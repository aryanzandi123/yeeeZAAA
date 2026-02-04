#!/usr/bin/env python3
"""
DAG (Directed Acyclic Graph) Data Structures for Pathway Hierarchy

Provides in-memory representation of the pathway hierarchy for:
- Topological sorting
- Ancestor/descendant queries
- Cycle detection
- Level computation
- Materialized path generation

These structures are used by the hierarchy scripts to manipulate
pathways before persisting to the database.
"""

from dataclasses import dataclass, field
from typing import Dict, List, Set, Optional, Tuple
from collections import defaultdict
import json


@dataclass
class PathwayNode:
    """
    In-memory representation of a single pathway in the DAG.

    Attributes:
        id: Database ID of the pathway
        name: Human-readable pathway name
        ontology_id: External reference (e.g., "GO:0006914", "hsa04140")
        ontology_source: Source of ontology_id ('GO', 'KEGG', 'Reactome', or None)
        parent_ids: Set of parent pathway IDs (multiple parents allowed for DAG)
        child_ids: Set of child pathway IDs
        hierarchy_level: Depth in hierarchy (0=root, higher=deeper)
        protein_count: Number of proteins associated with this pathway
        ancestor_ids: All ancestors (transitive closure of parents)
        is_ai_generated: True if pathway was created by AI (not from ontology)
        description: Optional pathway description
    """
    id: int
    name: str
    ontology_id: Optional[str] = None
    ontology_source: Optional[str] = None
    parent_ids: Set[int] = field(default_factory=set)
    child_ids: Set[int] = field(default_factory=set)
    hierarchy_level: int = 0
    protein_count: int = 0
    ancestor_ids: Set[int] = field(default_factory=set)
    is_ai_generated: bool = False
    description: Optional[str] = None

    def is_root(self) -> bool:
        """True if this pathway has no parents (top-level category)."""
        return len(self.parent_ids) == 0

    def is_leaf(self) -> bool:
        """True if this pathway has no children (most specific level)."""
        return len(self.child_ids) == 0

    def to_dict(self) -> Dict:
        """Convert to dictionary for JSON serialization."""
        return {
            'id': self.id,
            'name': self.name,
            'ontology_id': self.ontology_id,
            'ontology_source': self.ontology_source,
            'parent_ids': list(self.parent_ids),
            'child_ids': list(self.child_ids),
            'hierarchy_level': self.hierarchy_level,
            'protein_count': self.protein_count,
            'ancestor_ids': list(self.ancestor_ids),
            'is_ai_generated': self.is_ai_generated,
            'description': self.description,
        }

    @classmethod
    def from_dict(cls, data: Dict) -> 'PathwayNode':
        """Create PathwayNode from dictionary."""
        return cls(
            id=data['id'],
            name=data['name'],
            ontology_id=data.get('ontology_id'),
            ontology_source=data.get('ontology_source'),
            parent_ids=set(data.get('parent_ids', [])),
            child_ids=set(data.get('child_ids', [])),
            hierarchy_level=data.get('hierarchy_level', 0),
            protein_count=data.get('protein_count', 0),
            ancestor_ids=set(data.get('ancestor_ids', [])),
            is_ai_generated=data.get('is_ai_generated', False),
            description=data.get('description'),
        )


