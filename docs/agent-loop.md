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

Budget: ~4000 characters (configurable via `IdentityConfig.maxChars`).

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
| **Hot** | ~2k tokens | Identity prompt — always in context, never evicted | Rebuilt each cycle from live state |
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
| World | `update_world_model`, `adversarial_test` |
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
| `src/autonomous/agent-tools.ts` | `AgentToolkit` — tool schemas and executors (1900+ lines) |
| `src/autonomous/identity.ts` | Identity prompt builder |
| `src/autonomous/context-manager.ts` | 4-tier memory hierarchy |
| `src/autonomous/journal.ts` | Append-only JSONL journal |
| `src/autonomous/goal-stack.ts` | Goal tracking and progression |
| `src/autonomous/issue-log.ts` | Self-managed issue tracker |
| `src/autonomous/world-model.ts` | Persistent world state |
| `src/autonomous/events.ts` | Event types and priority system |
| `src/autonomous/trigger-router.ts` | Trigger normalization |
