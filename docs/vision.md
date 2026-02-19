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

## Self-Improvement Mechanisms

The 120b model's raw capability is fixed. Its weights don't change between sessions. But its *effective* capability -- the combination of weights, prompt, tools, context, accumulated operational knowledge, and learned behavioral rules -- is not fixed. Every mechanism below raises the effective capability ceiling without changing the underlying model. Free tokens and local hardware make all of them feasible.

```
┌─────────────────────────────────────────────────────────────────┐
│                    EFFECTIVE CAPABILITY                          │
│                                                                 │
│   Raw Weights (fixed)                                           │
│     + Evolved System Prompt (self-modifying prompts)            │
│     + Synthesized Tools (tool synthesis)                        │
│     + Skill Adapters (local fine-tuning / LoRA)                 │
│     + Operational Rules (constitutional self-governance)        │
│     + Crystallized Knowledge (memory crystallization)           │
│     + Calibrated Judgment (shadow execution)                    │
│     + Tested Weaknesses (adversarial self-testing)              │
│     + Optimized Instructions (prompt genetic algorithm)         │
│     + Failure Analysis (self-debugging replay)                  │
│                                                                 │
│   = A system that gets better every day                         │
│     without changing a single weight                            │
└─────────────────────────────────────────────────────────────────┘
```

### 1. Self-Modifying Prompts

The system prompt is the architecture. Modifying the prompt is self-modification.

**Concept:** The LLM maintains its system prompt as a versioned file (`~/.casterly/system-prompt.md`). During dream cycles, it reviews its journal for behavioral patterns -- what worked, what failed, what it keeps having to re-learn -- and proposes edits to its own prompt. Each revision is committed with a journal entry explaining the rationale.

**What the LLM can modify:**
- Workflow guidance ("after modifying more than 2 files, run tests before reporting success")
- Default strategies ("skip planning for single-file edits")
- Tool preferences ("prefer recall_journal over recall for debugging context")
- Context management heuristics ("load full file contents for refactoring tasks")
- Self-correction triggers ("if I'm unsure about a regex, test it before using it")

**What the LLM cannot modify:** The safety boundary, path guards, redaction rules, and security invariants. These are the only immutable layer.

**Version control:** Every prompt revision gets a version number, a journal entry with rationale, and a link to the performance data that motivated it. If performance degrades after a change, the LLM can diff against previous versions during the next dream cycle and revert. The self-knowledge system tracks metrics per prompt version.

**What exists today:**
- The identity prompt (`src/autonomous/identity.ts`) is built dynamically from workspace files and the world model.
- The journal already captures decision patterns and outcomes.
- The self-model tracks performance metrics that can motivate prompt changes.

**Implementation plan:**
1. **Prompt file and loader** -- Create `~/.casterly/system-prompt.md` as the editable prompt source. Modify `buildIdentityPrompt()` to incorporate it alongside the existing workspace files. Version metadata stored in `~/.casterly/prompt-versions.yaml`.
2. **`edit_prompt` tool** -- Agent tool that lets the LLM propose a prompt edit: old text, new text, rationale. The edit is applied, versioned, and journaled. A `revert_prompt` tool rolls back to a specified version.
3. **Performance tracking per version** -- Extend the self-model to tag outcomes with the active prompt version. Dream cycle analysis can then compare success rates across versions.
4. **Dream cycle integration** -- Add a "review prompt effectiveness" phase to dream cycles. The LLM examines recent failures and considers whether a prompt edit would prevent them. This is advisory -- the LLM decides whether to act on it.
5. **Tests** -- Versioning roundtrip (edit, revert, re-edit). Prompt file loading. Safety boundary immutability (attempts to modify protected patterns are rejected).

**Files touched:** `~/.casterly/system-prompt.md` (new runtime file), `~/.casterly/prompt-versions.yaml` (new), `src/autonomous/identity.ts`, `src/autonomous/agent-tools.ts`, `src/autonomous/dream/runner.ts`.

---

### 2. Tool Synthesis

The LLM writes new tools for itself.

