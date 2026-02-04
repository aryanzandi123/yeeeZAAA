/**
 * Card View / Horizontal List View Visualization
 * INDEPENDENT IMPLEMENTATION
 * 
 * Features:
 * - Independent State Management (Selection, Expansion)
 * - Independent Sidebar Controls
 * - Horizontal Tree Layout (D3)
 * - Reuses Global Data (SNAP) but builds its own hierarchy
 * - Rich Card Context (Upstream/Downstream info)
 */

// --- Configuration ---
const CV_CONFIG = {
    CARD_WIDTH: 280,   // Wider for context
    CARD_HEIGHT: 80,   // Taller for subtitles
    LEVEL_SPACING: 450, // More space for connections
    NODE_VERTICAL_SPACING: 100, // More vertical breathing room
    ANIMATION_DURATION: 400
};

// ===========================================================================
// UNIFIED STATE MANAGER - PathwayState (Single Source of Truth)
// ===========================================================================

const PathwayState = (function() {
    'use strict';

    // --- Core State (Private) ---
    const core = {
        selectedPathways: new Set(),    // ANY level pathways (no L0 filter!)
        hiddenPathways: new Set(),      // Hidden from BOTH Explorer AND Card View
        expandedBranches: new Set(),    // Explorer tree expansion
        expandedCards: new Set(),       // Card View expansion
        interactionMetadata: new Map(), // {pathwayId -> {activates, inhibits, binds, regulates, total}}
        searchQuery: '',
        syncInProgress: false,          // Prevent infinite loops

        // Visual state (animations)
        syncPulseActive: false,
        recentlyChanged: new Set(),     // For visual feedback (fade after 2s)
    };

    // --- Observers (Imperative Shell) ---
    const observers = {
        explorer: [],
        cardView: [],
        sidebar: [],
        syncIndicator: []
    };

    // --- Public API ---
    return {
        // Getters
        getSelectedPathways: () => new Set(core.selectedPathways),
        getHiddenPathways: () => new Set(core.hiddenPathways),
        getExpandedBranches: () => new Set(core.expandedBranches),
        getExpandedCards: () => new Set(core.expandedCards),
        getInteractionMetadata: () => new Map(core.interactionMetadata),
        isSyncPulseActive: () => core.syncPulseActive,
        getRecentlyChanged: () => new Set(core.recentlyChanged),

        // Mutations (notify observers)
        toggleSelection(pathwayId, source = 'unknown') {
            if (core.syncInProgress) return;

            core.syncInProgress = true;
            try {
                const wasSelected = core.selectedPathways.has(pathwayId);

                const hierarchyMap = window.getPathwayHierarchy?.() || new Map();
                const childrenMap = window.getPathwayChildrenMap?.() || new Map();

                let cascadedIds = [];

                if (wasSelected) {
                    // DESELECTING: Remove this pathway AND all descendants
                    core.selectedPathways.delete(pathwayId);

                    const toDeselect = calculateCascadeDeselectDown(
                        pathwayId,
                        core.selectedPathways,
                        childrenMap
                    );

                    toDeselect.forEach(id => {
                        core.selectedPathways.delete(id);
                        core.recentlyChanged.add(id);
                        setTimeout(() => core.recentlyChanged.delete(id), 2000);
                    });

                    cascadedIds = Array.from(toDeselect);

                } else {
                    // SELECTING: Add this pathway AND all ancestors
                    core.selectedPathways.add(pathwayId);

                    const toSelect = calculateCascadeSelectUp(
                        pathwayId,
                        core.selectedPathways,
                        hierarchyMap
                    );

                    toSelect.forEach(id => {
                        core.selectedPathways.add(id);
                        core.recentlyChanged.add(id);
                        setTimeout(() => core.recentlyChanged.delete(id), 2000);
                    });

                    cascadedIds = Array.from(toSelect);
                }

                core.recentlyChanged.add(pathwayId);
                setTimeout(() => core.recentlyChanged.delete(pathwayId), 2000);

                this.notifyAll('selection', {
                    pathwayId,
                    selected: !wasSelected,
                    source,
                    cascadedIds
                });
            } finally {
                core.syncInProgress = false;
            }
        },

        toggleVisibility(pathwayId, source = 'unknown') {
            if (core.syncInProgress) return;

            core.syncInProgress = true;
            try {
                const wasHidden = core.hiddenPathways.has(pathwayId);

                if (wasHidden) {
                    core.hiddenPathways.delete(pathwayId);
                } else {
                    core.hiddenPathways.add(pathwayId);
                }

                core.recentlyChanged.add(pathwayId);
                setTimeout(() => core.recentlyChanged.delete(pathwayId), 2000);

                this.notifyAll('visibility', { pathwayId, hidden: !wasHidden, source });
            } finally {
                core.syncInProgress = false;
            }
        },

        toggleExpansion(pathwayId, component = 'both', source = 'unknown') {
            if (core.syncInProgress) return;
            core.syncInProgress = true;

            try {
                const hierarchyMap = window.getPathwayHierarchy?.() || new Map();
                const childrenMap = window.getPathwayChildrenMap?.() || new Map();

                // Check if EITHER set has it expanded (unified expansion state)
                const wasExpanded = core.expandedBranches.has(pathwayId) || core.expandedCards.has(pathwayId);

                let cascadedIds = [];

                if (wasExpanded) {
                    // COLLAPSING: Collapse this node AND all descendants
                    core.expandedBranches.delete(pathwayId);
                    core.expandedCards.delete(pathwayId);
                    cascadedIds.push(pathwayId);

                    // CASCADE COLLAPSE: Also collapse all descendants
                    const descendants = calculateDescendants(pathwayId, childrenMap);
                    descendants.forEach(descendantId => {
                        if (core.expandedBranches.has(descendantId) || core.expandedCards.has(descendantId)) {
                            core.expandedBranches.delete(descendantId);
                            core.expandedCards.delete(descendantId);
                            cascadedIds.push(descendantId);
                        }
                    });

                    // Track for visual feedback
                    cascadedIds.forEach(id => {
                        core.recentlyChanged.add(id);
                        setTimeout(() => core.recentlyChanged.delete(id), 2000);
                    });
                } else {
                    // EXPANDING: Also expand all ancestors for visibility
                    const ancestors = calculateAncestors(pathwayId, hierarchyMap);

                    // Add the target and all ancestors to BOTH sets (unified)
                    [pathwayId, ...ancestors].forEach(id => {
                        core.expandedBranches.add(id);
                        core.expandedCards.add(id);
                        cascadedIds.push(id);
                    });

                    // Track for visual feedback
                    cascadedIds.forEach(id => {
                        core.recentlyChanged.add(id);
                        setTimeout(() => core.recentlyChanged.delete(id), 2000);
                    });
                }

                this.notifyAll('expansion', {
                    pathwayId,
                    expanded: !wasExpanded,
                    component,
                    source,
                    cascadedIds
                });
            } finally {
                core.syncInProgress = false;
            }
        },

        setInteractionMetadata(pathwayId, metadata) {
            core.interactionMetadata.set(pathwayId, metadata);
        },

        clearSelections() {
            core.selectedPathways.clear();
            this.notifyAll('selection', { pathwayId: null, selected: false, source: 'clearAll' });
        },

        selectAll(pathwayIds) {
            pathwayIds.forEach(id => core.selectedPathways.add(id));
            this.notifyAll('selection', { pathwayId: null, selected: true, source: 'selectAll' });
        },

        showAll() {
            core.hiddenPathways.clear();
            this.notifyAll('visibility', { pathwayId: null, hidden: false, source: 'showAll' });
        },

        // Observer pattern
        observe(component, callback) {
            if (!observers[component]) observers[component] = [];
            observers[component].push(callback);
        },

        notifyAll(eventType, data) {
            // Trigger sync pulse animation
            core.syncPulseActive = true;
            setTimeout(() => core.syncPulseActive = false, 800);

            // Trigger visual indicator
            const indicator = document.getElementById('pe-sync-indicator');
            const line = document.getElementById('pe-sync-line');
            if (indicator) {
                indicator.classList.remove('active');
                void indicator.offsetWidth; // Force reflow
                indicator.classList.add('active');
            }
            if (line) {
                line.classList.remove('active');
                void line.offsetWidth; // Force reflow
                line.classList.add('active');
            }

            // Notify all components
            Object.values(observers).flat().forEach(cb => {
                try {
                    cb(eventType, data);
                } catch (e) {
                    console.error('Observer error:', e);
                }
            });
        },

        // Helpers
        isSelected(pathwayId) {
            return core.selectedPathways.has(pathwayId);
        },

        isHidden(pathwayId) {
            return core.hiddenPathways.has(pathwayId);
        },

        isExpanded(pathwayId, component = 'explorer') {
            const set = component === 'explorer' ? core.expandedBranches : core.expandedCards;
            return set.has(pathwayId);
        }
    };
})();

// ===========================================================================
// EXPANSION WITH AUTO-SELECTION (Issue 2b Fix)
// ===========================================================================

/**
 * Expand a pathway and auto-select its visible children in the navigator.
 * When expanding a card node, we want the children to appear in BOTH card view
 * AND be selected in the pathway navigator for sync.
 *
 * @param {string} pathwayId - Pathway to expand
 * @param {string} source - Event source for tracking ('cardView', 'click', etc.)
 */
function expandAndSelectChildren(pathwayId, source = 'cardView') {
    const childrenMap = window.getPathwayChildrenMap?.() || new Map();

    // Check current expansion state BEFORE toggling
    const wasExpanded = PathwayState.isExpanded(pathwayId, 'cardView');

    // Toggle expansion
    PathwayState.toggleExpansion(pathwayId, 'cardView', source);

    if (!wasExpanded) {
        // EXPANDING: Auto-select visible children (those with interactors in their subtree)
        const childIds = childrenMap.get(pathwayId) || [];
        const hasInteractorsMap = window.getHasInteractorsInSubtree?.() || new Map();

        childIds.forEach(childId => {
            const hasContent = hasInteractorsMap.get(childId) === true;
            if (hasContent && !PathwayState.isSelected(childId)) {
                PathwayState.toggleSelection(childId, source);
            }
        });
    } else {
        // COLLAPSING: Deselect all descendants to hide them from card view
        // This matches the behavior of navigator checkbox deselection
        const descendants = calculateDescendants(pathwayId, childrenMap);
        descendants.forEach(descendantId => {
            if (PathwayState.isSelected(descendantId)) {
                PathwayState.toggleSelection(descendantId, source);
            }
        });
    }
}

// ===========================================================================
// PURE CASCADE LOGIC (Functional Core - No Side Effects)
// ===========================================================================

/**
 * Calculate all ancestor pathway IDs (parents, grandparents, etc.)
 * @param {string} pathwayId - Starting pathway
 * @param {Map} hierarchyMap - window.getPathwayHierarchy() result
 * @returns {Set<string>} All ancestor IDs
 */
function calculateAncestors(pathwayId, hierarchyMap) {
    const ancestors = new Set();
    const visited = new Set();
    const queue = [pathwayId];

    while (queue.length > 0) {
        const currentId = queue.shift();
        if (visited.has(currentId)) continue;
        visited.add(currentId);

        const hier = hierarchyMap.get(currentId);
        if (!hier || !hier.parent_ids) continue;

        hier.parent_ids.forEach(parentId => {
            if (!ancestors.has(parentId) && !visited.has(parentId)) {
                ancestors.add(parentId);
                queue.push(parentId);
            }
        });
    }

    return ancestors;
}

/**
 * Calculate all descendant pathway IDs (children, grandchildren, etc.)
 * @param {string} pathwayId - Starting pathway
 * @param {Map} childrenMap - window.getPathwayChildrenMap() result
 * @returns {Set<string>} All descendant IDs
 */
function calculateDescendants(pathwayId, childrenMap) {
    const descendants = new Set();
    const visited = new Set();
    const queue = [pathwayId];

    while (queue.length > 0) {
        const currentId = queue.shift();
        if (visited.has(currentId)) continue;
        visited.add(currentId);

        const children = childrenMap.get(currentId);
        if (!children) continue;

        children.forEach(childId => {
            if (!descendants.has(childId) && !visited.has(childId)) {
                descendants.add(childId);
                queue.push(childId);
            }
        });
    }

    return descendants;
}

/**
 * Calculate pathways to select when cascading up (for selection)
 * @param {string} pathwayId - Pathway being selected
 * @param {Set} currentlySelected - Current selection state
 * @param {Map} hierarchyMap - Hierarchy data
 * @returns {Set<string>} IDs that need to be selected
 */
