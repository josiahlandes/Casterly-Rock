# Implementation Plan: StateManager for Dual-Loop State Bridging

## Problem

The AutonomousLoop owns ~38 stores/components. DeepLoop currently only accesses 2 of them
(`GoalStack` via `setGoalStack()`, `SkillFilesManager` via `setSkillFilesManager()`). The
remaining ~30 stateful stores are invisible to DeepLoop, which means the planner and
reviewer phases can't leverage memory, world model, self-knowledge, or context that the
autonomous system has accumulated.

**Critical constraint from the user**: When DeepLoop is in *coder mode* (the `dispatchToCoder`
execution phase), the prompt should be lean — only project data and the coding prompt. The
coder does NOT need access to memory, world model, user info, etc. Those stores are only
relevant to the *planner* and *reviewer* phases.

## Architecture Decision

Introduce a `StateManager` class that:
1. Owns the lifecycle (load/save) of all persistent stores
2. Exposes **role-scoped views** so each DeepLoop phase gets only what it needs
3. Is shared between AutonomousLoop and DeepLoop (single source of truth)

### Role-Scoped Views

| View | Who uses it | What's included | What's excluded |
|------|-------------|-----------------|-----------------|
| `PlannerView` | `planTask()` | WorldModel, GoalStack, IssueLog, SkillFilesManager, ContextManager, Journal, PromptStore, GraphMemory, LinkNetwork, SelfModel summary | Raw user data, communication stores, training stores |
| `CoderView` | `dispatchToCoder()` / `executeStep()` | Project dir, workspace manifest, step context, toolkit | Everything else — no memory, no world model, no user info |
| `ReviewerView` | `selfReviewTask()` | WorldModel (read-only), GoalStack (read-only), IssueLog (read-only) | Memory evolution, training, communication |
| `FullView` | AutonomousLoop agent cycle, DreamCycleRunner | All stores (current `AgentState`) | Nothing excluded |

The `CoderView` is intentionally minimal — it's a type with just `projectDir`, `manifest`,
and `toolkit`. The coder prompt construction in `dispatchToCoder` and `executeStep` stays
exactly as-is. No memory/world-model/user data leaks into coder prompts.

## Files to Create

### 1. `src/state/state-manager.ts` (NEW)

The central store registry and lifecycle manager.

```typescript
export class StateManager {
  // All store instances (private)
  private stores: AllStores;

  constructor(config: StateManagerConfig) { /* instantiate all stores */ }

  async load(): Promise<void>   { /* parallel load via Promise.all */ }
  async save(): Promise<void>   { /* parallel save via Promise.all */ }

  // Role-scoped accessors
  plannerView(): PlannerView    { /* return subset */ }
  coderView(): CoderView        { /* return minimal project-only subset */ }
  reviewerView(): ReviewerView  { /* return read-only subset */ }
  fullView(): AgentState        { /* return everything (AutonomousLoop compat) */ }

  // Individual store access (for wiring that needs specific stores)
  get goalStack(): GoalStack { ... }
  get worldModel(): WorldModel { ... }
  get skillFilesManager(): SkillFilesManager { ... }
  // ... etc for each store
}
```

### 2. `src/state/views.ts` (NEW)

Type definitions for the role-scoped views.

```typescript
/** What the planner sees — rich context for planning decisions */
export interface PlannerView {
  worldModel: WorldModel;         // Current project/env understanding
  goalStack: GoalStack;           // Active goals for idle work
  issueLog: IssueLog;             // Known issues to consider
  skillFiles: SkillFilesManager;  // Learned skills as prior art
  contextManager: ContextManager; // Accumulated context
  journal: Journal;               // Recent activity history
  graphMemory: GraphMemory;       // Relational knowledge
  linkNetwork: LinkNetwork;       // Zettelkasten connections
  promptStore?: PromptStore;      // Evolved prompts (tier 2)
  selfModelSummary?: string;      // Self-assessment summary (not full SelfModel)
}

/** What the coder sees — project data only, no agent memory */
export interface CoderView {
  projectDir: string | null;
  toolkit: AgentToolkit | null;
}

/** What the reviewer sees — read-only state for context-aware review */
export interface ReviewerView {
  readonly worldModel: WorldModel;
  readonly goalStack: GoalStack;
  readonly issueLog: IssueLog;
}
```

### 3. `src/state/store-registry.ts` (NEW)

Factory functions and the `AllStores` type. Extracts the store instantiation logic
currently spread across the AutonomousLoop constructor (lines 264-388) into a
declarative registry.

```typescript
export interface AllStores {
  // Core
  worldModel: WorldModel;
  goalStack: GoalStack;
  issueLog: IssueLog;
  journal: Journal;
  // Memory
  linkNetwork: LinkNetwork;
  memoryEvolution: MemoryEvolution;
  // ... all ~38 stores
}

export function createAllStores(config: StoreConfig): AllStores { ... }
export function loadableStores(stores: AllStores): Array<{ load(): Promise<void> }> { ... }
export function savableStores(stores: AllStores): Array<{ save(): Promise<void> }> { ... }
```

## Files to Modify

### 4. `src/autonomous/loop.ts` — Refactor to use StateManager

**Before**: AutonomousLoop owns 38 fields, has its own `loadState()`/`saveState()`.

