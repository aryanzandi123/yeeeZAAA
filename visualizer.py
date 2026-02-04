"""
Visualizer with original styling & behavior restored, plus:
- De-densified layout (spacing, charge, collision)
- Header/search matches index styles (title centered, round search bar)
- Nodes: dark circles + WHITE labels (as before)
- Legend restored
- Modals match original styling; two distinct modal paths:
  (1) Interaction (main ↔ interactor) when clicking the interactor link/ circle
  (2) Function (interactor → function) when clicking the function link/box
- Function confidence labels on boxes (as before)
- Arrows: pointer on hover + thicker on hover
- Function boxes connect ONLY to their interactor (never to main)
- Progress bar on viz page updated using your exact IDs
- Snapshot hydrated with ctx_json for complete function/evidence details
- Expand-on-click preserved; depth limit = 3
"""
from __future__ import annotations
import json
import subprocess
import sys
import time
from pathlib import Path
import tempfile

HTML = r"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>ProPath - PLACEHOLDER_MAIN</title>
  <link rel="icon" type="image/png" href="/static/logo.png">
  <link rel="apple-touch-icon" href="/static/logo.png">
  <link rel="stylesheet" href="/static/styles.css"/>
  <script src="/static/script.js"></script>
  <script src="https://cdn.sheetjs.com/xlsx-0.20.1/package/dist/xlsx.full.min.js"></script>
  <link rel="stylesheet" href="/static/viz-styles.css"/>
  <link rel="stylesheet" href="/static/pathway_explorer_v2.css"/>
