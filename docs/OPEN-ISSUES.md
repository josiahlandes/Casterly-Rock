# Open Issues

Tracked gaps, bugs, and feature needs for Casterly-Rock.

---

## ISSUE-001: File Type Support Gaps

**Status:** Implemented (read_document executor: PDF, DOCX, XLSX, CSV with parsers, schemas, tests)
**Priority:** High
**Opened:** 2026-02-12
**Category:** Feature — Document Handling

### Summary

Tyrion's toolkit is text/code-first. It has zero capability for the document, spreadsheet, image, and media file types a personal assistant encounters daily.

### Current State

| File Type | Read | Modify | Write/Create | Notes |
|-----------|:----:|:------:|:------------:|-------|
| `.ts` `.js` `.py` `.go` `.rs` `.java` `.c/.cpp` | Yes | Yes | Yes | Full support via coding tools |
| `.json` `.yaml` `.yml` `.xml` | Yes | Yes | Yes | Full support |
| `.md` `.html` `.css` `.scss` | Yes | Yes | Yes | Full support |
| `.sh` `.bash` `.zsh` | Yes | Yes | Yes | Full support |
| `.svg` | Yes | Yes | Yes | XML-based, works as text |
| `.csv` | Partial | Partial | Partial | Raw text only — no column/row awareness |
| `.pdf` | **No** | **No** | **No** | Detected as binary, skipped |
| `.docx` | **No** | **No** | **No** | No parser |
| `.doc` | **No** | **No** | **No** | No parser (legacy format) |
| `.xlsx` / `.xls` | **No** | **No** | **No** | No parser |
| `.numbers` | **No** | **No** | **No** | Apple-proprietary, no parser |
| `.pptx` | **No** | **No** | **No** | No parser |
| `.png` `.jpg` `.gif` `.webp` | **No** | **No** | **No** | Binary, skipped |
| `.mp3` `.wav` `.ogg` | **No** | **No** | **No** | Binary, flagged sensitive |
| `.mp4` `.mov` `.webm` | **No** | **No** | **No** | Binary |
| `.zip` `.tar` `.gz` | **No** | **No** | **No** | No unpacker |

### Proposed Solution

Add document handler modules under `src/coding/tools/` (or a new `src/handlers/` directory) using these libraries:

| Gap | npm Package | Adds |
|-----|-------------|------|
| PDF read | `pdf-parse` or `pdfjs-dist` | Extract text from PDFs |
| DOCX read | `mammoth` | Word → text/HTML extraction |
| DOCX write | `docx` | Programmatic Word doc creation |
| XLSX/XLS read/write | `exceljs` | Full spreadsheet support |
| CSV structured parse | `csv-parser` / `csv-stringify` | Column-aware read/write |
| Image processing | `sharp` | Resize, convert, read metadata |
| MIME detection | `file-type` | Auto-detect unknown file types |
| Archive unpacking | `extract-zip` / `tar` | Open .zip / .tar.gz |

### Suggested Priority Order

1. **PDF** + **DOCX** + **XLSX** — covers invoices, contracts, budgets, receipts
2. **CSV structured parsing** — lightweight win, useful for data import/export
3. **Image processing** — resize, convert, metadata for photos/screenshots
4. **MIME detection** — safety net for unknown files
5. **Archive support** — .zip/.tar.gz unpacking

### Constraints

- All processing must stay local (privacy-first principle).
- Sensitive document content must never be logged raw.
- New handlers must integrate with the existing tool registry pattern.

---

## ISSUE-002: Task Management & Orchestration Layer

**Status:** Implemented (all 5 phases: classifier, planner, runner, verifier, manager)
**Priority:** Critical
**Opened:** 2026-02-12
**Category:** Architecture — Core Intelligence

### Summary

Tyrion has no ability to distinguish tasks from conversation, decompose complex requests into steps, execute those steps with verification, or confirm the final outcome matches the original instruction. The current daemon runs a flat tool loop where the model reacts turn-by-turn with no plan, no per-step validation, and no outcome check.

### Current State

The daemon (`src/imessage/daemon.ts:131-224`) operates as:

```
message → model generates → tool calls? → execute sequentially → feed results back → loop → text out
```

**What's missing:**

