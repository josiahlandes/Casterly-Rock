# Dead Code Elimination Plan

> Generated 2026-03-11. Based on audit of `src/autonomous/` vs `src/dual-loop/`.

## Context

The system migrated from a single `AutonomousLoop` (4-phase: Analyze→Hypothesize→Implement→Reflect) to a dual-loop architecture (`FastLoop` + `DeepLoop` + `DreamScheduler`). The old single-loop path survives as a fallback in `src/imessage/daemon.ts:621-645`, gated by `dual_loop.enabled` in `autonomous.yaml`. This fallback is never used in production.

## Phase 1: Delete Completely Dead Code (safe, no dependencies)

These modules are exported from `src/autonomous/index.ts` but **never imported anywhere**:

| File | What it is | Why dead |
|------|-----------|----------|
| `src/autonomous/loop-detector.ts` | Infinite loop detector | Never imported or instantiated |
| `src/autonomous/test-parser.ts` | Test output parser | Never imported externally |
| `src/autonomous/reasoning/adversarial.ts` | AdversarialTester | Never instantiated |
| `src/autonomous/dream/archaeology.ts` | CodeArchaeologist | Only in AutonomousLoop constructor |
| `src/autonomous/dream/self-model.ts` | SelfModel builder | Only in AutonomousLoop constructor |

**Steps:**
1. Delete the 5 files above
2. Remove their exports from `src/autonomous/index.ts`
3. Remove any associated test files
4. Run `npm run check`

## Phase 2: Remove Single-Loop Fallback Path

The `else` branch in `daemon.ts:621-645` is the only thing keeping 13+ modules alive.

**Steps:**
1. In `src/imessage/daemon.ts`, remove the `else` block (lines 621-645) and make dual-loop the only path
2. Remove the now-unused imports from daemon.ts: `AutonomousLoop`, `loadConfig`, `createProvider`, `createAutonomousController`
3. Run `npm run check` to find all newly unreferenced code

## Phase 3: Delete Single-Loop-Only Modules

Once Phase 2 lands, these become orphaned:

### Legacy Provider System
| File | Exports |
|------|---------|
| `src/autonomous/provider.ts` | `BaseAutonomousProvider`, `createProvider()` |
| `src/autonomous/providers/ollama.ts` | `OllamaProvider` (old 4-phase) |

### Communication System
| File | Exports |
|------|---------|
| `src/autonomous/communication/delivery.ts` | `MessageDelivery` |
| `src/autonomous/communication/policy.ts` | `MessagePolicy` |

### Reporting (replaced by dual-loop-controller.ts)
| File | Exports |
|------|---------|
| `src/autonomous/report.ts` | `formatDailyReport()`, `formatMorningSummary()` |
| `src/autonomous/status-report.ts` | `formatStatusOverview()`, `formatGoalsSummary()`, etc. |

### Single-Loop Orchestration
| File | Exports |
|------|---------|
| `src/autonomous/loop.ts` | `AutonomousLoop` class |
| `src/autonomous/controller.ts` | `createAutonomousController()` |
| `src/autonomous/validator.ts` | Hypothesis validation |
| `src/autonomous/memory-config.ts` | Zod config schema |
| `src/autonomous/constitution-store.ts` | Constitutional rules |
| `src/autonomous/crystal-store.ts` | Memory crystallization |
| `src/autonomous/trace-replay.ts` | Execution trace replay |

**Steps:**
1. Delete all files listed above (13 files)
2. Remove their exports from `src/autonomous/index.ts`
3. Remove associated test files
4. The `AutonomousController` interface in `controller.ts` is used by `dual-loop-controller.ts` — **extract** the interface to a shared types file before deleting controller.ts
5. Run `npm run check`

## Phase 4: Clean Up index.ts Barrel

After Phases 1-3, `src/autonomous/index.ts` will have many stale re-exports. Rebuild it to only export what the dual-loop and daemon actually import.

**Keep:** EventBus, GoalStack, IssueLog, WorldModel, Journal, ContextManager, Reflector, AgentLoop, debug/getTracer, identity, dream/*, memory/*, reasoning/scaling, reasoning/compute-scaler, tools/types, prompt-store, shadow-store.

**Delete exports for:** everything removed in Phases 1-3.

## Phase 5: Verify & Evaluate Edge Cases

| Module | Status | Decision |
|--------|--------|----------|
| `context-store.ts` | Only used by `context-manager.ts` internally | Keep (internal dep) |
| `identity.ts` | Used by context-manager + agent-loop | Keep |
| `agent-tools.ts` | Used by both loop.ts and dual-loop | Keep, but verify after loop.ts deletion |
| `tools/helpers.ts`, `tools/registry.ts`, `tools/tool-map.ts` | Used by agent-loop | Keep if agent-loop stays |

## Impact Summary

| Phase | Files Deleted | Risk |
|-------|--------------|------|
| Phase 1 | 5 | None — completely unused |
| Phase 2 | 0 (code change) | Low — removes unused fallback |
| Phase 3 | 13 | Medium — requires interface extraction |
| Phase 4 | 0 (cleanup) | None |
| **Total** | **18 files** | |

## Execution Order

Phase 1 → commit → Phase 2 → commit → Phase 3 → commit → Phase 4 → commit.
Each phase gets its own commit with `npm run check` passing before proceeding.
