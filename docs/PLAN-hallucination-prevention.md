# Plan: Native Tool Use API Migration

> **STATUS: COMPLETE** ✅
>
> This plan has been fully implemented. The native tool use migration was completed
> across 10 sessions. See `docs/PLAN-implementation-roadmap.md` for session details.
>
> **Key outcomes:**
> - All providers now use `generateWithTools()` instead of `generate()`
> - Router uses `route_decision` tool instead of JSON parsing
> - Daemon uses native tool loop with orchestrator
> - Old text-parsing code (`parseToolCalls()`) has been removed
> - Model: `qwen3:14b` selected for tool calling support
>
> The hallucination problem is eliminated because models must call structured tools
> to perform actions - they cannot claim actions in text without API calls.

---

## Problem Statement

The local LLM (DeepSeek V2 16B) sometimes claims to have performed actions (like "I've deleted the files") without actually executing any bash commands. This is a form of hallucination where the model generates text that implies completed actions without using the tool execution mechanism.

**Evidence from logs:**
- User asked to delete files on desktop
- Model responded: "Sure thing! I've deleted 'index.html' and 'webpage.html'"
- No `Tool call` log entry - model never executed `rm` or `trash`
- Files remained on desktop

## Root Cause Analysis

**Current architecture:**
1. Model outputs free-form text with optional bash code blocks
2. `parseToolCalls()` extracts commands from ` ```bash ``` ` blocks
3. If no code blocks found, response is sent as-is
4. Model can "lie" by generating completion text without code blocks

**OpenClaw's architecture (for comparison):**
- Uses native tool_use API via `@mariozechner/pi-agent-core`
- Model must explicitly call tools through structured API
- Cannot claim action without invoking tool - API enforces it

---

# Implementation Plan: Native Tool Use API

## Overview

Migrate from text-parsing tool execution to native tool use APIs. This requires changes across multiple layers:
1. Tool schema definitions
2. Provider interfaces and implementations
3. Daemon message processing loop
4. Model selection (tool-capable models)

---

## Phase 1: Foundation - Tool Schema & Types

### Task 1.1: Define Tool Schema Types
**File:** `src/tools/types.ts` (new)

Define TypeScript interfaces for tool schemas compatible with both Anthropic and Ollama APIs:

```typescript
export interface ToolParameter {
  type: 'string' | 'number' | 'boolean' | 'object' | 'array';
  description: string;
  enum?: string[];
  required?: boolean;
}

export interface ToolSchema {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, ToolParameter>;
    required: string[];
  };
}

export interface ToolCall {
  id: string;           // Unique ID for this call (for tool_result matching)
  name: string;         // Tool name (e.g., 'bash')
  input: Record<string, unknown>;  // Parsed arguments
}

export interface ToolResult {
  toolCallId: string;
  success: boolean;
  output?: string;
  error?: string;
}
```

**Acceptance criteria:**
- [ ] Types compile without errors
- [ ] Types are exported from `src/tools/index.ts`

### Task 1.2: Define Core Tool Schemas
**File:** `src/tools/schemas.ts` (new)

Define the bash tool and any other core tools:

```typescript
import type { ToolSchema } from './types.js';

export const BASH_TOOL: ToolSchema = {
  name: 'bash',
  description: 'Execute a shell command on the local macOS system. Use this tool for ANY action that reads, creates, modifies, or deletes files, sends messages, or interacts with the system. You MUST use this tool to perform actions - you cannot claim to have done something without calling this tool.',
  inputSchema: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'The shell command to execute (e.g., "ls -la ~/Desktop")',
      },
      workdir: {
        type: 'string',
        description: 'Working directory for the command (optional, defaults to home)',
      },
      timeout: {
        type: 'number',
        description: 'Timeout in milliseconds (optional, defaults to 30000)',
      },
    },
    required: ['command'],
  },
};

export const CORE_TOOLS: ToolSchema[] = [BASH_TOOL];
```

**Acceptance criteria:**
- [ ] Schemas follow Anthropic tool_use format
- [ ] Descriptions are clear about when to use tools
- [ ] Exported from `src/tools/index.ts`

### Task 1.3: Create Tool Registry
**File:** `src/tools/registry.ts` (new)

Registry to manage available tools and convert schemas for different providers:

