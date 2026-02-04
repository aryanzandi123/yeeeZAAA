#!/usr/bin/env python3
"""
Clear Pathway Tables Utility
============================

Clears pathway tables for fresh hierarchy rebuild while keeping
proteins and interactions intact.

Usage:
    python scripts/clear_pathway_tables.py           # Clear pathway tables only
    python scripts/clear_pathway_tables.py --all     # Clear ALL tables (nuclear)
    python scripts/clear_pathway_tables.py --dry-run # Preview what would be deleted
"""
import sys
import argparse
import shutil
from pathlib import Path

# Add project root to path
PROJECT_ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

from app import app, db
from models import PathwayParent, PathwayInteraction, Pathway, Interaction, Protein

# ALL pathway-related fields to clear from interaction.data
PATHWAY_DATA_FIELDS = [
    'step2_proposal',
    'step2_function_proposals',
    'step3_finalized_pathway',
    'step3_function_pathways',
]

# Fields to clear from each function in the functions array
FUNCTION_PATHWAY_FIELDS = ['step2_pathway', 'pathway']

# Cache files to delete
CACHE_FILES = [
    'cache/pathway_hierarchy_cache.json',
]

# Cache directories to clear (contents deleted, directory kept)
CACHE_DIRS = [
    'cache/hierarchy_checkpoints',
    'cache/hierarchy_reports',
]


def _clear_cache_files(dry_run: bool = False) -> dict:
    """Clear pathway-related cache files and directories.

    Returns dict with counts of files/dirs cleared.
    """
    stats = {'files_deleted': 0, 'dirs_cleared': 0}

    # Delete individual cache files
    for rel_path in CACHE_FILES:
        cache_file = PROJECT_ROOT / rel_path
        if cache_file.exists():
            if dry_run:
                print(f"  [DRY RUN] Would delete: {rel_path}")
            else:
                cache_file.unlink()
                print(f"  Deleted: {rel_path}")
            stats['files_deleted'] += 1

    # Clear cache directories (delete contents, keep directory)
    for rel_path in CACHE_DIRS:
        cache_dir = PROJECT_ROOT / rel_path
        if cache_dir.exists() and cache_dir.is_dir():
            files_in_dir = list(cache_dir.glob('*'))
            if files_in_dir:
                if dry_run:
                    print(f"  [DRY RUN] Would clear {len(files_in_dir)} files in: {rel_path}/")
                else:
                    for f in files_in_dir:
                        if f.is_file():
                            f.unlink()
                        elif f.is_dir():
                            shutil.rmtree(f)
                    print(f"  Cleared {len(files_in_dir)} items from: {rel_path}/")
                stats['dirs_cleared'] += 1

    return stats


def _clear_interaction_pathway_data(interactions, dry_run: bool = False) -> int:
    """Clear ALL pathway-related fields from interactions.

    Clears:
    - Top-level fields: step2_proposal, step2_function_proposals,
      step3_finalized_pathway, step3_function_pathways
    - Per-function fields: functions[].step2_pathway, functions[].pathway

    Returns count of interactions modified.
    """
    cleared_count = 0

    for ix in interactions:
        if not ix.data:
            continue

        modified = False
        new_data = dict(ix.data)

        # Clear top-level pathway fields
        for field in PATHWAY_DATA_FIELDS:
            if field in new_data:
                del new_data[field]
                modified = True

        # Clear pathway fields from each function in functions array
        if 'functions' in new_data and isinstance(new_data['functions'], list):
            for func in new_data['functions']:
                if isinstance(func, dict):
                    for field in FUNCTION_PATHWAY_FIELDS:
                        if field in func:
                            del func[field]
                            modified = True

        if modified:
            if not dry_run:
                ix.data = new_data
            cleared_count += 1

    return cleared_count


