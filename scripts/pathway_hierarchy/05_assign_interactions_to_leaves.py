#!/usr/bin/env python3
"""
Script 05: Assign Interactions to Most Specific Pathways

Analyzes each interaction and assigns it to the most specific
appropriate pathway(s) in the hierarchy. Uses AI to determine
the best pathway based on the interaction's functions.

Run: python scripts/pathway_hierarchy/05_assign_interactions_to_leaves.py

Prerequisites:
- Scripts 01-04 must have run successfully
- Interactions must exist in database

Batching: 5 interactions per AI call (need function context)
"""

import sys
from pathlib import Path
from datetime import datetime
from typing import List, Dict, Set, Optional

# Add project root to path
PROJECT_ROOT = Path(__file__).parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

from scripts.pathway_hierarchy.ai_hierarchy_builder import (
    assign_interactions_batch,
    format_hierarchy_tree,
)
from scripts.pathway_hierarchy.hierarchy_utils import (
    setup_logging,
    CheckpointManager,
    ScriptStats,
    save_run_report,
    get_app_context,
    ProgressTracker,
)
from scripts.pathway_hierarchy.pathway_config import ROOT_CATEGORY_NAMES


BATCH_SIZE = 15  # Interactions per AI call

# ROOT categories imported from central config
ROOT_CATEGORIES = ROOT_CATEGORY_NAMES


def ensure_hierarchy_chain_local(session, chain: List[str], confidence: float = 0.85, logger=None) -> int:
    """
    Ensure all pathways in chain exist with proper parent-child links.
    Returns the ID of the leaf (last) pathway.
    """
    from models import Pathway, PathwayParent

    if not chain or len(chain) < 1:
        return None

    # Validate ROOT category
    if chain[0] not in ROOT_CATEGORIES:
        if logger:
            logger.warning(f"Invalid ROOT '{chain[0]}' in chain, prepending Cellular Signaling")
        chain = ['Cellular Signaling'] + list(chain)

    parent_id = None

    for i, pathway_name in enumerate(chain):
        pathway = session.query(Pathway).filter_by(name=pathway_name).first()

        if pathway:
            if pathway.hierarchy_level != i:
                pathway.hierarchy_level = i

            if i > 0 and parent_id:
                existing_link = session.query(PathwayParent).filter_by(
                    child_pathway_id=pathway.id,
                    parent_pathway_id=parent_id
                ).first()
                if not existing_link:
                    link = PathwayParent(
                        child_pathway_id=pathway.id,
                        parent_pathway_id=parent_id,
                        relationship_type='is_a',
                        confidence=confidence,
                        source='AI',
                    )
                    session.add(link)

            parent_id = pathway.id
        else:
            is_leaf = (i == len(chain) - 1)
            pathway = Pathway(
                name=pathway_name,
                description=f"AI-inferred pathway (level {i})",
                ai_generated=True,
                hierarchy_level=i,
                is_leaf=is_leaf
            )
            session.add(pathway)
            session.flush()

            if i > 0 and parent_id:
                link = PathwayParent(
                    child_pathway_id=pathway.id,
                    parent_pathway_id=parent_id,
                    relationship_type='is_a',
                    confidence=confidence,
                    source='AI',
                )
                session.add(link)

            if logger:
                logger.info(f"Created pathway '{pathway_name}' at level {i}")
            parent_id = pathway.id

    # Update is_leaf for all pathways in chain
    for i, pathway_name in enumerate(chain):
        pathway = session.query(Pathway).filter_by(name=pathway_name).first()
        if pathway:
            pathway.is_leaf = (i == len(chain) - 1)

    session.flush()
    return parent_id


