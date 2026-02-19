# Triggers & Event System

> **Source**: `src/autonomous/trigger-router.ts`, `src/autonomous/events.ts`, `src/autonomous/watchers/`

Every interaction with Casterly — whether a user message, a file change, a git commit, or a timer firing — enters through the trigger system and is normalized into a single `AgentTrigger` type that the agent loop understands.

## Trigger Types

```typescript
type AgentTrigger =
  | { type: 'user'; message: string; sender: string }
  | { type: 'event'; event: AgentEvent }
  | { type: 'goal'; goal: Goal }
  | { type: 'scheduled' }
```

| Type | Source | Priority | Behavior |
|------|--------|----------|----------|
| `user` | iMessage, CLI | 0 (highest) | Preempts any running cycle |
| `event` | File watcher, git watcher, issue watcher | 1 | Triggers cycle if idle |
| `goal` | Goal stack (autonomous work) | 2 | Continue in-progress work |
| `scheduled` | Timer (background improvement) | 3 (lowest) | Runs when nothing else is pending |

## Trigger Router

`src/autonomous/trigger-router.ts` provides four builder functions that normalize inputs:

| Function | Input | Output |
|----------|-------|--------|
| `triggerFromMessage(message, sender)` | User text + sender ID | `{ type: 'user', ... }` |
| `triggerFromEvent(event)` | `SystemEvent` | `{ type: 'event', ... }` with description and metadata |
| `triggerFromGoal(goal)` | `Goal` object | `{ type: 'goal', ... }` |
| `triggerFromSchedule()` | Nothing | `{ type: 'scheduled' }` |

`getTriggerPriority(trigger)` returns the numeric priority (lower = more urgent).

All trigger creation is logged through the debug tracer.

## Event System

### SystemEvent Types

`src/autonomous/events.ts` defines 7 event types:

| Event | Fields | Emitted By |
|-------|--------|------------|
| `file_changed` | `paths[]`, `changeKind` (`created`/`modified`/`deleted`/`mixed`) | `FileWatcher` |
| `test_failed` | `testName`, `output` | Agent loop (after running tests) |
| `git_push` | `branch`, `commits[]` | `GitWatcher` |
| `build_error` | `error` | Agent loop (after build) |
| `issue_stale` | `issueId`, `daysSinceActivity` | `IssueWatcher` |
| `user_message` | `sender`, `message` | iMessage daemon, CLI |
| `scheduled` | `reason` | Timer |

### Event Priority

Events are ranked by urgency. Lower number = higher priority:

```
0  user_message     Always preempt
1  test_failed      React to breakage
2  build_error      React to breakage
3  file_changed     Code changed
4  git_push         New commits landed
5  issue_stale      Aging reminder
6  scheduled        Background work
```

Within the same priority level, events are processed FIFO (oldest first).

### EventBus

The `EventBus` class is the central nervous system connecting watchers to the agent loop.

**Lifecycle:**
1. A watcher detects a change and calls `eventBus.emit(event)`
2. The event is added to the queue and timestamped
3. Registered handlers are notified synchronously (for logging, metrics)
4. The autonomous loop's wildcard handler calls `handleEvent(event)`
5. If conditions are met (no active cycle, cooldown elapsed, budget remaining), a new agent cycle is triggered

**Configuration:**

```typescript
{
  maxQueueSize: 100,   // Oldest low-priority events dropped when exceeded
  logEvents: true,     // Log all events through debug tracer
}
```

**Key methods:**

| Method | Purpose |
|--------|---------|
| `emit(event)` | Add event to queue, notify handlers |
| `drain()` | Return all events sorted by priority, clear queue |
| `peek()` | Look at highest-priority event without removing |
| `on(type, handler)` | Register handler for specific event type |
| `onAny(handler)` | Register wildcard handler |
| `pause()` / `resume()` | Temporarily stop accepting events |

**Privacy**: Events never contain raw sensitive user data. Only codebase metadata (file paths, branch names, test names) is stored.

## Watchers

Three watchers produce events from the environment:

### FileWatcher

> **Source**: `src/autonomous/watchers/file-watcher.ts`

Monitors the codebase for file changes using Node's native `fs.watch` (backed by FSEvents on macOS).

| Setting | Default | Description |
|---------|---------|-------------|
| `watchPaths` | `['src/', 'tests/', 'config/']` | Directories to watch (recursive) |
| `debounceMs` | `500` | Batch rapid changes into one event |
| `ignorePatterns` | `['node_modules/', 'dist/', '.git/', '.DS_Store']` | Paths to skip |

Changes within the debounce window are accumulated and flushed as a single `file_changed` event.

### GitWatcher

> **Source**: `src/autonomous/watchers/git-watcher.ts`

Monitors `.git/refs/heads/` for branch updates using `fs.watch`. When a ref file changes, it reads the new commit hash, runs `git log` for recent subjects, and emits a `git_push` event.

| Setting | Default | Description |
|---------|---------|-------------|
| `watchBranches` | `['main', 'master']` | Branches to monitor |
| `debounceMs` | `1000` | Debounce ref changes |
| `recentCommitCount` | `5` | Commits to include in event |

Only emits when the hash actually changes (no spurious events).

### IssueWatcher

> **Source**: `src/autonomous/watchers/issue-watcher.ts`

Periodically checks the issue log for stale issues and emits `issue_stale` events.

| Setting | Default | Description |
|---------|---------|-------------|
| `checkIntervalMs` | `6 hours` | How often to scan |
| `staleDays` | `7` | Days without activity before flagging |

