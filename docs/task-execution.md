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
