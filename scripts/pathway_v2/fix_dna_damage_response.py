#!/usr/bin/env python3
"""
Fix DNA Damage Response Pathway Hierarchy
==========================================
Corrects the DNA Damage Response pathway which was incorrectly
hardcoded as a root (Level 0) but should be a child of Cellular Stress Response.

Hierarchy chain after fix:
  Cellular Signaling (L0)
    -> Cellular Response to Stimuli (L1)
      -> Cellular Stress Response (L2)
        -> DNA Damage Response (L3)

Changes made:
1. Ensures intermediate pathways exist (Cellular Response to Stimuli, Cellular Stress Response)
2. Sets DNA Damage Response's parent to Cellular Stress Response
3. Updates hierarchy_level to 3
4. Updates ancestor_ids for DNA Damage Response and its descendants
5. Removes any existing root-level parent link

Usage:
    python scripts/pathway_v2/fix_dna_damage_response.py [--dry-run]
"""

import sys
import logging
import argparse
from pathlib import Path
from collections import deque

# Add project root to path
PROJECT_ROOT = Path(__file__).parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

# Setup logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)


def fix_dna_damage_response(dry_run: bool = False):
    """
    Fix the DNA Damage Response pathway hierarchy.

    Steps:
    1. Find "Cellular Signaling" root (must exist)
    2. Find or create "Cellular Response to Stimuli" at L1
    3. Find or create "Cellular Stress Response" at L2
    4. Update DNA Damage Response to L3 under Cellular Stress Response
    5. Recalculate ancestor_ids and descendant levels
    """
    try:
        from app import app, db
        from models import Pathway, PathwayParent
    except ImportError as e:
        logger.error(f"Failed to import app/db: {e}")
        return False

    with app.app_context():
        logger.info("=" * 60)
        logger.info("FIX DNA DAMAGE RESPONSE PATHWAY HIERARCHY")
        logger.info(f"Mode: {'DRY RUN' if dry_run else 'LIVE'}")
        logger.info("=" * 60)

        # Step 1: Find DNA Damage Response
        dna_damage = Pathway.query.filter_by(name="DNA Damage Response").first()
        if not dna_damage:
            logger.warning("DNA Damage Response pathway not found in database - nothing to fix.")
            return True

        logger.info(f"Found: '{dna_damage.name}' (ID: {dna_damage.id}, Level: {dna_damage.hierarchy_level})")

        if dna_damage.hierarchy_level != 0:
            logger.info(f"DNA Damage Response is already at level {dna_damage.hierarchy_level} - checking parent...")
            parent_link = PathwayParent.query.filter_by(child_pathway_id=dna_damage.id).first()
            if parent_link:
                parent = Pathway.query.get(parent_link.parent_pathway_id)
                if parent and parent.name == "Cellular Stress Response":
                    logger.info("Already correctly linked to Cellular Stress Response. No fix needed.")
                    return True

        # Step 2: Find Cellular Signaling root (must exist)
        cellular_signaling = Pathway.query.filter_by(name="Cellular Signaling").first()
        if not cellular_signaling:
            logger.error("Root 'Cellular Signaling' not found - cannot proceed!")
            return False
        logger.info(f"Found root: '{cellular_signaling.name}' (ID: {cellular_signaling.id})")

        # Step 3: Find or create "Cellular Response to Stimuli" (L1)
        cellular_response = Pathway.query.filter_by(name="Cellular Response to Stimuli").first()
        if not cellular_response:
            logger.info("Creating 'Cellular Response to Stimuli' at Level 1...")
            if not dry_run:
                cellular_response = Pathway(
                    name="Cellular Response to Stimuli",
                    hierarchy_level=1,
                    is_leaf=False,
                    ai_generated=True,
                    description="Cellular processes activated in response to external or internal stimuli.",
                    ancestor_ids=[cellular_signaling.id]
                )
                db.session.add(cellular_response)
                db.session.flush()  # Get ID

                # Link to Cellular Signaling
                link = PathwayParent(
                    child_pathway_id=cellular_response.id,
                    parent_pathway_id=cellular_signaling.id,
                    relationship_type='is_a'
                )
                db.session.add(link)
                logger.info(f"  Created with ID: {cellular_response.id}")
            else:
                logger.info("  [DRY RUN] Would create pathway")
        else:
            logger.info(f"Found: '{cellular_response.name}' (ID: {cellular_response.id})")

        # Step 4: Find or create "Cellular Stress Response" (L2)
        cellular_stress = Pathway.query.filter_by(name="Cellular Stress Response").first()
        if not cellular_stress:
            logger.info("Creating 'Cellular Stress Response' at Level 2...")
            if not dry_run:
                cellular_stress = Pathway(
                    name="Cellular Stress Response",
                    hierarchy_level=2,
                    is_leaf=False,
                    ai_generated=True,
                    description="Pathways that sense and respond to various cellular stress conditions.",
                    ancestor_ids=[cellular_signaling.id, cellular_response.id] if cellular_response else [cellular_signaling.id]
                )
                db.session.add(cellular_stress)
                db.session.flush()  # Get ID

                # Link to Cellular Response to Stimuli
                if cellular_response:
                    link = PathwayParent(
                        child_pathway_id=cellular_stress.id,
                        parent_pathway_id=cellular_response.id,
                        relationship_type='is_a'
                    )
                    db.session.add(link)
                logger.info(f"  Created with ID: {cellular_stress.id}")
            else:
                logger.info("  [DRY RUN] Would create pathway")
        else:
            logger.info(f"Found: '{cellular_stress.name}' (ID: {cellular_stress.id})")

        # Step 5: Check/update parent link for DNA Damage Response
        current_parent_link = PathwayParent.query.filter_by(
            child_pathway_id=dna_damage.id
        ).first()

        if current_parent_link:
            current_parent = Pathway.query.get(current_parent_link.parent_pathway_id)
            logger.info(f"Current parent: '{current_parent.name if current_parent else 'Unknown'}' (ID: {current_parent_link.parent_pathway_id})")

            # Check if it's already pointing to Cellular Stress Response
            if cellular_stress and current_parent_link.parent_pathway_id == cellular_stress.id:
                logger.info("  Parent link already points to Cellular Stress Response - keeping it")
            else:
                if dry_run:
                    logger.info(f"  [DRY RUN] Would update parent link to Cellular Stress Response")
                else:
                    # Update existing link instead of delete/recreate
                    current_parent_link.parent_pathway_id = cellular_stress.id
                    logger.info("  Updated parent link to Cellular Stress Response")
        else:
            logger.info("No existing parent link (was treated as root)")
            # Step 6: Create new parent link to Cellular Stress Response
            if dry_run:
                logger.info(f"[DRY RUN] Would create parent link: DNA Damage Response -> Cellular Stress Response")
            else:
                if cellular_stress:
                    new_link = PathwayParent(
                        child_pathway_id=dna_damage.id,
                        parent_pathway_id=cellular_stress.id,
                        relationship_type='is_a'
                    )
                    db.session.add(new_link)
                    logger.info(f"Created parent link: DNA Damage Response -> Cellular Stress Response")

        # Step 6: Update hierarchy level and ancestor_ids
        if dry_run:
            logger.info(f"[DRY RUN] Would update level: {dna_damage.hierarchy_level} -> 3")
        else:
            # Update hierarchy_level
            old_level = dna_damage.hierarchy_level
            dna_damage.hierarchy_level = 3
            logger.info(f"Updated level: {old_level} -> 3")

            # Update ancestor_ids
            dna_damage.ancestor_ids = [
                cellular_signaling.id,
                cellular_response.id if cellular_response else None,
                cellular_stress.id
            ]
            # Filter out None values
            dna_damage.ancestor_ids = [a for a in dna_damage.ancestor_ids if a is not None]
            logger.info(f"Updated ancestor_ids: {dna_damage.ancestor_ids}")

            # Mark as not a leaf if it has children
            dna_damage.is_leaf = False

        # Step 7: Recalculate levels for any children of DNA Damage Response
        if not dry_run:
            children_updated = _recalculate_descendant_levels(db, Pathway, PathwayParent, dna_damage.id, 3)
            logger.info(f"Updated {children_updated} descendant pathways")

            # Also update Cellular Signaling to not be a leaf
            cellular_signaling.is_leaf = False

            # Commit all changes
            db.session.commit()
            logger.info("All changes committed successfully")
        else:
            logger.info("[DRY RUN] No changes committed")

        logger.info("=" * 60)
        logger.info("FIX COMPLETE")
        logger.info("=" * 60)

        return True