Each stale issue is only reported once per session (tracked via `notifiedStaleIssues` set). Notifications reset when the issue gets updated.

## Event Handling in the Autonomous Loop

`src/autonomous/loop.ts` wires it all together:

```
AutonomousLoop.startEventDriven()
    │
    ├── Start FileWatcher, GitWatcher, IssueWatcher
    │
    └── eventBus.onAny(event => handleEvent(event))
```

**`handleEvent(event)`** applies four guards before triggering a cycle:

1. **Agent loop enabled?** — Skip if disabled
2. **Cycle already running?** — If yes: user messages abort the active cycle; other events stay queued
3. **Cooldown elapsed?** — Minimum `cooldownSeconds` (default: 30) between cycles
4. **Daily budget remaining?** — Maximum `dailyBudgetTurns` (default: 500) per day

If all guards pass, the event is converted to an `AgentTrigger` and a new agent cycle runs.

### Events Configuration

```typescript
{
  enabled: false,                // Event system off by default
  fileWatcher:  { enabled: true,  debounceMs: 500 },
  gitWatcher:   { enabled: true,  debounceMs: 1000 },
  issueWatcher: { enabled: true,  checkIntervalMs: 21_600_000 },
  cooldownSeconds: 30,           // Min gap between cycles
  dailyBudgetTurns: 500,         // Max agent turns per day
}
```

## Key Files

| File | Purpose |
|------|---------|
| `src/autonomous/trigger-router.ts` | Builder functions for all trigger types |
| `src/autonomous/events.ts` | `SystemEvent` types, priority ranking, `EventBus` class |
| `src/autonomous/watchers/file-watcher.ts` | FSEvents-backed file change detection |
| `src/autonomous/watchers/git-watcher.ts` | Git ref monitoring via `.git/refs/heads/` |
| `src/autonomous/watchers/issue-watcher.ts` | Periodic stale issue scanner |
| `src/autonomous/loop.ts` | `handleEvent()` — the glue between events and agent cycles |

---

## Vision Reconciliation Notes

The trigger system is well-aligned with the vision. Triggers are already normalized into a uniform shape, and the event bus is the right abstraction. The following changes are needed:

### 1. Remove the `events.enabled` toggle

**Current:** `config/autonomous.yaml` has `events.enabled: false` (line 141). `src/autonomous/loop.ts` (line 546) skips event-driven mode entirely when disabled.

**Why change:** The vision says events are triggers the LLM receives — the same as user messages, just with a different source. Gating them behind a toggle creates a modal boundary.

**What to do:** Remove the `events.enabled` flag. Watchers always run and emit events. The LLM decides what to do with them (including ignoring low-priority events when higher-priority work is pending).

### 2. Remove quiet hours as a hard gate

**Current:** `src/autonomous/loop.ts` (lines 292-310) checks `quietHours.enabled` and returns `false` from `shouldRunCycle()` during quiet hours. `src/autonomous/controller.ts` (lines 304-321) has `isInWorkWindow()` which enforces the same gate.

**Why change:** The vision says "quiet hours are a scheduling preference, not a mode switch." The LLM should know about quiet hours through its system prompt and prefer consolidation work during those times, but the system shouldn't refuse to run cycles.

**What to do:** Remove the quiet-hours check from `shouldRunCycle()` and `isInWorkWindow()`. Include quiet hours in the system prompt as scheduling context: "The user prefers you do consolidation work during quiet hours (6am-10pm). User messages always take priority regardless of time."

### 3. Remove the `handleEvent()` guard for `agent_loop.enabled`

**Current:** `handleEvent()` in `loop.ts` (line 163 area) has a guard: "Agent loop enabled? — Skip if disabled."

**Why change:** The agent loop is always the execution path. There is no disabled state.

**What to do:** Remove the guard. Events always flow to the agent loop.

### 4. Integrate self-knowledge triggers (Vision Tier 1)

**Current:** Crystals, constitutional rules, and trace replay are driven by agent tools and dream cycle phases. The agent decides when to use them during a cycle.

**Future:** As the system matures, certain events should automatically suggest self-knowledge actions:
- A failed cycle should suggest `replay` + `create_rule` in the next scheduled trigger
- High-recall journal entries should suggest `crystallize` during dream cycles
- Rules with declining confidence should suggest review during scheduled maintenance

**What exists today:** Vision Tier 1 is fully implemented. The crystal store, constitution store, and trace replay are integrated into the agent toolkit (9 tools) and dream cycle runner (pruning phases). Vision Tier 2 is also implemented: the prompt store, shadow store, and tool synthesizer add 8 more tools. Vision Tier 3 is also implemented: the challenge generator/evaluator, prompt evolution, training extractor, and LoRA trainer add 7 more tools and three dream cycle phases (8a: adversarial challenges, 8b: prompt evolution, 8c: training data extraction). The Roadmap Phases 1-5 add 18 more tools (67 total), including the `schedule` tool (Phase 5) which lets the LLM create its own triggers. Self-knowledge and self-improvement triggers are currently manual (agent-initiated) — automatic suggestion is planned for future phases.

### 5. Route iMessage through the trigger system

**Current:** iMessage messages bypass the trigger system entirely. They go from `src/imessage/daemon.ts` → `processChatMessage()` → pipeline.

**Why change:** The vision says all input enters through triggers. User messages should be `triggerFromMessage()` events like everything else.

**What to do:** Modify the iMessage daemon to call `triggerFromMessage(text, sender)` and emit the trigger via the event bus (or directly invoke the agent loop). Remove the direct `processChatMessage()` call.
