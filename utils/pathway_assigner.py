#!/usr/bin/env python3
"""
Pathway Assignment Pipeline for Protein Interactions

Three-stage AI pipeline that:
1. Generates biological pathway names for interactions using Gemini
2. Consolidates with existing DB pathways and maps to standard ontologies
3. Assigns pathway metadata to interaction records

Uses hybrid approach: AI-generated names mapped to KEGG/Reactome/GO when possible.
"""

import json
import time
import re
from typing import Dict, List, Optional, Set, Tuple
from difflib import SequenceMatcher

from utils.llm_response_parser import extract_json_from_llm_response


# ═══════════════════════════════════════════════════════════════════════════════
# ONTOLOGY MAPPINGS - Standard biological pathways with their ontology IDs
# ═══════════════════════════════════════════════════════════════════════════════

ONTOLOGY_MAPPINGS: Dict[str, Dict[str, str]] = {
    # Autophagy-related
    "autophagy": {"id": "GO:0006914", "source": "GO", "canonical": "Autophagy"},
    "macroautophagy": {"id": "GO:0016236", "source": "GO", "canonical": "Macroautophagy"},
    "mitophagy": {"id": "GO:0000423", "source": "GO", "canonical": "Mitophagy"},
    "aggrephagy": {"id": "GO:0035973", "source": "GO", "canonical": "Aggrephagy"},
    "chaperone-mediated autophagy": {"id": "GO:0061684", "source": "GO", "canonical": "Chaperone-Mediated Autophagy"},

    # Protein degradation
    "ubiquitin-proteasome system": {"id": "GO:0010415", "source": "GO", "canonical": "Ubiquitin-Proteasome System"},
    "proteasome": {"id": "GO:0010498", "source": "GO", "canonical": "Proteasomal Degradation"},
    "ubiquitination": {"id": "GO:0016567", "source": "GO", "canonical": "Protein Ubiquitination"},
    "deubiquitination": {"id": "GO:0016579", "source": "GO", "canonical": "Protein Deubiquitination"},
    "er-associated degradation": {"id": "GO:0036503", "source": "GO", "canonical": "ER-Associated Degradation"},
    "erad": {"id": "GO:0036503", "source": "GO", "canonical": "ER-Associated Degradation"},

    # Signaling pathways (KEGG)
    "mtor signaling": {"id": "hsa04150", "source": "KEGG", "canonical": "mTOR Signaling"},
    "mtorc1": {"id": "hsa04150", "source": "KEGG", "canonical": "mTOR Signaling"},
    "mtorc2": {"id": "hsa04150", "source": "KEGG", "canonical": "mTOR Signaling"},
    "pi3k-akt signaling": {"id": "hsa04151", "source": "KEGG", "canonical": "PI3K-Akt Signaling"},
    "mapk signaling": {"id": "hsa04010", "source": "KEGG", "canonical": "MAPK Signaling"},
    "nf-kb signaling": {"id": "hsa04064", "source": "KEGG", "canonical": "NF-kB Signaling"},
    "nf-kappab": {"id": "hsa04064", "source": "KEGG", "canonical": "NF-kB Signaling"},
    "wnt signaling": {"id": "hsa04310", "source": "KEGG", "canonical": "Wnt Signaling"},
    "notch signaling": {"id": "hsa04330", "source": "KEGG", "canonical": "Notch Signaling"},
    "hedgehog signaling": {"id": "hsa04340", "source": "KEGG", "canonical": "Hedgehog Signaling"},
    "tgf-beta signaling": {"id": "hsa04350", "source": "KEGG", "canonical": "TGF-beta Signaling"},
    "hippo signaling": {"id": "hsa04390", "source": "KEGG", "canonical": "Hippo Signaling"},
    "jak-stat signaling": {"id": "hsa04630", "source": "KEGG", "canonical": "JAK-STAT Signaling"},
    "calcium signaling": {"id": "hsa04020", "source": "KEGG", "canonical": "Calcium Signaling"},
    "camp signaling": {"id": "hsa04024", "source": "KEGG", "canonical": "cAMP Signaling"},

    # Cell death pathways
    "apoptosis": {"id": "GO:0006915", "source": "GO", "canonical": "Apoptosis"},
    "programmed cell death": {"id": "GO:0012501", "source": "GO", "canonical": "Programmed Cell Death"},
    "necroptosis": {"id": "GO:0070266", "source": "GO", "canonical": "Necroptosis"},
    "pyroptosis": {"id": "GO:0070269", "source": "GO", "canonical": "Pyroptosis"},
    "ferroptosis": {"id": "GO:0097707", "source": "GO", "canonical": "Ferroptosis"},

    # Cell cycle
    "cell cycle": {"id": "GO:0007049", "source": "GO", "canonical": "Cell Cycle"},
    "cell division": {"id": "GO:0051301", "source": "GO", "canonical": "Cell Division"},
    "mitosis": {"id": "GO:0007067", "source": "GO", "canonical": "Mitosis"},
    "dna replication": {"id": "GO:0006260", "source": "GO", "canonical": "DNA Replication"},

    # DNA damage/repair
    "dna damage response": {"id": "GO:0006974", "source": "GO", "canonical": "DNA Damage Response"},
    "dna repair": {"id": "GO:0006281", "source": "GO", "canonical": "DNA Repair"},
    "homologous recombination": {"id": "GO:0035825", "source": "GO", "canonical": "Homologous Recombination"},
    "non-homologous end joining": {"id": "GO:0006303", "source": "GO", "canonical": "Non-Homologous End Joining"},
    "nucleotide excision repair": {"id": "GO:0006289", "source": "GO", "canonical": "Nucleotide Excision Repair"},
    "base excision repair": {"id": "GO:0006284", "source": "GO", "canonical": "Base Excision Repair"},

    # Stress responses
    "unfolded protein response": {"id": "GO:0030968", "source": "GO", "canonical": "Unfolded Protein Response"},
    "upr": {"id": "GO:0030968", "source": "GO", "canonical": "Unfolded Protein Response"},
    "er stress": {"id": "GO:0034976", "source": "GO", "canonical": "ER Stress Response"},
    "heat shock response": {"id": "GO:0009408", "source": "GO", "canonical": "Heat Shock Response"},
    "oxidative stress": {"id": "GO:0006979", "source": "GO", "canonical": "Oxidative Stress Response"},
    "hypoxia response": {"id": "GO:0001666", "source": "GO", "canonical": "Hypoxia Response"},

    # Protein quality control
    "protein folding": {"id": "GO:0006457", "source": "GO", "canonical": "Protein Folding"},
    "chaperone": {"id": "GO:0006457", "source": "GO", "canonical": "Protein Folding"},
    "proteostasis": {"id": "GO:0006457", "source": "GO", "canonical": "Proteostasis"},

    # Transcription
    "transcription": {"id": "GO:0006351", "source": "GO", "canonical": "Transcription"},
    "transcriptional regulation": {"id": "GO:0006355", "source": "GO", "canonical": "Transcriptional Regulation"},
    "chromatin remodeling": {"id": "GO:0006338", "source": "GO", "canonical": "Chromatin Remodeling"},
    "epigenetic regulation": {"id": "GO:0040029", "source": "GO", "canonical": "Epigenetic Regulation"},

    # Inflammation/Immune
    "inflammation": {"id": "GO:0006954", "source": "GO", "canonical": "Inflammatory Response"},
    "immune response": {"id": "GO:0006955", "source": "GO", "canonical": "Immune Response"},
    "innate immunity": {"id": "GO:0045087", "source": "GO", "canonical": "Innate Immune Response"},
    "cytokine signaling": {"id": "hsa04060", "source": "KEGG", "canonical": "Cytokine Signaling"},

    # Metabolism
    "glycolysis": {"id": "GO:0006096", "source": "GO", "canonical": "Glycolysis"},
    "oxidative phosphorylation": {"id": "GO:0006119", "source": "GO", "canonical": "Oxidative Phosphorylation"},
    "lipid metabolism": {"id": "GO:0006629", "source": "GO", "canonical": "Lipid Metabolism"},
    "amino acid metabolism": {"id": "GO:0006520", "source": "GO", "canonical": "Amino Acid Metabolism"},

    # Vesicle trafficking
    "endocytosis": {"id": "GO:0006897", "source": "GO", "canonical": "Endocytosis"},
    "exocytosis": {"id": "GO:0006887", "source": "GO", "canonical": "Exocytosis"},
    "vesicle trafficking": {"id": "GO:0016192", "source": "GO", "canonical": "Vesicle Transport"},
    "lysosomal degradation": {"id": "GO:0007041", "source": "GO", "canonical": "Lysosomal Degradation"},

    # Cytoskeleton
    "cytoskeleton organization": {"id": "GO:0007015", "source": "GO", "canonical": "Cytoskeleton Organization"},
    "actin dynamics": {"id": "GO:0030031", "source": "GO", "canonical": "Actin Cytoskeleton Organization"},
    "microtubule organization": {"id": "GO:0000226", "source": "GO", "canonical": "Microtubule Organization"},

    # Neuronal
    "neurodegeneration": {"id": "GO:0070997", "source": "GO", "canonical": "Neurodegeneration"},
    "synaptic signaling": {"id": "GO:0099536", "source": "GO", "canonical": "Synaptic Signaling"},
    "axon guidance": {"id": "GO:0007411", "source": "GO", "canonical": "Axon Guidance"},
    "neuronal development": {"id": "GO:0048666", "source": "GO", "canonical": "Neuronal Development"},
}


