from typing import Dict, Any, List
from copy import deepcopy


def aggregate_function_arrows(interactor: Dict[str, Any]) -> Dict[str, Any]:
    """
    Aggregate function-level arrows into interaction-level arrows field.

    Computes:
    - `arrows`: Dict mapping direction → list of unique interaction_effect types
    - `arrow`: Backward-compat field (most common interaction_effect or 'regulates' if mixed)
    - `direction`: main_to_primary | primary_to_main | bidirectional

    DIRECTIONALITY RULES:
    - Function-level "bidirectional" is treated as a SPLIT: counts as BOTH
      main_to_primary AND primary_to_main (one vote each).
    - Interactor-level "bidirectional" requires functions in BOTH directions
      with DIFFERENT biological function names (not the same function counted twice).
    - Ties default to primary_to_main (conservative: assume interactor acts on query).

    Args:
        interactor: Interactor dict with functions[] containing interaction_effect/interaction_direction fields

    Returns:
        Updated interactor dict with arrows and arrow fields
    """
    functions = interactor.get("functions", [])

    if not functions:
        interactor["arrow"] = "binds"
        interactor["arrows"] = {"main_to_primary": ["binds"]}
        interactor["direction"] = "main_to_primary"
        return interactor

    # Collect arrows by direction AND track function names per direction
    arrows_by_direction = {
        "main_to_primary": set(),
        "primary_to_main": set(),
    }

    # Track unique function names per direction (for bidirectional validation)
    function_names_by_direction = {
        "main_to_primary": set(),
        "primary_to_main": set(),
    }

    direction_counts = {
        "main_to_primary": 0,
        "primary_to_main": 0,
    }

    for fn in functions:
        if not isinstance(fn, dict):
            continue

        interaction_effect = fn.get("interaction_effect", fn.get("arrow", "complex"))
        interaction_direction = fn.get("interaction_direction", fn.get("direction", ""))
        func_name = fn.get("function", "")

        # Handle bidirectional at function level: split into BOTH directions
        if interaction_direction == "bidirectional":
            # Count as one vote for each direction
            direction_counts["main_to_primary"] += 1
            direction_counts["primary_to_main"] += 1
            arrows_by_direction["main_to_primary"].add(interaction_effect)
            arrows_by_direction["primary_to_main"].add(interaction_effect)
            function_names_by_direction["main_to_primary"].add(func_name)
            function_names_by_direction["primary_to_main"].add(func_name)
        elif interaction_direction == "primary_to_main":
            direction_counts["primary_to_main"] += 1
            arrows_by_direction["primary_to_main"].add(interaction_effect)
            function_names_by_direction["primary_to_main"].add(func_name)
        else:
            # Default: main_to_primary (includes empty/missing direction)
            direction_counts["main_to_primary"] += 1
            arrows_by_direction["main_to_primary"].add(interaction_effect)
            function_names_by_direction["main_to_primary"].add(func_name)

    # Build arrows dict (remove empty directions)
    arrows = {
        k: sorted(list(v))
        for k, v in arrows_by_direction.items() if v
    }

    # Determine summary arrow field
    all_arrows = set()
    for arrow_list in arrows.values():
        all_arrows.update(arrow_list)

    if len(all_arrows) == 0:
        arrow = "binds"
    elif len(all_arrows) == 1:
        arrow = list(all_arrows)[0]
    else:
        arrow = "regulates"

    # Determine primary direction
    m2p_count = direction_counts["main_to_primary"]
    p2m_count = direction_counts["primary_to_main"]

    # Check for truly bidirectional: BOTH directions must have at least 1 function
    # AND the function names must be DIFFERENT in each direction (not the same function
    # counted twice from a bidirectional split)
    m2p_funcs = function_names_by_direction["main_to_primary"]
    p2m_funcs = function_names_by_direction["primary_to_main"]

    # Functions that appear ONLY in one direction (not shared from bidirectional split)
    m2p_unique = m2p_funcs - p2m_funcs
    p2m_unique = p2m_funcs - m2p_funcs

    has_unique_in_both = bool(m2p_unique) and bool(p2m_unique)

    if has_unique_in_both and m2p_count > 0 and p2m_count > 0:
        # Truly bidirectional: distinct functions in each direction
        direction = "bidirectional"
    elif p2m_count > m2p_count:
        direction = "primary_to_main"
    elif m2p_count > p2m_count:
        direction = "main_to_primary"
    elif p2m_count == m2p_count and p2m_count > 0:
        # Tie: default to primary_to_main (conservative - assume interactor acts on query)
        # This prevents upstream interactors from being mislabeled as downstream
        direction = "primary_to_main"
    else:
        direction = "main_to_primary"

    interactor["arrows"] = arrows
    interactor["arrow"] = arrow
    interactor["direction"] = direction

    return interactor