def _recalculate_descendant_levels(db, Pathway, PathwayParent, parent_id: int, parent_level: int) -> int:
    """Recursively update hierarchy levels and ancestor_ids for all descendants."""
    updated = 0
    queue = deque([(parent_id, parent_level)])

    # Build ancestor chain for parent
    parent_pathway = Pathway.query.get(parent_id)
    parent_ancestors = parent_pathway.ancestor_ids if parent_pathway else []

    while queue:
        current_id, current_level = queue.popleft()
        current_pathway = Pathway.query.get(current_id)
        current_ancestors = current_pathway.ancestor_ids if current_pathway else []

        # Find all children
        children = PathwayParent.query.filter_by(parent_pathway_id=current_id).all()
        for child_link in children:
            child = Pathway.query.get(child_link.child_pathway_id)
            if child:
                new_level = current_level + 1
                new_ancestors = current_ancestors + [current_id]

                changed = False
                if child.hierarchy_level != new_level:
                    child.hierarchy_level = new_level
                    changed = True
                if child.ancestor_ids != new_ancestors:
                    child.ancestor_ids = new_ancestors
                    changed = True

                if changed:
                    updated += 1
                    logger.info(f"  Updated '{child.name}': level -> {new_level}")

                queue.append((child.id, new_level))

    return updated


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Fix DNA Damage Response pathway hierarchy")
    parser.add_argument("--dry-run", action="store_true", help="Show what would be changed without making changes")
    args = parser.parse_args()

    success = fix_dna_damage_response(dry_run=args.dry_run)
    sys.exit(0 if success else 1)
