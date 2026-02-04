#!/usr/bin/env python3
"""
Script 04: AI Create Missing Branches

Analyzes the hierarchy for gaps and uses AI to create appropriate
intermediate pathways where needed. Also handles orphan pathways
that couldn't be classified in Script 03.

Run: python scripts/pathway_hierarchy/04_ai_create_missing_branches.py

Prerequisites:
- Scripts 01-03 must have run successfully

Key Rules:
- Intermediate pathways must implicate >5 proteins (significance cap)
- No protein-specific pathways (too narrow)
- Maximum 2 intermediate levels per gap
"""

import sys
from pathlib import Path
from datetime import datetime
from typing import List, Dict, Set, Tuple, Optional

# Add project root to path
PROJECT_ROOT = Path(__file__).parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

from scripts.pathway_hierarchy.ai_hierarchy_builder import (
    create_intermediate_pathways_batch,
    handle_orphan_pathways,
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


BATCH_SIZE = 15  # Gaps per AI call (complex reasoning needed)
MIN_PROTEIN_COUNT = 1  # Minimum proteins for intermediate pathways


def find_hierarchy_gaps(session) -> List[Dict]:
    """
    Find gaps in the hierarchy where intermediate levels may be needed.

    A gap exists when a child pathway is >2 levels below its parent
    conceptually, or when the child seems too specific for its parent.
    """
    from models import Pathway, PathwayParent

    gaps = []

    # Get all parent-child relationships
    for link in session.query(PathwayParent).all():
        child = session.query(Pathway).get(link.child_pathway_id)
        parent = session.query(Pathway).get(link.parent_pathway_id)

        if not child or not parent:
            continue

        # Check level gap
        level_gap = (child.hierarchy_level or 0) - (parent.hierarchy_level or 0)

        # Consider it a gap if child jumps more than 2 levels
        # Or if this is a direct root -> leaf connection
        if level_gap > 2 or (parent.hierarchy_level == 0 and child.is_leaf):
            gaps.append({
                'child': child.name,
                'child_id': child.id,
                'parent': parent.name,
                'parent_id': parent.id,
                'description': child.description or '',
                'level_gap': level_gap,
            })

    return gaps


def get_remaining_orphans(session) -> List[Dict]:
    """Get pathways that still don't have any parent."""
    from models import Pathway, PathwayParent

    # Get IDs of pathways that have parents
    has_parent = session.query(PathwayParent.child_pathway_id).distinct().all()
    has_parent_ids = {p[0] for p in has_parent}

    # Get root pathway IDs
    root_ids = {p.id for p in session.query(Pathway).filter_by(hierarchy_level=0).all()}

    # Orphans are pathways with no parents that aren't roots
    orphans = session.query(Pathway).filter(
        ~Pathway.id.in_(has_parent_ids | root_ids)
    ).all()

    return [
        {
            'id': pw.id,
            'name': pw.name,
            'description': pw.description or '',
        }
        for pw in orphans
    ]


def get_hierarchy_tree_for_ai(session) -> str:
    """Get hierarchy tree formatted for AI prompts."""
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

    return format_hierarchy_tree(tree_data, max_depth=5)


def create_intermediate_pathway(
    session,
    name: str,
    description: str,
    parent_id: int = None,
    go_id: str = None,
    hierarchy_level: int = None
) -> int:
    """
    Create a new intermediate pathway in the database with proper hierarchy.

    Args:
        session: Database session
        name: Pathway name
        description: Pathway description
        parent_id: ID of parent pathway (if known)
        go_id: GO ontology ID (optional)
        hierarchy_level: Explicit level (if not provided, computed from parent)

    Returns:
        ID of the created (or existing) pathway
    """
    from models import Pathway
    import logging
    logger = logging.getLogger(__name__)

    # Check if already exists
    existing = session.query(Pathway).filter_by(name=name).first()
    if existing:
        # If exists but wrong level, update it
        if hierarchy_level is not None and existing.hierarchy_level != hierarchy_level:
            logger.info(f"Updating '{name}' hierarchy_level from {existing.hierarchy_level} to {hierarchy_level}")
            existing.hierarchy_level = hierarchy_level
        return existing.id

    # Calculate hierarchy level based on parent if not explicitly provided
    if hierarchy_level is None:
        hierarchy_level = 0
        if parent_id:
            parent = session.query(Pathway).get(parent_id)
            if parent:
                hierarchy_level = (parent.hierarchy_level or 0) + 1

    pathway = Pathway(
        name=name,
        description=description,
        ontology_id=go_id,
        ontology_source='GO' if go_id and go_id.startswith('GO:') else None,
        ai_generated=True,
        is_leaf=True,  # Will be updated later
        hierarchy_level=hierarchy_level,  # EXPLICITLY SET
    )
    session.add(pathway)
    session.flush()

    # Create parent link if parent_id provided
    if parent_id:
        create_parent_link(session, pathway.id, parent_id, confidence=0.85, source='AI')

    logger.info(f"Created pathway '{name}' at level {hierarchy_level}")
    return pathway.id


def create_parent_link(session, child_id: int, parent_id: int, confidence: float = 0.85, source: str = 'AI') -> bool:
    """Create a parent-child link if it doesn't exist."""
    from models import PathwayParent

    existing = session.query(PathwayParent).filter_by(
        child_pathway_id=child_id,
        parent_pathway_id=parent_id
    ).first()

    if existing:
        return False

    link = PathwayParent(
        child_pathway_id=child_id,
        parent_pathway_id=parent_id,
        relationship_type='is_a',
        confidence=confidence,
        source=source,
    )
    session.add(link)
    return True


def ensure_hierarchy_chain(session, chain: List[str], confidence: float = 0.85) -> int:
    """
    Ensure all pathways in chain exist with proper parent-child links.
    Returns the ID of the leaf (last) pathway.

    This is the KEY function for creating proper hierarchy chains.
    It ensures that every pathway in the chain exists and has the correct
    hierarchy_level and parent-child links.

    Example:
        chain = ["Cellular Signaling", "Transcription", "Epigenetic Regulation", "Histone Deacetylation"]
        Creates/links: Root(0) -> L1(1) -> L2(2) -> Leaf(3)

    Args:
        session: Database session
        chain: List of pathway names from ROOT to LEAF
        confidence: Confidence score for parent links

    Returns:
        ID of the leaf (last) pathway in the chain
    """
    from models import Pathway, PathwayParent
    import logging
    logger = logging.getLogger(__name__)

    if not chain or len(chain) < 1:
        return None

    # Validate ROOT category (imported from pathway_config)
    if chain[0] not in ROOT_CATEGORY_NAMES:
        logger.warning(f"Invalid ROOT '{chain[0]}' in chain, defaulting to Cellular Signaling")
        chain = ['Cellular Signaling'] + list(chain)

    parent_id = None
    created_pathways = []

    for i, pathway_name in enumerate(chain):
        # Check if pathway exists
        pathway = session.query(Pathway).filter_by(name=pathway_name).first()

        if pathway:
            # Pathway exists - ensure hierarchy_level is correct
            if pathway.hierarchy_level != i:
                logger.info(f"Updating '{pathway_name}' hierarchy_level from {pathway.hierarchy_level} to {i}")
                pathway.hierarchy_level = i

            # Ensure parent link exists (except for root)
            if i > 0 and parent_id:
                existing_link = session.query(PathwayParent).filter_by(
                    child_pathway_id=pathway.id,
                    parent_pathway_id=parent_id
                ).first()
                if not existing_link:
                    create_parent_link(session, pathway.id, parent_id, confidence, 'AI')
                    logger.info(f"Created missing link: {chain[i-1]} -> {pathway_name}")

            parent_id = pathway.id
        else:
            # Create new pathway with correct level
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
            created_pathways.append(pathway_name)

            # Create parent link (except for root at index 0)
            if i > 0 and parent_id:
                create_parent_link(session, pathway.id, parent_id, confidence, 'AI')

            logger.info(f"Created pathway '{pathway_name}' at level {i}, parent={chain[i-1] if i > 0 else 'ROOT'}")
            parent_id = pathway.id

    # Update is_leaf for all pathways in chain (only last should be leaf)
    for i, pathway_name in enumerate(chain):
        pathway = session.query(Pathway).filter_by(name=pathway_name).first()
        if pathway:
            should_be_leaf = (i == len(chain) - 1)
            if pathway.is_leaf != should_be_leaf:
                pathway.is_leaf = should_be_leaf
                logger.debug(f"Updated '{pathway_name}' is_leaf to {should_be_leaf}")

    session.flush()

    if created_pathways:
        logger.info(f"ensure_hierarchy_chain created: {' -> '.join(created_pathways)}")

    return parent_id  # Returns leaf pathway ID


def update_hierarchy_metadata(session):
    """Update hierarchy levels and is_leaf status for all pathways."""
    from models import Pathway, PathwayParent

    # Compute levels using BFS from roots
    levels = {}

    def compute_level(pathway_id: int, visited: Set[int] = None) -> int:
        if visited is None:
            visited = set()
        if pathway_id in visited:
            return 0

        visited.add(pathway_id)
        parent_links = session.query(PathwayParent).filter_by(
            child_pathway_id=pathway_id
        ).all()

        if not parent_links:
            return 0

        max_parent_level = 0
        for link in parent_links:
            parent_level = compute_level(link.parent_pathway_id, visited.copy())
            max_parent_level = max(max_parent_level, parent_level)

        return max_parent_level + 1

    for pathway in session.query(Pathway).all():
        levels[pathway.id] = compute_level(pathway.id)
        pathway.hierarchy_level = levels[pathway.id]

    # Update is_leaf
    parent_ids = {p[0] for p in session.query(PathwayParent.parent_pathway_id).distinct().all()}
    for pathway in session.query(Pathway).all():
        pathway.is_leaf = pathway.id not in parent_ids


def main():
    """Create missing intermediate branches in the hierarchy."""
    logger = setup_logging("04_create_branches")
    checkpoint_mgr = CheckpointManager("04_ai_create_missing_branches")
    stats = ScriptStats(
        script_name="04_ai_create_missing_branches",
        start_time=datetime.now()
    )

    logger.info("=" * 60)
    logger.info("Script 04: AI Create Missing Branches")
    logger.info("=" * 60)

    # Check for checkpoint
    checkpoint = checkpoint_mgr.load()
    processed_gaps = set()
    processed_orphans = set()
    if checkpoint:
        logger.info(f"Found checkpoint from {checkpoint.timestamp}")
        processed_gaps = set(checkpoint.data.get('processed_gaps', []))
        processed_orphans = set(checkpoint.data.get('processed_orphans', []))

    try:
        with get_app_context():
            from models import db, Pathway, PathwayParent

            # Phase 1: Find hierarchy gaps
            logger.info("")
            logger.info("-" * 40)
            logger.info("Phase 1: Identifying hierarchy gaps")
            logger.info("-" * 40)

            gaps = find_hierarchy_gaps(db.session)
            gaps = [g for g in gaps if g['child_id'] not in processed_gaps]
            logger.info(f"Found {len(gaps)} hierarchy gaps to analyze")

            # Phase 2: Find remaining orphans
            logger.info("")
            logger.info("-" * 40)
            logger.info("Phase 2: Identifying remaining orphan pathways")
            logger.info("-" * 40)

            orphans = get_remaining_orphans(db.session)
            orphans = [o for o in orphans if o['id'] not in processed_orphans]
            logger.info(f"Found {len(orphans)} orphan pathways")

            if not gaps and not orphans:
                logger.info("No gaps or orphans to process. Hierarchy is complete!")
                return True

            # Get hierarchy tree for AI context
            hierarchy_tree = get_hierarchy_tree_for_ai(db.session)
            existing_names = [pw.name for pw in db.session.query(Pathway).all()]

            # Phase 3: Process gaps - create intermediate pathways
            if gaps:
                logger.info("")
                logger.info("-" * 40)
                logger.info("Phase 3: Creating intermediate pathways for gaps")
                logger.info("-" * 40)

                for i in range(0, len(gaps), BATCH_SIZE):
                    batch = gaps[i:i + BATCH_SIZE]
                    batch_num = i // BATCH_SIZE + 1
                    total_batches = (len(gaps) + BATCH_SIZE - 1) // BATCH_SIZE

                    logger.info(f"[Batch {batch_num}/{total_batches}] Analyzing {len(batch)} gaps...")

                    try:
                        # Call AI to suggest intermediates
                        gap_analyses = create_intermediate_pathways_batch(
                            batch, existing_names
                        )

                        for analysis in gap_analyses:
                            child_name = analysis.get('child')
                            if not analysis.get('intermediates_needed'):
                                logger.info(f"  {child_name}: No intermediates needed")
                                continue

                            intermediates = analysis.get('suggested_intermediates', [])
                            logger.info(f"  {child_name}: Creating {len(intermediates)} intermediate(s)")

                            # Find child and parent IDs
                            child_pw = db.session.query(Pathway).filter_by(name=child_name).first()
                            parent_name = analysis.get('parent')
                            parent_pw = db.session.query(Pathway).filter_by(name=parent_name).first()

                            if not child_pw or not parent_pw:
                                continue

                            # Create intermediates in order
                            prev_id = parent_pw.id
                            for inter in intermediates:
                                inter_name = inter['name']
                                inter_desc = inter.get('description', '')
                                inter_go = inter.get('go_id')
                                est_proteins = inter.get('estimated_protein_count', 0)

                                # Check significance cap
                                if est_proteins < MIN_PROTEIN_COUNT:
                                    logger.warning(f"    Skipping '{inter_name}' (est. {est_proteins} proteins < {MIN_PROTEIN_COUNT})")
                                    continue

                                # Create intermediate pathway
                                inter_id = create_intermediate_pathway(
                                    db.session, inter_name, inter_desc,
                                    parent_id=prev_id, go_id=inter_go
                                )

                                # Link intermediate to previous (parent or previous intermediate)
                                create_parent_link(db.session, inter_id, prev_id, confidence=0.85, source='AI')
                                logger.info(f"    Created: {inter_name} (under {parent_name if prev_id == parent_pw.id else 'intermediate'})")

                                prev_id = inter_id
                                stats.items_created += 1

                            # Re-link original child to last intermediate
                            if prev_id != parent_pw.id:
                                # Remove old link
                                db.session.query(PathwayParent).filter_by(
                                    child_pathway_id=child_pw.id,
                                    parent_pathway_id=parent_pw.id
                                ).delete()

                                # Add new link to intermediate
                                create_parent_link(db.session, child_pw.id, prev_id, confidence=0.85, source='AI')

                            processed_gaps.add(child_pw.id)
                            stats.items_processed += 1

                        db.session.commit()

                    except Exception as e:
                        logger.error(f"Batch failed: {e}")
                        db.session.rollback()  # Prevent cascading transaction errors
                        stats.errors += 1

                    # Checkpoint
                    checkpoint_mgr.save(
                        phase=3,
                        data={
                            'processed_gaps': list(processed_gaps),
                            'processed_orphans': list(processed_orphans)
                        }
                    )

                    import time
                    time.sleep(1.5)

            # Phase 4: Handle orphan pathways using hierarchy_chain
            if orphans:
                logger.info("")
                logger.info("-" * 40)
                logger.info("Phase 4: Handling orphan pathways with hierarchy chains")
                logger.info("-" * 40)

                for i in range(0, len(orphans), BATCH_SIZE):
                    batch = orphans[i:i + BATCH_SIZE]
                    batch_num = i // BATCH_SIZE + 1
                    total_batches = (len(orphans) + BATCH_SIZE - 1) // BATCH_SIZE

                    logger.info(f"[Batch {batch_num}/{total_batches}] Processing {len(batch)} orphans...")

                    try:
                        solutions = handle_orphan_pathways(batch, hierarchy_tree)

                        for solution in solutions:
                            orphan_name = solution.get('orphan_name')
                            orphan_pw = db.session.query(Pathway).filter_by(name=orphan_name).first()
                            if not orphan_pw:
                                continue

                            # NEW: Use hierarchy_chain from AI response
                            hierarchy_chain = solution.get('hierarchy_chain', [])
                            confidence = solution.get('confidence', 0.7)
                            new_intermediates = solution.get('new_intermediates', [])

                            if hierarchy_chain and len(hierarchy_chain) >= 2:
                                # Ensure full chain exists with proper links
                                logger.info(f"  {orphan_name} -> chain: {' -> '.join(hierarchy_chain)}")

                                # Create any new intermediates with descriptions
                                intermediate_descs = {
                                    inter['name']: inter.get('description', '')
                                    for inter in new_intermediates
                                }

                                # Build the chain
                                ensure_hierarchy_chain(db.session, hierarchy_chain, confidence)

                                # Update descriptions for new intermediates
                                for inter in new_intermediates:
                                    inter_pw = db.session.query(Pathway).filter_by(
                                        name=inter['name']
                                    ).first()
                                    if inter_pw and inter.get('description'):
                                        inter_pw.description = inter['description']
                                    if inter_pw and inter.get('go_id'):
                                        inter_pw.ontology_id = inter['go_id']
                                        inter_pw.ontology_source = 'GO'

                                stats.items_created += len(new_intermediates)
                            else:
                                # Fallback: old format or no chain
                                # Try to get parent from old format
                                parent_info = solution.get('parent', {})
                                if parent_info and parent_info.get('name'):
                                    parent_pw = db.session.query(Pathway).filter_by(
                                        name=parent_info['name']
                                    ).first()
                                    if parent_pw:
                                        create_parent_link(db.session, orphan_pw.id, parent_pw.id, confidence, 'AI')
                                        logger.info(f"  {orphan_name} -> fallback to '{parent_info['name']}'")
                                else:
                                    # Last resort: assign to Cellular Signaling
                                    root_pw = db.session.query(Pathway).filter_by(
                                        name="Cellular Signaling"
                                    ).first()
                                    if root_pw:
                                        create_parent_link(db.session, orphan_pw.id, root_pw.id, 0.5, 'AI_fallback')
                                        logger.warning(f"  {orphan_name} -> default fallback to 'Cellular Signaling'")

                            processed_orphans.add(orphan_pw.id)
                            stats.items_processed += 1

                        db.session.commit()

                    except Exception as e:
                        logger.error(f"Batch failed: {e}")
                        db.session.rollback()  # Prevent cascading transaction errors
                        stats.errors += 1

                    checkpoint_mgr.save(
                        phase=4,
                        data={
                            'processed_gaps': list(processed_gaps),
                            'processed_orphans': list(processed_orphans)
                        }
                    )

                    import time
                    time.sleep(1.5)

            # Phase 5: Update hierarchy metadata
            logger.info("")
            logger.info("-" * 40)
            logger.info("Phase 5: Updating hierarchy metadata")
            logger.info("-" * 40)

            update_hierarchy_metadata(db.session)
            db.session.commit()

            # Summary
            logger.info("")
            logger.info("=" * 60)
            logger.info("SUMMARY")
            logger.info("=" * 60)

            total_pathways = db.session.query(Pathway).count()
            total_links = db.session.query(PathwayParent).count()
            ai_created = db.session.query(Pathway).filter_by(ai_generated=True).count()

            logger.info(f"Total pathways: {total_pathways}")
            logger.info(f"AI-generated pathways: {ai_created}")
            logger.info(f"Total parent-child links: {total_links}")
            logger.info(f"Gaps processed: {len(processed_gaps)}")
            logger.info(f"Orphans handled: {len(processed_orphans)}")

            # Check for remaining orphans
            remaining_orphans = get_remaining_orphans(db.session)
            if remaining_orphans:
                logger.warning(f"Still have {len(remaining_orphans)} orphan pathways")
                for o in remaining_orphans[:5]:
                    logger.warning(f"  - {o['name']}")
            else:
                logger.info("All pathways are now in the hierarchy!")

            # Clear checkpoint
            checkpoint_mgr.clear()

            stats.end_time = datetime.now()
            report_path = save_run_report(stats)
            logger.info("")
            logger.info(f"Report saved to: {report_path}")
            logger.info("")
            logger.info("Script 04 completed successfully!")
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