**Concept:** When the LLM notices it repeatedly performs the same multi-step operation, it can synthesize a new tool that wraps the workflow. The tool is written in TypeScript, compiled by the system, and registered with the tool runtime. The next cycle, the tool is available.

**Examples of synthesized tools:**
- `check_and_summarize_diff` -- reads git diff, classifies change type, updates world model. Previously required 3 separate tool calls.
- `validate_regex` -- takes a regex pattern and test cases, runs them, returns pass/fail. Previously required the LLM to reason about regex correctness.
- `quick_test` -- runs only the test files related to recently modified source files. Previously required the LLM to identify relevant tests and invoke the test runner manually.

**Safety:** Synthesized tools run inside the same sandbox as all other tools. They cannot bypass path guards, redaction, or command blockers. The `create_tool` meta-tool runs the implementation through the security scanner before registration. Failed tools are logged to the issue tracker with the compilation or security error.

**What exists today:**
- The tool registry (`src/tools/index.ts`) and executor (`src/tools/executor.ts`) support dynamic tool schemas.
- Tool schemas are already defined as structured objects the LLM can read.
- The security scanner (`scripts/guardrails.mjs`) can review tool implementations for dangerous patterns.

**Implementation plan:**
1. **`create_tool` meta-tool** -- Takes name, description, parameter schema (JSON Schema), and TypeScript implementation body. The system wraps it in the standard tool interface, compiles with `esbuild` or `tsx`, and runs the security scanner.
2. **Synthesized tool store** -- Tools saved to `~/.casterly/tools/` as `.ts` files with companion `.schema.json`. Loaded at session start alongside built-in tools.
3. **Tool lifecycle** -- Synthesized tools have usage counters. Tools unused for 30 days get flagged during dream cycles. The LLM can archive or delete them via a `manage_tools` tool.
4. **`list_custom_tools` tool** -- Shows all synthesized tools with usage stats, creation date, and last-used date. Helps the LLM manage its own tool inventory.
5. **Tests** -- Tool creation roundtrip (create, invoke, verify result). Security scanner rejection for dangerous patterns (e.g., `fs.rm`, `process.exit`). Schema validation. Compilation error handling.

**Files touched:** `src/tools/synthesizer.ts` (new), `src/tools/index.ts`, `src/autonomous/agent-tools.ts`, `~/.casterly/tools/` (new runtime directory).

---

### 3. Local Fine-Tuning and LoRA Adapters

The model literally gets better at tasks it encounters, using its own experience as training data.

**Concept:** The journal captures every decision and outcome. That's training data. During dream cycles, the LLM extracts decision-outcome pairs, formats them as training examples, and triggers a LoRA fine-tuning job. The resulting adapter is loaded and evaluated against a benchmark. If it improves performance, it's kept. If not, it's discarded.

**LoRA adapters per skill domain:** Rather than one monolithic fine-tune, maintain separate adapters: `regex.lora`, `refactoring.lora`, `security-review.lora`, `typescript.lora`. The self-model tracks which skills are weak. Dream cycles prioritize generating training data for weak skills. The executive model requests the relevant adapter when it encounters a task in that domain.

**Why this is feasible locally:**
- LoRA adapters are small (tens of MB each). Dozens can coexist in memory alongside the base model.
- Ollama supports adapter loading via model variants.
- Training uses the GPU during idle time (dream cycles run at night).
- 128GB provides ample memory for training + inference on the same hardware.

**Risk mitigation:** Fine-tuning on your own outputs can cause drift or mode collapse. Every adapter is evaluated against a stable benchmark suite before acceptance. The self-model tracks pre- and post-adapter performance. Adapters that degrade performance are logged and discarded. A `max_adapters` limit prevents unbounded growth.

**What exists today:**
- The journal (`src/autonomous/journal.ts`) stores structured entries with outcomes.
- The issue log (`src/autonomous/issue-log.ts`) tracks attempt histories with success/failure.
- The self-model tracks skill-level performance metrics.
- Ollama runs locally with full model management capabilities.

