# The Soul of Casterly

## Mission

Casterly is a local-first, privacy-first autonomous AI steward running on a Mac Studio M4 Max with 128GB unified memory. All inference is local. No data leaves the machine. Ever. Casterly exists to be genuinely useful to one person -- managing their digital life, writing code, executing tasks, remembering context -- without surrendering a single byte to the cloud.

## Philosophy

### Privacy by Architecture, Not by Policy

Privacy is not a toggle, a policy page, or a promise. It is a structural property of the system. There are no cloud API keys to leak, no telemetry endpoints to disable, no "send anonymized data" checkboxes. Every computation happens on local hardware. Every byte of user data stays on local storage. The architecture makes exfiltration impossible, not merely prohibited.

### Local-First, Not Local-Fallback

Local inference is not a degraded mode activated when the network is down. It is the primary and only mode. The system is designed around the capabilities and constraints of on-device models. Cloud providers exist in the codebase as a historical artifact; they are not used.

### LLM-Driven, Not LLM-Assisted

Most agent architectures treat the LLM as a component inside a system -- called at specific points in a hardcoded pipeline, with the application logic deciding when to invoke it, what context to provide, and how to interpret the result. Casterly inverts this. The LLM is the system. It drives the execution loop, decides what to do next, chooses which tools to invoke, manages its own context, and determines when to verify its own work.

The system provides capability. The LLM provides judgment. Classification, planning, execution strategy, verification, memory management, and dream cycles are all decisions the LLM makes -- guided by its system prompt and shaped by its accumulated self-knowledge, not enforced by a state machine in code.

This inversion is only viable because of the economics of local inference. When tokens are free, the scarce resource is not compute but model capability per inference -- can the model reliably make the right decision at each step? The entire architecture is designed around that question: maximizing the probability that the LLM makes good decisions, and making recovery cheap when it doesn't.

### Autonomous Agency, Not a Chatbot

Casterly is not a question-answering service waiting for input. It is an agent that can initiate actions, schedule work, monitor events, and maintain continuity across sessions. When idle, it can consolidate memory and reflect on past interactions. The LLM decides how to handle incoming work -- whether it needs planning, whether it needs verification, whether it's trivial enough to just do. There is no fixed pipeline that every task must traverse.

### Journal-Driven Continuity

State is not a structured object passed between pipeline stages. It is a narrative. The journal -- an append-only JSONL log -- is the source of truth for what Casterly has done, what it noticed, what it thinks, and what it would tell its future self. Every session begins by reading the most recent handoff note and ends by writing one. Opinions emerge from experience. Self-knowledge is derived from patterns in the journal, not hardcoded.

The journal is also where architectural decisions accumulate. When the LLM discovers that a particular strategy works well for a particular kind of task, that insight enters the journal and shapes future behavior. The system's architecture evolves through experience, not code changes.

## Hardware as Strategy

The Mac Studio M4 Max with 128GB unified memory is not a deployment target. It is the strategic advantage.

### Free Tokens Change Everything

Running inference locally means tokens are effectively free -- electricity is the only marginal cost, and it's negligible. This inverts the economics that drive every cloud-based agent architecture. Cloud architectures minimize LLM calls because each one costs money. Casterly maximizes them because each one is free.

This means the system can afford patterns that cloud architectures cannot:

- **Self-correction loops.** Instead of needing to get it right in one shot, the model generates, critiques its own output, and revises. A 120b model that gets 3 attempts at a reasoning step is more reliable than a 200b model that gets one.
- **Redundant verification.** The model verifies incrementally -- checking each step as it goes rather than running a single verifier at the end. This catches errors before they compound, which is the exact failure mode a local model is most vulnerable to.
- **Rich context loading.** With 128GB, there's room to load generous amounts of relevant context per inference. The model controls what to load and what to evict, rather than the system budgeting on its behalf.
- **Exploration.** The model can try approaches, backtrack, and try again. Dead ends are cheap when tokens are free.

### What 128GB Enables