```typescript
import type { ToolSchema, ToolCall, ToolResult } from './types.js';
import { CORE_TOOLS } from './schemas.js';

export interface ToolRegistry {
  getTools(): ToolSchema[];
  getTool(name: string): ToolSchema | undefined;
  formatForAnthropic(): AnthropicTool[];
  formatForOllama(): OllamaTool[];
}

export function createToolRegistry(tools?: ToolSchema[]): ToolRegistry {
  const allTools = tools ?? CORE_TOOLS;
  // ... implementation
}
```

**Acceptance criteria:**
- [ ] Can retrieve tools by name
- [ ] Can format for Anthropic API
- [ ] Can format for Ollama API

---

## Phase 2: Provider Interface Updates

### Task 2.1: Extend Base Provider Interface
**File:** `src/providers/base.ts`

Add tool-aware generation method to the provider interface:

```typescript
export interface ToolCallResponse {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface GenerateWithToolsResponse {
  text: string;
  toolCalls: ToolCallResponse[];
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens';
  providerId: string;
  model: string;
}

export interface LlmProvider {
  id: string;
  kind: ProviderKind;
  model: string;
  generate(request: GenerateRequest): Promise<GenerateResponse>;

  // New method for tool-aware generation
  generateWithTools?(
    request: GenerateRequest,
    tools: ToolSchema[],
    previousToolResults?: Array<{ callId: string; result: string }>
  ): Promise<GenerateWithToolsResponse>;

  // Check if provider supports tool use
  supportsTools?(): boolean;
}
```

**Acceptance criteria:**
- [ ] Interface is backward compatible (existing code still works)
- [ ] New methods are optional (?) for gradual migration
- [ ] Types exported properly

### Task 2.2: Implement Ollama Tool Use
**File:** `src/providers/ollama.ts`

Add tool use support using Ollama's chat API with tools:

```typescript
async generateWithTools(
  request: GenerateRequest,
  tools: ToolSchema[],
  previousToolResults?: Array<{ callId: string; result: string }>
): Promise<GenerateWithToolsResponse> {
  // Build messages array
  const messages = [
    { role: 'system', content: request.systemPrompt },
    { role: 'user', content: request.prompt },
  ];

  // Add previous tool results if any
  for (const result of previousToolResults ?? []) {
    messages.push({
      role: 'tool',
      content: result.result,
      tool_call_id: result.callId,
    });
  }

  const response = await fetch(`${this.baseUrl}/api/chat`, {
    method: 'POST',
    body: JSON.stringify({
      model: this.model,
      messages,
      tools: tools.map(t => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: t.inputSchema,
        },
      })),
      stream: false,
    }),
  });

  // Parse response and extract tool calls
  const data = await response.json();
  return {
    text: data.message?.content ?? '',
    toolCalls: (data.message?.tool_calls ?? []).map(tc => ({
      id: tc.id ?? generateId(),
      name: tc.function.name,
      input: JSON.parse(tc.function.arguments),
    })),
    stopReason: data.message?.tool_calls?.length ? 'tool_use' : 'end_turn',
    providerId: this.id,
    model: this.model,
  };
}

supportsTools(): boolean {
  // Check if model supports tools (may need runtime check)
  return true;
}
```

**Acceptance criteria:**
- [ ] Correctly formats tool schemas for Ollama
- [ ] Parses tool calls from response
- [ ] Handles models that don't support tools gracefully
- [ ] Existing `generate()` method unchanged

### Task 2.3: Implement Claude Tool Use
**File:** `src/providers/claude.ts`

Add tool use support using Anthropic's native tool_use API:

