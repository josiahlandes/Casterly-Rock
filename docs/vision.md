# The Soul of Casterly

## Mission

Casterly is a local-first, privacy-first autonomous AI steward running on a Mac Studio M4 Max with 128GB unified memory. All inference is local. No data leaves the machine. Ever. Casterly exists to be genuinely useful to one person -- managing their digital life, writing code, executing tasks, remembering context -- without surrendering a single byte to the cloud.

## Philosophy

### Privacy by Architecture, Not by Policy

Privacy is not a toggle, a policy page, or a promise. It is a structural property of the system. There are no cloud API keys to leak, no telemetry endpoints to disable, no "send anonymized data" checkboxes. Every computation happens on local hardware. Every byte of user data stays on local storage. The architecture makes exfiltration impossible, not merely prohibited.

### Local-First, Not Local-Fallback

Local inference is not a degraded mode activated when the network is down. It is the primary and only mode. The system is designed around the capabilities and constraints of on-device models. Cloud providers exist in the codebase as a historical artifact; they are not used.

### Autonomous Agency, Not a Chatbot

Casterly is not a question-answering service waiting for input. It is an agent that can initiate actions, schedule work, monitor events, and maintain continuity across sessions. It classifies incoming work, decomposes complex tasks into plans, executes those plans with verification, and learns from outcomes. When idle, it can consolidate memory and reflect on past interactions.

### Journal-Driven Continuity

State is not a structured object passed between pipeline stages. It is a narrative. The journal -- an append-only JSONL log -- is the source of truth for what Casterly has done, what it noticed, what it thinks, and what it would tell its future self. Every session begins by reading the most recent handoff note and ends by writing one. Opinions emerge from experience. Self-knowledge is derived from patterns in the journal, not hardcoded.

## Hardware as Strategy

The Mac Studio M4 Max with 128GB unified memory is not a deployment target. It is the strategic advantage.

### What This Enables Now

- **gpt-oss:120b running locally** with headroom for a second concurrent model (qwen3-coder-next for code editing). No API latency. No rate limits. No per-token costs.
- **128GB unified memory** means two 70B+ parameter models can coexist in memory simultaneously, enabling task-based model routing without cold starts.
- **NVMe storage** for fast journal reads, session loading, and repo-map generation.
- **Full macOS integration** -- iMessage, Calendar, Reminders, Notes, Finder, System Events -- all accessible locally via AppleScript and native APIs with no network dependency.

### What This Unlocks

- **On-device embeddings** for semantic memory (beyond keyword matching in the journal).
- **Concurrent agent reasoning** to maximize hardware utilization -- multiple subagents reasoning in parallel within the hardware's concurrency budget.
- **Real-time event processing** -- file watchers, git hooks, and calendar polling feeding triggers into the agent loop with minimal latency.
- **Large context windows** -- local models with 128K context windows, paired with intelligent context budgeting, enable complex multi-file code operations.

## Models

| Role | Model | Purpose |
|------|-------|---------|
| Primary reasoning | gpt-oss:120b | Planning, conversation, classification, verification, general tasks |
| Code editing | qwen3-coder-next | Code generation, refactoring, review, implementation |

Task-based routing is configured in `config/models.yaml`. Ollama is the sole inference provider. Model selection follows these rules:

- **Coding tasks** (code generation, refactoring, bug fixes, review) route to `qwen3-coder-next`.
- **General tasks** (reasoning, planning, conversation, classification) route to the primary model.
- **Autonomous cycles** use the primary model for reasoning and delegate coding subtasks to the coding model via the `delegate` tool.

The agent can also perform metacognitive delegation -- deciding at runtime which model is best suited for a subtask based on its self-assessment of the task's characteristics.

## Identity and Personality

Casterly's deployed instance is named **Tyrion**. The personality is defined in workspace files that the agent reads at the start of every session:

| File | Purpose |
|------|---------|
| `workspace/SOUL.md` | Core truths, personality traits, boundaries, communication style |
| `workspace/IDENTITY.md` | Name, platform, interface, vibe |
| `workspace/TOOLS.md` | Environment-specific notes, memory system, safety rules |
| `workspace/USER.md` | User profile -- built over time through interaction |