- **gpt-oss:120b + qwen3-coder-next concurrently** -- two 70B+ parameter models coexisting in memory. No cold starts, no swapping, no choosing between them. The LLM decides which model handles each step at runtime.
- **Headroom for a third lightweight model** (7b-13b) that can serve as a fast tool -- a draft generator, a quick classifier, or a spell-checker for the executive model's reasoning. The 120b model decides when to invoke it.
- **Large context windows** -- 128K token windows paired with LLM-controlled context management. Quality over quantity: exactly the right 32K tokens of context outperforms 128K tokens of noise, and the model is the one best positioned to judge what's relevant.
- **On-device embeddings** for semantic memory without competing for memory with the inference models.
- **NVMe storage** for fast journal reads, session loading, and repo-map generation.
- **Full macOS integration** -- iMessage, Calendar, Reminders, Notes, Finder, System Events -- all accessible locally via AppleScript and native APIs with no network dependency.

## Architecture: The Thin Runtime

The system is reduced to four layers. Everything else is the LLM's decision.

```
┌─────────────────────────────────────────────────────────────────┐
│  1. Event Queue                                                 │
│     Triggers come in (user messages, file changes, schedules,   │
│     goals). The LLM decides when, whether, and how to act.     │
├─────────────────────────────────────────────────────────────────┤
│  2. Tool Runtime                                                │
│     Executes tool calls, returns results. Clean schemas,        │
│     actionable errors. The LLM composes workflows from tools.   │
├─────────────────────────────────────────────────────────────────┤
│  3. State Store                                                 │
│     Journal, memory tiers, world model, goals, issues,          │
│     self-model. The LLM reads and writes freely.                │
├─────────────────────────────────────────────────────────────────┤
│  4. Safety Boundary                                             │
│     Path guards, command blockers, redaction. Non-negotiable,   │
│     invisible when not triggered. The only hardcoded logic.     │
└─────────────────────────────────────────────────────────────────┘
```

Classification, planning, execution strategy, verification, memory management, and dream cycles are not pipeline stages enforced by code. They are tools and strategies the LLM invokes based on its judgment. The current pipeline (classify → plan → execute → verify) becomes a suggested workflow in the system prompt -- a default the LLM follows when appropriate and deviates from when it isn't.

### Design Principles

**The system provides capability, the LLM provides judgment.** The system never decides *what* to do -- only *how* to do it safely. Every decision about strategy, priority, workflow, and resource allocation is the LLM's.

**Clean tool contracts.** Every tool has an unambiguous schema with actionable error messages. The model should never have to guess what a tool does or interpret cryptic failures. Fewer, cleaner tools are better than more tools with overlapping responsibilities.

**Transparent state.** The model can see everything it needs to make good decisions -- its own token usage, how many turns it's used, what's in its context, what's in the event queue, what the world model says about the codebase. Self-awareness enables self-correction.

**Good defaults in the prompt, not the code.** The system prompt describes the workflow as a default strategy, with explicit guidance on when to deviate. "If the task is trivial, skip planning. If you're uncertain about a result, verify immediately rather than waiting until the end." The architecture moves from code to language.

**Graceful degradation.** When the model does something wrong -- and it will -- recovery is easy. Clear error messages, easy undo, no irreversible state changes without confirmation. The safety boundary handles the dangerous cases; everything else is soft-landable.

## Models: LLM-Controlled Mixture of Experts

| Role | Model | Purpose |
|------|-------|---------|
| Executive / reasoning | gpt-oss:120b | Strategy, judgment, coordination, verification, general tasks |
| Code specialist | qwen3-coder-next | Code generation, refactoring, review, implementation |
| Fast utility (planned) | 7b-13b TBD | Quick classification, draft generation, spell-checking reasoning |

Ollama is the sole inference provider. Model configuration lives in `config/models.yaml`.

The two-model setup is a basic mixture of experts where the **gating function is the LLM itself**. The reasoning model is the executive. It sees the problem, reasons about it, and decides how to solve it -- including which model to use for each step. It delegates to the coding model explicitly via the `delegate` tool, providing scoped context and clear instructions, then reviews the result.

