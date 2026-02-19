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
  model: string;                 // e.g. 'hermes3:70b', 'qwen3-coder-next:latest'

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

The registry manages two provider slots and handles model selection:

```typescript
interface ProviderRegistry {
  local: LlmProvider;   // Primary model — reasoning, planning, conversation
  coding: LlmProvider;  // Coding model — code generation, review, file ops
  forTask(taskType?: string): LlmProvider;  // Route by task type
  get(name: string): LlmProvider;           // Get by name
}
```

### Two-Model Setup

When `config.local.codingModel` is set and differs from the primary model, a separate `OllamaProvider` is created for coding tasks:

| Slot | Config Key | Default Model | Purpose |
|------|-----------|---------------|---------|
| `local` | `local.model` | `hermes3:70b` | Reasoning, planning, conversation |
| `coding` | `local.codingModel` | `qwen3-coder-next:latest` | Code generation, review, file operations |

If `codingModel` is not set or matches the primary model, both slots point to the same provider instance.

### Task-Based Routing

`forTask(taskType)` routes to the coding model for these task types:

```
coding, file_operation, code, review, implement, validate
```

Everything else goes to the primary model.

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

The classifier determines how to handle an incoming message before it reaches a model. It uses a single focused LLM call with a `classify_message` tool as the only available tool, forcing structured output.

### Classification Categories

| Category | Meaning | Action |
|----------|---------|--------|
| `conversation` | Chatting, questions, small talk | Respond directly, flat tool loop |
| `simple_task` | Single unambiguous command | Single tool call, skip decomposition |
| `complex_task` | Multi-step workflow | Plan → execute → verify pipeline |

### How It Works

1. Builds minimal context: current message + last 3 conversation exchanges
2. Sends to the LLM with `classify_message` as the only tool
3. Parses the structured output: `{ taskClass, confidence, reason, taskType }`
4. Falls back to `conversation` (confidence 0.3) if the model doesn't call the tool
5. Falls back to `conversation` (confidence 0.1) on any error

### Classification Rules

The system prompt instructs:
- Default to `conversation` unless the message is clearly and purely a task command
- Most real user messages include conversational context → classify as `conversation`
- `simple_task` only when the entire message is a direct, unambiguous single-action command
- `complex_task` only when the user explicitly wants multiple distinct actions

### Task Types

The classifier also tags messages with a task type (e.g. `calendar`, `file_operation`, `coding`, `reminder`, `system_info`, `communication`) which feeds into the provider routing decision.

## Pipeline Routing

> **Source**: `src/pipeline/process.ts`

The message processing pipeline integrates classification and routing:

```
Message arrives
    │
    ▼
classifyMessage(message, history, provider)
    │
    ├── taskClass: conversation ──→ Flat tool loop (direct response)
    │
    ├── taskClass: simple_task
    │   └── taskType: coding/file_operation ──→ Flat tool loop
    │   └── taskType: other ──→ Task manager pipeline
    │
    └── taskClass: complex_task ──→ Task manager pipeline

    After classification:
    providers.forTask(taskType) ──→ Switch to coding model if needed
```

Key routing decisions:
1. **Classification first** — cheap single LLM call to determine message type
2. **Model routing** — if the task type is coding-related, switch to the coding model
3. **Execution mode** — conversation and coding tasks use the flat tool loop; complex tasks use the full plan-execute-verify pipeline

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

## Autonomous Provider

> **Source**: `src/autonomous/provider.ts`, `src/autonomous/providers/ollama.ts`

A separate provider interface for the legacy autonomous improvement loop (the 4-phase pipeline, superseded by the ReAct agent loop). This is distinct from the `LlmProvider` interface — it's structured around the improvement cycle phases rather than generic generation.

### AutonomousProvider Interface

| Method | Phase | Returns |
|--------|-------|---------|
| `analyze(context)` | Analyze | Observations from error logs, metrics, backlog |
| `hypothesize(observations)` | Hypothesize | Ranked improvement proposals |
| `implement(hypothesis, context)` | Implement | File changes + commit message |
| `reflect(outcome)` | Reflect | Learnings + suggested adjustments |

Each method uses structured prompt templates (`PROMPTS.analyze`, etc.) that expect JSON output from the model.

### OllamaAutonomousProvider

Implementation details:
- Uses the `/api/generate` endpoint (not `/api/chat`) for simpler prompt-based interaction
- Temperature: 0.3 (lower than default for more deterministic output)
- Timeout: 300,000ms (5 min, accommodating slower local inference)
- JSON parsing: strips markdown code blocks, finds JSON objects/arrays, falls back to default values
- Cost: always $0 (local inference)

## Key Files

| File | Purpose |
|------|---------|
| `src/providers/base.ts` | `LlmProvider` interface, `GenerateRequest`, error types |
| `src/providers/ollama.ts` | Ollama provider: `/api/chat`, tool call parsing, multi-turn threading |
| `src/providers/index.ts` | `ProviderRegistry`: two-model setup, task-based routing |
| `src/providers/concurrent.ts` | Parallel inference, best-of-N generation with judge model |
| `src/tasks/classifier.ts` | Message classification: `conversation` / `simple_task` / `complex_task` |
| `src/tasks/types.ts` | `ClassificationResult`, `TaskPlan`, `TaskStep`, verification types |
| `src/autonomous/provider.ts` | `AutonomousProvider` interface for legacy 4-phase loop |
| `src/autonomous/providers/ollama.ts` | Ollama implementation of autonomous provider |
| `src/pipeline/process.ts` | Pipeline integration: classify → route → execute |
