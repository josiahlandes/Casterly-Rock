# Tyrion Evolution Plan — From Pipeline to Steward

## Overview

This plan transforms Tyrion from a structured pipeline (analyze → hypothesize → implement → validate → reflect) into an autonomous steward with persistent identity, memory, initiative, and self-improvement capability. The changes are organized into six phases, each independently shippable and testable.

**Design principles:**
- Every phase preserves all existing invariants (local-only, privacy-first, quality gates).
- No phase requires the next one to be useful.
- Protected paths are modified only where structurally necessary; each such change is called out.
- `npm run check` must pass after every phase.

**Protected path changes required:**
- `config/autonomous.yaml` — New fields for agent loop, memory, event triggers, hardware.
- `config/models.yaml` — New model entries (specialist, embed) and routing keys.
- `src/providers/*` — New provider capabilities (multi-turn, concurrent, delegation).
- `config/default.yaml` — Hardware utilization settings.
- `docs/rulebook.md` — Updated invariants for agent behavior.
- `docs/subagents.md` — New subagent role for Tyrion's self-governance.

---

## Phase 1: Persistent Identity and Memory

**Goal:** Tyrion becomes a continuous entity that persists across sessions and cycles.

### 1A. World Model (`src/autonomous/world-model.ts`) — NEW FILE

A markdown file (`~/.casterly/world-model.md`) that Tyrion reads at the start of every interaction and updates at the end. Contains:

```
## Codebase Health
- Tests: 47 passing, 0 failing (as of 2026-02-17 03:14)
- TypeScript: 0 errors
- Lint: clean
- Coverage: 82%
- Last commit: a3f2b1c "Fix detector regex anchoring"

## Active Concerns
- detector.test.ts: regex edge case under investigation (2 days)
- orchestrator.ts: 4 remaining `any` casts

## Recent Activity
- Fixed flaky test in security/patterns.ts
- Refactored tool schema validation
```

**Implementation:**
- `WorldModel` class with `load()`, `save()`, `update(section, content)`, `getSummary()`.
- `updateFromCodebase()` method runs `npm run typecheck`, `npm run test`, `git log --oneline -5`, parses results, and overwrites the health section.
- Integrated into `AutonomousLoop.runCycle()` — load at start, save at end.
- Integrated into iMessage daemon — load at start of `processMessage()`.

**Lines of code:** ~200

### 1B. Goal Stack (`src/autonomous/goal-stack.ts`) — NEW FILE

A persistent priority queue stored as `~/.casterly/goals.yaml`.

```yaml
goals:
  - id: goal-001
    source: user        # user | self | event
    priority: 1         # 1 = highest
    description: "Refactor tool orchestrator"
    created: 2026-02-15
    status: in_progress  # pending | in_progress | blocked | done
    attempts: 1
    notes: "Started branch auto/refactor-orchestrator"

  - id: goal-002
    source: self
    priority: 3
    description: "Fix remaining `any` types in orchestrator.ts"
    created: 2026-02-16
    status: pending
    attempts: 0
    notes: ""
```

**Implementation:**
- `GoalStack` class with `load()`, `save()`, `addGoal()`, `getNext()`, `updateGoal()`, `completeGoal()`, `getBySource()`, `prune()`.
- User goals (from iMessage or CLI) always get priority 1.
- Self-generated goals start at priority 3+.
- Aging: goals older than N days without progress get priority bumped.
- Max open goals: 20. Oldest low-priority goals pruned automatically.

**Lines of code:** ~180

### 1C. Issue Log (`src/autonomous/issue-log.ts`) — NEW FILE

Tyrion's self-managed issue tracker at `~/.casterly/issues.yaml`.

```yaml
issues:
  - id: ISS-003
    title: "Flaky regex match in detector.test.ts"
    first_seen: 2026-02-14
    attempts: 2
    last_attempt: 2026-02-16
    last_approach: "Changed regex quantifier — still fails on Unicode input"
    next_idea: "Check if input encoding differs between test and runtime"
    priority: medium
    status: open         # open | investigating | resolved | wontfix
    related_files:
      - src/security/detector.ts
      - src/security/patterns.ts
      - tests/security/detector.test.ts
```

