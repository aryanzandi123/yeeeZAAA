#!/usr/bin/env python3
"""
Run Full V2 Pipeline
====================
Executes Steps 1 through 5 sequentially.
"""
import subprocess
import sys
import time

STEPS = [
    "scripts/pathway_v2/step1_init_roots.py",
    "scripts/pathway_v2/step2_assign_initial_terms.py",
    "scripts/pathway_v2/step3_refine_pathways.py",
    "scripts/pathway_v2/step4_build_hierarchy_backwards.py",
    "scripts/pathway_v2/step5_discover_siblings.py",
    "scripts/pathway_v2/step6_reorganize_pathways.py",
    "scripts/pathway_v2/verify_pipeline.py"
]

def run_step(script_path):
    print(f"\n>>> RUNNING: {script_path}")
    start = time.time()
    result = subprocess.run([sys.executable, script_path], capture_output=False)
    duration = time.time() - start
    print(f">>> FINISHED: {script_path} in {duration:.1f}s (Exit Code: {result.returncode})")
    if result.returncode != 0:
        print("!!! ERROR: Step failed. Stopping pipeline.")
        sys.exit(result.returncode)

def main():
    print("Starting V2 Pathway Pipeline...")
    for script in STEPS:
        run_step(script)
    print("\nALL STEPS COMPLETED SUCCESSFULLY.")

if __name__ == "__main__":
    main()
