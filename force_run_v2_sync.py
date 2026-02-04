
import sys
import os
from pathlib import Path

# Add project root to path
PROJECT_ROOT = Path(__file__).parent
sys.path.insert(0, str(PROJECT_ROOT))

from scripts.pathway_v2.step1_init_roots import init_roots
from scripts.pathway_v2.step2_assign_initial_terms import assign_initial_terms
from scripts.pathway_v2.step3_refine_pathways import refine_pathways
from scripts.pathway_v2.step4_build_hierarchy_backwards import build_hierarchy
from scripts.pathway_v2.step5_discover_siblings import discover_siblings

def force_run():
    print("=== FORCE RUN V2 PIPELINE ===")
    
    print("--- Step 1: Init Roots ---")
    init_roots()
    
    print("--- Step 2: Assign Initial Terms ---")
    assign_initial_terms()
    
    print("--- Step 3: Refine Pathways ---")
    refine_pathways()
    
    print("--- Step 4: Build Hierarchy ---")
    build_hierarchy()
    
    print("--- Step 5: Discover Siblings ---")
    discover_siblings()
    
    print("=== PIPELINE COMPLETE ===")

if __name__ == "__main__":
    force_run()
