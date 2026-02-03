# Implementation Roadmap: Native Tool Use Migration

This document provides a detailed, session-by-session breakdown for implementing native tool use and bundled architecture improvements.

**Total Scope:** ~12-15 hours across 8 sessions

> **Note:** This is a clean migration—no backwards compatibility with text-parsing. The old `parseToolCalls()` approach will be removed entirely.

---

## Session 1: Foundation Types & Interfaces
**Estimated Time:** 1.5-2 hours
**Dependencies:** None
**Risk:** Low

### Objectives
- Define all new TypeScript types for native tool use
- Replace provider interface with tool-aware version
- Remove text-parsing types

### Tasks

#### 1.1 Create Tool Schema Types
**File:** `src/tools/schemas/types.ts` (new)

```typescript
// Define these interfaces:
- ToolParameter
- ToolInputSchema
- ToolSchema
- NativeToolCall (with id, name, input)
- NativeToolResult (with toolCallId, success, output, error)
- ToolCallResponse (provider response format)
- GenerateWithToolsResponse
```

**Acceptance Criteria:**
- [ ] All types compile without errors
- [ ] Types match Anthropic tool_use format
- [ ] Types are flexible enough for Ollama format
- [ ] Exported from `src/tools/schemas/index.ts`

#### 1.2 Define Core Tool Schemas
**File:** `src/tools/schemas/core.ts` (new)

```typescript
// Define tool schemas for:
- BASH_TOOL (command execution)
- ROUTE_DECISION_TOOL (for router)
```

**Acceptance Criteria:**
- [ ] Schemas follow Anthropic format
- [ ] Descriptions are clear about when to use
- [ ] Include all required/optional parameters

#### 1.3 Replace Provider Interface
**File:** `src/providers/base.ts`

```typescript
// Replace existing interface:
interface LlmProvider {
  id: string;
  kind: ProviderKind;
  model: string;

  // Remove old generate() - all generation uses tools now
  generateWithTools(
    request: GenerateRequest,
    tools: ToolSchema[],
    previousResults?: ToolResultMessage[]
  ): Promise<GenerateWithToolsResponse>;
}
```

**Acceptance Criteria:**
- [ ] Old `generate()` method removed
- [ ] All providers implement `generateWithTools()`
- [ ] Types are clean and simple

#### 1.4 Create Tool Registry
**File:** `src/tools/schemas/registry.ts` (new)

```typescript
// Implement:
- ToolRegistry interface
- createToolRegistry() factory
- formatForAnthropic() converter
- formatForOllama() converter
```

**Acceptance Criteria:**
- [ ] Can register and retrieve tools
- [ ] Format conversion works for both providers

### Session 1 Deliverables
- [ ] New `src/tools/schemas/` directory with types
- [ ] Updated `src/providers/base.ts` with extended interface
- [ ] All existing tests still pass
- [ ] Commit: "feat(tools): add native tool use types and schemas"

---

## Session 2: Ollama Provider Tool Support
**Estimated Time:** 2-2.5 hours
**Dependencies:** Session 1
**Risk:** Medium (API behavior may vary by model)

### Objectives
- Implement `generateWithTools()` for Ollama
- Test with multiple models to find best tool support
- Document model compatibility

### Tasks

#### 2.1 Implement Ollama Tool Use
**File:** `src/providers/ollama.ts`

```typescript
// Add methods:
- getCapabilities(): ProviderCapabilities
- supportsTools(): boolean
- generateWithTools(request, tools, previousResults): Promise<GenerateWithToolsResponse>
```

**Implementation Notes:**
- Use `/api/chat` endpoint (not `/api/generate`)
- Format tools as OpenAI-compatible function calls
- Handle `tool_calls` in response message
- Generate unique IDs for tool calls if not provided

**Acceptance Criteria:**
- [ ] Correctly formats tool schemas for Ollama
- [ ] Parses tool calls from response
- [ ] Returns structured `GenerateWithToolsResponse`
- [ ] Throws clear error if model doesn't support tools

#### 2.2 Add Ollama Chat Types
**File:** `src/providers/ollama.ts`

