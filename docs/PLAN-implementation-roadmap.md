# Implementation Roadmap: Native Tool Use Migration

This document provides a detailed, session-by-session breakdown for implementing native tool use and bundled architecture improvements.

**Total Scope:** ~15-20 hours across 8-10 sessions

---

## Session 1: Foundation Types & Interfaces
**Estimated Time:** 1.5-2 hours
**Dependencies:** None
**Risk:** Low

### Objectives
- Define all new TypeScript types for native tool use
- Extend provider interface with capability discovery
- Keep backwards compatible with existing code

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

#### 1.3 Extend Provider Interface
**File:** `src/providers/base.ts`

```typescript
// Add to existing file:
- ProviderCapabilities interface
- getCapabilities() method (optional)
- generateWithTools() method (optional)
- supportsTools() helper
```

**Acceptance Criteria:**
- [ ] Existing code still compiles
- [ ] New methods are optional (?)
- [ ] No breaking changes to LlmProvider interface

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
- [ ] Existing `generate()` method unchanged
- [ ] Handles models without tool support gracefully

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
- [ ] Existing `generate()` method unchanged

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

#### 4.1 Refactor Tool Executor
**File:** `src/tools/executor.ts`

```typescript
// Add new functions:
- executeNativeToolCall(call: NativeToolCall): Promise<NativeToolResult>
- createBashExecutor(options): NativeToolExecutor

// Keep existing:
- parseToolCalls() (for fallback)
- executeCommand()
- executeToolCalls()
```

**Acceptance Criteria:**
- [ ] Handles `NativeToolCall` format
- [ ] Returns `NativeToolResult` with toolCallId
- [ ] Preserves all safety checks
- [ ] Existing text-parsing functions still work

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

## Session 5: Daemon Integration (Part 1)
**Estimated Time:** 2-2.5 hours
**Dependencies:** Sessions 1-4
**Risk:** Medium (core message loop changes)

### Objectives
- Update daemon to detect tool-capable providers
- Implement native tool loop alongside text parsing
- Add feature flag for gradual rollout

### Tasks

#### 5.1 Add Tool Use Detection
**File:** `src/imessage/daemon.ts`

```typescript
// In processMessage():
const useNativeTools = provider.supportsTools?.() ?? false;
```

#### 5.2 Implement Native Tool Loop
**File:** `src/imessage/daemon.ts`

```typescript
// New tool loop for native tools:
if (useNativeTools && provider.generateWithTools) {
  // Native tool use path
  const toolRegistry = createToolRegistry();
  const orchestrator = createToolOrchestrator();
  orchestrator.registerExecutor(createBashExecutor());

  while (iteration < maxToolIterations) {
    const response = await provider.generateWithTools(
      { prompt, systemPrompt },
      toolRegistry.getTools(),
      previousResults
    );

    if (response.toolCalls.length === 0) {
      finalResponse = response.text;
      break;
    }

    const results = await orchestrator.executeAll(response.toolCalls);
    previousResults = results.map(r => ({
      callId: r.toolCallId,
      result: r.success ? r.output : `Error: ${r.error}`
    }));
  }
} else {
  // Existing text-parsing path (fallback)
  // ... keep existing code ...
}
```

#### 5.3 Add Configuration Flag
**File:** `src/config/schema.ts`

```typescript
// Add to AppConfig:
features?: {
  useNativeTools?: boolean;  // Default: true
}
```

#### 5.4 Update Logging
**File:** `src/imessage/daemon.ts`

Add detailed logging for native tool path:
- [ ] Log when using native vs text-parsing
- [ ] Log each tool call with name and input
- [ ] Log tool results
- [ ] Log iteration count

### Session 5 Deliverables
- [ ] Daemon detects tool-capable providers
- [ ] Native tool loop implemented
- [ ] Fallback to text parsing works
- [ ] Feature flag added
- [ ] Commit: "feat(daemon): integrate native tool use loop"

---

## Session 6: Daemon Integration (Part 2) & Testing
**Estimated Time:** 2 hours
**Dependencies:** Session 5
**Risk:** Medium

### Objectives
- Complete daemon integration
- End-to-end testing
- Fix issues found in testing

### Tasks

#### 6.1 Update System Prompt for Tool Use
**File:** `src/interface/prompt-builder.ts`

```typescript
function buildCapabilitiesSection(skills: Skill[], useNativeTools: boolean): string {
  if (useNativeTools) {
    return `## Capabilities
You have access to tools that let you interact with the local system.
When you need to perform an action, use the appropriate tool.

**Important:** You can ONLY perform actions by calling tools.
Any claims about actions taken are meaningless unless you actually called the tool.`;
  }
  // Existing text-based instructions
}
```

#### 6.2 Handle Tool Filter for iMessage
**File:** `src/imessage/tool-filter.ts`

Update to handle native tool calls:
```typescript
function filterNativeToolCalls(calls: NativeToolCall[]): {
  allowed: NativeToolCall[];
  blocked: NativeToolCall[];
}
```

#### 6.3 End-to-End Testing
**Action:** Manual testing with iMessage daemon

Test scenarios:
- [ ] Simple greeting (no tools) → Works with native path
- [ ] "What files are on my desktop?" → Tool called, results returned
- [ ] "Create a file called test.txt" → Tool called, file created
- [ ] "Delete test.txt" → Approval required (if applicable)
- [ ] Multi-step: "List files, then create a summary" → Multiple tool calls
- [ ] Fallback: Force text-parsing path, verify still works

