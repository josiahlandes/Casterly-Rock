# Dual-Loop System

> **Source**: `src/dual-loop/`

Two independent LLM loops run concurrently and coordinate through a shared TaskBoard. The FastLoop (35B-A3B) handles user-facing interaction; the DeepLoop uses a 27B dense reasoner for planning/review and an 80B-A3B MoE coder for tool-calling code generation.

## Why Two Loops

| Problem with single-loop | Dual-loop solution |
|--------------------------|-------------------|
| User waits 30-60s for acknowledgment while reasoning model thinks | FastLoop acknowledges in <2s |
| FastLoop model sits idle while reasoner works | Both models active concurrently |
| Scheduled work blocks user interaction | FastLoop always responsive |

## Components

### FastLoop (User-Facing)

**Model**: `qwen3.5:35b-a3b` (MoE -- 35B total, 3B active per token)
**Server**: Ollama (localhost:11434)
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

### DeepLoop (Reasoning + Coding Engine)

The DeepLoop uses two specialized models with distinct roles:

#### Reasoner (27B Dense)

**Model**: `Qwen3.5-27B-Claude-4.6-Opus-Reasoning-Distilled` (dense -- all 27B params active per token)
**Server**: vllm-mlx (localhost:8000)
**Thinking**: ON (generates `<think>` blocks via `--reasoning-parser qwen3`)
**KV Cache**: K8V4 (asymmetric quantization, lossless at 128K context)

Responsibilities:
- **Plan** complex tasks into steps with scoped context
- **Review** completed work and request revisions
- **Summarize** results into user-facing responses
- **Autonomous work** during idle: events from EventBus, goals from GoalStack

#### Coder (80B-A3B MoE)

**Model**: `Qwen3-Coder-Next` (Hybrid MoE+DeltaNet -- 80B total, 3B active per token, MXFP4)
**Server**: vllm-mlx (localhost:8001)
**Thinking**: OFF (non-thinking instruct model)
**KV Cache**: FP16 (only 12 KV layers, quantization saves negligible memory)
**Context**: 256K native

Responsibilities:
- **Execute** via the 96-tool agent toolkit (ReAct pattern)
- **Generate code** with tool-calling (SWE-bench capable)
- **Handle revisions** when review requests changes

**Source**: `src/dual-loop/deep-loop.ts`
**Cadence**: Natural pace (10-60s per turn)

Work priority order:
1. Queued user tasks (highest)
2. Revision requests
3. System events (file changes, test failures)
4. Goal stack work

### Model Routing within DeepLoop

The reasoner and coder are routed automatically within DeepLoop:

```
Task claimed by DeepLoop
    |
    v
Reasoner (27B) generates plan
    |
    v
For each step:
    |-- Planning/review step --> Reasoner (27B)
    |-- Code/tool step -------> Coder (80B-A3B) via providerOverride
    |
    v
Reasoner (27B) reviews output
    |
    v
Reasoner (27B) generates summary
```

The routing is controlled by `dispatchToCoder()` in `deep-loop.ts`, which passes the `coderProvider` as a `providerOverride` to `executeWithTools()`.

### TaskBoard (Shared State)

**Source**: `src/dual-loop/task-board.ts`
**Storage**: `~/.casterly/taskboard.json`

The TaskBoard is the **sole communication channel** between loops. Both loops read and write tasks through synchronous in-memory operations -- no locks needed because JS is single-threaded.

#### Task Lifecycle

```
User message arrives
    |
    v
FastLoop triages
    |
    v
+--------------------------------------------------+
|  simple/conversational -> answered_directly       |
|  complex -> queued (for DeepLoop)                 |
+--------------------------------------------------+
    | (complex path)
    v
DeepLoop claims -> planning (27B) -> implementing (80B) -> reviewing (27B) -> done
    |
    v
FastLoop delivers response via voice filter
```

#### Task States

| Status | Owner | Description |
|--------|-------|-------------|
| `queued` | null | Waiting for DeepLoop to claim |
| `planning` | deep | Reasoner generating plan |
| `implementing` | deep | Coder executing steps |
| `reviewing` | deep | Reasoner self-reviewing |
| `revision` | null | Review requested changes; DeepLoop will re-claim |
| `done` | null | Complete; FastLoop delivers response |
| `failed` | null | Abandoned or max retries exceeded |
| `answered_directly` | null | FastLoop handled without DeepLoop |

#### Ownership Protocol

```typescript
// Atomic claim (JS single-threaded -- no locks needed)
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
- Accepts optional `coderProvider` to forward to DeepLoop for model specialization

### DualLoopController

**Source**: `src/dual-loop/dual-loop-controller.ts`

Adapts the Coordinator to the daemon's `AutonomousController` interface:

- `start()` -> launches the coordinator as a long-running background task
- `tick()` -> no-op (coordinator runs continuously)
- `runTriggeredCycle(trigger)` -> routes user messages to FastLoop, returns immediately
- Status commands (`status`, `health`, `activity`) read from Coordinator health
- Accepts `coderProvider` in options and forwards to coordinator

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
| 4+ steps or resumed | extended | 131,072 |

### Coder Context Tiers

| Task complexity | Tier | num_ctx |
|-----------------|------|---------|
| Standard | base | 8,192 |
| Extended | extended | 65,536 |
| Maximum | max | 262,144 |

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
t=1.0s  FastLoop creates task, acknowledges: "On it -- planning now"
t=2.0s  DeepLoop claims task, reads triage notes
t=5.0s  Reasoner (27B) generates 5-step plan
t=6.0s  Coder (80B) starts executing step 1 with tools
t=60s   Coder finishes step 3/5, working on token validation
t=60.5s User asks: "How's it going?"
t=61.0s FastLoop reads TaskBoard: "3/5 steps done. Working on token validation."
t=120s  Coder finishes all steps
t=125s  Reasoner reviews output, approves
t=130s  Reasoner writes userFacing summary
t=131s  FastLoop delivers response via voice filter
```

## Key Files

| File | Purpose |
|------|---------|
| `src/dual-loop/coordinator.ts` | Lifecycle, health monitoring, message routing |
| `src/dual-loop/fast-loop.ts` | 35B-A3B event loop: triage, delivery, progress |
| `src/dual-loop/deep-loop.ts` | Planning (27B), tool-calling (80B), code gen, review |
| `src/dual-loop/task-board.ts` | In-memory shared state with JSON persistence |
| `src/dual-loop/task-board-types.ts` | Task, PlanStep, TaskArtifact type definitions |
| `src/dual-loop/context-tiers.ts` | Tier selection and context budgeting |
| `src/dual-loop/triage-prompt.ts` | Triage system prompt and response parsing |
| `src/dual-loop/review-prompt.ts` | Code review prompt and response parsing |
| `src/dual-loop/dual-loop-controller.ts` | Daemon integration adapter |
| `src/dual-loop/deep-loop-events.ts` | Event/goal -> task conversion for idle work |
| `src/dual-loop/project-store.ts` | PROJECT.md management for generated projects |
