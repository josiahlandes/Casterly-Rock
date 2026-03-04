# Casterly Roadmap

## How to Use This Document

This is the living implementation roadmap for Casterly. Items are ordered by implementation priority — each tier builds on the previous.

**When implementing a feature from this list:**
1. Move it from `[ ]` to `[x]` and add the implementation date
2. Add the source file paths under the item
3. Note any follow-up improvements discovered during implementation
4. Run `ALLOW_PROTECTED_CHANGES=1 npm run check` to verify all quality gates pass

**Status key:**
- `[ ]` — Not started
- `[~]` — In progress
- `[x]` — Implemented (date noted)

---

## Tier 1: Immediate Wins (hours to days)

Low-effort, high-impact changes that improve performance or reliability with minimal risk.

### 1. [x] Cross-File API Validation (2026-03-01)

**What:** Static analysis that catches cross-file method/property mismatches before runtime. When the DeepLoop generates multi-file workspaces, programmatically validate that every `obj.method()` call on an imported binding actually exists in the source module. Auto-inject fix steps when mismatches are found.

**Why:** Attempt 7 of Neon Invaders generated all 14 files correctly but crashed on frame 1 due to 9 missing methods and 9 config property name mismatches. The model reads files in review but doesn't notice cross-file API inconsistencies.

**Impact:** Eliminates the #1 cause of generated code failures — API surface mismatches between files.

**Source files:**
- `src/dual-loop/deep-loop.ts` — `extractImportBindings()`, `extractMemberAccesses()`, `extractAPISurface()`, `extractObjectPropertyNames()`, `crossValidateAPIs()`
- `tests/dual-loop-api-validation.test.ts` — 30 tests

**References:**
- Plan: `~/.claude/plans/typed-shimmying-goose.md`

---

### 2. [x] KV Cache Quantization (2026-03-02)

**What:** Set `OLLAMA_KV_CACHE_TYPE=q8_0` in the Ollama environment. This quantizes the key-value cache from FP16 to Q8, reducing KV cache memory by ~50% with negligible quality loss.

**Why:** The 122B model at 128K context consumes massive KV cache memory. Quantizing it frees memory for longer contexts or concurrent models without changing inference quality. Ollama v0.5+ supports this natively.

**Impact:** ~50% KV cache memory reduction. Effectively free — a single environment variable.

**Source files:**
- `scripts/tyrion-daemon.sh` — exports `OLLAMA_KV_CACHE_TYPE=q8_0` before daemon launch
- `scripts/setup-mac.sh` — adds export to user's shell config (Step 10)
- `config/models.yaml` — documents the setting under `ollama.kv_cache_type`

**References:**
- Ollama docs: KV cache quantization (v0.5+)
- Research: KVQuant (Hooper et al., 2024) — 10× KV compression with <0.1 perplexity degradation

---

### 3. [x] Structured Output for Routing (2026-03-02)

**What:** Add Ollama `format` parameter support for JSON Schema constraints. FastLoop triage and code review calls now pass a JSON schema that guarantees valid, schema-conformant output — no parsing failures.

**Why:** The FastLoop triage and review parsers used fragile JSON extraction from free-form text. Structured output eliminates an entire class of failures where the model produces valid reasoning but malformed output.

**Impact:** Eliminates triage/review parse failures. Reduces unnecessary escalations. More reliable with smaller models.

**Source files:**
- `src/providers/ollama.ts` — `format` field extracted from `providerOptions` and passed as top-level Ollama request field
- `src/dual-loop/triage-prompt.ts` — `TRIAGE_FORMAT_SCHEMA` JSON schema for triage responses
- `src/dual-loop/review-prompt.ts` — `REVIEW_FORMAT_SCHEMA` JSON schema for review responses
- `src/dual-loop/fast-loop.ts` — passes format schemas in triage and review calls; `callWithTier` now accepts `providerOptions`
- `tests/structured-output.test.ts` — 10 tests for schemas and parsing

**References:**
- Ollama v0.5+ structured output: `format` parameter accepts JSON Schema
- Research: Guidance (Microsoft) — constrained decoding maintains reasoning quality while guaranteeing format

---

### 4. [x] Context Pressure as Proactive Feature (2026-03-02)

**What:** Extended context pressure logging into a three-threshold proactive system. At 70% context usage, injects a budget warning so the model self-manages. At 85%, auto-compresses the prompt by removing middle sections. At 80%, logs for dream cycle analysis.

**Why:** Context pressure was logged but not acted upon. The model didn't know it was running out of context until hitting the wall. Proactive pressure management prevents context overflow failures.

**Impact:** Eliminates context overflow crashes. Improves long-task reliability. Model self-manages context when warned.

**Source files:**
- `src/dual-loop/context-tiers.ts` — `DeepTierConfig` extended with `contextPressureSoftThreshold` (0.70) and `contextPressureActionThreshold` (0.85); new functions `checkContextPressure()`, `buildPressureWarning()`, `compressPrompt()`
- `src/dual-loop/deep-loop.ts` — `callWithTier()` now runs the full pressure pipeline: compress → warn → log
- `src/dual-loop/coordinator.ts` — default config updated with new thresholds
- `config/autonomous.yaml` — three threshold values under `context_tiers.deep`
- `tests/dual-loop-context-tiers.test.ts` — 20 new tests for pressure checking, warning, and compression