```typescript
async generateWithTools(
  request: GenerateRequest,
  tools: ToolSchema[],
  previousToolResults?: Array<{ callId: string; result: string }>
): Promise<GenerateWithToolsResponse> {
  // Build content array with previous tool results
  const content: ContentBlock[] = [
    { type: 'text', text: request.prompt }
  ];

  // Anthropic uses tool_result content blocks
  for (const result of previousToolResults ?? []) {
    content.push({
      type: 'tool_result',
      tool_use_id: result.callId,
      content: result.result,
    });
  }

  const response = await fetch(`${this.baseUrl}/v1/messages`, {
    method: 'POST',
    headers: {
      'x-api-key': this.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: this.model,
      max_tokens: request.maxTokens ?? 1024,
      system: request.systemPrompt,
      messages: [{ role: 'user', content }],
      tools: tools.map(t => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema,
      })),
    }),
  });

  const data = await response.json();

  // Parse content blocks
  const textBlocks = data.content?.filter(b => b.type === 'text') ?? [];
  const toolBlocks = data.content?.filter(b => b.type === 'tool_use') ?? [];

  return {
    text: textBlocks.map(b => b.text).join(''),
    toolCalls: toolBlocks.map(b => ({
      id: b.id,
      name: b.name,
      input: b.input,
    })),
    stopReason: data.stop_reason === 'tool_use' ? 'tool_use' : 'end_turn',
    providerId: this.id,
    model: this.model,
  };
}

supportsTools(): boolean {
  return true;
}
```

**Acceptance criteria:**
- [ ] Correctly formats tools for Anthropic API
- [ ] Handles tool_use content blocks
- [ ] Handles tool_result for multi-turn
- [ ] Existing `generate()` method unchanged

---

## Phase 3: Tool Execution Layer

### Task 3.1: Create Tool Executor
**File:** `src/tools/executor.ts` (update existing)

Refactor existing executor to work with new tool call format:

```typescript
import type { ToolCall, ToolResult, ToolSchema } from './types.js';

export interface ToolExecutor {
  execute(call: ToolCall): Promise<ToolResult>;
  canExecute(toolName: string): boolean;
}

export function createBashExecutor(options?: {
  workdir?: string;
  timeout?: number;
}): ToolExecutor {
  return {
    canExecute: (name) => name === 'bash',
    execute: async (call) => {
      const command = call.input.command as string;
      const workdir = (call.input.workdir as string) ?? options?.workdir;
      const timeout = (call.input.timeout as number) ?? options?.timeout ?? 30000;

      // Use existing executeCommand logic
      const result = executeCommand(command, timeout);

      return {
        toolCallId: call.id,
        success: result.success,
        output: result.output,
        error: result.error,
      };
    },
  };
}
```

**Acceptance criteria:**
- [ ] Works with new ToolCall format
- [ ] Returns ToolResult with toolCallId
- [ ] Preserves existing safety checks

### Task 3.2: Create Tool Orchestrator
**File:** `src/tools/orchestrator.ts` (new)

High-level orchestrator that coordinates tool execution:

```typescript
import type { ToolCall, ToolResult, ToolExecutor } from './types.js';

export interface ToolOrchestrator {
  registerExecutor(executor: ToolExecutor): void;
  executeAll(calls: ToolCall[]): Promise<ToolResult[]>;
}

export function createToolOrchestrator(): ToolOrchestrator {
  const executors: ToolExecutor[] = [];

  return {
    registerExecutor(executor) {
      executors.push(executor);
    },

    async executeAll(calls) {
      const results: ToolResult[] = [];

      for (const call of calls) {
        const executor = executors.find(e => e.canExecute(call.name));

        if (!executor) {
          results.push({
            toolCallId: call.id,
            success: false,
            error: `No executor for tool: ${call.name}`,
          });
          continue;
        }

        try {
          const result = await executor.execute(call);
          results.push(result);
        } catch (error) {
          results.push({
            toolCallId: call.id,
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error',
          });
        }
      }

      return results;
    },
  };
}
```

**Acceptance criteria:**
- [ ] Handles multiple executors
- [ ] Returns results in order
- [ ] Handles missing executors gracefully

---

## Phase 4: Daemon Integration

### Task 4.1: Update Message Processing Loop
**File:** `src/imessage/daemon.ts`

Replace text-parsing approach with native tool use:

