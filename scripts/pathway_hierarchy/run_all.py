#!/usr/bin/env python3
"""
Pathway Hierarchy Orchestrator

Runs all pathway hierarchy scripts in sequence:
1. Fetch ontology hierarchies (GO/KEGG)
2. Build base hierarchy scaffold
3. Classify existing pathways
4. Create missing branches (AI)
5. Assign interactions to most specific pathways
6. Validate and finalize

Usage:
    python scripts/pathway_hierarchy/run_all.py [options]

Options:
    --from STEP     Start from step N (1-6), default: 1
    --to STEP       Stop after step N (1-6), default: 6
    --force         Force re-run even if already completed
    --dry-run       Show what would be run without executing
"""

import sys
import subprocess
import time
from pathlib import Path
from datetime import datetime
from typing import List, Tuple

# Add project root to path
PROJECT_ROOT = Path(__file__).parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

from scripts.pathway_hierarchy.hierarchy_utils import setup_logging, ScriptStats, save_run_report


SCRIPTS = [
    {
        'number': 1,
        'name': '01_fetch_ontology_hierarchies',
        'description': 'Fetch GO/KEGG ontology hierarchies',
        'file': '01_fetch_ontology_hierarchies.py',
        'estimated_time': '5-10 minutes (with cache: instant)',
    },
    {
        'number': 2,
        'name': '02_build_base_hierarchy',
        'description': 'Build base hierarchy scaffold in database',
        'file': '02_build_base_hierarchy.py',
        'estimated_time': '1-2 minutes',
    },
    {
        'number': 3,
        'name': '03_classify_existing_pathways',
        'description': 'Classify existing pathways into hierarchy (AI)',
        'file': '03_classify_existing_pathways.py',
        'estimated_time': '5-15 minutes depending on pathway count',
    },
    {
        'number': 4,
        'name': '04_ai_create_missing_branches',
        'description': 'Create intermediate pathways where needed (AI)',
        'file': '04_ai_create_missing_branches.py',
        'estimated_time': '5-10 minutes',
    },
    {
        'number': 5,
        'name': '05_assign_interactions_to_leaves',
        'description': 'Assign interactions to most specific pathways (AI)',
        'file': '05_assign_interactions_to_leaves.py',
        'estimated_time': '10-30 minutes depending on interaction count',
    },
    {
        'number': 6,
        'name': '06_validate_and_finalize',
        'description': 'Validate hierarchy and finalize',
        'file': '06_validate_and_finalize.py',
        'estimated_time': '2-5 minutes',
    },
    {
        'number': 7,
        'name': '07_merge_duplicate_pathways',
        'description': 'Merge duplicate pathways by normalized name',
        'file': '07_merge_duplicate_pathways.py',
        'estimated_time': '1-2 minutes',
    },
]


def run_script(script_path: Path, logger) -> Tuple[bool, float]:
    """
    Run a script and return (success, duration_seconds).
    """
    start = time.time()

    try:
        result = subprocess.run(
            [sys.executable, str(script_path)],
            capture_output=True,
            text=True,
            timeout=3600,  # 1 hour timeout
        )

        duration = time.time() - start

        # Log output
        if result.stdout:
            for line in result.stdout.strip().split('\n'):
                logger.info(f"  | {line}")

        if result.returncode != 0:
            logger.error(f"Script failed with return code {result.returncode}")
            if result.stderr:
                for line in result.stderr.strip().split('\n'):
                    logger.error(f"  | {line}")
            return False, duration

        return True, duration

    except subprocess.TimeoutExpired:
        duration = time.time() - start
        logger.error("Script timed out after 1 hour")
        return False, duration

    except Exception as e:
        duration = time.time() - start
        logger.error(f"Error running script: {e}")
        return False, duration


