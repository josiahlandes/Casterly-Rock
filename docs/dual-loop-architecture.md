# Dual-Loop Architecture: Three-Model Concurrent System

## Status: IMPLEMENTED — All 5 passes complete

---

## Implementation Progress

Five passes, each building on the last. Track completion here.

| Pass | Scope | Status |
|------|-------|--------|
| **1. Scaffold** | All files created with types, interfaces, class skeletons, exports. No logic. | **Done** — `tsc --noEmit` clean |
| **2. Foundation** | TaskBoard (JSON-backed), context-tiers, DebugSubsystem registration | **Done** — `tsc --noEmit` clean |
| **3. Loops** | FastLoop event loop, DeepLoop plan-and-execute, triage, review, fast-tools | **Done** — `tsc --noEmit` clean |
| **4. Integration** | Coordinator lifecycle + health, config YAML entries, message routing, save timers | **Done** — `tsc --noEmit` clean |
| **5. Hardening** | 79 tests (4 test files), config fix, quality gates green | **Done** — guardrails + lint + typecheck pass |

### Files Created

```
src/dual-loop/
  [x] task-board-types.ts     — Task, TaskStatus, PlanStep, TaskArtifact types
  [x] task-board.ts           — TaskBoard class (JSON-backed, GoalStack pattern)
  [x] context-tiers.ts        — ContextTierConfig types + tier selection functions
  [x] fast-loop.ts            — FastLoop class
  [x] deep-loop.ts            — DeepLoop class
  [x] coordinator.ts          — LoopCoordinator (starts/stops both loops)
  [x] fast-tools.ts           — Filtered toolkit for FastLoop
  [x] triage-prompt.ts        — Prompts for message triage
  [x] review-prompt.ts        — Prompts for code review
  [x] index.ts                — Public API re-exports
```

---

## 1. Executive Summary

Replace the current single-loop `AutonomousLoop` (one model handles everything sequentially) with a **dual-loop architecture** where two independent event loops run concurrently, coordinated through a shared **TaskBoard**. A third model (the coder) is dispatched as a tool by the deep loop.

| Loop | Model | Role | Cadence |
|------|-------|------|---------|
| **FastLoop** | `qwen3.5:27b` | User-facing, triage, code review, status | ~2s heartbeat |
| **DeepLoop** | `qwen3.5:122b` | Planning, reasoning, tool calling, decisions | Natural pace (10-60s/turn) |
| **Coder** | `qwen3-coder-next` | Code generation (dispatched by DeepLoop) | On-demand |

### Memory Budget

| Component | VRAM |
|-----------|------|
| qwen3.5:122b-a10b | ~73 GB |
| qwen3.5:27b | ~17 GB |
| qwen3-coder-next | ~22 GB |
| **Total** | **~112 GB** |
| Remaining (of 128 GB) | ~16 GB (12.5% headroom) |

All three models run with `keep_alive: -1` (never unloaded). The 122b MoE architecture activates only ~10B parameters per token, so actual compute per token is modest despite the large weight footprint.

---

## 2. Problem Statement

Today's system has a single `AgentLoop` driven by one LLM provider. This creates three problems:

1. **Responsiveness** — When the 122B is mid-generation on a 40-turn autonomous cycle, user messages queue behind it. The user waits 30-60 seconds for acknowledgment.
2. **Concurrency** — The system can only do one thing at a time. A scheduled improvement cycle blocks event processing.
3. **Model underutilization** — The 27B sits idle unless the routing classifier sends it a coding task. The 122B is used for trivial triage that a smaller model could handle.

### What the Dual-Loop Solves

- The **FastLoop** (27B) is always responsive — its small size means sub-second first-token latency for short responses.
- The **DeepLoop** (122B) runs uninterrupted — it never has to pause mid-plan to acknowledge a user message.
- Both loops operate **concurrently** through a data-structure coupling (TaskBoard), not a model-call coupling.
- The 27B handles **two roles** it's strong at: user interaction (IFEval 95.0) and code review (SWE-bench 72.4).
- The 122B focuses on what it's best at: deep reasoning (GPQA 86.6), tool calling (BFCL-V4 72.2), and complex planning.

---

## 3. Architecture Overview

```
┌──────────────────────────────────────────────────────────────────┐
│                     SHARED STATE LAYER                           │
│                                                                  │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────────────────┐ │
│  │  TaskBoard   │  │  EventBus    │  │  Persistent State      │ │
│  │  (SQLite)    │  │  (existing)  │  │  (WorldModel,GoalStack,│ │
│  │              │  │              │  │   IssueLog,Journal)     │ │
│  └──────┬───────┘  └──────┬───────┘  └────────────┬───────────┘ │
│         │                 │                        │             │
└─────────┼─────────────────┼────────────────────────┼─────────────┘
          │                 │                        │
   ┌──────┴─────────────────┴──────┐   ┌────────────┴──────────┐
   │         FAST LOOP (27B)       │   │     DEEP LOOP (122B)  │
   │                               │   │                       │
   │  Responsibilities:            │   │  Responsibilities:    │
   │  • User message handling      │   │  • Task planning      │
   │  • Task triage & creation     │   │  • Multi-step tool    │
   │  • Status reporting           │   │    calling            │
   │  • Code review                │   │  • Complex reasoning  │
   │  • Quick answers (simple Qs)  │   │  • Code dispatch to   │
   │  • Dashboard / progress       │   │    Coder model        │
   │                               │   │  • Accept/reject      │
   │  Heartbeat: ~2 seconds        │   │    reviews            │
   │  Context: user conversation   │   │  • Quality decisions  │
   │           + task board state   │   │                       │
   │                               │   │  Pace: natural        │
   └───────────────────────────────┘   │  Context: task detail │
                                       │           + codebase  │
                                       │                       │
                                       │  ┌─────────────────┐  │
                                       │  │  CODER           │  │
                                       │  │  (qwen3-coder)   │  │
                                       │  │                  │  │
                                       │  │  Dispatched as   │  │
                                       │  │  tool by DeepLoop│  │
                                       │  └─────────────────┘  │
                                       └───────────────────────┘
```

### Key Principle: Data-Structure Coupling, Not Model-Call Coupling

The two loops **never call each other directly**. They communicate exclusively through the TaskBoard (a shared data structure backed by SQLite). This means:

- Neither loop can block the other.
- Either loop can crash and restart without corrupting the other's state.
- The TaskBoard is the single source of truth for all task state.

---

## 4. TaskBoard: The Shared State Layer

### 4.1 Schema

```typescript
interface Task {
  // Identity
  id: string;                    // e.g., "task-m3k8a-x9p2q"
  createdAt: string;             // ISO timestamp
  updatedAt: string;             // ISO timestamp

  // Lifecycle
  status: TaskStatus;
  owner: 'fast' | 'deep' | null; // Which loop currently owns this task

  // Origin
  origin: 'user' | 'event' | 'scheduled' | 'goal';
  priority: number;              // 0 = highest (user), 3 = lowest (scheduled)
  sender?: string;               // User name/ID if origin is 'user'
  originalMessage?: string;      // Raw user message if applicable

  // Triage (written by FastLoop)
  classification?: 'simple' | 'complex' | 'conversational';
  triageNotes?: string;          // FastLoop's summary for DeepLoop

  // Plan (written by DeepLoop)
  plan?: string;                 // DeepLoop's approach
  planSteps?: PlanStep[];        // Broken-down steps with status

  // Implementation (written by DeepLoop)
  artifacts?: TaskArtifact[];    // File paths, diffs, commits
  implementationNotes?: string;  // What was done

  // Review (written by FastLoop)
  reviewResult?: 'approved' | 'changes_requested' | 'rejected';
  reviewNotes?: string;          // What the reviewer found
  reviewFeedback?: string;       // Specific feedback for DeepLoop

  // Resolution
  resolvedAt?: string;
  resolution?: string;           // Final summary
  userFacing?: string;           // Response to show the user
}

type TaskStatus =
  | 'queued'            // Created by FastLoop, waiting for DeepLoop
  | 'planning'          // DeepLoop is planning the approach
  | 'implementing'      // DeepLoop is dispatching to Coder
  | 'reviewing'         // FastLoop is reviewing the output
  | 'revision'          // DeepLoop is addressing review feedback
  | 'done'              // Completed successfully
  | 'failed'            // Failed after retries
  | 'answered_directly' // FastLoop handled it without DeepLoop
  ;

interface PlanStep {
  description: string;
  status: 'pending' | 'in_progress' | 'done' | 'failed';
  output?: string;
}

interface TaskArtifact {
  type: 'file_diff' | 'file_created' | 'test_result' | 'commit';
  path?: string;
  content?: string;    // Truncated if large
  timestamp: string;
}
```

### 4.2 Storage Backend

**SQLite** via `better-sqlite3` (synchronous, no async overhead for reads):

- Single file at `~/.casterly/taskboard.db`
- WAL mode for concurrent read/write from both loops
- Tasks table with JSON columns for nested structures (plan_steps, artifacts)
- Indexes on `status`, `priority`, `owner`, `createdAt`
- Automatic cleanup: tasks older than 7 days move to an archive table

Why SQLite over JSON file:
- Both loops can read/write concurrently without file-locking races
- WAL mode ensures readers never block writers and vice versa
- Structured queries (e.g., "get the oldest queued task with highest priority")
- Transactions for atomic status updates (prevents two loops claiming the same task)

### 4.3 Ownership Protocol

The TaskBoard uses a **claim-based ownership** model to prevent race conditions:

```
1. FastLoop creates a task → status: 'queued', owner: null
2. DeepLoop claims it → UPDATE SET owner='deep', status='planning'
                         WHERE id=? AND owner IS NULL  (atomic)
3. DeepLoop finishes → UPDATE SET owner=null, status='reviewing'
4. FastLoop claims it for review → UPDATE SET owner='fast'
                                   WHERE id=? AND owner IS NULL
5. FastLoop writes review → UPDATE SET owner=null, status='done'|'revision'
6. If 'revision' → DeepLoop re-claims, addresses feedback, back to step 3
```

The `WHERE owner IS NULL` clause ensures only one loop can claim a task at a time. No locks, no mutexes — just SQL atomicity.

---

## 5. FastLoop: The 27B User-Facing Agent

### 5.1 Responsibilities

| Capability | Description |
|-----------|-------------|
| **User acknowledgment** | Instantly acknowledge incoming messages ("Got it, working on that") |
| **Triage** | Classify messages as simple/complex/conversational |
| **Direct answers** | Handle simple questions without involving DeepLoop |
| **Status reporting** | "Your task is 60% done — planning phase complete, now implementing" |
| **Code review** | Review diffs produced by DeepLoop+Coder before commit |
| **Dashboard** | Summarize the task board when user asks "what's going on?" |
| **Interrupt relay** | If user sends follow-up that changes the task, update the TaskBoard |

### 5.2 Event Loop Design

```typescript
class FastLoop {
  private readonly provider: LlmProvider;      // 27B OllamaProvider
  private readonly taskBoard: TaskBoard;
  private readonly eventBus: EventBus;
  private readonly conversationHistory: Message[];  // User-facing context
  private running: boolean = false;

  /**
   * Main heartbeat loop. Runs every ~2 seconds.
   * Each tick checks for work in priority order.
   */
  async run(): Promise<void> {
    this.running = true;

    while (this.running) {
      // 1. Check for new user messages (highest priority)
      const userEvent = this.eventBus.peekType('user_message');
      if (userEvent) {
        await this.handleUserMessage(userEvent);
        continue; // Don't sleep — check for more immediately
      }

      // 2. Check for tasks needing review
      const reviewable = this.taskBoard.getNextReviewable();
      if (reviewable) {
        await this.reviewTask(reviewable);
        continue;
      }

      // 3. Check for tasks with user-facing responses ready
      const completed = this.taskBoard.getCompletedWithResponse();
      if (completed) {
        await this.deliverResponse(completed);
        continue;
      }

      // 4. Heartbeat — nothing to do, sleep briefly
      await sleep(2000);
    }
  }
}
```

### 5.3 Triage Logic

When a user message arrives, the FastLoop decides how to handle it:

```
User message → FastLoop triage:

1. Is this a greeting/small talk?
   → Answer directly. No task created.

2. Is this a simple factual question the 27B can answer?
   → Answer directly. Log as 'answered_directly'.

3. Is this a status query ("how's it going?", "what are you working on?")?
   → Read TaskBoard, summarize active tasks. No task created.

4. Is this a follow-up to an existing task?
   → Find the active task, append the user's message as a note.
   → If it contradicts the current plan, set a flag for DeepLoop.

5. Is this a new complex task?
   → Create a Task with status='queued', write triageNotes.
   → Acknowledge to user: "I'll start working on that."
```

