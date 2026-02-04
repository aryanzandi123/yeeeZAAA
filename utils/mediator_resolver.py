#!/usr/bin/env python3
"""
Mediator Resolver
Post-processing script to link 'indirect' interactors to their 'direct' mediators
if the mediator is present in the dataset.
"""

import json
from typing import Dict, Any, List, Set, Optional
from copy import deepcopy

def resolve_mediators(json_data: Dict[str, Any], verbose: bool = False) -> Dict[str, Any]:
    """
    Main entry point for mediator resolution.
    """
    if 'ctx_json' not in json_data:
        return json_data
        
    interactors = json_data['ctx_json'].get('interactors', [])
    if not interactors:
        return json_data
        
    main_protein = json_data['ctx_json'].get('main', 'Unknown')
    
    # Create a lookup map of all available interactors
    interactor_map = {i.get('primary'): i for i in interactors}
    available_symbols = set(interactor_map.keys())
    
    if verbose:
        print(f"\n{'='*60}")
        print(f"🔗 RESOLVING INDIRECT MEDIATORS for {main_protein}")
        print(f"{'='*60}")
    
    updates_made = 0
    
    for interactor in interactors:
        primary = interactor.get('primary')
        itype = interactor.get('interaction_type', 'direct')
        
        # Only process indirect interactors that don't already have a clear upstream
        if itype == 'indirect' and not interactor.get('upstream_interactor'):
            
            # Gather text to search for mediators
            text_corpus = f"{interactor.get('mechanism', '')} "
            for func in interactor.get('functions', []):
                text_corpus += f"{func.get('function', '')} {func.get('cellular_process', '')} "
                for ev in func.get('evidence', []):
                    text_corpus += f"{ev.get('relevant_quote', '')} "
            
            text_corpus = text_corpus.upper()
            
            # Check for mentions of other available proteins
            potential_mediators = []
            for candidate in available_symbols:
                if candidate == primary or candidate == main_protein:
                    continue
                
                # Strict word boundary check would be better, but substring is okay for now with spaces
                if f" {candidate} " in f" {text_corpus} " or \
                   f" {candidate}," in f" {text_corpus} " or \
                   f" {candidate}." in f" {text_corpus} ":
                    potential_mediators.append(candidate)
            
            if potential_mediators:
                # Pick the first one found
                mediator_name = potential_mediators[0]
                
                if verbose:
                    print(f"  🔗 Linking {primary} (Indirect) -> via {mediator_name} (Direct)")
                
                # Update the indirect interactor
                interactor['upstream_interactor'] = mediator_name
                interactor['mediator_chain'] = [mediator_name]
                updates_made += 1

    if verbose:
        print(f"  ✓ Linked {updates_made} indirect interactors to their mediators.")
        
    # Ensure snapshot is consistent
    if 'snapshot_json' in json_data:
        json_data['snapshot_json']['interactors'] = interactors
        
    return json_data