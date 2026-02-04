
/* ===== Globals ===== */
let svg, g, width, height, simulation, zoomBehavior;
let graphInitialFitDone = false;
let fitToViewTimer = null;

let nodes = [], links = [];

// PERFORMANCE: Throttle link path updates to screen refresh rate (max 60fps)
let linkUpdatePending = false;
let linkUpdateRAF = null;

let currentZoom = 1;
let mainNodeRadius = 60;            // Bigger than interactors but not too fat
let interactorNodeRadius = 32;      // Standard size for interactor nodes
let expandedNodeRadius = 45;        // Expanded nodes (midway between main and interactor)
let interactorR = 950;              // Interactor ring radius (recalculated in buildInitialGraph)
let linkGroup, nodeGroup;            // D3 selections for links and nodes

// PERFORMANCE: Cache main node to avoid O(N) search on every tick for shared links
let cachedMainNode = null;

// PERFORMANCE: Node lookup map for O(1) access instead of O(N) find operations
let nodeMap = new Map(); // Map<nodeId, node>

// Pathway visualization state
let pathwayNodeRadius = 45;          // Size for pathway nodes (used for collision detection)
let pathwayRingRadius = 300;         // Distance from center for pathway nodes (reduced for compact layout)
let expandedPathways = new Set();    // Set of expanded pathway IDs (showing interactors)
let pathwayToInteractors = new Map(); // Map<pathwayId, Set<interactorId>>
let pathwayToInteractions = new Map(); // Map<pathwayId, Array<interaction>> - full interaction objects for leaf pathways
let pathwayMode = false;             // Whether visualization is in pathway mode
let userModeOverride = null;         // User override: null = auto, 'pathway', 'interactor'

// Hierarchical pathway state
let pathwayHierarchy = new Map();           // pathway_id -> {level, is_leaf, parent_ids, child_ids, ancestry}
let expandedHierarchyPathways = new Set();  // Track hierarchy expansions (showing sub-pathways)
let pathwayToChildren = new Map();          // pathway_id -> Set<child_pathway_id>
let allPathwaysData = [];                   // Store all pathways data for lazy expansion

// Visual constants by hierarchy level
const PATHWAY_SIZES = {
  0: { radius: 50, fontSize: 16 },   // Root level
  1: { radius: 45, fontSize: 14 },   // Level 1
  2: { radius: 40, fontSize: 13 },   // Level 2
  3: { radius: 35, fontSize: 12 }    // Level 3+
};

const PATHWAY_COLORS = {
  0: '#7c3aed',  // Deep violet
  1: '#8b5cf6',  // Medium violet
  2: '#a78bfa',  // Light violet
  3: '#c4b5fd'   // Pale violet
};

// Shell radii for concentric layout (non-pathway mode) - UNIFIED
const SHELL_RADIUS_BASE = 200;        // Shell 1
const SHELL_RADIUS_EXPANDED = 350;    // Shell 2 (Base + 150)
const SHELL_RADIUS_CHILDREN = 500;    // Shell 3 (Base + 300)

/**
 * Helper: Get node ID from link endpoint (handles both string IDs and node objects)
 * D3 force simulation converts link source/target to node objects after initialization
 */
function getLinkNodeId(endpoint) {
  return typeof endpoint === 'object' ? endpoint.id : endpoint;
}

// === COMPOUND NODE ID HELPERS ===
// Proteins can appear in multiple pathways, so we use compound IDs: "PROTEIN__pw_123"

function makeProteinNodeId(proteinSymbol, pathwayId) {
    return `${proteinSymbol}__pw_${pathwayId}`;
}

function parseProteinNodeId(nodeId) {
    const match = nodeId.match(/^(.+)__pw_(\d+)$/);
    if (match) {
        return { proteinId: match[1], pathwayId: parseInt(match[2]) };
    }
    // Legacy format or pathway node
    return { proteinId: nodeId, pathwayId: null };
}

function isCompoundProteinNode(nodeId) {
    return nodeId.includes('__pw_');
}

function getProteinIdFromNode(nodeId) {
    return parseProteinNodeId(nodeId).proteinId;
}

function getPathwayIdFromNode(nodeId) {
    return parseProteinNodeId(nodeId).pathwayId;
}

// Count how many pathways a protein appears in
function countPathwaysForProtein(proteinSymbol) {
    let count = 0;
    if (window.pathwayToInteractors) {
        window.pathwayToInteractors.forEach((proteins, pathwayId) => {
            if (proteins.has(proteinSymbol)) count++;
        });
    }
    return count;
}

// Get all pathways a protein appears in
function getPathwaysForProtein(proteinSymbol) {
    const pathways = [];
    if (window.pathwayToInteractors) {
        window.pathwayToInteractors.forEach((proteins, pathwayId) => {
            if (proteins.has(proteinSymbol)) {
                const pathway = window.allPathwaysData?.find(p => p.id === pathwayId);
                if (pathway) pathways.push(pathway);
            }
        });
    }
    return pathways;
}

/**
 * Calculate optimal expansion radius based on node count to prevent overlap
 * Uses circumference formula: radius = (nodeCount * spacing) / (2 * PI)
 * TIGHTENED: Reduced spacing and bounds for compact clusters
 */
function calculateExpandRadius(nodeCount, nodeRadius) {
  if (nodeCount <= 1) return 65; // Single node - REDUCED (was 80)

  // Minimum spacing between node centers (node diameter + gap)
  // REDUCED: tighter spacing for more compact clusters
  const minSpacing = nodeRadius * 2 + 8; // 8px gap (was 16px/24px)

  // Calculate circumference needed: nodeCount * minSpacing
  const circumference = nodeCount * minSpacing;

  // Radius = circumference / (2 * PI)
  const calculatedRadius = circumference / (2 * Math.PI);

  // REDUCED bounds for tighter clusters
  const minRadius = 90;   // Was 150
  const maxRadius = 180;  // Was 250
  return Math.max(minRadius, Math.min(maxRadius, calculatedRadius));
}

/**
 * Classify proteins by their directional relationship to the query protein
 * @param {Array} interactions - Array of interaction objects with source, target, direction
 * @param {string} queryProtein - The main/query protein (SNAP.main)
 * @returns {Object} - { upstream: Set, downstream: Set, bidirectional: Set }
 */
function getProteinsByRole(interactions, queryProtein) {
  const upstream = new Set();      // direction = 'primary_to_main' (interactor acts ON query)
  const downstream = new Set();    // direction = 'main_to_primary' (query acts ON interactor)
  const bidirectional = new Set(); // direction = 'bidirectional' or undefined

  interactions.forEach(inter => {
    const src = inter.source;
    const tgt = inter.target;

    // Determine which protein is the "other" (not query)
    let other = null;
    if (src === queryProtein) {
      other = tgt;
    } else if (tgt === queryProtein) {
      other = src;
    } else {
      // Neither is query - this is an interactor-interactor link, skip for classification
      return;
    }

    if (!other || other === queryProtein) return;

    const dir = inter.direction || 'bidirectional';
    if (dir === 'primary_to_main') {
      upstream.add(other);  // This protein acts on query (upstream)
    } else if (dir === 'main_to_primary') {
      downstream.add(other);  // Query acts on this protein (downstream)
    } else {
      bidirectional.add(other);
    }
  });

  return { upstream, downstream, bidirectional };
}

/**
 * Calculate arc positions for distributing nodes along an arc
 * @param {number} count - Number of nodes to position
 * @param {number} cx - Center X coordinate
 * @param {number} cy - Center Y coordinate
 * @param {number} radius - Distance from center
 * @param {number} startAngle - Arc start angle in radians
 * @param {number} endAngle - Arc end angle in radians
 * @returns {Array} - Array of {x, y, angle} positions
 */
function calculateArcPositions(count, cx, cy, radius, startAngle, endAngle) {
  if (count === 0) return [];

  // Single node goes to middle of arc
  if (count === 1) {
    const angle = (startAngle + endAngle) / 2;
    return [{
      x: cx + radius * Math.cos(angle),
      y: cy + radius * Math.sin(angle),
      angle: angle
    }];
  }

  // Multiple nodes spread evenly along arc
  const positions = [];
  const step = (endAngle - startAngle) / (count - 1);

  for (let i = 0; i < count; i++) {
    const angle = startAngle + i * step;
    positions.push({
      x: cx + radius * Math.cos(angle),
      y: cy + radius * Math.sin(angle),
      angle: angle
    });
  }

  return positions;
}

/**
 * Find an unoccupied angular sector around a center point
 * Scans existing nodes and returns an angle in the largest gap
 * @param {number} centerX - Center X coordinate
 * @param {number} centerY - Center Y coordinate
 * @param {Array} existingNodes - Nodes to avoid
 * @param {number} preferredAngle - Preferred angle if space is available
 * @param {number} minClearance - Minimum angular clearance needed (radians)
 * @returns {number} - Safe angle in radians
 */
function findUnoccupiedSector(centerX, centerY, existingNodes, preferredAngle, minClearance = Math.PI / 4) {
  if (!existingNodes || existingNodes.length === 0) {
    return preferredAngle;
  }

  // Calculate angles of existing nodes relative to center
  const angles = existingNodes
    .map(n => {
      const dx = n.x - centerX;
      const dy = n.y - centerY;
      return Math.atan2(dy, dx);
    })
    .sort((a, b) => a - b);

  // Check if preferred angle has enough clearance
  const hasSpace = angles.every(existingAngle => {
    let diff = Math.abs(preferredAngle - existingAngle);
    if (diff > Math.PI) diff = 2 * Math.PI - diff;
    return diff >= minClearance;
  });

  if (hasSpace) {
    return preferredAngle;
  }

  // Find the largest gap between consecutive angles
  let maxGap = 0;
  let maxGapStart = 0;

  for (let i = 0; i < angles.length; i++) {
    const current = angles[i];
    const next = angles[(i + 1) % angles.length];
    // Handle wrap-around from last to first angle
    let gap = (i === angles.length - 1)
      ? (next + 2 * Math.PI) - current
      : next - current;

    if (gap > maxGap) {
      maxGap = gap;
      maxGapStart = current;
    }
  }

  // Return angle in the middle of the largest gap
  return maxGapStart + maxGap / 2;
}

// ============================================================================
// SHELL-BASED LAYOUT SYSTEM - Deterministic radial positioning
// ============================================================================

/** @type {'shell'|'force'} Layout mode: 'shell' for deterministic, 'force' for physics */
let layoutMode = 'shell';

/** @type {Map<number, Set<string>>} Registry of nodes per shell */
let shellRegistry = new Map();

/** @type {number[]} Cached shell radii (recalculated when nodes change) */
let shellRadii = [];

/**
 * Angular Space Manager - Global coordination of occupied angular sectors per shell
 * Enables proactive space reservation to prevent overlap before positioning
 */
const angularSpaceManager = {
  /** @type {Map<number, Array<{startAngle: number, endAngle: number, ownerId: string, priority: number}>>} */
  occupiedSectors: new Map(),

  /** Minimum angular gap between sectors (5 degrees in radians) */
  MIN_ANGULAR_GAP: Math.PI / 36,

  /**
   * Normalize angle to [0, 2*PI) range
   */
  normalizeAngle(angle) {
    while (angle < 0) angle += 2 * Math.PI;
    while (angle >= 2 * Math.PI) angle -= 2 * Math.PI;
    return angle;
  },

  /**
   * Calculate angular distance between two angles (always positive, shortest path)
   */
  angularDistance(a, b) {
    const diff = Math.abs(this.normalizeAngle(a) - this.normalizeAngle(b));
    return Math.min(diff, 2 * Math.PI - diff);
  },

  /**
   * Reserve an angular sector for a node group
   * @param {number} shell - Shell number
   * @param {number} startAngle - Start angle in radians
   * @param {number} endAngle - End angle in radians
   * @param {string} ownerId - ID of owning node (for release on collapse)
   * @param {number} priority - Higher = harder to displace (main=100, pathway=50, interactor=10)
   */
  reserve(shell, startAngle, endAngle, ownerId, priority = 10) {
    if (!this.occupiedSectors.has(shell)) {
      this.occupiedSectors.set(shell, []);
    }
    const sectors = this.occupiedSectors.get(shell);

    // Remove any existing reservation by this owner in this shell
    const existing = sectors.findIndex(s => s.ownerId === ownerId);
    if (existing !== -1) {
      sectors.splice(existing, 1);
    }

    sectors.push({
      startAngle: this.normalizeAngle(startAngle),
      endAngle: this.normalizeAngle(endAngle),
      ownerId,
      priority
    });
  },

  /**
   * Find the best available sector for a given angular span
   * @param {number} shell - Shell number
   * @param {number} requiredSpan - Angular width needed in radians
   * @param {number} preferredCenter - Preferred center angle (e.g., parent's angle)
   * @returns {{startAngle: number, endAngle: number, quality: number}} - Best available sector
   */
  findBestSector(shell, requiredSpan, preferredCenter = 0) {
    const sectors = this.occupiedSectors.get(shell) || [];
    preferredCenter = this.normalizeAngle(preferredCenter);

    // If no occupants, center on preferred angle
    if (sectors.length === 0) {
      return {
        startAngle: preferredCenter - requiredSpan / 2,
        endAngle: preferredCenter + requiredSpan / 2,
        quality: 1.0
      };
    }

    // Sort sectors by start angle
    const sorted = [...sectors].sort((a, b) => a.startAngle - b.startAngle);

    // Find gaps between consecutive sectors (including wrap-around)
    const gaps = [];
    for (let i = 0; i < sorted.length; i++) {
      const current = sorted[i];
      const next = sorted[(i + 1) % sorted.length];

      let gapStart = current.endAngle + this.MIN_ANGULAR_GAP;
      let gapEnd;

      if (i === sorted.length - 1) {
        // Wrap-around gap: from last sector's end to first sector's start (+ 2*PI)
        gapEnd = next.startAngle + 2 * Math.PI - this.MIN_ANGULAR_GAP;
      } else {
        gapEnd = next.startAngle - this.MIN_ANGULAR_GAP;
      }

      const gapSize = gapEnd - gapStart;
      if (gapSize >= requiredSpan) {
        gaps.push({ start: gapStart, end: gapEnd, size: gapSize });
      }
    }

    // If no gaps found, return quality=0 (caller should expand radius)
    if (gaps.length === 0) {
      // Force placement at preferred angle with quality=0
      return {
        startAngle: preferredCenter - requiredSpan / 2,
        endAngle: preferredCenter + requiredSpan / 2,
        quality: 0
      };
    }

    // Score gaps: prefer those closest to preferredCenter
    const scoredGaps = gaps.map(gap => {
      const gapCenter = this.normalizeAngle(gap.start + gap.size / 2);
      const distToPreferred = this.angularDistance(gapCenter, preferredCenter);
      const score = 1 - (distToPreferred / Math.PI); // 0-1, higher is better
      return { ...gap, score };
    });

    // Select best gap
    scoredGaps.sort((a, b) => b.score - a.score);
    const best = scoredGaps[0];

    // Center the required span within the best gap, biased toward preferred angle
    let centerInGap = this.normalizeAngle(best.start + best.size / 2);

    // If preferred angle is within this gap, use it
    const prefNorm = preferredCenter;
    if (prefNorm >= best.start && prefNorm <= best.start + best.size) {
      centerInGap = prefNorm;
    }

    return {
      startAngle: centerInGap - requiredSpan / 2,
      endAngle: centerInGap + requiredSpan / 2,
      quality: best.score
    };
  },

  /**
   * Release all sectors owned by a node (called on collapse)
   * @param {string} ownerId - ID of the owner to release
   */
  releaseOwnerSectors(ownerId) {
    for (const [shell, sectors] of this.occupiedSectors) {
      const filtered = sectors.filter(s => s.ownerId !== ownerId);
      if (filtered.length !== sectors.length) {
        this.occupiedSectors.set(shell, filtered);
      }
    }
  },

  /**
   * Clear all reservations for a specific shell
   * @param {number} shell - Shell number to clear
   */
  clearShell(shell) {
    this.occupiedSectors.set(shell, []);
  },

  /**
   * Clear all reservations (called on full reset)
   */
  clear() {
    this.occupiedSectors.clear();
  },

  /**
   * Get total occupied angular span in a shell
   * @param {number} shell - Shell number
   * @returns {number} - Total occupied radians
   */
  getOccupiedSpan(shell) {
    const sectors = this.occupiedSectors.get(shell) || [];
    return sectors.reduce((sum, s) => {
      const span = s.endAngle >= s.startAngle
        ? s.endAngle - s.startAngle
        : (2 * Math.PI - s.startAngle) + s.endAngle;
      return sum + span;
    }, 0);
  }
};

/**
 * Calculate shell position for a node - PURE FUNCTION
 * @param {Object} config - {centerX, centerY, shell, totalInShell, indexInShell, nodeRadius}
 * @returns {Object} - {x, y, angle, shell, slot, totalSlots, radius}
 */
function calculateShellPosition(config) {
  const { centerX, centerY, shell, totalInShell, indexInShell, nodeRadius } = config;

  // Dynamic radius: scale with node count to prevent overlap
  const minSpacing = nodeRadius * 2.5;
  const requiredCircumference = Math.max(totalInShell, 1) * minSpacing;
  const minRadiusForCount = requiredCircumference / (2 * Math.PI);

  // Base radii with dynamic scaling - each shell accumulates
  const BASE_SHELL_GAP = 150; // UNIFIED GAP
  const SHELL_0_RADIUS = 0;   // Center (main node)

  let radius;
  if (shell === 0) {
    radius = SHELL_0_RADIUS;
  } else {
    // Accumulate radius: each shell is at least BASE_SHELL_GAP from previous
    // STRICT MODE: Fixed radius, no expansion based on count
    radius = shell * BASE_SHELL_GAP + 50; // Shell 1 = 150*1 + 50 = 200

  }

  // Calculate angle: evenly distribute nodes around the shell
  const effectiveTotal = Math.max(totalInShell, 1);
  const angleStep = (2 * Math.PI) / effectiveTotal;
  const angle = indexInShell * angleStep - Math.PI / 2; // Start from top

  return {
    x: centerX + radius * Math.cos(angle),
    y: centerY + radius * Math.sin(angle),
    angle: angle,
    shell: shell,
    slot: indexInShell,
    totalSlots: effectiveTotal,
    radius: radius
  };
}

/**
 * Position a node within its parent's angular sector (arc-sector clustering)
 * Children are distributed within their parent's arc, not the entire ring
 */
function calculateArcSectorPosition(config) {
  const {
    centerX, centerY,
    shell,
    shellRadius,
    parentAngle,           // Parent's angular position (radians)
    arcSpan,               // Angular width for this parent's children
    indexInParentGroup,    // Index among siblings with same parent
    totalInParentGroup     // Total siblings with same parent
  } = config;

  // Distribute children evenly within parent's arc
  let angle;
  if (totalInParentGroup === 1) {
    // Single child: position directly at parent's angle
    angle = parentAngle;
  } else {
    // Multiple children: spread within arc centered on parent
    const arcStart = parentAngle - arcSpan / 2;

    // For full circles (arcSpan ≈ 2π), use n divisions to avoid first/last overlap
    // For partial arcs, use (n-1) divisions so first and last are at arc boundaries
    const isFullCircle = arcSpan > 1.9 * Math.PI;  // ~342° threshold
    const step = isFullCircle
      ? arcSpan / totalInParentGroup           // Full circle: evenly spaced with gap
      : arcSpan / (totalInParentGroup - 1);    // Partial arc: endpoints at boundaries

    angle = arcStart + indexInParentGroup * step;
  }

  return {
    x: centerX + shellRadius * Math.cos(angle),
    y: centerY + shellRadius * Math.sin(angle),
    angle,
    shell,
    radius: shellRadius
  };
}

/**
 * Calculate fixed radii for all shells - consistent spacing like shell 1
 * Uses fixed gaps instead of dynamic circumference-based expansion
 * @param {Map<number, Array>} nodesByShell - Map of shell number to nodes array
 * @param {number} defaultNodeRadius - Default radius for nodes (unused, kept for API compatibility)
 * @returns {number[]} - Array of radii indexed by shell number
 */
function calculateCollisionFreeRadii(nodesByShell, defaultNodeRadius = 35) {
  const radii = [0]; // Shell 0 is center
  const BASE_RADIUS = 200;     // Shell 1 minimum radius
  const SHELL_GAP = 180;       // Gap between shells (INCREASED to allow links to pass)
  const BASE_SHELL_GAP = 180;  // Minimum gap constraint
  const MIN_NODE_SPACING = 90; // Spacing between node centers (was 80)

  // Get max shell number
  const maxShell = Math.max(...Array.from(nodesByShell.keys()), 0);

  let requiredGap = BASE_SHELL_GAP; // Initialize with a minimum gap

  for (let shell = 1; shell <= maxShell + 1; shell++) {
    const shellNodes = nodesByShell.get(shell) || [];
    const nodeCount = shellNodes.length;

    // Calculate minimum radius required for this shell to avoid overlaps
    // Method 1: Simple circumference (all nodes side-by-side)
    const circumferenceNeeded = nodeCount * MIN_NODE_SPACING;
    const circumferenceRadius = circumferenceNeeded / (2 * Math.PI);

    // Method 2: Angular density (clustering) - heavily weighted for pathways
    // Group nodes by parent to find angular clusters
    const byParent = new Map();
    shellNodes.forEach(node => {
      const parentId = node.type === 'pathway'
        ? (node.parentPathwayId || node._isChildOf || 'root')
        : (node._pathwayContext || node._isChildOf || 'root');
      if (!byParent.has(parentId)) byParent.set(parentId, []);
      byParent.get(parentId).push(node);
    });

    let maxDensityRadius = 0;
    for (const [parentId, children] of byParent) {
      let totalSpacing = 0;
      children.forEach(child => {
        // Pathways need significant width
        totalSpacing += child.type === 'pathway' ? 240 : MIN_NODE_SPACING;
      });

      // Assume maximum usable arc per parent group is limited (e.g., PI radians)
      // This forces radius expansion if too many children share one parent
      const maxArc = Math.PI * 0.8;
      maxDensityRadius = Math.max(maxDensityRadius, totalSpacing / maxArc);
    }

    // Required radius for this specific shell
    const neededRadius = Math.max(circumferenceRadius, maxDensityRadius) + 50;

    // Calculate what GAP would be needed to reach this radius:
    // Radius = 50 + shell * gap  =>  gap = (Radius - 50) / shell
    const neededGap = (neededRadius - 50) / shell;

    // Keep track of the maximum gap needed by ANY shell
    requiredGap = Math.max(requiredGap, neededGap);
  }

  // Apply the uniform gap to all shells
  // Capping gap to prevent explosion, but ensuring it's at least BASE_SHELL_GAP
  const finalGap = Math.min(Math.max(requiredGap, BASE_SHELL_GAP), 600);

  for (let shell = 1; shell <= maxShell + 1; shell++) {
    radii[shell] = 50 + shell * finalGap;
  }

  return radii;
}

/**
 * Assign nodes to shells based on their type and expansion state
 * @param {Array} allNodes - All nodes in the graph
 * @param {string} mainNodeId - ID of the main/root protein
 * @param {Set} expandedSet - Set of expanded node IDs
 * @param {Object} context - Additional context {pathwayMode, expandedPathways, pathwayHierarchy}
 * @returns {Map<string, Object>} - Map of nodeId -> {shell, role, parentId, parentShell}
 */
function assignNodesToShells(allNodes, mainNodeId, expandedSet, context = {}) {
  const assignments = new Map();
  const {
    expandedPathways: expPathways,
    pathwayHierarchy: pwHierarchy,
    pathwayMode: pMode = pathwayMode  // Extract from context with fallback to global
  } = context;

  // PASS 1: Assign main node and ALL pathways first (so their shells are known for interactors)
  // Sort pathways by hierarchy level to ensure parents are assigned before children
  const pathwayNodes = allNodes
    .filter(n => n.type === 'pathway')
    .sort((a, b) => {
      const aLevel = pwHierarchy?.get(a.originalId || a.id)?.level ?? a.hierarchyLevel ?? 0;
      const bLevel = pwHierarchy?.get(b.originalId || b.id)?.level ?? b.hierarchyLevel ?? 0;
      return aLevel - bLevel; // Lower levels first
    });

  // Determine Main Node ID
  const rootId = mainNodeId || (allNodes.find(n => n.type === 'main')?.id);

  // BFS Queue: [ { id, shell } ]
  const queue = [];
  const visited = new Set();

  if (rootId) {
    queue.push({ id: rootId, shell: 0 });
    visited.add(rootId);
    assignments.set(rootId, { shell: 0, role: 'main', parentId: null });
  }

  // Pre-process parent-child relationships for BFS traversal
  // We need to know who are the children of a node to push them to queue
  const childrenMap = new Map(); // parentId -> [childId]

  allNodes.forEach(node => {
    // Logic for pathways: uses parentPathwayId or _isChildOf
    const pId = node.parentPathwayId || node._isChildOf || node._pathwayContext;
    if (pId) {
      if (!childrenMap.has(pId)) childrenMap.set(pId, []);
      childrenMap.get(pId).push(node.id);
    }
    // Special case: Link from Main to Top-level pathways
    // Top-level pathways might not have parentPathwayId set to Main, so we infer
    if (node.type === 'pathway' && !node.parentPathwayId && !node._isChildOf && (node.hierarchyLevel === 0 || node.level === 0)) {
      // Treat root as parent for Level 0 pathways
      if (rootId) {
        if (!childrenMap.has(rootId)) childrenMap.set(rootId, []);
        childrenMap.get(rootId).push(node.id);
      }
    }
  });

  // BFS Traversal
  while (queue.length > 0) {
    const { id, shell } = queue.shift();
    const currentShell = shell;

    const children = childrenMap.get(id) || [];
    children.forEach(childId => {
      if (!visited.has(childId)) {
        visited.add(childId);
        // Child is definitely in next shell
        const nextShell = currentShell + 1;
        assignments.set(childId, { shell: nextShell, role: 'child', parentId: id });
        queue.push({ id: childId, shell: nextShell });
      }
    });
  }

  // Fallback for disconnected nodes (shouldn't happen often)
  allNodes.forEach(node => {
    if (!assignments.has(node.id)) {
      // If unassigned, default to Shell 1 (neighbors of main) if likely top level, else deeper
      console.warn(`Orphan node assigned default shell: ${node.id}`);
      assignments.set(node.id, { shell: 1, role: 'orphan', parentId: rootId });
    }
  });


  // PASS 2: Assign interactors (now all parent pathways have shells assigned)
  allNodes.forEach(node => {
    // Skip already assigned (main, pathways) and function nodes
    if (assignments.has(node.id)) return;
    if (node.type === 'function' || node.isFunction) return;

    let shell = 1; // Default shell
    let role = node.type || 'interactor';
    let parentId = node._pathwayContext || node._isChildOf || null;
    let parentShell = null;

    // Interactors expanded from pathways: go to shell after parent pathway
    if (node._pathwayContext && pMode) {
      const parentNode = nodeMap.get(node._pathwayContext);
      if (parentNode) {
        const parentAssignment = assignments.get(parentNode.id);
        // Now parent pathway is guaranteed to have a shell assigned
        parentShell = parentAssignment?.shell ?? 1;

        // Direction-based shell assignment for interactors
        if (node._directionRole === 'upstream') {
          shell = parentShell + 1;
        } else if (node.isQueryProtein || node._directionRole === 'query') {
          shell = parentShell + 2;
        } else if (node._directionRole === 'bidirectional') {
          // Bidirectional interactors get distinct shell to avoid crowding with upstream/pathways
          shell = parentShell + 2;
        } else if (node._directionRole === 'downstream') {
          shell = parentShell + 3;
        } else if (node._directionRole === 'indirect') {
          // Indirect interactors go further out based on hop count
          const hopCount = node._indirectHopCount || 1;
          shell = parentShell + 3 + hopCount;
        } else {
          // Default: unknown direction - conservative placement
          if (!node._directionRole) {
            console.warn(`⚠️ Node ${node.id} missing _directionRole, defaulting to shell ${parentShell + 1}`);
          }
          shell = parentShell + 1;
        }
      }
      role = 'interactor';
    }
    // Non-pathway mode: shell based on expansion state
    else if (!pMode) {
      if (node._isChildOf) {
        // Children of expanded nodes go to outer shell
        const parentNode = nodeMap.get(node._isChildOf);
        parentShell = parentNode ? (assignments.get(parentNode.id)?.shell ?? 1) : 1;
        shell = parentShell + 1;
      } else if (expandedSet && expandedSet.has(node.id)) {
        shell = 2; // Expanded nodes
      } else {
        shell = 1; // Base interactors
      }
      role = 'interactor';
    }
    // NEW: Handle interactors in pathway mode WITHOUT _pathwayContext
    // These are initial interactors that were created at graph build time
    // Without this case, they fall through and stay at default shell=1 without proper assignment
    else if (pMode && node.type === 'interactor') {
      if (node._isChildOf) {
        // Children of expanded nodes go to outer shell
        const parentNode = nodeMap.get(node._isChildOf);
        parentShell = parentNode ? (assignments.get(parentNode.id)?.shell ?? 1) : 1;
        shell = parentShell + 1;
      } else {
        shell = 1; // Base shell for initial interactors
      }
      role = 'interactor';
    }

    // Placeholder nodes stay in same shell as parent's children
    if (node.isPlaceholder) {
      role = 'placeholder';
    }

    assignments.set(node.id, { shell, role, parentId, parentShell });
  });

  return assignments;
}

/**
 * Find a parent node with fallback for context-qualified IDs
 * Handles cases where IDs like "pathway_B@pathway_A" need to find "pathway_A"
 * @param {string} parentId - The parent ID to look up
 * @returns {Object|null} - The parent node or null if not found
 */
function findParentNode(parentId) {
  if (!parentId) return null;

  // Direct lookup first
  let parent = nodeMap.get(parentId);
  if (parent) return parent;

  // Try original ID without context suffix (e.g., "pathway_A@main" → "pathway_A")
  const baseId = parentId.split('@')[0];
  parent = nodeMap.get(baseId);
  if (parent) return parent;

  // Search for any node with originalId matching
  for (const [, node] of nodeMap) {
    if (node.originalId === parentId || node.originalId === baseId) {
      return node;
    }
  }

  return null;
}

/**
 * Calculate the subtree size for each expanded pathway.
 * Subtree includes: pathway node + all interactors with _pathwayContext pointing to it.
 * @param {Array} allNodes - All nodes in the graph
 * @param {Set} expandedPathways - Set of expanded pathway IDs
 * @returns {Map<string, number>} - pathwayId -> subtreeSize
 */
function calculateExpandedSubtreeSizes(allNodes, expandedPathways) {
  const subtreeSizes = new Map();

  expandedPathways.forEach(pathwayId => {
    let count = 1; // The pathway node itself

    allNodes.forEach(node => {
      // Count nodes that belong to this pathway's subtree
      if (node._pathwayContext === pathwayId ||
        node.pathwayId === pathwayId ||
        node.parentPathwayId === pathwayId) {
        count++;
      }
    });

    subtreeSizes.set(pathwayId, count);
  });

  return subtreeSizes;
}

/**
 * Allocate angular sectors to pathways proportionally based on subtree sizes.
 * Expanded pathways with more interactors get wider sectors.
 * @param {Array} shell1Nodes - All nodes in shell 1
 * @param {Map} subtreeSizes - pathwayId -> subtreeSize from calculateExpandedSubtreeSizes
 * @param {Set} expandedPathways - Set of expanded pathway IDs
 * @returns {Map<string, Object>} - pathwayId -> {startAngle, endAngle, centerAngle, arcSpan}
 */
function allocateSectorsBySubtreeSize(shell1Nodes, subtreeSizes, expandedPathways) {
  const sectors = new Map();
  const pathways = shell1Nodes.filter(n => n.type === 'pathway');

  if (pathways.length === 0) return sectors;

  // Calculate weights: expanded pathways get subtree size, unexpanded get 1
  let totalWeight = 0;
  const weights = new Map();

  pathways.forEach(pw => {
    const isExpanded = expandedPathways.has(pw.id);
    const weight = isExpanded ? (subtreeSizes.get(pw.id) || 1) : 1;
    weights.set(pw.id, weight);
    totalWeight += weight;
  });

  // Sort pathways by connection topology for optimal ordering
  const sortedPathways = sortNodesByConnectionTopology(pathways);

  // Allocate sectors proportionally, starting from top (-PI/2)
  let currentAngle = -Math.PI / 2;

  sortedPathways.forEach(pw => {
    const weight = weights.get(pw.id);
    const arcSpan = (weight / totalWeight) * 2 * Math.PI;

    sectors.set(pw.id, {
      startAngle: currentAngle,
      endAngle: currentAngle + arcSpan,
      centerAngle: currentAngle + arcSpan / 2,
      arcSpan: arcSpan
    });

    currentAngle += arcSpan;
  });

  return sectors;
}

/**
 * Find the pathway node that a given node is connected to.
 * Used for assigning non-pathway shell 1 nodes to sectors.
 * @param {Object} node - The node to find a connected pathway for
 * @returns {Object|null} - The connected pathway node, or null
 */
function findConnectedPathway(node) {
  // First check if node has explicit pathway context
  if (node._pathwayContext) {
    return nodeMap.get(node._pathwayContext);
  }

  // Check links for pathway connections
  for (const link of links) {
    const srcId = typeof link.source === 'object' ? link.source.id : link.source;
    const tgtId = typeof link.target === 'object' ? link.target.id : link.target;

    if (srcId === node.id) {
      const target = nodeMap.get(tgtId);
      if (target?.type === 'pathway') return target;
    }
    if (tgtId === node.id) {
      const source = nodeMap.get(srcId);
      if (source?.type === 'pathway') return source;
    }
  }

  return null;
}

/**
 * Sort nodes by their connection topology to minimize link crossings
 * Nodes connected to similar targets will be placed adjacent to each other
 * @param {Array} shellNodes - Nodes to sort
 * @returns {Array} - Sorted nodes
 */
function sortNodesByConnectionTopology(shellNodes) {
  if (shellNodes.length <= 2) return shellNodes;

  // Build connection map: what does each node connect to?
  const nodeConnections = new Map();
  shellNodes.forEach(node => {
    const connected = new Set();
    links.forEach(link => {
      const srcId = typeof link.source === 'object' ? link.source.id : link.source;
      const tgtId = typeof link.target === 'object' ? link.target.id : link.target;
      if (srcId === node.id) connected.add(tgtId);
      if (tgtId === node.id) connected.add(srcId);
    });
    nodeConnections.set(node.id, connected);
  });

  // Calculate connection similarity between two nodes
  // Higher score = more common connections
  function connectionSimilarity(nodeA, nodeB) {
    const connA = nodeConnections.get(nodeA.id) || new Set();
    const connB = nodeConnections.get(nodeB.id) || new Set();
    let common = 0;
    connA.forEach(id => { if (connB.has(id)) common++; });
    return common;
  }

  // Greedy nearest-neighbor sorting:
  // Start with first node, then always pick the most similar unvisited node
  const sorted = [];
  const remaining = new Set(shellNodes);

  // Start with the node that has the most connections (hub node)
  let current = shellNodes.reduce((best, node) => {
    const conns = nodeConnections.get(node.id)?.size || 0;
    const bestConns = nodeConnections.get(best.id)?.size || 0;
    return conns > bestConns ? node : best;
  }, shellNodes[0]);

  sorted.push(current);
  remaining.delete(current);

  while (remaining.size > 0) {
    // Find the remaining node most similar to current
    let bestNext = null;
    let bestScore = -1;

    remaining.forEach(candidate => {
      const score = connectionSimilarity(current, candidate);
      if (score > bestScore) {
        bestScore = score;
        bestNext = candidate;
      }
    });

    // If no good match (score=0), pick based on parent angle proximity
    if (bestScore === 0 && bestNext) {
      // Fall back to picking by type grouping (pathways together, interactors together)
      const currentType = current.type;
      for (const candidate of remaining) {
        if (candidate.type === currentType) {
          bestNext = candidate;
          break;
        }
      }
    }

    if (!bestNext) bestNext = remaining.values().next().value;

    sorted.push(bestNext);
    remaining.delete(bestNext);
    current = bestNext;
  }

  return sorted;
}

/**
 * Sort children within a parent group by the angle of their external connections.
 * This ensures siblings are positioned so their links to other nodes don't cross.
 * Nodes whose connections are on the "left" (lower angles) get placed at lower angles,
 * and nodes whose connections are on the "right" (higher angles) get placed at higher angles.
 * @param {Array} children - All children of the same parent
 * @param {Map} nodeAngles - Map of nodeId → angle for already-positioned nodes
 * @param {string} parentId - The parent's ID (to exclude from connection analysis)
 * @returns {Array} - Children sorted by external connection angles
 */
function sortChildrenByExternalConnections(children, nodeAngles, parentId) {
  if (children.length <= 1) return children;

  // For each child, calculate the average angle of its external connections
  const childConnectionAngles = new Map();

  children.forEach(child => {
    let weightedSum = 0;
    let totalWeight = 0;

    // Find all links connected to this child
    links.forEach(link => {
      const srcId = typeof link.source === 'object' ? link.source.id : link.source;
      const tgtId = typeof link.target === 'object' ? link.target.id : link.target;

      let otherId = null;
      if (srcId === child.id) otherId = tgtId;
      else if (tgtId === child.id) otherId = srcId;
      else return;

      // Skip the parent connection (we're sorting within parent group)
      if (otherId === parentId) return;
      // Also skip base ID match
      const baseParentId = parentId.split('@')[0];
      if (otherId === baseParentId || otherId.split('@')[0] === baseParentId) return;

      // Get the other node's angle if already positioned
      let otherAngle = nodeAngles.get(otherId);
      if (otherAngle === undefined) {
        const baseOtherId = otherId.split('@')[0];
        otherAngle = nodeAngles.get(baseOtherId);
      }

      if (otherAngle !== undefined) {
        weightedSum += otherAngle;
        totalWeight += 1;
      }
    });

    // If no external connections found, use topology-based fallback
    // (check if connected to any siblings - place similar siblings together)
    if (totalWeight === 0) {
      // Fallback: use the child's ID hash for consistent ordering
      let hash = 0;
      for (let i = 0; i < child.id.length; i++) {
        hash = ((hash << 5) - hash) + child.id.charCodeAt(i);
        hash |= 0;
      }
      childConnectionAngles.set(child.id, (hash % 1000) / 1000 * 2 * Math.PI - Math.PI);
    } else {
      childConnectionAngles.set(child.id, weightedSum / totalWeight);
    }
  });

  // Sort by: 1) Type (pathways first, interactors last) 2) Connection angle within type
  // Pathways go first so their expansions continue in the same angular direction,
  // while interactors (which don't expand) are positioned after them
  return children.slice().sort((a, b) => {
    // Primary sort: pathways before interactors
    const aIsPathway = a.type === 'pathway' ? 0 : 1;
    const bIsPathway = b.type === 'pathway' ? 0 : 1;
    if (aIsPathway !== bIsPathway) {
      return aIsPathway - bIsPathway; // pathways (0) before interactors (1)
    }
    // Secondary sort: by connection angle within same type
    return childConnectionAngles.get(a.id) - childConnectionAngles.get(b.id);
  });
}

/**
 * Sort ALL nodes at a shell level by their parent's angle.
 * This ensures nodes from different parents don't overlap angularly,
 * preventing link crossings between different parent-child pairs.
 * @param {Array} shellNodes - All nodes at this shell level
 * @param {Map} nodeAngles - Map of nodeId → angle for parent lookup
 * @returns {Array} - Nodes sorted by parent angle, with external-connection sort within same-parent groups
 */
function sortShellNodesByParentAngle(shellNodes, nodeAngles) {
  if (shellNodes.length <= 1) return shellNodes;

  // Group nodes by parent
  const byParent = new Map();
  shellNodes.forEach(node => {
    const parentId = node.type === 'pathway'
      ? (node.parentPathwayId || node._isChildOf || SNAP.main)
      : (node._pathwayContext || node._isChildOf || SNAP.main);

    if (!byParent.has(parentId)) {
      byParent.set(parentId, []);
    }
    byParent.get(parentId).push(node);
  });

  // Sort parent groups by parent's angle
  const sortedParentIds = Array.from(byParent.keys()).sort((a, b) => {
    // Try multiple lookup methods for parent angle
    let angleA = nodeAngles.get(a);
    if (angleA === undefined) {
      const baseA = a.split('@')[0];
      angleA = nodeAngles.get(baseA);
    }
    if (angleA === undefined) angleA = 0;

    let angleB = nodeAngles.get(b);
    if (angleB === undefined) {
      const baseB = b.split('@')[0];
      angleB = nodeAngles.get(baseB);
    }
    if (angleB === undefined) angleB = 0;

    return angleA - angleB;
  });

  // Flatten: for each parent group in angle order, add children sorted by external connections
  const result = [];
  for (const parentId of sortedParentIds) {
    const children = byParent.get(parentId);
    // Sort within parent group by external connection angles (not just topology)
    const sortedChildren = sortChildrenByExternalConnections(children, nodeAngles, parentId);
    result.push(...sortedChildren);
  }

  return result;
}

/**
 * Rebuild shell registry and recalculate all positions
 * Call this after any node addition/removal
 */
function recalculateShellPositions() {
  if (layoutMode !== 'shell') return;

  const centerX = width / 2;
  const centerY = height / 2;

  // Get shell assignments for all nodes
  const assignments = assignNodesToShells(nodes, SNAP.main, expanded, {
    pathwayMode,
    expandedPathways,
    pathwayHierarchy
  });

  // Group nodes by shell
  shellRegistry.clear();
  const nodesByShell = new Map();

  nodes.forEach(node => {
    const assignment = assignments.get(node.id);
    if (!assignment || node.type === 'function' || node.isFunction) return;

    const shell = assignment.shell;
    node._shellData = assignment; // Store assignment on node

    if (!nodesByShell.has(shell)) {
      nodesByShell.set(shell, []);
    }
    nodesByShell.get(shell).push(node);

    if (!shellRegistry.has(shell)) {
      shellRegistry.set(shell, new Set());
    }
    shellRegistry.get(shell).add(node.id);
  });

  // Calculate collision-free radii
  shellRadii = calculateCollisionFreeRadii(nodesByShell, interactorNodeRadius);

  // SIMPLIFIED POSITIONING:
  // 1. Shell 1 nodes spread evenly around center
  // 2. Shell 2+ nodes inherit parent's angle and spread within small arc

  // Store angles for parent lookup
  const nodeAngles = new Map();  // nodeId → angle

  // Process shells in order
  const sortedShells = Array.from(nodesByShell.keys()).sort((a, b) => a - b);
  for (const shellNum of sortedShells) {
    const shellNodes = nodesByShell.get(shellNum);

    if (shellNum === 0) {
      // Main node at center - explicit positioning
      shellNodes.forEach(node => {
        node.x = width / 2;
        node.y = height / 2;
        node.fx = width / 2;
        node.fy = height / 2;
        node._shellData = { shell: 0, radius: 0, angle: 0 };
      });
      continue;
    }

    const shellRadius = shellRadii[shellNum] || (shellNum * 150 + 100);

    // SIMPLE APPROACH:
    // Shell 1: spread all nodes evenly around circle
    // Shell 2+: group by parent, position at parent's angle with small spread

    if (shellNum === 1) {
      // SHELL 1: Use proportional sector allocation based on expanded subtree sizes
      // Expanded pathways with more interactors get wider angular sectors
      const subtreeSizes = calculateExpandedSubtreeSizes(nodes, expandedPathways);
      const sectorAllocations = allocateSectorsBySubtreeSize(shellNodes, subtreeSizes, expandedPathways);

      // Position each node based on its sector allocation
      shellNodes.forEach(node => {
        let angle;

        if (node.type === 'pathway' && sectorAllocations.has(node.id)) {
          // Pathway node: position at sector center
          const sector = sectorAllocations.get(node.id);
          angle = sector.centerAngle;
          // Store sector info for children to inherit
          node._sectorAllocation = sector;
        } else {
          // Non-pathway node: position based on connected pathway
          const connectedPw = findConnectedPathway(node);
          if (connectedPw && sectorAllocations.has(connectedPw.id)) {
            angle = sectorAllocations.get(connectedPw.id).centerAngle;
          } else {
            // Fallback: find first available sector or use default
            const nonPathwayNodes = shellNodes.filter(n => n.type !== 'pathway');
            const idx = nonPathwayNodes.indexOf(node);
            const count = nonPathwayNodes.length || 1;
            angle = (idx / count) * 2 * Math.PI - Math.PI / 2;
          }
        }

        node.x = centerX + shellRadius * Math.cos(angle);
        node.y = centerY + shellRadius * Math.sin(angle);
        node._shellData = { ...node._shellData, angle, radius: shellRadius, shell: shellNum };
        node._targetAngle = angle;
        nodeAngles.set(node.id, angle);
        if (node.originalId) nodeAngles.set(node.originalId, angle);
        // Store by base ID too
        const baseId = node.id.split('@')[0];
        if (baseId !== node.id) nodeAngles.set(baseId, angle);
        node.fx = null;
        node.fy = null;
      });
    } else {
      // SHELL 2+: Parent-centric positioning with overlap prevention
      // Each parent's children are anchored near the parent's angle,
      // but sectors are adjusted to prevent cross-parent overlaps.

      // Use per-node spacing based on node type (pathway vs interactor)
      // For pathways, calculate ACTUAL label width to ensure enough arc is allocated
      const getNodeAngularSpacing = (node) => {
        if (node.type === 'pathway') {
          // Approximate width calculation matching the rendering logic
          const fontSize = 14;
          const charWidth = fontSize * 0.55;
          const paddingX = 24;
          const textWidth = (node.label || '').length * charWidth;
          const rectWidth = Math.max(textWidth + paddingX * 2, 120);

          // Convert linear width to arc length (radians)
          // Add 40px gap between pathway boxes
          return (rectWidth + 60) / shellRadius;
        }

        // For interactors (circles)
        const radius = interactorNodeRadius;
        return (radius * 2.5) / shellRadius;
      };

      // Step 1: Group nodes by parent and calculate arc needs
      const byParent = new Map();
      shellNodes.forEach(node => {
        const parentId = node.type === 'pathway'
          ? (node.parentPathwayId || node._isChildOf || SNAP.main)
          : (node._pathwayContext || node._isChildOf || SNAP.main);

        if (!byParent.has(parentId)) {
          byParent.set(parentId, []);
        }
        byParent.get(parentId).push(node);
      });

      // Step 2: Build parent data with angles and arc needs
      const parentData = [];
      for (const [parentId, children] of byParent) {
        // Get parent's angle
        let parentAngle = nodeAngles.get(parentId);
        if (parentAngle === undefined) {
          const baseParentId = parentId.split('@')[0];
          parentAngle = nodeAngles.get(baseParentId);
        }
        if (parentAngle === undefined) {
          const parent = findParentNode(parentId);
          if (parent) {
            parentAngle = parent._shellData?.angle ?? parent._targetAngle;
            if (parentAngle === undefined && parent.x !== undefined) {
              parentAngle = Math.atan2(parent.y - centerY, parent.x - centerX);
            }
          }
        }
        if (parentAngle === undefined) parentAngle = 0;

        // Calculate arc needed for this parent's children
        let arcNeeded = 0;
        children.forEach(child => arcNeeded += getNodeAngularSpacing(child));

        parentData.push({
          parentId,
          parentAngle,
          children,
          arcNeeded,
          sortedChildren: sortChildrenByExternalConnections(children, nodeAngles, parentId)
        });
      }

      // Step 3: Sort parents by angle
      parentData.sort((a, b) => a.parentAngle - b.parentAngle);

      // Step 4: Assign non-overlapping sectors centered on parent angles
      // First pass: calculate ideal sectors (centered on parent, constrained by parent's sector)
      parentData.forEach(pd => {
        // Check if parent has a sector allocation that constrains children
        const parent = findParentNode(pd.parentId);
        const parentSector = parent?._sectorAllocation;

        let idealStart = pd.parentAngle - pd.arcNeeded / 2;
        let idealEnd = pd.parentAngle + pd.arcNeeded / 2;

        // Constrain to parent's sector bounds if available
        // Constrain to parent's sector bounds if available
        if (parentSector) {
          // Centered on parent
          const parentCenter = parentSector.centerAngle;
          idealStart = parentCenter - pd.arcNeeded / 2;
          idealEnd = parentCenter + pd.arcNeeded / 2;

          // DO NOT CLAMP width to parent sector - allow expansion
          // The collision resolution pass below will handle overlaps with neighbors
        }

        pd.idealStart = idealStart;
        pd.idealEnd = idealEnd;
        pd.sectorStart = pd.idealStart;
        pd.sectorEnd = pd.idealEnd;
      });

      // Second pass: resolve overlaps by pushing later sectors
      for (let i = 1; i < parentData.length; i++) {
        const prev = parentData[i - 1];
        const curr = parentData[i];
        if (curr.sectorStart < prev.sectorEnd) {
          // Overlap detected - push current sector forward
          curr.sectorStart = prev.sectorEnd;
          curr.sectorEnd = curr.sectorStart + curr.arcNeeded;
        }
      }

      // Check for wrap-around overlap (last sector overlapping first)
      if (parentData.length > 1) {
        const first = parentData[0];
        const last = parentData[parentData.length - 1];
        const wrapOverlap = (last.sectorEnd - 2 * Math.PI) - first.sectorStart;
        if (wrapOverlap > 0) {
          // Scale all sectors to fit within 2*PI
          const totalArc = last.sectorEnd - first.sectorStart;
          const scale = (2 * Math.PI) / totalArc;
          const baseStart = first.sectorStart;
          parentData.forEach(pd => {
            const relStart = pd.sectorStart - baseStart;
            const relEnd = pd.sectorEnd - baseStart;
            pd.sectorStart = baseStart + relStart * scale;
            pd.sectorEnd = baseStart + relEnd * scale;
            pd.arcNeeded *= scale;
          });
        }
      }

      // Step 5: Position children within each parent's sector
      const parentGroups = new Map();
      parentData.forEach(pd => {
        let currentAngle = pd.sectorStart;
        const arcScale = pd.arcNeeded > 0 ? (pd.sectorEnd - pd.sectorStart) / pd.arcNeeded : 1;

        pd.sortedChildren.forEach(node => {
          const nodeAngularSpan = getNodeAngularSpacing(node) * arcScale;
          const angle = currentAngle + nodeAngularSpan / 2;

          // Position node
          node.x = centerX + shellRadius * Math.cos(angle);
          node.y = centerY + shellRadius * Math.sin(angle);
          node._shellData = { ...node._shellData, angle, radius: shellRadius, shell: shellNum };
          node._targetAngle = angle;
          nodeAngles.set(node.id, angle);
          if (node.originalId) nodeAngles.set(node.originalId, angle);
          const baseId = node.id.split('@')[0];
          if (baseId !== node.id) nodeAngles.set(baseId, angle);
          node.fx = null;
          node.fy = null;

          currentAngle += nodeAngularSpan;
        });

        // Store parent group info for sector allocation
        parentGroups.set(pd.parentId, {
          nodes: pd.sortedChildren,
          startAngle: pd.sectorStart,
          endAngle: pd.sectorEnd
        });
      });

      // Step 6: Assign sector allocations to ALL nodes for their children
      // IMPORTANT: Both pathways AND interactors need sector allocations for equal treatment
      // This ensures when ANY node expands, its children stay in its allocated sector
      shellNodes.forEach(node => {
        // Skip main and function nodes - they don't need sector allocations
        if (node.type === 'main' || node.type === 'function' || node.isFunction) return;

        // Use appropriate parent lookup based on node type
        const parentId = node.type === 'pathway'
          ? (node.parentPathwayId || node._isChildOf || SNAP.main)
          : (node._pathwayContext || node._isChildOf || SNAP.main);
        const parentGroup = parentGroups.get(parentId);

        if (!parentGroup || parentGroup.nodes.length === 0) {
          // Fallback: use node's own angular span
          const span = getNodeAngularSpacing(node);
          node._sectorAllocation = {
            startAngle: node._shellData.angle - span / 2,
            endAngle: node._shellData.angle + span / 2,
            centerAngle: node._shellData.angle,
            arcSpan: span
          };
          return;
        }

        // Sort ALL siblings by their actual angular position
        const sortedSiblings = parentGroup.nodes.slice().sort(
          (a, b) => a._shellData.angle - b._shellData.angle
        );
        const idx = sortedSiblings.findIndex(n => n.id === node.id);

        // Calculate sector bounds as midpoints to adjacent siblings (ANY type)
        // This ensures sectors don't overlap sibling positions
        let sectorStart, sectorEnd;

        if (idx === 0) {
          // First sibling: start from parent group's start
          sectorStart = parentGroup.startAngle;
        } else {
          // Midpoint to previous sibling
          const prev = sortedSiblings[idx - 1];
          sectorStart = (prev._shellData.angle + node._shellData.angle) / 2;
        }

        if (idx === sortedSiblings.length - 1) {
          // Last sibling: end at parent group's end
          sectorEnd = parentGroup.endAngle;
        } else {
          // Midpoint to next sibling
          const next = sortedSiblings[idx + 1];
          sectorEnd = (node._shellData.angle + next._shellData.angle) / 2;
        }

        node._sectorAllocation = {
          startAngle: sectorStart,
          endAngle: sectorEnd,
          centerAngle: node._shellData.angle,
          arcSpan: sectorEnd - sectorStart
        };
      });
    }
  }

  // Position function nodes within parent's allocated arc
  // Uses arc-sector logic with scaled radius based on parent's shell depth
  nodes.forEach(node => {
    if (node.type !== 'function' && !node.isFunction) return;

    const parentId = node.parentProtein || node.id.split('_func_')[0];
    const parent = findParentNode(parentId);
    if (!parent) return;

    // Get all sibling functions for this parent
    const funcNodes = nodes.filter(n =>
      (n.type === 'function' || n.isFunction) &&
      (n.parentProtein === parentId || n.id.startsWith(parentId + '_func_'))
    );
    const funcIdx = funcNodes.indexOf(node);
    const funcTotal = funcNodes.length;

    // Calculate radius based on parent's shell depth
    const parentShell = parent._shellData?.shell || 1;
    const funcRadius = 50 + parentShell * 10;  // Scale with depth

    // Calculate arc span based on function count (max 90°, ~15° per function)
    const baseArcSpan = Math.min(Math.PI / 2, funcTotal * 0.25);
    const parentAngle = parent._shellData?.angle || 0;
    const arcStart = parentAngle - baseArcSpan / 2;
    const arcStep = funcTotal > 1 ? baseArcSpan / (funcTotal - 1) : 0;
    const funcAngle = arcStart + funcIdx * arcStep;

    node.x = parent.x + funcRadius * Math.cos(funcAngle);
    node.y = parent.y + funcRadius * Math.sin(funcAngle);
    node._shellData = {
      shell: parentShell,
      angle: funcAngle,
      parentId: parentId
    };
  });
}

/**
 * Get all nodes currently in a specific shell
 * @param {number} shellNum - Shell number
 * @returns {Array} - Array of nodes in that shell
 */
function getNodesInShell(shellNum) {
  const nodeIds = shellRegistry.get(shellNum);
  if (!nodeIds) return [];
  return Array.from(nodeIds).map(id => nodeMap.get(id)).filter(Boolean);
}

/**
 * Reflow a shell after node addition/removal - redistributes nodes evenly
 * @param {number} shellNum - Shell number to reflow
 */
function reflowShell(shellNum) {
  const shellNodes = getNodesInShell(shellNum);
  if (shellNodes.length === 0) return;

  const centerX = width / 2;
  const centerY = height / 2;

  // Sort for consistent ordering
  shellNodes.sort((a, b) => (a.id || '').localeCompare(b.id || ''));

  shellNodes.forEach((node, idx) => {
    const pos = calculateShellPosition({
      centerX,
      centerY,
      shell: shellNum,
      totalInShell: shellNodes.length,
      indexInShell: idx,
      nodeRadius: node.radius || interactorNodeRadius
    });

    node.x = pos.x;
    node.y = pos.y;
    node._shellData = { ...node._shellData, ...pos };
  });
}

// ============================================================================
// END SHELL-BASED LAYOUT SYSTEM
// ============================================================================

/**
 * Custom D3 force: keep pathway-expanded interactors orbiting their parent pathway
 * This prevents expanded nodes from drifting to center and overlapping
 */
function forcePathwayOrbit() {
  let nodes = [];
  let strength = 0.4;

  function force(alpha) {
    nodes.forEach(node => {
      // Only apply to interactors within expanded pathways
      if (!node._pathwayContext) return;
      if (node.type !== 'interactor') return;
      if (!pathwayMode) return;

      const parent = nodeMap.get(node._pathwayContext);
      if (!parent) return;

      // Calculate current distance from parent pathway
      const dx = node.x - parent.x;
      const dy = node.y - parent.y;
      const dist = Math.sqrt(dx * dx + dy * dy);

      // Calculate target distance based on shell offset from parent
      // Deep pathway interactors orbit further out than shallow ones
      const parentShell = parent._shellData?.shell || 1;
      const nodeShell = node._shellData?.shell || (parentShell + 1);
      const shellOffset = Math.max(1, nodeShell - parentShell);

      // Each shell offset adds ~100px of distance from parent
      const SHELL_OFFSET_DISTANCE = 100;
      const baseTargetDist = shellOffset * SHELL_OFFSET_DISTANCE;

      // Query protein closer to parent, others at full shell-offset distance
      const targetDist = node.isQueryProtein
        ? Math.max(baseTargetDist * 0.6, 60)
        : Math.max(baseTargetDist, 60);

      if (dist === 0) return;

      // Apply radial force toward target orbital distance
      const factor = (dist - targetDist) / dist * alpha * strength;
      node.vx -= dx * factor;
      node.vy -= dy * factor;
    });
  }

  force.initialize = function (_) {
    nodes = _;
  };

  force.strength = function (_) {
    return arguments.length ? (strength = _, force) : strength;
  };

  return force;
}

/**
 * Custom D3 force: constrain ALL interactors to their assigned sector
 * - For pathway interactors: pulls toward sector around parent pathway
 * - For regular interactors: pulls toward sector around canvas center
 * This keeps all interactors organized in their assigned angular positions
 */
function forceSectorConstraint() {
  let nodes = [];
  let strength = 0.3;

  function force(alpha) {
    nodes.forEach(node => {
      // Apply to ALL interactors with assigned angle (not just pathway-expanded)
      if (node.type !== 'interactor') return;
      if (node._targetAngle === undefined) return;

      // Determine reference point: parent pathway or canvas center
      const parent = node._pathwayContext ? nodeMap.get(node._pathwayContext) : null;
      const refX = parent ? parent.x : (width / 2);
      const refY = parent ? parent.y : (height / 2);

      // Calculate target radius based on shell data
      let targetRadius;
      if (parent) {
        // Pathway interactors: use shell-relative distance from parent
        const parentShell = parent._shellData?.shell || 1;
        const nodeShell = node._shellData?.shell || (parentShell + 1);
        const shellOffset = Math.max(1, nodeShell - parentShell);
        const SHELL_OFFSET_DISTANCE = 100;
        targetRadius = node.isQueryProtein
          ? Math.max(shellOffset * SHELL_OFFSET_DISTANCE * 0.6, 50)
          : Math.max(shellOffset * SHELL_OFFSET_DISTANCE, 50);
      } else {
        // Regular interactors: use shell radius from center
        const shellNum = node._shellData?.shell || 1;
        targetRadius = shellRadii[shellNum] || (shellNum * 150 + 100);
      }

      const targetX = refX + targetRadius * Math.cos(node._targetAngle);
      const targetY = refY + targetRadius * Math.sin(node._targetAngle);

      // Apply force toward sector position
      node.vx += (targetX - node.x) * alpha * strength;
      node.vy += (targetY - node.y) * alpha * strength;
    });
  }

  force.initialize = function (_) {
    nodes = _;
  };

  force.strength = function (_) {
    return arguments.length ? (strength = _, force) : strength;
  };

  return force;
}

/**
 * Custom D3 force: pull nodes toward their assigned angular position
 * This creates sector-based layout where nodes are organized by direction
 * Sectors: RIGHT=downstream, BOTTOM=bidirectional, LEFT=upstream, TOP=pathways
 */
function forceAngularPosition() {
  let nodes = [];
  let strength = 0.15;
  let centerX = 0;
  let centerY = 0;

  function force(alpha) {
    nodes.forEach(node => {
      // Skip nodes without target angle
      if (node._targetAngle === undefined || node._targetAngle === null) return;
      // Skip main node (fixed at center)
      if (node.type === 'main') return;
      // Skip function nodes
      if (node.type === 'function' || node.isFunction) return;

      const dx = node.x - centerX;
      const dy = node.y - centerY;
      const currentRadius = Math.sqrt(dx * dx + dy * dy);

      // Don't apply to nodes too close to center
      if (currentRadius < 50) return;

      // Calculate target position at same radius but target angle
      const targetX = centerX + currentRadius * Math.cos(node._targetAngle);
      const targetY = centerY + currentRadius * Math.sin(node._targetAngle);

      // Apply force toward target angle
      node.vx += (targetX - node.x) * alpha * strength;
      node.vy += (targetY - node.y) * alpha * strength;
    });
  }

  force.initialize = function (_) {
    nodes = _;
  };

  force.strength = function (_) {
    return arguments.length ? (strength = _, force) : strength;
  };

  force.center = function (x, y) {
    centerX = x;
    centerY = y;
    return force;
  };

  return force;
}

/**
 * Highlight all nodes in a pathway cluster (for hover effect)
 * @param {string} pathwayId - The pathway ID whose cluster should be highlighted
 */
function highlightCluster(pathwayId) {
  // Highlight all nodes in cluster (same _pathwayContext or is the pathway itself)
  d3.selectAll('.node-group').each(function () {
    const nd = d3.select(this).datum();
    if (nd._pathwayContext === pathwayId || nd.id === pathwayId) {
      // Highlight cluster members
      d3.select(this).select('circle, rect')
        .style('filter', 'url(#nodeGlow)')
        .style('stroke', '#fbbf24')
        .style('stroke-width', '3px');
    } else if (nd._pathwayContext || nd.type === 'pathway') {
      // Dim other pathway-related nodes
      d3.select(this).style('opacity', 0.3);
    }
  });

  // Highlight links in cluster
  d3.selectAll('.link').each(function () {
    const ld = d3.select(this).datum();
    const srcCtx = ld.source?._pathwayContext || (typeof ld.source === 'object' ? ld.source._pathwayContext : null);
    const tgtCtx = ld.target?._pathwayContext || (typeof ld.target === 'object' ? ld.target._pathwayContext : null);
    const srcId = typeof ld.source === 'object' ? ld.source.id : ld.source;
    const tgtId = typeof ld.target === 'object' ? ld.target.id : ld.target;

    if (srcCtx === pathwayId || tgtCtx === pathwayId || srcId === pathwayId || tgtId === pathwayId) {
      d3.select(this).style('opacity', 1).style('stroke-width', '3px');
    }
  });
}

/**
 * Clear cluster highlighting (reset to normal state)
 */
function clearClusterHighlight() {
  // Reset all nodes
  d3.selectAll('.node-group')
    .style('opacity', null)
    .select('circle, rect')
    .style('filter', null)
    .style('stroke', null)
    .style('stroke-width', null);

  // Reset all links
  d3.selectAll('.link')
    .style('opacity', null)
    .style('stroke-width', null);
}

/**
 * Assign sector and target angle to a node based on its direction relative to main
 * @param {string} direction - 'main_to_primary' (downstream), 'primary_to_main' (upstream), 'bidirectional'
 * @param {number} indexInSector - Position within sector (for spreading nodes)
 * @param {number} totalInSector - Total nodes in this sector
 * @returns {Object} - { sector, targetAngle }
 */
function assignSectorAndAngle(direction, indexInSector, totalInSector) {
  // Sector definitions (angles in radians)
  // RIGHT (315° to 45°): downstream - main acts ON these proteins
  // BOTTOM (45° to 135°): bidirectional
  // LEFT (135° to 225°): upstream - these proteins act ON main
  // TOP (225° to 315°): reserved for pathway connections

  const sectors = {
    downstream: { start: -Math.PI / 4, end: Math.PI / 4, sector: 0 },      // RIGHT
    bidirectional: { start: Math.PI / 4, end: 3 * Math.PI / 4, sector: 1 }, // BOTTOM
    upstream: { start: 3 * Math.PI / 4, end: 5 * Math.PI / 4, sector: 2 },  // LEFT (wraps to -3π/4)
    pathway: { start: -3 * Math.PI / 4, end: -Math.PI / 4, sector: 3 }      // TOP
  };

  let sectorInfo;
  if (direction === 'main_to_primary') {
    sectorInfo = sectors.downstream;
  } else if (direction === 'primary_to_main') {
    sectorInfo = sectors.upstream;
  } else {
    sectorInfo = sectors.bidirectional;
  }

  // Calculate angle within sector
  let targetAngle;
  if (totalInSector <= 1) {
    // Single node: center of sector
    targetAngle = (sectorInfo.start + sectorInfo.end) / 2;
  } else {
    // Multiple nodes: spread evenly within sector
    const sectorSpan = sectorInfo.end - sectorInfo.start;
    const padding = sectorSpan * 0.1; // 10% padding on each edge
    const usableSpan = sectorSpan - 2 * padding;
    const step = usableSpan / (totalInSector - 1);
    targetAngle = sectorInfo.start + padding + indexInSector * step;
  }

  return { sector: sectorInfo.sector, targetAngle };
}

/**
 * Rebuilds the node lookup map for O(1) access
 * Call this after any operation that modifies the nodes array
 */
function rebuildNodeMap() {
  nodeMap.clear();
  nodes.forEach(n => nodeMap.set(n.id, n));
}

function initNetwork() {
  const container = document.getElementById('network');
  if (!container) return;

  const fallbackWidth = Math.max(window.innerWidth * 0.75, 960);
  const fallbackHeight = Math.max(window.innerHeight * 0.65, 640);
  width = container.clientWidth || fallbackWidth;
  height = container.clientHeight || fallbackHeight;

  svg = d3.select('#svg').attr('width', width).attr('height', height);

  graphInitialFitDone = false;
  if (fitToViewTimer) {
    clearTimeout(fitToViewTimer);
    fitToViewTimer = null;
  }

  zoomBehavior = d3.zoom()
    .scaleExtent([0.35, 2.8])
    .on('zoom', (ev) => {
      if (g) {
        g.attr('transform', ev.transform);
      }
      currentZoom = ev.transform.k;
    });

  svg.call(zoomBehavior);
  g = svg.append('g');

  // DEPTH INDICATOR BANDS: Subtle concentric rings showing hierarchy levels
  const depthBands = [
    { radius: SHELL_RADIUS_BASE, label: 'Direct', opacity: 0.025 },      // 250px
    { radius: SHELL_RADIUS_EXPANDED, label: 'Expanded', opacity: 0.018 }, // 350px
    { radius: SHELL_RADIUS_CHILDREN, label: 'Secondary', opacity: 0.012 } // 450px
  ];

  const bandGroup = g.append('g').attr('class', 'depth-bands');
  bandGroup.selectAll('circle')
    .data(depthBands)
    .enter()
    .append('circle')
    .attr('cx', width / 2)
    .attr('cy', height / 2)
    .attr('r', d => d.radius)
    .attr('fill', 'none')
    .attr('stroke', d => `rgba(140, 120, 200, ${d.opacity})`)
    .attr('stroke-width', 35)
    .attr('stroke-dasharray', '6,12')
    .style('pointer-events', 'none');

  // Arrowheads
  const defs = svg.append('defs');
  ['activate', 'inhibit', 'binding'].forEach(type => {
    const color = type === 'activate' ? '#059669' : type === 'inhibit' ? '#dc2626' : '#7c3aed';
    if (type === 'activate') {
      defs.append('marker').attr('id', 'arrow-activate').attr('viewBox', '0 -5 10 10').attr('refX', 10).attr('refY', 0)
        .attr('markerWidth', 10).attr('markerHeight', 10).attr('orient', 'auto')
        .append('path').attr('d', 'M0,-5L10,0L0,5L3,0Z').attr('fill', color);
    } else if (type === 'inhibit') {
      defs.append('marker').attr('id', 'arrow-inhibit').attr('viewBox', '0 -5 10 10').attr('refX', 10).attr('refY', 0)
        .attr('markerWidth', 10).attr('markerHeight', 10).attr('orient', 'auto')
        .append('rect').attr('x', 6).attr('y', -4).attr('width', 3).attr('height', 8).attr('fill', color);
    } else {
      const m = defs.append('marker').attr('id', 'arrow-binding').attr('viewBox', '0 -5 10 10').attr('refX', 10).attr('refY', 0)
        .attr('markerWidth', 10).attr('markerHeight', 10).attr('orient', 'auto');
      m.append('rect').attr('x', 4).attr('y', -4).attr('width', 2).attr('height', 8).attr('fill', color);
      m.append('rect').attr('x', 7).attr('y', -4).attr('width', 2).attr('height', 8).attr('fill', color);
    }
  });
  // Distinct marker for 'regulates' (amber diamond)
  const reg = defs.append('marker')
    .attr('id', 'arrow-regulate')
    .attr('viewBox', '0 -5 10 10')
    .attr('refX', 10)
    .attr('refY', 0)
    .attr('markerWidth', 10)
    .attr('markerHeight', 10)
    .attr('orient', 'auto');
  reg.append('path')
    .attr('d', 'M0,0 L5,-4 L10,0 L5,4 Z')
    .attr('fill', '#d97706');

  // Node Gradients - Light Mode
  const mainGrad = defs.append('radialGradient').attr('id', 'mainGradient');
  mainGrad.append('stop').attr('offset', '0%').attr('stop-color', '#6366f1');
  mainGrad.append('stop').attr('offset', '100%').attr('stop-color', '#4338ca');

  const interactorGrad = defs.append('radialGradient').attr('id', 'interactorGradient');
  interactorGrad.append('stop').attr('offset', '0%').attr('stop-color', '#525252');
  interactorGrad.append('stop').attr('offset', '100%').attr('stop-color', '#404040');

  // Node Gradients - Dark Mode
  const mainGradDark = defs.append('radialGradient').attr('id', 'mainGradientDark');
  mainGradDark.append('stop').attr('offset', '0%').attr('stop-color', '#818cf8');
  mainGradDark.append('stop').attr('offset', '100%').attr('stop-color', '#6366f1');

  const interactorGradDark = defs.append('radialGradient').attr('id', 'interactorGradientDark');
  interactorGradDark.append('stop').attr('offset', '0%').attr('stop-color', '#404040');
  interactorGradDark.append('stop').attr('offset', '100%').attr('stop-color', '#262626');

  // Expanded Node Gradients - Distinct from main, darker glow
  const expandedGrad = defs.append('radialGradient').attr('id', 'expandedGradient');
  expandedGrad.append('stop').attr('offset', '0%').attr('stop-color', '#c7d2fe'); // Light indigo (indigo-200)
  expandedGrad.append('stop').attr('offset', '100%').attr('stop-color', '#a5b4fc'); // Light indigo (indigo-300)

  const expandedGradDark = defs.append('radialGradient').attr('id', 'expandedGradientDark');
  expandedGradDark.append('stop').attr('offset', '0%').attr('stop-color', '#a5b4fc'); // Light indigo (indigo-300)
  expandedGradDark.append('stop').attr('offset', '100%').attr('stop-color', '#818cf8'); // Light indigo (indigo-400)

  // Pathway Node Gradients - Light Mode (purple/violet theme)
  const pathwayGrad = defs.append('radialGradient').attr('id', 'pathwayGradient');
  pathwayGrad.append('stop').attr('offset', '0%').attr('stop-color', '#8b5cf6'); // violet-500
  pathwayGrad.append('stop').attr('offset', '100%').attr('stop-color', '#7c3aed'); // violet-600

  // Pathway Node Gradients - Dark Mode
  const pathwayGradDark = defs.append('radialGradient').attr('id', 'pathwayGradientDark');
  pathwayGradDark.append('stop').attr('offset', '0%').attr('stop-color', '#a78bfa'); // violet-400
  pathwayGradDark.append('stop').attr('offset', '100%').attr('stop-color', '#8b5cf6'); // violet-500

  // Pathway Expanded Gradients - Light Mode (brighter when expanded)
  const pathwayExpandedGrad = defs.append('radialGradient').attr('id', 'pathwayExpandedGradient');
  pathwayExpandedGrad.append('stop').attr('offset', '0%').attr('stop-color', '#c4b5fd'); // violet-300
  pathwayExpandedGrad.append('stop').attr('offset', '100%').attr('stop-color', '#a78bfa'); // violet-400

  // Pathway Expanded Gradients - Dark Mode
  const pathwayExpandedGradDark = defs.append('radialGradient').attr('id', 'pathwayExpandedGradientDark');
  pathwayExpandedGradDark.append('stop').attr('offset', '0%').attr('stop-color', '#c4b5fd'); // violet-300
  pathwayExpandedGradDark.append('stop').attr('offset', '100%').attr('stop-color', '#a78bfa'); // violet-400

  // ========== SEMANTIC NODE GRADIENTS (by interaction type) ==========
  // Activates - Green gradient
  const activatesGrad = defs.append('radialGradient').attr('id', 'gradient-activates');
  activatesGrad.append('stop').attr('offset', '0%').attr('stop-color', '#34d399');  // emerald-400
  activatesGrad.append('stop').attr('offset', '100%').attr('stop-color', '#10b981'); // emerald-500

  const activatesGradDark = defs.append('radialGradient').attr('id', 'gradient-activates-dark');
  activatesGradDark.append('stop').attr('offset', '0%').attr('stop-color', '#6ee7b7'); // emerald-300
  activatesGradDark.append('stop').attr('offset', '100%').attr('stop-color', '#34d399'); // emerald-400

  // Inhibits - Red gradient
  const inhibitsGrad = defs.append('radialGradient').attr('id', 'gradient-inhibits');
  inhibitsGrad.append('stop').attr('offset', '0%').attr('stop-color', '#f87171');  // red-400
  inhibitsGrad.append('stop').attr('offset', '100%').attr('stop-color', '#ef4444'); // red-500

  const inhibitsGradDark = defs.append('radialGradient').attr('id', 'gradient-inhibits-dark');
  inhibitsGradDark.append('stop').attr('offset', '0%').attr('stop-color', '#fca5a5'); // red-300
  inhibitsGradDark.append('stop').attr('offset', '100%').attr('stop-color', '#f87171'); // red-400

  // Binds - Purple gradient
  const bindsGrad = defs.append('radialGradient').attr('id', 'gradient-binds');
  bindsGrad.append('stop').attr('offset', '0%').attr('stop-color', '#a78bfa');  // violet-400
  bindsGrad.append('stop').attr('offset', '100%').attr('stop-color', '#8b5cf6'); // violet-500

  const bindsGradDark = defs.append('radialGradient').attr('id', 'gradient-binds-dark');
  bindsGradDark.append('stop').attr('offset', '0%').attr('stop-color', '#c4b5fd'); // violet-300
  bindsGradDark.append('stop').attr('offset', '100%').attr('stop-color', '#a78bfa'); // violet-400

  // Regulates - Amber gradient
  const regulatesGrad = defs.append('radialGradient').attr('id', 'gradient-regulates');
  regulatesGrad.append('stop').attr('offset', '0%').attr('stop-color', '#fbbf24');  // amber-400
  regulatesGrad.append('stop').attr('offset', '100%').attr('stop-color', '#f59e0b'); // amber-500

  const regulatesGradDark = defs.append('radialGradient').attr('id', 'gradient-regulates-dark');
  regulatesGradDark.append('stop').attr('offset', '0%').attr('stop-color', '#fcd34d'); // amber-300
  regulatesGradDark.append('stop').attr('offset', '100%').attr('stop-color', '#fbbf24'); // amber-400

  // Node glow filter for hover effects
  const glowFilter = defs.append('filter').attr('id', 'nodeGlow').attr('x', '-50%').attr('y', '-50%').attr('width', '200%').attr('height', '200%');
  glowFilter.append('feGaussianBlur').attr('stdDeviation', '3').attr('result', 'blur');
  const glowMerge = glowFilter.append('feMerge');
  glowMerge.append('feMergeNode').attr('in', 'blur');
  glowMerge.append('feMergeNode').attr('in', 'SourceGraphic');

  buildInitialGraph();
  // snapshot base graph ids (non-removable)
  baseNodes = new Set(nodes.map(n => n.id));
  baseLinks = new Set(links.map(l => l.id));
  // PERFORMANCE: Cache main node reference for O(1) lookup in calculateLinkPath
  cachedMainNode = nodes.find(n => n.type === 'main');
  // PERFORMANCE: Build node lookup map for O(1) access
  rebuildNodeMap();
  createSimulation();
}

// calculateSpacing function removed - logic now inline in buildInitialGraph()

/**
 * Get the gradient ID for a node based on its interaction type
 * @param {Object} node - The node object
 * @returns {string} - The gradient URL (e.g., 'url(#gradient-activates)')
 */
function getNodeGradient(node) {
  const isDark = document.body.classList.contains('dark-mode');

  // Main node uses main gradient
  if (node.type === 'main') {
    return isDark ? 'url(#mainGradientDark)' : 'url(#mainGradient)';
  }

  // Pathway node uses pathway gradient
  if (node.type === 'pathway') {
    if (node.expanded) {
      return isDark ? 'url(#pathwayExpandedGradientDark)' : 'url(#pathwayExpandedGradient)';
    }
    return isDark ? 'url(#pathwayGradientDark)' : 'url(#pathwayGradient)';
  }

  // Interactor nodes use semantic gradient based on their interaction type
  const arrow = node.arrow || 'binds';
  const suffix = isDark ? '-dark' : '';

  switch (arrow) {
    case 'activates': return `url(#gradient-activates${suffix})`;
    case 'inhibits': return `url(#gradient-inhibits${suffix})`;
    case 'regulates': return `url(#gradient-regulates${suffix})`;
    case 'binds':
    default: return `url(#gradient-binds${suffix})`;
  }
}

/**
 * Get the CSS class for a node based on its interaction type (for styling)
 */
function getNodeArrowClass(node) {
  if (node.type !== 'interactor') return '';
  const arrow = node.arrow || 'binds';
  return `interactor-${arrow}`;
}

function arrowKind(rawArrow, intent, direction) {
  const arrowValue = (rawArrow || '').toString().trim().toLowerCase();
  const intentValue = (intent || '').toString().trim().toLowerCase();

  // Comprehensive activation terms
  const activateTerms = ['activate', 'activates', 'activation', 'enhance', 'enhances', 'promote', 'promotes', 'upregulate', 'upregulates', 'stabilize', 'stabilizes'];
  // Comprehensive inhibition terms
  const inhibitTerms = ['inhibit', 'inhibits', 'inhibition', 'suppress', 'suppresses', 'repress', 'represses', 'downregulate', 'downregulates', 'block', 'blocks', 'reduce', 'reduces'];

  // Check arrow value for activation
  if (activateTerms.some(term => arrowValue.includes(term))) {
    return 'activates';
  }
  // Check arrow value for inhibition
  if (inhibitTerms.some(term => arrowValue.includes(term))) {
    return 'inhibits';
  }
  // Regulation/modulation normalization
  if (arrowValue === 'regulates' || arrowValue.includes('regulat') || arrowValue === 'modulates' || arrowValue.includes('modulat')) {
    return 'regulates';
  }
  // Exact binding match
  if (arrowValue === 'binds' || arrowValue === 'binding') {
    return 'binds';
  }
  // Additional arrow value checks
  if (arrowValue === 'activator' || arrowValue === 'positive') {
    return 'activates';
  }
  if (arrowValue === 'negative') {
    return 'inhibits';
  }
  // If arrow is undirected/unknown, check intent
  if (!arrowValue || ['undirected', 'unknown', 'none', 'na', 'n/a', 'bidirectional', 'both', 'reciprocal', 'neutral'].includes(arrowValue)) {
    if (intentValue === 'activation' || intentValue === 'activates') return 'activates';
    if (intentValue === 'inhibition' || intentValue === 'inhibits') return 'inhibits';
    if (intentValue === 'regulation' || intentValue === 'modulation' || intentValue === 'regulates' || intentValue === 'modulates') return 'regulates';
    if (intentValue === 'binding') return 'binds';
    return 'binds';
  }
  // Check intent as fallback
  if (intentValue === 'binding') {
    return 'binds';
  }
  if (intentValue === 'activation') {
    return 'activates';
  }
  if (intentValue === 'inhibition') {
    return 'inhibits';
  }
  // Final fallback
  return ['activates', 'inhibits', 'binds', 'regulates'].includes(arrowValue) ? arrowValue : 'binds';
}

function isBiDir(dir) {
  const v = (dir || '').toLowerCase();
  return v === 'bidirectional' || v === 'undirected' || v === 'both' || v === 'reciprocal';
}

/**
 * Calculate node depths using breadth-first search from main protein.
 * Ignores backend metadata (depth, interaction_type) - uses only graph structure.
 *
 * @param {Array} interactions - Array of interaction objects with source/target
 * @param {string} mainProtein - ID of the main protein node
 * @returns {Map<string, number>} Map of nodeId → depth (distance from main)
 */
function calculateDepthsFromGraph(interactions, mainProtein) {
  const depthMap = new Map();
  const queue = [];
  const visited = new Set();

  // Start BFS from main protein
  depthMap.set(mainProtein, 0);
  queue.push(mainProtein);
  visited.add(mainProtein);

  while (queue.length > 0) {
    const currentNode = queue.shift();
    const currentDepth = depthMap.get(currentNode);

    // Find all neighbors of currentNode
    interactions.forEach(interaction => {
      const source = interaction.source;
      const target = interaction.target;

      // Determine neighbor (the other endpoint)
      let neighbor = null;
      if (source === currentNode) {
        neighbor = target;
      } else if (target === currentNode) {
        neighbor = source;
      } else {
        return; // This interaction doesn't involve currentNode
      }

      // Skip if already visited (first visit = shortest path)
      if (visited.has(neighbor)) {
        return;
      }

      // Set depth and mark as visited
      const newDepth = currentDepth + 1;
      depthMap.set(neighbor, newDepth);
      visited.add(neighbor);
      queue.push(neighbor);
    });
  }

  return depthMap;
}

/**
 * Filter interactions based on view mode to handle duplicates (NET vs DIRECT)
 */
function filterInteractionsByViewMode(interactions) {
  const mode = getCurrentViewMode ? getCurrentViewMode() : 'direct';

  if (mode === 'both') {
    return interactions;  // Show everything
  }

  // Group interactions by source-target pair (normalized alphabetically)
  const pairMap = new Map();  // "PROTEIN1::PROTEIN2" -> [interactions]

  interactions.forEach(int => {
    const src = int.source;
    const tgt = int.target;
    if (!src || !tgt) return;

    // Create normalized key (alphabetical order for consistency)
    const pairKey = src < tgt ? `${src}::${tgt}` : `${tgt}::${src}`;

    if (!pairMap.has(pairKey)) {
      pairMap.set(pairKey, []);
    }
    pairMap.get(pairKey).push(int);
  });

  // Filter each group based on view mode
  const filtered = [];
  pairMap.forEach((group, pairKey) => {
    if (group.length === 1) {
      // Only one interaction for this pair - always include it
      filtered.push(group[0]);
      return;
    }

    // Multiple interactions for same pair - apply filtering
    if (mode === 'direct') {
      // Prefer DIRECT mediator links over NET effects
      const directLink = group.find(int =>
        int._direct_mediator_link ||
        int.function_context === 'direct' ||
        (int.data && int.data.function_context === 'direct')
      );

      if (directLink) {
        filtered.push(directLink);  // Show DIRECT link only
      } else {
        // No direct link found - show first NET effect or regular interaction
        const netEffect = group.find(int =>
          int._net_effect ||
          int.function_context === 'net' ||
          (int.data && int.data.function_context === 'net')
        );
        filtered.push(netEffect || group[0]);
      }
    } else if (mode === 'net') {
      // Prefer NET effects over DIRECT links
      const netEffect = group.find(int =>
        int._net_effect ||
        int.function_context === 'net' ||
        (int.data && int.data.function_context === 'net')
      );

      if (netEffect) {
        filtered.push(netEffect);  // Show NET effect only
      } else {
        // No net effect found - show first DIRECT link or regular interaction
        const directLink = group.find(int =>
          int._direct_mediator_link ||
          int.function_context === 'direct' ||
          (int.data && int.data.function_context === 'direct')
        );
        filtered.push(directLink || group[0]);
      }
    }
  });

  console.log(`🔍 View mode: ${mode} - Filtered ${interactions.length} → ${filtered.length} interactions`);
  return filtered;
}

function buildInitialGraph() {
  // Clear arrays to prevent duplicates on refresh
  nodes = [];
  links = [];
  expandedPathways.clear();
  pathwayToInteractors.clear();

  // NEW: Use proteins array for node creation, interactions array for links
  let proteins = SNAP.proteins || [];
  let interactions = SNAP.interactions || [];
  let pathways = SNAP.pathways || [];

  // INTERACTOR MODE FIX: If pathways exist but proteins array is empty,
  // extract all unique proteins from pathway interactor_ids
  if (proteins.length <= 1 && pathways.length > 0) {
    const extractedProteins = new Set([SNAP.main]);
    pathways.forEach(pw => {
      (pw.interactor_ids || []).forEach(id => extractedProteins.add(id));
      // Also extract from interactions within pathways
      (pw.interactions || []).forEach(inter => {
        if (inter.source) extractedProteins.add(inter.source);
        if (inter.target) extractedProteins.add(inter.target);
      });
    });
    proteins = Array.from(extractedProteins);
    console.log(`📦 Extracted ${proteins.length} proteins from pathways for interactor mode`);
  }

  // Also extract interactions from pathways if main interactions array is empty
  if (interactions.length === 0 && pathways.length > 0) {
    const extractedInteractions = [];
    pathways.forEach(pw => {
      (pw.interactions || []).forEach(inter => {
        extractedInteractions.push(inter);
      });
    });
    interactions = extractedInteractions;
    console.log(`📦 Extracted ${interactions.length} interactions from pathways for interactor mode`);
  }

  // FALLBACK: Transform old cache format (interactors with primary) to new format (interactions with source/target)
  if ((proteins.length === 0 || interactions.length === 0) && SNAP.interactors && SNAP.interactors.length > 0) {
    console.log('📦 Transforming old cache format to new format...');
    proteins = [SNAP.main];
    interactions = [];

    SNAP.interactors.forEach(interactor => {
      const primary = interactor.primary;
      if (primary && !proteins.includes(primary)) {
        proteins.push(primary);
      }
      // For indirect interactors, also add the mediator protein if not present
      if (interactor.interaction_type === 'indirect' && interactor.upstream_interactor) {
        if (!proteins.includes(interactor.upstream_interactor)) {
          proteins.push(interactor.upstream_interactor);
        }
      }
      // Transform to new format: copy all fields and add source/target
      // FIX: Respect direction field when setting source/target
      // - primary_to_main: interactor acts ON query (source=interactor, target=query)
      // - main_to_primary: query acts ON interactor (source=query, target=interactor)
      // - For indirect: source is the upstream_interactor (mediator)
      let source, target;
      if (interactor.interaction_type === 'indirect' && interactor.upstream_interactor) {
        // Indirect: source is the mediator, target is this interactor
        source = interactor.upstream_interactor;
        target = primary;
      } else if (interactor.direction === 'primary_to_main') {
        // Interactor acts on query protein (upstream)
        source = primary;
        target = SNAP.main;
      } else {
        // Query acts on interactor (downstream) or bidirectional/undefined
        source = SNAP.main;
        target = primary;
      }
      interactions.push({
        ...interactor,
        source: source,
        target: target
      });
    });

    // Store transformed data back to SNAP for other functions to use
    SNAP.proteins = proteins;
    SNAP.interactions = interactions;
    console.log(`✅ Transformed ${interactions.length} interactors to new format`);
  }

  // Filter interactions based on view mode (NET vs DIRECT)
  interactions = filterInteractionsByViewMode(interactions);

  if (!SNAP.main || proteins.length === 0) {
    console.error('❌ buildInitialGraph: Missing data');
    const networkDiv = document.getElementById('network');
    if (networkDiv) {
      networkDiv.innerHTML = `
          <div style="padding: 60px 40px; text-align: center; color: #ef4444; font-family: system-ui, sans-serif;">
            <h2 style="font-size: 24px; margin-bottom: 16px;">⚠️ No Interaction Data Available</h2>
            <p style="font-size: 16px; color: #6b7280; margin-bottom: 8px;">
              ${SNAP.main ? `Protein: <strong>${SNAP.main}</strong>` : 'Unknown protein'}
            </p>
          </div>
        `;
    }
    return;
  }

  // Create main protein node (always at center)
  nodes.push({
    id: SNAP.main,
    label: SNAP.main,
    type: 'main',
    radius: mainNodeRadius,
    x: width / 2,
    y: height / 2,
    fx: width / 2,
    fy: height / 2
  });

  // Check if pathway mode should be enabled (respect user override)
  if (userModeOverride !== null) {
    pathwayMode = userModeOverride === 'pathway';
  } else {
    pathwayMode = pathways.length > 0;
  }

  // Show/hide mode toggle based on data availability
  const modeToggle = document.getElementById('mode-toggle');
  if (modeToggle) {
    modeToggle.style.display = pathways.length > 0 ? 'flex' : 'none';
    // Update button states to match current mode
    const pathwayBtn = document.getElementById('mode-pathway');
    const interactorBtn = document.getElementById('mode-interactor');
    if (pathwayBtn) pathwayBtn.classList.toggle('active', pathwayMode);
    if (interactorBtn) interactorBtn.classList.toggle('active', !pathwayMode);
  }

  if (pathwayMode) {
    // PATHWAY MODE: Hierarchical pathway visualization
    console.log(`🛤️ Pathway mode enabled: ${pathways.length} total pathways`);

    // Store all pathway data for later expansion
    allPathwaysData = pathways;
    window.allPathwaysData = pathways; // EXPOSE FOR CARD VIEW

    // Build hierarchy maps from pathway data
    pathwayHierarchy.clear();
    pathwayToChildren.clear();

    pathways.forEach(pw => {
      const pathwayId = pw.id || `pathway_${pw.name.replace(/\s+/g, '_')}`;

      // Store hierarchy info for this pathway
      pathwayHierarchy.set(pathwayId, {
        level: pw.hierarchy_level || 0,
        is_leaf: pw.is_leaf ?? true,
        parent_ids: pw.parent_pathway_ids || [],
        child_ids: pw.child_pathway_ids || [],
        ancestry: pw.ancestry || [pw.name]
      });

      // Build parent-child map for quick lookup
      (pw.child_pathway_ids || []).forEach(childId => {
        if (!pathwayToChildren.has(pathwayId)) {
          pathwayToChildren.set(pathwayId, new Set());
        }
        pathwayToChildren.get(pathwayId).add(childId);
      });

      // Store interactor mapping for expansion
      pathwayToInteractors.set(pathwayId, new Set(pw.interactor_ids || []));

      // Store full interaction objects for leaf pathway expansion
      // This enables rendering actual interaction edges (not just proteins) inside pathways
      if (pw.interactions && pw.interactions.length > 0) {
        pathwayToInteractions.set(pathwayId, pw.interactions);
      }
    });

    // EXPOSE MAPS FOR CARD VIEW
    window.pathwayHierarchy = pathwayHierarchy;
    window.pathwayToChildren = pathwayToChildren;
    window.pathwayToInteractors = pathwayToInteractors;

    // Count root-level pathways (for logging)
    const rootPathways = pathways.filter(pw => (pw.hierarchy_level || 0) === 0);
    console.log(`🌳 Found ${rootPathways.length} root pathways (of ${pathways.length} total)`);

    // OPTION A: Empty start - don't create any pathway nodes initially
    // User will select which pathways to display via the sidebar
    console.log(`📋 Pathway mode: Empty start - use sidebar to select pathways`);

    // Initialize sidebar after a short delay (to ensure DOM is ready)
    setTimeout(() => {
      initPathwaySidebar();
    }, 100);

    // SKIP creating pathway nodes here - sidebar controls visibility
    // The old code that created nodes immediately is replaced with sidebar-based selection
    /*
    rootPathways.forEach((pw, idx) => {
      const pathwayId = pw.id || `pathway_${pw.name.replace(/\s+/g, '_')}`;
      const angle = (idx / rootPathways.length) * 2 * Math.PI - Math.PI / 2;
      const x = width / 2 + pathwayRingRadius * Math.cos(angle);
      const y = height / 2 + pathwayRingRadius * Math.sin(angle);
 
      const hier = pathwayHierarchy.get(pathwayId);
      const level = hier?.level || 0;
      const sizing = PATHWAY_SIZES[Math.min(level, 3)];
 
      // Create pathway node with hierarchy info
      nodes.push({
        id: pathwayId,
        label: pw.name,
        type: 'pathway',
        radius: sizing.radius,
        hierarchyLevel: level,
        isLeaf: hier?.is_leaf ?? true,
        childPathwayIds: hier?.child_ids || [],
        ancestry: hier?.ancestry || [pw.name],
        interactorIds: pw.interactor_ids || [],
        ontologyId: pw.ontology_id,
        ontologySource: pw.ontology_source,
        interactionCount: pw.interaction_count || 0,
        expanded: false,
        hierarchyExpanded: false,
        x: x,
        y: y
      });
 
      // Create link from main to pathway
      links.push({
        id: `${SNAP.main}-${pathwayId}`,
        source: SNAP.main,
        target: pathwayId,
        type: 'pathway-link',
        arrow: 'pathway'
      });
    });
    */
  } else {
    // STANDARD MODE: Create interactor nodes directly
    // First, build a map of protein -> interaction arrow for semantic coloring
    const proteinArrowMap = new Map();
    interactions.forEach(interaction => {
      const src = interaction.source;
      const tgt = interaction.target;
      const arrow = arrowKind(interaction.arrow, interaction.intent, interaction.direction);
      // Store arrow for both proteins (we want the arrow for their interaction with main)
      if (src === SNAP.main) proteinArrowMap.set(tgt, { arrow, data: interaction });
      if (tgt === SNAP.main) proteinArrowMap.set(src, { arrow, data: interaction });
    });

    // SECTOR-BASED POSITIONING: Organize nodes by direction relative to main protein
    // Upstream (LEFT), Downstream (RIGHT), Bidirectional (BOTTOM)
    const nonMainProteins = proteins.filter(p => p !== SNAP.main);

    // Classify proteins by direction using existing helper
    const { upstream, downstream, bidirectional } = getProteinsByRole(interactions, SNAP.main);

    // Convert to arrays with indices for angle calculation
    const upstreamArr = Array.from(upstream);
    const downstreamArr = Array.from(downstream);
    const bidirectionalArr = Array.from(bidirectional);

    // Track sector assignments for each protein
    const proteinSectorMap = new Map();
    upstreamArr.forEach((p, idx) => proteinSectorMap.set(p, { direction: 'primary_to_main', idx, total: upstreamArr.length }));
    downstreamArr.forEach((p, idx) => proteinSectorMap.set(p, { direction: 'main_to_primary', idx, total: downstreamArr.length }));
    bidirectionalArr.forEach((p, idx) => proteinSectorMap.set(p, { direction: 'bidirectional', idx, total: bidirectionalArr.length }));

    nonMainProteins.forEach((p) => {
      const interactionInfo = proteinArrowMap.get(p);
      const sectorInfo = proteinSectorMap.get(p);

      // Calculate sector and angle
      let angle, sector;
      if (sectorInfo) {
        const assignment = assignSectorAndAngle(sectorInfo.direction, sectorInfo.idx, sectorInfo.total);
        angle = assignment.targetAngle;
        sector = assignment.sector;
      } else {
        // Fallback: unclassified proteins go to bidirectional sector
        const fallbackIdx = bidirectionalArr.length;
        const assignment = assignSectorAndAngle('bidirectional', fallbackIdx, fallbackIdx + 1);
        angle = assignment.targetAngle;
        sector = assignment.sector;
      }

      const x = width / 2 + SHELL_RADIUS_BASE * Math.cos(angle);
      const y = height / 2 + SHELL_RADIUS_BASE * Math.sin(angle);

      nodes.push({
        id: p,
        label: p,
        type: 'interactor',
        radius: interactorNodeRadius,
        arrow: interactionInfo?.arrow || 'binds',  // Semantic coloring
        interactionData: interactionInfo?.data,
        direction: sectorInfo?.direction || 'bidirectional',  // Store direction for reference
        _sector: sector,           // Sector index (0-3)
        _targetAngle: angle,       // Target angle for angular force
        x: x,
        y: y
      });
    });

    // Rebuild node map for O(1) access
    rebuildNodeMap();

    // Create interaction links (only in standard mode)
    const linkIds = new Set();
    interactions.forEach(interaction => {
      const source = interaction.source;
      const target = interaction.target;

      if (!source || !target) return;
      if (!nodeMap.has(source) || !nodeMap.has(target)) return;

      const arrow = arrowKind(interaction.arrow, interaction.intent, interaction.direction);
      const linkId = `${source}-${target}-${arrow}`;

      if (linkIds.has(linkId)) return;

      links.push({
        id: linkId,
        source: source,
        target: target,
        type: 'interaction',
        arrow: arrow,
        direction: interaction.direction,
        data: interaction,
        isBidirectional: false
      });
      linkIds.add(linkId);
    });
  }

  // Rebuild node map after all nodes created
  rebuildNodeMap();

  // Calculate depths (bfs)
  depthMap.clear();
  const calculatedDepths = calculateDepthsFromGraph(interactions, SNAP.main);
  calculatedDepths.forEach((depth, nodeId) => depthMap.set(nodeId, depth));
}

/**
 * Resolve initial node overlaps BEFORE simulation starts
 * Uses spatial hash for O(n log n) collision detection
 * Iteratively pushes overlapping nodes apart
 */
function resolveInitialOverlaps() {
  const MAX_ITERATIONS = 20;
  const MIN_SEPARATION = interactorNodeRadius * 2.5;  // ~80px - consistent with MIN_NODE_SPACING

  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    let overlapsResolved = 0;

    // Build spatial hash (grid cells of MIN_SEPARATION size)
    const grid = new Map();
    const cellSize = MIN_SEPARATION;

    nodes.forEach(node => {
      // Skip function nodes (they follow parent)
      if (node.type === 'function' || node.isFunction) return;
      if (node.x === undefined || node.y === undefined) return;

      const cellX = Math.floor(node.x / cellSize);
      const cellY = Math.floor(node.y / cellSize);
      const key = `${cellX},${cellY}`;
      if (!grid.has(key)) grid.set(key, []);
      grid.get(key).push(node);
    });

    // Check each node against neighbors in spatial hash
    nodes.forEach(node => {
      if (node.type === 'function' || node.isFunction) return;
      if (node.x === undefined || node.y === undefined) return;
      if (node.type === 'main') return; // Don't move main node

      const cellX = Math.floor(node.x / cellSize);
      const cellY = Math.floor(node.y / cellSize);

      // Check 3x3 neighborhood
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          const neighbors = grid.get(`${cellX + dx},${cellY + dy}`) || [];
          neighbors.forEach(other => {
            if (other === node) return;

            const distX = node.x - other.x;
            const distY = node.y - other.y;
            const dist = Math.sqrt(distX * distX + distY * distY);

            // Calculate minimum distance based on node types
            const nodeRadius = node.type === 'pathway' ? 60 : (node.radius || interactorNodeRadius);
            const otherRadius = other.type === 'pathway' ? 60 : (other.radius || interactorNodeRadius);
            const minDist = nodeRadius + otherRadius + 8; // 8px padding

            if (dist < minDist && dist > 0.001) {
              // Push apart along line between centers
              const overlap = minDist - dist;
              const pushX = (distX / dist) * overlap * 0.5;
              const pushY = (distY / dist) * overlap * 0.5;

              // Weight by priority: main=fixed, pathway=heavy, interactor=light
              const nodePriority = node.type === 'main' ? 100 : (node.type === 'pathway' ? 50 : 10);
              const otherPriority = other.type === 'main' ? 100 : (other.type === 'pathway' ? 50 : 10);
              const totalPriority = nodePriority + otherPriority;

              // Lower priority nodes move more
              const nodeWeight = 1 - (nodePriority / totalPriority);
              const otherWeight = 1 - (otherPriority / totalPriority);

              if (node.type !== 'main') {
                node.x += pushX * nodeWeight * 2;
                node.y += pushY * nodeWeight * 2;
              }
              if (other.type !== 'main') {
                other.x -= pushX * otherWeight * 2;
                other.y -= pushY * otherWeight * 2;
              }

              overlapsResolved++;
            }
          });
        }
      }
    });

    // Update _targetAngle for pushed nodes
    nodes.forEach(node => {
      if (node.type === 'function' || node.isFunction) return;
      if (node.type === 'main') return;
      if (node.x === undefined || node.y === undefined) return;

      // Recalculate angle from center
      const centerX = width / 2;
      const centerY = height / 2;
      node._targetAngle = Math.atan2(node.y - centerY, node.x - centerX);
    });

    if (overlapsResolved === 0) {
      console.log(`✓ Overlap resolution converged in ${iter + 1} iterations`);
      break;
    }
  }
}

/**
 * Find closest point on a quadratic Bézier curve to a given point
 * @param {number} px, py - Point to test
 * @param {number} x1, y1 - Start point
 * @param {number} cx, cy - Control point
 * @param {number} x2, y2 - End point
 * @returns {Object} - {x, y, dist, t} of closest point
 */
function getClosestPointOnBezier(px, py, x1, y1, cx, cy, x2, y2) {
  let minDist = Infinity;
  let closestPoint = { x: x1, y: y1, dist: Infinity, t: 0 };

  // Sample the curve at intervals
  for (let t = 0; t <= 1; t += 0.05) {
    const mt = 1 - t;
    // Quadratic Bézier formula: B(t) = (1-t)²·P₀ + 2(1-t)t·C + t²·P₁
    const bx = mt * mt * x1 + 2 * mt * t * cx + t * t * x2;
    const by = mt * mt * y1 + 2 * mt * t * cy + t * t * y2;

    const dx = px - bx, dy = py - by;
    const dist = Math.sqrt(dx * dx + dy * dy);

    if (dist < minDist) {
      minDist = dist;
      closestPoint = { x: bx, y: by, dist, t };
    }
  }
  return closestPoint;
}

/**
 * Calculate the control point for a link's Bézier curve
 * Extracted from calculateLinkPath logic
 */
function getLinkControlPoint(link) {
  const sourceNode = typeof link.source === 'object' ? link.source : nodeMap.get(link.source);
  const targetNode = typeof link.target === 'object' ? link.target : nodeMap.get(link.target);

  if (!sourceNode || !targetNode || sourceNode.x === undefined || targetNode.x === undefined) {
    return null;
  }

  const x1 = sourceNode.x, y1 = sourceNode.y;
  const x2 = targetNode.x, y2 = targetNode.y;
  const dx = x2 - x1, dy = y2 - y1;
  const dist = Math.sqrt(dx * dx + dy * dy);

  if (dist < 80 || dist === 0) {
    // Straight line - use midpoint as control
    return { cx: (x1 + x2) / 2, cy: (y1 + y2) / 2, x1, y1, x2, y2, isStraight: true };
  }

  const perpX = -dy / dist;
  const perpY = dx / dist;

  const midX = (x1 + x2) / 2;
  const midY = (y1 + y2) / 2;
  const centerX = width / 2, centerY = height / 2;

  const midToCenterX = centerX - midX;
  const midToCenterY = centerY - midY;
  const dot = perpX * midToCenterX + perpY * midToCenterY;
  const sign = dot > 0 ? -1 : 1;

  const curveStrength = Math.min(dist * 0.15, 60);
  const ctrlX = midX + perpX * curveStrength * sign;
  const ctrlY = midY + perpY * curveStrength * sign;

  return { cx: ctrlX, cy: ctrlY, x1, y1, x2, y2, isStraight: false };
}

/**
 * Resolve link-node collisions by pushing nodes away from nearby links
 * Called on every tick to prevent nodes from overlapping with link lines
 * AGGRESSIVE version: large margins, full push, multiple iterations
 */
let _collisionTickCount = 0;
function resolveNodeLinkCollisions() {
  if (!links || !nodes || links.length === 0) return;

  // Performance: only run every 3rd tick and skip when simulation is nearly settled
  _collisionTickCount++;
  if (_collisionTickCount % 3 !== 0) return;
  if (simulation && simulation.alpha() < 0.03) return;

  const AVOIDANCE_MARGIN = 65;  // INCREASED: stronger avoidance for cross-shell links
  const cellSize = AVOIDANCE_MARGIN * 2;
  const MAX_ITERATIONS = 4;  // Extra iteration for convergence

  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    // Build spatial hash for links (rebuild each iteration as nodes move)
    const linkGrid = new Map();

    links.forEach(link => {
      const ctrl = getLinkControlPoint(link);
      if (!ctrl) return;

      // Store link in grid cells around its bounding box
      const minX = Math.min(ctrl.x1, ctrl.x2, ctrl.cx) - AVOIDANCE_MARGIN;
      const maxX = Math.max(ctrl.x1, ctrl.x2, ctrl.cx) + AVOIDANCE_MARGIN;
      const minY = Math.min(ctrl.y1, ctrl.y2, ctrl.cy) - AVOIDANCE_MARGIN;
      const maxY = Math.max(ctrl.y1, ctrl.y2, ctrl.cy) + AVOIDANCE_MARGIN;

      const minCellX = Math.floor(minX / cellSize);
      const maxCellX = Math.floor(maxX / cellSize);
      const minCellY = Math.floor(minY / cellSize);
      const maxCellY = Math.floor(maxY / cellSize);

      for (let cx = minCellX; cx <= maxCellX; cx++) {
        for (let cy = minCellY; cy <= maxCellY; cy++) {
          const key = `${cx},${cy}`;
          if (!linkGrid.has(key)) linkGrid.set(key, []);
          linkGrid.get(key).push({ link, ctrl });
        }
      }
    });

    let collisionsResolved = 0;

    // Check each node against nearby links
    nodes.forEach(node => {
      // Skip function nodes, main node, pathway nodes, and nodes without positions
      // Pathway nodes have deterministic shell positions - don't push them around
      if (node.type === 'function' || node.isFunction) return;
      if (node.type === 'main') return;
      if (node.type === 'pathway') return;
      if (node.x === undefined || node.y === undefined) return;

      const cellX = Math.floor(node.x / cellSize);
      const cellY = Math.floor(node.y / cellSize);
      const nearbyLinks = new Set();

      // Gather links from 3x3 neighborhood
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          const linksInCell = linkGrid.get(`${cellX + dx},${cellY + dy}`) || [];
          linksInCell.forEach(item => nearbyLinks.add(item));
        }
      }

      // Get node radius - use LARGER values for pathways
      const nodeRadius = node.type === 'pathway' ? 90 : (node.radius || interactorNodeRadius + 10);
      const totalMargin = nodeRadius + AVOIDANCE_MARGIN;

      // Test each nearby link
      nearbyLinks.forEach(({ link, ctrl }) => {
        const sourceNode = typeof link.source === 'object' ? link.source : nodeMap.get(link.source);
        const targetNode = typeof link.target === 'object' ? link.target : nodeMap.get(link.target);

        // Skip if this link connects to the node
        if (sourceNode === node || targetNode === node) return;
        if (sourceNode?.id === node.id || targetNode?.id === node.id) return;

        // Get closest point on link curve to node center
        const closestPt = getClosestPointOnBezier(
          node.x, node.y,
          ctrl.x1, ctrl.y1,
          ctrl.cx, ctrl.cy,
          ctrl.x2, ctrl.y2
        );

        if (closestPt.dist < totalMargin) {
          collisionsResolved++;

          // Push node away from link - FULL push immediately
          const pushX = node.x - closestPt.x;
          const pushY = node.y - closestPt.y;
          const pushDist = Math.sqrt(pushX * pushX + pushY * pushY);

          if (pushDist > 0.1) {
            // Full push to clear the margin completely
            const pushAmount = (totalMargin - closestPt.dist) * 1.1;  // 110% to ensure clearance
            const pushUnitX = pushX / pushDist;
            const pushUnitY = pushY / pushDist;

            node.x += pushUnitX * pushAmount;
            node.y += pushUnitY * pushAmount;
          } else {
            // Node center exactly on link - push perpendicular to link direction
            const linkDx = ctrl.x2 - ctrl.x1;
            const linkDy = ctrl.y2 - ctrl.y1;
            const linkLen = Math.sqrt(linkDx * linkDx + linkDy * linkDy);
            if (linkLen > 0) {
              // Push perpendicular (90 degrees from link direction)
              const perpX = -linkDy / linkLen;
              const perpY = linkDx / linkLen;
              node.x += perpX * totalMargin;
              node.y += perpY * totalMargin;
            } else {
              // Fallback: random direction
              const angle = Math.random() * Math.PI * 2;
              node.x += Math.cos(angle) * totalMargin;
              node.y += Math.sin(angle) * totalMargin;
            }
          }
        }
      });
    });

    // If no collisions found, no need for more iterations
    if (collisionsResolved === 0) break;
  }
}

/**
 * Creates D3 force simulation
 * In 'shell' mode: minimal forces, deterministic positions
 * In 'force' mode: full physics simulation (legacy)
 */
function createSimulation() {
  // SHELL MODE: Calculate deterministic positions first
  if (layoutMode === 'shell') {
    recalculateShellPositions();
    // resolveInitialOverlaps();  // DISABLED: Relies on strict radial force and collision sliding
  }

  // Create simulation - needed for rendering even in shell mode
  simulation = d3.forceSimulation(nodes);

  if (layoutMode === 'shell') {
    // SHELL MODE: Minimal forces - just enough to render links properly
    simulation
      .force('link', d3.forceLink(links)
        .id(d => d.id)
        .distance(100)
        .strength(0) // No pull - positions are fixed by shell calculations
      )
      .force('collide', d3.forceCollide()
        .radius(d => {
          // Very generous padding to make overlaps impossible
          if (d.type === 'main') return mainNodeRadius + 20;
          if (d.type === 'pathway') return 70;  // Reduced buffer
          if (d.type === 'function' || d.isFunction) return 45;
          if (d.type === 'interactor') return (d.radius || interactorNodeRadius) + 12;  // Standard buffer (44px radius -> 88px spacing)
          return (d.radius || interactorNodeRadius) + 12;
        })
        .iterations(25)  // Many passes to fully resolve overlaps
        .strength(1.0)   // Maximum collision strength
      );

    // Shell mode: run collision resolution with much more time to settle
    simulation.alpha(0.8).alphaDecay(0.015);  // Much more time to settle completely
  } else {
    // FORCE MODE: Full physics simulation (legacy behavior)
    simulation
      .force('link', d3.forceLink(links)
        .id(d => d.id)
        .distance(d => {
          const src = typeof d.source === 'object' ? d.source : nodeMap.get(d.source);
          const tgt = typeof d.target === 'object' ? d.target : nodeMap.get(d.target);

          if (d.linkType === 'indirect-chain') return 60;
          if (d.type === 'pathway-interactor-link') {
            const srcId = typeof d.source === 'object' ? d.source.id : d.source;
            const tgtId = typeof d.target === 'object' ? d.target.id : d.target;
            const isExpanded = expandedPathways.has(srcId) || expandedPathways.has(tgtId);
            if (d.isReferenceLink) return isExpanded ? 90 : 70;
            return isExpanded ? 120 : 80;
          }
          if (d.type === 'pathway-link') return pathwayRingRadius;
          if (d.type === 'function' || (tgt && (tgt.type === 'function' || tgt.isFunction))) return 80;

          if (!pathwayMode && src && tgt) {
            if (src.type === 'main' || tgt.type === 'main') return SHELL_RADIUS_BASE;
            if (tgt._isChildOf || src._isChildOf) return 150;
          }

          return 250;
        })
        .strength(0.4)
      )
      .force('charge', d3.forceManyBody()
        .strength(d => {
          if (d.type === 'pathway') return -350;
          if (d.isReferenceNode) return -100;
          return -200;
        })
        .distanceMax(500)
      )
      .force('center', d3.forceCenter(width / 2, height / 2).strength(0.03))
      .force('collide', d3.forceCollide()
        .radius(d => {
          if (d.type === 'main') return mainNodeRadius + 35;

          // For pathways, approximate the half-width of the rectangle
          if (d.type === 'pathway') {
            const fontSize = 14;
            const charWidth = fontSize * 0.55;
            const textWidth = (d.label || '').length * charWidth;
            const rectWidth = Math.max(textWidth + 48, 120);
            return rectWidth / 2 + 10; // Half width + padding
          }

          if (d.type === 'function' || d.isFunction) return 55;
          if (d.type === 'interactor') return (d.radius || interactorNodeRadius) + 20;  // Moderate buffer
          return (d.radius || interactorNodeRadius) + 35;
        })
        .strength(0.7) // Stronger collision to ensure separation
        .iterations(2)
      )
      .force('radialPathways', d3.forceRadial(
        d => {
          if (d.type === 'pathway') {
            return expandedPathways.has(d.id) ? pathwayRingRadius + 80 : pathwayRingRadius;
          }
          return 0;
        },
        width / 2,
        height / 2
      ).strength(d => d.type === 'pathway' ? 0.9 : 0))
      .force('radialShell', d3.forceRadial(
        d => {
          if (d.type === 'main') return 0;
          if (d.isFunction || d.type === 'function') return null;
          if (d.type === 'pathway') return null;

          // In pathway mode, calculate absolute radius from shell number
          // This ensures deep pathway interactors are pushed to outer rings
          if (pathwayMode && d._shellData?.shell) {
            const BASE_RADIUS = 250;
            const SHELL_GAP = 150;
            return BASE_RADIUS + (d._shellData.shell - 1) * SHELL_GAP;
          }

          // Non-pathway mode: original logic
          if (d._isChildOf) return SHELL_RADIUS_CHILDREN;
          if (expanded.has(d.id)) return SHELL_RADIUS_EXPANDED;
          return SHELL_RADIUS_BASE;
        },
        width / 2,
        height / 2
      ).strength(d => {
        // ALL nodes except main get 0 radial strength - let angular positioning dominate
        // This matches pathway behavior: pathways stay organized because radial force is disabled
        // Interactors should behave the same - stay in assigned angular sectors
        if (d.type === 'main' || d.isFunction || d.type === 'function' || d.type === 'pathway') return 0;
        if (d.type === 'interactor') return 0;  // Disable radial pull for interactors too!
        return 0;
      }))
      .force('pathwayOrbit', forcePathwayOrbit().strength(0.6))
      .force('sectorConstraint', forceSectorConstraint().strength(0.35))
      .force('angularPosition', forceAngularPosition()
        .center(width / 2, height / 2)
        .strength(0.5))
      .force('strictRadial', () => {
        // STRICT RADIAL ENFORCEMENT: Snap nodes to their exact shell radius
        nodes.forEach(node => {
          // Robust check for main node: by type OR by shell assignment
          if (node.type === 'main' || node._shellData?.shell === 0) {
            node.x = width / 2;
            node.y = height / 2;
            node.fx = width / 2; // ENFORCE FIXED position
            node.fy = height / 2;
            return;
          }
          if (node.type === 'function' || node.isFunction) return;

          const shell = node._shellData?.shell;
          if (shell !== undefined && shellRadii[shell]) {
            const targetRadius = shellRadii[shell];
            const dx = node.x - width / 2;
            const dy = node.y - height / 2;
            const currentRadius = Math.sqrt(dx * dx + dy * dy);

            if (currentRadius > 0) {
              // Project to exact radius
              const scale = targetRadius / currentRadius;
              node.x = width / 2 + dx * scale;
              node.y = height / 2 + dy * scale;
            }
          }
        });
      });

    simulation.alpha(1);
  }

  simulation.restart();

  // LINKS
  const link = g.append('g').selectAll('path')
    .data(links).enter().append('path')
    .attr('class', d => {
      const arrow = d.arrow || 'binds';
      let classes = 'link';
      if (arrow === 'binds') classes += ' link-binding';
      else if (arrow === 'activates') classes += ' link-activate';
      else if (arrow === 'inhibits') classes += ' link-inhibit';
      else if (arrow === 'regulates') classes += ' link-regulate';
      else classes += ' link-binding';
      return classes;
    })
    .attr('marker-end', d => {
      // Simple marker logic
      const a = d.arrow || 'binds';
      if (a === 'activates') return 'url(#arrow-activate)';
      if (a === 'inhibits') return 'url(#arrow-inhibit)';
      if (a === 'regulates') return 'url(#arrow-regulate)';
      return 'url(#arrow-binding)';
    })
    .attr('fill', 'none')
    .on('mouseover', function () { d3.select(this).style('stroke-width', '3.5'); svg.style('cursor', 'pointer'); })
    .on('mouseout', function () { d3.select(this).style('stroke-width', null); svg.style('cursor', null); })
    .on('click', handleLinkClick);

  // NODES
  const node = g.append('g').selectAll('g')
    .data(nodes).enter().append('g')
    .attr('class', 'node-group')
    .call(d3.drag()
      .on('start', dragstarted)
      .on('drag', dragged)
      .on('end', dragended));

  node.each(function (d) {
    const group = d3.select(this);
    if (d.type === 'main') {
      // Main protein node
      group.append('circle')
        .attr('class', 'node main-node')
        .attr('r', mainNodeRadius)
        .style('fill', '#4f46e5')  // Explicitly set fill (Bright Violet)
        .style('stroke', '#818cf8') // Explicit stroke
        .style('stroke-width', '3px')
        .style('cursor', 'pointer')
        .on('click', (ev) => { ev.stopPropagation(); handleNodeClick(d); });
      console.log('Drawing MAIN node:', d); // Debug log
      group.append('text')
        .attr('class', 'node-label main-label')
        .attr('dy', 5)
        .style('font-size', '16px')
        .style('font-weight', '700')
        .text(d.label);
    } else if (d.type === 'pathway') {
      // Pathway node - ROUNDED RECTANGLE that fits full text
      const isDark = document.body.classList.contains('dark-mode');
      const gradientId = d.expanded
        ? (isDark ? 'pathwayExpandedGradientDark' : 'pathwayExpandedGradient')
        : (isDark ? 'pathwayGradientDark' : 'pathwayGradient');

      // Calculate rectangle dimensions based on text length
      const fontSize = 14;
      const paddingX = 24;
      const paddingY = 14;
      const charWidth = fontSize * 0.55; // Approximate character width
      const textWidth = d.label.length * charWidth;
      const rectWidth = Math.max(textWidth + paddingX * 2, 120); // Min width 120px
      const rectHeight = 44;

      // Store dimensions on node for collision detection and positioning
      d.rectWidth = rectWidth;
      d.rectHeight = rectHeight;

      group.append('rect')
        .attr('class', `node pathway-node ${d.expanded ? 'expanded' : ''}`)
        .attr('width', rectWidth)
        .attr('height', rectHeight)
        .attr('x', -rectWidth / 2)
        .attr('y', -rectHeight / 2)
        .attr('rx', 12)  // Rounded corners
        .attr('ry', 12)
        .style('fill', `url(#${gradientId})`)
        .style('stroke', '#7c3aed')
        .style('stroke-width', d.expanded ? '3px' : '2px')
        .style('cursor', 'pointer')
        .on('click', (ev) => { ev.stopPropagation(); handlePathwayClick(d); });

      // Full pathway label (no truncation)
      group.append('text')
        .attr('class', 'node-label pathway-label')
        .attr('dy', 5)
        .attr('text-anchor', 'middle')
        .style('fill', 'white')
        .style('font-size', `${fontSize}px`)
        .style('font-weight', '700')
        .text(d.label);

      // Interactor count badge (positioned at top-right corner of rectangle)
      const count = (d.interactorIds || []).length;
      if (count > 0) {
        const badgeX = rectWidth / 2 - 8;
        const badgeY = -rectHeight / 2 - 4;

        group.append('circle')
          .attr('class', 'pathway-badge')
          .attr('cx', badgeX)
          .attr('cy', badgeY)
          .attr('r', 14)
          .style('fill', '#ef4444');

        group.append('text')
          .attr('class', 'pathway-badge-text')
          .attr('x', badgeX)
          .attr('y', badgeY)
          .attr('text-anchor', 'middle')
          .attr('dy', 5)
          .style('fill', 'white')
          .style('font-size', '11px')
          .style('font-weight', 'bold')
          .text(count);
      }
    } else {
      // Interactor node (standard or under pathway) - use semantic coloring
      const arrowClass = getNodeArrowClass(d);
      group.append('circle')
        .attr('class', `node interactor-node ${arrowClass}`)
        .attr('r', d.radius || interactorNodeRadius)
        .style('fill', getNodeGradient(d))
        .style('cursor', 'pointer')
        .on('click', (ev) => { ev.stopPropagation(); handleNodeClick(d); });
      group.append('text')
        .attr('class', `node-label interactor-label ${arrowClass}`)
        .attr('dy', 5)
        .style('font-size', '13px')
        .style('font-weight', '600')
        .text(d.label);
    }
  });

  // Tick handler
  simulation.on('tick', () => {
    resolveNodeLinkCollisions();  // Push nodes away from link lines
    node.attr('transform', d => `translate(${d.x},${d.y})`);
    link.attr('d', calculateLinkPath);
  });

  // Store selections
  linkGroup = link;
  nodeGroup = node;
}

function dragstarted(ev, d) {
  // Track start position for click detection
  d._dragStartX = ev.x;
  d._dragStartY = ev.y;
  d._dragMoved = false;

  if (layoutMode === 'shell') {
    // In shell mode, just track that we're dragging
    d._isDragging = true;
  } else {
    if (!ev.active) simulation.alphaTarget(0.3).restart();
  }
  d.fx = d.x;
  d.fy = d.y;
}

function dragged(ev, d) {
  // Check if actually moved beyond threshold (5px)
  const dx = ev.x - d._dragStartX;
  const dy = ev.y - d._dragStartY;
  if (Math.abs(dx) > 5 || Math.abs(dy) > 5) {
    d._dragMoved = true;
  }

  d.fx = ev.x;
  d.fy = ev.y;
  // Update position immediately for visual feedback
  d.x = ev.x;
  d.y = ev.y;
}

function dragended(ev, d) {
  d._isDragging = false;

  // If no movement occurred, treat as a click
  if (!d._dragMoved) {
    // Reset position since this was just a click, not a drag
    d.fx = null;
    d.fy = null;

    // Fire appropriate click handler based on node type
    if (d.type === 'pathway') {
      handlePathwayClick(d);
    } else if (d.type === 'main' || d.type === 'interactor') {
      handleNodeClick(d);
    }
    return;
  }

  if (layoutMode === 'shell') {
    // SHELL MODE: Snap to nearest slot in node's shell
    if (d.type === 'main') {
      // Main node stays at center
      d.fx = width / 2;
      d.fy = height / 2;
      d.x = width / 2;
      d.y = height / 2;
      return;
    }

    const shellData = d._shellData;
    if (!shellData || shellData.shell === undefined) {
      d.fx = null;
      d.fy = null;
      return;
    }

    const shell = shellData.shell;
    const centerX = width / 2;
    const centerY = height / 2;

    // Calculate dragged angle from center
    const dx = ev.x - centerX;
    const dy = ev.y - centerY;
    const draggedAngle = Math.atan2(dy, dx);

    // Get nodes in this shell
    const shellNodes = getNodesInShell(shell);
    const totalSlots = shellNodes.length;

    if (totalSlots <= 1) {
      // Single node - snap back to calculated position
      recalculateShellPositions();
      d.fx = null;
      d.fy = null;
      renderGraph();
      return;
    }

    // Find nearest slot based on angle
    const angleStep = (2 * Math.PI) / totalSlots;
    // Normalize dragged angle to [0, 2*PI)
    let normalizedAngle = draggedAngle + Math.PI / 2; // Offset to match our start-from-top
    if (normalizedAngle < 0) normalizedAngle += 2 * Math.PI;

    const nearestSlotIndex = Math.round(normalizedAngle / angleStep) % totalSlots;

    // Get the radius for this shell
    const shellRadius = shellRadii[shell] || (shell * 150 + 100);

    // Calculate snapped position
    const snappedAngle = nearestSlotIndex * angleStep - Math.PI / 2;
    const snappedX = centerX + shellRadius * Math.cos(snappedAngle);
    const snappedY = centerY + shellRadius * Math.sin(snappedAngle);

    // Check if we're swapping with another node
    const currentSlot = shellData.slot;
    if (nearestSlotIndex !== currentSlot) {
      // Find node currently at target slot and swap
      const nodeAtTargetSlot = shellNodes.find(n =>
        n._shellData && n._shellData.slot === nearestSlotIndex && n.id !== d.id
      );

      if (nodeAtTargetSlot) {
        // Swap positions
        const myOldAngle = currentSlot * angleStep - Math.PI / 2;
        const swapX = centerX + shellRadius * Math.cos(myOldAngle);
        const swapY = centerY + shellRadius * Math.sin(myOldAngle);

        nodeAtTargetSlot.x = swapX;
        nodeAtTargetSlot.y = swapY;
        nodeAtTargetSlot._shellData = {
          ...nodeAtTargetSlot._shellData,
          slot: currentSlot,
          angle: myOldAngle
        };
        nodeAtTargetSlot.fx = null;
        nodeAtTargetSlot.fy = null;
      }
    }

    // Update dragged node's position
    d.x = snappedX;
    d.y = snappedY;
    d._shellData = {
      ...d._shellData,
      slot: nearestSlotIndex,
      angle: snappedAngle
    };
    d.fx = null;
    d.fy = null;

    // Re-render to show snapped positions
    renderGraph();
  } else {
    // FORCE MODE: Standard behavior
    if (!ev.active) simulation.alphaTarget(0);
    if (d.type !== 'main') {
      d.fx = null;
      d.fy = null;
    }
  }
}

/**
 * Handle pathway node click - expand/collapse interactors
 */
function handlePathwayClick(pathwayNode) {
  if (!pathwayNode || pathwayNode.type !== 'pathway') return;

  // Handle reference node - navigate to primary location
  if (pathwayNode.isReferenceNode) {
    const primaryNode = nodeMap.get(pathwayNode.primaryNodeId);
    if (primaryNode) {
      pulseAndCenter(primaryNode);
    }
    return;
  }

  const hier = pathwayHierarchy.get(pathwayNode.originalId || pathwayNode.id);
  const hasChildren = (pathwayNode.childPathwayIds?.length || hier?.child_ids?.length || 0) > 0;
  const isLeaf = pathwayNode.isLeaf ?? hier?.is_leaf ?? true;

  // Check current expansion state
  const hasHierarchyExpanded = expandedHierarchyPathways.has(pathwayNode.id);
  const hasInteractorsExpanded = expandedPathways.has(pathwayNode.id);

  // Decide action based on current state and node properties
  if (hasHierarchyExpanded || hasInteractorsExpanded) {
    // Currently expanded - collapse everything
    if (hasInteractorsExpanded) {
      collapsePathway(pathwayNode);
    }
    if (hasHierarchyExpanded) {
      collapsePathwayHierarchy(pathwayNode);
    }
  } else {
    // Not expanded - HIERARCHICAL EXPANSION
    if (hasChildren && !isLeaf) {
      // Has sub-pathways - expand hierarchy only (don't show interactors yet)
      // User must drill down to leaf pathways to see actual interactors
      expandPathwayHierarchy(pathwayNode);
    } else {
      // LEAF PATHWAY: Show interactors with proper tree structure
      // Only leaf pathways show their interactors - this prevents
      // messy direct protein attachments on non-leaf pathways
      expandPathwayWithLazyLoad(pathwayNode);
    }
  }

  updateSimulation();
}

/**
 * Expand a pathway node to show its interactors
 */
function expandPathway(pathwayNode) {
  expandedPathways.add(pathwayNode.id);
  pathwayNode.expanded = true;
  // Note: Radial force will automatically push pathway to expanded radius (430px)

  // Check if we have full interaction data for this pathway (leaf pathway with interactions)
  // Try both context-qualified ID and original ID (for child pathways created with @parent suffix)
  const pathwayInteractions = pathwayToInteractions.get(pathwayNode.id) ||
    pathwayToInteractions.get(pathwayNode.originalId);
  if (pathwayInteractions && pathwayInteractions.length > 0) {
    // NEW: Interaction-based expansion - show protein nodes connected by interaction edges
    expandPathwayWithInteractions(pathwayNode, pathwayInteractions);
    return;
  }

  // FALLBACK: Legacy interactor-based expansion (pathway → protein links)
  const interactorIds = pathwayToInteractors.get(pathwayNode.id) || new Set();
  // Note: expandRadius and indirectRadius calculated after classification (below)

  // Helper: Find interaction data for a given interactor
  function getInteractionForInteractor(interactorId) {
    // Try new format first (interactions array with source/target)
    const interactions = SNAP.interactions || [];
    let found = interactions.find(interaction => {
      const src = interaction.source;
      const tgt = interaction.target;

      // For DIRECT interactions: match main → interactor or interactor → main
      if (interaction.interaction_type !== 'indirect') {
        return (src === SNAP.main && tgt === interactorId) ||
          (tgt === SNAP.main && src === interactorId);
      }

      // For INDIRECT interactions: the database has already set source to upstream_interactor
      // So we match interactions where this interactor is the target
      // Example: For chain ATXN3 → PNKP → ATM, the ATM interaction has:
      //   source = "PNKP" (upstream_interactor), target = "ATM"
      return tgt === interactorId;
    });

    if (found) return found;

    // Fallback to old format (interactors array with primary)
    const interactors = SNAP.interactors || [];
    return interactors.find(interactor => interactor.primary === interactorId);
  }

  // STEP 1: Classify interactors as direct vs indirect
  // Direct interactors connect to pathway node
  // Indirect interactors connect to their mediator (upstream_interactor)
  const directInteractors = new Set();
  const indirectByMediator = new Map();  // Map<mediatorId, Set<indirectInteractorId>>
  const interactorDataMap = new Map();   // Cache interaction data

  interactorIds.forEach(interactorId => {
    const interactionData = getInteractionForInteractor(interactorId);
    interactorDataMap.set(interactorId, interactionData);

    if (interactionData?.interaction_type === 'indirect' && interactionData.upstream_interactor) {
      // Indirect interactor - group by mediator
      const mediator = interactionData.upstream_interactor;
      if (!indirectByMediator.has(mediator)) {
        indirectByMediator.set(mediator, new Set());
      }
      indirectByMediator.get(mediator).add(interactorId);
    } else {
      // Direct interactor
      directInteractors.add(interactorId);
    }
  });

  // Calculate dynamic radii based on node counts (prevents overlap)
  const expandRadius = calculateExpandRadius(directInteractors.size, interactorNodeRadius);

  // STEP 2: Create direct interactor nodes (linked to pathway)
  const directAngleStep = (2 * Math.PI) / Math.max(directInteractors.size, 1);
  let directIdx = 0;

  directInteractors.forEach(interactorId => {
    const nodeId = `${interactorId}@${pathwayNode.id}`;

    if (!nodeMap.has(nodeId)) {
      const angle = directIdx * directAngleStep - Math.PI / 2;
      const x = pathwayNode.x + expandRadius * Math.cos(angle);
      const y = pathwayNode.y + expandRadius * Math.sin(angle);

      const interactionData = interactorDataMap.get(interactorId);
      const actualArrow = interactionData ? arrowKind(interactionData.arrow, interactionData.intent, interactionData.direction) : 'binds';

      // Determine direction role from interaction data
      const direction = interactionData?.direction || 'bidirectional';
      let directionRole = 'bidirectional';
      if (direction === 'primary_to_main') directionRole = 'upstream';
      else if (direction === 'main_to_primary') directionRole = 'downstream';

      // CHECK: Does this protein already exist as a node from another pathway?
      const existingNode = findExistingInteractorNode(interactorId);

      if (existingNode) {
        // CREATE REFERENCE NODE - points to the existing primary node
        const refNodeId = `ref_${interactorId}@${pathwayNode.id}`;

        const refNode = {
          id: refNodeId,
          label: interactorId,
          symbol: interactorId,
          type: 'interactor',
          isReferenceNode: true,
          primaryNodeId: existingNode.id,
          originalId: interactorId,
          pathwayId: pathwayNode.id,
          _pathwayContext: pathwayNode.id,
          _pathwayName: pathwayNode.label,
          _directionRole: directionRole,
          radius: interactorNodeRadius * 0.85,  // Slightly smaller
          arrow: actualArrow,
          interactionData: interactionData,
          x: x,
          y: y,
          expandRadius: expandRadius,
          isNewlyExpanded: true
        };

        nodes.push(refNode);
        nodeMap.set(refNodeId, refNode);
        newlyAddedNodes.add(refNodeId);

        // Link: pathway → reference node (dashed style applied in rendering)
        links.push({
          id: `${pathwayNode.id}-${refNodeId}`,
          source: pathwayNode.id,
          target: refNodeId,
          type: 'pathway-interactor-link',
          isReferenceLink: true,
          arrow: actualArrow,
          data: interactionData
        });

        console.log(`📍 Created reference node for ${interactorId} → primary at ${existingNode.id}`);
      } else {
        // CREATE PRIMARY NODE - first occurrence of this protein
        const newNode = {
          id: nodeId,
          label: interactorId,
          symbol: interactorId,
          type: 'interactor',
          originalId: interactorId,
          pathwayId: pathwayNode.id,
          _pathwayContext: pathwayNode.id,    // Track pathway context for filtering
          _pathwayName: pathwayNode.label,    // Pathway name for badge display
          _directionRole: directionRole,
          radius: interactorNodeRadius,
          arrow: actualArrow,
          interactionData: interactionData,
          x: x,
          y: y,
          expandRadius: expandRadius,
          isNewlyExpanded: true
        };

        nodes.push(newNode);
        nodeMap.set(nodeId, newNode);
        newlyAddedNodes.add(nodeId);

        // Link: pathway → direct interactor
        links.push({
          id: `${pathwayNode.id}-${nodeId}`,
          source: pathwayNode.id,
          target: nodeId,
          type: 'pathway-interactor-link',
          arrow: actualArrow,
          data: interactionData
        });
      }
    }
    directIdx++;
  });

  // STEP 3: Create indirect interactor nodes (linked to their mediators)
  indirectByMediator.forEach((indirectIds, mediatorId) => {
    // Find the mediator node (it should exist as a direct interactor)
    const mediatorNodeId = `${mediatorId}@${pathwayNode.id}`;
    let mediatorNode = nodeMap.get(mediatorNodeId);

    if (!mediatorNode) {
      // Mediator not in this pathway - create it on-demand
      console.log(`📍 Creating mediator node ${mediatorId} on-demand for pathway ${pathwayNode.id}`);

      // Position mediator at an offset from pathway center
      const mediatorAngle = Math.random() * 2 * Math.PI;  // Random angle
      const mediatorX = pathwayNode.x + expandRadius * 0.7 * Math.cos(mediatorAngle);
      const mediatorY = pathwayNode.y + expandRadius * 0.7 * Math.sin(mediatorAngle);

      // Get mediator interaction data if available
      const mediatorInteractionData = getInteractionForInteractor(mediatorId);
      const mediatorArrow = mediatorInteractionData ? arrowKind(mediatorInteractionData.arrow, mediatorInteractionData.intent, mediatorInteractionData.direction) : 'binds';

      // Determine direction role for mediator (typically downstream of query, upstream of indirect)
      const mediatorDirection = mediatorInteractionData?.direction || 'bidirectional';
      let mediatorDirectionRole = 'downstream';  // Default: mediators are downstream of query
      if (mediatorDirection === 'primary_to_main') mediatorDirectionRole = 'upstream';
      else if (mediatorDirection === 'main_to_primary') mediatorDirectionRole = 'downstream';

      mediatorNode = {
        id: mediatorNodeId,
        label: mediatorId,
        type: 'interactor',
        originalId: mediatorId,
        pathwayId: pathwayNode.id,
        _pathwayContext: pathwayNode.id,
        _pathwayName: pathwayNode.label,
        _directionRole: mediatorDirectionRole,
        radius: interactorNodeRadius,
        arrow: mediatorArrow,
        interactionData: mediatorInteractionData,
        isMediatorNode: true,  // Mark as mediator for styling
        x: mediatorX,
        y: mediatorY,
        expandRadius: expandRadius,
        isNewlyExpanded: true
      };

      nodes.push(mediatorNode);
      nodeMap.set(mediatorNodeId, mediatorNode);
      newlyAddedNodes.add(mediatorNodeId);

      // Link: pathway → mediator
      links.push({
        id: `${pathwayNode.id}-${mediatorNodeId}`,
        source: pathwayNode.id,
        target: mediatorNodeId,
        type: 'pathway-interactor-link',
        linkType: 'mediator-link',
        arrow: mediatorArrow,
        data: mediatorInteractionData
      });
    }

    // Use the mediator's target position for indirect node positioning
    const mediatorX = mediatorNode.targetX || mediatorNode.x;
    const mediatorY = mediatorNode.targetY || mediatorNode.y;

    // Calculate dynamic radius for this mediator's indirect interactors
    const indirectRadius = calculateExpandRadius(indirectIds.size, interactorNodeRadius);
    const indirectAngleStep = (2 * Math.PI) / Math.max(indirectIds.size, 1);
    let indirectIdx = 0;

    indirectIds.forEach(indirectId => {
      const nodeId = `${indirectId}@${pathwayNode.id}`;

      if (!nodeMap.has(nodeId)) {
        // Position around mediator (not pathway)
        const angle = indirectIdx * indirectAngleStep - Math.PI / 2;
        const x = mediatorX + indirectRadius * Math.cos(angle);
        const y = mediatorY + indirectRadius * Math.sin(angle);

        const interactionData = interactorDataMap.get(indirectId);
        const actualArrow = interactionData ? arrowKind(interactionData.arrow, interactionData.intent, interactionData.direction) : 'binds';

        // CHECK: Does this protein already exist as a node from another pathway?
        const existingNode = findExistingInteractorNode(indirectId);

        if (existingNode) {
          // CREATE REFERENCE NODE for indirect interactor
          const refNodeId = `ref_${indirectId}@${pathwayNode.id}`;

          const refNode = {
            id: refNodeId,
            label: indirectId,
            symbol: indirectId,
            type: 'interactor',
            isReferenceNode: true,
            primaryNodeId: existingNode.id,
            originalId: indirectId,
            pathwayId: pathwayNode.id,
            _pathwayContext: pathwayNode.id,
            _pathwayName: pathwayNode.label,
            _directionRole: 'indirect',
            _indirectHopCount: 1,
            radius: interactorNodeRadius * 0.85,
            arrow: actualArrow,
            interactionData: interactionData,
            upstream_interactor: mediatorId,
            interaction_type: 'indirect',
            x: x,
            y: y,
            expandRadius: indirectRadius,
            isNewlyExpanded: true
          };

          nodes.push(refNode);
          nodeMap.set(refNodeId, refNode);
          newlyAddedNodes.add(refNodeId);

          // Link: mediator → reference node
          links.push({
            id: `${mediatorNodeId}-${refNodeId}`,
            source: mediatorNodeId,
            target: refNodeId,
            type: 'pathway-interactor-link',
            linkType: 'indirect-chain',
            isReferenceLink: true,
            arrow: actualArrow,
            data: interactionData
          });
        } else {
          // CREATE PRIMARY NODE
          const newNode = {
            id: nodeId,
            label: indirectId,
            symbol: indirectId,
            type: 'interactor',
            originalId: indirectId,
            pathwayId: pathwayNode.id,
            _pathwayContext: pathwayNode.id,    // Track pathway context for filtering
            _pathwayName: pathwayNode.label,    // Pathway name for badge display
            _directionRole: 'indirect',
            _indirectHopCount: 1,
            radius: interactorNodeRadius,
            arrow: actualArrow,
            interactionData: interactionData,
            upstream_interactor: mediatorId,  // Track mediator for this indirect node
            interaction_type: 'indirect',
            x: x,
            y: y,
            expandRadius: indirectRadius,
            isNewlyExpanded: true
          };

          nodes.push(newNode);
          nodeMap.set(nodeId, newNode);
          newlyAddedNodes.add(nodeId);

          // Link: mediator → indirect interactor (NOT pathway → indirect)
          links.push({
            id: `${mediatorNodeId}-${nodeId}`,
            source: mediatorNodeId,
            target: nodeId,
            type: 'pathway-interactor-link',
            linkType: 'indirect-chain',  // Mark as indirect chain link
            arrow: actualArrow,
            data: interactionData
          });
        }
      }
      indirectIdx++;
    });
  });

  const directCount = directInteractors.size;
  const indirectCount = interactorIds.size - directCount;
  console.log(`🛤️ Expanded pathway: ${pathwayNode.label} with ${directCount} direct + ${indirectCount} indirect interactors`);
}

/**
 * Expand pathway with full interaction data - shows protein nodes connected by interaction edges
 * This renders actual interactions (protein ↔ protein) instead of just pathway → protein links
 * @param {Object} pathwayNode - The pathway node being expanded
 * @param {Array} interactions - Array of interaction objects
 * @param {Object} options - Optional settings { anchorAngle: number } for placeholder expansions
 */
function expandPathwayWithInteractions(pathwayNode, interactions, options = {}) {
  const { anchorAngle } = options;  // Used to anchor interactors at placeholder's original position
  const queryProtein = SNAP.main;

  // Step 1: Classify proteins by direction relative to query
  const { upstream, downstream, bidirectional } = getProteinsByRole(interactions, queryProtein);

  // Also collect any proteins not directly connected to query (interactor-interactor links)
  const allProteins = new Set();
  interactions.forEach(inter => {
    if (inter.source) allProteins.add(inter.source);
    if (inter.target) allProteins.add(inter.target);
  });

  // Calculate total node count for radius (upstream + downstream + bidirectional + query)
  const totalInteractors = upstream.size + downstream.size + bidirectional.size;
  const expandRadius = calculateExpandRadius(totalInteractors + 1, interactorNodeRadius);
  const queryRadius = expandRadius * 0.5;  // Query protein closer to pathway

  // Map protein symbol → node id
  const proteinNodeMap = new Map();

  // Step 2: Create query protein node (positioned between pathway and interactors)
  // Query protein always gets a reference node since it's the main protein
  const existingQueryNode = findExistingInteractorNode(queryProtein);
  let queryNodeId;

  if (existingQueryNode) {
    // Create reference node for query protein
    queryNodeId = `ref_${queryProtein}@${pathwayNode.id}`;
    if (!nodeMap.has(queryNodeId)) {
      const queryX = pathwayNode.x + queryRadius;
      const queryY = pathwayNode.y;

      const refNode = {
        id: queryNodeId,
        label: queryProtein,
        symbol: queryProtein,
        type: 'interactor',
        isReferenceNode: true,
        primaryNodeId: existingQueryNode.id,
        isQueryProtein: true,
        originalId: queryProtein,
        pathwayId: pathwayNode.id,
        _pathwayContext: pathwayNode.id,
        _pathwayName: pathwayNode.label,
        _directionRole: 'query',
        _anchorAngle: anchorAngle,  // For placeholder expansion positioning
        radius: interactorNodeRadius * 1.0,  // Reference is smaller
        x: queryX,
        y: queryY,
        expandRadius: expandRadius,
        isNewlyExpanded: true
      };

      nodes.push(refNode);
      nodeMap.set(queryNodeId, refNode);
      newlyAddedNodes.add(queryNodeId);
    }
  } else {
    queryNodeId = `${queryProtein}@${pathwayNode.id}`;
    if (!nodeMap.has(queryNodeId)) {
      const queryX = pathwayNode.x + queryRadius;
      const queryY = pathwayNode.y;

      const queryNode = {
        id: queryNodeId,
        label: queryProtein,
        symbol: queryProtein,
        type: 'interactor',
        isQueryProtein: true,  // Mark for special styling
        originalId: queryProtein,
        pathwayId: pathwayNode.id,
        _pathwayContext: pathwayNode.id,
        _pathwayName: pathwayNode.label,
        _directionRole: 'query',
        _anchorAngle: anchorAngle,  // For placeholder expansion positioning
        radius: interactorNodeRadius * 1.2,  // Slightly larger
        x: queryX,
        y: queryY,
        expandRadius: expandRadius,
        isNewlyExpanded: true
      };

      nodes.push(queryNode);
      nodeMap.set(queryNodeId, queryNode);
      newlyAddedNodes.add(queryNodeId);
    }
  }
  proteinNodeMap.set(queryProtein, queryNodeId);

  // Step 3: Position UPSTREAM proteins on LEFT arc (they point TOWARD query)
  // Arc from ~135deg to ~225deg (left side)
  const upstreamArray = Array.from(upstream);
  const upstreamPositions = calculateArcPositions(
    upstreamArray.length,
    pathwayNode.x, pathwayNode.y,
    expandRadius,
    Math.PI * 0.6,   // ~108deg (upper-left)
    Math.PI * 1.4    // ~252deg (lower-left)
  );

  upstreamArray.forEach((proteinId, idx) => {
    const pos = upstreamPositions[idx] || { x: pathwayNode.x - expandRadius, y: pathwayNode.y };
    const interactionData = interactions.find(i => i.source === proteinId || i.target === proteinId);
    const actualArrow = interactionData
      ? arrowKind(interactionData.arrow, interactionData.intent, interactionData.direction)
      : 'binds';

    // Check for existing node
    const existingNode = findExistingInteractorNode(proteinId);
    let nodeId;

    if (existingNode) {
      // Create reference node
      nodeId = `ref_${proteinId}@${pathwayNode.id}`;
      if (!nodeMap.has(nodeId)) {
        const refNode = {
          id: nodeId,
          label: proteinId,
          symbol: proteinId,
          type: 'interactor',
          isReferenceNode: true,
          primaryNodeId: existingNode.id,
          originalId: proteinId,
          pathwayId: pathwayNode.id,
          _pathwayContext: pathwayNode.id,
          _pathwayName: pathwayNode.label,
          _directionRole: 'upstream',
          _anchorAngle: anchorAngle,  // For placeholder expansion positioning
          radius: interactorNodeRadius * 0.85,
          arrow: actualArrow,
          interactionData: interactionData,
          x: pos.x,
          y: pos.y,
          _targetAngle: pos.angle,
          expandRadius: expandRadius,
          isNewlyExpanded: true
        };
        nodes.push(refNode);
        nodeMap.set(nodeId, refNode);
        newlyAddedNodes.add(nodeId);
      }
    } else {
      nodeId = `${proteinId}@${pathwayNode.id}`;
      if (!nodeMap.has(nodeId)) {
        const newNode = {
          id: nodeId,
          label: proteinId,
          symbol: proteinId,
          type: 'interactor',
          originalId: proteinId,
          pathwayId: pathwayNode.id,
          _pathwayContext: pathwayNode.id,
          _pathwayName: pathwayNode.label,
          _directionRole: 'upstream',
          _anchorAngle: anchorAngle,  // For placeholder expansion positioning
          radius: interactorNodeRadius,
          arrow: actualArrow,
          interactionData: interactionData,
          x: pos.x,
          y: pos.y,
          _targetAngle: pos.angle,
          expandRadius: expandRadius,
          isNewlyExpanded: true
        };
        nodes.push(newNode);
        nodeMap.set(nodeId, newNode);
        newlyAddedNodes.add(nodeId);
      }
    }
    proteinNodeMap.set(proteinId, nodeId);
  });

  // Step 4: Position DOWNSTREAM proteins on RIGHT arc (query points TOWARD them)
  // Arc from ~-45deg to ~45deg (right side)
  const downstreamArray = Array.from(downstream);
  const downstreamPositions = calculateArcPositions(
    downstreamArray.length,
    pathwayNode.x, pathwayNode.y,
    expandRadius * 1.3,  // Further out (past query)
    -Math.PI * 0.4,  // ~-72deg (upper-right)
    Math.PI * 0.4    // ~72deg (lower-right)
  );

  downstreamArray.forEach((proteinId, idx) => {
    const pos = downstreamPositions[idx] || { x: pathwayNode.x + expandRadius * 1.3, y: pathwayNode.y };
    const interactionData = interactions.find(i => i.source === proteinId || i.target === proteinId);
    const actualArrow = interactionData
      ? arrowKind(interactionData.arrow, interactionData.intent, interactionData.direction)
      : 'binds';

    // Check for existing node
    const existingNode = findExistingInteractorNode(proteinId);
    let nodeId;

    if (existingNode) {
      // Create reference node
      nodeId = `ref_${proteinId}@${pathwayNode.id}`;
      if (!nodeMap.has(nodeId)) {
        const refNode = {
          id: nodeId,
          label: proteinId,
          symbol: proteinId,
          type: 'interactor',
          isReferenceNode: true,
          primaryNodeId: existingNode.id,
          originalId: proteinId,
          pathwayId: pathwayNode.id,
          _pathwayContext: pathwayNode.id,
          _pathwayName: pathwayNode.label,
          _directionRole: 'downstream',
          _anchorAngle: anchorAngle,  // For placeholder expansion positioning
          radius: interactorNodeRadius * 0.85,
          arrow: actualArrow,
          interactionData: interactionData,
          x: pos.x,
          y: pos.y,
          _targetAngle: pos.angle,
          expandRadius: expandRadius * 1.3,
          isNewlyExpanded: true
        };
        nodes.push(refNode);
        nodeMap.set(nodeId, refNode);
        newlyAddedNodes.add(nodeId);
      }
    } else {
      nodeId = `${proteinId}@${pathwayNode.id}`;
      if (!nodeMap.has(nodeId)) {
        const newNode = {
          id: nodeId,
          label: proteinId,
          symbol: proteinId,
          type: 'interactor',
          originalId: proteinId,
          pathwayId: pathwayNode.id,
          _pathwayContext: pathwayNode.id,
          _pathwayName: pathwayNode.label,
          _directionRole: 'downstream',
          _anchorAngle: anchorAngle,  // For placeholder expansion positioning
          radius: interactorNodeRadius,
          arrow: actualArrow,
          interactionData: interactionData,
          x: pos.x,
          y: pos.y,
          _targetAngle: pos.angle,
          expandRadius: expandRadius * 1.3,
          isNewlyExpanded: true
        };
        nodes.push(newNode);
        nodeMap.set(nodeId, newNode);
        newlyAddedNodes.add(nodeId);
      }
    }
    proteinNodeMap.set(proteinId, nodeId);
  });

  // Step 5: Position BIDIRECTIONAL proteins on TOP/BOTTOM arcs
  const bidirectionalArray = Array.from(bidirectional);
  const biPositions = calculateArcPositions(
    bidirectionalArray.length,
    pathwayNode.x, pathwayNode.y,
    expandRadius,
    -Math.PI * 0.5,  // -90deg (top)
    Math.PI * 0.5    // 90deg (bottom, going through right)
  );

  bidirectionalArray.forEach((proteinId, idx) => {
    const pos = biPositions[idx] || { x: pathwayNode.x, y: pathwayNode.y - expandRadius };
    const interactionData = interactions.find(i => i.source === proteinId || i.target === proteinId);
    const actualArrow = interactionData
      ? arrowKind(interactionData.arrow, interactionData.intent, interactionData.direction)
      : 'binds';

    // Check for existing node
    const existingNode = findExistingInteractorNode(proteinId);
    let nodeId;

    if (existingNode) {
      // Create reference node
      nodeId = `ref_${proteinId}@${pathwayNode.id}`;
      if (!nodeMap.has(nodeId)) {
        const refNode = {
          id: nodeId,
          label: proteinId,
          symbol: proteinId,
          type: 'interactor',
          isReferenceNode: true,
          primaryNodeId: existingNode.id,
          originalId: proteinId,
          pathwayId: pathwayNode.id,
          _pathwayContext: pathwayNode.id,
          _pathwayName: pathwayNode.label,
          _directionRole: 'bidirectional',
          _anchorAngle: anchorAngle,  // For placeholder expansion positioning
          radius: interactorNodeRadius * 0.85,
          arrow: actualArrow,
          interactionData: interactionData,
          x: pos.x,
          y: pos.y,
          _targetAngle: pos.angle,
          expandRadius: expandRadius,
          isNewlyExpanded: true
        };
        nodes.push(refNode);
        nodeMap.set(nodeId, refNode);
        newlyAddedNodes.add(nodeId);
      }
    } else {
      nodeId = `${proteinId}@${pathwayNode.id}`;
      if (!nodeMap.has(nodeId)) {
        const newNode = {
          id: nodeId,
          label: proteinId,
          symbol: proteinId,
          type: 'interactor',
          originalId: proteinId,
          pathwayId: pathwayNode.id,
          _pathwayContext: pathwayNode.id,
          _pathwayName: pathwayNode.label,
          _directionRole: 'bidirectional',
          _anchorAngle: anchorAngle,  // For placeholder expansion positioning
          radius: interactorNodeRadius,
          arrow: actualArrow,
          interactionData: interactionData,
          x: pos.x,
          y: pos.y,
          _targetAngle: pos.angle,
          expandRadius: expandRadius,
          isNewlyExpanded: true
        };
        nodes.push(newNode);
        nodeMap.set(nodeId, newNode);
        newlyAddedNodes.add(nodeId);
      }
    }
    proteinNodeMap.set(proteinId, nodeId);
  });

  // Step 5.5: Create nodes for proteins ONLY in interactor-interactor links
  // These are indirect interactors like UFD1 that aren't directly connected to query
  // but appear in chains like VCP → UFD1

  // Build list of indirect proteins for deterministic positioning
  const indirectProteins = Array.from(allProteins).filter(p =>
    p !== queryProtein && !proteinNodeMap.has(p)
  );

  indirectProteins.forEach((proteinId, indirectIndex) => {
    // Find interaction data for this protein
    const interactionData = interactions.find(i =>
      i.source === proteinId || i.target === proteinId
    );

    // Find the mediator (protein this one connects to that we already have)
    const mediator = interactionData?.source === proteinId
      ? interactionData?.target
      : interactionData?.source;
    const mediatorNodeId = proteinNodeMap.get(mediator);
    const mediatorNode = mediatorNodeId ? nodeMap.get(mediatorNodeId) : null;

    // Position near mediator if found, otherwise at edge of expand radius
    let x, y;
    if (mediatorNode) {
      // Use deterministic angle based on mediator's position and index
      // Position radially outward from mediator, opposite to pathway direction
      const baseAngle = mediatorNode._targetAngle !== undefined
        ? mediatorNode._targetAngle + Math.PI  // Opposite direction from pathway
        : Math.atan2(mediatorNode.y - pathwayNode.y, mediatorNode.x - pathwayNode.x);
      // Spread multiple indirect nodes at 30-degree intervals
      const spreadAngle = (indirectIndex - (indirectProteins.length - 1) / 2) * (Math.PI / 6);
      const angle = baseAngle + spreadAngle;
      const offset = interactorNodeRadius * 3;  // Tighter clustering near mediator
      x = mediatorNode.x + offset * Math.cos(angle);
      y = mediatorNode.y + offset * Math.sin(angle);
    } else {
      // Fallback: position at outer edge with deterministic spread
      const fallbackAngle = (indirectIndex * Math.PI / 4) - Math.PI / 2;
      x = pathwayNode.x + expandRadius * 1.3 * Math.cos(fallbackAngle);
      y = pathwayNode.y + expandRadius * 1.3 * Math.sin(fallbackAngle);
    }

    const actualArrow = interactionData
      ? arrowKind(interactionData.arrow, interactionData.intent, interactionData.direction)
      : 'binds';

    // Check for existing node
    const existingNode = findExistingInteractorNode(proteinId);
    let nodeId;

    if (existingNode) {
      // Create reference node
      nodeId = `ref_${proteinId}@${pathwayNode.id}`;
      if (!nodeMap.has(nodeId)) {
        const refNode = {
          id: nodeId,
          label: proteinId,
          symbol: proteinId,
          type: 'interactor',
          isReferenceNode: true,
          primaryNodeId: existingNode.id,
          originalId: proteinId,
          pathwayId: pathwayNode.id,
          _pathwayContext: pathwayNode.id,
          _pathwayName: pathwayNode.label,
          _directionRole: 'indirect',
          _anchorAngle: anchorAngle,
          radius: interactorNodeRadius * 0.85,
          arrow: actualArrow,
          interactionData: interactionData,
          x: x,
          y: y,
          expandRadius: expandRadius,
          isNewlyExpanded: true
        };
        nodes.push(refNode);
        nodeMap.set(nodeId, refNode);
        newlyAddedNodes.add(nodeId);
      }
    } else {
      nodeId = `${proteinId}@${pathwayNode.id}`;
      if (!nodeMap.has(nodeId)) {
        const newNode = {
          id: nodeId,
          label: proteinId,
          symbol: proteinId,
          type: 'interactor',
          originalId: proteinId,
          pathwayId: pathwayNode.id,
          _pathwayContext: pathwayNode.id,
          _pathwayName: pathwayNode.label,
          _directionRole: 'indirect',
          _anchorAngle: anchorAngle,
          radius: interactorNodeRadius,
          arrow: actualArrow,
          interactionData: interactionData,
          x: x,
          y: y,
          expandRadius: expandRadius,
          isNewlyExpanded: true
        };
        nodes.push(newNode);
        nodeMap.set(nodeId, newNode);
        newlyAddedNodes.add(nodeId);
      }
    }
    proteinNodeMap.set(proteinId, nodeId);
    console.log(`📍 Created indirect interactor node: ${proteinId} (mediator: ${mediator || 'none'})`);
  });

  // Step 5.6: Add missing query links for orphan proteins
  // Some proteins (like PARK2) appear in pathway data with interactor-interactor links
  // but have a link back to query in SNAP.interactions that's not in pathway data
  indirectProteins.forEach(proteinId => {
    const nodeId = proteinNodeMap.get(proteinId);
    if (!nodeId) return;

    // Check if this protein already has any link to/from query in this pathway expansion
    const hasQueryLink = links.some(l => {
      const src = l.source?.id || l.source;
      const tgt = l.target?.id || l.target;
      return (src === queryNodeId && tgt === nodeId) ||
        (tgt === queryNodeId && src === nodeId);
    });

    if (!hasQueryLink) {
      // Check SNAP.interactions for a direct link between query and this protein
      const snapInteraction = (SNAP.interactions || []).find(i =>
        (i.source === queryProtein && i.target === proteinId) ||
        (i.target === queryProtein && i.source === proteinId)
      );

      if (snapInteraction) {
        // Add the missing link from query to this protein
        const linkId = `${queryNodeId}-${nodeId}@${pathwayNode.id}`;
        if (!links.find(l => l.id === linkId)) {
          const actualArrow = arrowKind(snapInteraction.arrow, snapInteraction.intent, snapInteraction.direction);
          links.push({
            id: linkId,
            source: queryNodeId,
            target: nodeId,
            type: 'interaction-edge',
            arrow: actualArrow,
            direction: snapInteraction.direction || 'bidirectional',
            data: snapInteraction,
            _pathwayContext: pathwayNode.id,
            _addedFromSNAP: true  // Mark as added from global interactions
          });
          console.log(`📍 Added missing query link: ${queryProtein} → ${proteinId} (${actualArrow})`);
        }
      }
    }
  });

  // Step 6: Create anchor links from pathway to upstream proteins (they flow into query)
  upstreamArray.forEach(proteinId => {
    const nodeId = proteinNodeMap.get(proteinId);
    const anchorLinkId = `${pathwayNode.id}-anchor-${nodeId}`;
    if (!links.find(l => l.id === anchorLinkId)) {
      links.push({
        id: anchorLinkId,
        source: pathwayNode.id,
        target: nodeId,
        type: 'pathway-anchor-link',
        arrow: 'none',
        opacity: 0.25
      });
    }
  });

  // If no upstream proteins, anchor to query directly
  if (upstreamArray.length === 0) {
    const anchorLinkId = `${pathwayNode.id}-anchor-${queryNodeId}`;
    if (!links.find(l => l.id === anchorLinkId)) {
      links.push({
        id: anchorLinkId,
        source: pathwayNode.id,
        target: queryNodeId,
        type: 'pathway-anchor-link',
        arrow: 'none',
        opacity: 0.25
      });
    }
  }

  // Step 7: Create interaction edges with proper direction
  // upstream → query, query → downstream, bidirectional ↔ query
  interactions.forEach(inter => {
    const src = inter.source;
    const tgt = inter.target;
    const dir = inter.direction || 'bidirectional';

    // Determine link endpoints
    let linkSource, linkTarget;

    if (src === queryProtein) {
      // Query is source: query → other
      linkSource = queryNodeId;
      linkTarget = proteinNodeMap.get(tgt);
    } else if (tgt === queryProtein) {
      // Query is target: other → query
      linkSource = proteinNodeMap.get(src);
      linkTarget = queryNodeId;
    } else {
      // Neither is query: interactor → interactor link
      linkSource = proteinNodeMap.get(src);
      linkTarget = proteinNodeMap.get(tgt);
    }

    if (!linkSource || !linkTarget || linkSource === linkTarget) return;

    const linkId = `${linkSource}-${linkTarget}@${pathwayNode.id}`;
    if (links.find(l => l.id === linkId)) return;

    const actualArrow = arrowKind(inter.arrow, inter.intent, inter.direction);

    links.push({
      id: linkId,
      source: linkSource,
      target: linkTarget,
      type: 'interaction-edge',
      arrow: actualArrow,
      direction: dir,
      confidence: inter.confidence || 0.5,
      data: inter,
      _pathwayContext: pathwayNode.id,
      _directionType: dir
    });
  });

  console.log(`🛤️ Expanded pathway: ${pathwayNode.label} - ${upstream.size} upstream, ${downstream.size} downstream, ${bidirectional.size} bidirectional`);
}

/**
 * Collapse a pathway node - remove its interactors
 */
function collapsePathway(pathwayNode) {
  expandedPathways.delete(pathwayNode.id);
  pathwayNode.expanded = false;
  // Note: Radial force will automatically return pathway to base radius (350px)

  // ALWAYS remove ALL nodes belonging to this pathway (including reference nodes)
  // User preference: collapse removes nodes regardless of visibility elsewhere
  const nodesToRemove = new Set();
  nodes.forEach(n => {
    if (n.pathwayId === pathwayNode.id) {
      nodesToRemove.add(n.id);
    }
  });

  // Remove nodes
  nodes = nodes.filter(n => !nodesToRemove.has(n.id));

  // Remove associated links
  links = links.filter(l => {
    const sourceId = typeof l.source === 'object' ? l.source.id : l.source;
    const targetId = typeof l.target === 'object' ? l.target.id : l.target;
    return !nodesToRemove.has(sourceId) && !nodesToRemove.has(targetId);
  });

  // Rebuild node map
  rebuildNodeMap();

  console.log(`🛤️ Collapsed pathway: ${pathwayNode.label} (removed ${nodesToRemove.size} nodes)`);
}

/**
 * Expand a pathway to show its child sub-pathways (hierarchy expansion)
 */
function expandPathwayHierarchy(pathwayNode) {
  expandedHierarchyPathways.add(pathwayNode.id);
  pathwayNode.hierarchyExpanded = true;

  const hier = pathwayHierarchy.get(pathwayNode.originalId || pathwayNode.id);
  const childIds = pathwayNode.childPathwayIds || hier?.child_ids || [];

  // Check for interactors (for mixed content handling)
  const hasInteractors = checkPathwayHasInteractors(pathwayNode);

  if (childIds.length === 0 && !hasInteractors) {
    console.warn(`⚠️ No children or interactors for pathway: ${pathwayNode.label}`);
    return;
  }

  // Get child pathway data from stored allPathwaysData
  const childPathways = allPathwaysData.filter(pw => {
    const pwId = pw.id || `pathway_${pw.name.replace(/\s+/g, '_')}`;
    return childIds.includes(pwId);
  });

  // Calculate positions for child pathways
  const totalItems = childPathways.length;

  // Calculate positions around parent
  // Pathway children need more distance: parent radius (~50) + child radius (~45) + gap (35) = 130
  const PATHWAY_MIN_CHILD_DISTANCE = 130;
  const baseExpandRadius = calculateExpandRadius(totalItems, 60);
  const expandRadius = Math.max(baseExpandRadius, PATHWAY_MIN_CHILD_DISTANCE);
  const angleStep = (2 * Math.PI) / Math.max(totalItems, 1);

  childPathways.forEach((child, idx) => {
    const childId = child.id || `pathway_${child.name.replace(/\s+/g, '_')}`;
    const nodeId = `${childId}@${pathwayNode.id}`;  // Context-qualified ID

    // Calculate angle - evenly distributed, recalculateShellPositions handles final layout
    const angle = idx * angleStep - Math.PI / 2;

    // Check if this pathway already exists under another parent (DAG handling)
    const existingNode = findExistingPathwayNode(childId);

    if (existingNode && existingNode.parentPathwayId !== pathwayNode.id) {
      // Create reference node instead of duplicate
      const refNodeId = `ref_${childId}@${pathwayNode.id}`;
      if (!nodeMap.has(refNodeId)) {
        const x = pathwayNode.x + expandRadius * Math.cos(angle);
        const y = pathwayNode.y + expandRadius * Math.sin(angle);

        const refNode = {
          id: refNodeId,
          label: child.name,
          type: 'pathway',
          isReferenceNode: true,
          primaryNodeId: existingNode.id,
          originalId: childId,
          parentPathwayId: pathwayNode.id,
          hierarchyLevel: existingNode.hierarchyLevel,
          radius: PATHWAY_SIZES[Math.min(existingNode.hierarchyLevel || 1, 3)].radius,
          x: x,
          y: y
        };

        nodes.push(refNode);
        nodeMap.set(refNodeId, refNode);
        newlyAddedNodes.add(refNodeId);

        // Link with reference style
        links.push({
          id: `${pathwayNode.id}-${refNodeId}`,
          source: pathwayNode.id,
          target: refNodeId,
          type: 'pathway-reference-link'
        });
      }
    } else if (!nodeMap.has(nodeId)) {
      // Normal child node creation
      const x = pathwayNode.x + expandRadius * Math.cos(angle);
      const y = pathwayNode.y + expandRadius * Math.sin(angle);

      const childHier = pathwayHierarchy.get(childId);
      const level = childHier?.level || (pathwayNode.hierarchyLevel || 0) + 1;
      const sizing = PATHWAY_SIZES[Math.min(level, 3)];

      const newNode = {
        id: nodeId,
        label: child.name,
        type: 'pathway',
        originalId: childId,
        parentPathwayId: pathwayNode.id,
        hierarchyLevel: level,
        isLeaf: childHier?.is_leaf ?? child.is_leaf ?? true,
        childPathwayIds: childHier?.child_ids || child.child_pathway_ids || [],
        ancestry: childHier?.ancestry || child.ancestry || [child.name],
        interactorIds: child.interactor_ids || [],
        ontologyId: child.ontology_id,
        interactionCount: child.interaction_count || 0,
        expanded: false,
        hierarchyExpanded: false,
        radius: sizing.radius,
        x: x,
        y: y,
        isNewlyExpanded: true
      };

      nodes.push(newNode);
      nodeMap.set(nodeId, newNode);
      newlyAddedNodes.add(nodeId);

      // Store interactor mapping for this child
      pathwayToInteractors.set(nodeId, new Set(child.interactor_ids || []));

      // Link from parent pathway to child pathway
      links.push({
        id: `${pathwayNode.id}-${nodeId}`,
        source: pathwayNode.id,
        target: nodeId,
        type: 'pathway-hierarchy-link'
      });
    }
  });

  // Show interactors directly (no placeholder) if pathway has any
  if (hasInteractors) {
    const pathwayId = pathwayNode.id;
    const originalId = pathwayNode.originalId || pathwayId;
    const pathwayInteractions = pathwayToInteractions.get(pathwayId) || pathwayToInteractions.get(originalId) || [];

    if (pathwayInteractions.length > 0) {
      // Mark as expanded and show interactors directly
      expandedPathways.add(pathwayId);
      pathwayNode.expanded = true;
      expandPathwayWithInteractions(pathwayNode, pathwayInteractions);
      console.log(`🔗 Expanded interactors for: ${pathwayNode.label} (${pathwayInteractions.length} interactions)`);
    }
  }

  console.log(`🌳 Expanded hierarchy: ${pathwayNode.label} → ${childPathways.length} sub-pathways${hasInteractors ? ' + interactors' : ''}`);
}

/**
 * Check if a pathway has interactors (either directly or via interactions)
 */
function checkPathwayHasInteractors(pathwayNode) {
  const pathwayId = pathwayNode.id;
  const originalId = pathwayNode.originalId || pathwayId;

  // Check pathwayToInteractors map
  const interactorIds = pathwayToInteractors.get(pathwayId) || pathwayToInteractors.get(originalId);
  if (interactorIds && interactorIds.size > 0) return true;

  // Check pathwayToInteractions map (new format)
  const interactions = pathwayToInteractions.get(pathwayId) || pathwayToInteractions.get(originalId);
  if (interactions && interactions.length > 0) return true;

  return false;
}

/**
 * Find an existing pathway node by its originalId (for DAG handling)
 */
function findExistingPathwayNode(pathwayId) {
  for (const node of nodes) {
    if (node.type === 'pathway' && !node.isReferenceNode) {
      if (node.id === pathwayId || node.originalId === pathwayId) {
        return node;
      }
    }
  }
  return null;
}

/**
 * Find an existing interactor node by protein symbol (for DAG handling)
 * Returns the PRIMARY node (not reference nodes) if the protein is already visible
 */
function findExistingInteractorNode(symbol) {
  for (const node of nodes) {
    if (node.type === 'interactor' && !node.isReferenceNode) {
      // Match by symbol/label or originalId
      if (node.symbol === symbol || node.label === symbol || node.originalId === symbol) {
        return node;
      }
    }
  }
  return null;
}

/**
 * Create an "Interactors" placeholder node for pathways with mixed content
 * When a pathway has both sub-pathways and interactors, this placeholder
 * allows users to expand interactors separately
 * @param {Object} pathwayNode - The parent pathway node
 * @param {number} angle - Angular position for the placeholder
 * @param {number} radius - Distance from parent
 * @returns {Object} - The placeholder node
 */
function createInteractorPlaceholder(pathwayNode, angle, radius) {
  const placeholderId = `${pathwayNode.id}_interactors_placeholder`;

  // Count interactors for this pathway
  const interactorIds = pathwayToInteractors.get(pathwayNode.id) || pathwayToInteractors.get(pathwayNode.originalId);
  const interactionData = pathwayToInteractions.get(pathwayNode.id) || pathwayToInteractions.get(pathwayNode.originalId);
  const interactorCount = interactorIds?.size || interactionData?.length || 0;

  if (interactorCount === 0) return null;

  const x = pathwayNode.x + radius * Math.cos(angle);
  const y = pathwayNode.y + radius * Math.sin(angle);

  const placeholder = {
    id: placeholderId,
    label: `${interactorCount} Interactors`,
    type: 'placeholder',
    isPlaceholder: true,
    pathwayId: pathwayNode.id,
    pathwayOriginalId: pathwayNode.originalId || pathwayNode.id,
    interactorCount: interactorCount,
    parentPathwayId: pathwayNode.id,
    hierarchyLevel: (pathwayNode.hierarchyLevel || 0) + 1,
    _pathwayContext: pathwayNode.id,
    _directionRole: 'placeholder',  // Prevent shell assignment warnings
    radius: 35,
    x: x,
    y: y,
    _targetAngle: angle,
    isNewlyExpanded: true
  };

  return placeholder;
}

/**
 * Handle click on an "Interactors" placeholder node
 * Removes the placeholder and expands actual interactors in its place
 * @param {Object} placeholderNode - The placeholder node that was clicked
 */
function handlePlaceholderClick(placeholderNode) {
  if (!placeholderNode || !placeholderNode.isPlaceholder) return;

  const pathwayId = placeholderNode.pathwayId;
  const pathwayOriginalId = placeholderNode.pathwayOriginalId || pathwayId;
  const pathwayNode = nodeMap.get(pathwayId);

  if (!pathwayNode) {
    console.warn(`⚠️ Parent pathway not found: ${pathwayId}`);
    return;
  }

  console.log(`📦 Expanding placeholder for: ${pathwayNode.label}`);

  // Capture placeholder's angle BEFORE removing it - used to anchor expanded interactors
  const placeholderAngle = placeholderNode._targetAngle;

  // Find ALL existing interactors to avoid overlapping ANY cluster
  // (not just nearby - deep child pathways like Aggrephagy may have interactors far from parent)
  const existingInteractors = nodes.filter(n =>
    n.type === 'interactor' &&
    n.id !== placeholderNode.id
  );

  // Calculate safe angle: position new interactors OPPOSITE to existing clusters
  let safeAngle = placeholderAngle;

  if (existingInteractors.length > 0) {
    // Calculate centroid of all existing interactors
    const centroidX = existingInteractors.reduce((sum, n) => sum + n.x, 0) / existingInteractors.length;
    const centroidY = existingInteractors.reduce((sum, n) => sum + n.y, 0) / existingInteractors.length;

    // Calculate angle FROM pathway TO centroid of existing clusters
    const angleToExisting = Math.atan2(
      centroidY - pathwayNode.y,
      centroidX - pathwayNode.x
    );

    // Position new interactors on OPPOSITE side (add PI radians = 180 degrees)
    safeAngle = angleToExisting + Math.PI;

    console.log(`📐 Existing cluster centroid at angle ${(angleToExisting * 180 / Math.PI).toFixed(1)}° → placing new interactors at ${(safeAngle * 180 / Math.PI).toFixed(1)}° (opposite side)`);
  } else {
    console.log(`📐 No existing interactors, using placeholder angle: ${(placeholderAngle * 180 / Math.PI).toFixed(1)}°`);
  }

  // Remove the placeholder node
  const placeholderIdx = nodes.findIndex(n => n.id === placeholderNode.id);
  if (placeholderIdx !== -1) {
    nodes.splice(placeholderIdx, 1);
  }
  nodeMap.delete(placeholderNode.id);

  // Remove link to placeholder
  const linkIdx = links.findIndex(l =>
    (l.source === placeholderNode.id || l.source?.id === placeholderNode.id) ||
    (l.target === placeholderNode.id || l.target?.id === placeholderNode.id)
  );
  if (linkIdx !== -1) {
    links.splice(linkIdx, 1);
  }

  // Now expand the actual interactors
  // Check for interaction data first (new format)
  const pathwayInteractions = pathwayToInteractions.get(pathwayId) ||
    pathwayToInteractions.get(pathwayOriginalId);

  if (pathwayInteractions && pathwayInteractions.length > 0) {
    expandedPathways.add(pathwayId);
    pathwayNode.expanded = true;
    // Pass safe angle (avoiding existing clusters) as anchor for shell positioning
    expandPathwayWithInteractions(pathwayNode, pathwayInteractions, {
      anchorAngle: safeAngle
    });
  } else {
    // Fallback to legacy expansion
    expandPathway(pathwayNode);
  }

  updateSimulation();
}

/**
 * Navigate to primary node when clicking a reference node
 * Pans the view and pulses the primary node
 */
function navigateToPrimaryNode(refNode) {
  if (!refNode.primaryNodeId) return;

  const primaryNode = nodeMap.get(refNode.primaryNodeId);
  if (!primaryNode) return;

  // Pan to center the primary node
  const scale = currentZoom;
  const x = width / 2 - primaryNode.x * scale;
  const y = height / 2 - primaryNode.y * scale;

  svg.transition()
    .duration(500)
    .call(zoomBehavior.transform, d3.zoomIdentity.translate(x, y).scale(scale));

  // Pulse the primary node
  pulseNode(primaryNode.id);
}

/**
 * Pulse animation for a node (highlight effect)
 */
function pulseNode(nodeId) {
  const nodeEl = d3.select(`[data-node-id="${nodeId}"]`);
  if (nodeEl.empty()) return;

  nodeEl.select('circle')
    .transition().duration(200)
    .attr('stroke-width', 6)
    .attr('stroke', '#fbbf24')
    .transition().duration(200)
    .attr('stroke-width', 4)
    .attr('stroke', '#fbbf24')
    .transition().duration(200)
    .attr('stroke-width', 6)
    .attr('stroke', '#fbbf24')
    .transition().duration(300)
    .attr('stroke-width', 2)
    .attr('stroke', null);  // Reset to CSS
}

/**
 * Collapse pathway hierarchy - remove child pathway nodes
 */
function collapsePathwayHierarchy(pathwayNode) {
  expandedHierarchyPathways.delete(pathwayNode.id);
  pathwayNode.hierarchyExpanded = false;

  const nodesToRemove = new Set();

  // Recursively collect all descendant nodes
  function collectDescendants(parentId) {
    nodes.forEach(n => {
      if (n.parentPathwayId === parentId) {
        nodesToRemove.add(n.id);
        // If this is a pathway, also collapse its children and interactors
        if (n.type === 'pathway') {
          collectDescendants(n.id);
          expandedHierarchyPathways.delete(n.id);
          expandedPathways.delete(n.id);
        }
      }
      // Also remove interactor nodes under this pathway
      if (n.pathwayId === parentId) {
        nodesToRemove.add(n.id);
      }
    });
  }

  collectDescendants(pathwayNode.id);

  // Remove nodes and associated links
  nodes = nodes.filter(n => !nodesToRemove.has(n.id));
  links = links.filter(l => {
    const srcId = typeof l.source === 'object' ? l.source.id : l.source;
    const tgtId = typeof l.target === 'object' ? l.target.id : l.target;
    return !nodesToRemove.has(srcId) && !nodesToRemove.has(tgtId);
  });

  rebuildNodeMap();
  console.log(`🌳 Collapsed hierarchy: ${pathwayNode.label}`);
}

/**
 * Expand pathway with lazy loading of interactors (for leaf pathways)
 */
const _loadingPathways = new Set();  // Prevent concurrent lazy loads for same pathway
async function expandPathwayWithLazyLoad(pathwayNode) {
  const pathwayId = pathwayNode.originalId || pathwayNode.id;

  // Check if we already have interactors cached
  if (pathwayNode.interactorIds?.length > 0) {
    expandPathway(pathwayNode);  // Use existing data
    return;
  }

  // Prevent concurrent loads for the same pathway
  if (_loadingPathways.has(pathwayId)) return;
  _loadingPathways.add(pathwayId);

  // Show loading indicator
  pathwayNode.loading = true;
  renderGraph();

  try {
    const response = await fetch(`/api/pathway/${encodeURIComponent(pathwayId)}/interactors`);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const data = await response.json();

    // Cache the interactors on the node
    pathwayNode.interactorIds = data.interactors.map(i => i.symbol);
    pathwayNode.interactorData = data.interactors;

    // Update the pathwayToInteractors map
    pathwayToInteractors.set(pathwayNode.id, new Set(pathwayNode.interactorIds));

    expandPathway(pathwayNode);
  } catch (error) {
    console.error(`❌ Failed to load interactors for ${pathwayNode.label}:`, error);
    // Fallback: try expanding with existing data
    expandPathway(pathwayNode);
  } finally {
    pathwayNode.loading = false;
    _loadingPathways.delete(pathwayId);
  }
}

/**
 * Pulse and center on a node (used for reference node navigation)
 */
function pulseAndCenter(node) {
  if (!node) return;

  // Center view on node
  const transform = d3.zoomIdentity
    .translate(width / 2 - node.x, height / 2 - node.y)
    .scale(1.2);

  svg.transition()
    .duration(500)
    .call(zoomBehavior.transform, transform);

  // Add pulse animation class
  const nodeElement = d3.select(`[data-node-id="${node.id}"]`);
  if (!nodeElement.empty()) {
    nodeElement.classed('pulse-highlight', true);
    setTimeout(() => {
      nodeElement.classed('pulse-highlight', false);
    }, 1500);
  }

  console.log(`🎯 Centered on: ${node.label}`);
}

/**
 * Show ancestry breadcrumb tooltip for pathway nodes
 */
function showAncestryTooltip(event, ancestry) {
  if (!ancestry || ancestry.length <= 1) return;

  let tooltip = document.getElementById('ancestry-tooltip');
  if (!tooltip) {
    tooltip = document.createElement('div');
    tooltip.id = 'ancestry-tooltip';
    tooltip.className = 'ancestry-tooltip';
    document.body.appendChild(tooltip);
  }

  // Build breadcrumb HTML
  const breadcrumb = ancestry.map((name, idx) => {
    const isLast = idx === ancestry.length - 1;
    const escapedName = name.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return `<span class="ancestry-item ${isLast ? 'current' : ''}">${escapedName}</span>`;
  }).join('<span class="ancestry-arrow">→</span>');

  tooltip.innerHTML = breadcrumb;
  tooltip.style.display = 'block';
  tooltip.style.left = `${event.pageX + 15}px`;
  tooltip.style.top = `${event.pageY - 30}px`;
}

/**
 * Hide ancestry tooltip
 */
function hideAncestryTooltip() {
  const tooltip = document.getElementById('ancestry-tooltip');
  if (tooltip) {
    tooltip.style.display = 'none';
  }
}

// Track newly added nodes for entry animation
let newlyAddedNodes = new Set();

/**
 * Update simulation after adding/removing nodes
 */
function updateSimulation() {
  if (!simulation) return;

  // Rebuild node map first
  rebuildNodeMap();

  if (layoutMode === 'shell') {
    // SHELL MODE: Recalculate deterministic positions
    recalculateShellPositions();

    // Update simulation nodes/links (needed for link resolution)
    simulation.nodes(nodes);
    if (simulation.force('link')) {
      simulation.force('link').links(links);
    }

    // Run collision resolution to push overlapping nodes apart
    // Shell positions are set, now let collision force resolve any overlaps
    simulation.alpha(0.8).alphaDecay(0.02).restart();  // More time to resolve collisions
  } else {
    // FORCE MODE: Standard physics update
    simulation.nodes(nodes);
    simulation.force('link').links(links);

    // Update radial force for pathways (recalculates expanded state)
    simulation.force('radialPathways', d3.forceRadial(
      d => {
        if (d.type === 'pathway') {
          return expandedPathways.has(d.id) ? pathwayRingRadius + 100 : pathwayRingRadius;
        }
        return 0;
      },
      width / 2,
      height / 2
    ).strength(d => d.type === 'pathway' ? 1.0 : 0));

    // Update pathway orbit force strength (active in pathway mode only)
    if (simulation.force('pathwayOrbit')) {
      simulation.force('pathwayOrbit').strength(pathwayMode ? 0.4 : 0);
    }

    // Restart simulation with higher alpha for responsive layout
    simulation.alpha(0.7).restart();
  }

  // Re-render nodes and links with animations
  renderGraph();

  // Clear newly added nodes after a delay (animation completes)
  setTimeout(() => {
    newlyAddedNodes.clear();
  }, 600);
}

/**
 * Re-render the graph after structural changes
 */
function renderGraph() {
  if (!g) return;

  // Remove existing elements
  g.selectAll('.node-group').remove();
  g.selectAll('path').remove();

  // Re-create links
  const link = g.append('g').selectAll('path')
    .data(links).enter().append('path')
    .attr('class', d => {
      if (d.type === 'pathway-link') return 'link pathway-link';
      // Pathway-interactor links: include arrow class for semantic coloring
      if (d.type === 'pathway-interactor-link') {
        const arrow = d.arrow || 'binds';
        let arrowClass = 'link-binding';
        if (arrow === 'activates') arrowClass = 'link-activate';
        else if (arrow === 'inhibits') arrowClass = 'link-inhibit';
        else if (arrow === 'regulates') arrowClass = 'link-regulate';
        // Add indirect-chain class for mediator → indirect interactor links (dashed style)
        const chainClass = d.linkType === 'indirect-chain' ? ' link-indirect-chain' : '';
        // Add reference class for links to reference nodes (dashed, lower opacity)
        const refClass = d.isReferenceLink ? ' link-reference' : '';
        return `link pathway-interactor-link ${arrowClass}${chainClass}${refClass}`;
      }
      // Interaction edges (protein ↔ protein within a pathway)
      if (d.type === 'interaction-edge') {
        const arrow = d.arrow || 'binds';
        let arrowClass = 'link-binding';
        if (arrow === 'activates') arrowClass = 'link-activate';
        else if (arrow === 'inhibits') arrowClass = 'link-inhibit';
        else if (arrow === 'regulates') arrowClass = 'link-regulate';
        return `link interaction-edge ${arrowClass}`;
      }
      // Pathway anchor link (subtle visual anchor from pathway to proteins)
      if (d.type === 'pathway-anchor-link') {
        return 'link pathway-anchor-link';
      }
      const arrow = d.arrow || 'binds';
      let classes = 'link';
      if (arrow === 'binds') classes += ' link-binding';
      else if (arrow === 'activates') classes += ' link-activate';
      else if (arrow === 'inhibits') classes += ' link-inhibit';
      else if (arrow === 'regulates') classes += ' link-regulate';
      else classes += ' link-binding';
      return classes;
    })
    .attr('marker-end', d => {
      if (d.type === 'pathway-link' || d.type === 'pathway-interactor-link' || d.type === 'pathway-anchor-link') return null;
      const a = d.arrow || 'binds';
      if (a === 'activates') return 'url(#arrow-activate)';
      if (a === 'inhibits') return 'url(#arrow-inhibit)';
      if (a === 'regulates') return 'url(#arrow-regulate)';
      return 'url(#arrow-binding)';
    })
    .attr('fill', 'none')
    .on('mouseover', function () { d3.select(this).style('stroke-width', '3.5'); svg.style('cursor', 'pointer'); })
    .on('mouseout', function () { d3.select(this).style('stroke-width', null); svg.style('cursor', null); })
    .on('click', handleLinkClick)
    .attr('d', calculateLinkPath);  // Initial path (shell mode needs this since tick may not fire)

  // Re-create nodes
  const node = g.append('g').selectAll('g')
    .data(nodes).enter().append('g')
    .attr('class', 'node-group')
    .attr('transform', d => `translate(${d.x || width / 2},${d.y || height / 2})`)  // Initial position (shell mode needs this)
    .call(d3.drag()
      .on('start', dragstarted)
      .on('drag', dragged)
      .on('end', dragended));

  node.each(function (d) {
    const group = d3.select(this);
    if (d.type === 'main') {
      group.append('circle')
        .attr('class', 'node main-node')
        .attr('r', mainNodeRadius)
        .style('cursor', 'pointer')
        .on('click', (ev) => { ev.stopPropagation(); handleNodeClick(d); });
      group.append('text')
        .attr('class', 'node-label main-label')
        .attr('dy', 5)
        .style('font-size', '16px')
        .style('font-weight', '700')
        .text(d.label);
    } else if (d.type === 'pathway') {
      // Pathway node - ROUNDED RECTANGLE with hierarchy-based styling
      const isDark = document.body.classList.contains('dark-mode');
      const hier = pathwayHierarchy.get(d.originalId || d.id);
      const level = d.hierarchyLevel || hier?.level || 0;
      const hasChildren = (d.childPathwayIds?.length || hier?.child_ids?.length || 0) > 0;
      const isLeaf = d.isLeaf ?? hier?.is_leaf ?? true;
      const isReference = d.isReferenceNode || false;

      // Size and color by hierarchy level
      const sizing = PATHWAY_SIZES[Math.min(level, 3)];
      const levelColor = PATHWAY_COLORS[Math.min(level, 3)];

      // Gradient based on expansion state
      let gradientId;
      if (d.expanded) {
        gradientId = isDark ? 'pathwayExpandedGradientDark' : 'pathwayExpandedGradient';
      } else if (d.hierarchyExpanded) {
        gradientId = isDark ? 'pathwayGradientDark' : 'pathwayGradient';  // Could add hierarchyExpandedGradient
      } else {
        gradientId = isDark ? 'pathwayGradientDark' : 'pathwayGradient';
      }

      // Calculate rectangle dimensions based on text length and level
      const fontSize = sizing.fontSize;
      const paddingX = 20;
      const charWidth = fontSize * 0.55;
      const textWidth = d.label.length * charWidth;
      const rectWidth = Math.max(textWidth + paddingX * 2, 100);
      const rectHeight = sizing.radius;

      // Store dimensions on node for collision detection
      d.rectWidth = rectWidth;
      d.rectHeight = rectHeight;

      // Node classes for styling
      const nodeClasses = [
        'node',
        'pathway-node',
        `level-${Math.min(level, 3)}`,
        d.expanded ? 'expanded' : '',
        d.hierarchyExpanded ? 'hierarchy-expanded' : '',
        isReference ? 'reference' : '',
        d.loading ? 'loading' : ''
      ].filter(Boolean).join(' ');

      const rect = group.append('rect')
        .attr('class', nodeClasses)
        .attr('data-node-id', d.id)
        .attr('width', rectWidth)
        .attr('height', rectHeight)
        .attr('x', -rectWidth / 2)
        .attr('y', -rectHeight / 2)
        .attr('rx', 10)
        .attr('ry', 10)
        .style('fill', `url(#${gradientId})`)
        .style('stroke', levelColor)
        .style('stroke-width', (d.expanded || d.hierarchyExpanded) ? '3px' : '2px')
        .style('cursor', 'pointer');

      // Reference node styling
      if (isReference) {
        rect.style('stroke-dasharray', '4, 2')
          .style('opacity', 0.7);
      }

      // Add hover events for ancestry tooltip + cluster highlighting
      rect.on('mouseenter', (ev) => {
        const ancestry = d.ancestry || hier?.ancestry || [d.label];
        showAncestryTooltip(ev, ancestry);
        // Highlight cluster when hovering pathway
        highlightCluster(d.id);
      })
        .on('mouseleave', () => {
          hideAncestryTooltip();
          clearClusterHighlight();
        })
        .on('click', (ev) => { ev.stopPropagation(); handlePathwayClick(d); });

      // Full pathway label (no truncation)
      group.append('text')
        .attr('class', 'node-label pathway-label')
        .attr('dy', 5)
        .attr('text-anchor', 'middle')
        .style('fill', 'white')
        .style('font-size', `${fontSize}px`)
        .style('font-weight', '700')
        .style('pointer-events', 'none')
        .text(d.label);

      // Reference icon for reference nodes
      if (isReference) {
        group.append('text')
          .attr('class', 'reference-icon')
          .attr('x', rectWidth / 2 - 14)
          .attr('y', 4)
          .attr('text-anchor', 'middle')
          .style('fill', 'white')
          .style('font-size', '12px')
          .style('pointer-events', 'none')
          .text('↗');
      }

      // Expand indicator (+/-) for non-leaf pathways
      if (hasChildren && !isLeaf && !isReference) {
        const icon = d.hierarchyExpanded ? '−' : '+';
        group.append('text')
          .attr('class', 'pathway-expand-icon')
          .attr('x', -rectWidth / 2 + 14)
          .attr('y', 5)
          .attr('text-anchor', 'middle')
          .style('fill', 'white')
          .style('font-size', '14px')
          .style('font-weight', 'bold')
          .style('pointer-events', 'none')
          .text(icon);
      }

      // Interactor count badge (top-right of rectangle) - only for leaf pathways
      const count = (d.interactorIds || []).length;
      if (count > 0 && (isLeaf || d.expanded)) {
        const badgeX = rectWidth / 2 - 8;
        const badgeY = -rectHeight / 2 - 4;

        group.append('circle')
          .attr('class', 'pathway-badge')
          .attr('cx', badgeX)
          .attr('cy', badgeY)
          .attr('r', 12)
          .style('fill', '#ef4444');

        group.append('text')
          .attr('class', 'pathway-badge-text')
          .attr('x', badgeX)
          .attr('y', badgeY)
          .attr('text-anchor', 'middle')
          .attr('dy', 4)
          .style('fill', 'white')
          .style('font-size', '10px')
          .style('font-weight', 'bold')
          .text(count);
      }

      // Loading indicator
      if (d.loading) {
        group.append('text')
          .attr('class', 'loading-indicator')
          .attr('x', 0)
          .attr('y', rectHeight / 2 + 16)
          .attr('text-anchor', 'middle')
          .style('fill', levelColor)
          .style('font-size', '10px')
          .text('Loading...');
      }
    } else if (d.type === 'placeholder' || d.isPlaceholder) {
      // PLACEHOLDER NODE - "N Interactors" clickable node
      const isDark = document.body.classList.contains('dark-mode');
      const isNew = newlyAddedNodes.has(d.id);

      // Rounded rectangle for placeholder
      const rectWidth = Math.max(100, d.label.length * 8 + 24);
      const rectHeight = 36;

      const rect = group.append('rect')
        .attr('class', 'node placeholder-node')
        .attr('width', rectWidth)
        .attr('height', rectHeight)
        .attr('x', -rectWidth / 2)
        .attr('y', -rectHeight / 2)
        .attr('rx', 18)
        .attr('ry', 18)
        .style('fill', isDark ? '#374151' : '#6b7280')
        .style('stroke', isDark ? '#9ca3af' : '#4b5563')
        .style('stroke-width', '2px')
        .style('stroke-dasharray', '6 3')
        .style('cursor', 'pointer')
        .style('opacity', isNew ? 0 : 1)
        .on('click', (ev) => { ev.stopPropagation(); handlePlaceholderClick(d); })
        .on('mouseenter', function () {
          d3.select(this).style('fill', isDark ? '#4b5563' : '#4b5563');
        })
        .on('mouseleave', function () {
          d3.select(this).style('fill', isDark ? '#374151' : '#6b7280');
        });

      // Label
      const label = group.append('text')
        .attr('class', 'node-label placeholder-label')
        .attr('dy', 5)
        .attr('text-anchor', 'middle')
        .style('fill', 'white')
        .style('font-size', '12px')
        .style('font-weight', '600')
        .style('pointer-events', 'none')
        .style('opacity', isNew ? 0 : 1)
        .text(d.label);

      // Expand icon
      group.append('text')
        .attr('class', 'placeholder-icon')
        .attr('x', rectWidth / 2 - 16)
        .attr('y', 5)
        .attr('text-anchor', 'middle')
        .style('fill', 'white')
        .style('font-size', '14px')
        .style('font-weight', 'bold')
        .style('pointer-events', 'none')
        .text('+');

      // Entry animation
      if (isNew) {
        rect.transition()
          .duration(400)
          .ease(d3.easeCubicOut)
          .style('opacity', 1);

        label.transition()
          .duration(400)
          .delay(100)
          .ease(d3.easeCubicOut)
          .style('opacity', 1);
      }
    } else {
      // Interactor node - use semantic coloring based on interaction type
      const arrowClass = getNodeArrowClass(d);
      const isNewNode = newlyAddedNodes.has(d.id);

      // Add entry animation class for newly expanded nodes
      const animationClass = isNewNode ? 'node-entering' : '';

      // Add query protein class for special styling
      const queryClass = d.isQueryProtein ? 'is-query-protein' : '';

      // REFERENCE NODE: dashed border, dimmed, navigation cursor
      const refClass = d.isReferenceNode ? 'reference-node' : '';

      const circle = group.append('circle')
        .attr('class', `node interactor-node ${arrowClass} ${animationClass} ${queryClass} ${refClass}`.trim())
        .attr('r', isNewNode ? 0 : (d.radius || interactorNodeRadius))  // Start small for animation
        .style('fill', getNodeGradient(d))
        .style('cursor', d.isReferenceNode ? 'alias' : 'pointer')  // Alias cursor for reference
        .style('opacity', isNewNode ? 0 : (d.isReferenceNode ? 0.7 : 1))  // Dimmed reference nodes
        .style('stroke-dasharray', d.isReferenceNode ? '4 2' : null)  // Dashed border
        .style('stroke-width', d.isReferenceNode ? 2 : null)
        .on('click', (ev) => { ev.stopPropagation(); handleNodeClick(d); })
        .on('mouseenter', function (ev) {
          if (d._pathwayContext) highlightCluster(d._pathwayContext);
        })
        .on('mouseleave', function (ev) {
          clearClusterHighlight();
        });

      // Add navigation icon for reference nodes
      if (d.isReferenceNode) {
        group.append('text')
          .attr('class', 'reference-icon')
          .attr('x', (d.radius || interactorNodeRadius) * 0.5)
          .attr('y', -(d.radius || interactorNodeRadius) * 0.5)
          .style('font-size', '10px')
          .style('fill', '#a78bfa')
          .style('pointer-events', 'none')
          .text('↗');
      }

      // Add multi-pathway badge if protein appears in multiple pathways
      const nodeRadius = d.radius || interactorNodeRadius;
      const proteinId = d.originalId || d.label || d.id;
      const pathwayCount = countPathwaysForProtein(proteinId);
      if (pathwayCount > 1) {
        group.append('circle')
          .attr('class', 'multi-pathway-badge-bg')
          .attr('cx', nodeRadius - 5)
          .attr('cy', -nodeRadius + 5)
          .attr('r', 10)
          .attr('fill', '#7c3aed')
          .style('pointer-events', 'none');

        group.append('text')
          .attr('class', 'multi-pathway-badge')
          .attr('x', nodeRadius - 5)
          .attr('y', -nodeRadius + 9)
          .attr('text-anchor', 'middle')
          .attr('fill', 'white')
          .attr('font-size', '10px')
          .attr('font-weight', 'bold')
          .style('pointer-events', 'none')
          .style('user-select', 'none')
          .text(pathwayCount);
      }

      const label = group.append('text')
        .attr('class', `node-label interactor-label ${arrowClass} ${queryClass} ${refClass}`.trim())
        .attr('dy', 5)
        .style('font-size', '13px')
        .style('font-weight', '600')
        .style('opacity', isNewNode ? 0 : (d.isReferenceNode ? 0.7 : 1))  // Dimmed for reference
        .text(d.label);

      // Animate entry for new nodes
      if (isNewNode) {
        circle.transition()
          .duration(400)
          .ease(d3.easeCubicOut)
          .attr('r', d.radius || interactorNodeRadius)
          .style('opacity', 1);

        label.transition()
          .duration(400)
          .delay(100)
          .ease(d3.easeCubicOut)
          .style('opacity', 1);

        // Animate position from parent to target
        if (d.targetX !== undefined && d.targetY !== undefined) {
          d.x = d.targetX;
          d.y = d.targetY;
        }
      }
    }
  });

  // Update tick handler
  simulation.on('tick', () => {
    resolveNodeLinkCollisions();  // Push nodes away from link lines
    node.attr('transform', d => `translate(${d.x},${d.y})`);
    link.attr('d', calculateLinkPath);
  });

  linkGroup = link;
  nodeGroup = node;
}

/**
 * Link path calculation with parallel link offset
 * Bidirectional/parallel links between same nodes curve in opposite directions
 */
function calculateLinkPath(d) {
  const sourceNode = typeof d.source === 'object' ? d.source : nodeMap.get(d.source);
  const targetNode = typeof d.target === 'object' ? d.target : nodeMap.get(d.target);

  if (!sourceNode || !targetNode) return 'M 0 0';

  const x1 = sourceNode.x;
  const y1 = sourceNode.y;
  const x2 = targetNode.x;
  const y2 = targetNode.y;

  const dx = x2 - x1;
  const dy = y2 - y1;
  const dist = Math.sqrt(dx * dx + dy * dy);

  // Straight line for very short links or zero distance
  if (dist < 80 || dist === 0) {
    return `M ${x1} ${y1} L ${x2} ${y2}`;
  }

  // Perpendicular vector to the link direction
  const perpX = -dy / dist;
  const perpY = dx / dist;

  // Calculate offset for parallel links between same node pair
  const srcId = sourceNode.id;
  const tgtId = targetNode.id;
  const linkKey = [srcId, tgtId].sort().join('::');

  // Find all links between these two nodes (parallel/bidirectional links)
  const parallelLinks = links.filter(l => {
    const s = typeof l.source === 'object' ? l.source.id : l.source;
    const t = typeof l.target === 'object' ? l.target.id : l.target;
    return [s, t].sort().join('::') === linkKey;
  });

  const linkIndex = parallelLinks.indexOf(d);
  const totalParallel = parallelLinks.length;

  // Offset parallel links perpendicular to direction (±16px per link)
  // This separates bidirectional arrows so they don't overlap
  const parallelOffset = totalParallel > 1
    ? (linkIndex - (totalParallel - 1) / 2) * 16
    : 0;

  // CURVED LINKS: Quadratic bezier that curves away from center
  const midX = (x1 + x2) / 2;
  const midY = (y1 + y2) / 2;
  const cx = width / 2;
  const cy = height / 2;

  // Determine curve direction: curve AWAY from center
  const midToCenterX = cx - midX;
  const midToCenterY = cy - midY;
  const dot = perpX * midToCenterX + perpY * midToCenterY;
  const sign = dot > 0 ? -1 : 1;

  // Curve strength + parallel offset (increased base curve for better separation)
  const curveStrength = Math.min(dist * 0.15, 60);
  const ctrlX = midX + perpX * (curveStrength * sign + parallelOffset);
  const ctrlY = midY + perpY * (curveStrength * sign + parallelOffset);

  return `M ${x1} ${y1} Q ${ctrlX} ${ctrlY} ${x2} ${y2}`;
}

function forceClusterBounds() { return () => { }; } // No-op
function forceIndirectClustering() { return () => { }; } // No-op
function initializeClusterLayout() { } // No-op


// Drag handlers removed - static layout with fixed positions
// User can zoom/pan the entire graph, but nodes don't move individually

/* ===============================================================
   MODAL SYSTEM
   =============================================================== */

let modalOpen = false;

function openModal(titleHTML, bodyHTML) {
  document.getElementById('modalTitle').innerHTML = titleHTML;
  document.getElementById('modalBody').innerHTML = bodyHTML;
  document.getElementById('modal').classList.add('active');
  modalOpen = true;
  document.addEventListener('keydown', handleModalEscape);
  // Event delegation handles expandable rows automatically - no setTimeout needed
}

function closeModal() {
  document.getElementById('modal').classList.remove('active');
  modalOpen = false;
  document.removeEventListener('keydown', handleModalEscape);
}

function handleModalEscape(e) {
  if (e.key === 'Escape' && modalOpen) {
    closeModal();
  }
}

document.getElementById('modal').addEventListener('click', (e) => {
  if (e.target.id === 'modal') closeModal();
});

// Event delegation for modal expandable rows - handles all clicks via bubbling
// More robust than setTimeout-based listener attachment
document.getElementById('modalBody').addEventListener('click', (e) => {
  // Handle function expandable rows
  const funcHeader = e.target.closest('.function-row-header');
  if (funcHeader) {
    const row = funcHeader.closest('.function-expandable-row');
    if (row) row.classList.toggle('expanded');
    return;
  }

  // Handle interaction expandable rows
  const interactionHeader = e.target.closest('.interaction-row-header');
  if (interactionHeader) {
    const row = interactionHeader.closest('.interaction-expandable-row');
    const content = row?.querySelector('.interaction-expanded-content');
    const icon = row?.querySelector('.interaction-expand-icon');

    if (row && content) {
      const isExpanded = row.classList.contains('expanded');
      if (isExpanded) {
        row.classList.remove('expanded');
        content.style.maxHeight = '0';
        content.style.opacity = '0';
        if (icon) icon.style.transform = 'rotate(0deg)';
      } else {
        row.classList.add('expanded');
        content.style.maxHeight = '2000px';
        content.style.opacity = '1';
        if (icon) icon.style.transform = 'rotate(180deg)';
      }
    }
  }
});

/* Helper: Check if pathway context matches function pathway (exact or hierarchy) */
function isPathwayInContext(fnPathway, fnHierarchy, pathwayContext) {
  if (!pathwayContext?.name || !fnPathway) return false;
  const contextName = pathwayContext.name.toLowerCase();
  // Check exact match
  if (fnPathway.toLowerCase() === contextName) return true;
  // Check if context pathway is in function's hierarchy
  if (fnHierarchy && Array.isArray(fnHierarchy)) {
    return fnHierarchy.some(h => h.toLowerCase() === contextName);
  }
  return false;
}

/* Helper: Render an expandable function row */
function renderExpandableFunction(fn, mainProtein, interactorProtein, defaultInteractionEffect, parentDirection, pathwayContext = null, interactionPathway = null) {
  const functionName = escapeHtml(fn.function || 'Function');

  // Pathway badge logic: Prioritize interaction-level assignment if no function-specific pathway
  let pathwayBadgeHTML = '';
  // FIX: Handle both object (legacy) and string (V2) formats for function pathway
  const fnPathwayRaw = fn.pathway;
  const fnPathway = (typeof fnPathwayRaw === 'string') ? fnPathwayRaw : (fnPathwayRaw?.canonical_name || fnPathwayRaw?.name);
  const fnHierarchy = (typeof fnPathwayRaw === 'object' && fnPathwayRaw?.hierarchy) ? fnPathwayRaw.hierarchy : [];

  if (fnPathway) {
    // 1. Function has explicit pathway data
    // ✅ FIXED: Check both exact match AND hierarchy ancestry
    const matchesContext = isPathwayInContext(fnPathway, fnHierarchy, pathwayContext);
    const tooltipText = fnHierarchy.length > 1 ? fnHierarchy.join(' → ') : fnPathway;

    if (matchesContext) {
      pathwayBadgeHTML = `<span class="pathway-badge current" style="font-size: 10px; padding: 2px 6px; border-radius: 4px; margin-right: 8px; background: #10b981; color: white; cursor: help;" title="${escapeHtml(tooltipText)}">${escapeHtml(fnPathway)}</span>`;
    } else {
      pathwayBadgeHTML = `<span class="pathway-badge other" style="font-size: 10px; padding: 2px 6px; border-radius: 4px; margin-right: 8px; background: #6b7280; color: white; opacity: 0.7; cursor: help;" title="${escapeHtml(tooltipText)}">${escapeHtml(fnPathway)}</span>`;
    }
  } else if (interactionPathway) {
    // 2. Fallback to Interaction-Level Assignment (V2 Pipeline)
    // This handles the user request to show the assigned pathway next to each function
    pathwayBadgeHTML = `<span class="pathway-badge assigned" style="font-size: 10px; padding: 2px 6px; border-radius: 4px; margin-right: 8px; background: #3b82f6; color: white; cursor: help;" title="Assigned by Pipeline V2">${escapeHtml(interactionPathway)}</span>`;
  } else if (pathwayContext?.name) {
    // 3. Fallback to viewing context
    pathwayBadgeHTML = `<span class="pathway-badge inherited" style="font-size: 10px; padding: 2px 6px; border-radius: 4px; margin-right: 8px; background: #10b981; color: white; opacity: 0.5; cursor: help;" title="Inherited from current view">${escapeHtml(pathwayContext.name)}</span>`;
  }

  // --- DATA PREPARATION (From Table View Logic) ---
  const fnDirection = parentDirection || fn.interaction_direction || fn.direction || 'main_to_primary';
  let sourceProtein, targetProtein, arrowSymbol;
  if (fnDirection === 'primary_to_main') {
    sourceProtein = interactorProtein;
    targetProtein = mainProtein;
    arrowSymbol = '→';
  } else if (fnDirection === 'bidirectional') {
    sourceProtein = mainProtein;
    targetProtein = interactorProtein;
    arrowSymbol = '↔';
  } else {
    // main_to_primary
    sourceProtein = mainProtein;
    targetProtein = interactorProtein;
    arrowSymbol = '→';
  }

  // Interaction Effect
  // FIX: Prioritize the passed defaultInteractionEffect (from Link) over fn.interaction_effect
  // This ensures consistency with Table View which relies on the Link's arrow.
  let interactionEffect = defaultInteractionEffect || fn.interaction_effect || 'binds';
  const interactionArrowClass = arrowKind(interactionEffect, fn.intent, fnDirection);
  const interactionEffectBadgeText = formatArrow(interactionEffect);
  const interactionEffectBadge = `<span class="effect-badge effect-${interactionArrowClass}">${interactionEffectBadgeText}</span>`;

  // Function Effect
  const fnArrow = fn.arrow || 'binds';
  // Context override logic
  if (interactionEffect === 'binds' && fn._context && fn._context.type === 'chain') {
    if (fnArrow === 'activates' || fnArrow === 'inhibits') {
      interactionEffect = fnArrow;
    }
  }
  const functionArrowClass = arrowKind(fnArrow, fn.intent, fnDirection);
  const functionEffectBadgeText = formatArrow(fnArrow);
  const functionEffectBadge = `<span class="effect-badge effect-${functionArrowClass}">${functionEffectBadgeText}</span>`;

  // Helper Data
  const contextBadge = fn._context ? (fn._context.type === 'chain' ? '<span class="context-badge" style="background: #f59e0b; color: white; font-size: 9px; padding: 2px 6px; border-radius: 3px; margin-left: 6px;">CHAIN CONTEXT</span>' : '<span class="context-badge" style="background: #10b981; color: white; font-size: 9px; padding: 2px 6px; border-radius: 3px; margin-left: 6px;">DIRECT PAIR</span>') : '';

  // Interaction Display (Header)
  const interactionDisplay = `
    <span class="detail-interaction">
      ${escapeHtml(sourceProtein)}
      <span class="detail-arrow">${arrowSymbol}</span>
      ${escapeHtml(targetProtein)}
    </span>
    ${interactionEffectBadge}
  `;

  // --- CONTENT CONSTRUCTION (Restoring "Pretty" Layout) ---
  let expandedSections = '';

  // 1. Effects Summary (Enhanced with Table View Data)
  expandedSections += `
    <div class="function-detail-section section-effects-summary section-highlighted" style="background: var(--color-bg-secondary); border-left: 3px solid var(--color-primary);">
      <div class="function-section-title">🎯 Effects Summary</div>
      <div class="function-section-content">
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
          <div>
            <div style="font-size: 0.75rem; text-transform: uppercase; color: var(--color-text-secondary); margin-bottom: 4px;">Interaction</div>
            <div style="font-size: 0.9rem; margin-bottom: 4px;">
              ${escapeHtml(sourceProtein)} ${arrowSymbol} ${escapeHtml(targetProtein)}
            </div>
            ${interactionEffectBadge}
          </div>
          <div>
            <div style="font-size: 0.75rem; text-transform: uppercase; color: var(--color-text-secondary); margin-bottom: 4px;">Function</div>
            <div style="font-size: 0.9rem; margin-bottom: 4px;">
              ${escapeHtml(functionName)}
            </div>
            ${functionEffectBadge}
          </div>
        </div>
      </div>
    </div>
  `;

  // 2. Mechanism (from cellular_process)
  if (fn.cellular_process) {
    expandedSections += `
      <div class="function-detail-section section-mechanism section-highlighted">
        <div class="function-section-title">⚙️ Mechanism</div>
        <div class="function-section-content">
          <div style="margin-bottom: 8px;">${escapeHtml(fn.cellular_process)}</div>
        </div>
      </div>
    `;
  }

  // 3. Effect Description
  if (fn.effect_description) {
    expandedSections += `
      <div class="function-detail-section section-effect section-highlighted effect-${functionArrowClass}">
        <div class="function-section-title">💡 Effect</div>
        <div class="function-section-content">${escapeHtml(fn.effect_description)}</div>
      </div>
    `;
  }

  // 4. Biological Cascade
  if (Array.isArray(fn.biological_consequence) && fn.biological_consequence.length > 0) {
    const cascadesHTML = fn.biological_consequence.map((cascade, idx) => {
      const text = (cascade == null ? '' : cascade).toString().trim();
      if (!text) return '';
      const steps = text.split('→').map(s => s.trim()).filter(s => s.length > 0);
      if (steps.length === 0) return '';
      return `
          <div class="cascade-scenario">
            <div class="cascade-scenario-label">Scenario ${idx + 1}</div>
            <div class="cascade-flow-container">
              ${steps.map(step => `<div class="cascade-flow-item">${escapeHtml(step)}</div>`).join('')}
            </div>
          </div>
        `;
    }).join('');

    if (cascadesHTML) {
      expandedSections += `
        <div class="function-detail-section">
          <div class="function-section-title">Biological Cascade</div>
          ${cascadesHTML}
        </div>
      `;
    }
  }

  // 5. Specific Effects
  if (Array.isArray(fn.specific_effects) && fn.specific_effects.length > 0) {
    expandedSections += `
      <div class="function-detail-section section-specific-effects section-highlighted">
        <div class="function-section-title">⚡ Specific Effects</div>
        <ul style="margin: 0; padding-left: 1.5em;">
          ${fn.specific_effects.map(eff => `<li class="function-section-content">${escapeHtml(eff)}</li>`).join('')}
        </ul>
      </div>
    `;
  }

  // 6. Evidence (Pretty Card Style)
  if (Array.isArray(fn.evidence) && fn.evidence.length > 0) {
    expandedSections += `
      <div class="function-detail-section">
        <div class="function-section-title">Evidence & Publications</div>
        ${fn.evidence.map(ev => {
      const title = ev.paper_title || (ev.pmid ? `PMID: ${ev.pmid}` : 'Untitled');
      const metaParts = [];
      if (ev.journal) metaParts.push(escapeHtml(ev.journal));
      if (ev.year) metaParts.push(escapeHtml(ev.year));
      const meta = metaParts.join(' · ');

      let pmidLinks = '';
      if (ev.pmid) pmidLinks += `<a href="https://pubmed.ncbi.nlm.nih.gov/${escapeHtml(ev.pmid)}" target="_blank" class="pmid-badge" onclick="event.stopPropagation();">PMID: ${escapeHtml(ev.pmid)}</a>`;
      if (ev.doi) pmidLinks += `<a href="https://doi.org/${escapeHtml(ev.doi)}" target="_blank" class="pmid-badge" onclick="event.stopPropagation();">DOI</a>`;

      return `
            <div class="evidence-card">
              <div class="evidence-title">${escapeHtml(title)}</div>
              ${meta ? `<div class="evidence-meta">${meta}</div>` : ''}
              ${ev.relevant_quote ? `<div class="evidence-quote">"${escapeHtml(ev.relevant_quote)}"</div>` : ''}
              ${pmidLinks ? `<div style="margin-top: var(--space-2);">${pmidLinks}</div>` : ''}
            </div>
          `;
    }).join('')}
      </div>
    `;
  } else if (fn.pmids && fn.pmids.length > 0) {
    expandedSections += `
      <div class="function-detail-section">
        <div class="function-section-title">References</div>
        <div>
          ${fn.pmids.map(pmid => `<a href="https://pubmed.ncbi.nlm.nih.gov/${escapeHtml(pmid)}" target="_blank" class="pmid-badge">PMID: ${escapeHtml(pmid)}</a>`).join('')}
        </div>
      </div>
    `;
  }

  // Build Final Row HTML
  return `
    <div class="function-expandable-row">
      <div class="function-row-header">
        <div class="function-row-left">
          <div class="function-expand-icon">▼</div>
          ${pathwayBadgeHTML}
          <div class="function-name-with-effect">
            <div class="function-name-display">${functionName}</div>
            ${functionEffectBadge}
          </div>
          <span class="function-separator" style="margin: 0 8px; color: var(--color-text-secondary);">||</span>
          ${interactionDisplay}
          ${contextBadge}
        </div>
      </div>
      <div class="function-expanded-content">
        ${expandedSections || '<div class="function-section-content" style="color: var(--color-text-secondary);">No additional details available</div>'}
      </div>
    </div>
  `;
}

function handleLinkClick(ev, d) {
  ev.stopPropagation();
  if (!d) return;
  if (d.type === 'function') {
    showFunctionModalFromLink(d);
  } else if (d.type === 'interaction' || d.type === 'interaction-edge') {
    // Both regular interactions and pathway-context interaction edges use the same modal
    showInteractionModal(d);
  }
}

/* ===============================================================
   Interaction Modal: NEW DESIGN with Expandable Functions
   =============================================================== */
function showInteractionModal(link, clickedNode = null) {
  const L = link.data || link;  // Link properties are directly on link object or in data
  const isSharedInteraction = L._is_shared_link || false;
  const isIndirectInteraction = L.interaction_type === 'indirect';

  // Use semantic source/target (biological direction) instead of D3's geometric source/target
  // Semantic fields preserve the biological meaning, while link.source/target are D3 node references
  const srcName = L.semanticSource || ((link.source && link.source.id) ? link.source.id : link.source);
  const tgtName = L.semanticTarget || ((link.target && link.target.id) ? link.target.id : link.target);
  const safeSrc = escapeHtml(srcName || '-');
  const safeTgt = escapeHtml(tgtName || '-');

  // Determine which protein was clicked (if any)
  // If called from node click, use clickedNode; otherwise determine from link
  let clickedProteinId = null;
  if (clickedNode) {
    clickedProteinId = clickedNode.id;
  }

  // Determine arrow direction
  // IMPORTANT: Direction field has different semantics for direct vs indirect interactions
  // - Direct: direction is QUERY-RELATIVE (main_to_primary = query→interactor)
  // - Indirect: direction is LINK-ABSOLUTE (main_to_primary = source→target after transformation)
  const direction = L.direction || link.direction || 'main_to_primary';
  const isIndirect = L.interaction_type === 'indirect';
  const directionIsLinkAbsolute = L._direction_is_link_absolute || isIndirect;

  let arrowSymbol = '↔';
  if (direction === 'bidirectional' || direction === 'undirected') {
    arrowSymbol = '↔';
  } else {
    // For all directed links (main_to_primary, primary_to_main, a_to_b, b_to_a),
    // the link source is the actor, so the arrow is always source -> target.
    arrowSymbol = '→';
  }

  // === BUILD INTERACTION METADATA SECTION ===

  let functionTypeBadge = '';
  if (isSharedInteraction) {
    functionTypeBadge = '<span class="mechanism-badge" style="background: #9333ea; color: white; font-size: 9px; padding: 2px 6px;">SHARED</span>';
  } else if (isIndirectInteraction) {
    // Build full chain path display for INDIRECT label
    // Try to extract chain from first function with chain context
    let chainDisplay = '';
    const firstChainFunc = functions.find(f => f._context && f._context.type === 'chain' && f._context.chain);
    if (firstChainFunc && firstChainFunc._context.chain) {
      chainDisplay = buildFullChainPath(SNAP.main, firstChainFunc._context.chain, L);
    }

    // Fallback: use upstream_interactor if no chain found
    if (!chainDisplay && L.upstream_interactor) {
      if (L.upstream_interactor === L.primary) {
        chainDisplay = `${escapeHtml(SNAP.main)} → ${escapeHtml(L.primary)}`;
      } else {
        chainDisplay = `${escapeHtml(SNAP.main)} → ${escapeHtml(L.upstream_interactor)} → ${escapeHtml(L.primary)}`;
      }
    }

    functionTypeBadge = chainDisplay
      ? `<span class="mechanism-badge" style="background: #f59e0b; color: white; font-size: 9px; padding: 2px 6px;">${chainDisplay}</span>`
      : `<span class="mechanism-badge" style="background: #f59e0b; color: white; font-size: 9px; padding: 2px 6px;">INDIRECT</span>`;
  } else {
    functionTypeBadge = '<span class="mechanism-badge" style="background: #10b981; color: white; font-size: 9px; padding: 2px 6px;">DIRECT</span>';
  }

  if (functions.length > 0) {
    if (isIndirectInteraction) {
      // For indirect interactions: Don't group by direction - show all together
      // Direction is no longer query-relative, so grouping would be confusing
      const arrows = L.arrows || {};
      const arrowCount = Object.values(arrows).flat().filter((v, i, a) => a.indexOf(v) === i).length;

      functionsHTML = `<div class="modal-functions-header">Functions (${functions.length})${arrowCount > 1 ? ` <span style="background:#f59e0b;color:white;padding:2px 6px;border-radius:10px;font-size:10px;margin-left:8px;">${arrowCount} arrows</span>` : ''}</div>`;

      // Display all functions without direction grouping
      functionsHTML += `<div style="margin:16px 0;">
        ${functions.map(f => {
        const effectArrow = f.arrow || 'complex';
        return renderExpandableFunction(f, SNAP.main, L.primary, L.arrow || 'binds', direction, null, L.step3_finalized_pathway);
      }).join('')}
      </div>`;

    } else {
      // For direct interactions: Group by INTERACTION DIRECTION
      // Functions should be grouped by which protein acts on which, showing the directionality
      const grp = {
        main_to_primary: [],
        primary_to_main: [],
        bidirectional: []
      };
      functions.forEach(f => grp[(f.interaction_direction || f.direction || direction)].push(f));

      const arrows = L.arrows || {};
      const arrowCount = Object.values(arrows).flat().filter((v, i, a) => a.indexOf(v) === i).length;

      // Determine protein names for direction labels
      const queryProtein = SNAP.main;
      const interactorProtein = safeSrc === queryProtein ? safeTgt : safeSrc;

      functionsHTML = `<div class="modal-functions-header">Functions (${functions.length})${arrowCount > 1 ? ` <span style="background:#f59e0b;color:white;padding:2px 6px;border-radius:10px;font-size:10px;margin-left:8px;">${arrowCount} arrows</span>` : ''}</div>`;

      // Direction labels with arrow symbols based on interaction type
      const directionConfig = {
        main_to_primary: {
          source: queryProtein,
          target: interactorProtein,
          arrowSymbol: '→',
          color: '#3b82f6',  // Blue
          bg: '#dbeafe'
        },
        primary_to_main: {
          source: interactorProtein,
          target: queryProtein,
          arrowSymbol: '→',
          color: '#9333ea',  // Purple
          bg: '#f3e8ff'
        },
        bidirectional: {
          source: queryProtein,
          target: interactorProtein,
          arrowSymbol: '↔',
          color: '#059669',  // Green
          bg: '#d1fae5'
        }
      };

      ['main_to_primary', 'primary_to_main', 'bidirectional'].forEach(dir => {
        if (grp[dir].length) {
          const config = directionConfig[dir];
          functionsHTML += `<div style="">
            <div style="">
              <span class="detail-interaction">
                ${escapeHtml(config.source)}
                <span class="detail-arrow">${config.arrowSymbol}</span>
                ${escapeHtml(config.target)}
              </span> (${grp[dir].length})
            </div>
            ${grp[dir].map(f => {
            // Within each direction, show effect type badge
            const effectArrow = f.arrow || 'complex';
            // Pass SNAP.main and interactorName to ensure correct direction resolution
            // FIX: Pass interactionArrow as defaultInteractionEffect, NOT effectArrow
            return renderExpandableFunction(f, SNAP.main, interactorProtein, L.arrow || 'binds', dir, null, L.step3_finalized_pathway);
          }).join('')}
          </div>`;
        }
      });
    }
  } else {
    const emptyMessage = isSharedInteraction
      ? 'Shared interactions may not include context-specific functions.'
      : 'No functions associated with this interaction.';
    functionsHTML = `
      <div class="modal-functions-header">Functions</div>
      <div style="padding: var(--space-4); color: var(--color-text-secondary); font-style: italic;">
        ${emptyMessage}
      </div>
    `;
  }

  // === BUILD EXPAND/COLLAPSE FOOTER (if called from node click) ===
  let footerHTML = '';
  if (clickedProteinId) {
    const proteinLabel = clickedProteinId;
    const isMainProtein = clickedProteinId === SNAP.main;
    const isExpanded = expanded.has(clickedProteinId);
    const canExpand = (depthMap.get(clickedProteinId) ?? 1) < MAX_DEPTH;
    const hasInteractions = true; // Always true for showInteractionModal (single link exists)

    if (isMainProtein) {
      // Main protein: show single "Find New Interactions" button
      footerHTML = `
        <div class="modal-footer" style="border-top: 1px solid var(--color-border); padding: 16px; background: var(--color-bg-secondary);">
          <button onclick="handleQueryFromModal('${clickedProteinId}')" class="btn-primary" style="padding: 8px 20px; background: #10b981; color: white; border: none; border-radius: 6px; font-weight: 500; cursor: pointer; font-size: 14px; font-family: var(--font-sans); transition: background 0.2s;">
            Find New Interactions
          </button>
        </div>
      `;
    } else {
      // Interactor: show conditional Expand + Query buttons
      footerHTML = `
        <div class="modal-footer" style="border-top: 1px solid var(--color-border); padding: 16px; background: var(--color-bg-secondary);">
          <div style="display: flex; gap: 12px; align-items: center; flex-wrap: wrap;">
            ${canExpand && !isExpanded && hasInteractions ? `
              <button onclick="handleExpandFromModal('${clickedProteinId}')" class="btn-primary" style="padding: 8px 20px; background: #3b82f6; color: white; border: none; border-radius: 6px; font-weight: 500; cursor: pointer; font-size: 14px; font-family: var(--font-sans); transition: background 0.2s;">
                Expand
              </button>
            ` : ''}
            ${canExpand && !isExpanded && !hasInteractions ? `
              <button disabled style="padding: 8px 20px; background: #d1d5db; color: #6b7280; border: none; border-radius: 6px; font-weight: 500; font-size: 14px; cursor: not-allowed; font-family: var(--font-sans);">
                Expand (No data)
              </button>
            ` : ''}
            ${isExpanded ? `
              <button onclick="handleCollapseFromModal('${clickedProteinId}')" class="btn-secondary" style="padding: 8px 20px; background: #ef4444; color: white; border: none; border-radius: 6px; font-weight: 500; cursor: pointer; font-size: 14px; font-family: var(--font-sans); transition: background 0.2s;">
                Collapse
              </button>
            ` : ''}
            <button onclick="handleQueryFromModal('${clickedProteinId}')" class="btn-primary" style="padding: 8px 20px; background: #10b981; color: white; border: none; border-radius: 6px; font-weight: 500; cursor: pointer; font-size: 14px; font-family: var(--font-sans); transition: background 0.2s;">
              Query
            </button>
            ${!canExpand && !isExpanded ? `
              <div style="padding: 8px 20px; background: #f3f4f6; color: #6b7280; border-radius: 6px; font-size: 13px; font-family: var(--font-sans); font-style: italic;">
                Max depth reached (${MAX_DEPTH})
              </div>
            ` : ''}
          </div>
          <div style="margin-top: 12px; font-size: 12px; color: var(--color-text-secondary); font-family: var(--font-sans);">
            Expand uses existing data • Query finds new interactions
          </div>
        </div>
      `;
    }
  }

  // === BUILD MODAL TITLE WITH TYPE BADGE ===
  // Determine interaction type and create badge
  const isShared = L._is_shared_link || false;
  // isIndirect already declared at line 5518 - reuse that variable
  const mediatorChain = L.mediator_chain || [];
  const chainDepth = L.depth || 1;

  // Check if THIS interaction's target is a mediator for OTHER indirect interactions
  // (e.g., KEAP1 is mediator in p62→KEAP1→NRF2)
  const isMediator = (tgtName === L.upstream_interactor || srcName === L.upstream_interactor);

  let typeBadge = '';
  if (isShared) {
    typeBadge = '<span class="mechanism-badge" style="background: #9333ea; color: white; font-size: 10px; padding: 3px 8px; margin-left: 12px;">SHARED</span>';
  } else if (isIndirect) {
    // Build full chain path display for INDIRECT label
    // Try to extract chain from first function with chain context
    let chainDisplay = '';
    const firstChainFunc = functions.find(f => f._context && f._context.type === 'chain' && f._context.chain);
    if (firstChainFunc && firstChainFunc._context.chain) {
      chainDisplay = buildFullChainPath(SNAP.main, firstChainFunc._context.chain, L);
    }

    // Fallback: use upstream_interactor if no chain found
    if (!chainDisplay && L.upstream_interactor) {
      if (L.upstream_interactor === L.primary) {
        chainDisplay = `${escapeHtml(SNAP.main)} → ${escapeHtml(L.primary)}`;
      } else {
        chainDisplay = `${escapeHtml(SNAP.main)} → ${escapeHtml(L.upstream_interactor)} → ${escapeHtml(L.primary)}`;
      }
    }

    typeBadge = chainDisplay
      ? `<span class="mechanism-badge" style="background: #f59e0b; color: white; font-size: 10px; padding: 3px 8px; margin-left: 12px;">${chainDisplay}</span>`
      : `<span class="mechanism-badge" style="background: #f59e0b; color: white; font-size: 10px; padding: 3px 8px; margin-left: 12px;">INDIRECT</span>`;
  } else if (isMediator) {
    // This protein is a mediator in indirect chains AND this link is direct
    typeBadge = `<span class="mechanism-badge" style="background: #10b981; color: white; font-size: 10px; padding: 3px 8px; margin-left: 12px;">DIRECT</span>
                 <span class="mechanism-badge" style="background: #6366f1; color: white; font-size: 10px; padding: 3px 8px; margin-left: 4px;">MEDIATOR</span>`;
  } else {
    typeBadge = '<span class="mechanism-badge" style="background: #10b981; color: white; font-size: 10px; padding: 3px 8px; margin-left: 12px;">DIRECT</span>';
  }

  let modalTitle = `
    <div style="display: flex; align-items: center; gap: 12px; flex-wrap: wrap;">
      <span style="font-size: 18px; font-weight: 600;">${safeSrc} ${arrowSymbol} ${safeTgt}</span>
      ${typeBadge}
    </div>
  `;

  // Add full chain display for ALL indirect interactions
  if (isIndirect) {
    let fullChainText = '';
    if (mediatorChain.length > 0) {
      // CRITICAL FIX (Issue #2): Use chain_with_arrows if available for typed arrows
      const chainWithArrows = L.chain_with_arrows || [];

      if (chainWithArrows.length > 0) {
        // CRITICAL FIX (Issue #1): For shared links, use correct protein perspective
        // Check if this is a shared link and reconstruct chain from shared interactor's perspective
        if (isShared && L._shared_between && L._shared_between.length >= 2) {
          // Find the shared interactor (not the main query protein)
          const sharedInteractor = L._shared_between.find(p => p !== SNAP.main);

          if (sharedInteractor) {
            // Filter chain segments to show only those starting from shared interactor
            const relevantSegments = chainWithArrows.filter(seg =>
              seg.from === sharedInteractor || chainWithArrows.indexOf(seg) > chainWithArrows.findIndex(s => s.from === sharedInteractor)
            );

            if (relevantSegments.length > 0) {
              const arrowSymbols = {
                'activates': ' <span style="color:#059669;font-weight:700;">--&gt;</span> ',
                'inhibits': ' <span style="color:#dc2626;font-weight:700;">--|</span> ',
                'binds': ' <span style="color:#7c3aed;font-weight:700;">---</span> ',
                'complex': ' <span style="color:#f59e0b;font-weight:700;">--=</span> '
              };

              fullChainText = relevantSegments.map((segment, i) => {
                const arrow = arrowSymbols[segment.arrow] || ' → ';
                if (i === relevantSegments.length - 1) {
                  return escapeHtml(segment.from) + arrow + escapeHtml(segment.to);
                } else {
                  return escapeHtml(segment.from) + arrow;
                }
              }).join('');
            } else {
              // Fallback: shared interactor → target
              fullChainText = `${escapeHtml(sharedInteractor)} → ${escapeHtml(tgtName)}`;
            }
          } else {
            // Couldn't find shared interactor, use default
            fullChainText = chainWithArrows.map((segment, i) => {
              const arrow = arrowSymbols[segment.arrow] || ' → ';
              return i === chainWithArrows.length - 1
                ? escapeHtml(segment.from) + arrow + escapeHtml(segment.to)
                : escapeHtml(segment.from) + arrow;
            }).join('');
          }
        } else {
          // NOT a shared link: Display full chain with typed arrows
          const arrowSymbols = {
            'activates': ' <span style="color:#059669;font-weight:700;">--&gt;</span> ',
            'inhibits': ' <span style="color:#dc2626;font-weight:700;">--|</span> ',
            'binds': ' <span style="color:#7c3aed;font-weight:700;">---</span> ',
            'complex': ' <span style="color:#f59e0b;font-weight:700;">--=</span> '
          };

          fullChainText = chainWithArrows.map((segment, i) => {
            const arrow = arrowSymbols[segment.arrow] || ' → ';
            if (i === chainWithArrows.length - 1) {
              // Last segment: show "from arrow to"
              return escapeHtml(segment.from) + arrow + escapeHtml(segment.to);
            } else {
              // Middle segments: only show "from arrow" (to avoid duplication)
              return escapeHtml(segment.from) + arrow;
            }
          }).join('');
        }
      } else {
        // FALLBACK: Generic arrows (old data or no chain_with_arrows)
        // CRITICAL FIX (Issue #1): For shared links, start chain from shared interactor
        let startProtein = SNAP.main;

        if (isShared && L._shared_between && L._shared_between.length >= 2) {
          const sharedInteractor = L._shared_between.find(p => p !== SNAP.main);
          if (sharedInteractor) {
            startProtein = sharedInteractor;
          }
        }

        const fullChain = [startProtein, ...mediatorChain, tgtName];
        fullChainText = fullChain.map(p => escapeHtml(p)).join(' → ');
      }
    } else if (L.upstream_interactor && L.upstream_interactor !== SNAP.main) {
      // Indirect with single upstream (no chain array but has upstream)
      // TODO: Could enhance to look up arrow types here too
      fullChainText = `${escapeHtml(SNAP.main)} → ${escapeHtml(L.upstream_interactor)} → ${escapeHtml(tgtName)}`;
    } else {
      // First-ring indirect: no mediator specified (pathway incomplete)
      fullChainText = `${escapeHtml(SNAP.main)} → ${escapeHtml(tgtName)} <span style="font-style: italic; color: #f59e0b;">(direct mediator unknown)</span>`;
    }

    modalTitle = `
      <div style="display: flex; flex-direction: column; gap: 8px;">
        <div style="display: flex; align-items: center; gap: 12px; flex-wrap: wrap;">
          <span style="font-size: 18px; font-weight: 600;">${safeSrc} ${arrowSymbol} ${safeTgt}</span>
          ${typeBadge}
        </div>
        <div style="font-size: 13px; color: var(--color-text-secondary); font-weight: normal; padding: 4px 8px; background: var(--color-bg-tertiary); border-radius: 4px; border-left: 3px solid #f59e0b;">
          <strong>Full Chain:</strong> ${fullChainText}
        </div>
      </div>
    `;
  }

  // === COMBINE SECTIONS AND DISPLAY ===
  const fullModalContent = interactionMetadataHTML + functionsHTML + footerHTML;
  openModal(modalTitle, fullModalContent);
}

/* DEPRECATED: Old interactor modal - now using unified interaction modal for both arrows and nodes */
// showInteractorModal removed - nodes now use showInteractionModal with expand/collapse footer

/* Handle node click - show interaction modal with expand/collapse controls */
function handleNodeClick(node) {
  try {
    // For pathway-expanded nodes, use originalId to find actual interaction data
    const lookupId = node.originalId || node.id;

    // Find ALL links involving this node (using originalId for pathway-expanded nodes)
    const nodeLinks = links.filter(l => {
      const src = (l.source && l.source.id) ? l.source.id : l.source;
      const tgt = (l.target && l.target.id) ? l.target.id : l.target;
      // Match either the full ID or the originalId
      const srcOriginal = l.source && l.source.originalId;
      const tgtOriginal = l.target && l.target.originalId;
      return src === lookupId || tgt === lookupId ||
        srcOriginal === lookupId || tgtOriginal === lookupId ||
        src === node.id || tgt === node.id;
    });

    if (nodeLinks.length === 0) {
      // FALLBACK: Try finding interactions in raw SNAP data (Robustness for Card View / Desync)
      if (typeof SNAP !== 'undefined' && SNAP.interactions) {
        const lookupId = node.originalId || node.id;
        const rawInteractions = SNAP.interactions.filter(i =>
          i.source === lookupId || i.target === lookupId
        );

        if (rawInteractions.length > 0) {
          const restoredLinks = rawInteractions.map(i => ({
            data: i,
            source: { id: i.source },
            target: { id: i.target },
            arrow: i.arrow,
            direction: i.direction
          }));
          showAggregatedInteractionsModal(restoredLinks, node);
          return;
        }
      }

      // Fallback: show error message
      openModal(`Protein: ${escapeHtml(node.label || node.id)}`,
        '<div style="color:#6b7280; padding: 20px; text-align: center;">No interactions found for this protein.</div>');
    } else {
      // Use aggregated modal for consistent formatting (1+ interactions)
      // This ensures all modals have color-coded section headers and bordered boxes
      showAggregatedInteractionsModal(nodeLinks, node);
    }
  } catch (err) {
    console.error('Error in handleNodeClick:', err);
    openModal('Error', `<div style="padding:20px;color:red;">Failed to open modal: ${escapeHtml(err.message)}</div>`);
  }
}

/**
 * Group interactions by their assigned pathway
 * @param {Array} interactions - Array of interaction objects
 * @returns {Map} Map of pathwayName -> Array of interactions
 */
function groupInteractionsByPathway(interactions) {
    const groups = new Map();

    interactions.forEach(interaction => {
        const data = interaction.data || interaction;
        // Get pathway from step3_finalized_pathway or functions
        const pathwayName = data.step3_finalized_pathway ||
                           data.data?.step3_finalized_pathway ||
                           'Unassigned';

        if (!groups.has(pathwayName)) {
            groups.set(pathwayName, []);
        }
        groups.get(pathwayName).push(interaction);
    });

    return groups;
}

/* Show aggregated modal for nodes with multiple interactions */
function showAggregatedInteractionsModal(nodeLinks, clickedNode) {
  const nodeId = clickedNode.id;
  const nodeLabel = clickedNode.label || nodeId;
  // For pathway-expanded nodes, use originalId to look up actual interaction data
  const lookupId = clickedNode.originalId || nodeLabel;

  // If this is a pathway-expanded node and nodeLinks is empty or only contains pathway links,
  // look up the actual interaction data from SNAP.interactions
  let actualLinks = nodeLinks;
  if (clickedNode.pathwayId && SNAP && SNAP.interactions) {
    // Find interactions involving this protein
    const interactionData = SNAP.interactions.filter(interaction => {
      const src = interaction.source || '';
      const tgt = interaction.target || '';
      return src === lookupId || tgt === lookupId;
    });

    // Convert SNAP.interactions to link-like objects for the modal
    if (interactionData.length > 0) {
      actualLinks = interactionData.map(interaction => ({
        data: interaction,
        source: { id: interaction.source, originalId: interaction.source },
        target: { id: interaction.target, originalId: interaction.target },
        arrow: interaction.arrow,
        direction: interaction.direction
      }));
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // PATHWAY FILTERING: Filter interactions by pathway context
  // ═══════════════════════════════════════════════════════════════
  // ✅ FIXED: Use _pathwayContext from card view if available
  const currentPathwayId = clickedNode.pathwayId || clickedNode._pathwayContext?.id;
  const isPathwayExpanded = !!currentPathwayId;
  let pathwayFilterIndicatorHTML = '';
  let otherPathwaysHTML = '';
  let chainContextHTML = '';
  let pathwayLabel = '';  // Declare at outer scope for use in renderInteractionSection

  if (isPathwayExpanded && currentPathwayId) {
    // Get pathway's interactor set
    const pathwayNode = nodeMap.get(currentPathwayId);
    const pathwayInteractors = new Set(pathwayNode?.interactorIds || pathwayToInteractors.get(currentPathwayId) || []);
    // ✅ FIXED: Prioritize _pathwayContext.name from card view
    pathwayLabel = clickedNode._pathwayContext?.name || pathwayNode?.label || currentPathwayId.replace('pathway_', '');  // Assign (not redeclare)

    // Filter to pathway-relevant interactions
    const unfilteredCount = actualLinks.length;
    actualLinks = actualLinks.filter(link => {
      const L = link.data || {};
      const src = L.source || link.source?.originalId || link.source;
      const tgt = L.target || link.target?.originalId || link.target;
      const otherProtein = (src === lookupId) ? tgt : src;

      // Keep if: main protein OR in same pathway OR is shared between pathway interactors
      if (otherProtein === SNAP.main) return true;
      if (pathwayInteractors.has(otherProtein)) return true;
      // For shared links, check if BOTH proteins are in pathway
      if (L._is_shared_link) {
        return pathwayInteractors.has(src) && pathwayInteractors.has(tgt);
      }
      return false;
    });

    console.log(`[Pathway Filter] ${lookupId}: ${actualLinks.length}/${unfilteredCount} interactions in "${pathwayLabel}"`);

    // Build pathway context indicator (always show current pathway)
    // Show filtering count only when some interactions were filtered out
    const filterCount = actualLinks.length < unfilteredCount
      ? `<span style="color: var(--color-text-secondary);">(${actualLinks.length} of ${unfilteredCount})</span>`
      : '';
    pathwayFilterIndicatorHTML = `
      <div class="pathway-filter-indicator">
        <span>Pathway:</span>
        <span class="pathway-name">${escapeHtml(pathwayLabel)}</span>
        ${filterCount}
      </div>
    `;

    // Find OTHER pathways this protein appears in (for cross-reference)
    const otherPathways = nodes
      .filter(n => n.type === 'pathway' && n.id !== currentPathwayId)
      .filter(n => {
        const pwInteractors = n.interactorIds || pathwayToInteractors.get(n.id) || new Set();
        return (Array.isArray(pwInteractors) ? pwInteractors.includes(lookupId) : pwInteractors.has(lookupId));
      })
      .map(n => ({ id: n.id, label: n.label }));

    if (otherPathways.length > 0) {
      otherPathwaysHTML = `
        <div class="other-pathways-section">
          <div class="other-pathways-label">Also appears in:</div>
          <div class="other-pathways-tags">
            ${otherPathways.map(p => `
              <button class="pathway-tag" onclick="switchToPathway('${p.id}', '${currentPathwayId}')">
                ${escapeHtml(p.label)}
              </button>
            `).join('')}
          </div>
        </div>
      `;
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // CHAIN CONTEXT BANNER: Show full chain for indirect interactors
  // ═══════════════════════════════════════════════════════════════
  const nodeData = clickedNode.interactionData || clickedNode;
  const isIndirectNode = nodeData.interaction_type === 'indirect' || clickedNode.interaction_type === 'indirect';
  const mediator = nodeData.upstream_interactor || clickedNode.upstream_interactor;

  if (isIndirectNode && mediator) {
    const chainWithArrows = nodeData.chain_with_arrows || [];
    let chainDisplay = '';

    if (chainWithArrows.length > 0) {
      // Build typed chain: ATXN3 → PNKP ⊣ ATM
      chainDisplay = chainWithArrows.map((seg, i) => {
        const arrowSymbols = {
          'activates': ' → ',
          'inhibits': ' ⊣ ',
          'binds': ' — ',
          'regulates': ' ↔ '
        };
        const arrow = arrowSymbols[seg.arrow] || ' → ';
        return i === chainWithArrows.length - 1
          ? `${escapeHtml(seg.from)}${arrow}${escapeHtml(seg.to)}`
          : `${escapeHtml(seg.from)}${arrow}`;
      }).join('');
    } else {
      // Fallback to simple chain
      chainDisplay = `${escapeHtml(SNAP.main)} → ${escapeHtml(mediator)} → ${escapeHtml(lookupId)}`;
    }

    chainContextHTML = `
      <div class="chain-context-banner">
        <span class="chain-label">Full Chain:</span>
        <code class="chain-path">${chainDisplay}</code>
      </div>
    `;
  }

  // Group links by type (direct, indirect, shared)
  // Uses interaction_type field to distinguish:
  // - Direct: direct protein-protein interaction
  // - Indirect: interaction chain (e.g., ATXN3 → PARK2 → BCL2)
  const directLinks = [];
  const indirectLinks = [];
  const sharedLinks = [];

  actualLinks.forEach(link => {
    const L = link.data || {};
    if (L._is_shared_link) {
      sharedLinks.push(link);
    } else if (L.interaction_type === 'indirect') {
      indirectLinks.push(link);
    } else {
      directLinks.push(link);
    }
  });

  // Build sections HTML
  let sectionsHTML = '';

  // Helper to render a single interaction section
  // Uses lookupId from outer scope to determine perspective
  function renderInteractionSection(link, sectionType) {
    const L = link.data || link;  // Link properties are directly on link object or in data

    // Use semantic source/target (biological direction) instead of D3's geometric source/target
    // For pathway-expanded nodes, use originalId (the actual protein name) instead of the pathway-prefixed ID
    let srcName = L.semanticSource || ((link.source && link.source.id) ? link.source.id : link.source);
    let tgtName = L.semanticTarget || ((link.target && link.target.id) ? link.target.id : link.target);
    // Strip pathway prefix if present (e.g., "TUBULIN@pathway_..." -> "TUBULIN")
    if (link.source && link.source.originalId) srcName = link.source.originalId;
    if (link.target && link.target.originalId) tgtName = link.target.originalId;
    // Also check for @pathway_ pattern in string IDs
    if (typeof srcName === 'string' && srcName.includes('@pathway_')) srcName = srcName.split('@')[0];
    if (typeof tgtName === 'string' && tgtName.includes('@pathway_')) tgtName = tgtName.split('@')[0];

    // PERSPECTIVE TRANSFORMATION for indirect interactors
    // When viewing an indirect interactor (e.g., ATM), show interaction from its perspective
    // Instead of "ATXN3 → PNKP", show "PNKP → ATM"
    const isIndirect = L.interaction_type === 'indirect';
    const upstream = L.upstream_interactor;
    const indirectTarget = L.primary || tgtName;
    const isViewingIndirectInteractor = isIndirect && lookupId === indirectTarget && lookupId !== SNAP.main;

    let displaySrc = srcName;
    let displayTgt = tgtName;

    if (isViewingIndirectInteractor && upstream) {
      // When viewing indirect interactor's modal, show: mediator → indirect_target
      displaySrc = upstream;
      displayTgt = indirectTarget;
    }

    const safeSrc = escapeHtml(displaySrc || '-');
    const safeTgt = escapeHtml(displayTgt || '-');

    // Determine arrow symbol
    // Support both query-relative AND absolute directions
    const direction = L.direction || link.direction || 'main_to_primary';
    let arrowSymbol = '↔';
    if (direction === 'bidirectional' || direction === 'undirected') {
      arrowSymbol = '↔';
    } else {
      // For all directed links (main_to_primary, primary_to_main, a_to_b, b_to_a),
      // the link source is the actor, so the arrow is always source -> target.
      arrowSymbol = '→';
    }

    // Type badge
    let typeBadgeHTML = '';
    if (sectionType === 'shared') {
      typeBadgeHTML = '<span class="mechanism-badge" style="background: #9333ea; color: white;">SHARED</span>';
    } else if (sectionType === 'indirect') {
      // Build chain path display for INDIRECT label
      // PERSPECTIVE-AWARE: Show relevant portion based on which protein we're viewing
      let chainDisplay = '';

      if (isViewingIndirectInteractor && upstream) {
        // Viewing indirect interactor (e.g., BCL2): show full chain "ATXN3 → PARK2 → BCL2"
        chainDisplay = `${escapeHtml(SNAP.main)} → ${escapeHtml(upstream)} → ${escapeHtml(indirectTarget)}`;
      } else {
        // Viewing from main protein's perspective: show full chain
        const functions = L.functions || [];
        const firstChainFunc = functions.find(f => f._context && f._context.type === 'chain' && f._context.chain);
        if (firstChainFunc && firstChainFunc._context.chain) {
          chainDisplay = buildFullChainPath(SNAP.main, firstChainFunc._context.chain, L);
        }

        // Fallback: use upstream_interactor if no chain found
        if (!chainDisplay && upstream) {
          chainDisplay = `${escapeHtml(SNAP.main)} → ${escapeHtml(upstream)} → ${escapeHtml(indirectTarget)}`;
        }
      }

      typeBadgeHTML = chainDisplay
        ? `<span class="mechanism-badge" style="background: #f59e0b; color: white;">${chainDisplay}</span>`
        : `<span class="mechanism-badge" style="background: #f59e0b; color: white;">INDIRECT</span>`;
    } else {
      typeBadgeHTML = '<span class="mechanism-badge" style="background: #10b981; color: white;">DIRECT</span>';
    }

    // Interaction title - use perspective-aware display names
    const interactionTitle = `${safeSrc} ${arrowSymbol} ${safeTgt}`;

    // Arrow type badge
    const arrow = L.arrow || link.arrow || 'binds';
    const normalizedArrow = arrow === 'activates' || arrow === 'activate' ? 'activates'
      : arrow === 'inhibits' || arrow === 'inhibit' ? 'inhibits'
        : arrow === 'regulates' || arrow === 'regulate' || arrow === 'modulates' ? 'regulates'
          : 'binds';
    const isDarkMode = document.body.classList.contains('dark-mode');
    const arrowColors = isDarkMode ? {
      'activates': { bg: '#065f46', text: '#a7f3d0', border: '#047857', label: 'ACTIVATES' },
      'inhibits': { bg: '#991b1b', text: '#fecaca', border: '#b91c1c', label: 'INHIBITS' },
      'regulates': { bg: '#92400e', text: '#fde68a', border: '#b45309', label: 'REGULATES' },
      'binds': { bg: '#5b21b6', text: '#ddd6fe', border: '#6d28d9', label: 'BINDS' }
    } : {
      'activates': { bg: '#d1fae5', text: '#047857', border: '#059669', label: 'ACTIVATES' },
      'inhibits': { bg: '#fee2e2', text: '#b91c1c', border: '#dc2626', label: 'INHIBITS' },
      'regulates': { bg: '#fef3c7', text: '#92400e', border: '#f59e0b', label: 'REGULATES' },
      'binds': { bg: '#ede9fe', text: '#6d28d9', border: '#7c3aed', label: 'BINDS' }
    };
    const colors = arrowColors[normalizedArrow];

    // Functions
    function deduplicateFunctions(functionArray) {
      if (!Array.isArray(functionArray)) return [];
      const seen = new Set();
      return functionArray.filter(fn => {
        if (!fn) return false;
        const key = `${fn.function || ''}|${fn.arrow || ''}|${fn.cellular_process || ''}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }

    const rawFunctions = Array.isArray(L.functions) ? L.functions : [];
    const functions = deduplicateFunctions(rawFunctions);

    // Determine protein names for function rendering
    // CRITICAL FIX: For indirect interactions viewed from the indirect interactor's perspective,
    // use the perspective-transformed display names (mediator → indirect) instead of (main → mediator)
    let functionMainProtein, functionInteractorProtein;
    if (isViewingIndirectInteractor && upstream) {
      // For ATM (indirect via PNKP): show functions as PNKP → ATM
      functionMainProtein = displaySrc;      // PNKP (the mediator)
      functionInteractorProtein = displayTgt; // ATM (the indirect target)
    } else {
      // Standard case: use the interaction's actual source/target (not SNAP.main)
      // This ensures BCL2's modal shows "PARK2 → BCL2" not "ATXN3 → PARK2"
      functionMainProtein = displaySrc;
      functionInteractorProtein = displayTgt;
    }

    let functionsHTML = '';
    if (functions.length > 0) {
      // Build pathway context for badge display (if in pathway mode)
      const pathwayContextForFunctions = currentPathwayId ? { id: currentPathwayId, name: pathwayLabel } : null;

      functionsHTML = functions.map(fn => {
        // Pass appropriate proteins for direction resolution based on interaction type
        // FIXED: Pass 'main_to_primary' as direction because functionMainProtein/functionInteractorProtein
        // are already resolved to biological source/target (displaySrc/displayTgt).
        // renderExpandableFunction's swap logic assumes mainProtein=SNAP.main, but here
        // mainProtein=displaySrc (already biological source), so we must prevent the swap.
        return renderExpandableFunction(fn, functionMainProtein, functionInteractorProtein, arrow, 'main_to_primary', pathwayContextForFunctions, L.step3_finalized_pathway);
      }).join('');
    } else {
      const emptyMessage = sectionType === 'shared'
        ? 'Shared interactions may not include context-specific functions.'
        : 'No functions associated with this interaction.';
      functionsHTML = `
        <div style="padding: var(--space-4); color: var(--color-text-secondary); font-style: italic;">
          ${emptyMessage}
        </div>
      `;
    }

    return `
      <div class="interaction-expandable-row" style="margin-bottom: 16px; border: 1px solid var(--color-border); border-radius: 8px; overflow: hidden; transition: all 0.2s ease;">
        <div class="interaction-row-header" style="padding: 12px 16px; background: var(--color-bg-secondary); display: flex; align-items: center; justify-content: space-between; gap: 12px; cursor: pointer; transition: background 0.2s;">
          <div style="display: flex; align-items: center; gap: 12px;">
            <div class="interaction-expand-icon" style="font-size: 12px; color: var(--color-text-secondary); width: 20px; transition: transform 0.2s;">▼</div>
            <span style="font-weight: 600; font-size: 14px;">${interactionTitle}</span>
            ${typeBadgeHTML}
            <span class="interaction-type-badge" style="display: inline-block; padding: 2px 8px; background: ${colors.bg}; color: ${colors.text}; border: 1px solid ${colors.border}; border-radius: 4px; font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.3px;">
              ${colors.label}
            </span>
          </div>
        </div>
        <div class="interaction-expanded-content" style="max-height: 0; opacity: 0; overflow: hidden; transition: max-height 0.3s ease, opacity 0.2s ease;">
          <div style="padding: 16px; border-top: 1px solid var(--color-border);">
            ${L.support_summary ? `
              <div style="margin-bottom: 16px;">
                <div class="modal-detail-label">SUMMARY</div>
                <div class="modal-detail-value">${escapeHtml(L.support_summary)}</div>
              </div>
            ` : ''}
            <div class="modal-functions-header" style="font-size: 16px; margin-bottom: 12px;">Biological Functions (${functions.length})</div>
            ${functionsHTML}
          </div>
        </div>
      </div>
    `;
  }

  // CRITICAL FIX (Issue #6): Enhanced section headers for visual distinction
  // Render all sections with prominent, color-coded headers
  if (directLinks.length > 0) {
    sectionsHTML += `<div class="modal-section-divider" style="margin: 24px 0 16px 0; padding: 12px 16px; background: linear-gradient(135deg, #dbeafe 0%, #e0e7ff 100%); border-left: 6px solid #3b82f6; border-radius: 8px; box-shadow: 0 2px 4px rgba(59,130,246,0.1);">
      <h3 style="margin: 0; font-size: 16px; font-weight: 700; color: #1e40af; text-transform: uppercase; letter-spacing: 1px; display: flex; align-items: center; gap: 8px;">
        <span style="display: inline-block; width: 8px; height: 8px; background: #3b82f6; border-radius: 50%;"></span>
        DIRECT INTERACTIONS (${directLinks.length})
      </h3>
    </div>`;
    directLinks.forEach(link => {
      sectionsHTML += renderInteractionSection(link, 'direct');
    });
  }

  if (indirectLinks.length > 0) {
    sectionsHTML += `<div class="modal-section-divider" style="margin: 24px 0 16px 0; padding: 12px 16px; background: linear-gradient(135deg, #fef3c7 0%, #fed7aa 100%); border-left: 6px solid #f59e0b; border-radius: 8px; box-shadow: 0 2px 4px rgba(245,158,11,0.1);">
      <h3 style="margin: 0; font-size: 16px; font-weight: 700; color: #92400e; text-transform: uppercase; letter-spacing: 1px; display: flex; align-items: center; gap: 8px;">
        <span style="display: inline-block; width: 8px; height: 8px; background: #f59e0b; border-radius: 50%;"></span>
        INDIRECT INTERACTIONS (${indirectLinks.length})
      </h3>
    </div>`;
    indirectLinks.forEach(link => {
      sectionsHTML += renderInteractionSection(link, 'indirect');
    });
  }

  if (sharedLinks.length > 0) {
    sectionsHTML += `<div class="modal-section-divider" style="margin: 24px 0 16px 0; padding: 12px 16px; background: linear-gradient(135deg, #f3e8ff 0%, #fae8ff 100%); border-left: 6px solid #9333ea; border-radius: 8px; box-shadow: 0 2px 4px rgba(147,51,234,0.1);">
      <h3 style="margin: 0; font-size: 16px; font-weight: 700; color: #581c87; text-transform: uppercase; letter-spacing: 1px; display: flex; align-items: center; gap: 8px;">
        <span style="display: inline-block; width: 8px; height: 8px; background: #9333ea; border-radius: 50%;"></span>
        SHARED INTERACTIONS (${sharedLinks.length})
      </h3>
    </div>`;
    sharedLinks.forEach(link => {
      sectionsHTML += renderInteractionSection(link, 'shared');
    });
  }

  // Expand/collapse footer
  // For pathway-expanded nodes, use lookupId for queries
  const isPathwayNode = !!clickedNode.pathwayId;
  const queryProteinId = lookupId;  // Use original protein name for queries
  const isMainProtein = lookupId === SNAP.main;
  const isExpanded = expanded.has(lookupId) || expanded.has(nodeId);
  const canExpand = (depthMap.get(lookupId) ?? depthMap.get(nodeId) ?? 1) < MAX_DEPTH;
  const hasInteractions = actualLinks.length > 0;

  let footerHTML = '';
  if (isMainProtein) {
    // Main protein: show single "Find New Interactions" button
    footerHTML = `
      <div class="modal-footer" style="border-top: 1px solid var(--color-border); padding: 16px; background: var(--color-bg-secondary);">
        <button onclick="handleQueryFromModal('${queryProteinId}')" class="btn-primary" style="padding: 8px 20px; background: #10b981; color: white; border: none; border-radius: 6px; font-weight: 500; cursor: pointer; font-size: 14px; font-family: var(--font-sans); transition: background 0.2s;">
          Find New Interactions
        </button>
      </div>
    `;
  } else if (isPathwayNode) {
    // Pathway-expanded node: only show Query button (no expand/collapse for pathway nodes)
    footerHTML = `
      <div class="modal-footer" style="border-top: 1px solid var(--color-border); padding: 16px; background: var(--color-bg-secondary);">
        <button onclick="handleQueryFromModal('${queryProteinId}')" class="btn-primary" style="padding: 8px 20px; background: #10b981; color: white; border: none; border-radius: 6px; font-weight: 500; cursor: pointer; font-size: 14px; font-family: var(--font-sans); transition: background 0.2s;">
          Query ${escapeHtml(queryProteinId)}
        </button>
      </div>
    `;
  } else {
    // Interactor: show conditional Expand + Query buttons
    footerHTML = `
      <div class="modal-footer" style="border-top: 1px solid var(--color-border); padding: 16px; background: var(--color-bg-secondary);">
        <div style="display: flex; gap: 12px; align-items: center; flex-wrap: wrap;">
          ${canExpand && !isExpanded && hasInteractions ? `
            <button onclick="handleExpandFromModal('${queryProteinId}')" class="btn-primary" style="padding: 8px 20px; background: #3b82f6; color: white; border: none; border-radius: 6px; font-weight: 500; cursor: pointer; font-size: 14px; font-family: var(--font-sans); transition: background 0.2s;">
              Expand
            </button>
          ` : ''}
          ${canExpand && !isExpanded && !hasInteractions ? `
            <button disabled style="padding: 8px 20px; background: #d1d5db; color: #6b7280; border: none; border-radius: 6px; font-weight: 500; font-size: 14px; cursor: not-allowed; font-family: var(--font-sans);">
              Expand (No data)
            </button>
          ` : ''}
          ${isExpanded ? `
            <button onclick="handleCollapseFromModal('${queryProteinId}')" class="btn-secondary" style="padding: 8px 20px; background: #ef4444; color: white; border: none; border-radius: 6px; font-weight: 500; cursor: pointer; font-size: 14px; font-family: var(--font-sans); transition: background 0.2s;">
              Collapse
            </button>
          ` : ''}
          <button onclick="handleQueryFromModal('${queryProteinId}')" class="btn-primary" style="padding: 8px 20px; background: #10b981; color: white; border: none; border-radius: 6px; font-weight: 500; cursor: pointer; font-size: 14px; font-family: var(--font-sans); transition: background 0.2s;">
            Query
          </button>
          ${!canExpand && !isExpanded ? `
            <div style="padding: 8px 20px; background: #f3f4f6; color: #6b7280; border-radius: 6px; font-size: 13px; font-family: var(--font-sans); font-style: italic;">
              Max depth reached (${MAX_DEPTH})
            </div>
          ` : ''}
        </div>
        <div style="margin-top: 12px; font-size: 12px; color: var(--color-text-secondary); font-family: var(--font-sans);">
          Expand uses existing data • Query finds new interactions
        </div>
      </div>
    `;
  }

  // Build modal title - show mediator relationship for indirect interactors
  let titleDisplay = nodeLabel;
  if (isIndirectNode && mediator) {
    // For indirect interactors, show the direct relationship: "PNKP → ATM"
    titleDisplay = `${mediator} → ${nodeLabel}`;
  }

  const modalTitle = `${escapeHtml(titleDisplay)} - Interactions (${actualLinks.length})`;

  // Assemble modal content with new sections:
  // 1. Pathway filter indicator (if filtering applied)
  // 2. Chain context banner (for indirect interactors)
  // 3. Interaction sections (direct, indirect, shared)
  // 4. Other pathways section (clickable tags)
  // 5. Footer (expand/collapse/query buttons)
  const modalContent = pathwayFilterIndicatorHTML + chainContextHTML + sectionsHTML + otherPathwaysHTML + footerHTML;

  openModal(modalTitle, modalContent);
}

/* Helper functions for expand/collapse from modal */
function handleExpandFromModal(proteinId) {
  closeModal();
  const node = nodeMap.get(proteinId); // PERFORMANCE: O(1) lookup
  if (node) {
    expandInteractor(node);
  }
}

function handleCollapseFromModal(proteinId) {
  closeModal();
  collapseInteractor(proteinId);
}

/**
 * Switch from one expanded pathway to another (for "Also appears in" tags)
 * Collapses current pathway and expands the new one
 */
function switchToPathway(newPathwayId, currentPathwayId) {
  closeModal();

  // Find and collapse current pathway
  if (currentPathwayId) {
    const currentPathwayNode = nodeMap.get(currentPathwayId);
    if (currentPathwayNode && currentPathwayNode.expanded) {
      collapsePathway(currentPathwayNode);
    }
  }

  // Find and expand new pathway
  const newPathwayNode = nodeMap.get(newPathwayId);
  if (newPathwayNode) {
    // Small delay for visual feedback
    setTimeout(() => {
      expandPathway(newPathwayNode);
      updateSimulation();
      renderGraph();
    }, 200);
  }
}

async function handleQueryFromModal(proteinId) {
  closeModal();

  // Get configuration from localStorage
  const queryConfig = {
    interactor_rounds: parseInt(localStorage.getItem('interactor_rounds')) || 3,
    function_rounds: parseInt(localStorage.getItem('function_rounds')) || 3,
    max_depth: parseInt(localStorage.getItem('max_depth')) || 3,
    skip_validation: localStorage.getItem('skip_validation') === 'true',
    skip_deduplicator: localStorage.getItem('skip_deduplicator') === 'true',
    skip_arrow_determination: localStorage.getItem('skip_arrow_determination') === 'true'
  };

  try {
    const response = await fetch('/api/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        protein: proteinId,
        ...queryConfig
      })
    });

    if (!response.ok) {
      const errorData = await response.json();
      showNotificationMessage(`<span style="color: #ef4444;">Query failed: ${errorData.error || 'Unknown error'}</span>`);
      return;
    }

    const data = await response.json();

    if (data.status === 'processing') {
      // Add job to tracker with reload callback
      vizJobTracker.addJob(proteinId, {
        ...queryConfig,
        onComplete: () => {
          // Reload page to show updated data
          vizJobTracker.saveToSessionStorage(); // Persist jobs before reload
          window.location.reload();
        }
      });
    } else if (data.status === 'complete') {
      // Already complete - reload immediately
      showNotificationMessage(`<span>Query complete! Reloading...</span>`);
      vizJobTracker.saveToSessionStorage(); // Persist jobs before reload
      setTimeout(() => { window.location.reload(); }, 500);
    } else {
      showNotificationMessage(`<span style="color: #ef4444;">Unexpected status: ${data.status}</span>`);
    }
  } catch (error) {
    console.error('[ERROR] Query from modal failed:', error);
    showNotificationMessage(`<span style="color: #ef4444;">Failed to start query</span>`);
  }
}

// Search protein from visualizer page
async function searchProteinFromVisualizer(proteinName) {
  showNotificationMessage(`<span>Searching for ${proteinName}...</span>`);

  try {
    const response = await fetch(`/api/search/${encodeURIComponent(proteinName)}`);

    if (!response.ok) {
      const errorData = await response.json();
      showNotificationMessage(`<span style="color: #ef4444;">${errorData.error || 'Search failed'}</span>`);
      return;
    }

    const data = await response.json();

    if (data.status === 'found') {
      // Protein exists - navigate to it
      showNotificationMessage(`<span>Found! Loading ${proteinName}...</span>`);
      localStorage.setItem('lastQueriedProtein', proteinName.toUpperCase());
      setTimeout(() => {
        window.location.href = `/api/visualize/${encodeURIComponent(proteinName)}?t=${Date.now()}`;
      }, 500);
    } else {
      // Not found - show query prompt
      showNotificationMessage(`<span>${proteinName} not found. <button onclick="startQueryFromVisualizer('${proteinName}')" style="padding: 4px 12px; background: #3b82f6; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 12px; margin-left: 8px;">Start Query</button></span>`);
    }
  } catch (error) {
    console.error('[ERROR] Search failed:', error);
    showNotificationMessage(`<span style="color: #ef4444;">Search failed</span>`);
  }
}

// Start query from visualizer page
async function startQueryFromVisualizer(proteinName) {
  // IMMEDIATELY hide notification message when starting query
  const msg = document.getElementById('notification-message');
  if (msg) {
    msg.style.display = 'none';
    msg.innerHTML = '';
  }

  const queryConfig = {
    interactor_rounds: parseInt(localStorage.getItem('interactor_rounds')) || 3,
    function_rounds: parseInt(localStorage.getItem('function_rounds')) || 3,
    max_depth: parseInt(localStorage.getItem('max_depth')) || 3,
    skip_validation: localStorage.getItem('skip_validation') === 'true',
    skip_deduplicator: localStorage.getItem('skip_deduplicator') === 'true',
    skip_arrow_determination: localStorage.getItem('skip_arrow_determination') === 'true'
  };

  try {
    const response = await fetch('/api/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        protein: proteinName,
        ...queryConfig
      })
    });

    if (!response.ok) {
      const errorData = await response.json();
      showNotificationMessage(`<span style="color: #ef4444;">Query failed: ${errorData.error || 'Unknown error'}</span>`);
      return;
    }

    const data = await response.json();

    if (data.status === 'processing') {
      // Add job to tracker with completion callback
      vizJobTracker.addJob(proteinName, {
        ...queryConfig,
        onComplete: () => {
          // Navigate to visualization
          localStorage.setItem('lastQueriedProtein', proteinName.toUpperCase());
          vizJobTracker.saveToSessionStorage(); // Persist jobs before navigation
          window.location.href = `/api/visualize/${encodeURIComponent(proteinName)}?t=${Date.now()}`;
        }
      });
    } else if (data.status === 'complete') {
      // Already complete - navigate immediately
      showNotificationMessage(`<span>Query complete! Loading visualization...</span>`);
      localStorage.setItem('lastQueriedProtein', proteinName.toUpperCase());
      vizJobTracker.saveToSessionStorage(); // Persist jobs before navigation
      setTimeout(() => {
        window.location.href = `/api/visualize/${encodeURIComponent(proteinName)}?t=${Date.now()}`;
      }, 500);
    } else {
      showNotificationMessage(`<span style="color: #ef4444;">Unexpected status: ${data.status}</span>`);
    }
  } catch (error) {
    console.error('[ERROR] Query failed:', error);
    showNotificationMessage(`<span style="color: #ef4444;">Failed to start query</span>`);
  }
}

function showFunctionModalFromNode(fnNode) {
  // Find the corresponding link to get the normalized arrow
  const linkId = `${fnNode.parent}-${fnNode.id}`;
  const correspondingLink = links.find(l => l.id === linkId);

  // Leverage the same renderer as link, but pass the fields explicitly
  showFunctionModal({
    fn: fnNode.data,
    interactor: fnNode.interactorData,
    affected: fnNode.parent,
    label: fnNode.label,
    linkArrow: correspondingLink ? correspondingLink.arrow : undefined
  });
}

/* Function modal (from function link click) */
function showFunctionModalFromLink(link) {
  const payload = link.data || {};
  showFunctionModal({
    fn: payload.fn || {},
    interactor: payload.interactor || {},
    affected: (payload.interactor && payload.interactor.primary) || '—',
    label: (payload.fn && payload.fn.function) || 'Function',
    linkArrow: link.arrow  // Pass the link's already-normalized arrow
  });
}

/* Render function modal (interactor → fn) */
function showFunctionModal({ fn, interactor, affected, label, linkArrow }) {

  // Format references with full paper details from evidence using beautiful wrappers
  const evs = Array.isArray(fn.evidence) ? fn.evidence : [];
  const evHTML = evs.length ? `<div class="expanded-evidence-list">${evs.map(ev => {
    const primaryLink = ev.pmid ? `https://pubmed.ncbi.nlm.nih.gov/${ev.pmid}` : (ev.doi ? `https://doi.org/${ev.doi}` : null);
    return `<div class="expanded-evidence-wrapper">
      <div class="expanded-evidence-card" data-evidence-link="${primaryLink || ''}" data-has-link="${primaryLink ? 'true' : 'false'}">
        <div class="expanded-evidence-title">${ev.paper_title || 'Title not available'}</div>
        <div class="expanded-evidence-meta">
          ${ev.authors ? `<div class="expanded-evidence-meta-item"><strong>Authors:</strong> ${ev.authors}</div>` : ''}
          ${ev.journal ? `<div class="expanded-evidence-meta-item"><strong>Journal:</strong> ${ev.journal}</div>` : ''}
          ${ev.year ? `<div class="expanded-evidence-meta-item"><strong>Year:</strong> ${ev.year}</div>` : ''}
        </div>
        ${ev.relevant_quote ? `<div class="expanded-evidence-quote">"${ev.relevant_quote}"</div>` : ''}
        <div class="expanded-evidence-pmids" style="margin-top:8px;">
          ${ev.pmid ? `<a href="https://pubmed.ncbi.nlm.nih.gov/${ev.pmid}" target="_blank" class="expanded-pmid-badge" onclick="event.stopPropagation();">PMID: ${ev.pmid}</a>` : ''}
          ${ev.doi ? `<a href="https://doi.org/${ev.doi}" target="_blank" class="expanded-pmid-badge" onclick="event.stopPropagation();">DOI: ${ev.doi}</a>` : ''}
        </div>
      </div>
    </div>`;
  }).join('')}</div>` : (Array.isArray(fn.pmids) && fn.pmids.length
    ? fn.pmids.map(p => `<a class="pmid-link" target="_blank" href="https://pubmed.ncbi.nlm.nih.gov/${p}">PMID: ${p}</a>`).join(', ')
    : '<div class="expanded-empty">No references available</div>');

  // Format specific effects with 3D wrappers
  let effectsHTML = '';
  if (Array.isArray(fn.specific_effects) && fn.specific_effects.length) {
    const effectChips = fn.specific_effects.map(s => `
      <div class="expanded-effect-chip-wrapper">
        <div class="expanded-effect-chip">${s}</div>
      </div>`).join('');
    effectsHTML = `
      <tr class="info-row">
        <td class="info-label">SPECIFIC EFFECTS</td>
        <td class="info-value">
          <div class="expanded-effects-grid">${effectChips}</div>
        </td>
      </tr>`;
  }

  // Format biological cascade - NORMALIZED VERTICAL FLOWCHART
  const createCascadeHTML = (value) => {
    const segments = Array.isArray(value) ? value : (value ? [value] : []);
    if (segments.length === 0) {
      return '<div class="expanded-empty">Cascading biological effects not specified</div>';
    }

    // Normalize: flatten all segments and split by arrow (→)
    const allSteps = [];
    segments.forEach(segment => {
      const text = (segment == null ? '' : segment).toString().trim();
      if (!text) return;

      // Split by arrow and clean each step
      const steps = text.split('→').map(s => s.trim()).filter(s => s.length > 0);
      allSteps.push(...steps);
    });

    if (allSteps.length === 0) {
      return '<div class="expanded-empty">Cascading biological effects not specified</div>';
    }

    // Create vertical flowchart blocks
    const items = allSteps.map(step =>
      `<div class="cascade-flow-item">${escapeHtml(step)}</div>`
    ).join('');

    return `<div class="cascade-wrapper"><div class="cascade-flow-container">${items}</div></div>`;
  };
  const biologicalConsequenceHTML = createCascadeHTML(fn.biological_consequence);

  const mechanism = interactor && interactor.intent ? (interactor.intent[0].toUpperCase() + interactor.intent.slice(1)) : 'Not specified';

  // EFFECT TYPE: Use the link's already-normalized arrow
  // The link was created with the normalized arrow, so we MUST use that for consistency
  const normalizedArrow = linkArrow || 'binds';  // Default to binds if no link arrow provided
  const arrowColor = normalizedArrow === 'activates' ? '#059669' : (normalizedArrow === 'inhibits' ? '#dc2626' : '#7c3aed');
  const arrowStr = fn.effect_description ?
    `<strong style="color:${arrowColor};">${fn.effect_description}</strong>` :
    (normalizedArrow === 'activates' ?
      '<strong style="color:#059669;">✓ Function is enhanced or activated</strong>' :
      (normalizedArrow === 'inhibits' ?
        '<strong style="color:#dc2626;">✗ Function is inhibited or disrupted</strong>' :
        '<strong style="color:#7c3aed;">⊕ Binds/Interacts</strong>'));

  // Check for validity field (from fact-checker)
  const validity = fn.validity || 'TRUE';
  const validationNote = fn.validation_note || '';
  const isConflicting = validity === 'CONFLICTING';
  const isFalse = validity === 'FALSE';

  // Build conflict warning HTML if needed
  let conflictWarningHTML = '';
  if (isConflicting || isFalse) {
    const warningType = isFalse ? 'Invalid Claim' : 'Conflicting Evidence';
    const warningIcon = isFalse ? '❌' : '⚠️';
    const warningColor = isFalse ? '#dc2626' : '#f59e0b';
    conflictWarningHTML = `
      <tr class="info-row">
        <td colspan="2">
          <div style="background:${isFalse ? '#fee2e2' : '#fff3cd'};border-left:4px solid ${warningColor};padding:12px 16px;margin:8px 0;border-radius:4px;">
            <div style="font-weight:600;color:${warningColor};margin-bottom:4px;">
              ${warningIcon} <strong>${warningType}</strong>
            </div>
            <div style="color:#374151;font-size:13px;">${validationNote}</div>
          </div>
        </td>
      </tr>`;
  }

  // Update function label to show asterisk for conflicting claims
  const functionLabel = isConflicting ? `⚠ ${label} *` : label;

  // Wrap mechanism with beautiful wrapper
  const mechanismHTML = mechanism !== 'Not specified'
    ? `<div class="expanded-mechanism-wrapper"><span class="mechanism-badge">${mechanism}</span></div>`
    : '<span class="muted-text">Not specified</span>';

  // Wrap cellular process with beautiful wrapper
  const cellularHTML = fn.cellular_process
    ? `<div class="expanded-cellular-wrapper"><div class="expanded-cellular-process"><div class="expanded-cellular-process-text">${fn.cellular_process}</div></div></div>`
    : '<div class="expanded-empty">Molecular mechanism not specified</div>';

  // ========== PATHWAY CONTEXT ==========
  // FIXED: Use fn.pathway directly instead of searching nodes
  // This ensures the function's pathway matches what was assigned in Script 05
  let pathwayContextHTML = '';
  if (pathwayMode) {
    const relevantPathways = [];

    // NEW: First check if function has pathway assigned directly
    if (fn.pathway && fn.pathway.name) {
      const fnPathway = fn.pathway;
      relevantPathways.push({
        name: fnPathway.canonical_name || fnPathway.name,
        hierarchy: fnPathway.hierarchy || [fnPathway.name],
        level: fnPathway.level || 0,
        is_leaf: fnPathway.is_leaf !== false,
        id: fnPathway.name,
        ontologyId: fnPathway.ontology_id,
        ontologySource: fnPathway.ontology_source
      });
    } else if (interactor) {
      // Fallback: Check pathway nodes to find ones containing this interactor
      const interactorId = interactor.primary || interactor.id || affected;
      nodes.filter(n => n.type === 'pathway').forEach(pathwayNode => {
        const interactorIds = pathwayNode.interactorIds || [];
        if (interactorIds.includes(interactorId)) {
          relevantPathways.push({
            name: pathwayNode.label,
            id: pathwayNode.id,
            hierarchy: pathwayNode.hierarchy || [pathwayNode.label],
            level: pathwayNode.level || 0,
            ontologyId: pathwayNode.ontologyId,
            ontologySource: pathwayNode.ontologySource
          });
        }
      });
    }

    if (relevantPathways.length > 0) {
      // Determine role based on function arrow
      const roleText = normalizedArrow === 'activates'
        ? `Activates ${label} within this pathway`
        : normalizedArrow === 'inhibits'
          ? `Inhibits ${label} within this pathway`
          : normalizedArrow === 'regulates'
            ? `Regulates ${label} within this pathway`
            : `Interacts with ${label} in this pathway`;

      const pathwayBadges = relevantPathways.map(pw => {
        const ontologyLink = pw.ontologyId && pw.ontologySource
          ? (pw.ontologySource === 'GO'
            ? `<a href="https://www.ebi.ac.uk/QuickGO/term/${pw.ontologyId}" target="_blank" class="ontology-link">${pw.ontologyId}</a>`
            : `<span class="ontology-badge">${pw.ontologyId}</span>`)
          : '';

        // NEW: Show hierarchy chain if available
        const hierarchyChain = pw.hierarchy && pw.hierarchy.length > 1
          ? `<div class="pathway-hierarchy-chain" style="font-size: 10px; color: #6b7280; margin-top: 4px;">${pw.hierarchy.join(' → ')}</div>`
          : '';

        // NEW: Show level and leaf badge
        const levelBadge = pw.level !== undefined
          ? `<span class="pathway-level-badge" style="font-size: 9px; background: #e0e7ff; color: #4338ca; padding: 1px 4px; border-radius: 3px; margin-left: 6px;">Level ${pw.level}</span>`
          : '';
        const leafBadge = pw.is_leaf
          ? `<span class="pathway-leaf-badge" style="font-size: 9px; background: #d1fae5; color: #059669; padding: 1px 4px; border-radius: 3px; margin-left: 4px;">LEAF</span>`
          : '';

        return `<div class="pathway-context-badge">
          <div style="display: flex; align-items: center; flex-wrap: wrap;">
            <span class="pathway-name">${pw.name}</span>
            ${levelBadge}
            ${leafBadge}
            ${ontologyLink}
          </div>
          ${hierarchyChain}
        </div>`;
      }).join('');

      pathwayContextHTML = `
        <tr class="info-row">
          <td class="info-label">PATHWAY CONTEXT</td>
          <td class="info-value">
            <div class="pathway-context-wrapper">
              <div class="pathway-badges">${pathwayBadges}</div>
              <div class="pathway-role">${roleText}</div>
            </div>
          </td>
        </tr>`;
    }
  }

  // Wrap effect type with beautiful wrapper
  const effectTypeColor = normalizedArrow === 'activates' ? 'activates' : (normalizedArrow === 'inhibits' ? 'inhibits' : 'binds');
  const effectTypeText = fn.effect_description || (normalizedArrow === 'activates' ? '✓ Function is enhanced or activated' : (normalizedArrow === 'inhibits' ? '✗ Function is inhibited or disrupted' : '⊕ Binds/Interacts'));
  const effectTypeHTML = `<div class="expanded-effect-type ${effectTypeColor}"><span class="effect-type-badge ${effectTypeColor}">${effectTypeText}</span></div>`;

  // Wrap function and protein names prominently
  const functionHTML = `<div class="function-name-wrapper ${effectTypeColor}"><span class="function-name ${effectTypeColor}" style="font-size: 18px;">${functionLabel}</span></div>`;
  const affectedHTML = `<div class="interaction-name-wrapper"><div class="interaction-name" style="font-size: 16px;">${affected}</div></div>`;

  const body = `
    <table class="info-table">
      ${conflictWarningHTML}
      <tr class="info-row"><td class="info-label">FUNCTION</td><td class="info-value">${functionHTML}</td></tr>
      <tr class="info-row"><td class="info-label">AFFECTED PROTEIN</td><td class="info-value">${affectedHTML}</td></tr>
      ${pathwayContextHTML}
      <tr class="info-row"><td class="info-label">EFFECT TYPE</td><td class="info-value">${effectTypeHTML}</td></tr>
      <tr class="info-row"><td class="info-label">MECHANISM</td><td class="info-value">${mechanismHTML}</td></tr>
      <tr class="info-row"><td class="info-label">CELLULAR PROCESS</td><td class="info-value">${cellularHTML}</td></tr>
      <tr class="info-row"><td class="info-label">BIOLOGICAL CASCADE</td><td class="info-value">${biologicalConsequenceHTML}</td></tr>
      ${effectsHTML}
      <tr class="info-row"><td class="info-label">REFERENCES</td><td class="info-value">${evHTML}</td></tr>
    </table>`;
  openModal(`Function: ${label}`, body);
}

/* ===== Progress helpers (viz page) ===== */
// Custom error for cancellations (to distinguish from other errors)
class CancellationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CancellationError';
  }
}

// ============================================================================
// UTILITY FUNCTIONS - Fetch with timeout and retry
// ============================================================================

/**
 * Fetch with timeout to prevent hanging requests
 * FIXED: Added 30s timeout for all HTTP requests
 */
async function fetchWithTimeout(url, options = {}, timeout = 30000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal
    });
    clearTimeout(id);
    return response;
  } catch (error) {
    clearTimeout(id);
    if (error.name === 'AbortError') {
      throw new Error('Request timeout');
    }
    throw error;
  }
}

/**
 * Fetch with exponential backoff retry
 * FIXED: Added retry logic for failed status checks
 */
async function fetchWithRetry(url, options = {}, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const response = await fetchWithTimeout(url, options);
      return response;
    } catch (error) {
      if (i === maxRetries - 1) throw error;

      // Exponential backoff: 1s, 2s, 4s
      const delay = 1000 * Math.pow(2, i);
      console.log(`[Fetch] Retry ${i + 1}/${maxRetries} after ${delay}ms for ${url}`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

// ============================================================================
// FUNCTIONAL CORE - Pure State Management (No Side Effects)
// ============================================================================

/**
 * Calculate percentage from current/total progress
 * @pure
 */
function calculateJobPercent(current, total) {
  if (typeof current !== 'number' || typeof total !== 'number') return 0;
  if (total <= 0) return 0;
  if (current >= total) return 100;
  return Math.round((current / total) * 100);
}

/**
 * Format job status into display metadata
 * @pure
 */
function formatVizJobStatus(status) {
  const statusMap = {
    processing: { color: '#3b82f6', icon: '⏳', text: 'Running' },
    complete: { color: '#10b981', icon: '✓', text: 'Complete' },
    error: { color: '#ef4444', icon: '✕', text: 'Failed' },
    cancelled: { color: '#6b7280', icon: '⊘', text: 'Cancelled' }
  };
  return statusMap[status] || statusMap.processing;
}

/**
 * Create new job state object
 * @pure
 */
function createVizJobState(protein, config = {}) {
  return {
    protein,
    status: 'processing',
    progress: {
      current: 0,
      total: 100,
      text: 'Initializing...'
    },
    config,
    startTime: Date.now()
  };
}

/**
 * Update job progress (returns new object)
 * @pure
 */
function updateVizJobProgress(job, progressData) {
  return {
    ...job,
    progress: {
      current: progressData.current || job.progress.current,
      total: progressData.total || job.progress.total,
      text: progressData.text || job.progress.text
    }
  };
}

/**
 * Mark job as complete (returns new object)
 * @pure
 */
function markVizJobComplete(job) {
  return {
    ...job,
    status: 'complete',
    progress: {
      current: 100,
      total: 100,
      text: 'Complete!'
    }
  };
}

/**
 * Mark job as error (returns new object)
 * @pure
 */
function markVizJobError(job, errorText) {
  return {
    ...job,
    status: 'error',
    progress: {
      ...job.progress,
      text: errorText || 'Error occurred'
    }
  };
}

/**
 * Mark job as cancelled (returns new object)
 * @pure
 */
function markVizJobCancelled(job) {
  return {
    ...job,
    status: 'cancelled',
    progress: {
      ...job.progress,
      text: 'Cancelled by user'
    }
  };
}

// ============================================================================
// IMPERATIVE SHELL - DOM Manipulation (Thin I/O Layer)
// ============================================================================

/**
 * Create a mini job card DOM element (for viz page header)
 * Compact chip layout: NAME - XX% [=====___] [−][×]
 * @returns {Object} { container, bar, text, percent, removeBtn, cancelBtn }
 */
function createMiniJobCard(protein) {
  const container = document.createElement('div');
  container.className = 'mini-job-card';
  container.id = `mini-job-${protein}`;

  container.innerHTML = `
    <span class="mini-job-protein">${protein}</span>
    <span class="mini-job-separator">−</span>
    <span class="mini-job-progress-percent">0%</span>
    <div class="mini-job-progress-bar-outer">
      <div class="mini-job-progress-bar-inner"></div>
    </div>
    <div class="mini-job-actions">
      <button class="mini-job-btn mini-job-remove" title="Remove from tracker (job continues in background)" aria-label="Remove from tracker">
        <span class="mini-job-btn-icon">−</span>
      </button>
      <button class="mini-job-btn mini-job-cancel" title="Cancel job" aria-label="Cancel job">
        <span class="mini-job-btn-icon">✕</span>
      </button>
    </div>
  `;

  return {
    container,
    bar: container.querySelector('.mini-job-progress-bar-inner'),
    text: null, // Not used in compact layout
    percent: container.querySelector('.mini-job-progress-percent'),
    removeBtn: container.querySelector('.mini-job-remove'),
    cancelBtn: container.querySelector('.mini-job-cancel')
  };
}

/**
 * Update mini job card UI with current job state
 */
function updateMiniJobCard(elements, job) {
  if (!elements || !job) return;

  const { bar, text, percent, container } = elements;
  const progressPercent = calculateJobPercent(job.progress.current, job.progress.total);
  const statusInfo = formatVizJobStatus(job.status);

  // Update progress bar
  if (bar) {
    bar.style.width = `${progressPercent}%`;
    bar.style.backgroundColor = statusInfo.color;
  }

  // Update text
  if (text) {
    if (job.progress.current && job.progress.total) {
      text.textContent = `${job.protein}: Step ${job.progress.current}/${job.progress.total}`;
    } else {
      text.textContent = `${job.protein}: ${job.progress.text}`;
    }
  }

  // Update percent
  if (percent) {
    percent.textContent = `${progressPercent}%`;
  }

  // Update container state
  if (container) {
    container.setAttribute('data-status', job.status);
  }
}

/**
 * Remove mini job card from DOM with fade animation
 */
function removeMiniJobCard(container, callback) {
  if (!container) {
    if (callback) callback();
    return;
  }

  container.style.opacity = '0';
  container.style.transform = 'translateY(-10px)';

  setTimeout(() => {
    if (container.parentNode) {
      container.parentNode.removeChild(container);
    }
    if (callback) callback();
  }, 300);
}

// ============================================================================
// VIZ JOB TRACKER - Multi-Job Orchestration for Visualization Page
// ============================================================================

class VizJobTracker {
  constructor(containerId) {
    this.jobs = new Map();           // protein -> job state
    this.intervals = new Map();      // protein -> intervalId
    this.uiElements = new Map();     // protein -> DOM elements
    this.container = document.getElementById(containerId);
    this._isRestoring = false;       // FIXED: Guard against parallel restores

    if (!this.container) {
      console.warn(`[VizJobTracker] Container #${containerId} not found. Creating fallback.`);
      this._createFallbackContainer();
    }
  }

  /**
   * Create fallback container if none exists
   */
  _createFallbackContainer() {
    const notification = document.getElementById('job-notification');
    if (notification) {
      const container = document.createElement('div');
      container.id = 'mini-job-container';
      container.className = 'mini-job-container';
      notification.insertBefore(container, notification.firstChild);
      this.container = container;
    }
  }

  /**
   * Add a new job to tracker and start polling
   */
  addJob(protein, config = {}) {
    // Guard: prevent duplicate jobs
    if (this.jobs.has(protein)) {
      const existingJob = this.jobs.get(protein);
      if (existingJob.status === 'processing') {
        console.warn(`[VizJobTracker] Job for ${protein} already running`);

        // Show user-friendly warning
        const confirmed = confirm(
          `A query for ${protein} is already running.\n\nCancel the existing job and start a new one?`
        );

        if (confirmed) {
          this.cancelJob(protein);
          // Wait a moment for cleanup
          setTimeout(() => this._addJobInternal(protein, config), 500);
        }
        return;
      }
    }

    this._addJobInternal(protein, config);
  }

  /**
   * Internal method to add job (separated for recursion after cancel)
   */
  _addJobInternal(protein, config) {
    // Create job state
    const job = createVizJobState(protein, config);
    this.jobs.set(protein, job);

    // Show header when first job starts
    showHeader();

    // Render UI
    this._renderJob(protein);

    // Start polling
    this._startPolling(protein);

    console.log(`[VizJobTracker] Added job for ${protein}`);
  }

  /**
   * Remove job from tracker (UI only, job continues in background)
   */
  removeFromTracker(protein) {
    console.log(`[VizJobTracker] Removing ${protein} from tracker (job continues in background)`);

    // Stop polling
    this._stopPolling(protein);

    // Remove UI
    const elements = this.uiElements.get(protein);
    if (elements) {
      removeMiniJobCard(elements.container, () => {
        this.uiElements.delete(protein);
      });
    }

    // Remove from state
    this.jobs.delete(protein);

    // Hide header if no more jobs
    if (this.jobs.size === 0) {
      setTimeout(hideHeader, 500);
    }
  }

  /**
   * Cancel job (stops backend job + removes from tracker)
   * FIXED: Stop polling BEFORE cancel request to prevent race condition
   */
  async cancelJob(protein) {
    console.log(`[VizJobTracker] Cancelling job for ${protein}`);

    const job = this.jobs.get(protein);
    if (!job) {
      console.warn(`[VizJobTracker] No job found for ${protein}`);
      return;
    }

    // FIXED: Stop polling FIRST to prevent race with completion
    this._stopPolling(protein);

    // Disable cancel button to prevent double-clicks
    const elements = this.uiElements.get(protein);
    if (elements && elements.cancelBtn) {
      elements.cancelBtn.disabled = true;
    }

    try {
      // Send cancel request to backend
      const response = await fetch(`/api/cancel/${encodeURIComponent(protein)}`, {
        method: 'POST'
      });

      if (!response.ok) {
        throw new Error('Cancel request failed');
      }

      // Update state
      const cancelledJob = markVizJobCancelled(job);
      this.jobs.set(protein, cancelledJob);

      // Update UI
      this._updateJobUI(protein);

      // Remove after delay
      setTimeout(() => {
        this.removeFromTracker(protein);
      }, 2000);

    } catch (error) {
      console.error(`[VizJobTracker] Failed to cancel ${protein}:`, error);

      // Re-enable cancel button on error
      if (elements && elements.cancelBtn) {
        elements.cancelBtn.disabled = false;
      }

      // Show error in UI
      const errorJob = markVizJobError(job, 'Failed to cancel job');
      this.jobs.set(protein, errorJob);
      this._updateJobUI(protein);

      // Restart polling on error (cancel failed, job still running)
      this._startPolling(protein);
    }
  }

  /**
   * Update job progress
   */
  updateJob(protein, progressData) {
    const job = this.jobs.get(protein);
    if (!job) return;

    const updatedJob = updateVizJobProgress(job, progressData);
    this.jobs.set(protein, updatedJob);
    this._updateJobUI(protein);
  }

  /**
   * Mark job as complete (with custom callback)
   */
  completeJob(protein, onComplete) {
    const job = this.jobs.get(protein);
    if (!job) return;

    const completedJob = markVizJobComplete(job);
    this.jobs.set(protein, completedJob);
    this._updateJobUI(protein);
    this._stopPolling(protein);

    // Call custom completion callback
    if (onComplete) {
      setTimeout(() => {
        onComplete();
        this.removeFromTracker(protein);
      }, 1000);
    } else {
      // Default: auto-remove after delay
      setTimeout(() => {
        this.removeFromTracker(protein);
      }, 3000);
    }
  }

  /**
   * Mark job as error
   */
  errorJob(protein, errorText) {
    const job = this.jobs.get(protein);
    if (!job) return;

    const errorJob = markVizJobError(job, errorText);
    this.jobs.set(protein, errorJob);
    this._updateJobUI(protein);
    this._stopPolling(protein);

    // Auto-remove after delay
    setTimeout(() => {
      this.removeFromTracker(protein);
    }, 5000);
  }

  /**
   * Render mini job card in UI
   */
  _renderJob(protein) {
    if (!this.container) return;

    const job = this.jobs.get(protein);
    if (!job) return;

    // Create job card
    const elements = createMiniJobCard(protein);
    this.uiElements.set(protein, elements);

    // Wire up event listeners
    elements.removeBtn.onclick = () => this.removeFromTracker(protein);
    elements.cancelBtn.onclick = () => this.cancelJob(protein);

    // Add to DOM
    this.container.appendChild(elements.container);

    // Initial render
    this._updateJobUI(protein);

    // Trigger animation
    setTimeout(() => {
      elements.container.style.opacity = '1';
    }, 10);
  }

  /**
   * Update job UI from state
   */
  _updateJobUI(protein) {
    const job = this.jobs.get(protein);
    const elements = this.uiElements.get(protein);

    if (!job || !elements) return;

    updateMiniJobCard(elements, job);
  }

  /**
   * Start polling for job status
   * FIXED: Uses fetchWithRetry for resilience
   */
  _startPolling(protein) {
    const intervalId = setInterval(async () => {
      try {
        const response = await fetchWithRetry(`/api/status/${encodeURIComponent(protein)}`);

        if (!response.ok) {
          console.warn(`[VizJobTracker] Status check failed for ${protein}`);
          return;
        }

        const data = await response.json();
        const job = this.jobs.get(protein);

        if (!job) {
          // Job was removed, stop polling
          this._stopPolling(protein);
          return;
        }

        // Handle different statuses
        if (data.status === 'complete') {
          // Get custom completion callback from job config
          this.completeJob(protein, job.config.onComplete);
        } else if (data.status === 'cancelled' || data.status === 'cancelling') {
          const cancelledJob = markVizJobCancelled(job);
          this.jobs.set(protein, cancelledJob);
          this._updateJobUI(protein);
          this._stopPolling(protein);
          setTimeout(() => this.removeFromTracker(protein), 2000);
        } else if (data.status === 'error') {
          const errorText = typeof data.progress === 'object' ? data.progress.text : data.progress;
          this.errorJob(protein, errorText || 'Unknown error');
        } else if (data.progress) {
          // Processing - update progress
          this.updateJob(protein, data.progress);
        }

      } catch (error) {
        console.error(`[VizJobTracker] Polling error for ${protein}:`, error);
      }
    }, 5000); // FIXED: Standardized to 5s (was 4s)

    this.intervals.set(protein, intervalId);
  }

  /**
   * Stop polling for job
   */
  _stopPolling(protein) {
    const intervalId = this.intervals.get(protein);
    if (intervalId) {
      clearInterval(intervalId);
      this.intervals.delete(protein);
    }
  }

  /**
   * Get count of active jobs
   */
  getActiveJobCount() {
    return Array.from(this.jobs.values()).filter(
      job => job.status === 'processing'
    ).length;
  }

  /**
   * Save active jobs to sessionStorage for persistence across page navigations
   * FIXED: Merges with existing jobs to prevent multi-tab corruption
   */
  saveToSessionStorage() {
    // Read existing saved jobs from sessionStorage
    const existing = sessionStorage.getItem('vizActiveJobs');
    const existingJobs = existing ? JSON.parse(existing) : [];

    // Get current processing jobs
    const currentProteins = new Set();
    this.jobs.forEach((job, protein) => {
      if (job.status === 'processing') {
        currentProteins.add(protein);
      }
    });

    // Merge: Keep existing jobs not in current tab, add current tab's jobs
    const merged = existingJobs.filter(j => !currentProteins.has(j.protein));

    this.jobs.forEach((job, protein) => {
      if (job.status === 'processing') {
        merged.push({
          protein: protein,
          startTime: job.startTime,
          config: job.config || {}
        });
      }
    });

    sessionStorage.setItem('vizActiveJobs', JSON.stringify(merged));
    console.log(`[SessionStorage] Saved ${merged.length} active job(s) (merged from ${existingJobs.length} existing)`);
  }

  /**
   * Restore jobs from sessionStorage on page load
   * Only restores jobs that are still actually running on backend
   * FIXED: Guard against parallel restores
   */
  async restoreFromSessionStorage() {
    // Guard against parallel restores
    if (this._isRestoring) {
      console.log('[SessionStorage] Restore already in progress, skipping');
      return;
    }

    this._isRestoring = true;

    try {
      const saved = sessionStorage.getItem('vizActiveJobs');
      if (!saved) {
        console.log('[SessionStorage] No saved jobs found');
        return;
      }

      const savedJobs = JSON.parse(saved);
      const oneHourAgo = Date.now() - (60 * 60 * 1000);

      console.log(`[SessionStorage] Found ${savedJobs.length} saved job(s), checking status...`);

      let restoredCount = 0;

      for (const savedJob of savedJobs) {
        // Skip stale jobs (>1 hour old)
        if (savedJob.startTime < oneHourAgo) {
          console.log(`[SessionStorage] Skipping stale job: ${savedJob.protein} (${Math.round((Date.now() - savedJob.startTime) / 60000)}min old)`);
          continue;
        }

        // Check if job is still running
        try {
          const response = await fetchWithRetry(`/api/status/${encodeURIComponent(savedJob.protein)}`);
          if (!response.ok) {
            console.log(`[SessionStorage] Job ${savedJob.protein} not found on backend`);
            continue;
          }

          const data = await response.json();

          if (data.status === 'processing') {
            // FIXED: Check if already tracked (from auto-resume) to prevent duplicate dialog
            if (!this.jobs.has(savedJob.protein)) {
              console.log(`[SessionStorage] Restoring job: ${savedJob.protein}`);
              this.addJob(savedJob.protein, savedJob.config || {});
              restoredCount++;
            } else {
              console.log(`[SessionStorage] Skipping ${savedJob.protein} (already tracked)`);
            }
          } else {
            console.log(`[SessionStorage] Job ${savedJob.protein} no longer processing (status: ${data.status})`);
          }
        } catch (error) {
          console.log(`[SessionStorage] Failed to check job ${savedJob.protein}:`, error.message);
        }
      }

      console.log(`[SessionStorage] Restored ${restoredCount} active job(s)`);

      // FIXED: Clean up sessionStorage to only keep currently active jobs
      const activeJobs = [];
      this.jobs.forEach((job, protein) => {
        if (job.status === 'processing') {
          activeJobs.push({
            protein: protein,
            startTime: job.startTime,
            config: job.config || {}
          });
        }
      });
      sessionStorage.setItem('vizActiveJobs', JSON.stringify(activeJobs));
      console.log(`[SessionStorage] Cleaned up, ${activeJobs.length} active jobs remain`);

    } catch (error) {
      console.error('[SessionStorage] Restore failed:', error);
    } finally {
      this._isRestoring = false;
    }
  }
}

// Initialize global job tracker for viz page
const vizJobTracker = new VizJobTracker('mini-job-container');

function showHeader() {
  const header = document.querySelector('.header');
  if (header) header.classList.add('header-visible');
}
function hideHeader() {
  const header = document.querySelector('.header');
  if (header) header.classList.remove('header-visible');
}

/**
 * Show notification message in header (for non-job messages)
 */
function showNotificationMessage(html) {
  const msg = document.getElementById('notification-message');
  if (msg) {
    msg.innerHTML = html;
    msg.style.display = 'block';
    showHeader();
    // Auto-hide after 5 seconds
    setTimeout(() => {
      msg.style.display = 'none';
      if (vizJobTracker.getActiveJobCount() === 0) {
        hideHeader();
      }
    }, 5000);
  }
}

/**
 * Show query prompt for protein not found in database
 * Matches index page behavior - gives user option to start query
 */
function showQueryPromptViz(proteinName) {
  const message = `
    <div style="text-align: center; padding: 12px;">
      <p style="font-size: 14px; color: #6b7280; margin-bottom: 12px;">
        Protein <strong>${proteinName}</strong> not found in database.
      </p>
      <button onclick="startQueryFromVisualizer('${proteinName}')"
              style="padding: 8px 16px; background: #3b82f6; color: white;
                     border: none; border-radius: 6px; font-weight: 500;
                     cursor: pointer; font-size: 13px;">
        Start Research Query
      </button>
    </div>
  `;
  showNotificationMessage(message);
}

function miniProgress(text, current, total, proteinName) {
  const wrap = document.getElementById('mini-progress-wrapper');
  const bar = document.getElementById('mini-progress-bar-inner');
  const txt = document.getElementById('mini-progress-text');
  const msg = document.getElementById('notification-message');
  const cancelBtn = document.getElementById('mini-cancel-btn');

  if (msg) msg.innerHTML = '';

  // FALLBACK: If old elements don't exist, use new tracker system
  if (!wrap || !bar || !txt) {
    if (proteinName) {
      // Use new job tracker if tracking a specific protein
      const existingJob = vizJobTracker.jobs.get(proteinName);
      if (!existingJob) {
        // Auto-create job in tracker if it doesn't exist
        vizJobTracker.addJob(proteinName, {});
      }
      // Update progress
      if (typeof current === 'number' && typeof total === 'number') {
        vizJobTracker.updateJob(proteinName, { current, total, text: text || 'Processing' });
      }
    } else {
      // Show as notification for non-protein-specific messages
      showNotificationMessage(`<span>${text || 'Processing...'}</span>`);
    }
    return;
  }

  // OLD CODE PATH: Use old elements if they exist
  showHeader();
  wrap.style.display = 'grid';

  // Track current job
  if (proteinName) {
    currentJobProtein = proteinName;
    currentRunningJob = proteinName;  // Keep both variables in sync
    // Show cancel button for all jobs
    if (cancelBtn) {
      cancelBtn.style.display = 'inline-block';
      cancelBtn.disabled = false;  // Re-enable in case it was disabled
    }
  }

  if (typeof current === 'number' && typeof total === 'number' && total > 0) {
    const pct = Math.max(0, Math.min(100, Math.round((current / total) * 100)));
    bar.style.width = pct + '%';
    // Simplified format for visualization page: just protein name and percentage
    if (proteinName) {
      txt.textContent = `${proteinName}: ${pct}%`;
    } else {
      txt.textContent = `${text || 'Processing…'} (${pct}%)`;
    }
  } else {
    bar.style.width = '25%';
    // When no progress numbers available, show protein name with status
    if (proteinName) {
      txt.textContent = `${proteinName}: ${text || 'Processing…'}`;
    } else {
      txt.textContent = text || 'Processing…';
    }
  }
}

function miniDone(html) {
  const wrap = document.getElementById('mini-progress-wrapper');
  const bar = document.getElementById('mini-progress-bar-inner');
  const msg = document.getElementById('notification-message');
  const cancelBtn = document.getElementById('mini-cancel-btn');

  // FALLBACK: If old elements don't exist, use new notification system
  if (!wrap || !bar) {
    if (html) {
      showNotificationMessage(html);
    }
    currentJobProtein = null;
    currentRunningJob = null;
    return;
  }

  // OLD CODE PATH: Use old elements if they exist
  if (wrap) wrap.style.display = 'none';
  if (bar) bar.style.width = '0%';
  if (cancelBtn) cancelBtn.style.display = 'none';
  if (msg && html) msg.innerHTML = html;

  // Hide header after a delay
  setTimeout(hideHeader, 3000);
  currentJobProtein = null;
  currentRunningJob = null;  // Clear both variables
}

async function cancelCurrentJob() {
  if (!currentJobProtein) {
    console.warn('No current job to cancel');
    return;
  }

  const cancelBtn = document.getElementById('mini-cancel-btn');
  if (cancelBtn) cancelBtn.disabled = true;

  try {
    const response = await fetch(`/api/cancel/${encodeURIComponent(currentJobProtein)}`, {
      method: 'POST'
    });

    if (response.ok) {
      miniDone('<span style="color:#dc2626;">Job cancelled.</span>');
    } else {
      const data = await response.json();
      miniDone(`<span style="color:#dc2626;">Failed to cancel: ${data.error || 'Unknown error'}</span>`);
    }
  } catch (error) {
    console.error('Cancel request failed:', error);
    miniDone('<span style="color:#dc2626;">Failed to cancel job.</span>');
  } finally {
    if (cancelBtn) cancelBtn.disabled = false;
  }
}
async function pollUntilComplete(p, onUpdate) {
  for (; ;) {
    await new Promise(r => setTimeout(r, 4000));
    try {
      const r = await fetch(`/api/status/${encodeURIComponent(p)}`);
      if (!r.ok) { onUpdate && onUpdate({ text: `Waiting on ${p}…` }); continue; }
      const s = await r.json();
      if (s.status === 'complete') { onUpdate && onUpdate({ text: `Complete: ${p}`, current: 1, total: 1 }); break; }
      if (s.status === 'cancelled' || s.status === 'cancelling') {
        miniDone('<span style="color:#dc2626;">Job cancelled.</span>');
        throw new CancellationError('Job was cancelled by user');
      }
      const prog = s.progress || s;
      onUpdate && onUpdate({ current: prog.current, total: prog.total, text: prog.text || s.status || 'Processing' });
    } catch (e) {
      if (e instanceof CancellationError || e.name === 'CancellationError') throw e;
      onUpdate && onUpdate({ text: `Rechecking ${p}…` });
    }
  }
}

// === Pruned expansion (client prefers prune, falls back to full) ===
const PRUNE_KEEP = 20;  // (#2) client cap; backend will enforce its own hard cap

function getCurrentProteinNodes() {
  // Only main + interactors (omit function boxes) (#3)
  return nodes.filter(n => n.type === 'main' || n.type === 'interactor').map(n => n.id);
}

function findMainEdgePayload(targetId) {
  // Enrich pruning relevance when main ↔ target exists; otherwise omit (#3)
  const hit = links.find(l => l.type === 'interaction' && (
    ((l.source.id || l.source) === SNAP.main && (l.target.id || l.target) === targetId) ||
    ((l.source.id || l.source) === targetId && (l.target.id || l.target) === SNAP.main)
  ));
  if (!hit) return null;
  const L = hit.data || {};
  return {
    arrow: hit.arrow || L.arrow || '',
    intent: L.intent || hit.intent || '',
    direction: L.direction || hit.direction || '',
    support_summary: L.support_summary || ''
  };
}

async function pollPruned(jobId, onUpdate) {
  for (; ;) {
    await new Promise(r => setTimeout(r, 3000));
    try {
      const r = await fetch(`/api/expand/status/${encodeURIComponent(jobId)}`);
      if (!r.ok) throw new Error(`status ${r.status}`);
      const s = await r.json();
      if (s.status === 'complete') { onUpdate && onUpdate({ text: s.text || 'complete' }); break; }
      if (s.status === 'error') throw new Error(s.text || 'prune error');
      onUpdate && onUpdate({ text: s.text || s.status || 'processing' });
    } catch {
      onUpdate && onUpdate({ text: 'checking…' });
    }
  }
}

async function queueAndWaitFull(protein) {
  // (#6) Only label text changes, bar stays the same
  miniProgress('Initializing…', null, null, protein);
  const q = await fetch('/api/query', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ protein })
  });
  if (!q.ok) throw new Error('failed to queue full job');

  try {
    await pollUntilComplete(protein, ({ current, total, text }) =>
      miniProgress(text || 'Processing', current, total, protein)
    );
  } catch (e) {
    // Re-throw with proper error type
    if (e instanceof CancellationError || e.name === 'CancellationError') {
      throw new CancellationError(e.message);
    }
    throw e;
  }
}

async function tryPrunedExpand(interNode) {
  const payload = {
    parent: SNAP.main,                    // (#1) always the current root as parent
    protein: interNode.id,
    current_nodes: getCurrentProteinNodes(),
    parent_edge: findMainEdgePayload(interNode.id) || undefined,
    max_keep: PRUNE_KEEP                  // (#2) client-side cap
  };

  const resp = await fetch('/api/expand/pruned', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!resp.ok) throw new Error(`pruned request failed: ${resp.status}`);
  const j = await resp.json();
  const jobId = j.job_id;

  if (j.status === 'needs_full') {
    await queueAndWaitFull(interNode.id);
    return await tryPrunedExpand(interNode); // re-enter prune after full is built
  }

  if (j.status === 'queued' || j.status === 'processing') {
    // (#6) progress label: show "Pruning (relevance…)" and switch to "LLM" if backend reports it
    miniProgress('Pruning (relevance)…', null, null, interNode.id);
    await pollPruned(jobId, p => {
      const t = (p.text || '').toLowerCase();
      const label = t.includes('llm') ? 'Pruning (LLM)' : 'Pruning (relevance)';
      miniProgress(`${label}…`, null, null, interNode.id);
    });
  } else if (j.status !== 'complete') {
    throw new Error(`unexpected pruned status: ${j.status || 'unknown'}`);
  }

  const rr = await fetch(`/api/expand/results/${encodeURIComponent(jobId)}`);
  if (!rr.ok) throw new Error(`failed to load pruned results`);
  const pruned = await rr.json();
  await mergeSubgraph(pruned, interNode);
  miniDone(`<span>Added pruned subgraph for <b>${interNode.id}</b> (≤${PRUNE_KEEP}).</span>`);
}

// Current full-flow used as fallback
async function expandViaFullFlow(interNode) {
  const id = interNode.id;
  let res = await fetch(`/api/results/${encodeURIComponent(id)}`);
  if (res.ok) {
    const raw = await res.json();
    await mergeSubgraph(raw, interNode);
    miniDone(`<span>Added subgraph for <b>${id}</b>.</span>`);
    return;
  }
  if (res.status === 404) {
    try {
      await queueAndWaitFull(id);
    } catch (e) {
      // Re-throw cancellation errors
      if (e instanceof CancellationError || e.name === 'CancellationError') {
        throw e;
      }
      throw e;
    }
    const r2 = await fetch(`/api/results/${encodeURIComponent(id)}`);
    if (!r2.ok) { miniDone(`<span>No results for ${id} after job.</span>`); return; }
    const raw2 = await r2.json();
    await mergeSubgraph(raw2, interNode);
    miniDone(`<span>Added subgraph for <b>${id}</b>.</span>`);
    return;
  }
  miniDone(`<span>Error loading ${id}: ${res.status}</span>`);
}

/* ===== Expand-on-click with depth limit ===== */
const MAX_DEPTH = 3;
const depthMap = new Map();
const expanded = new Set();
// NOTE: depthMap is now populated in buildInitialGraph() for NEW format compatibility
// REMOVED: Legacy seedDepths() IIFE that only worked with SNAP.interactors (OLD format)

async function expandInteractor(interNode) {
  const id = interNode.id;
  const depth = depthMap.get(id) ?? 1;
  const msg = document.getElementById('notification-message');

  // Toggle collapse
  if (expanded.has(id)) {
    await collapseInteractor(id);
    if (msg) msg.innerHTML = `<span>Collapsed subgraph for <b>${id}</b>.</span>`;
    return;
  }
  if (depth >= MAX_DEPTH) {
    if (msg) msg.innerHTML = `<span>Depth limit (${MAX_DEPTH}) reached for ${id}.</span>`;
    return;
  }

  try {
    // Prefer pruned; clean fallback to full flow
    await tryPrunedExpand(interNode).catch(async (e) => {
      // Don't fallback if user cancelled
      if (e instanceof CancellationError || e.name === 'CancellationError') {
        throw e;  // Re-throw cancellation errors
      }
      console.warn('Pruned expand failed, falling back:', e);
      await expandViaFullFlow(interNode);
    });
  } catch (err) {
    // Don't show error message for cancellations
    if (err instanceof CancellationError || err.name === 'CancellationError') {
      return;  // Silent exit on cancellation
    }
    miniDone(`<span>Error expanding ${id}: ${err?.message || err}</span>`);
  }
}

async function mergeSubgraph(raw, clickedNode) {
  // NEW: Extract from new data structure
  const sub = (raw && raw.snapshot_json) ? raw.snapshot_json : raw;

  // NEW: Check for new data structure (proteins and interactions arrays)
  if (!sub || !Array.isArray(sub.proteins) || !Array.isArray(sub.interactions)) {
    console.error('❌ mergeSubgraph: Invalid data structure!');
    console.error('  Expected: { proteins: [...], interactions: [...] }');
    console.error('  Got:', sub);
    return;
  }

  // Determine cluster position for the expansion
  // Calculate ONCE and store for later cluster creation
  let newClusterPos = null;
  let centerX, centerY;

  if (clusters.has(clickedNode.id)) {
    // Cluster already exists, use its position
    const cluster = clusters.get(clickedNode.id);
    centerX = cluster.centerPos.x;
    centerY = cluster.centerPos.y;
  } else {
    // New cluster - calculate position now, create cluster later
    // Pass interactor count for dynamic spacing
    const interactorCount = sub.proteins.length - 1; // Exclude the clicked protein itself
    newClusterPos = getNextClusterPosition(interactorCount);
    centerX = newClusterPos.x;
    centerY = newClusterPos.y;
  }

  const nodeIds = new Set(nodes.map(n => n.id));
  const linkIds = new Set(links.map(l => l.id));
  const parentDepth = depthMap.get(clickedNode.id) ?? 1;
  const childDepth = Math.min(MAX_DEPTH, parentDepth + 1);

  const regNodes = new Set();
  const regLinks = new Set();

  // NEW: Add protein nodes (exclude clicked node if already exists)
  const newProteins = sub.proteins.filter(p => p !== clickedNode.id && !nodeIds.has(p));

  // Calculate cluster radius for positioning (use existing cluster if available, or calculate new one)
  let clusterRadius;
  if (clusters.has(clickedNode.id)) {
    clusterRadius = clusters.get(clickedNode.id).radius;
  } else {
    // Calculate radius for new cluster based on protein count
    clusterRadius = calculateClusterRadius(newProteins.length);
  }

  newProteins.forEach((protein, idx) => {
    // Position nodes in a small circle within the cluster
    const angle = (2 * Math.PI * idx) / Math.max(1, newProteins.length) - Math.PI / 2;
    const radius = clusterRadius * 0.6; // Position within cluster bounds (60% of calculated radius)
    const x = centerX + Math.cos(angle) * radius;
    const y = centerY + Math.sin(angle) * radius;

    // Create new protein node
    nodes.push({
      id: protein,
      label: protein,
      type: 'interactor',
      radius: interactorNodeRadius,
      x: x,
      y: y,
      _isChildOf: clickedNode.id  // Tag as child for shell-based layout
    });

    nodeIds.add(protein);
    depthMap.set(protein, childDepth);

    // Track for expansion registry (for collapse)
    if (!baseNodes || !baseNodes.has(protein)) {
      if (!regNodes.has(protein)) {
        refCounts.set(protein, (refCounts.get(protein) || 0) + 1);
        regNodes.add(protein);
      }
    }
  });

  // NEW: Add interaction links (all types: direct, shared, cross_link)
  sub.interactions.forEach(interaction => {
    const source = interaction.source;
    const target = interaction.target;

    if (!source || !target) {
      console.warn('mergeSubgraph: Interaction missing source/target', interaction);
      return;
    }

    // Determine arrow type
    const arrow = arrowKind(
      interaction.arrow || 'binds',
      interaction.intent || 'binding',
      interaction.direction || 'main_to_primary'
    );

    // Create link ID with arrow type (to allow parallel links with different arrows)
    const linkId = `${source}-${target}-${arrow}`;
    const reverseLinkId = `${target}-${source}-${arrow}`;

    // Skip if link already exists in base graph
    const inBase = (baseLinks && (baseLinks.has(linkId) || baseLinks.has(reverseLinkId)));
    if (inBase) {
      return;
    }

    // Skip if link already added in this merge
    if (linkIds.has(linkId)) {
      return;
    }

    // Check if reverse exists
    const reverseExists = linkIds.has(reverseLinkId);

    // Determine if bidirectional
    const isBidirectional = isBiDir(interaction.direction) || reverseExists;

    // Create link
    const link = {
      id: linkId,
      source: source,
      target: target,
      type: 'interaction',
      interactionType: interaction.type || 'direct',
      arrow: arrow,
      intent: interaction.intent || 'binding',
      direction: interaction.direction || 'main_to_primary',
      data: interaction,
      isBidirectional: isBidirectional,
      linkOffset: reverseExists ? 1 : 0,
      showBidirectionalMarkers: isBidirectional,
      confidence: interaction.confidence || 0.5,

      // PERFORMANCE: Cache constant values to avoid recalculation in every tick
      _sourceRadius: null,  // Will be set after D3 binds node objects
      _targetRadius: null,  // Will be set after D3 binds node objects
      _isShared: (interaction.type === 'shared' || interaction.interactionType === 'shared'),
      _needsCurve: isBidirectional || (interaction.type === 'shared') || (interaction.interactionType === 'shared')
    };

    links.push(link);
    linkIds.add(linkId);

    // Track for expansion registry (for collapse)
    if (!baseLinks || !baseLinks.has(linkId)) {
      if (!regLinks.has(linkId)) {
        refCounts.set(linkId, (refCounts.get(linkId) || 0) + 1);
        regLinks.add(linkId);
      }
    }
  });

  // Create new cluster for the expanded protein if needed
  if (!clusters.has(clickedNode.id) && newClusterPos) {
    // Remove clicked node from its old cluster
    const oldClusterId = getNodeCluster(clickedNode.id);
    if (oldClusterId) {
      const oldCluster = clusters.get(oldClusterId);
      if (oldCluster) {
        oldCluster.members.delete(clickedNode.id);
        // PERFORMANCE: Update reverse cluster lookup map
        nodeToClusterMap.delete(clickedNode.id);
      }
    }

    // Create new cluster and move the clicked node to it
    createCluster(clickedNode.id, newClusterPos, newProteins.length);
  } else if (!newClusterPos && !clusters.has(clickedNode.id)) {
    console.error(`ERROR: newClusterPos is null/undefined for ${clickedNode.id}`);
  }

  // ALWAYS add new proteins to the cluster (whether newly created or pre-existing)
  // CRITICAL FIX: This was inside the conditional above, causing drag issues on re-expansion
  const targetCluster = clusters.get(clickedNode.id);

  if (targetCluster && newProteins.length > 0) {
    // Add all new proteins to the expanded cluster
    newProteins.forEach(protein => {
      addNodeToCluster(clickedNode.id, protein);
    });

    // Mark intra-cluster links
    sub.interactions.forEach(interaction => {
      const source = interaction.source;
      const target = interaction.target;
      const arrow = arrowKind(interaction.arrow || 'binds', interaction.intent || 'binding', interaction.direction || 'main_to_primary');
      const linkId = `${source}-${target}-${arrow}`;

      // If both nodes are in the cluster, it's an intra-cluster link
      if (targetCluster.members.has(source) && targetCluster.members.has(target)) {
        targetCluster.localLinks.add(linkId);
      }
    });

    // CRITICAL FIX: Ensure all cluster member positions are valid and synced
    // This prevents drag issues where member positions might not be initialized yet
    let validPosCount = 0;
    let invalidPosCount = 0;
    const clusterCenterX = centerX; // Use the centerX/centerY calculated earlier
    const clusterCenterY = centerY;

    targetCluster.members.forEach(memberId => {
      const member = nodeMap.get(memberId); // PERFORMANCE: O(1) lookup
      if (member) {
        if (Number.isFinite(member.x) && Number.isFinite(member.y) &&
          member.x !== 0 && member.y !== 0) {
          validPosCount++;
        } else {
          invalidPosCount++;
          // If position is invalid, set it to cluster center + small offset
          const offset = Math.random() * 50 - 25;
          member.x = clusterCenterX + offset;
          member.y = clusterCenterY + offset;
          console.warn(`Fixed invalid position for ${memberId}: set to (${member.x}, ${member.y})`);
        }
      }
    });

    // PERFORMANCE: Console logs commented out to improve rendering speed
    // console.log(`\n✅ CLUSTER UPDATE COMPLETE for ${clickedNode.id}:`);
    // console.log(`  - Position: (${clusterCenterX}, ${clusterCenterY})`);
    // console.log(`  - Members (${targetCluster.members.size}):`, Array.from(targetCluster.members));
    // console.log(`  - New proteins added: ${newProteins.join(', ')}`);
    // console.log(`  - Center node position: (${clickedNode.x}, ${clickedNode.y}), fixed: (${clickedNode.fx}, ${clickedNode.fy})`);
    // console.log(`  - Member positions: ${validPosCount} valid, ${invalidPosCount} fixed`);
    // console.log(`  - Cluster in map:`, clusters.has(clickedNode.id));
    // console.log(`  - Total clusters:`, clusters.size);
    // console.log(`  - All cluster keys:`, Array.from(clusters.keys()));
  } else if (!targetCluster) {
    console.error(`❌ CLUSTER ERROR: No cluster found for ${clickedNode.id} after creation attempt!`);
  } else if (newProteins.length === 0) {
    console.warn(`⚠️ WARNING: No new proteins to add to cluster ${clickedNode.id}`);
  }

  // Mark expansion as complete
  expanded.add(clickedNode.id);
  expansionRegistry.set(clickedNode.id, { nodes: regNodes, links: regLinks });

  // Reposition indirect interactors near their upstream interactors (hybrid layout)
  // Group newly added indirect nodes by upstream
  const newIndirectGroups = new Map();

  // PERFORMANCE: Build link lookup map to avoid O(N×M) nested loop
  const linksByTarget = new Map();
  links.forEach(link => {
    const target = (link.target && link.target.id) ? link.target.id : link.target;
    if (!linksByTarget.has(target)) {
      linksByTarget.set(target, []);
    }
    linksByTarget.get(target).push(link);
  });

  // Now iterate nodes once and look up links in O(1)
  nodes.forEach(node => {
    if (regNodes.has(node.id) && node.type === 'interactor') {
      // Check if this newly added node is an indirect interactor - PERFORMANCE: O(1) lookup
      const nodeLinks = linksByTarget.get(node.id) || [];
      const link = nodeLinks.find(l =>
        l?.data?.interaction_type === 'indirect' && l?.data?.upstream_interactor
      );

      if (link) {
        const upstream = link.data.upstream_interactor;
        if (!newIndirectGroups.has(upstream)) {
          newIndirectGroups.set(upstream, []);
        }
        newIndirectGroups.get(upstream).push(node);

        // Copy upstream info to node for force simulation
        node.upstream_interactor = upstream;
        node.interaction_type = 'indirect';
      }
    }
  });

  // Position each group around its upstream node
  newIndirectGroups.forEach((indirectNodes, upstreamId) => {
    const upstreamNode = nodeMap.get(upstreamId); // PERFORMANCE: O(1) lookup

    if (!upstreamNode) {
      console.warn(`mergeSubgraph: Upstream node ${upstreamId} not found`);
      return;
    }

    // Position in small orbital ring around upstream
    const orbitalRadius = 200;
    indirectNodes.forEach((node, idx) => {
      const angle = (2 * Math.PI * idx) / Math.max(indirectNodes.length, 1);
      node.x = upstreamNode.x + Math.cos(angle) * orbitalRadius;
      node.y = upstreamNode.y + Math.sin(angle) * orbitalRadius;
      delete node.fx;
      delete node.fy;
    });
  });

  // PERFORMANCE: Rebuild node lookup map after adding new nodes
  rebuildNodeMap();

  // Update graph with smooth transitions
  updateGraphWithTransitions();
}

// --- collapse helper: remove one expansion safely ---
async function collapseInteractor(ownerId) {
  const reg = expansionRegistry.get(ownerId);
  if (!reg) { expanded.delete(ownerId); return; }

  // Remove links first
  const toRemoveLinks = [];
  reg.links.forEach(lid => {
    if (baseLinks && baseLinks.has(lid)) return; // never remove base
    const c = (refCounts.get(lid) || 0) - 1;
    if (c <= 0) { refCounts.delete(lid); toRemoveLinks.push(lid); }
    else { refCounts.set(lid, c); }
  });
  if (toRemoveLinks.length) {
    links = links.filter(l => !toRemoveLinks.includes(l.id));
  }

  // Remove nodes (only if no remaining incident links)
  const toRemoveNodes = [];
  reg.nodes.forEach(nid => {
    if (baseNodes && baseNodes.has(nid)) return;
    const c = (refCounts.get(nid) || 0) - 1;
    if (c <= 0) {
      const stillUsed = links.some(l => ((l.source.id || l.source) === nid) || ((l.target.id || l.target) === nid));
      if (!stillUsed) { refCounts.delete(nid); toRemoveNodes.push(nid); }
      else { refCounts.set(nid, 0); }
    } else {
      refCounts.set(nid, c);
    }
  });
  if (toRemoveNodes.length) {
    nodes = nodes.filter(n => !toRemoveNodes.includes(n.id));
  }

  // Remove cluster if it was created for this expansion
  if (clusters.has(ownerId)) {
    // Before deleting, move the owner node back to root cluster
    const ownerNode = nodeMap.get(ownerId); // PERFORMANCE: O(1) lookup
    if (ownerNode) {
      // Release fixed position so it can move
      ownerNode.fx = null;
      ownerNode.fy = null;

      // Find the main cluster (root cluster) - PERFORMANCE: Use cached reference
      const mainNode = cachedMainNode;
      if (mainNode && clusters.has(mainNode.id)) {
        const rootCluster = clusters.get(mainNode.id);
        rootCluster.members.add(ownerId);
        // PERFORMANCE: Update reverse cluster lookup map
        nodeToClusterMap.set(ownerId, mainNode.id);

        // Position it near the root cluster center for smooth transition
        const rootPos = rootCluster.centerPos;
        const angle = Math.random() * Math.PI * 2;
        const radius = rootCluster.radius * 0.7; // Use cluster's calculated radius
        ownerNode.x = rootPos.x + Math.cos(angle) * radius;
        ownerNode.y = rootPos.y + Math.sin(angle) * radius;
      }
    }

    // PERFORMANCE: Clean up reverse cluster lookup map for all members of deleted cluster
    const deletedCluster = clusters.get(ownerId);
    if (deletedCluster) {
      deletedCluster.members.forEach(memberId => {
        if (nodeToClusterMap.get(memberId) === ownerId) {
          nodeToClusterMap.delete(memberId);
        }
      });
    }
    clusters.delete(ownerId);
  }

  expansionRegistry.delete(ownerId);
  expanded.delete(ownerId);
  // PERFORMANCE: Rebuild node lookup map after removing nodes
  rebuildNodeMap();
  updateGraphWithTransitions();
}

/**
 * Updates graph with smooth D3 transitions (works with force simulation)
 */
function updateGraphWithTransitions() {
  // Initialize new nodes with orbital positions
  nodes.forEach(node => {
    if (!Number.isFinite(node.x) || !Number.isFinite(node.y)) {
      const pos = calculateOrbitalPosition(node);
      node.x = pos.x;
      node.y = pos.y;
    }
  });

  // Update links with transitions
  if (!linkGroup) {
    // First render - no transitions
    rebuild();
    return;
  }

  // LINK UPDATE PATTERN
  const linkData = linkGroup.data(links, d => d.id);

  // EXIT: Remove old links
  linkData.exit()
    .transition().duration(300)
    .style('opacity', 0)
    .remove();

  // UPDATE: Update existing links
  linkData
    .transition().duration(400)
    .attr('d', calculateLinkPath);

  // ENTER: Add new links
  const linkEnter = linkData.enter().append('path')
    .attr('class', d => {
      const arrow = d.arrow || 'binds';
      let classes = 'link';
      if (arrow === 'binds') classes += ' link-binding';
      else if (arrow === 'activates') classes += ' link-activate';
      else if (arrow === 'inhibits') classes += ' link-inhibit';
      else classes += ' link-binding';
      if (d.interaction_type === 'indirect') {
        classes += ' link-indirect';
      }
      if (d.interactionType === 'shared' || d.interactionType === 'cross_link') {
        classes += ' link-shared';
      }
      if (d._incomplete_pathway) {
        classes += ' link-incomplete';
      }
      return classes;
    })
    .attr('marker-start', d => {
      const dir = (d.direction || '').toLowerCase();
      // marker-start shows arrow at source end
      // Use for bidirectional (both ends) only
      if (dir === 'bidirectional') {
        const a = d.arrow || 'binds';
        if (a === 'activates') return 'url(#arrow-activate)';
        if (a === 'inhibits') return 'url(#arrow-inhibit)';
        return 'url(#arrow-binding)';
      }
      return null;
    })
    .attr('marker-end', d => {
      const dir = (d.direction || '').toLowerCase();
      // marker-end shows arrow at target end (default for all directed arrows)
      // Support both query-relative (main_to_primary) AND absolute (a_to_b) directions
      // Query-relative: main_to_primary, primary_to_main, bidirectional
      // Absolute: a_to_b, b_to_a (used for shared links and database storage)
      if (dir === 'main_to_primary' || dir === 'primary_to_main' || dir === 'bidirectional' ||
        dir === 'a_to_b' || dir === 'b_to_a') {
        const a = d.arrow || 'binds';
        if (a === 'activates') return 'url(#arrow-activate)';
        if (a === 'inhibits') return 'url(#arrow-inhibit)';
        return 'url(#arrow-binding)';
      }
      return null;
    })
    .attr('fill', 'none')
    .attr('d', calculateLinkPath)
    .style('opacity', 0)
    .on('mouseover', function () { d3.select(this).style('stroke-width', '3.5'); svg.style('cursor', 'pointer'); })
    .on('mouseout', function () { d3.select(this).style('stroke-width', null); svg.style('cursor', null); })
    .on('click', handleLinkClick);

  linkEnter.transition().duration(400).style('opacity', 1);

  // Merge enter + update
  linkGroup = linkEnter.merge(linkData);

  // PERFORMANCE: Initialize cached radii for new expansion links (D3 has now bound node objects)
  links.forEach(link => {
    if (!link._sourceRadius || !link._targetRadius) {
      const src = link.source;
      const tgt = link.target;
      if (typeof src === 'object' && typeof tgt === 'object') {
        link._sourceRadius = src.type === 'main' ? mainNodeRadius :
          (src.type === 'interactor' ? interactorNodeRadius : 0);
        link._targetRadius = tgt.type === 'main' ? mainNodeRadius :
          (tgt.type === 'interactor' ? interactorNodeRadius : 0);
      }
    }
  });

  // NODE UPDATE PATTERN
  const nodeData = nodeGroup.data(nodes, d => d.id);

  // EXIT: Remove old nodes
  nodeData.exit()
    .transition().duration(300)
    .style('opacity', 0)
    .remove();

  // UPDATE: Move existing nodes and update expanded state
  nodeData.each(function (d) {
    if (d.type === 'interactor') {
      // Update class and radius based on whether this node is now a cluster center
      const isExpanded = clusters.has(d.id);
      const nodeClass = isExpanded ? 'node expanded-node' : 'node interactor-node';
      const nodeRadius = isExpanded ? expandedNodeRadius : interactorNodeRadius;
      d3.select(this).select('circle')
        .attr('class', nodeClass)
        .attr('r', nodeRadius);
    }
  });
  nodeData
    .transition().duration(500)
    .attr('transform', d => `translate(${d.x},${d.y})`);

  // ENTER: Add new nodes
  const nodeEnter = nodeData.enter().append('g')
    .attr('class', 'node-group')
    .attr('transform', d => {
      // Start from parent position for smooth animation - PERFORMANCE: Search registry map instead of nodes array
      let parent = null;
      for (const [parentId, registry] of expansionRegistry.entries()) {
        if (registry && registry.nodes && registry.nodes.has(d.id)) {
          parent = nodeMap.get(parentId);
          break;
        }
      }
      if (parent && parent.x && parent.y) {
        return `translate(${parent.x},${parent.y})`;
      }
      return `translate(${d.x},${d.y})`;
    })
    .style('opacity', 0);

  nodeEnter.each(function (d) {
    const group = d3.select(this);
    if (d.type === 'main') {
      group.append('circle')
        .attr('class', 'node main-node')
        .attr('r', mainNodeRadius)
        .style('cursor', 'pointer')
        .on('click', (ev) => { ev.stopPropagation(); handleNodeClick(d); });
      group.append('text')
        .attr('class', 'node-label main-label')
        .attr('dy', 5)
        .style('font-size', '16px')
        .style('font-weight', '700')
        .text(d.label);
    } else if (d.type === 'interactor') {
      // Check if this interactor has been expanded (is a cluster center)
      const isExpanded = clusters.has(d.id);
      const nodeClass = isExpanded ? 'node expanded-node' : 'node interactor-node';
      group.append('circle')
        .attr('class', nodeClass)
        .attr('r', isExpanded ? expandedNodeRadius : interactorNodeRadius)
        .style('cursor', 'pointer')
        .on('click', (ev) => { ev.stopPropagation(); handleNodeClick(d); });
      group.append('text').attr('class', 'node-label').attr('dy', 5).text(d.label);
    }
  });

  // Animate new nodes to final position
  nodeEnter.transition().duration(500)
    .attr('transform', d => `translate(${d.x},${d.y})`)
    .style('opacity', 1);

  // Merge enter + update
  nodeGroup = nodeEnter.merge(nodeData);

  // Add drag handlers to new nodes
  nodeEnter.call(d3.drag()
    .on('start', dragstarted)
    .on('drag', dragged)
    .on('end', dragended));

  // Update simulation with new data
  if (simulation) {
    simulation.nodes(nodes);

    // Filter to only intra-cluster links for force
    const intraClusterLinks = links.filter(link => {
      const type = classifyLink(link);
      return type === 'intra-cluster';
    });

    simulation.force('link').links(intraClusterLinks);

    // Reheat simulation to settle new nodes
    if (nodeEnter.size() > 0) {
      reheatSimulation(0.3);
    }
  }

  // Update table view
  buildTableView();

  // After transitions complete, zoom to new nodes
  if (nodeEnter.size() > 0) {
    setTimeout(() => {
      focusOnNewNodes(nodeEnter.data());
    }, 600); // Wait for node animations to complete
  }
}

/**
 * Smoothly zooms camera to focus on newly added nodes
 * @param {array} newNodes - Array of newly added node data objects
 */
function focusOnNewNodes(newNodes) {
  if (!newNodes || newNodes.length === 0) return;

  // Calculate bounding box of new nodes
  const padding = 150;
  const xs = newNodes.map(n => n.x).filter(x => Number.isFinite(x));
  const ys = newNodes.map(n => n.y).filter(y => Number.isFinite(y));

  if (xs.length === 0 || ys.length === 0) return;

  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);

  // Calculate cluster dimensions
  const clusterWidth = Math.max(maxX - minX, 100); // Min 100px
  const clusterHeight = Math.max(maxY - minY, 100);
  const clusterCenterX = (minX + maxX) / 2;
  const clusterCenterY = (minY + maxY) / 2;

  // Calculate zoom scale to fit cluster with padding
  const viewWidth = width || 1000;
  const viewHeight = height || 800;
  const scaleX = (viewWidth - padding * 2) / clusterWidth;
  const scaleY = (viewHeight - padding * 2) / clusterHeight;
  const scale = Math.min(Math.max(scaleX, scaleY, 0.5), 2.0); // Clamp between 0.5x and 2x

  // Calculate translate to center the cluster
  const translateX = viewWidth / 2 - scale * clusterCenterX;
  const translateY = viewHeight / 2 - scale * clusterCenterY;

  // Apply smooth zoom transition
  const transform = d3.zoomIdentity
    .translate(translateX, translateY)
    .scale(scale);

  svg.transition()
    .duration(750)
    .ease(d3.easeCubicOut)
    .call(zoomBehavior.transform, transform);
}

/**
 * Full rebuild (used for initial render only)
 */
function rebuild() {
  // Clear existing visualization
  g.selectAll('*').remove();

  // Create force simulation with orbital constraints
  createSimulation();

  // Rebind interactor click handlers
  try {
    g.selectAll('.node-group').filter(d => d.type === 'interactor')
      .on('click', (ev, d) => { ev.stopPropagation(); handleNodeClick(d); });
  } catch (e) { }

  // Update table view when graph changes
  buildTableView();
}

/* Zoom controls */
function scheduleFitToView(delay = 450, animate = true) {
  if (fitToViewTimer) {
    clearTimeout(fitToViewTimer);
  }
  fitToViewTimer = setTimeout(() => {
    fitGraphToView(120, animate);
  }, Math.max(0, delay));
}

function fitGraphToView(padding = 120, animate = true) {
  if (!svg || !zoomBehavior) return;
  const container = document.getElementById('network');
  if (!container) return;

  const viewWidth = container.clientWidth || width || 0;
  const viewHeight = container.clientHeight || height || 0;
  if (viewWidth < 10 || viewHeight < 10) return;

  width = viewWidth;
  height = viewHeight;
  svg.attr('width', width).attr('height', height);

  const positioned = nodes.filter(n => Number.isFinite(n.x) && Number.isFinite(n.y));
  if (!positioned.length) return;

  const [minX, maxX] = d3.extent(positioned, d => d.x);
  const [minY, maxY] = d3.extent(positioned, d => d.y);
  if (!Number.isFinite(minX) || !Number.isFinite(maxX) || !Number.isFinite(minY) || !Number.isFinite(maxY)) return;

  const graphWidth = Math.max(maxX - minX, 1);
  const graphHeight = Math.max(maxY - minY, 1);
  const safePadding = Math.min(padding, Math.min(viewWidth, viewHeight) / 3);

  const scaleX = (viewWidth - safePadding * 2) / graphWidth;
  const scaleY = (viewHeight - safePadding * 2) / graphHeight;
  const targetScale = Math.max(0.35, Math.min(2.4, Math.min(scaleX, scaleY)));

  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;

  const translateX = (viewWidth / 2) - targetScale * centerX;
  const translateY = (viewHeight / 2) - targetScale * centerY;
  const transform = d3.zoomIdentity.translate(translateX, translateY).scale(targetScale);

  if (animate) {
    svg.transition().duration(500).ease(d3.easeCubicOut).call(zoomBehavior.transform, transform);
  } else {
    svg.call(zoomBehavior.transform, transform);
  }

  graphInitialFitDone = true;
}

function reheatSimulation(alpha = 0.65) {
  if (!simulation) return;
  const targetAlpha = Math.max(alpha, simulation.alpha());
  simulation.alpha(targetAlpha).alphaTarget(0);
  simulation.restart();
}

function zoomIn() {
  if (!svg || !zoomBehavior) return;
  svg.transition().duration(250).ease(d3.easeCubicOut).call(zoomBehavior.scaleBy, 1.2);
}
function zoomOut() {
  if (!svg || !zoomBehavior) return;
  svg.transition().duration(250).ease(d3.easeCubicOut).call(zoomBehavior.scaleBy, 0.8);
}
function resetView() {
  if (!svg || !zoomBehavior) return;
  nodes.forEach(node => {
    if (node.type === 'main') {
      node.fx = width / 2;
      node.fy = height / 2;
    } else {
      node.fx = null;
      node.fy = null;
    }
  });
  reheatSimulation(0.7);
  scheduleFitToView(360, true);
}

function toggleTheme() {
  document.body.classList.toggle('dark-mode');
  const isDark = document.body.classList.contains('dark-mode');
  const icon = document.getElementById('theme-icon');
  if (icon) {
    icon.textContent = isDark ? '☀️' : '🌙';
  }
  localStorage.setItem('theme', isDark ? 'dark' : 'light');
}

/* ===== Graph Filters ===== */
let graphActiveFilters = new Set(['activates', 'inhibits', 'binds', 'regulates']);
let graphActiveDepths = new Set([0, 1, 2, 3]); // All depths visible by default (0=main, 1=direct, 2=indirect, 3=tertiary)

function toggleGraphFilter(filterType) {
  if (graphActiveFilters.has(filterType)) {
    graphActiveFilters.delete(filterType);
  } else {
    graphActiveFilters.add(filterType);
  }

  // Update button visual state
  const btn = document.querySelector(`.graph-filter-btn.${filterType}`);
  if (btn) {
    btn.classList.toggle('active');
  }

  // Update graph visibility
  applyGraphFilters();
}

function toggleDepthFilter(depth) {
  // Never allow hiding depth 0 (main protein)
  if (depth === 0) return;

  if (graphActiveDepths.has(depth)) {
    graphActiveDepths.delete(depth);
  } else {
    graphActiveDepths.add(depth);
  }

  // Update button visual state
  const btn = document.querySelector(`.depth-filter[data-depth="${depth}"]`);
  if (btn) {
    btn.classList.toggle('active');
  }

  // Update graph visibility
  applyGraphFilters();
}

function refreshVisualization() {
  // MEMORY LEAK FIX: Stop existing simulation before clearing
  if (simulation) {
    simulation.stop();
    simulation.on('tick', null);
  }
  // Cancel any pending RAF for link updates
  if (linkUpdateRAF) {
    cancelAnimationFrame(linkUpdateRAF);
    linkUpdateRAF = null;
  }
  linkUpdatePending = false;

  // Clear existing SVG elements to prevent duplicate graphs
  if (g) g.selectAll('*').remove();

  // Clear clusters - PERFORMANCE: Also clear reverse lookup map
  clusters.clear();
  nodeToClusterMap.clear();
  nextClusterAngle = 0;

  // Rebuild the graph from current data (buildInitialGraph already clears nodes/links)
  if (typeof buildInitialGraph === 'function') {
    buildInitialGraph();

    // Reset base graph tracking
    baseNodes = new Set(nodes.map(n => n.id));
    baseLinks = new Set(links.map(l => l.id));
    // PERFORMANCE: Cache main node reference for O(1) lookup in calculateLinkPath
    cachedMainNode = nodes.find(n => n.type === 'main');
    // PERFORMANCE: Build node lookup map for O(1) access
    rebuildNodeMap();

    // Recreate force simulation
    createSimulation();

    // Reset expansion tracking
    expansionRegistry.clear();
    expanded.clear();
    refCounts.clear();
  }
}

function applyGraphFilters() {
  if (!g) return;

  // Update link visibility and opacity
  g.selectAll('path.link').each(function (d) {
    const link = d3.select(this);
    const arrow = d.arrow || 'binds';

    if (d.type === 'interaction') {
      // Check both arrow type and depth filters - PERFORMANCE: O(1) lookup
      const targetId = d.target?.id || d.target;
      const sourceId = d.source?.id || d.source;
      const targetNode = typeof targetId === 'string' ? nodeMap.get(targetId) : d.target;
      const sourceNode = typeof sourceId === 'string' ? nodeMap.get(sourceId) : d.source;
      const maxDepth = Math.max(
        depthMap.get(targetNode?.id || '') || 0,
        depthMap.get(sourceNode?.id || '') || 0
      );

      const arrowMatch = graphActiveFilters.has(arrow);
      const depthMatch = graphActiveDepths.has(maxDepth);
      const shouldShow = arrowMatch && depthMatch;

      link.style('display', shouldShow ? null : 'none');
      link.style('opacity', shouldShow ? 0.7 : 0);
    }
  });

  // Update node visibility - hide interactors if all their interactions are filtered out OR depth filtered
  g.selectAll('g.node-group').each(function (d) {
    const nodeGroup = d3.select(this);

    // Main protein is always visible
    if (d.type === 'main') {
      nodeGroup.style('opacity', 1);
      nodeGroup.style('pointer-events', 'all');
      return;
    }

    if (d.type === 'interactor') {
      const nodeDepth = depthMap.get(d.id) || 0;
      const depthVisible = graphActiveDepths.has(nodeDepth);

      // Check if any links to this interactor are visible
      const hasVisibleLink = depthVisible && links.some(l => {
        if (l.type !== 'interaction') return false;
        const targetId = (l.target && l.target.id) ? l.target.id : l.target;
        const sourceId = (l.source && l.source.id) ? l.source.id : l.source;
        const isConnected = targetId === d.id || sourceId === d.id;
        const arrow = l.arrow || 'binds';

        // Check if the link itself passes depth filter - PERFORMANCE: O(1) lookup
        const linkTargetNode = typeof targetId === 'string' ? nodeMap.get(targetId) : l.target;
        const linkSourceNode = typeof sourceId === 'string' ? nodeMap.get(sourceId) : l.source;
        const linkMaxDepth = Math.max(
          depthMap.get(linkTargetNode?.id || '') || 0,
          depthMap.get(linkSourceNode?.id || '') || 0
        );

        return isConnected && graphActiveFilters.has(arrow) && graphActiveDepths.has(linkMaxDepth);
      });

      nodeGroup.style('opacity', hasVisibleLink ? 1 : 0.2);
      nodeGroup.style('pointer-events', hasVisibleLink ? 'all' : 'none');
    }
  });
}

/* ===== Table View ===== */
// Search and filter state
let searchQuery = '';
let activeFilters = new Set(['activates', 'inhibits', 'binds', 'regulates']);
let searchDebounceTimer = null;

function switchView(viewName) {
  const graphView = document.getElementById('network');
  const tableView = document.getElementById('table-view');
  const chatView = document.getElementById('chat-view');
  const cardView = document.getElementById('card-view'); // NEW
  const tabs = document.querySelectorAll('.tab-btn');
  const header = document.querySelector('.header');
  const container = document.querySelector('.container');

  // Hide all views first
  if (graphView) graphView.style.display = 'none';
  if (tableView) tableView.style.display = 'none';
  if (chatView) chatView.style.display = 'none';
  if (cardView) cardView.style.display = 'none'; // NEW

  // Remove active from all tabs
  tabs.forEach(tab => tab.classList.remove('active'));

  if (viewName === 'graph') {
    if (graphView) graphView.style.display = 'block';
    if (tabs[0]) tabs[0].classList.add('active');
    // Remove static class to restore auto-hide behavior
    if (header) header.classList.remove('header-static');
    // Enable graph view scroll behavior
    document.body.classList.remove('table-view-active');
    document.body.classList.add('graph-view-active');
    if (container) container.classList.add('graph-active');
    scheduleFitToView(180, true);
  } else if (viewName === 'table') {
    if (tableView) tableView.style.display = 'flex';
    if (tabs[1]) tabs[1].classList.add('active');
    if (typeof buildTableView === 'function') buildTableView(); // Rebuild on switch to ensure current state
    // Make header static (always visible) for table view
    if (header) header.classList.add('header-static');
    // Enable page scroll for table view
    document.body.classList.remove('graph-view-active');
    document.body.classList.add('table-view-active');
    if (container) container.classList.remove('graph-active');
    // Reset search and filters when switching to table view
    searchQuery = '';
    activeFilters = new Set(['activates', 'inhibits', 'binds', 'regulates']);
    const searchInput = document.getElementById('table-search');
    if (searchInput) searchInput.value = '';
    document.querySelectorAll('.filter-chip').forEach(chip => chip.classList.add('filter-active'));
    if (typeof applyFilters === 'function') applyFilters();
  } else if (viewName === 'chat') {
    if (chatView) chatView.style.display = 'block';
    if (tabs[2]) tabs[2].classList.add('active');
    // Use auto-hide header for chat view (same as graph view)
    if (header) header.classList.remove('header-static');
    // Enable page scroll for chat view
    document.body.classList.remove('graph-view-active');
    document.body.classList.add('table-view-active');
    if (container) container.classList.remove('graph-active');
    // Focus chat input when switching to chat view
    const chatInput = document.getElementById('chat-input');
    if (chatInput) {
      setTimeout(() => chatInput.focus(), 100);
    }
  } else if (viewName === 'card') { // NEW
    if (cardView) cardView.style.display = 'block';
    if (tabs[3]) tabs[3].classList.add('active');
    // Use auto-hide header for card view (like graph view)
    if (header) header.classList.remove('header-static');
    // Enable card view specific scrolling
    document.body.classList.remove('graph-view-active');
    document.body.classList.remove('table-view-active');
    document.body.classList.add('card-view-active');
    if (container) container.classList.remove('graph-active');

    // Render Card View
    if (typeof renderCardView === 'function') {
      renderCardView();
    }
  }
}

function handleSearchInput(event) {
  const query = event.target.value;
  const clearBtn = document.getElementById('search-clear-btn');

  // Show/hide clear button
  if (clearBtn) {
    clearBtn.style.display = query ? 'flex' : 'none';
  }

  // Debounce search
  clearTimeout(searchDebounceTimer);
  searchDebounceTimer = setTimeout(() => {
    searchQuery = query.toLowerCase().trim();
    applyFilters();
  }, 300);
}

function clearSearch() {
  const searchInput = document.getElementById('table-search');
  if (searchInput) {
    searchInput.value = '';
    searchQuery = '';
    const clearBtn = document.getElementById('search-clear-btn');
    if (clearBtn) clearBtn.style.display = 'none';
    applyFilters();
  }
}

function toggleFilter(filterType) {
  if (activeFilters.has(filterType)) {
    activeFilters.delete(filterType);
  } else {
    activeFilters.add(filterType);
  }

  // Update visual state
  const chip = document.querySelector(`.filter-chip.${filterType}`);
  if (chip) {
    chip.classList.toggle('filter-active');
  }

  applyFilters();
}

function applyFilters() {
  const tbody = document.getElementById('table-body');
  if (!tbody) return;

  const functionRows = tbody.querySelectorAll('tr.function-row');
  let visibleCount = 0;

  functionRows.forEach(row => {
    const arrow = row.dataset.arrow || 'binds';
    const searchText = row.dataset.search || '';

    const typeMatch = activeFilters.has(arrow);
    const searchMatch = !searchQuery || searchText.includes(searchQuery);

    const shouldShow = typeMatch && searchMatch;
    row.style.display = shouldShow ? '' : 'none';

    if (shouldShow) visibleCount++;
  });

  updateFilterResults(visibleCount, functionRows.length);
}

function updateFilterResults(visible, total) {
  const resultsDiv = document.getElementById('filter-results');
  if (!resultsDiv) return;

  if (visible === undefined) {
    resultsDiv.textContent = '';
    return;
  }

  if (total === 0) {
    resultsDiv.textContent = '';
    resultsDiv.style.color = '#6b7280';
    return;
  }

  if (visible === 0) {
    resultsDiv.textContent = 'No interactions match current filters';
    resultsDiv.style.color = '#dc2626';
  } else if (visible === total) {
    resultsDiv.textContent = '';
  } else {
    resultsDiv.textContent = `Showing ${visible} of ${total} interactions`;
    resultsDiv.style.color = '#6b7280';
  }
}

/* ===== View Mode Switching (NET vs DIRECT) ===== */
let currentInteractionMode = 'both';  // 'direct', 'net', 'both' - default to 'both' to show all interactions

/**
 * Switch between interaction view modes (DIRECT / NET / BOTH)
 */
function switchInteractionMode(mode) {
  if (!['direct', 'net', 'both'].includes(mode)) {
    console.error('Invalid interaction mode:', mode);
    return;
  }

  console.log(`Switching interaction mode: ${currentInteractionMode} → ${mode}`);
  currentInteractionMode = mode;

  // Update button active states
  document.querySelectorAll('.mode-btn').forEach(btn => btn.classList.remove('active'));
  const activeButton = document.getElementById(`mode-${mode}`);
  if (activeButton) {
    activeButton.classList.add('active');
  }

  // Save preference to localStorage
  try {
    localStorage.setItem('interaction_view_mode', mode);
  } catch (e) {
    console.warn('Could not save view mode to localStorage:', e);
  }

  // Rebuild graph with filtered interactions
  buildInitialGraph();

  // Restart simulation gently
  if (simulation) {
    simulation.alpha(0.3).restart();
  }

  // Rebuild table view if visible
  const tableView = document.getElementById('table-view');
  if (tableView && tableView.style.display !== 'none') {
    buildTableView();
  }

  // Update counter
  updateViewModeCounter();

  console.log(`View mode switched to: ${mode}`);
}

/**
 * Get current interaction view mode
 */
function getCurrentViewMode() {
  return currentInteractionMode;
}

/**
 * Update the view mode counter display
 */
function updateViewModeCounter() {
  const counterEl = document.getElementById('view-mode-counter');
  if (!counterEl) return;

  const mode = getCurrentViewMode();
  const totalInteractions = SNAP.interactions ? SNAP.interactions.length : 0;
  const visibleInteractions = links.length;

  if (visibleInteractions === totalInteractions) {
    counterEl.textContent = '';
  } else {
    const modeLabel = mode === 'direct' ? 'DIRECT' : mode === 'net' ? 'NET' : 'ALL';
    counterEl.textContent = `${modeLabel}: ${visibleInteractions} of ${totalInteractions}`;
    counterEl.style.fontSize = '12px';
    counterEl.style.color = '#6b7280';
    counterEl.style.marginLeft = '8px';
    counterEl.style.fontWeight = '500';
  }
}

/**
 * Initialize view mode from localStorage on page load
 */
function initializeViewMode() {
  try {
    const savedMode = localStorage.getItem('interaction_view_mode') || 'both';  // Default to 'both' (show all)
    if (['direct', 'net', 'both'].includes(savedMode)) {
      currentInteractionMode = savedMode;

      // Update button states
      document.querySelectorAll('.mode-btn').forEach(btn => btn.classList.remove('active'));
      const activeButton = document.getElementById(`mode-${savedMode}`);
      if (activeButton) {
        activeButton.classList.add('active');
      }

      console.log(`Initialized view mode: ${savedMode}`);
    }
  } catch (e) {
    console.warn('Could not load view mode from localStorage:', e);
  }
}

/* ===== Table Sorting ===== */
let currentSortColumn = null;
let currentSortDirection = null;

function sortTable(column) {
  const tbody = document.getElementById('table-body');
  if (!tbody) return;

  const rows = Array.from(tbody.querySelectorAll('tr.function-row'));

  // Toggle sort direction
  if (currentSortColumn === column) {
    if (currentSortDirection === 'asc') {
      currentSortDirection = 'desc';
    } else if (currentSortDirection === 'desc') {
      // Third click: reset to unsorted
      currentSortColumn = null;
      currentSortDirection = null;
    } else {
      currentSortDirection = 'asc';
    }
  } else {
    currentSortColumn = column;
    currentSortDirection = 'asc';
  }

  // Update header indicators
  document.querySelectorAll('.data-table th.sortable').forEach(th => {
    th.classList.remove('sort-asc', 'sort-desc');
  });

  if (currentSortColumn && currentSortDirection) {
    const header = document.querySelector(`.data-table th[data-sort="${column}"]`);
    if (header) {
      header.classList.add(`sort-${currentSortDirection}`);
    }

    // Sort rows
    rows.sort((a, b) => {
      let aVal, bVal;

      switch (column) {
        case 'interaction':
          aVal = (a.querySelector('.interaction-name')?.textContent || '').trim();
          bVal = (b.querySelector('.interaction-name')?.textContent || '').trim();
          break;
        case 'function':
          aVal = (a.querySelector('.col-function .function-name')?.textContent || '').trim();
          bVal = (b.querySelector('.col-function .function-name')?.textContent || '').trim();
          break;
        case 'effect':
          aVal = (a.querySelector('.col-effect .effect-badge')?.textContent || '').trim();
          bVal = (b.querySelector('.col-effect .effect-badge')?.textContent || '').trim();
          break;
        case 'effectType':
          aVal = (a.querySelector('.col-effect-type')?.textContent || '').trim();
          bVal = (b.querySelector('.col-effect-type')?.textContent || '').trim();
          break;
        case 'mechanism':
          aVal = (a.querySelector('.col-mechanism')?.textContent || '').trim();
          bVal = (b.querySelector('.col-mechanism')?.textContent || '').trim();
          break;
        default:
          return 0;
      }

      const comparison = aVal.localeCompare(bVal, undefined, { numeric: true, sensitivity: 'base' });
      return currentSortDirection === 'asc' ? comparison : -comparison;
    });
  }

  // Re-append rows in sorted order
  rows.forEach(row => {
    // Also move the corresponding expanded row if it exists
    const expandedRow = row.nextElementSibling;
    tbody.appendChild(row);
    if (expandedRow && expandedRow.classList.contains('expanded-row')) {
      tbody.appendChild(expandedRow);
    }
  });
}

/* ===== Column Resizing ===== */
let resizingColumn = null;
let startX = 0;
let startWidth = 0;

function initColumnResizing() {
  const table = document.getElementById('interactions-table');
  if (!table) return;

  const resizeHandles = table.querySelectorAll('.resize-handle');
  resizeHandles.forEach(handle => {
    handle.addEventListener('mousedown', startResize);
  });

  document.addEventListener('mousemove', doResize);
  document.addEventListener('mouseup', stopResize);
}

function startResize(e) {
  e.preventDefault();
  e.stopPropagation();

  resizingColumn = e.target.closest('th');
  if (!resizingColumn) return;

  startX = e.pageX;
  startWidth = resizingColumn.offsetWidth;

  document.body.style.cursor = 'col-resize';
  document.body.style.userSelect = 'none';
}

function doResize(e) {
  if (!resizingColumn) return;

  const diff = e.pageX - startX;
  const newWidth = Math.max(40, startWidth + diff);

  resizingColumn.style.width = newWidth + 'px';
  resizingColumn.style.minWidth = newWidth + 'px';
}

function stopResize() {
  if (resizingColumn) {
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    resizingColumn = null;
  }
}

/* ===== Row Expansion ===== */
function toggleRowExpansion(clickedRow) {
  const isExpanded = clickedRow.dataset.expanded === 'true';

  // Find any existing expanded row
  const nextRow = clickedRow.nextElementSibling;
  const isExpandedRow = nextRow && nextRow.classList.contains('expanded-row');

  if (isExpanded) {
    // Collapse
    clickedRow.dataset.expanded = 'false';
    if (isExpandedRow) {
      nextRow.classList.remove('show');
      setTimeout(() => nextRow.remove(), 300);
    }
  } else {
    // Expand
    clickedRow.dataset.expanded = 'true';

    // Get entry data from row
    const entry = getEntryDataFromRow(clickedRow);
    if (!entry) return;

    // Create expanded row
    const expandedRow = createExpandedRow(entry);
    clickedRow.insertAdjacentElement('afterend', expandedRow);

    // Trigger animation
    setTimeout(() => expandedRow.classList.add('show'), 10);
  }
}

function getEntryDataFromRow(row) {
  const cells = row.querySelectorAll('td');
  if (cells.length < 6) return null; // Changed from 7 to 6 (we now have 6 columns)

  // We need to reconstruct the entry data from the row
  // We'll find it from the original entries using the stored data attributes
  const entries = collectFunctionEntries();
  const arrow = row.dataset.arrow;
  const searchKey = row.dataset.search;

  // Find matching entry
  const entry = entries.find(e => e.arrow === arrow && e.searchKey === searchKey);
  return entry;
}

function createExpandedRow(entry) {
  const expandedRow = document.createElement('tr');
  expandedRow.className = 'expanded-row';

  const td = document.createElement('td');
  td.colSpan = 6; // Match number of columns (reduced from 7 to 6)

  const content = document.createElement('div');
  content.className = 'expanded-content';

  // Build the expanded content - CLEAN TWO-COLUMN LAYOUT
  let html = '';

  // SECTION 1: INTERACTION DETAILS
  html += '<div class="detail-section">';
  html += '<h3 class="detail-section-header">INTERACTION DETAILS</h3>';
  html += '<div class="detail-divider"></div>';
  html += '<dl class="detail-grid">';

  // Interaction
  html += '<dt class="detail-label">Interaction:</dt>';
  html += `<dd class="detail-value">
    <span class="detail-interaction">
      ${escapeHtml(entry.source || 'Unknown')}
      <span class="detail-arrow">→</span>
      ${escapeHtml(entry.target || 'Unknown')}
    </span>
  </dd>`;

  // Function
  html += '<dt class="detail-label">Function:</dt>';
  html += `<dd class="detail-value">${escapeHtml(entry.functionLabel || 'Not specified')}</dd>`;

  // Interaction Effect (on the downstream protein)
  const interactionArrowClass = entry.interactionArrow || entry.arrow || 'binds';
  html += '<dt class="detail-label">Interaction Effect:</dt>';
  html += `<dd class="detail-value">
    <span class="detail-effect detail-effect-${interactionArrowClass}">${escapeHtml(entry.interactionEffectBadgeText || entry.effectBadgeText || 'Not specified')}</span>
    <span style="margin-left: 8px; font-size: 0.875em; color: var(--color-text-secondary);">(on ${escapeHtml(entry.interactorLabel)})</span>
  </dd>`;

  // Function Effect (on this specific function)
  const functionArrowClass = entry.functionArrow || entry.arrow || 'binds';
  html += '<dt class="detail-label">Function Effect:</dt>';
  html += `<dd class="detail-value">
    <span class="function-effect function-effect-${functionArrowClass}">${escapeHtml(entry.functionEffectBadgeText || entry.effectBadgeText || 'Not specified')}</span>
    <span style="margin-left: 8px; font-size: 0.875em; color: var(--color-text-secondary);">(on ${escapeHtml(entry.functionLabel)})</span>
  </dd>`;

  // Effect Type
  html += '<dt class="detail-label">Effect Type:</dt>';
  if (entry.effectTypeDetails && entry.effectTypeDetails.text) {
    html += `<dd class="detail-value">${escapeHtml(entry.effectTypeDetails.text)}</dd>`;
  } else {
    html += '<dd class="detail-value detail-empty">Not specified</dd>';
  }

  // Mechanism
  html += '<dt class="detail-label">Mechanism:</dt>';
  if (entry.mechanismText) {
    html += `<dd class="detail-value">${escapeHtml(entry.mechanismText)}</dd>`;
  } else {
    html += '<dd class="detail-value detail-empty">Not specified</dd>';
  }

  html += '</dl>';
  html += '</div>'; // end section

  // SECTION 2: CELLULAR CONTEXT
  html += '<div class="detail-section">';
  html += '<h3 class="detail-section-header">CELLULAR CONTEXT</h3>';
  html += '<div class="detail-divider"></div>';
  html += '<dl class="detail-grid">';

  // Cellular Process
  html += '<dt class="detail-label">Process:</dt>';
  if (entry.cellularProcess) {
    html += `<dd class="detail-value">${escapeHtml(entry.cellularProcess)}</dd>`;
  } else {
    html += '<dd class="detail-value detail-empty">Not specified</dd>';
  }

  // Specific Effects
  html += '<dt class="detail-label">Specific Effects:</dt>';
  if (entry.specificEffects && entry.specificEffects.length > 0) {
    html += '<dd class="detail-value"><ul class="detail-list">';
    entry.specificEffects.forEach(effect => {
      html += `<li>${escapeHtml(effect)}</li>`;
    });
    html += '</ul></dd>';
  } else {
    html += '<dd class="detail-value detail-empty">Not specified</dd>';
  }

  // Biological Cascade
  html += '<dt class="detail-label">Biological Cascade:</dt>';
  if (entry.biologicalCascade && entry.biologicalCascade.length > 0) {
    // Normalize: flatten all segments and split by arrow (→)
    const allSteps = [];
    entry.biologicalCascade.forEach(segment => {
      const text = (segment == null ? '' : segment).toString().trim();
      if (!text) return;
      const steps = text.split('→').map(s => s.trim()).filter(s => s.length > 0);
      allSteps.push(...steps);
    });

    if (allSteps.length > 0) {
      html += '<dd class="detail-value"><ol class="detail-list detail-list-ordered">';
      allSteps.forEach(step => {
        html += `<li>${escapeHtml(step)}</li>`;
      });
      html += '</ol></dd>';
    } else {
      html += '<dd class="detail-value detail-empty">Not specified</dd>';
    }
  } else {
    html += '<dd class="detail-value detail-empty">Not specified</dd>';
  }

  html += '</dl>';
  html += '</div>'; // end section

  // SECTION 3: EVIDENCE
  html += '<div class="detail-section">';
  html += '<h3 class="detail-section-header">EVIDENCE & PUBLICATIONS</h3>';
  html += '<div class="detail-divider"></div>';
  if (entry.evidence && entry.evidence.length > 0) {
    html += '<div class="expanded-evidence-list">';
    entry.evidence.forEach((ev, evIndex) => {
      // Determine primary link (PMID preferred, then DOI)
      const primaryLink = ev.pmid
        ? `https://pubmed.ncbi.nlm.nih.gov/${escapeHtml(ev.pmid)}`
        : (ev.doi ? `https://doi.org/${escapeHtml(ev.doi)}` : null);

      // Simplified: Remove wrapper, keep card only
      html += `<div class="expanded-evidence-card" data-evidence-link="${primaryLink || ''}" data-has-link="${primaryLink ? 'true' : 'false'}">`;

      // Title
      const title = ev.paper_title || 'Untitled Publication';
      html += `<div class="expanded-evidence-title">${escapeHtml(title)}</div>`;

      // Meta information
      html += '<div class="expanded-evidence-meta">';
      if (ev.authors) {
        html += `<div class="expanded-evidence-meta-item"><strong>Authors:</strong> ${escapeHtml(ev.authors)}</div>`;
      }
      if (ev.journal) {
        html += `<div class="expanded-evidence-meta-item"><strong>Journal:</strong> ${escapeHtml(ev.journal)}</div>`;
      }
      if (ev.year) {
        html += `<div class="expanded-evidence-meta-item"><strong>Year:</strong> ${escapeHtml(ev.year)}</div>`;
      }
      if (ev.assay) {
        html += `<div class="expanded-evidence-meta-item"><strong>Assay:</strong> ${escapeHtml(ev.assay)}</div>`;
      }
      if (ev.species) {
        html += `<div class="expanded-evidence-meta-item"><strong>Species:</strong> ${escapeHtml(ev.species)}</div>`;
      }
      html += '</div>';

      // Quote
      if (ev.relevant_quote) {
        html += `<div class="expanded-evidence-quote">${escapeHtml(ev.relevant_quote)}</div>`;
      }

      // PMIDs and DOI
      html += '<div class="expanded-evidence-pmids">';
      if (ev.pmid) {
        html += `<a href="https://pubmed.ncbi.nlm.nih.gov/${escapeHtml(ev.pmid)}" target="_blank" class="expanded-pmid-badge" onclick="event.stopPropagation();">PMID: ${escapeHtml(ev.pmid)}</a>`;
      }
      if (ev.doi) {
        html += `<a href="https://doi.org/${escapeHtml(ev.doi)}" target="_blank" class="expanded-pmid-badge" onclick="event.stopPropagation();">DOI: ${escapeHtml(ev.doi)}</a>`;
      }
      html += '</div>';

      html += '</div>'; // end evidence-card
    });
    html += '</div>';
  } else if (entry.fnData && entry.fnData.pmids && entry.fnData.pmids.length > 0) {
    // Show PMIDs even if no full evidence
    html += '<div class="expanded-evidence-pmids">';
    entry.fnData.pmids.forEach(pmid => {
      html += `<a href="https://pubmed.ncbi.nlm.nih.gov/${escapeHtml(pmid)}" target="_blank" class="expanded-pmid-badge">PMID: ${escapeHtml(pmid)}</a>`;
    });
    html += '</div>';
  } else {
    html += '<p class="detail-empty" style="margin-top: 0;">No evidence provided</p>';
  }
  html += '</div>'; // end section

  content.innerHTML = html;
  td.appendChild(content);
  expandedRow.appendChild(td);

  // Add click handlers to evidence cards after DOM insertion
  setTimeout(() => {
    const evidenceCards = content.querySelectorAll('.expanded-evidence-card[data-has-link="true"]');
    evidenceCards.forEach(card => {
      card.addEventListener('click', (e) => {
        // Don't trigger if clicking on the badge links (they have stopPropagation)
        const link = card.dataset.evidenceLink;
        if (link) {
          window.open(link, '_blank');
        }
      });
    });
  }, 50);

  return expandedRow;
}

function buildTableView() {
  const tbody = document.getElementById('table-body');
  if (!tbody) return;

  tbody.innerHTML = '';

  const entries = collectFunctionEntries();

  entries.forEach(entry => {
    const row = document.createElement('tr');
    row.className = 'function-row';
    row.dataset.arrow = entry.arrow;
    row.dataset.search = entry.searchKey;
    row.dataset.expanded = 'false';

    const displaySource = entry.source || '—';
    const displayTarget = entry.target || '—';

    // Determine direction arrow symbol and color class
    // Support both query-relative AND absolute directions
    const direction = entry.direction || 'main_to_primary';
    let arrowSymbol = '↔';
    if (direction === 'main_to_primary' || direction === 'a_to_b' || direction.includes('to_primary')) arrowSymbol = '→';
    else if (direction === 'primary_to_main' || direction === 'b_to_a' || direction.includes('to_main')) arrowSymbol = '←';

    const arrowColorClass = `interaction-arrow-${entry.arrow}`;

    // Clean mechanism text (no wrapper)
    const mechanismHtml = entry.mechanismText
      ? `<span class="mechanism-text">${escapeHtml(entry.mechanismText.toUpperCase())}</span>`
      : '<span class="muted-text">Not specified</span>';

    // Clean effect type text (no wrapper)
    const effectTypeHtml = entry.effectTypeDetails && entry.effectTypeDetails.text
      ? `<span class="effect-type-text">${escapeHtml(entry.effectTypeDetails.text)}</span>`
      : '<span class="muted-text">Not specified</span>';

    row.innerHTML = `
      <td class="col-expand"><span class="expand-icon">▼</span></td>
      <td class="col-interaction">
        <div class="interaction-cell">
          <span class="interaction-text">
            ${escapeHtml(displaySource)}
            <span class="interaction-arrow ${arrowColorClass}">${arrowSymbol}</span>
            ${escapeHtml(displayTarget)}
          </span>
          <div class="interaction-subtitle">${escapeHtml(entry.interactorLabel)}</div>
        </div>
      </td>
      <td class="col-effect">
        <div style="display: flex; flex-direction: column; gap: 4px;">
          <span class="effect-text effect-text-${entry.interactionArrow}" style="font-size: 10px;" title="Interaction effect (on protein)">${escapeHtml(entry.interactionEffectBadgeText)}</span>
          <span class="function-effect-text function-effect-text-${entry.functionArrow}" style="font-size: 10px;" title="Function effect">${escapeHtml(entry.functionEffectBadgeText)}</span>
        </div>
      </td>
      <td class="col-function">
        <span class="function-text">${escapeHtml(entry.functionLabel)}</span>
      </td>
      <td class="col-effect-type">${effectTypeHtml}</td>
      <td class="col-mechanism">${mechanismHtml}</td>
    `;

    // Add click handler for row expansion
    row.addEventListener('click', (e) => {
      // Don't toggle if clicking on a link
      if (e.target.tagName === 'A' || e.target.closest('a')) {
        return;
      }
      // Toggle expansion for any other click on the row
      toggleRowExpansion(row);
    });

    tbody.appendChild(row);
  });

  applyFilters();
}

function collectFunctionEntries() {
  const entries = [];

  // Helper to safely extract node ID from D3 node object or string
  function getNodeId(node) {
    if (!node) return '';
    if (typeof node === 'string') return node;
    return node.id || '';
  }

  // Include both standard interactions AND pathway-interactor links
  // This ensures table view works in both standard and pathway modes
  const interactionLinks = links.filter(l =>
    l.type === 'interaction' || l.type === 'pathway-interactor-link'
  );

  if (!SNAP.main) {
    console.warn('collectFunctionEntries: No main protein');
    return entries;
  }

  // Loop through interaction links, then their functions
  interactionLinks.forEach(link => {
    // Safe property accessor: expanded links store data in link.data, initial links store directly
    const L = link.data || link;

    // Extract source/target IDs using robust helper
    const source = L.semanticSource || getNodeId(link.source);
    const target = L.semanticTarget || getNodeId(link.target);

    // For pathway-interactor links, the target might have @pathwayId suffix - extract original ID
    const cleanTarget = target.includes('@') ? target.split('@')[0] : target;
    const cleanSource = source.includes('@') ? source.split('@')[0] : source;

    // Get functions - for pathway-interactor links, look up from SNAP.interactions
    let functions = L.functions || [];
    const interactionArrow = L.arrow || link.arrow || 'binds';

    // If no functions but we have interaction data, try to find functions from SNAP.interactions
    if (functions.length === 0 && link.type === 'pathway-interactor-link') {
      // Look up the full interaction data from SNAP.interactions
      const fullInteraction = (SNAP.interactions || []).find(int =>
        (int.source === SNAP.main && int.target === cleanTarget) ||
        (int.target === SNAP.main && int.source === cleanTarget) ||
        (int.source === SNAP.main && int.target === cleanSource) ||
        (int.target === SNAP.main && int.source === cleanSource)
      );
      if (fullInteraction) {
        functions = fullInteraction.functions || [];
      }
    }

    // Skip interactions without functions (create a minimal entry for display)
    if (functions.length === 0) {
      // Create a minimal entry for interactions without functions
      const displayTarget = cleanTarget || target;
      const displaySource = cleanSource || source;
      entries.push({
        interactorId: displayTarget !== SNAP.main ? displayTarget : displaySource,
        interactorLabel: displayTarget !== SNAP.main ? displayTarget : displaySource,
        source: displaySource,
        target: displayTarget,
        direction: L.direction || 'bidirectional',
        interactionArrow: arrowKind(interactionArrow, L.intent, L.direction),
        interactionEffectBadgeText: formatArrow(arrowKind(interactionArrow, L.intent, L.direction)),
        functionArrow: '—',
        functionEffectBadgeText: '—',
        arrow: arrowKind(interactionArrow, L.intent, L.direction),
        effectBadgeText: formatArrow(arrowKind(interactionArrow, L.intent, L.direction)),
        functionLabel: '(No functions)',
        cellularProcess: '—',
        specificEffects: [],
        effectTypeDetails: { text: '—', description: '' },
        mechanismText: '—',
        biologicalCascade: [],
        evidence: [],
        fnData: null,
        supportSummary: L.support_summary || '',
        searchKey: `${displaySource} ${displayTarget} no functions`.toLowerCase(),
        isMinimalEntry: true
      });
      return;
    }

    // Extract interaction metadata (interactionArrow already defined above)
    const intent = L.intent || 'binding';
    const supportSummary = L.support_summary || '';
    const direction = L.direction || 'main_to_primary';

    // Determine which protein is the "interactor" for display purposes
    // Use clean source/target (without @pathwayId suffix) for comparison
    let interactorLabel = '';
    if (cleanSource === SNAP.main) {
      interactorLabel = cleanTarget;
    } else if (cleanTarget === SNAP.main) {
      interactorLabel = cleanSource;
    } else {
      // Shared link between two interactors - use source as display
      interactorLabel = cleanSource;
    }

    // Process each function
    functions.forEach((fn, fnIndex) => {
      if (!fn || typeof fn !== 'object') {
        console.warn('collectFunctionEntries: Invalid function data', fn);
        return;
      }

      const functionLabel = fn.function || 'Function';

      // IMPORTANT: Separate interaction effect from function effect
      // 1. Interaction Effect: Effect on the downstream PROTEIN (e.g., "ATXN3 inhibits VCP")
      // 2. Function Effect: Effect on this specific FUNCTION (e.g., "This interaction activates Autophagy")

      // Normalize interaction arrow (effect on the protein)
      const normalizedInteractionArrow = arrowKind(interactionArrow, intent, direction);

      // Normalize function arrow (effect on this specific function)
      const fnArrow = fn.arrow || interactionArrow;  // Fallback to interaction if function has no arrow
      const normalizedFunctionArrow = arrowKind(fnArrow, fn.intent || intent, direction);

      // Extract function details
      const cellularProcess = fn.cellular_process || '';
      const specificEffects = Array.isArray(fn.specific_effects) ? fn.specific_effects : [];
      const biologicalCascade = Array.isArray(fn.biological_consequence) ? fn.biological_consequence : [];
      const evidence = Array.isArray(fn.evidence) ? fn.evidence : [];
      const pmids = Array.isArray(fn.pmids) ? fn.pmids : [];

      // Get effect type details (use function arrow for function-specific details)
      const effectTypeDetails = getEffectTypeDetails(fn, normalizedFunctionArrow);

      // Get mechanism text
      const mechanismText = getMechanismText(intent);

      // Build searchable text
      const evidenceText = evidence.map(ev => [
        ev.paper_title,
        ev.authors,
        ev.journal,
        ev.year,
        ev.relevant_quote,
        ev.pmid
      ].filter(Boolean).join(' ')).join(' ');

      const searchParts = [
        source,
        target,
        interactorLabel,
        functionLabel,
        cellularProcess,
        specificEffects.join(' '),
        effectTypeDetails.text,
        mechanismText || '',
        supportSummary,
        biologicalCascade.join(' '),
        evidenceText,
        pmids.join(' ')
      ];

      // Create entry with BOTH interaction and function effects
      entries.push({
        interactorId: interactorLabel,
        interactorLabel: interactorLabel,
        source: String(cleanSource),  // Use clean IDs without @pathwayId suffix
        target: String(cleanTarget),
        direction: direction,

        // Interaction effect (on the downstream protein)
        interactionArrow: normalizedInteractionArrow,
        interactionEffectBadgeText: formatArrow(normalizedInteractionArrow),

        // Function effect (on this specific function)
        functionArrow: normalizedFunctionArrow,
        functionEffectBadgeText: formatArrow(normalizedFunctionArrow),

        // Legacy field for backward compatibility (use interactionArrow for most displays)
        arrow: normalizedInteractionArrow,
        effectBadgeText: formatArrow(normalizedInteractionArrow),

        functionLabel: functionLabel,
        cellularProcess: cellularProcess,
        specificEffects: specificEffects,
        effectTypeDetails: effectTypeDetails,
        mechanismText: mechanismText,
        biologicalCascade: biologicalCascade,
        evidence: evidence,
        fnData: fn,
        supportSummary: supportSummary,
        searchKey: searchParts.filter(Boolean).join(' ').toLowerCase()
      });
    });
  });

  return entries;
}

function renderSpecificEffects(effects) {
  if (!Array.isArray(effects) || effects.length === 0) {
    return '<span class="muted-text">Not specified</span>';
  }

  return `<div class="specific-effects-list">
    ${effects.map(effect => `<div class="specific-effect-chip">${escapeHtml(effect)}</div>`).join('')}
  </div>`;
}

function renderBiologicalCascade(steps) {
  if (!Array.isArray(steps) || steps.length === 0) {
    return '<span class="muted-text">Not specified</span>';
  }

  // Normalize: flatten all segments and split by arrows
  const allSteps = [];
  steps.forEach(segment => {
    const text = (segment == null ? '' : segment).toString().trim();
    if (!text) return;

    // Split by both arrow types (→ and \u001a) and clean each step
    const normalized = text.replace(/\u001a/g, '→');
    const stepsList = normalized.split('→').map(s => s.trim()).filter(s => s.length > 0);
    allSteps.push(...stepsList);
  });

  if (allSteps.length === 0) {
    return '<span class="muted-text">Not specified</span>';
  }

  return `<div class="biological-cascade-list">
    ${allSteps.map(step => `<div class="biological-cascade-item">${escapeHtml(step)}</div>`).join('')}
  </div>`;
}

function renderEvidenceSummary(evidence, fnData) {
  const items = Array.isArray(evidence) ? evidence.filter(Boolean) : [];
  const fnPmids = Array.isArray(fnData && fnData.pmids) ? fnData.pmids.filter(Boolean) : [];

  if (!items.length && !fnPmids.length) {
    return '<span class="muted-text">No evidence provided</span>';
  }

  if (!items.length) {
    return `<div class="table-evidence-pmids">
      ${fnPmids.map(p => `<a href="https://pubmed.ncbi.nlm.nih.gov/${escapeHtml(p)}" target="_blank" class="pmid-link">PMID: ${escapeHtml(p)}</a>`).join('')}
    </div>`;
  }

  const limited = items.slice(0, 3);
  const displayedPmids = new Set();
  const listHtml = limited.map(ev => {
    const title = escapeHtml(ev.paper_title || 'Untitled');
    const authors = ev.authors ? escapeHtml(ev.authors) : '';
    const journal = ev.journal ? escapeHtml(ev.journal) : '';
    const year = ev.year ? escapeHtml(ev.year) : '';
    const metaParts = [];
    if (authors) metaParts.push(authors);
    if (journal) metaParts.push(journal);
    if (year) metaParts.push(`(${year})`);
    const metaHtml = metaParts.length ? `<div class="table-evidence-meta">${metaParts.join(' · ')}</div>` : '';
    let pmidHtml = '';
    if (ev.pmid) {
      const safePmid = escapeHtml(ev.pmid);
      displayedPmids.add(ev.pmid);
      pmidHtml = `<div class="table-evidence-pmids"><a href="https://pubmed.ncbi.nlm.nih.gov/${safePmid}" target="_blank" class="pmid-link">PMID: ${safePmid}</a></div>`;
    }
    return `<div class="table-evidence-item">
      <div class="table-evidence-title">${title}</div>
      ${metaHtml}
      ${pmidHtml}
    </div>`;
  }).join('');

  const moreCount = items.length - limited.length;
  const extraPmids = fnPmids.filter(p => p && !displayedPmids.has(p));
  const extraPmidHtml = extraPmids.length ? `<div class="table-evidence-pmids">
    ${extraPmids.map(p => `<a href="https://pubmed.ncbi.nlm.nih.gov/${escapeHtml(p)}" target="_blank" class="pmid-link">PMID: ${escapeHtml(p)}</a>`).join('')}
  </div>` : '';
  const moreHtml = moreCount > 0 ? `<div class="table-evidence-more">+${moreCount} more sources</div>` : '';

  return `<div class="table-evidence-list">${listHtml}${extraPmidHtml}${moreHtml}</div>`;
}

function renderEffectType(details) {
  if (!details || !details.text) {
    return '<span class="muted-text">Not specified</span>';
  }

  const arrowClass = details.arrow === 'activates' || details.arrow === 'inhibits' ? details.arrow : 'binds';
  return `<div class="expanded-effect-type ${arrowClass}">
    <span class="effect-type-badge ${arrowClass}">${escapeHtml(details.text)}</span>
  </div>`;
}

function getEffectTypeDetails(fn, arrow) {
  const normalized = (arrow || '').toLowerCase();
  const arrowKey = normalized === 'activates' || normalized === 'inhibits' ? normalized : 'binds';

  let text = '';
  if (fn && fn.effect_description) {
    text = fn.effect_description;
  }

  if (!text) {
    if (arrowKey === 'activates') text = 'Function is enhanced or activated';
    else if (arrowKey === 'inhibits') text = 'Function is inhibited or disrupted';
    else text = 'Binds / interacts';
  }

  return { text, arrow: arrowKey };
}

function getMechanismText(intent) {
  if (!intent) return null;
  const value = Array.isArray(intent) ? intent.find(Boolean) : intent;
  if (!value) return null;
  const str = String(value).trim();
  if (!str) return null;
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function formatArrow(arrow) {
  if (arrow === 'activates') return 'Activates';
  if (arrow === 'inhibits') return 'Inhibits';
  if (arrow === 'regulates') return 'Regulates';
  return 'Binds';
}

function toPastTense(verb) {
  // Convert infinitive verb form to past tense/past participle
  // Handles common verbs used in interaction/function effects
  const v = verb.toLowerCase();

  // Direct word mappings for all common forms
  const pastTenseMap = {
    'activate': 'activated',
    'activates': 'activated',
    'inhibit': 'inhibited',
    'inhibits': 'inhibited',
    'bind': 'bound',
    'binds': 'bound',  // Irregular verb - FIXED
    'regulate': 'regulated',
    'regulates': 'regulated',
    'modulate': 'modulated',
    'modulates': 'modulated',
    'complex': 'complexed',
    'suppress': 'suppressed',
    'suppresses': 'suppressed',
    'enhance': 'enhanced',
    'enhances': 'enhanced',
    'promote': 'promoted',
    'promotes': 'promoted',
    'repress': 'repressed',
    'represses': 'repressed'
  };

  if (pastTenseMap[v]) return pastTenseMap[v];

  // Default fallback for regular verbs
  if (v.endsWith('e')) return v + 'd';
  return v + 'ed';
}

function extractSourceProteinFromChain(fn, interactorProtein) {
  // Extract the immediate upstream protein that acts on the target (interactor)
  // For chain context: [Query, A, B, Target] → returns B (acts on Target)
  // Returns the protein that directly causes the effect on interactorProtein

  if (!fn._context || fn._context.type !== 'chain') {
    // No chain context - fallback to interactor itself
    return interactorProtein;
  }

  const chainArray = fn._context.chain;
  const queryProtein = fn._context.query_protein || '';

  if (!Array.isArray(chainArray) || chainArray.length === 0) {
    return interactorProtein;
  }

  // Full chain: [Query, ...intermediates, Target]
  const fullChain = [queryProtein, ...chainArray];

  // Find the target protein in the chain
  const targetIndex = fullChain.findIndex(p => p === interactorProtein);

  if (targetIndex > 0) {
    // Return the protein immediately before target (the one acting on it)
    return fullChain[targetIndex - 1];
  }

  // Fallback: return last protein in chain before target
  return chainArray[chainArray.length - 1] || interactorProtein;
}

function buildFullChainPath(queryProtein, chainArray, linkData) {
  // Build full chain display for INDIRECT labels
  // Input: query protein + chain array from link/function metadata
  // Output: "ATF6 → SREBP2 → HMGCR"

  if (!Array.isArray(chainArray) || chainArray.length === 0) {
    // No chain - check if linkData has upstream_interactor
    if (linkData && linkData.upstream_interactor) {
      return `${escapeHtml(queryProtein)} → ${escapeHtml(linkData.upstream_interactor)} → ${escapeHtml(linkData.primary)}`;
    }
    return '';
  }

  const fullChain = [queryProtein, ...chainArray];
  return fullChain.map(p => escapeHtml(p)).join(' → ');
}

function formatDirection(dir) {
  const v = (dir || '').toLowerCase();
  // Handle both query-relative AND absolute directions
  if (v === 'bidirectional' || v === 'undirected' || v === 'both') return 'Bidirectional';
  if (v === 'primary_to_main' || v === 'b_to_a') return 'Protein → Main';
  if (v === 'main_to_primary' || v === 'a_to_b') return 'Main → Protein';
  return 'Bidirectional';
}

function renderPMIDs(pmids) {
  if (!Array.isArray(pmids) || pmids.length === 0) return '—';

  return `<div class="pmid-list">
    ${pmids.slice(0, 5).map(p =>
    `<a href="https://pubmed.ncbi.nlm.nih.gov/${escapeHtml(p)}" target="_blank" class="pmid-link">${escapeHtml(p)}</a>`
  ).join('')}
    ${pmids.length > 5 ? `<span style="color:#6b7280;font-size:12px;">+${pmids.length - 5} more</span>` : ''}
  </div>`;
}

function escapeHtml(text) {
  if (text == null) return '';
  const div = document.createElement('div');
  div.textContent = String(text);
  return div.innerHTML;
}

function escapeCsv(text) {
  if (text == null) return '';
  const str = String(text);
  // Escape quotes and wrap in quotes if contains comma, quote, or newline
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

function toggleExportDropdown() {
  const menu = document.getElementById('export-dropdown-menu');
  if (menu) {
    menu.classList.toggle('show');
  }
}

function closeExportDropdown() {
  const menu = document.getElementById('export-dropdown-menu');
  if (menu) {
    menu.classList.remove('show');
  }
}

// Close dropdown when clicking outside
document.addEventListener('click', (e) => {
  const dropdown = document.querySelector('.export-dropdown');
  if (dropdown && !dropdown.contains(e.target)) {
    closeExportDropdown();
  }
});

function buildFunctionExportRows() {
  const header = [
    'Source',
    'Target',
    'Interaction',
    'Effect',
    'Function',
    'Cellular Process',
    'Specific Effects',
    'Effect Type',
    'Mechanism',
    'Biological Cascade',
    'Support Summary',
    'Evidence Title',
    'Authors',
    'Journal',
    'Year',
    'PMID',
    'Quote'
  ];

  const rows = [header];
  const entries = collectFunctionEntries();

  if (entries.length === 0) {
    rows.push(new Array(header.length).fill(''));
    return rows;
  }

  entries.forEach(entry => {
    const fnData = entry.fnData || {};
    const interaction = `${entry.source} -> ${entry.target}`;
    const effectLabel = entry.arrow === 'activates' ? 'Activates' : (entry.arrow === 'inhibits' ? 'Inhibits' : 'Binds');
    const cellularProcessText = entry.cellularProcess || 'Not specified';
    const specificEffectsText = entry.specificEffects.length ? entry.specificEffects.join(' | ') : 'Not specified';
    const effectTypeText = entry.effectTypeDetails.text || '';
    const mechanismText = entry.mechanismText || 'Not specified';
    const bioCascadeText = entry.biologicalCascade.length ? entry.biologicalCascade.join(' -> ') : '';
    const supportSummary = entry.supportSummary || '';
    const evidenceItems = entry.evidence.length ? entry.evidence : [null];
    const pmidFallback = Array.isArray(fnData.pmids) ? fnData.pmids.join(' | ') : '';

    evidenceItems.forEach((ev, evIndex) => {
      const pmidValue = ev && ev.pmid ? ev.pmid : pmidFallback;

      rows.push([
        entry.source,
        entry.target,
        interaction,
        effectLabel,
        entry.functionLabel,
        cellularProcessText,
        specificEffectsText,
        effectTypeText,
        mechanismText,
        evIndex === 0 ? bioCascadeText : '',  // Only show biological cascade in first evidence row
        evIndex === 0 ? supportSummary : '',  // Only show support summary in first evidence row
        ev ? (ev.paper_title || '') : '',
        ev ? (ev.authors || '') : '',
        ev ? (ev.journal || '') : '',
        ev ? (ev.year || '') : '',
        pmidValue,
        ev ? (ev.relevant_quote || '') : ''
      ]);
    });
  });

  return rows;
}

function exportToCSV() {
  const rows = buildFunctionExportRows();
  const csvContent = rows
    .map(row => row.map(escapeCsv).join(','))
    .join('\n');

  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${SNAP.main}_interaction_network.csv`;
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

function exportToExcel() {
  if (typeof XLSX === 'undefined') {
    alert('Excel export library not loaded. Please refresh the page.');
    return;
  }

  const wb = XLSX.utils.book_new();
  const data = buildFunctionExportRows();
  const ws = XLSX.utils.aoa_to_sheet(data);
  XLSX.utils.book_append_sheet(wb, ws, 'Functions');
  XLSX.writeFile(wb, `${SNAP.main}_interaction_network.xlsx`);
}

/* ===== Re-query and Cancellation ===== */
let currentRunningJob = null;

async function requeryMainProtein() {
  if (!SNAP || !SNAP.main) {
    alert('No main protein found');
    return;
  }

  // Check if there's a running job
  if (currentRunningJob) {
    const confirmed = confirm(`A query is already running for ${currentRunningJob}. Cancel it and start a new re-query?`);
    if (confirmed) {
      await cancelCurrentJob();
      // Wait a moment for cancellation to process
      await new Promise(resolve => setTimeout(resolve, 500));
    } else {
      return;
    }
  }

  // Prompt for number of rounds
  const interactorInput = prompt('Number of interactor discovery rounds (1-8, default 1):', '1');
  if (interactorInput === null) return; // User cancelled

  const functionInput = prompt('Number of function mapping rounds (1-8, default 1):', '1');
  if (functionInput === null) return; // User cancelled

  const interactorRounds = Math.max(1, Math.min(8, parseInt(interactorInput) || 1));
  const functionRounds = Math.max(1, Math.min(8, parseInt(functionInput) || 1));

  currentRunningJob = SNAP.main;

  try {
    // Get list of current nodes to send as context
    const currentNodes = nodes
      .filter(n => n.type === 'main' || n.type === 'interactor')
      .map(n => n.id);

    // Start re-query
    const response = await fetch('/api/requery', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        protein: SNAP.main,
        current_nodes: currentNodes,
        interactor_rounds: interactorRounds,
        function_rounds: functionRounds
      })
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || 'Re-query failed');
    }

    // Start polling for status
    pollForComplete(SNAP.main, () => {
      // On complete, reload the page to show new data
      location.reload();
    });

  } catch (err) {
    console.error('Error starting re-query:', err);
    alert(`Failed to start re-query: ${err.message}`);
    currentRunningJob = null;
  }
}

async function pollForComplete(proteinName, onComplete) {
  const maxAttempts = 600; // 10 minutes max (1 check per second)
  let attempts = 0;

  const checkStatus = async () => {
    try {
      const response = await fetch(`/api/status/${proteinName}`);
      const data = await response.json();

      if (data.status === 'complete') {
        miniDone('Re-query complete! Refreshing...');
        currentRunningJob = null;
        currentJobProtein = null;
        // Reload immediately to show new data
        if (onComplete) {
          onComplete();
        } else {
          // Fallback: reload anyway
          setTimeout(() => location.reload(), 500);
        }
        return;
      } else if (data.status === 'error') {
        const errorText = typeof data.progress === 'object' ? data.progress.text : data.progress;
        miniDone(`Error: ${errorText}`);
        currentRunningJob = null;
        return;
      } else if (data.status === 'cancelled') {
        miniDone('Cancelled');
        currentRunningJob = null;
        return;
      } else if (data.status === 'processing') {
        const prog = data.progress || {};
        const text = prog.text || 'Processing...';
        const current = prog.current || 0;
        const total = prog.total || 100;
        miniProgress(text, current, total, proteinName);
      }

      // Keep polling
      attempts++;
      if (attempts < maxAttempts) {
        setTimeout(checkStatus, 1000);
      } else {
        miniDone('Timeout waiting for re-query');
        currentRunningJob = null;
      }
    } catch (err) {
      console.error('Error polling status:', err);
      miniDone('Error checking status');
      currentRunningJob = null;
    }
  };

  checkStatus();
}

/* ===== Chat Functions ===== */
// Chat state
let chatHistory = [];
let chatPending = false;
const MAX_CHAT_HISTORY = 10; // Configurable max history to send to LLM

/**
 * Build compact state snapshot for LLM context.
 * Sends only visible protein list - backend reads full data from cache JSON.
 */
function buildChatCompactState() {
  // Collect all visible proteins (main + interactors only, not function nodes)
  const visibleProteins = new Set();

  // Always include root protein (with safety check)
  const mainProtein = SNAP && SNAP.main ? SNAP.main : 'Unknown';
  if (mainProtein !== 'Unknown') {
    visibleProteins.add(mainProtein);
  }

  // Add all visible interactor proteins from nodes array (with safety check)
  if (Array.isArray(nodes)) {
    nodes.forEach(n => {
      if (n && n.id && (n.type === 'main' || n.type === 'interactor')) {
        visibleProteins.add(n.id);
      }
    });
  }

  return {
    parent: mainProtein,
    visible_proteins: Array.from(visibleProteins)
  };
}

/**
 * Render a chat message in the UI.
 */
function renderChatMessage(role, content, isError = false) {
  const messagesContainer = document.getElementById('chat-messages');
  if (!messagesContainer) return;

  const messageDiv = document.createElement('div');

  if (isError) {
    messageDiv.className = 'chat-message error-message';
  } else if (role === 'user') {
    messageDiv.className = 'chat-message user-message';
  } else if (role === 'assistant') {
    messageDiv.className = 'chat-message assistant-message';
  } else if (role === 'system') {
    messageDiv.className = 'chat-message system-message';
  }

  const contentDiv = document.createElement('div');
  contentDiv.className = 'message-content';
  contentDiv.textContent = content;

  messageDiv.appendChild(contentDiv);
  messagesContainer.appendChild(messageDiv);

  // Auto-scroll to bottom
  messagesContainer.scrollTop = messagesContainer.scrollHeight;
}

/**
 * Send chat message to backend.
 */
async function sendChatMessage() {
  const input = document.getElementById('chat-input');
  const sendBtn = document.getElementById('chat-send-btn');
  const sendText = document.getElementById('chat-send-text');
  const sendLoading = document.getElementById('chat-send-loading');

  if (!input || !sendBtn) return;

  const userMessage = input.value.trim();
  if (!userMessage || chatPending) return;

  // Early validation: ensure SNAP exists before starting
  if (!SNAP || !SNAP.main) {
    renderChatMessage('error', 'Error: No protein data loaded', true);
    return;
  }

  // Update UI state
  chatPending = true;
  input.value = '';
  input.disabled = true;
  sendBtn.disabled = true;
  sendText.style.display = 'none';
  sendLoading.style.display = 'inline';

  // Add user message to history and UI
  chatHistory.push({ role: 'user', content: userMessage });
  renderChatMessage('user', userMessage);

  try {
    // Build compact state for context
    const compactState = buildChatCompactState();

    // Prepare request payload
    const payload = {
      parent: SNAP.main,
      messages: chatHistory,
      state: compactState,
      max_history: MAX_CHAT_HISTORY,
    };

    // Call chat API
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    const data = await response.json();

    if (!response.ok) {
      // Handle API error
      const errorMsg = data.error || `Server error (${response.status})`;
      throw new Error(errorMsg);
    }

    // Extract reply
    const reply = data.reply;
    if (!reply) {
      throw new Error('Empty response from server');
    }

    // Add assistant response to history and UI
    chatHistory.push({ role: 'assistant', content: reply });
    renderChatMessage('assistant', reply);

    // Trim chat history to prevent unbounded growth
    // Keep only the most recent MAX_CHAT_HISTORY * 2 messages (generous buffer)
    const maxClientHistory = MAX_CHAT_HISTORY * 2;
    if (chatHistory.length > maxClientHistory) {
      chatHistory = chatHistory.slice(-maxClientHistory);
    }

  } catch (error) {
    console.error('Chat error:', error);

    // Render error message
    const errorText = error.message || 'Failed to get response. Please try again.';
    renderChatMessage('error', `Error: ${errorText}`, true);

    // Remove the user message from history if request failed
    chatHistory.pop();

  } finally {
    // Reset UI state
    chatPending = false;
    input.disabled = false;
    sendBtn.disabled = false;
    sendText.style.display = 'inline';
    sendLoading.style.display = 'none';
    input.focus();
  }
}

/**
 * Handle Enter key in chat input (Shift+Enter for new line, Enter to send).
 */
function handleChatKeydown(event) {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    sendChatMessage();
  }
}

// Wire up chat input keyboard handler
document.addEventListener('DOMContentLoaded', () => {
  const chatInput = document.getElementById('chat-input');
  if (chatInput) {
    chatInput.addEventListener('keydown', handleChatKeydown);
  }
});

/* Wire up */
document.addEventListener('DOMContentLoaded', () => {
  // Restore theme preference (dark mode is default)
  const savedTheme = localStorage.getItem('theme');
  if (savedTheme === 'light') {
    document.body.classList.remove('dark-mode');
  } else if (!savedTheme) {
    // First visit: ensure dark mode is set
    localStorage.setItem('theme', 'dark');
  }

  // Initialize view mode from localStorage
  if (typeof initializeViewMode === 'function') {
    initializeViewMode();
  }

  // Update theme toggle icon
  const isDark = document.body.classList.contains('dark-mode');
  const icon = document.getElementById('theme-icon');
  if (icon) {
    icon.textContent = isDark ? '☀️' : '🌙';
  }

  // Wire up search bar - matches index page behavior (search first, then prompt)
  const queryBtn = document.getElementById('query-button');
  const proteinInp = document.getElementById('protein-input');
  if (queryBtn && proteinInp) {
    const handleQuery = async () => {
      const p = proteinInp.value.trim();
      if (!p) {
        showNotificationMessage('<span style="color:#dc2626;">Please enter a protein name.</span>');
        return;
      }
      if (!/^[a-zA-Z0-9_-]+$/.test(p)) {
        showNotificationMessage('<span style="color:#dc2626;">Invalid format. Use only letters, numbers, hyphens, and underscores.</span>');
        return;
      }

      // Search database first (like index page)
      showNotificationMessage(`<span>Searching for ${p}...</span>`);

      try {
        const response = await fetch(`/api/search/${encodeURIComponent(p)}`);

        if (!response.ok) {
          const errorData = await response.json();
          showNotificationMessage(`<span style="color:#dc2626;">${errorData.error || 'Search failed'}</span>`);
          return;
        }

        const data = await response.json();

        if (data.status === 'found') {
          // Protein exists - navigate to it
          showNotificationMessage(`<span>Found! Loading ${p}...</span>`);
          vizJobTracker.saveToSessionStorage(); // Persist jobs before navigation
          setTimeout(() => {
            window.location.href = `/api/visualize/${encodeURIComponent(p)}?t=${Date.now()}`;
          }, 500);
        } else {
          // Not found in DB - check if query is currently running
          try {
            const statusResponse = await fetch(`/api/status/${encodeURIComponent(p)}`);

            if (statusResponse.ok) {
              const statusData = await statusResponse.json();

              if (statusData.status === 'processing') {
                // Job is running! Add to tracker (don't navigate)
                vizJobTracker.addJob(p, {});
                showNotificationMessage(`<span>Query running for ${p} (not in database yet)</span>`);
                return;
              }
            }
          } catch (e) {
            console.log('[handleQuery] No running job found for', p);
          }

          // Not found AND not running - show query prompt
          showQueryPromptViz(p);
        }
      } catch (error) {
        console.error('[handleQuery] Search failed:', error);
        showNotificationMessage('<span style="color:#dc2626;">Search failed</span>');
      }
    };
    queryBtn.addEventListener('click', handleQuery);
    proteinInp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); handleQuery(); } });
  }

  // === CLEANUP ON PAGE UNLOAD ===
  // FIXED: Stop all polling intervals to prevent wasted requests
  window.addEventListener('beforeunload', () => {
    vizJobTracker.intervals.forEach((intervalId) => {
      clearInterval(intervalId);
    });
    vizJobTracker.intervals.clear();
    console.log('[VizJobTracker] Cleaned up all polling intervals on unload');
  });

  // === AUTO-RESUME JOB TRACKING ===
  // Check if current protein has a running job and resume tracking
  (async function checkAndResumeJob() {
    if (!SNAP || !SNAP.main) return;

    const currentProtein = SNAP.main;

    try {
      const response = await fetch(`/api/status/${encodeURIComponent(currentProtein)}`);
      if (!response.ok) return; // Protein not being queried

      const data = await response.json();

      // If job is still processing, add to tracker
      if (data.status === 'processing') {
        console.log(`[Auto-Resume] Found running job for ${currentProtein}, resuming tracking...`);

        vizJobTracker.addJob(currentProtein, {
          onComplete: () => {
            // Reload page to show updated data
            showNotificationMessage(`<span>Query complete! Reloading...</span>`);
            setTimeout(() => {
              window.location.reload();
            }, 1000);
          }
        });
      }
    } catch (error) {
      // Silently fail - protein just doesn't have a running job
      console.log(`[Auto-Resume] No running job for ${currentProtein}`);
    }

    // After checking current protein, restore other jobs from sessionStorage
    await vizJobTracker.restoreFromSessionStorage();
  })();

  // === SMART HEADER AUTO-HIDE ===
  // Solves the "hover chase" bug where panels shift as header shows/hides
  // Strategy: Delay hiding + extend hover zone to include panels
  (function initHeaderAutoHide() {
    const header = document.querySelector('.header');
    const headerTrigger = document.querySelector('.header-trigger');
    const controlsPanel = document.querySelector('.controls');
    const infoPanel = document.querySelector('.info-panel');

    if (!header || !headerTrigger) return;

    let hideTimer = null;
    let isHeaderVisible = false;

    // Check if header is in static mode (table view)
    function isStaticMode() {
      return header.classList.contains('header-static');
    }

    // Show header immediately (unless in static mode)
    function show() {
      if (isStaticMode()) return; // Don't toggle in static mode

      if (hideTimer) {
        clearTimeout(hideTimer);
        hideTimer = null;
      }
      if (!isHeaderVisible) {
        header.classList.add('header-visible');
        isHeaderVisible = true;
      }
    }

    // Hide header after delay (allows smooth mouse movement)
    function scheduleHide() {
      if (isStaticMode()) return; // Don't toggle in static mode

      if (hideTimer) clearTimeout(hideTimer);
      hideTimer = setTimeout(() => {
        header.classList.remove('header-visible');
        isHeaderVisible = false;
        hideTimer = null;
      }, 400); // 400ms grace period
    }

    // Attach hover listeners to all relevant elements
    [headerTrigger, header, controlsPanel, infoPanel].forEach(el => {
      if (!el) return;

      el.addEventListener('mouseenter', () => {
        show();
      });

      el.addEventListener('mouseleave', () => {
        scheduleHide();
      });
    });

    // Also respond to focus within header (keyboard accessibility)
    header.addEventListener('focusin', () => {
      show();
    });

    header.addEventListener('focusout', () => {
      scheduleHide();
    });
  })();

  initNetwork();
  buildTableView(); // Build initial table
  initColumnResizing(); // Initialize column resizing
  // Initialize with graph view active
  document.body.classList.add('graph-view-active');
  const container = document.querySelector('.container');
  if (container) container.classList.add('graph-active');
});
window.addEventListener('resize', () => {
  const el = document.getElementById('network');
  if (!el || !svg) return;
  const newWidth = el.clientWidth || width;
  const newHeight = el.clientHeight || height;
  if (newWidth) width = newWidth;
  if (newHeight) height = newHeight;
  svg.attr('width', width).attr('height', height);
  if (simulation) {
    simulation.force('center', d3.forceCenter(width / 2, height / 2));
    reheatSimulation(0.3);
  }
  scheduleFitToView(200, false);
});

// ===============================================================
// PATHWAY EXPLORER SIDEBAR
// ===============================================================

// Track selected root pathways
const selectedRootPathways = new Set();
let sidebarCollapsed = false;

/**
 * Toggle sidebar visibility
 */
function togglePathwaySidebar() {
  const sidebar = document.getElementById('pathway-sidebar');
  const tab = document.getElementById('pathway-sidebar-tab');

  if (!sidebar || !tab) return;

  sidebarCollapsed = !sidebarCollapsed;

  if (sidebarCollapsed) {
    sidebar.classList.add('collapsed');
    tab.style.display = 'flex';
  } else {
    sidebar.classList.remove('collapsed');
    tab.style.display = 'none';
  }
}

/**
 * Filter pathway tree based on search input
 */
function filterPathwaySidebar(searchTerm) {
  const tree = document.getElementById('pathway-tree');
  if (!tree) return;

  const items = tree.querySelectorAll('.pathway-tree-item');
  const lowerSearch = searchTerm.toLowerCase();

  items.forEach(item => {
    const label = item.querySelector('.pathway-tree-label');
    const text = label ? label.textContent.toLowerCase() : '';
    const matches = text.includes(lowerSearch);

    // Show/hide based on match
    item.style.display = matches || searchTerm === '' ? 'flex' : 'none';

    // Also show parent containers if child matches
    if (matches && searchTerm !== '') {
      let parent = item.parentElement;
      while (parent && parent.classList.contains('pathway-tree-children')) {
        parent.style.display = 'block';
        parent = parent.parentElement;
      }
    }
  });
}

/**
 * Select all root pathways
 */
function selectAllRootPathways() {
  if (!pathwayMode || !allPathwaysData) return;

  const rootPathways = allPathwaysData.filter(pw => (pw.hierarchy_level || 0) === 0);

  rootPathways.forEach(pw => {
    const pathwayId = pw.id || `pathway_${pw.name.replace(/\s+/g, '_')}`;
    if (!selectedRootPathways.has(pathwayId)) {
      selectedRootPathways.add(pathwayId);
      addRootPathwayToGraph(pw);
    }
  });

  updateSidebarCheckboxes();
  updateSimulation();
}

/**
 * Clear all root pathway selections
 */
function clearAllRootPathways() {
  // Remove all root pathway nodes from graph
  selectedRootPathways.forEach(pathwayId => {
    removeRootPathwayFromGraph(pathwayId);
  });

  selectedRootPathways.clear();
  updateSidebarCheckboxes();
  updateSimulation();
}

/**
 * Toggle a specific root pathway
 */
function toggleRootPathway(pathwayId, checkbox) {
  if (checkbox.checked) {
    selectedRootPathways.add(pathwayId);
    const pw = allPathwaysData.find(p => (p.id || `pathway_${p.name.replace(/\s+/g, '_')}`) === pathwayId);
    if (pw) addRootPathwayToGraph(pw);
  } else {
    selectedRootPathways.delete(pathwayId);
    removeRootPathwayFromGraph(pathwayId);
  }

  updateSidebarItemState(pathwayId, checkbox.checked);
  updateSimulation();
}

/**
 * Add a root pathway node to the graph
 */
function addRootPathwayToGraph(pw) {
  const pathwayId = pw.id || `pathway_${pw.name.replace(/\s+/g, '_')}`;

  // Check if already exists
  if (nodeMap.has(pathwayId)) return;

  // Calculate position - spread evenly around TOP sector (reserved for pathways)
  // Pathways go in the TOP sector (225° to 315°, or -135° to -45°)
  const existingRoots = nodes.filter(n => n.type === 'pathway' && n.hierarchyLevel === 0);
  const totalSelected = Math.max(selectedRootPathways.size, existingRoots.length + 1, 1);
  const pathwayIndex = existingRoots.length;

  // Spread pathways across the TOP arc (-135° to -45° = 90° span)
  const arcStart = -3 * Math.PI / 4;  // -135°
  const arcEnd = -Math.PI / 4;         // -45°
  const arcSpan = arcEnd - arcStart;   // 90° = π/2

  let angle;
  if (totalSelected <= 1) {
    angle = (arcStart + arcEnd) / 2;  // Center of arc
  } else {
    // Spread evenly with padding
    const padding = arcSpan * 0.1;
    const usableSpan = arcSpan - 2 * padding;
    const step = usableSpan / (totalSelected - 1);
    angle = arcStart + padding + pathwayIndex * step;
  }

  const x = width / 2 + pathwayRingRadius * Math.cos(angle);
  const y = height / 2 + pathwayRingRadius * Math.sin(angle);

  const hier = pathwayHierarchy.get(pathwayId);
  const level = hier?.level || 0;
  const sizing = PATHWAY_SIZES[Math.min(level, 3)];

  const newNode = {
    id: pathwayId,
    label: pw.name,
    type: 'pathway',
    radius: sizing.radius,
    hierarchyLevel: level,
    isLeaf: hier?.is_leaf ?? true,
    childPathwayIds: hier?.child_ids || [],
    ancestry: hier?.ancestry || [pw.name],
    interactorIds: pw.interactor_ids || [],
    ontologyId: pw.ontology_id,
    interactionCount: pw.interaction_count || 0,
    expanded: false,
    hierarchyExpanded: false,
    _targetAngle: angle,  // For angular stability force
    _sector: 3,           // Sector 3 = TOP (pathways)
    x: x,
    y: y,
    isNewlyExpanded: true
  };

  nodes.push(newNode);
  nodeMap.set(pathwayId, newNode);

  // Link to main node
  const mainNode = nodes.find(n => n.type === 'main');
  if (mainNode) {
    links.push({
      id: `${mainNode.id}-${pathwayId}`,
      source: mainNode.id,
      target: pathwayId,
      type: 'pathway-link'
    });
  }

  console.log(`➕ Added root pathway: ${pw.name}`);
}

/**
 * Remove a root pathway node from the graph
 */
function removeRootPathwayFromGraph(pathwayId) {
  const pathwayNode = nodeMap.get(pathwayId);
  if (!pathwayNode) return;

  // First collapse if expanded
  if (expandedPathways.has(pathwayId)) {
    collapsePathway(pathwayNode);
  }
  if (expandedHierarchyPathways.has(pathwayId)) {
    collapsePathwayHierarchy(pathwayNode);
  }

  // Remove node and associated links
  nodes = nodes.filter(n => n.id !== pathwayId);
  links = links.filter(l => {
    const srcId = typeof l.source === 'object' ? l.source.id : l.source;
    const tgtId = typeof l.target === 'object' ? l.target.id : l.target;
    return srcId !== pathwayId && tgtId !== pathwayId;
  });

  nodeMap.delete(pathwayId);
  console.log(`➖ Removed root pathway: ${pathwayNode.label}`);
}

/**
 * Update sidebar checkbox states
 */
function updateSidebarCheckboxes() {
  const tree = document.getElementById('pathway-tree');
  if (!tree) return;

  tree.querySelectorAll('.pathway-tree-checkbox').forEach(checkbox => {
    const pathwayId = checkbox.dataset.pathwayId;
    checkbox.checked = selectedRootPathways.has(pathwayId);
    updateSidebarItemState(pathwayId, checkbox.checked);
  });
}

/**
 * Update visual state of a sidebar item
 */
function updateSidebarItemState(pathwayId, selected) {
  const item = document.querySelector(`.pathway-tree-item[data-pathway-id="${pathwayId}"]`);
  if (!item) return;

  if (selected) {
    item.classList.remove('grayed');
    item.classList.add('selected');
  } else {
    item.classList.add('grayed');
    item.classList.remove('selected');
  }
}

/**
 * Initialize pathway sidebar with tree structure
 */
function initPathwaySidebar() {
  const tree = document.getElementById('pathway-tree');
  if (!tree || !pathwayMode || !allPathwaysData || allPathwaysData.length === 0) {
    // Hide sidebar if no pathways
    const sidebar = document.getElementById('pathway-sidebar');
    if (sidebar) sidebar.style.display = 'none';
    return;
  }

  // Get root pathways
  const rootPathways = allPathwaysData.filter(pw => (pw.hierarchy_level || 0) === 0);

  // Sort by interaction count (descending)
  rootPathways.sort((a, b) => (b.interaction_count || 0) - (a.interaction_count || 0));

  // Build tree HTML
  let html = '';

  rootPathways.forEach(pw => {
    const pathwayId = pw.id || `pathway_${pw.name.replace(/\s+/g, '_')}`;
    const hier = pathwayHierarchy.get(pathwayId);
    const childIds = hier?.child_ids || [];
    const hasChildren = childIds.length > 0;
    const interactionCount = pw.interaction_count || pathwayToInteractors.get(pathwayId)?.size || 0;

    html += buildPathwayTreeItem(pw, pathwayId, hasChildren, interactionCount, 0);
  });

  tree.innerHTML = html;
  console.log(`📋 Sidebar initialized with ${rootPathways.length} root pathways`);
}

/**
 * Build HTML for a pathway tree item (recursive)
 */
function buildPathwayTreeItem(pw, pathwayId, hasChildren, interactionCount, depth) {
  const hier = pathwayHierarchy.get(pathwayId);
  const childIds = hier?.child_ids || [];

  let html = `
    <div class="pathway-tree-item grayed" data-pathway-id="${pathwayId}">
      ${hasChildren ? '<span class="pathway-tree-expander" onclick="togglePathwayTreeExpand(event, this)">▶</span>' : '<span class="pathway-tree-expander"></span>'}
      <input type="checkbox" class="pathway-tree-checkbox" data-pathway-id="${pathwayId}"
             onchange="toggleRootPathway('${pathwayId}', this)">
      <span class="pathway-tree-label" title="${pw.name}">${pw.name}</span>
      <span class="pathway-tree-count">${interactionCount}</span>
    </div>
  `;

  // Add children container (collapsed by default)
  if (hasChildren && depth < 2) {  // Limit depth to prevent too deep nesting
    html += `<div class="pathway-tree-children" style="display: none;">`;

    childIds.forEach(childId => {
      const childPw = allPathwaysData.find(p => (p.id || `pathway_${p.name.replace(/\s+/g, '_')}`) === childId);
      if (childPw) {
        const childHier = pathwayHierarchy.get(childId);
        const childChildIds = childHier?.child_ids || [];
        const childHasChildren = childChildIds.length > 0;
        const childCount = childPw.interaction_count || pathwayToInteractors.get(childId)?.size || 0;

        html += buildPathwayTreeItem(childPw, childId, childHasChildren, childCount, depth + 1);
      }
    });

    html += `</div>`;
  }

  return html;
}

/**
 * Toggle expansion of a tree item in sidebar
 */
function togglePathwayTreeExpand(event, expander) {
  event.stopPropagation();

  const item = expander.closest('.pathway-tree-item');
  const children = item.nextElementSibling;

  if (children && children.classList.contains('pathway-tree-children')) {
    const isExpanded = children.style.display !== 'none';
    children.style.display = isExpanded ? 'none' : 'block';
    expander.textContent = isExpanded ? '▶' : '▼';
  }
}

// Make functions globally available
window.togglePathwaySidebar = togglePathwaySidebar;
window.filterPathwaySidebar = filterPathwaySidebar;
window.selectAllRootPathways = selectAllRootPathways;
window.clearAllRootPathways = clearAllRootPathways;
window.toggleRootPathway = toggleRootPathway;
window.togglePathwayTreeExpand = togglePathwayTreeExpand;

// ============================================================================
// EXTERNAL API (For Separate Views like Card View)
// ============================================================================

// Expose internal state for external modules
window.getGraphNodes = () => nodes || [];
window.getGraphLinks = () => links || [];

// Expose key interaction functions
// REMOVED RECURSIVE WRAPPER
// window.handleNodeClick was causing infinite recursion because it called itself.
// The original handleNodeClick function is already available in the global scope.
// If external modules need it, they can access it directly.

/* 
// Deprecated wrapper
window.handleNodeClick = (event, nodeData) => {
  if (typeof handleNodeClick === 'function') {
    handleNodeClick(nodeData);
  } else {
    console.warn('handleNodeClick not found in visualizer.js scope');
  }
};
*/

window.openNodeModal = (nodeData) => {
  // Manually trigger modal if handleNodeClick isn't enough
  // But handleNodeClick usually opens the modal.
  if (typeof handleNodeClick === 'function') {
    handleNodeClick(nodeData);
  }
};

// ============================================================================
// EXPORTS FOR CARD VIEW
// ============================================================================
window.getRawPathwayData = () => window.allPathwaysData || [];
window.getPathwayHierarchy = () => window.pathwayHierarchy;
window.getPathwayChildrenMap = () => window.pathwayToChildren;
window.getMainProteinId = () => (window.SNAP && window.SNAP.main) || (typeof SNAP !== 'undefined' ? SNAP.main : null);

// ============================================================================
// RELATIONSHIP & MODAL HELPERS FOR CARD VIEW
// ============================================================================

window.getNodeRelationship = (nodeId) => {
  if (!nodeId || !SNAP || !SNAP.interactions) return null;
  if (nodeId === SNAP.main) return { type: 'main', label: 'Main Protein' };

  // Find interaction with main
  // We look for direct interactions first
  const interactions = SNAP.interactions;
  const direct = interactions.find(i =>
    (i.source === SNAP.main && i.target === nodeId) ||
    (i.source === nodeId && i.target === SNAP.main)
  );

  if (direct) {
    const isDownstream = direct.source === SNAP.main;
    const arrow = direct.arrow || 'binds';

    // Construct readable text
    // e.g. "ATXN3 activates FOXO4" or "FOXO4 binds ATXN3"
    const action = arrow === 'activates' ? 'activates' :
      arrow === 'inhibits' ? 'inhibits' :
        arrow === 'regulates' ? 'regulates' : 'binds';

    let text = '';
    if (isDownstream) {
      text = `${SNAP.main} ${action} ${nodeId}`;
      return {
        direction: 'downstream',
        arrow: arrow,
        text: text,
        raw: direct
      };
    } else {
      text = `${nodeId} ${action} ${SNAP.main}`;
      return {
        direction: 'upstream',
        arrow: arrow,
        text: text,
        raw: direct
      };
    }
  }

  return { direction: 'associated', text: `Associated with ${SNAP.main}` };
};

// ============================================================================
// MODAL HANDLER FOR CARD VIEW (Independent of Graph Links)
// ============================================================================

window.openModalForCard = (nodeId, pathwayContext = null) => {
  if (!SNAP || !SNAP.interactions) {
    console.error('SNAP data not found');
    return;
  }

  // Find all interactions involving this node
  const interactionData = SNAP.interactions.filter(interaction => {
    const src = interaction.source || '';
    const tgt = interaction.target || '';
    return src === nodeId || tgt === nodeId;
  });

  if (interactionData.length === 0) {
    console.warn('No interactions found for', nodeId);
  }

  // ✅ IMPROVED: Filter/mark interactions by pathway context
  let relevantInteractions = interactionData;
  let otherInteractions = [];

  if (pathwayContext && pathwayContext.id) {
    const pathwayInteractionIds = getInteractionsForPathway(pathwayContext.id);

    relevantInteractions = interactionData.filter(interaction => {
      const interactorId = interaction.source === nodeId ? interaction.target : interaction.source;
      return pathwayInteractionIds.has(interactorId);
    });

    otherInteractions = interactionData.filter(interaction => {
      const interactorId = interaction.source === nodeId ? interaction.target : interaction.source;
      return !pathwayInteractionIds.has(interactorId);
    });
  }

  // Convert to link objects
  const links = interactionData.map(interaction => ({
    data: interaction,
    source: { id: interaction.source, originalId: interaction.source },
    target: { id: interaction.target, originalId: interaction.target },
    arrow: interaction.arrow,
    direction: interaction.direction,
    isBidirectional: interaction.direction === 'bidirectional',
    // Mark if this link is relevant to the pathway context
    _isRelevantToPathway: pathwayContext ? relevantInteractions.includes(interaction) : true
  }));

  // Mock node object
  const nodeObj = {
    id: nodeId,
    label: nodeId,
    originalId: nodeId,
    _pathwayContext: pathwayContext, // Store context for modal rendering
    _relevantCount: relevantInteractions.length,
    _otherCount: otherInteractions.length
  };

  console.log('Opening Card Modal for:', nodeId, 'with', links.length, 'interactions');
  if (pathwayContext) {
    console.log(`  → ${relevantInteractions.length} in ${pathwayContext.name}, ${otherInteractions.length} in other pathways`);
  }
  showAggregatedInteractionsModal(links, nodeObj);
};

function getInteractionsForPathway(pathwayId) {
  const interactorIds = new Set();
  const pathwayData = window.getRawPathwayData?.() || [];

  // Find the pathway and all its descendants
  const pathwaysToCheck = new Set([pathwayId]);
  const childrenMap = window.getPathwayChildrenMap?.() || new Map();

  function addDescendants(id) {
    const children = childrenMap.get(id);
    if (children) {
      children.forEach(childId => {
        if (!pathwaysToCheck.has(childId)) {
          pathwaysToCheck.add(childId);
          addDescendants(childId);
        }
      });
    }
  }

  addDescendants(pathwayId);

  // Collect all interactor IDs from these pathways
  pathwaysToCheck.forEach(pwId => {
    const pw = pathwayData.find(p =>
      (p.id || `pathway_${p.name.replace(/\s+/g, '_')}`) === pwId
    );
    if (pw && pw.interactor_ids) {
      pw.interactor_ids.forEach(intId => interactorIds.add(intId));
    }
  });

  return interactorIds;
}

// ============================================================================
// VISUALIZATION MODE TOGGLE (Pathway vs Interactor)
// ============================================================================

/**
 * Switch between pathway mode (hierarchical with sidebar) and interactor mode (pure network)
 * @param {string} mode - 'pathway' or 'interactor'
 */
function setVisualizationMode(mode) {
  if (mode !== 'pathway' && mode !== 'interactor') {
    console.error('Invalid visualization mode:', mode);
    return;
  }

  userModeOverride = mode;

  // Update button states
  const pathwayBtn = document.getElementById('mode-pathway');
  const interactorBtn = document.getElementById('mode-interactor');
  if (pathwayBtn) pathwayBtn.classList.toggle('active', mode === 'pathway');
  if (interactorBtn) interactorBtn.classList.toggle('active', mode === 'interactor');

  // Toggle sidebar visibility
  const sidebar = document.getElementById('pathway-sidebar');
  const sidebarTab = document.getElementById('pathway-sidebar-tab');
  if (mode === 'pathway') {
    if (sidebar) sidebar.style.display = 'flex';
  } else {
    if (sidebar) sidebar.style.display = 'none';
    if (sidebarTab) sidebarTab.style.display = 'none';
  }

  // Rebuild visualization with new mode
  refreshVisualization();
}

// Export for global access (used by HTML onclick)
window.setVisualizationMode = setVisualizationMode;