**Implementation:**
- `IssueLog` class with `load()`, `save()`, `fileIssue()`, `updateIssue()`, `resolveIssue()`, `getOpen()`, `getByFile()`, `getStale()`.
- When a hypothesis fails in the agent loop → `fileIssue()` or `updateIssue()` with what was tried.
- When a fix succeeds → `resolveIssue()` with resolution notes.
- Stale detection: issues with no activity for N days flagged for attention.

**Lines of code:** ~170

### 1D. Narrative Identity Prompt (`src/autonomous/identity.ts`) — NEW FILE

A single identity prompt loaded into every interaction context — autonomous, coding, iMessage.

```typescript
export function buildIdentityPrompt(
  worldModel: WorldModelSummary,
  goalStack: GoalSummary[],
  openIssues: IssueSummary[],
  selfModel: SelfModelSummary
): string
```

Generates a prompt like:

> You are Tyrion, the steward of the Casterly codebase. This is your project. You maintain its health, track its issues, and improve it over time. You think before you act. You verify your own work. When you can't fix something, you file an issue and come back to it.
>
> Current state: Tests passing (47/47). No type errors. 2 open issues. Active goal: refactor tool orchestrator.
>
> Your strengths: TypeScript type fixes (90% success). Your weaknesses: complex regex (40% success).

**Integration points:**
- `AutonomousLoop.runCycle()` — prepended to agent system prompt.
- `processMessage()` in iMessage daemon — prepended to system prompt.
- `ContextManager.buildContext()` — available as identity layer.

**Lines of code:** ~100

### 1E. Config Changes (PROTECTED: `config/autonomous.yaml`)

Add new sections:

```yaml
memory:
  world_model_path: ~/.casterly/world-model.md
  goal_stack_path: ~/.casterly/goals.yaml
  issue_log_path: ~/.casterly/issues.yaml
  self_model_path: ~/.casterly/self-model.yaml
  update_on_cycle_end: true
  update_on_session_end: true
  max_open_goals: 20
  max_open_issues: 50
  stale_issue_days: 7
```

**Tests:**
- Unit tests for WorldModel, GoalStack, IssueLog (CRUD, persistence, edge cases).
- Integration test: cycle starts, loads state, updates world model, saves.
- Test: goal priority ordering is correct.
- Test: stale issues are identified.

---

## Phase 2: Agent Loop (ReAct)

**Goal:** Replace the rigid 4-phase pipeline with a reasoning agent that decides its own actions.

### 2A. Agent Loop (`src/autonomous/agent-loop.ts`) — NEW FILE

Replaces the linear `runCycle()` logic. The agent loop:

1. Loads identity prompt + world model + goal stack + issue log.
2. Selects next goal or responds to an event.
3. Enters a reason → act → observe loop (max N turns, configurable).
4. Each turn: LLM receives full conversation history + tool results, returns either a tool call or a "done" signal.
5. On completion: updates world model, goal stack, issue log. Commits if changes were made.

```typescript
export class AgentLoop {
  constructor(
    config: AgentLoopConfig,
    provider: LlmProvider,
    tools: AgentToolkit,
    state: TyrionState  // world model + goals + issues + self-model
  )

  async run(trigger: AgentTrigger): Promise<AgentOutcome> {
    // Build initial context from state
    // Loop: reason → act → observe
    // Update state on completion
  }
}

type AgentTrigger =
  | { type: 'scheduled' }
  | { type: 'event'; event: SystemEvent }
  | { type: 'user'; message: string; sender: string }
  | { type: 'goal'; goal: Goal }
```

**Key design decisions:**
- **Budget-limited:** Each run has a max turn count (default 20) and max token budget.
- **Interruptible:** User messages always preempt autonomous work.
- **Transparent:** Every reasoning step is logged (redacted) for debugging.
- **Tool-driven:** The LLM can't directly modify files — it must use tools that go through validation.

**Lines of code:** ~350

### 2B. Agent Toolkit (`src/autonomous/agent-tools.ts`) — NEW FILE

Tools available to the agent loop. These wrap existing capabilities:

