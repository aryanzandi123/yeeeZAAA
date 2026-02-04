#!/usr/bin/env python3
"""
Unit tests for Step 2 per-function pathway assignment.

Tests the pure helper functions used in step2_assign_initial_terms.py.
"""

import sys
from pathlib import Path

# Add project root to path
PROJECT_ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

from scripts.pathway_v2.step2_assign_initial_terms import (
    _format_interaction,
    _extract_pathways_from_result,
)


class MockProtein:
    """Mock protein for testing."""
    def __init__(self, symbol: str):
        self.symbol = symbol


class MockInteraction:
    """Mock interaction for testing."""
    def __init__(self, id: int, protein_a_symbol: str, protein_b_symbol: str, data: dict = None):
        self.id = id
        self.protein_a = MockProtein(protein_a_symbol)
        self.protein_b = MockProtein(protein_b_symbol)
        self.data = data or {}


def test_format_interaction_no_functions():
    """Test formatting interaction with no functions."""
    interaction = MockInteraction(1, "ATXN3", "VCP", {})
    result = _format_interaction(interaction)

    assert "ID: 1" in result
    assert "ATXN3" in result
    assert "VCP" in result
    assert "No functions" in result
    print("[OK] test_format_interaction_no_functions")


def test_format_interaction_with_functions():
    """Test formatting interaction with multiple functions."""
    interaction = MockInteraction(2, "ATXN3", "TBP", {
        "functions": [
            {"description": "binds TBP to modulate transcription"},
            {"description": "polyQ-expanded ATXN3 sequesters TBP in aggregates"},
            {"function": "stabilizes TBP protein levels"}
        ]
    })
    result = _format_interaction(interaction)

    assert "ID: 2" in result
    assert "ATXN3" in result
    assert "TBP" in result
    assert "[0]" in result
    assert "[1]" in result
    assert "[2]" in result
    assert "modulate transcription" in result
    assert "aggregates" in result
    assert "stabilizes" in result
    print("[OK] test_format_interaction_with_functions")


def test_format_interaction_truncates_long_descriptions():
    """Test that long function descriptions are truncated to 150 chars."""
    long_desc = "A" * 200
    interaction = MockInteraction(3, "A", "B", {
        "functions": [{"description": long_desc}]
    })
    result = _format_interaction(interaction)

    # Should be truncated
    assert "A" * 150 in result
    assert "A" * 151 not in result
    print("[OK] test_format_interaction_truncates_long_descriptions")


def test_extract_pathways_from_result_empty():
    """Test extracting pathways from empty result."""
    result = {}
    pathways = _extract_pathways_from_result(result)

    assert len(pathways) == 0
    print("[OK] test_extract_pathways_from_result_empty")


def test_extract_pathways_from_result_primary_only():
    """Test extracting pathways with only primary_pathway."""
    result = {"primary_pathway": "DNA Damage Response"}
    pathways = _extract_pathways_from_result(result)

    assert "DNA Damage Response" in pathways
    assert len(pathways) == 1
    print("[OK] test_extract_pathways_from_result_primary_only")


def test_extract_pathways_from_result_functions_only():
    """Test extracting pathways with only function_pathways."""
    result = {
        "function_pathways": [
            {"function_index": 0, "pathway": "Transcriptional Regulation"},
            {"function_index": 1, "pathway": "Protein Aggregation"}
        ]
    }
    pathways = _extract_pathways_from_result(result)

    assert "Transcriptional Regulation" in pathways
    assert "Protein Aggregation" in pathways
    assert len(pathways) == 2
    print("[OK] test_extract_pathways_from_result_functions_only")


def test_extract_pathways_from_result_full():
    """Test extracting all unique pathways from complete result."""
    result = {
        "primary_pathway": "Protein Quality Control",
        "function_pathways": [
            {"function_index": 0, "pathway": "Transcriptional Regulation"},
            {"function_index": 1, "pathway": "Protein Aggregation"},
            {"function_index": 2, "pathway": "Protein Quality Control"}  # Duplicate
        ]
    }
    pathways = _extract_pathways_from_result(result)

    assert "Transcriptional Regulation" in pathways
    assert "Protein Aggregation" in pathways
    assert "Protein Quality Control" in pathways
    assert len(pathways) == 3  # No duplicates
    print("[OK] test_extract_pathways_from_result_full")


def test_extract_pathways_handles_none_values():
    """Test that None pathway values are handled gracefully."""
    result = {
        "primary_pathway": None,
        "function_pathways": [
            {"function_index": 0, "pathway": None},
            {"function_index": 1, "pathway": "Valid Pathway"}
        ]
    }
    pathways = _extract_pathways_from_result(result)

    assert "Valid Pathway" in pathways
    assert None not in pathways
    assert len(pathways) == 1
    print("[OK] test_extract_pathways_handles_none_values")


if __name__ == "__main__":
    print("\n" + "="*60)
    print("Step 2 Function-Level Pathway Assignment - Unit Tests")
    print("="*60 + "\n")

    test_format_interaction_no_functions()
    test_format_interaction_with_functions()
    test_format_interaction_truncates_long_descriptions()
    test_extract_pathways_from_result_empty()
    test_extract_pathways_from_result_primary_only()
    test_extract_pathways_from_result_functions_only()
    test_extract_pathways_from_result_full()
    test_extract_pathways_handles_none_values()

    print("\n" + "="*60)
    print("[OK] ALL TESTS PASSED")
    print("="*60 + "\n")
