# Tools & Skills

> **Source**: `src/tools/`, `src/skills/`, `src/autonomous/tools/`

Tyrion has two capability systems: **native tools** (compiled executors) and **skills** (drop-in markdown packages loaded at startup). Both are surfaced to the LLM through the same tool-use protocol.

## Native Tools

### Tool System

Every tool is a `ToolSchema` with a name, description, and JSON Schema for parameters. The tool registry manages schemas and converts between Anthropic and Ollama wire formats.

The tool orchestrator maps tool names to executors. `executeAll()` runs multiple tool calls concurrently when safe.

### Core Tools (13)

| Tool | Purpose |
|------|---------|
| `read_file` | Read file contents with optional line range |
| `write_file` | Write or overwrite file |
| `edit_file` | Search-and-replace edit with diff preview |
| `list_files` | List directory contents |
| `glob_files` | Find files matching glob patterns |
| `grep_files` | Search file contents with regex |
| `search_files` | Combined grep + glob search |
| `validate_files` | Validate file syntax (TypeScript, JSON) |
| `bash` | Execute shell commands (gated by safety tiers) |
| `http_get` | Fetch URL content (sanitized before return) |
| `send_message` | Send message via iMessage or console |
| `think` | Private reasoning scratchpad (not sent to user) |
| `echo` | Return input text as output |

### Agent Tools (96 total)

The autonomous agent extends core tools with specialized capabilities:

| Category | Examples |
|----------|----------|
| **Self-Knowledge** | `crystallize`, `create_rule`, `replay`, `compare_traces` |
| **Self-Improvement** | `edit_prompt`, `shadow`, `create_tool`, `evolve_prompt` |
| **Introspection** | `peek_queue`, `check_budget`, `list_context`, `assess_self` |
| **Context Control** | `load_context`, `evict_context`, `set_budget`, `semantic_recall` |
| **Autonomous** | `schedule`, `meta`, `classify`, `plan`, `verify`, `parallel_reason` |
| **Communication** | `message_user`, `file_issue`, `update_goal` |

Tool presets (`buildPresetToolkit()`) control which tools are available per context (e.g., FastLoop gets a filtered subset via `src/dual-loop/fast-tools.ts`).

## Skills (Drop-in Packages)

Skills are markdown files (`SKILL.md`) discovered at startup from the `skills/` directory. Each skill declares:

- Name and description
- Tools it provides (with JSON Schema parameters)
- System prompt additions
- Trigger patterns (when to activate)

Skills are merged into the tool registry alongside native tools. The skill registry provides `getRelevantSkillInstr()` for context-aware skill injection into prompts.

## Tool Synthesis

> **Source**: `src/tools/synthesizer.ts`

The LLM can create custom tools at runtime via the `create_tool` agent tool. Synthesized tools use bash template implementations with `{{param}}` substitution. Templates are scanned against 13 dangerous patterns before creation. Max 20 synthesized tools, unused tools flagged after 30 days.

See [memory-and-state.md](memory-and-state.md) for details on the tool store.

## Key Files

| File | Purpose |
|------|---------|
| `src/tools/schemas/` | Core tool schema definitions |
| `src/tools/executors/` | Core tool executor implementations |
| `src/tools/registry.ts` | Tool schema registry and format conversion |
| `src/tools/orchestrator.ts` | Tool execution routing and concurrency |
| `src/tools/executor.ts` | Shell command safety gates |
| `src/tools/synthesizer.ts` | LLM-authored tool synthesis |
| `src/autonomous/tools/` | Agent tool registry, map, and helpers |
| `src/dual-loop/fast-tools.ts` | Filtered toolkit for FastLoop |
| `src/skills/` | Skill types, discovery, registration |
| `skills/` | Drop-in skill packages |
