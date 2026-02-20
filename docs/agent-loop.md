# Agent Loop

> **Source**: `src/autonomous/agent-loop.ts`, `src/autonomous/loop.ts`
> **Entry point**: `AgentLoop.run(trigger)`

The agent loop is a ReAct (Reason → Act → Observe) cycle engine. It receives a trigger, loads persistent state, builds an identity-aware prompt, then loops — calling the LLM, executing any tool calls, and feeding results back — until the LLM signals completion or a budget is exhausted.

## Lifecycle

```
Trigger arrives (user message, event, scheduled, goal)
    │
    ▼
Load state (world model, goals, issues, journal)
    │
    ▼
Build context
  ├─ Hot tier: identity prompt (who Tyrion is, world state, goals, issues)
  ├─ Warm tier: session working memory (populated during cycle)
  └─ Handoff note: what previous cycle left behind
    │
    ▼
Build system prompt (task description + tool schemas)
    │
    ▼
┌─── ReAct loop (up to maxTurns) ──────────────────────┐
│  1. Check abort signal, token budget, turn limit       │
│  2. Call LLM via provider.generateWithTools()          │
│  3. If tool calls → execute, accumulate results, loop  │
│  4. If no tool calls → done (text response = summary)  │
└────────────────────────────────────────────────────────┘
    │
    ▼
Write handoff note to journal
    │
    ▼
Return AgentOutcome
```

## Triggers

The loop accepts four trigger types:

| Type | Source | Priority |
|------|--------|----------|
| `user` | Direct user message (iMessage, CLI) | Highest — preempts running cycles |
| `event` | System event (file change, test failure, git push) | Varies by event type |
| `goal` | Continue work on a goal from the goal stack | Normal |
| `scheduled` | Background autonomous work (periodic) | Lowest |

```typescript
type AgentTrigger =
  | { type: 'scheduled' }
  | { type: 'event'; event: AgentEvent }
  | { type: 'user'; message: string; sender: string }
  | { type: 'goal'; goal: Goal }
```

Triggers are normalized by the trigger router (`src/autonomous/trigger-router.ts`) before reaching the loop. See [docs/triggers.md](triggers.md) for details.

## State Loading

At the start of each cycle, `AutonomousLoop.loadState()` loads all persistent state in parallel:

```typescript
await Promise.all([
  this.worldModel.load(),    // ~/.casterly/world-model.yaml
  this.goalStack.load(),     // ~/.casterly/goals.yaml
  this.issueLog.load(),      // ~/.casterly/issues.yaml
  this.journal.load(),       // ~/.casterly/journal.jsonl
])
```

Then `AgentLoop.run()` builds the identity prompt from this state and appends the most recent journal handoff note.

## Identity Prompt

Built by `src/autonomous/identity.ts`. Defines who Tyrion is for the current cycle.

Components:
1. **Character prompt** — fixed personality and behavioral guidelines
2. **World model summary** — codebase health (typecheck, tests, lint status), recent activity
3. **Goal stack summary** — active goals with status and progress
4. **Issue log summary** — open issues with severity and attempt history
5. **Self-model summary** — strengths, weaknesses, patterns (Phase 6)
6. **Crystallized knowledge** — permanent insights from `CrystalStore`, sorted by confidence (Vision Tier 1)
7. **Operational rules** — self-authored constitutional rules from `ConstitutionStore`, with success rates (Vision Tier 1)

Budget: ~4000 characters (configurable via `IdentityConfig.maxChars`). Crystals and constitution each have a 500-token sub-budget within the hot tier.

The handoff note from the previous cycle is appended after the identity prompt:

