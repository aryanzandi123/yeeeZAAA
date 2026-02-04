#!/usr/bin/env python3
"""
Shared Utilities for Pathway Hierarchy Scripts

Provides:
- Database connection helpers
- Batch processing utilities
- Checkpoint management
- Logging configuration
"""

import os
import sys
import json
import time
import logging
from pathlib import Path
from datetime import datetime
from typing import Dict, List, Any, Callable, Optional, TypeVar
from dataclasses import dataclass, asdict

# Add project root to path
PROJECT_ROOT = Path(__file__).parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

# Configure logging
def setup_logging(name: str, level: int = logging.INFO) -> logging.Logger:
    """Configure logging for a script."""
    logger = logging.getLogger(name)
    logger.setLevel(level)

    # Console handler
    console_handler = logging.StreamHandler()
    console_handler.setLevel(level)
    formatter = logging.Formatter(
        '%(asctime)s - %(name)s - %(levelname)s - %(message)s',
        datefmt='%Y-%m-%d %H:%M:%S'
    )
    console_handler.setFormatter(formatter)

    if not logger.handlers:
        logger.addHandler(console_handler)

    return logger


# Database connection
def get_db_session():
    """Get a database session from the Flask app context."""
    from app import app, db

    with app.app_context():
        return db.session


def get_app_context():
    """Get Flask app context for database operations."""
    from app import app
    return app.app_context()


# =============================================================================
# Batch Processing
# =============================================================================

T = TypeVar('T')


def process_in_batches(
    items: List[T],
    batch_size: int,
    processor: Callable[[List[T]], Dict],
    delay_between_batches: float = 1.5,
    verbose: bool = True,
    logger: Optional[logging.Logger] = None
) -> Dict[str, Any]:
    """
    Process items in batches with retry logic.

    Args:
        items: List of items to process
        batch_size: Number of items per batch
        processor: Function that processes a batch and returns results dict
        delay_between_batches: Seconds to wait between batches
        verbose: Whether to log progress
        logger: Logger instance (uses default if None)

    Returns:
        Combined results from all batches
    """
    if logger is None:
        logger = logging.getLogger(__name__)

    results = {}
    total_batches = (len(items) + batch_size - 1) // batch_size
    processed = 0
    errors = []

    for i in range(0, len(items), batch_size):
        batch = items[i:i + batch_size]
        batch_num = i // batch_size + 1

        if verbose:
            logger.info(f"[Batch {batch_num}/{total_batches}] Processing {len(batch)} items...")

        try:
            batch_results = processor(batch)
            results.update(batch_results)
            processed += len(batch)
        except Exception as e:
            logger.error(f"[Batch {batch_num}] Error: {e}")
            errors.append({'batch': batch_num, 'error': str(e)})

            # Retry individual items
            for item in batch:
                try:
                    single_result = processor([item])
                    results.update(single_result)
                    processed += 1
                except Exception as e2:
                    logger.error(f"[Single item] Error: {e2}")
                    errors.append({'item': str(item), 'error': str(e2)})

        # Rate limiting
        if i + batch_size < len(items):
            time.sleep(delay_between_batches)

    return {
        'results': results,
        'processed': processed,
        'total': len(items),
        'errors': errors,
    }


# =============================================================================
# Checkpoint Management
# =============================================================================

@dataclass
class Checkpoint:
    """Checkpoint for resumable script execution."""
    script_name: str
    phase: int
    timestamp: str
    data: Dict[str, Any]

    def to_dict(self) -> Dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: Dict) -> 'Checkpoint':
        return cls(
            script_name=data['script_name'],
            phase=data['phase'],
            timestamp=data['timestamp'],
            data=data.get('data', {}),
        )


