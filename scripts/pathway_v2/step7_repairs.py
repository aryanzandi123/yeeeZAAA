#!/usr/bin/env python3
"""
Step 7 Auto-Repair Functions
============================
Functions to automatically fix issues found during verification.
"""

import logging
from typing import List, Dict, Tuple, Optional
from dataclasses import dataclass
from collections import deque

from scripts.pathway_v2.step7_checks import Issue, Severity
from scripts.pathway_v2.step6_utils import STRICT_ROOTS
from scripts.pathway_v2.step6_utils import get_smart_rescue_parent

logger = logging.getLogger(__name__)


# ==============================================================================
# DATA STRUCTURES
# ==============================================================================

@dataclass
class RepairResult:
    """Result of a repair operation."""
    issue: Issue
    success: bool
    action_taken: str
    error: Optional[str] = None


@dataclass
class RepairSummary:
    """Summary of all repairs attempted."""
    total_issues: int
    attempted: int
    succeeded: int
    failed: int
    skipped: int
    results: List[RepairResult]

    def add_result(self, result: RepairResult):
        self.results.append(result)
        if result.success:
            self.succeeded += 1
        else:
            self.failed += 1


# ==============================================================================
# REPAIR FUNCTIONS
# ==============================================================================

def repair_missing_root(db, Pathway, name: str) -> RepairResult:
    """Create a missing root pathway."""
    issue = Issue(
        check_name="all_roots_exist",
        severity=Severity.CRITICAL,
        message=f"Creating missing root: {name}",
        entity_type="pathway",
        auto_fixable=True
    )

    try:
        existing = Pathway.query.filter_by(name=name).first()
        if existing:
            # Root exists but maybe wrong level
            existing.hierarchy_level = 0
            existing.is_leaf = False
            db.session.commit()
            return RepairResult(
                issue=issue,
                success=True,
                action_taken=f"Set existing pathway '{name}' to level 0"
            )

        # Create new root
        root = Pathway(
            name=name,
            hierarchy_level=0,
            is_leaf=False,
            ai_generated=False
        )
        db.session.add(root)
        db.session.commit()

        return RepairResult(
            issue=issue,
            success=True,
            action_taken=f"Created root pathway '{name}'"
        )

    except Exception as e:
        db.session.rollback()
        return RepairResult(
            issue=issue,
            success=False,
            action_taken="Failed to create root",
            error=str(e)
        )


def repair_root_level(db, Pathway, pathway_id: int) -> RepairResult:
    """Fix a root pathway that has wrong hierarchy level."""
    issue = Issue(
        check_name="all_roots_exist",
        severity=Severity.MEDIUM,
        message=f"Fixing root level for pathway {pathway_id}",
        entity_type="pathway",
        entity_id=pathway_id,
        auto_fixable=True
    )

    try:
        pw = Pathway.query.get(pathway_id)
        if not pw:
            return RepairResult(issue=issue, success=False,
                                action_taken="Pathway not found", error="Not found")

        old_level = pw.hierarchy_level
        pw.hierarchy_level = 0
        db.session.commit()

        return RepairResult(
            issue=issue,
            success=True,
            action_taken=f"Changed '{pw.name}' level from {old_level} to 0"
        )

    except Exception as e:
        db.session.rollback()
        return RepairResult(issue=issue, success=False,
                            action_taken="Failed", error=str(e))


def repair_usage_count(db, Pathway, PathwayInteraction, pathway_id: int) -> RepairResult:
    """Recalculate usage_count for a pathway."""
    issue = Issue(
        check_name="usage_count_accuracy",
        severity=Severity.LOW,
        message=f"Recalculating usage_count for pathway {pathway_id}",
        entity_type="pathway",
        entity_id=pathway_id,
        auto_fixable=True
    )

    try:
        pw = Pathway.query.get(pathway_id)
        if not pw:
            return RepairResult(issue=issue, success=False,
                                action_taken="Pathway not found", error="Not found")

        actual_count = PathwayInteraction.query.filter_by(pathway_id=pathway_id).count()
        old_count = pw.usage_count
        pw.usage_count = actual_count
        db.session.commit()

        return RepairResult(
            issue=issue,
            success=True,
            action_taken=f"Updated '{pw.name}' usage_count: {old_count} -> {actual_count}"
        )

    except Exception as e:
        db.session.rollback()
        return RepairResult(issue=issue, success=False,
                            action_taken="Failed", error=str(e))