| Tool | Wraps | Purpose |
|------|-------|---------|
| `read_file` | ReadFileExecutor | Read a source file |
| `edit_file` | WriteFileExecutor | Modify a file (search/replace) |
| `create_file` | WriteFileExecutor | Create a new file |
| `grep` | SearchFilesExecutor | Search codebase content |
| `glob` | ListFilesExecutor | Find files by pattern |
| `bash` | BashExecutor | Run shell commands |
| `git` | GitOperations | Git operations |
| `run_tests` | Validator | Execute test suite |
| `typecheck` | Validator | Run TypeScript compiler |
| `delegate` | NEW | Send sub-task to a specific model |
| `file_issue` | IssueLog | Create/update an issue |
| `close_issue` | IssueLog | Resolve an issue |
| `update_goal` | GoalStack | Update goal status |
| `recall` | NEW (Phase 4) | Search past reflections/memory |
| `message_user` | iMessage | Send a message to the user |
| `think` | NO-OP | Explicit reasoning step (logged, no side effects) |

The `think` tool is important — it lets the model explicitly reason without acting, which improves chain-of-thought quality in tool-use contexts.

The `delegate` tool sends a sub-prompt to a specified model:

```typescript
{
  name: 'delegate',
  parameters: {
    model: 'hermes3:70b' | 'qwen3-coder-next' | 'tyrion-specialist',
    task: string,
    context_files: string[]  // files to include in sub-prompt
  }
}
```

This replaces the hardcoded model routing in `config/models.yaml` with agent-driven model selection.

**Lines of code:** ~400

### 2C. Replace `AutonomousLoop.runCycle()` — MODIFY `src/autonomous/loop.ts`

The existing `runCycle()` method (lines 158-261) is replaced with:

```typescript
async runCycle(): Promise<void> {
  const state = await this.loadState();    // world model, goals, issues
  const trigger = this.determineTrigger(); // scheduled, event, or goal-based
  const agentLoop = new AgentLoop(this.config, this.provider, this.tools, state);
  const outcome = await agentLoop.run(trigger);
  await this.saveState(state);
  await this.logOutcome(outcome);
}
```

The existing `attemptHypothesis()`, phase-specific methods, and `PROMPTS` object in `provider.ts` become unused. They are retained temporarily for fallback but marked deprecated.

### 2D. Config Changes (PROTECTED: `config/autonomous.yaml`)

```yaml
agent:
  max_turns_per_cycle: 20
  max_tokens_per_cycle: 50000
  reasoning_model: hermes3:70b        # For planning and judgment
  coding_model: qwen3-coder-next:latest  # For implementation
  think_tool_enabled: true
  delegation_enabled: true
  user_messaging_enabled: true
```

**Tests:**
- Agent loop with mock provider: verify turn-by-turn execution.
- Agent loop respects budget (max turns, max tokens).
- Agent loop correctly routes `delegate` calls to specified model.
- Agent loop updates world model on completion.
- Regression: existing quality gates still enforced via `run_tests` tool.

---

## Phase 3: Event-Driven Awareness

**Goal:** Tyrion responds to events rather than running on a fixed timer.

### 3A. Event System (`src/autonomous/events.ts`) — NEW FILE

```typescript
export type SystemEvent =
  | { type: 'file_changed'; paths: string[]; timestamp: Date }
  | { type: 'test_failed'; testName: string; output: string; timestamp: Date }
  | { type: 'git_push'; branch: string; commits: string[]; timestamp: Date }
  | { type: 'build_error'; error: string; timestamp: Date }
  | { type: 'issue_stale'; issueId: string; daysSinceActivity: number }
  | { type: 'user_message'; sender: string; message: string }
  | { type: 'scheduled'; reason: string }

export class EventBus {
  on(type: string, handler: (event: SystemEvent) => void): void
  emit(event: SystemEvent): void
  getQueue(): SystemEvent[]
  drain(): SystemEvent[]
}
```

**Lines of code:** ~120

### 3B. File Watcher (`src/autonomous/watchers/file-watcher.ts`) — NEW FILE

Uses `fs.watch` (Node native) on `src/`, `tests/`, `config/`.

- Debounces changes (500ms window).
- Ignores `node_modules/`, `dist/`, `.git/`.
- Emits `file_changed` events to the EventBus.
- On change to test files: automatically triggers `test_failed` check.

**Lines of code:** ~100

### 3C. Git Hook Watcher (`src/autonomous/watchers/git-watcher.ts`) — NEW FILE