def _normalize_pathway_name(name: str) -> str:
    """Normalize pathway name for matching."""
    return re.sub(r'[^a-z0-9]', '', name.lower())


def _find_ontology_match(pathway_name: str) -> Optional[Dict[str, str]]:
    """
    Find best ontology match for a pathway name.
    Uses fuzzy matching to handle variations.
    """
    normalized = _normalize_pathway_name(pathway_name)

    # Direct match
    if normalized in ONTOLOGY_MAPPINGS:
        return ONTOLOGY_MAPPINGS[normalized]

    # Check if normalized name contains any key
    for key, mapping in ONTOLOGY_MAPPINGS.items():
        if key in normalized or normalized in key:
            return mapping

    # Fuzzy match using sequence matching
    best_ratio = 0.0
    best_match = None
    for key, mapping in ONTOLOGY_MAPPINGS.items():
        ratio = SequenceMatcher(None, normalized, key).ratio()
        if ratio > best_ratio and ratio > 0.7:  # 70% similarity threshold
            best_ratio = ratio
            best_match = mapping

    return best_match


def _call_gemini_json(prompt: str, api_key: str, max_retries: int = 3) -> dict:
    """
    Call Gemini 2.5 Pro for pathway assignment, parse strict JSON.
    """
    from google import genai as google_genai
    from google.genai import types

    client = google_genai.Client(api_key=api_key)
    config = types.GenerateContentConfig(
        max_output_tokens=62048,
        temperature=0.3,
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
            time.sleep(1.5 * attempt)
    raise RuntimeError(f"LLM call failed: {last_err}")


# ═══════════════════════════════════════════════════════════════════════════════
# STAGE 1: Generate Pathway Names
# ═══════════════════════════════════════════════════════════════════════════════

def build_pathway_generation_prompt(
    main_protein: str,
    interactors: List[Dict],
) -> str:
    """
    Build prompt for Stage 1: Generate pathway names for EACH FUNCTION (not just interactors).
    Each function/interaction row gets its own pathway assignment.
    """
    # Extract relevant info from interactors with indexed functions
    interaction_summaries = []
    for ix in interactors:
        primary = ix.get("primary", "?")
        arrow = ix.get("arrow", "binds")
        functions = ix.get("functions", [])

        # Include function index for mapping back
        indexed_functions = []
        for idx, f in enumerate(functions[:10]):  # Top 10 functions
            indexed_functions.append({
                "index": idx,
                "function": f.get("function", "Unknown"),
            })

        interaction_summaries.append({
            "interactor": primary,
            "arrow": arrow,
            "functions": indexed_functions,
            "confidence": ix.get("confidence", 0.5),
        })

    context_json = json.dumps({
        "main_protein": main_protein,
        "interactions": interaction_summaries,
    }, indent=2)

    prompt = f"""
╔══════════════════════════════════════════════════════════════════════════════╗
║   PATHWAY ASSIGNMENT – ASSIGN PATHWAY TO EACH FUNCTION/INTERACTION ROW       ║
╚══════════════════════════════════════════════════════════════════════════════╝

ROLE: You are an expert molecular biologist categorizing each function/mechanism
      into its most relevant biological pathway.

CONTEXT:
  Main/Query Protein: {main_protein}
  Number of interactors: {len(interactors)}

OBJECTIVE:
  For EACH FUNCTION listed under each interactor, assign it to the SINGLE MOST
  RELEVANT biological pathway. Use standard terminology (KEGG, Reactome, GO).

RULES:
  1. EVERY function MUST be assigned to exactly ONE pathway.
  2. Choose the pathway that BEST describes that specific function/mechanism.
  3. Pathway names should be SPECIFIC biological processes, not generic terms.
  4. Use established pathway names when possible (e.g., "Autophagy", "mTOR Signaling",
     "Ubiquitin-Proteasome System", "ER-Associated Degradation", "Apoptosis").
  5. Functions under the same interactor CAN be assigned to different pathways.

GOOD PATHWAY NAMES:
  - "Autophagy", "Mitophagy", "Aggrephagy"
  - "mTOR Signaling", "PI3K-Akt Signaling"
  - "Ubiquitin-Proteasome System", "ER-Associated Degradation"
  - "Apoptosis", "Cell Cycle Regulation"
  - "DNA Damage Response", "Oxidative Stress Response"
  - "Transcriptional Regulation", "Chromatin Remodeling"

BAD PATHWAY NAMES (avoid):
  - "Regulation" (too generic)
  - "Protein Interaction" (meaningless)
  - "Cellular Process" (too vague)

────────────────────────────────────────────────────────────────────────────────
OUTPUT FORMAT (STRICT JSON ONLY)
────────────────────────────────────────────────────────────────────────────────
{{
  "function_pathways": {{
    "INTERACTOR_SYMBOL": {{
      "0": "Autophagy",
      "1": "Ubiquitin-Proteasome System",
      "2": "Autophagy"
    }},
    "ANOTHER_INTERACTOR": {{
      "0": "mTOR Signaling",
      "1": "Apoptosis"
    }}
  }},
  "pathway_descriptions": {{
    "Autophagy": "Cellular degradation pathway for damaged organelles and proteins",
    "Ubiquitin-Proteasome System": "Protein degradation via ubiquitin tagging"
  }}
}}

NOTE: The keys under each interactor are the function INDEX (0, 1, 2...) as strings.
      Multiple functions CAN map to the same pathway if appropriate.

────────────────────────────────────────────────────────────────────────────────
INTERACTION DATA (READ CAREFULLY - assign pathway to each indexed function)
────────────────────────────────────────────────────────────────────────────────
{context_json}
"""
    return prompt


def generate_pathway_names(
    interactors: List[Dict],
    main_protein: str,
    api_key: str,
    verbose: bool = False,
) -> Tuple[Dict[str, Dict], List[Dict]]:
    """
    Stage 1: Use Gemini to generate pathway assignments for EACH FUNCTION.

    Args:
        interactors: List of interactor dicts from pipeline
        main_protein: Query protein symbol
        api_key: Gemini API key
        verbose: Print debug info

    Returns:
        Tuple of:
        - pathways: Dict of pathway_name -> {description}
        - updated_interactors: Interactors with pathway field added to each function
    """
    if not interactors:
        return {}, []

    prompt = build_pathway_generation_prompt(main_protein, interactors)

    if verbose:
        print(f"[PathwayAssigner] Stage 1: Generating per-function pathways for {len(interactors)} interactors...")

    result = _call_gemini_json(prompt, api_key)
    function_pathways = result.get("function_pathways", {})
    pathway_descriptions = result.get("pathway_descriptions", {})

    if verbose:
        print(f"[PathwayAssigner] Got pathway assignments for {len(function_pathways)} interactors")

    # Build pathways dict for Stage 2 consolidation
    pathways = {}
    for pw_name, desc in pathway_descriptions.items():
        pathways[pw_name] = {"description": desc, "confidence": 0.8}

    # Also collect pathway names from function_pathways (in case descriptions are incomplete)
    for interactor_data in function_pathways.values():
        for pw_name in interactor_data.values():
            if pw_name and pw_name not in pathways:
                pathways[pw_name] = {"description": "", "confidence": 0.8}

    # Update interactors: add pathway to each function
    updated_interactors = []
    interactor_pathways_set: Dict[str, set] = {}  # Track pathways per interactor

    for ix in interactors:
        ix_copy = dict(ix)
        primary = ix.get("primary", "")
        functions = ix_copy.get("functions", [])
        interactor_pw_mapping = function_pathways.get(primary, {})

        # Track all pathways for this interactor
        if primary not in interactor_pathways_set:
            interactor_pathways_set[primary] = set()

        # Deep copy functions and add pathway to each
        updated_functions = []
        for idx, fn in enumerate(functions):
            fn_copy = dict(fn)
            idx_str = str(idx)

            # Get pathway for this function from AI response
            pw_name = interactor_pw_mapping.get(idx_str)
            if pw_name:
                fn_copy["pathway"] = {"name": pw_name, "confidence": 0.8}
                interactor_pathways_set[primary].add(pw_name)
            else:
                # Fallback: use function name as pathway
                fallback_pw = fn.get("function", "Protein Interaction")
                fn_copy["pathway"] = {"name": fallback_pw, "confidence": 0.5}
                interactor_pathways_set[primary].add(fallback_pw)
                if fallback_pw not in pathways:
                    pathways[fallback_pw] = {"description": "", "confidence": 0.5}

            updated_functions.append(fn_copy)

        ix_copy["functions"] = updated_functions

        # Also set interactor-level pathways (for backward compatibility)
        ix_copy["pathways"] = [
            {"name": pw_name, "confidence": 0.8}
            for pw_name in interactor_pathways_set.get(primary, set())
        ]

        updated_interactors.append(ix_copy)

    if verbose:
        total_functions = sum(len(ix.get("functions", [])) for ix in updated_interactors)
        print(f"[PathwayAssigner] Assigned pathways to {total_functions} functions across {len(pathways)} unique pathways")

    return pathways, updated_interactors


# ═══════════════════════════════════════════════════════════════════════════════
# STAGE 2: Consolidate with DB + Map to Ontologies
# ═══════════════════════════════════════════════════════════════════════════════

def consolidate_pathways(
    ai_pathways: Dict[str, Dict],
    existing_db_pathways: List[str],
    verbose: bool = False,
) -> Dict[str, Dict]:
    """
    Stage 2: Consolidate AI-generated pathways with existing DB pathways
    and map to standard ontologies.

    Args:
        ai_pathways: Pathways from Stage 1 {name: {description, interactors, confidence}}
        existing_db_pathways: List of pathway names already in database
        verbose: Print debug info

    Returns:
        Consolidated pathways with ontology mappings:
        {
            "original_name": {
                "canonical_name": "...",  # Final name to use
                "ontology_id": "GO:...",  # Or null if AI-generated
                "ontology_source": "GO",  # Or null
                "description": "...",
                "is_new": True/False,
            }
        }
    """
    consolidated = {}
    existing_normalized = {_normalize_pathway_name(p): p for p in existing_db_pathways}

    for pw_name, pw_data in ai_pathways.items():
        normalized = _normalize_pathway_name(pw_name)

        # Check if exists in DB
        if normalized in existing_normalized:
            # Use existing DB pathway name
            consolidated[pw_name] = {
                "canonical_name": existing_normalized[normalized],
                "ontology_id": None,  # Will be looked up from DB
                "ontology_source": None,
                "description": pw_data.get("description", ""),
                "is_new": False,
            }
            continue

        # Try ontology mapping
        ontology_match = _find_ontology_match(pw_name)
        if ontology_match:
            consolidated[pw_name] = {
                "canonical_name": ontology_match["canonical"],
                "ontology_id": ontology_match["id"],
                "ontology_source": ontology_match["source"],
                "description": pw_data.get("description", ""),
                "is_new": ontology_match["canonical"] not in existing_db_pathways,
            }
        else:
            # AI-generated pathway with no ontology match
            # Clean up the name slightly
            clean_name = pw_name.strip().title()
            consolidated[pw_name] = {
                "canonical_name": clean_name,
                "ontology_id": None,
                "ontology_source": None,
                "description": pw_data.get("description", ""),
                "is_new": True,
            }

    if verbose:
        new_count = sum(1 for p in consolidated.values() if p["is_new"])
        mapped_count = sum(1 for p in consolidated.values() if p["ontology_id"])
        print(f"[PathwayAssigner] Stage 2: {len(consolidated)} pathways, "
              f"{new_count} new, {mapped_count} ontology-mapped")

    return consolidated


# ═══════════════════════════════════════════════════════════════════════════════
# STAGE 3: Apply Consolidated Mappings to Interactors
# ═══════════════════════════════════════════════════════════════════════════════

def apply_pathway_mappings(
    interactors: List[Dict],
    consolidated: Dict[str, Dict],
) -> List[Dict]:
    """
    Stage 3: Apply consolidated pathway mappings to interactors AND their functions.

    Updates:
    - Each interactor's 'pathways' array with canonical names and ontology IDs
    - Each function's 'pathway' field with canonical names and ontology IDs

    Args:
        interactors: Interactors with 'pathways' field and functions with 'pathway' from Stage 1
        consolidated: Consolidated mappings from Stage 2

    Returns:
        Updated interactors with enriched pathway metadata on both interactor and function level
    """
    updated = []
    for ix in interactors:
        ix_copy = dict(ix)

        # Enrich interactor-level pathways (for backward compatibility)
        enriched_pathways = []
        for pw in ix_copy.get("pathways", []):
            pw_name = pw.get("name", "")
            mapping = consolidated.get(pw_name, {})

            enriched_pathways.append({
                "name": pw_name,
                "canonical_name": mapping.get("canonical_name", pw_name),
                "ontology_id": mapping.get("ontology_id"),
                "ontology_source": mapping.get("ontology_source"),
                "confidence": pw.get("confidence", 0.8),
            })
        ix_copy["pathways"] = enriched_pathways

        # Enrich function-level pathways (the key fix!)
        functions = ix_copy.get("functions", [])
        enriched_functions = []
        for fn in functions:
            fn_copy = dict(fn)
            fn_pathway = fn_copy.get("pathway", {})

            if fn_pathway:
                pw_name = fn_pathway.get("name", "")
                mapping = consolidated.get(pw_name, {})

                fn_copy["pathway"] = {
                    "name": pw_name,
                    "canonical_name": mapping.get("canonical_name", pw_name),
                    "ontology_id": mapping.get("ontology_id"),
                    "ontology_source": mapping.get("ontology_source"),
                    "confidence": fn_pathway.get("confidence", 0.8),
                }

            enriched_functions.append(fn_copy)

        ix_copy["functions"] = enriched_functions
        updated.append(ix_copy)

    return updated


# ═══════════════════════════════════════════════════════════════════════════════
# MAIN PIPELINE RUNNER
# ═══════════════════════════════════════════════════════════════════════════════

class PathwayAssigner:
    """
    Three-stage AI pipeline for assigning biological pathways to protein interactions.
    """

    def __init__(self, api_key: str, verbose: bool = False):
        self.api_key = api_key
        self.verbose = verbose

    def run_full_pipeline(
        self,
        interactors: List[Dict],
        main_protein: str,
        existing_db_pathways: Optional[List[str]] = None,
    ) -> Tuple[List[Dict], Dict[str, Dict]]:
        """
        Run the complete 3-stage pathway assignment pipeline.

        Args:
            interactors: List of interactor dicts from main pipeline
            main_protein: Query protein symbol
            existing_db_pathways: Optional list of pathway names from DB

        Returns:
            Tuple of:
            - updated_interactors: Interactors with enriched 'pathways' field
            - pathway_metadata: {canonical_name: {ontology_id, source, description, is_new}}
        """
        if not interactors:
            return [], {}

        existing = existing_db_pathways or []

        # Stage 1: Generate pathway names
        if self.verbose:
            print(f"[PathwayAssigner] Starting 3-stage pipeline for {main_protein}")

        ai_pathways, stage1_interactors = generate_pathway_names(
            interactors=interactors,
            main_protein=main_protein,
            api_key=self.api_key,
            verbose=self.verbose,
        )

        # Stage 2: Consolidate with DB + ontology mapping
        consolidated = consolidate_pathways(
            ai_pathways=ai_pathways,
            existing_db_pathways=existing,
            verbose=self.verbose,
        )

        # Stage 3: Apply mappings to interactors
        final_interactors = apply_pathway_mappings(
            interactors=stage1_interactors,
            consolidated=consolidated,
        )

        # Build pathway metadata for DB storage
        pathway_metadata = {}
        for original_name, mapping in consolidated.items():
            canonical = mapping["canonical_name"]
            if canonical not in pathway_metadata:
                pathway_metadata[canonical] = {
                    "ontology_id": mapping["ontology_id"],
                    "ontology_source": mapping["ontology_source"],
                    "description": mapping["description"],
                    "is_new": mapping["is_new"],
                    "ai_generated": mapping["ontology_id"] is None,
                }

        if self.verbose:
            print(f"[PathwayAssigner] Complete. {len(pathway_metadata)} pathways, "
                  f"{len(final_interactors)} interactors updated")

        return final_interactors, pathway_metadata