def repair_hierarchy_level(db, Pathway, PathwayParent, pathway_id: int) -> RepairResult:
    """Recalculate hierarchy_level based on parent."""
    issue = Issue(
        check_name="levels_correct",
        severity=Severity.LOW,
        message=f"Recalculating level for pathway {pathway_id}",
        entity_type="pathway",
        entity_id=pathway_id,
        auto_fixable=True
    )

    try:
        pw = Pathway.query.get(pathway_id)
        if not pw:
            return RepairResult(issue=issue, success=False,
                                action_taken="Pathway not found", error="Not found")

        parent_link = PathwayParent.query.filter_by(child_pathway_id=pathway_id).first()
        if not parent_link:
            # No parent - should be root or orphan
            if pw.name in STRICT_ROOTS:
                pw.hierarchy_level = 0
            else:
                pw.hierarchy_level = -1  # Orphan
            db.session.commit()
            return RepairResult(
                issue=issue,
                success=True,
                action_taken=f"Set '{pw.name}' level to {pw.hierarchy_level} (no parent)"
            )

        parent = Pathway.query.get(parent_link.parent_pathway_id)
        if not parent:
            return RepairResult(issue=issue, success=False,
                                action_taken="Parent not found", error="Parent missing")

        old_level = pw.hierarchy_level
        pw.hierarchy_level = parent.hierarchy_level + 1
        db.session.commit()

        return RepairResult(
            issue=issue,
            success=True,
            action_taken=f"Updated '{pw.name}' level: {old_level} -> {pw.hierarchy_level}"
        )

    except Exception as e:
        db.session.rollback()
        return RepairResult(issue=issue, success=False,
                            action_taken="Failed", error=str(e))


def repair_is_leaf(db, Pathway, PathwayParent, pathway_id: int) -> RepairResult:
    """Recalculate is_leaf based on whether pathway has children."""
    issue = Issue(
        check_name="is_leaf_accurate",
        severity=Severity.LOW,
        message=f"Recalculating is_leaf for pathway {pathway_id}",
        entity_type="pathway",
        entity_id=pathway_id,
        auto_fixable=True
    )

    try:
        pw = Pathway.query.get(pathway_id)
        if not pw:
            return RepairResult(issue=issue, success=False,
                                action_taken="Pathway not found", error="Not found")

        has_children = PathwayParent.query.filter_by(parent_pathway_id=pathway_id).count() > 0
        old_value = pw.is_leaf
        pw.is_leaf = not has_children
        db.session.commit()

        return RepairResult(
            issue=issue,
            success=True,
            action_taken=f"Updated '{pw.name}' is_leaf: {old_value} -> {pw.is_leaf}"
        )

    except Exception as e:
        db.session.rollback()
        return RepairResult(issue=issue, success=False,
                            action_taken="Failed", error=str(e))


def repair_ancestor_ids(db, Pathway, PathwayParent, pathway_id: int) -> RepairResult:
    """Rebuild ancestor_ids JSONB from parent chain."""
    issue = Issue(
        check_name="ancestor_ids_accurate",
        severity=Severity.LOW,
        message=f"Rebuilding ancestor_ids for pathway {pathway_id}",
        entity_type="pathway",
        entity_id=pathway_id,
        auto_fixable=True
    )

    try:
        pw = Pathway.query.get(pathway_id)
        if not pw:
            return RepairResult(issue=issue, success=False,
                                action_taken="Pathway not found", error="Not found")

        # Build parent map
        parent_map = {
            link.child_pathway_id: link.parent_pathway_id
            for link in PathwayParent.query.all()
        }

        # Traverse upward
        ancestors = []
        current = pathway_id
        visited = set()

        while current in parent_map and current not in visited:
            visited.add(current)
            parent = parent_map[current]
            ancestors.append(parent)
            current = parent

        old_ancestors = pw.ancestor_ids
        pw.ancestor_ids = ancestors
        db.session.commit()

        return RepairResult(
            issue=issue,
            success=True,
            action_taken=f"Updated '{pw.name}' ancestors: {old_ancestors} -> {ancestors}"
        )

    except Exception as e:
        db.session.rollback()
        return RepairResult(issue=issue, success=False,
                            action_taken="Failed", error=str(e))


