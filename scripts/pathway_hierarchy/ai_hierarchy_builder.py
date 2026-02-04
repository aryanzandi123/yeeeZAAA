#!/usr/bin/env python3
"""
AI Hierarchy Builder for Pathway Classification

Uses Gemini 2.5 Pro to:
- Classify pathways into hierarchy
- Create intermediate pathway levels
- Assign interactions to most specific pathways
- Validate biological consistency

All prompts are designed for batched processing to minimize API calls
while maintaining quality.
"""

import os
import sys
import json
import time
import logging
from pathlib import Path
from typing import Dict, List, Optional, Tuple, Any
from dataclasses import dataclass

# Add project root to path
PROJECT_ROOT = Path(__file__).parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

from utils.llm_response_parser import extract_json_from_llm_response
from scripts.pathway_hierarchy.pathway_config import ROOT_CATEGORY_NAMES

logger = logging.getLogger(__name__)


def _get_api_key() -> str:
    """Get Google API key from environment."""
    api_key = os.environ.get('GOOGLE_API_KEY')
    if not api_key:
        from dotenv import load_dotenv
        load_dotenv(PROJECT_ROOT / '.env')
        api_key = os.environ.get('GOOGLE_API_KEY')
    if not api_key:
        raise RuntimeError("GOOGLE_API_KEY not found in environment")
    return api_key


def _call_gemini_json(
    prompt: str,
    api_key: str = None,
    max_retries: int = 3,
    temperature: float = 0.3,
    max_output_tokens: int = 62048
) -> dict:
    """
    Call Gemini 2.5 Pro and parse JSON response.

    Args:
        prompt: The prompt to send
        api_key: Google API key (uses env if not provided)
        max_retries: Number of retries on failure
        temperature: Model temperature (lower = more deterministic)
        max_output_tokens: Maximum output length

    Returns:
        Parsed JSON response as dict
    """
    from google import genai as google_genai
    from google.genai import types

    if api_key is None:
        api_key = _get_api_key()

    client = google_genai.Client(api_key=api_key)
    config = types.GenerateContentConfig(
        max_output_tokens=max_output_tokens,
        temperature=temperature,
        top_p=0.5,
        tools=[],  # No search for speed
    )

    last_err = None
    for attempt in range(1, max_retries + 1):
        try:
            resp = client.models.generate_content(
                model="gemini-2.5-pro",
                contents=prompt,
                config=config,
            )
            if hasattr(resp, "text") and resp.text:
                return extract_json_from_llm_response(resp.text)
            if hasattr(resp, "candidates") and resp.candidates:
                parts = resp.candidates[0].content.parts
                out = "".join(p.text for p in parts if hasattr(p, "text"))
                return extract_json_from_llm_response(out)
            raise RuntimeError("Empty model response")
        except Exception as e:
            last_err = e
            logger.warning(f"Attempt {attempt} failed: {e}")
            time.sleep(1.5 * attempt)

    raise RuntimeError(f"LLM call failed after {max_retries} attempts: {last_err}")


# =============================================================================
# Pathway Classification Prompts
# =============================================================================