Tyrion has a voice, not just capabilities:

- **Concise** -- responses are brief, especially over iMessage.
- **Direct** -- says what it means without hedging.
- **Practical** -- focuses on solving problems.
- **Honest** -- admits limitations and uncertainty.
- **Attentive** -- remembers details and builds understanding of the user over time.

The personality is not cosmetic. It shapes how the agent communicates, what it prioritizes, and how it earns trust. "Be genuinely helpful, not performatively helpful" is the first core truth.

## Invariants

These rules are non-negotiable. They must remain true as the project evolves. Changing them requires explicit user authorization.

### Architecture Invariants

1. All inference is local via Ollama. No cloud APIs.
2. Provider integrations sit behind a stable, minimal `LlmProvider` interface.
3. Security and redaction logic are centralized in `src/security/*`.
4. Logging goes through the privacy-safe logger (`src/logging/safe-logger.ts`), never direct `console.log` for user data.
5. Configuration is validated at startup via Zod schemas and fails fast on invalid or unsafe settings.
6. Model selection is task-based (coding vs primary) via `config/models.yaml`.
7. The agent loop is the single execution path. No separate interactive/autonomous code paths.
8. The journal is append-only. Entries are never deleted, only compressed during dream cycles.
9. Delegation is transparent. Every delegated call is logged and reviewable.

### Security Invariants

1. All user data stays on the local machine.
2. Redaction is the default for any user-provided text in logs.
3. Secrets (API keys, tokens, credentials) are never logged or echoed.
4. Privacy-critical behavior is covered by unit tests.
5. Guardrails flag changes to critical privacy modules and sensitive paths.
6. The user model is local-only and never logged raw -- it is derived, not stored verbatim.

### Sensitive Data Categories

These categories are handled with particular care (all stay local by design):

1. Calendar and schedules
2. Financial information and transactions
3. Health and medical information
4. Credentials, passwords, secrets, or API keys
5. Private notes, journals, voice memos, or documents
6. Personal contacts and relationships

### Protected Paths

Changes to these paths are high risk and must be called out explicitly:

- `src/security/*`
- `src/tasks/classifier.ts`
- `src/providers/*`
- `config/*`
- `.env` and `.env.*`
- `scripts/guardrails.mjs`

### Development Workflow

1. Read this document and the relevant module source before making changes.
2. Use the System Architect subagent to confirm the approach for cross-cutting changes.
3. Implement with clear boundaries and minimal surface area.
4. Add or update tests for any behavior change.
5. Run `npm run check` before finishing.
6. If guardrails fail, either revert the risky changes or set `ALLOW_PROTECTED_CHANGES=1` intentionally.

### Definition of Done

A change is done only when:

1. The change respects all invariants above.
2. Tests cover the new or modified behavior.
3. `npm run check` passes locally.
4. Any remaining risk is called out explicitly in the final summary.

## Roadmap

### Semantic Memory

On-device embeddings for richer recall beyond keyword matching. The journal's `recall_journal` tool currently uses keyword search. Embedding-based similarity search would enable the agent to find relevant past context even when the exact words differ. This requires a small, fast embedding model running alongside the reasoning model within the 128GB memory budget.

### Parallelism

Concurrent agent reasoning to maximize hardware utilization. The M4 Max can support two concurrent models. The task runner already has a semaphore-based concurrency pool, but independent branches of a task DAG could be processed in parallel by multiple subagents, each with a scoped context. The hardware constraint is two concurrent large models; the architecture should exploit this fully.

### Dream Cycle Consolidation

Background reasoning during idle time. When the agent is not actively processing user requests, it can analyze its journal for patterns, consolidate operational memory, update its self-model, and compress old entries. The `consolidate` tool and dream cycle runner are currently stubs awaiting real pattern analysis logic.

### Self-Knowledge Rebuilding

Periodic self-reflection passes where the agent rebuilds its understanding of its own strengths, weaknesses, and working patterns entirely from journal history. This replaces telemetry-based metrics with genuine self-knowledge: "I tend to over-complicate refactors" rather than "successRate: 0.7."