Monitors `.git/refs/heads/` for branch updates. When a commit lands on main:

- Emits `git_push` event.
- Triggers world model update.

**Lines of code:** ~80

### 3D. Issue Aging Watcher (`src/autonomous/watchers/issue-watcher.ts`) — NEW FILE

Periodic check (every 6 hours) for stale issues:

- Issues with no activity for `stale_issue_days` emit `issue_stale` events.
- These feed into the agent loop as low-priority triggers.

**Lines of code:** ~60

### 3E. Modify `AutonomousLoop` to be Event-Driven — MODIFY `src/autonomous/loop.ts`

Replace the timer-based `while (running) { sleep(interval); runCycle() }` with:

```typescript
async start(): Promise<void> {
  this.eventBus = new EventBus();
  this.startWatchers();

  // Timer still exists as fallback
  this.scheduleTimer();

  // Process events as they arrive
  this.eventBus.on('*', async (event) => {
    if (this.shouldHandle(event)) {
      await this.runCycle({ type: 'event', event });
    }
  });
}
```

**Event priority:**
1. `user_message` — Immediate, interrupts current work.
2. `test_failed` — High, triggers investigation.
3. `build_error` — High, triggers investigation.
4. `file_changed` — Medium, triggers world model update + optional action.
5. `git_push` — Medium, triggers world model update.
6. `issue_stale` — Low, handled during quiet periods.
7. `scheduled` — Lowest, fallback when no events.

**Throttling:** Max 1 agent cycle running at a time. Events queue and are batched if they arrive during an active cycle.

### 3F. Config Changes (PROTECTED: `config/autonomous.yaml`)

```yaml
events:
  file_watcher:
    enabled: true
    paths: [src/, tests/, config/]
    debounce_ms: 500
    ignore: [node_modules/, dist/, .git/]
  git_watcher:
    enabled: true
  issue_watcher:
    enabled: true
    check_interval_hours: 6
  throttle:
    max_concurrent_cycles: 1
    cooldown_seconds: 30     # Min time between cycles
    daily_budget_turns: 500  # Max agent turns per day
```

**Tests:**
- EventBus: emit and receive events correctly.
- File watcher: debouncing works, ignore patterns respected.
- Throttling: concurrent cycle prevention.
- Priority ordering: user messages preempt scheduled cycles.

---

## Phase 4: Tiered Memory and Context Management

**Goal:** Tyrion manages his own context window using MemGPT-style virtual memory.

### 4A. Memory Tiers (`src/autonomous/memory/tiers.ts`) — NEW FILE

```typescript
export interface MemoryTiers {
  hot: HotMemory;    // Always in context: identity, world model, goals (~4k tokens)
  warm: WarmMemory;  // Session-specific: current files, recent tool output (~20k tokens)
  cool: CoolMemory;  // On-demand: past reflections, closed issues (~searchable)
  cold: ColdMemory;  // Archive: full MEMORY.md, old reflections (~searchable)
}
```

**Hot tier** (always loaded):
- Identity prompt
- World model summary (compressed)
- Goal stack (top 5)
- Open issues (top 5)
- Self-model summary

**Warm tier** (agent-managed, in context):
- Files currently being worked on
- Recent tool results
- Current conversation turns
- Working notes from this cycle

**Cool tier** (searchable, loaded on demand):
- Past 30 days of reflections
- Recently closed issues
- Recent MEMORY.md entries

**Cold tier** (archive, loaded on explicit query):
- All reflections
- All historical issues
- Full MEMORY.md
- Git history analysis

### 4B. Recall Tool (`src/autonomous/memory/recall.ts`) — NEW FILE

The `recall` tool from the agent toolkit:

```typescript
{
  name: 'recall',
  parameters: {
    query: string,          // What to search for
    tier: 'cool' | 'cold',  // Which tier to search
    limit: number            // Max results
  }
}
```

**Initial implementation:** Keyword search (grep-based) over structured YAML/JSON files. No vector database needed yet — the volume is manageable with text search.

**Future upgrade path (Phase 6):** Replace keyword search with local embedding model + vector store when reflection volume exceeds text search efficiency.

### 4C. Archive Tool (`src/autonomous/memory/archive.ts`) — NEW FILE