| Capability | Status | Impact |
|-----------|--------|--------|
| Task vs. conversation classification | Missing | Every message enters the tool loop unnecessarily |
| Task decomposition / planning | Missing | Complex requests handled reactively, not planned |
| Dependency-aware step ordering | Missing | All steps run sequentially even when parallelizable |
| Per-step verification | Missing | Failed steps feed raw errors back; model guesses next move |
| Final outcome verification | Missing | No check that result matches the original request |
| Concurrent subagent execution | Missing | Single-threaded tool loop; no parallelism |
| Structured plan representation | Missing | "Plans" exist only as model prose, not executable data |

### Proposed Architecture

```
Message In
    │
    ▼
┌─────────────────────────┐
│  1. CLASSIFIER           │  "Is this a task or conversation?"
│     → conversation       │─── respond directly (no tools needed)
│     → task               │
└────────────┬────────────┘
             ▼
┌─────────────────────────┐
│  2. TASK PLANNER         │  "What does done look like?"
│     • completion criteria │
│     • required steps     │
│     • tool mapping       │
│     • dependency graph   │
└────────────┬────────────┘
             ▼
┌─────────────────────────┐
│  3. TASK RUNNER          │  Execute the plan
│     • run steps (parallel│
│       where independent, │
│       sequential where   │
│       dependent)         │
│     • verify each step   │
│     • correct on failure │
└────────────┬────────────┘
             ▼
┌─────────────────────────┐
│  4. OUTCOME VERIFIER     │  "Does the chain match the instruction?"
│     • compare to         │
│       completion criteria│
│     • retry or report    │
└────────────┬────────────┘
             ▼
        Response to User
```

### Proposed Module Structure

```
src/tasks/
├── classifier.ts      # Task vs. conversation classification
├── planner.ts         # Decompose into structured steps with deps
├── step-executor.ts   # Execute one step, return structured result
├── runner.ts          # Manage the DAG — parallel + sequential
├── verifier.ts        # Per-step + final outcome verification
├── manager.ts         # Top-level wiring (replaces flat daemon loop)
└── types.ts           # Shared types
```

### Key Types

```typescript
interface TaskPlan {
  goal: string;
  completionCriteria: string[];
  steps: TaskStep[];
}

interface TaskStep {
  id: string;
  description: string;
  tool: string;
  input: Record<string, unknown>;
  dependsOn: string[];        // step IDs that must complete first
  verification: Verification;  // how to confirm this step succeeded
}

type Verification =
  | { type: 'exit_code'; expect: number }
  | { type: 'file_exists'; path: string }
  | { type: 'output_contains'; substring: string }
  | { type: 'schema'; jsonSchema: object }
  | { type: 'llm_judge'; prompt: string };  // last resort
```

### Subagent Concurrency Model

- Independent steps dispatch to concurrent subagents
- M4 Max hardware limit: 2 concurrent models — runner must respect a concurrency pool
- Dependent steps queue until their prerequisites resolve
- Manager (Tyrion) monitors all subagents, corrects or retries on failure
- Each subagent gets a scoped context (only what it needs), not the full conversation

### Design Considerations

1. **Planner output must be data, not prose** — structured `TaskPlan` that the runner can mechanically execute, not a paragraph the model interprets
2. **Prefer structural verification over LLM self-grading** — exit codes, file checks, schema validation first; LLM judge only as fallback
3. **Simple tasks should stay simple** — single-tool tasks skip decomposition; don't over-engineer the happy path
4. **Conversation messages skip entirely** — classifier gates entry to the pipeline; chat stays fast
5. **Concurrency respects hardware** — semaphore-based pool, not unbounded parallelism

### Constraints

- All task execution stays local (privacy-first)
- Task plans and step results must not log raw sensitive content
- Must integrate with existing `ToolOrchestrator` and `NativeToolExecutor` interfaces
- Classifier must use native tool use (`route_decision` pattern), not text parsing

---

## ISSUE-003: Proactive Scheduler — Tyrion Should Initiate, Not Just React

**Status:** Implemented (one-shot timers, cron jobs, job store, daemon integration)
**Priority:** High
**Opened:** 2026-02-12
**Category:** Feature — Core Intelligence

### Summary

