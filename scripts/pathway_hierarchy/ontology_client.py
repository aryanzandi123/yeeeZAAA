#!/usr/bin/env python3
"""
Ontology Client for GO and KEGG APIs

Provides functions to:
- Fetch GO term hierarchies from QuickGO API
- Fetch KEGG pathway hierarchies from KEGG REST API
- Cache results locally for efficiency
- Map between ontology IDs and human-readable names
"""

import requests
import json
import time
from pathlib import Path
from typing import Dict, List, Optional, Set, Tuple
from dataclasses import dataclass, field
from collections import defaultdict
import logging

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# API endpoints
QUICKGO_BASE = "https://www.ebi.ac.uk/QuickGO/services"
KEGG_BASE = "https://rest.kegg.jp"

# Cache directory
CACHE_DIR = Path(__file__).parent.parent.parent / "cache" / "ontology_hierarchies"


@dataclass
class OntologyTerm:
    """Represents a single ontology term (GO or KEGG)."""
    id: str  # e.g., "GO:0006914" or "hsa04140"
    name: str  # e.g., "autophagy" or "Autophagy - Homo sapiens"
    source: str  # "GO" or "KEGG"
    definition: Optional[str] = None
    parent_ids: Set[str] = field(default_factory=set)
    child_ids: Set[str] = field(default_factory=set)
    relationship_types: Dict[str, str] = field(default_factory=dict)  # parent_id -> type

    def to_dict(self) -> Dict:
        return {
            'id': self.id,
            'name': self.name,
            'source': self.source,
            'definition': self.definition,
            'parent_ids': list(self.parent_ids),
            'child_ids': list(self.child_ids),
            'relationship_types': self.relationship_types,
        }

    @classmethod
    def from_dict(cls, data: Dict) -> 'OntologyTerm':
        return cls(
            id=data['id'],
            name=data['name'],
            source=data['source'],
            definition=data.get('definition'),
            parent_ids=set(data.get('parent_ids', [])),
            child_ids=set(data.get('child_ids', [])),
            relationship_types=data.get('relationship_types', {}),
        )


class OntologyHierarchy:
    """Container for a complete ontology hierarchy."""

    def __init__(self, source: str):
        self.source = source  # "GO" or "KEGG"
        self.terms: Dict[str, OntologyTerm] = {}
        self.name_to_id: Dict[str, str] = {}  # Lowercase name -> ID

    def add_term(self, term: OntologyTerm) -> None:
        self.terms[term.id] = term
        self.name_to_id[term.name.lower()] = term.id

    def get_term(self, term_id: str) -> Optional[OntologyTerm]:
        return self.terms.get(term_id)

    def get_term_by_name(self, name: str) -> Optional[OntologyTerm]:
        term_id = self.name_to_id.get(name.lower())
        return self.terms.get(term_id) if term_id else None

    def get_ancestors(self, term_id: str) -> Set[str]:
        """Get all ancestors of a term (transitive closure)."""
        if term_id not in self.terms:
            return set()

        ancestors = set()
        stack = list(self.terms[term_id].parent_ids)

        while stack:
            parent_id = stack.pop()
            if parent_id not in ancestors and parent_id in self.terms:
                ancestors.add(parent_id)
                stack.extend(self.terms[parent_id].parent_ids)

        return ancestors

    def get_descendants(self, term_id: str) -> Set[str]:
        """Get all descendants of a term (transitive closure)."""
        if term_id not in self.terms:
            return set()

        descendants = set()
        stack = list(self.terms[term_id].child_ids)

        while stack:
            child_id = stack.pop()
            if child_id not in descendants and child_id in self.terms:
                descendants.add(child_id)
                stack.extend(self.terms[child_id].child_ids)

        return descendants

    def get_roots(self) -> List[OntologyTerm]:
        """Get all root terms (no parents)."""
        return [t for t in self.terms.values() if not t.parent_ids]

    def to_dict(self) -> Dict:
        return {
            'source': self.source,
            'terms': {tid: t.to_dict() for tid, t in self.terms.items()},
        }

    @classmethod
    def from_dict(cls, data: Dict) -> 'OntologyHierarchy':
        hierarchy = cls(data['source'])
        for tid, tdata in data.get('terms', {}).items():
            hierarchy.add_term(OntologyTerm.from_dict(tdata))
        return hierarchy

    def save_to_file(self, filepath: Path) -> None:
        filepath.parent.mkdir(parents=True, exist_ok=True)
        with open(filepath, 'w', encoding='utf-8') as f:
            json.dump(self.to_dict(), f, indent=2, ensure_ascii=False)
        logger.info(f"Saved {len(self.terms)} terms to {filepath}")

    @classmethod
    def load_from_file(cls, filepath: Path) -> Optional['OntologyHierarchy']:
        if not filepath.exists():
            return None
        with open(filepath, 'r', encoding='utf-8') as f:
            data = json.load(f)
        hierarchy = cls.from_dict(data)
        logger.info(f"Loaded {len(hierarchy.terms)} terms from {filepath}")
        return hierarchy


