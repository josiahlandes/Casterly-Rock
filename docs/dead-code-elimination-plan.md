# Dead Code Elimination Plan (Corrected)

> Generated 2026-03-11. Corrected after dependency-chain audit revealed no
> truly orphaned modules exist.

## Context

The system migrated from a single `AutonomousLoop` (4-phase:
Analyze→Hypothesize→Implement→Reflect) to a dual-loop architecture
(`FastLoop` + `DeepLoop` + `DreamScheduler`). The old single-loop path
survives as a fallback in `src/imessage/daemon.ts:621-645`, gated by
`dual_loop.enabled` in `autonomous.yaml`.

## Why the Original Audit Was Wrong

The first audit checked whether modules were imported *from outside*
`src/autonomous/`. But the dual-loop imports `tools/types.ts`, which in turn
imports `ConstitutionStore`, `CrystalStore`, and `TraceReplayStore`.
`DreamCycleRunner` (used by `DreamScheduler` in the dual-loop) imports
`CodeArchaeologist`, `SelfModel`, and `AdapterManager`. `AgentLoop` imports
`LoopDetector`. `agent-tools.ts` imports `AdversarialTester`.

**Every module originally flagged as "dead" is reachable through active
dual-loop dependency chains.** There is no safe deletion without decoupling first.

## Dependency Map: What Bridges the Two Architectures

These modules are shared between the old single-loop and the new dual-loop:

| Bridge Module | Used by Single-Loop | Used by Dual-Loop via |
|---------------|--------------------|-----------------------|
| `tools/types.ts` | `agent-tools.ts` → `loop.ts` | `deep-loop.ts`, `coordinator.ts`, `state-manager.ts` |
| `dream/runner.ts` | `loop.ts` | `DreamScheduler` → `coordinator.ts` |
| `agent-loop.ts` | `controller.ts` → `loop.ts` | Shared (AgentLoop class) |
| `identity.ts` | `context-manager.ts` | `deep-loop.ts` |
| `agent-tools.ts` | `loop.ts` | Indirectly via `tools/types.ts` |

Because `tools/types.ts` imports store types (ConstitutionStore, CrystalStore,
TraceReplayStore), these stores cannot be deleted without modifying the shared
type interface.

## Revised Plan

### Phase 1: Decouple Shared Types from Store Implementations

**Goal:** Make `tools/types.ts` reference lightweight interfaces instead of
concrete store classes.

1. Extract `ConstitutionStore`, `CrystalStore`, `TraceReplayStore` type
   signatures into a new `src/autonomous/tools/store-interfaces.ts`
2. Update `tools/types.ts` to import from `store-interfaces.ts` instead of
   the concrete modules
3. Update `agent-tools.ts` to import concrete classes only where instantiated
   (not at the type level)
4. Run `npm run check`

### Phase 2: Remove Single-Loop Fallback Path

1. Remove the `else` block in `daemon.ts:621-645`
2. Remove unused imports: `AutonomousLoop`, `loadConfig`, `createProvider`,
   `createAutonomousController`
3. Run `npm run check` to identify newly unreachable code

### Phase 3: Delete Newly Orphaned Single-Loop Modules

After Phase 2, trace the dependency graph again. Modules that become orphaned:

**Likely orphaned (only reachable via loop.ts):**
- `src/autonomous/provider.ts` — legacy 4-phase provider
- `src/autonomous/providers/ollama.ts` — old OllamaProvider
- `src/autonomous/communication/delivery.ts` — MessageDelivery
- `src/autonomous/communication/policy.ts` — MessagePolicy
- `src/autonomous/report.ts` — old formatDailyReport/formatMorningSummary
- `src/autonomous/status-report.ts` — old status formatters
- `src/autonomous/validator.ts` — hypothesis validation
- `src/autonomous/memory-config.ts` — single-loop Zod config
- `src/autonomous/trigger-router.ts` — event→trigger routing

**Requires re-verification (may still be needed via DreamCycleRunner):**
- `src/autonomous/constitution-store.ts` — check if only loop.ts instantiates
- `src/autonomous/crystal-store.ts` — check if only loop.ts instantiates
- `src/autonomous/trace-replay.ts` — check if only loop.ts instantiates

**Must keep (used by DreamCycleRunner → DreamScheduler → dual-loop):**
- `src/autonomous/dream/archaeology.ts` — CodeArchaeologist
- `src/autonomous/dream/self-model.ts` — SelfModel
- `src/autonomous/dream/adapter-manager.ts` — AdapterManager
- `src/autonomous/loop-detector.ts` — LoopDetector (used by AgentLoop)
- `src/autonomous/reasoning/adversarial.ts` — AdversarialTester (used by agent-tools)

**Extract before deleting:**
- `AutonomousController` interface from `controller.ts` → move to
  `src/autonomous/controller-types.ts` (used by `dual-loop-controller.ts`)

### Phase 4: Delete loop.ts Itself

Once all modules that depend solely on `AutonomousLoop` are removed:
1. Delete `src/autonomous/loop.ts`
2. Remove its exports from `src/autonomous/index.ts`
3. Delete associated test files (`tests/autonomous-loop.test.ts`)
4. Run `npm run check`

### Phase 5: Clean Up Barrel Exports

Rebuild `src/autonomous/index.ts` to only re-export what is actually imported
by the dual-loop, daemon, and shared modules.

## Impact Summary (Revised)

| Phase | What | Files Changed | Risk |
|-------|------|--------------|------|
| Phase 1 | Decouple types | 3 modified, 1 new | Low |
| Phase 2 | Remove fallback | 1 modified | Low |
| Phase 3 | Delete orphans | ~9-12 deleted | Medium — requires re-verification |
| Phase 4 | Delete loop.ts | 1 deleted | Low (after Phase 3) |
| Phase 5 | Clean barrel | 1 modified | None |

## Key Lesson

Never trust import-from-outside analysis alone. Always trace full dependency
chains: A → B → C where A is alive means C is alive, even if C has no direct
external importers.
