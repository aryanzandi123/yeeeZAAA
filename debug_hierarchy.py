
from app import app, db
from models import Pathway, PathwayParent, PathwayInteraction, Interaction

with app.app_context():
    print("=== HIERARCHY DIAGNOSTIC ===")
    
    # 1. Check Roots
    roots = Pathway.query.filter_by(hierarchy_level=0).all()
    print(f"ROOTS ({len(roots)}):")
    for r in roots:
        child_links = PathwayParent.query.filter_by(parent_pathway_id=r.id).count()
        print(f"  - {r.name}: {child_links} children linked directly")
        
    # 2. Check for ANY Parent-Child Links
    total_links = PathwayParent.query.count()
    print(f"\nTOTAL PARENT-CHILD LINKS: {total_links}")
    
    # 3. Check for Orphan Pathways (Leafs assigned to interactions but no parents)
    # Get all pathways assigned to interactions
    assigned_pis = PathwayInteraction.query.all()
    assigned_pw_ids = {pi.pathway_id for pi in assigned_pis}
    
    print(f"\nASSIGNED PATHWAYS: {len(assigned_pw_ids)}")
    
    orphans = 0
    for pw_id in assigned_pw_ids:
        # Does this pathway have a parent?
        has_parent = PathwayParent.query.filter_by(child_pathway_id=pw_id).first()
        if not has_parent:
            pw = Pathway.query.get(pw_id)
            if pw and pw.hierarchy_level != 0: # Roots strictly don't have parents usually
                print(f"  ORPHAN: {pw.name} (Assigned to interaction but has no parent)")
                orphans += 1
                
    print(f"TOTAL ORPHANS: {orphans}")

    # 4. Check Sample Chain
    print("\nSAMPLE CHAIN TRACE:")
    sample_pi = PathwayInteraction.query.first()
    if sample_pi:
        pw = sample_pi.pathway
        print(f"  Start: {pw.name}")
        curr = pw
        depth = 0
        while True:
            parent_link = PathwayParent.query.filter_by(child_pathway_id=curr.id).first()
            if not parent_link:
                print(f"    -> END (No Parent) at {curr.name}")
                break
            curr = parent_link.parent
            print(f"    -> Parent: {curr.name}")
            depth += 1
            if depth > 10: 
                print("    -> STOP (Too deep)")
                break
