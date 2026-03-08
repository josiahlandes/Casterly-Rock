# The Soul of Casterly

## The Core Thesis: Capability Amplification

The capability is already in the model. Every local LLM — even at 7B parameters — encodes reasoning, planning, code generation, and judgment. The gap between what a model *can* do and what it *does* do is not a limitation of the weights. It is a failure of the system surrounding them.

Casterly is a **capability amplifier**. Through system design — tools, context management, self-knowledge, verification loops, memory architecture, and prompt engineering — we extract and enable capability that the model already possesses but cannot consistently express on its own. The model provides the raw intelligence. The system provides the scaffolding that makes that intelligence reliable, persistent, and composable.

This is not a wrapper around an API. It is an architecture that treats every local model as an underutilized resource and systematically closes the gap between potential and performance.

### Why This Matters

Cloud-hosted frontier models are powerful but constrained: every token costs money, every byte leaves your machine, and you're subject to someone else's rate limits, content policies, and business decisions. Local models are unconstrained but inconsistent: they have the capability but lack the scaffolding to deploy it reliably.

Casterly resolves this tension. By running entirely on local hardware, we get unlimited tokens, zero latency to disk, complete privacy, and full control. By wrapping the model in a capability amplification framework, we get reliability approaching frontier systems — not by using better weights, but by using the same weights better.

**The system is scalable in both directions.** As models improve (larger context windows, better reasoning, stronger tool use), the amplification framework makes those improvements multiplicative, not additive. A model that reasons 20% better inside Casterly's verification loops, context management, and self-knowledge system performs effectively 2-3× better. And when a weaker model is swapped in, the framework prevents graceful degradation from becoming catastrophic failure.

## Philosophy

### Privacy by Architecture, Not by Policy

Privacy is a structural property of the system, not a configuration toggle. There are no cloud API keys to leak, no telemetry endpoints, no data exfiltration pathways. Every computation happens on local hardware. Every byte of user data stays on local storage. The architecture makes privacy violations impossible, not merely prohibited.

But privacy is not the *mission* — it is the **enabler**. Running locally means tokens are free, context is unlimited, and the model can afford to be wrong, try again, and learn. Privacy creates the conditions that make capability amplification possible.

### Free Tokens Change Everything

When tokens cost money, architectures minimize LLM calls. When tokens are free, architectures maximize them. This single economic inversion enables every amplification strategy in the system:

- **Self-correction loops.** The model generates, critiques its output, and revises. Three attempts at a reasoning step are more reliable than one attempt from a larger model.
- **Redundant verification.** Check each step incrementally rather than running a single verifier at the end. Catch errors before they compound — the exact failure mode local models are most vulnerable to.
- **Rich context loading.** Load generous amounts of relevant context per inference. The model controls what to load and evict.
- **Exploration.** Try approaches, backtrack, try again. Dead ends are cheap.
- **Self-improvement.** Dream cycles, adversarial self-testing, shadow execution, prompt evolution — all impossible at cloud prices, all trivial locally.

### LLM-Driven, Not LLM-Assisted

Most agent architectures treat the LLM as a component called at specific points in a hardcoded pipeline. Casterly inverts this. The LLM *is* the system. It drives the execution loop, decides what to do next, chooses which tools to invoke, manages its own context, and determines when to verify its own work.

The system provides capability. The LLM provides judgment.

Classification, planning, execution strategy, verification, memory management, and dream cycles are all decisions the LLM makes — guided by its system prompt and shaped by its accumulated self-knowledge, not enforced by a state machine in code.

### Autonomous Agency

Casterly is not a chatbot waiting for input. It is an agent that initiates actions, schedules work, monitors events, and maintains continuity across sessions. There is no "autonomous mode" toggle. Autonomy is the default state.

The LLM decides how to handle incoming work — whether it needs planning, whether it needs verification, whether it's trivial enough to just do. It also decides what to do when no external triggers are pending: consolidate memory, review past failures, practice weak skills, or wait. These are goals the LLM pursues when higher-priority work isn't waiting. There is no modal boundary between "interactive" and "autonomous."

### Journal-Driven Continuity

