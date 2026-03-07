# LocalCowork vs Tyrion — Toolset Comparison

**Date:** 2026-03-07
**Source:** https://github.com/Liquid4All/cookbook/tree/main/examples/localcowork

## What is LocalCowork?

A desktop AI agent by Liquid AI, built on their LFM2-24B-A2B MoE model (24B total, 2.3B active). Runs entirely on-device via Tauri 2.0 (Rust) + React frontend. Uses Model Context Protocol (MCP) for tool integration. 75 tools across 14 MCP servers. MIT licensed.

Key stats: 80% single-step tool accuracy at 390ms latency on M4 Max. 853 tests.

## Architecture Comparison

| Aspect | Tyrion | LocalCowork |
|--------|--------|-------------|
| **Runtime** | Node.js/TypeScript | Rust (Tauri 2.0) + React |
| **Models** | Dual: 122B (deep) + 35B-A3B (fast) | Single: 24B-A2B (+ optional 1.2B router) |
| **Inference** | Ollama | OpenAI-compatible (llama.cpp/Ollama/vLLM) |
| **Tool protocol** | Native tool registry | MCP (Model Context Protocol) |
| **Tool count** | ~150+ (18 categories) | 75 (14 MCP servers) |
| **Interface** | iMessage daemon | Desktop GUI (Tauri) |
| **Persistence** | 19 stores (YAML/JSONL/JSON) | SQLite + JSON |
| **Self-improvement** | Yes (dream cycles, LoRA, prompt evolution) | No |
| **Memory** | 4-tier (hot/warm/cool/cold) + knowledge graph | None (conversation only) |

## Tool-by-Tool Gap Analysis

### Things LocalCowork Has That We Should Consider

#### 1. RAG-Based Tool Pre-filtering ⭐⭐⭐
**What:** Embeds all tool descriptions at startup, then at query time embeds the user message and selects top-K tools by cosine similarity before sending to the model.
**Why it matters:** We already have `buildCompactManifest()` and `TASK_CATEGORY_PRESETS` for narrowing tools, but these are static mappings. RAG pre-filtering is dynamic — it adapts to the actual query content. With 150+ tools, this could significantly improve routing accuracy for edge cases that don't fit neatly into our preset categories.
**Port difficulty:** Medium. We'd need a local embedding endpoint (Ollama supports `/api/embeddings`). Implementation is ~200 lines of Rust in their codebase, would be similar in TypeScript.

#### 2. Tiered Permission System ⭐⭐⭐
**What:** Three tiers — Allow Once (ask every time), Session (memory-only, cleared on restart), Always (persisted to disk as `permissions.json`). Uses atomic writes (temp → rename) for crash safety.
**Why it matters:** Tyrion currently has safety tiers for bash commands but no persistent, user-configurable permission grants per tool. As we add more write/destructive tools, having "I always trust `read_file` but always want to confirm `git_commit`" stored persistently would reduce friction without reducing safety.
**Port difficulty:** Low. Clean pattern, would slot into our `src/tools/executor.ts` safety gate.

#### 3. Human-in-the-Loop Confirmation Previews ⭐⭐
**What:** Write and destructive actions display a preview of what will happen, requiring explicit user confirmation. Converts 80% model accuracy into near-100% effective safety.
**Why it matters:** Tyrion's iMessage interface is text-only, so rich previews aren't directly applicable. But the concept of structured confirmation ("I'm about to write 47 lines to `budget.csv` — here's a summary") could be adapted for iMessage as a pre-action summary message.
**Port difficulty:** Low. We already have `message_user`; this is a pattern change, not a new tool.

#### 4. Audit Trail / Compliance Reporting ⭐⭐
**What:** Dedicated `audit` MCP server with 4 tools: `get_tool_log`, `generate_audit_report`, `export_audit_pdf`, plus a 4th. All tool executions are logged to a local audit trail.
**Why it matters:** Tyrion logs to `journal.jsonl` and `execution-log/`, but we don't have structured audit reporting or the ability to query "what did you do between Tuesday and Thursday?" as a first-class tool. This would be valuable for accountability and debugging.
**Port difficulty:** Low. We already log everything; this is a query/report layer on top.

#### 5. Dual-Model Orchestrator (Plan → Route → Synthesize) ⭐⭐
**What:** Uses a large model (24B) for planning, a tiny model (1.2B) for tool selection, then the large model again for synthesis. The 1.2B router achieves 93% tool selection accuracy.
**Why it matters:** Our dual-loop is different — FastLoop handles triage, DeepLoop handles execution. LocalCowork's approach separates planning from routing within a single task. This is interesting because their router is fine-tuned specifically for tool selection, achieving 93% accuracy with a 1.2B model. We could potentially fine-tune a tiny model for our tool routing.
**Port difficulty:** High. Requires fine-tuning a router model on our 150+ tool schema.