The triage decision uses the 27B with a focused system prompt (not the full 96-tool toolkit). The 27B's IFEval 95.0 means it reliably follows classification prompts.

### 5.4 Code Review Flow

When DeepLoop finishes implementation and sets `status='reviewing'`:

1. FastLoop claims the task (`owner='fast'`)
2. Reads the `artifacts` (diffs, file changes)
3. Sends each diff to the 27B with a review prompt:
   - "Review this diff for correctness, security issues, and style violations"
   - "Check that the change matches the plan: {plan}"
4. Writes `reviewResult` and `reviewNotes`:
   - `'approved'` → Task moves to `'done'`
   - `'changes_requested'` → Task moves to `'revision'` with specific feedback
   - `'rejected'` → Task moves to `'failed'` with explanation
5. Releases ownership (`owner=null`)

### 5.5 Context Window Management

The FastLoop's 27B has a ~32K context window. It holds:

- **System prompt** (~2K): Triage/review/status instructions
- **User conversation** (~10K): Rolling window of recent messages
- **Task board summary** (~3K): Active tasks, statuses, recent completions
- **Current work item** (~5K): The diff being reviewed or the message being triaged
- **Remaining** (~12K): Buffer for response generation

The FastLoop does NOT hold:
- Full codebase context (that's the DeepLoop's job)
- Full tool schemas (it only needs TaskBoard tools + message tools)
- Deep planning history (that lives in the TaskBoard's `plan` field)

---

## 6. DeepLoop: The 122B Reasoning Engine

### 6.1 Responsibilities

| Capability | Description |
|-----------|-------------|
| **Task planning** | Break complex tasks into steps |
| **Tool calling** | Execute the full 96-tool toolkit |
| **Code dispatch** | Send implementation tasks to Coder model via ConcurrentProvider |
| **Quality decisions** | Accept/reject based on test results |
| **Autonomous work** | Scheduled cycles, goal stack, event-driven responses |
| **Review arbitration** | Address FastLoop's review feedback |

### 6.2 Event Loop Design

```typescript
class DeepLoop {
  private readonly provider: LlmProvider;           // 122B OllamaProvider
  private readonly concurrentProvider: ConcurrentProvider; // For Coder dispatch
  private readonly taskBoard: TaskBoard;
  private readonly eventBus: EventBus;
  private readonly state: AgentState;               // Goals, issues, world model
  private running: boolean = false;

  /**
   * Main work loop. Runs continuously, pulling tasks from the board.
   * Unlike FastLoop, this doesn't heartbeat — it works at its natural
   * pace, spending 10-60 seconds per turn on complex reasoning.
   */
  async run(): Promise<void> {
    this.running = true;

    while (this.running) {
      // 1. Check for queued tasks (user-requested work, highest priority)
      const userTask = this.taskBoard.claimNext('deep', ['queued']);
      if (userTask) {
        await this.planAndExecute(userTask);
        continue;
      }

      // 2. Check for revision requests (FastLoop flagged issues)
      const revision = this.taskBoard.claimNext('deep', ['revision']);
      if (revision) {
        await this.addressRevision(revision);
        continue;
      }

      // 3. Check for system events
      const events = this.eventBus.drain();
      if (events.length > 0) {
        await this.handleEvents(events);
        continue;
      }

      // 4. Work on goal stack (autonomous improvement)
      const goal = this.state.goalStack.getTop();
      if (goal) {
        await this.workOnGoal(goal);
        continue;
      }

      // 5. Nothing to do — sleep longer
      await sleep(10_000);
    }
  }
}
```

### 6.3 Plan-and-Execute Flow

When DeepLoop picks up a queued task:

```
1. Read the task's triageNotes (written by FastLoop)
2. Read relevant context (files, test results) using tools
3. Generate a plan with steps
4. Write the plan to TaskBoard (status='planning' → 'implementing')
5. For each implementation step:
   a. Assess difficulty via ReasoningScaler
   b. Easy → dispatch to Coder model directly
   c. Hard → bestOfN via ConcurrentProvider
   d. Execute tool calls (edit_file, run_tests, etc.)
   e. Update plan step status in TaskBoard
6. When all steps done → status='reviewing', owner=null
7. Wait for FastLoop review
8. If 'revision' → read feedback, fix issues, back to reviewing
9. If 'approved' → write userFacing response, status='done'
```

### 6.4 Coder Dispatch

The Coder model is NOT a loop — it's a tool invoked by DeepLoop:

```typescript
// Inside DeepLoop.planAndExecute():

async dispatchToCoder(task: Task, step: PlanStep): Promise<string> {
  const request: GenerateRequest = {
    prompt: this.buildCoderPrompt(task, step),
    systemPrompt: 'You are a code implementation assistant. Write the code changes requested. Be precise and minimal.',
    temperature: 0.1,
    maxTokens: 4096,
  };

  // Use ConcurrentProvider so Coder runs without blocking 122B's next thought
  const response = await this.concurrentProvider.generate(
    'qwen3-coder-next:latest',
    request,
  );

  return response.text;
}
```

The Coder gets a **scoped prompt** — not the full conversation history, just:
- The specific step to implement
- Relevant file contents
- The plan context
- Style/convention notes

This keeps the Coder's context clean and focused.

### 6.5 Context Window Management

The DeepLoop's 122B has a ~41K context window. It holds:

- **System prompt** (~4K): Identity, tool guidelines, behavioral expectations
- **Task context** (~10K): The current task's plan, artifacts, review feedback
- **File context** (~15K): Files being worked on (gathered via tools)
- **Tool results** (~8K): Recent tool call results (warm tier)
- **Remaining** (~4K): Buffer for reasoning + tool calls

The DeepLoop does NOT hold:
- User conversation history (that's the FastLoop's job)
- Other tasks' context (one task at a time)
- Dashboard/status information (FastLoop handles that)

---

## 7. Coordination Patterns

### 7.1 User Message → Complex Task → Response

```
Timeline:

  t=0s   User sends: "Refactor the authentication module to use JWT"
  t=0.5s FastLoop picks up message, triages as 'complex'
  t=1s   FastLoop creates Task, acknowledges: "On it — I'll plan the refactor."
  t=2s   DeepLoop claims task, starts reading auth files
  t=30s  DeepLoop finishes plan, writes 5 steps to TaskBoard
  t=35s  User asks: "How's the refactor going?"
  t=35.5s FastLoop reads TaskBoard: "Planning done. 5 steps identified.
           Starting implementation. Step 1: update token generation..."
  t=120s DeepLoop finishes all steps, status='reviewing'
  t=122s FastLoop claims for review, reads diffs
  t=130s FastLoop approves: "Looks clean. Tests pass."
  t=131s DeepLoop writes userFacing summary
  t=132s FastLoop delivers: "Done! Here's what changed: ..."
```

**Key observations:**
- At t=35s, the user gets an instant status update even though DeepLoop is mid-work
- At no point does either loop wait for the other
- The total wall-clock time is the same as single-loop, but responsiveness is dramatically better

### 7.2 User Message → Simple Question → Direct Answer

```
  t=0s   User sends: "What does the --keep-alive flag do?"
  t=0.5s FastLoop triages as 'simple'
  t=1.5s FastLoop answers directly from its own knowledge
  t=2s   Task logged as 'answered_directly'. DeepLoop never involved.
```

### 7.3 User Interrupts Active Task

```
  t=0s   DeepLoop is working on Task A (refactor auth)
  t=15s  User sends: "Actually, stop that. Fix the login bug first."
  t=15.5s FastLoop creates Task B (fix login bug, priority=0)
  t=16s  FastLoop updates Task A status to 'queued' (deprioritized)
  t=16.5s FastLoop acknowledges: "Stopping the refactor. Switching to the login bug."
  t=17s  DeepLoop finishes current turn, checks board, sees Task B at priority 0
  t=18s  DeepLoop parks Task A, claims Task B
```

**The DeepLoop is not interrupted mid-generation** — it finishes its current turn (up to 60s), then checks the board. This is acceptable because:
- The FastLoop has already acknowledged the user
- The user knows the switch is happening
- The DeepLoop doesn't lose work — Task A stays in the board

### 7.4 Review Rejection Flow

```
  t=0s   DeepLoop finishes implementation, status='reviewing'
  t=2s   FastLoop reviews: "Line 47 introduces a SQL injection risk."
  t=3s   Task status='revision', reviewFeedback="SQL injection on line 47..."
  t=5s   DeepLoop claims revision, reads feedback
  t=30s  DeepLoop fixes the issue, re-submits for review
  t=32s  FastLoop re-reviews: "Fixed. Approved."
  t=33s  Task status='done'
```

**The DeepLoop MUST address the specific concern.** It can override, but it must write `implementationNotes` explaining why. This mirrors how a senior engineer handles code review — you can disagree, but you can't ignore.

---

## 8. Integration with Existing Systems

### 8.1 What Changes

| Current System | What Changes |
|---------------|-------------|
| `AutonomousLoop` | Splits into `FastLoop` + `DeepLoop` + `LoopCoordinator` |
| `AgentLoop` | Retained as-is — used inside DeepLoop for its ReAct cycle |
| `EventBus` | Shared between both loops (already designed for concurrent access) |
| `trigger-router.ts` | Extended: user triggers go to FastLoop, others to DeepLoop |
| `ConcurrentProvider` | Extended: registers all 3 models instead of 2 |
| `AutonomousProvider` (legacy) | No change — already deprecated |
| Tool system | FastLoop gets a filtered toolkit; DeepLoop gets the full toolkit |
| `config/models.yaml` | Add `fast` model entry for 27B |
| `config/autonomous.yaml` | Add `dual_loop` section with per-loop config |

### 8.2 What Stays the Same

| System | Why Unchanged |
|--------|--------------|
| `LlmProvider` interface | Both loops use the same interface |
| `OllamaProvider` | Each loop creates its own instance with different models |
| Tool executors | Tool implementations don't care which loop calls them |
| Security/redaction | All logging still goes through safe-logger |
| WorldModel, GoalStack, IssueLog | Both loops can read; only DeepLoop writes |
| Journal | DeepLoop writes handoff notes as before |
| Dream cycles | Run inside DeepLoop during quiet periods |
| Reasoning scaler | Used inside DeepLoop for Coder dispatch |

### 8.3 New Files

```
src/
  dual-loop/
    task-board.ts          # TaskBoard class (SQLite-backed)
    task-board-types.ts    # Task, TaskStatus, TaskArtifact types
    fast-loop.ts           # FastLoop class
    deep-loop.ts           # DeepLoop class
    coordinator.ts         # LoopCoordinator (starts/stops both loops)
    fast-tools.ts          # Filtered toolkit for FastLoop
    review-prompt.ts       # Prompts for code review
    triage-prompt.ts       # Prompts for message triage
    context-tiers.ts       # Dynamic num_ctx tier selection (Section 28)
    index.ts               # Public API

config/
  models.yaml              # Updated: add 'fast' model entry
  autonomous.yaml          # Updated: add 'dual_loop' + 'context_tiers' sections
```

### 8.4 Modified Files (Protected Paths — Requires Explicit Callout)

- `config/models.yaml` — Add `fast:` model entry for 27B
- `config/autonomous.yaml` — Add `dual_loop:` configuration section
- `src/providers/concurrent.ts` — Register 3 models instead of 2

### 8.5 Migration Path

The dual-loop is **additive**, not a rewrite. The existing `AutonomousLoop` continues to work. The new system is activated via config:

```yaml
# config/autonomous.yaml
dual_loop:
  enabled: true                    # false = use legacy single loop
  fast_model: qwen3.5:27b
  fast_context_length: 32768
  fast_heartbeat_ms: 2000
  task_board_path: ~/.casterly/taskboard.db
  max_review_rounds: 3             # Max revision cycles before escalating
  triage_timeout_ms: 10000         # Max time for FastLoop triage
```

When `dual_loop.enabled: false`, the system runs exactly as it does today. This gives us a clean rollback path.

---

## 9. FastLoop Toolkit (Filtered)

The FastLoop does NOT get the full 96-tool toolkit. It gets a minimal set:

```typescript
const FAST_LOOP_TOOLS: CategoryName[] = [
  'core',           // think, read_file, search_code
  'reasoning',      // think (for triage reasoning)
];

// Plus these custom tools:
const FAST_LOOP_CUSTOM_TOOLS = [
  'task_board_read',        // Read current task board state
  'task_board_create',      // Create a new task
  'task_board_update',      // Update task status/notes
  'task_board_claim',       // Claim a task for review
  'respond_to_user',        // Send response to user
  'read_task_artifacts',    // Read diffs/files from a task
];
```

This keeps the 27B's context overhead minimal (~2K for tool schemas vs ~50K for full toolkit).

---

## 10. Configuration

### 10.1 models.yaml Addition

```yaml
models:
  # NEW: Fast model for user-facing loop
  fast:
    provider: ollama
    model: qwen3.5:27b
    context_length: 32768
    temperature: 0.3      # Slightly creative for natural conversation
    keep_alive: -1         # Never unload
    fallback: null         # If 27B is down, DeepLoop handles everything

  # Existing entries unchanged
  primary:
    provider: ollama
    model: qwen3.5:122b
    ...
  coding:
    provider: ollama
    model: qwen3-coder-next:latest
    ...
```

### 10.2 autonomous.yaml Addition

```yaml
dual_loop:
  enabled: true

  # FastLoop settings
  fast:
    model: qwen3.5:27b
    heartbeat_ms: 2000
    triage_timeout_ms: 10000
    max_conversation_tokens: 10000   # Rolling window for user chat
    review_enabled: true              # Can disable review for speed

  # DeepLoop settings
  deep:
    model: qwen3.5:122b
    coder_model: qwen3-coder-next:latest
    max_turns_per_task: 50            # Safety ceiling per task
    max_revision_rounds: 3            # Before marking task as failed
    preempt_check_interval_turns: 5   # Check board every N turns

  # TaskBoard settings
  task_board:
    path: ~/.casterly/taskboard.db
    archive_after_days: 7
    max_active_tasks: 10              # Prevent unbounded task accumulation
```

---

## 11. Critical Design Decisions

### 11.1 Who Has Final Authority?

**The DeepLoop (122B) has final authority on implementation decisions.** The FastLoop (27B) reviews and provides feedback, but the DeepLoop can override with explanation. This mirrors a senior engineer overriding a code review.

However, the **FastLoop has exclusive authority on user interaction.** The DeepLoop never sends messages to the user directly — it writes `userFacing` text to the TaskBoard, and the FastLoop delivers it. This ensures consistent voice and prevents both loops from talking to the user simultaneously.

### 11.2 What If the 27B Gives a Bad Review?

The DeepLoop's `implementationNotes` for an override must address the specific concern:

```
reviewFeedback: "Line 47 has a SQL injection risk"
implementationNotes: "Line 47 uses parameterized queries via the ORM.
  The $1 placeholder is not user-controlled — it comes from the validated
  config schema. No injection risk. Overriding review."
```

If the DeepLoop overrides more than 2 reviews in a row, a warning is logged and the task is flagged for human review in the morning summary.

### 11.3 What If Both Loops Try to Write State?

**Rule: Only DeepLoop writes to WorldModel, GoalStack, IssueLog.** FastLoop reads these for context but never modifies them. This eliminates write conflicts entirely.

The only shared-write surface is the TaskBoard, which uses SQLite's atomic updates (see Ownership Protocol in section 4.3).

### 11.4 Context Fragmentation: "Why did you do it that way?"

When a user asks about a task they didn't witness, the FastLoop needs enough context to answer. Solution:

1. DeepLoop writes rich `plan`, `implementationNotes`, and `resolution` to every task
2. FastLoop reads these fields and summarizes for the user
3. If the FastLoop can't answer from TaskBoard data alone, it writes a clarification request to the TaskBoard, which the DeepLoop picks up on its next check

The 27B's IFEval 95.0 means it can reliably follow a prompt like:
> "Summarize the plan and implementation notes of task #7 for the user. Be concise."

### 11.5 Graceful Degradation

If one loop crashes:

| Failure | Behavior |
|---------|----------|
| 27B model unavailable | FastLoop stops. DeepLoop continues. User messages queue (delivered when 27B recovers). |
| 122B model unavailable | DeepLoop stops. FastLoop continues acknowledging messages ("I'm experiencing technical issues, will get back to you soon"). |
| Coder unavailable | DeepLoop falls back to 122B for code generation (existing `fallback` config). |
| SQLite corruption | Both loops fall back to in-memory TaskBoard (volatile, no persistence). |
| Both loops crash | LoopCoordinator restarts both. TaskBoard state survives (on-disk). |

---

## 12. Implementation Order

### Phase 1: TaskBoard (Foundation)

**Files:** `src/dual-loop/task-board.ts`, `src/dual-loop/task-board-types.ts`, `src/dual-loop/context-tiers.ts`

1. Define TypeScript types for Task, TaskStatus, TaskArtifact, PlanStep
2. Implement TaskBoard class with SQLite backend (better-sqlite3)
3. Implement CRUD: create, claim, update, getNextReviewable, getCompletedWithResponse
4. Implement ownership protocol (atomic claim via WHERE owner IS NULL)
5. Implement archive/cleanup for old tasks
6. Add WAL mode configuration
7. **Context Tiers foundation** (Section 28): Create `context-tiers.ts` with types, tier selection functions, `resolveNumCtx()`, and Zod validation. Add `providerOptions` field to `AgentLoopConfig`. Add context pressure warning to AgentLoop's turn loop
8. Write unit tests: concurrent claims, ownership transitions, priority ordering, tier selection for all operation types, config validation

**Testing checkpoint:** `npm run check` passes with TaskBoard and context tier selection fully tested.

### Phase 2: FastLoop (User-Facing)

**Files:** `src/dual-loop/fast-loop.ts`, `src/dual-loop/fast-tools.ts`, `src/dual-loop/triage-prompt.ts`

1. Create FastLoop class with heartbeat event loop
2. Build filtered toolkit (TaskBoard tools + core tools)
3. Implement triage logic (classify user messages)
4. Implement direct-answer path (simple questions)
5. Implement status reporting (read TaskBoard, summarize)
6. Wire up to EventBus for user_message events
7. **Context Tiers integration** (Section 28): Wire `selectFastTier()` into every FastLoop operation. Pass `providerOptions: { num_ctx }` in every `GenerateRequest`. Add `review_large_threshold_lines` config
8. Write unit tests: triage classification, status formatting, heartbeat timing, correct tier selected for each operation type

**Testing checkpoint:** FastLoop can triage messages and answer simple questions, using compact/standard/extended tiers appropriately.

### Phase 3: DeepLoop (Reasoning Engine)

**Files:** `src/dual-loop/deep-loop.ts`

1. Create DeepLoop class wrapping the existing AgentLoop
2. Implement task claim and plan-and-execute flow
3. Implement Coder dispatch via ConcurrentProvider
4. Implement revision handling (read review feedback, fix, resubmit)
5. Implement preemption checking (check board every N turns for higher-priority tasks)
6. Wire up to EventBus for system events, goal stack for autonomous work
7. **Context Tiers integration** (Section 28): Wire `selectDeepTier()` into task claim. Pass `providerOptions` through to AgentLoop config. Add `setContextWindow()` to ContextManager. Wire Coder dispatch through `selectCoderTier()`
8. Write unit tests: task flow state machine, coder dispatch, revision cycle, tier selection for various task shapes, context pressure flow

**Testing checkpoint:** DeepLoop can plan, implement, and respond to reviews. Tier-selected `num_ctx` flows through to all Ollama calls.

### Phase 4: Code Review (FastLoop ↔ DeepLoop)

**Files:** `src/dual-loop/review-prompt.ts`

1. Implement review flow in FastLoop (claim reviewing tasks, send diffs to 27B)
2. Implement review response parsing (approved/changes_requested/rejected)
3. Implement revision flow in DeepLoop (read feedback, fix, resubmit)
4. Add max-revision-rounds safety (prevent infinite ping-pong)
5. Write integration tests: full task lifecycle from creation to completion

**Testing checkpoint:** A task can go through the full lifecycle including review.

### Phase 5: LoopCoordinator (Orchestration)

**Files:** `src/dual-loop/coordinator.ts`, `src/dual-loop/index.ts`

1. Create LoopCoordinator that starts/stops both loops
2. Wire up to existing AutonomousLoop start path (config-gated)
3. Implement health monitoring (detect if a loop is stuck)
4. Implement graceful degradation (one loop down, other continues)
5. Update `config/models.yaml` and `config/autonomous.yaml`
6. Write integration tests: startup, shutdown, degradation

**Testing checkpoint:** Full dual-loop system runs end-to-end.

### Phase 6: Migration & Polish

1. Update `loop.ts` to conditionally use dual-loop or legacy
2. Update the iMessage daemon to route through FastLoop
3. Add dashboard/status reporting tools
4. Add morning summary integration (include TaskBoard history)
5. Performance tuning: heartbeat interval, preemption frequency
6. Documentation updates

---

## 13. Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| 27B gives incorrect triage | Medium | Medium | Triage errors are recoverable — DeepLoop can re-classify. Add triage confidence threshold. |
| Review ping-pong (endless revisions) | Low | High | Hard cap at 3 revision rounds. After that, task is marked for human review. |
| SQLite contention under heavy load | Low | Medium | WAL mode handles this. Both loops do short transactions. Benchmark under stress. |
| Context fragmentation (user asks about unknown task) | Medium | Low | Rich TaskBoard fields (plan, notes, resolution). FastLoop can relay to DeepLoop. |
| 27B model quality insufficient for review | Medium | Medium | Review is advisory, not blocking. DeepLoop can override. We can disable review via config. |
| Memory pressure (112GB of 128GB) | Low | High | Dynamic context tiers (Section 28) reduce KV cache from ~6 GB to ~2 GB typical. Monitor via `ollama ps`. Enable `OLLAMA_FLASH_ATTENTION=1` for further 2x reduction. |
| Both loops writing to EventBus | Low | Low | EventBus is already designed for concurrent emitters. No structural change needed. |

---

## 14. Success Metrics

| Metric | Current (Single Loop) | Target (Dual Loop) |
|--------|----------------------|-------------------|
| User message acknowledgment latency | 10-60s | <2s |
| User message → full response (simple) | 10-30s | 2-5s |
| Autonomous cycle interruption latency | Up to full cycle | <5s (FastLoop acknowledges immediately) |
| Review coverage of code changes | 0% (no review) | 100% (all changes reviewed by 27B) |
| Model utilization (% time active) | 122B: ~40%, Coder: ~20%, 27B: 0% | 122B: ~60%, Coder: ~30%, 27B: ~30% |

---

## 15. Open Questions

1. **Should the FastLoop maintain its own conversation history, or use the existing session system?** The current `session.ts` is designed for per-peer sessions via iMessage. The FastLoop's conversation is a superset of any single peer. Likely need a new "agent conversation" store.

2. **Should the Coder have a persistent warm-up context?** Currently it gets cold-started on each dispatch. We could maintain a persistent "coder session" with repo map and style guide pre-loaded.

3. **How should dream cycles interact with the dual-loop?** Today they run inside the single loop. In the dual-loop world, they should probably run inside DeepLoop during idle periods, but the FastLoop should be aware of dream cycle state for status reporting.

4. **Should the FastLoop handle iMessage voice filter?** Currently the voice filter runs as a post-processing step on the 122B's output. In the dual-loop, the FastLoop is already generating user-facing text — it could apply the voice filter itself, or we keep it as a separate step.

5. **Dependency: `better-sqlite3`.** This is a native Node.js addon. It's well-maintained and widely used, but adds a native compilation step. Alternative: use the built-in `fs` module with a JSON-based TaskBoard and advisory file locking. Trade-off: simpler build vs. weaker concurrency guarantees.

---

## 16. Process Isolation: How the Two Loops Actually Run

### 16.1 Threading Model

Both loops run in the **same Node.js process** but as independent `async` coroutines. This works because:

- Ollama HTTP calls are async I/O — while one loop is waiting on an HTTP response, the other can run
- Node.js event loop interleaves the two naturally
- No CPU-bound work happens in the TypeScript layer — all heavy computation is in Ollama

```typescript
// Inside coordinator.ts
async start(): Promise<void> {
  // Both loops launched as concurrent promises — NOT awaited sequentially
  const fastPromise = this.fastLoop.run();
  const deepPromise = this.deepLoop.run();

  // Wait for either to crash (or both to be stopped)
  await Promise.race([fastPromise, deepPromise]);
}
```

### 16.2 Why Not Separate Processes?

Separate processes would give true parallelism but add complexity:

- **Shared state** — EventBus, WorldModel, GoalStack would need IPC or shared memory
- **Deployment** — Two processes to manage, two sets of logs, two crash handlers
- **The bottleneck is Ollama** — Metal GPU scheduling handles the actual parallelism. The TypeScript layer is just issuing HTTP calls and waiting for responses.

The single-process model works because our loops are I/O-bound (waiting on Ollama), not CPU-bound. Node's event loop handles interleaving naturally.

### 16.3 Ollama Concurrency Considerations

With three models loaded and both loops generating concurrently, Ollama's internal scheduler matters:

- **OLLAMA_NUM_PARALLEL**: Set to 2 (one request per loop maximum). Avoids thrashing.
- **Model switching latency**: All three models are pre-loaded (`keep_alive: -1`). No cold-start penalty.
- **Metal GPU scheduling**: Apple's M4 Max GPU scheduler handles concurrent inference across models. The 122B activates 10B params/token, so when it's generating, there's compute headroom for the 27B's smaller footprint.
- **Worst case**: Both loops request generation simultaneously. Ollama queues one and processes them sequentially. This adds ~1-2 seconds to the queued request — acceptable for the FastLoop's 2-second heartbeat.

---

## 17. DeepLoop Preemption: Checking for Higher-Priority Work

### 17.1 The Problem

The DeepLoop can spend 10-60 minutes on a complex autonomous task. During that time, a user might send a message that creates a high-priority task. The DeepLoop needs to notice this without losing its current work.

### 17.2 The Solution: Turn-Level Board Checks

Every `preempt_check_interval_turns` turns (default: 5), the DeepLoop checks the TaskBoard:

```typescript
// Inside DeepLoop's ReAct loop (wrapping AgentLoop.run())
async planAndExecute(task: Task): Promise<void> {
  let turnsSinceCheck = 0;

  // The AgentLoop calls us back per-turn via a hook
  const agentLoop = createAgentLoop(config, provider, toolkit, state);

  // Before each turn, check if we should preempt
  agentLoop.onBeforeTurn(async (turnNumber) => {
    turnsSinceCheck++;
    if (turnsSinceCheck >= this.config.preemptCheckIntervalTurns) {
      turnsSinceCheck = 0;
      const urgent = this.taskBoard.getHigherPriorityTask(task.priority);
      if (urgent) {
        // Park current task (preserve state)
        await this.taskBoard.parkTask(task.id, {
          parkedAtTurn: turnNumber,
          reason: `Preempted by task ${urgent.id}`,
        });
        agentLoop.abort(); // Triggers clean exit
      }
    }
  });

  const outcome = await agentLoop.run(trigger);
  // ... handle outcome
}
```

### 17.3 Parking a Task

When preempted, the task doesn't lose progress:

```typescript
interface Task {
  // ... existing fields ...

  // Parking (for preemption)
  parkedState?: {
    parkedAtTurn: number;
    reason: string;
    contextSnapshot?: string;  // Summary of work done so far
  };
}
```

When the DeepLoop returns to a parked task, it resumes from the `contextSnapshot` rather than starting over. The AgentLoop's turn history is lost (it lives in memory), but the TaskBoard's `planSteps` with their statuses and the `implementationNotes` preserve the important state.

### 17.4 AgentLoop Hook: onBeforeTurn

The existing `AgentLoop` doesn't expose a per-turn hook. We need to add one:

```typescript
// Addition to AgentLoop class
private beforeTurnCallback: ((turn: number) => Promise<void>) | null = null;

onBeforeTurn(callback: (turn: number) => Promise<void>): void {
  this.beforeTurnCallback = callback;
}

// In the main ReAct loop, before calling the LLM:
if (this.beforeTurnCallback) {
  await this.beforeTurnCallback(turnNumber);
  if (this.aborted) break;
}
```

This is a minimal, non-breaking change to `agent-loop.ts`.

---

## 18. Voice Filter Integration

### 18.1 Current State

Today, the voice filter (`src/imessage/voice-filter.ts`) is a post-processing step that rewrites the agent's raw response in Tyrion's personality. It uses the 122B model.

### 18.2 Dual-Loop Change

In the dual-loop, **the FastLoop applies the voice filter**, not the DeepLoop:

1. The DeepLoop writes raw `userFacing` text to the TaskBoard (clear, factual, personality-free)
2. The FastLoop reads it, applies the voice filter, and delivers to the user

This is better because:
- The FastLoop already owns user communication
- The 27B is sufficient for voice rewriting (it's a text transformation, not deep reasoning)
- The 122B doesn't waste context on personality concerns

**Configuration change**: `voice_filter.model` changes from `qwen3.5:122b` to `qwen3.5:27b`.

**Fallback**: If voice filter fails (timeout, model issue), deliver the raw text. Same as today.

---

## 19. iMessage Daemon Integration

### 19.1 Current Flow

```
Daemon → poll SQLite → Input Guard → Classify → Agent Loop → Voice Filter → Send
```

### 19.2 Dual-Loop Flow

```
Daemon → poll SQLite → Input Guard → EventBus.emit(user_message)
                                              ↓
                                      FastLoop picks up
                                              ↓
                              Triage → Direct answer OR → TaskBoard
                                              ↓                ↓
                              Voice Filter → Send     DeepLoop works
                                                              ↓
                                              FastLoop picks up response
                                                              ↓
                                              Voice Filter → Send
```

### 19.3 Changes to `src/imessage/daemon.ts`

Minimal changes:
1. Remove direct `runTriggeredCycle()` call
2. Instead, emit `user_message` event to EventBus
3. The FastLoop handles the rest

The daemon becomes thinner — it's just a poller that emits events.

### 19.4 Changes to `src/autonomous/controller.ts`

The AutonomousController currently orchestrates cycle lifecycle. In dual-loop mode:
1. It creates the LoopCoordinator instead of a single AutonomousLoop
2. The LoopCoordinator manages both loops' lifecycles
3. Health checks and restart logic move to the LoopCoordinator

---

## 20. Testing Strategy

### 20.1 Unit Tests (per module)

| Module | Test File | Key Tests |
|--------|-----------|-----------|
| TaskBoard | `tests/task-board.test.ts` | Create/read/update, atomic claims, concurrent ownership, priority ordering, archive cleanup, WAL concurrent access |
| FastLoop | `tests/fast-loop.test.ts` | Triage classification, status formatting, review flow, heartbeat timing, direct answer path |
| DeepLoop | `tests/deep-loop.test.ts` | Task claim, plan generation, coder dispatch, revision handling, preemption |
| LoopCoordinator | `tests/loop-coordinator.test.ts` | Startup/shutdown, health monitoring, graceful degradation, restart |
| Review prompts | `tests/review-prompts.test.ts` | Prompt construction, response parsing (approved/rejected/changes) |
| Triage prompts | `tests/triage-prompts.test.ts` | Classification accuracy, confidence thresholds |

### 20.2 Integration Tests

| Test | Description |
|------|-------------|
| Full lifecycle | Message → triage → task → plan → implement → review → deliver |
| Preemption | Low-priority task interrupted by high-priority user message |
| Review rejection | Implementation rejected, revised, re-approved |
| Graceful degradation | Kill 27B provider, verify DeepLoop continues |
| Concurrent access | Both loops hitting TaskBoard simultaneously (stress test) |

### 20.3 Mock Strategy

All tests use mock `LlmProvider` implementations — no actual Ollama needed:

```typescript
class MockProvider implements LlmProvider {
  readonly id = 'mock';
  readonly kind = 'local';
  readonly model = 'mock:test';

  private responses: GenerateWithToolsResponse[] = [];

  queueResponse(response: GenerateWithToolsResponse): void {
    this.responses.push(response);
  }

  async generateWithTools(): Promise<GenerateWithToolsResponse> {
    return this.responses.shift() ?? { text: '', toolCalls: [], providerId: 'mock', model: 'mock:test', stopReason: 'end_turn' };
  }
}
```

---

## 21. Dependency Decision: SQLite vs JSON File

### 21.1 Option A: better-sqlite3

**Pros:**
- True concurrent read/write (WAL mode)
- Atomic transactions (claim protocol is trivial)
- Structured queries (ORDER BY priority, WHERE status IN (...))
- Battle-tested in Electron, VS Code, Obsidian, etc.
- Synchronous API (no async overhead for simple reads)

**Cons:**
- Native addon — requires node-gyp, C compiler, platform-specific binary
- Adds ~2MB to node_modules
- Prebuilt binaries may not cover all platforms (Apple Silicon is covered)

### 21.2 Option B: JSON File with Advisory Locking

**Pros:**
- Zero dependencies
- Human-readable state file
- No native compilation

**Cons:**
- File-level locking required (both loops writing to same file)
- No atomic transactions — must implement compare-and-swap manually
- Read-modify-write cycle is not atomic — race conditions with concurrent loops
- Performance degrades with many tasks (must parse entire file on each read)

### 21.3 Recommendation

**Use better-sqlite3.** The concurrent access requirement is the deciding factor. With two independent loops both reading and writing to the TaskBoard, JSON file locking is fragile and adds accidental complexity. SQLite is the right tool for this — it's why it exists.

The native compilation concern is mitigated by:
- Apple Silicon prebuilt binaries are widely available
- The project already uses `better-sqlite3`-style patterns (the existing iMessage reader uses SQLite to read `chat.db`)
- If `better-sqlite3` causes issues, we can fall back to `node:sqlite` (available in Node.js 22.5+) which is built-in

---

## 22. Invariant Compliance Checklist

Per `docs/rulebook.md`, verify each architecture invariant:

| # | Invariant | Compliant? | Notes |
|---|-----------|-----------|-------|
| 1 | All inference local via Ollama | Yes | All three models are local Ollama |
| 2 | Providers behind stable LlmProvider | Yes | Both loops use LlmProvider interface |
| 3 | Security centralized in src/security/ | Yes | No security changes needed |
| 4 | Logging through safe-logger | Yes | Both loops log through existing tracer |
| 5 | Config validated at startup | Yes | New dual_loop config validated via Zod |
| 6 | Model selection task-based | Yes | Fast=27B, Deep=122B, Code=coder |
| 7 | Agent loop is single execution path | **Modified** | Now TWO loops, but each uses AgentLoop internally. The principle (no separate code paths) holds — both loops share the same tool executors and provider interface |
| 8 | Journal append-only | Yes | DeepLoop writes to journal as before |
| 9 | Delegation transparent | Yes | All TaskBoard operations are logged |

**Invariant 7 needs discussion.** The rulebook says "The agent loop is the single execution path. No separate interactive/autonomous code paths." The dual-loop introduces two execution paths. However, the *spirit* of this invariant is to prevent divergent code — e.g., one path for interactive and a totally different one for autonomous. In our design, both loops use the same `AgentLoop` class, the same tools, the same provider interface. The paths are parallel, not divergent. We should update the rulebook to reflect this: "The agent loop (and its wrapping loops) share a single tool/provider interface. No duplicate execution logic."

---

## 23. Edge Cases and Failure Modes (Third Pass)

### 23.1 Rapid-Fire User Messages

**Scenario:** User sends 5 messages in 10 seconds.

**Problem:** FastLoop processes one at a time. By the time it finishes triaging message 1, messages 2-5 are queued. If each creates a task, the TaskBoard fills with partially-redundant tasks.

**Solution:**
- FastLoop batches consecutive user messages within a **coalesce window** (default: 3 seconds)
- If multiple messages arrive within the window, they're combined into a single triage call
- The 27B sees all messages together and creates one coherent task (or answers directly)
- Configurable: `fast.message_coalesce_ms: 3000`

```typescript
// Inside FastLoop
private pendingMessages: { sender: string; message: string; timestamp: string }[] = [];
private coalesceTimer: NodeJS.Timeout | null = null;

async onUserMessage(event: UserMessageEvent): Promise<void> {
  this.pendingMessages.push(event);

  // Reset coalesce timer
  if (this.coalesceTimer) clearTimeout(this.coalesceTimer);
  this.coalesceTimer = setTimeout(() => {
    this.processBatchedMessages();
  }, this.config.messageCoalesceMs);
}
```

### 23.2 DeepLoop Gets Stuck in a Tool Loop

**Scenario:** The DeepLoop enters a repeating pattern — read file, edit file, run tests, tests fail, read file again — for 200 turns without progress.

**Problem:** The existing `maxTurns` safety ceiling catches this, but 200 turns of wasted compute is expensive even locally.

**Solution:** Enhance the DeepLoop's ReAct loop with **stall detection**:
- Track the last N tool calls. If the same tool sequence repeats 3 times with no new files modified and no status changes, trigger early exit.
- The DeepLoop writes a `failureReason` to the task: "Stalled after 3 repeated attempts. Same tools called without progress."
- Task moves to `'failed'` with the stall diagnosis.

```typescript
// Stall detection heuristic
interface StallDetector {
  recentToolSequences: string[][]; // Last 3 sequences of tool calls
  checkStall(): boolean;           // True if last 3 sequences are identical
}
```

### 23.3 FastLoop Triages Incorrectly

**Scenario:** User sends a complex request ("refactor the auth system to use JWT and add refresh token rotation") but FastLoop classifies it as 'simple' and tries to answer directly.

**Problem:** The 27B gives a bad answer. The user is confused or annoyed.

**Solution:**
- FastLoop's triage includes a **confidence score** (0-1). If confidence < 0.7, default to 'complex' (escalate to DeepLoop).
- The triage prompt explicitly instructs: "When in doubt, classify as complex. It's better to involve the deep thinker unnecessarily than to give a bad direct answer."
- If the user responds negatively to a direct answer (e.g., "that's wrong", "no", "you don't understand"), the FastLoop creates a task and escalates: "Sorry, let me take a closer look at this."

### 23.4 TaskBoard Fills Up

**Scenario:** Many events trigger tasks faster than DeepLoop can process them.

**Problem:** `max_active_tasks: 10` prevents unlimited growth, but what happens when we hit the cap?

**Solution:** Priority-based eviction:
1. If board is full and a new task arrives with higher priority → evict the lowest-priority task
2. Evicted tasks are archived (not lost) — they move to the archive table
3. If ALL 10 tasks are user-originated (priority 0), new tasks queue in a **waiting list** with a warning to the user: "I'm handling several requests. Yours is queued — I'll get to it shortly."
4. Scheduled/goal tasks are the first to be evicted — they can always be re-created

### 23.5 User Asks About a Task That Was Parked

**Scenario:** User asked for a refactor (Task A). It was preempted by a bug fix (Task B). User asks: "How's the refactor going?"

**Problem:** Task A is parked. DeepLoop isn't working on it.

**Solution:** FastLoop reads the TaskBoard and gives an honest status:
> "The refactor is paused — I switched to fixing the login bug you asked about. The refactor has 3 of 5 steps done. I'll resume it once the bug fix is complete."

The `parkedState.reason` field provides the context. FastLoop's status reporting already reads all task fields — this is handled naturally.

### 23.6 Ollama Crashes Mid-Generation

**Scenario:** Ollama process dies while the DeepLoop is mid-generation on turn 15 of a 50-turn task.

**Problem:** The HTTP request throws an error. The AgentLoop catches it and sets `stopReason: 'error'`.

**Solution:**
- The DeepLoop catches the error and writes the task's current state to the TaskBoard: all completed `planSteps`, any artifacts generated so far, and the error message.
- Task status → `'queued'` (back in the queue for retry) with `parkedState.reason: "Ollama connection lost"`.
- The LoopCoordinator detects the Ollama failure (provider health check) and:
  1. Logs a warning
  2. Attempts to reconnect with exponential backoff (5s, 10s, 20s, 40s)
  3. If successful, both loops resume naturally (they pull from the TaskBoard)
  4. If unsuccessful after 4 attempts, notifies the user via FastLoop (if it's still up): "I'm having trouble connecting to my inference engine. Standing by."

### 23.7 27B and 122B Disagree on Review (Repeatedly)

**Scenario:** The 27B flags an issue. The 122B overrides. The 27B flags the same issue again. The 122B overrides again. This happens 3 times.

**Problem:** Infinite ping-pong. Neither model is necessarily wrong — they have different perspectives.

**Solution:** Already handled by `max_revision_rounds: 3`, but add a **disagreement escalation** path:
1. After 3 rounds, task status → `'done'` (not `'failed'`)
2. The task is **flagged for human review** in the morning summary
3. The `resolution` field notes: "Approved with 122B override after 3 review rounds. Flagged for human review."
4. The code changes ARE committed (the 122B's judgment prevails) but the flag ensures the human sees it

This prevents blocking while still surfacing disagreements.

### 23.8 Multiple Users Sending Messages Simultaneously

**Scenario:** The iMessage daemon detects messages from two different contacts at the same time.

**Problem:** The FastLoop needs to maintain separate conversation contexts per user but might interleave responses.

**Solution:**
- The FastLoop maintains a `Map<sender, ConversationContext>` — per-user conversation history
- Tasks include the `sender` field so responses are routed back to the right person
- The voice filter and delivery system already handle per-sender routing (existing `session.ts` does this)
- The TaskBoard's `sender` field ensures DeepLoop responses are attributed correctly

### 23.9 DeepLoop Wants to Message the User Directly

**Scenario:** During autonomous work, the DeepLoop finds a critical security vulnerability. It wants to alert the user immediately.

**Problem:** The rule is "DeepLoop never messages the user directly."

**Solution:** The DeepLoop writes an **urgent notification task** to the TaskBoard:

```typescript
{
  origin: 'event',
  priority: 0,              // Highest — same as user messages
  classification: 'notification',
  userFacing: 'I found a critical security issue in src/auth/validate.ts...',
  status: 'done',           // Already complete — just needs delivery
}
```

The FastLoop sees this on its next heartbeat (~2s), applies the voice filter, and delivers it. The DeepLoop's urgency is respected without breaking the communication protocol.

---

## 24. State Persistence Across Restarts

### 24.1 What Survives a Process Restart

| State | Persistence | Survives Restart? |
|-------|------------|------------------|
| TaskBoard (SQLite) | On-disk, WAL mode | Yes — SQLite recovers automatically |
| WorldModel | YAML file | Yes — loaded at startup |
| GoalStack | YAML file | Yes — loaded at startup |
| IssueLog | YAML file | Yes — loaded at startup |
| Journal | JSONL file | Yes — append-only, never corrupt |
| FastLoop conversation history | In-memory | **No** — lost on restart |
| DeepLoop turn history | In-memory | **No** — lost, but TaskBoard has plan/artifacts |
| EventBus queue | In-memory | **No** — events re-generated by watchers |

### 24.2 FastLoop Conversation Recovery

On restart, the FastLoop has no conversation history. This means:
- The user's first message after restart is treated as a fresh conversation
- Recent tasks in the TaskBoard provide context ("I was working on X when I restarted")
- The journal's handoff note provides high-level continuity

This is acceptable — users already experience this with the current system (each cycle starts fresh). The TaskBoard's rich task fields compensate for the lost conversation.

### 24.3 DeepLoop Task Recovery

On restart, the DeepLoop checks for in-progress tasks:
1. Any task with `status='implementing'` and `owner='deep'` was interrupted
2. These tasks are set to `status='queued'` with `parkedState.reason: "Process restart"`
3. The DeepLoop re-claims them naturally on its next iteration
4. The `planSteps` with their statuses tell the DeepLoop where to resume

---

## 25. Performance Expectations

### 25.1 Latency Estimates

| Operation | Estimated Latency | Context Tier (Section 28) | Notes |
|-----------|------------------|--------------------------|-------|
| FastLoop heartbeat (idle) | 2s | — | Just a sleep + board check |
| FastLoop triage (27B) | 0.5-1.5s | compact (4K) | ~5x faster than fixed 32K due to reduced prefill |
| FastLoop direct answer (27B) | 1-3s | standard (12K) | Moderate context for question + answer |
| FastLoop code review (27B) | 3-10s | standard/extended | Small diff=standard, large diff=extended |
| FastLoop voice filter (27B) | 0.5-1s | compact (4K) | Minimal context, short rewrite |
| DeepLoop planning (122B) | 10-30s | standard/extended | Set once at task start, no mid-task resize |
| DeepLoop tool call (122B) | 5-15s per turn | (inherited from task) | Same tier for entire task duration |
| Coder dispatch | 3-15s | compact/standard | Sized to actual prompt content |
| TaskBoard read | <1ms | — | SQLite synchronous read |
| TaskBoard write | <1ms | — | SQLite synchronous write |

### 25.2 Throughput

- **FastLoop**: Can process ~20-30 user messages per minute (limited by 27B generation speed)
- **DeepLoop**: ~1-3 tasks per hour (depending on complexity)
- **Coder**: ~10-20 code generations per hour (focused, short prompts)

### 25.3 Memory Steady State

After all three models are loaded and warm:
- Ollama model weights: ~112 GB (three models in unified memory)
- Ollama KV caches: ~2-5 GB (depends on active context tiers — see Section 28.6)
  - Typical (FastLoop compact + DeepLoop standard): ~1.9 GB
  - Worst case (all loops at extended): ~4.8 GB
  - With `OLLAMA_FLASH_ATTENTION=1`: roughly half the above
- Node.js heap: ~200-400 MB (TaskBoard, state stores, conversation history)
- SQLite WAL: ~1-10 MB (depending on active task count)
- Total system: ~115-117 GB typical (well within 128 GB budget)

---

## 26. Monitoring and Observability

### 26.1 Health Dashboard

The LoopCoordinator exposes health state for the existing status command:

```
Tyrion Status (Dual-Loop)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
FastLoop:  ● Running  (last heartbeat: 1.2s ago)
DeepLoop:  ● Working  (task: task-m3k8a — "Refactor auth", turn 12/50)
Coder:     ○ Idle     (last dispatch: 3m ago)

TaskBoard:
  Active: 3    Queued: 1    Reviewing: 1    Done today: 7

Models (Ollama):
  qwen3.5:27b       ● Loaded  (17.1 GB)  ctx: compact (4K)
  qwen3.5:122b      ● Loaded  (73.4 GB)  ctx: standard (25K)
  qwen3-coder-next  ● Loaded  (22.0 GB)  ctx: idle
  Weights: 112.5 GB  |  KV cache: ~1.9 GB  |  Free: 13.6 GB
```

### 26.2 Logging

Both loops log through the existing `getTracer()` debug system with loop-specific tags:

```
[fast-loop] [info] User message received from Josiah (42 chars)
[fast-loop] [debug] Triage: complex (confidence: 0.92)
[fast-loop] [info] Created task task-m3k8a: "Refactor auth module"
[deep-loop] [info] Claimed task task-m3k8a
[deep-loop] [debug] Planning: 5 steps identified
[deep-loop] [info] Dispatching step 1 to coder
[deep-loop] [debug] Coder returned 847 chars in 12.3s
[fast-loop] [info] Reviewing task task-m3k8a (3 diffs, 127 lines)
[fast-loop] [debug] Review: approved (no issues found)
```

### 26.3 Metrics for Tuning

Track these to tune the dual-loop over time:

| Metric | What It Tells You |
|--------|------------------|
| Triage accuracy | Is the 27B classifying correctly? Compare triage vs actual outcome |
| Direct answer satisfaction | Do users follow up with corrections after direct answers? |
| Review override rate | How often does 122B override 27B reviews? If >50%, reviews may not be useful |
| Preemption frequency | How often are tasks parked? If frequent, adjust priority thresholds |
| Queue depth over time | Is DeepLoop keeping up? Rising queue = need faster processing |
| Heartbeat jitter | Is FastLoop responsive? Jitter >5s means it's blocking on something |
| Coder dispatch success rate | Does Coder output pass review? If <80%, Coder prompts need work |

---

## 27. Answers to Open Questions (Resolved in This Pass)

### Q1: FastLoop conversation history → Use a new per-loop store

The FastLoop maintains its own `FastConversation` — a simple ring buffer of the last N messages per sender. It does NOT use the existing `session.ts` system, which is designed for per-peer iMessage sessions with different constraints (daily reset, per-channel scope). The FastConversation is:
- In-memory only (lost on restart, which is fine)
- Per-sender (multiple users get separate contexts)
- Rolling window (configurable max tokens, default 10K)
- Append-only during a session (no edits or deletions)

### Q2: Coder warm-up context → Yes, use a persistent system prompt

Each Coder dispatch includes a **preamble** loaded once and cached:
- The project's coding style (extracted from existing code patterns)
- The repo map (top-level file/symbol index, already built by `coding/modes/`)
- Any relevant `.editorconfig` or linting rules

This preamble is built once per DeepLoop startup and reused across dispatches. Cost: ~2K tokens of the Coder's 32K context, saving significant per-dispatch overhead.

### Q3: Dream cycles → Run inside DeepLoop, status visible to FastLoop

Dream cycles run as low-priority tasks in the DeepLoop. When a dream cycle is due:
1. DeepLoop creates a `Task` with `origin: 'scheduled'`, `priority: 3` (lowest)
2. It only runs if no higher-priority tasks are queued
3. The TaskBoard's `planSteps` reflect dream phase progress
4. FastLoop can report: "Running a dream cycle — consolidating reflections (step 2/7)"

### Q4: Voice filter → FastLoop handles it (resolved in Section 18)

The FastLoop applies the voice filter using the 27B. This is a natural fit.

### Q5: SQLite dependency → Use better-sqlite3 (resolved in Section 21)

Use `better-sqlite3` with `node:sqlite` as fallback for future Node.js versions.

---

## 28. Dynamic Context Tiers: Per-Request `num_ctx` Sizing

### 28.1 Problem Statement

Today, every Ollama request uses a **fixed `num_ctx`** regardless of the actual prompt size:

```typescript
// loop.ts:272 — current state
this.llmProvider = new OllamaProvider({
  numCtx: 40_960,  // Every request allocates a 40K KV cache
});
```

This is wasteful. When the FastLoop sends a 2K-token triage prompt, Ollama still allocates a 40K-token KV cache. That KV cache consumes real memory (proportional to `num_ctx × num_layers × hidden_dim × 2`) and slows down inference (attention computation scales with context length).

With three models sharing 128 GB and weights consuming ~112 GB, the remaining ~16 GB is the **KV cache budget**. Fixed allocation wastes this budget:

| Scenario | Fixed `num_ctx` | KV Cache Allocated | KV Cache Actually Needed |
|----------|----------------|-------------------|-------------------------|
| FastLoop triage (2K tokens) | 32,768 | ~1.5 GB | ~0.1 GB |
| FastLoop code review (10K tokens) | 32,768 | ~1.5 GB | ~0.5 GB |
| DeepLoop planning (25K tokens) | 40,960 | ~3.0 GB | ~1.8 GB |
| Coder dispatch (6K tokens) | 32,768 | ~1.5 GB | ~0.3 GB |
| **Total (all active)** | — | **~7.5 GB** | **~2.7 GB** |

That's **~5 GB of wasted KV cache** in a typical concurrent workload — nearly a third of our 16 GB headroom.

### 28.2 Key Insight: Per-Call Sizing is Free for Most Operations

Ollama accepts `num_ctx` as a per-request option via the `options` field. The question is: what does it cost to change `num_ctx` between requests?

**Within a multi-turn conversation** (same model, accumulating context): Changing `num_ctx` invalidates the KV cache. Ollama must re-process the entire conversation from scratch. For the DeepLoop at turn 30 with 25K accumulated tokens, this costs 15-30 seconds on the 122B. This is unacceptable.

**Between independent calls** (fresh conversation each time): There is no KV cache to preserve. Each request builds its own KV cache from scratch regardless. Changing `num_ctx` costs nothing.

This maps perfectly onto our dual-loop architecture:

| Loop | Call Pattern | KV Cache Reuse? | Dynamic Sizing Cost |
|------|-------------|----------------|-------------------|
| **FastLoop** | Independent calls (each triage/review/status is fresh) | No reuse between calls | **Zero** — size freely per-call |
| **DeepLoop** | Multi-turn ReAct loop (context accumulates over turns) | Reused across turns | **Expensive** — only size at task start |
| **Coder** | Independent dispatches (scoped prompt each time) | No reuse between dispatches | **Zero** — size freely per-dispatch |

### 28.3 Design: Three-Tier Context Sizing

Instead of continuous dynamic resizing (which incurs KV cache invalidation), use **discrete context tiers** that each loop selects per-operation. Three tiers per model:

```typescript
/**
 * Context tier configuration for a single model.
 *
 * Each tier represents a pre-defined num_ctx value optimized for
 * a class of operations. The loop selects the tier based on
 * the operation type, not token counting (deterministic, no prediction).
 */
interface ContextTierConfig {
  /** Compact: triage, voice filter, simple Q&A, acknowledgments */
  compact: number;

  /** Standard: code review, detailed status, moderate planning, focused code generation */
  standard: number;

  /** Extended: cross-module refactors, deep multi-turn reasoning, large diff review */
  extended: number;
}
```

Per-model tier values:

```yaml
# config/autonomous.yaml — addition to dual_loop section
dual_loop:
  context_tiers:
    # FastLoop (qwen3.5:27b)
    fast:
      compact: 4096       # Triage, voice filter, acknowledgment, simple Q&A
      standard: 12288     # Code review (small-medium), status with rich context
      extended: 24576     # Large diff review (200+ lines), batched multi-message triage

    # DeepLoop (qwen3.5:122b)
    deep:
      compact: 8192       # Quick event handling, simple tool calls
      standard: 24576     # Standard task planning and multi-step execution
      extended: 40960     # Cross-module refactors, deep reasoning, resumed parked tasks

    # Coder (qwen3-coder-next)
    coder:
      compact: 8192       # Single-file focused code generation
      standard: 16384     # Multi-file code generation with context
      extended: 32768     # Large refactors with extensive file context (rare)
```

### 28.4 Tier Selection Logic

Each loop selects its tier **deterministically** based on the operation type. No token counting, no prediction, no heuristics that can fail silently.

#### 28.4.1 FastLoop Tier Selection

The FastLoop knows what operation it's about to perform before calling the model. The operation type dictates the tier:

```typescript
type FastOperation =
  | 'triage'              // Classify incoming user message
  | 'acknowledge'         // Quick "got it" response
  | 'voice_filter'        // Rewrite raw text in Tyrion's voice
  | 'direct_answer'       // Answer a simple question
  | 'status_report'       // Summarize task board state
  | 'review_small'        // Review diff < 150 lines
  | 'review_large'        // Review diff >= 150 lines
  | 'batched_triage'      // Triage multiple coalesced messages
  | 'deliver_response';   // Format and deliver DeepLoop's userFacing text

function selectFastTier(operation: FastOperation): keyof ContextTierConfig {
  switch (operation) {
    case 'triage':
    case 'acknowledge':
    case 'voice_filter':
    case 'deliver_response':
      return 'compact';

    case 'direct_answer':
    case 'status_report':
    case 'review_small':
      return 'standard';

    case 'review_large':
    case 'batched_triage':
      return 'extended';
  }
}
```

**Why `review_small` vs `review_large`?** The diff size is known before the LLM call (the FastLoop reads the artifacts from the TaskBoard). A 50-line diff plus system prompt fits in 12K. A 300-line diff needs 24K. The line threshold (150 lines) is configurable: `fast.review_large_threshold_lines: 150`.

#### 28.4.2 DeepLoop Tier Selection

The DeepLoop sets `num_ctx` **once at task start** and does not change it during the multi-turn ReAct loop. This avoids KV cache invalidation mid-task.

```typescript
function selectDeepTier(task: Task): keyof ContextTierConfig {
  // Resumed parked tasks already had significant context built up.
  // Use extended to ensure we don't truncate the restored state.
  if (task.parkedState) {
    return 'extended';
  }

  // Tasks with many plan steps or touching many files need more context
  // for file contents, tool results, and accumulated reasoning.
  const stepCount = task.planSteps?.length ?? 0;
  const isMultiFile = stepCount > 3;

  if (isMultiFile) return 'extended';
  if (stepCount > 1) return 'standard';

  // Single-step tasks or tasks without a plan yet (pre-planning phase)
  // For pre-planning: the planning turn itself is one LLM call. After
  // planning, the task is updated with steps and the next claim re-evaluates.
  return 'standard';  // Default to standard, not compact, for safety margin
}
```

**Why default to `standard` instead of `compact`?** The DeepLoop's work is inherently complex. Even "simple" tasks involve reading files, tool calls, and multi-turn reasoning. Starting at `compact` (8K) risks truncation on turn 3-4. The memory savings from compact→standard on the 122B is ~1.2 GB, not worth the truncation risk. Reserve `compact` for genuinely lightweight operations (quick event acknowledgment, checking if the board has work).

**What if the estimate is wrong?** If the DeepLoop's context grows beyond the selected `num_ctx`, Ollama silently truncates the oldest messages. This is bad for coherence. Mitigations:

1. **Buffer rule**: The tier values include ~20% headroom over typical usage (e.g., `standard: 24576` for workloads that typically use ~18-20K).
2. **Token tracking already exists**: The AgentLoop tracks cumulative token usage via `estimateTokens(text.length / 3.5)`. If tracked usage exceeds 80% of the current tier's capacity, the DeepLoop logs a warning. This is observability, not dynamic resizing — it tells us if the tiers are misconfigured.
3. **Tier upgrade on retry**: If a task fails with `stopReason: 'max_tokens'` or the stall detector fires, and the task was at `standard`, it can be re-queued at `extended`. This is a per-task retry, not a mid-conversation resize.

#### 28.4.3 Coder Tier Selection

The Coder receives a scoped prompt every time — file contents + plan step + style notes. We know the exact content before calling the model, so we can **measure** instead of estimate:

```typescript
function selectCoderTier(
  stepPrompt: string,
  fileContents: string,
  preamble: string,
): keyof ContextTierConfig {
  const estimatedTokens = Math.ceil(
    (stepPrompt.length + fileContents.length + preamble.length) / 3.5
  );

  // Add buffer for response generation (the model needs room to write code)
  const withBuffer = estimatedTokens + 2000; // ~2K tokens response budget

  if (withBuffer < 6000) return 'compact';
  if (withBuffer < 14000) return 'standard';
  return 'extended';
}
```

This is the most precise tier selection — it's based on measured content, not operation type heuristics. The 2K response buffer is conservative; adjust via `coder.response_buffer_tokens: 2000`.

### 28.5 Implementation: How `num_ctx` Flows Through the System

The existing codebase already supports per-request `num_ctx` via `providerOptions` in `GenerateRequest` (see `src/providers/base.ts:44`). The `OllamaProvider` spreads `providerOptions` into the `options` field (see `src/providers/ollama.ts:252`). The plumbing is already there.

What's needed:

#### 28.5.1 New File: `src/dual-loop/context-tiers.ts`

```typescript
/**
 * Context Tiers — Dynamic num_ctx selection for the dual-loop architecture.
 *
 * Each loop selects a context tier (compact/standard/extended) per-operation.
 * The tier maps to a specific num_ctx value that Ollama uses for KV cache
 * allocation. This replaces the fixed num_ctx=40960 with operation-aware sizing.
 *
 * Invariant: Tier selection is deterministic and based on known-before-call
 * information (operation type, diff size, prompt content). No runtime prediction.
 */

export interface ContextTierConfig {
  compact: number;
  standard: number;
  extended: number;
}

export interface ContextTiersConfig {
  fast: ContextTierConfig;
  deep: ContextTierConfig;
  coder: ContextTierConfig;
}

export type ContextTier = keyof ContextTierConfig;

// --- Tier selection functions ---

export function selectFastTier(operation: FastOperation): ContextTier { /* ... */ }
export function selectDeepTier(task: Task): ContextTier { /* ... */ }
export function selectCoderTier(promptLength: number): ContextTier { /* ... */ }

// --- num_ctx resolution ---

export function resolveNumCtx(
  tiers: ContextTierConfig,
  tier: ContextTier,
): number {
  return tiers[tier];
}
```

#### 28.5.2 Changes to FastLoop (`src/dual-loop/fast-loop.ts`)

Each FastLoop operation selects its tier and passes `num_ctx` via `providerOptions`:

```typescript
// Inside FastLoop.handleUserMessage():
async handleUserMessage(event: UserMessageEvent): Promise<void> {
  const tier = selectFastTier('triage');
  const numCtx = resolveNumCtx(this.tiers.fast, tier);

  const request: GenerateRequest = {
    prompt: buildTriagePrompt(event),
    systemPrompt: TRIAGE_SYSTEM_PROMPT,
    temperature: 0.3,
    maxTokens: 1024,
    providerOptions: { num_ctx: numCtx },
  };

  const response = await this.provider.generateWithTools(request, this.tools);
  // ... handle triage result
}
```

The same pattern applies to `reviewTask()`, `deliverResponse()`, etc. Each method calls `selectFastTier()` with its operation type.

#### 28.5.3 Changes to DeepLoop (`src/dual-loop/deep-loop.ts`)

The DeepLoop selects a tier once when claiming a task and passes it to the AgentLoop:

```typescript
// Inside DeepLoop.planAndExecute():
async planAndExecute(task: Task): Promise<void> {
  const tier = selectDeepTier(task);
  const numCtx = resolveNumCtx(this.tiers.deep, tier);

  // The AgentLoop needs to pass num_ctx on every LLM call within the
  // multi-turn ReAct loop. We inject it via the agent config.
  const agentLoop = createAgentLoop({
    ...this.agentConfig,
    providerOptions: { num_ctx: numCtx },
  });

  const outcome = await agentLoop.run(trigger);
  // ...
}
```

This requires a small addition to `AgentLoopConfig` — a `providerOptions` field that gets spread into every `GenerateRequest` the loop makes. This is a non-breaking change: existing callers don't pass it and get the provider's default `num_ctx`.

#### 28.5.4 Changes to AgentLoop (`src/autonomous/agent-loop.ts`)

Add `providerOptions` to the config and spread it into each request:

```typescript
// In AgentLoopConfig (new optional field)
interface AgentLoopConfig {
  // ... existing fields ...
  /** Provider-specific options applied to every request (e.g., { num_ctx: 24576 }) */
  providerOptions?: Record<string, unknown>;
}

// In the ReAct loop, when building the GenerateRequest:
const request: GenerateRequest = {
  prompt: userPrompt,
  systemPrompt: systemPrompt,
  temperature: this.config.temperature ?? 0.2,
  maxTokens: this.config.maxResponseTokens ?? 4096,
  previousAssistantMessages: this.previousAssistantMessages,
  providerOptions: this.config.providerOptions, // <-- new
};
```

#### 28.5.5 Changes to OllamaProvider (`src/providers/ollama.ts`)

No changes needed. The provider already merges `providerOptions` into `options`:

```typescript
// ollama.ts:248-253 — already handles this correctly
options: {
  temperature: request.temperature ?? 0.7,
  num_predict: request.maxTokens ?? 2048,
  ...(this.numCtx ? { num_ctx: this.numCtx } : {}),
  ...(request.providerOptions ?? {}),  // <-- per-request num_ctx overrides instance default
},
```

Per-request `providerOptions.num_ctx` already overrides the instance-level `this.numCtx`. This is the existing behavior — we just start using it.

#### 28.5.6 Changes to ConcurrentProvider (`src/providers/concurrent.ts`)

No changes needed. The `ConcurrentProvider.generate()` passes the full `GenerateRequest` (including `providerOptions`) through to the underlying provider. The tier-selected `num_ctx` flows through transparently.

### 28.6 Memory Impact

#### 28.6.1 KV Cache Size Estimation

KV cache memory depends on model architecture. For Qwen-family models with grouped-query attention (GQA) and Q8_0 quantized KV:

| Model | KV Cache per 1K Tokens (est.) | Compact | Standard | Extended |
|-------|------------------------------|---------|----------|----------|
| qwen3.5:27b | ~45 MB/1K | 0.18 GB | 0.55 GB | 1.11 GB |
| qwen3.5:122b-a10b | ~70 MB/1K | 0.57 GB | 1.72 GB | 2.87 GB |
| qwen3-coder-next | ~50 MB/1K | 0.41 GB | 0.82 GB | 1.64 GB |

*Note: These are estimates. Actual values depend on num_kv_heads, head_dim, and quantization. Measure with `ollama ps` after deployment.*

#### 28.6.2 Typical Workload Comparison

**Scenario A: Fixed `num_ctx` (current design)**

All three models at their fixed maximum context:
```
27B at 32K:     ~1.47 GB
122B at 41K:    ~2.87 GB
Coder at 32K:   ~1.64 GB
Total KV:       ~5.98 GB
Free:           128 - 112 - 5.98 = 10.02 GB headroom
```

**Scenario B: Tiered `num_ctx` (typical mixed workload)**

FastLoop triaging (compact), DeepLoop planning (standard), Coder idle:
```
27B at 4K:      ~0.18 GB
122B at 25K:    ~1.72 GB
Coder idle:     0 GB
Total KV:       ~1.90 GB
Free:           128 - 112 - 1.90 = 14.10 GB headroom
```

**Scenario C: Tiered `num_ctx` (all loops active, worst case)**

FastLoop reviewing large diff (extended), DeepLoop planning (extended), Coder generating (standard):
```
27B at 25K:     ~1.11 GB
122B at 41K:    ~2.87 GB
Coder at 16K:   ~0.82 GB
Total KV:       ~4.80 GB
Free:           128 - 112 - 4.80 = 11.20 GB headroom
```

| Metric | Fixed (A) | Typical Tiered (B) | Worst Tiered (C) |
|--------|-----------|-------------------|------------------|
| **KV cache total** | 5.98 GB | 1.90 GB | 4.80 GB |
| **Free headroom** | 10.02 GB | 14.10 GB | 11.20 GB |
| **vs. Fixed** | baseline | -4.08 GB (68% less) | -1.18 GB (20% less) |

The typical case recovers **~4 GB** of headroom. The worst case is still better than fixed allocation.

### 28.7 Latency Impact (The Bigger Win)

Context length affects inference speed in two ways:

1. **Prompt processing** (prefill): Time to process the input tokens. Scales roughly linearly with token count.
2. **Per-token generation**: Each output token attends to all preceding tokens. Longer contexts mean slower generation.

Estimated latency impact for the 27B (FastLoop's model):

| Operation | Fixed 32K `num_ctx` | Compact 4K `num_ctx` | Speedup |
|-----------|--------------------|--------------------|---------|
| First-token latency | ~2-3s | ~0.3-0.5s | **~5x** |
| Per-token generation | ~30ms | ~20ms | ~1.5x |
| Total for 200-token triage response | ~8-9s | ~4-5s | **~2x** |

For the FastLoop's 2-second heartbeat target, the difference between 0.5s and 3s first-token is the difference between **feeling instant** and **feeling slow**. Compact triage at 4K context puts the FastLoop comfortably within its responsiveness target.

The DeepLoop benefits less (it's doing long-running work), but the Coder benefits significantly — compact dispatch at 8K is measurably faster than fixed 32K for small code generation tasks.

### 28.8 Configuration

#### 28.8.1 Full YAML Addition

```yaml
# Addition to dual_loop section in config/autonomous.yaml
dual_loop:
  # ... existing fast/deep/task_board config ...

  # ─────────────────────────────────────────────────────────────────────────
  # DYNAMIC CONTEXT TIERS
  # ─────────────────────────────────────────────────────────────────────────
  # Per-model context window tiers. Each loop selects a tier per-operation
  # to minimize KV cache memory and maximize inference speed.
  #
  # Values are in tokens. Ollama uses num_ctx to allocate the KV cache.
  # Smaller num_ctx = less memory + faster inference.
  #
  # Tier selection is deterministic (based on operation type, not prediction).
  # See docs/dual-loop-architecture.md Section 28 for full design.
  context_tiers:
    fast:
      compact: 4096
      standard: 12288
      extended: 24576
      # Diffs with more lines than this threshold use 'extended' tier
      review_large_threshold_lines: 150

    deep:
      compact: 8192
      standard: 24576
      extended: 40960
      # If tracked tokens exceed this fraction of num_ctx, log a warning
      context_pressure_warning_threshold: 0.80

    coder:
      compact: 8192
      standard: 16384
      extended: 32768
      # Tokens reserved for response generation (added to prompt estimate)
      response_buffer_tokens: 2000

  # Ollama environment recommendation (set in shell or systemd unit):
  # OLLAMA_FLASH_ATTENTION=1  — reduces KV cache memory ~2x with GQA models
  # This should be enabled regardless of whether tiers are used.
```

#### 28.8.2 Zod Validation Schema

```typescript
const contextTierSchema = z.object({
  compact: z.number().int().min(1024).max(131072),
  standard: z.number().int().min(1024).max(131072),
  extended: z.number().int().min(1024).max(131072),
}).refine(
  (t) => t.compact <= t.standard && t.standard <= t.extended,
  'Tiers must be ordered: compact <= standard <= extended',
);

const contextTiersConfigSchema = z.object({
  fast: contextTierSchema.extend({
    review_large_threshold_lines: z.number().int().min(10).default(150),
  }),
  deep: contextTierSchema.extend({
    context_pressure_warning_threshold: z.number().min(0.5).max(0.99).default(0.80),
  }),
  coder: contextTierSchema.extend({
    response_buffer_tokens: z.number().int().min(500).default(2000),
  }),
});
```

### 28.9 Interaction with Existing Systems

#### 28.9.1 ContextManager (Tiered Memory)

The `ContextManager` in `src/autonomous/context-manager.ts` tracks token usage across hot/warm tiers and has a `contextWindowTokens` config field (currently `32768`). With dynamic tiers, `contextWindowTokens` is no longer a fixed value — it depends on which tier the current operation selected.

**Change required:** The `ContextManager` needs to accept `contextWindowTokens` as a mutable parameter, not a fixed config value. Add a method:

```typescript
// Addition to ContextManager
setContextWindow(tokens: number): void {
  this.config.contextWindowTokens = tokens;
}
```

The DeepLoop calls `contextManager.setContextWindow(numCtx)` once when it claims a task (same time it selects the tier). This updates the warm tier's eviction logic to respect the actual allocated context window.

The FastLoop doesn't use the ContextManager (it has no warm tier — each call is independent). No change needed.

#### 28.9.2 AgentLoop Token Tracking

The `AgentLoop` tracks cumulative token usage per cycle via `estimateTokens()`. This tracking is used for budget enforcement (`maxTokensPerCycle`), not for `num_ctx` decisions. No change needed — the tracking continues to work regardless of `num_ctx`.

However, we add **one new check**: if the cumulative token estimate for the current turn's context (system prompt + conversation + tool results) exceeds `contextPressureWarningThreshold × num_ctx`, log a warning:

```typescript
// In the AgentLoop's main turn loop, after building the prompt:
const currentContextTokens = estimateTokens(
  systemPrompt + userPrompt + toolResultsText
);
const numCtx = this.config.providerOptions?.num_ctx as number | undefined;

if (numCtx && currentContextTokens > numCtx * pressureThreshold) {
  tracer.log('agent', 'warn', 'Context pressure high', {
    estimated: currentContextTokens,
    numCtx,
    ratio: (currentContextTokens / numCtx).toFixed(2),
    tier: this.config.contextTier,  // for debugging
  });
}
```

This is observability, not control flow. It tells us when the tier configuration needs tuning.

#### 28.9.3 ReasoningScaler (bestOfN)

The `ReasoningScaler` uses `ConcurrentProvider.bestOfN()` for hard problems, dispatching multiple Coder generations in parallel. Each generation inherits the `providerOptions` from the `GenerateRequest` — including the tier-selected `num_ctx`. No change needed. All candidates in a bestOfN batch get the same `num_ctx` (appropriate, since they're solving the same problem with the same context).

#### 28.9.4 Voice Filter

The voice filter currently uses the 122B (`voice_filter.model: qwen3.5:122b`). In the dual-loop, it moves to the 27B (Section 18). With dynamic tiers, the voice filter always uses the **compact** tier — it's a short text rewrite (~500 tokens in, ~500 out). This is handled by `selectFastTier('voice_filter')` returning `'compact'`.

#### 28.9.5 Dream Cycles

Dream cycles run inside the DeepLoop as low-priority scheduled tasks. They use the same tier selection as any other DeepLoop task:

- **Consolidation** (reading journal, compressing reflections): `standard` — reads moderate context, produces summaries
- **Exploration** (code archaeology, pattern detection): `extended` — needs to hold multiple file contents
- **Self-model rebuild**: `standard` — reads structured state, produces a summary

The dream cycle task's `planSteps` count drives tier selection via the normal `selectDeepTier()` logic.

### 28.10 Edge Cases and Failure Modes

#### 28.10.1 Ollama Ignores `num_ctx` on Warm KV Cache Hit

**Scenario:** The 27B processes a triage at `num_ctx: 4096`. Next request is a code review at `num_ctx: 12288`. Ollama has the 27B's KV cache still warm from the triage.

**Behavior:** When `num_ctx` changes between requests to the same model, Ollama invalidates the warm KV cache and allocates a new one at the requested size. This is expected and correct — the FastLoop doesn't reuse context between calls anyway.

**Risk:** If Ollama silently ignores the new `num_ctx` and reuses the old 4K cache for a 12K prompt, the prompt would be truncated. This would be an Ollama bug, not a design flaw. **Mitigation:** On deployment, verify with `ollama ps` that the loaded model's context changes between requests with different `num_ctx` values. Add a one-time validation test to the integration test suite.

#### 28.10.2 Extended Tier Still Too Small

**Scenario:** A task involves a massive refactor touching 20 files. The DeepLoop's `extended` tier (40960 tokens) isn't enough — the accumulated context exceeds 41K tokens around turn 30.

**Behavior:** Ollama truncates the oldest messages. The AgentLoop's context pressure warning fires. The DeepLoop may produce incoherent output because it's lost early conversation turns.

**Mitigation chain:**
1. The context pressure warning logs the issue for post-hoc analysis.
2. The stall detector (Section 23.2) catches if the DeepLoop starts repeating itself due to lost context.
3. If the task fails, the LoopCoordinator can retry with a **higher max** — but only if we add a fourth tier or allow raw `num_ctx` override. For now, 41K is the hard ceiling on the 122B (same as today's fixed value). This edge case exists regardless of dynamic tiers.
4. Long-term fix: The ContextManager's warm tier eviction should be more aggressive when context pressure is high — evict stale file contents and tool results to make room for the current turn.

#### 28.10.3 Multiple Concurrent Requests with Different `num_ctx`

**Scenario:** The FastLoop sends a triage at `num_ctx: 4096` to the 27B at the same instant the DeepLoop sends a planning request at `num_ctx: 40960` to the 122B.

**Behavior:** No conflict — they're different models. Ollama allocates independent KV caches per model. The 27B gets a 4K cache, the 122B gets a 41K cache. Total memory is within budget because we sized the tiers with concurrent usage in mind (Section 28.6.2, Scenario C).

**Scenario B:** Two requests to the *same* model with different `num_ctx` (e.g., DeepLoop dispatches to Coder at `num_ctx: 8192`, then immediately dispatches again at `num_ctx: 16384` before the first completes).

**Behavior:** Ollama handles this with its internal request queue (`OLLAMA_NUM_PARALLEL`). Each request gets its own KV cache at its requested size. With `OLLAMA_NUM_PARALLEL=2`, both run concurrently. With `OLLAMA_NUM_PARALLEL=1`, the second queues behind the first.

**Risk:** If `OLLAMA_NUM_PARALLEL > 1`, both KV caches exist simultaneously. Two Coder requests at `extended` (32K each) would allocate ~3.3 GB of KV cache for the Coder alone. This is fine within our budget but worth monitoring.

#### 28.10.4 Config Validation: Tiers Must Be Ordered

**Scenario:** Someone edits `autonomous.yaml` and sets `compact: 16384, standard: 8192` (inverted).

**Mitigation:** The Zod schema enforces `compact <= standard <= extended`. Startup fails fast with a clear error: `"Tiers must be ordered: compact <= standard <= extended"`.

#### 28.10.5 Tier Selection Disagreement Between ContextManager and AgentLoop

**Scenario:** The DeepLoop selects `standard` (24576) for a task. The AgentLoop starts building context. After 5 turns, the warm tier has 8K tokens and the hot tier has 2K tokens. The ContextManager thinks `contextWindowTokens` is 24576. The AgentLoop thinks it can accumulate up to `maxTokensPerCycle` (500K across all turns). These are different ceilings measuring different things.

**Clarification:** There is no disagreement. These track different things:
- `contextWindowTokens` (ContextManager): How many tokens fit in a *single LLM call* (the prompt + response). Governs warm tier eviction.
- `maxTokensPerCycle` (AgentLoop): Cumulative budget across *all turns in a cycle*. Governs when to stop the ReAct loop.

Both operate correctly regardless of `num_ctx`. The tier system only affects `contextWindowTokens` (the ContextManager's window). `maxTokensPerCycle` is unchanged.

#### 28.10.6 OLLAMA_FLASH_ATTENTION Interaction

**Scenario:** `OLLAMA_FLASH_ATTENTION=1` is set (recommended). This uses Flash Attention, which reduces KV cache memory by ~2x for models with GQA.

**Impact on tiers:** Flash Attention makes all tier values cheaper in memory terms. The tier values don't change (they're in tokens, not bytes), but the actual memory consumed per tier is halved. This effectively doubles our headroom. All the memory estimates in Section 28.6 should be halved if Flash Attention is enabled.

**Recommendation:** Always enable `OLLAMA_FLASH_ATTENTION=1`. Add it to the deployment checklist and verify in the health check.

#### 28.10.7 Tier Selection for Unknown/New Operations

**Scenario:** A new FastLoop operation is added (e.g., `'summarize_journal'`) but the developer forgets to add it to `selectFastTier()`.

**Mitigation:** TypeScript's exhaustive switch pattern. The `FastOperation` type is a union, and the switch statement covers all cases. Adding a new operation without updating the switch causes a compile-time error (via the `default: never` pattern):

```typescript
function selectFastTier(operation: FastOperation): ContextTier {
  switch (operation) {
    case 'triage': return 'compact';
    // ... other cases ...
    default: {
      const _exhaustive: never = operation;
      return 'standard'; // Fallback at runtime, error at compile time
    }
  }
}
```

### 28.11 Observability and Tuning

#### 28.11.1 Logging

Every LLM call logs the selected tier and `num_ctx`:

```
[fast-loop] [debug] Tier: compact (num_ctx=4096) for operation=triage
[deep-loop] [debug] Tier: standard (num_ctx=24576) for task=task-m3k8a
[deep-loop] [warn]  Context pressure: 0.83 of num_ctx=24576 (estimated 20398 tokens)
[coder]     [debug] Tier: compact (num_ctx=8192) for step="Add JWT validation"
```

#### 28.11.2 Metrics for Tuning

| Metric | How to Measure | What It Tells You |
|--------|---------------|------------------|
| **Tier distribution** | Count calls per tier per model | If `extended` is used >50% of the time, the `standard` value may be too low |
| **Context pressure rate** | % of turns above 80% threshold | If >10% of turns hit pressure, bump tier values or improve warm tier eviction |
| **Truncation events** | Ollama logs when context is truncated | Direct evidence that a tier is too small |
| **FastLoop latency by tier** | Time from request to first token | Validates that compact tier actually delivers the expected speedup |
| **Memory usage by tier** | `ollama ps` KV cache size | Ground truth for the memory estimates in Section 28.6 |

#### 28.11.3 Tuning Guidance

After deployment, observe for 1-2 weeks, then tune:

1. **If FastLoop feels sluggish on triage**: Verify it's using `compact`. If yes, the model may need a smaller context or the prompt is too long. Check prompt token count.
2. **If DeepLoop context pressure warnings are frequent**: Bump `standard` from 24576 to 28672, or improve warm tier eviction to be more aggressive on stale entries.
3. **If Coder generates truncated code**: The `response_buffer_tokens` may be too low for the types of code being generated. Increase to 3000-4000.
4. **If memory usage is consistently low**: You can afford to raise tier values or add more headroom to `standard`.

### 28.12 Implementation Order

This feature integrates into the existing Phase 2 (FastLoop) and Phase 3 (DeepLoop) of the dual-loop implementation. It is NOT a separate phase — it's woven into the loop implementations.

#### Step 1: Foundation (during Phase 1 — TaskBoard)
- Add `context_tiers` to `config/autonomous.yaml`
- Add Zod validation for the new config section
- Create `src/dual-loop/context-tiers.ts` with types, tier selection functions, and `resolveNumCtx()`
- Add `providerOptions` field to `AgentLoopConfig`
- Add context pressure warning to `AgentLoop`'s turn loop
- Write unit tests: tier selection for all operation types, config validation, pressure warning

#### Step 2: Integration (during Phase 2 — FastLoop)
- Wire `selectFastTier()` into every FastLoop operation
- Pass `providerOptions: { num_ctx }` in every FastLoop `GenerateRequest`
- Add `review_large_threshold_lines` to FastLoop config
- Write unit tests: verify correct tier selected for each operation type

#### Step 3: Integration (during Phase 3 — DeepLoop)
- Wire `selectDeepTier()` into `planAndExecute()` and task claim
- Pass `providerOptions` through to `AgentLoop` config
- Add `setContextWindow()` to `ContextManager`
- Wire Coder dispatch through `selectCoderTier()`
- Write unit tests: tier selection for various task shapes, context pressure flow

#### Step 4: Validation (during Phase 5 — LoopCoordinator)
- Add tier metrics to the health dashboard (Section 26.1)
- Add tier logging to the observability system (Section 26.2)
- Write integration test: verify `ollama ps` shows expected KV cache sizes for different tier selections
- Benchmark: measure FastLoop triage latency at compact vs extended tier
- Document the `OLLAMA_FLASH_ATTENTION=1` recommendation

### 28.13 Invariant Compliance

| # | Invariant | Compliant? | Notes |
|---|-----------|-----------|-------|
| 1 | All inference local via Ollama | Yes | `num_ctx` is an Ollama option. No cloud involvement. |
| 2 | Providers behind stable LlmProvider | Yes | `providerOptions` is an existing field in `GenerateRequest`. No interface change. |
| 3 | Security centralized in src/security/ | Yes | No security changes. |
| 4 | Logging through safe-logger | Yes | Tier logging uses existing `getTracer()`. No raw user content logged. |
| 5 | Config validated at startup | Yes | Zod schema validates tier ordering and ranges. |
| 6 | Model selection task-based | Yes | Tier selection is operation-based, extending the same principle. |
| 7 | Agent loop shared execution path | Yes | Both loops use the same `AgentLoop` class, same `providerOptions` mechanism. |
| 8 | Journal append-only | Yes | No journal changes. |
| 9 | Delegation transparent | Yes | Tier selection is logged and auditable. |

### 28.14 Why Not Continuous Dynamic Resizing?

For completeness, here's why the **naive version** (grow `num_ctx` mid-conversation when tokens approach the limit) was rejected:

1. **KV cache invalidation**: Changing `num_ctx` mid-conversation forces Ollama to discard the KV cache and re-process the entire conversation from scratch. At turn 30 with 25K tokens on the 122B, this costs 15-30 seconds of pure re-processing.

2. **Compounding cost**: Each resize pays more than the last (more tokens to re-process). If you resize at 8K, 16K, and 32K, you re-process 8K + 16K + 32K = 56K tokens total — nearly double the actual content.

3. **Prediction is unreliable**: Estimating future token usage requires knowing how many more turns the task will take and how much context each turn adds. This is inherently unpredictable.

4. **The cost of being wrong (small)**: If you start too small and need to grow, you pay the re-processing tax. The tiers avoid this by starting at the right size.

5. **The cost of being wrong (large)**: If you start too large, you waste memory and speed. But this is the *current* behavior (fixed 40K), so it's strictly no worse than today.

The three-tier approach gives 80% of the benefit (right-sized for most operations) with none of the cost (no mid-conversation resizes). The remaining 20% (perfectly sized for every operation) isn't worth the complexity and latency penalty of continuous resizing.

### 28.15 Future Extensions (Not for Initial Implementation)

These ideas are noted for potential future work but are explicitly **out of scope** for the initial implementation:

1. **Shared context memory pool**: Instead of fixed per-model tiers, a global KV memory budget that the LoopCoordinator allocates dynamically across models based on current workload. Complex coordination for modest benefit — defer until tiers prove insufficient.

2. **Adaptive tier learning**: Track which operations actually need which tier sizes over time and auto-adjust the tier values. Requires sufficient data (weeks of operation logs). Run manually first: review the metrics in Section 28.11.2, then adjust YAML values.

3. **Mid-conversation tier upgrade with context replay**: If the DeepLoop hits context pressure, pause the ReAct loop, serialize the essential context (plan + key findings), resize to `extended`, and replay the serialized context as a fresh prompt. This is a softer version of the rejected continuous resizing — it only happens on detected pressure, and it uses a curated summary instead of replaying the full conversation. Feasible but complex. Defer until context pressure warnings prove to be a real operational problem.

4. **Per-turn `num_ctx` within the DeepLoop**: Instead of one tier per task, adjust per-turn. Early turns (reading files) need more context; later turns (running tests) need less. Requires deep integration with the ReAct loop and incurs KV cache invalidation on every tier change. Not worth the complexity.