# =============================================================================
# Gene Ontology (GO) API Functions
# =============================================================================

def fetch_go_term(go_id: str) -> Optional[Dict]:
    """
    Fetch a single GO term from QuickGO API.

    API: GET /ontology/go/terms/{ids}
    """
    url = f"{QUICKGO_BASE}/ontology/go/terms/{go_id}"
    headers = {'Accept': 'application/json'}

    try:
        response = requests.get(url, headers=headers, timeout=30)
        response.raise_for_status()
        data = response.json()

        if data.get('results'):
            return data['results'][0]
        return None
    except Exception as e:
        logger.error(f"Error fetching GO term {go_id}: {e}")
        return None


def fetch_go_ancestors(go_id: str) -> List[Dict]:
    """
    Fetch all ancestors of a GO term.

    API: GET /ontology/go/terms/{ids}/ancestors
    Returns list of ancestor terms with relationship info.
    """
    url = f"{QUICKGO_BASE}/ontology/go/terms/{go_id}/ancestors"
    headers = {'Accept': 'application/json'}

    try:
        response = requests.get(url, headers=headers, timeout=30)
        response.raise_for_status()
        data = response.json()

        return data.get('results', [])
    except Exception as e:
        logger.error(f"Error fetching ancestors for {go_id}: {e}")
        return []


def fetch_go_children(go_id: str) -> List[Dict]:
    """
    Fetch direct children of a GO term.

    API: GET /ontology/go/terms/{ids}/children
    """
    url = f"{QUICKGO_BASE}/ontology/go/terms/{go_id}/children"
    headers = {'Accept': 'application/json'}

    try:
        response = requests.get(url, headers=headers, timeout=30)
        response.raise_for_status()
        data = response.json()

        return data.get('results', [])
    except Exception as e:
        logger.error(f"Error fetching children for {go_id}: {e}")
        return []


def fetch_go_descendants(go_id: str, relation: str = "is_a,part_of") -> List[Dict]:
    """
    Fetch all descendants of a GO term (recursive children).

    API: GET /ontology/go/terms/{ids}/descendants
    """
    url = f"{QUICKGO_BASE}/ontology/go/terms/{go_id}/descendants"
    params = {'relations': relation}
    headers = {'Accept': 'application/json'}

    try:
        response = requests.get(url, headers=headers, params=params, timeout=60)
        response.raise_for_status()
        data = response.json()

        return data.get('results', [])
    except Exception as e:
        logger.error(f"Error fetching descendants for {go_id}: {e}")
        return []