```typescript
// Add internal types:
- OllamaChatRequest
- OllamaChatResponse
- OllamaToolCall
- OllamaMessage
```

#### 2.3 Test Model Compatibility
**Action:** Manual testing (document results)

Test these models with a simple tool call:
- [ ] `qwen2.5:7b-instruct`
- [ ] `llama3.1:8b-instruct`
- [ ] `mistral:7b-instruct`
- [ ] `deepseek-coder-v2:16b`

**Test cases:**
1. "What files are on the desktop?" → Should call bash tool
2. "Create a file called test.txt" → Should call bash tool
3. "What is 2+2?" → Should NOT call tool

#### 2.4 Document Model Support
**File:** `docs/MODEL-TOOL-SUPPORT.md` (new)

Document:
- Which models support tools
- Quality of tool use per model
- Recommended default model
- Known issues/workarounds

### Session 2 Deliverables
- [ ] Working `generateWithTools()` for Ollama
- [ ] Model compatibility documentation
- [ ] Commit: "feat(ollama): implement native tool use support"

---

## Session 3: Claude Provider Tool Support
**Estimated Time:** 1.5-2 hours
**Dependencies:** Session 1
**Risk:** Low (well-documented API)

### Objectives
- Implement `generateWithTools()` for Claude
- Handle multi-turn tool conversations
- Test with Claude API

### Tasks

#### 3.1 Implement Claude Tool Use
**File:** `src/providers/claude.ts`

```typescript
// Add methods:
- getCapabilities(): ProviderCapabilities
- supportsTools(): boolean
- generateWithTools(request, tools, previousResults): Promise<GenerateWithToolsResponse>
```

**Implementation Notes:**
- Use existing `/v1/messages` endpoint
- Add `tools` array to request body
- Handle `tool_use` content blocks in response
- Handle `tool_result` for multi-turn

**Acceptance Criteria:**
- [ ] Correctly formats tools for Anthropic API
- [ ] Handles `tool_use` content blocks
- [ ] Handles `tool_result` for multi-turn conversations
- [ ] Returns structured `GenerateWithToolsResponse`

#### 3.2 Add Claude Tool Types
**File:** `src/providers/claude.ts`

```typescript
// Add internal types:
- ClaudeToolDefinition
- ClaudeToolUseBlock
- ClaudeToolResultBlock
- ClaudeContentBlock (union type)
```

#### 3.3 Handle Multi-Turn Tool Conversations
**File:** `src/providers/claude.ts`

Implement proper message structure for tool results:
```typescript
messages: [
  { role: 'user', content: userMessage },
  { role: 'assistant', content: [{ type: 'tool_use', ... }] },
  { role: 'user', content: [{ type: 'tool_result', ... }] },
]
```

#### 3.4 Write Provider Tests
**File:** `tests/providers/claude.test.ts`

- [ ] Test tool schema formatting
- [ ] Test tool call parsing
- [ ] Test multi-turn conversation
- [ ] Test error handling

### Session 3 Deliverables
- [ ] Working `generateWithTools()` for Claude
- [ ] Provider tests passing
- [ ] Commit: "feat(claude): implement native tool use support"

---

## Session 4: Tool Executor & Orchestrator
**Estimated Time:** 2 hours
**Dependencies:** Sessions 1-3
**Risk:** Low

### Objectives
- Create executor that handles native tool calls
- Create orchestrator for multi-tool execution
- Maintain backwards compatibility with text parsing

### Tasks

#### 4.1 Rewrite Tool Executor
**File:** `src/tools/executor.ts`

```typescript
// Remove old text-parsing code, implement:
- executeNativeToolCall(call: NativeToolCall): Promise<NativeToolResult>
- createBashExecutor(options): NativeToolExecutor
- executeCommand() (keep - used internally)

// DELETE:
- parseToolCalls()
- looksLikeCommand()
- Old ToolCall/ToolResult types
```

**Acceptance Criteria:**
- [ ] Handles `NativeToolCall` format only
- [ ] Returns `NativeToolResult` with toolCallId
- [ ] Preserves all safety checks (BLOCKED_COMMANDS, etc.)
- [ ] Old text-parsing code removed