function calculateCascadeSelectUp(pathwayId, currentlySelected, hierarchyMap) {
    const toSelect = new Set();
    const ancestors = calculateAncestors(pathwayId, hierarchyMap);

    ancestors.forEach(ancestorId => {
        if (!currentlySelected.has(ancestorId)) {
            toSelect.add(ancestorId);
        }
    });

    return toSelect;
}

/**
 * Calculate pathways to deselect when cascading down (for deselection)
 * @param {string} pathwayId - Pathway being deselected
 * @param {Set} currentlySelected - Current selection state
 * @param {Map} childrenMap - Children mapping
 * @returns {Set<string>} IDs that need to be deselected
 */
function calculateCascadeDeselectDown(pathwayId, currentlySelected, childrenMap) {
    const toDeselect = new Set();
    const descendants = calculateDescendants(pathwayId, childrenMap);

    descendants.forEach(descendantId => {
        if (currentlySelected.has(descendantId)) {
            toDeselect.add(descendantId);
        }
    });

    return toDeselect;
}

/**
 * Validate hierarchy data integrity
 * @param {Map} hierarchyMap - Hierarchy data
 * @param {Map} childrenMap - Children mapping
 * @returns {Object} {valid: boolean, errors: string[]}
 */
function validateHierarchyData(hierarchyMap, childrenMap) {
    const errors = [];
    const allPathways = new Set([...hierarchyMap.keys(), ...childrenMap.keys()]);

    allPathways.forEach(pathwayId => {
        const ancestors = calculateAncestors(pathwayId, hierarchyMap);
        if (ancestors.has(pathwayId)) {
            errors.push(`Self-ancestry cycle: ${pathwayId}`);
        }
    });

    return { valid: errors.length === 0, errors };
}

// --- State (Legacy - will be replaced by PathwayState) ---
const cvState = {
    expandedNodes: new Set(), // IDs of expanded nodes
    selectedRoots: new Set(), // IDs of selected root pathways
    hiddenCards: new Set(),   // IDs of hidden pathway cards (NEW for v2)
    rootPathways: [],         // List of all root pathways
    initialized: false,
    sidebarCollapsed: false,
    filterByInteractorDescendants: true  // Only show pathways leading to interactors by default
};

// --- D3 Objects ---
let cvSvg, cvG, cvZoom;

// ============================================================================
// INITIALIZATION
// ============================================================================

function initCardView() {
    if (cvState.initialized) return;

    // 1. Setup D3 - Scrollable mode (no zoom/pan)
    const container = document.getElementById('card-view');
    if (!container) return;

    cvSvg = d3.select('#card-svg');
    cvG = cvSvg.append('g').attr('class', 'card-view-group');

    // No zoom behavior - we use native scroll instead
    cvZoom = null;


    // 2. Initialize Data
    const rawPathways = window.getRawPathwayData ? window.getRawPathwayData() : [];

    // ✅ FIXED: Store ALL pathways (not just L0) to support any-level selection
    cvState.rootPathways = rawPathways;

    // ✅ FIX 2a: Do NOT auto-select all L0 pathways
    // Let PathwayExplorer.init() handle selection based on filterByInteractorDescendants
    // cvState.selectedRoots starts empty

    // 3. Render Sidebar
    renderCardSidebar();

    // 4. Validate hierarchy data integrity
    runHierarchyValidation();

    // 5. Register expansion observer for bidirectional sync
    PathwayState.observe('cardView', (eventType, data) => {
        if (eventType === 'expansion') {
            // Sync expansion state from PathwayState to cvState
            cvState.expandedNodes = new Set([
                ...PathwayState.getExpandedBranches(),
                ...PathwayState.getExpandedCards()
            ]);
            renderCardView();
        }
    });

    cvState.initialized = true;
    renderCardView();
}

/**
 * Run hierarchy validation and report any issues
 */
function runHierarchyValidation() {
    const hierarchyMap = window.getPathwayHierarchy?.() || new Map();
    const childrenMap = window.getPathwayChildrenMap?.() || new Map();

    const result = validateHierarchyData(hierarchyMap, childrenMap);

    if (!result.valid) {
        console.group('⚠️ Hierarchy Validation Errors');
        result.errors.forEach(err => console.error(err));
        console.error('Run: python scripts/pathway_v2/verify_pipeline.py --auto-fix');
        console.groupEnd();
    } else {
        console.log('✅ Hierarchy validation passed');
    }

    return result.valid;
}

// ============================================================================
// DATA & HIERARCHY
// ============================================================================

/**
 * Build the Tree Data Structure dynamically based on State
 */
function buildCardHierarchy() {
    const mainId = window.getMainProteinId ? window.getMainProteinId() : "Main";
    const hierarchyMap = window.getPathwayHierarchy ? window.getPathwayHierarchy() : new Map();
    const childrenMap = window.getPathwayChildrenMap ? window.getPathwayChildrenMap() : new Map();

    const rootNode = {
        id: mainId,
        type: 'main',
        children: []
    };

    // Track created nodes to avoid duplicates
    const nodeMap = new Map(); // pathwayId -> node

    /**
     * Get full ancestry chain from L0 root down to pathwayId
     * Returns: [L0_id, L1_id, L2_id, ..., pathwayId]
     */
    function getAncestryChain(pathwayId) {
        const chain = [];
        let currentId = pathwayId;
        const visited = new Set(); // Prevent infinite loops
        
        while (currentId && !visited.has(currentId)) {
            visited.add(currentId);
            chain.unshift(currentId); // Add to front
            
            const hier = hierarchyMap.get(currentId);
            const parentIds = hier?.parent_ids || [];
            
            // Take first parent (pathways can have multiple parents, but we show one chain)
            currentId = parentIds.length > 0 ? parentIds[0] : null;
        }
        
        return chain;
    }

    /**
     * Get or create a pathway node (cached to avoid duplicates)
     */
    function getOrCreateNode(pathwayId) {
        if (nodeMap.has(pathwayId)) {
            return nodeMap.get(pathwayId);
        }

        const raw = cvState.rootPathways.find(pw => (pw.id || `pathway_${pw.name.replace(/\s+/g, '_')}`) === pathwayId);
        if (!raw) {
            return null;
        }

        const node = createPathwayNode(pathwayId, raw, hierarchyMap);
        nodeMap.set(pathwayId, node);
        return node;
    }

    // 1. Build ancestry chains for all selected pathways
    // ✅ Shows full L0→L1→L2→L3 chain for context
    // ✅ FIX: Only show pathways if all their ancestors are expanded
    cvState.selectedRoots.forEach(pathwayId => {
        if (cvState.hiddenCards.has(pathwayId)) return;

        const chain = getAncestryChain(pathwayId);

        // Check if all ancestors (except the pathway itself) are expanded
        // This ensures collapsed parents hide their children
        const ancestorsExceptSelf = chain.slice(0, -1); // All except the last (target pathway)
        const allAncestorsExpanded = ancestorsExceptSelf.every(ancestorId =>
            cvState.expandedNodes.has(ancestorId)
        );

        // Skip this pathway if any ancestor is collapsed (unless it's an L0 root with no ancestors)
        if (ancestorsExceptSelf.length > 0 && !allAncestorsExpanded) {
            return;
        }

        // Build tree from L0 root down to selected pathway
        let parentNode = rootNode;

        chain.forEach((id) => {
            const node = getOrCreateNode(id);
            if (!node) return;

            // Check if node already exists in parent's children
            if (!parentNode.children) parentNode.children = [];
            const existingChild = parentNode.children.find(c => c.id === id);

            if (!existingChild) {
                // Add new node as child
                parentNode.children.push(node);
                parentNode = node; // Move down to this node
            } else {
                // Reuse existing node
                parentNode = existingChild;
            }
        });
    });

    // 2. Recursively add children if expanded
    // DFS traversal to add children
    const processedNodes = new Set(); // ✅ Track processed nodes to prevent infinite loops
    
    const processChildren = (parentNode) => {
        if (!cvState.expandedNodes.has(parentNode.id)) return;
        // Skip if hidden
        if (cvState.hiddenCards.has(parentNode.id)) return;

        // A. Add Child Pathways
        const childIds = childrenMap.get(parentNode.id);
        if (childIds) {
            childIds.forEach(childId => {
                // Skip hidden child pathways
                if (cvState.hiddenCards.has(childId)) return;

                // ✅ NEW: Filter by interactor descendants (default behavior)
                // Only show pathways that eventually lead to interactors
                if (cvState.filterByInteractorDescendants) {
                    const hasInteractorsMap = window.getHasInteractorsInSubtree?.();
                    if (hasInteractorsMap && hasInteractorsMap.get(childId) === false) {
                        // Skip pathways without interactor descendants
                        // UNLESS it's manually selected (via cvState.selectedRoots)
                        if (!cvState.selectedRoots.has(childId)) {
                            return;
                        }
                    }
                }

                // ✅ FIX: Check if child already exists (from ancestry chain)
                if (!parentNode.children) parentNode.children = [];
                const existingChild = parentNode.children.find(c => c.id === childId);
                if (existingChild) {
                    // Child already in tree from ancestry chain, skip adding duplicate
                    return;
                }

                const raw = cvState.rootPathways.find(pw => (pw.id || `pathway_${pw.name.replace(/\s+/g, '_')}`) === childId);

                if (raw) {
                    const childNode = createPathwayNode(childId, raw, hierarchyMap);
                    parentNode.children.push(childNode);
                    // Recursively process this new child's descendants if expanded
                    processChildren(childNode);
                }
            });
        }

        // B. Add Leaf Interactors (Iterative Hierarchical Assignment)
        if (parentNode.raw && parentNode.raw.interactor_ids) {
            const pathwayInteractors = parentNode.raw.interactor_ids;

            // Track all created nodes for lookup
            const nodesById = new Map();
            const unassignedIds = new Set(pathwayInteractors);
            const assignedIds = new Set(); // Nodes successfully placed in the tree

            // --- SETUP: Identify Anchors and Split by Direction ---
            // Pass 1 now respects the flow relative to the Main Protein (e.g., ATXN3).
            // - Downstream (ATXN3 -> Int): Group under a single ATXN3 parent node.
            // - Upstream (Int -> ATXN3): Int becomes the root, ATXN3 becomes its child.

            const directInteractors = pathwayInteractors.filter(intId => isDirectlyConnectedToMain(intId));
            const downstreamAnchors = [];
            const upstreamAnchors = [];

            directInteractors.forEach(intId => {
                // Guard against missing SNAP data
                // NOTE: Use `SNAP` not `window.SNAP` — SNAP is a `let` variable, not a window property
                if (!SNAP || !SNAP.interactions) return;

                const interaction = SNAP.interactions.find(i =>
                    (i.source === SNAP.main && i.target === intId) ||
                    (i.source === intId && i.target === SNAP.main)
                );

                let isUpstream = false;
                if (interaction) {
                    // Primary check: explicit direction field
                    if (interaction.direction === 'primary_to_main') {
                        isUpstream = true;
                    }
                    // Secondary check: source/target fields (ground truth set by backend)
                    // Backend sets source=interactor, target=query for primary_to_main (app.py:495-498)
                    else if (interaction.source === intId && interaction.target === SNAP.main) {
                        isUpstream = true;
                    }
                    // If bi-directional or undefined, default to Downstream
                }

                if (isUpstream) {
                    upstreamAnchors.push(intId);
                } else {
                    downstreamAnchors.push(intId);
                }
            });

            // === UNIFIED LAYOUT: Upstream → ATXN3 → Downstream ===
            // All anchors (upstream AND downstream) share ONE central ATXN3 node.
            // Layout: [Pathway] → [Upstream1] → [ATXN3] → [Downstream1]
            //         [Pathway] → [Upstream2] ↗          ↘ [Downstream2]
            // In tree form: upstream anchors are children of pathway,
            // ATXN3 is child of LAST upstream anchor (or pathway if no upstream),
            // downstream anchors are children of ATXN3.

            let centralMainNode = null;

            // === UPSTREAM → ATXN3 → DOWNSTREAM LAYOUT ===
            // Layout: [Pathway] → [RAD23A] ↘
            //         [Pathway] → [RAD23B] → [ATXN3] → [E2F1, KLF4, ...]
            //         [Pathway] → [UBE4B]  ↗
            //
            // In tree structure: ATXN3 is child of FIRST upstream anchor.
            // Other upstream anchors are siblings (children of pathway).
            // Extra links from other upstream anchors → ATXN3 are added post-layout.

            if (upstreamAnchors.length > 0) {
                // Create all upstream anchor nodes as children of the pathway
                upstreamAnchors.forEach((intId, idx) => {
                    const anchorNode = createInteractorNode(intId, parentNode.id);
                    nodesById.set(intId, anchorNode);
                    addChildIfUnique(parentNode, anchorNode);
                    assignedIds.add(intId);
                    unassignedIds.delete(intId);

                    if (idx === 0) {
                        // FIRST upstream anchor: ATXN3 is its child (natural tree link)
                        centralMainNode = createInteractorNode(SNAP.main, anchorNode.id);
                        centralMainNode.isQueryProtein = true;
                        centralMainNode._uid = SNAP.main + '::' + parentNode.id;
                        nodesById.set(SNAP.main, centralMainNode);
                        assignedIds.add(SNAP.main);
                        addChildIfUnique(anchorNode, centralMainNode);
                    } else {
                        // OTHER upstream anchors: store for extra links later
                        // Tag them so we can find them and draw extra links to ATXN3
                        anchorNode._extraLinkToMain = true;
                        anchorNode._extraLinkTargetUid = centralMainNode._uid;
                    }
                });

                // Attach downstream anchors as children of the shared ATXN3 node
                downstreamAnchors.forEach(intId => {
                    const node = createInteractorNode(intId, centralMainNode.id);
                    nodesById.set(intId, node);
                    addChildIfUnique(centralMainNode, node);
                    assignedIds.add(intId);
                    unassignedIds.delete(intId);
                });

            } else if (downstreamAnchors.length > 0) {
                // No upstream: ATXN3 is child of pathway directly
                centralMainNode = createInteractorNode(SNAP.main, parentNode.id);
                centralMainNode.isQueryProtein = true;
                centralMainNode._uid = SNAP.main + '::' + parentNode.id;
                nodesById.set(SNAP.main, centralMainNode);
                assignedIds.add(SNAP.main);
                addChildIfUnique(parentNode, centralMainNode);

                downstreamAnchors.forEach(intId => {
                    const node = createInteractorNode(intId, centralMainNode.id);
                    nodesById.set(intId, node);
                    addChildIfUnique(centralMainNode, node);
                    assignedIds.add(intId);
                    unassignedIds.delete(intId);
                });
            } else if (pathwayInteractors.length > 0) {
                // Edge case: No direct anchors at all (only indirect).
                centralMainNode = createInteractorNode(SNAP.main, parentNode.id);
                centralMainNode.isQueryProtein = true;
                centralMainNode._uid = SNAP.main + '::' + parentNode.id;
                nodesById.set(SNAP.main, centralMainNode);
                assignedIds.add(SNAP.main);
                addChildIfUnique(parentNode, centralMainNode);
            }

            // Note: If centralMainNode acts as a catch-all, ensure it exists for Extensions/Islands
            if (!centralMainNode && nodesById.has(SNAP.main)) {
                centralMainNode = nodesById.get(SNAP.main);
            }

            // --- PASS 2: Extensions (Iteratively attach to Assigned Nodes) ---
            // Iterate until no more nodes can be attached.
            let progress = true;
            // Guard against infinite loops (though unassigned decreases, so safe)
            while (progress && unassignedIds.size > 0) {
                progress = false;
                const currentUnassigned = Array.from(unassignedIds);

                currentUnassigned.forEach(childId => {
                    const candidates = Array.from(assignedIds);
                    const parentId = findUpstreamParent(childId, candidates);

                    if (parentId && nodesById.has(parentId)) {
                        const parentNodeForIndirect = nodesById.get(parentId);

                        // Create Node
                        const node = createInteractorNode(childId, parentNodeForIndirect.id);
                        nodesById.set(childId, node);

                        // Add to Parent's children
                        addChildIfUnique(parentNodeForIndirect, node);

                        // Mark assigned
                        assignedIds.add(childId);
                        unassignedIds.delete(childId);
                        progress = true; // Continue to next iteration
                    }
                });
            }

            // --- PASS 3: Island Resolution (Disconnected Sub-trees) ---
            // Islands usually imply missing intermediates.
            // We attach them to the Central Main Node (ATXN3) if it exists, as the most logical parent.
            if (unassignedIds.size > 0) {
                // Ensure we have a central anchor for islands
                if (!centralMainNode) {
                    centralMainNode = createInteractorNode(SNAP.main, parentNode.id);
                    centralMainNode.isQueryProtein = true;
                    centralMainNode._uid = SNAP.main + '::' + parentNode.id;
                    nodesById.set(SNAP.main, centralMainNode);
                    assignedIds.add(SNAP.main);
                    addChildIfUnique(parentNode, centralMainNode);
                }
            }

            while (unassignedIds.size > 0) {
                const currentUnassigned = Array.from(unassignedIds);
                let madeAssignment = false;

                // A. Try to find Local Roots
                const localRoots = currentUnassigned.filter(nodeId => {
                    const internalParent = findUpstreamParent(nodeId, currentUnassigned.filter(id => id !== nodeId));
                    return !internalParent;
                });

                if (localRoots.length > 0) {
                    localRoots.forEach(rootId => {
                        // Attach to Central Main Node (ATXN3)
                        const node = createInteractorNode(rootId, centralMainNode.id);
                        nodesById.set(rootId, node);

                        addChildIfUnique(centralMainNode, node);

                        assignedIds.add(rootId);
                        unassignedIds.delete(rootId);
                    });
                    madeAssignment = true;
                } else {
                    // B. Cycle Detection
                    const cycleBreaker = currentUnassigned[0];
                    const node = createInteractorNode(cycleBreaker, centralMainNode.id);
                    nodesById.set(cycleBreaker, node);

                    addChildIfUnique(centralMainNode, node);

                    assignedIds.add(cycleBreaker);
                    unassignedIds.delete(cycleBreaker);
                    madeAssignment = true;
                }

                // C. Re-run Extensions (Pass 2 Logic)
                if (madeAssignment && unassignedIds.size > 0) {
                    let extensionProgress = true;
                    while (extensionProgress && unassignedIds.size > 0) {
                        extensionProgress = false;
                        const validParents = Array.from(assignedIds);
                        const leftovers = Array.from(unassignedIds);

                        leftovers.forEach(childId => {
                            const parentId = findUpstreamParent(childId, validParents);
                            if (parentId && nodesById.has(parentId)) {
                                const parentNode = nodesById.get(parentId);
                                const node = createInteractorNode(childId, parentNode.id);
                                nodesById.set(childId, node);

                                addChildIfUnique(parentNode, node);

                                assignedIds.add(childId);
                                unassignedIds.delete(childId);
                                extensionProgress = true;
                            }
                        });
                    }
                }
            }
        }
    };

    // ✅ FIX: Traverse ALL nodes in tree (including those from ancestry chains)
    // Then add children/interactions for expanded nodes
    function traverseAndProcess(node) {
        if (!node) return;

        // First, process this node (add children if expanded)
        processChildren(node);

        // Then traverse existing children (from ancestry chains)
        if (node.children) {
            node.children.forEach(child => {
                // Only traverse pathway nodes, not interactor nodes
                if (child.type === 'pathway') {
                    traverseAndProcess(child);
                }
            });
        }
    }

    // Start traversal from root's immediate children
    if (rootNode.children) {
        rootNode.children.forEach(traverseAndProcess);
    }

    return rootNode;
}