class PathwayDAG:
    """
    In-memory DAG (Directed Acyclic Graph) for pathway hierarchy operations.

    Supports:
    - Adding/removing nodes and edges
    - Topological sorting (roots first)
    - Ancestor/descendant queries (transitive closure)
    - Cycle detection (validates DAG property)
    - Level computation (depth from roots)
    - Materialized path generation

    Usage:
        dag = PathwayDAG()
        dag.add_node(PathwayNode(id=1, name="Cellular Signaling"))
        dag.add_node(PathwayNode(id=2, name="Autophagy"))
        dag.add_edge(child_id=2, parent_id=1)  # Autophagy under Cellular Signaling

        levels = dag.compute_levels()
        ancestors = dag.get_ancestors(2)  # Returns {1}
    """

    def __init__(self):
        self.nodes: Dict[int, PathwayNode] = {}
        self.name_to_id: Dict[str, int] = {}  # Lowercase name -> ID for lookups
        self._next_temp_id: int = -1  # For nodes without DB IDs yet

    def add_node(self, node: PathwayNode) -> None:
        """
        Add a pathway node to the DAG.

        Args:
            node: PathwayNode to add

        Note: If node.id is None, assigns a temporary negative ID.
        """
        if node.id is None:
            node.id = self._next_temp_id
            self._next_temp_id -= 1

        self.nodes[node.id] = node
        self.name_to_id[node.name.lower()] = node.id

    def get_node(self, node_id: int) -> Optional[PathwayNode]:
        """Get node by ID, or None if not found."""
        return self.nodes.get(node_id)

    def get_node_by_name(self, name: str) -> Optional[PathwayNode]:
        """Get node by name (case-insensitive), or None if not found."""
        node_id = self.name_to_id.get(name.lower())
        return self.nodes.get(node_id) if node_id is not None else None

    def add_edge(self, child_id: int, parent_id: int) -> bool:
        """
        Add a parent-child edge between two pathways.

        Args:
            child_id: ID of child pathway
            parent_id: ID of parent pathway

        Returns:
            True if edge was added, False if nodes don't exist or edge would create cycle
        """
        if child_id not in self.nodes or parent_id not in self.nodes:
            return False

        if child_id == parent_id:
            return False  # No self-loops

        # Check if adding this edge would create a cycle
        if self._would_create_cycle(child_id, parent_id):
            return False

        self.nodes[child_id].parent_ids.add(parent_id)
        self.nodes[parent_id].child_ids.add(child_id)
        return True

    def remove_edge(self, child_id: int, parent_id: int) -> bool:
        """Remove a parent-child edge."""
        if child_id not in self.nodes or parent_id not in self.nodes:
            return False

        self.nodes[child_id].parent_ids.discard(parent_id)
        self.nodes[parent_id].child_ids.discard(child_id)
        return True

    def _would_create_cycle(self, child_id: int, parent_id: int) -> bool:
        """Check if adding edge child->parent would create a cycle."""
        # If parent is reachable from child via existing edges, adding this edge creates a cycle
        visited = set()
        stack = [child_id]

        while stack:
            current = stack.pop()
            if current == parent_id:
                continue  # Skip the proposed parent
            if current in visited:
                continue
            visited.add(current)

            # Follow children (descendants)
            for child in self.nodes[current].child_ids:
                if child == parent_id:
                    return True  # Cycle detected
                stack.append(child)

        return False

    def get_ancestors(self, node_id: int) -> Set[int]:
        """
        Get all ancestors of a node (transitive closure of parents).

        Args:
            node_id: ID of node to get ancestors for

        Returns:
            Set of all ancestor node IDs (not including the node itself)
        """
        if node_id not in self.nodes:
            return set()

        ancestors = set()
        stack = list(self.nodes[node_id].parent_ids)

        while stack:
            parent_id = stack.pop()
            if parent_id not in ancestors:
                ancestors.add(parent_id)
                if parent_id in self.nodes:
                    stack.extend(self.nodes[parent_id].parent_ids)

        return ancestors

    def get_descendants(self, node_id: int) -> Set[int]:
        """
        Get all descendants of a node (transitive closure of children).

        Args:
            node_id: ID of node to get descendants for

        Returns:
            Set of all descendant node IDs (not including the node itself)
        """
        if node_id not in self.nodes:
            return set()

        descendants = set()
        stack = list(self.nodes[node_id].child_ids)

        while stack:
            child_id = stack.pop()
            if child_id not in descendants:
                descendants.add(child_id)
                if child_id in self.nodes:
                    stack.extend(self.nodes[child_id].child_ids)

        return descendants

    def get_roots(self) -> List[PathwayNode]:
        """Get all root nodes (nodes with no parents)."""
        return [n for n in self.nodes.values() if n.is_root()]

    def get_leaves(self) -> List[PathwayNode]:
        """Get all leaf nodes (nodes with no children)."""
        return [n for n in self.nodes.values() if n.is_leaf()]

    def topological_sort(self) -> List[int]:
        """
        Return nodes in topological order (roots first, leaves last).

        Uses Kahn's algorithm for topological sorting.

        Returns:
            List of node IDs in topological order

        Raises:
            ValueError: If DAG contains cycles
        """
        in_degree = {nid: len(n.parent_ids) for nid, n in self.nodes.items()}
        queue = [nid for nid, deg in in_degree.items() if deg == 0]
        result = []

        while queue:
            node_id = queue.pop(0)
            result.append(node_id)

            for child_id in self.nodes[node_id].child_ids:
                in_degree[child_id] -= 1
                if in_degree[child_id] == 0:
                    queue.append(child_id)

        if len(result) != len(self.nodes):
            raise ValueError(f"Cycle detected in DAG! Processed {len(result)} of {len(self.nodes)} nodes.")

        return result

    def compute_levels(self) -> Dict[int, int]:
        """
        Compute hierarchy level for each node.

        Level 0 = root nodes (no parents)
        Level N = max(parent levels) + 1

        Returns:
            Dict mapping node_id -> level
        """
        levels = {}

        for node_id in self.topological_sort():
            node = self.nodes[node_id]
            if node.is_root():
                levels[node_id] = 0
            else:
                # Level is max parent level + 1 (for DAG with multiple parents)
                parent_levels = [levels[pid] for pid in node.parent_ids if pid in levels]
                levels[node_id] = max(parent_levels) + 1 if parent_levels else 0

        return levels

    def compute_all_ancestors(self) -> Dict[int, Set[int]]:
        """
        Compute ancestor_ids for all nodes (materialized paths).

        Returns:
            Dict mapping node_id -> set of all ancestor IDs
        """
        ancestors_map = {}

        for node_id in self.topological_sort():
            node = self.nodes[node_id]
            ancestors = set()

            for parent_id in node.parent_ids:
                ancestors.add(parent_id)
                if parent_id in ancestors_map:
                    ancestors.update(ancestors_map[parent_id])

            ancestors_map[node_id] = ancestors

        return ancestors_map

    def detect_cycles(self) -> List[List[int]]:
        """
        Detect and return all cycles in the graph.

        Uses DFS with three-color marking (WHITE/GRAY/BLACK).

        Returns:
            List of cycles, where each cycle is a list of node IDs
        """
        WHITE, GRAY, BLACK = 0, 1, 2
        color = {nid: WHITE for nid in self.nodes}
        cycles = []

        def dfs(node_id: int, path: List[int]) -> None:
            color[node_id] = GRAY

            for child_id in self.nodes[node_id].child_ids:
                if color[child_id] == GRAY:
                    # Found a cycle - extract it
                    try:
                        cycle_start = path.index(child_id)
                        cycles.append(path[cycle_start:] + [child_id])
                    except ValueError:
                        cycles.append([node_id, child_id])
                elif color[child_id] == WHITE:
                    dfs(child_id, path + [child_id])

            color[node_id] = BLACK

        for node_id in self.nodes:
            if color[node_id] == WHITE:
                dfs(node_id, [node_id])

        return cycles

    def validate(self) -> Tuple[bool, List[str]]:
        """
        Validate the DAG structure.

        Checks:
        1. No cycles
        2. All nodes reachable from roots
        3. No orphan references (parent/child IDs exist)
        4. Consistent parent-child relationships

        Returns:
            Tuple of (is_valid, list of error messages)
        """
        errors = []

        # Check for cycles
        cycles = self.detect_cycles()
        if cycles:
            for cycle in cycles[:3]:  # Show first 3 cycles
                cycle_names = [self.nodes[nid].name for nid in cycle if nid in self.nodes]
                errors.append(f"Cycle detected: {' -> '.join(cycle_names)}")
            if len(cycles) > 3:
                errors.append(f"... and {len(cycles) - 3} more cycles")

        # Check all nodes reachable from roots
        roots = self.get_roots()
        if not roots and self.nodes:
            errors.append("No root nodes found (all nodes have parents)")
        else:
            reachable = set()
            for root in roots:
                reachable.add(root.id)
                reachable.update(self.get_descendants(root.id))

            unreachable = set(self.nodes.keys()) - reachable
            if unreachable:
                unreachable_names = [self.nodes[nid].name for nid in list(unreachable)[:5]]
                errors.append(f"{len(unreachable)} unreachable nodes: {unreachable_names}...")

        # Check for orphan references
        for node_id, node in self.nodes.items():
            for parent_id in node.parent_ids:
                if parent_id not in self.nodes:
                    errors.append(f"Node '{node.name}' references non-existent parent ID {parent_id}")
            for child_id in node.child_ids:
                if child_id not in self.nodes:
                    errors.append(f"Node '{node.name}' references non-existent child ID {child_id}")

        # Check parent-child consistency
        for node_id, node in self.nodes.items():
            for parent_id in node.parent_ids:
                if parent_id in self.nodes and node_id not in self.nodes[parent_id].child_ids:
                    errors.append(f"Inconsistent: '{node.name}' lists '{self.nodes[parent_id].name}' as parent, but not vice versa")

        return len(errors) == 0, errors

    def get_ancestry_path(self, node_id: int) -> List[List[str]]:
        """
        Get all paths from roots to this node.

        Since this is a DAG (multiple parents), there may be multiple paths.

        Args:
            node_id: ID of the node

        Returns:
            List of paths, where each path is a list of pathway names from root to node
        """
        if node_id not in self.nodes:
            return []

        node = self.nodes[node_id]

        if node.is_root():
            return [[node.name]]

        all_paths = []
        for parent_id in node.parent_ids:
            parent_paths = self.get_ancestry_path(parent_id)
            for path in parent_paths:
                all_paths.append(path + [node.name])

        return all_paths

    def get_primary_ancestry_path(self, node_id: int) -> List[str]:
        """
        Get the primary (shortest) ancestry path from root to node.

        Args:
            node_id: ID of the node

        Returns:
            List of pathway names from root to node (shortest path)
        """
        paths = self.get_ancestry_path(node_id)
        if not paths:
            return []
        return min(paths, key=len)

    def to_dict(self) -> Dict:
        """Serialize DAG to dictionary for JSON storage."""
        return {
            'nodes': {str(nid): node.to_dict() for nid, node in self.nodes.items()},
            'name_to_id': self.name_to_id,
        }

    @classmethod
    def from_dict(cls, data: Dict) -> 'PathwayDAG':
        """Deserialize DAG from dictionary."""
        dag = cls()
        for nid_str, node_data in data.get('nodes', {}).items():
            node = PathwayNode.from_dict(node_data)
            dag.nodes[int(nid_str)] = node
        dag.name_to_id = data.get('name_to_id', {})
        return dag

    def save_to_file(self, filepath: str) -> None:
        """Save DAG to JSON file."""
        with open(filepath, 'w', encoding='utf-8') as f:
            json.dump(self.to_dict(), f, indent=2, ensure_ascii=False)

    @classmethod
    def load_from_file(cls, filepath: str) -> 'PathwayDAG':
        """Load DAG from JSON file."""
        with open(filepath, 'r', encoding='utf-8') as f:
            data = json.load(f)
        return cls.from_dict(data)

    def __len__(self) -> int:
        """Return number of nodes in DAG."""
        return len(self.nodes)

    def __contains__(self, node_id: int) -> bool:
        """Check if node ID is in DAG."""
        return node_id in self.nodes

    def __repr__(self) -> str:
        roots = len(self.get_roots())
        leaves = len(self.get_leaves())
        return f"<PathwayDAG nodes={len(self.nodes)} roots={roots} leaves={leaves}>"


