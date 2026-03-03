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

### 12. [ ] KVSplit K8V4 for MLX Inference

**What:** Use mixed-precision KV cache where keys are stored at 8-bit and values at 4-bit precision (K8V4). Research shows this asymmetric quantization achieves 59% cache memory reduction with minimal quality loss — keys are more sensitive to quantization than values.

**Why:** At 128K context, the KV cache for a 122B model is enormous. K8V4 reduces it by 59%, enabling longer effective contexts or freeing memory for other purposes. This is more aggressive than Q8 quantization (Tier 1 item 2) but also higher reward.

**Impact:** 59% KV cache reduction. Enables longer contexts or lower memory pressure.

**Implementation:**
1. Requires MLX backend (Tier 2 item 5) as prerequisite
2. Implement K8V4 quantization in MLX inference config
3. Benchmark carefully: run quality evaluation suite at multiple context lengths
4. Compare against Q8 (Tier 1) and FP16 baselines
5. Document quality/memory tradeoff curves

**References:**
- Research: KVQuant (Hooper et al., 2024) — asymmetric key/value quantization
- Research: KIVI (Liu et al., 2024) — K8V4 specifically, 59% reduction with <0.1 perplexity degradation
- MLX quantization support: configurable per-tensor precision

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
```

### Quality Gates

Every implementation must pass `ALLOW_PROTECTED_CHANGES=1 npm run check` before merging. This includes:
- TypeScript compilation (`tsc --noEmit`)
- ESLint
- All Vitest tests (currently 3736+)
- Security guardrails (`scripts/guardrails.mjs`)