def get_interactions_with_pathways(session) -> List[Dict]:
    """Get all interactions with their current pathway assignments."""
    from models import Interaction, Pathway, PathwayInteraction, Protein

    interactions = []

    for inter in session.query(Interaction).all():
        # Get protein symbols
        protein_a = session.query(Protein).get(inter.protein_a_id)
        protein_b = session.query(Protein).get(inter.protein_b_id)

        if not protein_a or not protein_b:
            continue

        inter_id = f"{protein_a.symbol}-{protein_b.symbol}"

        # Get current pathway assignments
        pathway_links = session.query(PathwayInteraction).filter_by(
            interaction_id=inter.id
        ).all()

        current_pathways = []
        for link in pathway_links:
            pathway = session.query(Pathway).get(link.pathway_id)
            if pathway:
                current_pathways.append(pathway.name)

        # Get functions from JSONB data
        data = inter.data or {}
        functions = []

        # Extract function names from the stored data
        func_list = data.get('functions', [])
        for func in func_list:
            if isinstance(func, dict):
                func_name = func.get('function', '')
                if func_name:
                    functions.append(func_name)
            elif isinstance(func, str):
                functions.append(func)

        interactions.append({
            'db_id': inter.id,
            'id': inter_id,
            'protein_a': protein_a.symbol,
            'protein_b': protein_b.symbol,
            'current_pathways': current_pathways,
            'functions': functions if functions else ['Unknown'],
        })

    return interactions


def get_available_pathways_tree(session) -> str:
    """Get formatted pathway hierarchy for AI prompts."""
    from models import Pathway, PathwayParent

    pathways = session.query(Pathway).order_by(Pathway.hierarchy_level).all()

    tree_data = []
    for pw in pathways:
        parent_links = session.query(PathwayParent).filter_by(
            child_pathway_id=pw.id
        ).all()
        parent_names = []
        for link in parent_links:
            parent = session.query(Pathway).get(link.parent_pathway_id)
            if parent:
                parent_names.append(parent.name)

        tree_data.append({
            'name': pw.name,
            'level': pw.hierarchy_level or 0,
            'parent_names': parent_names,
        })

    return format_hierarchy_tree(tree_data, max_depth=6)


def get_leaf_pathways(session) -> Dict[str, int]:
    """Get mapping of leaf pathway names to IDs."""
    from models import Pathway

    leaves = session.query(Pathway).filter_by(is_leaf=True).all()
    return {pw.name: pw.id for pw in leaves}


def update_interaction_pathways(
    session,
    interaction_db_id: int,
    pathway_ids: List[int],
    confidence: float = 0.85
):
    """Update pathway assignments for an interaction."""
    from models import PathwayInteraction

    # Remove existing assignments
    session.query(PathwayInteraction).filter_by(
        interaction_id=interaction_db_id
    ).delete()

    # Add new assignments
    for pathway_id in pathway_ids:
        link = PathwayInteraction(
            interaction_id=interaction_db_id,
            pathway_id=pathway_id,
            assignment_confidence=confidence,
            assignment_method='ai_hierarchy',
        )
        session.add(link)


def compute_pathway_ancestry(session, pathway_id: int) -> List[str]:
    """Get the full ancestry path for a pathway."""
    from models import Pathway, PathwayParent

    ancestry = []
    current_id = pathway_id

    visited = set()
    while current_id and current_id not in visited:
        visited.add(current_id)
        pathway = session.query(Pathway).get(current_id)
        if not pathway:
            break

        ancestry.insert(0, pathway.name)

        # Get first parent (for primary path)
        parent_link = session.query(PathwayParent).filter_by(
            child_pathway_id=current_id
        ).first()

        if parent_link:
            current_id = parent_link.parent_pathway_id
        else:
            break

    return ancestry


def update_interaction_jsonb_pathways(session, interaction_db_id: int, pathways: List[Dict]):
    """
    Update the pathways array in interaction JSONB data AND sync function pathways.

    This ensures that function pathways match the interaction's most specific pathway,
    fixing the mismatch where modals would show a different pathway than expected.
    """
    from models import Interaction
    import logging
    logger = logging.getLogger(__name__)

    inter = session.query(Interaction).get(interaction_db_id)
    if not inter:
        return

    data = inter.data or {}

    # Update interaction-level pathways
    data['pathways'] = pathways

    # Find the most specific (deepest level) pathway
    most_specific = None
    if pathways:
        most_specific = max(pathways, key=lambda p: p.get('level', 0))

    # SYNC FUNCTION PATHWAYS with the most specific interaction pathway
    if most_specific and 'functions' in data:
        pathway_obj = {
            'name': most_specific.get('name'),
            'canonical_name': most_specific.get('name'),
            'hierarchy': most_specific.get('hierarchy', [most_specific.get('name')]),
            'level': most_specific.get('level', 0),
            'is_leaf': most_specific.get('is_leaf', True),
            'confidence': most_specific.get('confidence', 0.85)
        }

        functions_updated = 0
        for func in data.get('functions', []):
            # Update function's pathway to match interaction's most specific pathway
            old_pathway = func.get('pathway', {}).get('name') if isinstance(func.get('pathway'), dict) else func.get('pathway')
            func['pathway'] = pathway_obj
            functions_updated += 1

            if old_pathway and old_pathway != most_specific.get('name'):
                logger.debug(f"Synced function pathway: '{old_pathway}' -> '{most_specific.get('name')}'")

        if functions_updated > 0:
            logger.debug(f"Synced {functions_updated} function(s) to pathway '{most_specific.get('name')}'")

    inter.data = data

    # Mark as modified for SQLAlchemy
    from sqlalchemy.orm.attributes import flag_modified
    flag_modified(inter, 'data')