Tyrion is purely reactive. The daemon polls for inbound iMessages, processes them, responds. A personal assistant must also **initiate**: scheduled reminders, calendar alerts, follow-ups on deferred tasks, periodic check-ins, and event-driven notifications.

### Current State

The daemon loop (`src/imessage/daemon.ts:384-439`) is a poll-then-respond cycle:

```
poll → filter new messages → process each → respond → sleep → repeat
```

There is no mechanism to:
- Fire a message at a scheduled time ("remind me at 3pm")
- Watch for external events and notify ("your build finished", "new email from X")
- Follow up on incomplete tasks ("you asked me to do X yesterday — still want that?")
- Run periodic maintenance (memory compaction, session cleanup)

### Proposed Architecture

```
src/scheduler/
├── cron.ts          # Time-based triggers (cron expressions or absolute times)
├── watch.ts         # Event-based triggers (file changes, calendar updates, etc.)
├── trigger.ts       # Normalize all triggers into a synthetic message shape
├── store.ts         # Persist scheduled jobs across daemon restarts
└── types.ts         # ScheduledJob, Trigger, etc.
```

All triggers produce a synthetic message that enters the same classify → plan → execute pipeline from ISSUE-002. The scheduler is **not** a separate execution path — it's a second source of inputs alongside iMessage polling.

### Key Capabilities

| Trigger Type | Example | Mechanism |
|-------------|---------|-----------|
| One-shot timer | "Remind me at 3pm to call the dentist" | Absolute timestamp, fire once |
| Recurring cron | "Every Monday morning, summarize my week" | Cron expression, repeating |
| Event watch | "Tell me when the download finishes" | File/process watcher |
| Follow-up | "Circle back on this tomorrow" | Deferred task with timestamp |
| Proactive alert | "Meeting in 15 minutes" | Calendar polling + time math |

### Design Considerations

1. **Scheduled jobs must persist** — daemon restarts shouldn't lose pending reminders. Use a local JSON/SQLite store.
2. **Triggers feed the task manager** — a scheduled trigger is just a synthetic user message. No separate execution path.
3. **Time zones matter** — store everything in UTC, convert for display. Mac system timezone for default.
4. **Concurrency with reactive work** — a scheduled trigger firing while processing a user message must queue, not race.
5. **User must be able to list/cancel** — "what reminders do I have?" and "cancel the 3pm reminder" should work naturally.

### Constraints

- All scheduling stays local (no cloud cron services)
- Scheduled job store must not contain raw sensitive content (redact descriptions in logs)
- Must integrate with the task manager pipeline (ISSUE-002) once built

---

## ISSUE-004: Asynchronous Approval Flow for Destructive Operations

**Status:** Implemented (approval bridge, response matcher, persistent store, daemon integration)
**Priority:** High
**Opened:** 2026-02-12
**Category:** Architecture — Safety & UX

### Summary

The tool executor (`src/tools/executor.ts:97-113`) has `requiresApproval()` checks and an `approvalCallback`, but there is no actual approval UX over iMessage. When a multi-step task hits a destructive command mid-execution, the step silently fails with "Command requires approval but was denied." The user never gets asked, the task silently degrades.

### Current State

```typescript
// executor.ts:206-223
if (requiresApproval(command) && !autoApprove) {
  if (approvalCallback) {
    const approved = await approvalCallback(command);  // ← no iMessage implementation
    if (!approved) {
      return { success: false, error: 'Command requires approval but was denied' };
    }
  } else {
    return { success: false, error: `Command requires approval: ${command.substring(0, 50)}` };
  }
}
```

The daemon currently sets `autoApprove: true` (`daemon.ts:129`), bypassing all safety gates. This is expedient but dangerous.

### Proposed Solution

An asynchronous approval state machine:

```
Task step hits approval gate
    │
    ▼
┌──────────────────────────────┐
│  PAUSE the task DAG           │  (runner holds, other independent branches may continue)
│  Send approval request via    │
│  iMessage with context:       │
│  "Step 3 wants to run:        │
│   rm -rf old-backup/          │
│   Approve? (yes/no)"          │
└──────────────┬───────────────┘
               │
    ┌──────────┴──────────┐
    │  Wait for response   │  (with timeout — default 5 min)
    └──────────┬──────────┘
               │
    ┌──────────┼──────────┐
    ▼          ▼          ▼
  "yes"      "no"      timeout
  resume     abort      abort with
  step       step +     notification
             notify
```

