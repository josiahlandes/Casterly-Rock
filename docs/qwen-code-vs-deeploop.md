# Qwen Code Study: Insights for Casterly

> **Purpose**: Extract actionable patterns from Qwen Code (QwenLM/qwen-code) to improve Casterly's coding interface, context management, and agent loop.
> **Date**: 2026-03-04
> **Source**: <https://github.com/QwenLM/qwen-code> (Apache-2.0)

---

## 1. Project Overview

Qwen Code is a **TypeScript monorepo** (~20k GitHub stars) providing a terminal-first coding agent. It's a fork of Google's Gemini CLI with multi-provider support layered on top (OpenAI, Anthropic, Gemini, Qwen/DashScope).

**Key packages:**

| Package | Purpose |
|---------|---------|
| `packages/core` | LLM clients, tools, prompts, services, subagents |
| `packages/cli` | Terminal UI, commands, IDE integration |
| `packages/sdk-typescript` | Programmatic SDK for embedding |
| `packages/webui` | Browser-based interface |
| `packages/vscode-ide-companion` | VS Code extension |

---

## 2. Architecture Comparison

| Dimension | Casterly | Qwen Code |
|-----------|----------|-----------|
| **Execution** | Local-only (Ollama) | Cloud APIs (Qwen OAuth, OpenAI, Anthropic, Gemini) |
| **Agent loop** | Custom ReAct with 4-tier memory, 96 tools, identity prompt | GeminiClient turn loop, 20+ tools, sequential queue |
| **Context management** | Hot/Warm/Cool/Cold tiers, LRU eviction, handoff notes | Chat compression at 70% threshold, split-point algorithm |
| **Tool execution** | Sequential, preset-based filtering (23-96 tools per cycle) | Sequential queue with state machine (7 states) |
| **Subagents** | `delegate` tool (text-only, no tools) | Full `TaskTool` subagents with own tool sets and event streams |
| **Loop detection** | Turn limit + token budget + abort signal | 3-layer: identical tool calls, content chanting, LLM-based assessment |
| **Memory** | Journal + world model + goals + issues + crystals + constitution | `QWEN.md` files (global + project), session-scoped only |
| **Skills** | Tool synthesis (LLM-authored tools) | SKILL.md files with YAML frontmatter, discoverable by model |

---

## 3. Deep-Loop Coding Mode: Head-to-Head

This section compares Qwen Code's coding workflow specifically against Tyrion's coding interface (`src/coding/`) when in a deep multi-file editing loop — the scenario where context pressure is highest and compaction matters most.

### 3.1 Context Strategy During Deep Edits

| Aspect | Casterly (Coding Interface) | Qwen Code |
|--------|---------------------------|-----------|
| **Codebase awareness** | Tree-sitter repo map with PageRank ranking (2–8k tokens) | No repo map — relies on `glob`/`grep` tool calls to discover structure on-the-fly |
| **File budget** | Explicit token budget allocation: system (~2k) + repo map (~2-8k) + active files (~20-40k) + conversation (~10-20k) + tool results (~10k) + response headroom (~20-40k) = 128k | Implicit — fills context until 70% threshold, then compresses |
| **Context window** | 128k (Qwen 3.5 via Ollama) | Varies by provider (128k–1M+) |
| **What happens at capacity** | Warm tier LRU eviction — **oldest entries silently dropped** | ChatCompressionService triggers — **older history summarized into XML snapshot, recent 30% kept verbatim** |
| **Multi-file coordination** | EditTransaction with atomic backup/rollback across files | No transaction model — sequential tool calls, no atomic guarantees |
| **Validation loop** | Parse → Lint → TypeCheck → Test pipeline with auto-revert on failure, 3 retries | No built-in validation loop — model decides whether to check |
| **Edit format** | search/replace blocks (SEARCH/REPLACE markers) | `edit` tool with `old_string`/`new_string` exact match (identical concept, different syntax) |

**Key takeaway**: Casterly has the **superior scaffolding** (repo map, validation loop, edit transactions, explicit budget allocation). But Qwen Code has the **superior degradation strategy** — when context fills up during a long edit session, it compresses intelligently instead of silently losing information.

### 3.2 Where Tyrion Loses Context in Deep Loops

In a deep coding loop (20+ turns of reading, editing, testing across multiple files), here's what happens in each system:

**Casterly's failure mode:**

    Turn 1-10: Read files, understand codebase, start editing
    Turn 11-20: Warm tier fills up → LRU evicts oldest tool results
    Turn 21+: Model has lost the grep results from turn 3, the test
               output from turn 8, the architecture decision from turn 5.
               It re-reads files, re-runs searches, wastes turns.

**Qwen Code's approach:**

    Turn 1-10: Read files, make edits, run commands
    Turn 11-20: Context hits 70% → compression triggers
                → Older history becomes: "Read src/auth.ts (JWT validation),
                  decided to use middleware pattern, edited 3 files,
                  tests passing except auth.test.ts line 42"
                → Recent 5-6 turns kept verbatim
    Turn 21+: Model has compressed-but-present context from earlier work.
               Continues without re-reading files it already understood.