```typescript
import { createToolRegistry } from '../tools/registry.js';
import { createToolOrchestrator, createBashExecutor } from '../tools/index.js';

// In processMessage:
const toolRegistry = createToolRegistry();
const orchestrator = createToolOrchestrator();
orchestrator.registerExecutor(createBashExecutor({ workdir: workspacePath }));

const tools = toolRegistry.getTools();
let conversationHistory: Array<{ callId: string; result: string }> = [];

while (iteration < maxToolIterations) {
  iteration++;

  // Check if provider supports tools
  if (!currentProvider.supportsTools?.() || !currentProvider.generateWithTools) {
    // Fall back to text parsing for non-tool-capable providers
    const response = await currentProvider.generate({ prompt: conversationContext });
    // ... existing text-parsing logic as fallback
    break;
  }

  // Use native tool API
  const response = await currentProvider.generateWithTools(
    { prompt: conversationContext, systemPrompt },
    tools,
    conversationHistory
  );

  safeLogger.info('Generated response (tool-aware)', {
    provider: response.providerId,
    model: response.model,
    textLength: response.text.length,
    toolCalls: response.toolCalls.length,
    stopReason: response.stopReason,
    iteration,
  });

  // If no tool calls, this is the final response
  if (response.toolCalls.length === 0) {
    finalResponse = response.text;
    break;
  }

  // Execute tool calls
  const results = await orchestrator.executeAll(response.toolCalls);

  // Log tool executions
  for (let i = 0; i < response.toolCalls.length; i++) {
    const call = response.toolCalls[i];
    const result = results[i];
    safeLogger.info('Tool execution (native)', {
      tool: call.name,
      input: JSON.stringify(call.input).substring(0, 200),
      success: result?.success,
      outputLength: result?.output?.length ?? 0,
      error: result?.error,
    });
  }

  // Add results to conversation history for next iteration
  conversationHistory = results.map(r => ({
    callId: r.toolCallId,
    result: r.success ? (r.output ?? 'Success') : `Error: ${r.error}`,
  }));

  // Include any text from the response
  if (response.text) {
    finalResponse += response.text + '\n';
  }
}
```

**Acceptance criteria:**
- [ ] Uses native tool use when available
- [ ] Falls back to text parsing when not available
- [ ] Properly chains tool results back to model
- [ ] Logs all tool executions

### Task 4.2: Update System Prompt for Tool Use
**File:** `src/interface/prompt-builder.ts`

Update capabilities section for tool-use models:

```typescript
function buildCapabilitiesSection(skills: Skill[], useNativeTools: boolean): string {
  if (skills.length === 0) {
    return `## Capabilities\n\nYou can have conversations...`;
  }

  if (useNativeTools) {
    return `## Capabilities

You have access to tools that let you interact with the local system. When you need to perform an action (read files, execute commands, etc.), use the appropriate tool.

**Important:** You can ONLY perform actions by calling tools. Any claims about actions taken (like "I've deleted the files") are meaningless unless you actually called the tool. The system will only execute actions through tool calls.

Available tools will be provided in the API request.`;
  }

  // Existing text-based instructions for fallback
  return `## Capabilities

You can execute shell commands...`;
}
```

**Acceptance criteria:**
- [ ] Different prompts for tool-use vs text-parsing modes
- [ ] Emphasizes tool-only actions

---

## Phase 5: Model Selection & Testing

### Task 5.1: Test Tool-Capable Models
**Action:** Manual testing on Mac Mini

Test these Ollama models for tool use capability:
- [ ] `qwen2.5:7b-instruct` - Known good tool support
- [ ] `llama3.1:8b-instruct` - Should support tools
- [ ] `mistral:7b-instruct` - May support tools
- [ ] `deepseek-coder-v2:16b` - Coding focus, may work

For each model, test:
1. Simple tool call: "What files are on my desktop?"
2. Action tool call: "Create a file called test.txt on my desktop"
3. Multi-step: "List files, then delete test.txt"

Document results in `docs/MODEL-TOOL-SUPPORT.md`

### Task 5.2: Update Config for Tool-Capable Model
**File:** `~/Tyrion/config/default.yaml` on Mac Mini

Once a good model is identified:
```yaml
local:
  provider: ollama
  model: qwen2.5:7b-instruct  # or whichever works best
  baseUrl: http://localhost:11434
  timeoutMs: 120000
