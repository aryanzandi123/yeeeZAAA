#!/usr/bin/env python3
"""
Step 2: Assign Initial Specific Pathway Terms ("Goldilocks" Step)
=================================================================
For each FUNCTION of every interaction, assign an independent pathway term that most
closely and specifically describes that function's biological role.

Different functions between the same protein pair can (and often do) belong to
different pathways. Each function is evaluated independently.

GUARANTEE: 100% of interactions MUST have step2_proposal when this function completes.
Uses retry cascade: batch → split → individual until success.

Goldilocks Principle:
- Not too broad (e.g., "Metabolism" is BAD).
- Not too specific (e.g., "ATXN3 phosphorylation" is BAD).
- Just right (e.g., "Protein Quality Control" is okay, "Aggrephagy" is better).

Usage:
    python3 scripts/pathway_v2/step2_assign_initial_terms.py
"""

import sys
import logging
import time
from pathlib import Path
from typing import List, Dict, Set

# Add project root to path
PROJECT_ROOT = Path(__file__).parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

# Setup logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

from scripts.pathway_v2.llm_utils import _call_gemini_json

BATCH_SIZE = 20
MAX_RETRY_ROUNDS = 5  # Maximum retry rounds for failed batches

STEP2_PROMPT = """You are a biological pathway curator with a "Goldilocks" mindset.
Task: Assign a SINGLE, highly appropriate Pathway Name to EACH FUNCTION of each protein-protein interaction.

## THE "GOLDILOCKS" RULE
The pathway name must be specific enough to be meaningful, but broad enough to be a category.
- **TOO BROAD (Avoid)**: "Metabolism", "Cell Signaling", "Disease", "Interaction".
- **TOO SPECIFIC (Avoid)**: "Phosphorylation of Protein X", "Binding of A to B", "Complex Formation".
- **JUST RIGHT**: "mTOR Signaling", "Aggrephagy", "Wnt Signaling Pathway", "DNA Mismatch Repair".

## CRITICAL: PREFER SPECIFIC OVER BROAD (Context-Aware)
When a function relates to a high-level category, ALWAYS check if a more specific child exists:
- If the function specifically describes a SUB-TYPE of a broad pathway -> USE THE SPECIFIC CHILD
- If the function genuinely spans MULTIPLE sub-types -> the broad pathway is acceptable
- NEVER use Level 0 (Root) pathways just because they "technically apply"

DECISION PROCESS:
1. Identify the most specific pathway that accurately describes THIS function
2. Check: Does a child pathway in the database better match?
3. Only use a broad pathway if the function genuinely doesn't fit any specific child

EXAMPLES:
- Function: "repairs oxidized bases in DNA" -> "Base Excision Repair" (NOT "DNA Damage Response")
- Function: "general DNA damage sensor" -> "DNA Damage Response" is OK (spans multiple repair types)
- Function: "degrades misfolded proteins via autophagy" -> "Aggrephagy" (NOT "Protein Quality Control")

## EXISTING PATHWAYS IN DATABASE (organized by specificity level)
{existing_pathways}

## CRITICAL: EVALUATE EACH FUNCTION INDEPENDENTLY
Different functions between the SAME protein pair can belong to DIFFERENT pathways!
Example: ATXN3 <-> TBP could have:
- Function 1: "binds TBP to modulate transcription" -> "Transcriptional Regulation"
- Function 2: "polyQ-expanded ATXN3 sequesters TBP in aggregates" -> "Protein Aggregation"

## INTERACTIONS AND THEIR FUNCTIONS TO ASSIGN
{interactions_list}

## RESPONSE FORMAT (Strict JSON)
{{
  "assignments": [
    {{
      "interaction_id": "ID",
      "function_pathways": [
        {{"function_index": 0, "pathway": "Pathway Name", "reasoning": "Why"}},
        {{"function_index": 1, "pathway": "Different Pathway", "reasoning": "Why"}}
      ],
      "primary_pathway": "Most representative pathway for the interaction overall"
    }}
  ]
}}
Respond with ONLY the JSON. You MUST provide assignments for EVERY function of EVERY interaction.
"""

SIMPLE_PROMPT = """Assign biological pathway names to this protein-protein interaction.
Evaluate EACH function independently - different functions can have DIFFERENT pathways.

Pathway should be specific (like "mTOR Signaling") not too broad (like "Metabolism").
PREFER specific pathways over broad ones - if "Base Excision Repair" exists, use it instead of "DNA Damage Response".

Existing pathways (organized by specificity - PREFER higher level numbers):
{existing_pathways}

Interaction: {protein_a} <-> {protein_b}
Functions:
{functions}

Respond with ONLY JSON:
{{"interaction_id": "{interaction_id}", "function_pathways": [{{"function_index": 0, "pathway": "PathwayName", "reasoning": "Why"}}], "primary_pathway": "MainPathway"}}
"""