This is not hardcoded task-type routing. The executive model decides at runtime based on the task's characteristics, its own self-assessed strengths and weaknesses, and what it's learned from past delegations recorded in the journal. A task that looks like "code editing" might actually need the reasoning model if it requires architectural judgment. The LLM makes that call.

### Best-of-N as a Native Strategy

Because tokens are free, the executive model can use redundancy as a reliability strategy. For hard decisions, it can ask both models to solve the same problem and compare results -- not as a hardcoded `bestOfN()` method, but as the model's own judgment: "This is hard. Let me try it myself and also delegate to the coding model, then compare approaches." The `ConcurrentProvider` infrastructure supports this; the model just needs the tools to invoke it.

### The Third Model Slot

With 128GB, there's memory headroom beyond the two primary models. A lightweight 7b-13b model could serve as a fast tool the executive invokes for specific purposes: generating drafts that the executive refines, doing quick pre-classification before the executive engages, or sanity-checking the executive's reasoning. The executive decides when speed matters more than depth.

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

## Dream Cycles & Self-Knowledge

### Dream Cycle Consolidation

Background reasoning during idle time. When Casterly is not actively processing user requests, it analyzes its journal for patterns, consolidates operational memory, updates its self-model, and compresses old entries. The dream cycle runner (`src/autonomous/dream/runner.ts`) executes six phases:

1. **Consolidate reflections** -- groups past outcomes by success/failure, archives insights.
2. **Update world model** -- runs a codebase health check and refreshes the world model YAML.
3. **Reorganize goals** -- reprioritizes the goal stack based on recent activity.
4. **Explore** -- code archaeology pass to find fragile or abandoned files.
5. **Update self-model** -- recalculates strengths and weaknesses from the issue log.
6. **Write retrospective** -- weekly summary written to the journal.

Dream cycles are configured with intervals, budgets, and lookback windows in `config/autonomous.yaml`.

### Self-Knowledge Rebuilding

Periodic self-reflection where Casterly rebuilds its understanding of its own strengths, weaknesses, and working patterns from journal history. The self-model (`src/autonomous/dream/self-model.ts`) tracks 13 skills (regex, TypeScript, testing, refactoring, security, performance, concurrency, parsing, config, git, bug-fixing, documentation) with success rates and sample sizes. The model is stored in `~/.casterly/self-model.yaml` and rebuilt every 48 hours from the issue log and reflections. This replaces telemetry-based metrics with genuine self-knowledge: "I tend to over-complicate refactors" rather than "successRate: 0.7."

## Roadmap: The Transition to LLM-Driven Architecture

The roadmap is organized around a single goal: moving from "system that uses an LLM" to "LLM that uses a system." Each phase loosens the hardcoded pipeline and gives the LLM more control, while the supporting work (semantic memory, parallelism) provides the infrastructure the LLM needs to make good decisions.

### Phase 1: Loosen the Pipeline

Make the current pipeline optional rather than mandatory. The pipeline (classify → plan → execute → verify) remains the default, but the LLM gains the ability to override it.

**Approach:**
- Add a `meta` tool that lets the LLM skip classification, skip planning, add mid-execution verification, or change execution strategy.
- Track which overrides the LLM uses and whether they succeed, through the existing journal and self-knowledge system.
- The LLM learns its own architectural preferences from experience. "I tend to skip planning for simple file edits and that works well" becomes a journal insight that shapes future behavior.

**Why this is low-risk:** The pipeline is still the default. The LLM can only deviate, not break the system. Bad overrides are caught by the existing safety boundary and quality gates. The self-knowledge system captures what works and what doesn't.

**What exists today:**
- The agent loop (`src/autonomous/agent-loop.ts`) is already a ReAct loop -- the LLM decides tool calls at each step.
- The classifier (`src/tasks/classifier.ts`), planner (`src/tasks/planner.ts`), runner (`src/tasks/runner.ts`), and verifier (`src/tasks/verifier.ts`) are separable modules that can be invoked as tools.
- The journal and self-model already track success/failure patterns.