def build_go_subgraph(root_go_ids: List[str], max_depth: int = 5) -> OntologyHierarchy:
    """
    Build a GO subgraph starting from given root terms.

    Args:
        root_go_ids: List of GO IDs to start from (e.g., ["GO:0007165", "GO:0008219"])
        max_depth: Maximum depth to traverse

    Returns:
        OntologyHierarchy containing all terms in the subgraph
    """
    hierarchy = OntologyHierarchy("GO")
    visited = set()
    queue = [(go_id, 0) for go_id in root_go_ids]

    while queue:
        go_id, depth = queue.pop(0)

        if go_id in visited or depth > max_depth:
            continue
        visited.add(go_id)

        # Fetch term info
        term_data = fetch_go_term(go_id)
        if not term_data:
            continue

        # Create term
        term = OntologyTerm(
            id=go_id,
            name=term_data.get('name', go_id),
            source='GO',
            definition=term_data.get('definition', {}).get('text'),
        )

        # Fetch and add children
        children = fetch_go_children(go_id)
        for child in children:
            child_id = child.get('id')
            if child_id:
                term.child_ids.add(child_id)
                # Queue child for processing
                if child_id not in visited:
                    queue.append((child_id, depth + 1))

        hierarchy.add_term(term)
        time.sleep(0.2)  # Rate limiting

        if len(visited) % 50 == 0:
            logger.info(f"Processed {len(visited)} GO terms...")

    # Second pass: set parent_ids based on child_ids
    for term_id, term in hierarchy.terms.items():
        for child_id in term.child_ids:
            if child_id in hierarchy.terms:
                hierarchy.terms[child_id].parent_ids.add(term_id)

    logger.info(f"Built GO subgraph with {len(hierarchy.terms)} terms")
    return hierarchy


# =============================================================================
# KEGG API Functions
# =============================================================================

def fetch_kegg_pathway_list(organism: str = "hsa") -> List[Tuple[str, str]]:
    """
    Fetch list of all pathways for an organism.

    API: GET /list/pathway/{organism}
    Returns list of (pathway_id, pathway_name) tuples.
    """
    url = f"{KEGG_BASE}/list/pathway/{organism}"

    try:
        response = requests.get(url, timeout=30)
        response.raise_for_status()

        pathways = []
        for line in response.text.strip().split('\n'):
            if '\t' in line:
                parts = line.split('\t')
                pathway_id = parts[0].replace('path:', '')
                pathway_name = parts[1] if len(parts) > 1 else pathway_id
                pathways.append((pathway_id, pathway_name))

        return pathways
    except Exception as e:
        logger.error(f"Error fetching KEGG pathway list: {e}")
        return []


def fetch_kegg_pathway_info(pathway_id: str) -> Optional[Dict]:
    """
    Fetch detailed info for a KEGG pathway.

    API: GET /get/{pathway_id}
    """
    url = f"{KEGG_BASE}/get/{pathway_id}"

    try:
        response = requests.get(url, timeout=30)
        response.raise_for_status()

        # Parse KEGG flat file format
        info = {'id': pathway_id, 'name': '', 'class': '', 'description': ''}
        current_field = None

        for line in response.text.split('\n'):
            if line.startswith('NAME'):
                info['name'] = line[12:].strip()
            elif line.startswith('CLASS'):
                info['class'] = line[12:].strip()
            elif line.startswith('DESCRIPTION'):
                info['description'] = line[12:].strip()

        return info
    except Exception as e:
        logger.error(f"Error fetching KEGG pathway {pathway_id}: {e}")
        return None


def fetch_kegg_brite_hierarchy() -> Dict[str, List[str]]:
    """
    Fetch KEGG BRITE pathway hierarchy.

    This provides the official KEGG pathway classification.
    Returns dict mapping category -> list of pathway IDs.
    """
    url = f"{KEGG_BASE}/get/br:br08901/json"

    try:
        response = requests.get(url, timeout=60)
        response.raise_for_status()
        data = response.json()

        # Parse BRITE hierarchy
        categories = {}

        def parse_node(node, path=[]):
            name = node.get('name', '')
            children = node.get('children', [])

            if not children:
                # Leaf node (pathway)
                if name.startswith('hsa'):
                    pathway_id = name.split()[0]
                    category = ' > '.join(path) if path else 'Uncategorized'
                    if category not in categories:
                        categories[category] = []
                    categories[category].append(pathway_id)
            else:
                # Category node
                new_path = path + [name] if name else path
                for child in children:
                    parse_node(child, new_path)

        parse_node(data)
        return categories

    except Exception as e:
        logger.error(f"Error fetching KEGG BRITE hierarchy: {e}")
        return {}


