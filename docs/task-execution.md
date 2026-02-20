# Task Execution

> **Source**: `src/tasks/`
> **Entry point**: `createTaskManager(options).handle(message, history, provider)`

When a user message requires action, the task execution pipeline classifies it, decomposes it into a plan, executes the plan as a dependency graph, verifies the result, and logs the outcome for future learning.

## Pipeline Overview

```
User message
    │
    ▼
┌──────────────┐
│  Classifier  │  conversation? → return to normal LLM response
│              │  simple_task or complex_task? → continue ▼
└──────┬───────┘
       │
       ▼
┌──────────────┐
│   Planner    │  Decompose into steps with dependency graph
└──────┬───────┘
       │
       ▼
┌──────────────┐
│   Runner     │  Execute steps (DAG walk, parallel where possible)
└──────┬───────┘
       │
       ▼
┌──────────────┐
│  Verifier    │  Step-level checks + LLM judge for overall criteria
└──────┬───────┘
       │
       ▼
┌──────────────┐
│ Exec. Log    │  Record outcome for operational memory
└──────────────┘
```

## Classifier

> **Source**: `src/tasks/classifier.ts`

Determines whether an incoming message is:

| Class | Meaning | Pipeline action |
|-------|---------|-----------------|
| `conversation` | Chatting, questions, small talk | Skip — use normal LLM response |
| `simple_task` | Single tool call (e.g. "check my calendar") | Plan → Execute → Verify |
| `complex_task` | Multi-step workflow requiring coordination | Plan → Execute → Verify |

**How it works**: A focused LLM call with `classify_message` as the **only** available tool, forcing structured output. Context is kept minimal — just the current message and last 3 exchanges — for fast classification on local models.

**Defaults to conversation** unless the message is clearly and purely a task command. This ensures natural conversational responses aren't suppressed.

**Output**:

```typescript
interface ClassificationResult {
  taskClass: 'conversation' | 'simple_task' | 'complex_task';
  confidence: number;       // 0–1
  reason: string;           // Brief explanation
  taskType?: string;        // e.g. 'calendar', 'file_operation', 'coding'
}
```

Uses the `classifier` context profile (low token budget, low temperature).

## Planner

> **Source**: `src/tasks/planner.ts`

Decomposes a user instruction into a structured `TaskPlan` with ordered steps, a dependency graph, and verification criteria.

**How it works**: A focused LLM call with `create_plan` as the only available tool. The system prompt lists all available tools with their parameter schemas, plus relevant execution history for learning from past outcomes.

**Key behaviors**:
- Each step calls exactly one tool
- Steps with no dependencies can run in parallel
- Includes verification criteria for each step
- Validates plan for missing required parameters — retries once with feedback if params are missing
- Falls back to a single-step error plan if the LLM doesn't cooperate

**Output**:

```typescript
interface TaskPlan {
  goal: string;
  completionCriteria: string[];
  steps: TaskStep[];
}

interface TaskStep {
  id: string;                              // "step-1", "step-2"
  description: string;                     // Human-readable
  tool: string;                            // Tool to call
  input: Record<string, unknown>;          // Tool parameters
  dependsOn: string[];                     // Step IDs that must complete first
  verification: Verification;              // How to check success
}
```

**Verification types**:

| Type | Check |
|------|-------|
| `exit_code` | Compare tool exit code to expected value |
| `file_exists` | Check if file was created at path |
| `output_contains` | Substring match on tool output |
| `schema` | Validate JSON output against a schema |
| `llm_judge` | LLM evaluates whether the step succeeded |
| `none` | No verification |

Uses the `planner` context profile.

### Operational Memory Integration

The planner receives the last 5 execution records for the same task type from the execution log. This includes:
- Which tools succeeded or failed
- Failure reasons
- Execution duration

This allows the planner to avoid known-broken approaches and prefer reliable tools.

## Runner

> **Source**: `src/tasks/runner.ts`