#### 6.4 Fix Issues
Reserve time for fixing issues found during testing.

#### 6.5 Update Documentation
**File:** `docs/PLAN-hallucination-prevention.md`

- [ ] Mark completed phases
- [ ] Document any deviations from plan
- [ ] Note known issues

### Session 6 Deliverables
- [ ] Full daemon integration working
- [ ] All test scenarios passing
- [ ] Documentation updated
- [ ] Commit: "feat(daemon): complete native tool use integration"

---

## Session 7: Router via Tool Use
**Estimated Time:** 1.5-2 hours
**Dependencies:** Sessions 1-3
**Risk:** Low (isolated change)

### Objectives
- Migrate router classifier to use native tool use
- Eliminate JSON parsing fragility
- Improve routing reliability

### Tasks

#### 7.1 Define Route Decision Tool
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

#### 7.2 Update Classifier
**File:** `src/router/classifier.ts`

```typescript
export async function classifyRoute(
  text: string,
  deps: RouteClassifierDependencies,
  context: RouteClassifierContext,
  sensitiveCategories: SensitiveCategory[]
): Promise<RouteDecision> {
  // ... existing sensitive category check ...

  // Use native tool use if available
  if (deps.localProvider.supportsTools?.() && deps.localProvider.generateWithTools) {
    return classifyWithToolUse(text, deps, context, sensitiveCategories);
  }

  // Fallback to text parsing
  return classifyWithTextParsing(text, deps, context, sensitiveCategories);
}

async function classifyWithToolUse(...): Promise<RouteDecision> {
  const response = await deps.localProvider.generateWithTools(
    { prompt: text, systemPrompt: ROUTER_PROMPT_FOR_TOOLS },
    [ROUTE_DECISION_TOOL]
  );

  if (response.toolCalls.length === 0) {
    // Model didn't call tool - use default
    return createFallbackDecision(...);
  }

  const decision = response.toolCalls[0].input as {
    route: RouteTarget;
    reason: string;
    confidence: number;
  };

  // Validate and return
  return {
    route: decision.route,
    reason: decision.reason,
    confidence: decision.confidence,
    sensitiveCategories
  };
}
```

#### 7.3 Update Router Prompt
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

#### 7.4 Write Classifier Tests
**File:** `tests/router/classifier.test.ts`

- [ ] Test tool-based classification
- [ ] Test fallback to text parsing
- [ ] Test confidence threshold handling
- [ ] Test sensitive category override

### Session 7 Deliverables
- [ ] Router uses tool use for classification
- [ ] Text parsing fallback works
- [ ] Tests passing
- [ ] Commit: "feat(router): migrate classifier to native tool use"

---

## Session 8: Cleanup & Polish
**Estimated Time:** 1.5-2 hours
**Dependencies:** Sessions 1-7
**Risk:** Low

### Objectives
- Remove deprecated code paths (if stable)
- Add deprecation warnings
- Final documentation
- Performance testing

### Tasks

#### 8.1 Add Deprecation Warnings
**File:** `src/skills/executor.ts`

```typescript
export function parseToolCalls(text: string): ToolCall[] {
  safeLogger.warn('Using deprecated text-parsing for tool calls', {
    hint: 'Consider using a model with native tool support'
  });
  // ... existing implementation
}
```

#### 8.2 Update Configuration Defaults
**File:** `config/default.yaml`

```yaml
local:
  provider: ollama
  model: qwen2.5:7b-instruct  # Updated for tool support
  # ...

features:
  useNativeTools: true
```

#### 8.3 Performance Comparison
**Action:** Benchmark testing

Compare:
- [ ] Response latency: native vs text-parsing
- [ ] Token usage: native vs text-parsing
- [ ] Reliability: tool call success rate

#### 8.4 Final Documentation Update
**Files:** Multiple docs

- [ ] Update `docs/architecture.md` with tool use flow
- [ ] Update `docs/api-reference.md` with new APIs
- [ ] Update `docs/install.md` with model recommendations
- [ ] Mark `PLAN-hallucination-prevention.md` as complete

#### 8.5 Create Migration Guide
**File:** `docs/MIGRATION-native-tools.md` (new)

Document:
- What changed
- How to update custom code
- How to revert if issues
- Known limitations

### Session 8 Deliverables
- [ ] Deprecation warnings in place
- [ ] Config defaults updated
- [ ] Performance documented
- [ ] All documentation current
- [ ] Commit: "docs: finalize native tool use migration"

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
| 5 | Daemon Integration (1) | 2-2.5h | Medium |
| 6 | Daemon Integration (2) | 2h | Medium |
| 7 | Router via Tool Use | 1.5-2h | Low |
| 8 | Cleanup & Polish | 1.5-2h | Low |
| 9 | Message Types (optional) | 2-2.5h | Medium |
| 10 | Skills as Tools (optional) | 2h | Low |

**Core Migration (Sessions 1-8):** ~14-17 hours
**Full Implementation (Sessions 1-10):** ~18-22 hours

---

## Rollback Plan

If issues are found after deployment:

1. **Quick rollback:** Set `features.useNativeTools: false` in config
2. **Code rollback:** Revert to text-parsing path (preserved as fallback)
3. **Model rollback:** Switch back to original model in config

All changes are designed to be backwards compatible with fallback paths.