```

### Task 5.3: Create Fallback Strategy
**File:** `src/providers/index.ts`

Add logic to detect tool support and choose strategy:

```typescript
export function buildProviders(config: AppConfig): ProviderRegistry & {
  useNativeTools: boolean;
} {
  // ... existing logic

  // Detect if local model supports tools
  const useNativeTools = checkModelToolSupport(config.local.model);

  return { local, cloud, useNativeTools };
}
```

---

## Phase 6: Cleanup & Documentation

### Task 6.1: Deprecate Text Parsing (Optional)
Keep text parsing as fallback but log warnings when used:

```typescript
if (!provider.supportsTools?.()) {
  safeLogger.warn('Using text-parsing fallback (model does not support tools)', {
    model: provider.model,
  });
}
```

### Task 6.2: Update Documentation
- [ ] Update `docs/PLAN-hallucination-prevention.md` with completion status
- [ ] Create `docs/TOOL-USE-ARCHITECTURE.md` explaining new system
- [ ] Update `CLAUDE.md` if needed

### Task 6.3: Add Tests
- [ ] Unit tests for tool schema formatting
- [ ] Unit tests for tool executor
- [ ] Integration test for full tool loop

---

## Migration Checklist

### Pre-Migration
- [ ] Current system is stable and deployed
- [ ] Logs are working for debugging

### Phase 1 Complete
- [ ] Tool types defined
- [ ] Tool schemas defined
- [ ] Tool registry created
- [ ] All exports working

### Phase 2 Complete
- [ ] Provider interface extended
- [ ] Ollama tool use implemented
- [ ] Claude tool use implemented
- [ ] Existing generate() still works

### Phase 3 Complete
- [ ] Tool executor updated
- [ ] Tool orchestrator created
- [ ] Safety checks preserved

### Phase 4 Complete
- [ ] Daemon uses native tools
- [ ] Fallback to text parsing works
- [ ] System prompt updated

### Phase 5 Complete
- [ ] Tool-capable model identified
- [ ] Model deployed to Mac Mini
- [ ] End-to-end testing passed

### Post-Migration
- [ ] Documentation updated
- [ ] Old code paths logged as deprecated
- [ ] Monitoring in place

---

## Estimated Effort

| Phase | Tasks | Estimated Time |
|-------|-------|----------------|
| Phase 1 | 3 tasks | 1-2 hours |
| Phase 2 | 3 tasks | 2-3 hours |
| Phase 3 | 2 tasks | 1-2 hours |
| Phase 4 | 2 tasks | 2-3 hours |
| Phase 5 | 3 tasks | 2-4 hours (includes model testing) |
| Phase 6 | 3 tasks | 1-2 hours |

**Total:** 9-16 hours across multiple sessions

---

## Approach 1: Response Validation Layer (ARCHIVED)

*Keeping this section for reference - this was the quick-fix approach that we decided not to pursue in favor of native tool use.*

**Goal:** Detect when the model claims to have performed an action but didn't execute any commands. Either reject/re-prompt or warn the user.

### Implementation

#### 1.1 Create Action Claim Detector

Create `src/validation/action-detector.ts`:

```typescript
/**
 * Patterns that indicate the model claims to have performed an action
 */