// Helper: Add child to parent only if not already present (by ID) - prevents duplicates
function addChildIfUnique(parent, child) {
    if (!parent.children) parent.children = [];
    const exists = parent.children.some(c => c.id === child.id);
    if (!exists) {
        parent.children.push(child);
        return true;
    }
    return false;
}

// Helper: Check direct connection to Main
function isDirectlyConnectedToMain(nodeId) {
    if (!SNAP || !SNAP.interactions) return false;
    // Check both directions
    return SNAP.interactions.some(i =>
        (
            (i.source === SNAP.main && i.target === nodeId) ||
            (i.source === nodeId && i.target === SNAP.main)
        ) &&
        // EXCLUDE 'indirect' types to force them into Pass 2
        // unless they are explicitly masquerading as direct (should be handled by source switch in app.py)
        // Ideally, if app.py switched source to upstream, this strict check isn't needed,
        // but adding it ensures safety against data artifacts.
        i.type !== 'indirect'
    );
}

// Helper: Find upstream parent for an indirect node within a candidate set
function findUpstreamParent(childId, candidates) {
    if (!SNAP || !SNAP.interactions) return null;

    // Strategy 1: Look for explicit 'upstream_interactor' metadata
    // This is specific to our V2 pipeline's indirect interaction structure
    // We look for any interaction involving the child where the upstream_interactor is a candidate
    const indirectInteraction = SNAP.interactions.find(i =>
        (i.target === childId || i.source === childId) &&
        i.upstream_interactor &&
        candidates.includes(i.upstream_interactor)
    );

    if (indirectInteraction) {
        return indirectInteraction.upstream_interactor;
    }

    // Strategy 2: Topology - Look for direct link from Candidate -> Child (or swapped)
    const parent = candidates.find(candidateId => {
        return SNAP.interactions.some(i =>
            (i.source === candidateId && i.target === childId) ||
            (i.source === childId && i.target === candidateId)
        );
    });

    return parent || null;
}

function createInteractorNode(intId, parentId) {
    let rel = null;
    if (window.getNodeRelationship) {
        // If the parent is an interactor (implied by ID not starting with pathway_),
        // we might want context relative to THAT parent.
        // But getNodeRelationship assumes Main.

        const isPathway = parentId.startsWith('pathway_');
        if (isPathway) {
            rel = window.getNodeRelationship(intId);
        } else {
            // It's a nested node. Find relationship with parentId
            rel = getLocalRelationship(parentId, intId);
        }
    }

    return {
        id: intId,
        type: 'interactor',
        label: intId,
        parentId: parentId,
        contextText: rel ? rel.text : '',
        arrowType: rel ? rel.arrow : 'binds',
        isDownstream: rel ? (rel.direction === 'downstream') : false,
        children: [] // allow children for cascades
    };
}

function getLocalRelationship(parentId, childId) {
    if (!SNAP || !SNAP.interactions) return null;
    const interaction = SNAP.interactions.find(i =>
        (i.source === parentId && i.target === childId) ||
        (i.source === childId && i.target === parentId)
    );

    if (!interaction) return { text: 'Associated', arrow: 'binds' };

    const isDownstream = interaction.source === parentId;
    const arrow = interaction.arrow || 'binds';

    // e.g. "PNKP activates ATM"
    const action = arrow === 'activates' ? 'activates' :
        arrow === 'inhibits' ? 'inhibits' :
            arrow === 'regulates' ? 'regulates' : 'binds';

    let text = '';
    if (isDownstream) {
        text = `${parentId} ${action} ${childId}`;
        return {
            direction: 'downstream',
            arrow: arrow,
            text: text
        };
    } else {
        text = `${childId} ${action} ${parentId}`; // Fix: parent -> parentId
        return {
            direction: 'upstream',
            arrow: arrow,
            text: text
        };
    }
}

function createPathwayNode(id, raw, hierarchyMap) {
    const hier = hierarchyMap.get(id);
    return {
        id: id,
        label: raw.name,
        type: 'pathway',
        level: raw.hierarchy_level || 0,
        isLeaf: hier?.is_leaf,
        raw: raw, // Keep ref to raw for interactor lookup
        _childrenCount: (hier?.child_ids?.length || 0) + (raw.interactor_ids?.length || 0)
    };
}


// ============================================================================
// RENDERING
// ============================================================================

