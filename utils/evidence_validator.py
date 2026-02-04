#!/usr/bin/env python3
"""
Evidence Validator & Citation Enricher (Integrated Fact-Checker)
Post-processes pipeline JSON to validate biological accuracy, check mechanisms, and enrich with citations.
Uses Gemini 3.0 Pro Preview with Google Search for maximum rigor.
"""

from __future__ import annotations

import json
import os
import sys
import time
import re
from copy import deepcopy
from pathlib import Path
from typing import Any, Dict, List, Optional, Set
from concurrent.futures import ThreadPoolExecutor

# Fix Windows console encoding
if sys.stdout.encoding != 'utf-8':
    import io
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8', errors='replace')

from google import genai
from google.genai import types
from dotenv import load_dotenv

# Constants
MAX_OUTPUT_TOKENS = 60192 
# MODEL ID: Using Gemini 3.0 Pro Preview for maximum reasoning power on validation
MODEL_ID = "gemini-2.5-pro"
MAX_CONCURRENT_PRO = 4  # Conservative for gemini-2.5-pro

class EvidenceValidatorError(RuntimeError):
    """Raised when evidence validation fails."""
    pass


def load_json_file(json_path: Path) -> Dict[str, Any]:
    try:
        return json.loads(json_path.read_text(encoding="utf-8"))
    except Exception as e:
        raise EvidenceValidatorError(f"Failed to load JSON: {e}")