### Key Components

| Component | Responsibility |
|-----------|---------------|
| `ApprovalRequest` | Structured request with command, context, task ID, step ID |
| `ApprovalStore` | Pending approvals indexed by task — persisted in case of restart |
| `ApprovalBridge` | iMessage-specific: send request, match response to pending approval |
| `TaskRunner` integration | Pause/resume DAG branches on approval gates |

### Design Considerations

1. **Remove `autoApprove: true`** from the daemon once this is built — that's a temporary workaround that skips all safety
2. **Approval timeout** — don't block forever. Default 5 minutes, configurable per-user
3. **Context in the request** — don't just show the raw command. Show what task this is part of and why the step is needed
4. **Partial DAG continuation** — independent branches that don't need approval should keep running while waiting
5. **Audit trail** — log all approval decisions (approved/denied/timed-out) for security review

### Constraints

- Approval messages must not leak sensitive content (redact paths/data in the request text)
- Must work over iMessage's async, text-based interface
- Must integrate with the task runner's DAG execution (ISSUE-002)
- Approval state must persist across daemon restarts

---

## ISSUE-005: Operational Memory — Learning From Task Execution

**Status:** Implemented (execution log + shared task types)
**Priority:** Medium
**Opened:** 2026-02-12
**Category:** Feature — Intelligence & Adaptation

### Summary

Tyrion has user-facing memory (`src/interface/memory.ts`) for facts the user tells him ("remember my wife's birthday is March 5"). He has no **operational memory** — the ability to learn from task execution patterns, remember what worked, what failed, and adapt future plans accordingly.

### Current State

Memory is a flat key-value store for user-declared facts. There is no:
- Record of past task executions and their outcomes
- Pattern detection across similar tasks
- Approach adaptation based on historical success/failure
- Knowledge about tool reliability or common failure modes

### Proposed Solution

A lightweight execution log alongside the existing memory system:

```
src/tasks/
└── execution-log.ts   # Append-only log of task execution records
```

```typescript
interface ExecutionRecord {
  id: string;
  timestamp: number;
  taskType: string;              // classified category
  originalInstruction: string;   // redacted summary, not raw content
  plan: TaskPlan;
  stepResults: StepOutcome[];
  overallSuccess: boolean;
  durationMs: number;
  retries: number;
  notes?: string;                // planner observations for next time
}

interface StepOutcome {
  stepId: string;
  tool: string;
  success: boolean;
  retries: number;
  failureReason?: string;
  durationMs: number;
}
```

### How It Feeds Back Into Planning

The task planner (ISSUE-002) queries recent execution records before generating a plan:

1. **Similar task lookup** — "Last time a calendar query was requested, `icalbuddy` failed because of date format. Use ISO format this time."
2. **Tool reliability scores** — if `osascript` calendar calls fail 40% of the time, prefer `icalbuddy` for calendar reads
3. **Duration estimates** — "This type of task typically takes 3 steps and ~8 seconds" helps set user expectations
4. **Failure pattern avoidance** — "The last 2 file-move tasks failed because the target directory didn't exist. Add a mkdir step first."

### Design Considerations

1. **Privacy** — execution records must be redacted. Store task type and tool names, not raw user content or file paths
2. **Bounded storage** — keep the last N records (e.g., 500) or last 30 days, whichever is smaller. Not unbounded
3. **Query by similarity** — simple keyword/category matching is fine initially. No need for vector search
4. **Read-only for the planner** — the planner reads the log for context but never modifies it. Only the task runner appends
5. **Not ML, just pattern matching** — this is a lookup table, not a training loop. Keep it simple and deterministic

### Constraints

- Execution records must never contain raw sensitive content
- Log must be local-only, stored under `~/.casterly/execution-log/`
- Must not slow down task execution — writes should be async/buffered
- Integrates with the task manager (ISSUE-002) as a planner input

---

## ISSUE-006: Scoped Subagent Context — Prevent Context Explosion

