# Coding Interface

> **Status**: Design document
> **Inspiration**: [Aider](https://github.com/Aider-AI/aider) repo map architecture
> **Last Updated**: 2026-02-08

## Overview

The coding interface provides the scaffolding layer between raw LLM inference and effective code editing. It solves the problem of context management - helping the model understand large codebases without exhausting token limits.

This is what Claude Code is to Opus, or what Aider is to GPT-4. Tyrion needs the same.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                      CODING INTERFACE                            │
│                                                                 │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────┐ │
│  │  Repo Map   │  │   Context   │  │    Session Memory       │ │
│  │  (AST)      │  │   Manager   │  │                         │ │
│  │             │  │             │  │  - Conversation history │ │
│  │  tree-sitter│  │  - Files    │  │  - Decisions made       │ │
│  │  parsing    │  │  - Symbols  │  │  - Files modified       │ │
│  │             │  │  - Budget   │  │  - Learnings            │ │
│  └─────────────┘  └─────────────┘  └─────────────────────────┘ │
│         │                │                     │                │
│         └────────────────┼─────────────────────┘                │
│                          ▼                                      │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │                    Tool Suite                            │   │
│  │                                                         │   │
│  │  read | edit | write | glob | grep | bash | git | test  │   │
│  └─────────────────────────────────────────────────────────┘   │
│                          │                                      │
│                          ▼                                      │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │                   Edit Formats                           │   │
│  │                                                         │   │
│  │  search/replace | whole file | diff | udiff             │   │
│  └─────────────────────────────────────────────────────────┘   │
│                          │                                      │
│                          ▼                                      │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │                 Validation Loop                          │   │
│  │                                                         │   │
│  │  parse → lint → typecheck → test → commit               │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
              ┌───────────────────────────────┐
              │        Model Router           │
              │                               │
              │  Hermes 3 70B (reasoning)     │
              │  Qwen3-Coder (implementation) │
              └───────────────────────────────┘
```

---

## Core Components

### 1. Repo Map (Tree-Sitter Based)

The repo map provides a compressed view of the entire codebase that fits within token limits. Instead of sending raw file contents, it sends a structural summary.

**How it works**:

1. **Parse** - Tree-sitter parses each file into an AST
2. **Extract** - Pull out definitions: functions, classes, types, exports
3. **Graph** - Build a dependency graph (file → references → file)
4. **Rank** - PageRank to find the most important symbols
5. **Budget** - Select top symbols that fit in token budget

**Example output**:

```
src/providers/ollama.ts:
│ class OllamaProvider
│   constructor(config: OllamaConfig)
│   async chat(messages: Message[]): Promise<Response>
│   async stream(messages: Message[]): AsyncGenerator<Chunk>
│
│ interface OllamaConfig
│   baseUrl: string
│   model: string
│   timeoutMs: number

src/tools/executor.ts:
│ async function executeTool(name: string, args: unknown): Promise<ToolResult>
│ function validateArgs(schema: JsonSchema, args: unknown): boolean
│
│ references: OllamaProvider, ToolSchema, Message
```

**Configuration**:

```yaml
repo_map:
  enabled: true
  token_budget: 2048           # Default tokens for map
  token_budget_max: 8192       # Expand when no files in context
  languages:
    - typescript
    - javascript
    - python
    - rust
    - go
  include_patterns:
    - "src/**/*"
    - "tests/**/*"
  exclude_patterns:
    - "node_modules/**"
    - "dist/**"
    - "*.min.js"
```

**Implementation**:

```typescript
// src/coding/repo-map.ts

import Parser from 'tree-sitter';
import TypeScript from 'tree-sitter-typescript';

interface RepoMap {
  files: FileMap[];
  totalTokens: number;
  generatedAt: string;
}

interface FileMap {
  path: string;
  symbols: Symbol[];
  references: string[];      // Files this file imports/uses
  importance: number;        // PageRank score
}

interface Symbol {
  name: string;
  kind: 'function' | 'class' | 'interface' | 'type' | 'const' | 'export';
  signature: string;         // Full signature from AST
  line: number;
  exported: boolean;
}

async function buildRepoMap(
  rootPath: string,
  config: RepoMapConfig
): Promise<RepoMap> {
  const parser = new Parser();
  parser.setLanguage(TypeScript);

  // 1. Find all source files
  const files = await glob(config.includePatterns, {
    ignore: config.excludePatterns,
    cwd: rootPath,
  });

  // 2. Parse each file and extract symbols
  const fileMaps: FileMap[] = [];
  const graph = new Map<string, Set<string>>();

  for (const file of files) {
    const content = await fs.readFile(path.join(rootPath, file), 'utf-8');
    const tree = parser.parse(content);

    const symbols = extractSymbols(tree.rootNode, content);
    const references = extractReferences(tree.rootNode, content);

    fileMaps.push({ path: file, symbols, references, importance: 0 });
    graph.set(file, new Set(references));
  }

  // 3. Compute PageRank importance
  computePageRank(fileMaps, graph);

  // 4. Sort by importance and trim to budget
  fileMaps.sort((a, b) => b.importance - a.importance);

  return trimToBudget(fileMaps, config.tokenBudget);
}
```

---

### 2. Context Manager

Tracks what the model currently "knows" and manages the token budget.

**Responsibilities**:

- Track which files are loaded in context
- Manage token budget across: system prompt, repo map, file contents, conversation
- Decide when to load/unload files
- Provide relevant context for current task

**Token Budget Allocation**:

```
┌─────────────────────────────────────────────────────────────────┐
│                    CONTEXT WINDOW (128k)                        │
│                                                                 │
│  ┌──────────────┐  System prompt, rules, persona    (~2k)      │
│  ├──────────────┤                                               │
│  │              │  Repo map (compressed codebase)   (~2-8k)    │
│  ├──────────────┤                                               │
│  │              │                                               │
│  │              │  Active files (full content)      (~20-40k)  │
│  │              │                                               │
│  ├──────────────┤                                               │
│  │              │  Conversation history             (~10-20k)  │
│  │              │                                               │
│  ├──────────────┤                                               │
│  │              │  Tool results, diffs              (~10k)     │
│  ├──────────────┤                                               │
│  │              │  Response headroom                (~20-40k)  │
│  └──────────────┘                                               │
└─────────────────────────────────────────────────────────────────┘
```

**Implementation**:

```typescript
// src/coding/context-manager.ts

interface ContextManager {
  // File tracking
  addFile(path: string): Promise<void>;
  removeFile(path: string): void;
  getActiveFiles(): string[];

  // Token management
  getTokenBudget(): TokenBudget;
  getRemainingTokens(): number;

  // Context building
  buildContext(task: string): Promise<Context>;

  // Auto-context
  suggestFiles(task: string): Promise<string[]>;
}

interface TokenBudget {
  total: number;              // Model's context window
  system: number;             // Reserved for system prompt
  repoMap: number;            // Current repo map size
  files: number;              // Active file contents
  conversation: number;       // Chat history
  tools: number;              // Tool results
  response: number;           // Reserved for response
}

interface Context {
  systemPrompt: string;
  repoMap: string;
  fileContents: Map<string, string>;
  conversation: Message[];
  tokenUsage: TokenBudget;
}
```

---

### 3. Session Memory

Persists state across conversation turns and even across sessions.

**What it tracks**:

```typescript
interface SessionMemory {
  // Current session
  sessionId: string;
  startedAt: string;

  // Task tracking
  currentTask?: string;
  todos: Todo[];

  // File tracking
  filesRead: string[];
  filesModified: string[];
  filesCreated: string[];

  // Decision log
  decisions: Decision[];

  // Learnings (for future sessions)
  learnings: string[];
}

interface Decision {
  timestamp: string;
  context: string;
  decision: string;
  reasoning: string;
}
```

**Persistence**:

```yaml
# ~/.casterly/sessions/2026-02-08-abc123.yaml

session_id: abc123
started_at: "2026-02-08T15:30:00Z"
current_task: "Add dark mode toggle to settings"

todos:
  - content: "Create DarkModeToggle component"
    status: completed
  - content: "Add theme context provider"
    status: in_progress
  - content: "Update CSS variables"
    status: pending

files_modified:
  - src/components/DarkModeToggle.tsx
  - src/contexts/ThemeContext.tsx

decisions:
  - timestamp: "2026-02-08T15:32:00Z"
    context: "Choosing state management for theme"
    decision: "Use React Context instead of Redux"
    reasoning: "Theme is simple boolean, no need for Redux complexity"
```

---

### 4. Tool Suite

Structured tools that are more precise than raw bash.

| Tool | Purpose | Advantage over bash |
|------|---------|---------------------|
| `read` | Read file contents | Token counting, line limits |
| `edit` | Search/replace in file | Atomic, validated, reversible |
| `write` | Create/overwrite file | Validates path, creates dirs |
| `glob` | Find files by pattern | Returns structured list |
| `grep` | Search file contents | Structured matches with context |
| `git` | Git operations | Safe subset, auto-commit |
| `test` | Run test suite | Parsed results, not raw output |
| `lint` | Run linter | Structured errors with fixes |

**Edit Tool (Search/Replace)**:

```typescript
interface EditTool {
  name: 'edit';
  input: {
    path: string;
    search: string;      // Exact text to find
    replace: string;     // Text to replace with
    replaceAll?: boolean;
  };
  output: {
    success: boolean;
    matchCount: number;
    preview?: string;    // Diff preview
    error?: string;
  };
}
```

**Why search/replace over diff**:

1. **Unambiguous** - Exact text match, no line number drift
2. **Verifiable** - Can confirm the search text exists before replacing
3. **Reversible** - Easy to undo by swapping search/replace
4. **LLM-friendly** - Models produce fewer errors than with unified diff

---

### 5. Edit Formats

Support multiple edit formats depending on task:

| Format | When to use | Example |
|--------|-------------|---------|
| **search/replace** | Small, targeted edits | Fix a bug, rename variable |
| **whole file** | New files, major rewrites | Create new component |
| **diff** | Review changes | Show what will change |

**Search/Replace Format** (default):

```
<<<<<<< SEARCH
export function oldName(x: number): number {
  return x * 2;
}
=======
export function newName(x: number): number {
  return x * 2;
}
>>>>>>> REPLACE
```

**Whole File Format**:

```
<<<<<<< FILE: src/components/NewComponent.tsx
import React from 'react';

export function NewComponent() {
  return <div>Hello</div>;
}
>>>>>>> END
```

---

### 6. Validation Loop

Every edit goes through validation before committing:

```
Edit requested
      │
      ▼
┌─────────────┐
│   Parse     │ ← Can the file still be parsed?
└─────────────┘
      │ yes
      ▼
┌─────────────┐
│    Lint     │ ← Any new lint errors?
└─────────────┘
      │ pass
      ▼
┌─────────────┐
│  TypeCheck  │ ← Any new type errors?
└─────────────┘
      │ pass
      ▼
┌─────────────┐
│    Test     │ ← Do tests still pass? (optional)
└─────────────┘
      │ pass
      ▼
┌─────────────┐
│   Commit    │ ← Auto-commit with descriptive message
└─────────────┘
```

**Configuration**:

```yaml
validation:
  parse_check: true           # Always check syntax
  lint_on_edit: true          # Run lint after each edit
  typecheck_on_edit: true     # Run typecheck after each edit
  test_on_edit: false         # Only run tests on request
  auto_commit: true           # Commit after successful validation
  commit_message_style: conventional  # conventional | descriptive
```

---

## Modes

The coding interface supports multiple modes for different tasks:

### Code Mode (default)

For making changes to files.

```
You are in CODE mode. You can read and edit files.

Available tools: read, edit, write, glob, grep, git, bash

When editing, use search/replace blocks:
<<<<<<< SEARCH
old code
=======
new code
>>>>>>> REPLACE
```

### Architect Mode

For planning before implementing.

```
You are in ARCHITECT mode. Plan the implementation before coding.

1. Analyze the request
2. Identify affected files
3. Outline the changes needed
4. Consider edge cases
5. Present the plan for approval

Do NOT make changes in this mode. Output a plan only.
```

### Ask Mode

For questions without making changes.

```
You are in ASK mode. Answer questions about the codebase.

You can read files but cannot edit them.
Use the repo map to understand the codebase structure.
```

---

## Model Routing

The coding interface routes to different models based on task:

```typescript
interface ModelRouter {
  // Planning, architecture decisions
  architect: 'hermes3:70b';

  // Code implementation
  code: 'qwen3-coder-next:latest';

  // Quick questions, explanations
  ask: 'hermes3:70b';

  // Code review
  review: 'qwen3-coder-next:latest';
}
```

**Routing logic**:

```typescript
function routeToModel(mode: Mode, task: string): string {
  switch (mode) {
    case 'architect':
      return 'hermes3:70b';       // Reasoning for planning

    case 'code':
      return 'qwen3-coder-next';  // Coding specialist

    case 'ask':
      // Use coding model for code questions, reasoning for general
      return isCodeQuestion(task)
        ? 'qwen3-coder-next'
        : 'hermes3:70b';

    case 'review':
      return 'qwen3-coder-next';  // Code understanding
  }
}
```

---

## Integration with Autonomous Loop

The coding interface can be used by both:

1. **Interactive sessions** - User requests changes
2. **Autonomous loop** - Self-improvement cycle

```
┌─────────────────────────────────────────────────────────────────┐
│                                                                 │
│    ┌─────────────────┐         ┌─────────────────┐             │
│    │   Interactive   │         │   Autonomous    │             │
│    │     Session     │         │      Loop       │             │
│    │                 │         │                 │             │
│    │  User requests  │         │  Self-improve   │             │
│    └────────┬────────┘         └────────┬────────┘             │
│             │                           │                       │
│             └───────────┬───────────────┘                       │
│                         │                                       │
│                         ▼                                       │
│             ┌─────────────────────┐                            │
│             │   Coding Interface  │                            │
│             │                     │                            │
│             │  - Repo map         │                            │
│             │  - Context manager  │                            │
│             │  - Tool suite       │                            │
│             │  - Validation       │                            │
│             └─────────────────────┘                            │
│                         │                                       │
│                         ▼                                       │
│             ┌─────────────────────┐                            │
│             │   Hermes / Qwen     │                            │
│             └─────────────────────┘                            │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## Implementation Roadmap

### Phase 1: Core Tools
- [ ] Implement `read` tool with token counting
- [ ] Implement `edit` tool with search/replace
- [ ] Implement `write` tool with validation
- [ ] Implement `glob` and `grep` tools

### Phase 2: Repo Map
- [ ] Integrate tree-sitter for TypeScript
- [ ] Symbol extraction (functions, classes, types)
- [ ] Dependency graph building
- [ ] PageRank scoring
- [ ] Token budget management

### Phase 3: Context Manager
- [ ] File tracking
- [ ] Token budget allocation
- [ ] Auto-suggest relevant files
- [ ] Context window optimization

### Phase 4: Session Memory
- [ ] Session state persistence
- [ ] Todo tracking
- [ ] Decision logging
- [ ] Cross-session learning

### Phase 5: Validation Loop
- [ ] Lint integration
- [ ] TypeCheck integration
- [ ] Test runner integration
- [ ] Auto-commit with conventional messages

### Phase 6: Modes
- [ ] Code mode implementation
- [ ] Architect mode implementation
- [ ] Ask mode implementation
- [ ] Mode switching

---

## Configuration

**File**: `config/coding.yaml`

```yaml
coding:
  # Repo map settings
  repo_map:
    enabled: true
    token_budget: 2048
    token_budget_max: 8192
    refresh_on_change: true

  # Context settings
  context:
    max_files: 10
    max_file_tokens: 8000
    auto_add_imports: true
    auto_add_tests: true

  # Edit settings
  edit:
    format: search_replace      # search_replace | whole_file | diff
    require_exact_match: true
    show_diff_preview: true

  # Validation settings
  validation:
    parse_check: true
    lint_on_edit: true
    typecheck_on_edit: true
    test_on_edit: false
    auto_commit: true

  # Model routing
  models:
    architect: hermes3:70b
    code: qwen3-coder-next:latest
    ask: hermes3:70b
    review: qwen3-coder-next:latest

  # Session settings
  session:
    persist: true
    persist_path: ~/.casterly/sessions/
    max_history_tokens: 10000
```

---

## References

- [Aider Repo Map](https://aider.chat/docs/repomap.html)
- [Building a better repository map with tree-sitter](https://aider.chat/2023/10/22/repomap.html)
- [Tree-sitter](https://tree-sitter.github.io/tree-sitter/)
- [py-tree-sitter-languages](https://github.com/grantjenks/py-tree-sitter-languages)