def build_dag_from_db(db_session) -> PathwayDAG:
    """
    Build a PathwayDAG from database records.

    Args:
        db_session: SQLAlchemy session

    Returns:
        PathwayDAG populated from Pathway and PathwayParent tables
    """
    from models import Pathway, PathwayParent

    dag = PathwayDAG()

    # Load all pathways
    pathways = db_session.query(Pathway).all()
    for pw in pathways:
        node = PathwayNode(
            id=pw.id,
            name=pw.name,
            ontology_id=pw.ontology_id,
            ontology_source=pw.ontology_source,
            hierarchy_level=pw.hierarchy_level or 0,
            protein_count=pw.protein_count or 0,
            ancestor_ids=set(pw.ancestor_ids or []),
            is_ai_generated=pw.ai_generated,
            description=pw.description,
        )
        dag.add_node(node)

    # Load all parent-child relationships
    parent_links = db_session.query(PathwayParent).all()
    for link in parent_links:
        dag.add_edge(child_id=link.child_pathway_id, parent_id=link.parent_pathway_id)

    return dag


def save_dag_to_db(dag: PathwayDAG, db_session, update_existing: bool = True) -> Dict:
    """
    Save a PathwayDAG to database.

    Args:
        dag: PathwayDAG to save
        db_session: SQLAlchemy session
        update_existing: If True, update existing pathways; if False, skip them

    Returns:
        Dict with statistics: {created, updated, edges_created}
    """
    from models import Pathway, PathwayParent

    stats = {'created': 0, 'updated': 0, 'edges_created': 0}

    # Compute levels and ancestors
    levels = dag.compute_levels()
    ancestors_map = dag.compute_all_ancestors()

    # Update nodes with computed values
    for node_id, node in dag.nodes.items():
        node.hierarchy_level = levels.get(node_id, 0)
        node.ancestor_ids = ancestors_map.get(node_id, set())

    # Save/update pathways
    id_mapping = {}  # temp_id -> db_id

    for node in dag.nodes.values():
        if node.id < 0:  # Temporary ID, create new record
            pw = Pathway(
                name=node.name,
                description=node.description,
                ontology_id=node.ontology_id,
                ontology_source=node.ontology_source,
                ai_generated=node.is_ai_generated,
                hierarchy_level=node.hierarchy_level,
                is_leaf=node.is_leaf(),
                protein_count=node.protein_count,
                ancestor_ids=list(node.ancestor_ids),
            )
            db_session.add(pw)
            db_session.flush()  # Get the ID
            id_mapping[node.id] = pw.id
            stats['created'] += 1
        else:
            if update_existing:
                pw = db_session.query(Pathway).get(node.id)
                if pw:
                    pw.hierarchy_level = node.hierarchy_level
                    pw.is_leaf = node.is_leaf()
                    pw.protein_count = node.protein_count
                    pw.ancestor_ids = list(node.ancestor_ids)
                    if node.description:
                        pw.description = node.description
                    stats['updated'] += 1
            id_mapping[node.id] = node.id

    # Save parent-child relationships
    for node in dag.nodes.values():
        db_child_id = id_mapping.get(node.id, node.id)

        for parent_id in node.parent_ids:
            db_parent_id = id_mapping.get(parent_id, parent_id)

            # Check if relationship already exists
            existing = db_session.query(PathwayParent).filter_by(
                child_pathway_id=db_child_id,
                parent_pathway_id=db_parent_id
            ).first()

            if not existing:
                link = PathwayParent(
                    child_pathway_id=db_child_id,
                    parent_pathway_id=db_parent_id,
                    relationship_type='is_a',
                    confidence=1.0,
                    source='hierarchy_script',
                )
                db_session.add(link)
                stats['edges_created'] += 1

    return stats