CLASSIFY_PATHWAYS_PROMPT = """You are a biological pathway classification expert. Your task is to classify pathways into a FULL hierarchical chain from ROOT to the pathway itself.

## EXISTING ROOT CATEGORIES (level 0 - these are the ONLY valid starting points):
- Proteostasis
- Metabolism & Bioenergetics
- Membrane & Transport
- Genome Maintenance
- Gene Expression
- Signal Transduction
- Cytoskeletal Dynamics


## AVAILABLE HIERARCHY (for context):
{hierarchy_tree}

## PATHWAYS TO CLASSIFY (batch of {batch_size}):
{pathways_to_classify}

## INSTRUCTIONS:
For each pathway, determine its FULL hierarchy chain from a ROOT category down to itself.

CRITICAL RULES:
1. hierarchy_chain[0] MUST be one of the ROOT categories listed above
2. hierarchy_chain[-1] MUST be the pathway being classified
3. Create intermediate pathways as needed using standard biological terminology
4. Chain length should be 2-5 (root + 1-4 levels of specificity)
5. More specific = deeper in hierarchy (e.g., "Histone Deacetylation" is MORE specific than "Epigenetic Regulation")
6. Use established biology terms: "Transcription", "Epigenetic Regulation", "Histone Modification", etc.
7. Confidence should be 0.7-1.0 (only assign if confident)

## RESPONSE FORMAT (strict JSON):
{{
  "classifications": [
    {{
      "pathway_name": "Original Pathway Name",
      "hierarchy_chain": ["Root Category", "Intermediate 1", "Intermediate 2", "This Pathway"],
      "confidence": 0.85,
      "reasoning": "Brief explanation"
    }}
  ]
}}

## EXAMPLES:
For "Histone Deacetylation":
{{
  "pathway_name": "Histone Deacetylation",
  "hierarchy_chain": ["Cellular Signaling", "Transcription", "Epigenetic Regulation", "Histone Deacetylation"],
  "confidence": 0.9,
  "reasoning": "Histone deacetylation is a specific epigenetic mechanism controlling transcription"
}}

For "Mitophagy":
{{
  "pathway_name": "Mitophagy",
  "hierarchy_chain": ["Protein Quality Control", "Autophagy", "Selective Autophagy", "Mitophagy"],
  "confidence": 0.95,
  "reasoning": "Mitophagy is selective autophagy targeting mitochondria"
}}

Respond with ONLY the JSON, no other text."""


def classify_pathways_batch(
    pathways: List[Dict[str, str]],
    hierarchy_tree: str,
    api_key: str = None
) -> Dict[str, Dict]:
    """
    Classify a batch of pathways into the hierarchy.

    Args:
        pathways: List of {"name": "...", "description": "..."} dicts
        hierarchy_tree: String representation of available hierarchy
        api_key: Google API key

    Returns:
        Dict mapping pathway_name -> {hierarchy_chain: [...], confidence: float, reasoning: str}
    """
    pathways_str = "\n".join([
        f"{i+1}. \"{p['name']}\" - {p.get('description', 'No description')}"
        for i, p in enumerate(pathways)
    ])

    prompt = CLASSIFY_PATHWAYS_PROMPT.format(
        hierarchy_tree=hierarchy_tree,
        batch_size=len(pathways),
        pathways_to_classify=pathways_str
    )

    result = _call_gemini_json(prompt, api_key)

    # Parse into dict with hierarchy_chain
    classifications = {}
    for item in result.get('classifications', []):
        name = item.get('pathway_name', '')
        hierarchy_chain = item.get('hierarchy_chain', [])
        confidence = item.get('confidence', 0.85)
        reasoning = item.get('reasoning', '')

        # Validate chain starts with ROOT and ends with pathway
        if hierarchy_chain:
            # Ensure chain starts with valid ROOT (using imported ROOT_CATEGORY_NAMES)
            if hierarchy_chain[0] not in ROOT_CATEGORY_NAMES:
                logger.warning(f"Invalid ROOT '{hierarchy_chain[0]}' for '{name}', defaulting to Cellular Signaling")
                hierarchy_chain = ['Cellular Signaling'] + hierarchy_chain

            # Ensure chain ends with the pathway
            if hierarchy_chain[-1] != name:
                hierarchy_chain.append(name)

        classifications[name] = {
            'hierarchy_chain': hierarchy_chain,
            'confidence': confidence,
            'reasoning': reasoning
        }

    return classifications


# =============================================================================
# Create Intermediate Pathways
# =============================================================================