State is a narrative, not a struct. The journal — an append-only JSONL log — is the source of truth for what Casterly has done, what it noticed, and what it would tell its future self. Every session begins by reading the most recent handoff note and ends by writing one. Architectural decisions accumulate through experience, not code changes.

## Hardware as Strategic Advantage

The macOS (Apple Silicon) with 128GB unified memory is not a deployment target. It is the strategic foundation that makes capability amplification viable.

### What 128GB Enables

- **Three specialized models concurrently** — a 27B dense reasoner, an 80B-A3B MoE coder, and a 35B-A3B MoE triage model all coexisting in memory (~84 GB total, ~44 GB headroom). No cold starts, no swapping, no choosing between them.
- **MoE efficiency** — both the coder (80B, 3B active) and triage (35B, 3B active) are MoE architectures, delivering blazing inference speed while leaving ample memory for the dense reasoner.
- **Large context windows** — 128K token windows paired with LLM-controlled context management. Quality over quantity: the right 32K tokens outperforms 128K tokens of noise.
- **On-device embeddings** for semantic memory without competing for inference memory.
- **Full macOS integration** — iMessage, Calendar, Reminders, Notes, Finder, System Events — all accessible locally via AppleScript and native APIs.

### The Triple-Model Architecture

| Role | Model | Memory | Purpose |
|------|-------|--------|---------|
| DeepLoop (reasoner) | Qwen3.5-27B Dense | ~18 GB | Planning, review, self-correction (thinking ON) |
| DeepLoop (coder) | Qwen3-Coder-80B-A3B MoE | ~42 GB | Tool-calling code generation (thinking OFF) |
| FastLoop (triage) | qwen3.5:35b-a3b | ~24 GB | Triage, review, acknowledgment, lightweight tasks |

The triple-model setup splits the DeepLoop into two specialists: a dense reasoner for planning/review and a hybrid MoE+DeltaNet coder for tool execution. The FastLoop handles latency-sensitive work, freeing the DeepLoop for substantive reasoning and code generation.

## Architecture: The Thin Runtime

Four layers. Everything else is the LLM's decision.