</head>
<body class="dark-mode">
<div class="container">
  <!-- Invisible hover trigger -->
  <div class="header-trigger"></div>

  <!-- Header (classes/IDs aligned with index page) -->
  <div class="header">
    <h1 class="title" id="networkTitle">PLACEHOLDER_MAIN Interaction Network</h1>

    <div class="header-search-container">
      <div class="input-container">
        <input type="text" id="protein-input" placeholder="Search another protein..."/>
        <button id="query-button">Generate</button>
      </div>
    </div>

    <!-- Inline Controls Row: View Tabs + Research Settings -->
    <div class="header-controls-row">
      <div class="view-tabs">
        <button class="header-btn tab-btn active" onclick="switchView('graph')">Graph View</button>
        <button class="header-btn tab-btn" onclick="switchView('table')">Table View</button>
        <button class="header-btn tab-btn" onclick="switchView('chat')">Chat</button>
        <button class="header-btn tab-btn" onclick="switchView('card')">Card View</button>
      </div>

      <details class="config-details-inline">
        <summary class="header-btn config-summary-inline">Research Settings</summary>
        <div class="config-content-inline">
          <div class="config-presets">
            <button class="preset-btn" onclick="setPreset(3,3)">Quick</button>
            <button class="preset-btn" onclick="setPreset(5,5)">Standard</button>
            <button class="preset-btn" onclick="setPreset(8,8)">Thorough</button>
          </div>
          <div class="config-inputs">
            <label class="config-label">
              <span class="config-label-text">Interactor Discovery Rounds:</span>
              <input type="number" id="interactor-rounds" class="config-input" min="3" max="8" value="3">
            </label>
            <label class="config-label">
              <span class="config-label-text">Function Mapping Rounds:</span>
              <input type="number" id="function-rounds" class="config-input" min="3" max="8" value="3">
            </label>
          </div>
        </div>
      </details>

      <button class="header-btn theme-toggle-btn" onclick="toggleTheme()" title="Toggle Light/Dark Mode" id="theme-toggle">
        <span id="theme-icon">☀️</span>
      </button>
    </div>

    <div id="job-notification" class="job-notification">
      <!-- Multi-job tracker container -->
      <div id="mini-job-container" class="mini-job-container"></div>
      <!-- Notification message for non-job updates -->
      <p id="notification-message" style="display: none;"></p>
    </div>
  </div>

  <div id="network" class="view-container">
    <!-- Pathway Explorer Sidebar -->
    <div id="pathway-sidebar" class="pathway-sidebar">
      <div class="pathway-sidebar-header">
        <span class="pathway-sidebar-title">Pathway Explorer</span>
        <button class="pathway-sidebar-toggle" onclick="togglePathwaySidebar()" title="Collapse">◀</button>
      </div>
      <div class="pathway-sidebar-content">
        <div class="pathway-search-container">
          <input type="text" id="pathway-search" class="pathway-search-input" placeholder="Filter pathways..." oninput="filterPathwaySidebar(this.value)">
        </div>
        <div class="pathway-bulk-actions">
          <button class="pathway-action-btn" onclick="selectAllRootPathways()">Select All</button>
          <button class="pathway-action-btn" onclick="clearAllRootPathways()">Clear All</button>
        </div>
        <div id="pathway-tree" class="pathway-tree">
          <!-- Dynamically populated by JS -->
        </div>
      </div>
    </div>

    <!-- Collapsed Sidebar Tab -->
    <div id="pathway-sidebar-tab" class="pathway-sidebar-tab" style="display:none;" onclick="togglePathwaySidebar()" title="Open Pathway Explorer">
      <span>▶</span>
      <span class="pathway-tab-label">Pathways</span>
    </div>

    <!-- Mode Toggle: Pathway vs Interactor View -->
    <div id="mode-toggle" class="mode-toggle-container" style="display: none;">
      <button id="mode-pathway" class="mode-toggle-btn active" onclick="setVisualizationMode('pathway')" title="Show hierarchical pathway organization">
        <span class="mode-icon">&#128193;</span>
        <span class="mode-label">Pathways</span>
      </button>
      <button id="mode-interactor" class="mode-toggle-btn" onclick="setVisualizationMode('interactor')" title="Show pure interactor network">
        <span class="mode-icon">&#128279;</span>
        <span class="mode-label">Interactors</span>
      </button>
    </div>

    <div class="controls">
      <button class="control-btn" onclick="zoomIn()" title="Zoom In">+</button>
      <button class="control-btn" onclick="zoomOut()" title="Zoom Out">−</button>
      <div class="control-divider"></div>
      <button class="control-btn" onclick="refreshVisualization()" title="Reset Graph">⟳</button>
    </div>

    <div class="info-panel"><strong>TIPS:</strong> Click arrows & nodes for details</div>

    <!-- Legend restored -->
    <div class="legend">
      <div class="legend-title">INTERACTION TYPES</div>
      <div class="legend-item">
        <div class="legend-arrow">
          <svg width="30" height="20"><line x1="0" y1="10" x2="20" y2="10" stroke="#059669" stroke-width="2"/><polygon points="20,10 26,10 23,7 23,13" fill="#059669"/></svg>
        </div>Activates
      </div>
      <div class="legend-item">
        <div class="legend-arrow">
          <svg width="30" height="20"><line x1="0" y1="10" x2="20" y2="10" stroke="#dc2626" stroke-width="2"/><line x1="23" y1="6" x2="23" y2="14" stroke="#dc2626" stroke-width="3"/></svg>
        </div>Inhibits
      </div>
      <div class="legend-item">
        <div class="legend-arrow">
          <svg width="30" height="20"><line x1="0" y1="8" x2="26" y2="8" stroke="#7c3aed" stroke-width="2"/><line x1="0" y1="12" x2="26" y2="12" stroke="#7c3aed" stroke-width="2"/></svg>
        </div>Binding
      </div>
      <div class="legend-item" style="margin-top:12px;padding-top:8px;border-top:1px solid #e5e7eb">
        <div class="legend-arrow">
          <svg width="30" height="20"><line x1="0" y1="10" x2="26" y2="10" stroke="#6b7280" stroke-width="2"/></svg>
        </div>Direct (physical)
      </div>
      <div class="legend-item">
        <div class="legend-arrow">
          <svg width="30" height="20"><line x1="0" y1="10" x2="26" y2="10" stroke="#6b7280" stroke-width="2" stroke-dasharray="8,4"/></svg>
        </div>Indirect (cascade)
      </div>
      <div class="legend-item">
        <div class="legend-arrow">
          <svg width="30" height="20"><line x1="0" y1="10" x2="26" y2="10" stroke="#ff8c00" stroke-width="2" stroke-dasharray="5,5"/></svg>
        </div>Incomplete (mediator missing)
      </div>
    </div>

    <svg id="svg"></svg>
  </div>

  <div id="table-view" class="view-container" style="display:none;">
    <div class="table-controls">
      <div class="table-controls-main">
        <div class="table-controls-left">
          <div class="search-container">
            <input type="text" id="table-search" class="table-search-input" placeholder="Search interactions..." oninput="handleSearchInput(event)">
            <button class="search-clear-btn" id="search-clear-btn" onclick="clearSearch()" style="display:none;">×</button>
          </div>
          <div class="filter-chips">
            <button class="filter-chip filter-active activates" onclick="toggleFilter('activates')">Activates</button>
            <button class="filter-chip filter-active inhibits" onclick="toggleFilter('inhibits')">Inhibits</button>
            <button class="filter-chip filter-active binds" onclick="toggleFilter('binds')">Binds</button>
            <button class="filter-chip filter-active regulates" onclick="toggleFilter('regulates')">Regulates</button>
          </div>
        </div>
        <div class="export-dropdown">
          <button class="export-btn" onclick="toggleExportDropdown()">Export ▼</button>
          <div class="export-dropdown-menu" id="export-dropdown-menu">
            <button class="export-option" onclick="exportToCSV(); closeExportDropdown();">Export as CSV</button>
            <button class="export-option" onclick="exportToExcel(); closeExportDropdown();">Export as Excel (.xlsx)</button>
          </div>
        </div>
      </div>
      <div id="filter-results" class="filter-results"></div>
    </div>
    <div class="table-wrapper">
      <table id="interactions-table" class="data-table">
        <thead>
          <tr>
            <th class="col-expand"><span class="expand-header-icon">▼</span></th>
            <th class="col-interaction resizable sortable" data-sort="interaction" onclick="sortTable('interaction')">Interaction <span class="sort-indicator"></span><span class="resize-handle"></span></th>
            <th class="col-effect resizable sortable" data-sort="effect" onclick="sortTable('effect')">Type <span class="sort-indicator"></span><span class="resize-handle"></span></th>
            <th class="col-function resizable sortable" data-sort="function" onclick="sortTable('function')">Function Affected <span class="sort-indicator"></span><span class="resize-handle"></span></th>
            <th class="col-effect-type resizable sortable" data-sort="effectType" onclick="sortTable('effectType')">Effect <span class="sort-indicator"></span><span class="resize-handle"></span></th>
            <th class="col-mechanism resizable sortable" data-sort="mechanism" onclick="sortTable('mechanism')">Mechanism <span class="sort-indicator"></span><span class="resize-handle"></span></th>
          </tr>
        </thead>
        <tbody id="table-body">
          <!-- Populated by buildTableView() -->
        </tbody>
      </table>
    </div>
  </div>

  <div id="card-view" class="view-container" style="display:none; width: 100%; height: 100%; background: #0a0612; position: relative; overflow: hidden;">
    <!-- Pathway Explorer V2 - Neural Command Design -->
    <div id="pathway-explorer-v2" class="pathway-explorer-v2">
      <!-- Header -->
      <div class="pe-header">
        <div class="pe-header-main">
          <div class="pe-title-group">
            <div class="pe-neural-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2z"/>
                <path d="M12 6v6l4 2"/>
                <circle cx="12" cy="12" r="2"/>
              </svg>
            </div>
            <div>
              <div class="pe-title">Pathway Navigator</div>
              <div class="pe-subtitle">Neural Command Interface</div>
            </div>
          </div>
          <button class="pe-collapse-btn" onclick="PathwayExplorer.toggleExplorer()" title="Collapse">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M15 19l-7-7 7-7"/>
            </svg>
          </button>
        </div>
        <!-- Breadcrumb Trail -->
        <div class="pe-breadcrumb" id="pe-breadcrumb">
          <span class="pe-breadcrumb-root">Navigate pathways below</span>
        </div>
      </div>

      <!-- Search -->
      <div class="pe-search-container">
        <div class="pe-search-wrapper">
          <input type="text"
                 id="pe-search-input"
                 class="pe-search-input"
                 placeholder="Search pathways..."
                 oninput="PathwayExplorer.handleSearch(this.value)"
                 onkeydown="PathwayExplorer.handleKeyNav(event)">
          <svg class="pe-search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="11" cy="11" r="6"/>
            <line x1="16" y1="16" x2="20" y2="20"/>
          </svg>
          <button class="pe-search-clear" onclick="PathwayExplorer.clearSearch()">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M18 6L6 18M6 6l12 12"/>
            </svg>
          </button>
        </div>
        <div class="pe-search-results" id="pe-search-results"></div>
      </div>

      <!-- Stats Bar - Organism Activity Monitor -->
      <div class="pe-stats-bar">
        <div class="pe-stat activates" title="Activating interactions">
          <div class="pe-stat-organism"></div>
          <span class="pe-stat-value" id="pe-stat-activates">0</span>
        </div>
        <div class="pe-stat inhibits" title="Inhibiting interactions">
          <div class="pe-stat-organism"></div>
          <span class="pe-stat-value" id="pe-stat-inhibits">0</span>
        </div>
        <div class="pe-stat binds" title="Binding interactions">
          <div class="pe-stat-organism"></div>
          <span class="pe-stat-value" id="pe-stat-binds">0</span>
        </div>
        <div class="pe-stat regulates" title="Regulating interactions">
          <div class="pe-stat-organism"></div>
          <span class="pe-stat-value" id="pe-stat-regulates">0</span>
        </div>
      </div>

      <!-- Bulk Actions -->
      <div class="pe-actions">
        <button class="pe-action-btn" onclick="PathwayExplorer.selectAllVisible()">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M9 11l3 3L22 4M20 12v7a2 2 0 01-2 2H6a2 2 0 01-2-2V6a2 2 0 012-2h9"/>
          </svg>
          <span>Select All</span>
        </button>
        <button class="pe-action-btn" onclick="PathwayExplorer.clearAllSelections()">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M3 6h18M8 6V4h8v2M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6"/>
          </svg>
          <span>Clear</span>
        </button>
        <button class="pe-action-btn" onclick="PathwayExplorer.showAllCards()">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
            <circle cx="12" cy="12" r="3"/>
          </svg>
          <span>Show All</span>
        </button>
      </div>

      <!-- Tree Container -->
      <div class="pe-tree-container" id="pe-tree-container">
        <div class="pe-tree" id="pe-tree">
          <!-- Dynamically populated by PathwayExplorer module -->
        </div>
      </div>
    </div>

    <!-- Sync Pulse Indicators (Neural Synaptic Firing) -->
    <div id="pe-sync-indicator" class="pe-sync-indicator"></div>
    <div id="pe-sync-line" class="pe-sync-line"></div>

    <!-- Collapsed Tab -->
    <div id="pe-collapsed-tab" class="pe-collapsed-tab" onclick="PathwayExplorer.toggleExplorer()" title="Open Pathway Navigator">
      <svg class="pe-collapsed-tab-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M9 5l7 7-7 7"/>
      </svg>
      <span class="pe-collapsed-tab-label">Pathways</span>
    </div>

    <!-- Scrollable SVG Container -->
    <div id="card-svg-container" style="position: absolute; top: 0; right: 0; bottom: 0; left: 400px; overflow: auto; background: #0a0612; transition: left 0.3s ease;">
      <svg id="card-svg" style="display: block; min-width: 100%; min-height: 100%;"></svg>
    </div>

    <!-- Neural Particles (Floating Bioluminescent Organisms) -->
    <canvas id="neural-particles" data-particles style="position: absolute; top: 0; left: 0; width: 100%; height: 100%; pointer-events: none; z-index: 1;"></canvas>
  </div>

  <div id="chat-view" class="view-container" style="display:none;">
    <div class="chat-container">
      <div class="chat-header">
        <h2 class="chat-title">Network Assistant</h2>
        <p class="chat-subtitle">Ask questions about the protein interaction network</p>
      </div>
      <div id="chat-messages" class="chat-messages">
        <div class="chat-message system-message">
          <div class="message-content">
            👋 Hello! I'm here to help you understand this protein interaction network. Ask me anything about the visible proteins, their interactions, or biological functions.
          </div>
        </div>
      </div>
      <div class="chat-input-wrapper">
        <textarea
          id="chat-input"
          class="chat-input"
          placeholder="Ask about this network (e.g., 'What proteins interact with ATXN3?')..."
          rows="3"
        ></textarea>
        <button id="chat-send-btn" class="chat-send-btn" onclick="sendChatMessage()">
          <span id="chat-send-text">Send</span>
          <span id="chat-send-loading" style="display:none;">Thinking...</span>
        </button>
      </div>
    </div>
  </div>
