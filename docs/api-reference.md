# Casterly API Reference

This document provides detailed API reference for Casterly's core modules.

## Table of Contents

- [Providers](#providers)
- [Tools](#tools)
- [Security](#security)
- [Interface Layer](#interface-layer)
- [Skills](#skills)
- [Configuration](#configuration)

> **Note**: This is the Mac Studio M4 Max Edition. All inference runs locally via Ollama.

---

## Providers

### `src/providers/base.ts`

#### `LlmProvider` Interface

```typescript
interface LlmProvider {
  id: string;
  kind: ProviderKind;
  model: string;
  generateWithTools(
    request: GenerateRequest,
    tools: ToolSchema[],
    previousResults?: ToolResultMessage[]
  ): Promise<GenerateWithToolsResponse>;
}
```

| Property | Type | Description |
|----------|------|-------------|
| `id` | `string` | Provider identifier ("ollama") |
| `kind` | `ProviderKind` | Always "local" for Mac Studio |
| `model` | `string` | Model identifier |

#### `GenerateRequest`

```typescript
interface GenerateRequest {
  prompt: string;
  systemPrompt?: string;
  maxTokens?: number;
  temperature?: number;
}
```

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `prompt` | `string` | required | User message and context |
| `systemPrompt` | `string` | `undefined` | System instructions |
| `maxTokens` | `number` | `1024` | Maximum response tokens |
| `temperature` | `number` | `0.7` | Creativity (0.0-1.0) |

#### `GenerateWithToolsResponse`

```typescript
interface GenerateWithToolsResponse {
  text: string;
  toolCalls: NativeToolCall[];
  providerId: string;
  model: string;
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence';
}
```

| Property | Type | Description |
|----------|------|-------------|
| `text` | `string` | LLM response text |
| `toolCalls` | `NativeToolCall[]` | Structured tool call requests |
| `providerId` | `string` | Which provider generated the response |
| `model` | `string` | Which model was used |
| `stopReason` | `string` | Why generation stopped |

#### `ProviderError`

```typescript
class ProviderError extends Error {
  constructor(
    message: string,
    public providerId: string,
    public cause?: Error
  )
}
```

#### `BillingError`

```typescript
class BillingError extends ProviderError {
  // Legacy: Not used in local-only mode
}
```

---

### `src/providers/ollama.ts`

#### `OllamaProvider` Class

```typescript
class OllamaProvider implements LlmProvider {
  constructor(config: OllamaConfig)
  generateWithTools(
    request: GenerateRequest,
    tools: ToolSchema[],
    previousResults?: ToolResultMessage[]
  ): Promise<GenerateWithToolsResponse>
}
```

Uses Ollama's `/api/chat` endpoint with OpenAI-compatible tool format.

#### `OllamaConfig`

```typescript
interface OllamaConfig {
  model: string;        // Must be tool-capable (e.g., qwen3:14b)
  baseUrl: string;      // Default: "http://localhost:11434"
  timeoutMs?: number;   // Default: 60000 (14B models need longer)
}
```

---

### `src/providers/claude.ts`

#### `ClaudeProvider` Class

```typescript
class ClaudeProvider implements LlmProvider {
  constructor(config: ClaudeConfig)
  generateWithTools(
    request: GenerateRequest,
    tools: ToolSchema[],
    previousResults?: ToolResultMessage[]
  ): Promise<GenerateWithToolsResponse>
}
```

Uses Anthropic Messages API with `tool_use` and `tool_result` content blocks.

#### `ClaudeConfig`

```typescript
interface ClaudeConfig {
  model: string;
  apiKey: string;
  baseUrl?: string;     // Default: "https://api.anthropic.com"
  timeoutMs?: number;   // Default: 45000
}
```

---

### `src/providers/index.ts`

#### `buildProviders()`

```typescript
function buildProviders(config: AppConfig): {
  local: LlmProvider;
}
```

Creates the Ollama provider instance from configuration. Mac Studio Edition only uses local providers.

---

## Tools

### `src/tools/schemas/types.ts`

#### `ToolSchema`

```typescript
interface ToolSchema {
  name: string;
  description: string;
  inputSchema: ToolInputSchema;
}
```

#### `ToolInputSchema`

```typescript
interface ToolInputSchema {
  type: 'object';
  properties: Record<string, ToolProperty>;
  required: string[];  // Non-optional
}
```

#### `ToolProperty`

```typescript
type JsonSchemaType = 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array' | 'null';

interface ToolProperty {
  type: JsonSchemaType;
  description: string;
  enum?: string[];                            // For string enums
  items?: ToolProperty;                       // For array item types
  properties?: Record<string, ToolProperty>;  // For nested objects
  required?: string[];                        // For nested object requirements
}
```

#### `NativeToolCall`

```typescript
interface NativeToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}
```

| Property | Type | Description |
|----------|------|-------------|
| `id` | `string` | Unique call ID for result matching |
| `name` | `string` | Tool name (e.g., "bash") |
| `input` | `object` | Tool-specific parameters |

#### `NativeToolResult`

```typescript
interface NativeToolResult {
  toolCallId: string;
  success: boolean;
  output?: string;
  error?: string;
  exitCode?: number;
}
```

#### `ToolResultMessage`

```typescript
interface ToolResultMessage {
  callId: string;
  result: string;
  isError?: boolean;
}
```

Used for multi-turn tool conversations.

---

### `src/tools/schemas/core.ts`

#### `BASH_TOOL`

```typescript
const BASH_TOOL: ToolSchema = {
  name: 'bash',
  description: 'Execute a shell command on the local system.',
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The shell command to execute.' }
    },
    required: ['command']
  }
};
```

---

### `src/tools/executor.ts`

#### `executeBashToolCall()`

```typescript
function executeBashToolCall(
  call: NativeToolCall,
  options?: BashExecutorOptions
): Promise<NativeToolResult>
```

Executes a bash command with safety checks.

#### `createBashExecutor()`

```typescript
function createBashExecutor(
  options?: BashExecutorOptions
): NativeToolExecutor
```

Creates a reusable bash executor for the orchestrator.

#### Safety Gates

Commands are classified into three categories:

| Category | Behavior | Examples |
|----------|----------|----------|
| **BLOCKED** | Never executed | `rm -rf /`, `mkfs`, fork bombs |
| **APPROVAL_REQUIRED** | User confirmation needed | `rm`, `sudo`, `mv`, `chmod` |
| **SAFE** | Executed immediately | `ls`, `cat`, `grep`, `curl` |

---

### `src/tools/orchestrator.ts`

#### `ToolOrchestrator` Interface

```typescript
interface ToolOrchestrator {
  registerExecutor(executor: NativeToolExecutor): void;
  canExecute(toolName: string): boolean;
  execute(call: NativeToolCall): Promise<NativeToolResult>;
  executeAll(calls: NativeToolCall[]): Promise<NativeToolResult[]>;
  getRegisteredTools(): string[];
}
```

#### `createToolOrchestrator()`

```typescript
function createToolOrchestrator(): ToolOrchestrator
```

Creates a tool orchestrator for managing multiple executors.

---

### `src/tools/schemas/registry.ts`

#### `ToolRegistry` Interface

```typescript
interface ToolRegistry {
  register(tool: ToolSchema): void;
  get(name: string): ToolSchema | undefined;
  getTools(): ToolSchema[];
  has(name: string): boolean;
}
```

#### `createToolRegistry()`

```typescript
function createToolRegistry(): ToolRegistry
```

Creates a tool registry with core tools pre-registered.

---

## Security

### `src/security/detector.ts`

#### `detectSensitiveContent()`

```typescript
function detectSensitiveContent(
  text: string,
  options?: SensitiveDetectionOptions
): SensitiveDetectionResult
```

Detects sensitive content in text.

#### `SensitiveDetectionOptions`

```typescript
interface SensitiveDetectionOptions {
  categories?: SensitiveCategory[];  // Categories to check (default: all)
  strict?: boolean;                   // Stricter matching (default: false)
}
```

#### `SensitiveDetectionResult`

```typescript
interface SensitiveDetectionResult {
  isSensitive: boolean;
  categories: SensitiveCategory[];
  reasons: string[];
}
```

---

### `src/security/redactor.ts`

#### `redactSensitiveText()`

```typescript
function redactSensitiveText(text: string): string
```

Replaces sensitive patterns with `[REDACTED]`.

**Redacted patterns include:**
- Social Security Numbers
- Credit card numbers
- API keys and tokens
- Passwords
- Email addresses (optionally)
- Phone numbers (optionally)

---

### `src/logging/safe-logger.ts`

#### `safeLogger`

```typescript
const safeLogger: {
  info(message: string, data?: object): void;
  warn(message: string, data?: object): void;
  error(message: string, data?: object): void;
  debug(message: string, data?: object): void;
}
```

All data is automatically redacted before logging.

---

## Interface Layer

### `src/interface/bootstrap.ts`

#### `loadBootstrapFiles()`

```typescript
function loadBootstrapFiles(
  workspacePath: string,
  config?: BootstrapConfig
): BootstrapContent
```

Loads workspace files (SOUL.md, IDENTITY.md, etc.) for system prompt.

#### `BootstrapConfig`

```typescript
interface BootstrapConfig {
  maxFileSize?: number;     // Default: 20000 characters
  files?: string[];         // Default: ['IDENTITY.md', 'SOUL.md', 'TOOLS.md', 'USER.md']
}
```

#### `BootstrapContent`

```typescript
interface BootstrapContent {
  identity?: string;
  soul?: string;
  tools?: string;
  user?: string;
  combined: string;         // All files concatenated
}
```

---

### `src/interface/prompt-builder.ts`

#### `buildSystemPrompt()`

```typescript
function buildSystemPrompt(
  options: PromptBuilderOptions
): BuiltPrompt
```

Assembles complete system prompt from all components.

#### `PromptBuilderOptions`

```typescript
interface PromptBuilderOptions {
  mode: 'full' | 'minimal' | 'none';
  skills: Skill[];
  timezone?: string;
  channel: 'imessage' | 'cli' | 'web';
  bootstrap?: BootstrapContent;
  memory?: string;
}
```

| Property | Type | Description |
|----------|------|-------------|
| `mode` | `string` | Prompt verbosity level |
| `skills` | `Skill[]` | Available skills to include |
| `timezone` | `string` | User's timezone |
| `channel` | `string` | Communication channel |
| `bootstrap` | `BootstrapContent` | Loaded workspace files |
| `memory` | `string` | Long-term memory content |

#### `BuiltPrompt`

```typescript
interface BuiltPrompt {
  systemPrompt: string;
  sections: {
    identity: string;
    bootstrap: string;
    capabilities: string;
    skills: string;
    memory: string;
    safety: string;
    context: string;
    guidelines: string;
  }
}
```

---

### `src/interface/context.ts`

#### `assembleContext()`

```typescript
function assembleContext(
  options: ContextAssemblyOptions
): AssembledContext
```

Combines system prompt, history, and current message within token budget.

#### `ContextAssemblyOptions`

```typescript
interface ContextAssemblyOptions {
  systemPrompt: string;
  history: ConversationMessage[];
  currentMessage: string;
  maxTokens?: number;       // Default: 4096
}
```

#### `AssembledContext`

```typescript
interface AssembledContext {
  context: string;
  systemPrompt: string;
  history: string;
  currentMessage: string;
  historyMessagesIncluded: number;
  estimatedTokens: number;
}
```

---

### `src/interface/session.ts`

#### `createSession()`

```typescript
function createSession(
  sessionId: string,
  options?: SessionOptions
): Session
```

Creates a new conversation session.

#### `SessionOptions`

```typescript
interface SessionOptions {
  scope?: SessionScope;
  storagePath?: string;
  maxMessages?: number;     // Default: 100
}
```

#### `SessionScope`

```typescript
type SessionScope = 'main' | 'per-peer' | 'per-channel';
```

| Scope | Description |
|-------|-------------|
| `main` | Single shared session |
| `per-peer` | Separate session per contact |
| `per-channel` | Separate session per channel |

#### `Session` Interface

```typescript
interface Session {
  state: SessionState;
  addMessage(message: Omit<ConversationMessage, 'timestamp'>): void;
  getHistory(maxMessages?: number): ConversationMessage[];
  clear(): void;
  save(): void;
}
```

#### `ConversationMessage`

```typescript
interface ConversationMessage {
  role: 'user' | 'assistant' | 'system';
  content: MessageContent;  // string | ContentBlock[]
  timestamp: string;
  sender?: string;
}
```

#### `ContentBlock` Types

```typescript
type TextBlock = { type: 'text'; text: string };
type ToolUseBlock = { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> };
type ToolResultBlock = { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };

type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;
type MessageContent = string | ContentBlock[];
```

#### `getMessageText()`

```typescript
function getMessageText(message: ConversationMessage): string
```

Extracts text content from a message (handles both string and content blocks).

---

### `src/interface/memory.ts`

#### `MemoryManager`

```typescript
interface MemoryManager {
  load(): Promise<string>;
  save(content: string): Promise<void>;
  append(entry: string): Promise<void>;
  clear(): Promise<void>;
}
```

Manages long-term memory persistence.

---

## Skills

### `src/skills/types.ts`

#### `Skill`

```typescript
interface Skill {
  id: string;
  frontmatter: SkillFrontmatter;
  instructions: string;
  path: string;
  available: boolean;
  unavailableReason?: string;
  tools: ToolSchema[];  // Native tools defined by this skill
}
```

#### `SkillFrontmatter`

```typescript
interface SkillFrontmatter {
  name: string;
  description: string;
  homepage?: string;
  tools?: ToolSchema[];  // Native tool definitions
  metadata?: {
    openclaw?: {
      emoji?: string;
      os?: ('darwin' | 'linux' | 'win32')[];
      requires?: {
        bins?: string[];      // Required binaries
        envVars?: string[];   // Required env vars
      };
      install?: SkillInstallOption[];
    }
  }
}
```

---

### `src/skills/loader.ts`

#### `loadSkills()`

```typescript
function loadSkills(): Map<string, Skill>
```

Discovers and loads skills from configured directories.

#### `createSkillRegistry()`

```typescript
function createSkillRegistry(): SkillRegistry
```

Creates a skill registry for managing skills.

#### `SkillRegistry`

```typescript
interface SkillRegistry {
  skills: Map<string, Skill>;
  get(id: string): Skill | undefined;
  getAvailable(): Skill[];
  getPromptSection(): string;
  getRelevantSkillInstructions(message: string): string;
  getTools(): ToolSchema[];  // Collect tools from all skills
  reload(): Promise<void>;
}
```

---

## Configuration

### `src/config/schema.ts`

#### `AppConfig`

```typescript
interface AppConfig {
  local: LocalProviderConfig;
}
```

#### `LocalProviderConfig`

```typescript
interface LocalProviderConfig {
  provider: 'ollama';
  model: string;
  baseUrl: string;
  timeoutMs?: number;
}
```

Mac Studio Edition - all configuration is for local Ollama provider only.

---

### `src/config/index.ts`

#### `loadConfig()`

```typescript
function loadConfig(
  configPath?: string
): AppConfig
```

Loads and validates configuration from YAML file.

**Default path:** `config/default.yaml`

---

## iMessage Integration

### `src/imessage/daemon.ts`

#### `startDaemon()`

```typescript
function startDaemon(
  config: DaemonConfig
): Promise<void>
```

Starts the iMessage polling daemon.

#### `DaemonConfig`

```typescript
interface DaemonConfig {
  pollInterval?: number;    // Default: 2000ms
  providers: {
    local: LlmProvider;
  };
  workspacePath?: string;
}
```

---

### `src/imessage/reader.ts`

#### `readNewMessages()`

```typescript
function readNewMessages(
  sinceTimestamp: number
): Promise<IncomingMessage[]>
```

Reads new messages from iMessage database.

---

### `src/imessage/sender.ts`

#### `sendMessage()`

```typescript
function sendMessage(
  chatId: string,
  text: string
): Promise<void>
```

Sends a message via iMessage.

---

## Error Handling

All modules follow consistent error handling:

```typescript
try {
  const result = await provider.generate(request);
} catch (error) {
  if (error instanceof BillingError) {
    // Fallback to local provider
  } else if (error instanceof ProviderError) {
    // Log and retry or fail
  } else {
    // Unknown error
  }
}
```

---

## Usage Examples

### Basic Generation with Tools

```typescript
import { buildProviders } from './providers';
import { loadConfig } from './config';
import { createToolRegistry } from './tools';

const config = loadConfig();
const providers = buildProviders(config);
const toolRegistry = createToolRegistry();

const response = await providers.local.generateWithTools(
  {
    prompt: "What files are on the desktop?",
    systemPrompt: "You are a helpful assistant."
  },
  toolRegistry.getTools()
);

if (response.toolCalls.length > 0) {
  // Execute tool calls
  console.log('Tool requested:', response.toolCalls[0].name);
} else {
  console.log(response.text);
}
```

### Native Tool Loop

```typescript
import { createToolOrchestrator, createBashExecutor } from './tools';

const orchestrator = createToolOrchestrator();
orchestrator.registerExecutor(createBashExecutor());

let previousResults: ToolResultMessage[] = [];

while (true) {
  const response = await provider.generateWithTools(
    { prompt, systemPrompt },
    toolRegistry.getTools(),
    previousResults
  );

  if (response.toolCalls.length === 0) {
    console.log(response.text);
    break;
  }

  const results = await orchestrator.executeAll(response.toolCalls);
  previousResults = results.map(r => ({
    callId: r.toolCallId,
    result: r.success ? r.output! : `Error: ${r.error}`,
    isError: !r.success
  }));
}
```
