#!/usr/bin/env python3
"""
Script 01: Fetch KEGG Pathway Hierarchy

Downloads KEGG pathway hierarchies from the KEGG REST API.
These hierarchies serve as the scaffold for organizing pathways.

Run: python scripts/pathway_hierarchy/01_fetch_ontology_hierarchies.py [--force]

Output:
- cache/ontology_hierarchies/kegg_hierarchy.json
"""

import sys
from pathlib import Path
from datetime import datetime

# Add project root to path
PROJECT_ROOT = Path(__file__).parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

from scripts.pathway_hierarchy.ontology_client import (
    get_cached_kegg_hierarchy,
    CACHE_DIR,
)
from scripts.pathway_hierarchy.hierarchy_utils import (
    setup_logging,
    ScriptStats,
    save_run_report,
)


def main(force_refresh: bool = False):
    """
    Fetch and cache KEGG pathway hierarchy.

    Args:
        force_refresh: If True, re-download even if cache exists
    """
    logger = setup_logging("01_fetch_ontologies")
    stats = ScriptStats(
        script_name="01_fetch_ontology_hierarchies",
        start_time=datetime.now()
    )

    logger.info("=" * 60)
    logger.info("Script 01: Fetch KEGG Pathway Hierarchy")
    logger.info("=" * 60)

    # Ensure cache directory exists
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    logger.info(f"Cache directory: {CACHE_DIR}")

    try:
        # Fetch KEGG hierarchy
        logger.info("")
        logger.info("-" * 40)
        logger.info("Fetching KEGG pathway hierarchy...")
        logger.info("-" * 40)

        kegg_cache = CACHE_DIR / "kegg_hierarchy.json"
        if kegg_cache.exists() and not force_refresh:
            logger.info(f"KEGG cache exists at {kegg_cache}")
            logger.info("Use --force to re-download")
        else:
            logger.info("Downloading KEGG hierarchy from KEGG REST API...")
            logger.info("This may take 2-5 minutes...")

        kegg_hierarchy = get_cached_kegg_hierarchy(force_refresh=force_refresh)
        kegg_terms = len(kegg_hierarchy.terms)

        if kegg_terms == 0:
            raise RuntimeError("KEGG hierarchy fetch returned 0 terms - API may be down")

        logger.info(f"KEGG hierarchy loaded: {kegg_terms} pathways")
        stats.items_processed = kegg_terms

        # Summary
        logger.info("")
        logger.info("=" * 60)
        logger.info("SUMMARY")
        logger.info("=" * 60)
        logger.info(f"KEGG pathways: {kegg_terms}")
        logger.info("")
        logger.info("Cache file:")
        logger.info(f"  - {kegg_cache}")

        # Show some example KEGG pathways
        logger.info("")
        logger.info("Sample KEGG pathways:")
        sample_count = 0
        for term in kegg_hierarchy.terms.values():
            if term.id.startswith("hsa") and sample_count < 5:
                logger.info(f"  - {term.id}: {term.name}")
                sample_count += 1

        stats.end_time = datetime.now()
        stats.items_created = kegg_terms

        # Save report
        report_path = save_run_report(stats)
        logger.info("")
        logger.info(f"Report saved to: {report_path}")
        logger.info("")
        logger.info("Script 01 completed successfully!")
        logger.info(stats.summary())

        return True

    except Exception as e:
        logger.error(f"Script failed: {e}")
        import traceback
        traceback.print_exc()
        stats.errors += 1
        stats.end_time = datetime.now()
        save_run_report(stats)
        raise


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(
        description="Fetch and cache KEGG pathway hierarchy"
    )
    parser.add_argument(
        "--force", "-f",
        action="store_true",
        help="Force re-download even if cache exists"
    )

    args = parser.parse_args()

    try:
        success = main(force_refresh=args.force)
        sys.exit(0 if success else 1)
    except Exception as e:
        print(f"Error: {e}")
        sys.exit(1)