class CheckpointManager:
    """
    Manages checkpoints for resumable script execution.

    Usage:
        mgr = CheckpointManager("my_script")
        checkpoint = mgr.load()
        if checkpoint and checkpoint.phase >= 3:
            print("Resuming from phase 3...")

        # After completing phase
        mgr.save(phase=3, data={'processed_ids': [1, 2, 3]})

        # On completion
        mgr.clear()
    """

    CHECKPOINT_DIR = PROJECT_ROOT / "cache" / "hierarchy_checkpoints"

    def __init__(self, script_name: str):
        self.script_name = script_name
        self.filepath = self.CHECKPOINT_DIR / f"{script_name}_checkpoint.json"

    def save(self, phase: int, data: Dict[str, Any] = None) -> None:
        """Save a checkpoint."""
        self.CHECKPOINT_DIR.mkdir(parents=True, exist_ok=True)

        checkpoint = Checkpoint(
            script_name=self.script_name,
            phase=phase,
            timestamp=datetime.now().isoformat(),
            data=data or {},
        )

        with open(self.filepath, 'w', encoding='utf-8') as f:
            json.dump(checkpoint.to_dict(), f, indent=2)

    def load(self) -> Optional[Checkpoint]:
        """Load checkpoint if exists."""
        if not self.filepath.exists():
            return None

        try:
            with open(self.filepath, 'r', encoding='utf-8') as f:
                data = json.load(f)
            return Checkpoint.from_dict(data)
        except Exception:
            return None

    def clear(self) -> None:
        """Clear checkpoint (call on successful completion)."""
        if self.filepath.exists():
            self.filepath.unlink()

    def exists(self) -> bool:
        """Check if checkpoint exists."""
        return self.filepath.exists()


# =============================================================================
# Progress Tracking
# =============================================================================

class ProgressTracker:
    """Simple progress tracker with ETA estimation."""

    def __init__(self, total: int, description: str = "Processing"):
        self.total = total
        self.description = description
        self.current = 0
        self.start_time = time.time()

    def update(self, n: int = 1) -> None:
        """Update progress by n items."""
        self.current += n

    def get_eta(self) -> str:
        """Get estimated time remaining."""
        if self.current == 0:
            return "calculating..."

        elapsed = time.time() - self.start_time
        rate = self.current / elapsed
        remaining = (self.total - self.current) / rate if rate > 0 else 0

        if remaining < 60:
            return f"{remaining:.0f}s"
        elif remaining < 3600:
            return f"{remaining / 60:.1f}m"
        else:
            return f"{remaining / 3600:.1f}h"

    def get_progress_str(self) -> str:
        """Get progress string."""
        pct = (self.current / self.total * 100) if self.total > 0 else 0
        return f"{self.description}: {self.current}/{self.total} ({pct:.1f}%) - ETA: {self.get_eta()}"


# =============================================================================
# Pathway Name Normalization
# =============================================================================

def normalize_pathway_name(name: str) -> str:
    """
    Normalize a pathway name for comparison and deduplication.

    Transformations:
    - Lowercase
    - Greek letter substitution (κ→k, β→beta, α→alpha, γ→gamma, δ→delta)
    - Remove hyphens between word chars (NF-kB → NFkB)
    - Remove punctuation
    - Collapse whitespace
    - Remove common prefixes/suffixes

    Examples:
        "NF-κB Signaling Pathway" → "nfkb"
        "NF-kB Signaling"        → "nfkb"
        "TGF-beta Signaling"     → "tgfbeta"
    """
    import re

    # Greek letter mapping (common in pathway names)
    greek_map = {
        'κ': 'k',
        'β': 'beta',
        'α': 'alpha',
        'γ': 'gamma',
        'δ': 'delta',
        'ε': 'epsilon',
        'ω': 'omega',
    }

    name = name.lower()

    # Replace Greek letters
    for greek, latin in greek_map.items():
        name = name.replace(greek, latin)

    # Remove hyphens between alphanumeric chars (NF-kB → NFkB)
    name = re.sub(r'(?<=[a-zA-Z0-9])-(?=[a-zA-Z0-9])', '', name)

    # Remove punctuation (except already handled hyphens)
    name = re.sub(r'[^\w\s]', '', name)

    # Collapse whitespace
    name = re.sub(r'\s+', ' ', name).strip()

    # Remove common prefixes (order matters - longest first)
    for prefix in ['positive regulation of ', 'negative regulation of ', 'regulation of ']:
        if name.startswith(prefix):
            name = name[len(prefix):]

    # Remove common suffixes (apply repeatedly until no more matches)
    changed = True
    while changed:
        changed = False
        for suffix in [' pathway', ' signaling', ' signalling', ' process', ' cascade', ' response']:
            if name.endswith(suffix):
                name = name[:-len(suffix)]
                changed = True

    return name.strip()


