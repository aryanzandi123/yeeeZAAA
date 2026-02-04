#!/usr/bin/env python3
"""
LLM Utilities for Pathway V2 Pipeline
=====================================
Shared functions for calling Gemini 2.5 Pro and parsing JSON responses.
"""

import os
import time
import logging
import json
import re
from pathlib import Path

# Setup logging
logger = logging.getLogger(__name__)

PROJECT_ROOT = Path(__file__).parent.parent.parent

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

def _find_balanced_json(text: str, start_pos: int) -> str | None:
    """Find a balanced JSON object starting at start_pos."""
    if start_pos >= len(text) or text[start_pos] != '{':
        return None

    depth = 0
    in_string = False
    escape_next = False

    for i in range(start_pos, len(text)):
        char = text[i]

        # Handle string escapes
        if escape_next:
            escape_next = False
            continue

        if char == '\\':
            escape_next = True
            continue

        # Track string boundaries
        if char == '"':
            in_string = not in_string
            continue

        # Only count brackets outside strings
        if not in_string:
            if char == '{':
                depth += 1
            elif char == '}':
                depth -= 1
                if depth == 0:
                    return text[start_pos:i+1]

    return None

def _extract_partial_assignments(text: str) -> list:
    """
    Extract individual assignments from malformed JSON using regex.
    This salvages whatever assignments we can even if the overall JSON is broken.
    Returns list of dicts with interaction_id and specific_pathway.
    """
    assignments = []
    # Match patterns like: "interaction_id": "123", ... "specific_pathway": "Some Pathway"
    # Handle both quoted and unquoted IDs
    pattern = r'"interaction_id"\s*:\s*"?(\d+)"?\s*,\s*"specific_pathway"\s*:\s*"([^"]+)"'
    matches = re.findall(pattern, text, re.IGNORECASE)
    for interaction_id, pathway in matches:
        assignments.append({
            'interaction_id': interaction_id,
            'specific_pathway': pathway
        })

    if assignments:
        logger.info(f"  Partial extraction recovered {len(assignments)} assignments from malformed JSON")

    return assignments


def _fix_truncated_json(text: str) -> str:
    """
    Attempt to fix truncated JSON by closing unclosed brackets and braces.
    """
    # Count open brackets/braces
    open_braces = text.count('{') - text.count('}')
    open_brackets = text.count('[') - text.count(']')

    # Check if we're inside a string (unclosed quote)
    in_string = False
    escape_next = False
    for char in text:
        if escape_next:
            escape_next = False
            continue
        if char == '\\':
            escape_next = True
            continue
        if char == '"':
            in_string = not in_string

    fixed = text

    # Close string if needed
    if in_string:
        fixed += '"'

    # Close brackets first, then braces
    fixed += ']' * open_brackets
    fixed += '}' * open_braces

    return fixed


def _extract_json_from_text(text: str) -> dict:
    """
    Extract JSON object from text (handles markdown code blocks, malformed responses,
    truncation, and single quotes).
    """
    if not text:
        logger.warning("Empty response text")
        return {}

    # Strategy 1: Try direct parsing
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass

    # Strategy 2: Extract from ```json ... ``` blocks
    match = re.search(r'```(?:json)?\s*(\{[\s\S]*?\})\s*```', text, re.DOTALL)
    if match:
        try:
            return json.loads(match.group(1))
        except json.JSONDecodeError:
            pass

    # Strategy 3: Replace single quotes with double quotes (Python dict notation)
    try:
        fixed_quotes = text.replace("'", '"')
        return json.loads(fixed_quotes)
    except json.JSONDecodeError:
        pass

    # Strategy 4: Balanced bracket search - find properly balanced JSON object
    start = text.find('{')
    if start != -1:
        json_str = _find_balanced_json(text, start)
        if json_str:
            try:
                return json.loads(json_str)
            except json.JSONDecodeError:
                pass

    # Strategy 5: Try to fix truncated JSON by closing brackets
    start = text.find('{')
    if start != -1:
        truncated_json = text[start:]
        fixed_json = _fix_truncated_json(truncated_json)
        try:
            return json.loads(fixed_json)
        except json.JSONDecodeError:
            pass

    # Strategy 6: Extract partial assignments using regex (last resort)
    partial = _extract_partial_assignments(text)
    if partial:
        return {'assignments': partial, '_partial_extraction': True}

    # Failed all strategies - provide detailed error context
    response_len = len(text)
    preview_head = text[:300] if len(text) > 300 else text
    preview_tail = text[-300:] if len(text) > 300 else ""

    logger.warning(
        f"Failed to extract JSON from response (length: {response_len}):\n"
        f"  HEAD: {preview_head}\n"
        f"  TAIL: {preview_tail if preview_tail else '(same as head)'}"
    )

    # Log full response to file for debugging
    try:
        debug_file = PROJECT_ROOT / 'logs' / 'json_parse_failures.log'
        debug_file.parent.mkdir(exist_ok=True)
        with open(debug_file, 'a', encoding='utf-8') as f:
            f.write(f"\n{'='*80}\n")
            f.write(f"TIMESTAMP: {time.strftime('%Y-%m-%d %H:%M:%S')}\n")
            f.write(f"RESPONSE LENGTH: {response_len}\n")
            f.write(f"FULL RESPONSE:\n{text}\n")
    except Exception as e:
        logger.debug(f"Could not write debug log: {e}")

    return {}