```typescript
if (this.journal) {
  const handoff = this.journal.getHandoffNote()
  if (handoff) {
    identityPrompt += `\n\n## Last Session Handoff (${handoff.timestamp.split('T')[0]})\n${handoff.content}`
  }
}
```

## Context Manager: Tiered Memory

`src/autonomous/context-manager.ts` manages a 4-tier memory hierarchy:

| Tier | Budget | Content | Persistence |
|------|--------|---------|-------------|
| **Hot** | ~2k tokens | Identity prompt + crystals + constitution — always in context, never evicted | Rebuilt each cycle from live state |
| **Warm** | ~20k tokens | Session working memory — tool results, working notes | In-memory only, cleared between cycles |
| **Cool** | On-demand | Past 30 days of archived notes | Disk (JSONL store) |
| **Cold** | Archive | Full historical archive | Disk (JSONL store) |

Warm tier uses LRU eviction when its budget is exceeded. During the cycle, significant tool results are automatically added:

```typescript
const significantTools = new Set([
  'read_file', 'search_code', 'run_tests', 'run_command',
  'recall', 'adversarial_test',
])
```

Outputs are truncated to 4000 characters before storage.

## Tool Execution

Tools are provided by `AgentToolkit` (`src/autonomous/agent-tools.ts`), which defines both the schemas (sent to the LLM) and the executors.

During each turn, tool calls are executed sequentially:

```typescript
for (const toolCall of response.toolCalls) {
  const result = await this.toolkit.execute(toolCall)
  toolResults.push(result)
  this.trackStateChanges(toolCall, result, ...)
}
```

Tool output is capped at 10,000 characters. See [docs/skills-and-tools.md](skills-and-tools.md) for the full tool catalog.

### Available Tool Categories

| Category | Tools |
|----------|-------|
| File ops | `read_file`, `edit_file`, `create_file` |
| Search | `grep`, `glob` |
| System | `bash` (timeout: 120s default) |
| Quality | `run_tests`, `typecheck`, `lint` |
| Git | `git_status`, `git_diff`, `git_commit`, `git_log` |
| State | `file_issue`, `close_issue`, `update_goal` |
| Reasoning | `think` (no-op for explicit reasoning), `delegate` |
| Memory | `recall`, `archive`, `recall_journal`, `consolidate`, `save_note` |
| Self-knowledge | `crystallize`, `dissolve`, `list_crystals`, `create_rule`, `update_rule`, `list_rules`, `replay`, `compare_traces`, `search_traces` |
| Self-improvement | `edit_prompt`, `revert_prompt`, `get_prompt`, `shadow`, `list_shadows`, `create_tool`, `manage_tools`, `list_custom_tools` |
| Advanced self-improvement | `run_challenges`, `challenge_history`, `evolve_prompt`, `evolution_status`, `extract_training_data`, `list_adapters`, `load_adapter` |
| Pipeline control | `meta` |
| Promoted pipeline | `classify`, `plan`, `verify` |
| Introspection | `peek_queue`, `check_budget`, `list_context`, `review_steps`, `assess_self` |
| Context control | `load_context`, `evict_context`, `set_budget` |
| Self-initiated triggers | `schedule`, `list_schedules`, `cancel_schedule` |
| Semantic memory | `semantic_recall` |
| Parallel reasoning | `parallel_reason` |
| World | `update_world_model`, `adversarial_test` |
| Dream cycle phases | `consolidate_reflections`, `reorganize_goals`, `explore_codebase`, `rebuild_self_model`, `write_retrospective` |
| Advanced memory (A-MEM) | `link_memories`, `get_links`, `traverse_links` |
| Communication | `message_user` (placeholder) |

### Path Security

File operations are restricted:
- **Allowed directories**: `src/`, `scripts/`, `tests/`, `config/`, `skills/`
- **Forbidden patterns**: `**/*.env*`, `**/credentials*`, `**/secrets*`, `**/.git/**`

## Delegation

The agent can spawn sub-tasks to a different model via the `delegate` tool:

```typescript
{
  "name": "delegate",
  "input": {
    "model": "qwen3-coder-next:latest",
    "task": "Review this code for security issues",
    "context_files": ["src/security/validator.ts"]
  }
}
```

The delegate receives **no tools** — it only generates text. This keeps sub-tasks simple and bounded.

## Stop Conditions

The loop terminates when any of these conditions is met:

| Condition | Stop Reason |
|-----------|-------------|
| LLM returns no tool calls | `completed` |
| Token budget exceeded | `max_tokens` |
| Max turns reached | `max_turns` |
| Abort signal fired (e.g. user message preempts) | `aborted` |
| Exception thrown | `error` |

Token estimation: `Math.ceil(text.length / 3.5)`.

## Outcome

Every cycle returns an `AgentOutcome`:

```typescript
interface AgentOutcome {
  trigger: AgentTrigger
  success: boolean
  stopReason: 'completed' | 'max_turns' | 'max_tokens' | 'aborted' | 'error'
  summary: string
  turns: AgentTurn[]
  totalTurns: number
  totalTokensEstimate: number
  durationMs: number
  startedAt: string
  endedAt: string
  filesModified: string[]
  issuesFiled: string[]
  goalsUpdated: string[]
  error?: string
}
```

## Handoff Notes

At the end of each cycle, the outcome summary is written to the journal as a `handoff` entry:

```typescript
await this.journal.append({
  type: 'handoff',
  content: outcome.summary,
  tags: [outcome.stopReason, trigger.type, ...],
  cycleId: this.config.cycleId,
  triggerType: trigger.type,
})
```

The next cycle loads this handoff note and appends it to the identity prompt, creating continuous memory across cycles.

## Event Preemption

When the loop is running autonomously and a user message arrives:

1. The active cycle is aborted (`stopReason: 'aborted'`)
2. A new cycle starts with the user message as trigger
3. User messages always take priority (event priority 0)

Safeguards prevent tight loops:
- **Cooldown**: minimum time between cycles
- **Daily budget**: maximum turns per day (`dailyBudgetTurns`)

## Default Configuration

```typescript
{
  maxTurns: 20,
  maxTokensPerCycle: 50_000,
  reasoningModel: 'hermes3:70b',
  codingModel: 'qwen3-coder-next:latest',
  thinkToolEnabled: true,
  delegationEnabled: true,
  userMessagingEnabled: false,
  temperature: 0.2,
  maxResponseTokens: 4096,
}
```

Overrideable by passing `Partial<AgentLoopConfig>` to the constructor.

## Key Files

| File | Purpose |
|------|---------|
| `src/autonomous/agent-loop.ts` | `AgentLoop` class — the ReAct cycle engine (779 lines) |
| `src/autonomous/loop.ts` | `AutonomousLoop` — orchestrates cycles, manages state persistence, handles events |
| `src/autonomous/agent-tools.ts` | `AgentToolkit` — 74 tool schemas and executors |
| `src/autonomous/identity.ts` | Identity prompt builder |
| `src/autonomous/context-manager.ts` | 4-tier memory hierarchy |
| `src/autonomous/journal.ts` | Append-only JSONL journal |
| `src/autonomous/goal-stack.ts` | Goal tracking and progression |
| `src/autonomous/issue-log.ts` | Self-managed issue tracker |
| `src/autonomous/world-model.ts` | Persistent world state |
| `src/autonomous/events.ts` | Event types and priority system |
| `src/autonomous/trigger-router.ts` | Trigger normalization |

---

## Vision Reconciliation Notes — IMPLEMENTED

The agent loop is the closest module to the vision's target architecture. It is already a ReAct loop where the LLM decides what to do. All reconciliation items below have been implemented.

### 1. Remove the `agent_loop.enabled` toggle — IMPLEMENTED

**Current:** `config/autonomous.yaml` has `agent_loop.enabled: false` (line 105). `src/autonomous/loop.ts` (line 199) checks `this.useAgentLoop = agentConfig?.enabled ?? false` and falls back to the legacy 4-phase pipeline when disabled.

**Why change:** The vision says "the agent loop is the only execution path." There should be no toggle — the agent loop is always active. The legacy pipeline is retired.

**What to do:** Remove the `enabled` flag from config. Remove the `useAgentLoop` conditional in `loop.ts`. Delete the legacy 4-phase fallback code path.

> **Status:** `agent_loop.enabled` toggle removed. Legacy 4-phase fallback deprecated (`runCycle` marked `@deprecated`). `runAgentCycle` is the sole execution path.

### 2. Make the agent loop the entry point for ALL triggers, including iMessage — IMPLEMENTED

**Current:** iMessage messages arrive at `src/imessage/daemon.ts`, which calls `processChatMessage()` in `src/pipeline/process.ts`. This is a completely separate execution path from the agent loop — it runs the classify → task manager pipeline or a flat tool loop.

**Why change:** The vision says "responding to a user message, noticing a file change, consolidating memory [...] are all the same thing: the LLM receiving a trigger, deciding what to do, and doing it." User messages should flow through `triggerFromMessage()` → agent loop, not a separate pipeline.

**What to do:** Modify the iMessage daemon to emit user triggers via the event bus (or call the agent loop directly) rather than calling `processChatMessage()`. Remove `src/pipeline/process.ts` as a separate entry point.

> **Status:** iMessage routed through trigger system. `user_message` events emitted to EventBus.

### 3. Convert pipeline stages into agent tools — IMPLEMENTED

**Current:** The classifier, planner, runner, and verifier are hardcoded stages in `src/tasks/manager.ts`. The agent loop has no access to them as tools.

**Why change:** The vision says classification, planning, and verification are "tools and strategies the LLM invokes based on its judgment." A simple question shouldn't go through planning. A complex task should be planned. The LLM decides.

**What to do:** Create agent tools: `classify_task` (wraps `classifyMessage()`), `plan_task` (wraps `createTaskPlan()`), `verify_outcome` (wraps `verifyTaskOutcome()`). Add them to `AgentToolkit`. The system prompt should suggest the default workflow but not enforce it.

> **Status:** Pipeline stages available as agent tools (`classify`, `plan`, `verify`). 5 dream cycle phases also converted to agent tools (`consolidate_reflections`, `reorganize_goals`, `explore_codebase`, `rebuild_self_model`, `write_retrospective`). Total tools: 74.

### 4. Add introspection tools — IMPLEMENTED

**Current:** The agent loop tracks budget (turns, tokens) internally but doesn't expose this to the LLM. The self-model is loaded into the hot tier passively but isn't queryable as a tool.

**Why change:** The vision's Phase 3 (Introspection Tools) says "a model that can see its own state makes better decisions." The LLM needs tools like `check_budget`, `peek_queue`, `list_context`, `review_steps`, `assess_self`.

**What to do:** Add introspection tools to `AgentToolkit`. These are read-only — they expose internal state to the LLM without mutating anything.

> **Status:** Introspection tools implemented (Roadmap Phase 3).

### 5. Remove the `autonomous.enabled` master switch — IMPLEMENTED

**Current:** `config/autonomous.yaml` has `autonomous.enabled: true` (line 11). `src/autonomous/loop.ts` (line 1241) exits the process if disabled.

**Why change:** The vision says "there is no 'autonomous mode' toggle." Autonomy is the default state.

**What to do:** Remove the `enabled` flag. The loop always starts. If the user wants to pause self-initiated work, that's a goal-stack adjustment (e.g., "pause all self-initiated goals"), not a process exit.

> **Status:** `autonomous.enabled` toggle removed. The loop always starts.
