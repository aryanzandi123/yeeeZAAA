
from app import app, db
from models import Pathway, PathwayInteraction

with app.app_context():
    print("=== ANCESTOR_IDS DIAGNOSTIC ===")
    
    # Check a few pathways assigned to interactions (Leaves)
    assigned_pis = PathwayInteraction.query.limit(5).all()
    
    for pi in assigned_pis:
        pw = pi.pathway
        print(f"Pathway: {pw.name} (ID: {pw.id})")
        print(f"  Level: {pw.hierarchy_level}")
        print(f"  Ancestor IDs: {pw.ancestor_ids}")
        if not pw.ancestor_ids:
            print("  [WARN] Ancestor IDs is EMPTY!")
            
    # Check just random non-root pathways
    print("\nRandom Non-Root Pathways:")
    others = Pathway.query.filter(Pathway.hierarchy_level > 0).limit(5).all()
    for pw in others:
        print(f"Pathway: {pw.name}")
        print(f"  Ancestor IDs: {pw.ancestor_ids}")
