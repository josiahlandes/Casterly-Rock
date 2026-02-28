# Providers & Routing

> **Source**: `src/providers/`, `src/tasks/classifier.ts`, `src/autonomous/provider.ts`

Casterly is local-first: all LLM inference runs on-device through Ollama. The provider system abstracts model access behind a common interface, and routing logic selects the right model for each task.

## Provider Interface

> **Source**: `src/providers/base.ts`

Every provider implements the `LlmProvider` interface:

```typescript
interface LlmProvider {
  id: string;                    // e.g. 'ollama'
  kind: 'local' | 'cloud';      // always 'local' in current setup
  model: string;                 // e.g. 'qwen3.5:122b', 'qwen3.5:35b-a3b'

  generateWithTools(
    request: GenerateRequest,
    tools: ToolSchema[],
    previousResults?: ToolResultMessage[]
  ): Promise<GenerateWithToolsResponse>;
}
```

### GenerateRequest

| Field | Type | Description |
|-------|------|-------------|
| `prompt` | `string` | User message / prompt |
| `systemPrompt` | `string?` | System prompt for context and instructions |
| `maxTokens` | `number?` | Maximum tokens to generate |
| `temperature` | `number?` | Randomness (0.0–1.0) |
| `providerOptions` | `Record<string, unknown>?` | Ollama-specific options (`num_ctx`, `repeat_penalty`, etc.) |
| `previousAssistantMessages` | `PreviousAssistantMessage[]?` | Prior turns for multi-turn tool calling |

### GenerateWithToolsResponse

| Field | Type | Description |
|-------|------|-------------|
| `text` | `string` | Text content of the response |
| `toolCalls` | `NativeToolCall[]` | Tool calls the model wants to make |
| `providerId` | `string` | Which provider generated this |
| `model` | `string` | Which model was used |
| `stopReason` | `'end_turn' \| 'tool_use' \| 'max_tokens'` | Why the model stopped |

### Error Types

| Error | When | Behavior |
|-------|------|----------|
| `ProviderError` | Any provider failure | Generic error with optional cause |
| `BillingError` | Cloud billing issues | Signals caller to fall back to local (unused in current local-only setup) |

## Ollama Provider

> **Source**: `src/providers/ollama.ts`

The only active provider implementation. Talks to the local Ollama API at `http://localhost:11434`.

### Connection Details

| Setting | Default | Source |
|---------|---------|--------|
| Base URL | `http://localhost:11434` | Config `local.baseUrl` |
| Timeout | 60,000ms | Config `local.timeoutMs` |
| Temperature | 0.7 | Per-request |

### How It Works

1. Builds an `OllamaChatRequest` with messages in the OpenAI-compatible format:
   - `system` message (if system prompt provided)
   - `user` message (the prompt)
   - `assistant` + `tool` messages (for multi-turn tool calling)
2. Converts `ToolSchema[]` to Ollama's tool format (`OllamaTool[]`)
3. POSTs to `/api/chat` with `stream: false`
4. Parses the response:
   - Extracts text from `message.content`
   - Parses tool calls from `message.tool_calls`
   - Determines stop reason from `done_reason`

### Tool Call Parsing

Ollama returns tool call arguments as parsed objects (not JSON strings like OpenAI). The provider normalizes both formats:

```typescript
// Ollama native: arguments is already an object
{ function: { name: "read_file", arguments: { path: "src/foo.ts" } } }

// OpenAI compat: arguments is a JSON string
{ function: { name: "read_file", arguments: '{"path":"src/foo.ts"}' } }
```

Both are normalized to `NativeToolCall` with `input: Record<string, unknown>`.

### Multi-Turn Threading

For tool-use conversations, the provider reconstructs the full message chain:

```
user → assistant (with tool_calls) → tool (result) → assistant (with tool_calls) → tool (result) → ...
```

The `previousAssistantMessages` field carries prior assistant turns (text + tool calls), and `previousResults` carries their corresponding tool results.

## Provider Registry

> **Source**: `src/providers/index.ts`

The registry manages provider slots and model lookup:

```typescript
interface ProviderRegistry {
  local: LlmProvider;   // Primary model — reasoning, planning, conversation
  coding: LlmProvider;  // Coding model — code generation, review, file ops
  get(name: string): LlmProvider;           // Get by name
}
```

### Two-Model Setup

In the current two-model architecture, the 122B model handles all reasoning and code generation. The `codingModel` config key is unused -- both the `local` and `coding` slots point to the same provider instance:

| Slot | Config Key | Default Model | Purpose |
|------|-----------|---------------|---------|
| `local` | `local.model` | `qwen3.5:122b` | DeepLoop: reasoning, planning, code generation, conversation |
| `fast` | `fast_loop.model` | `qwen3.5:35b-a3b` | FastLoop: triage, review, acknowledgment (MoE: 35B total, 3B active) |