**Implementation plan:**
1. **Training data extractor** -- `src/autonomous/dream/training-extractor.ts`. Scans journal and issue log for decision-outcome pairs. Formats as instruction/completion pairs for supervised fine-tuning, or as preference pairs (chosen/rejected) for DPO. Groups by skill domain using the self-model's skill taxonomy.
2. **Training orchestrator** -- `src/autonomous/dream/lora-trainer.ts`. Wraps `unsloth` or `llama.cpp`'s fine-tuning capabilities. Configurable: rank, alpha, target modules, learning rate, epochs. Runs during dream cycles with a configurable GPU time budget.
3. **Adapter registry** -- `~/.casterly/adapters/` directory with metadata in `adapters.yaml`. Each adapter tracks: skill domain, training data size, creation date, benchmark score, active status.
4. **Benchmark suite** -- `~/.casterly/benchmarks/` containing representative tasks per skill domain with known-good outcomes. The LLM generates benchmark tasks during dream cycles. Adapters are evaluated against these before activation.
5. **`load_adapter` tool** -- Lets the executive model request a specific adapter for the current task. Wraps Ollama's model variant loading.
6. **Tests** -- Training data extraction from mock journal entries. Adapter lifecycle (create, evaluate, activate, deactivate, discard). Benchmark scoring. Graceful degradation when no adapters exist.

**Files touched:** `src/autonomous/dream/training-extractor.ts` (new), `src/autonomous/dream/lora-trainer.ts` (new), `src/autonomous/agent-tools.ts`, `config/autonomous.yaml`, `~/.casterly/adapters/` (new runtime directory), `~/.casterly/benchmarks/` (new runtime directory).

---

### 4. Adversarial Dual-Model Self-Testing

Use the two models against each other to discover and strengthen weaknesses.

**Concept:** During dream cycles, the coding model generates challenges in domains where the self-model reports low confidence. The reasoning model attempts the challenges. Results feed back into the self-model with higher fidelity than real-task tracking (which is sparse and noisy). This creates a training signal from nothing -- the model practices its weaknesses proactively rather than waiting for real tasks to expose them.

**Modes of adversarial testing:**

1. **Challenge generation.** "Self-model says I'm at 40% on regex. Coding model generates 20 regex challenges of increasing difficulty. I attempt them. I pass 14/20. The 6 failures are analyzed: all involve nested lookaheads. Updated self-model: regex-general (70%), regex-lookaheads (15%)."

2. **Adversarial code review.** The coding model writes an implementation with intentional subtle bugs. The reasoning model tries to find them. Missed bugs are logged. Over time, the reasoning model learns what kinds of bugs the coding model tends to introduce, and the coding model learns what the reasoning model tends to miss.

3. **Strategy debate.** Both models propose approaches to a problem. Each critiques the other's approach. The exchange is logged as a learning experience. This builds the LLM's understanding of when each model's strengths are relevant.

**What exists today:**
- `ConcurrentProvider` (`src/providers/concurrent.ts`) can invoke both models on the same prompt.
- The self-model tracks skill-level performance with success rates and sample sizes.
- Dream cycles already have an "exploration" phase that can host adversarial testing.

**Implementation plan:**
1. **Challenge generator** -- `src/autonomous/dream/challenge-generator.ts`. Uses the coding model to generate domain-specific challenges based on self-model weakness data. Challenge types: code completion, bug detection, regex construction, refactoring decisions, security review.
2. **Challenge evaluator** -- `src/autonomous/dream/challenge-evaluator.ts`. Runs the reasoning model against challenges, evaluates results against known answers, and updates the self-model with granular skill data.
3. **Adversarial review mode** -- Extension to the challenge generator where the coding model intentionally writes buggy code and the reasoning model reviews it. Scoring: bugs found / bugs planted.
4. **Self-model granularity** -- Extend `self-model.ts` to support sub-skills (e.g., `regex.lookaheads`, `typescript.generics`, `security.injection`). The adversarial testing reveals which sub-skills are weak.
5. **Dream cycle integration** -- Add adversarial testing as an optional dream phase, configured with a challenge budget (default: 20 challenges per cycle) and domain selection (prioritize weakest skills).
6. **Tests** -- Challenge generation produces valid, solvable problems. Evaluation scoring is correct. Self-model updates reflect challenge outcomes. Budget limits are respected.

