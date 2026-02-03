# Casterly API Reference

This document provides detailed API reference for Casterly's core modules.

## Table of Contents

- [Providers](#providers)
- [Router](#router)
- [Security](#security)
- [Interface Layer](#interface-layer)
- [Skills](#skills)
- [Configuration](#configuration)

---

## Providers

### `src/providers/base.ts`

#### `LlmProvider` Interface

```typescript
interface LlmProvider {
  id: string;
  kind: ProviderKind;
  model: string;
  generate(request: GenerateRequest): Promise<GenerateResponse>;
}
```

| Property | Type | Description |
|----------|------|-------------|
| `id` | `string` | Provider identifier (e.g., "ollama", "claude") |
| `kind` | `ProviderKind` | Either "local" or "cloud" |
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

#### `GenerateResponse`

```typescript
interface GenerateResponse {
  text: string;
  providerId: string;
  model: string;
}
```

| Property | Type | Description |
|----------|------|-------------|
| `text` | `string` | LLM response text |
| `providerId` | `string` | Which provider generated the response |
| `model` | `string` | Which model was used |

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
  // Thrown when cloud provider has billing issues
  // Triggers fallback to local provider
}
```

---

### `src/providers/ollama.ts`

#### `OllamaProvider` Class

```typescript
class OllamaProvider implements LlmProvider {
  constructor(config: OllamaConfig)
  generate(request: GenerateRequest): Promise<GenerateResponse>
}
```

#### `OllamaConfig`

```typescript
interface OllamaConfig {
  model: string;
  baseUrl: string;      // Default: "http://localhost:11434"
  timeoutMs?: number;   // Default: 30000
}
```

---

### `src/providers/claude.ts`

#### `ClaudeProvider` Class

```typescript
class ClaudeProvider implements LlmProvider {
  constructor(config: ClaudeConfig)
  generate(request: GenerateRequest): Promise<GenerateResponse>
}
```

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
  cloud: LlmProvider;
}
```

Creates provider instances from application configuration.

---

## Router

### `src/router/index.ts`

#### `routeRequest()`

```typescript
async function routeRequest(
  input: string,
  deps: RouterDependencies
): Promise<RouteDecision>
```

Main routing function that determines whether a request should go to local or cloud provider.

#### `RouteDecision`

```typescript
interface RouteDecision {
  route: 'local' | 'cloud';
  reason: string;
  confidence: number;           // 0.0 to 1.0
  sensitiveCategories: SensitiveCategory[];
}
```

| Property | Type | Description |
|----------|------|-------------|
| `route` | `'local' \| 'cloud'` | Routing decision |
| `reason` | `string` | Human-readable explanation |
| `confidence` | `number` | Confidence score (0.0-1.0) |
| `sensitiveCategories` | `SensitiveCategory[]` | Detected sensitive categories |

#### `RouterDependencies`

```typescript
interface RouterDependencies {
  localProvider: LlmProvider;
  config: RouterConfig;
}
```

---

### `src/router/classifier.ts`

#### `classifyWithLlm()`

```typescript
async function classifyWithLlm(
  input: string,
  provider: LlmProvider,
  config: RouterConfig
): Promise<ClassificationResult>
```

Uses local LLM to classify ambiguous requests.

#### `ClassificationResult`

```typescript
interface ClassificationResult {
  route: 'local' | 'cloud';
  reason: string;
  confidence: number;
}
```

---

### `src/router/patterns.ts`

#### `matchSensitivePatterns()`

```typescript
function matchSensitivePatterns(
  input: string
): PatternMatchResult
```

Fast regex-based pattern matching for obvious sensitive content.

#### `PatternMatchResult`

```typescript
interface PatternMatchResult {
  matched: boolean;
  categories: SensitiveCategory[];
  patterns: string[];           // Which patterns matched
}
```

#### `SensitiveCategory`

```typescript
type SensitiveCategory =
  | 'calendar'
  | 'finances'
  | 'health'
  | 'credentials'
  | 'documents'
  | 'contacts'
  | 'voice_memos';
```

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
  content: string;
  timestamp: number;
}
```

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
}
```

#### `SkillFrontmatter`

```typescript
interface SkillFrontmatter {
  name: string;
  description: string;
  homepage?: string;
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
function loadSkills(
  skillsPath: string
): Promise<Skill[]>
```

Discovers and loads skills from a directory.

---

### `src/skills/executor.ts`

#### `parseToolCalls()`

```typescript
function parseToolCalls(
  response: string
): ToolCall[]
```

Extracts bash commands from LLM response.

#### `ToolCall`

```typescript
interface ToolCall {
  type: 'bash';
  command: string;
}
```

#### `executeCommand()`

```typescript
function executeCommand(
  command: string,
  timeout?: number
): ExecutionResult
```

Executes a shell command with safety checks.

#### `ExecutionResult`

```typescript
interface ExecutionResult {
  success: boolean;
  output?: string;
  error?: string;
  exitCode?: number;
}
```

#### Safety Gates

Commands are classified into three categories:

| Category | Behavior | Examples |
|----------|----------|----------|
| **BLOCKED** | Never executed | `rm -rf /`, `mkfs`, fork bombs |
| **APPROVAL_REQUIRED** | User confirmation needed | `rm`, `sudo`, `mv`, `chmod` |
| **SAFE** | Executed immediately | `ls`, `cat`, `grep`, `curl` |

---

## Configuration

### `src/config/schema.ts`

#### `AppConfig`

```typescript
interface AppConfig {
  local: LocalProviderConfig;
  cloud: CloudProviderConfig;
  router: RouterConfig;
  sensitivity: SensitivityConfig;
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

#### `CloudProviderConfig`

```typescript
interface CloudProviderConfig {
  provider: 'claude';
  model: string;
  apiKey?: string;
  apiKeyEnv: string;
  baseUrl?: string;
  timeoutMs?: number;
}
```

#### `RouterConfig`

```typescript
interface RouterConfig {
  defaultRoute: 'local' | 'cloud';
  confidenceThreshold: number;  // 0.0 to 1.0
}
```

#### `SensitivityConfig`

```typescript
interface SensitivityConfig {
  alwaysLocal: SensitiveCategory[];
}
```

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
    cloud: LlmProvider;
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

### Basic Generation

```typescript
import { buildProviders } from './providers';
import { loadConfig } from './config';

const config = loadConfig();
const providers = buildProviders(config);

const response = await providers.local.generate({
  prompt: "What is the capital of France?",
  systemPrompt: "You are a helpful assistant."
});

console.log(response.text);
```

### Routing a Request

```typescript
import { routeRequest } from './router';

const decision = await routeRequest(
  "What's on my calendar today?",
  { localProvider: providers.local, config: config.router }
);

if (decision.route === 'local') {
  // Use local provider for privacy
}
```

### Building Context

```typescript
import { buildSystemPrompt, assembleContext } from './interface';

const prompt = buildSystemPrompt({
  mode: 'full',
  skills: [],
  channel: 'cli'
});

const context = assembleContext({
  systemPrompt: prompt.systemPrompt,
  history: session.getHistory(),
  currentMessage: userInput
});
```
