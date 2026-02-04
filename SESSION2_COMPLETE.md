# Session 2 Complete: Step 6 & Step 7 Redesign

**Date:** 2025-12-30
**Focus:** Perfect Step 6, Create Step 7 verification layer

---

## 1. Step 6 Changes Summary

### What Was Broken

| Problem | Root Cause | Terminal Evidence |
|---------|------------|-------------------|
| JSON truncation | Batch size of 10 pairs exceeded `max_output_tokens=8192` | `Failed to extract JSON from response (length: 945)` |
| Invalid parent warnings | No cycle detection; LLM could pick parents that create loops | `Invalid parent 'Protein Sequestration' for 'Spatial Protein Quality Control'` |
| Hierarchy aborts | When LLM returned invalid parent, code logged warning and continued with broken state | Pathways going straight to root |
| Interactions not updated | Merge logic existed but no verification after | Orphaned PathwayInteraction records |

### How It Was Fixed

**New Architecture: 6 Phases with Validation**

```
Phase 1: DEDUPLICATION
├── Adaptive batching: 5 pairs → 3 → 1 (with retries)
├── Truncation detection before parsing
├── Migration plan built in-memory, validated, then executed
└── Post-merge verification query

Phase 2: TREE ENFORCEMENT
├── Build in-memory graph from PathwayParent table
├── Detect all multi-parent nodes
├── For each: LLM picks best parent
├── BEFORE applying: simulate and run cycle detection (DFS)
├── If cycle → try alternatives, never leave orphaned
└── Verify no cycles remain after phase

Phase 3: HIERARCHY REPAIR
├── Pass A: Find broken parent links (parent doesn't exist)
│   └── LLM suggests new parent or attach to fallback root
├── Pass B: Deepen shallow hierarchies
│   └── Level-1 pathways evaluated for intermediate parents
└── Skip known legitimate level-1 pathways (Apoptosis, Autophagy, etc.)

Phase 4: INTERACTION SYNC
├── Find dangling PathwayInteraction records → delete
├── Find interactions without any pathway → reassign
│   ├── Priority 1: step3_finalized_pathway
│   ├── Priority 2: step2_proposal
│   └── Priority 3: Fallback to "Protein Quality Control"
└── Verify 0 orphaned interactions after phase

Phase 5: SAFE PRUNING
├── Only delete pathways that are:
│   ├── hierarchy_level == -1 (unreachable)
│   ├── No PathwayInteraction records
│   ├── No children
│   └── Not in STRICT_ROOTS
├── Pathways with data → rescue (attach to fallback root)
└── Never delete roots

Phase 6: PRE-FLIGHT VALIDATION
├── All 10 roots exist at level 0
├── No pathways with hierarchy_level == -1
├── No multi-parent pathways
├── No cycles
├── All interactions have PathwayInteraction
└── No dangling pathway references
```

### Key New Utilities (step6_utils.py)

| Function | Purpose |
|----------|---------|
| `build_parent_graph()` | Build child→parents adjacency map |
| `build_child_graph()` | Build parent→children adjacency map |
| `detect_cycle_from_node()` | DFS cycle detection from a starting node |
| `would_create_cycle()` | Check if proposed parent would create cycle |
| `find_all_cycles()` | Find all cycles in the graph |
| `detect_multi_parent_nodes()` | Find nodes with >1 parent |
| `AdaptiveBatcher` | Retry with smaller batches on failure |
| `build_merge_migration_plan()` | Plan all data moves before executing |
| `execute_migration_plan()` | Atomic execution of merge |

---

## 2. Step 7 Documentation

### Purpose

Step 7 is the **final gatekeeper** before data is considered production-ready. It runs after Step 6 completes and:

1. Runs 13 comprehensive checks
2. Auto-fixes LOW/MEDIUM severity issues
3. Blocks on HIGH/CRITICAL issues
4. Generates a detailed verification report

### Checks Performed

**Interaction Checks:**
- `interactions_have_pathway` - Every interaction has PathwayInteraction record
- `pathway_references_valid` - All PathwayInteraction.pathway_id exist
- `interaction_data_consistency` - step2/step3 fields present

**Pathway Checks:**
- `all_roots_exist` - All 10 roots present at level 0
- `no_duplicate_names` - Unique pathway names
- `no_empty_names` - No null/empty names
- `usage_count_accuracy` - Matches actual count

**Hierarchy Checks:**
- `no_cycles` - Graph is acyclic
- `single_parent` - Each pathway has exactly 1 parent
- `no_orphan_pathways` - No hierarchy_level == -1
- `parent_exists` - All parent references valid
- `levels_correct` - level = parent.level + 1
- `ancestor_ids_accurate` - JSONB matches actual path
- `is_leaf_accurate` - Matches whether has children

### Auto-Repair Capabilities

| Issue | Severity | Auto-Fix |
|-------|----------|----------|
| usage_count mismatch | LOW | Recalculate |
| ancestor_ids stale | LOW | Rebuild |
| is_leaf incorrect | LOW | Recalculate |
| levels incorrect | LOW | Recalculate via BFS |
| Missing PathwayInteraction | MEDIUM | Create from step3 data |
| Orphan pathway with data | MEDIUM | Attach to root |
| Cycle detected | HIGH | Block (manual fix) |
| Duplicate names | HIGH | Block (manual fix) |
| Missing root | CRITICAL | Block (abort) |

### Verification Report Format