**The gap**: Our repo map and validation loop are advantages Qwen Code doesn't have. But their compression means the model retains *why* it made decisions and *what* it already checked, while ours forgets.

### 3.3 What a Combined Approach Looks Like

The ideal deep-loop coding session should combine both systems' strengths:

    CASTERLY ADVANTAGES (keep):           QWEN CODE ADVANTAGES (adopt):
    ├─ Tree-sitter repo map               ├─ Compression before eviction
    ├─ Explicit token budget allocation    ├─ Structured XML state snapshots
    ├─ Edit transactions (atomic)          ├─ 70% threshold trigger
    ├─ Validation pipeline (auto-revert)   ├─ User-message-boundary split points
    ├─ Session memory (decisions, todos)   ├─ Loop detection (3-layer)
    └─ Mode system (architect/code/ask)    └─ File-change delta tracking

The implementation plan in §4 below addresses exactly this gap.

---

## 4. Insights Worth Adopting

### 4.1 Chat Compression (Context Compaction)

**What they do**: `ChatCompressionService` triggers at **70% context window usage**, compresses older history into a structured **XML `<state_snapshot>`**, keeps the most recent **30%** verbatim.

**Key design choices**:
- Split points are only allowed at **user message boundaries** (never mid-tool-call)
- Final message before split must be a model response without pending function calls
- Uses JSON string length as a token proxy for split-point calculation
- A single failed compression **permanently disables auto-compression** for the session
- Compression prompt asks the model to produce structured XML, not free-form text

**Relevance to Casterly**: Our warm tier uses LRU eviction (lose-oldest), which discards tool results without summarization. Their approach **summarizes before evicting**, preserving semantic content. We could add a compression step before warm-tier eviction:

    Warm tier at capacity
      → Compress oldest N entries into structured summary
      → Replace N entries with 1 summary entry
      → Continue

**Action item**: Implement `compressWarmTier()` in `src/autonomous/context-manager.ts` that summarizes evicted entries via a fast-model call before discarding them. Use XML `<state_snapshot>` format for parseability.

### 4.2 Loop Detection (3-Layer)

**What they do**: `LoopDetectionService` combines three independent detectors:

1. **Identical tool calls** — hash signatures, triggers at 5 consecutive repeats
2. **Content chanting** — sliding window of 50-char chunks with SHA-256, triggers at 10+ identical chunks within proximity (avg spacing ≤ 75 chars). Smart false-positive avoidance excludes code blocks, tables, markdown structures.
3. **LLM-based cognitive assessment** — after 30+ turns, periodically asks a base model "is this conversation stuck?" with a 0.0–1.0 confidence score. Check interval dynamically adjusts (5–15 turns) based on confidence.

**Relevance to Casterly**: We rely only on turn limits and token budgets. We have no detection of *semantic* loops (model doing the same thing repeatedly with slight variations). The LLM-based assessment is particularly clever — use the fast model (qwen3.5:35b-a3b) to evaluate whether the deep model is stuck.

**Action item**: Add `LoopDetector` to `src/autonomous/agent-loop.ts` with at minimum layers 1 (tool call hashing) and 3 (fast-model assessment). Layer 2 (content chanting) is lower priority for local inference since we don't pay per token.

### 4.3 Tool Call State Machine

**What they do**: `CoreToolScheduler` tracks each tool call through 7 explicit states:
`validating → scheduled → executing → success/error/cancelled`
with a parallel `awaiting_approval` state for dangerous operations.

**What we do**: Sequential execution with a flat `try/catch` per tool call in the agent loop.

**Relevance to Casterly**: The state machine gives better observability and enables features like:
- Approval workflows for destructive commands (we have bash safety gates, but not a unified state machine)
- Retry with modification (re-enter validation after failure)
- Telemetry on tool call lifecycle

**Action item**: Low priority. Our current approach works for local execution. Revisit if we add approval workflows for iMessage-initiated file edits.

### 4.4 Subagent Architecture (Full Tool Sets)

**What they do**: The `TaskTool` spawns subagents that are **full agent instances** with their own tool sets, event streams, lifecycle management, and session tracking. Subagents run non-interactively.

**What we do**: `delegate` tool spawns a text-only sub-task to a different model — no tool access.

**Relevance to Casterly**: Giving subagents tools would enable patterns like:
- Delegate a code review to the fast model *with* `read_file` and `grep` access
- Run parallel investigations with tool access
- Security review subagent that can actually read and test code

**Action item**: Extend `delegate` tool to optionally provide a subset of read-only tools to the delegate. Start with `read_file`, `grep`, `glob`, `git_diff`. Keep write tools restricted to the main loop.

### 4.5 Streaming Tool Call Parser

