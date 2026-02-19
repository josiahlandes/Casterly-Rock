# Memory & State

> **Source**: `src/autonomous/journal.ts`, `src/autonomous/world-model.ts`, `src/autonomous/goal-stack.ts`, `src/autonomous/issue-log.ts`, `src/autonomous/context-manager.ts`, `src/autonomous/crystal-store.ts`, `src/autonomous/constitution-store.ts`, `src/autonomous/trace-replay.ts`, `src/tasks/execution-log.ts`

Casterly maintains persistent state across sessions through eight subsystems, each stored separately on disk. They are loaded in parallel at cycle start and saved at cycle end.

```
~/.casterly/
├── journal.jsonl              ← Append-only narrative memory
├── world-model.yaml           ← Codebase health, stats, concerns
├── goals.yaml                 ← Priority queue of work items
├── issues.yaml                ← Problem tracker with attempt history
├── crystals.yaml              ← Permanent high-value insights (Vision Tier 1)
├── constitution.yaml          ← Self-authored operational rules (Vision Tier 1)
├── traces/                    ← Execution trace archive (Vision Tier 1)
│   ├── index.json             ← Lightweight trace index
│   └── <cycleId>.json         ← Individual trace files
└── execution-log/
    └── log.jsonl              ← Task execution outcomes (operational memory)
```

## Journal

> **Source**: `src/autonomous/journal.ts`
> **Storage**: `~/.casterly/journal.jsonl` (append-only JSONL)

The journal is Tyrion's narrative memory — what he was working on, what he noticed, what he'd tell his future self. It's the primary source of continuity between cycles.

### Entry Types

| Type | Purpose | Example |
|------|---------|---------|
| `handoff` | Written at end of every cycle — "what I'd tell myself next time" | "Fixed the flaky test. Still need to investigate the regex edge case." |
| `reflection` | Observations about patterns, approaches, lessons learned | "The provider interface is cleaner when I separate streaming from batch." |
| `opinion` | Preferences that emerge over time | "I think the detector regex is over-complicated." |
| `observation` | Things noticed in passing | "Test coverage dropped 2% after the refactor." |
| `user_interaction` | Notes about conversations (never verbatim content) | "User asked about calendar integration. They prefer brief responses." |

### Entry Structure

```typescript
interface JournalEntry {
  id: string;                    // Auto-generated (j-<timestamp>-<random>)
  timestamp: string;             // ISO
  type: 'handoff' | 'reflection' | 'opinion' | 'observation' | 'user_interaction';
  content: string;               // Natural language
  tags: string[];                // For recall: ['provider-interface', 'refactor', 'stuck']
  cycleId?: string;              // Which cycle produced this
  triggerType?: string;          // What started that cycle
}
```

### Key Behaviors

- **Append-only**: Entries are never modified or deleted. Write-through to disk on every append.
- **In-memory window**: Last 200 entries cached (configurable via `maxInMemory`). Older entries are on disk only.
- **Handoff continuity**: `getHandoffNote()` returns the most recent handoff entry, which is injected into the identity prompt at the start of every cycle.
- **Search**: Keyword search across content and tags (case-insensitive substring match).
- **Summarize**: Generates a compact date-tagged summary for context inclusion.
- **Privacy**: Contains only Tyrion's own reasoning, never raw user data.

## World Model

> **Source**: `src/autonomous/world-model.ts`
> **Storage**: `~/.casterly/world-model.yaml` (YAML, full rewrite on save)

Tyrion's structured understanding of the codebase state. Answers: "What is the current state of my codebase?"

### Sections

**Health Snapshot** — Output of running quality gates:

| Check | Fields |
|-------|--------|
| TypeScript | `passed`, `errorCount`, `errors[]` (first 10) |
| Tests | `passed`, `total`, `passing`, `failing`, `skipped`, `failingTests[]` (first 10) |
| Lint | `passed`, `errorCount`, `warningCount` |
| Overall | `healthy` (all three passing) |