CREATE_INTERMEDIATES_PROMPT = """You are a biological pathway expert. Your task is to identify gaps in the pathway hierarchy and suggest intermediate pathways to bridge them.

## HIERARCHY GAPS TO ANALYZE:
{gaps_to_analyze}

## CONTEXT: Existing pathways in the hierarchy
{existing_pathways}

## INSTRUCTIONS:
For each gap (child pathway that's too far from its parent), suggest appropriate intermediate pathway(s).

CRITICAL RULES:
1. Intermediates must apply to MANY proteins (>5 known participants) - NOT protein-specific
2. Do NOT create hyper-specific pathways like "ATXN3-specific degradation"
3. Use standard biological terminology (check if GO/KEGG terms exist)
4. Maximum 2 intermediate levels per gap
5. Each intermediate should be a meaningful biological grouping
6. If no intermediate is needed (gap is acceptable), say so

## RESPONSE FORMAT (strict JSON):
{{
  "gap_analyses": [
    {{
      "child": "Child Pathway Name",
      "parent": "Parent Pathway Name",
      "intermediates_needed": true,
      "suggested_intermediates": [
        {{
          "name": "Intermediate Pathway Name",
          "description": "Brief description of this pathway",
          "estimated_protein_count": 50,
          "go_id": "GO:0000000 or null",
          "position": "between_parent_and_child"
        }}
      ],
      "reasoning": "Why these intermediates are appropriate"
    }}
  ]
}}

Respond with ONLY the JSON, no other text."""


def create_intermediate_pathways_batch(
    gaps: List[Dict[str, str]],
    existing_pathways: List[str],
    api_key: str = None
) -> List[Dict]:
    """
    Analyze hierarchy gaps and suggest intermediate pathways.

    Args:
        gaps: List of {"child": "...", "parent": "...", "description": "..."} dicts
        existing_pathways: List of existing pathway names for context
        api_key: Google API key

    Returns:
        List of gap analyses with suggested intermediates
    """
    gaps_str = "\n".join([
        f"{i+1}. Child: \"{g['child']}\" → Parent: \"{g['parent']}\"\n"
        f"   Child description: {g.get('description', 'No description')}"
        for i, g in enumerate(gaps)
    ])

    existing_str = "\n".join([f"- {p}" for p in existing_pathways[:50]])  # Limit for context

    prompt = CREATE_INTERMEDIATES_PROMPT.format(
        gaps_to_analyze=gaps_str,
        existing_pathways=existing_str
    )

    result = _call_gemini_json(prompt, api_key)
    return result.get('gap_analyses', [])


# =============================================================================
# Assign Interactions to Specific Pathways
# =============================================================================

ASSIGN_INTERACTIONS_PROMPT = """You are a biological pathway assignment expert. Your task is to assign protein-protein interactions to their MOST SPECIFIC appropriate pathway(s) with FULL hierarchy chains.

## EXISTING ROOT CATEGORIES (level 0):
- Proteostasis
- Metabolism & Bioenergetics
- Membrane & Transport
- Genome Maintenance
- Gene Expression
- Signal Transduction
- Cytoskeletal Dynamics

## AVAILABLE PATHWAYS (hierarchical):
{available_pathways}

## INTERACTIONS TO ASSIGN (batch of {batch_size}):
{interactions_to_assign}

## INSTRUCTIONS:
For each interaction, determine the MOST SPECIFIC pathway(s) it belongs to and provide the FULL hierarchy chain.

CRITICAL RULES:
1. Choose the MOST SPECIFIC pathway that accurately describes the interaction
2. Consider the biological functions listed - they indicate the pathway type
3. Provide the FULL hierarchy_chain from ROOT to the most specific leaf pathway
4. hierarchy_chain[0] MUST be one of the ROOT categories
5. Confidence threshold: Only assign if confidence > 0.7
6. Create appropriate intermediate pathways in the chain as needed

## RESPONSE FORMAT (strict JSON):
{{
  "assignments": [
    {{
      "interaction_id": "PROTEIN1-PROTEIN2",
      "current_pathways": ["Current Pathway 1"],
      "recommended_pathways": [
        {{
          "hierarchy_chain": ["Root Category", "Intermediate", "Most Specific Leaf"],
          "confidence": 0.9,
          "reason": "Brief explanation based on functions"
        }}
      ],
      "change_needed": true
    }}
  ]
}}

## EXAMPLES:
For interaction with functions ["Histone deacetylation", "Transcriptional repression"]:
{{
  "interaction_id": "ATXN3-HDAC3",
  "recommended_pathways": [
    {{
      "hierarchy_chain": ["Cellular Signaling", "Transcription", "Epigenetic Regulation", "Histone Deacetylation"],
      "confidence": 0.92,
      "reason": "Functions indicate histone deacetylase activity in epigenetic regulation"
    }}
  ],
  "change_needed": true
}}

Respond with ONLY the JSON, no other text."""


