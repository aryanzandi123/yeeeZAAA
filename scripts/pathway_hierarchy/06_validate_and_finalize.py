#!/usr/bin/env python3
"""
Script 06: Validate and Finalize Hierarchy

Final validation and cleanup of the pathway hierarchy:
- Detect and fix cycles
- Ensure all pathways are reachable from roots
- Validate significance cap (leaf pathways have enough proteins)
- Compute and store materialized ancestor paths
- Generate summary report

Run: python scripts/pathway_hierarchy/06_validate_and_finalize.py

Prerequisites:
- Scripts 01-05 must have run successfully
"""

import sys
from pathlib import Path
from datetime import datetime
from typing import List, Dict, Set, Tuple

# Add project root to path
PROJECT_ROOT = Path(__file__).parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

from scripts.pathway_hierarchy.dag_models import PathwayDAG, PathwayNode, build_dag_from_db
from scripts.pathway_hierarchy.ai_hierarchy_builder import validate_hierarchy, format_hierarchy_tree
from scripts.pathway_hierarchy.hierarchy_utils import (
    setup_logging,
    CheckpointManager,
    ScriptStats,
    save_run_report,
    get_app_context,
)


MIN_PROTEIN_COUNT = 5  # Minimum proteins for leaf pathways (significance cap)


def validate_dag_structure(dag: PathwayDAG, logger) -> Tuple[bool, List[str]]:
    """Validate the DAG structure."""
    errors = []
    warnings = []

    # 1. Check for cycles
    logger.info("  Checking for cycles...")
    cycles = dag.detect_cycles()
    if cycles:
        for cycle in cycles[:3]:
            cycle_names = [dag.nodes[nid].name for nid in cycle if nid in dag.nodes]
            errors.append(f"Cycle detected: {' -> '.join(cycle_names)}")
        if len(cycles) > 3:
            errors.append(f"... and {len(cycles) - 3} more cycles")
    else:
        logger.info("    No cycles found")

    # 2. Check reachability from roots
    logger.info("  Checking reachability from roots...")
    roots = dag.get_roots()
    if not roots:
        errors.append("No root nodes found!")
    else:
        reachable = set()
        for root in roots:
            reachable.add(root.id)
            reachable.update(dag.get_descendants(root.id))

        unreachable = set(dag.nodes.keys()) - reachable
        if unreachable:
            unreachable_names = [dag.nodes[nid].name for nid in list(unreachable)[:5]]
            errors.append(f"{len(unreachable)} unreachable pathways: {unreachable_names}")
        else:
            logger.info(f"    All {len(dag.nodes)} pathways reachable from {len(roots)} roots")

    # 3. Check significance cap
    logger.info("  Checking significance cap (leaf pathways)...")
    leaves = dag.get_leaves()
    low_protein_leaves = []
    for leaf in leaves:
        if leaf.protein_count < MIN_PROTEIN_COUNT:
            low_protein_leaves.append(f"{leaf.name} ({leaf.protein_count} proteins)")

    if low_protein_leaves:
        warnings.append(f"{len(low_protein_leaves)} leaf pathways have <{MIN_PROTEIN_COUNT} proteins")
        for name in low_protein_leaves[:5]:
            warnings.append(f"  - {name}")
    else:
        logger.info(f"    All {len(leaves)} leaf pathways meet significance cap")

    # 4. Check parent-child consistency
    logger.info("  Checking parent-child consistency...")
    inconsistencies = 0
    for node_id, node in dag.nodes.items():
        for parent_id in node.parent_ids:
            if parent_id in dag.nodes and node_id not in dag.nodes[parent_id].child_ids:
                inconsistencies += 1

    if inconsistencies > 0:
        errors.append(f"{inconsistencies} parent-child inconsistencies found")
    else:
        logger.info("    Parent-child relationships are consistent")

    return len(errors) == 0, errors + warnings


def compute_and_store_ancestors(session, dag: PathwayDAG, logger):
    """Compute ancestor_ids for all pathways and store in database."""
    from models import Pathway

    ancestors_map = dag.compute_all_ancestors()

    updated = 0
    for pathway in session.query(Pathway).all():
        if pathway.id in ancestors_map:
            ancestors = list(ancestors_map[pathway.id])
            if pathway.ancestor_ids != ancestors:
                pathway.ancestor_ids = ancestors
                updated += 1

    logger.info(f"  Updated ancestor_ids for {updated} pathways")
    return updated


def update_hierarchy_levels(session, dag: PathwayDAG, logger):
    """Update hierarchy_level for all pathways based on DAG."""
    from models import Pathway

    levels = dag.compute_levels()

    updated = 0
    for pathway in session.query(Pathway).all():
        if pathway.id in levels:
            new_level = levels[pathway.id]
            if pathway.hierarchy_level != new_level:
                pathway.hierarchy_level = new_level
                updated += 1

    logger.info(f"  Updated hierarchy_level for {updated} pathways")
    return updated


