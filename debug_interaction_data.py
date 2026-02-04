
from app import app, db
from models import Interaction

with app.app_context():
    print("=== INTERACTION DATA DIAGNOSTIC ===")
    
    total = Interaction.query.count()
    print(f"Total Interactions: {total}")
    
    step2_count = 0
    step3_count = 0
    step3_values = set()
    
    interactions = Interaction.query.all()
    for i in interactions:
        data = i.data or {}
        if 'step2_proposal' in data:
            step2_count += 1
        if 'step3_finalized_pathway' in data:
            step3_count += 1
            step3_values.add(data['step3_finalized_pathway'])
            
    print(f"With Step 2: {step2_count}")
    print(f"With Step 3: {step3_count}")
    print(f"Unique Step 3 Terms: {len(step3_values)}")
    if step3_values:
        print(f"Sample Terms: {list(step3_values)[:5]}")