```typescript
{
  name: 'archive',
  parameters: {
    content: string,    // What to save
    tags: string[],     // For later retrieval
    tier: 'cool'        // Where to store (cool is the default deposit tier)
  }
}
```

Tyrion uses this to save working notes, partial analysis, and intermediate results that might be useful later but don't need to stay in context.

### 4D. Context Budget Integration — MODIFY `src/coding/context-manager/manager.ts`

Extend `ContextManager` to understand memory tiers:

- Hot tier content is reserved first (non-evictable).
- Warm tier content is managed by the agent (via tools).
- `getRemainingTokens()` accounts for hot tier reservation.
- `buildContext()` always includes hot tier at the top.

**Lines of code (total Phase 4):** ~500

**Tests:**
- Memory tiers load/save correctly.
- Recall returns relevant results for known queries.
- Archive persists and is recallable.
- Hot tier is always present in context.
- Token budget correctly reserves hot tier space.

---

## Phase 5: Hardware Maximization

**Goal:** Use the Mac Studio's 128GB unified memory and M4 Max compute effectively.

### 5A. Always-Hot Models — MODIFY `config/models.yaml` (PROTECTED)

```yaml
models:
  coding:
    provider: ollama
    model: qwen3-coder-next:latest
    context_length: 32768
    temperature: 0.1
    keep_alive: -1          # Never unload

  primary:
    provider: ollama
    model: hermes3:70b
    context_length: 32768
    temperature: 0.7
    keep_alive: -1          # Never unload

  # Future: specialist model from self-distillation
  specialist:
    provider: ollama
    model: tyrion-specialist:latest
    context_length: 32768
    temperature: 0.2
    keep_alive: -1
    enabled: false          # Enabled after first training run

hardware:
  platform: mac-studio-m4-max
  memory_gb: 128
  max_concurrent_models: 3  # Updated from 2
  target_memory_usage_pct: 70  # Leave 30% headroom
```

### 5B. Concurrent Inference (`src/providers/concurrent.ts`) — NEW FILE

Wraps the OllamaProvider to support parallel requests:

```typescript
export class ConcurrentProvider {
  constructor(providers: Map<string, LlmProvider>)

  // Send to specific model
  async generate(model: string, request: GenerateRequest): Promise<Response>

  // Send same prompt to multiple models, return all results
  async parallel(models: string[], request: GenerateRequest): Promise<Map<string, Response>>

  // Send same prompt to N models, return best (judged by a third)
  async bestOfN(models: string[], request: GenerateRequest, judge: string): Promise<Response>
}
```

This enables:
- **Delegation:** Agent loop on hermes3, coding tasks on qwen3 — simultaneously.
- **Speculative execution:** Two approaches tried in parallel.
- **Best-of-N:** Generate N solutions, verify each, keep the best.

### 5C. Test-Time Compute Scaling (`src/autonomous/reasoning/scaling.ts`) — NEW FILE

Implements difficulty-adaptive reasoning:

```typescript
export class ReasoningScaler {
  // Assess problem difficulty from context
  assessDifficulty(problem: string, context: string[]): 'easy' | 'medium' | 'hard'

  // Easy: single generation, verify once
  // Medium: generate 2 candidates, pick better
  // Hard: generate 4 candidates, tree search with verification
  async solve(
    problem: string,
    difficulty: Difficulty,
    provider: ConcurrentProvider
  ): Promise<Solution>
}
```

**Integration:** The agent loop calls `assessDifficulty()` before implementation steps. Easy problems go straight to qwen3. Hard problems get parallel candidate generation and verification.

### 5D. Adversarial Self-Testing (`src/autonomous/reasoning/adversarial.ts`) — NEW FILE

After generating code, Tyrion attacks it:

```typescript
export class AdversarialTester {
  // Generate adversarial inputs using the reasoning model
  async generateAttacks(
    code: string,
    functionSignature: string,
    provider: LlmProvider  // hermes3 — the reasoner
  ): Promise<TestCase[]>

  // Run attacks using the test framework
  async executeAttacks(
    testCases: TestCase[],
    targetFile: string
  ): Promise<AttackResult[]>
}
```

Flow:
1. Tyrion writes code (qwen3).
2. Adversarial tester generates edge cases (hermes3).
3. Edge cases are executed.
4. Failures feed back into the agent loop for fixing.