const ACTION_CLAIM_PATTERNS = [
  // Completion claims
  /I've (deleted|removed|created|moved|copied|renamed|sent|updated|modified|changed|added|installed|uninstalled)/i,
  /I (deleted|removed|created|moved|copied|renamed|sent|updated|modified|changed|added|installed|uninstalled)/i,
  /Done!?\s*(I |The )?.*?(deleted|removed|created|moved|copied|renamed)/i,
  /(files?|folders?|directories?|messages?|emails?) (have been|were|are now) (deleted|removed|created|sent)/i,
  /Successfully (deleted|removed|created|moved|copied|renamed|sent|updated)/i,
  /Finished (deleting|removing|creating|moving|copying|renaming|sending)/i,

  // Implicit completion
  /^(Done|Completed|Finished|All set|That's done)!?$/im,
  /the (files?|task|action|operation) (is|are) (complete|done|finished)/i,
];

/**
 * Patterns that indicate conversational/informational responses (not action claims)
 */
const INFORMATIONAL_PATTERNS = [
  /I can help you/i,
  /Would you like me to/i,
  /I'll need to/i,
  /Let me know if/i,
  /Here's what I found/i,
  /I don't have/i,
  /I'm not able to/i,
];

export interface ActionClaimResult {
  claimsAction: boolean;
  claimedActions: string[];
  confidence: number;
}

export function detectActionClaims(response: string): ActionClaimResult {
  // Skip if clearly informational
  if (INFORMATIONAL_PATTERNS.some(p => p.test(response))) {
    return { claimsAction: false, claimedActions: [], confidence: 0.9 };
  }

  const claimedActions: string[] = [];

  for (const pattern of ACTION_CLAIM_PATTERNS) {
    const match = response.match(pattern);
    if (match) {
      claimedActions.push(match[0]);
    }
  }

  return {
    claimsAction: claimedActions.length > 0,
    claimedActions,
    confidence: claimedActions.length > 0 ? 0.8 : 0.9,
  };
}
```

#### 1.2 Integrate Validation into Daemon

Modify `src/imessage/daemon.ts` tool loop:

```typescript
import { detectActionClaims } from '../validation/action-detector.js';

// After getting response, before sending:
if (toolCalls.length === 0) {
  // No tool calls - check if model is claiming to have done something
  const actionClaim = detectActionClaims(response.text);

  if (actionClaim.claimsAction) {
    safeLogger.warn('Model claimed action without tool execution', {
      claims: actionClaim.claimedActions,
      response: response.text.substring(0, 200),
    });

    // Option A: Re-prompt the model
    conversationContext += `\n\nSYSTEM: You claimed to perform an action ("${actionClaim.claimedActions[0]}") but did not execute any commands. You MUST use a bash code block to actually perform the action. Try again.`;
    continue; // Loop back for another iteration

    // Option B: Warn the user (alternative)
    // finalResponse = response.text + "\n\n⚠️ Warning: This response may contain unverified action claims.";
  }

  finalResponse = response.text;
  break;
}
```

#### 1.3 Add Re-prompt Limit

Add a counter to prevent infinite re-prompt loops:

```typescript
let repromptCount = 0;
const MAX_REPROMPTS = 2;

// In the validation check:
if (actionClaim.claimsAction) {
  if (repromptCount >= MAX_REPROMPTS) {
    safeLogger.warn('Max reprompts reached for hallucinated action');
    finalResponse = response.text + "\n\n⚠️ I was unable to execute this action. Please try again with a specific command.";
    break;
  }
  repromptCount++;
  // ... re-prompt logic
}
```

### Pros/Cons

**Pros:**
- Quick to implement
- No changes to provider API
- Works with any model
- Can be tuned with patterns

**Cons:**
- Pattern matching is imperfect
- May have false positives/negatives
- Doesn't prevent hallucination, just detects it
- Re-prompting uses extra tokens/time

---

## Approach 2: Native Tool Use API

**Goal:** Switch from text-parsing to structured tool calling API, making it impossible for the model to claim actions without calling tools.

### Implementation

#### 2.1 Define Tool Schema

Create `src/tools/schemas.ts`:

```typescript
export const TOOL_SCHEMAS = {
  bash: {
    name: 'bash',
    description: 'Execute a shell command on the local system. Use this for ANY action that modifies files, sends messages, or interacts with the system.',
    input_schema: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'The shell command to execute',
        },
        workdir: {
          type: 'string',
          description: 'Working directory (optional)',
        },
      },
      required: ['command'],
    },
  },
  // Add more tools as needed
};
```

#### 2.2 Update Ollama Provider for Tool Use

Modify `src/providers/ollama.ts`:

```typescript
export interface OllamaToolCall {
  function: {
    name: string;
    arguments: string; // JSON string
  };
}

export interface OllamaGenerateResponse {
  text: string;
  toolCalls?: OllamaToolCall[];
}

export class OllamaProvider implements LlmProvider {
  // ...existing code...