def assign_interactions_batch(
    interactions: List[Dict],
    available_pathways: str,
    api_key: str = None
) -> Dict[str, List[Dict]]:
    """
    Assign interactions to their most specific pathways with full hierarchy chains.

    Args:
        interactions: List of interaction dicts with keys:
            - id: "PROTEIN1-PROTEIN2"
            - current_pathways: ["Pathway1", "Pathway2"]
            - functions: ["Function1", "Function2"]
        available_pathways: String representation of available hierarchy
        api_key: Google API key

    Returns:
        Dict mapping interaction_id -> list of {hierarchy_chain: [...], confidence: float, reason: str}
    """
    interactions_str = "\n".join([
        f"{i+1}. {inter['id']}\n"
        f"   Current pathways: {', '.join(inter.get('current_pathways', ['None']))}\n"
        f"   Functions: {', '.join(inter.get('functions', ['Unknown']))}"
        for i, inter in enumerate(interactions)
    ])

    prompt = ASSIGN_INTERACTIONS_PROMPT.format(
        available_pathways=available_pathways,
        batch_size=len(interactions),
        interactions_to_assign=interactions_str
    )

    result = _call_gemini_json(prompt, api_key)

    # Parse into dict with hierarchy_chain validation (using imported ROOT_CATEGORY_NAMES)
    assignments = {}
    for item in result.get('assignments', []):
        inter_id = item.get('interaction_id', '')
        recommended = item.get('recommended_pathways', [])
        change_needed = item.get('change_needed', False)

        if change_needed and recommended:
            # Validate and fix hierarchy chains
            validated_pathways = []
            for pw in recommended:
                hierarchy_chain = pw.get('hierarchy_chain', [])

                # Backward compatibility: if only 'name' provided, wrap it
                if not hierarchy_chain and 'name' in pw:
                    hierarchy_chain = [pw['name']]

                if hierarchy_chain:
                    # Ensure chain starts with valid ROOT
                    if hierarchy_chain[0] not in ROOT_CATEGORY_NAMES:
                        logger.warning(f"Invalid ROOT '{hierarchy_chain[0]}' for interaction '{inter_id}', defaulting to Cellular Signaling")
                        hierarchy_chain = ['Cellular Signaling'] + hierarchy_chain

                    validated_pathways.append({
                        'hierarchy_chain': hierarchy_chain,
                        'confidence': pw.get('confidence', 0.85),
                        'reason': pw.get('reason', '')
                    })

            if validated_pathways:
                assignments[inter_id] = validated_pathways

    return assignments


# =============================================================================
# Validate Hierarchy Consistency
# =============================================================================

VALIDATE_HIERARCHY_PROMPT = """You are a biological pathway expert. Your task is to validate the consistency and correctness of a pathway hierarchy.

## PATHWAY HIERARCHY TO VALIDATE:
{hierarchy_to_validate}

## VALIDATION CHECKS:
1. Are parent-child relationships biologically sensible?
2. Are there any pathways that seem misplaced?
3. Are there obvious missing intermediate levels?
4. Are pathway names consistent and standardized?
5. Do any pathways seem too broad or too specific for their level?

## RESPONSE FORMAT (strict JSON):
{{
  "is_valid": true,
  "issues": [
    {{
      "type": "misplaced|missing_intermediate|inconsistent_naming|too_broad|too_specific",
      "pathway": "Affected Pathway Name",
      "description": "What the issue is",
      "suggestion": "How to fix it"
    }}
  ],
  "summary": "Overall assessment"
}}

Respond with ONLY the JSON, no other text."""


