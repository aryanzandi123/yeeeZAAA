import json
import time
from pathlib import Path

# New React Dashboard Template
HTML = """<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>PLACEHOLDER_MAIN ProPath Dashboard</title>

    <!-- React & ReactDOM -->
    <script crossorigin src="https://unpkg.com/react@18/umd/react.development.js"></script>
    <script crossorigin src="https://unpkg.com/react-dom@18/umd/react-dom.development.js"></script>

    <!-- Babel Standalone (for JSX in browser) -->
    <script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>

    <!-- Tailwind CSS -->
    <script src="https://cdn.tailwindcss.com"></script>

    <!-- React Force Graph -->
    <script src="//unpkg.com/react-force-graph-2d"></script>

    <!-- Lucide Icons -->
    <script src="https://unpkg.com/lucide@latest"></script>

    <!-- Custom Styles -->
    <link rel="stylesheet" href="/static/css/dashboard.css?v=CACHE_BUST">

    <!-- Custom Tailwind Configuration -->
    <script>
        tailwind.config = {
            theme: {
                extend: {
                    fontFamily: {
                        sans: ['Inter', 'system-ui', 'sans-serif'],
                        mono: ['JetBrains Mono', 'monospace'],
                    },
                    colors: {
                        slate: {
                            950: '#020617', // Darker background
                        }
                    }
                }
            }
        }
    </script>
</head>
<body class="bg-slate-950 text-slate-200 h-screen overflow-hidden selection:bg-cyan-500/30 selection:text-cyan-200">
    <div id="root"></div>

    <!-- Data Injection -->
    <script>
        window.SNAP = PLACEHOLDER_JSON;
    </script>

    <!-- React Application -->
    <script type="text/babel" src="/static/js/react-dashboard.js?v=CACHE_BUST"></script>
</body>
</html>
"""

def _load_json(obj):
    if isinstance(obj, (str, bytes, Path)):
        return json.loads(Path(obj).read_text(encoding="utf-8"))
    if isinstance(obj, dict):
        return obj
    raise TypeError("json_data must be path or dict")

def _resolve_symbol(entry):
    """Resolves protein symbol from various field names"""
    for key in ('primary', 'hgnc_symbol', 'symbol', 'gene', 'name'):
        value = entry.get(key) if isinstance(entry, dict) else None
        if isinstance(value, str) and value.strip():
            return value.strip()
    placeholder = None
    if isinstance(entry, dict):
        placeholder = entry.get('id') or entry.get('interactor_id') or entry.get('mechanism_id')
    if placeholder:
        return f"MISSING_{placeholder}"
    return None

def _build_interactor_key(interactor):
    """Creates unique key for interactor matching"""
    if not isinstance(interactor, dict):
        return None
    pmids = interactor.get('pmids')
    if isinstance(pmids, list) and pmids:
        normalized_pmids = tuple(sorted(str(pmid) for pmid in pmids))
        return ('pmids', normalized_pmids)
    summary = interactor.get('support_summary')
    if isinstance(summary, str) and summary.strip():
        return ('summary', summary.strip())
    mechanism = interactor.get('mechanism_details')
    if isinstance(mechanism, list) and mechanism:
        return ('mechanism', tuple(sorted(mechanism)))
    return None

NAME_FIXES = {}

def validate_function_name(name: str) -> tuple[bool, str]:
    """
    Check if function name is specific enough.
    Returns (is_valid, error_message)
    """
    if not name or not isinstance(name, str):
        return (False, "Function name is missing or invalid")

    name_lower = name.lower().strip()

    # Too short
    if len(name) < 5:
        return (False, f"Function name '{name}' is too short (< 5 chars)")

    # Check for overly generic terms without specifics
    generic_patterns = [
        ('regulation', 30),   # "Regulation" is vague unless part of longer specific name
        ('control', 25),      # "Control" is vague
        ('response', 25),     # "Response" is vague (unless specific like "DNA Damage Response")
        ('metabolism', 20),   # "Metabolism" alone is too vague
        ('signaling', 20),    # "Signaling" alone is too vague
        ('pathway', 20),      # "Pathway" alone is too vague
    ]

    for term, min_length in generic_patterns:
        if term in name_lower and len(name) < min_length:
            return (False, f"Function name '{name}' is too generic (contains '{term}' but too short)")

    # Check for very generic standalone terms
    very_generic = [
        'function', 'process', 'activity', 'mechanism', 'role',
        'involvement', 'participation', 'interaction'
    ]
    if name_lower in very_generic:
        return (False, f"Function name '{name}' is extremely generic")

    return (True, "")