#### 4.2 Create Tool Orchestrator
**File:** `src/tools/orchestrator.ts` (new)

```typescript
interface ToolOrchestrator {
  registerExecutor(executor: NativeToolExecutor): void;
  executeAll(calls: NativeToolCall[]): Promise<NativeToolResult[]>;
  canExecute(toolName: string): boolean;
}

function createToolOrchestrator(): ToolOrchestrator
```

**Acceptance Criteria:**
- [ ] Handles multiple executors
- [ ] Returns results in order
- [ ] Handles missing executors gracefully
- [ ] Logs all executions via safeLogger

#### 4.3 Update Tool Exports
**File:** `src/tools/index.ts`

Export new types and functions:
- [ ] NativeToolCall, NativeToolResult
- [ ] ToolSchema, ToolRegistry
- [ ] createToolOrchestrator
- [ ] executeNativeToolCall

#### 4.4 Write Executor Tests
**File:** `tests/tools/executor.test.ts`

- [ ] Test native tool call execution
- [ ] Test safety gates with native format
- [ ] Test orchestrator with multiple tools
- [ ] Test error handling

### Session 4 Deliverables
- [ ] Native tool executor working
- [ ] Tool orchestrator created
- [ ] All exports updated
- [ ] Tests passing
- [ ] Commit: "feat(tools): add native tool executor and orchestrator"

---

## Session 5: Daemon Integration
**Estimated Time:** 2-2.5 hours
**Dependencies:** Sessions 1-4
**Risk:** Medium (core message loop changes)

### Objectives
- Rewrite daemon message loop for native tool use
- Remove all text-parsing code
- Simplify the processing pipeline

### Tasks

#### 5.1 Rewrite Message Processing Loop
**File:** `src/imessage/daemon.ts`

```typescript
// Replace entire tool loop with clean native implementation:
const toolRegistry = createToolRegistry();
const orchestrator = createToolOrchestrator();
orchestrator.registerExecutor(createBashExecutor());

let previousResults: ToolResultMessage[] = [];

while (iteration < maxToolIterations) {
  iteration++;

  const response = await provider.generateWithTools(
    { prompt: conversationContext, systemPrompt },
    toolRegistry.getTools(),
    previousResults
  );

  safeLogger.info('LLM response', {
    provider: response.providerId,
    toolCalls: response.toolCalls.length,
    hasText: response.text.length > 0,
    stopReason: response.stopReason,
  });

  if (response.toolCalls.length === 0) {
    finalResponse = response.text;
    break;
  }

  // Execute all tool calls
  const results = await orchestrator.executeAll(response.toolCalls);

  // Log results
  for (const result of results) {
    safeLogger.info('Tool executed', {
      toolCallId: result.toolCallId,
      success: result.success,
      outputLength: result.output?.length ?? 0,
    });
  }

  // Set up for next iteration
  previousResults = results.map(r => ({
    callId: r.toolCallId,
    result: r.success ? (r.output ?? 'Success') : `Error: ${r.error}`,
  }));

  // Include any text from response
  if (response.text) {
    finalResponse += response.text + '\n';
  }
}
```

#### 5.2 Remove Old Imports and Code
**File:** `src/imessage/daemon.ts`

Delete:
- [ ] Import of `parseToolCalls`
- [ ] All text-parsing tool extraction code
- [ ] String concatenation for tool results
- [ ] `filterMessageSendToolCalls` (rewrite for native format)

#### 5.3 Update Tool Filter for Native Format
**File:** `src/imessage/tool-filter.ts`

```typescript
// Rewrite to handle NativeToolCall:
export function filterToolCalls(calls: NativeToolCall[]): {
  allowed: NativeToolCall[];
  blocked: NativeToolCall[];
}
```

#### 5.4 Update Logging
**File:** `src/imessage/daemon.ts`

- [ ] Log each tool call with name and input
- [ ] Log tool results with success/error
- [ ] Log iteration count and stop reason