def _get_existing_pathways(db) -> tuple[Set[str], str]:
    """Get existing pathway names with hierarchy info for prompt.
    
    Returns:
        Tuple of (set of all pathway names, formatted string showing hierarchy levels)
    """
    try:
        from models import Pathway
        pathways = Pathway.query.all()
        
        if not pathways:
            return set(), "None yet"
        
        # Group by hierarchy level
        by_level = {}
        for p in pathways:
            if p.name:
                level = p.hierarchy_level if p.hierarchy_level is not None else 0
                by_level.setdefault(level, []).append(p.name)
        
        # Format for prompt - show structure with specificity guidance
        lines = []
        for level in sorted(by_level.keys()):
            names = sorted(by_level[level])[:25]  # Limit per level to avoid prompt bloat
            if level == 0:
                prefix = "Level 0 (ROOT - AVOID unless function spans multiple children)"
            elif level == 1:
                prefix = "Level 1 (Broad - prefer more specific if available)"
            else:
                prefix = f"Level {level}+ (Specific - PREFERRED)"
            
            if len(by_level[level]) > 25:
                lines.append(f"  {prefix}: {', '.join(names)}, ... (+{len(by_level[level]) - 25} more)")
            else:
                lines.append(f"  {prefix}: {', '.join(names)}")
        
        formatted = "\n".join(lines) if lines else "None yet"
        all_names = {p.name for p in pathways if p.name}
        return all_names, formatted
    except Exception as e:
        logger.warning(f"Could not fetch existing pathways: {e}")
        return set(), "None yet"


def _get_protein_pathway_hints(interaction, db) -> List[str]:
    """Get pathway hints from other interactions involving the same proteins."""
    try:
        from models import Interaction
        protein_a_id = interaction.protein_a_id
        protein_b_id = interaction.protein_b_id

        # Find interactions involving either protein that have pathway assignments
        related = Interaction.query.filter(
            ((Interaction.protein_a_id == protein_a_id) |
             (Interaction.protein_b_id == protein_a_id) |
             (Interaction.protein_a_id == protein_b_id) |
             (Interaction.protein_b_id == protein_b_id)) &
            (Interaction.id != interaction.id)
        ).all()

        hints = []
        for r in related:
            if r.data and 'step2_proposal' in r.data:
                hints.append(r.data['step2_proposal'])

        return list(set(hints))[:5]  # Return up to 5 unique hints
    except Exception as e:
        logger.debug(f"Could not get pathway hints: {e}")
        return []


def _format_interaction(item) -> str:
    """Format a single interaction with ALL its functions for the prompt."""
    funcs = item.data.get('functions', []) if item.data else []

    if not funcs:
        return f"- ID: {item.id} | Proteins: {item.protein_a.symbol} <-> {item.protein_b.symbol} | Functions: [No functions - assign based on interaction type]"

    func_details = []
    for idx, f in enumerate(funcs):
        desc = f.get('description') or f.get('function') or str(f) if isinstance(f, dict) else str(f)
        func_details.append(f"    [{idx}] {desc[:150]}")

    func_str = "\n".join(func_details)
    return f"- ID: {item.id} | Proteins: {item.protein_a.symbol} <-> {item.protein_b.symbol}\n  Functions:\n{func_str}"


def _process_batch(batch: List, existing_pathways: Set[str], pathways_formatted: str, db) -> Dict[str, Dict]:
    """
    Process a batch of interactions. Returns dict of:
    {interaction_id: {"function_pathways": [...], "primary_pathway": "..."}}

    Note: `db` parameter is unused here but kept for API consistency with
    _process_single and _retry_cascade which do use it.
    """
    if not batch:
        return {}

    batch_map = {str(item.id): item for item in batch}
    items_str = "\n".join([_format_interaction(item) for item in batch])

    prompt = STEP2_PROMPT.format(
        existing_pathways=pathways_formatted,
        interactions_list=items_str
    )

    resp = _call_gemini_json(prompt, temperature=0.2)
    assignments = resp.get('assignments', [])

    results = {}
    for a in assignments:
        str_id = str(a.get('interaction_id'))
        if str_id in batch_map:
            results[str_id] = {
                "function_pathways": a.get('function_pathways', []),
                "primary_pathway": a.get('primary_pathway')
            }

    return results