**Files touched:** `src/autonomous/dream/challenge-generator.ts` (new), `src/autonomous/dream/challenge-evaluator.ts` (new), `src/autonomous/dream/self-model.ts`, `src/autonomous/dream/runner.ts`, `config/autonomous.yaml`.

---

### 5. Shadow Execution

For every non-trivial task, generate an alternative approach but only execute one. Learn from the comparison.

**Concept:** Before executing a plan, the LLM generates a second approach -- the "shadow." Only the primary plan is executed. After the cycle completes, the shadow is stored alongside the outcome. During dream cycles, the LLM compares executed plans with their shadows: when the executed approach succeeded, was the shadow also viable? When it failed, would the shadow have worked?

**Why this matters for a 120b model:** The model's biggest weakness is judgment -- choosing the right approach on the first try. Shadow execution gives it data on the approaches it *didn't* take. Over time, the LLM learns to recognize which types of problems call for which types of approaches. This calibrates judgment without requiring real failures to learn from.

**What exists today:**
- The agent loop already produces a plan (implicitly, through its ReAct reasoning).
- The journal captures outcomes.
- Dream cycle phase 1 (consolidate reflections) already reviews outcomes.

**Implementation plan:**
1. **`shadow` tool** -- Agent tool that records an alternative approach before execution begins. Takes a structured description: strategy, expected steps, rationale for why the primary approach was chosen over this one.
2. **Shadow storage** -- Shadows stored as companion entries in the journal, linked to the cycle's primary journal entry by cycle ID. Schema: `{ type: 'shadow', cycleId, strategy, steps, rationale }`.
3. **Shadow analysis in dream cycles** -- Extend consolidation phase: for failed cycles, load the shadow and evaluate whether it would have succeeded. For successful cycles, note whether the shadow was a viable alternative. Results feed into a `shadow-analysis.yaml` that tracks which judgment patterns are reliable.
4. **Judgment calibration** -- The shadow analysis produces insights like: "When I chose a single-file approach over a multi-file approach, the single-file approach failed 60% of the time for refactoring tasks." These insights get promoted to the constitution or the system prompt.
5. **Tests** -- Shadow creation and retrieval. Dream cycle shadow analysis with mock data. Journal schema compatibility. Judgment pattern extraction.

**Files touched:** `src/autonomous/agent-tools.ts`, `src/autonomous/journal.ts` (schema extension), `src/autonomous/dream/runner.ts`, `~/.casterly/shadow-analysis.yaml` (new runtime file).

---

### 6. Prompt Genetic Algorithm

Evolve the system prompt through selection pressure.

**Concept:** Maintain a population of system prompt variants. Each variant is tested against a benchmark suite. The best-performing prompts "reproduce" -- combine elements from the strongest variants. Over generations, the system prompt evolves toward optimal performance for the specific model, hardware, and use patterns.

**Why free tokens make this feasible:** Each variant needs to run through a benchmark, meaning dozens of inference calls per generation. Cloud architectures can't afford this. Locally, it's just idle GPU time during dream cycles. A population of 8 variants running 10 benchmark tasks each is 80 inference calls -- trivial when tokens are free.