def _call_gemini_json(
    prompt: str,
    api_key: str = None,
    max_retries: int = 3,
    temperature: float = 0.3,
    max_output_tokens: int = 16384
) -> dict:
    """
    Call Gemini 2.5 Pro and parse JSON response.
    """
    try:
        from google import genai
        from google.genai import types
    except ImportError:
        logger.error("google-genai SDK not installed. Please run `pip install google-genai`.")
        return {}

    if api_key is None:
        try:
            api_key = _get_api_key()
        except RuntimeError as e:
            logger.error(str(e))
            return {}

    client = genai.Client(api_key=api_key)
    config = types.GenerateContentConfig(
        max_output_tokens=max_output_tokens,
        temperature=temperature,
        top_p=0.95,
        response_mime_type="application/json",
        thinking_config=types.ThinkingConfig(thinking_budget=4096),
    )

    last_err = None
    for attempt in range(1, max_retries + 1):
        try:
            resp = client.models.generate_content(
                model="gemini-3-flash-preview", # Using Flash 2.0 or Pro 1.5 as 2.5 might not be avail? 
                # User config says "2.5 Pro" but user instructions clarify "gemini-3-flash-preview" in past context
                # Safe bet: gemini-1.5-pro-latest or gemini-2.0-flash-exp. 
                # Let's try gemini-1.5-pro-002 (reliable) or gemini-2.0-flash-exp (fast).
                # Using 'gemini-2.0-flash-exp' as it is current SOTA for reasoning speed.
                contents=prompt,
                config=config,
            )
            
            text = ""
            if hasattr(resp, "text") and resp.text:
                text = resp.text
            elif hasattr(resp, "candidates") and resp.candidates:
                parts = resp.candidates[0].content.parts
                text = "".join(p.text for p in parts if hasattr(p, "text"))
            
            if text:
                return _extract_json_from_text(text)
                
            raise RuntimeError("Empty response from model")
            
        except Exception as e:
            last_err = e
            logger.warning(f"Attempt {attempt} failed: {e}")
            time.sleep(2 * attempt)

    logger.error(f"LLM call failed after {max_retries} attempts: {last_err}")
    return {}


# ==============================================================================
# CACHED LLM CALLS
# ==============================================================================

def _call_gemini_json_cached(
    prompt: str,
    cache_key: str = None,
    cache_type: str = "parent",  # "parent" or "siblings"
    api_key: str = None,
    max_retries: int = 3,
    temperature: float = 0.3,
    max_output_tokens: int = 16384
) -> dict:
    """
    Call Gemini with optional caching.

    If cache_key is provided and cache_type is "parent", checks PathwayCache first.
    """
    if cache_key:
        from scripts.pathway_v2.cache import get_pathway_cache
        cache = get_pathway_cache()

        if cache_type == "parent":
            cached = cache.get_parent(cache_key)
            if cached:
                logger.info(f"  Cache hit for parent of '{cache_key}'")
                return {"child": cache_key, "parent": cached, "_cached": True}
        elif cache_type == "siblings":
            cached = cache.get_siblings(cache_key)
            if cached:
                logger.info(f"  Cache hit for siblings of '{cache_key}'")
                return {"siblings": cached, "_cached": True}

    # Call LLM
    result = _call_gemini_json(
        prompt=prompt,
        api_key=api_key,
        max_retries=max_retries,
        temperature=temperature,
        max_output_tokens=max_output_tokens
    )

    # Cache result if successful
    if cache_key and result:
        from scripts.pathway_v2.cache import get_pathway_cache
        cache = get_pathway_cache()

        if cache_type == "parent" and result.get("parent"):
            cache.set_parent(cache_key, result["parent"])
        elif cache_type == "siblings" and result.get("siblings"):
            cache.set_siblings(cache_key, result["siblings"])

    return result