def repair_orphan_interaction(db, Interaction, Pathway, PathwayInteraction,
                               interaction_id: int) -> RepairResult:
    """Assign pathway to an orphaned interaction."""
    issue = Issue(
        check_name="interactions_have_pathway",
        severity=Severity.MEDIUM,
        message=f"Assigning pathway to interaction {interaction_id}",
        entity_type="interaction",
        entity_id=interaction_id,
        auto_fixable=True
    )

    try:
        interaction = Interaction.query.get(interaction_id)
        if not interaction:
            return RepairResult(issue=issue, success=False,
                                action_taken="Interaction not found", error="Not found")

        # Try to find pathway from interaction data
        assigned_pathway = None
        source = None

        if interaction.data:
            # Priority 1: step3_finalized_pathway
            if 'step3_finalized_pathway' in interaction.data:
                pw_name = interaction.data['step3_finalized_pathway']
                assigned_pathway = Pathway.query.filter_by(name=pw_name).first()
                if assigned_pathway:
                    source = "step3_finalized_pathway"

            # Priority 2: step2_proposal
            if not assigned_pathway and 'step2_proposal' in interaction.data:
                pw_name = interaction.data['step2_proposal']
                assigned_pathway = Pathway.query.filter_by(name=pw_name).first()
                if assigned_pathway:
                    source = "step2_proposal"

        # Priority 3: Fallback
        if not assigned_pathway:
            assigned_pathway = Pathway.query.filter_by(name="Protein Quality Control").first()
            source = "fallback"

        if not assigned_pathway:
            return RepairResult(issue=issue, success=False,
                                action_taken="No fallback pathway found", error="Missing fallback")

        # Create PathwayInteraction
        pi = PathwayInteraction(
            pathway_id=assigned_pathway.id,
            interaction_id=interaction_id,
            assignment_method=f'step7_repair_{source}'
        )
        db.session.add(pi)

        # Update interaction data
        if not interaction.data:
            interaction.data = {}
        interaction.data['_step7_repaired'] = True
        interaction.data['_step7_pathway'] = assigned_pathway.name

        db.session.commit()

        return RepairResult(
            issue=issue,
            success=True,
            action_taken=f"Assigned interaction {interaction_id} to '{assigned_pathway.name}' via {source}"
        )

    except Exception as e:
        db.session.rollback()
        return RepairResult(issue=issue, success=False,
                            action_taken="Failed", error=str(e))


def repair_dangling_pathway_link(db, PathwayInteraction, link_id: int) -> RepairResult:
    """Delete a PathwayInteraction pointing to missing pathway."""
    issue = Issue(
        check_name="pathway_references_valid",
        severity=Severity.MEDIUM,
        message=f"Deleting dangling link {link_id}",
        entity_type="pathway_interaction",
        entity_id=link_id,
        auto_fixable=True
    )

    try:
        pi = PathwayInteraction.query.get(link_id)
        if not pi:
            return RepairResult(issue=issue, success=False,
                                action_taken="Link not found", error="Not found")

        interaction_id = pi.interaction_id
        pathway_id = pi.pathway_id
        db.session.delete(pi)
        db.session.commit()

        return RepairResult(
            issue=issue,
            success=True,
            action_taken=f"Deleted link (interaction={interaction_id}, pathway={pathway_id})"
        )

    except Exception as e:
        db.session.rollback()
        return RepairResult(issue=issue, success=False,
                            action_taken="Failed", error=str(e))


def repair_broken_parent_link(db, PathwayParent, Pathway, link_id: int) -> RepairResult:
    """Fix or delete a PathwayParent with missing parent."""
    issue = Issue(
        check_name="parent_exists",
        severity=Severity.HIGH,
        message=f"Fixing broken parent link {link_id}",
        entity_type="pathway_parent",
        entity_id=link_id,
        auto_fixable=True
    )

    try:
        link = PathwayParent.query.get(link_id)
        if not link:
            return RepairResult(issue=issue, success=False,
                                action_taken="Link not found", error="Not found")

        child = Pathway.query.get(link.child_pathway_id)
        if not child:
            db.session.delete(link)
            db.session.commit()
            return RepairResult(
                issue=issue,
                success=True,
                action_taken="Deleted link (child also missing)"
            )

        # Try to assign to fallback root
        fallback = Pathway.query.filter_by(name="Protein Quality Control").first()
        if fallback:
            link.parent_pathway_id = fallback.id
            db.session.commit()
            return RepairResult(
                issue=issue,
                success=True,
                action_taken=f"Reassigned '{child.name}' to Protein Quality Control"
            )

        # No fallback - delete link
        db.session.delete(link)
        db.session.commit()
        return RepairResult(
            issue=issue,
            success=True,
            action_taken=f"Deleted broken link for '{child.name}'"
        )

    except Exception as e:
        db.session.rollback()
        return RepairResult(issue=issue, success=False,
                            action_taken="Failed", error=str(e))