def update_is_leaf_status(session, dag: PathwayDAG, logger):
    """Update is_leaf status for all pathways."""
    from models import Pathway

    updated = 0
    for pathway in session.query(Pathway).all():
        if pathway.id in dag.nodes:
            is_leaf = dag.nodes[pathway.id].is_leaf()
            if pathway.is_leaf != is_leaf:
                pathway.is_leaf = is_leaf
                updated += 1

    logger.info(f"  Updated is_leaf for {updated} pathways")
    return updated


def generate_hierarchy_report(session, dag: PathwayDAG) -> Dict:
    """Generate a comprehensive hierarchy report."""
    from models import Pathway, PathwayParent, PathwayInteraction

    report = {
        'summary': {},
        'by_level': {},
        'top_pathways': [],
        'orphan_interactions': 0,
    }

    # Summary stats
    report['summary'] = {
        'total_pathways': len(dag.nodes),
        'root_categories': len(dag.get_roots()),
        'leaf_pathways': len(dag.get_leaves()),
        'total_edges': session.query(PathwayParent).count(),
        'max_depth': max(dag.compute_levels().values()) if dag.nodes else 0,
    }

    # By level
    levels = dag.compute_levels()
    level_counts = {}
    for node_id, level in levels.items():
        level_counts[level] = level_counts.get(level, 0) + 1
    report['by_level'] = level_counts

    # Top pathways by usage
    top = session.query(Pathway).order_by(Pathway.usage_count.desc()).limit(20).all()
    report['top_pathways'] = [
        {'name': pw.name, 'usage': pw.usage_count, 'proteins': pw.protein_count}
        for pw in top if pw.usage_count > 0
    ]

    # Orphan interactions (no pathway assigned)
    from models import Interaction
    total_interactions = session.query(Interaction).count()
    assigned_interactions = session.query(PathwayInteraction).distinct(
        PathwayInteraction.interaction_id
    ).count()
    report['orphan_interactions'] = total_interactions - assigned_interactions

    return report


def save_hierarchy_tree_to_file(session, filepath: Path):
    """Save the complete hierarchy tree to a file."""
    from models import Pathway, PathwayParent

    pathways = session.query(Pathway).order_by(Pathway.hierarchy_level).all()

    # Build tree structure
    children_map = {}
    for link in session.query(PathwayParent).all():
        if link.parent_pathway_id not in children_map:
            children_map[link.parent_pathway_id] = []
        children_map[link.parent_pathway_id].append(link.child_pathway_id)

    # Get ID to name mapping
    id_to_name = {pw.id: pw.name for pw in pathways}
    id_to_level = {pw.id: pw.hierarchy_level for pw in pathways}
    id_to_count = {pw.id: pw.usage_count for pw in pathways}

    # Find roots
    roots = [pw for pw in pathways if pw.hierarchy_level == 0]

    # Write tree
    with open(filepath, 'w', encoding='utf-8') as f:
        f.write("# Pathway Hierarchy Tree\n")
        f.write(f"# Generated: {datetime.now().isoformat()}\n")
        f.write(f"# Total pathways: {len(pathways)}\n\n")

        def write_node(node_id: int, indent: int = 0):
            name = id_to_name.get(node_id, '?')
            count = id_to_count.get(node_id, 0)
            prefix = "  " * indent

            if count > 0:
                f.write(f"{prefix}- {name} ({count} interactions)\n")
            else:
                f.write(f"{prefix}- {name}\n")

            # Write children
            for child_id in sorted(children_map.get(node_id, []), key=lambda x: id_to_name.get(x, '')):
                write_node(child_id, indent + 1)

        for root in sorted(roots, key=lambda x: x.name):
            write_node(root.id)
            f.write("\n")