Full health update is expensive (runs `tsc`, `vitest`, `lint`) — done sparingly (once per autonomous cycle or during dream cycles).

**Codebase Stats**: `totalFiles`, `totalLines`, `lastCommitHash`, `lastCommitMessage`, `branchName`. Updated cheaply from `git log`.

**Concerns** — Lightweight observations not yet promoted to issues:

```typescript
interface Concern {
  description: string;
  firstSeen: string;
  occurrences: number;      // Incremented on re-observation
  severity: 'informational' | 'worth-watching' | 'needs-action';
  relatedFiles: string[];
}
```

Max 30 concerns. When full, oldest informational concerns are pruned first.

**Recent Activity** — Simplified log of what happened (max 50 entries):

```typescript
interface ActivityEntry {
  timestamp: string;
  description: string;
  source: 'user' | 'tyrion' | 'external';
  commitHash?: string;
}
```

**User Model** — Derived understanding of the user (never verbatim content):

```typescript
interface UserModel {
  communicationStyle: string;     // e.g. "brief, technical"
  priorities: string[];
  recentTopics: string[];         // Last 10
  preferences: string[];          // Deduplicated set
  lastUpdated: string;
}
```

### Update Strategies

| Method | Cost | When | What |
|--------|------|------|------|
| `updateFromCodebase()` | High | Once per autonomous cycle | Runs tsc, vitest, lint, git info, file count (in parallel) |
| `updateActivity()` | Low | After every interaction | Refreshes git info only |
| `addActivity()` | Free | During cycle | Appends an activity entry |
| `addConcern()` | Free | During cycle | Adds or increments a concern |
| `updateHealth()` | Free | After agent runs tests | Updates health without re-running commands |

### Summary for Identity Prompt

`getSummary()` produces a compact markdown text covering health status, stats, needs-action concerns, worth-watching concerns, and recent activity. This is what Tyrion sees when he "wakes up."

### Configuration Defaults

```typescript
{
  path: '~/.casterly/world-model.yaml',
  projectRoot: process.cwd(),
  maxActivityEntries: 50,
  maxConcerns: 30,
  commandTimeoutMs: 120_000,
}
```

## Goal Stack

> **Source**: `src/autonomous/goal-stack.ts`
> **Storage**: `~/.casterly/goals.yaml` (YAML, full rewrite on save)

The goal stack gives Tyrion direction — a persistent priority queue of things he cares about.

### Goal Structure

```typescript
interface Goal {
  id: string;                // "goal-001"
  source: 'user' | 'self' | 'event';
  priority: number;          // 1 = highest
  description: string;
  created: string;
  updated: string;
  status: 'pending' | 'in_progress' | 'blocked' | 'done' | 'abandoned';
  attempts: number;
  notes: string;
  relatedFiles: string[];
  issueId?: string;
  eventType?: string;
  tags: string[];
}
```

### Goal Sources & Default Priorities

| Source | Default Priority | Description |
|--------|-----------------|-------------|
| `user` | 1 (highest) | Explicitly requested by the human |
| `event` | 2 | Created from system events (test failures, build errors, stale issues) |
| `self` | 3 | Identified by Tyrion during autonomous or dream cycles |

### Key Behaviors

- **Capacity**: Max 20 open goals. When full, user/event goals auto-abandon the lowest-priority self-generated goal. Self-generated goals are rejected at capacity.
- **Next goal selection**: `getNextGoal()` returns the in-progress goal first (no context-switching), then the highest-priority pending goal.
- **Stale detection**: Goals with no activity for 7 days (configurable) are flagged.
- **Pruning**: Max 100 total goals. Oldest completed/abandoned goals are pruned first.
- **Dirty flag**: Only writes to disk when data has changed.

### Summary for Identity Prompt

`getSummaryText()` produces markdown with: in-progress goals (with notes), top pending, blocked, stale, and recently completed.

## Issue Log

> **Source**: `src/autonomous/issue-log.ts`
> **Storage**: `~/.casterly/issues.yaml` (YAML, full rewrite on save)