def build_kegg_hierarchy() -> OntologyHierarchy:
    """
    Build KEGG pathway hierarchy.

    Uses KEGG BRITE classification to create parent-child relationships.
    """
    hierarchy = OntologyHierarchy("KEGG")

    # Fetch pathway list
    pathways = fetch_kegg_pathway_list()
    logger.info(f"Fetched {len(pathways)} KEGG pathways")

    # Create terms for each pathway
    for pathway_id, pathway_name in pathways:
        term = OntologyTerm(
            id=pathway_id,
            name=pathway_name.replace(' - Homo sapiens (human)', '').strip(),
            source='KEGG',
        )
        hierarchy.add_term(term)
        time.sleep(0.1)  # Rate limiting

    # Fetch BRITE hierarchy for classification
    brite = fetch_kegg_brite_hierarchy()

    # Create category nodes and link pathways
    category_ids = {}
    for category_path, pathway_ids in brite.items():
        # Create category node if not exists
        if category_path not in category_ids:
            cat_id = f"KEGG_CAT:{category_path.replace(' > ', '_').replace(' ', '_')}"
            cat_term = OntologyTerm(
                id=cat_id,
                name=category_path.split(' > ')[-1] if ' > ' in category_path else category_path,
                source='KEGG',
            )
            hierarchy.add_term(cat_term)
            category_ids[category_path] = cat_id

        # Link pathways to category
        cat_id = category_ids[category_path]
        for pw_id in pathway_ids:
            if pw_id in hierarchy.terms:
                hierarchy.terms[pw_id].parent_ids.add(cat_id)
                hierarchy.terms[cat_id].child_ids.add(pw_id)

    logger.info(f"Built KEGG hierarchy with {len(hierarchy.terms)} terms")
    return hierarchy


# =============================================================================
# Unified Functions
# =============================================================================

def get_cached_go_hierarchy(
    root_go_ids: List[str] = None,
    force_refresh: bool = False
) -> OntologyHierarchy:
    """
    Get GO hierarchy, using cache if available.

    Default root IDs cover the 7 root biological process categories:
    - GO:0006457 - protein folding (Proteostasis)
    - GO:0008152 - metabolic process (Metabolism & Bioenergetics)
    - GO:0016192 - vesicle-mediated transport (Membrane & Transport)
    - GO:0006281 - DNA repair (Genome Maintenance)
    - GO:0010467 - gene expression (Gene Expression)
    - GO:0007165 - signal transduction (Signal Transduction)
    - GO:0007010 - cytoskeleton organization (Cytoskeletal Dynamics)
    """
    if root_go_ids is None:
        root_go_ids = [
            "GO:0006457",  # protein folding (Proteostasis)
            "GO:0008152",  # metabolic process (Metabolism & Bioenergetics)
            "GO:0016192",  # vesicle-mediated transport (Membrane & Transport)
            "GO:0006281",  # DNA repair (Genome Maintenance)
            "GO:0010467",  # gene expression (Gene Expression)
            "GO:0007165",  # signal transduction (Signal Transduction)
            "GO:0007010",  # cytoskeleton organization (Cytoskeletal Dynamics)
        ]

    cache_file = CACHE_DIR / "go_hierarchy.json"

    if not force_refresh and cache_file.exists():
        hierarchy = OntologyHierarchy.load_from_file(cache_file)
        if hierarchy:
            return hierarchy

    logger.info("Building GO hierarchy from API (this may take several minutes)...")
    hierarchy = build_go_subgraph(root_go_ids, max_depth=4)
    hierarchy.save_to_file(cache_file)
    return hierarchy


def get_cached_kegg_hierarchy(force_refresh: bool = False) -> OntologyHierarchy:
    """Get KEGG hierarchy, using cache if available."""
    cache_file = CACHE_DIR / "kegg_hierarchy.json"

    if not force_refresh and cache_file.exists():
        hierarchy = OntologyHierarchy.load_from_file(cache_file)
        if hierarchy:
            return hierarchy

    logger.info("Building KEGG hierarchy from API...")
    hierarchy = build_kegg_hierarchy()
    hierarchy.save_to_file(cache_file)
    return hierarchy