### Session 5 Deliverables
- [ ] Daemon uses native tool loop only
- [ ] All text-parsing code removed
- [ ] Tool filter updated
- [ ] Commit: "feat(daemon): rewrite for native tool use"

---

## Session 6: Testing & System Prompt
**Estimated Time:** 1.5-2 hours
**Dependencies:** Session 5
**Risk:** Low

### Objectives
- Update system prompt for tool use
- End-to-end testing
- Fix issues found in testing

### Tasks

#### 6.1 Update System Prompt for Tool Use
**File:** `src/interface/prompt-builder.ts`

```typescript
function buildCapabilitiesSection(skills: Skill[]): string {
  return `## Capabilities

You have access to tools that let you interact with the local system.
When you need to perform an action (read files, execute commands, etc.),
use the appropriate tool.

**Critical:** You can ONLY perform actions by calling tools.
Do not claim to have done something without actually calling the tool.
The system will only execute actions through tool calls.

Available tools will be provided in the API request.`;
}
```

#### 6.2 End-to-End Testing
**Action:** Manual testing with iMessage daemon

Test scenarios:
- [ ] Simple greeting (no tools) → Response without tool calls
- [ ] "What files are on my desktop?" → bash tool called, results returned
- [ ] "Create a file called test.txt" → bash tool called, file created
- [ ] "Delete test.txt" → bash tool called (check safety gates)
- [ ] Multi-step: "List files, then create a summary" → Multiple tool iterations
- [ ] Error handling: Invalid command → Graceful error in response

#### 6.3 Fix Issues
Reserve time for fixing issues found during testing.

#### 6.4 Update Documentation
**File:** `docs/PLAN-hallucination-prevention.md`

- [ ] Mark completed phases
- [ ] Document any deviations from plan
- [ ] Note known issues

### Session 6 Deliverables
- [ ] System prompt updated
- [ ] All test scenarios passing
- [ ] Documentation updated
- [ ] Commit: "feat: complete native tool use integration"

---

## Session 8: Router via Tool Use
**Estimated Time:** 1.5-2 hours
**Dependencies:** Sessions 1-4
**Risk:** Low (isolated change)

### Objectives
- Rewrite router classifier to use native tool use
- Eliminate JSON parsing completely
- Improve routing reliability

### Tasks

#### 8.1 Define Route Decision Tool
**File:** `src/router/tools.ts` (new)

```typescript
export const ROUTE_DECISION_TOOL: ToolSchema = {
  name: 'route_decision',
  description: 'Declare the routing decision for this user request',
  inputSchema: {
    type: 'object',
    properties: {
      route: {
        type: 'string',
        enum: ['local', 'cloud'],
        description: 'Where to route: local (privacy-sensitive, simple) or cloud (complex reasoning)'
      },
      reason: {
        type: 'string',
        description: 'Brief explanation for the routing decision'
      },
      confidence: {
        type: 'number',
        description: 'Confidence score from 0.0 to 1.0'
      }
    },
    required: ['route', 'reason', 'confidence']
  }
};
```

#### 8.2 Rewrite Classifier
**File:** `src/router/classifier.ts`

```typescript
export async function classifyRoute(
  text: string,
  deps: RouteClassifierDependencies,
  context: RouteClassifierContext,
  sensitiveCategories: SensitiveCategory[]
): Promise<RouteDecision> {
  // Check sensitive categories first (unchanged)
  if (sensitiveCategories.some(cat => context.alwaysLocalCategories.includes(cat))) {
    return {
      route: 'local',
      reason: 'Matched always-local sensitive category',
      confidence: 1,
      sensitiveCategories
    };
  }

  // Use tool call for routing decision
  const response = await deps.localProvider.generateWithTools(
    { prompt: text, systemPrompt: ROUTER_PROMPT },
    [ROUTE_DECISION_TOOL]
  );

  if (response.toolCalls.length === 0) {
    // Model didn't call tool - use default route
    safeLogger.warn('Router: model did not call route_decision tool');
    return {
      route: context.defaultRoute,
      reason: 'Model did not provide routing decision',
      confidence: 0.5,
      sensitiveCategories
    };
  }

  const decision = response.toolCalls[0].input as {
    route: RouteTarget;
    reason: string;
    confidence: number;
  };

  return {
    route: decision.route,
    reason: decision.reason,
    confidence: decision.confidence,
    sensitiveCategories
  };
}
```