**Status:** Implemented (5 context profiles, token budgets, assembly functions)
**Priority:** High
**Opened:** 2026-02-12
**Category:** Architecture — Performance & Quality

### Summary

The current context assembly (`src/interface/context.ts`) builds one monolithic context per LLM call: system prompt + full conversation history + user message, trimmed to a token budget. When the task manager (ISSUE-002) runs multi-step plans with subagents, each subagent will inherit this full context plus accumulating tool results — blowing up context size, slowing local inference, and degrading output quality.

### Current State

Context assembly is one-size-fits-all:

```typescript
assembleContext({
  session,          // full conversation history
  userMessage,      // current message
  sender,
  skills,           // all available skills
  channel,
  workspacePath,
});
```

Every LLM call gets the same shape of context regardless of whether it's:
- A conversational reply (needs history, no tool context)
- A task classifier (needs the message, minimal history)
- A step executor (needs the step instruction + dependency outputs only)
- A verifier (needs the original goal + step results)

### Problem

On local models (hermes3:70b, qwen3-coder-next), context size directly impacts:

| Context size | Inference speed | Output quality |
|-------------|----------------|----------------|
| 2K tokens | Fast | Focused, accurate |
| 8K tokens | Moderate | Good |
| 16K+ tokens | Slow | Degrades — model loses focus on the actual instruction |

A 5-step task with tool results easily pushes each subagent call past 16K if context isn't scoped.

### Proposed Solution

Context profiles — each pipeline stage gets a purpose-built context:

| Stage | Gets | Doesn't get |
|-------|------|-------------|
| Classifier | Current message, last 2-3 exchanges | Full history, tool results, skill docs |
| Planner | Original instruction, available tools list, relevant execution history | Conversation history, unrelated skill docs |
| Step Executor | Step instruction, dependency outputs | Other steps' results, conversation history, full plan |
| Verifier | Original goal, completion criteria, all step results | Conversation history, tool schemas, skill docs |
| Conversational reply | Full history (trimmed), personality, skills | Tool execution context, plans |

### Implementation Approach

```typescript
interface ContextProfile {
  type: 'conversation' | 'classifier' | 'planner' | 'executor' | 'verifier';
  systemPrompt: string;
  messages: Message[];
  maxTokens: number;
}

function assembleContextForProfile(profile: ContextProfile): AssembledContext;
```

The existing `assembleContext` becomes the `conversation` profile. New profiles are added for each task pipeline stage.

### Design Considerations

1. **Step executors only see their dependencies** — if step C depends on A and B, its context includes A and B's outputs but not D's
2. **Personality stays in conversation context only** — subagents executing tools don't need Tyrion's personality; they need precision
3. **Token budget per profile** — classifier gets 2K max, planner gets 4K, executor gets 4K, verifier gets 8K
4. **Shared system prompt fragments** — safety rules and tool schemas are reused across profiles, personality is not

### Constraints

- Must not break existing conversational flow — the `conversation` profile is the current behavior
- Privacy rules (redaction, no raw logging) apply across all profiles
- Must integrate with the task manager pipeline (ISSUE-002)

---

## ISSUE-007: Native Tool Executors — Reduce Bash Passthrough

**Status:** Implemented (read_file, write_file, list_files, search_files)
**Priority:** Medium
**Opened:** 2026-02-12
**Category:** Architecture — Reliability & Safety

### Summary

Nearly every tool call currently routes through the single bash executor (`src/tools/executor.ts`). File reads use `cat`, calendar checks use `icalbuddy`, reminders use `osascript`, and so on. This means the LLM must know exact CLI syntax, output parsing is fragile, there's no type safety on inputs/outputs, and safety gates are string-prefix matching on raw commands.

### Current State

```
LLM → bash tool call → executor.ts → execSync(command) → parse stdout text → feed back
```

The skill system already supports native tool schemas in SKILL.md files, and the orchestrator supports registering custom executors. But almost no native executors are built — everything falls through to bash.

### Problem

| Issue | Impact |
|-------|--------|
| Model must know CLI syntax | Hallucinated flags, wrong argument order |
| Text output parsing | Brittle — format changes break extraction |
| No input validation | Bad inputs pass to shell unchecked |
| Safety is prefix-matching | Easy to bypass with pipes, subshells, aliases |
| No structured output | Tool results are untyped strings that the model re-parses |

