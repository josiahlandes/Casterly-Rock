# Plan: Unified Documentation

## Goal

Replace scattered documentation with a clear hierarchy: one vision doc, one architecture overview that links to focused detail docs, and one operational guide. Every doc has one job. Nothing important is lost.

## Documents

### 1. `docs/vision.md` — The Soul of the Project

**Purpose:** Why Casterly exists, what it's becoming, hardware as strategy.

Sections:
1. **Mission** — One-paragraph statement: Casterly is a local-first, privacy-first autonomous AI steward running on a Mac Studio M4 Max with 128GB unified memory. All inference is local. No data leaves the machine. Ever.
2. **Philosophy** — Privacy-by-architecture (not by policy), local-first (not local-fallback), autonomous agency (not a chatbot), journal-driven continuity.
3. **Hardware as Strategy** — The M4 Max / 128GB isn't a deployment target, it's the strategic advantage. Running qwen3.5:122b locally with headroom. Frame what this enables now and what it unlocks.
4. **Models** — qwen3.5:122b (primary reasoning, planning, conversation), qwen3-coder-next (code editing). Task-based routing via config. Ollama as sole inference provider.
5. **Identity & Personality** — Workspace personality files (SOUL.md, IDENTITY.md, TOOLS.md, USER.md). Casterly has a voice, not just capabilities.
6. **Invariants** — The non-negotiable rules, consolidated from rulebook.md, CLAUDE.md, and AGENTS.md into one canonical list.
7. **Roadmap**:
   - File type support: PDF, DOCX, XLSX, CSV ingestion (ISSUE-001, pending)
   - Scheduler: cron, watch, triggers as synthetic messages (ISSUE-003, pending)
   - Approval flow: async state machine with timeout (ISSUE-004, pending)
   - Semantic memory: on-device embeddings for richer recall beyond keyword matching
   - Parallelism: concurrent agent reasoning to maximize hardware utilization
   - Dream cycle consolidation: background reasoning during idle time (stubbed)
   - Self-knowledge rebuilding: periodic self-reflection passes (stubbed)

### 2. `docs/architecture.md` — How It Works (Overview + Index)

**Purpose:** High-level system overview with a short summary of each subsystem, linking to a dedicated detail doc for each. This is the entry point, not the encyclopedia.

Overview section:
- **System Overview** — High-level data flow diagram. Triggers → Router → Unified Agent Loop → Tools/State/Delegation. One page, one diagram, enough to orient a new reader.
- **Module Index** — Table linking each subsystem to its detail doc.

Each subsystem gets a focused detail doc under `docs/`:

| Detail Doc | Content | Absorbs |
|---|---|---|
| `docs/agent-loop.md` | `AgentLoop.run()` entry point, ReAct cycle, journal loading, state mutations | New |
| `docs/triggers.md` | All event sources (iMessage, CLI, file watcher, git hooks, cron, goals) normalized into uniform Trigger shape | New |
| `docs/task-execution.md` | Classifier → Planner (DAG decomposition) → Runner (parallel execution) → Verifier. Includes implementation specs and dependency graph for open issues | `docs/IMPLEMENTATION-GUIDE.md` |
| `docs/skills-and-tools.md` | Tool registry, native executors, bash safety gates, OpenClaw-compatible skills system | Existing (keep + update) |
| `docs/coding-interface.md` | Aider-style interface, repo-map, context budgeting, validation pipeline, modes | Existing (keep + update) |
| `docs/imessage.md` | Daemon polling, SQLite reader, AppleScript sender, tool filter | New |
| `docs/memory-and-state.md` | Journal, world model, user memory, execution log, session persistence | New |
| `docs/security.md` | Sensitive data categories, pattern detection, redaction, safe logging | `docs/rulebook.md` (security invariants) |
| `docs/configuration.md` | YAML + Zod validation, `config/models.yaml`, fail-fast, data layout (`~/.casterly/`) | New |
| `docs/api-reference.md` | Provider interface, tool schemas, key function signatures | Existing (keep + update) |
| `docs/error-codes.md` | Structured error system (E1xx-E9xx), auto-detection, helpers | Existing (keep + update) |
| `docs/testing.md` | Trace collection, test cases, benchmarking, CLI, test registry | Existing (absorbs `docs/test-registry.md`) |
| `docs/install.md` | Installation, prerequisites, configuration | Existing (keep) |

### 3. `CLAUDE.md` — How to Work Here

**Purpose:** Operational instructions for Claude Code sessions. Minimal, directive, points to vision.md as authority.

Sections:
1. **First Principles** — Read `docs/vision.md` first. Local-first, privacy-first. When unsure, route locally.
2. **Mandatory Reading** — `docs/vision.md` for context, `docs/architecture.md` for technical reference.
3. **Protected Paths** — Single canonical list: `src/security/*`, `src/tasks/classifier.ts`, `src/providers/*`, `config/*`, `.env*`, `scripts/guardrails.mjs`. State clearly and run quality gates if touched.
4. **Quality Gates** — `npm run check` after every change. What it runs, what to do if it fails.
5. **Implementation Standards** — Small, explicit, readable code. Provider logic in provider modules. Structured and testable routing. Never log raw sensitive content.
6. **Subagent Flow** — Default sequence: System Architect → Implementer → Security Reviewer → Test Engineer → Quality Gates Enforcer. Absorbs subagents.md role definitions.

## Standalone Docs (Kept Separately)

These docs are self-contained and don't belong in the architecture tree:

- `docs/app-wrapper-plan.md` — Casterly.app native wrapper plan (7 phases, active)
- `docs/mac-permissions-review.md` — macOS permission surface analysis (prerequisite for app wrapper)

## Files to Delete

- `casterly-plan.md` (outdated, describes cloud routing that doesn't exist)
- `docs/rulebook.md` (absorbed into vision.md invariants + docs/security.md)
- `docs/subagents.md` (absorbed into CLAUDE.md)
- `docs/IMPLEMENTATION-GUIDE.md` (absorbed into docs/task-execution.md)
- `docs/test-registry.md` (absorbed into docs/testing.md)
- `docs/OPEN-ISSUES.md` (implemented issues captured in architecture docs, pending issues moved to vision.md roadmap)
- `AGENTS.md` (absorbed into CLAUDE.md)

## Files to Archive (`docs/archive/`)

- `docs/PLAN-agent-architecture-refactor.md` (completed work, but preserves design rationale and risk assessment)

## Execution Order

1. Read all existing docs thoroughly to capture every detail worth preserving
2. Write `docs/vision.md`
3. Write `docs/architecture.md` (overview + module index)
4. Write new detail docs (agent-loop, triggers, task-execution, imessage, memory-and-state, security, configuration)
5. Update existing detail docs that are being kept (skills-and-tools, coding-interface, api-reference, error-codes, testing, install)
6. Rewrite `CLAUDE.md`
7. Move archived files to `docs/archive/`
8. Delete all absorbed/outdated files
9. Run `npm run check` to verify nothing breaks
10. Commit and push