def main():
    """Assign interactions to most specific pathways."""
    logger = setup_logging("05_assign_interactions")
    checkpoint_mgr = CheckpointManager("05_assign_interactions_to_leaves")
    stats = ScriptStats(
        script_name="05_assign_interactions_to_leaves",
        start_time=datetime.now()
    )

    logger.info("=" * 60)
    logger.info("Script 05: Assign Interactions to Most Specific Pathways")
    logger.info("=" * 60)

    # Check for checkpoint
    checkpoint = checkpoint_mgr.load()
    processed_ids = set()
    if checkpoint:
        logger.info(f"Found checkpoint from {checkpoint.timestamp}")
        processed_ids = set(checkpoint.data.get('processed_ids', []))
        logger.info(f"Resuming with {len(processed_ids)} already processed")

    try:
        with get_app_context():
            from models import db, Pathway, PathwayInteraction

            # Phase 1: Get all interactions
            logger.info("")
            logger.info("-" * 40)
            logger.info("Phase 1: Loading interactions and pathways")
            logger.info("-" * 40)

            all_interactions = get_interactions_with_pathways(db.session)
            interactions = [i for i in all_interactions if i['db_id'] not in processed_ids]

            logger.info(f"Total interactions: {len(all_interactions)}")
            logger.info(f"To process: {len(interactions)}")

            if not interactions:
                logger.info("No interactions to process. Done!")
                return True

            # Get available pathways
            available_pathways = get_available_pathways_tree(db.session)
            leaf_pathways = get_leaf_pathways(db.session)
            logger.info(f"Available leaf pathways: {len(leaf_pathways)}")

            # Phase 2: Process interactions in batches
            logger.info("")
            logger.info("-" * 40)
            logger.info("Phase 2: AI-based pathway assignment")
            logger.info("-" * 40)

            progress = ProgressTracker(len(interactions), "Assigning pathways")
            total_batches = (len(interactions) + BATCH_SIZE - 1) // BATCH_SIZE

            for i in range(0, len(interactions), BATCH_SIZE):
                batch = interactions[i:i + BATCH_SIZE]
                batch_num = i // BATCH_SIZE + 1

                logger.info(f"[Batch {batch_num}/{total_batches}] Processing {len(batch)} interactions...")

                try:
                    # Prepare batch for AI
                    batch_for_ai = [
                        {
                            'id': inter['id'],
                            'current_pathways': inter['current_pathways'],
                            'functions': inter['functions'],
                        }
                        for inter in batch
                    ]

                    # Call AI
                    assignments = assign_interactions_batch(batch_for_ai, available_pathways)

                    # Apply assignments - NEW: Uses hierarchy_chain from AI response
                    for inter in batch:
                        new_pathways = assignments.get(inter['id'], [])

                        if new_pathways:
                            pathway_ids = []
                            pathway_data = []

                            for pw in new_pathways:
                                # NEW: Get hierarchy_chain from AI response
                                hierarchy_chain = pw.get('hierarchy_chain', [])
                                confidence = pw.get('confidence', 0.85)

                                if hierarchy_chain and len(hierarchy_chain) >= 2:
                                    # Ensure full chain exists with proper links
                                    leaf_id = ensure_hierarchy_chain_local(
                                        db.session, hierarchy_chain, confidence, logger
                                    )

                                    if leaf_id:
                                        pathway_ids.append(leaf_id)
                                        leaf_name = hierarchy_chain[-1]
                                        pathway_data.append({
                                            'name': leaf_name,
                                            'hierarchy': hierarchy_chain,
                                            'level': len(hierarchy_chain) - 1,
                                            'is_leaf': True,  # Last in chain is always leaf
                                            'confidence': confidence,
                                        })
                                        logger.info(f"  {inter['id']}: {' -> '.join(hierarchy_chain)}")
                                else:
                                    # Fallback: old format with just 'name'
                                    pw_name = pw.get('name') or (hierarchy_chain[-1] if hierarchy_chain else None)
                                    if pw_name:
                                        pw_id = leaf_pathways.get(pw_name)
                                        if not pw_id:
                                            pw_obj = db.session.query(Pathway).filter_by(name=pw_name).first()
                                            if pw_obj:
                                                pw_id = pw_obj.id

                                        if pw_id:
                                            pathway_ids.append(pw_id)
                                            ancestry = compute_pathway_ancestry(db.session, pw_id)
                                            pathway_data.append({
                                                'name': pw_name,
                                                'hierarchy': ancestry,
                                                'level': len(ancestry) - 1,
                                                'is_leaf': pw_name in leaf_pathways,
                                                'confidence': confidence,
                                            })
                                            logger.info(f"  {inter['id']}: {pw_name} (fallback)")

                            if pathway_ids:
                                # Update PathwayInteraction table
                                update_interaction_pathways(
                                    db.session,
                                    inter['db_id'],
                                    pathway_ids,
                                    confidence=0.85
                                )

                                # Update JSONB data (also syncs function pathways)
                                update_interaction_jsonb_pathways(
                                    db.session,
                                    inter['db_id'],
                                    pathway_data
                                )

                                stats.items_updated += 1
                        else:
                            logger.info(f"  {inter['id']}: No change needed")

                        processed_ids.add(inter['db_id'])
                        stats.items_processed += 1

                    db.session.commit()

                except Exception as e:
                    logger.error(f"Batch failed: {e}")
                    import traceback
                    traceback.print_exc()
                    stats.errors += 1
                    db.session.rollback()

                # Save checkpoint
                checkpoint_mgr.save(phase=2, data={'processed_ids': list(processed_ids)})
                progress.update(len(batch))

                # Rate limiting
                import time
                time.sleep(1.5)

            # Phase 3: Update pathway usage counts
            logger.info("")
            logger.info("-" * 40)
            logger.info("Phase 3: Updating pathway usage counts")
            logger.info("-" * 40)

            for pathway in db.session.query(Pathway).all():
                count = db.session.query(PathwayInteraction).filter_by(
                    pathway_id=pathway.id
                ).count()
                pathway.usage_count = count

                # Also update protein_count based on unique proteins
                unique_proteins = set()
                for link in db.session.query(PathwayInteraction).filter_by(pathway_id=pathway.id).all():
                    from models import Interaction
                    inter = db.session.query(Interaction).get(link.interaction_id)
                    if inter:
                        unique_proteins.add(inter.protein_a_id)
                        unique_proteins.add(inter.protein_b_id)

                pathway.protein_count = len(unique_proteins)

            db.session.commit()

            # Summary
            logger.info("")
            logger.info("=" * 60)
            logger.info("SUMMARY")
            logger.info("=" * 60)

            total_interactions = len(all_interactions)
            assigned = db.session.query(PathwayInteraction).distinct(
                PathwayInteraction.interaction_id
            ).count()

            logger.info(f"Total interactions: {total_interactions}")
            logger.info(f"Interactions with pathway assignments: {assigned}")
            logger.info(f"Updated this run: {stats.items_updated}")

            # Show pathway distribution
            logger.info("")
            logger.info("Top pathways by interaction count:")
            top_pathways = db.session.query(Pathway).order_by(
                Pathway.usage_count.desc()
            ).limit(10).all()

            for pw in top_pathways:
                if pw.usage_count > 0:
                    logger.info(f"  {pw.name}: {pw.usage_count} interactions, {pw.protein_count} proteins")

            # Clear checkpoint
            checkpoint_mgr.clear()

            stats.end_time = datetime.now()
            report_path = save_run_report(stats)
            logger.info("")
            logger.info(f"Report saved to: {report_path}")
            logger.info("")
            logger.info("Script 05 completed successfully!")
            logger.info(stats.summary())

            return True

    except Exception as e:
        logger.error(f"Script failed: {e}")
        import traceback
        traceback.print_exc()
        stats.errors += 1
        stats.end_time = datetime.now()
        save_run_report(stats)
        return False


if __name__ == "__main__":
    success = main()
    sys.exit(0 if success else 1)