**Delete:**
- [ ] `extractJson()` function
- [ ] `parseRouteResponse()` function
- [ ] All JSON parsing regex code
- [ ] Old `ROUTER_PROMPT` with JSON instructions

#### 8.3 Update Router Prompt
**File:** `src/router/classifier.ts`

```typescript
const ROUTER_PROMPT_FOR_TOOLS = `You are a privacy-aware router.
Analyze the user's request and call the route_decision tool with your decision.

ROUTE TO LOCAL (default):
- Greetings, simple questions, casual conversation
- Personal data: calendar, finances, health, contacts
- Sensitive content: passwords, credentials, private documents
- Anything the user wouldn't want a company to see

ROUTE TO CLOUD (only for complex tasks):
- Coding tasks: writing, debugging, reviewing code
- Complex multi-step reasoning
- Technical explanations or tutorials
- Long-form creative writing

DEFAULT TO LOCAL. Only route to cloud if clearly needed.`;
```

#### 8.4 Write Classifier Tests
**File:** `tests/router/classifier.test.ts`

- [ ] Test tool-based classification returns correct route
- [ ] Test confidence threshold handling
- [ ] Test sensitive category override (bypasses LLM)
- [ ] Test handling when model doesn't call tool

### Session 7 Deliverables
- [ ] Router uses tool use for classification
- [ ] Old JSON parsing code deleted
- [ ] Tests passing
- [ ] Commit: "feat(router): rewrite classifier with native tool use"

---

## Session 7: Cleanup & Documentation
**Estimated Time:** 1-1.5 hours
**Dependencies:** Sessions 1-6
**Risk:** Low

### Objectives
- Delete all old text-parsing code
- Update configuration defaults
- Finalize documentation

### Tasks

#### 7.1 Delete Old Code
**Files:** Multiple

Delete completely:
- [ ] `src/skills/executor.ts`: `parseToolCalls()`, `looksLikeCommand()`, old types
- [ ] `src/router/classifier.ts`: `extractJson()`, `parseRouteResponse()`
- [ ] Any remaining text-parsing utilities
- [ ] Old `ToolCall` and `ToolResult` types (replaced by Native versions)

#### 7.2 Update Configuration Defaults
**File:** `config/default.yaml`

```yaml
local:
  provider: ollama
  model: qwen2.5:7b-instruct  # Tool-capable model required
  baseUrl: http://localhost:11434
  timeoutMs: 30000

cloud:
  provider: claude
  model: claude-sonnet-4-20250514
  apiKeyEnv: ANTHROPIC_API_KEY
  timeoutMs: 45000
```

#### 7.3 Final Documentation Update
**Files:** Multiple docs

- [ ] Update `docs/architecture.md` with native tool use flow
- [ ] Update `docs/api-reference.md` with new provider interface
- [ ] Update `docs/install.md` with model requirements
- [ ] Mark `PLAN-hallucination-prevention.md` as complete
- [ ] Archive or delete `PLAN-architecture-rework.md` notes

#### 7.4 Update README (if exists)
Note that tool-capable models are now required.

### Session 7 Deliverables
- [ ] All old code deleted
- [ ] Config updated with tool-capable model
- [ ] Documentation current
- [ ] Commit: "chore: cleanup and finalize native tool use migration"

---

---

## Optional Extensions

---

## Session 9 (Optional): Conversation Message Types
**Estimated Time:** 2-2.5 hours
**Dependencies:** Sessions 1-6
**Risk:** Medium (touches session/context)

### Objectives
- Add proper content block support to messages
- Enable true multi-turn tool conversations
- Preserve backwards compatibility

### Tasks

#### 9.1 Update Message Types
**File:** `src/interface/session.ts`

```typescript
type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };

interface ConversationMessage {
  role: 'user' | 'assistant' | 'system';
  content: string | ContentBlock[];
  sender?: string;
  timestamp: number;
}
```

