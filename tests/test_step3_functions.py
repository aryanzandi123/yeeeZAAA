#!/usr/bin/env python3
"""Tests for step3_refine_pathways pure functions."""

import sys
from pathlib import Path
PROJECT_ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

from scripts.pathway_v2.step3_refine_pathways import _format_interaction_for_step3

class MockInteraction:
    def __init__(self, id, data):
        self.id = id
        self.data = data

def test_format_interaction_with_proposals():
    """Test formatting when step2_function_proposals exists."""
    interaction = MockInteraction(123, {
        'step2_function_proposals': [
            {'function_index': 0, 'pathway': 'Autophagy'},
            {'function_index': 1, 'pathway': 'Protein Aggregation'}
        ],
        'step2_proposal': 'Fallback Pathway'
    })
    result = _format_interaction_for_step3(interaction)
    assert '123' in result
    assert '[0] Autophagy' in result
    assert '[1] Protein Aggregation' in result
    print("[OK] test_format_interaction_with_proposals")

def test_format_interaction_fallback():
    """Test fallback to step2_proposal when no function proposals."""
    interaction = MockInteraction(456, {
        'step2_proposal': 'Fallback Pathway'
    })
    result = _format_interaction_for_step3(interaction)
    assert '456' in result
    assert 'Fallback Pathway' in result
    print("[OK] test_format_interaction_fallback")

def test_format_interaction_no_data():
    """Test handling when data is None."""
    interaction = MockInteraction(789, None)
    result = _format_interaction_for_step3(interaction)
    assert '789' in result
    assert 'Unknown' in result
    print("[OK] test_format_interaction_no_data")

if __name__ == "__main__":
    test_format_interaction_with_proposals()
    test_format_interaction_fallback()
    test_format_interaction_no_data()
    print("\nALL TESTS PASSED")
