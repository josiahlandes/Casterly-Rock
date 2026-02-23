# Implementation Guide — Open Issues

This document is a session handoff for Claude (or any agent) working on the open issues in `docs/OPEN-ISSUES.md`. It contains the exact integration points, function signatures, file paths, and design decisions needed to start implementing immediately without re-reading the full codebase.

**Read this before starting work on any issue.**

---

## Codebase Quick Reference

### Key Interfaces (copy-paste ready)

```typescript
// src/tools/schemas/types.ts — The tool contract everything plugs into
interface ToolSchema {
  name: string;
  description: string;
  inputSchema: ToolInputSchema;
}

interface NativeToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

interface NativeToolResult {
  toolCallId: string;
  success: boolean;
  output?: string;
  error?: string;
  exitCode?: number;
}

interface NativeToolExecutor {
  toolName: string;
  execute: (call: NativeToolCall) => Promise<NativeToolResult>;
}

interface GenerateWithToolsResponse {
  text: string;
  toolCalls: NativeToolCall[];
  providerId: string;
  model: string;
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence';
}
```

```typescript
// src/providers/base.ts — How to call the LLM
interface LlmProvider {
  id: string;
  kind: 'local' | 'cloud';
  model: string;
  generateWithTools(
    request: GenerateRequest,
    tools: ToolSchema[],
    previousResults?: ToolResultMessage[]
  ): Promise<GenerateWithToolsResponse>;
}

interface GenerateRequest {
  prompt: string;
  systemPrompt?: string;
  maxTokens?: number;
  temperature?: number;
}
```

```typescript
// src/tools/orchestrator.ts — Where executors register
interface ToolOrchestrator {
  registerExecutor(executor: NativeToolExecutor): void;
  canExecute(toolName: string): boolean;
  execute(call: NativeToolCall): Promise<NativeToolResult>;
  executeAll(calls: NativeToolCall[]): Promise<NativeToolResult[]>;
  getRegisteredTools(): string[];
}
```

```typescript
// src/tools/schemas/registry.ts — Where tool schemas register
interface ToolRegistry {
  register(tool: ToolSchema): void;
  getTools(): ToolSchema[];
  getTool(name: string): ToolSchema | undefined;
  formatForOllama(): OllamaTool[];
}
```

```typescript
// src/interface/context.ts — Context assembly (will be extended by ISSUE-006)
interface AssembledContext {
  context: string;
  systemPrompt: string;
  history: string;
  currentMessage: string;
  historyMessagesIncluded: number;
  estimatedTokens: number;
}

// Default token config (maxContextTokens: 3500, reserveForResponse: 500, maxHistoryMessages: 10)
```

### Critical File Paths

| File | Role | When to Modify |
|------|------|---------------|
| `src/tools/schemas/types.ts` | All tool types | Adding new type definitions |
| `src/tools/schemas/core.ts` | Core tool schemas (BASH_TOOL) | Adding new core tool schemas |
| `src/tools/schemas/registry.ts` | Tool schema registry | If registry interface changes |
| `src/tools/executor.ts` | Bash executor + safety gates | ISSUE-004 (approval), ISSUE-007 (reference only) |
| `src/tools/orchestrator.ts` | Multi-executor coordination | Reference — new executors register here |
| `src/tools/index.ts` | Module exports | When adding new executor exports |
| `src/imessage/daemon.ts` | Main message loop (lines 131-224) | ISSUE-002 replaces the tool loop |
| `src/interface/context.ts` | Context assembly | ISSUE-006 extends this |
| `src/interface/memory.ts` | User-facing memory | ISSUE-005 builds alongside this |
| `src/providers/base.ts` | LLM provider interface | Reference only |
| `src/providers/ollama.ts` | Ollama implementation | Reference only |
| `src/testing/test-cases.ts` | Test case definitions | ISSUE-008 extends these |
| `src/testing/test-runner.ts` | Test execution | ISSUE-008 wraps this |
| `src/testing/trace.ts` | Request tracing | ISSUE-008 extends with metrics |
| `config/models.yaml` | Model assignments (protected) | Only via ISSUE-008 benchmark results |
| `src/logging/safe-logger.ts` | Privacy-safe logging | Route all new logs through this |

### Module Export Pattern

Every new module directory needs an `index.ts` that re-exports public types and functions. Follow the pattern in `src/tools/index.ts`. The project uses ES module syntax with `.js` extensions in imports:

```typescript
// Correct import style
import { foo } from './bar.js';
import type { Baz } from '../types.js';
```

### Quality Gates

After any changes: `npm run check` (runs typecheck + lint + tests + guardrails)

---

