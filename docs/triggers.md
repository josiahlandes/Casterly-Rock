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