### 5E. Config Changes (PROTECTED: `config/default.yaml`)

```yaml
hardware:
  concurrent_inference: true
  test_time_scaling: true
  adversarial_testing: true
  max_parallel_generations: 4
  bestofn_judge_model: hermes3:70b
```

**Lines of code (total Phase 5):** ~600

**Tests:**
- ConcurrentProvider dispatches to correct models.
- Parallel generation returns results from all models.
- ReasoningScaler selects appropriate strategy per difficulty.
- AdversarialTester generates and runs test cases.
- Memory stays within budget under concurrent load.

---

## Phase 6: Dream Cycles and Self-Improvement

**Goal:** Tyrion uses quiet hours for strategic consolidation, exploration, and growth.

### 6A. Dream Cycle Runner (`src/autonomous/dream/runner.ts`) — NEW FILE

During quiet hours, instead of normal agent cycles:

```typescript
export class DreamCycleRunner {
  async run(): Promise<DreamOutcome> {
    await this.consolidateReflections();   // Find patterns across recent reflections
    await this.updateWorldModel();          // Full codebase health check
    await this.reorganizeGoals();           // Reprioritize based on new information
    await this.explore();                   // Read unfamiliar code, build understanding
    await this.updateSelfModel();           // Recalculate strengths/weaknesses
    await this.writeRetrospective();        // Weekly summary to MEMORY.md
  }
}
```

### 6B. Self-Model (`src/autonomous/dream/self-model.ts`) — NEW FILE

Computed from historical data:

```typescript
export class SelfModel {
  // Recalculate from issue log + reflections
  async rebuild(issues: Issue[], reflections: Reflection[]): Promise<void>

  getStrengths(): SkillAssessment[]     // >70% success rate
  getWeaknesses(): SkillAssessment[]    // <50% success rate
  getRecommendation(taskType: string): string  // "Be careful with regex"
}
```

Stored at `~/.casterly/self-model.yaml`.

### 6C. Code Archaeology (`src/autonomous/dream/archaeology.ts`) — NEW FILE

During exploration phase of dream cycles:

```typescript
export class CodeArchaeologist {
  // Analyze git history for a file
  async analyzeFileHistory(path: string): Promise<FileHistory>

  // Find fragile code (frequently changed/fixed)
  async findFragileCode(): Promise<FragileFile[]>

  // Find abandoned code (not touched in N months)
  async findAbandonedCode(months: number): Promise<string[]>

  // Build narrative of recent project evolution
  async buildNarrative(days: number): Promise<string>
}
```

Results feed into the world model and goal stack. Fragile files get flagged for investigation. Abandoned code gets flagged for cleanup or removal.

### 6D. Self-Distillation Pipeline (Future — Design Only)

This phase documents the pipeline but does not implement training. Implementation depends on accumulating sufficient training data (target: 1,000+ high-quality examples).

**Data collection** (starts immediately in Phase 2):
- Every successful agent loop run saves its reasoning trace to `~/.casterly/training-data/traces.jsonl`.
- Format: `{ problem, reasoning_steps[], tool_calls[], outcome, verification }`
- Only successful, verified outcomes are saved.
- Traces include tool usage patterns (not just reasoning).

**Training pipeline** (future implementation):
1. Curate: filter low-confidence traces, deduplicate.
2. Format: convert to instruction-following format for QLoRA.
3. Fine-tune: 32B base model via MLX on Apple Silicon.
4. Benchmark: test against held-out examples.
5. Deploy: export as GGUF, import to Ollama as `tyrion-specialist:latest`.

### 6E. Config Changes (PROTECTED: `config/autonomous.yaml`)

```yaml
dream:
  enabled: true
  consolidation_interval_hours: 24
  exploration_budget_turns: 50
  self_model_rebuild_interval_hours: 48
  archaeology_lookback_days: 90
  retrospective_interval_days: 7

training_data:
  enabled: true
  path: ~/.casterly/training-data/
  format: jsonl
  save_successful_traces: true
  save_tool_usage: true
  min_confidence_to_save: 0.7
```

**Tests:**
- Dream cycle runner executes all phases.
- Self-model correctly computes success rates from historical data.
- Code archaeology identifies frequently-changed files.
- Training data is saved in correct format.