## ISSUE-007: Native Tool Executors

**Status:** Ready to implement
**Depends on:** Nothing
**Blocked by:** Nothing

### Implementation Plan

#### Step 1: Create tool schemas in `src/tools/schemas/core.ts`

Add schemas alongside BASH_TOOL. Each needs name, description, and inputSchema:

```typescript
export const READ_FILE_TOOL: ToolSchema = {
  name: 'read_file',
  description: 'Read the contents of a file. Returns the file content as text.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Absolute path to the file to read' },
      encoding: { type: 'string', description: 'File encoding (default: utf-8)', enum: ['utf-8', 'ascii', 'base64'] },
      maxLines: { type: 'integer', description: 'Maximum lines to read (default: all)' },
    },
    required: ['path'],
  },
};

export const WRITE_FILE_TOOL: ToolSchema = {
  name: 'write_file',
  description: 'Write content to a file. Creates the file if it does not exist.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Absolute path to the file to write' },
      content: { type: 'string', description: 'Content to write to the file' },
      append: { type: 'boolean', description: 'Append to file instead of overwriting (default: false)' },
    },
    required: ['path', 'content'],
  },
};

export const LIST_FILES_TOOL: ToolSchema = {
  name: 'list_files',
  description: 'List files and directories at a given path.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Directory path to list' },
      recursive: { type: 'boolean', description: 'List recursively (default: false)' },
      pattern: { type: 'string', description: 'Glob pattern to filter results (e.g. "*.ts")' },
    },
    required: ['path'],
  },
};

export const SEARCH_FILES_TOOL: ToolSchema = {
  name: 'search_files',
  description: 'Search for a text pattern in files. Returns matching lines with file paths and line numbers.',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Regex pattern to search for' },
      path: { type: 'string', description: 'Directory to search in (default: current directory)' },
      filePattern: { type: 'string', description: 'Glob pattern to filter files (e.g. "*.ts")' },
      maxResults: { type: 'integer', description: 'Maximum results to return (default: 50)' },
    },
    required: ['pattern'],
  },
};
```

Update `CORE_TOOLS` array to include all new schemas.

#### Step 2: Create executor files under `src/tools/executors/`

Each file exports a `createXxxExecutor(): NativeToolExecutor` function.

**`src/tools/executors/read-file.ts`**
- Use `node:fs/promises` readFile
- Validate path exists, is not a directory
- Respect maxLines by slicing
- Safety: block reads from sensitive paths (`.env*`, `config/*` credentials)
- Return `{ content, size, lines }` as JSON string in output

**`src/tools/executors/write-file.ts`**
- Use `node:fs/promises` writeFile/appendFile
- Create parent directories with `{ recursive: true }`
- Safety: block writes to protected paths from `docs/rulebook.md` list
- Return `{ path, bytesWritten, created }` as JSON string

**`src/tools/executors/list-files.ts`**
- Use `node:fs/promises` readdir with `withFileTypes: true`
- Recursive: walk subdirectories
- Pattern: use minimatch or simple glob
- Return `{ files: [{ name, path, type, size }] }` as JSON string

**`src/tools/executors/search-files.ts`**
- Use `child_process.execFile` with `grep -rn` or `rg` (check which is available)
- Parse output into structured matches
- Return `{ matches: [{ file, line, content }], totalMatches }` as JSON string

**`src/tools/executors/index.ts`**
- Import all creators
- Export `registerAllExecutors(orchestrator: ToolOrchestrator): void`
- This is called from daemon.ts after creating the orchestrator

#### Step 3: Wire into daemon

In `src/imessage/daemon.ts`, after `orchestrator.registerExecutor(createBashExecutor(...))`:
```typescript
import { registerAllExecutors } from '../tools/executors/index.js';
registerAllExecutors(orchestrator);
```

Update `src/tools/index.ts` to export the new executors.

#### Step 4: Tests

Add test cases in `tests/` for each executor. Focus on:
- Happy path read/write/list/search
- Error cases (file not found, permission denied)
- Safety gate enforcement (protected paths blocked)

---

## ISSUE-005: Operational Memory

**Status:** Ready to implement
**Depends on:** Nothing (types reference TaskPlan from ISSUE-002 but can use a placeholder)
**Blocked by:** Nothing

### Implementation Plan

#### Step 1: Create `src/tasks/types.ts`

Define shared types used by ISSUE-002 and ISSUE-005. This file is the foundation:

