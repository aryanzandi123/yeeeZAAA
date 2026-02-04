
from app import app, db
from models import Interaction
import json

with app.app_context():
    i = Interaction.query.first()
    if i:
        print(json.dumps(i.data, indent=2))
    else:
        print("No interactions found")