def pathway_name_similarity(name1: str, name2: str) -> float:
    """
    Calculate similarity between two pathway names.

    Returns float between 0 (no match) and 1 (exact match).
    """
    from difflib import SequenceMatcher

    norm1 = normalize_pathway_name(name1)
    norm2 = normalize_pathway_name(name2)

    if norm1 == norm2:
        return 1.0

    return SequenceMatcher(None, norm1, norm2).ratio()


# =============================================================================
# Database Transaction Helpers
# =============================================================================

def run_in_transaction(func: Callable, *args, **kwargs) -> Any:
    """
    Run a function within a database transaction.

    Commits on success, rolls back on failure.
    """
    from app import app, db

    with app.app_context():
        try:
            result = func(*args, **kwargs)
            db.session.commit()
            return result
        except Exception as e:
            db.session.rollback()
            raise e


def run_with_savepoint(func: Callable, *args, **kwargs) -> Any:
    """
    Run a function within a savepoint (nested transaction).

    Allows partial rollback without affecting outer transaction.
    """
    from app import app, db

    with app.app_context():
        try:
            with db.session.begin_nested():
                result = func(*args, **kwargs)
            db.session.commit()
            return result
        except Exception as e:
            db.session.rollback()
            raise e


# =============================================================================
# Statistics and Reporting
# =============================================================================

@dataclass
class ScriptStats:
    """Statistics for script execution."""
    script_name: str
    start_time: datetime
    end_time: Optional[datetime] = None
    items_processed: int = 0
    items_created: int = 0
    items_updated: int = 0
    errors: int = 0
    warnings: int = 0

    def duration_seconds(self) -> float:
        """Get duration in seconds."""
        if self.end_time:
            return (self.end_time - self.start_time).total_seconds()
        return (datetime.now() - self.start_time).total_seconds()

    def to_dict(self) -> Dict:
        return {
            'script_name': self.script_name,
            'start_time': self.start_time.isoformat(),
            'end_time': self.end_time.isoformat() if self.end_time else None,
            'duration_seconds': self.duration_seconds(),
            'items_processed': self.items_processed,
            'items_created': self.items_created,
            'items_updated': self.items_updated,
            'errors': self.errors,
            'warnings': self.warnings,
        }

    def summary(self) -> str:
        """Get human-readable summary."""
        duration = self.duration_seconds()
        return (
            f"{self.script_name} completed in {duration:.1f}s\n"
            f"  Processed: {self.items_processed}\n"
            f"  Created: {self.items_created}\n"
            f"  Updated: {self.items_updated}\n"
            f"  Errors: {self.errors}\n"
            f"  Warnings: {self.warnings}"
        )


def save_run_report(stats: ScriptStats, report_dir: Path = None) -> Path:
    """Save script execution report to JSON file."""
    if report_dir is None:
        report_dir = PROJECT_ROOT / "cache" / "hierarchy_reports"

    report_dir.mkdir(parents=True, exist_ok=True)

    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    filename = f"{stats.script_name}_{timestamp}.json"
    filepath = report_dir / filename

    with open(filepath, 'w', encoding='utf-8') as f:
        json.dump(stats.to_dict(), f, indent=2)

    return filepath