```typescript
/** Task classification result */
export type TaskClass = 'conversation' | 'simple_task' | 'complex_task';

/** Task plan — structured output from the planner */
export interface TaskPlan {
  goal: string;
  completionCriteria: string[];
  steps: TaskStep[];
}

export interface TaskStep {
  id: string;
  description: string;
  tool: string;
  input: Record<string, unknown>;
  dependsOn: string[];
  verification: Verification;
}

export type Verification =
  | { type: 'exit_code'; expect: number }
  | { type: 'file_exists'; path: string }
  | { type: 'output_contains'; substring: string }
  | { type: 'schema'; jsonSchema: Record<string, unknown> }
  | { type: 'llm_judge'; prompt: string };

/** Step execution outcome */
export interface StepOutcome {
  stepId: string;
  tool: string;
  success: boolean;
  retries: number;
  failureReason?: string;
  durationMs: number;
}

/** Full execution record for operational memory */
export interface ExecutionRecord {
  id: string;
  timestamp: number;
  taskType: string;
  originalInstruction: string;  // redacted summary
  plan: TaskPlan;
  stepResults: StepOutcome[];
  overallSuccess: boolean;
  durationMs: number;
  retries: number;
  notes?: string;
}
```

#### Step 2: Create `src/tasks/execution-log.ts`

```typescript
// Storage: ~/.casterly/execution-log/log.jsonl (append-only, one JSON object per line)
// Bounded: max 500 records or 30 days

export interface ExecutionLog {
  /** Append a record after task completion */
  append(record: ExecutionRecord): void;

  /** Query records by task type */
  queryByType(taskType: string, limit?: number): ExecutionRecord[];

  /** Query records by tool name */
  queryByTool(toolName: string, limit?: number): ExecutionRecord[];

  /** Get recent records */
  getRecent(limit?: number): ExecutionRecord[];

  /** Get tool reliability score (success rate 0-1) */
  getToolReliability(toolName: string): { successRate: number; totalCalls: number };

  /** Compact: remove records older than 30 days or beyond 500 count */
  compact(): void;
}

export function createExecutionLog(storagePath?: string): ExecutionLog;
```

Implementation notes:
- Use JSONL format (one JSON object per line) for append-only efficiency
- Read into memory on creation, keep in-memory cache
- Write appends to file immediately (async via `appendFile`)
- Compact on creation and periodically
- Default path: `~/.casterly/execution-log/log.jsonl`
- Privacy: caller must redact sensitive content before calling append

#### Step 3: Create `src/tasks/index.ts`

Export types and execution log.

---

## ISSUE-002: Task Manager (Foundation)

**Status:** Ready to implement after ISSUE-005 types
**Depends on:** ISSUE-005 types.ts (shared types)
**Largest issue — implement in phases**

### Phase 1: Types + Classifier (this session or next)

Types are in `src/tasks/types.ts` (created in ISSUE-005).

**`src/tasks/classifier.ts`**

Uses native tool use pattern (like route_decision) to classify messages:

```typescript
import type { LlmProvider } from '../providers/base.js';

export interface ClassificationResult {
  taskClass: TaskClass;
  confidence: number;
  reason: string;
  taskType?: string;  // e.g. 'calendar', 'file_operation', 'coding'
}

// Tool schema for the classifier
const CLASSIFY_TOOL: ToolSchema = {
  name: 'classify_message',
  description: 'Classify whether the user message is a conversational reply or an actionable task.',
  inputSchema: {
    type: 'object',
    properties: {
      taskClass: {
        type: 'string',
        enum: ['conversation', 'simple_task', 'complex_task'],
        description: 'conversation = no action needed, simple_task = single tool call, complex_task = multi-step plan needed',
      },
      confidence: { type: 'number', description: 'Confidence 0-1' },
      reason: { type: 'string', description: 'Brief explanation' },
      taskType: { type: 'string', description: 'Task category if applicable' },
    },
    required: ['taskClass', 'confidence', 'reason'],
  },
};

export async function classifyMessage(
  message: string,
  recentHistory: string[],
  provider: LlmProvider
): Promise<ClassificationResult>;
```

Implementation: send a focused prompt with CLASSIFY_TOOL as the only tool. Parse the tool call response. If model doesn't call the tool, default to 'conversation'.

Context for classifier should be minimal (ISSUE-006 pattern): just the message + last 2-3 exchanges. No skills, no full history.

### Phase 2: Planner

**`src/tasks/planner.ts`**

```typescript
export async function createTaskPlan(
  instruction: string,
  availableTools: ToolSchema[],
  executionHistory: ExecutionRecord[],  // from ISSUE-005
  provider: LlmProvider
): Promise<TaskPlan>;
```

Uses a `create_plan` tool schema that forces the model to output structured JSON:

