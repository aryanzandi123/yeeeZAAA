#!/usr/bin/env python3
"""
Diagnose and fix pathway cycles in the hierarchy.

Usage:
    python scripts/pathway_v2/fix_cycle.py [--auto]

Options:
    --auto    Automatically delete the link where the child has higher hierarchy_level
              (more specific pathway should be the child, not the parent)
"""
import sys
import argparse
from pathlib import Path

PROJECT_ROOT = Path(__file__).parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT))


def main():
    parser = argparse.ArgumentParser(description="Fix pathway hierarchy cycles")
    parser.add_argument("--auto", action="store_true",
                        help="Automatically fix based on hierarchy levels")
    args = parser.parse_args()

    from app import app, db
    from models import Pathway, PathwayParent
    from scripts.pathway_v2.step6_utils import find_all_cycles, build_parent_graph

    with app.app_context():
        # Build graph and find all cycles
        parent_graph = build_parent_graph(PathwayParent)
        cycles = find_all_cycles(parent_graph)

        if not cycles:
            print("No cycles detected in pathway hierarchy.")
            return

        print(f"Found {len(cycles)} cycle(s)")
        print("=" * 60)

        # Process each unique cycle
        processed_pairs = set()

        for cycle in cycles:
            if len(cycle) < 3:
                continue

            # Get the two pathways involved (for a 2-node cycle: A -> B -> A)
            # cycle format is [A, B, A] for a 2-node cycle
            pw_ids = cycle[:-1]  # Remove duplicate last element

            if len(pw_ids) == 2:
                pair = tuple(sorted(pw_ids))
                if pair in processed_pairs:
                    continue
                processed_pairs.add(pair)

                id_a, id_b = pw_ids[0], pw_ids[1]
                pw_a = Pathway.query.get(id_a)
                pw_b = Pathway.query.get(id_b)

                if not pw_a or not pw_b:
                    print(f"Warning: Could not find pathways {id_a} or {id_b}")
                    continue

                print(f"\n=== CYCLE DETECTED ===")
                print(f"Pathway A (ID {id_a}): '{pw_a.name}'")
                print(f"  - hierarchy_level: {pw_a.hierarchy_level}")
                print(f"  - is_leaf: {pw_a.is_leaf}")

                print(f"\nPathway B (ID {id_b}): '{pw_b.name}'")
                print(f"  - hierarchy_level: {pw_b.hierarchy_level}")
                print(f"  - is_leaf: {pw_b.is_leaf}")

                # Find the two links
                link_a_to_b = PathwayParent.query.filter_by(
                    child_pathway_id=id_a, parent_pathway_id=id_b
                ).first()
                link_b_to_a = PathwayParent.query.filter_by(
                    child_pathway_id=id_b, parent_pathway_id=id_a
                ).first()

                print(f"\n=== PARENT LINKS ===")
                if link_a_to_b:
                    print(f"Link 1: '{pw_a.name}' -> '{pw_b.name}' (A is child of B)")
                if link_b_to_a:
                    print(f"Link 2: '{pw_b.name}' -> '{pw_a.name}' (B is child of A)")

                print(f"\n=== FIX OPTIONS ===")
                if link_a_to_b:
                    print(f"A) Delete Link 1: Make '{pw_a.name}' NOT a child of '{pw_b.name}'")
                if link_b_to_a:
                    print(f"B) Delete Link 2: Make '{pw_b.name}' NOT a child of '{pw_a.name}'")

                if args.auto:
                    # Auto-fix: The pathway with higher level should be child, not parent
                    # So we delete the link where the higher-level pathway is the parent
                    level_a = pw_a.hierarchy_level if pw_a.hierarchy_level is not None else 99
                    level_b = pw_b.hierarchy_level if pw_b.hierarchy_level is not None else 99

                    if level_a > level_b:
                        # A is more specific (higher level), should be child not parent
                        # Delete link where A is parent (B is child of A)
                        if link_b_to_a:
                            print(f"\n[AUTO] '{pw_a.name}' (level {level_a}) is more specific than '{pw_b.name}' (level {level_b})")
                            print(f"[AUTO] Deleting link: '{pw_b.name}' -> '{pw_a.name}'")
                            db.session.delete(link_b_to_a)
                            db.session.commit()
                            print("[AUTO] Done.")
                    elif level_b > level_a:
                        # B is more specific, should be child not parent
                        if link_a_to_b:
                            print(f"\n[AUTO] '{pw_b.name}' (level {level_b}) is more specific than '{pw_a.name}' (level {level_a})")
                            print(f"[AUTO] Deleting link: '{pw_a.name}' -> '{pw_b.name}'")
                            db.session.delete(link_a_to_b)
                            db.session.commit()
                            print("[AUTO] Done.")
                    else:
                        print(f"\n[AUTO] Both pathways have same level ({level_a}). Manual decision needed.")
                        choice = input("Which link to delete? (A/B): ").strip().upper()
                        apply_choice(choice, link_a_to_b, link_b_to_a, db)
                else:
                    choice = input("\nWhich link to delete? (A/B/skip): ").strip().upper()
                    if choice == "SKIP":
                        print("Skipped.")
                        continue
                    apply_choice(choice, link_a_to_b, link_b_to_a, db)

        print("\n" + "=" * 60)
        print("Cycle fix complete. Run verify_pipeline.py --check-only to confirm.")


def apply_choice(choice, link_a_to_b, link_b_to_a, db):
    """Apply the user's choice to delete a link."""
    if choice == 'A' and link_a_to_b:
        db.session.delete(link_a_to_b)
        db.session.commit()
        print("Deleted Link 1 (A -> B)")
    elif choice == 'B' and link_b_to_a:
        db.session.delete(link_b_to_a)
        db.session.commit()
        print("Deleted Link 2 (B -> A)")
    else:
        print("Invalid choice or link not found. No changes made.")


if __name__ == "__main__":
    main()