def find_best_ontology_match(
    pathway_name: str,
    go_hierarchy: OntologyHierarchy,
    kegg_hierarchy: OntologyHierarchy
) -> Optional[Tuple[str, str, float]]:
    """
    Find best matching ontology term for a pathway name.

    Args:
        pathway_name: Name to search for
        go_hierarchy: GO hierarchy
        kegg_hierarchy: KEGG hierarchy

    Returns:
        Tuple of (ontology_id, source, confidence) or None if no match
    """
    from difflib import SequenceMatcher

    name_lower = pathway_name.lower()
    best_match = None
    best_score = 0.0

    # Check GO terms
    for term in go_hierarchy.terms.values():
        term_name_lower = term.name.lower()

        # Exact match
        if term_name_lower == name_lower:
            return (term.id, 'GO', 1.0)

        # Substring match
        if name_lower in term_name_lower or term_name_lower in name_lower:
            score = 0.9
            if score > best_score:
                best_score = score
                best_match = (term.id, 'GO', score)

        # Fuzzy match
        ratio = SequenceMatcher(None, name_lower, term_name_lower).ratio()
        if ratio > 0.7 and ratio > best_score:
            best_score = ratio
            best_match = (term.id, 'GO', ratio)

    # Check KEGG terms
    for term in kegg_hierarchy.terms.values():
        term_name_lower = term.name.lower()

        # Exact match
        if term_name_lower == name_lower:
            return (term.id, 'KEGG', 1.0)

        # Substring match
        if name_lower in term_name_lower or term_name_lower in name_lower:
            score = 0.9
            if score > best_score:
                best_score = score
                best_match = (term.id, 'KEGG', score)

        # Fuzzy match
        ratio = SequenceMatcher(None, name_lower, term_name_lower).ratio()
        if ratio > 0.7 and ratio > best_score:
            best_score = ratio
            best_match = (term.id, 'KEGG', ratio)

    return best_match


def get_ontology_parents(
    ontology_id: str,
    source: str,
    go_hierarchy: OntologyHierarchy,
    kegg_hierarchy: OntologyHierarchy
) -> List[Tuple[str, str]]:
    """
    Get parent terms for an ontology ID.

    Args:
        ontology_id: The ontology ID (e.g., "GO:0006914")
        source: 'GO' or 'KEGG'
        go_hierarchy: GO hierarchy
        kegg_hierarchy: KEGG hierarchy

    Returns:
        List of (parent_id, parent_name) tuples
    """
    hierarchy = go_hierarchy if source == 'GO' else kegg_hierarchy
    term = hierarchy.get_term(ontology_id)

    if not term:
        return []

    parents = []
    for parent_id in term.parent_ids:
        parent_term = hierarchy.get_term(parent_id)
        if parent_term:
            parents.append((parent_id, parent_term.name))

    return parents


# =============================================================================
# CLI for testing
# =============================================================================

if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Ontology Client CLI")
    parser.add_argument("--fetch-go", action="store_true", help="Fetch GO hierarchy")
    parser.add_argument("--fetch-kegg", action="store_true", help="Fetch KEGG hierarchy")
    parser.add_argument("--force", action="store_true", help="Force refresh (ignore cache)")
    parser.add_argument("--search", type=str, help="Search for pathway by name")

    args = parser.parse_args()

    if args.fetch_go:
        go = get_cached_go_hierarchy(force_refresh=args.force)
        print(f"GO hierarchy: {len(go.terms)} terms, {len(go.get_roots())} roots")

    if args.fetch_kegg:
        kegg = get_cached_kegg_hierarchy(force_refresh=args.force)
        print(f"KEGG hierarchy: {len(kegg.terms)} terms")

    if args.search:
        go = get_cached_go_hierarchy()
        kegg = get_cached_kegg_hierarchy()
        match = find_best_ontology_match(args.search, go, kegg)
        if match:
            print(f"Best match: {match[0]} ({match[1]}) - confidence: {match[2]:.2f}")
        else:
            print("No match found")
