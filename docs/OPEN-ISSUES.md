# Open Issues

Tracked gaps, bugs, and feature needs for Casterly-Rock.

---

## ISSUE-001: File Type Support Gaps

**Status:** Open
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

**Status:** Open
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

*Add new issues below using the next sequential ID (ISSUE-003, etc.).*