function renderCardView() {
    if (!cvState.initialized) initCardView();

    // BUG A FIX: Show empty state if no pathways selected
    if (cvState.selectedRoots.size === 0) {
        // Clear existing content
        cvG.selectAll('.cv-node').remove();
        cvG.selectAll('.cv-link').remove();
        cvG.selectAll('.cv-empty-state').remove();

        // Set minimal SVG size
        cvSvg.attr('width', 600).attr('height', 200);
        cvG.attr('transform', 'translate(300, 100)');

        // Show empty state message
        const emptyGroup = cvG.append('g').attr('class', 'cv-empty-state');

        emptyGroup.append('text')
            .attr('text-anchor', 'middle')
            .attr('dy', '-0.5em')
            .style('fill', '#64748b')
            .style('font-size', '16px')
            .style('font-family', 'Inter, sans-serif')
            .text('No pathways selected');

        emptyGroup.append('text')
            .attr('text-anchor', 'middle')
            .attr('dy', '1.2em')
            .style('fill', '#475569')
            .style('font-size', '12px')
            .style('font-family', 'Inter, sans-serif')
            .text('Use the Pathway Navigator to select pathways');

        return;
    }

    // Clear any existing empty state
    cvG.selectAll('.cv-empty-state').remove();

    const data = buildCardHierarchy();
    const root = d3.hierarchy(data);

    // Helper: Count descendants for a node (for separation calculation)
    function countDescendants(node) {
        if (!node.children || node.children.length === 0) return 1;
        return node.children.reduce((sum, child) => sum + countDescendants(child), 0);
    }

    // D3 Tree Layout with dynamic separation based on subtree size
    const treeLayout = d3.tree()
        .nodeSize([CV_CONFIG.NODE_VERTICAL_SPACING, CV_CONFIG.LEVEL_SPACING])
        .separation((a, b) => {
            // Base separation for siblings vs cousins
            const baseSep = a.parent === b.parent ? 1.1 : 1.5;

            // Calculate subtree sizes - expanded nodes need more space
            const aDescendants = countDescendants(a);
            const bDescendants = countDescendants(b);
            const maxDescendants = Math.max(aDescendants, bDescendants);

            // Scale separation based on largest subtree
            // More descendants = more space needed
            if (maxDescendants > 1) {
                // Add extra space proportional to subtree size
                return baseSep + (maxDescendants - 1) * 0.3;
            }
            return baseSep;
        });

    treeLayout(root);

    // --- Nodes ---
    const nodes = root.descendants();
    const links = root.links();

    // Build lookup of ATXN3 nodes by scoped UID
    const mainNodesByUid = new Map();
    nodes.forEach(n => {
        if (n.data._uid) mainNodesByUid.set(n.data._uid, n);
    });

    // Add extra links from non-first upstream anchors to their CORRECT ATXN3
    nodes.forEach(n => {
        if (n.data._extraLinkToMain && n.data._extraLinkTargetUid) {
            const targetNode = mainNodesByUid.get(n.data._extraLinkTargetUid);
            if (targetNode) {
                links.push({ source: n, target: targetNode });
            }
        }
    });

    // Bind Data
    const nodeSel = cvG.selectAll('.cv-node')
        .data(nodes, d => d.data._uid || d.data.id);

    // EXIT
    nodeSel.exit().transition().duration(CV_CONFIG.ANIMATION_DURATION)
        .style('opacity', 0)
        .remove();

    // ENTER
    const nodeEnter = nodeSel.enter()
        .append('g')
        .attr('class', 'cv-node')
        .attr('transform', d => `translate(${d.y},${d.x})`) // Initial position?
        .style('opacity', 0)
        .on('click', handleCardClick);

    // Definitions for gradients (re-defined here to ensure availability if needed, or rely on main)
    // We'll rely on global defs, but add card specific drop shadow
    const defs = cvSvg.select('defs').empty() ? cvSvg.append('defs') : cvSvg.select('defs');

    // Card Rect
    nodeEnter.append('rect')
        .attr('width', CV_CONFIG.CARD_WIDTH)
        .attr('height', CV_CONFIG.CARD_HEIGHT)
        .attr('y', -CV_CONFIG.CARD_HEIGHT / 2)
        .attr('rx', 8)
        .style('fill', d => getCVColor(d.data))
        .style('stroke', d => getCVStroke(d.data))
        .style('stroke-width', '1px')
    //.style('filter', 'drop-shadow(0px 4px 6px rgba(0,0,0,0.3))'); // Performance hit?

    // 1. Main Label (Protein or Pathway Name) with tooltip for truncated text
    nodeEnter.append('text')
        .attr('class', 'cv-label')
        .attr('x', 15)
        .attr('dy', d => d.data.type === 'interactor' ? '-0.4em' : '0.2em')
        .style('fill', 'white')
        .style('font-size', '15px')
        .style('font-weight', '600')
        .style('font-family', 'Inter, sans-serif')
        .style('pointer-events', 'none')
        .text(d => truncateCVText(d.data.id === data.id ? d.data.id : (d.data.label || d.data.id), 26));

    // Add tooltip (title) for truncated labels
    nodeEnter.each(function(d) {
        const fullText = d.data.id === data.id ? d.data.id : (d.data.label || d.data.id);
        if (fullText.length > 26) {
            d3.select(this).append('title').text(fullText);
        }
    });

    // 2. Subtitle / Context (Relationship info)
    nodeEnter.each(function (d) {
        if (d.data.type === 'interactor' && d.data.contextText) {
            d3.select(this).append('text')
                .attr('class', 'cv-subtitle')
                .attr('x', 15)
                .attr('dy', '1.1em') // Below main label
                .style('fill', '#94a3b8') // Lighter slate
                .style('font-size', '11px')
                .style('font-family', 'Inter, sans-serif')
                .style('pointer-events', 'none')
                .text(truncateCVText(d.data.contextText, 40));

            // Arrow Icon?
            // Could add a small arrow visual here
        } else if (d.data.type === 'pathway') {
            // For pathways, show "Pathway - Level X"
            d3.select(this).append('text')
                .attr('class', 'cv-badge')
                .attr('x', 15)
                .attr('dy', '1.8em')
                .style('fill', 'rgba(255,255,255,0.5)')
                .style('font-size', '10px')
                .style('pointer-events', 'none')
                .text(`Pathway Level ${d.data.level}`);
        }
    });

    // 3. "Also in" indicator for multi-pathway proteins
    nodeEnter.each(function (d) {
        if (d.data.type === 'interactor') {
            const proteinId = d.data.label || d.data.id;
            // Use helper from visualizer.js if available
            const otherPathways = typeof getPathwaysForProtein === 'function'
                ? getPathwaysForProtein(proteinId).filter(p => p.id !== d.data.pathwayId)
                : [];

            if (otherPathways.length > 0) {
                const alsoInText = `Also in: ${otherPathways.slice(0, 2).map(p => p.name).join(', ')}`;
                const suffix = otherPathways.length > 2 ? ` +${otherPathways.length - 2}` : '';

                d3.select(this).append('text')
                    .attr('class', 'cv-also-in')
                    .attr('x', 15)
                    .attr('dy', '2.3em')
                    .style('fill', '#64748b')
                    .style('font-size', '10px')
                    .style('font-style', 'italic')
                    .style('font-family', 'Inter, sans-serif')
                    .style('pointer-events', 'none')
                    .text(truncateCVText(alsoInText + suffix, 38));
            }
        }
    });

    // 4. Interaction Organism Badges (top-right corner)
    nodeEnter.each(function (d) {
        if (d.data.type === 'pathway') {
            // Get interaction metadata from PathwayState or calculate from pathway data
            const pathwayId = d.data.id;
            let interactions = null;

            // Try to get from PathwayState first
            if (typeof PathwayState !== 'undefined') {
                const metadata = PathwayState.getInteractionMetadata();
                interactions = metadata.get(pathwayId);
            }

            // Fallback: Calculate from pathway data
            if (!interactions && d.data.raw && d.data.raw.interactor_ids) {
                interactions = { activates: 0, inhibits: 0, binds: 0, regulates: 0, total: 0 };
                // Simple heuristic: count total interactions
                interactions.total = d.data.raw.interactor_ids.length;
                interactions.binds = interactions.total; // Default all to binds
            }

            if (interactions && interactions.total > 0) {
                const badgeGroup = d3.select(this).append('g')
                    .attr('class', 'cv-card-badges')
                    .attr('transform', `translate(${CV_CONFIG.CARD_WIDTH - 15}, ${-CV_CONFIG.CARD_HEIGHT / 2 + 15})`);

                const badgeTypes = ['activates', 'inhibits', 'binds', 'regulates'];
                const colors = {
                    activates: { core: '#10b981', aura: 'rgba(16, 185, 129, 0.4)' },
                    inhibits: { core: '#ef4444', aura: 'rgba(239, 68, 68, 0.4)' },
                    binds: { core: '#a78bfa', aura: 'rgba(167, 139, 250, 0.4)' },
                    regulates: { core: '#f59e0b', aura: 'rgba(245, 158, 11, 0.4)' }
                };

                let badgeX = 0;
                badgeTypes.forEach(type => {
                    if (interactions[type] > 0) {
                        const badge = badgeGroup.append('g')
                            .attr('class', `cv-badge-organism ${type}`)
                            .attr('transform', `translate(${badgeX}, 0)`);

                        // Outer aura (breathing)
                        badge.append('circle')
                            .attr('class', 'badge-aura')
                            .attr('r', 10)
                            .style('fill', colors[type].aura)
                            .style('opacity', 0.4);

                        // Inner core (pulsing)
                        badge.append('circle')
                            .attr('class', 'badge-core')
                            .attr('r', 6)
                            .style('fill', colors[type].core);

                        // Count label
                        badge.append('text')
                            .attr('class', 'badge-count')
                            .attr('text-anchor', 'middle')
                            .attr('dy', '0.35em')
                            .style('fill', 'white')
                            .style('font-family', 'JetBrains Mono, monospace')
                            .style('font-size', '9px')
                            .style('font-weight', '700')
                            .style('pointer-events', 'none')
                            .text(interactions[type]);

                        badgeX -= 22; // Move left for next badge
                    }
                });
            }
        }
    });

    // Expand/Collapse Indicator
    nodeEnter.each(function (d) {
        if (d.data.type === 'pathway') {
            const hasChildren = d.data._childrenCount > 0;
            if (hasChildren) {
                d3.select(this).append('circle')
                    .attr('cx', CV_CONFIG.CARD_WIDTH - 25)
                    .attr('cy', 0)
                    .attr('r', 10)
                    .style('fill', 'rgba(255,255,255,0.1)')
                    .style('stroke', 'rgba(255,255,255,0.3)');

                d3.select(this).append('text')
                    .attr('class', 'cv-expander')
                    .attr('x', CV_CONFIG.CARD_WIDTH - 25)
                    .attr('dy', '0.35em')
                    .attr('text-anchor', 'middle')
                    .style('fill', 'white')
                    .style('font-size', '12px')
                    .style('cursor', 'pointer')
                    .text(cvState.expandedNodes.has(d.data.id) ? '−' : '+');
            }
        }
    });

    // UPDATE
    const nodeUpdate = nodeSel.merge(nodeEnter);

    nodeUpdate.transition().duration(CV_CONFIG.ANIMATION_DURATION)
        .attr('transform', d => `translate(${d.y},${d.x})`)
        .style('opacity', 1);

    nodeUpdate.select('rect')
        .style('fill', d => getCVColor(d.data))
        .style('stroke', d => getCVStroke(d.data));

    nodeUpdate.select('.cv-expander')
        .text(d => cvState.expandedNodes.has(d.data.id) ? '−' : '+');

    // --- Links ---
    const linkSel = cvG.selectAll('.cv-link')
        .data(links, d => (d.source.data._uid || d.source.data.id) + '->' + (d.target.data._uid || d.target.data.id));

    linkSel.exit().transition().duration(CV_CONFIG.ANIMATION_DURATION)
        .style('opacity', 0)
        .remove();

    const linkEnter = linkSel.enter()
        .insert('path', '.cv-node')
        .attr('class', 'cv-link')
        .style('fill', 'none')
        .style('stroke', '#475569') // Slate-600
        .style('stroke-width', '1.5px')
        .attr('d', d => {
            const o = { x: d.source.x, y: d.source.y };
            return d3.linkHorizontal()
                .x(d => d.y)
                .y(d => d.x)
                ({ source: o, target: o });
        });

    linkSel.merge(linkEnter).transition().duration(CV_CONFIG.ANIMATION_DURATION)
        .attr('d', d3.linkHorizontal()
            .x(d => d.y)
            .y(d => d.x)
        );

    // --- Resize SVG to fit content (for scrollable view) ---
    resizeCardViewToFit(nodes);
}

/**
 * Resize the SVG to fit all nodes, enabling native scroll
 */
function resizeCardViewToFit(nodes) {
    if (!nodes || nodes.length === 0) return;

    // Calculate bounding box of all nodes
    let minX = Infinity, maxX = -Infinity;
    let minY = Infinity, maxY = -Infinity;

    nodes.forEach(d => {
        // d.x is vertical position, d.y is horizontal position in tree layout
        minX = Math.min(minX, d.x - CV_CONFIG.CARD_HEIGHT / 2);
        maxX = Math.max(maxX, d.x + CV_CONFIG.CARD_HEIGHT / 2);
        minY = Math.min(minY, d.y);
        maxY = Math.max(maxY, d.y + CV_CONFIG.CARD_WIDTH);
    });

    // Add padding
    const padding = 60;
    const contentWidth = (maxY - minY) + padding * 2;
    const contentHeight = (maxX - minX) + padding * 2;

    // Set SVG size to fit content
    cvSvg
        .attr('width', contentWidth)
        .attr('height', contentHeight);

    // Translate the group to account for negative positions + padding
    cvG.attr('transform', `translate(${-minY + padding}, ${-minX + padding})`);
}

// ============================================================================
// INTERACTIONS
// ============================================================================