### Proposed Native Executors

Build dedicated executors for the most common operations, registered with the existing orchestrator:

| Tool | Replaces | Input Schema | Output |
|------|----------|-------------|--------|
| `read_file` | `cat`, `head`, `tail` | `{ path, encoding?, offset?, limit? }` | `{ content, size, encoding }` |
| `write_file` | `echo >`, `cat <<EOF` | `{ path, content, append? }` | `{ bytesWritten, path }` |
| `list_files` | `ls`, `find` | `{ path, recursive?, pattern? }` | `{ files: FileEntry[] }` |
| `calendar_read` | `icalbuddy` | `{ startDate, endDate, calendar? }` | `{ events: CalendarEvent[] }` |
| `reminder_create` | `osascript` | `{ title, dueDate?, list?, notes? }` | `{ id, title, created }` |
| `http_get` | `curl` | `{ url, headers? }` | `{ status, headers, body }` |
| `search_files` | `grep`, `rg` | `{ pattern, path?, type? }` | `{ matches: SearchMatch[] }` |

### Implementation Pattern

Each executor follows the existing `NativeToolExecutor` interface:

```typescript
// src/tools/executors/read-file.ts
export function createReadFileExecutor(): NativeToolExecutor {
  return {
    toolName: 'read_file',
    async execute(call: NativeToolCall): Promise<NativeToolResult> {
      const { path, encoding, offset, limit } = call.input as ReadFileInput;
      // Direct fs.readFile — no shell, no parsing, typed input/output
      // ...
    },
  };
}
```

### Proposed Module Structure

```
src/tools/executors/
├── read-file.ts
├── write-file.ts
├── list-files.ts
├── calendar.ts
├── reminders.ts
├── http.ts
├── search-files.ts
└── index.ts          # Register all executors with the orchestrator
```

### Priority Order

1. **`read_file` + `write_file` + `list_files`** — covers the most common operations, immediate reliability win
2. **`search_files`** — structured grep replacement, high frequency
3. **`calendar_read` + `reminder_create`** — personal assistant core, currently fragile via osascript
4. **`http_get`** — useful but less frequent for a local-first assistant

### Design Considerations

1. **Bash executor stays** — it's the escape hatch for anything without a native executor. Don't remove it, just reduce reliance on it
2. **Task planner prefers native tools** — when the planner maps steps to tools, native executors should be preferred over bash equivalents
3. **Structured output for verification** — native executors return typed data, making ISSUE-002's structural verification much easier
4. **Safety is type-level** — input validation via Zod schemas before execution, not string matching after the fact

### Constraints

- All executors stay local (privacy-first)
- File operations must respect safety gates (no writes to protected paths)
- Must register with the existing `ToolOrchestrator` interface
- Sensitive file content must be redacted in logs

---

## ISSUE-008: Model Benchmarking & Evaluation Framework

**Status:** Implemented (benchmark suite, scorer, store, compare, report, CLI)
**Priority:** High
**Opened:** 2026-02-12
**Category:** Infrastructure — Testing & Model Selection

### Summary

Model selection is currently based on intuition. Hermes3:70b is assigned to general tasks and qwen3-coder-next to coding with no quantitative basis for either choice. There is no way to systematically evaluate a model against Tyrion's actual workload, compare alternatives, or assess newly released models. As the local model ecosystem evolves rapidly, this makes Casterly unable to keep up — every new model requires manual vibes-based testing instead of a standardized eval run.

### Current State

The existing test infrastructure (`src/testing/`) provides a foundation but is not a benchmarking system:

| Capability | Existing (`src/testing/`) | Needed for Benchmarking |
|-----------|--------------------------|------------------------|
| Test cases with expected outcomes | Yes — 25+ built-in cases | Extend with difficulty tiers and category coverage |
| Test runner | Yes — sequential execution | Multi-model: run same suite against N models |
| Trace collection | Yes — event-level tracing | Extend with token counts, memory, TTFT |
| Pass/fail evaluation | Yes — binary checks | Graduated quality scoring (0-10) |
| Result persistence | No — in-memory only | Store to disk, compare across runs |
| Model comparison | No | Side-by-side ranking on same suite |
| Hardware metrics | No | Memory consumption, GPU utilization |
| Reporting | Basic console output | Structured reports, comparison tables |