def repair_orphan_pathway(db, Pathway, PathwayParent, pathway_id: int) -> RepairResult:
    """Attach an orphaned pathway to the semantically correct root using smart rescue."""
    issue = Issue(
        check_name="no_orphan_pathways",
        severity=Severity.MEDIUM,
        message=f"Rescuing orphaned pathway {pathway_id}",
        entity_type="pathway",
        entity_id=pathway_id,
        auto_fixable=True
    )

    try:
        pw = Pathway.query.get(pathway_id)
        if not pw:
            return RepairResult(issue=issue, success=False,
                                action_taken="Pathway not found", error="Not found")

        # Don't touch roots
        if pw.name in STRICT_ROOTS:
            pw.hierarchy_level = 0
            db.session.commit()
            return RepairResult(
                issue=issue,
                success=True,
                action_taken=f"Fixed root '{pw.name}' level to 0"
            )

        # Use SMART rescue to find the correct root based on semantic meaning
        smart_parent = get_smart_rescue_parent(pw.name, Pathway)
        if not smart_parent:
            # Fallback to Protein Quality Control if smart rescue fails
            smart_parent = Pathway.query.filter_by(name="Protein Quality Control").first()
            if not smart_parent:
                return RepairResult(issue=issue, success=False,
                                    action_taken="No fallback root", error="Missing fallback")

        # Check if already has parent link
        existing_link = PathwayParent.query.filter_by(child_pathway_id=pathway_id).first()
        if existing_link:
            existing_link.parent_pathway_id = smart_parent.id
        else:
            new_link = PathwayParent(
                child_pathway_id=pathway_id,
                parent_pathway_id=smart_parent.id,
                relationship_type='is_a'
            )
            db.session.add(new_link)

        pw.hierarchy_level = 1
        db.session.commit()

        return RepairResult(
            issue=issue,
            success=True,
            action_taken=f"Smart rescue: '{pw.name}' -> '{smart_parent.name}'"
        )

    except Exception as e:
        db.session.rollback()
        return RepairResult(issue=issue, success=False,
                            action_taken="Failed", error=str(e))


# ==============================================================================
# BATCH REPAIRS
# ==============================================================================

def recalculate_all_levels(db, Pathway, PathwayParent) -> int:
    """Recalculate hierarchy_level for all pathways via BFS."""
    logger.info("Recalculating all hierarchy levels...")

    # Reset all to -1
    for pw in Pathway.query.all():
        pw.hierarchy_level = -1

    # Build child graph
    child_graph = {}
    for link in PathwayParent.query.all():
        if link.parent_pathway_id not in child_graph:
            child_graph[link.parent_pathway_id] = []
        child_graph[link.parent_pathway_id].append(link.child_pathway_id)

    # Initialize roots
    queue = deque()
    for pw in Pathway.query.all():
        if pw.name in STRICT_ROOTS:
            pw.hierarchy_level = 0
            queue.append(pw.id)

    # BFS
    updated = 0
    while queue:
        current_id = queue.popleft()
        current = Pathway.query.get(current_id)
        if not current:
            continue

        for child_id in child_graph.get(current_id, []):
            child = Pathway.query.get(child_id)
            if child and child.hierarchy_level == -1:
                child.hierarchy_level = current.hierarchy_level + 1
                queue.append(child_id)
                updated += 1

    db.session.commit()
    logger.info(f"Recalculated levels for {updated} pathways")
    return updated


def recalculate_all_usage_counts(db, Pathway, PathwayInteraction) -> int:
    """Recalculate usage_count for all pathways."""
    from sqlalchemy import func

    logger.info("Recalculating all usage counts...")

    # Get actual counts
    actual_counts = dict(
        db.session.query(
            PathwayInteraction.pathway_id,
            func.count(PathwayInteraction.id)
        ).group_by(PathwayInteraction.pathway_id).all()
    )

    updated = 0
    for pw in Pathway.query.all():
        actual = actual_counts.get(pw.id, 0)
        if pw.usage_count != actual:
            pw.usage_count = actual
            updated += 1

    db.session.commit()
    logger.info(f"Updated usage_count for {updated} pathways")
    return updated