def save_json_file(data: Dict[str, Any], output_path: Path) -> None:
    try:
        output_path.write_text(
            json.dumps(data, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8"
        )
        print(f"[OK]Saved validated output to: {output_path}")
    except Exception as e:
        raise EvidenceValidatorError(f"Failed to save JSON: {e}")


def extract_json_from_response(text: str) -> Dict[str, Any]:
    """Extract JSON from model response, handling markdown fences."""
    cleaned = text.strip()
    if cleaned.startswith("```"):
        cleaned = cleaned.strip("`").strip()
        if cleaned.lower().startswith("json"):
            cleaned = cleaned[4:].lstrip()
    try:
        return json.loads(cleaned)
    except json.JSONDecodeError as e:
        # Try fuzzy extraction
        start = cleaned.find('{')
        end = cleaned.rfind('}') + 1
        if start >= 0 and end > start:
            try:
                return json.loads(cleaned[start:end])
            except:
                pass
        raise EvidenceValidatorError(f"Failed to parse JSON: {e}")


def call_gemini_validation(
    prompt: str,
    api_key: str,
    verbose: bool = False
) -> str:
    """
    Call Gemini with Google Search for rigorous validation.
    """
    client = genai.Client(api_key=api_key)
    
    # Configuration: High reasoning, Search enabled
    config = types.GenerateContentConfig(
        tools=[types.Tool(google_search=types.GoogleSearch())],
        max_output_tokens=MAX_OUTPUT_TOKENS,
        temperature=0.3, # Low temp for factual rigor
    )

    if verbose:
        print(f"\n--- Calling {MODEL_ID} for Validation ---")

    try:
        response = client.models.generate_content(
            model=MODEL_ID,
            contents=prompt,
            config=config
        )
        return response.text
    except Exception as e:
        print(f"[WARN] {MODEL_ID} failed ({e}), falling back to gemini-2.5-pro")
        try:
            response = client.models.generate_content(
                model="gemini-2.5-pro",
                contents=prompt,
                config=config
            )
            return response.text
        except Exception as e2:
            raise EvidenceValidatorError(f"Validation failed: {e2}")


def create_validation_prompt(
    main_protein: str,
    interactors: List[Dict[str, Any]],
    batch_start: int,
    batch_end: int,
    total: int
) -> str:
    """
    Constructs a rigorous "Scientific Adversary" prompt.
    """
    
    items_str = json.dumps(interactors, indent=2)
    
    return f"""
You are a RIGOROUS SCIENTIFIC ADVERSARY and FACT-CHECKER.
Your task is to validate protein interaction claims between {main_protein} and a list of interactors.
You must use Google Search to verify every claim against primary literature.

**CORE OBJECTIVE:**
Detect and FIX "Mechanistic Opposites" and "Contextual Errors".
A common error is conflating **Transcriptional Repression** with **Protein Instability**, or **Activator** with **Repressor**.

**CRITICAL FAILURE EXAMPLES (DO NOT COMMIT THESE):**
1. **The "ATXN3-PTEN" Fallacy:**
   - *Input Claim:* ATXN3 deubiquitinates and STABILIZES PTEN protein (Activates).
   - *Reality:* ATXN3 transcriptionally REPRESSES the PTEN gene (Inhibits).
   - *Verdict:* WRONG MECHANISM. The effect is INHIBITORY (lowers PTEN levels), not ACTIVATING.
   
2. **The "Transcriptional vs Post-Translational" Confusion:**
   - *Input:* Protein A degrades Protein B.
   - *Reality:* Protein A represses Protein B's mRNA.
   - *Verdict:* The OUTCOME (lower Protein B) is the same, but the MECHANISM is different. You must be precise.

**INSTRUCTIONS:**

1. **INDEPENDENT RESEARCH:** For each interactor, search for the interaction mechanism *from scratch*. Do not blindly trust the input.
   - Search queries like: "{main_protein} {interactors[0]['primary']} interaction mechanism", "{main_protein} regulates {interactors[0]['primary']} transcription or stability".

2. **BIOLOGICAL CASCADE (MUST BE DETAILED):**
   - **REQUIREMENT:** Create detailed, multi-step molecular pathways.
   - **FORMAT:** "Event A (upstream) → Molecular Intermediate B → Downstream Effector C → Cellular Consequence D".
   - **DETAIL:** Include specific phosphorylation sites (e.g. Ser473), domains (e.g. SH2), co-factors, and cellular locations (e.g. Nuclear translocation).
   - **EXAMPLE:** "ATXN3 binds VCP → Deubiquitinates K48-linked chains on substrates → Prevents proteasomal degradation → Stabilizes protein X → Induces Autophagy."
   - **BAN:** Do NOT use vague single-step descriptions like "ATXN3 regulates VCP".

3. **SPECIFIC EFFECTS (MOLECULAR PRECISION):**
   - **REQUIREMENT:** Describe the EXACT molecular change.
   - **DETAIL:** Use precise terms: "Increases binding affinity by 2-fold", "Promotes nuclear translocation", "Inhibits enzymatic activity at site X", "Stabilizes protein half-life".
   - **AVOID:** Generic terms like "Regulates", "Affects", "Modulates", "Controls" without specific qualification.

4. **EVIDENCE & PUBLICATIONS (VERBATIM PROOF):**
   - **REQUIREMENT:** Evidence must be IRREFUTABLE and VERIFIABLE.
   - **FIELDS:** You MUST provide the **EXACT paper title**, **Journal**, **Year**.
   - **QUOTE:** You MUST include a **VERBATIM QUOTE** from the paper's abstract or results that proves the specific mechanism.
   - **RULE:** If you cannot find a specific paper supporting the mechanism, mark the claim as INVALID or CORRECT it to what the literature actually says.

**INPUT DATA (Batch {batch_start+1}-{batch_end} of {total}):**
{items_str}

**OUTPUT SCHEMA (JSON):**
{{
  "interactors": [
    {{
      "primary": "ProteinSymbol",
      "is_valid": true, // Set false if NO interaction exists
      "mechanism_correction": "Corrected detailed mechanism...", // Explain the REAL mechanism if input was wrong
      "functions": [
        {{
            "function": "Specific Function Name", // Corrected if necessary
            "arrow": "activates" | "inhibits" | "binds" | "regulates", // CRITICAL: Verify direction!
            "cellular_process": "Detailed biological explanation...",
            "effect_description": "Outcome of the interaction...",
            "biological_consequence": [ "Step 1 -> Step 2 -> Step 3 (Detailed Pathway)" ],
            "specific_effects": [ "Precise molecular effect 1", "Precise molecular effect 2" ],
            "evidence": [
                {{
                    "paper_title": "EXACT Title from PubMed",
                    "journal": "Journal Name",
                    "year": 2024,
                    "relevant_quote": "Verbatim quote supporting the mechanism."
                }}
            ]
        }}
      ]
    }}
  ]
}}
"""


def validate_evidence_parallel(
    main_protein: str,
    interactors: List[Dict[str, Any]],
    api_key: str,
    batch_size: int = 3,
    verbose: bool = False
) -> List[Dict[str, Any]]:
    """
    Validate all interactors in parallel batches.

    OPTIMIZED: All batches run simultaneously instead of sequentially.
    Expected speedup: ~12 min -> ~3-4 minutes
    """
    if not interactors:
        return []

    # Split into batches
    batches = [interactors[i:i + batch_size] for i in range(0, len(interactors), batch_size)]
    total = len(interactors)

    print(f"[INFO] Validating {total} interactors in {len(batches)} parallel batches")

    def validate_batch(batch_data):
        """Validate a single batch."""
        batch_idx, batch = batch_data
        batch_start = batch_idx * batch_size
        batch_end = min(batch_start + len(batch), total)

        try:
            prompt = create_validation_prompt(
                main_protein, batch, batch_start, batch_end, total
            )
            response = call_gemini_validation(prompt, api_key, verbose)
            result = extract_json_from_response(response)

            # Process validation results for each interactor
            validated = []
            if 'interactors' in result:
                for val_int in result['interactors']:
                    orig = next((x for x in batch if x['primary'] == val_int['primary']), None)
                    if orig:
                        if not val_int.get('is_valid', True):
                            print(f"  ❌ {val_int['primary']} flagged as INVALID interaction.")
                            orig['_validation_status'] = 'rejected'
                            orig['mechanism'] = "EVIDENCE REJECTED: " + val_int.get('mechanism_correction', 'No interaction found')
                        else:
                            print(f"  ✅ {val_int['primary']} validated.")
                            orig.update(val_int)
                        validated.append(orig)
            else:
                validated = batch

            return {
                'batch_idx': batch_idx,
                'interactors': validated,
                'error': None
            }
        except Exception as e:
            print(f"[WARN] Batch {batch_idx + 1} failed: {e}")
            return {
                'batch_idx': batch_idx,
                'interactors': batch,  # Return original on failure
                'error': str(e)
            }

    # Run all batches in parallel with limited concurrency
    with ThreadPoolExecutor(max_workers=MAX_CONCURRENT_PRO) as executor:
        batch_data = list(enumerate(batches))
        results = list(executor.map(validate_batch, batch_data))

    # Sort by batch index and flatten
    results.sort(key=lambda x: x['batch_idx'])

    validated = []
    errors = 0
    for r in results:
        if r.get('error'):
            errors += 1
        validated.extend(r.get('interactors', []))

    print(f"[INFO] Validation complete. {len(validated)} interactors processed, {errors} batch errors")

    return validated


def validate_and_enrich_evidence(
    json_data: Dict[str, Any],
    api_key: str,
    verbose: bool = False,
    batch_size: int = 3, # Low batch size for rigorous thinking
    step_logger = None
) -> Dict[str, Any]:
    """
    Main validation function.
    """
    if 'ctx_json' not in json_data:
        print("[WARN] No ctx_json found, skipping validation.")
        return json_data

    main_protein = json_data['ctx_json'].get('main', 'Unknown')
    interactors = json_data['ctx_json'].get('interactors', [])
    
    print(f"\n{'='*60}")
    print(f"🔍 RIGOROUS EVIDENCE VALIDATION FOR: {main_protein}")
    print(f"   Model: {MODEL_ID} (Scientific Adversary Mode)")
    print(f"   Total interactors: {len(interactors)}")
    print(f"{'='*60}")

    # Use parallel validation
    validated_interactors = validate_evidence_parallel(
        main_protein, interactors, api_key, batch_size, verbose
    )

    # Update payload
    json_data['ctx_json']['interactors'] = validated_interactors
    
    # Also update snapshot if present
    if 'snapshot_json' in json_data:
        json_data['snapshot_json']['interactors'] = validated_interactors

    return json_data


if __name__ == "__main__":
    # CLI testing
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("input_json")
    parser.add_argument("--output", default="validated_output.json")
    parser.add_argument("--api-key", default=os.getenv("GOOGLE_API_KEY"))
    args = parser.parse_args()
    
    if not args.api_key:
        sys.exit("GOOGLE_API_KEY required.")
        
    data = load_json_file(Path(args.input_json))
    validated = validate_and_enrich_evidence(data, args.api_key, verbose=True)
    save_json_file(validated, Path(args.output))