**After**: AutonomousLoop receives a `StateManager` (or creates one internally), delegates
load/save/fullView to it.

Changes:
- Constructor accepts optional `StateManager` instance
- Replace 38 individual fields with `this.stateManager`
- Replace `loadState()` body with `this.stateManager.load()`
- Replace `saveState()` body with `this.stateManager.save()`
- Replace `AgentState` construction (lines 807-858) with `this.stateManager.fullView()`
- Keep `DreamCycleRunner` wiring — it gets stores from `stateManager.fullView()`

### 5. `src/dual-loop/deep-loop.ts` — Accept StateManager, use PlannerView

**Before**: DeepLoop has `setGoalStack()` and `setSkillFilesManager()` — two ad-hoc setters.

**After**: DeepLoop receives a `StateManager` reference in its constructor.

Changes:
- Constructor gains `stateManager?: StateManager` parameter
- Remove `setGoalStack()` and `setSkillFilesManager()` setters
- In `planTask()`: call `this.stateManager.plannerView()` to get rich context
  - Inject world model summary, goal context, memory graph context into planning prompt
  - Keep skill injection logic (move it to use `plannerView.skillFiles`)
- In `executeStep()` and `dispatchToCoder()`: **NO CHANGES to prompt construction**
  - The coder prompt stays exactly as-is — project data + coding instructions only
  - `CoderView` is not even passed to these methods; they already have what they need
- In `selfReviewTask()`: optionally enrich review with `reviewerView()` context
  - E.g., reviewer can check if the code aligns with known issues or goals
- In `runIdleCheck()`: use `stateManager.goalStack` instead of `this.goalStack`

### 6. `src/autonomous/agent-tools.ts` — Minor: derive AgentState from StateManager

- `AgentState` interface stays the same (no breaking change)
- Add a helper: `export function stateManagerToAgentState(sm: StateManager): AgentState`

## What Changes in Each DeepLoop Phase

### Planning Phase (`planTask`)
**Before**: Gets `originalMessage`, `triageNotes`, `PROJECT.md`, `skillContext`.
**After**: Additionally gets:
- World model summary (1-2 paragraphs of project/env context)
- Active goals summary (from GoalStack)
- Recent journal entries (last 3-5, for continuity)
- Graph memory relevant nodes (if query matches)
- Self-model summary (strengths/weaknesses for planning)

These are injected as new `## sections` in the planning prompt, before the user request.
Total added context: ~500-1500 tokens, well within the `standard` tier budget.

### Step Execution / Coder Phase (`executeStep` + `dispatchToCoder`)
**Before**: Step description, step context, workspace manifest, prior outputs, upcoming steps.
**After**: **IDENTICAL. No changes.** The coder sees only project data and coding instructions.

This is the key insight: the coder doesn't benefit from knowing the world model or user
preferences. It needs precise, scoped coding instructions. Adding memory/goals would
waste context window and confuse the model.

### Review Phase (`selfReviewTask`)
**Before**: Plan, artifacts, manifest, originalMessage.
**After**: Additionally gets (appended to review prompt):
- Known issues from IssueLog (so reviewer can flag if the code re-introduces a known issue)
- Active goals (so reviewer can check alignment)

~200-400 tokens added. Minimal cost, meaningful signal.

### Revision Phase (`processRevision`)
**No changes.** Revision is feedback-driven — it already has what it needs.

## Tests to Add

### `tests/state/state-manager.test.ts` (NEW)
- `load()` calls load on all stateful stores in parallel
- `save()` calls save on all stateful stores in parallel
- `plannerView()` returns correct subset
- `coderView()` returns only projectDir + toolkit
- `reviewerView()` returns read-only references
- `fullView()` returns complete AgentState
- Conditional stores (Vision Tier 2/3) are included only when enabled

### `tests/dual-loop/deep-loop-state.test.ts` (NEW)
- Planning prompt includes world model summary when StateManager is provided
- Planning prompt includes goal context when StateManager is provided
- Coder prompt does NOT include world model, memory, or user data
- Review prompt includes issue log context when StateManager is provided
- DeepLoop works without StateManager (backwards compat — all views return empty/null)

## Migration Strategy

1. **Phase 1**: Create `StateManager` and views — no existing code changes
2. **Phase 2**: Wire StateManager into AutonomousLoop (behind the scenes — same external behavior)
3. **Phase 3**: Wire StateManager into DeepLoop, enrich planner/reviewer prompts
4. **Phase 4**: Remove old `setGoalStack()`/`setSkillFilesManager()` setters
5. Run `npm run check` after each phase

## Risk Assessment

- **Low risk**: CoderView is intentionally empty — coder prompts don't change at all
- **Low risk**: StateManager is additive — AutonomousLoop's behavior doesn't change
- **Medium risk**: Enriched planning prompts could cause the planner to produce different
  (hopefully better) plans. The planning system prompt is already well-structured with
  JSON output format, so additional context sections should be handled gracefully.
- **Mitigation**: All new context injections are guarded by `if (stateManager)` checks,
  so DeepLoop works identically without a StateManager (full backwards compatibility).

## Summary

The StateManager creates a clean separation between "what exists" (all stores) and
"what each role sees" (scoped views). The coder stays lean and focused on code. The
planner and reviewer get the rich context they need to make informed decisions. No
god objects, no prompt bloat in the coder phase.