The `codingModel` config key still exists for backward compatibility but is effectively unused since the 122B DeepLoop model handles coding directly (SWE-bench: 72.0).

### Model Routing

Hardcoded task-type routing has been deprecated. The LLM decides which model to use for each sub-task via the `delegate` tool at runtime. `forTask()` returns the local provider for all task types.

### Name-Based Lookup

`get(name)` supports:

| Name | Returns |
|------|---------|
| `'local'` or `'default'` | Primary model |
| `'coding'` | Coding model |
| Any string containing `'coder'` | Coding model |
| Anything else | Primary model (fallback) |

## Task Classifier

> **Source**: `src/tasks/classifier.ts`

The classifier is available as an **optional agent tool** (`classify`) that the LLM invokes when it judges classification is useful. It is no longer a mandatory pipeline stage.

It uses a single focused LLM call with a `classify_message` tool as the only available tool, forcing structured output.

### Classification Categories

| Category | Meaning |
|----------|---------|
| `conversation` | Chatting, questions, small talk |
| `simple_task` | Single unambiguous command |
| `complex_task` | Multi-step workflow |

### How It Works

1. Builds minimal context: current message + last 3 conversation exchanges
2. Sends to the LLM with `classify_message` as the only tool
3. Parses the structured output: `{ taskClass, confidence, reason, taskType }`
4. Falls back to `conversation` (confidence 0.3) if the model doesn't call the tool
5. Falls back to `conversation` (confidence 0.1) on any error

## Message Routing

All messages — whether from iMessage, CLI, or scheduled jobs — enter through the **agent loop** as triggers. There is no separate pipeline. The iMessage daemon calls `triggerFromMessage()` to create a user trigger, then `autonomousController.runTriggeredCycle()` to execute it through the agent loop. The agent loop is the sole execution path.

```
Message arrives (iMessage / CLI / scheduled job)
    │
    ▼
triggerFromMessage(text, sender)
    │
    ▼
autonomousController.runTriggeredCycle(trigger)
    │
    ▼
Agent Loop (ReAct cycle with 96 tools)
    │
    ▼
Voice Filter (personality rewrite)
    │
    ▼
sendMessage(response)
```

## Concurrent Provider

> **Source**: `src/providers/concurrent.ts`

For hardware-maximizing scenarios (Mac Studio M4 Max with 128GB unified memory), the concurrent provider enables parallel inference across multiple models.

### Capabilities

| Method | Description |
|--------|-------------|
| `generate(model, request)` | Send a request to a specific registered model |
| `parallel(models, request)` | Same prompt to multiple models concurrently; returns all results |
| `bestOfN(models, request, judgeModel)` | Generate N solutions, have a judge model pick the best |

### Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `maxConcurrent` | 3 | Maximum simultaneous inference requests |
| `requestTimeoutMs` | 300,000 | Individual request timeout (5 min) |
| `maxParallelGenerations` | 4 | Maximum models for parallel/bestOfN |

### Concurrency Control

Uses a simple semaphore pattern: `acquireSlot()` busy-waits with 50ms yields until a slot opens; `releaseSlot()` decrements the counter. Active request count is tracked.

### Best-of-N Flow

1. **Generate**: Run `parallel()` across all specified models
2. **Judge**: Build a comparison prompt with all candidate responses
3. **Select**: Parse the judge's response to identify the winning candidate (regex patterns for "Candidate N" / "select N" / leading digit)
4. **Fallback**: If judge response can't be parsed, candidate 1 wins by default

### Privacy

All providers are local Ollama instances. No data leaves the machine.

## Autonomous Provider (Legacy — Deprecated)

> **Source**: `src/autonomous/provider.ts`, `src/autonomous/providers/ollama.ts`

The `AutonomousProvider` interface was designed for the old 4-phase pipeline (analyze → hypothesize → implement → reflect). It has been superseded by the ReAct agent loop, which uses the standard `LlmProvider` interface exclusively.

The `AutonomousLoop` constructor creates a proper `OllamaProvider` (implementing `LlmProvider`) for the agent loop, configured with the model from `autonomous.yaml` and a 5-minute timeout for local inference. The legacy `AutonomousProvider` is no longer used for agent loop execution.

## Key Files