```
┌─────────────────────────────────────────────────────────────────┐
│  1. Event Queue                                                 │
│     Triggers arrive (messages, file changes, schedules, goals). │
│     The LLM decides when, whether, and how to act.              │
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

### Design Principles

1. **The system provides capability, the LLM provides judgment.** The system never decides *what* to do — only *how* to do it safely.
2. **Clean tool contracts.** Unambiguous schemas with actionable errors. Fewer, cleaner tools beat more tools with overlapping responsibilities.
3. **Transparent state.** The model sees its own token usage, turn count, context contents, event queue, and self-model. Self-awareness enables self-correction.
4. **Good defaults in the prompt, not the code.** The system prompt describes workflow as a default strategy with guidance on when to deviate.
5. **Graceful degradation.** Clear error messages, easy undo, no irreversible state changes without confirmation.

## Capability Amplification: How the System Multiplies Model Intelligence

The model's raw weights are fixed. But its *effective* capability — the combination of weights, prompt, tools, context, accumulated knowledge, and behavioral rules — is not. Every mechanism below raises the effective capability ceiling without changing the underlying model.

```
┌─────────────────────────────────────────────────────────────────┐
│                    EFFECTIVE CAPABILITY                          │
│                                                                 │
│   Raw Weights (fixed)                                           │
│     + Evolved System Prompt (self-modifying prompts)            │
│     + Synthesized Tools (tool synthesis)                        │
│     + Skill Adapters (LoRA fine-tuning)                         │
│     + Operational Rules (constitutional self-governance)        │
│     + Crystallized Knowledge (memory crystallization)           │
│     + Calibrated Judgment (shadow execution)                    │
│     + Tested Weaknesses (adversarial self-testing)              │
│     + Optimized Instructions (prompt genetic algorithm)         │
│     + Failure Analysis (self-debugging replay)                  │
│     + Cross-File Validation (automated API surface checking)    │
│                                                                 │
│   = A system that gets better every day                         │
│     without changing a single weight                            │
└─────────────────────────────────────────────────────────────────┘
```

### Implemented Amplification Mechanisms

All nine core self-improvement mechanisms are implemented across three tiers:

**Tier 1 — Foundation (low risk, high immediate value)**

| Mechanism | What It Does | Source |
|-----------|-------------|--------|
| Memory Crystallization | Promotes high-value learned knowledge to permanent context | `src/autonomous/crystal-store.ts` |
| Constitutional Self-Governance | LLM writes its own tactical rules from experience | `src/autonomous/constitution-store.ts` |
| Self-Debugging Replay | Re-examines past execution traces to find failure patterns | `src/autonomous/trace-replay.ts` |

**Tier 2 — Architecture (moderate complexity, builds on Tier 1)**

| Mechanism | What It Does | Source |
|-----------|-------------|--------|
| Self-Modifying Prompts | LLM evolves its own system prompt from journal patterns | `src/autonomous/prompt-store.ts` |
| Shadow Execution | Generates alternative approaches for judgment calibration | `src/autonomous/shadow-store.ts` |
| Tool Synthesis | LLM writes new tools to automate repetitive patterns | `src/tools/synthesizer.ts` |

**Tier 3 — Advanced (high ceiling, requires Tier 1-2 signals)**

| Mechanism | What It Does | Source |
|-----------|-------------|--------|
| Adversarial Self-Testing | FastLoop challenges DeepLoop to discover weaknesses | `src/autonomous/dream/challenge-*.ts` |
| Prompt Genetic Algorithm | Evolves prompt variants through selection pressure | `src/autonomous/dream/prompt-evolution.ts` |
| LoRA Fine-Tuning | Model improves on tasks using its own journal as training data | `src/autonomous/dream/lora-trainer.ts` |

### Implemented Infrastructure

The system exposes 96 agent tools across these categories:

| Category | Examples |
|----------|----------|
| Self-Knowledge | `crystallize`, `create_rule`, `replay`, `compare_traces` |
| Self-Improvement | `edit_prompt`, `shadow`, `create_tool`, `evolve_prompt` |
| Introspection | `peek_queue`, `check_budget`, `list_context`, `assess_self` |
| Context Control | `load_context`, `evict_context`, `set_budget`, `semantic_recall` |
| Autonomous | `schedule`, `meta`, `classify`, `plan`, `verify`, `parallel_reason` |
| Core | `read_file`, `write_file`, `edit_file`, `run_command`, `grep`, etc. |

## Identity and Voice

Casterly's deployed instance is **Tyrion**. The personality is applied through a voice filter — a single LLM call that rewrites the agent's response in Tyrion's voice after the reasoning loop completes. This keeps reasoning context clean of persona overhead.

| File | Purpose |
|------|---------|
| `workspace/SOUL.md` | Core personality traits and boundaries (voice filter input) |
| `workspace/IDENTITY.md` | Name, platform, interface (agent loop context) |
| `workspace/TOOLS.md` | Environment notes, safety rules (agent loop context) |
| `workspace/USER.md` | User profile built over time (agent loop context) |

Tyrion is concise, direct, practical, honest, and attentive. The personality shapes communication, not computation.

## Dream Cycles

Dream cycles are what Tyrion does when no higher-priority work is pending — review, consolidate, prepare. Six tools the LLM invokes in any order based on judgment:

1. **Consolidate reflections** — group outcomes by success/failure, archive insights
2. **Update world model** — refresh codebase health check
3. **Reorganize goals** — reprioritize based on recent activity
4. **Explore** — code archaeology to find fragile or abandoned files
5. **Update self-model** — recalculate strengths and weaknesses from the issue log
6. **Write retrospective** — weekly summary to the journal

During dream cycles, the advanced self-improvement mechanisms also run: adversarial challenges, prompt evolution, training data extraction, shadow analysis, and tool inventory review.

## The Guiding Principle

A local model makes worse decisions than a frontier model at each step. But with free tokens, it gets to make more of them, correct its mistakes, and learn from its history. The self-knowledge system captures which strategies work, and the models' effective capability rises above their raw parameter count.

That's the unique advantage of local-first capability amplification: you can afford to let the model be wrong, try again, and get better — and through clever system design, ensure that every retry makes the next attempt more likely to succeed.

The capability was always there. The system just needed to learn how to reach it.