def validate_hierarchy(
    hierarchy_tree: str,
    api_key: str = None
) -> Dict:
    """
    Validate a pathway hierarchy for biological consistency.

    Args:
        hierarchy_tree: String representation of hierarchy
        api_key: Google API key

    Returns:
        Validation result with issues and suggestions
    """
    prompt = VALIDATE_HIERARCHY_PROMPT.format(
        hierarchy_to_validate=hierarchy_tree
    )

    return _call_gemini_json(prompt, api_key)


# =============================================================================
# Orphan Pathway Handling
# =============================================================================

HANDLE_ORPHAN_PROMPT = """You are a biological pathway expert. Your task is to find the FULL hierarchy chain for orphan pathways from ROOT to the pathway itself.

## EXISTING ROOT CATEGORIES (level 0 - these are the ONLY valid starting points):
- Proteostasis
- Metabolism & Bioenergetics
- Membrane & Transport
- Genome Maintenance
- Gene Expression
- Signal Transduction
- Cytoskeletal Dynamics

## ORPHAN PATHWAYS (need full hierarchy chains):
{orphan_pathways}

## EXISTING HIERARCHY (for context):
{existing_hierarchy}

## INSTRUCTIONS:
For each orphan pathway, determine its FULL hierarchy chain from a ROOT category down to itself.
Create intermediate pathways as needed using standard biological terminology.

CRITICAL RULES:
1. hierarchy_chain[0] MUST be one of the ROOT categories listed above
2. hierarchy_chain[-1] MUST be the orphan pathway itself
3. Chain length should be 2-5 (root + 1-4 levels of specificity)
4. Use established biology terms for intermediates
5. Confidence must be > 0.6 to assign

## RESPONSE FORMAT (strict JSON):
{{
  "orphan_solutions": [
    {{
      "orphan_name": "Orphan Pathway Name",
      "hierarchy_chain": ["Root Category", "Intermediate 1", "Intermediate 2", "Orphan Pathway"],
      "new_intermediates": [
        {{
          "name": "Intermediate Name",
          "description": "Brief description",
          "go_id": "GO:0000000 or null"
        }}
      ],
      "confidence": 0.85,
      "reasoning": "Why this hierarchy is biologically appropriate"
    }}
  ]
}}

## EXAMPLES:
For orphan "Transcriptional Repression":
{{
  "orphan_name": "Transcriptional Repression",
  "hierarchy_chain": ["Cellular Signaling", "Transcription", "Transcriptional Repression"],
  "new_intermediates": [
    {{"name": "Transcription", "description": "Gene transcription regulation", "go_id": "GO:0006351"}}
  ],
  "confidence": 0.9,
  "reasoning": "Transcriptional repression is a specific mechanism within transcription regulation"
}}

Respond with ONLY the JSON, no other text."""


