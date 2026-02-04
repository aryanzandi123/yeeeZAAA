"""
Pathway Hierarchy Scripts

Standalone scripts for building hierarchical pathway organization using
GO/KEGG ontologies as scaffold with AI-driven custom branches.

Scripts (run in order):
1. 01_fetch_ontology_hierarchies.py - Download GO/KEGG hierarchies
2. 02_build_base_hierarchy.py - Create scaffold from ontologies
3. 03_classify_existing_pathways.py - Map existing pathways to hierarchy
4. 04_ai_create_missing_branches.py - AI fills gaps for unmapped pathways
5. 05_assign_interactions_to_leaves.py - Push interactions to most specific
6. 06_validate_and_finalize.py - Validation and cleanup

Or use run_all.py to execute all scripts in sequence.
"""

from .dag_models import PathwayNode, PathwayDAG, build_dag_from_db, save_dag_to_db

__all__ = [
    'PathwayNode',
    'PathwayDAG',
    'build_dag_from_db',
    'save_dag_to_db',
]