```typescript
const PLAN_TOOL: ToolSchema = {
  name: 'create_plan',
  description: 'Create a structured execution plan for the user task.',
  inputSchema: {
    type: 'object',
    properties: {
      goal: { type: 'string' },
      completionCriteria: { type: 'array', items: { type: 'string' } },
      steps: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            description: { type: 'string' },
            tool: { type: 'string' },
            dependsOn: { type: 'array', items: { type: 'string' } },
          },
          required: ['id', 'description', 'tool'],
        },
      },
    },
    required: ['goal', 'completionCriteria', 'steps'],
  },
};
```

### Phase 3: Runner (DAG executor)

**`src/tasks/runner.ts`**

```typescript
export interface TaskRunnerOptions {
  orchestrator: ToolOrchestrator;
  provider: LlmProvider;
  maxConcurrency: number;  // default 2 for M4 Max
  maxRetries: number;      // default 2
  onStepComplete?: (stepId: string, outcome: StepOutcome) => void;
}

export interface TaskRunResult {
  plan: TaskPlan;
  stepOutcomes: StepOutcome[];
  overallSuccess: boolean;
  durationMs: number;
}

export async function runTaskPlan(
  plan: TaskPlan,
  options: TaskRunnerOptions
): Promise<TaskRunResult>;
```

DAG logic:
1. Build adjacency map from `dependsOn` fields
2. Find steps with no dependencies → ready queue
3. Execute ready steps (up to maxConcurrency) using Promise pool
4. On completion, check which new steps have all deps satisfied → add to ready queue
5. On failure, mark step failed, check if dependents should be skipped
6. Continue until all steps complete or all remaining are blocked

Use a semaphore pattern for concurrency:
```typescript
class Semaphore {
  private current = 0;
  private queue: (() => void)[] = [];
  constructor(private max: number) {}
  async acquire(): Promise<void> { /* ... */ }
  release(): void { /* ... */ }
}
```

### Phase 4: Verifier

**`src/tasks/verifier.ts`**

```typescript
export async function verifyStepOutcome(
  step: TaskStep,
  result: NativeToolResult
): Promise<{ verified: boolean; reason: string }>;

export async function verifyTaskOutcome(
  plan: TaskPlan,
  outcomes: StepOutcome[],
  provider: LlmProvider
): Promise<{ verified: boolean; reason: string }>;
```

Step verification: switch on `step.verification.type`:
- `exit_code`: check `result.exitCode === expect`
- `file_exists`: use `fs.existsSync(path)`
- `output_contains`: check `result.output?.includes(substring)`
- `schema`: validate result output against JSON schema
- `llm_judge`: send to provider with a focused verification prompt

### Phase 5: Manager (top-level wiring)

**`src/tasks/manager.ts`**

```typescript
export interface TaskManager {
  handle(
    message: string,
    session: Session,
    provider: LlmProvider,
    options: TaskManagerOptions
  ): Promise<string>;  // final response text
}

export function createTaskManager(options: TaskManagerOptions): TaskManager;
```

This replaces the tool loop in `daemon.ts:131-224`. The daemon would call:
```typescript
const manager = createTaskManager({ orchestrator, executionLog, ... });
const response = await manager.handle(message.text, session, provider, options);
sendMessage(sender, response);
```

---

## ISSUE-006: Scoped Context Profiles

**Status:** Implement alongside ISSUE-002
**Depends on:** ISSUE-002 (defines the pipeline stages)

### Implementation Plan

Extend `src/interface/context.ts` with profile-specific assembly:

```typescript
export type ContextProfileType = 'conversation' | 'classifier' | 'planner' | 'executor' | 'verifier';

export interface ContextProfile {
  type: ContextProfileType;
  maxTokens: number;
}

export const CONTEXT_PROFILES: Record<ContextProfileType, ContextProfile> = {
  conversation: { type: 'conversation', maxTokens: 3500 },  // existing behavior
  classifier:   { type: 'classifier',   maxTokens: 2000 },
  planner:      { type: 'planner',      maxTokens: 4000 },
  executor:     { type: 'executor',     maxTokens: 4000 },
  verifier:     { type: 'verifier',     maxTokens: 8000 },
};
```

Add new assembly functions:
- `assembleClassifierContext(message, recentHistory)` — message + 2-3 exchanges only
- `assemblePlannerContext(instruction, tools, executionHistory)` — no conversation history
- `assembleExecutorContext(step, dependencyOutputs)` — just the step + deps
- `assembleVerifierContext(goal, criteria, stepResults)` — goal + all results

The existing `assembleContext()` remains unchanged as the `conversation` profile.

---

## ISSUE-008: Benchmarking Framework

**Status:** Ready to implement
**Depends on:** Nothing (extends existing src/testing/)

