#!/usr/bin/env python3
"""
SQLAlchemy Models for Protein Interaction Database

Tables:
- proteins: Core protein entities with query tracking
- interactions: Protein-protein relationships with full JSONB payload
- pathways: Biological pathways for grouping interactions (KEGG/Reactome/GO mapped)
- pathway_interactions: Many-to-many linking pathways to interactions
- pathway_parents: DAG hierarchy linking child pathways to parent pathways
"""

from flask_sqlalchemy import SQLAlchemy
from datetime import datetime
from sqlalchemy.dialects.postgresql import JSONB
from typing import Optional

db = SQLAlchemy()


class Protein(db.Model):
    """
    Protein entity with query tracking and metadata.

    Invariants:
    - symbol is unique (enforced by DB constraint)
    - query_count increments on each query
    - total_interactions updated after sync
    """
    __tablename__ = 'proteins'

    # Primary key
    id = db.Column(db.Integer, primary_key=True)

    # Protein identifier (unique, indexed for fast lookups)
    symbol = db.Column(db.String(50), unique=True, nullable=False, index=True)

    # Query tracking
    first_queried = db.Column(db.DateTime, default=datetime.utcnow, server_default=db.func.now(), nullable=False)
    last_queried = db.Column(db.DateTime, default=datetime.utcnow, server_default=db.func.now(), nullable=False)
    query_count = db.Column(db.Integer, default=0, nullable=False)
    total_interactions = db.Column(db.Integer, default=0, nullable=False)

    # Flexible metadata storage (JSONB for schema evolution)
    # Note: Using 'extra_data' instead of 'metadata' (reserved by SQLAlchemy)
    extra_data = db.Column(JSONB, server_default='{}', nullable=False)

    # Audit timestamps
    created_at = db.Column(db.DateTime, default=datetime.utcnow, server_default=db.func.now(), nullable=False)
    updated_at = db.Column(db.DateTime, default=datetime.utcnow, server_default=db.func.now(), onupdate=datetime.utcnow, nullable=False)

    # Relationships (one-to-many with interactions)
    interactions_as_a = db.relationship(
        'Interaction',
        foreign_keys='Interaction.protein_a_id',
        backref='protein_a_obj',
        cascade='all, delete-orphan',
        lazy='dynamic'
    )
    interactions_as_b = db.relationship(
        'Interaction',
        foreign_keys='Interaction.protein_b_id',
        backref='protein_b_obj',
        cascade='all, delete-orphan',
        lazy='dynamic'
    )

    def __repr__(self) -> str:
        return f'<Protein {self.symbol}>'