function handleCardClick(event, d) {
    if (d.data.type === 'interactor') {
        // ✅ IMPROVED: Pass pathway context to modal
        // Find the pathway node this interactor is under
        let pathwayContext = null;
        let current = d;
        while (current.parent && !pathwayContext) {
            if (current.parent.data.type === 'pathway') {
                pathwayContext = {
                    id: current.parent.data.id,
                    name: current.parent.data.label,
                    level: current.parent.data.level
                };
                break;
            }
            current = current.parent;
        }

        // Use the robust handler that fetches data directly from SNAP
        if (window.openModalForCard) {
            window.openModalForCard(d.data.id, pathwayContext);
        } else if (window.handleNodeClick) {
            // Fallback
            window.handleNodeClick({
                id: d.data.id,
                type: 'interactor',
                label: d.data.label,
                pathwayContext: pathwayContext
            });
        }
    } else {
        // Toggle Expansion via PathwayState (enables bidirectional sync)
        // ✅ FIX: Use expandAndSelectChildren to also select children in navigator
        expandAndSelectChildren(d.data.id, 'click');
    }
}

// ============================================================================
// SIDEBAR (Replicated Logic)
// ============================================================================

function renderCardSidebar() {
    const tree = document.getElementById('pathway-tree-card');
    if (!tree) return;

    tree.innerHTML = '';

    // ✅ REDESIGNED: Show ALL selected pathways (any level), grouped by hierarchy level
    const allPathways = window.getRawPathwayData ? window.getRawPathwayData() : [];
    const hierarchyMap = window.getPathwayHierarchy ? window.getPathwayHierarchy() : new Map();

    // Get all selected pathways (not just L0!)
    const selectedIds = new Set(cvState.selectedRoots);

    if (selectedIds.size === 0) {
        tree.innerHTML = '<div style="padding: 20px; text-align: center; color: #64748b; font-size: 13px;">No pathways selected.<br>Use the Explorer to select pathways.</div>';
        return;
    }

    // Group pathways by hierarchy level
    const byLevel = new Map();
    selectedIds.forEach(id => {
        const hier = hierarchyMap.get(id);
        const level = hier?.level || 0;
        if (!byLevel.has(level)) byLevel.set(level, []);
        byLevel.get(level).push(id);
    });

    // Sort levels (L0, L1, L2, ...)
    const sortedLevels = [...byLevel.keys()].sort((a, b) => a - b);

    // Render each level
    sortedLevels.forEach(level => {
        const ids = byLevel.get(level);

        // Level header
        const levelSection = document.createElement('div');
        levelSection.className = 'cv-sidebar-level';
        levelSection.innerHTML = `
            <div class="cv-sidebar-level-header">
                <span class="cv-sidebar-level-badge">L${level}</span>
                <span class="cv-sidebar-level-count">${ids.length} pathway${ids.length > 1 ? 's' : ''}</span>
            </div>
        `;

        // Items container
        const itemsContainer = document.createElement('div');
        itemsContainer.className = 'cv-sidebar-items';

        // Render each pathway in this level
        ids.forEach(id => {
            const pw = allPathways.find(p => (p.id || `pathway_${p.name.replace(/\s+/g, '_')}`) === id);
            if (!pw) return;

            const isHidden = cvState.hiddenCards.has(id);
            const isRecent = typeof PathwayState !== 'undefined' && PathwayState.getRecentlyChanged().has(id);

            // Get interaction metadata
            let interactions = null;
            if (typeof PathwayState !== 'undefined') {
                const metadata = PathwayState.getInteractionMetadata();
                interactions = metadata.get(id);
            }
            // Fallback
            if (!interactions && pw.interactor_ids) {
                interactions = { total: pw.interactor_ids.length, binds: pw.interactor_ids.length };
            }

            const item = document.createElement('div');
            item.className = `cv-sidebar-item ${isHidden ? 'hidden' : ''} ${isRecent ? 'recent-change' : ''}`;
            item.dataset.pathwayId = id;

            // Build interaction badges HTML
            let badgesHtml = '';
            if (interactions) {
                const types = ['activates', 'inhibits', 'binds', 'regulates'];
                types.forEach(type => {
                    if (interactions[type] > 0) {
                        badgesHtml += `
                            <div class="cv-interaction-organism ${type}" title="${interactions[type]} ${type}">
                                <div class="organism-core"></div>
                                <div class="organism-aura"></div>
                                <span class="organism-count">${interactions[type]}</span>
                            </div>
                        `;
                    }
                });
            }

            // Eye icon SVG
            const eyeIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`;
            const eyeOffIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19m-6.72-1.07a3 3 0 11-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`;

            item.innerHTML = `
                <div class="cv-sidebar-item-main">
                    <span class="cv-sidebar-item-name">${pw.name}</span>
                    <div class="cv-sidebar-item-actions">
                        ${badgesHtml}
                        <button class="cv-visibility-btn ${isHidden ? 'is-hidden' : ''}"
                                onclick="toggleCardPathwayVisibility('${id}')"
                                title="${isHidden ? 'Show' : 'Hide'} pathway">
                            ${isHidden ? eyeOffIcon : eyeIcon}
                        </button>
                    </div>
                </div>
            `;

            itemsContainer.appendChild(item);
        });

        levelSection.appendChild(itemsContainer);
        tree.appendChild(levelSection);
    });
}

// ✅ NEW: Toggle pathway visibility (hide/show)
window.toggleCardPathwayVisibility = (id) => {
    const isHidden = cvState.hiddenCards.has(id);

    if (isHidden) {
        cvState.hiddenCards.delete(id);
    } else {
        cvState.hiddenCards.add(id);
    }

    // Sync to PathwayState if available
    if (typeof PathwayState !== 'undefined') {
        PathwayState.toggleVisibility(id, 'sidebar');
    }

    renderCardSidebar(); // Update sidebar UI
    renderCardView();    // Update visualization
};

// Global handlers for Sidebar
window.toggleCardRoot = (id) => {
    if (cvState.selectedRoots.has(id)) {
        cvState.selectedRoots.delete(id);
    } else {
        cvState.selectedRoots.add(id);
    }
    renderCardSidebar(); // Update UI highlight
    renderCardView();    // Update Visualization
};

window.selectAllCardRoots = () => {
    // Only select L0 pathways for "Select All"
    cvState.rootPathways
        .filter(pw => (pw.hierarchy_level || 0) === 0)
        .forEach(pw => {
            const id = pw.id || `pathway_${pw.name.replace(/\s+/g, '_')}`;
            cvState.selectedRoots.add(id);
        });
    renderCardSidebar();
    renderCardView();
};

window.clearAllCardRoots = () => {
    cvState.selectedRoots.clear();
    renderCardSidebar();
    renderCardView();
};

window.filterCardSidebar = (query) => {
    // Hide/Show items based on name
    const items = document.querySelectorAll('#pathway-tree-card .pathway-item');
    const q = query.toLowerCase();
    items.forEach(item => {
        const name = item.querySelector('.pathway-name').innerText.toLowerCase();
        item.style.display = name.includes(q) ? 'block' : 'none';
    });
};

window.toggleCardSidebar = () => {
    const sidebar = document.getElementById('pathway-sidebar-card');
    const tab = document.getElementById('pathway-sidebar-tab-card');
    const cardView = document.getElementById('card-view');
    cvState.sidebarCollapsed = !cvState.sidebarCollapsed;

    if (cvState.sidebarCollapsed) {
        sidebar.style.display = 'none';
        tab.style.display = 'flex';
        cardView.classList.add('sidebar-collapsed');
    } else {
        sidebar.style.display = 'flex';
        tab.style.display = 'none';
        cardView.classList.remove('sidebar-collapsed');
    }
};

// ============================================================================
// UTILS
// ============================================================================

function getCVColor(data) {
    if (data.type === 'main') return 'url(#mainGradient)'; // Use graph gradients?
    if (data.type === 'pathway') return '#2e1065'; // Deep violet bg
    // Interactor bg dependent on arrow type
    if (data.type === 'interactor') {
        if (data.arrowType === 'activates') return '#064e3b'; // Dark green bg
        if (data.arrowType === 'inhibits') return '#7f1d1d'; // Dark red bg
        if (data.arrowType === 'binds') return '#3b0764'; // Dark purple bg
        if (data.arrowType === 'regulates') return '#713f12'; // Dark yellow/amber bg
    }
    return '#1e293b'; // Slate-800
}

function getCVStroke(data) {
    if (data.type === 'main') return '#818cf8';
    if (data.type === 'pathway') return '#7c3aed';
    if (data.type === 'interactor') {
        if (data.arrowType === 'activates') return '#059669'; // Green
        if (data.arrowType === 'inhibits') return '#dc2626'; // Red
        if (data.arrowType === 'binds') return '#a855f7'; // Purple
        if (data.arrowType === 'regulates') return '#eab308'; // Yellow
        return '#94a3b8'; // Slate (fallback)
    }
    return '#334155';
}


function truncateCVText(text, len) {
    // Return full text without truncation to display complete pathway names
    return text || '';
}


// ============================================================================
// PATHWAY EXPLORER V2 - Neural Command Interface
// ============================================================================