### What the Benchmark Should Measure

For each model × test case combination:

| Metric | Why It Matters | How to Capture |
|--------|---------------|----------------|
| **Response quality** | Does the model actually solve the task correctly? | Graduated scoring: structural checks + LLM-as-judge for subjective quality |
| **Tool calling accuracy** | Does the model call the right tools with correct args? | Compare actual tool calls against expected tool sequence |
| **Tool call efficiency** | Does it solve the task in minimal steps? | Count tool calls vs. optimal expected count |
| **Tokens used (input)** | Context consumption affects cost and speed | Ollama API reports prompt token count |
| **Tokens used (output)** | Verbosity vs. conciseness | Ollama API reports completion token count |
| **Time to first token (TTFT)** | Perceived responsiveness for the user | Timer from request to first streamed token |
| **Total completion time** | End-to-end latency | Timer from request to final response |
| **Memory consumption** | Can this model coexist with others on M4 Max? | Query Ollama `/api/ps` for model memory footprint |
| **Instruction following** | Does the model respect format, constraints, persona? | Check for format compliance, persona drift, hallucination |
| **Safety compliance** | Does the model respect safety gates? | Run safety test cases, check for bypass attempts |

### Proposed Architecture

```
src/benchmark/
├── suite.ts           # Benchmark suite definition (extends TestCase with difficulty + scoring)
├── runner.ts          # Multi-model runner: iterate models × test cases
├── scorer.ts          # Graduated scoring (structural + LLM-as-judge)
├── metrics.ts         # Capture hardware metrics from Ollama API
├── store.ts           # Persist results to ~/.casterly/benchmarks/
├── compare.ts         # Side-by-side model comparison and ranking
├── report.ts          # Formatted reports (console, JSON, markdown)
└── types.ts           # BenchmarkSuite, ModelScore, ComparisonResult, etc.
```

### Key Types

```typescript
interface BenchmarkCase extends TestCase {
  difficulty: 'trivial' | 'simple' | 'moderate' | 'complex' | 'expert';
  category: 'conversation' | 'tool_use' | 'planning' | 'coding' | 'safety' | 'knowledge' | 'multi_step';
  optimalToolCalls?: number;       // ideal number of tool calls for scoring efficiency
  qualityRubric?: string;          // instructions for LLM-as-judge scoring
  weight?: number;                 // relative importance (default 1.0)
}

interface ModelBenchmarkResult {
  modelId: string;                 // e.g. "hermes3:70b"
  modelSize: string;               // e.g. "70B"
  quantization: string;            // e.g. "Q4_K_M"
  timestamp: number;
  suiteId: string;
  caseResults: CaseBenchmarkResult[];
  aggregate: AggregateScore;
}

interface CaseBenchmarkResult {
  caseId: string;
  passed: boolean;
  qualityScore: number;            // 0-10
  toolAccuracy: number;            // 0-1 (correct tools / expected tools)
  toolEfficiency: number;          // 0-1 (optimal calls / actual calls)
  tokensInput: number;
  tokensOutput: number;
  ttftMs: number;                  // time to first token
  totalMs: number;                 // total completion time
  memoryMb: number;                // model memory footprint
  instructionFollowing: number;    // 0-1
  safetyCompliance: boolean;
}

interface AggregateScore {
  overallScore: number;            // weighted composite 0-100
  qualityAvg: number;
  toolAccuracyAvg: number;
  toolEfficiencyAvg: number;
  avgTtftMs: number;
  avgTotalMs: number;
  memoryMb: number;
  passByDifficulty: Record<string, { passed: number; total: number }>;
  passByCategory: Record<string, { passed: number; total: number }>;
}

interface ModelComparison {
  models: ModelBenchmarkResult[];
  ranking: { modelId: string; overallScore: number; rank: number }[];
  winner: string;
  tradeoffs: string[];             // e.g. "Model A is faster but less accurate on tool use"
}
```

### Benchmark Suite Design

The suite should cover Tyrion's actual workload across difficulty tiers:

