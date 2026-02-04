#!/usr/bin/env python3
"""
Script 07: Merge Duplicate Pathways

Finds and merges pathways that are duplicates based on normalized names.
Combines interaction assignments from duplicate pathways.

Examples of duplicates this script handles:
- "NF-kB Signaling" and "NF-κB Signaling Pathway"
- "TGF-beta Signaling" and "TGF-β Signaling Pathway"

Run: python scripts/pathway_hierarchy/07_merge_duplicate_pathways.py [--dry-run]

Prerequisites:
- Database must be accessible
- Script 06 should have run (hierarchy finalized)
"""

import sys
from pathlib import Path
from collections import defaultdict
from typing import Dict, List, Tuple
import argparse

# Add project root to path
PROJECT_ROOT = Path(__file__).parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

from scripts.pathway_hierarchy.hierarchy_utils import (
    setup_logging,
    normalize_pathway_name,
    get_app_context,
)


def find_duplicate_groups(session) -> Dict[str, List[Tuple[int, str]]]:
    """
    Group pathways by their normalized name.

    Returns: Dict[normalized_name] -> [(pathway_id, original_name), ...]
    """
    from models import Pathway

    groups = defaultdict(list)

    for pathway in session.query(Pathway).all():
        normalized = normalize_pathway_name(pathway.name)
        groups[normalized].append((pathway.id, pathway.name))

    # Filter to only groups with duplicates (>1 pathway per normalized name)
    return {k: v for k, v in groups.items() if len(v) > 1}


def select_canonical_pathway(pathways: List[Tuple[int, str]], session) -> int:
    """
    Select the canonical pathway from a group of duplicates.

    Priority:
    1. Has ontology_id (real ontology mapping)
    2. Has more interactions assigned
    3. Lower hierarchy_level (more established in tree)
    4. Lower ID (older, more established)
    """
    from models import Pathway, PathwayInteraction

    best_id = None
    best_score = (-1, -1, float('inf'), float('inf'))

    for pathway_id, name in pathways:
        pathway = session.query(Pathway).get(pathway_id)
        if not pathway:
            continue

        interaction_count = session.query(PathwayInteraction).filter_by(
            pathway_id=pathway_id
        ).count()

        has_ontology = 1 if pathway.ontology_id else 0
        level = pathway.hierarchy_level or 0

        # Score tuple: (has_ontology, interaction_count, -level, -id)
        # Higher is better for first two, lower is better for last two
        score = (has_ontology, interaction_count, -level, -pathway_id)

        if score > best_score:
            best_score = score
            best_id = pathway_id

    return best_id


