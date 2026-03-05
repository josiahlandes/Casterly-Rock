# Providers & Routing

> **Source**: `src/providers/`, `src/tasks/classifier.ts`

All LLM inference runs on-device through Ollama. The provider system abstracts model access behind a common interface.

## Provider Interface

> **Source**: `src/providers/base.ts`

```typescript
interface LlmProvider {
  id: string;                    // e.g. 'ollama'
  kind: 'local' | 'cloud';      // always 'local'
  model: string;                 // e.g. 'qwen3.5:122b'

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
| `temperature` | Randomness (0.0–1.0) |
| `providerOptions` | Ollama-specific options (`num_ctx`, etc.) |
| `previousAssistantMessages` | Prior turns for multi-turn tool calling |

## Ollama Provider

> **Source**: `src/providers/ollama.ts`

The only active provider. Talks to `http://localhost:11434`.

- Builds OpenAI-compatible chat messages
- Converts `ToolSchema[]` to Ollama's tool format
- POSTs to `/api/chat` with `stream: false`
- Normalizes tool call arguments (handles both object and JSON string formats)
- Reconstructs full message chain for multi-turn tool calling

## Two-Model Registry

> **Source**: `src/providers/index.ts`

| Slot | Model | Purpose |
|------|-------|---------|
| `local` | `qwen3.5:122b` | DeepLoop: reasoning, planning, code generation |
| `fast` | `qwen3.5:35b-a3b` | FastLoop: triage, review, acknowledgment |

The `codingModel` config key exists for backward compatibility but is unused — the 122B handles coding directly.

Model routing is **LLM-driven**, not hardcoded. The LLM decides via the `delegate` tool which model handles each sub-task.

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

Uses semaphore-based concurrency control (max 3 concurrent, 5 min timeout). All providers are local Ollama instances.

## Key Files

| File | Purpose |
|------|---------|
| `src/providers/base.ts` | `LlmProvider` interface, error types |
| `src/providers/ollama.ts` | Ollama provider implementation |
| `src/providers/index.ts` | Two-model registry |
| `src/providers/concurrent.ts` | Parallel inference, best-of-N |
| `src/tasks/classifier.ts` | Optional message classification tool |
| `src/imessage/voice-filter.ts` | Post-processing personality rewrite |