def clear_pathway_tables(dry_run: bool = False, clear_interaction_data: bool = True):
    """Clear pathway-related tables and optionally all pathway data from interactions.

    Args:
        dry_run: Preview changes without making them
        clear_interaction_data: Also clear pathway fields from interaction.data
    """
    with app.app_context():
        # Count rows first
        parents_count = db.session.query(PathwayParent).count()
        pi_count = db.session.query(PathwayInteraction).count()
        pathways_count = db.session.query(Pathway).count()

        # Count interactions with ANY pathway data
        interactions_with_pathway_data = db.session.query(Interaction).filter(
            db.or_(
                Interaction.data.has_key('step2_proposal'),
                Interaction.data.has_key('step2_function_proposals'),
                Interaction.data.has_key('step3_finalized_pathway'),
                Interaction.data.has_key('step3_function_pathways'),
            )
        ).count()

        print(f"\n{'[DRY RUN] ' if dry_run else ''}Pathway Tables Status:")
        print(f"  pathway_parents: {parents_count} rows")
        print(f"  pathway_interactions: {pi_count} rows")
        print(f"  pathways: {pathways_count} rows")
        print(f"\nInteraction Pathway Data:")
        print(f"  interactions with pathway data: {interactions_with_pathway_data}")
        print(f"\nCache Files:")

        # Check cache files (preview mode)
        _clear_cache_files(dry_run=True)
        print()

        if dry_run:
            print("[DRY RUN] No changes made. Run without --dry-run to delete.")
            return

        # Order matters due to foreign keys!
        deleted_parents = db.session.query(PathwayParent).delete()
        deleted_pi = db.session.query(PathwayInteraction).delete()
        deleted_pathways = db.session.query(Pathway).delete()

        # Clear ALL pathway data from interactions
        cleared_interactions = 0
        if clear_interaction_data:
            interactions = db.session.query(Interaction).filter(
                db.or_(
                    Interaction.data.has_key('step2_proposal'),
                    Interaction.data.has_key('step2_function_proposals'),
                    Interaction.data.has_key('step3_finalized_pathway'),
                    Interaction.data.has_key('step3_function_pathways'),
                )
            ).all()

            cleared_interactions = _clear_interaction_pathway_data(interactions, dry_run=False)

        db.session.commit()

        # Clear cache files
        print("\nClearing cache files...")
        _clear_cache_files(dry_run=False)

        print(f"\n{'='*50}")
        print("Summary:")
        print(f"  Deleted {deleted_parents} pathway_parents rows")
        print(f"  Deleted {deleted_pi} pathway_interactions rows")
        print(f"  Deleted {deleted_pathways} pathways rows")
        if clear_interaction_data:
            print(f"  Cleared pathway data from {cleared_interactions} interactions")
            print(f"    (fields: {', '.join(PATHWAY_DATA_FIELDS)})")
            print(f"    (per-function: {', '.join(FUNCTION_PATHWAY_FIELDS)})")
        print(f"{'='*50}")
        print("\nPathway tables cleared - ready for rebuild")
        print("\nNext steps:")
        print("  python scripts/pathway_v2/run_all_v2.py")


def clear_all_tables(dry_run: bool = False):
    """Clear ALL tables (nuclear option)."""
    with app.app_context():
        # Count rows first
        counts = {
            'pathway_parents': db.session.query(PathwayParent).count(),
            'pathway_interactions': db.session.query(PathwayInteraction).count(),
            'pathways': db.session.query(Pathway).count(),
            'interactions': db.session.query(Interaction).count(),
            'proteins': db.session.query(Protein).count(),
        }

        print(f"\n{'[DRY RUN] ' if dry_run else ''}ALL Tables Status:")
        for table, count in counts.items():
            print(f"  {table}: {count} rows")
        print()

        if dry_run:
            print("[DRY RUN] No changes made. Run without --dry-run to delete.")
            return

        # Confirmation for destructive operation
        total = sum(counts.values())
        print(f"WARNING: This will delete {total} rows across ALL tables!")
        response = input("Type 'yes' to confirm: ")
        if response.lower() != 'yes':
            print("Aborted.")
            return

        # Order matters due to foreign keys!
        db.session.query(PathwayParent).delete()
        db.session.query(PathwayInteraction).delete()
        db.session.query(Pathway).delete()
        db.session.query(Interaction).delete()
        db.session.query(Protein).delete()

        db.session.commit()

        # Clear ALL cache
        print("\nClearing cache files...")
        _clear_cache_files(dry_run=False)

        print("\nALL tables cleared")
        print("\nNext steps:")
        print("  1. Re-query a protein: curl -X POST localhost:5000/api/query -d '{\"protein\":\"ATXN3\"}'")
        print("  2. Run hierarchy pipeline: python scripts/pathway_v2/run_all_v2.py")


def main():
    parser = argparse.ArgumentParser(
        description="Clear pathway tables for fresh hierarchy rebuild",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python scripts/clear_pathway_tables.py                    # Clear pathway tables + ALL interaction pathway data
  python scripts/clear_pathway_tables.py --keep-assignments # Clear tables but keep pathway data in interactions
  python scripts/clear_pathway_tables.py --all              # Clear ALL tables (nuclear)
  python scripts/clear_pathway_tables.py --dry-run          # Preview what would be deleted

Fields cleared from interaction.data:
  - step2_proposal, step2_function_proposals
  - step3_finalized_pathway, step3_function_pathways
  - functions[].step2_pathway, functions[].pathway

Cache files cleared:
  - cache/pathway_hierarchy_cache.json
  - cache/hierarchy_checkpoints/*
  - cache/hierarchy_reports/*
        """
    )
    parser.add_argument(
        '--all',
        action='store_true',
        help='Clear ALL tables including proteins and interactions (nuclear option)'
    )
    parser.add_argument(
        '--keep-assignments',
        action='store_true',
        help='Keep pathway assignments in interaction.data (only clear tables)'
    )
    parser.add_argument(
        '--dry-run',
        action='store_true',
        help='Preview what would be deleted without making changes'
    )

    args = parser.parse_args()

    if args.all:
        clear_all_tables(dry_run=args.dry_run)
    else:
        clear_pathway_tables(
            dry_run=args.dry_run,
            clear_interaction_data=not args.keep_assignments
        )


if __name__ == "__main__":
    main()