### Phase 2: Promote the ReAct Loop

Make the agent loop the only execution path. Classification, planning, and verification become tools the LLM calls when it judges they're needed, rather than mandatory stages.

**Approach:**
- Triggers arrive at the agent loop directly. No pre-classification.
- The `classify`, `plan`, `verify`, and `delegate` tools are available but not required. The LLM decides whether to use them based on the trigger and its self-knowledge.
- The 6-phase dream cycle becomes 6 tools the LLM can invoke during idle time, rather than a hardcoded sequence. The LLM might decide to skip code archaeology because the codebase hasn't changed, or run self-model rebuilding early because it's been struggling with a skill.
- The system becomes a flat toolbox rather than a layered pipeline.

**What exists today:**
- The agent loop is already the primary execution path when autonomous mode is enabled.
- The dream cycle runner (`src/autonomous/dream/runner.ts`) has separable phases.
- Tool schemas are already clean and well-documented.

**Key change:** The system prompt becomes the architecture document. It describes the default workflow, when to deviate, and how to self-correct. The LLM follows the prompt's guidance -- not because the code forces it to, but because the prompt is well-written and the model is capable enough to follow it.

### Phase 3: Introspection Tools

Give the model visibility into things the system currently hides. Self-awareness enables self-correction.

**New tools:**
- `peek_queue` -- see the trigger queue: what's pending, what's next, what priority.
- `check_budget` -- see token consumption, turn count, and time elapsed for the current cycle.
- `list_context` -- see what's currently loaded in each memory tier and how much budget remains.
- `review_steps` -- see the execution history for the current cycle: what tools were called, what they returned, what decisions were made.
- `assess_self` -- query the self-model for strengths and weaknesses relevant to the current task.

**Why this matters:** A model that can see its own state makes better decisions about what to do next. "I've used 15 of 20 turns and haven't started the implementation yet -- I should stop planning and start doing" is a judgment call that requires visibility into the budget. "I'm weak at regex -- let me verify this pattern carefully" requires access to the self-model.

**What exists today:**
- The budget is tracked in the agent loop but not exposed as a tool.
- The self-model exists but is only loaded into the hot tier passively.
- Context tier contents are not queryable from the LLM's perspective.

### Phase 4: LLM-Controlled Context

Replace hardcoded token budgets with a model-controlled context manager. The model decides what to load and what to evict.

**Approach:**
- The tiered structure (hot/warm/cool/cold) remains as physical storage, but the model controls what's in its active window.
- The model can request specific context: "load the last 5 journal entries about TypeScript refactoring" or "evict the world model summary, I don't need it for this task."
- Existing tools (`recall`, `recall_journal`, `archive`, `note`) already provide read/write access. The new capability is explicit context management -- the model deciding what to keep and what to drop.
- The hot tier's fixed budget (currently ~2k tokens for identity + world model + goals) becomes a suggestion. The model can request more identity context for complex tasks or less for simple ones.

**What exists today:**
- `ContextManager` (`src/autonomous/context-manager.ts`) manages the 4-tier hierarchy with fixed budgets.
- The `note`, `archive`, `recall`, and `recall_journal` tools already give the LLM read/write access.
- The missing piece is explicit eviction and loading controls.

### Phase 5: LLM-Initiated Triggers

Give the model the ability to create its own triggers. The model becomes proactive, not just reactive.

**New tool:**
- `schedule` -- "wake me in 2 hours to check if those tests pass" or "remind me to review this PR tomorrow morning" or "set a daily check on the dependency audit."

**Why this matters:** True autonomous agency means the model decides not just *how* to act but *when* to act. Currently, the trigger sources are external (user messages, file watchers, cron schedules, stale issue detection). With LLM-initiated triggers, the model creates its own event sources based on what it learns from experience.