</div>

<!-- Modal restored -->
<div id="modal" class="modal" role="dialog" aria-modal="true" aria-labelledby="modalTitle">
  <div class="modal-content">
    <div class="modal-header">
      <h2 class="modal-title" id="modalTitle">Details</h2>
      <button class="close-btn" onclick="closeModal()" aria-label="Close dialog">&times;</button>
    </div>
    <div class="modal-body">
      <div id="modalBody"></div>
    </div>
  </div>
</div>

<script src="https://cdnjs.cloudflare.com/ajax/libs/d3/7.8.5/d3.min.js"></script>
<script>
/* ===== Robust data load & hydration ===== */
let RAW, SNAP, CTX;

try {
  // Validate PLACEHOLDER was replaced
  RAW = PLACEHOLDER_JSON;

  if (!RAW || typeof RAW !== 'object') {
    throw new Error('Invalid data structure: RAW is not an object');
  }

  // Check if PLACEHOLDER wasn't replaced (safety check)
  const rawStr = JSON.stringify(RAW).substring(0, 100);
  if (rawStr.includes('PLACEHOLDER')) {
    throw new Error('Data embedding failed: template placeholder not replaced');
  }

  console.log('✅ Step 1: RAW data loaded', {
    keys: Object.keys(RAW),
    hasSnapshot: !!RAW.snapshot_json,
    hasCtx: !!RAW.ctx_json
  });

  SNAP = (RAW && RAW.snapshot_json && typeof RAW.snapshot_json === 'object') ? RAW.snapshot_json : (RAW || {});
  CTX  = (RAW && RAW.ctx_json && typeof RAW.ctx_json === 'object') ? RAW.ctx_json : {};
  SNAP.interactors = Array.isArray(SNAP.interactors) ? SNAP.interactors : [];
  if (!SNAP.main) SNAP.main = RAW.main || RAW.primary || 'Unknown';

  // Save current protein to localStorage for repair feature
  if (SNAP.main && SNAP.main !== 'Unknown') {
    localStorage.setItem('lastQueriedProtein', SNAP.main.toUpperCase());
  }

  console.log('✅ Step 2: SNAP extracted', {
    main: SNAP.main,
    keys: Object.keys(SNAP),
    hasProteins: !!SNAP.proteins,
    hasInteractors: !!SNAP.interactors,
    hasInteractions: !!SNAP.interactions
  });

  // Freeze SNAP to prevent accidental mutation after initialization
  Object.freeze(SNAP);

} catch (error) {
  console.error('❌ Data initialization failed:', error);
  document.getElementById('network').innerHTML =
    `<div style="padding: 60px 40px; text-align: center; color: #ef4444; font-family: system-ui, sans-serif;">
      <h2 style="font-size: 24px; margin-bottom: 16px;">⚠️ Failed to Load Visualization</h2>
      <p style="font-size: 16px; color: #6b7280; margin-bottom: 8px;">Error: ${error.message}</p>
      <p style="font-size: 14px; color: #9ca3af;">Check the browser console for details, then try refreshing the page.</p>
    </div>`;
  throw error; // Stop execution
}