class Interaction(db.Model):
    """
    Protein-protein interaction with full JSONB payload.

    Invariants:
    - (protein_a_id, protein_b_id) is unique
    - protein_a_id != protein_b_id (no self-interactions)
    - data JSONB contains full pipeline output (evidence, functions, PMIDs)
    - interaction_type: 'direct' (physical) or 'indirect' (cascade/pathway)
    - upstream_interactor: required for indirect interactions, null for direct
    - mediator_chain: array of mediator proteins for multi-hop paths
    - depth: 1=direct, 2+=indirect (number of hops from query protein)
    - chain_context: stores interaction from all protein perspectives in chain

    Dual-Track System (for indirect chains):
    - function_context: 'direct' (pair-specific validation), 'net' (NET effect via chain), null (legacy)
    - Example: ATXN3→RHEB→MTOR chain creates TWO records:
      1. ATXN3→MTOR: interaction_type='indirect', function_context='net' (chain NET effect)
      2. RHEB→MTOR: interaction_type='direct', function_context='direct', _inferred_from_chain=True (extracted mediator link)
    """
    __tablename__ = 'interactions'

    # Primary key
    id = db.Column(db.Integer, primary_key=True)

    # Foreign keys (protein pair)
    protein_a_id = db.Column(
        db.Integer,
        db.ForeignKey('proteins.id', ondelete='CASCADE'),
        nullable=False,
        index=True
    )
    protein_b_id = db.Column(
        db.Integer,
        db.ForeignKey('proteins.id', ondelete='CASCADE'),
        nullable=False,
        index=True
    )

    # Denormalized fields for fast filtering (extracted from data JSONB)
    confidence = db.Column(db.Numeric(3, 2), index=True)  # 0.00 to 1.00
    direction = db.Column(db.String(20))  # 'bidirectional', 'main_to_primary', 'primary_to_main'
    arrow = db.Column(db.String(50))  # 'binds', 'activates', 'inhibits', 'regulates' (BACKWARD COMPAT: primary arrow)
    arrows = db.Column(JSONB, nullable=True)  # NEW (Issue #4): Multiple arrow types per direction {'main_to_primary': ['activates', 'inhibits'], ...}
    interaction_type = db.Column(db.String(20))  # 'direct' (physical) or 'indirect' (cascade/pathway)
    upstream_interactor = db.Column(db.String(50), nullable=True)  # Upstream protein symbol for indirect interactions
    function_context = db.Column(db.String(20), nullable=True)  # 'direct' (pair-specific), 'net' (NET effect via chain), null (legacy/unvalidated)

    # Chain metadata for multi-level indirect interactions
    mediator_chain = db.Column(JSONB, nullable=True)  # Full chain path e.g., ["VCP", "LAMP2"] for ATXN3→VCP→LAMP2→target
    depth = db.Column(db.Integer, default=1, nullable=False)  # 1=direct, 2=first indirect, 3=second indirect, etc.
    chain_context = db.Column(JSONB, nullable=True)  # Stores full chain context from all protein perspectives
    chain_with_arrows = db.Column(JSONB, nullable=True)  # NEW (Issue #2): Chain with typed arrows [{"from": "VCP", "to": "IκBά", "arrow": "inhibits"}, ...]

    # FULL PAYLOAD - Stores complete interactor JSON from pipeline
    # Contains: evidence[], functions[], pmids[], support_summary, etc.
    # Dual-track flags: _inferred_from_chain, _net_effect, _direct_mediator_link, _display_badge
    data = db.Column(JSONB, nullable=False)

    # Discovery metadata
    discovered_in_query = db.Column(db.String(50))  # Which protein query found this
    discovery_method = db.Column(db.String(50), default='pipeline')  # 'pipeline', 'requery', 'manual'

    # Audit timestamps
    created_at = db.Column(db.DateTime, default=datetime.utcnow, server_default=db.func.now(), nullable=False)
    updated_at = db.Column(db.DateTime, default=datetime.utcnow, server_default=db.func.now(), onupdate=datetime.utcnow, nullable=False)

    # Constraints and indexes
    __table_args__ = (
        # Prevent duplicate interactions
        db.UniqueConstraint('protein_a_id', 'protein_b_id', name='interaction_unique'),
        # Prevent self-interactions
        db.CheckConstraint('protein_a_id != protein_b_id', name='interaction_proteins_different'),
        # Indexes for chain queries
        db.Index('idx_interactions_depth', 'depth'),
        db.Index('idx_interactions_interaction_type', 'interaction_type'),
    )

    # Relationships (many-to-one with proteins)
    protein_a = db.relationship('Protein', foreign_keys=[protein_a_id], overlaps="interactions_as_a,protein_a_obj")
    protein_b = db.relationship('Protein', foreign_keys=[protein_b_id], overlaps="interactions_as_b,protein_b_obj")

    def __repr__(self) -> str:
        a_symbol = self.protein_a.symbol if self.protein_a else '?'
        b_symbol = self.protein_b.symbol if self.protein_b else '?'
        return f'<Interaction {a_symbol} ↔ {b_symbol}>'


class Pathway(db.Model):
    """
    Biological pathway for grouping protein interactions.

    Invariants:
    - name is unique (enforced by DB constraint)
    - ontology_id + ontology_source identify external reference (KEGG/Reactome/GO)
    - Pathways can be AI-generated (ontology_id=null) or mapped to standards
    - usage_count tracks how many interactions reference this pathway
    """
    __tablename__ = 'pathways'

    # Primary key
    id = db.Column(db.Integer, primary_key=True)

    # Pathway identifier (unique, indexed for fast lookups)
    name = db.Column(db.String(200), unique=True, nullable=False, index=True)
    description = db.Column(db.Text, nullable=True)

    # Ontology mapping (optional - for standardized pathways)
    ontology_id = db.Column(db.String(50), nullable=True)  # e.g., "GO:0006914", "hsa04140"
    ontology_source = db.Column(db.String(20), nullable=True)  # 'KEGG', 'Reactome', 'GO'
    canonical_term = db.Column(db.String(200), nullable=True)  # Standardized name from ontology

    # Generation metadata
    ai_generated = db.Column(db.Boolean, default=True, nullable=False)
    usage_count = db.Column(db.Integer, default=0, nullable=False)

    # Flexible metadata storage
    extra_data = db.Column(JSONB, server_default='{}', nullable=False)

    # Hierarchy fields (for DAG structure)
    hierarchy_level = db.Column(db.Integer, default=0, nullable=False)  # 0=root, higher=deeper
    is_leaf = db.Column(db.Boolean, default=True, nullable=False)  # True if no child pathways
    protein_count = db.Column(db.Integer, default=0, nullable=False)  # Proteins in this pathway
    ancestor_ids = db.Column(JSONB, server_default='[]', nullable=False)  # Materialized path for fast queries

    # Audit timestamps
    created_at = db.Column(db.DateTime, default=datetime.utcnow, server_default=db.func.now(), nullable=False)
    updated_at = db.Column(db.DateTime, default=datetime.utcnow, server_default=db.func.now(), onupdate=datetime.utcnow, nullable=False)

    # Indexes
    __table_args__ = (
        db.Index('idx_pathways_ontology', 'ontology_source', 'ontology_id'),
        db.Index('idx_pathways_hierarchy_level', 'hierarchy_level'),
        db.Index('idx_pathways_is_leaf', 'is_leaf'),
    )

    def __repr__(self) -> str:
        if self.ontology_id:
            return f'<Pathway {self.name} ({self.ontology_source}:{self.ontology_id})>'
        return f'<Pathway {self.name}>'