**References:**
- Existing: `src/dual-loop/deep-loop.ts` context pressure logging (PR #33)
- Research: LongWriter (Bai et al., 2024) — context management strategies for long-form generation

---

## Tier 2: Architecture-Level Gains (days to weeks)

Meaningful architectural changes that unlock new capability dimensions.

### 5. [x] MLX Backend for DeepLoop (2026-03-02)

**What:** Add MLX (Apple's ML framework) as an inference backend alongside Ollama, accessed via `vllm-mlx` (OpenAI-compatible server). MLX runs natively on Apple Silicon's unified memory with Metal acceleration, achieving 50-87% faster inference than Ollama for large models.

**Why:** Ollama uses llama.cpp which, while excellent, doesn't fully exploit Apple Silicon's unified memory architecture. MLX is purpose-built for it. The `vllm-mlx` project provides an OpenAI-compatible API server with continuous batching, making it a drop-in replacement.

**Impact:** 50-87% inference speedup for the 122B model. Faster inference = more self-correction loops = higher effective capability.

**Source files:**
- `src/providers/mlx.ts` — `MlxProvider` implementing `LlmProvider` interface via OpenAI-compatible API
- `src/providers/index.ts` — exports `MlxProvider` and `MlxProviderOptions`
- `scripts/mlx-server.sh` — launch script for vllm-mlx server (start/stop/status/logs)
- `src/imessage/daemon.ts` — MLX provider selection via `CASTERLY_DEEP_PROVIDER=mlx` env var
- `config/models.yaml` — MLX configuration section (model, endpoint, timeout)
- `tests/mlx-provider.test.ts` — 20 tests (generation, tool calling, error handling, multi-turn)

**Activation:** Set `CASTERLY_DEEP_PROVIDER=mlx` before starting the daemon. Launch vllm-mlx first with `./scripts/mlx-server.sh start`.

**References:**
- MLX framework: https://github.com/ml-explore/mlx
- vllm-mlx: OpenAI-compatible MLX inference server with continuous batching
- Benchmarks: MLX vs llama.cpp on M4 Max — 50-87% speedup for large dense models

---

### 6. [x] Speculative Decoding on MLX (2026-03-02)

**What:** Use speculative decoding where a small draft model (e.g., Qwen 0.5B) generates candidate tokens and the large model verifies them in a single forward pass. This achieves 1.5-2× speedup with *zero quality loss* — the output distribution is mathematically identical.

**Why:** The 122B model is slow. Speculative decoding accelerates it by leveraging the fact that most tokens are "easy" — a tiny model can predict them correctly, and the large model only needs to verify. MLX supports this natively.

**Impact:** 1.5-2× additional speedup on top of MLX, with zero quality regression.

**Source files:**
- `scripts/mlx-server.sh` — `--spec` flag enables speculative decoding with configurable draft model and lookahead depth
- `config/models.yaml` — speculative decoding configuration under `mlx.speculative_decoding` (draft model, num_speculative_tokens)

**Activation:** Launch with `./scripts/mlx-server.sh start --spec`. Configure draft model via `MLX_DRAFT_MODEL` env var.

**References:**
- Research: Leviathan et al. (2023) — "Fast Inference from Transformers via Speculative Decoding"
- MLX speculative decoding: native support in mlx-lm
- Typical acceptance rates: 70-85% for well-matched draft/target pairs

---

### 7. [x] Verification Cascade (Multi-Agent Quality) (2026-03-02)

**What:** For high-stakes outputs (code generation, multi-file changes), run a verification cascade: DeepLoop generates → FastLoop reviews (correctness) → FastLoop re-reviews (security) → done. Each pass uses a different focus prompt. Tasks with 3+ files or 3+ plan steps automatically get 2 review passes.

**Why:** Single-pass generation with a single verifier misses subtle bugs. Multi-pass verification with different focuses (correctness vs. security/robustness) catches more issues, because each pass looks for different types of problems.

**Impact:** Higher code quality for complex tasks. Security review catches vulnerabilities that correctness review misses.

**Source files:**
- `src/dual-loop/task-board-types.ts` — `verificationPasses` and `currentVerificationPass` fields on `Task` and `UpdateTaskFields`
- `src/dual-loop/review-prompt.ts` — `CASCADE_REVIEW_PROMPTS` array with security-focused review prompt
- `src/dual-loop/fast-loop.ts` — cascade logic in `reviewTask()`: selects prompt per pass, advances cascade on approval, resets to pass 0 on revision
- `src/dual-loop/deep-loop.ts` — sets `verificationPasses: 2` for high-stakes tasks (3+ files or 3+ plan steps); resets `currentVerificationPass: 0` on revision resubmit
- `config/autonomous.yaml` — `verification_cascade` config under `dual_loop`
- `tests/verification-cascade.test.ts` — 19 tests (prompt selection, cascade logic, reset behavior, high-stakes detection)

**References:**
- Research: Multi-agent debate (Du et al., 2023) — independent review catches errors self-review misses
- Existing: `ConcurrentProvider` already supports parallel multi-model inference
- Existing: Adversarial self-testing dream cycle validates the dual-model review pattern

---

## Tier 3: Self-Improvement Loop (weeks)

Mechanisms that make the system improve itself over time. High ceiling, high effort.

### 8. [x] LoRA Fine-Tuning FastLoop for Tool Calling (2026-03-02)

**What:** Fine-tune the FastLoop model (35B-A3B) on Casterly's own tool-calling patterns using QLoRA on Apple Silicon via `mlx-lm`. Training data extracted from the journal — successful tool call sequences become instruction/completion pairs.

**Why:** The FastLoop handles triage and lightweight tasks but sometimes makes suboptimal tool choices. Fine-tuning on actual usage patterns teaches it the specific tool vocabulary, parameter formats, and calling conventions that work in this system.

**Impact:** Better tool-call accuracy for the FastLoop model. Faster triage. Fewer escalations to DeepLoop.

**Source files:**
- `src/autonomous/dream/mlx-lora-trainer.ts` — `MlxLoraTrainer` class wrapping `mlx-lm` CLI for QLoRA training; SFT/DPO formatting, train/valid/test split (80/10/10), loss parsing, adapter archival
- `src/autonomous/dream/training-extractor.ts` — added `extractToolCallPairs()` for tool-call-specific training data extraction
- `src/autonomous/dream/lora-trainer.ts` — added `category` field to `LoraAdapter` interface
- `src/autonomous/dream/runner.ts` — Phase 8d (LoRA adapter training) and Phase 8e (SPIN self-play) in dream cycle
- `src/autonomous/loop.ts` — wired `MlxLoraTrainer` into main loop lifecycle (load/save/dream)
- `config/autonomous.yaml` — `mlx_training` config section (base_model, mlx_lm_binary, training time/example limits)
- `tests/mlx-lora-trainer.test.ts` — 11 tests (SFT/DPO formatting, data split, loss parsing, availability check)

**References:**
- mlx-lm: Native LoRA/QLoRA on Apple Silicon
- Research: QLoRA (Dettmers et al., 2023) — 4-bit quantized training, minimal memory overhead
- Existing: `src/autonomous/dream/lora-trainer.ts` (training orchestrator, implemented)
- Existing: `src/autonomous/dream/training-extractor.ts` (data extraction, implemented)

---

### 9. [x] Disentangled LoRA Adapters (2026-03-02)

**What:** Train separate LoRA adapters for reasoning vs. tool-calling rather than one monolithic adapter. Research (2026) shows that reasoning and tool-use training objectives create gradient conflicts — improving one degrades the other. Disentangled adapters eliminate the conflict.

**Why:** A single adapter that improves tool-calling may subtly degrade reasoning quality, and vice versa. Separate adapters let each capability improve independently, and the system can load the appropriate adapter based on the current task phase (reasoning during planning, tool-calling during execution).

**Impact:** Independent improvement of reasoning and tool-use capabilities without tradeoffs.

**Source files:**
- `src/autonomous/dream/adapter-manager.ts` — `AdapterManager` class managing disentangled adapter selection; maps task phases to categories (triage/planning/review → reasoning, execution/revision → tools); classifies training examples via regex; `splitByCategory()` for separate training
- `src/autonomous/loop.ts` — wired `AdapterManager` into main loop lifecycle (load/save/state)
- `config/autonomous.yaml` — `disentangled_adapters` config section (enabled, registry_path)
- `tests/adapter-manager.test.ts` — 27 tests (phase mapping, classification, split, registration, selection, summary)

**References:**
- Research: Gradient conflict in multi-task LoRA (2026) — reasoning vs. tool-use interference
- Research: LoRA composition — multiple adapters loaded simultaneously with weighted merging
- Existing adapter registry: `~/.casterly/adapters/` with metadata in `adapters.yaml`

---

### 10. [x] SPIN Self-Play for Self-Improvement (2026-03-02)

**What:** Implement Self-Play Fine-Tuning (SPIN) where the model plays against its previous iteration. The current model generates responses, and DPO loss trains it to prefer its responses over the previous version's. The model improves without requiring new human-labeled data.

**Why:** Traditional fine-tuning needs curated training data. SPIN creates training signal from nothing — the model's own improvement trajectory becomes the curriculum. Each iteration produces a slightly better model, and the process can run indefinitely during dream cycles.

**Impact:** Continuous self-improvement loop. The model gets better at Casterly-specific tasks over time without manual data curation.

**Source files:**
- `src/autonomous/dream/spin-trainer.ts` — `SpinTrainer` class implementing SPIN self-play; builds DPO pairs from response comparisons (current=chosen, previous=rejected); Wilcoxon signed-rank test (one-tailed, with tie correction and continuity correction) for statistical significance; iteration tracking with cycle caps
- `src/autonomous/dream/runner.ts` — Phase 8e (SPIN self-play eligibility check and iteration tracking)
- `src/autonomous/loop.ts` — wired `SpinTrainer` into main loop lifecycle (load/save/dream)
- `config/autonomous.yaml` — `spin` config section (max_iterations, min_benchmarks, significance_threshold, DPO params)
- `tests/spin-trainer.test.ts` — 27 tests (eligibility, DPO pairs, Wilcoxon test, significance, iteration tracking, cycle reset)

**References:**
- Research: SPIN (Chen et al., 2024) — "Self-Play Fine-Tuning Converts Weak Language Models to Strong Language Models"
- Research: DPO (Rafailov et al., 2023) — Direct Preference Optimization as alternative to RLHF
- Existing: DPO training pair extraction already in `training-extractor.ts`

---

## Tier 4: Frontier Exploration (high effort, high reward)

Experimental capabilities that push the boundaries of what's possible with local inference.

### 11. [ ] NPU/ANE Offloading for Embeddings and Classification

**What:** Offload lightweight inference tasks (text embeddings, classification, sentiment analysis) to Apple's Neural Engine (ANE/NPU), which delivers 19 TFLOPS at only 2.8W. This frees the GPU entirely for the main inference models.

**Why:** Embedding generation and classification currently compete with the main models for GPU compute. The ANE is purpose-built for these smaller models and runs them at negligible power cost. This is "free" compute that's currently unused.

**Impact:** Zero-cost embeddings and classification. GPU fully dedicated to main inference.

**Implementation:**
1. Convert embedding model (nomic-embed-text) to CoreML format with ANE target
2. Create `src/providers/ane.ts` wrapping CoreML inference via Swift bridge or `coremltools`
3. Route embedding requests to ANE, keep main inference on GPU
4. Benchmark: compare embedding latency and throughput on ANE vs GPU
5. Extend to classification tasks if ANE embedding quality matches GPU

**References:**
- Apple Neural Engine: 19 TFLOPS, hardware-accelerated matrix multiply
- coremltools: Python toolkit for converting models to CoreML/ANE format
- Research: ANE performance characteristics — best for small models (<1B), batch inference

---

### 12. [~] KVSplit K8V4 for MLX Inference (config layer: 2026-03-03)

**What:** Use mixed-precision KV cache where keys are stored at 8-bit and values at 4-bit precision (K8V4). Research shows this asymmetric quantization achieves 59% cache memory reduction with minimal quality loss — keys are more sensitive to quantization than values.

**Why:** At 128K context, the KV cache for a 122B model is enormous. K8V4 reduces it by 59%, enabling longer effective contexts or freeing memory for other purposes. This is more aggressive than Q8 quantization (Tier 1 item 2) but also higher reward.

**Impact:** 59% KV cache reduction. Enables longer contexts or lower memory pressure.

**Status: Configuration layer complete.** All code is wired end-to-end from env vars → server script → provider. Activation is a single flag flip (`MLX_KV_SERVER_SUPPORT=1`) when vllm-mlx adds `--kv-bits` support (tracking: mlx-lm Issue #615).

**Source files:**
- `src/providers/mlx-kv-cache.ts` — Types (`KvBits`, `KvGroupSize`, `KvCachePreset`, `MlxKvCacheConfig`), validation, preset resolution (none/q8/q4/k8v4), memory estimation with known model params, env var bridge (build/parse), human-readable summary
- `src/providers/mlx.ts` — `MlxProviderOptions.kvCache`, `kvBits` getter, `kvCacheSummary()` method
- `src/providers/mlx-health.ts` — `EnsureMlxServerOptions.startEnv` for passing KV cache env vars to server start script
- `src/providers/index.ts` — Re-exports all KV cache types and functions
- `scripts/mlx-server.sh` — `MLX_KV_KEY_BITS`, `MLX_KV_VALUE_BITS`, `MLX_KV_GROUP_SIZE`, `MLX_KV_QUANTIZED_START`, `MLX_KV_SERVER_SUPPORT` env vars; validation; conditional flag injection when server support is enabled; status display
- `config/models.yaml` — `mlx.kv_cache` section with K8V4 preset configuration
- `src/imessage/daemon.ts` — Reads KV cache config from env, passes to server start and provider construction
- `tests/mlx-kv-cache.test.ts` — 50 tests (defaults, validation, preset resolution, memory estimation, env var round-trip, summary formatting, provider integration)

**Implementation:**
1. ~~Requires MLX backend (Tier 2 item 5) as prerequisite~~ ✅
2. ~~Implement K8V4 quantization in MLX inference config~~ ✅ (config layer; server activation pending)
3. Benchmark carefully: run quality evaluation suite at multiple context lengths — **requires local Apple Silicon**
4. Compare against Q8 (Tier 1) and FP16 baselines — **requires local Apple Silicon**
5. Document quality/memory tradeoff curves — **requires benchmark data**

**Remaining (requires local machine):**
- Flip `MLX_KV_SERVER_SUPPORT=1` when vllm-mlx adds `--kv-bits` (Issue #615)
- Run benchmarks: perplexity at 4K/16K/64K/128K context for FP16 vs Q8 vs K8V4
- Validate flag names match vllm-mlx's actual CLI (expected: `--kv-bits`, `--kv-group-size`)
- Measure real memory savings with `mlx.core.metal.get_active_memory()`

**References:**
- Research: KVQuant (Hooper et al., 2024) — asymmetric key/value quantization
- Research: KIVI (Liu et al., 2024) — K8V4 specifically, 59% reduction with <0.1 perplexity degradation
- MLX quantization support: `mlx.core.quantize` with 2/3/4/5/6/8-bit, group sizes 32/64/128
- Tracking: [mlx-lm Issue #615](https://github.com/ml-explore/mlx-lm/issues/615) — server-side KV cache params

---

### 13. [ ] Test-Time Compute Scaling

**What:** Dynamically allocate compute budget based on task difficulty. Easy tasks get a single fast pass. Hard tasks get extended reasoning chains, multiple attempts, and verification cascades. The model itself estimates difficulty and requests the appropriate compute budget.

**Why:** Not all tasks need the same amount of thinking. Spending 30 seconds on "what time is it" wastes resources. Spending 3 seconds on "refactor this authentication system" wastes capability. Adaptive compute allocation matches effort to difficulty.

**Impact:** Faster responses for easy tasks. Better results for hard tasks. Optimal resource utilization.

**Implementation:**
1. Add difficulty estimation to the classification step (or let the model self-assess)
2. Map difficulty levels to compute budgets: turn limits, verification depth, retry count
3. Integrate with existing `ReasoningScaler` (`src/autonomous/reasoning/scaling.ts`)
4. Track difficulty estimates vs. actual outcomes in the journal for calibration
5. Dream cycle phase to recalibrate difficulty thresholds from historical data

**References:**
- Research: "Let Me Think" (2024) — test-time compute scaling for language models
- Research: Scaling LLM Test-Time Compute (Snell et al., 2024) — adaptive compute improves on fixed budgets
- Existing: `ReasoningScaler` maps difficulty to strategy but doesn't dynamically adjust

---

## Tier 5: Context & Loop Improvements (derived from Qwen Code study)

Patterns extracted from the [Qwen Code](https://github.com/QwenLM/qwen-code) codebase study (`docs/qwen-code-vs-deeploop.md`). These address real failure modes observed during Neon Invaders testing and long autonomous cycles.

### 14. [ ] Step-Scoped Context for Multi-File Plans

**What:** Change the planner to output a `context` field per step containing only the spec sections relevant to that step. `executeStep` uses `step.context` instead of the full `task.originalMessage`, so the coder model only sees what it needs for the current chunk of work.

**Why:** During Neon Invaders (attempt 7), the model created all 14 files in step 1 despite the plan having 6 steps. The root cause: every step receives the full 176-line spec via `task.originalMessage` (line 846 of `deep-loop.ts`). The model reads the full spec, sees all files described, and builds everything it can see — ignoring the step boundary instruction.

This mirrors how humans work with coding agents: you describe one chunk of work with focused context, the agent does it, then you describe the next chunk. The planner becomes the "project manager" who reads the full spec once and writes focused work tickets.

**Impact:** Eliminates the #1 multi-step execution failure — models running ahead of the plan. Each step becomes a self-contained work unit with naturally bounded scope.

**Implementation:**
1. Add `context?: string` field to `PlanStep` in `src/dual-loop/task-board-types.ts`
2. Update `PLANNING_SYSTEM_PROMPT` to require step-scoped context: "For each step, include a `context` field with ONLY the spec sections the coder needs. Do not repeat the full specification."
3. Update `executeStep` (line 845-854) to use `step.context` instead of `task.originalMessage`. Include only a one-line task overview (e.g., "Build Neon Invaders — vanilla JS, HTML5 Canvas, ES modules")
4. Keep upcoming steps as titles only (no detail) — awareness without temptation
5. Re-run Neon Invaders test to validate step isolation

**References:**
- Neon Invaders attempt 7: 14 files generated, crashed due to 9 missing methods + 9 config mismatches
- Current code: `src/dual-loop/deep-loop.ts` lines 812-881 (`executeStep`)
- Qwen Code comparison: `docs/qwen-code-vs-deeploop.md` §3.2

---

### 15. [ ] Warm-Tier Compression Before Eviction

**What:** Add a compression step before warm-tier LRU eviction. Instead of silently dropping the oldest entries, summarize them into a structured XML `<state_snapshot>` via a fast-model call, then replace N evicted entries with 1 summary entry.

**Why:** In long coding loops (20+ turns), warm-tier LRU eviction discards tool results without summarization. The model loses grep results, test output, and architecture decisions from earlier turns, then wastes turns re-reading files and re-running searches. Qwen Code's `ChatCompressionService` solves this by summarizing older history into structured snapshots at 70% context usage, keeping recent turns verbatim.

**Impact:** Preserves semantic content during long cycles. Model retains *why* it made decisions and *what* it already checked, even after context pressure triggers eviction.

**Implementation:**
1. Add `compressWarmTier()` to `src/autonomous/context-manager.ts`
2. Before evicting entries, call the fast model (35B) to compress the N oldest warm-tier entries into a structured summary
3. Use XML `<state_snapshot>` format with fields: `files_read`, `searches_performed`, `decisions_made`, `test_results`, `key_findings`
4. Replace N entries with 1 summary entry in the warm tier
5. Trigger at 70% warm-tier capacity (before the existing 85% action threshold)
6. A single failed compression disables auto-compression for the session (Qwen Code's safety valve)

**References:**
- Qwen Code: `ChatCompressionService` — split at user message boundaries, 70% threshold, XML snapshots
- Current code: `src/autonomous/context-manager.ts` warm-tier LRU eviction
- `docs/qwen-code-vs-deeploop.md` §4.1

---

### 16. [ ] Loop Detection (3-Layer)

**What:** Add a `LoopDetector` to the agent loop that detects when the model is stuck in semantic loops — doing the same thing repeatedly with slight variations. Three detection layers: tool call hash matching, content repetition detection, and LLM-based cognitive assessment.

**Why:** Currently we rely only on turn limits and token budgets. These don't catch semantic loops where the model re-reads the same files, re-runs the same searches, or oscillates between two approaches without making progress. Qwen Code's `LoopDetectionService` combines three independent detectors to catch different types of stuck behavior.

**Impact:** Prevents wasted cycles on stuck tasks. Protects local token budgets from waste. Enables earlier escalation or strategy change when the model is spinning.

**Implementation:**
1. **Layer 1: Tool call hashing** — Hash `{toolName, inputParams}` signatures. If 5 consecutive calls have identical hashes, trigger loop detection. Cheap, catches exact repeats.
2. **Layer 2: Content chanting** (lower priority) — Sliding window of 50-char chunks with SHA-256. Triggers at 10+ identical chunks within proximity. Exclude code blocks and markdown to avoid false positives.
3. **Layer 3: LLM cognitive assessment** — After 15+ turns (lower than Qwen Code's 30 since we're local), periodically ask the fast model (35B): "Is this conversation making progress or stuck? Score 0.0–1.0." Check interval adjusts dynamically (3–8 turns) based on confidence.
4. On loop detection: inject a meta-prompt ("You appear to be repeating actions. Try a different approach or summarize what's blocking you."), or escalate to user if repeated.

**References:**
- Qwen Code: `LoopDetectionService` — 3-layer detection with dynamic intervals
- Current code: `src/autonomous/agent-loop.ts` turn limit enforcement
- `docs/qwen-code-vs-deeploop.md` §4.2

---

### 17. [ ] Delegate with Read-Only Tools

**What:** Extend the `delegate` tool to optionally provide a subset of read-only tools to the delegate. Currently, delegated subagents are text-only — they receive context but cannot read files, search, or inspect code.

**Why:** Qwen Code's `TaskTool` spawns subagents that are full agent instances with their own tool sets, event streams, and session tracking. This enables patterns like delegating a code review to the fast model *with* actual file access, running parallel investigations, or having a security review subagent that can read and test code.

**Impact:** Enables meaningful delegation. A security reviewer can actually read the code it's reviewing. An investigator can search the codebase for context. A test writer can read existing tests for style consistency.

**Implementation:**
1. Add `tools?: 'none' | 'read-only'` parameter to the `delegate` tool schema
2. When `tools: 'read-only'`, provide: `read_file`, `grep_files`, `glob`, `list_files`, `git_diff`
3. Keep write tools (`write_file`, `edit_file`, `bash`) restricted to the main loop
4. Delegate runs its own mini ReAct loop (up to 10 turns) with the provided tools
5. Return tool results as part of the delegate's response

**References:**
- Qwen Code: `TaskTool` — full subagent instances with own tool sets
- Current code: `src/autonomous/tools/delegate.ts` (text-only delegation)
- `docs/qwen-code-vs-deeploop.md` §4.4
- `docs/subagents.md` — existing subagent role definitions

---

### 18. [ ] Structured Handoff Format

**What:** Define a structured handoff format (XML) for cross-cycle context transfer. Replace free-form handoff notes with explicit fields: `files_modified`, `decisions_made`, `blockers_encountered`, `next_steps`, `key_learnings`.

**Why:** Current handoff notes are free-form text stored via `journal.append({ type: 'handoff' })`. The receiving cycle must parse natural language to understand what happened, leading to information loss and misinterpretation. Qwen Code's compression produces structured XML `<state_snapshot>` with explicit fields, making compressed context more parseable and reliable.

**Impact:** More reliable cross-cycle memory. The receiving cycle knows exactly what files were changed, what decisions were made, and what's left to do — without parsing prose.

**Implementation:**
1. Define `HandoffSnapshot` interface in `src/dual-loop/task-board-types.ts`:
   ```
   files_modified: { path, operation, summary }[]
   decisions_made: { decision, rationale }[]
   blockers_encountered: string[]
   next_steps: string[]
   key_learnings: string[]
   test_results: { file, passed, failed, summary }[]
   ```
2. Update `generateSummary` and `parkTask` in `deep-loop.ts` to produce structured handoffs
3. Update `planTask` to parse structured handoffs from `parkedState.contextSnapshot` instead of treating them as free-form text
4. Use XML format for serializability and model-parseability

**References:**
- Qwen Code: XML `<state_snapshot>` compression format
- Current code: `src/dual-loop/deep-loop.ts` `parkTask()` (free-form contextSnapshot)
- `docs/qwen-code-vs-deeploop.md` §4.7

---

### 19. [ ] Meaningful Task Acknowledgments and Progress Updates

**What:** Replace the generic "Got it — working on that now." acknowledgment with a plan-aware initial message, and add proactive progress updates during multi-step task execution. The user should know *what* Tyrion is about to do before he does it, and get periodic updates as steps complete.

**Why:** Currently the FastLoop sends a throwaway acknowledgment from the triage model (line 303 of `fast-loop.ts`) before the DeepLoop has even planned the task. The triage model has no knowledge of the plan — it just generates a generic ack like "Understood. The work begins." Then there's silence until the entire task completes. The user has zero visibility into what's happening or how far along it is.

The `buildStatusReport()` method (line 509) already has decent step-level progress info (`3/6 steps — Creating player module`), but it's only used when explicitly asked. It's never proactively pushed.

**Impact:** Users know what Tyrion is doing, can course-correct early if the plan is wrong, and aren't left wondering if anything is happening during long tasks.

**Implementation:**

1. **Plan-aware initial ack:** After the DeepLoop finishes `planTask()`, send a brief plan summary to the user via the FastLoop's `deliver()`:
   ```
   "Building Neon Invaders in 6 steps:
    1. Project structure and config
    2. Player and input modules
    3. Enemy grid and collision
    4. Particles, audio, HUD
    5. Game loop and levels
    6. Integration test
    Starting now."
   ```
   This requires a new event or TaskBoard status check — when a task transitions from `queued` → `implementing` with `planSteps` populated, the FastLoop picks it up and delivers the plan summary.

2. **Step completion updates:** When a step transitions to `done`, emit a brief progress message:
   ```
   "Step 2/6 done — player.js and input.js created. Starting enemy grid."
   ```
   Use the existing `step.output` (truncated) and the next step's description. Rate-limit to at most one update per 60 seconds to avoid spamming.

3. **Milestone updates for long steps:** If a single step runs longer than 3 minutes, send a heartbeat:
   ```
   "Still working on step 3/6 (enemy grid) — 4 files created so far."
   ```
   Use the workspace manifest file count for progress indication.

4. **Remove the generic fallback:** Replace the `"Got it — working on that now."` fallback (line 303) with a triage-generated message that includes the `triageNotes` summary:
   ```
   "Got it — this looks like a multi-file coding project. Planning the approach now."
   ```
   Update the triage system prompt to generate contextual acks for complex tasks.

**Source files to modify:**
- `src/dual-loop/fast-loop.ts` — heartbeat loop to check for plan-ready and step-complete events; new `deliverProgressUpdate()` method; replace generic ack fallback
- `src/dual-loop/deep-loop.ts` — emit events or update TaskBoard fields when plan is ready and steps complete
- `src/dual-loop/task-board.ts` — add `planReady` flag or event for plan-summary delivery
- `src/dual-loop/task-board-types.ts` — add `lastProgressDeliveredAt` timestamp for rate-limiting
- `src/dual-loop/triage-prompt.ts` — update triage prompt to generate contextual acks for complex tasks

**References:**
- Current ack: `src/dual-loop/fast-loop.ts` line 303 (`Got it — working on that now.`)
- Existing progress data: `src/dual-loop/fast-loop.ts` lines 509-540 (`buildStatusReport()`)
- Task state transitions: `src/dual-loop/task-board.ts`

---

### 20. [ ] Batch File Read Tool

**What:** Add a `read_files` tool that reads multiple files in a single tool call, accepting an array of paths or glob patterns. Returns all file contents in one response, cutting multi-file exploration from N tool turns to 1.

**Why:** The current `read_file` tool (`src/tools/executors/read-file.ts`) reads one file per call. During the exploration phase of a coding task, the model typically reads 5-10 files to understand the codebase. Each read is a separate ReAct turn: model requests → tool executes → result fed back → model requests next file. This wastes turns and context on per-file overhead (tool call JSON, result framing).

Qwen Code's `ReadManyFilesTool` solves this with glob pattern support and batch reading. For a 6-file exploration phase, this cuts turns from 6 to 1.

**Impact:** 60-80% reduction in exploration turns. Less context wasted on per-file tool call overhead. Faster codebase understanding.

**Implementation:**
1. Create `src/tools/executors/read-files.ts` — new `read_files` executor accepting `{ paths: string[] }` or `{ glob: string }`
2. Reuse existing `read_file` safety checks (blocked paths, max file size, encoding)
3. Per-file size cap (same 5MB), plus aggregate cap (~20MB total) to prevent context flooding
4. Truncation: if total content exceeds a token budget (~50K chars), truncate the longest files first with `...(truncated)` markers
5. Add tool schema to `src/tools/schemas/core.ts`
6. Register executor in `src/tools/executors/index.ts` and tool map
7. Output format: array of `{ path, content, lines, size, error? }` — failed files return error instead of aborting the batch

**References:**
- Qwen Code: `ReadManyFilesTool` — glob patterns, batch read, intelligent filtering
- Current tool: `src/tools/executors/read-file.ts` (single file only)
- `docs/qwen-code-vs-deeploop.md` §3 (tool set comparison)

---

### 21. [ ] File-Change Delta Tracking

**What:** When the model re-reads a file it already read earlier in the same cycle, send only the diff from the last read instead of the full file contents. Track file read timestamps and content hashes to detect re-reads and compute minimal deltas.

**Why:** In long coding sessions (20+ turns), the model frequently re-reads files it already has in context — to check its edits, verify state, or refresh its memory. Each full re-read wastes context tokens on content the model has largely already seen. Qwen Code's IDE integration uses a delta pattern: full state on first access, only changes on subsequent accesses. The same principle applies to file reads in a coding loop.

**Impact:** Reduces redundant context in deep coding sessions. Works synergistically with warm-tier compression (#15) — compression preserves *what the model knew*, delta tracking avoids *re-sending what hasn't changed*. Together they attack context waste from both ends.

**Implementation:**
1. Add a `FileReadTracker` to `src/coding/context-manager.ts` that stores `{ path, contentHash, readAtTurn, content }` for each file read
2. On file read, check if the path has been read before in this cycle:
   - First read: return full content, store hash + content
   - Re-read with same hash: return `"(unchanged since turn N)"` — 5 tokens instead of 500+
   - Re-read with different hash: compute and return a unified diff, update stored hash + content
3. Use a fast hash (xxHash or SHA-256 of first 4KB + length) for change detection — don't diff unless hashes differ
4. Clear tracker on cycle boundaries (new task / handoff)
5. Add an escape hatch: `read_file(path, force_full=true)` for when the model explicitly needs the full content

**References:**
- Qwen Code: IDE context delta tracking — full state on first message, deltas on subsequent turns
- Current code: `src/tools/executors/read-file.ts` (always returns full content)
- `docs/qwen-code-vs-deeploop.md` §4.6

---

### 22. [ ] Skills System Deepening

**What:** Deepen the skills system from its current state (loosely integrated LLM-facing instructions) into a core execution primitive. Three workstreams: (a) tighter integration of skills into the agent loop so they're automatically invoked, not just discoverable; (b) autonomous skill authoring where Tyrion creates new SKILL.md packages from successful task patterns; (c) skill composition where multi-step workflows chain skills together.

**Why:** The skills infrastructure is solid — three tiers exist (static SKILL.md with 5 built-in + 14 workspace skills, learned skill files with mastery progression, and synthesized bash-template tools with security scanning). But they're underutilized: static skills require keyword-based intent matching to surface, learned skills are recorded but rarely replayed, and synthesized tools are isolated bash templates without workflow awareness. Skills should be a growth flywheel: successful tasks become skills, skills accelerate future tasks, usage data refines skill quality.

**Impact:** Transforms skills from a passive catalog into an active execution accelerator. Critical for Vision Tier 2 (self-improvement) and Tier 3 (autonomous operation). As the skill library grows, Tyrion gets faster at recurring patterns — the system compounds over time.

**Implementation:**

**(a) Agent Loop Integration:**
1. After task triage, query `skillFilesManager.search()` and `skillRegistry.getRelevantSkillInstructions()` with the task description
2. If a high-mastery (proficient/expert) learned skill matches, inject its steps as a suggested plan in the DeepLoop's planner prompt — not as a rigid template, but as prior art
3. After successful task completion, call `skillFilesManager.learn()` to capture the pattern if no existing skill matched (currently this path exists but isn't reliably triggered)
4. Track skill-assisted vs. unassisted task success rates for evaluation

**(b) Autonomous Skill Authoring:**
1. After a successful multi-step task, have the fast model extract a SKILL.md draft: frontmatter (name, description, requirements) + instruction body
2. Store in `workspace/skills/` as a new skill package — immediately discoverable on next task
3. Require at least 2 successful uses of the same pattern before authoring (avoid one-off noise)
4. Human approval gate: new skills are created as `draft` status, promoted to `active` after user confirms or after 3 successful autonomous uses

**(c) Skill Composition:**
1. Add a `depends_on` field to SKILL.md frontmatter for declaring skill chains
2. Enable multi-skill plans: "To deploy, run `build` skill → `test` skill → `deploy` skill"
3. Start simple — sequential chains only, no branching or parallelism

**References:**
- Current implementation: `src/skills/loader.ts` (registry), `src/autonomous/memory/skill-files.ts` (learned skills), `src/tools/synthesizer.ts` (tool synthesis)
- Qwen Code: `SKILL.md` discovery with YAML frontmatter — our format is already compatible
- `docs/qwen-code-vs-deeploop.md` §4.8
- `docs/skills-and-tools.md` (central skills documentation)

---

### 23. [ ] Playwright Desktop Interaction

**What:** Give Tyrion the ability to "see" and interact with the desktop via Playwright. Launch a browser or desktop app, take screenshots, read visual state, click elements, type text, and navigate — the same way a human would. This enables GUI-dependent tasks: testing web UIs, filling forms, reading visual dashboards, interacting with apps that have no CLI/API.

**Why:** Tyrion currently operates entirely through text: files, terminal commands, and tool outputs. But many real tasks involve visual interfaces — verifying a web app looks correct after code changes, interacting with admin panels, testing responsive layouts, reading error screens, or automating GUI workflows that have no programmatic API. Playwright provides a mature, cross-platform automation layer that can drive Chromium, Firefox, and WebKit, plus experimental desktop app support via Electron.

**Impact:** Opens an entirely new capability class. Tyrion can validate his own UI work visually (not just structurally), automate browser-based workflows, and handle tasks that currently require the user to be the "eyes." This is a meaningful step toward full autonomous operation — the agent can close the loop on visual tasks without human intermediation.

**Implementation:**

**(Phase 1: Browser Automation — Core)**
1. Add `playwright` as an optional dependency (it's heavy — ~130MB browsers)
2. Create `src/tools/executors/browser.ts` with actions:
   - `browser_open(url)` — Launch headless Chromium, navigate to URL
   - `browser_screenshot(selector?)` — Capture full page or element screenshot, return as image for vision model analysis
   - `browser_click(selector)` — Click an element
   - `browser_type(selector, text)` — Type into an input
   - `browser_eval(js)` — Run JavaScript in page context (gated — security review required)
   - `browser_close()` — Teardown
3. Screenshots are analyzed by the vision-capable model (Qwen VL or LLaVA via Ollama) — Tyrion "sees" the page as an image and reasons about it
4. Session management: one browser instance per task, auto-close on task completion or timeout (5 min idle)

**(Phase 2: Visual Validation for Code Tasks)**
1. After generating a web project, automatically `browser_open('file:///workspace/index.html')` and screenshot
2. Compare screenshot against task description: "Does this look like a space invaders game?"
3. If visual validation fails, feed the screenshot + description back to the coder for fixes
4. This closes the validation loop for UI work — currently we validate structure (parse, lint, typecheck) but not appearance

**(Phase 3: Desktop App Interaction — Future)**
1. Explore Playwright's Electron support for native app automation
2. Investigate accessibility tree reading as a lighter alternative to screenshots for structured UIs
3. Consider macOS Accessibility API integration (complements existing system-control skill)

**Security Considerations:**
- `browser_eval` must be gated behind approval (arbitrary JS execution)
- Browser sessions should be sandboxed (no access to user's real browser profile, cookies, or saved passwords)
- Network access from browser context should respect the same local-first policy — no unexpected cloud calls
- Screenshot storage must be ephemeral (workspace temp dir, cleaned on cycle end)

**References:**
- Playwright docs: headless browser automation, screenshot API, element selectors
- Vision models via Ollama: Qwen2.5-VL, LLaVA for screenshot analysis
- Existing validation: `src/coding/validators/` (parse, lint, typecheck — all structural, none visual)
- System-control skill: `skills/system-control/SKILL.md` (macOS screenshot capability already exists, but not integrated into agent loop)

---

## Implementation Notes

### Dependencies Between Items

```
Tier 1 items are independent — implement in any order.

Tier 2:
  5 (MLX Backend) ← 6 (Speculative Decoding)
  7 (Verification Cascade) is independent

Tier 3:
  8 (LoRA Fine-Tuning) ← 9 (Disentangled Adapters)
  8 (LoRA Fine-Tuning) ← 10 (SPIN Self-Play)

Tier 4:
  5 (MLX Backend) ← 12 (KVSplit K8V4)
  11 (NPU Offloading) is independent
  13 (Test-Time Compute) is independent

Tier 5 (Qwen Code-derived):
  14 (Step-Scoped Context) is independent
  15 (Warm-Tier Compression) is independent
  16 (Loop Detection) is independent
  17 (Delegate with Tools) is independent
  18 (Structured Handoffs) is independent
  19 (Progress Updates) is independent — but benefits from 14 (step-scoped context makes plan summaries more meaningful)
  20 (Batch File Read) is independent
  21 (File-Change Delta Tracking) is independent — but benefits from 20 (batch read tracker can share the same FileReadTracker)
  22 (Skills System Deepening) is independent — but part (a) benefits from 17 (delegate with tools enables skill-based subagent delegation)
  23 (Playwright Desktop Interaction) is independent — but Phase 2 benefits from 14 (step-scoped context for visual validation steps)
  15 ← 18 share the XML snapshot format — implement 18 first for type definitions
```

### Quality Gates

Every implementation must pass `ALLOW_PROTECTED_CHANGES=1 npm run check` before merging. This includes:
- TypeScript compilation (`tsc --noEmit`)
- ESLint
- All Vitest tests (currently 3736+)
- Security guardrails (`scripts/guardrails.mjs`)
