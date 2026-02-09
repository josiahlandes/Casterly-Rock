# Architecture Rework Analysis

This document analyzes what additional architectural changes should be bundled with the native tool use migration outlined in `PLAN-hallucination-prevention.md`.

## Current State Analysis

### 1. Provider System (`src/providers/`)

**Current:**
```typescript
interface LlmProvider {
  id: string;
  kind: ProviderKind;
  model: string;
  generate(request: GenerateRequest): Promise<GenerateResponse>;
}
```

**Issues:**
- Single `generate()` method - no capability discovery
- No streaming support
- No tool use support
- No way to query provider capabilities

### 2. Tool System (`src/skills/`)

**Current:**
```typescript
interface ToolCall {
  tool: string;      // "exec"
  args: string;      // Raw command string
  requiresApproval?: boolean;
}
```

**Issues:**
- Text-based tool calls extracted from markdown
- No structured input schema
- Single tool type ("exec" for bash)
- Tool calls can be hallucinated in text without actual execution

### 3. Router/Classifier (`src/router/`)

**Current:**
- Uses text-based JSON parsing for classification
- Asks LLM to output JSON, then parses with regex fallbacks
- Fragile - depends on LLM following output format

### 4. Session/Context (`src/interface/`)

**Current:**
```typescript
interface ConversationMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  sender?: string;
  timestamp: number;
}
```

**Issues:**
- No support for tool_use or tool_result message types
- Content is always a string, not content blocks
- Cannot represent multi-turn tool conversations

### 5. Daemon Message Loop (`src/imessage/daemon.ts`)

**Current:**
```typescript
// Tool execution loop
while (iteration < maxToolIterations) {
  response = await provider.generate({ prompt: conversationContext });
  toolCalls = parseToolCalls(response.text);  // Text parsing!
  // ...execute tools...
  conversationContext += toolResults;  // String concatenation
}
```

**Issues:**
- Text parsing for tool extraction
- Context built via string concatenation
- No proper multi-turn tool conversation structure

---

## Recommended Bundled Reworks

### Rework 1: Provider Capability System

**Why:** Native tool use requires knowing if a provider/model supports tools. This naturally extends to other capabilities.

**Changes:**

```typescript
// src/providers/base.ts

interface ProviderCapabilities {
  tools: boolean;
  streaming: boolean;
  vision: boolean;
  maxContextTokens: number;
}

interface LlmProvider {
  id: string;
  kind: ProviderKind;
  model: string;

  // Capability discovery
  getCapabilities(): ProviderCapabilities;

  // Text generation (existing)
  generate(request: GenerateRequest): Promise<GenerateResponse>;

  // Tool-aware generation (new)
  generateWithTools?(
    request: GenerateRequest,
    tools: ToolSchema[],
    previousResults?: ToolResultMessage[]
  ): Promise<GenerateWithToolsResponse>;

  // Streaming (future)
  generateStream?(request: GenerateRequest): AsyncGenerator<string>;
}
```

**Effort:** Low - additive change, backwards compatible

---

### Rework 2: Structured Tool System

**Why:** Native tool use requires structured tool definitions with JSON schemas. Current text-based system should migrate.

**Changes:**

```typescript
// src/tools/types.ts (new unified types)

interface ToolParameter {
  type: 'string' | 'number' | 'boolean' | 'object' | 'array';
  description: string;
  enum?: string[];
  required?: boolean;
}

interface ToolSchema {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, ToolParameter>;
    required: string[];
  };
}

interface NativeToolCall {
  id: string;                        // For matching results
  name: string;                      // Tool name
  input: Record<string, unknown>;    // Structured input
}

interface NativeToolResult {
  toolCallId: string;
  success: boolean;
  output?: string;
  error?: string;
}
```

**Migration path:**
1. Keep existing `ToolCall`/`ToolResult` for text-parsing fallback
2. Add `NativeToolCall`/`NativeToolResult` for tool use API
3. Executor handles both formats

**Effort:** Medium - requires parallel support during transition