**What they do**: `StreamingToolCallParser` assembles partial JSON tool calls from streaming chunks with depth tracking, string boundary detection, collision resolution, and three-tier fallback parsing (JSON → auto-closed string repair → `safeJsonParse`).

**Relevance to Casterly**: Our Ollama provider receives complete responses (not streaming). If we move to streaming for better UX or faster tool execution, this parser is a reference implementation.

**Action item**: Defer until streaming is prioritized.

### 4.6 IDE Context Delta Tracking

**What they do**: On first message, full editor state is sent (open files, cursor, selections). On subsequent turns, only **deltas** (file open/close, cursor moves, selection changes) are sent.

**Relevance to Casterly**: We don't have IDE integration yet, but the delta pattern is applicable to our coding interface's context manager. When the model reads a file, we could track "what changed since last read" and only send diffs on re-read.

**Action item**: Add file-change tracking to `src/coding/context-manager.ts` — when a file is re-read within the same cycle, send only the diff from the last read.

### 4.7 Structured Compression Prompts (XML Snapshots)

**What they do**: Compression produces XML `<state_snapshot>` with structured fields, not free-form summaries. This makes compressed context more parseable and less prone to information loss.

**Relevance to Casterly**: Our handoff notes are free-form text. Structured snapshots would make cross-cycle context transfer more reliable.

**Action item**: Define a structured handoff format (XML or YAML) for `journal.append({ type: 'handoff' })`. Include explicit fields: `files_modified`, `decisions_made`, `blockers_encountered`, `next_steps`, `key_learnings`.

### 4.8 Skills as Discoverable Files

**What they do**: Skills are directories with `SKILL.md` files containing YAML frontmatter (metadata) and markdown body (instructions). The model discovers and loads them via a `skill` tool.

**Relevance to Casterly**: Our OpenClaw skills are code-based. File-based skills would let Tyrion author and evolve skills autonomously (aligns with Vision Tier 2 tool synthesis).

**Action item**: The infrastructure exists (SKILL.md loader, learned skill files, tool synthesis) but skills are underutilized — loosely integrated, not automatically invoked. Deepen the system: tighter agent loop integration (auto-suggest matching skills during planning), autonomous skill authoring (extract SKILL.md from successful patterns), and skill composition (chained workflows). See roadmap §22.

---

## 5. Patterns to Avoid

### 5.1 Cloud-First Architecture

Qwen Code's content generator factory (`createContentGenerator`) branches on auth type (OpenAI, Anthropic, Gemini, Qwen OAuth). This adds complexity we don't need. Our single-provider Ollama architecture is simpler and should stay that way.

### 5.2 Gemini CLI Heritage Debt

The codebase uses Gemini internal types as its universal representation, converting to/from other providers via adapters. This creates unnecessary translation layers. Our native Ollama types are cleaner.

### 5.3 Session-Only Memory

Qwen Code's memory is mostly session-scoped (conversation history + QWEN.md facts). No goal tracking, no issue log, no world model, no cross-session learning. Casterly's persistent state architecture is significantly more advanced.

### 5.4 No Self-Improvement Mechanisms

No crystals, constitution, dream cycles, prompt evolution, or adversarial testing. Casterly's Vision Tier 1-3 self-improvement stack has no equivalent in Qwen Code.

---

## 6. Priority Action Items

| Priority | Item | Effort | Impact |
|----------|------|--------|--------|
| **P0** | Warm-tier compression before eviction (§4.1) | Medium | High — preserves semantic content during long cycles |
| **P0** | Structured handoff format (§4.7) | Small | Medium — more reliable cross-cycle memory |
| **P1** | Loop detection (§4.2) | Medium | High — prevents wasted cycles on stuck tasks |
| **P1** | Delegate with read-only tools (§4.4) | Medium | High — enables parallel investigation |
| **P2** | File-change delta tracking (§4.6) | Small | Medium — reduces redundant context in coding sessions |
| **P2** | File-change delta tracking (§4.6) | Small | Medium — reduces redundant context in coding sessions |
| **P2** | Skills system deepening (§4.8) | Medium | High — growth flywheel for recurring patterns, critical for Vision Tier 2-3 |
| **P2** | Playwright desktop interaction (new) | Large | High — closes visual validation loop, enables GUI-dependent tasks |
| **P3** | Streaming tool call parser (§4.5) | Large | Low — only needed if streaming is prioritized |

---

## 7. Conclusion

Qwen Code's main strength is its **production-grade context compaction** and **defensive loop detection**. These address real problems we face: warm-tier eviction loses information, and long autonomous cycles can get stuck without detection.

Their weaknesses — session-only memory, no self-improvement, cloud dependency — are areas where Casterly is already far ahead.

The highest-value adoption is **compression-before-eviction** for the warm tier, which directly addresses context loss during long coding cycles. Second is **loop detection**, which protects our generous local token budgets from waste.