#### 6. OCR Pipeline ⭐⭐
**What:** 4 tools: extract text from images, extract text from PDFs (scanned), extract structured data, extract tables. Uses Tesseract + PaddleOCR.
**Why it matters:** Tyrion can read PDFs and documents via `read_document`, but cannot OCR scanned documents or extract text from images. If a user sends a photo of a receipt or a scanned contract, we're blind.
**Port difficulty:** Medium. Needs Tesseract/PaddleOCR binaries installed. Implementation is a new tool executor.

#### 7. Document Diffing ⭐
**What:** `diff_documents` tool that compares two documents (PDF, DOCX, etc.) and shows changes.
**Why it matters:** We have `git_diff` for code but no way to diff binary documents. Useful for contract review, version comparison.
**Port difficulty:** Low-Medium. Depends on text extraction (which we partially have via `read_document`).

#### 8. Clipboard Integration ⭐
**What:** 3 tools: `get_clipboard`, `set_clipboard`, `clipboard_history`. Direct OS clipboard access.
**Why it matters:** Minor convenience. Tyrion operates via iMessage so clipboard isn't directly relevant, but could be useful in console mode.
**Port difficulty:** Low (pbcopy/pbpaste on macOS).

### Things LocalCowork Has That We Already Cover Better

| LocalCowork | Tyrion Equivalent | Notes |
|-------------|-------------------|-------|
| filesystem (9 tools) | core tools (read_file, write_file, etc.) | Equivalent coverage |
| security scanning | `src/security/*` (detector, redactor, sanitizer) | We're more comprehensive — continuous, not on-demand |
| calendar (4 tools) | `calendar_read`, `reminder_create` + skills | We have native macOS integration |
| task management | `goals.yaml`, `issues.yaml`, `file_issue`, etc. | Our state management is richer |
| system info | `bash` tool | We use bash for system queries |

### Things We Have That LocalCowork Doesn't

| Tyrion Capability | Notes |
|-------------------|-------|
| Dream cycles / self-improvement | Self-testing, prompt evolution, LoRA training |
| 4-tier memory system | Hot/warm/cool/cold with semantic search |
| Knowledge graph | Entity nodes + relationship edges |
| Skill synthesis | LLM creates custom tools at runtime |
| Constitutional rules | Self-authored operational rules |
| Crystal insights | Permanent distilled knowledge |
| Dual concurrent loops | Two models running simultaneously |
| Advanced memory (AUDN, evolution, temporal) | Memory that ages, links, and self-organizes |

## Recommendations — What to Port to Tyrion

### Priority 1 (High value, low effort)
1. **Tiered permissions** — Add persistent per-tool permission grants (once/session/always) to `src/tools/executor.ts`
2. **Audit query tool** — Add `query_audit_log` and `generate_report` agent tools that query our existing `execution-log/` and `journal.jsonl`
3. **Confirmation previews** — Before destructive actions, send a structured summary to the user via iMessage and wait for approval

### Priority 2 (High value, medium effort)
4. **RAG tool pre-filtering** — Embed tool descriptions via Ollama's `/api/embeddings`, select top-K at query time. Complements our static `TASK_CATEGORY_PRESETS`
5. **OCR tools** — Add `ocr_image` and `ocr_pdf` tools using Tesseract. Enables processing photos and scanned documents sent via iMessage

### Priority 2.5 (Medium value, low-medium effort)
6. **Undo stack for mutable tools** — Capture before/after state on file writes, moves, deletes. Enables "undo last action" as an agent tool. Their ToolRouter snapshots original state before mutations.
7. **Response quality guards** — Detect incomplete ("I'll process the remaining...") or deflecting (asks a question instead of acting) model responses and auto-re-prompt. Valuable for Tyrion's autonomous mode where no human is watching.
8. **Tool-call JSON repair** — Auto-fix malformed tool-call JSON before falling back to a retry or different model. We likely lose cycles to parse failures already.

### Priority 3 (Interesting but lower priority)
9. **Template matching for common workflows** — Keyword-scored pattern matching that skips the planner for known request types. Saves 2-3 seconds per matched query.
10. **Document diffing** — Add `diff_documents` tool leveraging existing `read_document` extraction
11. **Fine-tuned tool router** — Train a tiny model specifically for tool selection (long-term, needs dataset)

## Key Takeaway

LocalCowork is optimized for a different problem: making a small model (2.3B active params) reliably call tools in a desktop GUI. Their innovations (RAG pre-filtering, dual-model routing, tiered permissions) are responses to working with a weaker model that needs more scaffolding.

Tyrion has a far richer capability set (memory, self-improvement, autonomy) but could benefit from LocalCowork's **precision engineering around tool selection and safety UX**. The top ports are the permission system, audit querying, and RAG-based tool filtering — all of which make our existing 150+ tools more accessible and accountable.
