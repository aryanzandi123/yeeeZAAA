#!/usr/bin/env python3
"""
Pathway Hierarchy Configuration - DATABASE-DRIVEN
===================================================
Queries ROOT_CATEGORIES and SUB_CATEGORIES from PostgreSQL.
NO hardcoded pathway definitions - everything comes from the database.

Initial seeding is done by migrate_add_hierarchy_columns.py (run ONCE).
All subsequent pathways are discovered by AI classification.

Usage:
    from scripts.pathway_hierarchy.pathway_config import ROOT_CATEGORY_NAMES

    # Check if pathway is a root
    if pathway_name in ROOT_CATEGORY_NAMES:
        ...

The module provides lazy-loaded access to:
- ROOT_CATEGORIES: List of root pathway dicts (hierarchy_level=0)
- ROOT_CATEGORY_NAMES: Set of root pathway names for validation
- SUB_CATEGORIES: Dict mapping parent names to child pathway lists
"""

import sys
import logging
from pathlib import Path
from functools import lru_cache
from typing import List, Dict, Set, Optional

# Add project root to path
PROJECT_ROOT = Path(__file__).parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

logger = logging.getLogger(__name__)

# Cache timeout - clear cache periodically to pick up new pathways
_cache_initialized = False


def _get_db_context():
    """Get database context safely."""
    try:
        from app import app, db
        return app, db
    except ImportError as e:
        logger.warning(f"Could not import app/db: {e}")
        return None, None


def _clear_cache():
    """Clear all cached data - call when pathways are modified."""
    global _cache_initialized
    _get_root_categories_from_db.cache_clear()
    _get_sub_categories_from_db.cache_clear()
    _cache_initialized = False


@lru_cache(maxsize=1)
def _get_root_categories_from_db() -> List[Dict]:
    """
    Query root categories from database (hierarchy_level = 0).
    Returns list of dicts with name, go_id, description.
    """
    app, db = _get_db_context()
    if app is None:
        logger.warning("Database not available, returning empty root categories")
        return []

    try:
        with app.app_context():
            from models import Pathway

            roots = Pathway.query.filter_by(hierarchy_level=0).all()
            return [
                {
                    "name": p.name,
                    "go_id": p.ontology_id,
                    "description": p.description or "",
                }
                for p in roots
            ]
    except Exception as e:
        logger.warning(f"Error querying root categories: {e}")
        return []


@lru_cache(maxsize=1)
def _get_sub_categories_from_db() -> Dict[str, List[Dict]]:
    """
    Query sub-categories from pathway_parents relationships.
    Returns dict mapping parent name to list of child dicts.
    """
    app, db = _get_db_context()
    if app is None:
        logger.warning("Database not available, returning empty sub-categories")
        return {}

    try:
        with app.app_context():
            from models import Pathway, PathwayParent

            # Build parent_id -> parent_name lookup
            pathways = {p.id: p for p in Pathway.query.all()}

            # Get all parent-child links
            links = PathwayParent.query.all()

            sub_cats = {}
            for link in links:
                parent = pathways.get(link.parent_pathway_id)
                child = pathways.get(link.child_pathway_id)

                if parent and child:
                    if parent.name not in sub_cats:
                        sub_cats[parent.name] = []
                    sub_cats[parent.name].append({
                        "name": child.name,
                        "go_id": child.ontology_id,
                    })

            return sub_cats
    except Exception as e:
        logger.warning(f"Error querying sub-categories: {e}")
        return {}


def get_root_category_names() -> Set[str]:
    """Get set of root category names for validation."""
    return {cat["name"] for cat in _get_root_categories_from_db()}


def get_root_categories() -> List[Dict]:
    """Get list of root category dicts."""
    return _get_root_categories_from_db()


def get_sub_categories() -> Dict[str, List[Dict]]:
    """Get dict of sub-categories by parent name."""
    return _get_sub_categories_from_db()


# =============================================================================
# PUBLIC API - Backward compatible with hardcoded version
# =============================================================================
# These are accessed as module-level variables by other scripts.
# We use a lazy property pattern to defer database queries until needed.

class _LazyConfig:
    """Lazy loader for pathway configuration from database."""

    @property
    def ROOT_CATEGORIES(self) -> List[Dict]:
        return get_root_categories()

    @property
    def ROOT_CATEGORY_NAMES(self) -> Set[str]:
        return get_root_category_names()

    @property
    def SUB_CATEGORIES(self) -> Dict[str, List[Dict]]:
        return get_sub_categories()


# Create singleton instance
_config = _LazyConfig()

# Export as module-level attributes for backward compatibility
# Scripts can do: from pathway_config import ROOT_CATEGORY_NAMES
ROOT_CATEGORIES = property(lambda self: _config.ROOT_CATEGORIES)
ROOT_CATEGORY_NAMES = property(lambda self: _config.ROOT_CATEGORY_NAMES)
SUB_CATEGORIES = property(lambda self: _config.SUB_CATEGORIES)


# For direct attribute access (when imported as module)
def __getattr__(name):
    """Allow module-level attribute access to lazy-loaded config."""
    if name == "ROOT_CATEGORIES":
        return get_root_categories()
    elif name == "ROOT_CATEGORY_NAMES":
        return get_root_category_names()
    elif name == "SUB_CATEGORIES":
        return get_sub_categories()
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


# =============================================================================
# HELPER FUNCTIONS
# =============================================================================

def get_all_pathway_names() -> Set[str]:
    """Get all pathway names (roots + sub-categories)."""
    names = get_root_category_names().copy()
    for subcats in get_sub_categories().values():
        for sub in subcats:
            names.add(sub["name"])
    return names


def get_parent_for_pathway(pathway_name: str) -> Optional[str]:
    """Get the parent pathway name for a given pathway."""
    for parent, children in get_sub_categories().items():
        for child in children:
            if child["name"] == pathway_name:
                return parent
    return None


def get_children_for_pathway(pathway_name: str) -> List[str]:
    """Get child pathway names for a given pathway."""
    return [child["name"] for child in get_sub_categories().get(pathway_name, [])]


def is_root_category(pathway_name: str) -> bool:
    """Check if a pathway is a root category."""
    return pathway_name in get_root_category_names()


def refresh_config():
    """Force refresh of cached configuration from database."""
    _clear_cache()
    logger.info("Pathway config cache cleared")


# =============================================================================
# DEBUGGING
# =============================================================================

def print_config_status():
    """Print current configuration status (for debugging)."""
    print("=" * 60)
    print("PATHWAY CONFIG STATUS (Database-Driven)")
    print("=" * 60)

    roots = get_root_categories()
    print(f"\nRoot categories ({len(roots)}):")
    for r in roots:
        print(f"  - {r['name']} ({r.get('go_id', 'N/A')})")

    subs = get_sub_categories()
    print(f"\nSub-category relationships ({len(subs)} parents):")
    for parent, children in sorted(subs.items())[:5]:  # Show first 5
        print(f"  {parent}:")
        for c in children[:3]:  # Show first 3 children
            print(f"    - {c['name']}")
        if len(children) > 3:
            print(f"    ... and {len(children) - 3} more")

    if len(subs) > 5:
        print(f"  ... and {len(subs) - 5} more parents")

    print("\n" + "=" * 60)


if __name__ == "__main__":
    # Run diagnostic when executed directly
    print_config_status()
