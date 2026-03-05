# Coding Interface

> **Status**: Implemented — see `src/coding/` for source
> **Inspiration**: [Aider](https://github.com/Aider-AI/aider) repo map architecture
> **Last Updated**: 2026-02-15

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
              │  qwen3.5:122b (reason+code)   │
              │  qwen3.5:35b-a3b (fast loop)  │
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
  architect: 'qwen3.5:122b';

  // Code implementation
  code: 'qwen3.5:122b';

  // Quick questions, explanations
  ask: 'qwen3.5:122b';

  // Code review (fast model for speed)
  review: 'qwen3.5:35b-a3b';
}
```

**Routing logic**:

```typescript
function routeToModel(mode: Mode, task: string): string {
  switch (mode) {
    case 'architect':
      return 'qwen3.5:122b';      // Reasoning for planning

    case 'code':
      return 'qwen3.5:122b';      // Reasoning + code generation

    case 'ask':
      return 'qwen3.5:122b';      // All questions use DeepLoop

    case 'review':
      return 'qwen3.5:35b-a3b';   // Fast triage/review (MoE)
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

### Phase 1: Core Tools — COMPLETE
- [x] Implement `read` tool with token counting
- [x] Implement `edit` tool with search/replace
- [x] Implement `write` tool with validation
- [x] Implement `glob` and `grep` tools

### Phase 2: Repo Map — COMPLETE
- [x] TypeScript symbol extraction (functions, classes, types, exports)
- [x] Dependency graph building via import analysis
- [x] PageRank scoring (`src/coding/repo-map/pagerank.ts`)
- [x] Token budget management
- [ ] Add extractors for non-JS/TS languages (TODO in `builder.ts`)
- [ ] Incremental repo map updates (TODO in `builder.ts`)

### Phase 3: Context Manager — COMPLETE
- [x] File tracking
- [x] Token budget allocation via context profiles
- [x] Auto-suggest relevant files (`src/coding/auto-context.ts`)
- [x] Context window optimization via scoped profiles

### Phase 4: Session Memory — COMPLETE
- [x] Session state persistence (`src/interface/session.ts`)
- [x] Todo tracking (via interface memory)
- [x] Decision logging
- [x] Cross-session learning (via interface bootstrap + memory)

### Phase 5: Validation Loop — COMPLETE
- [x] Parse check (`src/coding/validation/parser.ts`)
- [x] Lint integration (`src/coding/validation/runner.ts`)
- [x] TypeCheck integration (`src/coding/validation/runner.ts`)
- [x] Validation pipeline (`src/coding/validation/pipeline.ts`)

### Phase 6: Modes — COMPLETE
- [x] Code mode implementation
- [x] Architect mode implementation
- [x] Ask mode implementation
- [x] Review mode implementation
- [x] Mode definitions (`src/coding/modes/definitions.ts`)

---

## Undo & Rollback

Every edit is reversible. The system maintains a history stack for rollback.

### Edit History

```typescript
interface EditHistory {
  entries: EditEntry[];
  maxEntries: number;        // Default: 100
}

interface EditEntry {
  id: string;
  timestamp: string;
  file: string;
  type: 'edit' | 'write' | 'delete';
  before: string;            // Content before change
  after: string;             // Content after change
  commitHash?: string;       // If auto-committed
}
```

### Undo Commands

| Command | Action |
|---------|--------|
| `/undo` | Undo last edit |
| `/undo 3` | Undo last 3 edits |
| `/undo file.ts` | Undo all edits to specific file |
| `/history` | Show edit history |
| `/diff` | Show uncommitted changes |
| `/reset` | Reset to last commit (discard all changes) |

### Git Integration for Rollback

```typescript
async function undoEdit(entry: EditEntry): Promise<void> {
  // 1. Restore file content
  await fs.writeFile(entry.file, entry.before);

  // 2. If was committed, create revert commit
  if (entry.commitHash) {
    await git.revert(entry.commitHash);
  }

  // 3. Re-run validation
  await validate(entry.file);
}
```

---

## Error Recovery

When validation fails, the system helps the model recover.

### Failure Flow

```
Edit applied
      │
      ▼
Validation fails (e.g., type error)
      │
      ▼
┌─────────────────────────────────────────┐
│  1. Auto-revert the failed edit         │
│  2. Show the error to the model         │
│  3. Include error context (file, line)  │
│  4. Model attempts fix                  │
│  5. Retry validation                    │
│  6. Max 3 retries before giving up      │
└─────────────────────────────────────────┘
```

### Error Feedback Format

```typescript
interface ValidationFeedback {
  success: false;
  originalEdit: EditRequest;
  errors: Array<{
    type: 'parse' | 'lint' | 'typecheck' | 'test';
    file: string;
    line: number;
    column?: number;
    message: string;
    suggestion?: string;      // From linter/tsc if available
    codeFrame?: string;       // Surrounding code for context
  }>;
  retryCount: number;
  maxRetries: number;
}
```

### Retry Strategy

```typescript
async function editWithRetry(
  request: EditRequest,
  maxRetries: number = 3
): Promise<EditResult> {
  let lastError: ValidationFeedback | null = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    // Apply edit
    const backup = await readFile(request.path);
    await applyEdit(request);

    // Validate
    const validation = await validate(request.path);

    if (validation.passed) {
      return { success: true, attempt };
    }

    // Revert and prepare feedback
    await writeFile(request.path, backup);
    lastError = {
      success: false,
      originalEdit: request,
      errors: validation.errors,
      retryCount: attempt + 1,
      maxRetries,
    };

    // Let model see the error and try again
    const fixedRequest = await askModelToFix(lastError);
    request = fixedRequest;
  }

  return { success: false, error: lastError };
}
```

---

## Multi-File Edits

Coordinating changes across multiple files atomically.

### Transaction Model

```typescript
interface EditTransaction {
  id: string;
  edits: EditRequest[];
  status: 'pending' | 'applied' | 'committed' | 'rolled_back';
  backups: Map<string, string>;   // File path → original content
}

async function executeTransaction(tx: EditTransaction): Promise<void> {
  // 1. Backup all files
  for (const edit of tx.edits) {
    tx.backups.set(edit.path, await readFile(edit.path));
  }

  // 2. Apply all edits
  for (const edit of tx.edits) {
    await applyEdit(edit);
  }
  tx.status = 'applied';

  // 3. Validate ALL files together (cross-file type checking)
  const validation = await validateAll(tx.edits.map(e => e.path));

  if (!validation.passed) {
    // 4a. Rollback all on failure
    for (const [path, content] of tx.backups) {
      await writeFile(path, content);
    }
    tx.status = 'rolled_back';
    throw new ValidationError(validation.errors);
  }

  // 4b. Commit all on success
  await git.add(tx.edits.map(e => e.path));
  await git.commit(generateCommitMessage(tx.edits));
  tx.status = 'committed';
}
```

### Dependency-Aware Ordering

When editing multiple files, order matters for validation:

```typescript
function orderEdits(edits: EditRequest[]): EditRequest[] {
  // 1. Build dependency graph from imports
  const deps = buildDependencyGraph(edits.map(e => e.path));

  // 2. Topological sort - edit dependencies first
  return topologicalSort(edits, deps);
}
```

---

## Conversation Summarization

When conversation history exceeds token budget, compress it.

### Summarization Strategy

```
┌─────────────────────────────────────────────────────────────────┐
│                    CONVERSATION WINDOW                          │
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  Summary of older messages                    (~500 tok) │  │
│  │  "Previously: Added auth system, fixed 3 bugs..."       │  │
│  ├──────────────────────────────────────────────────────────┤  │
│  │  Recent messages (full content)              (~8000 tok) │  │
│  │  - Last 5-10 turns preserved verbatim                   │  │
│  │  - All code blocks preserved                            │  │
│  │  - All file paths preserved                             │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Summarization Implementation

```typescript
interface ConversationCompressor {
  // Trigger compression when exceeds budget
  maxTokens: number;            // e.g., 10000

  // Always preserve these recent turns
  preserveRecentTurns: number;  // e.g., 5

  // Summary target size
  summaryMaxTokens: number;     // e.g., 500
}

async function compressConversation(
  messages: Message[],
  config: ConversationCompressor
): Promise<Message[]> {
  const currentTokens = countTokens(messages);

  if (currentTokens <= config.maxTokens) {
    return messages;
  }

  // Split into old and recent
  const recent = messages.slice(-config.preserveRecentTurns * 2);
  const old = messages.slice(0, -config.preserveRecentTurns * 2);

  // Summarize old messages
  const summary = await summarizeMessages(old, config.summaryMaxTokens);

  // Return summary + recent
  return [
    { role: 'system', content: `Previous conversation summary:\n${summary}` },
    ...recent,
  ];
}

async function summarizeMessages(
  messages: Message[],
  maxTokens: number
): Promise<string> {
  // Use Hermes for summarization (good at reasoning)
  const prompt = `Summarize this conversation, preserving:
- Key decisions made and reasoning
- Files that were modified
- Any unresolved issues or todos
- Important context for continuing the task

Conversation:
${formatMessages(messages)}

Summary (be concise):`;

  return await llm.generate(prompt, { maxTokens });
}
```

---

## User Commands

CLI commands for controlling the coding interface.

### File Management

| Command | Action |
|---------|--------|
| `/add <file>` | Add file to context |
| `/add <glob>` | Add files matching pattern |
| `/drop <file>` | Remove file from context |
| `/drop *` | Remove all files from context |
| `/files` | List files in context |

### Mode Switching

| Command | Action |
|---------|--------|
| `/code` | Switch to code mode (default) |
| `/architect` | Switch to architect mode |
| `/ask` | Switch to ask mode |
| `/review` | Switch to review mode |

### Git Operations

| Command | Action |
|---------|--------|
| `/commit` | Commit staged changes with generated message |
| `/commit -m "msg"` | Commit with custom message |
| `/diff` | Show uncommitted changes |
| `/undo` | Undo last edit |
| `/reset` | Discard all uncommitted changes |

### Navigation

| Command | Action |
|---------|--------|
| `/find <query>` | Search codebase for query |
| `/goto <file:line>` | Jump to file and line |
| `/map` | Show current repo map |

### Session

| Command | Action |
|---------|--------|
| `/save` | Save session state |
| `/load <id>` | Load previous session |
| `/clear` | Clear conversation history |
| `/tokens` | Show token usage breakdown |

### Implementation

```typescript
function parseCommand(input: string): Command | null {
  if (!input.startsWith('/')) return null;

  const [cmd, ...args] = input.slice(1).split(' ');

  switch (cmd) {
    case 'add':
      return { type: 'add_file', pattern: args.join(' ') };
    case 'drop':
      return { type: 'drop_file', pattern: args.join(' ') };
    case 'code':
    case 'architect':
    case 'ask':
    case 'review':
      return { type: 'switch_mode', mode: cmd };
    case 'undo':
      return { type: 'undo', count: parseInt(args[0]) || 1 };
    case 'commit':
      return { type: 'commit', message: args.join(' ') || undefined };
    // ... etc
    default:
      return null;
  }
}
```

---

## Linter Auto-Fix

Integration with auto-fixable lint and format errors.

### Auto-Fix Flow

```
Edit applied
      │
      ▼
Lint check
      │
      ├── No errors → Continue
      │
      └── Has errors
            │
            ├── All auto-fixable?
            │         │
            │         └── Yes → Apply fixes automatically
            │                        │
            │                        ▼
            │                   Re-validate
            │
            └── Some manual fixes needed
                      │
                      ▼
                Show errors to model for manual fix
```

### Configuration

```yaml
linting:
  auto_fix: true                    # Enable auto-fix for fixable errors
  fix_on_save: true                 # Fix on every edit
  formatters:
    typescript: prettier
    python: black
    rust: rustfmt
  rules:
    # Auto-fix these silently
    auto_fix_rules:
      - "no-unused-vars"
      - "indent"
      - "quotes"
      - "semi"
    # Always show these to model
    manual_fix_rules:
      - "no-any"
      - "complexity"
```

### Implementation

```typescript
async function lintWithAutoFix(file: string): Promise<LintResult> {
  // 1. Run linter with fix flag
  const result = await runLinter(file, { fix: true });

  // 2. Separate auto-fixed from remaining
  const autoFixed = result.fixed;
  const remaining = result.errors.filter(e => !e.fixable);

  // 3. If we fixed anything, file was modified
  if (autoFixed.length > 0) {
    log(`Auto-fixed ${autoFixed.length} issues in ${file}`);
  }

  return {
    passed: remaining.length === 0,
    autoFixed,
    errors: remaining,
  };
}
```

---

## Import Management

Automatically handle imports when editing code.

### Auto-Import Detection

When the model adds code that uses a symbol:

1. Check if symbol is imported
2. If not, find where it's exported from (using repo map)
3. Add the import automatically

```typescript
async function resolveImports(
  file: string,
  newCode: string
): Promise<string[]> {
  const ast = parse(newCode);
  const usedSymbols = extractUsedSymbols(ast);
  const existingImports = extractImports(await readFile(file));

  const missingImports: ImportStatement[] = [];

  for (const symbol of usedSymbols) {
    if (!existingImports.has(symbol) && !isBuiltin(symbol)) {
      // Find in repo map
      const source = repoMap.findExport(symbol);
      if (source) {
        missingImports.push({
          symbol,
          from: relativePath(file, source),
        });
      }
    }
  }

  return missingImports;
}
```

### Import Cleanup

Remove unused imports after editing:

```typescript
async function cleanupImports(file: string): Promise<void> {
  const content = await readFile(file);
  const ast = parse(content);

  const imports = extractImports(ast);
  const usedSymbols = extractUsedSymbols(ast);

  const unusedImports = [...imports].filter(i => !usedSymbols.has(i));

  if (unusedImports.length > 0) {
    const cleaned = removeImports(content, unusedImports);
    await writeFile(file, cleaned);
  }
}
```

---

## Smart Test Selection

Run only tests relevant to changed files.

### Test Mapping

Build a map of which tests cover which source files:

```typescript
interface TestMap {
  // Source file → Test files that import/test it
  sourceToTests: Map<string, string[]>;

  // Test file → Source files it tests
  testToSources: Map<string, string[]>;
}

function buildTestMap(repoMap: RepoMap): TestMap {
  const map: TestMap = {
    sourceToTests: new Map(),
    testToSources: new Map(),
  };

  for (const file of repoMap.files) {
    if (isTestFile(file.path)) {
      // Find which source files this test imports
      const sources = file.references.filter(r => !isTestFile(r));
      map.testToSources.set(file.path, sources);

      for (const source of sources) {
        const existing = map.sourceToTests.get(source) || [];
        map.sourceToTests.set(source, [...existing, file.path]);
      }
    }
  }

  return map;
}
```

### Running Relevant Tests

```typescript
async function runRelevantTests(
  changedFiles: string[]
): Promise<TestResult> {
  const testMap = await getTestMap();

  // Find all tests that cover changed files
  const testsToRun = new Set<string>();

  for (const file of changedFiles) {
    const tests = testMap.sourceToTests.get(file) || [];
    for (const test of tests) {
      testsToRun.add(test);
    }
  }

  if (testsToRun.size === 0) {
    return { passed: true, skipped: true, reason: 'No relevant tests' };
  }

  // Run only those tests
  return await runTests([...testsToRun]);
}
```

---

## Git Workflow

Detailed git integration for the coding interface.

### Branch Management

```typescript
interface GitConfig {
  // Auto-create feature branches for tasks
  autoCreateBranch: boolean;
  branchPrefix: string;          // e.g., "tyrion/"

  // Commit behavior
  autoCommit: boolean;
  commitStyle: 'conventional' | 'descriptive';

  // Safety
  protectedBranches: string[];   // Never commit directly to these
  requireCleanWorktree: boolean; // Fail if uncommitted changes exist
}
```

### Stash on Context Switch

```typescript
async function switchTask(newTask: string): Promise<void> {
  // 1. Check for uncommitted changes
  const status = await git.status();

  if (status.modified.length > 0) {
    // 2. Stash current work
    await git.stash.push({
      message: `WIP: ${currentTask}`,
      includeUntracked: true,
    });
  }

  // 3. Switch to new branch or create it
  const branch = `tyrion/${slugify(newTask)}`;

  if (await git.branchExists(branch)) {
    await git.checkout(branch);
    // Restore any stashed work for this branch
    await git.stash.pop({ branch });
  } else {
    await git.checkout('-b', branch);
  }

  // 4. Update session
  session.currentTask = newTask;
}
```

### Conflict Resolution

```typescript
async function handleConflict(file: string): Promise<void> {
  const content = await readFile(file);

  // Extract conflict markers
  const conflicts = parseConflicts(content);

  // Present to model for resolution
  const prompt = `This file has merge conflicts. Resolve them:

File: ${file}

${conflicts.map(c => `
<<<<<<< OURS
${c.ours}
=======
${c.theirs}
>>>>>>> THEIRS

Context: ${c.context}
`).join('\n')}

Provide the resolved content:`;

  const resolved = await llm.generate(prompt);

  // Apply resolution
  await writeFile(file, resolved);
  await git.add(file);
}
```

---

## Token Counting

Accurate token counting for context management.

### Token Counter Implementation

```typescript
import { encode } from 'gpt-tokenizer';  // Or tiktoken for accuracy

interface TokenCounter {
  count(text: string): number;
  countMessages(messages: Message[]): number;
  estimate(text: string): number;  // Fast approximation
}

const tokenCounter: TokenCounter = {
  count(text: string): number {
    // Use actual tokenizer for accuracy
    return encode(text).length;
  },

  countMessages(messages: Message[]): number {
    let total = 0;
    for (const msg of messages) {
      // Each message has overhead (~4 tokens for role, formatting)
      total += 4;
      total += this.count(msg.content);
    }
    // Plus conversation overhead
    total += 3;
    return total;
  },

  estimate(text: string): number {
    // Fast approximation: ~4 chars per token for English
    // Adjust for code which is denser
    const codeRatio = (text.match(/[{}();=]/g) || []).length / text.length;
    const charsPerToken = 4 - (codeRatio * 1.5);  // Code is 2.5-4 chars/token
    return Math.ceil(text.length / charsPerToken);
  },
};
```

### Budget Enforcement

```typescript
class ContextBudget {
  private budget: TokenBudget;
  private counter: TokenCounter;

  canAddFile(file: string, content: string): boolean {
    const tokens = this.counter.count(content);
    const currentFileTokens = this.budget.files;
    const maxFileTokens = this.budget.total - this.budget.system
                         - this.budget.repoMap - this.budget.conversation
                         - this.budget.response;

    return currentFileTokens + tokens <= maxFileTokens;
  }

  addFile(path: string, content: string): void {
    if (!this.canAddFile(path, content)) {
      throw new Error(`Cannot add ${path}: would exceed token budget`);
    }
    this.budget.files += this.counter.count(content);
  }

  getRemaining(): number {
    return this.budget.total - this.used();
  }

  private used(): number {
    return this.budget.system + this.budget.repoMap +
           this.budget.files + this.budget.conversation +
           this.budget.tools;
  }
}
```

---

## Caching

Cache expensive operations for performance.

### What to Cache

| Data | TTL | Invalidation |
|------|-----|--------------|
| Parsed ASTs | 5 min | File modification |
| Repo map | 1 min | Any file change |
| Token counts | Forever | Content change |
| Test map | 5 min | Test file change |
| Lint results | 1 min | File modification |

### Cache Implementation

```typescript
interface Cache<T> {
  get(key: string): T | undefined;
  set(key: string, value: T, ttlMs?: number): void;
  invalidate(key: string): void;
  invalidatePattern(pattern: RegExp): void;
}

class RepoMapCache {
  private cache: Cache<RepoMap>;
  private lastBuildTime: number = 0;
  private fileWatcher: FSWatcher;

  constructor() {
    // Watch for file changes
    this.fileWatcher = watch('src/**/*', {
      ignored: /node_modules/,
    });

    this.fileWatcher.on('change', (path) => {
      this.invalidate();
    });
  }

  async get(): Promise<RepoMap> {
    const cached = this.cache.get('repomap');
    if (cached) return cached;

    const map = await buildRepoMap();
    this.cache.set('repomap', map, 60_000);  // 1 min TTL
    return map;
  }

  invalidate(): void {
    this.cache.invalidate('repomap');
  }
}
```

### AST Cache

```typescript
class ASTCache {
  private cache: Map<string, { ast: AST; mtime: number }> = new Map();

  async get(file: string): Promise<AST> {
    const stat = await fs.stat(file);
    const cached = this.cache.get(file);

    if (cached && cached.mtime === stat.mtimeMs) {
      return cached.ast;
    }

    const content = await fs.readFile(file, 'utf-8');
    const ast = parse(content);

    this.cache.set(file, { ast, mtime: stat.mtimeMs });
    return ast;
  }
}
```

---

## Language Support

Different languages need different handling.

### Language Registry

```typescript
interface LanguageHandler {
  id: string;
  extensions: string[];
  treeSitterLanguage: string;

  // Symbol extraction
  extractSymbols(ast: AST): Symbol[];

  // Import handling
  extractImports(ast: AST): Import[];
  addImport(content: string, imp: Import): string;
  removeImport(content: string, imp: Import): string;

  // Formatting
  format(content: string): Promise<string>;

  // Linting
  lint(file: string): Promise<LintResult>;

  // Testing
  isTestFile(path: string): boolean;
  runTests(files: string[]): Promise<TestResult>;
}

const languages: Map<string, LanguageHandler> = new Map([
  ['typescript', typescriptHandler],
  ['javascript', javascriptHandler],
  ['python', pythonHandler],
  ['rust', rustHandler],
  ['go', goHandler],
]);

function getHandler(file: string): LanguageHandler {
  const ext = path.extname(file);
  for (const [id, handler] of languages) {
    if (handler.extensions.includes(ext)) {
      return handler;
    }
  }
  throw new Error(`No handler for ${ext}`);
}
```

### TypeScript Handler

```typescript
const typescriptHandler: LanguageHandler = {
  id: 'typescript',
  extensions: ['.ts', '.tsx', '.mts', '.cts'],
  treeSitterLanguage: 'typescript',

  extractSymbols(ast: AST): Symbol[] {
    const symbols: Symbol[] = [];

    // Functions
    for (const node of ast.query('(function_declaration name: (identifier) @name)')) {
      symbols.push({
        name: node.text,
        kind: 'function',
        signature: extractSignature(node.parent),
        line: node.startPosition.row + 1,
        exported: isExported(node.parent),
      });
    }

    // Classes, interfaces, types, etc.
    // ...

    return symbols;
  },

  async format(content: string): Promise<string> {
    return prettier.format(content, { parser: 'typescript' });
  },

  async lint(file: string): Promise<LintResult> {
    const eslint = new ESLint({ fix: true });
    const results = await eslint.lintFiles([file]);
    return parseLintResults(results);
  },

  isTestFile(path: string): boolean {
    return /\.(test|spec)\.[tj]sx?$/.test(path) ||
           path.includes('__tests__');
  },

  async runTests(files: string[]): Promise<TestResult> {
    const result = await exec(`npx vitest run ${files.join(' ')}`);
    return parseVitestOutput(result);
  },
};
```

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
    architect: qwen3.5:122b
    code: qwen3.5:122b
    ask: qwen3.5:122b
    review: qwen3.5:35b-a3b

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