#### 9.2 Update Context Assembly
**File:** `src/interface/context.ts`

Handle both string and ContentBlock[] content:
```typescript
function formatMessage(msg: ConversationMessage): string {
  if (typeof msg.content === 'string') {
    return msg.content;
  }
  return msg.content
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('');
}
```

#### 9.3 Update Session Persistence
**File:** `src/interface/session.ts`

Ensure JSONL format handles new content types.

#### 9.4 Migration for Existing Sessions
Handle loading old sessions with string content.

### Session 9 Deliverables
- [ ] Content block support working
- [ ] Backwards compatible with existing sessions
- [ ] Commit: "feat(session): add content block support for tool messages"

---

## Session 10 (Optional): Skills as Tool Schemas
**Estimated Time:** 2 hours
**Dependencies:** Sessions 1-8
**Risk:** Low (additive feature)

### Objectives
- Allow skills to define native tool schemas
- Auto-register skill tools with orchestrator
- Maintain backwards compatibility with text instructions

### Tasks

#### 10.1 Extend Skill Types
**File:** `src/skills/types.ts`

```typescript
interface Skill {
  id: string;
  frontmatter: SkillFrontmatter;
  instructions: string;
  tools?: ToolSchema[];  // NEW
  path: string;
  available: boolean;
}
```

#### 10.2 Update Skill Loader
**File:** `src/skills/loader.ts`

Parse `tools:` section from SKILL.md frontmatter.

#### 10.3 Register Skill Tools
**File:** `src/imessage/daemon.ts`

```typescript
for (const skill of skillRegistry.getAvailable()) {
  if (skill.tools) {
    for (const tool of skill.tools) {
      toolRegistry.register(tool);
    }
  }
}
```

#### 10.4 Create Example Skill with Tools
**File:** `skills/example-tool/SKILL.md`

```yaml
---
name: Example Tool Skill
description: Demonstrates native tool definition
tools:
  - name: example_action
    description: Performs an example action
    inputSchema:
      type: object
      properties:
        input:
          type: string
          description: Input for the action
      required: [input]
---
```

### Session 10 Deliverables
- [ ] Skills can define tool schemas
- [ ] Example skill created
- [ ] Commit: "feat(skills): support native tool definitions"

---

## Quick Reference: All Sessions

| Session | Focus | Time | Risk |
|---------|-------|------|------|
| 1 | Foundation Types | 1.5-2h | Low |
| 2 | Ollama Tool Support | 2-2.5h | Medium |
| 3 | Claude Tool Support | 1.5-2h | Low |
| 4 | Executor & Orchestrator | 2h | Low |
| 5 | Daemon Integration | 2-2.5h | Medium |
| 6 | Testing & System Prompt | 1.5-2h | Low |
| 7 | Cleanup & Documentation | 1-1.5h | Low |
| 8 | Router via Tool Use | 1.5-2h | Low |
| 9 | Message Types *(optional)* | 2-2.5h | Medium |
| 10 | Skills as Tools *(optional)* | 2h | Low |

**Core Migration (Sessions 1-8):** ~12-15 hours
**Full Implementation (Sessions 1-10):** ~16-19 hours

---

## Prerequisites

Before starting:

1. **Tool-capable model installed:**
   ```bash
   ollama pull qwen2.5:7b-instruct
   ```

2. **Verify model supports tools:**
   ```bash
   # Test with Ollama API directly
   curl http://localhost:11434/api/chat -d '{
     "model": "qwen2.5:7b-instruct",
     "messages": [{"role": "user", "content": "List files"}],
     "tools": [{"type": "function", "function": {"name": "bash", "parameters": {}}}]
   }'
   ```

---

## Rollback Plan

Since we're not preserving backwards compatibility:

1. **Git rollback:** `git revert` the migration commits
2. **Model:** Keep old model available during transition
3. **Testing:** Test thoroughly in Session 6 before cleanup in Session 7

**Recommendation:** Don't delete old code (Session 7) until you've run in production for a few days.