def validate_interactor_quality(interactor: dict) -> list[str]:
    """
    Check for data quality issues in an interactor.
    Returns list of warning messages.
    """
    issues = []
    primary = interactor.get('primary', 'Unknown')

    # Check interactor-level confidence
    interactor_conf = interactor.get('confidence')
    if interactor_conf is not None and interactor_conf == 0:
        issues.append(f"{primary}: interaction confidence is 0 (likely data error)")

    # Check functions
    for idx, func in enumerate(interactor.get('functions', [])):
        func_name = func.get('function', f'Function #{idx}')

        # Validate function name specificity
        is_valid, msg = validate_function_name(func_name)
        if not is_valid:
            issues.append(f"{primary}/{func_name}: {msg}")

        # Validate function confidence
        fn_conf = func.get('confidence')
        if fn_conf is not None and fn_conf == 0:
            issues.append(f"{primary}/{func_name}: function confidence is 0 (likely data error)")

        # Check if arrow and function name are compatible
        arrow = func.get('arrow', '')
        if arrow in ['activates', 'inhibits']:
            # Function name should describe a process that can be activated/inhibited
            # This is a heuristic check
            incompatible_terms = ['interaction', 'binding', 'association']
            if any(term in func_name.lower() for term in incompatible_terms):
                issues.append(f"{primary}/{func_name}: arrow='{arrow}' may not match function name")

    return issues


def create_visualization(json_data, output_path=None):
    # PMID refresh disabled: PMIDs are already updated during pipeline execution (runner.py STAGE 5)
    # This eliminates 10-40 second blocking delays on visualization requests
    data = _load_json(json_data)

    # NEW FORMAT: Use proteins + interactions arrays directly from database
    # No normalization or deduplication needed - database returns clean data
    if 'snapshot_json' in data:
        viz_data = data['snapshot_json']
    elif 'main' in data:
        # Direct snapshot format (rare, but possible)
        viz_data = data
    else:
        raise ValueError("Invalid JSON structure: expected 'snapshot_json' or 'main' field")

    # Loose validation to support both formats
    # New format: 'proteins' and 'interactions'
    # Old/Minimal format: 'interactors'
    has_new_format = isinstance(viz_data.get('interactions'), list)
    has_old_format = isinstance(viz_data.get('interactors'), list)

    if not has_new_format and not has_old_format:
        # If neither exists, we might have an issue, but let's be permissive and warn instead of crash
        print("⚠️ Warning: JSON data missing 'interactions' or 'interactors' list.")

    # Get main protein name (with fallback logic)
    main = viz_data.get('main', 'Unknown')
    if not main or main == 'UNKNOWN':
        main = 'Unknown'

    # Validate data quality and log warnings
    all_issues = []
    # Check both keys
    interactions_to_check = viz_data.get('interactions', []) + viz_data.get('interactors', [])

    for interaction in interactions_to_check:
        issues = validate_interactor_quality(interaction)
        all_issues.extend(issues)

    if all_issues:
        print(f"\n⚠️  Data Quality Warnings for {main}:")
        for issue in all_issues[:10]:  # Limit to first 10 to avoid spam
            print(f"  - {issue}")
        if len(all_issues) > 10:
            print(f"  ... and {len(all_issues) - 10} more warnings")
        print()

    # Prepare final data for embedding
    raw = data  # Keep original structure for backwards compatibility

    # Title uses snapshot_json.main or fallback
    try:
        main = (raw.get('snapshot_json') or {}).get('main') or raw.get('main') or raw.get('primary') or 'Protein'
    except Exception:
        main = raw.get('main') or raw.get('primary') or 'Protein'

    html = HTML.replace('PLACEHOLDER_MAIN', str(main))
    html = html.replace('PLACEHOLDER_JSON', json.dumps(raw, ensure_ascii=False))
    html = html.replace('CACHE_BUST', str(int(time.time())))

    if output_path:
        # If output_path provided, write to file and return path
        p = Path(output_path)
        p.write_text(html, encoding='utf-8')
        return str(p.resolve())
    else:
        # If no output_path, return HTML content directly (for web endpoints)
        return html

def create_visualization_from_dict(data_dict, output_path=None):
    """
    Create visualization from dict (not file).

    NEW: Accepts dict directly from database (PostgreSQL).
    This maintains compatibility with existing frontend while enabling
    database-backed visualization.

    Args:
        data_dict: Dict with {snapshot_json: {...}, ctx_json: {...}}
        output_path: Optional output file path. If None, returns HTML content.

    Returns:
        HTML string if output_path is None, else path to saved HTML file

    Note:
        Internally calls create_visualization() which supports both
        dict input (via _load_json) and returns HTML or file path based on output_path.
    """
    if not isinstance(data_dict, dict):
        raise TypeError("data_dict must be a dict")

    # create_visualization already supports dict input via _load_json
    return create_visualization(data_dict, output_path)


if __name__ == "__main__":
    import sys
    if len(sys.argv) < 2:
        print("Usage: python visualizer.py <json_file> [output_html]"); raise SystemExit(2)
    src = sys.argv[1]; dst = sys.argv[2] if len(sys.argv)>2 else None
    out = create_visualization(src, dst); print("Wrote:", out)