def split_bidirectional_interactor(
    interactor: Dict[str, Any],
    main_protein: str
) -> List[Dict[str, Any]]:
    """
    Split a bidirectional interactor into TWO separate interactor entries:
    one for main_to_primary functions, one for primary_to_main functions.

    Each entry gets its own arrow, direction, mechanism, effect, summary.
    Both entries share the same 'primary' protein name but have _direction_split metadata.

    Args:
        interactor: Interactor dict with direction='bidirectional'
        main_protein: The query protein symbol

    Returns:
        List of 1 or 2 interactor dicts. Returns [original] if not truly bidirectional.
    """
    if interactor.get("direction") != "bidirectional":
        return [interactor]

    functions = interactor.get("functions", [])
    if not functions:
        return [interactor]

    primary = interactor.get("primary", "UNKNOWN")

    # Group functions by direction
    m2p_functions = []
    p2m_functions = []

    for fn in functions:
        if not isinstance(fn, dict):
            continue
        direction = fn.get("interaction_direction", fn.get("direction", "main_to_primary"))
        if direction == "primary_to_main":
            p2m_functions.append(deepcopy(fn))
        elif direction == "bidirectional":
            # Split bidirectional function into both groups
            m2p_functions.append(deepcopy(fn))
            p2m_functions.append(deepcopy(fn))
        else:
            m2p_functions.append(deepcopy(fn))

    # If all functions ended up in one direction, don't split
    if not m2p_functions or not p2m_functions:
        return [interactor]

    results = []

    # Create downstream entry (main_to_primary)
    m2p_entry = deepcopy(interactor)
    m2p_entry["functions"] = m2p_functions
    m2p_entry["direction"] = "main_to_primary"
    m2p_entry["_direction_split"] = True
    m2p_entry["_split_direction"] = "main_to_primary"
    # Re-aggregate arrow for this subset
    m2p_entry = aggregate_function_arrows(m2p_entry)
    # Force direction back (aggregation might change it)
    m2p_entry["direction"] = "main_to_primary"
    m2p_entry["direction_details"] = {
        "is_split": True,
        "this_direction": "main_to_primary",
        "other_direction": "primary_to_main",
        "functions_in_this": [f.get("function", "") for f in m2p_functions],
        "functions_in_other": [f.get("function", "") for f in p2m_functions],
    }
    results.append(m2p_entry)

    # Create upstream entry (primary_to_main)
    p2m_entry = deepcopy(interactor)
    p2m_entry["functions"] = p2m_functions
    p2m_entry["direction"] = "primary_to_main"
    p2m_entry["_direction_split"] = True
    p2m_entry["_split_direction"] = "primary_to_main"
    # Re-aggregate arrow for this subset
    p2m_entry = aggregate_function_arrows(p2m_entry)
    # Force direction back
    p2m_entry["direction"] = "primary_to_main"
    p2m_entry["direction_details"] = {
        "is_split": True,
        "this_direction": "primary_to_main",
        "other_direction": "main_to_primary",
        "functions_in_this": [f.get("function", "") for f in p2m_functions],
        "functions_in_other": [f.get("function", "") for f in m2p_functions],
    }
    results.append(p2m_entry)

    return results