| File | Purpose |
|------|---------|
| `src/providers/base.ts` | `LlmProvider` interface, `GenerateRequest`, error types |
| `src/providers/ollama.ts` | Ollama provider: `/api/chat`, tool call parsing, multi-turn threading |
| `src/providers/index.ts` | `ProviderRegistry`: two-model setup, task-based routing |
| `src/providers/concurrent.ts` | Parallel inference, best-of-N generation with judge model |
| `src/tasks/classifier.ts` | Message classification: `conversation` / `simple_task` / `complex_task` (available as agent tool) |
| `src/tasks/types.ts` | `ClassificationResult`, `TaskPlan`, `TaskStep`, verification types |
| `src/autonomous/provider.ts` | `AutonomousProvider` interface (legacy, deprecated) |
| `src/autonomous/providers/ollama.ts` | Ollama implementation of autonomous provider (legacy) |
| `src/imessage/voice-filter.ts` | Post-processing personality rewrite before message delivery |

---

## Vision Reconciliation Notes — IMPLEMENTED

The provider interface itself is well-designed and aligned with the vision. All reconciliation items below have been implemented.

### 1. Remove hardcoded task-type model routing — IMPLEMENTED

**Current:** `src/providers/index.ts` (lines 48-78) has a `CODING_TASK_TYPES` set that routes `coding`, `file_operation`, `code`, `review`, `implement`, `validate` tasks to the coding model. `src/pipeline/process.ts` (lines 277-287) enforces this routing after classification.

**Why change:** The vision says the two-model setup is "a basic mixture of experts where the gating function is the LLM itself." The LLM should decide which model handles a subtask at runtime, not a static lookup table. A task classified as "coding" might actually need the reasoning model if it requires architectural judgment.

**What to do:** Remove the `CODING_TASK_TYPES` set and the `forTask()` routing method from `ProviderRegistry`. The `delegate` agent tool already lets the LLM specify which model to use — this is the correct mechanism. The system prompt should describe the models' strengths: "Use qwen3.5:122b (DeepLoop) for reasoning, planning, code generation, and implementation. Use qwen3.5:35b-a3b (FastLoop) for triage, review, and acknowledgment."

> **Status:** Hardcoded task-type model routing deprecated. `forTask` returns local for all task types. The LLM decides model routing via the `delegate` tool.

### 2. Retire the pipeline routing in `process.ts` — IMPLEMENTED

**Current:** `src/pipeline/process.ts` integrates classification and routing as a pipeline: classify → route to model → execute via flat tool loop or task manager.

**Why change:** The vision says the agent loop is the only execution path. The pipeline in `process.ts` is a separate path that bypasses the agent loop entirely.

**What to do:** Remove `process.ts` as an execution path. All triggers (including iMessage) flow through the agent loop. The classification step in the pipeline becomes an optional agent tool the LLM invokes when needed.

> **Status:** Fully implemented. iMessage daemon calls `triggerFromMessage()` → `autonomousController.runTriggeredCycle()`. The legacy `processChatMessage()` pipeline has been removed. All messages flow through the agent loop.

### 3. Remove the legacy `AutonomousProvider` interface — IMPLEMENTED

**Current:** `src/autonomous/provider.ts` defines a separate provider interface with `analyze()`, `hypothesize()`, `implement()`, `reflect()` methods for the old 4-phase pipeline.

**Why change:** The 4-phase pipeline is superseded by the ReAct agent loop. The `AutonomousProvider` interface is unused in the target architecture.

**What to do:** Delete `src/autonomous/provider.ts` and `src/autonomous/providers/ollama.ts`. All inference goes through the standard `LlmProvider` interface.

> **Status:** Legacy `AutonomousProvider` interface deprecated. The `AutonomousLoop` constructor creates a proper `OllamaProvider` (implementing `LlmProvider`) for agent loop inference, bypassing `AutonomousProvider` entirely.

### 4. Wire `ConcurrentProvider` as an LLM-accessible tool — IMPLEMENTED

**Current:** `src/providers/concurrent.ts` is fully implemented with `parallel()`, `bestOfN()`, and bounded concurrency, but is not wired into the agent loop or exposed to the LLM.

**Why change:** The vision says "because tokens are free, the executive model can use redundancy as a reliability strategy." The LLM should be able to request multi-model inference when it judges a problem is hard enough to warrant it.

**What to do:** Create a `parallel_reason` agent tool that lets the LLM explicitly request multi-model inference. The tool wraps `ConcurrentProvider.parallel()` or `bestOfN()`. The LLM decides when redundancy is worth the cost, rather than the system routing based on difficulty assessment.

> **Status:** `parallel_reason` agent tool implemented (Roadmap Parallelism supporting work).

### 5. Keep the provider interface stable — IMPLEMENTED

**Current:** The `LlmProvider` interface is minimal and clean: `generateWithTools()` is the only method.

**Why change:** This is already aligned with the vision. The interface is the right abstraction — it hides provider details and lets the agent loop work with any model.

**What to do:** Keep as-is. This is a good example of the "thin runtime" philosophy — the system provides capability (inference), the LLM provides judgment (what to ask and when).

> **Status:** Provider interface unchanged. Already aligned with vision.