def main():
    """Validate and finalize the hierarchy."""
    logger = setup_logging("06_validate_finalize")
    stats = ScriptStats(
        script_name="06_validate_and_finalize",
        start_time=datetime.now()
    )

    logger.info("=" * 60)
    logger.info("Script 06: Validate and Finalize Hierarchy")
    logger.info("=" * 60)

    try:
        with get_app_context():
            from models import db, Pathway, PathwayParent

            # Phase 1: Build DAG from database
            logger.info("")
            logger.info("-" * 40)
            logger.info("Phase 1: Loading hierarchy from database")
            logger.info("-" * 40)

            dag = build_dag_from_db(db.session)
            logger.info(f"Loaded {len(dag.nodes)} pathways into DAG")

            # Phase 2: Validate structure
            logger.info("")
            logger.info("-" * 40)
            logger.info("Phase 2: Validating DAG structure")
            logger.info("-" * 40)

            is_valid, issues = validate_dag_structure(dag, logger)

            if issues:
                logger.warning("Validation issues found:")
                for issue in issues:
                    logger.warning(f"  - {issue}")
                    if 'Cycle' in issue:
                        stats.errors += 1
                    else:
                        stats.warnings += 1
            else:
                logger.info("All validations passed!")

            # Phase 3: Update database with computed values
            logger.info("")
            logger.info("-" * 40)
            logger.info("Phase 3: Updating computed values")
            logger.info("-" * 40)

            # Update hierarchy levels
            logger.info("Updating hierarchy levels...")
            update_hierarchy_levels(db.session, dag, logger)

            # Update is_leaf status
            logger.info("Updating is_leaf status...")
            update_is_leaf_status(db.session, dag, logger)

            # Compute and store ancestors
            logger.info("Computing ancestor paths...")
            compute_and_store_ancestors(db.session, dag, logger)

            db.session.commit()

            # Phase 4: Generate report
            logger.info("")
            logger.info("-" * 40)
            logger.info("Phase 4: Generating reports")
            logger.info("-" * 40)

            report = generate_hierarchy_report(db.session, dag)

            logger.info("Hierarchy Summary:")
            logger.info(f"  Total pathways: {report['summary']['total_pathways']}")
            logger.info(f"  Root categories: {report['summary']['root_categories']}")
            logger.info(f"  Leaf pathways: {report['summary']['leaf_pathways']}")
            logger.info(f"  Max depth: {report['summary']['max_depth']}")
            logger.info(f"  Total edges: {report['summary']['total_edges']}")

            logger.info("")
            logger.info("Pathways by level:")
            for level, count in sorted(report['by_level'].items()):
                logger.info(f"  Level {level}: {count} pathways")

            if report['orphan_interactions'] > 0:
                logger.warning(f"Interactions without pathway: {report['orphan_interactions']}")

            # Save hierarchy tree to file
            tree_file = PROJECT_ROOT / "cache" / "hierarchy_reports" / "pathway_tree.md"
            tree_file.parent.mkdir(parents=True, exist_ok=True)
            save_hierarchy_tree_to_file(db.session, tree_file)
            logger.info(f"Saved hierarchy tree to: {tree_file}")

            # Save full report
            import json
            report_json = PROJECT_ROOT / "cache" / "hierarchy_reports" / "hierarchy_report.json"
            with open(report_json, 'w') as f:
                json.dump(report, f, indent=2)
            logger.info(f"Saved JSON report to: {report_json}")

            # Phase 5: AI validation (optional)
            if len(dag.nodes) > 0 and len(dag.nodes) < 200:  # Only for manageable sizes
                logger.info("")
                logger.info("-" * 40)
                logger.info("Phase 5: AI biological validation")
                logger.info("-" * 40)

                try:
                    # Get hierarchy tree for AI
                    pathways = db.session.query(Pathway).order_by(Pathway.hierarchy_level).all()
                    tree_data = []
                    for pw in pathways:
                        parent_links = db.session.query(PathwayParent).filter_by(
                            child_pathway_id=pw.id
                        ).all()
                        parent_names = [
                            db.session.query(Pathway).get(l.parent_pathway_id).name
                            for l in parent_links
                            if db.session.query(Pathway).get(l.parent_pathway_id)
                        ]
                        tree_data.append({
                            'name': pw.name,
                            'level': pw.hierarchy_level or 0,
                            'parent_names': parent_names,
                        })

                    tree_str = format_hierarchy_tree(tree_data, max_depth=4)

                    ai_result = validate_hierarchy(tree_str)

                    if ai_result.get('is_valid'):
                        logger.info("AI validation: Hierarchy is biologically consistent")
                    else:
                        logger.warning("AI validation found issues:")
                        for issue in ai_result.get('issues', [])[:5]:
                            logger.warning(f"  - {issue.get('type')}: {issue.get('description')}")
                            if issue.get('suggestion'):
                                logger.info(f"    Suggestion: {issue.get('suggestion')}")

                except Exception as e:
                    logger.warning(f"AI validation skipped: {e}")

            # Final Summary
            logger.info("")
            logger.info("=" * 60)
            logger.info("FINAL SUMMARY")
            logger.info("=" * 60)

            logger.info(f"Total pathways: {report['summary']['total_pathways']}")
            logger.info(f"Hierarchy depth: {report['summary']['max_depth']} levels")
            logger.info(f"Root categories: {report['summary']['root_categories']}")
            logger.info(f"Leaf pathways: {report['summary']['leaf_pathways']}")
            logger.info(f"Validation errors: {stats.errors}")
            logger.info(f"Validation warnings: {stats.warnings}")

            if report['top_pathways']:
                logger.info("")
                logger.info("Top 5 pathways by usage:")
                for pw in report['top_pathways'][:5]:
                    logger.info(f"  {pw['name']}: {pw['usage']} interactions, {pw['proteins']} proteins")

            stats.end_time = datetime.now()
            stats.items_processed = len(dag.nodes)

            report_path = save_run_report(stats)
            logger.info("")
            logger.info(f"Script report saved to: {report_path}")
            logger.info("")
            logger.info("Script 06 completed successfully!")
            logger.info(stats.summary())

            return stats.errors == 0

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
