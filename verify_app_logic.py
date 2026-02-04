
from app import app, build_full_json_from_db
import sys

def verify_app_logic():
    with app.app_context():
        print("=== APP LOGIC VERIFICATION ===")
        
        # Test with a known protein
        protein = "ATXN3" 
        print(f"Building JSON for {protein}...")
        
        try:
            result = build_full_json_from_db(protein)
            if not result:
                print("Error: No result returned.")
                return
            
            snapshot = result.get('snapshot_json', {})
            pathways = snapshot.get('pathways', [])
            
            print(f"Pathways found: {len(pathways)}")
            
            # Check for non-root, non-leaf nodes (intermediate nodes)
            intermediate_count = 0
            roots_populated = 0
            
            for pw in pathways:
                is_root = pw['hierarchy_level'] == 0
                is_leaf = pw['is_leaf']
                
                if not is_root and not is_leaf:
                    intermediate_count += 1
                    
                if is_root and pw['interaction_count'] > 0:
                    roots_populated += 1 # Note: interaction_count might be just direct ones
                    
                # Check Ancestry
                if len(pw['ancestry']) > 1:
                    # found a path!
                    pass
            
            print(f"Intermediate Nodes: {intermediate_count}")
            
            # Check specific chain
            for pw in pathways:
                if len(pw['ancestry']) > 2:
                    print(f"Sample Chain: {' -> '.join(pw['ancestry'])}")
                    break
                    
        except Exception as e:
            print(f"EXCEPTION: {e}")
            import traceback
            traceback.print_exc()

if __name__ == "__main__":
    verify_app_logic()