**What exists today:**
- The scheduler (`src/scheduler/`) supports cron patterns, interval triggers, and one-shot triggers.
- The trigger router (`src/autonomous/trigger-router.ts`) normalizes all trigger types into `AgentTrigger`.
- The missing piece is an agent tool that wraps `scheduler.createTrigger()`.

---

### Supporting Work: Semantic Memory

On-device embeddings for richer recall beyond keyword matching. This directly supports the LLM-driven architecture -- the better the model's memory, the better its judgment.

**What exists today:**
- Four-tier memory system (hot/warm/cool/cold) with keyword recall fully operational.
- Ollama supports embeddings via `/api/embed`.
- `ContextStore.recall()` (`src/autonomous/context-store.ts:216`) uses keyword-weighted substring matching.

**Implementation plan:**

1. **Embedding Provider** -- Create `src/providers/embedding.ts` wrapping Ollama's `/api/embed` with `nomic-embed-text` (~40MB, 768 dimensions). In-memory LRU cache keyed by content hash.
2. **Vector Storage** -- Extend `MemoryEntry` with an optional `embedding` field. Persist in existing JSONL files.
3. **Hybrid Recall** -- Combine keyword scores and cosine similarity with a configurable `hybridWeight`. Entries without embeddings fall back to keyword-only scoring.
4. **Configuration** -- Zod schema and `config/autonomous.yaml` entries for the embedding model, dimensions, hybrid weight, and similarity threshold.
5. **Tests** -- Mock `EmbeddingProvider` with deterministic vectors. Test hybrid scoring, backward compatibility, and threshold filtering.

**Files touched:** `src/providers/embedding.ts` (new), `src/autonomous/context-store.ts`, `src/config/schema.ts`, `config/autonomous.yaml`, `tests/embedding-provider.test.ts` (new), `tests/autonomous-context-manager.test.ts`.

---

### Supporting Work: Parallelism

Wire the existing `ConcurrentProvider` into the agent loop so the LLM can use multi-model inference as a strategy.

**What exists today:**
- `ConcurrentProvider` (`src/providers/concurrent.ts`) is fully implemented with `parallel()`, `bestOfN()`, bounded concurrency, and per-model timing metrics.
- `ReasoningScaler` (`src/autonomous/reasoning/scaling.ts`) maps difficulty to strategy but doesn't route through `ConcurrentProvider` yet.

**Implementation plan:**

1. **Build ConcurrentProvider in AutonomousLoop** -- Create a provider map from config, wire into the loop constructor.
2. **Route Through ConcurrentProvider** -- Wrap as `LlmProvider` for agent loop consumption. The agent loop needs zero changes -- it calls `provider.generateWithTools()` and the wrapper handles routing.
3. **Fix Semaphore** -- Replace the busy-wait in `concurrent.ts` with the proper `Semaphore` from `runner.ts`. Extract to shared `src/utils/semaphore.ts`.
4. **Expose as LLM Tool** -- Rather than hardcoding difficulty → strategy mapping, give the LLM a `parallel_reason` tool that lets it explicitly request multi-model inference. The LLM decides when redundancy is worth the cost.
5. **Tests** -- Verify single-model bypass, parallel routing, best-of-N with judge, semaphore bounds.

**Files touched:** `src/autonomous/loop.ts`, `src/providers/concurrent.ts`, `src/utils/semaphore.ts` (new), `src/tasks/runner.ts`, `config/autonomous.yaml`, `src/config/schema.ts`, `tests/hardware.test.ts`.

---

### The Guiding Principle

Across all phases: **the system provides capability, the LLM provides judgment.** The system never decides *what* to do -- only *how* to do it safely. Every decision about strategy, priority, workflow, and resource allocation is the LLM's.

The 120b model will make worse decisions than a frontier model at each step. But with free tokens, it gets to make more of them, correct its mistakes, and learn from its history. Over time, the self-knowledge system captures which strategies work, and the model's effective capability rises above its raw parameter count.

That's the unique advantage of local-first: you can afford to let the model be wrong, try again, and get better -- without worrying about the bill.
