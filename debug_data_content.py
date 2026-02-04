
from app import app, db
from models import Interaction

with app.app_context():
    print("=== INTERACTION DATA CONTENT DIAGNOSTIC ===")
    
    total = Interaction.query.count()
    print(f"Total Interactions: {total}")
    
    empty_data_count = 0
    populated_data_count = 0
    
    interactions = Interaction.query.limit(5).all()
    for i in interactions:
        print(f"ID {i.id}: Data type: {type(i.data)} | Content: {i.data}")
        if not i.data:
            empty_data_count += 1
        else:
            populated_data_count += 1
            
    # Count strict empty
    strict_empty = Interaction.query.filter(Interaction.data.is_(None)).count()
    print(f"Strict None data count (DB query): {strict_empty}")