---

## Phase 7: Communication — Proactive iMessage

**Goal:** Tyrion initiates communication with taste and judgment.

### 7A. Message Policy (`src/autonomous/communication/policy.ts`) — NEW FILE

Controls when Tyrion messages the user:

```typescript
export class MessagePolicy {
  shouldNotify(event: NotifiableEvent): boolean
  formatMessage(event: NotifiableEvent): string
  getThrottle(): { maxPerHour: number; maxPerDay: number; quietHours: boolean }
}

type NotifiableEvent =
  | { type: 'fix_complete'; description: string; branch: string }
  | { type: 'test_failure'; test: string; investigating: boolean }
  | { type: 'decision_needed'; question: string; options: string[] }
  | { type: 'daily_summary'; stats: WorldModelSummary }
```

**Rules:**
- Max 3 messages per hour, 10 per day.
- Never during user-configured quiet hours.
- Failures: only notify if Tyrion can't fix them himself.
- Successes: brief, factual. "Fixed flaky detector test. Merged to main."
- Decisions: only when Tyrion genuinely can't proceed without input.

### 7B. Integration with iMessage Daemon — MODIFY `src/imessage/daemon.ts`

Add outbound messaging capability:

```typescript
// Existing: receive and respond
// New: initiate messages
async function notifyUser(recipient: string, message: string): Promise<void>
```

The `message_user` tool in the agent toolkit routes through this + the MessagePolicy filter.

**Lines of code (total Phase 7):** ~250

**Tests:**
- Message policy respects throttle limits.
- Quiet hours block notifications.
- Message formatting is concise and useful.

---

## Implementation Order and Dependencies

```
Phase 1 ─── Persistent Identity & Memory (no dependencies)
   │
Phase 2 ─── Agent Loop (depends on Phase 1)
   │
   ├── Phase 3 ─── Event-Driven Awareness (depends on Phase 2)
   │
   ├── Phase 4 ─── Tiered Memory (depends on Phase 1 + 2)
   │
   └── Phase 5 ─── Hardware Maximization (depends on Phase 2)
          │
       Phase 6 ─── Dream Cycles (depends on Phase 2 + 4 + 5)
          │
       Phase 7 ─── Communication (depends on Phase 2 + 3)
```

Phases 3, 4, and 5 can be developed in parallel after Phase 2 is complete.

## File Count Summary

| Phase | New Files | Modified Files | Estimated Lines |
|-------|-----------|----------------|-----------------|
| 1. Identity & Memory | 4 | 2 | ~650 |
| 2. Agent Loop | 2 | 1 | ~750 |
| 3. Event System | 4 | 1 | ~360 |
| 4. Tiered Memory | 3 | 1 | ~500 |
| 5. Hardware | 3 | 2 | ~600 |
| 6. Dream Cycles | 4 | 1 | ~500 |
| 7. Communication | 1 | 1 | ~250 |
| **Total** | **21** | **9** | **~3,610** |

## Invariants Preserved

Every phase maintains:
1. All inference local via Ollama — no cloud APIs.
2. All user data stays on machine.
3. Logging through safe redaction.
4. Quality gates (`npm run check`) pass.
5. Protected paths only modified with explicit documentation.
6. Security patterns and detection unchanged.

## Subagent Flow for Implementation

Per `docs/subagents.md`, each phase follows:
1. **System Architect** — Confirm approach preserves invariants.
2. **Provider Specialist** — For Phases 2, 5 (provider changes).
3. **Security Reviewer** — Every phase (verify no data exfiltration paths).
4. **Test Engineer** — Every phase (tests written alongside implementation).
5. **Quality Gates Enforcer** — `npm run check` after every phase.

## Rulebook Updates Required

After implementation, `docs/rulebook.md` needs:
- New invariant: "Tyrion's persistent state (~/.casterly/) is private and local."
- New invariant: "Agent loop budget limits are enforced and non-bypassable."
- New invariant: "User messages always preempt autonomous work."
- Updated model selection section to reflect agent-driven delegation.

## Subagent Updates Required

After implementation, `docs/subagents.md` needs:
- New subagent role: **Tyrion Behavior Reviewer** — Reviews changes to identity prompts, goal stack logic, and communication policy for coherence and taste.