def handle_orphan_pathways(
    orphans: List[Dict[str, str]],
    existing_hierarchy: str,
    api_key: str = None
) -> List[Dict]:
    """
    Find full hierarchy chains for orphan pathways.

    Args:
        orphans: List of {"name": "...", "description": "..."} dicts
        existing_hierarchy: String representation of existing hierarchy
        api_key: Google API key

    Returns:
        List of solutions with hierarchy_chain for each orphan
    """
    orphans_str = "\n".join([
        f"{i+1}. \"{o['name']}\" - {o.get('description', 'No description')}"
        for i, o in enumerate(orphans)
    ])

    prompt = HANDLE_ORPHAN_PROMPT.format(
        orphan_pathways=orphans_str,
        existing_hierarchy=existing_hierarchy
    )

    result = _call_gemini_json(prompt, api_key)
    solutions = result.get('orphan_solutions', [])

    # Validate ROOT categories in each solution (using imported ROOT_CATEGORY_NAMES)
    for solution in solutions:
        hierarchy_chain = solution.get('hierarchy_chain', [])
        orphan_name = solution.get('orphan_name', '')

        if hierarchy_chain:
            # Ensure chain starts with valid ROOT
            if hierarchy_chain[0] not in ROOT_CATEGORY_NAMES:
                logger.warning(f"Invalid ROOT '{hierarchy_chain[0]}' for orphan '{orphan_name}', defaulting to Cellular Signaling")
                solution['hierarchy_chain'] = ['Cellular Signaling'] + hierarchy_chain

            # Ensure chain ends with the orphan
            if hierarchy_chain[-1] != orphan_name:
                solution['hierarchy_chain'].append(orphan_name)

    return solutions


# =============================================================================
# Hierarchy Tree Formatting
# =============================================================================

def format_hierarchy_tree(
    pathways: List[Dict],
    max_depth: int = 5,
    include_counts: bool = False
) -> str:
    """
    Format pathways into a readable hierarchy tree string.

    Args:
        pathways: List of pathway dicts with 'name', 'parent_names', 'level'
        max_depth: Maximum depth to show
        include_counts: Whether to include interaction counts

    Returns:
        Formatted tree string for prompts
    """
    # Build tree structure
    tree = {}
    for pw in pathways:
        level = pw.get('level', 0)
        if level > max_depth:
            continue

        name = pw['name']
        parents = pw.get('parent_names', [])

        if not parents:
            # Root node
            if name not in tree:
                tree[name] = {'children': {}, 'count': pw.get('count', 0)}
        else:
            # Find parent in tree and add as child
            for parent in parents:
                if parent in tree:
                    if name not in tree[parent]['children']:
                        tree[parent]['children'][name] = {
                            'children': {},
                            'count': pw.get('count', 0)
                        }

    # Format as string
    def format_node(node_name, node_data, indent=0):
        prefix = "  " * indent + ("├── " if indent > 0 else "")
        count_str = f" ({node_data['count']})" if include_counts and node_data['count'] else ""
        result = f"{prefix}{node_name}{count_str}\n"

        for child_name, child_data in sorted(node_data['children'].items()):
            result += format_node(child_name, child_data, indent + 1)

        return result

    output = ""
    for root_name, root_data in sorted(tree.items()):
        output += format_node(root_name, root_data)

    return output or "No hierarchy available"


# =============================================================================
# CLI for testing
# =============================================================================

if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="AI Hierarchy Builder CLI")
    parser.add_argument("--test-classify", action="store_true",
                       help="Test pathway classification")
    parser.add_argument("--test-validate", action="store_true",
                       help="Test hierarchy validation")

    args = parser.parse_args()

    # Simple test
    if args.test_classify:
        test_pathways = [
            {"name": "Mitophagy", "description": "Selective autophagy of mitochondria"},
            {"name": "mTORC1 Signaling", "description": "mTOR complex 1 signaling pathway"},
        ]
        test_hierarchy = """
- Cellular Signaling
  - Cell Growth Regulation
  - mTOR Signaling
- Protein Quality Control
  - Autophagy
    - Selective Autophagy
  - Ubiquitin-Proteasome System
"""
        result = classify_pathways_batch(test_pathways, test_hierarchy)
        print(json.dumps(result, indent=2))

    if args.test_validate:
        test_hierarchy = """
- Cellular Signaling (level 0)
  - Cell Growth (level 1)
    - mTOR Signaling (level 2)
  - Apoptosis (level 1)
- Protein Quality Control (level 0)
  - Autophagy (level 1)
    - Mitophagy (level 2)
"""
        result = validate_hierarchy(test_hierarchy)
        print(json.dumps(result, indent=2))