class PathwayInteraction(db.Model):
    """
    Many-to-many relationship: pathways ↔ interactions.

    Links interactions to their assigned biological pathways.
    An interaction can belong to multiple pathways.
    """
    __tablename__ = 'pathway_interactions'

    # Primary key
    id = db.Column(db.Integer, primary_key=True)

    # Foreign keys
    pathway_id = db.Column(
        db.Integer,
        db.ForeignKey('pathways.id', ondelete='CASCADE'),
        nullable=False,
        index=True
    )
    interaction_id = db.Column(
        db.Integer,
        db.ForeignKey('interactions.id', ondelete='CASCADE'),
        nullable=False,
        index=True
    )

    # Assignment metadata
    assignment_confidence = db.Column(db.Numeric(3, 2), default=0.80)  # 0.00 to 1.00
    assignment_method = db.Column(db.String(50), default='ai_pipeline')  # 'ai_pipeline', 'manual', 'ontology_match'

    # Audit timestamp
    created_at = db.Column(db.DateTime, default=datetime.utcnow, server_default=db.func.now(), nullable=False)

    # Constraints
    __table_args__ = (
        db.UniqueConstraint('pathway_id', 'interaction_id', name='pathway_interaction_unique'),
    )

    # Relationships
    pathway = db.relationship('Pathway', backref=db.backref('pathway_interactions', lazy='dynamic'))
    interaction = db.relationship('Interaction', backref=db.backref('pathway_interactions', lazy='dynamic'))

    def __repr__(self) -> str:
        pw_name = self.pathway.name if self.pathway else '?'
        return f'<PathwayInteraction pathway={pw_name} interaction_id={self.interaction_id}>'


class PathwayParent(db.Model):
    """
    DAG (Directed Acyclic Graph) relationship between pathways.

    Enables hierarchical pathway organization where:
    - A child pathway can have multiple parents (DAG, not tree)
    - Example: "Mitophagy" has parents ["Autophagy", "Mitochondrial Quality Control"]
    - Example: "PI3K/Akt/mTOR" has parents ["mTORC1 Signaling", "Cell Growth Regulation"]

    Relationship types:
    - 'is_a': Child is a subtype of parent (e.g., Mitophagy is_a Selective Autophagy)
    - 'part_of': Child is a component of parent (e.g., mTORC1 Signaling part_of Cell Growth)
    - 'regulates': Child regulates parent process

    Invariants:
    - No self-references (enforced by CHECK constraint)
    - No duplicate parent-child pairs (enforced by UNIQUE constraint)
    - DAG must be acyclic (enforced by application logic)
    """
    __tablename__ = 'pathway_parents'

    # Primary key
    id = db.Column(db.Integer, primary_key=True)

    # Foreign keys to pathways table
    child_pathway_id = db.Column(
        db.Integer,
        db.ForeignKey('pathways.id', ondelete='CASCADE'),
        nullable=False,
        index=True
    )
    parent_pathway_id = db.Column(
        db.Integer,
        db.ForeignKey('pathways.id', ondelete='CASCADE'),
        nullable=False,
        index=True
    )

    # Relationship metadata
    relationship_type = db.Column(db.String(30), default='is_a', nullable=False)  # 'is_a', 'part_of', 'regulates'
    confidence = db.Column(db.Numeric(3, 2), default=1.0, nullable=False)  # 1.0 for ontology-derived, <1.0 for AI-inferred
    source = db.Column(db.String(20), nullable=True)  # 'GO', 'KEGG', 'Reactome', 'AI'

    # Audit timestamp
    created_at = db.Column(db.DateTime, default=datetime.utcnow, server_default=db.func.now(), nullable=False)

    # Constraints
    __table_args__ = (
        db.UniqueConstraint('child_pathway_id', 'parent_pathway_id', name='pathway_parent_unique'),
        db.CheckConstraint('child_pathway_id != parent_pathway_id', name='no_self_parent'),
        db.Index('idx_pathway_parents_child', 'child_pathway_id'),
        db.Index('idx_pathway_parents_parent', 'parent_pathway_id'),
    )

    # Relationships
    child = db.relationship(
        'Pathway',
        foreign_keys=[child_pathway_id],
        backref=db.backref('parent_links', lazy='dynamic', cascade='all, delete-orphan')
    )
    parent = db.relationship(
        'Pathway',
        foreign_keys=[parent_pathway_id],
        backref=db.backref('child_links', lazy='dynamic', cascade='all, delete-orphan')
    )

    def __repr__(self) -> str:
        child_name = self.child.name if self.child else '?'
        parent_name = self.parent.name if self.parent else '?'
        return f'<PathwayParent {child_name} --[{self.relationship_type}]--> {parent_name}>'
