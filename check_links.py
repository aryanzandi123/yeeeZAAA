
from app import app, db
from models import PathwayInteraction, PathwayParent

with app.app_context():
    pi_count = PathwayInteraction.query.count()
    pp_count = PathwayParent.query.count()
    print(f"PathwayInteraction Count: {pi_count}")
    print(f"PathwayParent Count: {pp_count}")