def main(from_step: int = 1, to_step: int = 6, force: bool = False, dry_run: bool = False):
    """
    Run pathway hierarchy scripts in sequence.

    Args:
        from_step: Starting script number (1-6)
        to_step: Ending script number (1-6)
        force: Force re-run even if completed
        dry_run: Show what would run without executing
    """
    logger = setup_logging("run_all")
    stats = ScriptStats(
        script_name="pathway_hierarchy_orchestrator",
        start_time=datetime.now()
    )

    logger.info("=" * 70)
    logger.info("PATHWAY HIERARCHY BUILD ORCHESTRATOR")
    logger.info("=" * 70)
    logger.info("")
    logger.info(f"Running steps {from_step} to {to_step}")
    if force:
        logger.info("Force mode: Will re-run completed scripts")
    if dry_run:
        logger.info("DRY RUN: No scripts will actually execute")
    logger.info("")

    # Filter scripts to run
    scripts_to_run = [s for s in SCRIPTS if from_step <= s['number'] <= to_step]

    logger.info("Scripts to run:")
    for script in scripts_to_run:
        logger.info(f"  {script['number']}. {script['description']}")
        logger.info(f"     Estimated time: {script['estimated_time']}")
    logger.info("")

    if dry_run:
        logger.info("Dry run complete. No scripts executed.")
        return True

    # Run scripts
    results = []
    total_duration = 0

    for script in scripts_to_run:
        logger.info("-" * 70)
        logger.info(f"STEP {script['number']}: {script['description']}")
        logger.info("-" * 70)

        script_path = Path(__file__).parent / script['file']

        if not script_path.exists():
            logger.error(f"Script not found: {script_path}")
            results.append((script['number'], False, 0))
            stats.errors += 1
            continue

        logger.info(f"Running: {script['file']}")
        logger.info(f"Path: {script_path}")
        logger.info("")

        success, duration = run_script(script_path, logger)
        results.append((script['number'], success, duration))
        total_duration += duration

        if success:
            logger.info("")
            logger.info(f"Step {script['number']} completed successfully in {duration:.1f}s")
            stats.items_processed += 1
        else:
            logger.error("")
            logger.error(f"Step {script['number']} FAILED after {duration:.1f}s")
            stats.errors += 1

            # Ask whether to continue
            logger.warning("")
            logger.warning("Script failed. Stopping orchestrator.")
            logger.warning("Fix the issue and re-run with --from to resume.")
            break

        logger.info("")

        # Brief pause between scripts
        if script['number'] < to_step:
            time.sleep(2)

    # Summary
    logger.info("=" * 70)
    logger.info("ORCHESTRATOR SUMMARY")
    logger.info("=" * 70)
    logger.info("")

    succeeded = sum(1 for _, success, _ in results if success)
    failed = sum(1 for _, success, _ in results if not success)

    logger.info(f"Scripts run: {len(results)}")
    logger.info(f"Succeeded: {succeeded}")
    logger.info(f"Failed: {failed}")
    logger.info(f"Total duration: {total_duration:.1f}s ({total_duration/60:.1f} minutes)")
    logger.info("")

    logger.info("Results by step:")
    for step_num, success, duration in results:
        status = "OK" if success else "FAILED"
        logger.info(f"  Step {step_num}: {status} ({duration:.1f}s)")

    stats.end_time = datetime.now()
    report_path = save_run_report(stats)
    logger.info("")
    logger.info(f"Report saved to: {report_path}")

    if failed == 0:
        logger.info("")
        logger.info("=" * 70)
        logger.info("ALL STEPS COMPLETED SUCCESSFULLY!")
        logger.info("=" * 70)
        logger.info("")
        logger.info("Next steps:")
        logger.info("  1. Check the hierarchy report: cache/hierarchy_reports/pathway_tree.md")
        logger.info("  2. Review the JSON report: cache/hierarchy_reports/hierarchy_report.json")
        logger.info("  3. Test the frontend visualization")
        return True
    else:
        logger.error("")
        logger.error("ORCHESTRATOR COMPLETED WITH ERRORS")
        logger.error(f"Fix issues and re-run with: python run_all.py --from {results[-1][0]}")
        return False


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(
        description="Run pathway hierarchy build scripts",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
    # Run all scripts
    python run_all.py

    # Start from step 3
    python run_all.py --from 3

    # Run only steps 2-4
    python run_all.py --from 2 --to 4

    # Dry run to see what would execute
    python run_all.py --dry-run
        """
    )

    parser.add_argument(
        "--from", dest="from_step", type=int, default=1,
        choices=[1, 2, 3, 4, 5, 6, 7],
        help="Start from step N (default: 1)"
    )
    parser.add_argument(
        "--to", dest="to_step", type=int, default=7,
        choices=[1, 2, 3, 4, 5, 6, 7],
        help="Stop after step N (default: 7)"
    )
    parser.add_argument(
        "--force", "-f", action="store_true",
        help="Force re-run even if already completed"
    )
    parser.add_argument(
        "--dry-run", "-n", action="store_true",
        help="Show what would run without executing"
    )

    args = parser.parse_args()

    if args.from_step > args.to_step:
        parser.error("--from cannot be greater than --to")

    try:
        success = main(
            from_step=args.from_step,
            to_step=args.to_step,
            force=args.force,
            dry_run=args.dry_run
        )
        sys.exit(0 if success else 1)
    except KeyboardInterrupt:
        print("\nInterrupted by user")
        sys.exit(130)
    except Exception as e:
        print(f"Error: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)