def recalculate_all_is_leaf(db, Pathway, PathwayParent) -> int:
    """Recalculate is_leaf for all pathways."""
    logger.info("Recalculating all is_leaf flags...")

    # Get pathways that have children
    parents_with_children = set(
        row[0] for row in
        PathwayParent.query.with_entities(PathwayParent.parent_pathway_id).distinct().all()
    )

    updated = 0
    for pw in Pathway.query.all():
        should_be_leaf = pw.id not in parents_with_children
        if pw.is_leaf != should_be_leaf:
            pw.is_leaf = should_be_leaf
            updated += 1

    db.session.commit()
    logger.info(f"Updated is_leaf for {updated} pathways")
    return updated


def recalculate_all_ancestor_ids(db, Pathway, PathwayParent) -> int:
    """Recalculate ancestor_ids for all pathways."""
    logger.info("Recalculating all ancestor_ids...")

    # Build parent map
    parent_map = {
        link.child_pathway_id: link.parent_pathway_id
        for link in PathwayParent.query.all()
    }

    updated = 0
    for pw in Pathway.query.all():
        # Traverse upward
        ancestors = []
        current = pw.id
        visited = set()

        while current in parent_map and current not in visited:
            visited.add(current)
            parent = parent_map[current]
            ancestors.append(parent)
            current = parent

        # Type-safe comparison: ancestor_ids might be int/None/corrupted from JSONB
        stored = pw.ancestor_ids if isinstance(pw.ancestor_ids, list) else []
        if stored != ancestors:
            pw.ancestor_ids = ancestors
            updated += 1

    db.session.commit()
    logger.info(f"Updated ancestor_ids for {updated} pathways")
    return updated


# ==============================================================================
# MASTER REPAIR RUNNER
# ==============================================================================

def run_auto_repairs(
    issues: List[Issue],
    db,
    Pathway,
    PathwayParent,
    PathwayInteraction,
    Interaction
) -> RepairSummary:
    """
    Run auto-repairs for all fixable issues.

    Returns RepairSummary with details of all repairs attempted.
    """
    summary = RepairSummary(
        total_issues=len(issues),
        attempted=0,
        succeeded=0,
        failed=0,
        skipped=0,
        results=[]
    )

    # First, run batch recalculations for LOW severity issues
    low_issues = [i for i in issues if i.severity == Severity.LOW]
    if low_issues:
        logger.info("Running batch recalculations for LOW severity issues...")
        recalculate_all_levels(db, Pathway, PathwayParent)
        recalculate_all_usage_counts(db, Pathway, PathwayInteraction)
        recalculate_all_is_leaf(db, Pathway, PathwayParent)
        recalculate_all_ancestor_ids(db, Pathway, PathwayParent)

    # Process individual repairs for MEDIUM+ issues
    for issue in issues:
        if not issue.auto_fixable:
            summary.skipped += 1
            continue

        if issue.severity == Severity.LOW:
            # Already handled by batch recalculations
            summary.skipped += 1
            continue

        summary.attempted += 1

        try:
            result = None

            # Route to appropriate repair function
            if issue.check_name == "all_roots_exist" and "Missing root" in issue.message:
                name = issue.message.split(": ")[1] if ": " in issue.message else None
                if name:
                    result = repair_missing_root(db, Pathway, name)

            elif issue.check_name == "all_roots_exist":
                if issue.entity_id:
                    result = repair_root_level(db, Pathway, issue.entity_id)

            elif issue.check_name == "interactions_have_pathway":
                if issue.entity_id:
                    result = repair_orphan_interaction(
                        db, Interaction, Pathway, PathwayInteraction, issue.entity_id
                    )

            elif issue.check_name == "pathway_references_valid":
                if issue.entity_id:
                    result = repair_dangling_pathway_link(db, PathwayInteraction, issue.entity_id)

            elif issue.check_name == "parent_exists":
                if issue.entity_id:
                    result = repair_broken_parent_link(db, PathwayParent, Pathway, issue.entity_id)

            elif issue.check_name == "no_orphan_pathways":
                if issue.entity_id:
                    result = repair_orphan_pathway(db, Pathway, PathwayParent, issue.entity_id)

            if result:
                summary.add_result(result)
            else:
                summary.skipped += 1
                summary.attempted -= 1

        except Exception as e:
            logger.error(f"Error repairing issue: {e}")
            summary.add_result(RepairResult(
                issue=issue,
                success=False,
                action_taken="Exception during repair",
                error=str(e)
            ))

    return summary
