# Plan: Unified Vision Document

## Goal

Replace all existing documentation with three authoritative documents. Nothing important lives outside these three files.

## Documents

### 1. `docs/vision.md` — The Soul of the Project

**Purpose:** Why Casterly exists, what it's becoming, hardware as strategy.

Sections:
1. **Mission** — One-paragraph statement: Casterly is a local-first, privacy-first autonomous AI steward running on a Mac Studio M4 Max with 128GB unified memory. All inference is local. No data leaves the machine. Ever.
2. **Philosophy** — Privacy-by-architecture (not by policy), local-first (not local-fallback), autonomous agency (not a chatbot), journal-driven continuity.
3. **Hardware as Strategy** — The M4 Max / 128GB isn't a deployment target, it's the strategic advantage. Running gpt-oss:120b locally with headroom. Frame what this enables now and what it unlocks.
4. **Models** — gpt-oss:120b (primary reasoning, planning, conversation), qwen3-coder-next (code editing). Task-based routing via config. Ollama as sole inference provider.
5. **Identity & Personality** — Workspace personality files (SOUL.md, IDENTITY.md, TOOLS.md, USER.md). Casterly has a voice, not just capabilities.
6. **Invariants** — The non-negotiable rules, consolidated from rulebook.md, CLAUDE.md, and AGENTS.md into one canonical list.
7. **Roadmap** — Four items:
   - Semantic memory: on-device embeddings for richer recall beyond keyword matching
   - Parallelism: concurrent agent reasoning to maximize hardware utilization
   - Dream cycle consolidation: background reasoning during idle time (stubbed)
   - Self-knowledge rebuilding: periodic self-reflection passes (stubbed)

### 2. `docs/architecture.md` — How It Works

**Purpose:** The complete technical reference. One document to understand the system.

Sections:
1. **System Overview** — High-level data flow diagram. Triggers → Router → Unified Agent Loop → Tools/State/Delegation.
2. **Unified Agent Loop** — `AgentLoop.run()` entry point, ReAct cycle, journal loading, state mutations. The conceptual model.
3. **Trigger System** — All event sources (iMessage, CLI, file watcher, git hooks, cron, goals) normalized into uniform Trigger shape.
4. **Task Execution** — Classifier → Planner (DAG decomposition) → Runner (parallel execution) → Verifier (structural checks, LLM judge fallback).
5. **Tools & Skills** — Tool registry, native executors (read, write, list, search), bash executor with safety gates (BLOCKED/APPROVAL_REQUIRED/SAFE), OpenClaw-compatible skills system.
6. **Coding Interface** — Aider-style interface, repo-map with PageRank, context budgeting, validation pipeline (parse → lint → typecheck → test), modes (Code, Architect, Ask, Review).
7. **iMessage Integration** — Daemon polling, SQLite reader, AppleScript sender, tool filter for restricted context.
8. **Scheduler** — Cron + one-shot jobs, synthetic message injection, persistent job store.
9. **Memory & State** — Journal (append-only JSONL, source of truth for agent continuity), world model, long-term user memory, execution log, session persistence.
10. **Security & Privacy** — Sensitive data categories (calendar, finance, health, credentials, contacts, voice memos), pattern detection, automatic redaction, safe logging. Centralized in `src/security/*`.
11. **Configuration** — YAML-based with Zod validation, `config/models.yaml` for task-based model routing, fail-fast on invalid config.
12. **Data Layout** — Full `~/.casterly/` directory structure with purpose of each path.
13. **API Reference** — Provider interface (`LlmProvider`, `generateWithTools()`), tool schemas, key function signatures. Absorbs current api-reference.md.
14. **Error Codes** — Structured error system (E1xx-E9xx). Absorbs current error-codes.md.
15. **Testing** — Trace collection, test cases, benchmarking framework, CLI interfaces. Absorbs current testing.md.

### 3. `CLAUDE.md` — How to Work Here

**Purpose:** Operational instructions for Claude Code sessions. Minimal, directive, points to vision.md as authority.

Sections:
1. **First Principles** — Read `docs/vision.md` first. Local-first, privacy-first. When unsure, route locally.
2. **Mandatory Reading** — `docs/vision.md` for context, `docs/architecture.md` for technical reference.
3. **Protected Paths** — Single canonical list: `src/security/*`, `src/tasks/classifier.ts`, `src/providers/*`, `config/*`, `.env*`. State clearly and run quality gates if touched.
4. **Quality Gates** — `npm run check` after every change. What it runs, what to do if it fails.
5. **Implementation Standards** — Small, explicit, readable code. Provider logic in provider modules. Structured and testable routing. Never log raw sensitive content.
6. **Subagent Flow** — Default sequence: System Architect → Implementer → Security Reviewer → Test Engineer → Quality Gates Enforcer. Absorbs subagents.md role definitions.

## Files to Delete

- `casterly-plan.md` (outdated, describes cloud routing that doesn't exist)
- `docs/rulebook.md` (absorbed into vision.md invariants + architecture.md security)
- `docs/subagents.md` (absorbed into CLAUDE.md)
- `docs/IMPLEMENTATION-GUIDE.md` (absorbed into architecture.md)
- `docs/api-reference.md` (absorbed into architecture.md)
- `docs/error-codes.md` (absorbed into architecture.md)
- `docs/testing.md` (absorbed into architecture.md)
- `docs/OPEN-ISSUES.md` (all issues implemented, roadmap in vision.md)
- `docs/PLAN-agent-architecture-refactor.md` (completed work)
- `AGENTS.md` (absorbed into CLAUDE.md)

## Execution Order

1. Read all existing docs thoroughly to capture every detail worth preserving
2. Write `docs/vision.md`
3. Write `docs/architecture.md`
4. Rewrite `CLAUDE.md`
5. Delete all absorbed/outdated files
6. Run `npm run check` to verify nothing breaks
7. Commit and push