  async generateWithTools(
    request: GenerateRequest,
    tools: ToolSchema[]
  ): Promise<OllamaGenerateResponse> {
    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        messages: [
          { role: 'system', content: request.systemPrompt },
          { role: 'user', content: request.prompt },
        ],
        tools: tools.map(t => ({
          type: 'function',
          function: {
            name: t.name,
            description: t.description,
            parameters: t.input_schema,
          },
        })),
        stream: false,
      }),
    });

    const data = await response.json();

    return {
      text: data.message?.content ?? '',
      toolCalls: data.message?.tool_calls,
    };
  }
}
```

#### 2.3 Update Claude Provider for Tool Use

Modify `src/providers/claude.ts`:

```typescript
async generateWithTools(
  request: GenerateRequest,
  tools: ToolSchema[]
): Promise<GenerateResponseWithTools> {
  const response = await fetch(`${this.baseUrl}/v1/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': this.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: this.model,
      max_tokens: request.maxTokens ?? 1024,
      system: request.systemPrompt,
      messages: [{ role: 'user', content: request.prompt }],
      tools: tools,
    }),
  });

  const data = await response.json();

  // Parse content blocks
  const textBlocks = data.content?.filter(b => b.type === 'text') ?? [];
  const toolBlocks = data.content?.filter(b => b.type === 'tool_use') ?? [];

  return {
    text: textBlocks.map(b => b.text).join(''),
    toolCalls: toolBlocks.map(b => ({
      id: b.id,
      name: b.name,
      input: b.input,
    })),
    stopReason: data.stop_reason,
  };
}
```

#### 2.4 Update Daemon Loop for Tool Use

Modify `src/imessage/daemon.ts`:

```typescript
import { TOOL_SCHEMAS } from '../tools/schemas.js';

// In processMessage:
const tools = [TOOL_SCHEMAS.bash];

while (iteration < maxToolIterations) {
  iteration++;

  const response = await currentProvider.generateWithTools(
    { prompt: conversationContext, systemPrompt },
    tools
  );

  // Tool calls come from structured API, not text parsing
  if (!response.toolCalls || response.toolCalls.length === 0) {
    // Model chose not to call tools - this IS the final answer
    // No way to hallucinate an action here
    finalResponse = response.text;
    break;
  }

  // Execute tool calls
  for (const toolCall of response.toolCalls) {
    if (toolCall.name === 'bash') {
      const command = toolCall.input.command;
      safeLogger.info('Tool call (native)', { tool: 'bash', command });

      const result = executeCommand(command);

      // Add tool result to conversation for next iteration
      conversationContext += `\n\nTool Result (${toolCall.id}):\n${result.output || result.error}`;
    }
  }
}
```

#### 2.5 Model Compatibility Check

Not all Ollama models support tool use. Need to check model capabilities:

```typescript
// Check if model supports tools
async function modelSupportsTools(model: string, baseUrl: string): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl}/api/show`, {
      method: 'POST',
      body: JSON.stringify({ name: model }),
    });
    const data = await response.json();
    // Check model family or capabilities
    return data.details?.family === 'llama' ||
           model.includes('qwen') ||
           model.includes('mistral');
  } catch {
    return false;
  }
}
```

### Model Recommendations for Tool Use

Models with good tool/function calling support:
- `qwen2.5:7b-instruct` - Good tool use, smaller
- `mistral:7b-instruct` - Decent tool use
- `llama3.1:8b-instruct` - Supports tools
- `deepseek-coder-v2:16b` - Better for coding tasks

Models to avoid for tool use:
- `deepseek-v2:16b-lite-chat` - Chat-focused, weak tool use

### Pros/Cons

**Pros:**
- Eliminates hallucination structurally
- Model cannot claim action without calling tool
- Cleaner separation of text vs actions
- Better alignment with how frontier models work

**Cons:**
- Requires model that supports tool use
- More complex implementation
- May need to switch local model
- Some models have weak tool-use capabilities

---

## Recommendation

**Phase 1 (Quick fix):** Implement Approach 1 (validation layer)
- Can be done in ~1 hour
- Works with current model
- Catches most hallucinations
- Provides immediate improvement

**Phase 2 (Better solution):** Migrate to Approach 2 (native tool use)
- Test which Ollama models support tools well
- May need to switch from DeepSeek V2 to Qwen 2.5 or Llama 3.1
- Implement tool use API for both providers
- More robust long-term solution

---

## Files to Modify

### Approach 1
- Create: `src/validation/action-detector.ts`
- Modify: `src/imessage/daemon.ts`
- Modify: `src/validation/index.ts` (exports)

### Approach 2
- Create: `src/tools/schemas.ts`
- Modify: `src/providers/base.ts` (add interface)
- Modify: `src/providers/ollama.ts` (add tool use)
- Modify: `src/providers/claude.ts` (add tool use)
- Modify: `src/imessage/daemon.ts` (use new API)
- May need: New local model download

---

## Testing Plan

1. Send action request: "Delete the files on my desktop"
2. Verify model either:
   - (Approach 1) Gets re-prompted if it hallucinates
   - (Approach 2) Must call bash tool to claim completion
3. Verify files are actually deleted when model says they are
4. Test edge cases:
   - Informational responses (should not trigger validation)
   - Multi-step actions
   - Failed commands
