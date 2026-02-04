
import sys
import os
import json
from visualizer import create_visualization_from_dict

# Mock data matching the structure in logs
data = {
    'snapshot_json': {
        'main': 'ATXN3',
        'proteins': [{'id': 'ATXN3'}],
        'interactions': [{'primary': 'ATXN3', 'functions': []}],
        'interactors': []
    },
    'ctx_json': {}
}

try:
    print("Attempting to create visualization...")
    html = create_visualization_from_dict(data)
    print("Success! HTML length:", len(html))
    if "ProPath - ATXN3" in html:
        print("Title verified.")
    else:
        print("Title check failed.")
except Exception as e:
    print("FAILED with error:", e)
    import traceback
    traceback.print_exc()