const PathwayExplorer = (function() {
    'use strict';

    // --- State ---
    const state = {
        selectedPathways: new Set(),      // ANY level pathway IDs
        hiddenCards: new Set(),           // Hidden from card view
        expandedBranches: new Set(),      // Explorer tree expansion
        interactionsByPathway: new Map(), // {activates, inhibits, binds, regulates}
        hasInteractions: new Map(),       // Propagated flags
        hasInteractorsInSubtree: new Map(), // Which pathways eventually lead to interactors
        searchQuery: '',
        hoveredPathway: null,
        breadcrumbPath: [],
        keyboardFocusIndex: -1,
        flattenedItems: [],
        isCollapsed: false,
        initialized: false
    };

    // --- DOM References ---
    let elements = {
        explorer: null,
        tree: null,
        breadcrumb: null,
        searchInput: null,
        collapsedTab: null,
        svgContainer: null
    };

    // =========================================================================
    // INITIALIZATION
    // =========================================================================

    function init() {
        if (state.initialized) return;

        cacheElements();

        // Wait for data to be available
        const rawPathways = window.getRawPathwayData ? window.getRawPathwayData() : [];
        if (rawPathways.length === 0) {
            console.log('⏳ PathwayExplorer: Waiting for pathway data...');
            setTimeout(init, 500);
            return;
        }

        computeInteractionMetadata();

        // ✅ FIX 2a: Do NOT auto-select anything on init
        // User explicitly selects pathways via navigator - start with empty selection
        cvState.selectedRoots.clear();
        state.selectedPathways.clear();

        // Sync hidden state (if any persisted)
        cvState.hiddenCards.forEach(id => state.hiddenCards.add(id));

        renderTree();
        updateStatsBar();

        // Observe PathwayState for cascade updates
        if (typeof PathwayState !== 'undefined') {
            PathwayState.observe('explorer', (eventType, data) => {
                if (eventType === 'selection') {
                    // Sync local state with PathwayState
                    state.selectedPathways.clear();
                    const selected = PathwayState.getSelectedPathways();
                    selected.forEach(id => state.selectedPathways.add(id));

                    // ✅ NEW: Auto-expand ancestors when selecting a pathway
                    if (data.selected && data.pathwayId) {
                        expandAncestors(data.pathwayId);
                    }

                    // Update UI for primary pathway
                    if (data.pathwayId) {
                        updateSelectionUI(data.pathwayId, data.selected);
                    }

                    // Update UI for cascaded pathways
                    if (data.cascadedIds && data.cascadedIds.length > 0) {
                        data.cascadedIds.forEach(id => {
                            const isSelected = state.selectedPathways.has(id);
                            updateSelectionUI(id, isSelected);
                            // Also expand ancestors for cascaded selections
                            if (isSelected) {
                                expandAncestors(id);
                            }
                        });
                    }

                    // BUG B FIX: Ensure all selected pathways have correct UI state
                    // This handles cases where selection comes from card view expansion
                    PathwayState.getSelectedPathways().forEach(id => {
                        updateSelectionUI(id, true);
                    });

                    updateStatsBar();

                    // ✅ FIX 2b: Sync to card view so it re-renders with new selections
                    // This is critical for bidirectional sync when expanding card nodes
                    syncToCardView();
                }

                // ✅ Handle expansion events for bidirectional sync
                if (eventType === 'expansion') {
                    // Sync local state from PathwayState
                    state.expandedBranches.clear();
                    PathwayState.getExpandedBranches().forEach(id => state.expandedBranches.add(id));

                    // Update DOM for all cascaded items (including ancestors)
                    const allIds = data.cascadedIds || [data.pathwayId];
                    allIds.forEach(id => {
                        const item = document.querySelector(`[data-pathway-id="${id}"]`);
                        if (item) {
                            const children = item.querySelector('.pe-children');
                            if (data.expanded) {
                                item.classList.add('expanded');
                                // BUG B FIX: Also update children container
                                if (children) {
                                    children.classList.remove('collapsed');
                                    children.classList.add('expanded');
                                }
                            } else {
                                item.classList.remove('expanded');
                                if (children) {
                                    children.classList.add('collapsed');
                                    children.classList.remove('expanded');
                                }
                            }
                        }
                    });

                    // BUG B FIX: Sync all selection states after expansion
                    // This ensures checkboxes are updated for auto-selected children
                    PathwayState.getSelectedPathways().forEach(id => {
                        updateSelectionUI(id, true);
                    });

                    // Scroll the primary pathway into view
                    if (data.expanded && data.pathwayId) {
                        const targetItem = document.querySelector(`[data-pathway-id="${data.pathwayId}"]`);
                        if (targetItem) {
                            targetItem.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                        }
                    }
                }
            });
        }

        // Setup dragging
        setupDragging();

        state.initialized = true;
        console.log('✅ PathwayExplorer v2 initialized (Neural Command Interface)');
    }

    function setupDragging() {
        const explorer = elements.explorer;
        const header = explorer?.querySelector('.pe-header');
        if (!explorer || !header) return;

        let isDragging = false;
        let startX, startY, startLeft, startTop;

        header.addEventListener('mousedown', (e) => {
            // Don't drag if clicking on buttons or interactive elements
            if (e.target.closest('button') || e.target.closest('input') || e.target.closest('.pe-collapse-btn')) {
                return;
            }

            isDragging = true;
            startX = e.clientX;
            startY = e.clientY;

            const rect = explorer.getBoundingClientRect();
            startLeft = rect.left;
            startTop = rect.top;

            explorer.style.transition = 'none';
            document.body.style.cursor = 'grabbing';
            document.body.style.userSelect = 'none';

            e.preventDefault();
        });

        document.addEventListener('mousemove', (e) => {
            if (!isDragging) return;

            const deltaX = e.clientX - startX;
            const deltaY = e.clientY - startY;

            let newLeft = startLeft + deltaX;
            let newTop = startTop + deltaY;

            // Constrain to viewport
            const maxLeft = window.innerWidth - 100;
            const maxTop = window.innerHeight - 100;
            newLeft = Math.max(0, Math.min(newLeft, maxLeft));
            newTop = Math.max(0, Math.min(newTop, maxTop));

            explorer.style.left = newLeft + 'px';
            explorer.style.top = newTop + 'px';
        });

        document.addEventListener('mouseup', () => {
            if (isDragging) {
                isDragging = false;
                explorer.style.transition = '';
                document.body.style.cursor = '';
                document.body.style.userSelect = '';
            }
        });

        // Double-click to reset position
        header.addEventListener('dblclick', (e) => {
            if (e.target.closest('button') || e.target.closest('input')) return;
            explorer.style.left = '0';
            explorer.style.top = '60px';
        });
    }

    function cacheElements() {
        elements.explorer = document.getElementById('pathway-explorer-v2');
        elements.tree = document.getElementById('pe-tree');
        elements.breadcrumb = document.getElementById('pe-breadcrumb');
        elements.searchInput = document.getElementById('pe-search-input');
        elements.collapsedTab = document.getElementById('pe-collapsed-tab');
        elements.svgContainer = document.getElementById('card-svg-container');
    }

    // =========================================================================
    // INTERACTION METADATA
    // =========================================================================

    function computeInteractionMetadata() {
        const allPathways = window.getRawPathwayData?.() || [];
        const interactions = (typeof SNAP !== 'undefined' ? SNAP?.interactions : null) || [];

        state.interactionsByPathway.clear();
        state.hasInteractions.clear();

        allPathways.forEach(pw => {
            const pathwayId = pw.id || `pathway_${pw.name.replace(/\s+/g, '_')}`;
            const counts = { activates: 0, inhibits: 0, binds: 0, regulates: 0, total: 0 };

            // Count by interaction type from interactor_ids
            (pw.interactor_ids || []).forEach(intId => {
                const interaction = interactions.find(i =>
                    i.source === intId || i.target === intId ||
                    i.source === SNAP?.main && i.target === intId ||
                    i.target === SNAP?.main && i.source === intId
                );
                if (interaction) {
                    const arrow = interaction.arrow || 'binds';
                    if (counts[arrow] !== undefined) {
                        counts[arrow]++;
                    }
                    counts.total++;
                }
            });

            state.interactionsByPathway.set(pathwayId, counts);
            state.hasInteractions.set(pathwayId, counts.total > 0);
        });

        propagateInteractionFlags();
        computeInteractorDescendantFlags();  // Compute which pathways lead to interactors

        // ✅ FIX 2b: Expose hasInteractorsInSubtree for use by expandAndSelectChildren()
        window.getHasInteractorsInSubtree = () => state.hasInteractorsInSubtree;
    }

    function propagateInteractionFlags() {
        const hierarchyMap = window.getPathwayHierarchy?.() || new Map();
        const allPathways = window.getRawPathwayData?.() || [];

        // ✅ IMPROVED: Bubble interactions up through ALL ancestors
        // Process from leaves up (higher levels first)
        const sorted = [...allPathways].sort((a, b) =>
            (b.hierarchy_level || 0) - (a.hierarchy_level || 0)
        );

        sorted.forEach(pw => {
            const pathwayId = pw.id || `pathway_${pw.name.replace(/\s+/g, '_')}`;

            // If this pathway has interactions, propagate to ALL ancestors
            if (state.hasInteractions.get(pathwayId)) {
                const hier = hierarchyMap.get(pathwayId);
                const parentIds = hier?.parent_ids || [];

                // Recursively mark all ancestors as having interactions
                const visited = new Set();
                function markAncestors(currentId) {
                    if (visited.has(currentId)) return;
                    visited.add(currentId);

                    const h = hierarchyMap.get(currentId);
                    const parents = h?.parent_ids || [];

                    parents.forEach(parentId => {
                        state.hasInteractions.set(parentId, true);
                        markAncestors(parentId); // Recurse to grandparents
                    });
                }

                parentIds.forEach(parentId => {
                    state.hasInteractions.set(parentId, true);
                    markAncestors(parentId);
                });
            }
        });
    }

    /**
     * Compute hasInteractorsInSubtree for each pathway
     * A pathway has interactors in subtree if it or ANY of its descendants have interactors
     */
    function computeInteractorDescendantFlags() {
        const childrenMap = window.getPathwayChildrenMap?.() || new Map();
        const allPathways = window.getRawPathwayData?.() || [];
        const pathwayToInteractors = window.pathwayToInteractors || new Map();

        state.hasInteractorsInSubtree.clear();

        // Debug: Log childrenMap stats
        console.log(`🔍 computeInteractorDescendantFlags: childrenMap has ${childrenMap.size} entries`);
        console.log(`🔍 pathwayToInteractors has ${pathwayToInteractors.size} entries`);
        console.log(`🔍 state.hasInteractions has ${state.hasInteractions.size} entries, ${[...state.hasInteractions.values()].filter(v => v).length} with content`);

        // Recursive function with memoization
        function hasInteractorsRecursive(pathwayId, visited = new Set()) {
            // Cycle detection
            if (visited.has(pathwayId)) return false;
            visited.add(pathwayId);

            // Check memo
            if (state.hasInteractorsInSubtree.has(pathwayId)) {
                return state.hasInteractorsInSubtree.get(pathwayId);
            }

            // Check 1: Direct interactors via hasInteractions (set by computeInteractionMetadata)
            if (state.hasInteractions.get(pathwayId)) {
                state.hasInteractorsInSubtree.set(pathwayId, true);
                return true;
            }

            // Check 2: Direct interactors via pathwayToInteractors map
            const directInteractors = pathwayToInteractors.get(pathwayId);
            if (directInteractors && directInteractors.size > 0) {
                state.hasInteractorsInSubtree.set(pathwayId, true);
                state.hasInteractions.set(pathwayId, true); // Also update hasInteractions
                return true;
            }

            // Check 3: Check children recursively
            // Try both childrenMap (from pathwayToChildren) and hierarchy child_ids
            let childIds = childrenMap.get(pathwayId);

            // Convert Set to Array if needed
            if (childIds instanceof Set) {
                childIds = [...childIds];
            } else if (!childIds) {
                // Fallback: check hierarchy for child_ids
                const hierarchy = window.getPathwayHierarchy?.();
                const hier = hierarchy?.get(pathwayId);
                childIds = hier?.child_ids || [];
            }

            for (const childId of childIds) {
                if (hasInteractorsRecursive(childId, new Set(visited))) {
                    state.hasInteractorsInSubtree.set(pathwayId, true);
                    return true;
                }
            }

            state.hasInteractorsInSubtree.set(pathwayId, false);
            return false;
        }

        // Compute for all pathways
        allPathways.forEach(pw => {
            const pathwayId = pw.id || `pathway_${pw.name.replace(/\s+/g, '_')}`;
            hasInteractorsRecursive(pathwayId);
        });

        // Debug: Log results
        const withContent = [...state.hasInteractorsInSubtree.entries()].filter(([k, v]) => v);
        console.log(`✅ computeInteractorDescendantFlags: ${withContent.length}/${state.hasInteractorsInSubtree.size} pathways have content in subtree`);

        // Log a few examples
        if (withContent.length > 0) {
            console.log(`   Examples with content: ${withContent.slice(0, 5).map(([k]) => k).join(', ')}`);
        }
    }

    function updateStatsBar() {
        let totals = { activates: 0, inhibits: 0, binds: 0, regulates: 0 };

        state.selectedPathways.forEach(pathwayId => {
            const counts = state.interactionsByPathway.get(pathwayId);
            if (counts) {
                totals.activates += counts.activates;
                totals.inhibits += counts.inhibits;
                totals.binds += counts.binds;
                totals.regulates += counts.regulates;
            }
        });

        const activatesEl = document.getElementById('pe-stat-activates');
        const inhibitsEl = document.getElementById('pe-stat-inhibits');
        const bindsEl = document.getElementById('pe-stat-binds');
        const regulatesEl = document.getElementById('pe-stat-regulates');

        if (activatesEl) activatesEl.textContent = totals.activates;
        if (inhibitsEl) inhibitsEl.textContent = totals.inhibits;
        if (bindsEl) bindsEl.textContent = totals.binds;
        if (regulatesEl) regulatesEl.textContent = totals.regulates;
    }

    // =========================================================================
    // TREE RENDERING
    // =========================================================================

    function renderTree() {
        if (!elements.tree) {
            cacheElements();
            if (!elements.tree) return;
        }

        const allPathways = window.getRawPathwayData?.() || [];
        const childrenMap = window.getPathwayChildrenMap?.() || new Map();

        // Get root pathways (level 0)
        // ✅ FIX 2d: Sort by hasInteractorsInSubtree first, then by interaction count
        const rootPathways = allPathways
            .filter(pw => (pw.hierarchy_level || 0) === 0)
            .sort((a, b) => {
                const aId = a.id || `pathway_${a.name.replace(/\s+/g, '_')}`;
                const bId = b.id || `pathway_${b.name.replace(/\s+/g, '_')}`;
                // 1. Has interactors in subtree first (strict check - undefined = no content)
                const aHasContent = state.hasInteractorsInSubtree.get(aId) === true;
                const bHasContent = state.hasInteractorsInSubtree.get(bId) === true;
                if (aHasContent !== bHasContent) return bHasContent ? 1 : -1;
                // 2. Then by interaction count
                return (b.interaction_count || 0) - (a.interaction_count || 0);
            });

        elements.tree.innerHTML = '';
        state.flattenedItems = [];

        if (rootPathways.length === 0) {
            elements.tree.innerHTML = `
                <div class="pe-empty-state">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                        <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2z"/>
                        <path d="M12 8v4M12 16h.01"/>
                    </svg>
                    <div class="pe-empty-state-text">No pathways available</div>
                </div>
            `;
            return;
        }

        rootPathways.forEach(pw => {
            const pathwayId = pw.id || `pathway_${pw.name.replace(/\s+/g, '_')}`;
            const visited = new Set(); // Track visited pathways to prevent cycles
            const itemEl = buildTreeItem(pw, pathwayId, 0, childrenMap, allPathways, visited);
            elements.tree.appendChild(itemEl);
        });

        console.log(`🌳 Explorer tree: ${rootPathways.length} roots, ${state.flattenedItems.length} total items`);
    }

    function buildTreeItem(pw, pathwayId, level, childrenMap, allPathways, visited = new Set()) {
        // ✅ CYCLE DETECTION: Prevent infinite recursion from circular references
        if (visited.has(pathwayId)) {
            console.warn(`⚠️ Cycle detected in hierarchy data: ${pathwayId}`);
            console.warn(`   → This indicates a data integrity issue in PathwayParent table`);
            console.warn(`   → Run: python scripts/pathway_v2/fix_cycle.py --auto`);
            return document.createElement('div'); // Return empty element
        }
        
        // Add to visited set for this branch
        visited.add(pathwayId);
        
        const hierarchy = window.getPathwayHierarchy?.() || new Map();
        const hier = hierarchy.get(pathwayId);
        const childIds = hier?.child_ids || [];
        const hasChildren = childIds.length > 0;
        const counts = state.interactionsByPathway.get(pathwayId) || {};
        const hasInteractions = state.hasInteractions.get(pathwayId);
        const hasInteractorsInSubtree = state.hasInteractorsInSubtree.get(pathwayId);
        const isSelected = state.selectedPathways.has(pathwayId);
        const isHidden = state.hiddenCards.has(pathwayId);
        const isExpanded = state.expandedBranches.has(pathwayId);
        const isGreyed = hasInteractorsInSubtree === false;  // Pathway leads nowhere with interactors

        // Create item element
        const item = document.createElement('div');
        item.className = `pe-item${isExpanded ? ' expanded' : ''}${hasChildren ? ' has-children' : ''}${isGreyed ? ' no-interactors' : ''}`;
        item.dataset.pathwayId = pathwayId;
        item.dataset.level = level;

        // Track for keyboard navigation
        state.flattenedItems.push({ pathwayId, level, element: item });

        // Create content
        const content = document.createElement('div');
        content.className = `pe-item-content${isSelected ? ' selected' : ''}${isHidden ? ' hidden-card' : ''}`;

        // Build indicators HTML
        let indicatorsHtml = '<div class="pe-indicators">';
        if (hasInteractions) {
            if (counts.activates > 0) {
                indicatorsHtml += `<span class="pe-indicator activates${counts.activates > 2 ? ' active' : ''}" title="${counts.activates} activating"></span>`;
            }
            if (counts.inhibits > 0) {
                indicatorsHtml += `<span class="pe-indicator inhibits${counts.inhibits > 2 ? ' active' : ''}" title="${counts.inhibits} inhibiting"></span>`;
            }
            if (counts.binds > 0) {
                indicatorsHtml += `<span class="pe-indicator binds${counts.binds > 2 ? ' active' : ''}" title="${counts.binds} binding"></span>`;
            }
            if (counts.regulates > 0) {
                indicatorsHtml += `<span class="pe-indicator regulates${counts.regulates > 2 ? ' active' : ''}" title="${counts.regulates} regulating"></span>`;
            }
        }
        indicatorsHtml += '</div>';

        // BUG C FIX: Build content indicator with better visual distinction
        let indicatorClass = 'pe-content-indicator';
        let indicatorTitle = 'No interactions';
        let indicatorRadius = 3;

        if (hasInteractions) {
            indicatorClass += ' has-content has-direct';
            indicatorTitle = `${counts.total || 0} direct interactions`;
            indicatorRadius = 5;
        } else if (hasInteractorsInSubtree === true) {
            indicatorClass += ' has-subtree-content';
            indicatorTitle = 'Contains sub-pathways with interactions';
            indicatorRadius = 4;
        }

        content.innerHTML = `
            <button class="pe-expander${hasChildren ? '' : ' no-children'}">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M9 5l7 7-7 7"/>
                </svg>
            </button>

            <span class="${indicatorClass}" title="${indicatorTitle}">
                <svg viewBox="0 0 16 16" fill="currentColor">
                    <circle cx="8" cy="8" r="${indicatorRadius}"/>
                </svg>
            </span>

            <div class="pe-checkbox-wrapper">
                <input type="checkbox"
                       class="pe-checkbox"
                       id="pe-cb-${pathwayId}"
                       ${isSelected ? 'checked' : ''}>
                <div class="pe-checkbox-visual">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
                        <path d="M5 12l4 4 10-10"/>
                    </svg>
                </div>
            </div>

            <div class="pe-label-group">
                <span class="pe-label" title="${pw.name}">${highlightSearchTerm(pw.name)}</span>
                <span class="pe-level-badge">L${level}</span>
            </div>

            ${indicatorsHtml}

            <button class="pe-visibility-btn${isHidden ? ' is-hidden' : ''}" title="${isHidden ? 'Show in Card View' : 'Hide from Card View'}">
                <svg class="pe-eye-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                    ${isHidden ?
                        '<path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19m-6.72-1.07a3 3 0 11-4.24-4.24M1 1l22 22"/>' :
                        '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>'
                    }
                </svg>
            </button>
        `;

        // Add event listeners
        const expander = content.querySelector('.pe-expander');
        expander.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleBranch(pathwayId);
        });

        const checkbox = content.querySelector('.pe-checkbox');
        checkbox.addEventListener('change', (e) => {
            e.stopPropagation();
            toggleSelection(pathwayId, e.target.checked);
        });

        const labelGroup = content.querySelector('.pe-label-group');
        labelGroup.addEventListener('click', () => {
            toggleSelection(pathwayId, !state.selectedPathways.has(pathwayId));
            const cb = content.querySelector('.pe-checkbox');
            if (cb) cb.checked = state.selectedPathways.has(pathwayId);
        });

        const visibilityBtn = content.querySelector('.pe-visibility-btn');
        visibilityBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleVisibility(pathwayId);
        });

        // Hover events for breadcrumb
        content.addEventListener('mouseenter', () => {
            state.hoveredPathway = pathwayId;
            state.breadcrumbPath = hier?.ancestry || [pw.name];
            updateBreadcrumb();
        });

        content.addEventListener('mouseleave', () => {
            state.hoveredPathway = null;
            state.breadcrumbPath = [];
            updateBreadcrumb();
        });

        item.appendChild(content);

        // Children container (NO depth limit!)
        if (hasChildren) {
            const childrenContainer = document.createElement('div');
            childrenContainer.className = `pe-children${isExpanded ? ' expanded' : ' collapsed'}`;

            // NEW FEATURE: Separate children into content-containing and empty groups
            const allChildren = childIds
                .map(childId => ({
                    id: childId,
                    pw: allPathways.find(p =>
                        (p.id || `pathway_${p.name.replace(/\s+/g, '_')}`) === childId
                    ),
                    hasContent: state.hasInteractorsInSubtree.get(childId) === true
                }))
                .filter(c => c.pw);

            // Content-containing children: sorted by interaction count
            const contentChildren = allChildren
                .filter(c => c.hasContent)
                .sort((a, b) => (b.pw.interaction_count || 0) - (a.pw.interaction_count || 0));

            // Empty children: sorted alphabetically
            const emptyChildren = allChildren
                .filter(c => !c.hasContent)
                .sort((a, b) => a.pw.name.localeCompare(b.pw.name));

            // Render content-containing children normally
            contentChildren.forEach(({ id: childId, pw: childPw }) => {
                const childVisited = new Set(visited);
                const childItem = buildTreeItem(childPw, childId, level + 1, childrenMap, allPathways, childVisited);
                childrenContainer.appendChild(childItem);
            });

            // Render empty children in collapsible group (if any)
            if (emptyChildren.length > 0) {
                const emptyGroup = document.createElement('div');
                emptyGroup.className = 'pe-empty-group collapsed';
                emptyGroup.dataset.level = level + 1;

                emptyGroup.innerHTML = `
                    <div class="pe-empty-group-header">
                        <svg class="pe-empty-group-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M9 5l7 7-7 7"/>
                        </svg>
                        <span class="pe-empty-group-label">L${level + 1} Empty Pathways</span>
                        <span class="pe-empty-group-count">${emptyChildren.length}</span>
                    </div>
                    <div class="pe-empty-group-children"></div>
                `;

                // Toggle handler for empty group
                const header = emptyGroup.querySelector('.pe-empty-group-header');
                header.addEventListener('click', (e) => {
                    e.stopPropagation();
                    emptyGroup.classList.toggle('collapsed');
                    emptyGroup.classList.toggle('expanded');
                });

                // Add empty children to the group
                const emptyContainer = emptyGroup.querySelector('.pe-empty-group-children');
                emptyChildren.forEach(({ id: childId, pw: childPw }) => {
                    const childVisited = new Set(visited);
                    const childItem = buildTreeItem(childPw, childId, level + 1, childrenMap, allPathways, childVisited);
                    emptyContainer.appendChild(childItem);
                });

                childrenContainer.appendChild(emptyGroup);
            }

            item.appendChild(childrenContainer);
        }

        return item;
    }

    function highlightSearchTerm(text) {
        if (!state.searchQuery) return text;
        const regex = new RegExp(`(${escapeRegex(state.searchQuery)})`, 'gi');
        return text.replace(regex, '<span class="search-match">$1</span>');
    }

    function escapeRegex(str) {
        return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    // =========================================================================
    // INTERACTION HANDLERS
    // =========================================================================

    function toggleBranch(pathwayId) {
        // Use PathwayState for bidirectional sync with card view
        PathwayState.toggleExpansion(pathwayId, 'explorer', 'toggle');

        // Also update local DOM immediately for responsiveness
        // (PathwayState observer will handle this too, but this is faster)
        const isExpanded = state.expandedBranches.has(pathwayId);
        const item = document.querySelector(`.pe-item[data-pathway-id="${pathwayId}"]`);
        if (item) {
            const children = item.querySelector('.pe-children');
            if (children) {
                if (isExpanded) {
                    item.classList.remove('expanded');
                    children.classList.remove('expanded');
                    children.classList.add('collapsed');
                } else {
                    item.classList.add('expanded');
                    children.classList.remove('collapsed');
                    children.classList.add('expanded');
                }
            }
        }
    }

    function updateSelectionUI(pathwayId, isSelected) {
        const item = document.querySelector(`.pe-item[data-pathway-id="${pathwayId}"]`);
        if (!item) return;

        const content = item.querySelector('.pe-item-content');
        const checkbox = item.querySelector('.pe-checkbox');

        if (content) content.classList.toggle('selected', isSelected);
        if (checkbox) checkbox.checked = isSelected;
    }

    function toggleSelection(pathwayId, checked) {
        // Delegate to PathwayState (which handles cascading)
        if (typeof PathwayState !== 'undefined') {
            const isCurrentlySelected = PathwayState.isSelected(pathwayId);
            if (checked !== isCurrentlySelected) {
                PathwayState.toggleSelection(pathwayId, 'explorer');
            }
        } else {
            // Fallback for when PathwayState not available
            if (checked) {
                state.selectedPathways.add(pathwayId);
            } else {
                state.selectedPathways.delete(pathwayId);
            }
            updateSelectionUI(pathwayId, checked);
        }

        updateStatsBar();
        syncToCardView();
    }

    function toggleVisibility(pathwayId) {
        const isHidden = state.hiddenCards.has(pathwayId);

        if (isHidden) {
            state.hiddenCards.delete(pathwayId);
        } else {
            state.hiddenCards.add(pathwayId);
        }

        // ✅ CRITICAL FIX: Sync with PathwayState
        if (typeof PathwayState !== 'undefined') {
            const isInPathwayState = PathwayState.isHidden(pathwayId);
            // Only toggle if states differ
            if (!isHidden && !isInPathwayState) {
                PathwayState.toggleVisibility(pathwayId, 'explorer');
            } else if (isHidden && isInPathwayState) {
                PathwayState.toggleVisibility(pathwayId, 'explorer');
            }
        }

        // Update visual
        const item = document.querySelector(`.pe-item[data-pathway-id="${pathwayId}"]`);
        if (item) {
            const content = item.querySelector('.pe-item-content');
            const btn = item.querySelector('.pe-visibility-btn');

            if (content) content.classList.toggle('hidden-card', !isHidden);
            if (btn) {
                btn.classList.toggle('is-hidden', !isHidden);
                const svg = btn.querySelector('svg');
                if (svg) {
                    svg.innerHTML = isHidden ?
                        '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>' :
                        '<path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19m-6.72-1.07a3 3 0 11-4.24-4.24M1 1l22 22"/>';
                }
            }
        }

        syncToCardView();
    }

    // =========================================================================
    // BREADCRUMB
    // =========================================================================

    function updateBreadcrumb() {
        if (!elements.breadcrumb) return;

        if (state.breadcrumbPath.length === 0) {
            elements.breadcrumb.innerHTML = '<span class="pe-breadcrumb-root">Navigate pathways below</span>';
            return;
        }

        let html = '';
        state.breadcrumbPath.forEach((name, idx) => {
            const isLast = idx === state.breadcrumbPath.length - 1;
            html += `<span class="pe-breadcrumb-item${isLast ? ' active' : ''}">${name}</span>`;
            if (!isLast) {
                html += '<span class="pe-breadcrumb-divider">›</span>';
            }
        });

        elements.breadcrumb.innerHTML = html;
    }

    // =========================================================================
    // SEARCH
    // =========================================================================

    function handleSearch(query) {
        state.searchQuery = query.trim().toLowerCase();

        const items = document.querySelectorAll('.pe-item');
        const allPathways = window.getRawPathwayData?.() || [];
        const hierarchyMap = window.getPathwayHierarchy?.() || new Map();
        let matchCount = 0;

        // First pass: Find all matching items and their ancestors
        const matchingIds = new Set();
        const ancestorsToShow = new Set();

        items.forEach(item => {
            const pathwayId = item.dataset.pathwayId;
            const pw = allPathways.find(p =>
                (p.id || `pathway_${p.name.replace(/\s+/g, '_')}`) === pathwayId
            );

            const name = pw?.name?.toLowerCase() || '';
            const matches = state.searchQuery === '' || name.includes(state.searchQuery);

            if (matches && state.searchQuery) {
                matchingIds.add(pathwayId);
                matchCount++;

                // Collect all ancestors of this match
                const collectAncestors = (id, visited = new Set()) => {
                    if (visited.has(id)) return;
                    visited.add(id);
                    const hier = hierarchyMap.get(id);
                    if (hier?.parent_ids) {
                        hier.parent_ids.forEach(parentId => {
                            ancestorsToShow.add(parentId);
                            collectAncestors(parentId, visited);
                        });
                    }
                };
                collectAncestors(pathwayId);
            }
        });

        // Second pass: Show/hide items and update highlights
        items.forEach(item => {
            const pathwayId = item.dataset.pathwayId;
            const pw = allPathways.find(p =>
                (p.id || `pathway_${p.name.replace(/\s+/g, '_')}`) === pathwayId
            );

            const isMatch = matchingIds.has(pathwayId);
            const isAncestor = ancestorsToShow.has(pathwayId);
            const shouldShow = state.searchQuery === '' || isMatch || isAncestor;

            item.style.display = shouldShow ? '' : 'none';

            // Expand ancestors to show matches
            if (isAncestor && state.searchQuery) {
                item.classList.add('expanded');
                const children = item.querySelector('.pe-children');
                if (children) {
                    children.classList.remove('collapsed');
                    children.classList.add('expanded');
                }
                state.expandedBranches.add(pathwayId);
            }

            // Highlight matching text
            const label = item.querySelector('.pe-label');
            if (label && pw) {
                label.innerHTML = highlightSearchTerm(pw.name);
            }

            // Add visual distinction for direct matches vs ancestors
            const content = item.querySelector('.pe-item-content');
            if (content) {
                content.classList.toggle('search-match', isMatch && state.searchQuery !== '');
                content.classList.toggle('search-ancestor', isAncestor && !isMatch && state.searchQuery !== '');
            }
        });

        // Update results count
        const resultsEl = document.getElementById('pe-search-results');
        if (resultsEl) {
            resultsEl.textContent = state.searchQuery ?
                `${matchCount} match${matchCount !== 1 ? 'es' : ''}` : '';
        }
    }

    function expandParentBranches(pathwayId, visited = new Set()) {
        // ✅ CYCLE DETECTION: Prevent infinite recursion from circular references
        if (visited.has(pathwayId)) {
            console.warn(`⚠️ Cycle during search expansion: ${pathwayId}`);
            console.warn(`   → Run: python scripts/pathway_v2/verify_pipeline.py --auto-fix`);
            return;
        }
        visited.add(pathwayId);

        const hierarchy = window.getPathwayHierarchy?.() || new Map();
        const hier = hierarchy.get(pathwayId);

        if (hier?.parent_ids) {
            hier.parent_ids.forEach(parentId => {
                if (!state.expandedBranches.has(parentId)) {
                    state.expandedBranches.add(parentId);

                    const parentItem = document.querySelector(`.pe-item[data-pathway-id="${parentId}"]`);
                    if (parentItem) {
                        parentItem.classList.add('expanded');
                        const children = parentItem.querySelector('.pe-children');
                        if (children) {
                            children.classList.remove('collapsed');
                            children.classList.add('expanded');
                        }
                    }
                }
                expandParentBranches(parentId, visited); // Pass visited set
            });
        }
    }

    function expandAncestors(pathwayId) {
        const hierarchy = window.getPathwayHierarchy?.() || new Map();
        const visited = new Set();

        function expandRecursive(id) {
            if (visited.has(id)) return;
            visited.add(id);

            const hier = hierarchy.get(id);
            const parentIds = hier?.parent_ids || [];

            parentIds.forEach(parentId => {
                // Expand in explorer tree
                if (!state.expandedBranches.has(parentId)) {
                    state.expandedBranches.add(parentId);
                }

                // Expand in card view
                if (typeof cvState !== 'undefined' && !cvState.expandedNodes.has(parentId)) {
                    cvState.expandedNodes.add(parentId);
                }

                // Recurse to grandparents
                expandRecursive(parentId);
            });
        }

        expandRecursive(pathwayId);

        // Re-render both views
        renderTree();
        if (typeof renderCardView === 'function') {
            renderCardView();
        }
    }

    function clearSearch() {
        if (elements.searchInput) {
            elements.searchInput.value = '';
        }
        handleSearch('');
    }

    // =========================================================================
    // KEYBOARD NAVIGATION
    // =========================================================================

    function handleKeyNav(event) {
        const { key } = event;

        switch (key) {
            case 'ArrowDown':
                event.preventDefault();
                navigateItems(1);
                break;
            case 'ArrowUp':
                event.preventDefault();
                navigateItems(-1);
                break;
            case 'ArrowRight':
                event.preventDefault();
                expandFocusedItem();
                break;
            case 'ArrowLeft':
                event.preventDefault();
                collapseFocusedItem();
                break;
            case 'Enter':
            case ' ':
                event.preventDefault();
                toggleFocusedItem();
                break;
            case 'Escape':
                clearSearch();
                break;
        }
    }

    function navigateItems(direction) {
        const visibleItems = state.flattenedItems.filter(item =>
            item.element.style.display !== 'none'
        );

        if (visibleItems.length === 0) return;

        document.querySelector('.pe-item.keyboard-focus')?.classList.remove('keyboard-focus');

        state.keyboardFocusIndex += direction;

        if (state.keyboardFocusIndex < 0) state.keyboardFocusIndex = visibleItems.length - 1;
        if (state.keyboardFocusIndex >= visibleItems.length) state.keyboardFocusIndex = 0;

        const focused = visibleItems[state.keyboardFocusIndex];
        if (focused) {
            focused.element.classList.add('keyboard-focus');
            focused.element.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
    }

    function expandFocusedItem() {
        const focused = document.querySelector('.pe-item.keyboard-focus');
        if (focused) {
            const pathwayId = focused.dataset.pathwayId;
            if (!state.expandedBranches.has(pathwayId)) {
                toggleBranch(pathwayId);
            }
        }
    }

    function collapseFocusedItem() {
        const focused = document.querySelector('.pe-item.keyboard-focus');
        if (focused) {
            const pathwayId = focused.dataset.pathwayId;
            if (state.expandedBranches.has(pathwayId)) {
                toggleBranch(pathwayId);
            }
        }
    }

    function toggleFocusedItem() {
        const focused = document.querySelector('.pe-item.keyboard-focus');
        if (focused) {
            const pathwayId = focused.dataset.pathwayId;
            const checkbox = focused.querySelector('.pe-checkbox');
            if (checkbox) {
                checkbox.checked = !checkbox.checked;
                toggleSelection(pathwayId, checkbox.checked);
            }
        }
    }

    // =========================================================================
    // BULK ACTIONS
    // =========================================================================

    function selectAllVisible() {
        const items = document.querySelectorAll('.pe-item:not([style*="display: none"])');
        const pathwayIds = [];
        items.forEach(item => {
            const pathwayId = item.dataset.pathwayId;
            state.selectedPathways.add(pathwayId);
            pathwayIds.push(pathwayId);

            const checkbox = item.querySelector('.pe-checkbox');
            if (checkbox) checkbox.checked = true;

            const content = item.querySelector('.pe-item-content');
            if (content) content.classList.add('selected');
        });

        // ✅ Sync with PathwayState
        if (typeof PathwayState !== 'undefined') {
            PathwayState.selectAll(pathwayIds);
        }

        updateStatsBar();
        syncToCardView();
    }

    function clearAllSelections() {
        state.selectedPathways.clear();

        document.querySelectorAll('.pe-checkbox').forEach(cb => cb.checked = false);
        document.querySelectorAll('.pe-item-content.selected').forEach(el => el.classList.remove('selected'));

        // ✅ Sync with PathwayState
        if (typeof PathwayState !== 'undefined') {
            PathwayState.clearSelections();
        }

        updateStatsBar();
        syncToCardView();
    }

    function showAllCards() {
        state.hiddenCards.clear();

        document.querySelectorAll('.pe-item-content.hidden-card').forEach(el => el.classList.remove('hidden-card'));
        document.querySelectorAll('.pe-visibility-btn.is-hidden').forEach(btn => {
            btn.classList.remove('is-hidden');
            const svg = btn.querySelector('svg');
            if (svg) {
                svg.innerHTML = '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>';
            }
        });

        // ✅ Sync with PathwayState
        if (typeof PathwayState !== 'undefined') {
            PathwayState.showAll();
        }

        syncToCardView();
    }

    // =========================================================================
    // EXPLORER COLLAPSE/EXPAND
    // =========================================================================

    function toggleExplorer() {
        state.isCollapsed = !state.isCollapsed;

        if (elements.explorer) {
            elements.explorer.style.display = state.isCollapsed ? 'none' : 'flex';
        }
        if (elements.collapsedTab) {
            elements.collapsedTab.style.display = state.isCollapsed ? 'flex' : 'none';
        }
        if (elements.svgContainer) {
            elements.svgContainer.style.left = state.isCollapsed ? '50px' : '400px';
        }
    }

    // =========================================================================
    // CARD VIEW SYNC
    // =========================================================================

    function syncToCardView() {
        // Update cvState from PathwayState (or local state for backward compatibility)
        cvState.selectedRoots.clear();
        cvState.hiddenCards.clear();

        // ✅ FIXED: Accept pathways at ANY level (not just L0!)
        // If PathwayState exists, use it; otherwise fall back to local state
        const selectedSet = typeof PathwayState !== 'undefined'
            ? PathwayState.getSelectedPathways()
            : state.selectedPathways;
        const hiddenSet = typeof PathwayState !== 'undefined'
            ? PathwayState.getHiddenPathways()
            : state.hiddenCards;

        // Add ALL selected pathways (no level filter!)
        selectedSet.forEach(id => {
            cvState.selectedRoots.add(id);
        });

        hiddenSet.forEach(id => {
            cvState.hiddenCards.add(id);
        });

        // Trigger re-render
        if (typeof renderCardView === 'function') {
            renderCardView();
        }

        // Dispatch event
        window.dispatchEvent(new CustomEvent('pathwayExplorerUpdated', {
            detail: {
                selectedPathways: [...selectedSet],
                hiddenCards: [...hiddenSet]
            }
        }));
    }

    // =========================================================================
    // PUBLIC API
    // =========================================================================

    return {
        init,
        toggleBranch,
        toggleSelection,
        toggleVisibility,
        handleSearch,
        handleKeyNav,
        clearSearch,
        selectAllVisible,
        clearAllSelections,
        showAllCards,
        toggleExplorer,
        renderTree,

        // State access
        getState: () => ({ ...state }),
        getSelectedPathways: () => new Set(state.selectedPathways),
        getHiddenCards: () => new Set(state.hiddenCards),
        getHasInteractorsInSubtree: () => new Map(state.hasInteractorsInSubtree)
    };
})();

// Global accessor for hasInteractorsInSubtree (used by card view filtering)
window.getHasInteractorsInSubtree = () => PathwayExplorer.getHasInteractorsInSubtree();

// Global reference
window.PathwayExplorer = PathwayExplorer;

// Initialize when data is ready
document.addEventListener('DOMContentLoaded', () => {
    // Delay to ensure data is loaded
    setTimeout(() => {
        PathwayExplorer.init();
    }, 800);
});

// Also initialize when card view is shown
window.addEventListener('cardViewShown', () => {
    PathwayExplorer.init();
});