---

### Rework 3: Router via Tool Use

**Why:** The router classifier asks for JSON output and parses it with fragile regex. Using native tool use for the routing decision would be more reliable.

**Current:**
```typescript
// Prompt asks for JSON
const ROUTER_PROMPT = `...Respond with ONLY valid JSON:
{"route": "local" or "cloud", "reason": "...", "confidence": 0.0-1.0}`;

// Parse with regex fallbacks
const jsonString = extractJson(text);
const parsed = JSON.parse(jsonString);
```

**Proposed:**
```typescript
// Define routing as a tool
const ROUTE_DECISION_TOOL: ToolSchema = {
  name: 'route_decision',
  description: 'Declare the routing decision for this request',
  inputSchema: {
    type: 'object',
    properties: {
      route: { type: 'string', enum: ['local', 'cloud'], description: '...' },
      reason: { type: 'string', description: '...' },
      confidence: { type: 'number', description: '0.0-1.0' },
    },
    required: ['route', 'reason', 'confidence'],
  },
};

// Use tool call for reliable structured output
const response = await provider.generateWithTools(
  { prompt: text, systemPrompt: ROUTER_PROMPT },
  [ROUTE_DECISION_TOOL]
);

const decision = response.toolCalls[0]?.input as RouteDecision;
```

**Benefits:**
- Eliminates JSON parsing failures
- Model is forced to use the schema
- Easier to extend with additional routing metadata

**Effort:** Low - isolated change to classifier.ts

---

### Rework 4: Conversation Message Types

**Why:** Tool use requires multi-turn conversations with tool_use and tool_result content blocks.

**Changes:**

```typescript
// src/interface/session.ts

type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };

interface ConversationMessage {
  role: 'user' | 'assistant' | 'system';
  content: string | ContentBlock[];  // Support both for migration
  sender?: string;
  timestamp: number;
}
```

**Migration:**
- Existing messages with `content: string` continue to work
- New tool conversations use `content: ContentBlock[]`
- Context assembly handles both formats

**Effort:** Medium - requires updating session, context, and history handling

---

### Rework 5: Skills as Tool Schemas

**Why:** Skills currently provide text instructions. With native tool use, skills could also define tool schemas.

**Current:**
```typescript
interface Skill {
  id: string;
  frontmatter: SkillFrontmatter;
  instructions: string;        // Text for LLM
  path: string;
  available: boolean;
}
```

**Proposed extension:**
```typescript
interface Skill {
  id: string;
  frontmatter: SkillFrontmatter;
  instructions: string;        // Text fallback
  tools?: ToolSchema[];        // Native tool definitions
  path: string;
  available: boolean;
}
```

**Benefits:**
- Skills can define structured tools
- Tool schemas auto-generated from skill metadata
- Backwards compatible - skills without `tools` use text instructions

**Effort:** Medium - requires skill loader updates and SKILL.md schema extension

---

## Dependency Graph

```
                    ┌─────────────────────────┐
                    │ Rework 1: Provider      │
                    │ Capabilities            │
                    └───────────┬─────────────┘
                                │
          ┌─────────────────────┼─────────────────────┐
          │                     │                     │
          ▼                     ▼                     ▼
┌─────────────────┐   ┌─────────────────┐   ┌─────────────────┐
│ Rework 2:       │   │ Rework 3:       │   │ Rework 4:       │
│ Structured      │   │ Router via      │   │ Message Types   │
│ Tool System     │   │ Tool Use        │   │                 │
└────────┬────────┘   └─────────────────┘   └────────┬────────┘
         │                                           │
         │            ┌─────────────────┐            │
         └───────────▶│ Native Tool Use │◀───────────┘
                      │ (Main Plan)     │
                      └────────┬────────┘
                               │
                      ┌────────▼────────┐
                      │ Rework 5:       │
                      │ Skills as Tools │
                      └─────────────────┘
```

---

## Implementation Order

### Phase 0: Foundation (Do First)
1. **Rework 1: Provider Capabilities** - Add capability discovery
2. **Rework 2: Structured Tool Types** - Define new types alongside existing