def _process_single(interaction, existing_pathways: Set[str], pathways_formatted: str, db) -> Dict | None:
    """
    Process a single interaction with simplified prompt.
    Returns dict with function_pathways and primary_pathway, or None.
    """
    funcs = interaction.data.get('functions', []) if interaction.data else []

    # Format functions for the prompt
    if not funcs:
        funcs_str = "[No functions - assign based on interaction type]"
    else:
        func_details = []
        for idx, f in enumerate(funcs):
            desc = f.get('description') or f.get('function') or str(f) if isinstance(f, dict) else str(f)
            func_details.append(f"[{idx}] {desc[:150]}")
        funcs_str = "\n".join(func_details)

    # Get pathway hints from related interactions
    hints = _get_protein_pathway_hints(interaction, db)

    # Combine existing pathways and hints for the prompt
    # Use formatted string but append hints if any
    if hints:
        hints_str = ", ".join(hints[:10])
        prompt_pathways = f"{pathways_formatted}\n  Hints from related interactions: {hints_str}"
    else:
        prompt_pathways = pathways_formatted

    prompt = SIMPLE_PROMPT.format(
        existing_pathways=prompt_pathways,
        protein_a=interaction.protein_a.symbol,
        protein_b=interaction.protein_b.symbol,
        functions=funcs_str or "Unknown function",
        interaction_id=interaction.id
    )

    resp = _call_gemini_json(prompt, temperature=0.3)
    primary = resp.get('primary_pathway')
    if not primary:
        return None
    return {
        "function_pathways": resp.get('function_pathways', []),
        "primary_pathway": primary
    }


def _extract_pathways_from_result(result: Dict) -> Set[str]:
    """Extract all unique pathway names from a result dict for consistency tracking."""
    pathways = set()
    if result.get('primary_pathway'):
        pathways.add(result['primary_pathway'])
    for fp in result.get('function_pathways', []):
        if fp.get('pathway'):
            pathways.add(fp['pathway'])
    return pathways


def _retry_cascade(failed_interactions: List, existing_pathways: Set[str], pathways_formatted: str, db) -> Dict[str, Dict]:
    """
    Retry failed interactions with progressively smaller batches.
    Returns dict of {interaction_id: {"function_pathways": [...], "primary_pathway": "..."}}.
    """
    results = {}
    remaining = list(failed_interactions)

    batch_sizes = [10, 5, 3, 1]  # Progressive split

    for batch_size in batch_sizes:
        if not remaining:
            break

        logger.info(f"  Retrying {len(remaining)} interactions with batch size {batch_size}...")
        still_failed = []

        for i in range(0, len(remaining), batch_size):
            batch = remaining[i:i + batch_size]

            try:
                if batch_size == 1 and batch:
                    # Single interaction - use simplified prompt
                    result = _process_single(batch[0], existing_pathways, pathways_formatted, db)
                    if result:
                        results[str(batch[0].id)] = result
                        existing_pathways.update(_extract_pathways_from_result(result))
                    else:
                        still_failed.extend(batch)
                elif batch:
                    batch_results = _process_batch(batch, existing_pathways, pathways_formatted, db)
                    results.update(batch_results)
                    for r in batch_results.values():
                        existing_pathways.update(_extract_pathways_from_result(r))

                    # Track which ones still failed
                    for item in batch:
                        if str(item.id) not in batch_results:
                            still_failed.append(item)

                time.sleep(0.5)
            except Exception as e:
                logger.warning(f"  Retry batch failed: {e}")
                still_failed.extend(batch)

        remaining = still_failed

    return results


