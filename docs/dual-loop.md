# Dual-Loop System

> **Source**: `src/dual-loop/`

Two independent LLM loops run concurrently and coordinate through a shared TaskBoard. The FastLoop (35B-A3B) handles user-facing interaction; the DeepLoop (122B) handles reasoning, planning, and code generation.

## Why Two Loops

| Problem with single-loop | Dual-loop solution |
|--------------------------|-------------------|
| User waits 30-60s for acknowledgment while 122B reasons | FastLoop acknowledges in <2s |
| 35B-A3B sits idle while 122B works | Both models active concurrently |
| Scheduled work blocks user interaction | FastLoop always responsive |

## Components

### FastLoop (User-Facing)

**Model**: `qwen3.5:35b-a3b` (MoE — 35B total, 3B active per token)
**Source**: `src/dual-loop/fast-loop.ts`
**Cadence**: ~2-second heartbeat

Responsibilities:
- **Triage** incoming messages as `simple`, `complex`, or `conversational`
- **Answer directly** for simple questions (DeepLoop never involved)
- **Acknowledge** complex tasks and create TaskBoard entries for DeepLoop
- **Deliver responses** from completed tasks (via voice filter)
- **Report progress** on in-flight DeepLoop tasks

Heartbeat priority order:
1. Pending user messages (highest)
2. Completed task responses to deliver
3. Progress updates for active tasks
4. Sleep until next heartbeat

### DeepLoop (Reasoning Engine)

**Model**: `qwen3.5:122b`
**Source**: `src/dual-loop/deep-loop.ts`
**Cadence**: Natural pace (10-60s per turn)

Responsibilities:
- **Claim** queued tasks from the TaskBoard
- **Plan** complex tasks into steps with scoped context
- **Execute** via the 96-tool agent toolkit (ReAct pattern)
- **Generate code** directly (SWE-bench 72.0 — no separate coder model)
- **Handle revisions** when review requests changes
- **Autonomous work** during idle: events from EventBus, goals from GoalStack

Work priority order:
1. Queued user tasks (highest)
2. Revision requests
3. System events (file changes, test failures)
4. Goal stack work

### TaskBoard (Shared State)

**Source**: `src/dual-loop/task-board.ts`
**Storage**: `~/.casterly/taskboard.json`

The TaskBoard is the **sole communication channel** between loops. Both loops read and write tasks through synchronous in-memory operations — no locks needed because JS is single-threaded.

#### Task Lifecycle

```
User message arrives
    ↓
FastLoop triages
    ↓
┌──────────────────────────────────────────────────┐
│  simple/conversational → answered_directly       │
│  complex → queued (for DeepLoop)                 │
└──────────────────────────────────────────────────┘
    ↓ (complex path)
DeepLoop claims → planning → implementing → done
    ↓
FastLoop delivers response via voice filter
```

#### Task States

| Status | Owner | Description |
|--------|-------|-------------|
| `queued` | null | Waiting for DeepLoop to claim |
| `planning` | deep | DeepLoop generating plan |
| `implementing` | deep | DeepLoop executing steps |
| `reviewing` | deep | DeepLoop self-reviewing |
| `revision` | null | Review requested changes; DeepLoop will re-claim |
| `done` | null | Complete; FastLoop delivers response |
| `failed` | null | Abandoned or max retries exceeded |
| `answered_directly` | null | FastLoop handled without DeepLoop |

#### Ownership Protocol

```typescript
// Atomic claim (JS single-threaded — no locks needed)
claimNext(owner: 'fast' | 'deep', statuses: TaskStatus[]): Task | null
```

FastLoop creates tasks with `owner: null`. DeepLoop claims them atomically. When DeepLoop finishes, it sets `owner: null` and `status: 'done'`. FastLoop picks up the response for delivery.

### Coordinator

**Source**: `src/dual-loop/coordinator.ts`

The Coordinator starts both loops, monitors health, and handles graceful degradation:

- Auto-restarts crashed loops (up to 3 attempts with 5s backoff)
- Saves TaskBoard state every 30 seconds
- Archives completed tasks older than 7 days
- Provides health dashboard (running state, error counts, task stats)

### DualLoopController

**Source**: `src/dual-loop/dual-loop-controller.ts`

Adapts the Coordinator to the daemon's `AutonomousController` interface:

- `start()` → launches the coordinator as a long-running background task
- `tick()` → no-op (coordinator runs continuously)
- `runTriggeredCycle(trigger)` → routes user messages to FastLoop, returns immediately
- Status commands (`status`, `health`, `activity`) read from Coordinator health

## Context Management

### FastLoop Context Tiers

Per-operation tier selection (no mid-operation changes):

| Operation | Tier | num_ctx |
|-----------|------|---------|
| Triage | compact | 4,096 |
| Direct answer | standard | 12,288 |
| Large review (>150 diff lines) | extended | 24,576 |

### DeepLoop Context Tiers

Per-task tier selection (set once, never changed mid-ReAct):

| Task complexity | Tier | num_ctx |
|-----------------|------|---------|
| Single step | standard | 24,576 |
| 2-3 steps | standard | 24,576 |
| 4+ steps or resumed | extended | 262,144 |

### Context Pressure

DeepLoop monitors token usage and auto-adjusts:

| Pressure | Action |
|----------|--------|
| < 70% | Normal |
| 70-85% | Warning injected into prompt |
| > 85% | Auto-compress oldest turns |

## Preemption

DeepLoop checks for higher-priority tasks every 5 turns. If a user submits an urgent request while DeepLoop works on a lower-priority goal, the current task is **parked** (state saved to TaskBoard) and the higher-priority task is claimed.

## Message Flow Example

```
t=0.0s  User sends: "Refactor auth to JWT"
t=0.5s  FastLoop triages as 'complex'
t=1.0s  FastLoop creates task, acknowledges: "On it — planning now"
t=2.0s  DeepLoop claims task, reads triage notes
t=30s   DeepLoop finishes plan (5 steps), starts implementing
t=35s   User asks: "How's it going?"
t=35.5s FastLoop reads TaskBoard: "3/5 steps done. Working on token validation."
t=120s  DeepLoop finishes, writes userFacing response
t=121s  FastLoop delivers response via voice filter
```

## Key Files

| File | Purpose |
|------|---------|
| `src/dual-loop/coordinator.ts` | Lifecycle, health monitoring, message routing |
| `src/dual-loop/fast-loop.ts` | 35B-A3B event loop: triage, delivery, progress |
| `src/dual-loop/deep-loop.ts` | 122B work loop: planning, tool-calling, code gen |
| `src/dual-loop/task-board.ts` | In-memory shared state with JSON persistence |
| `src/dual-loop/task-board-types.ts` | Task, PlanStep, TaskArtifact type definitions |
| `src/dual-loop/context-tiers.ts` | Tier selection and context budgeting |
| `src/dual-loop/triage-prompt.ts` | Triage system prompt and response parsing |
| `src/dual-loop/review-prompt.ts` | Code review prompt and response parsing |
| `src/dual-loop/dual-loop-controller.ts` | Daemon integration adapter |
| `src/dual-loop/deep-loop-events.ts` | Event/goal → task conversion for idle work |
| `src/dual-loop/project-store.ts` | PROJECT.md management for generated projects |