```
=================================================================
            PATHWAY VERIFICATION REPORT
            Generated: 2025-12-30 14:32:15
=================================================================

SUMMARY
-----------------------------------------------------------------
  Interactions verified:  247
  Pathways verified:      89
  Checks passed:          13
  Checks failed:          0

STATUS: [OK*] PASS_WITH_FIXES
        (5 auto-fixes applied)

CHECKS
-----------------------------------------------------------------
  [OK] interactions_have_pathway
  [OK] pathway_references_valid
  [OK] all_roots_exist
  ...

AUTO-FIXES APPLIED
-----------------------------------------------------------------
  [FIXED] Updated usage_count for 12 pathways
  [FIXED] Rebuilt ancestor_ids for 8 pathways

=================================================================
```

---

## 3. Files Modified/Created

### New Files

| File | Lines | Purpose |
|------|-------|---------|
| `scripts/pathway_v2/step6_utils.py` | 450 | Cycle detection, graph ops, adaptive batcher |
| `scripts/pathway_v2/step7_checks.py` | 500 | 13 verification check functions |
| `scripts/pathway_v2/step7_repairs.py` | 450 | Auto-repair functions |

### Modified Files

| File | Changes |
|------|---------|
| `scripts/pathway_v2/step6_reorganize_pathways.py` | Complete rewrite (1162 lines) - 6 phases with validation |
| `scripts/pathway_v2/verify_pipeline.py` | Complete rewrite (380 lines) - Step 7 orchestrator |
| `runner.py` | Added Step 6 & Step 7 calls to pipeline flow |
| `app.py` | Capture verification result, include in API response |
| `docs/plans/2025-12-30-step6-step7-design.md` | Design document |

---

## 4. How Step 6 and Step 7 Work Together

```
┌─────────────────────────────────────────────────────────────────┐
│                        PIPELINE FLOW                            │
├─────────────────────────────────────────────────────────────────┤
│  Steps 1-5: Build pathways and hierarchy                        │
│       ↓                                                         │
│  Step 6: Reorganize (6 phases)                                  │
│       ├── Each phase validates its output                       │
│       ├── Checkpoints saved after each phase                    │
│       └── Pre-flight validation at end                          │
│       ↓                                                         │
│  Step 7: Verify                                                 │
│       ├── Run all 13 checks                                     │
│       ├── Auto-fix LOW/MEDIUM issues                            │
│       ├── Re-run checks after fixes                             │
│       └── Return pass/fail status                               │
│       ↓                                                         │
│  If PASS: Data is production-ready                              │
│  If FAIL: Blocking issues logged, manual intervention needed    │
└─────────────────────────────────────────────────────────────────┘
```

**Key Integration Points:**

1. `runner.py` calls `reorganize_pathways()` then `verify()`
2. `app.py` (repair-pathways endpoint) does the same
3. `verify()` returns dict with status, used in API response
4. Verification report saved to `logs/verification_reports/`

---

## 5. Confirmations

### Step 6 handles JSON truncation gracefully

**YES** - Implemented via `AdaptiveBatcher`:
```python
batcher = AdaptiveBatcher(candidates, initial_size=5, min_size=1, max_retries=3)
# On failure: 5 → 3 → 1 → skip and log
```
Located in: `step6_reorganize_pathways.py:292`

### Step 6 prevents circular references

**YES** - Implemented via `would_create_cycle()`:
```python
# Before applying any parent change:
if would_create_cycle(child_id, selected_parent.id, test_graph):
    # Try alternatives, never create cycle
```
Located in: `step6_reorganize_pathways.py:457`

### Step 6 reassigns interactions after merges

**YES** - Implemented via `execute_migration_plan()`:
```python
# Migration plan includes:
plan.interactions_to_reassign = [i.interaction_id for i in interactions]
# Executed atomically with collision detection
```
Located in: `step6_utils.py:350-380`

### Step 7 verifies everything before commit

**YES** - 13 checks run via `run_all_checks()`:
- Interaction checks (3)
- Pathway checks (4)
- Hierarchy checks (6)

Located in: `step7_checks.py:450-470`

### Step 7 can block bad data from saving

**YES** - `verify()` returns status that indicates pass/fail:
```python
return {
    'passed': report.status in (PASS, PASS_WITH_FIXES),
    'status': report.status,
    'blocking_issues': len(report.blocking_issues)
}
```
- HIGH/CRITICAL issues are blocking (not auto-fixable)
- Report saved with all details
- API response includes verification status

Located in: `verify_pipeline.py:324-362`

---

## 6. Remaining Concerns / Future Work

1. **LLM Rate Limiting** - Step 6 phases 2-3 make many LLM calls. Current 0.3-0.5s delays may need tuning for large datasets.

2. **Rollback Granularity** - Each phase commits independently. Full transaction rollback would require wrapping all phases.

3. **Semantic Duplicate Detection** - Current deduplication uses string similarity (>0.85). Truly semantic duplicates (synonyms with different wording) still need LLM judgment.

4. **Performance on Large Datasets** - With 1000+ pathways, Phase 1 candidate pair generation is O(n²). Could add early termination or sampling.

5. **Verification Report UI** - Reports are saved to files. Could add an API endpoint to retrieve latest report.

---

## 7. Usage

**Run Step 6 manually:**
```bash
# Dry run
python3 scripts/pathway_v2/step6_reorganize_pathways.py --dry-run

# Live run
python3 scripts/pathway_v2/step6_reorganize_pathways.py

# Start from specific phase
python3 scripts/pathway_v2/step6_reorganize_pathways.py --phase 3
```

**Run Step 7 manually:**
```bash
# Report only
python3 scripts/pathway_v2/verify_pipeline.py --report-only

# With auto-fix
python3 scripts/pathway_v2/verify_pipeline.py --auto-fix
```

**Via UI:** Just run a query - Steps 1-7 execute automatically.

---

*Session 2 Complete - 2025-12-30*