Executes a `TaskPlan` by walking the dependency graph:

1. Build adjacency map from `dependsOn` fields
2. Find steps with all dependencies satisfied → ready batch
3. Execute ready steps concurrently (up to `maxConcurrency`) via semaphore
4. On success: mark complete, check what new steps are unblocked
5. On failure: mark failed, skip all transitive dependents
6. Detect and handle deadlocks (log warning, skip remaining)

**Configuration**:

| Option | Default | Description |
|--------|---------|-------------|
| `maxConcurrency` | `2` | Parallel step limit (2 for M4 Max to avoid overloading unified memory) |
| `maxRetries` | `2` | Retry attempts per step |
| `onStepComplete` | — | Optional callback for progress reporting |

**Input validation**: Before executing a step, the runner validates required parameters against a known-tool table. Steps with missing required params are fast-failed without retrying.

**Step execution flow**:
1. Validate required input params → fast-fail if missing
2. Call `orchestrator.execute(toolCall)`
3. If success: run step-level verification
4. If failure: retry up to `maxRetries`
5. Return `StepOutcome` with timing, retry count, and output

**Output**:

```typescript
interface TaskRunResult {
  plan: TaskPlan;
  stepOutcomes: StepOutcome[];
  overallSuccess: boolean;    // All steps succeeded
  durationMs: number;
}
```

## Verifier

> **Source**: `src/tasks/verifier.ts`

Two levels of verification:

### Step-Level Verification

Fast, synchronous checks run after each step succeeds:

| Check | How |
|-------|-----|
| `exit_code` | Compare `result.exitCode` to expected |
| `file_exists` | `existsSync(path)` |
| `output_contains` | `result.output.includes(substring)` |
| `schema` | Parse JSON, check required fields and top-level types |
| `llm_judge` | Deferred to task-level (requires LLM call) |
| `none` | Always passes |

### Task-Level Verification

After all steps complete, an LLM evaluates whether the plan's `completionCriteria` are met given the step outcomes. Uses the `verify_task` tool to force structured output.

Falls back to step-level aggregate (`all steps succeeded?`) if the LLM call fails.

Uses the `verifier` context profile.

## Task Manager

> **Source**: `src/tasks/manager.ts`

The top-level orchestrator that ties the full pipeline together. Single entry point for the daemon:

```typescript
const manager = createTaskManager({
  orchestrator,          // ToolOrchestrator with registered executors
  executionLog,          // Operational memory
  availableTools,        // Tool schemas for the planner
  maxConcurrency: 2,
  maxRetries: 2,
});

const result = await manager.handle(message, recentHistory, provider);
// result.classification  — what kind of message
// result.response        — text to send back to user
// result.taskResult      — full execution details (if task was run)
```

**Response building**: On success, returns a summary of what was done. On failure, includes step-by-step failure details.

**Privacy**: Instructions are truncated to 100 chars before being stored in the execution log. Raw user content is never logged.

## Execution Log (Operational Memory)

> **Source**: `src/tasks/execution-log.ts`

Append-only JSONL log of completed task executions. Stored at `~/.casterly/execution-log/log.jsonl`.

**Bounds**: Max 500 records or 30 days, whichever is smaller. Compacted on load.

**Queries**:

| Method | Purpose |
|--------|---------|
| `queryByType(taskType, limit)` | Find past executions of the same task type |
| `queryByTool(toolName, limit)` | Find executions that used a specific tool |
| `getRecent(limit)` | Most recent records |
| `getToolReliability(toolName)` | Success rate, failure reasons for a tool |
| `getTaskTypes()` | All unique task types seen |

**Tool reliability stats**: Aggregates success rate, total calls, total failures, and the top 5 most common failure reasons for any tool.

## Key Files