console.log('✅ Step 3: Data loaded (hydration removed - using direct database format)');

document.getElementById('networkTitle').textContent = `${SNAP.main} Interaction Network`;
</script>
<script src="/static/visualizer.js?v=CACHE_BUST"></script>
<script src="/static/card_view.js?v=CACHE_BUST"></script>
<script src="/static/neural_particles.js?v=CACHE_BUST"></script>
</body>
</html>
"""

def _load_json(obj):
    if isinstance(obj, (str, bytes, Path)):
        return json.loads(Path(obj).read_text(encoding="utf-8"))
    if isinstance(obj, dict):
        return obj
    raise TypeError("json_data must be path or dict")

# JSON helper functions for data cleaning and validation
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

# Function name shortening map - REMOVED to preserve AI-generated specificity
# Previous NAME_FIXES was making specific names vague:
#   "ATXN3 Degradation" → "Degradation" (loses what's being degraded!)
#   "RNF8 Stability & DNA Repair" → "DNA repair" (loses the protein!)
#   "Apoptosis Inhibition" → "Apoptosis" (loses the arrow direction!)
# The AI prompts now generate specific, arrow-compatible names - preserve them!
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

    # Validate new format structure
    if not isinstance(viz_data.get('proteins'), list) or not isinstance(viz_data.get('interactions'), list):
        raise ValueError("Invalid data structure: expected 'proteins' (list) and 'interactions' (list)")

    # Get main protein name (with fallback logic)
    main = viz_data.get('main', 'Unknown')
    if not main or main == 'UNKNOWN':
        main = 'Unknown'

    # Validate data quality and log warnings
    all_issues = []
    for interaction in viz_data.get('interactions', []):
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