def merge_pathways(session, canonical_id: int, duplicate_ids: List[int], logger, dry_run: bool = False):
    """
    Merge duplicate pathways into the canonical one.

    1. Move all PathwayInteraction references to canonical
    2. Move all PathwayParent child links to canonical
    3. Delete duplicate pathways
    """
    from models import Pathway, PathwayInteraction, PathwayParent

    canonical = session.query(Pathway).get(canonical_id)
    if not canonical:
        logger.error(f"Canonical pathway {canonical_id} not found!")
        return

    logger.info(f"  Canonical: {canonical.name} (id={canonical_id})")

    for dup_id in duplicate_ids:
        if dup_id == canonical_id:
            continue

        dup = session.query(Pathway).get(dup_id)
        if not dup:
            continue

        logger.info(f"    Merging duplicate: {dup.name} (id={dup_id})")

        # 1. Move PathwayInteraction references
        interactions = session.query(PathwayInteraction).filter_by(pathway_id=dup_id).all()
        moved_count = 0
        deleted_count = 0

        for pi in interactions:
            # Check if canonical already has this interaction
            existing = session.query(PathwayInteraction).filter_by(
                pathway_id=canonical_id,
                interaction_id=pi.interaction_id
            ).first()

            if existing:
                if not dry_run:
                    session.delete(pi)
                deleted_count += 1
            else:
                if not dry_run:
                    pi.pathway_id = canonical_id
                moved_count += 1

        if moved_count or deleted_count:
            logger.info(f"      Interactions: {moved_count} moved, {deleted_count} deduplicated")

        # 2. Move child PathwayParent links (where dup is parent)
        child_links = session.query(PathwayParent).filter_by(parent_pathway_id=dup_id).all()
        for link in child_links:
            existing = session.query(PathwayParent).filter_by(
                parent_pathway_id=canonical_id,
                child_pathway_id=link.child_pathway_id
            ).first()

            if existing:
                if not dry_run:
                    session.delete(link)
            else:
                if not dry_run:
                    link.parent_pathway_id = canonical_id

        # 3. Handle parent links (where dup is child)
        parent_links = session.query(PathwayParent).filter_by(child_pathway_id=dup_id).all()
        for link in parent_links:
            existing = session.query(PathwayParent).filter_by(
                parent_pathway_id=link.parent_pathway_id,
                child_pathway_id=canonical_id
            ).first()

            if existing:
                if not dry_run:
                    session.delete(link)
            else:
                if not dry_run:
                    link.child_pathway_id = canonical_id

        # 4. Merge metadata (take best values)
        if not dry_run:
            if dup.ontology_id and not canonical.ontology_id:
                canonical.ontology_id = dup.ontology_id
                canonical.ontology_source = dup.ontology_source
            if dup.description and not canonical.description:
                canonical.description = dup.description
            # Keep higher usage_count
            canonical.usage_count = max(canonical.usage_count or 0, dup.usage_count or 0)

        # 5. Delete duplicate
        if not dry_run:
            session.delete(dup)
            logger.info(f"      Deleted duplicate pathway {dup_id}")
        else:
            logger.info(f"      [DRY RUN] Would delete duplicate pathway {dup_id}")


def main():
    parser = argparse.ArgumentParser(description='Merge duplicate pathways')
    parser.add_argument('--dry-run', action='store_true', help='Preview changes without applying')
    args = parser.parse_args()

    logger = setup_logging("07_merge_duplicates")

    logger.info("=" * 70)
    logger.info("Script 07: Merge Duplicate Pathways")
    logger.info("=" * 70)

    if args.dry_run:
        logger.info("DRY RUN MODE - no changes will be made")
    logger.info("")

    try:
        with get_app_context():
            from models import db

            # Find duplicates
            logger.info("Scanning for duplicate pathways...")
            duplicate_groups = find_duplicate_groups(db.session)

            if not duplicate_groups:
                logger.info("No duplicates found! Database is clean.")
                return True

            logger.info(f"Found {len(duplicate_groups)} groups of duplicates:\n")

            for normalized, pathways in sorted(duplicate_groups.items()):
                logger.info(f"  Normalized: '{normalized}'")
                for pid, name in pathways:
                    logger.info(f"    - [{pid}] {name}")
                logger.info("")

            # Merge each group
            logger.info("Merging duplicate groups...\n")

            for normalized, pathways in duplicate_groups.items():
                logger.info(f"Processing group: '{normalized}'")

                canonical_id = select_canonical_pathway(pathways, db.session)
                duplicate_ids = [pid for pid, _ in pathways if pid != canonical_id]

                merge_pathways(db.session, canonical_id, duplicate_ids, logger, args.dry_run)
                logger.info("")

            if not args.dry_run:
                db.session.commit()
                logger.info("=" * 70)
                logger.info("Changes committed successfully!")
                logger.info("=" * 70)
            else:
                db.session.rollback()
                logger.info("=" * 70)
                logger.info("[DRY RUN] Changes NOT committed")
                logger.info("=" * 70)

            return True

    except Exception as e:
        logger.error(f"Script failed: {e}")
        import traceback
        traceback.print_exc()
        return False


if __name__ == "__main__":
    success = main()
    sys.exit(0 if success else 1)