### Phase 1: Native Tool Use (Main Plan)
3. Implement `generateWithTools()` for Ollama provider
4. Implement `generateWithTools()` for Claude provider
5. Create tool executor for native format
6. Update daemon loop for native tool use

### Phase 2: Conversation Structure
7. **Rework 4: Message Types** - Add content block support
8. Update session and context assembly
9. Update history trimming for tool messages

### Phase 3: Router Enhancement
10. **Rework 3: Router via Tool Use** - Migrate classifier

### Phase 4: Skill Enhancement (Optional)
11. **Rework 5: Skills as Tools** - Extend skill system

---

## Decisions Needed

### 1. Fallback Strategy
- **Option A:** Always fall back to text parsing if tool use fails
- **Option B:** Require tool-capable models, no fallback
- **Recommendation:** Option A for reliability

### 2. Skill Migration
- **Option A:** All skills must define tool schemas
- **Option B:** Skills can use text instructions OR tool schemas
- **Recommendation:** Option B for backwards compatibility

### 3. Router Migration
- **Option A:** Migrate router to tool use immediately
- **Option B:** Keep text-based router, migrate later
- **Recommendation:** Option A (small scope, high value)

### 4. Model Selection
- Need to identify which Ollama models support tools well
- DeepSeek V2 may not - consider switching default to:
  - `qwen2.5:7b-instruct` (known good tool support)
  - `llama3.1:8b-instruct` (supports tools)
  - `mistral:7b-instruct` (decent tool support)

---

## Files to Modify

### Phase 0
- `src/providers/base.ts` - Add capabilities interface
- `src/providers/ollama.ts` - Add capability reporting
- `src/providers/claude.ts` - Add capability reporting
- `src/tools/types.ts` (new) - Structured tool types

### Phase 1
- `src/providers/ollama.ts` - Add `generateWithTools()`
- `src/providers/claude.ts` - Add `generateWithTools()`
- `src/tools/schemas.ts` (new) - Core tool definitions
- `src/tools/executor.ts` - Handle native tool format
- `src/tools/orchestrator.ts` (new) - Tool orchestration
- `src/imessage/daemon.ts` - Native tool loop

### Phase 2
- `src/interface/session.ts` - Content block support
- `src/interface/context.ts` - Handle tool messages
- `src/interface/prompt-builder.ts` - Tool-aware prompts

### Phase 3
- `src/router/classifier.ts` - Tool-based classification

### Phase 4
- `src/skills/types.ts` - Add tool schemas to Skill
- `src/skills/loader.ts` - Load tool definitions

---

## Estimated Total Effort

| Phase | Scope | Effort |
|-------|-------|--------|
| Phase 0 | Foundation | 2-3 hours |
| Phase 1 | Native Tool Use | 4-6 hours |
| Phase 2 | Conversation Structure | 3-4 hours |
| Phase 3 | Router Enhancement | 1-2 hours |
| Phase 4 | Skill Enhancement | 2-3 hours |

**Total:** 12-18 hours across multiple sessions

---

## Risk Assessment

| Risk | Impact | Mitigation |
|------|--------|------------|
| Model doesn't support tools well | High | Test models before migration; keep text fallback |
| Breaking existing sessions | Medium | Version session format; migrate on load |
| Performance regression | Medium | Benchmark tool use vs text parsing |
| Complexity increase | Low | Good abstractions; phased rollout |

---

## Recommendation

**Bundle these reworks with the native tool use migration:**

1. **Yes - Rework 1 (Capabilities):** Required for tool use, low effort
2. **Yes - Rework 2 (Tool Types):** Required for tool use, medium effort
3. **Yes - Rework 3 (Router):** High value, low effort, same pattern
4. **Defer - Rework 4 (Messages):** Can work with string concat initially
5. **Defer - Rework 5 (Skills):** Nice to have, not blocking

This gives a focused scope for the initial migration while setting up the foundation for future enhancements.