| File | Purpose |
|------|---------|
| `src/tasks/types.ts` | Shared types: `TaskClass`, `TaskPlan`, `TaskStep`, `StepOutcome`, `ExecutionRecord` |
| `src/tasks/classifier.ts` | Message classification via forced tool use |
| `src/tasks/planner.ts` | Plan decomposition with parameter validation and retry |
| `src/tasks/runner.ts` | DAG executor with semaphore-bounded concurrency |
| `src/tasks/verifier.ts` | Step-level checks + LLM judge for task-level verification |
| `src/tasks/manager.ts` | Top-level orchestrator (classify → plan → run → verify → log) |
| `src/tasks/execution-log.ts` | Bounded JSONL log for operational memory |
| `src/tasks/index.ts` | Public exports |

---

## Vision Reconciliation Notes — IMPLEMENTED

The task execution pipeline is the module most directly contradicted by the vision. The vision says the pipeline should become optional tools the LLM invokes by judgment, not a mandatory sequence every message traverses. All reconciliation items below have been implemented.

### 1. Convert the mandatory pipeline into optional agent tools — IMPLEMENTED

**Current:** `src/tasks/manager.ts` (lines 88-202) enforces classify → plan → execute → verify as a mandatory sequence. Every task message goes through all four stages regardless of complexity.

**Why change:** The vision says "classification, planning, execution strategy, verification [...] are all decisions the LLM makes — guided by its system prompt, not enforced by a state machine in code." A simple file read doesn't need planning. A quick question doesn't need classification. The LLM should decide.

**What to do:** Create four agent tools that wrap the existing logic:
- `classify_task` — wraps `classifyMessage()`. The LLM calls it when it wants help categorizing a request.
- `plan_task` — wraps `createTaskPlan()`. The LLM calls it when a task is complex enough to warrant decomposition.
- `run_plan` — wraps `runTaskPlan()`. Executes a plan the LLM has created.
- `verify_outcome` — wraps `verifyTaskOutcome()`. The LLM calls it when it wants to verify a completed task.

The system prompt should describe the default workflow ("for complex multi-step tasks, consider planning first; for simple actions, just do them") but the LLM decides whether to follow it.

> **Status:** Pipeline stages available as agent tools (`classify`, `plan`, `verify`). The LLM invokes them by judgment, not as mandatory stages.

### 2. Retire `TaskManager.handle()` as an entry point — IMPLEMENTED

**Current:** `TaskManager.handle()` is the top-level orchestrator called by the iMessage pipeline. It owns the full classify → plan → execute → verify flow.

**Why change:** When the agent loop is the only execution path, `TaskManager.handle()` has no caller. The individual stages survive as tools; the orchestration becomes the LLM's responsibility.

**What to do:** Remove `TaskManager.handle()` as an entry point. Keep the individual modules (`classifier.ts`, `planner.ts`, `runner.ts`, `verifier.ts`) as implementations behind the new agent tools.

> **Status:** iMessage routed through trigger system. Agent loop is the sole execution path. Controller uses `runAgentCycle` instead of `runCycle`.

### 3. Keep the execution log — IMPLEMENTED

**Current:** `src/tasks/execution-log.ts` records completed task executions for operational memory.

**Why change:** This is already aligned with the vision. The execution log feeds the planner with past outcomes — exactly the kind of self-knowledge the vision promotes.

**What to do:** Keep as-is. The `plan_task` tool should continue to receive execution history. Additionally, the execution log data should feed into the self-model during dream cycles.

> **Status:** Execution log preserved. Already aligned with vision.

### 4. The planner and verifier remain valuable as tools — IMPLEMENTED

**Current:** The planner decomposes tasks into DAGs with dependencies. The verifier checks completion criteria.

**Why change:** These are genuinely useful capabilities. The issue is not that they exist, but that they're mandatory. As optional tools the LLM invokes when needed, they're well-designed and should be preserved.

**What to do:** Wrap them as agent tools. The planner is especially valuable for multi-file refactoring and complex coding tasks. The verifier is valuable when the LLM is uncertain about an outcome.

> **Status:** Planner and verifier available as agent tools (`plan`, `verify`). Total tools: 76.