**Trivial** (should be instant, near-perfect):
- Simple greetings, factual Q&A, basic math
- Classification: "is this a task?" yes/no

**Simple** (single tool, straightforward):
- Check calendar, list files, get current time
- Single-step tasks with clear tool mapping

**Moderate** (multi-step, some reasoning):
- "What's on my calendar tomorrow and do I have any conflicts?"
- File operations with verification
- Tasks requiring 2-3 sequential tool calls

**Complex** (planning required, multiple tools):
- "Summarize the last 3 days of calendar events and draft a weekly update"
- Tasks requiring dependency ordering and verification
- Error recovery when a step fails

**Expert** (deep reasoning, long chains):
- Multi-file code refactoring with tests
- Tasks requiring plan revision mid-execution
- Ambiguous instructions requiring clarification

### Comparison Workflow

```
$ casterly benchmark run --models hermes3:70b,llama3.3:70b,qwen3:72b --suite full

Running benchmark suite "full" (45 cases)

Model 1/3: hermes3:70b
  [████████████████████████████████████████████████] 45/45

Model 2/3: llama3.3:70b
  [████████████████████████████████████████████████] 45/45

Model 3/3: qwen3:72b
  [████████████████████████████████████████████████] 45/45

═══════════════════════════════════════════════════════════
MODEL COMPARISON — Suite: full (45 cases)
═══════════════════════════════════════════════════════════

Rank │ Model           │ Score │ Quality │ Tools │ Speed  │ Memory
─────┼─────────────────┼───────┼─────────┼───────┼────────┼────────
  1  │ qwen3:72b       │ 82/100│  8.4/10 │ 91%   │ 2.1s   │ 42GB
  2  │ hermes3:70b     │ 76/100│  7.8/10 │ 84%   │ 2.4s   │ 41GB
  3  │ llama3.3:70b    │ 71/100│  7.2/10 │ 78%   │ 1.9s   │ 40GB

By Category:
  conversation:  qwen3 > hermes3 > llama3
  tool_use:      qwen3 > hermes3 > llama3
  coding:        qwen3 > llama3 > hermes3
  safety:        hermes3 > qwen3 > llama3

Tradeoffs:
  - llama3.3 is fastest (TTFT) but least accurate on tool use
  - hermes3 strongest on safety compliance
  - qwen3 wins overall but uses slightly more memory

Results saved: ~/.casterly/benchmarks/2026-02-12_full.json
```

### Integration With Model Selection

Once benchmark data exists, `config/models.yaml` choices can be data-driven:

1. **Run benchmarks** on candidate models
2. **Compare results** across Tyrion's workload categories
3. **Update config** with the best model per task type
4. **Re-run when new models release** — same suite, instant comparison

Future enhancement: the model selection router could use benchmark scores dynamically — routing coding tasks to the model that scored highest on the `coding` category, general tasks to the `conversation` winner, etc.

### Design Considerations

1. **Extend, don't replace** — build on top of existing `TestCase`, `TestResult`, and `TraceCollector` types. The benchmark suite is a superset of the test suite.
2. **LLM-as-judge for quality scoring** — use a capable model (possibly the best-performing one from a prior run) to score response quality 0-10 against a rubric. This is subjective but better than binary pass/fail.
3. **Cold vs. warm runs** — first inference after loading a model is slower (cold start). Benchmark should include a warmup pass and report both cold and warm metrics.
4. **Reproducibility** — seed prompts, fixed temperature (0 for determinism), record Ollama version and quant level. Same suite should produce comparable results across runs.
5. **Incremental runs** — don't require running the full suite every time. Support `--category tool_use` or `--difficulty complex` to benchmark specific areas.
6. **Hardware-aware** — M4 Max can run ~2 large models simultaneously. The benchmark should report whether a model can coexist with Tyrion's other models (memory budget check).

### Constraints

- All benchmarking runs locally on Ollama — no cloud model APIs
- Test inputs must not contain real sensitive data (use synthetic test data)
- Benchmark results stored locally under `~/.casterly/benchmarks/`
- Must not interfere with normal daemon operation — run as a separate CLI command
- LLM-as-judge calls should use a consistent judge model across comparisons

---

*Add new issues below using the next sequential ID (ISSUE-009, etc.).*
