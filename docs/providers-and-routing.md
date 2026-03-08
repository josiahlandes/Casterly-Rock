# Providers & Routing

> **Source**: `src/providers/`, `src/tasks/classifier.ts`

All LLM inference runs on-device through Ollama and vllm-mlx. The provider system abstracts model access behind a common interface.

## Provider Interface

> **Source**: `src/providers/base.ts`

```typescript
interface LlmProvider {
  id: string;                    // e.g. 'ollama', 'mlx'
  kind: 'local' | 'cloud';      // always 'local'
  model: string;                 // e.g. 'qwen3.5:35b-a3b'

  generateWithTools(
    request: GenerateRequest,
    tools: ToolSchema[],
    previousResults?: ToolResultMessage[]
  ): Promise<GenerateWithToolsResponse>;
}
```

| Request Field | Description |
|---------------|-------------|
| `prompt` | User message / prompt |
| `systemPrompt` | System prompt for context |
| `maxTokens` | Maximum tokens to generate |
| `temperature` | Randomness (0.0-1.0) |
| `providerOptions` | Provider-specific options (`num_ctx`, `think`, etc.) |
| `previousAssistantMessages` | Prior turns for multi-turn tool calling |

## Ollama Provider

> **Source**: `src/providers/ollama.ts`

Used for the FastLoop model (35B-A3B). Talks to `http://localhost:11434`.

- Builds OpenAI-compatible chat messages
- Converts `ToolSchema[]` to Ollama's tool format
- POSTs to `/api/chat` with `stream: false`
- Normalizes tool call arguments (handles both object and JSON string formats)
- Reconstructs full message chain for multi-turn tool calling

## MLX Provider

> **Source**: `src/providers/mlx.ts`

Used for DeepLoop models (27B reasoner and 80B coder). Talks to vllm-mlx's OpenAI-compatible API.

- Two instances: reasoner on port 8000, coder on port 8001
- POSTs to `/v1/chat/completions` with `stream: false`
- Supports `truncate_prompt_tokens` for context window management (maps from `num_ctx` in `providerOptions`)
- Handles KV cache configuration per instance (K8V4 for reasoner, FP16 for coder)
- 3-tier tool argument parsing: strict JSON, auto-repair, heuristic extraction

### MLX Health & Auto-Start

> **Source**: `src/providers/mlx-health.ts`

The `ensureMlxServerReady()` function probes the health endpoint and optionally auto-starts the server if it's down:

- Supports multi-instance management via `instance` option (e.g., `'reasoner'`, `'coder'`)
- Passes `MLX_INSTANCE` env var to `scripts/mlx-server.sh` for namespaced PID/log files
- Retries up to 20 times with 3s intervals after server start

### MLX KV Cache

> **Source**: `src/providers/mlx-kv-cache.ts`

Configurable KV cache quantization per provider instance:

| Model | Strategy | Rationale |
|-------|----------|-----------|
| 27B Reasoner | K8V4 (asymmetric) | 64 KV layers, lossless at 128K context, saves ~1.7GB vs FP16 |
| 80B Coder | FP16 (none) | Only 12 KV layers (DeltaNet hybrid), quantization saves negligible memory |

## Three-Model Registry

> **Source**: `src/providers/index.ts`, `src/imessage/daemon.ts`

| Slot | Model | Provider | Server | Purpose |
|------|-------|----------|--------|---------|
| `qwen3.5-27b-reasoner` | Qwen3.5-27B Dense | MLX | :8000 | DeepLoop: planning, review, self-correction |
| `qwen3-coder-80b` | Qwen3-Coder-80B-A3B MoE | MLX | :8001 | DeepLoop: tool-calling code generation |
| `qwen3.5:35b-a3b` | Qwen3.5-35B-A3B MoE | Ollama | :11434 | FastLoop: triage, review, acknowledgment |

The 27B reasoner handles planning and review with thinking enabled. The 80B coder handles tool execution and code generation with thinking disabled. The 35B fast model handles user-facing triage and delivery.

## Task Classifier

> **Source**: `src/tasks/classifier.ts`

Available as an **optional agent tool** (`classify`). Uses a single LLM call with structured output to classify messages as `conversation`, `simple_task`, or `complex_task`.

In the dual-loop system, the FastLoop's triage prompt handles classification directly rather than invoking this tool.

## Concurrent Provider

> **Source**: `src/providers/concurrent.ts`

Enables parallel inference across models on the Mac Studio M4 Max:

| Method | Description |
|--------|-------------|
| `generate(model, request)` | Send to a specific model |
| `parallel(models, request)` | Same prompt to N models concurrently |
| `bestOfN(models, request, judge)` | Generate N solutions, judge picks best |

Uses semaphore-based concurrency control (max 3 concurrent, 30 min timeout). Registers all three model providers.

## Key Files

| File | Purpose |
|------|---------|
| `src/providers/base.ts` | `LlmProvider` interface, error types |
| `src/providers/ollama.ts` | Ollama provider (FastLoop) |
| `src/providers/mlx.ts` | MLX provider (DeepLoop reasoner + coder) |
| `src/providers/mlx-health.ts` | Health checks, auto-start, multi-instance |
| `src/providers/mlx-kv-cache.ts` | KV cache quantization configuration |
| `src/providers/index.ts` | Model registry |
| `src/providers/concurrent.ts` | Parallel inference, best-of-N |
| `src/tasks/classifier.ts` | Optional message classification tool |
| `src/imessage/voice-filter.ts` | Post-processing personality rewrite |