**What it optimizes for:** Not task correctness (that's binary) but decision quality: turns-to-completion, unnecessary tool calls, errors caught by verification, context management efficiency, judgment accuracy (measured via shadow execution data).

**The meta-insight:** The LLM is evolving its own instructions. It's not just following a prompt -- it's searching for the *best* prompt for its specific capability level. A 120b model might need very different prompt engineering than a 200b model, and the genetic algorithm discovers the right engineering automatically.

**What exists today:**
- The self-modifying prompt mechanism (above) provides the substrate -- versioned prompts with performance tracking.
- The benchmark suite (from LoRA adapters) provides the fitness function.
- Dream cycles provide the execution window.

**Implementation plan:**
1. **Prompt population** -- `~/.casterly/prompt-evolution/` directory containing N prompt variants (default: 8). Each variant is a full `system-prompt.md` with metadata: generation number, parent variants, fitness scores.
2. **Mutation operators** -- `src/autonomous/dream/prompt-evolution.ts`. Operators: reorder rules, adjust thresholds, add/remove guidance, merge rules, split compound rules. The LLM generates mutations via a meta-prompt ("Given this system prompt and these recent failures, suggest 3 small modifications").
3. **Crossover** -- Combine sections from two high-performing variants. Section boundaries are defined by markdown headers. Crossover preserves the safety-critical sections unchanged.
4. **Fitness evaluation** -- Run each variant against the benchmark suite. Score on: turns-to-completion, tool call efficiency, error rate, verification effectiveness. Fitness is a weighted sum.
5. **Selection and reproduction** -- Top 4 variants produce the next generation through crossover and mutation. The current active prompt is always included as an "elite" to prevent regression.
6. **Generational logging** -- Each generation is logged with variant scores, selected parents, and mutations applied. Enables rollback to any previous generation.
7. **Tests** -- Mutation produces valid prompts. Crossover preserves safety sections. Fitness evaluation runs against mock benchmark. Selection preserves elite. Population size stays bounded.

**Files touched:** `src/autonomous/dream/prompt-evolution.ts` (new), `src/autonomous/dream/runner.ts`, `config/autonomous.yaml`, `~/.casterly/prompt-evolution/` (new runtime directory).

---

### 7. Memory Crystallization

Promote high-value learned knowledge to permanent, always-available context.

**Concept:** Not all memory is equal. Some things the LLM learns are universally true and always useful. These should be "crystallized" -- promoted from the warm/cool tiers to a permanent `crystals.yaml` that is always loaded into the hot tier. Crystals are cached conclusions the LLM doesn't have to re-derive from the journal.

**Examples of crystals:**
- "The user prefers functional patterns over class hierarchies."
- "Tests in this repo use Vitest with the `vi.fn()` mock pattern."
- "The provider interface is stable -- changes require updating 4+ consumers."
- "I perform better on refactoring tasks when I read the full file before planning."
- "The iMessage daemon polls every 2 seconds; don't schedule triggers faster than that."

**Crystal lifecycle:**
- **Formation:** During dream cycles, the LLM reviews warm and cool memory for entries that have been recalled more than N times, are referenced across multiple successful completions, or represent stable facts about the codebase/user/environment.
- **Validation:** A candidate crystal is tested against recent experience. Does it still hold? Has anything contradicted it?
- **Invalidation:** If a crystal contradicts a recent experience, it gets flagged for review. The LLM decides whether to update or dissolve it during the next dream cycle.
- **Budget:** Crystals share the hot tier token budget. A `max_crystals` limit (default: 30) prevents the hot tier from being consumed by crystallized knowledge. The LLM prioritizes the most impactful crystals.

**What exists today:**
- The context manager (`src/autonomous/context-manager.ts`) manages the 4-tier hierarchy with the hot tier rebuilt every cycle.
- The `recall` tool already surfaces high-recall entries.
- The identity prompt builder (`src/autonomous/identity.ts`) loads workspace files into the hot tier.

**Implementation plan:**
1. **Crystal store** -- `~/.casterly/crystals.yaml`. Schema: `{ content, source_entries[], formed_date, last_validated, recall_count, confidence }`. Loaded into the hot tier by `buildIdentityPrompt()`.
2. **`crystallize` tool** -- Agent tool that promotes an insight to a crystal. Takes content, source evidence, and confidence. Checks against `max_crystals` limit.
3. **`dissolve` tool** -- Removes or updates a crystal. Logs the dissolution reason to the journal.
4. **Dream cycle integration** -- Add a crystallization phase: review warm/cool tiers for high-recall entries, propose new crystals, validate existing ones against recent experience.
5. **Hot tier budgeting** -- Add a `crystals_budget` to the context manager config (default: 500 tokens). Crystals are loaded after identity files but before the world model summary.
6. **Tests** -- Crystal creation and loading. Budget enforcement. Validation against mock recent experience. Dissolution logging. Hot tier integration.

**Files touched:** `~/.casterly/crystals.yaml` (new runtime file), `src/autonomous/identity.ts`, `src/autonomous/agent-tools.ts`, `src/autonomous/dream/runner.ts`, `src/autonomous/context-manager.ts`, `config/autonomous.yaml`.

---

### 8. Constitutional Self-Governance

The LLM writes its own operational rules, versioned and decayable.

**Concept:** A `constitution.yaml` file stores rules the LLM has authored about its own behavior. Not safety rules (those are immutable in the safety boundary), but tactical operational rules discovered through experience. Rules are versioned, timestamped, linked to the journal entries that motivated them, and have confidence scores that decay or strengthen based on outcomes.

**Example rules:**
```yaml
- rule: "For tasks touching 3+ files, generate a plan before starting."
  added: 2026-02-15
  motivation: "journal#2847: skipped planning on a 5-file refactor, introduced a circular dependency"
  confidence: 0.85
  invocations: 12
  successes: 10

- rule: "When the coding model returns TypeScript with `any` type, flag for review."
  added: 2026-02-18
  motivation: "journal#3012: accepted code with `any` that later caused a runtime error"
  confidence: 0.92
  invocations: 8
  successes: 8

- rule: "Prefer recall_journal over recall for debugging-related context."
  added: 2026-02-19
  motivation: "journal#3098: recall returned stale memory notes, journal had the actual fix"
  confidence: 0.7
  invocations: 5
  successes: 3
```

**Rule lifecycle:**
- **Creation:** The LLM observes a pattern (usually a failure) and creates a rule via the `create_rule` tool, with a journal reference.
- **Strengthening:** When following a rule leads to success, confidence increases.
- **Decay:** When the LLM violates a rule and succeeds anyway, confidence decreases. Rules below a threshold (default: 0.3) are pruned during dream cycles.
- **Evolution:** Rules can be refined. "Plan for 3+ file changes" might evolve to "plan for 3+ file changes in different modules, but not for 3 files in the same module."

**Difference from self-modifying prompts:** The prompt describes *how to think* (strategy, workflow, heuristics). The constitution describes *what to do and not do* (concrete rules with evidence). The prompt is strategic and philosophical. The constitution is tactical and empirical.

**What exists today:**
- The journal captures the failure patterns that motivate rules.
- The self-model tracks skill-level performance.
- Dream cycles already consolidate reflections.

**Implementation plan:**
1. **Constitution store** -- `~/.casterly/constitution.yaml`. Schema per rule: `{ rule, added, motivation, confidence, invocations, successes }`. Loaded into the hot tier after crystals.
2. **`create_rule` tool** -- Agent tool to add a new rule. Requires: rule text, journal reference, initial confidence.
3. **`update_rule` tool** -- Modify rule text or adjust confidence manually. Logs the change.
4. **Rule evaluation** -- After each cycle, the LLM (or dream cycle) checks which rules were relevant, whether they were followed, and whether the outcome was positive. Updates confidence scores accordingly.
5. **Dream cycle pruning** -- Remove rules below confidence threshold. Log pruned rules to the journal with the reason.
6. **Hot tier integration** -- Constitution loaded into the identity prompt. Budget: shared with crystals under a `self_knowledge_budget` allocation.
7. **Tests** -- Rule creation, confidence update, pruning. Constitution loading into identity prompt. Budget enforcement. Rule evolution (modification preserves history).

**Files touched:** `~/.casterly/constitution.yaml` (new runtime file), `src/autonomous/identity.ts`, `src/autonomous/agent-tools.ts`, `src/autonomous/dream/runner.ts`, `config/autonomous.yaml`.

---

### 9. Self-Debugging Replay

Re-examine past execution traces step-by-step to identify failure patterns.

**Concept:** Every agent cycle's tool calls, results, and reasoning are logged via the debug tracer. The `replay` tool lets the LLM load a past cycle and walk through it step-by-step, seeing exactly what it did, what each tool returned, and where things went wrong. This is qualitatively different from reading the journal -- the journal captures high-level reflections, while replay captures the actual execution trace.

**Use cases:**
- **Post-mortem analysis.** "Replay the last 5 failed cycles. For each, identify the decision point where the failure originated. Write a constitutional rule to prevent that class of failure."
- **Strategy comparison.** "Replay my last two refactoring tasks. Compare the tool call sequences. Identify which patterns led to success."
- **Context debugging.** "Replay cycle #3847. What was in my context at the point where I made the wrong tool call? Did I have the information I needed?"

**What exists today:**
- The debug tracer (`src/debug/`) logs detailed execution traces.
- The journal captures cycle-level outcomes.
- Agent tools already provide structured access to state stores.

**Implementation plan:**
1. **Trace indexing** -- Ensure debug traces are indexed by cycle ID and searchable by date range, outcome (success/failure), and tool types used. Store index in `~/.casterly/traces/index.yaml`.
2. **`replay` tool** -- Agent tool that loads a past cycle's trace and presents it as a structured sequence: `[{ step, tool_called, parameters, result, reasoning, timestamp }]`. Supports filtering by step range or tool type.
3. **`compare_traces` tool** -- Takes two cycle IDs and produces a side-by-side diff of the execution strategies. Highlights divergence points.
4. **Dream cycle integration** -- Add a "failure replay" phase: automatically replay the N most recent failed cycles, identify common failure patterns, and propose constitutional rules or prompt edits.
5. **Trace retention policy** -- Successful traces retained for 7 days (configurable). Failed traces retained for 30 days. Traces referenced by constitutional rules or crystals retained indefinitely.
6. **Tests** -- Trace indexing and retrieval. Replay formatting. Comparison diff generation. Retention policy enforcement.

**Files touched:** `src/autonomous/agent-tools.ts`, `src/debug/` (trace indexing), `src/autonomous/dream/runner.ts`, `~/.casterly/traces/index.yaml` (new runtime file), `config/autonomous.yaml`.

---

### Self-Improvement Summary

| Mechanism | What Gets Modified | Feedback Loop | Dream Cycle Phase |
|-----------|-------------------|---------------|-------------------|
| Self-modifying prompts | How the LLM thinks | Journal → analysis → prompt edit → next session | Review prompt effectiveness |
| Tool synthesis | What the LLM can do | Repeated pattern → new tool → faster execution | Tool inventory review |
| LoRA fine-tuning | The LLM's weights | Journal → training data → adapter → evaluation | Training data extraction |
| Adversarial self-testing | The LLM's self-awareness | Challenge → attempt → granular skill update | Adversarial challenge phase |
| Shadow execution | The LLM's judgment | Shadow comparison → insight → better choices | Shadow analysis |
| Prompt genetic algorithm | The LLM's instructions | Population → benchmark → selection → evolution | Prompt evolution generation |
| Memory crystallization | What the LLM knows | High-recall entries → permanent context | Crystallization review |
| Constitutional self-governance | What the LLM rules | Outcome tracking → rule creation/decay | Rule pruning and creation |
| Self-debugging replay | The LLM's self-understanding | Trace replay → failure analysis → targeted fix | Failure replay |

### Implementation Priority

These mechanisms are ordered by risk and dependency. Earlier mechanisms create the substrate that later mechanisms build on.

**Tier 1 -- Low risk, high immediate value, minimal dependencies:**
1. Memory crystallization -- directly addresses context quality, the most impactful lever for a local model
2. Constitutional self-governance -- lightweight, additive, instantly useful
3. Self-debugging replay -- read-only analysis, no mutation risk

**Tier 2 -- Moderate complexity, requires Tier 1 insights to be most effective:**
4. Self-modifying prompts -- builds on constitutional rules and crystals as evidence for what to change
5. Shadow execution -- lightweight to implement, but most valuable once the constitution and crystals provide a framework for interpreting shadows
6. Tool synthesis -- requires stable tool runtime and good self-awareness of repetitive patterns

**Tier 3 -- High complexity, high ceiling, requires Tier 1-2 as training signal:**
7. Adversarial dual-model self-testing -- requires granular self-model (from Tier 1-2) to know what to test
8. Prompt genetic algorithm -- requires benchmarks (from adversarial testing) as the fitness function
9. LoRA fine-tuning -- highest ceiling but most complex; needs substantial journal data and the benchmark infrastructure from earlier tiers

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