### Implementation Plan

#### Step 1: Types (`src/benchmark/types.ts`)

Copy the type definitions from OPEN-ISSUES.md ISSUE-008 — they're complete.

#### Step 2: Suite (`src/benchmark/suite.ts`)

Extend existing `BUILT_IN_TEST_CASES` with difficulty and category annotations. Create `BENCHMARK_SUITE` constant.

#### Step 3: Metrics (`src/benchmark/metrics.ts`)

```typescript
export async function getOllamaModelMemory(model: string): Promise<number>;
// GET http://localhost:11434/api/ps → find model → report memory_mb

export function measureTTFT(startTime: number, firstTokenTime: number): number;
```

#### Step 4: Scorer (`src/benchmark/scorer.ts`)

Structural scoring + LLM-as-judge wrapper.

#### Step 5: Runner (`src/benchmark/runner.ts`)

Loop: for each model → for each case → run → score → collect metrics.

#### Step 6: Compare + Report (`src/benchmark/compare.ts`, `src/benchmark/report.ts`)

Ranking algorithm: weighted composite score from quality, tool accuracy, speed, memory.

#### Step 7: CLI entry point

Add `benchmark` command to `src/index.ts` or create `src/benchmark-cli.ts`.

---

## ISSUE-003: Scheduler

**Status:** Implement after ISSUE-002
**Depends on:** ISSUE-002 (triggers feed the task pipeline)

### Key Design Decision

Triggers produce synthetic messages. The scheduler doesn't have its own execution path:

```typescript
interface ScheduledJob {
  id: string;
  type: 'one_shot' | 'recurring';
  triggerAt: number;          // UTC timestamp
  cronExpression?: string;    // for recurring
  syntheticMessage: string;   // the "message" that enters the task pipeline
  targetUser: string;         // who to notify
  createdAt: number;
  status: 'pending' | 'fired' | 'cancelled';
}
```

Storage: `~/.casterly/scheduler/jobs.json` — read on startup, write on change.

Timer: `setInterval` in daemon alongside the message poll interval. Check for due jobs each tick.

---

## ISSUE-004: Approval Flow

**Status:** Implement after ISSUE-002
**Depends on:** ISSUE-002 (DAG pause/resume), iMessage send/receive

### Key Design Decision

The approval callback becomes async with iMessage bridge:

```typescript
// New approval bridge for iMessage
export function createIMessageApprovalBridge(sender: string): {
  requestApproval(command: string, context: string): Promise<boolean>;
}
```

Implementation: send approval request message, then poll for incoming messages matching the approval pattern (yes/no/approve/deny) within timeout window. This hooks into the existing daemon poll loop — approval responses are intercepted before normal message processing.

---

## Dependency Graph

```
ISSUE-007 (Native Executors) ─────────────────────┐
                                                    │
ISSUE-005 (Operational Memory) ──┐                  │
         ↓ (shared types)        │                  │
ISSUE-002 (Task Manager) ◄──────┘                  │
         ↓                       ↓                  │
ISSUE-006 (Context Profiles)     │                  │
         ↓                       │                  │
ISSUE-003 (Scheduler)            │  integrates with │
ISSUE-004 (Approval Flow)        │◄─────────────────┘
                                 │
ISSUE-008 (Benchmarking) ────────┘ (independent but more useful after 002+007)
ISSUE-001 (File Types) ──────────── (independent, follows 007 pattern)
```

## Implementation Order (Recommended)

1. **ISSUE-007** — Native Executors (independent, immediate value)
2. **ISSUE-005** — Operational Memory + shared types (foundation for 002)
3. **ISSUE-002** — Task Manager (the big one, phases 1-5)
4. **ISSUE-006** — Context Profiles (alongside 002)
5. **ISSUE-008** — Benchmarking (independent, high value for model selection)
6. **ISSUE-003** — Scheduler (needs 002)
7. **ISSUE-004** — Approval Flow (needs 002, needs Mac for iMessage testing)
8. **ISSUE-001** — File Type Support (follows 007 pattern, lowest urgency)

---

## Notes for Future Sessions

- The project uses TypeScript with ES modules (`.js` extensions in imports)
- All logging goes through `src/logging/safe-logger.ts` — never `console.log` for user data
- Protected paths are listed in `docs/rulebook.md` — changes require extra caution
- Run `npm run check` after all changes
- The daemon at `src/imessage/daemon.ts` is the main integration point
- Ollama runs locally at `http://localhost:11434`
- Hardware: Mac Studio M4 Max, 128GB unified memory, max 2 concurrent models
- Models: `hermes3:70b` (general), `qwen3-coder-next` (coding)