Tyrion's self-managed issue tracker for problems found but not yet solved. The institutional memory of failures, partial fixes, and open questions.

### How Issues Differ from Goals and Concerns

| | Goals | Issues | Concerns |
|-|-------|--------|----------|
| **Focus** | Forward-looking (what to do) | Problem-focused (what's wrong) | Observational (what I noticed) |
| **Weight** | Strategic | Tactical | Lightweight |
| **Example** | "Refactor the orchestrator" | "Regex doesn't match Unicode" | "Test coverage dropped 2%" |

An issue can spawn a goal (complex fix), and a goal can reference an issue.

### Issue Structure

```typescript
interface Issue {
  id: string;                    // "ISS-001"
  title: string;
  description: string;
  status: 'open' | 'investigating' | 'resolved' | 'wontfix';
  priority: 'critical' | 'high' | 'medium' | 'low';
  firstSeen: string;
  lastUpdated: string;
  relatedFiles: string[];
  tags: string[];
  attempts: IssueAttempt[];      // Full history of fix attempts
  nextIdea: string;              // What to try next time
  discoveredBy: 'autonomous' | 'user-report' | 'test-failure' | 'build-error' | 'dream-cycle';
  resolution: string;            // Filled when resolved/wontfix
  goalId?: string;               // Linked goal, if any
}
```

### Attempt Tracking

Each fix attempt records:
- **approach**: What was tried
- **outcome**: `success`, `failure`, or `partial`
- **details**: What happened
- **filesModified**: Which files were touched
- **branch/commitHash**: Git context (if applicable)

When an attempt is recorded on an `open` issue, it auto-transitions to `investigating`.

### Key Behaviors

- **Deduplication**: Filing an issue with the same title as an existing open issue updates the existing one instead.
- **Priority escalation**: If a duplicate is filed at higher priority, the existing issue is upgraded.
- **Capacity**: Max 50 open issues. When full, the oldest low-priority issue is auto-closed as `wontfix`.
- **Pruning**: Max 200 total issues. Oldest resolved/wontfix issues pruned first.
- **Summary text**: Shows investigating (with next idea), open by priority, stale, stubborn (3+ failed attempts), and recently resolved.

## Crystal Store (Vision Tier 1: Memory Crystallization)

> **Source**: `src/autonomous/crystal-store.ts`
> **Storage**: `~/.casterly/crystals.yaml` (JSON, full rewrite on save)

Permanent, always-available insights that Tyrion has promoted from the warm/cool memory tiers. Crystals represent stable facts, patterns, and preferences that don't need to be re-derived from the journal each cycle.

### Crystal Structure

```typescript
interface Crystal {
  id: string;              // "crys-<timestamp>-<random>"
  content: string;         // The insight — concise and actionable
  sourceEntries: string[]; // IDs of memory/journal entries that motivated this crystal
  formedDate: string;      // When first crystallized (ISO)
  lastValidated: string;   // When last confirmed against recent experience (ISO)
  recallCount: number;     // Times referenced
  confidence: number;      // 0-1 score
}
```

### Lifecycle

| Phase | Trigger | Effect |
|-------|---------|--------|
| **Formation** | Agent calls `crystallize` tool | New crystal added (if budget allows) |
| **Validation** | Agent calls `validate` or re-crystallizes | Confidence increases slightly |
| **Weakening** | Crystal contradicts recent experience | Confidence decreases |
| **Pruning** | Dream cycle maintenance | Crystals below 0.3 confidence removed |
| **Dissolution** | Agent calls `dissolve` tool | Crystal removed, dissolution logged to journal |

### Key Behaviors

- **Budget**: Max 30 crystals, 500 tokens total in the hot tier
- **Deduplication**: Re-crystallizing the same content strengthens the existing crystal
- **Eviction**: When at capacity, new high-confidence crystals evict the lowest-confidence existing crystal
- **Hot tier**: `buildCrystalsPrompt()` produces text for inclusion in the identity prompt, sorted by confidence
- **Privacy**: Only derived insights, never raw user content

## Constitution Store (Vision Tier 1: Self-Governance)

> **Source**: `src/autonomous/constitution-store.ts`
> **Storage**: `~/.casterly/constitution.yaml` (JSON, full rewrite on save)

Self-authored operational rules discovered through experience. These are tactical rules with evidence — distinct from the immutable safety boundary.

### Rule Structure

```typescript
interface ConstitutionalRule {
  id: string;              // "rule-<timestamp>-<random>"
  rule: string;            // The directive — concise and actionable
  added: string;           // When created (ISO)
  motivation: string;      // Journal reference explaining why this rule exists
  confidence: number;      // 0-1 score
  invocations: number;     // Times the rule was relevant
  successes: number;       // Times following the rule led to success
  tags: string[];          // Categorization tags
}
```

### Lifecycle

| Phase | Trigger | Effect |
|-------|---------|--------|
| **Creation** | Agent calls `create_rule` after observing a pattern | New rule added |
| **Strengthening** | `recordSuccess()` — rule followed, positive outcome | Confidence +0.03 |
| **Slight decay** | `recordFailure()` — rule followed, negative outcome | Confidence -0.02 |
| **Strong decay** | `recordViolationSuccess()` — rule violated, succeeded anyway | Confidence -0.05 |
| **Pruning** | Dream cycle maintenance | Rules below 0.3 confidence removed |
| **Evolution** | Agent calls `update_rule` | Rule text refined based on new evidence |

### Key Behaviors

- **Budget**: Max 50 rules, 500 tokens total in the hot tier
- **Deduplication**: Creating a duplicate rule strengthens the existing one
- **Success tracking**: Each rule tracks invocations and successes for success rate reporting
- **Search**: Rules searchable by keyword across text and tags
- **Hot tier**: `buildConstitutionPrompt()` includes success rate in the prompt

## Trace Replay (Vision Tier 1: Self-Debugging)

> **Source**: `src/autonomous/trace-replay.ts`
> **Storage**: `~/.casterly/traces/` (JSON files + index)

Execution trace recording for post-mortem analysis. Each cycle's tool calls, parameters, results, and timing are stored as structured traces.

### Trace Structure

```typescript
interface ExecutionTrace {
  cycleId: string;
  startedAt: string;
  endedAt: string;
  triggerType: string;
  outcome: 'success' | 'failure' | 'partial';
  steps: TraceStep[];     // Each tool call with params, result, reasoning, duration
  totalDurationMs: number;
  summary?: string;
  error?: string;
}
```

### Retention Policy

| Outcome | Retention | Override |
|---------|-----------|---------|
| Success | 7 days | — |
| Failure | 30 days | — |
| Referenced (by crystal or rule) | Indefinite | `markReferenced()` |

Max 500 traces. Retention enforced during dream cycles and when the limit is exceeded.

### Key Capabilities

- **Replay**: Step-by-step walkthrough with optional step range and tool filter
- **Compare**: Side-by-side comparison of two traces — finds divergence point, unique tools, outcome differences
- **Search**: Index-based search by outcome, trigger type, or tool used
- **Format**: Human-readable narrative format for both traces and comparisons
- **Auto-rebuild**: Index is rebuilt from trace files on first load if missing

## Context Manager (Tiered Memory)

> **Source**: `src/autonomous/context-manager.ts`

Manages what Tyrion can "see" during a cycle. Four tiers:

| Tier | Budget | Content | Persistence |
|------|--------|---------|-------------|
| **Hot** | ~2k tokens | Identity prompt + crystals + constitution (always in context) | Rebuilt each cycle from live state |
| **Warm** | ~20k tokens | Tool results, working notes, snippets | In-memory only (cleared between cycles) |
| **Cool** | On-demand | Past 30 days of archived notes | Disk (JSONL store, queried via `recall` tool) |
| **Cold** | Archive | Full historical archive | Disk (JSONL store, queried via `recall` tool) |

The warm tier uses LRU eviction. Significant tool results (from `read_file`, `search_code`, `run_tests`, `run_command`, `recall`, `adversarial_test`) are automatically added during the cycle, truncated to 4000 characters.

See [agent-loop.md](agent-loop.md) for how tiers are populated and consumed.

## Execution Log (Operational Memory)

> **Source**: `src/tasks/execution-log.ts`
> **Storage**: `~/.casterly/execution-log/log.jsonl` (append-only JSONL)

Records task execution outcomes so the planner can learn from past runs. This is separate from the journal — the journal is narrative; the execution log is structured data.

See [task-execution.md](task-execution.md) for full details.

**Bounds**: Max 500 records or 30 days. Compacted on load.

**Queries**: By task type, by tool, recent, tool reliability stats.

## State Lifecycle

```
Cycle start
    │
    ├── journal.load()           ← Read JSONL, cache last 200
    ├── worldModel.load()        ← Read YAML
    ├── goalStack.load()         ← Read YAML
    ├── issueLog.load()          ← Read YAML
    ├── crystalStore.load()      ← Read JSON (Vision Tier 1)
    ├── constitutionStore.load() ← Read JSON (Vision Tier 1)
    └── traceReplay.initialize() ← Load trace index (Vision Tier 1)
         (all in parallel)
    │
    ▼
During cycle
    │
    ├── Journal: append handoff, reflections, observations
    ├── World model: addActivity(), addConcern(), updateHealth()
    ├── Goal stack: recordAttempt(), updateNotes(), completeGoal()
    ├── Issue log: fileIssue(), recordAttempt(), resolveIssue()
    ├── Crystal store: crystallize(), dissolve(), validate(), weaken()
    ├── Constitution: createRule(), recordSuccess/Failure/ViolationSuccess()
    ├── Trace replay: record() (at cycle end)
    └── Context manager: addToWarmTier() (auto from tool results)
    │
    ▼
Cycle end
    │
    ├── journal.append(handoff)  ← Write-through (immediate)
    ├── worldModel.save()        ← Only if dirty
    ├── goalStack.save()         ← Only if dirty
    ├── issueLog.save()          ← Only if dirty
    ├── crystalStore.save()      ← Only if dirty (Vision Tier 1)
    └── constitutionStore.save() ← Only if dirty (Vision Tier 1)
```

## Privacy Guarantees

All state subsystems follow the same rule: **store only Tyrion's reasoning and codebase metadata, never raw user content.**

- Journal: Derived summaries only, not verbatim messages
- World model: File counts, test results, commit messages — no user data
- Goals: Task descriptions and codebase references only
- Issues: Technical descriptions, fix approaches, file paths only
- User model: Derived preferences (e.g. "prefers brief responses"), never quotes
- Crystals: Only derived insights, never raw user content
- Constitution: Only empirical rules from journal references, never user data
- Traces: Execution sequences and tool parameters only, no raw sensitive content

## Key Files

| File | Purpose |
|------|---------|
| `src/autonomous/journal.ts` | Append-only narrative memory (265 lines) |
| `src/autonomous/world-model.ts` | Codebase state: health, stats, concerns, user model (1028 lines) |
| `src/autonomous/goal-stack.ts` | Priority queue with capacity management (731 lines) |
| `src/autonomous/issue-log.ts` | Problem tracker with attempt history (729 lines) |
| `src/autonomous/context-manager.ts` | 4-tier memory hierarchy (150+ lines) |
| `src/autonomous/crystal-store.ts` | Permanent insights with confidence tracking (Vision Tier 1) |
| `src/autonomous/constitution-store.ts` | Self-authored rules with evidence (Vision Tier 1) |
| `src/autonomous/trace-replay.ts` | Execution trace recording and replay (Vision Tier 1) |
| `src/tasks/execution-log.ts` | Bounded task outcome log (248 lines) |