def assign_initial_terms(interaction_ids: List[int] = None):
    """
    Assign pathway terms to interactions. Guarantees 100% coverage.

    Args:
        interaction_ids: Optional list of interaction IDs to process.
                        If None, processes all interactions.
    """
    try:
        from app import app, db
        from models import Interaction
    except ImportError as e:
        logger.error(f"Failed to import app/db: {e}")
        return

    with app.app_context():
        # Fix any interactions with None data
        null_data_query = Interaction.query.filter(Interaction.data.is_(None))
        if interaction_ids:
            null_data_query = null_data_query.filter(Interaction.id.in_(interaction_ids))
        null_data_interactions = null_data_query.all()

        if null_data_interactions:
            logger.info(f"Fixing {len(null_data_interactions)} interactions with NULL data...")
            for i in null_data_interactions:
                i.data = {}
            db.session.commit()

        # Get interactions needing assignment
        query = Interaction.query.order_by(Interaction.id)
        if interaction_ids:
            query = query.filter(Interaction.id.in_(interaction_ids))
            logger.info(f"Filtering to {len(interaction_ids)} interactions from query filter")

        interactions = query.all()
        todo = [i for i in interactions if 'step2_proposal' not in (i.data or {})]

        logger.info(f"Interactions requiring Step 2 assignment: {len(todo)}")
        if not todo:
            return

        # Get existing pathways for consistency (returns set and formatted string)
        existing_pathways, pathways_formatted = _get_existing_pathways(db)
        logger.info(f"Found {len(existing_pathways)} existing pathways in database")

        total_batches = (len(todo) + BATCH_SIZE - 1) // BATCH_SIZE
        all_results = {}
        failed_interactions = []

        # First pass: process in batches
        for batch_idx in range(total_batches):
            batch = todo[batch_idx * BATCH_SIZE : (batch_idx + 1) * BATCH_SIZE]
            logger.info(f"Processing batch {batch_idx + 1}/{total_batches}...")

            try:
                batch_results = _process_batch(batch, existing_pathways, pathways_formatted, db)
                all_results.update(batch_results)
                for r in batch_results.values():
                    existing_pathways.update(_extract_pathways_from_result(r))

                # Track failed interactions
                for item in batch:
                    if str(item.id) not in batch_results:
                        failed_interactions.append(item)

                logger.info(f"  Updated {len(batch_results)}/{len(batch)} interactions.")
                time.sleep(1)
            except Exception as e:
                logger.error(f"Error in batch {batch_idx+1}: {e}")
                failed_interactions.extend(batch)

        # Retry cascade for failed interactions
        retry_round = 0
        while failed_interactions and retry_round < MAX_RETRY_ROUNDS:
            retry_round += 1
            logger.info(f"\n=== Retry Round {retry_round}: {len(failed_interactions)} interactions ===")

            retry_results = _retry_cascade(failed_interactions, existing_pathways, pathways_formatted, db)
            all_results.update(retry_results)

            # Update failed list
            failed_interactions = [i for i in failed_interactions if str(i.id) not in retry_results]

            if not failed_interactions:
                logger.info("All interactions successfully assigned!")
                break

        # Apply all results to database
        success_count = 0
        for interaction in todo:
            str_id = str(interaction.id)
            if str_id in all_results:
                result = all_results[str_id]
                d = dict(interaction.data or {})

                # Store function-level pathways
                d['step2_function_proposals'] = result.get('function_pathways', [])
                d['step2_proposal'] = result.get('primary_pathway')  # Backward compat

                # Also update each function in the data
                functions = d.get('functions', [])
                for fp in result.get('function_pathways', []):
                    try:
                        idx = int(fp.get('function_index', -1))
                    except (TypeError, ValueError):
                        idx = -1
                    if 0 <= idx < len(functions):
                        functions[idx]['step2_pathway'] = fp.get('pathway')
                d['functions'] = functions

                interaction.data = d
                success_count += 1

        db.session.commit()

        # Final report
        logger.info(f"\n{'='*60}")
        logger.info(f"Step 2 Complete:")
        logger.info(f"  Total interactions: {len(todo)}")
        logger.info(f"  Successfully assigned: {success_count}")
        logger.info(f"  Failed: {len(todo) - success_count}")

        if failed_interactions:
            logger.warning(f"  Failed interaction IDs: {[i.id for i in failed_interactions]}")
            logger.warning("  These will be retried in recovery loop during Step 3/4")

        logger.info(f"{'='*60}\n")


def assign_initial_terms_for_interactions(interactions: List):
    """
    Assign pathway terms to a specific list of interactions.
    Used by recovery loops in later steps.
    """
    try:
        from app import app, db
    except ImportError as e:
        logger.error(f"Failed to import app/db: {e}")
        return

    with app.app_context():
        existing_pathways, pathways_formatted = _get_existing_pathways(db)

        logger.info(f"Recovery: Processing {len(interactions)} unassigned interactions...")

        results = _retry_cascade(interactions, existing_pathways, pathways_formatted, db)

        for interaction in interactions:
            str_id = str(interaction.id)
            if str_id in results:
                result = results[str_id]
                d = dict(interaction.data or {})

                # Store function-level pathways
                d['step2_function_proposals'] = result.get('function_pathways', [])
                d['step2_proposal'] = result.get('primary_pathway')  # Backward compat

                # Also update each function in the data
                functions = d.get('functions', [])
                for fp in result.get('function_pathways', []):
                    try:
                        idx = int(fp.get('function_index', -1))
                    except (TypeError, ValueError):
                        idx = -1
                    if 0 <= idx < len(functions):
                        functions[idx]['step2_pathway'] = fp.get('pathway')
                d['functions'] = functions

                interaction.data = d

        db.session.commit()
        logger.info(f"Recovery: Assigned {len(results)}/{len(interactions)} interactions")


if __name__ == "__main__":
    assign_initial_terms()
