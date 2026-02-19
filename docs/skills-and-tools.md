# Skills & Tools

> **Source**: `src/tools/`, `src/skills/`, `skills/`

Tyrion has two complementary capability systems: **native tools** (built-in, typed executors compiled into the binary) and **skills** (drop-in markdown packages loaded from disk at startup). Both are surfaced to the LLM through the same tool-use protocol.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        Tool Registry                            │
│  Holds ToolSchema[] — name, description, JSON Schema params     │
│  Formats for Anthropic or Ollama/OpenAI wire format             │
└──────────┬──────────────────────────────┬───────────────────────┘
           │                              │
    CORE_TOOLS (compiled)         Skill tools (loaded from SKILL.md)
           │                              │
           ▼                              ▼
┌──────────────────────┐   ┌──────────────────────────┐
│  Tool Orchestrator   │   │  Skill Registry          │
│  Map<name, executor> │   │  Map<id, Skill>          │
│  execute(call)       │   │  getRelevantSkillInstr() │
│  executeAll(calls[]) │   │  getPromptSection()      │
└──────────────────────┘   │  getTools()              │
                           └──────────────────────────┘
```

---

## Native Tools

### Type System

Every tool is a `ToolSchema`:

```typescript
interface ToolSchema {
  name: string;             // Unique name the LLM uses to invoke it
  description: string;      // Human-readable description
  inputSchema: {            // JSON Schema for parameters
    type: 'object';
    properties: Record<string, ToolProperty>;
    required: string[];
  };
}
```

Tool calls and results are typed:

```typescript
interface NativeToolCall {
  id: string;                       // Match request to response
  name: string;                     // Tool name
  input: Record<string, unknown>;   // Structured params
}

interface NativeToolResult {
  toolCallId: string;
  success: boolean;
  output?: string;
  error?: string;
  exitCode?: number;
}
```

### Tool Registry

`createToolRegistry()` manages all tool schemas and converts between provider formats:

| Method | Purpose |
|--------|---------|
| `register(tool)` | Add a tool schema |
| `getTools()` | All registered schemas |
| `getTool(name)` | Lookup by name |
| `formatForAnthropic()` | Convert to `{ name, description, input_schema }` |
| `formatForOllama()` | Convert to `{ type: "function", function: { name, description, parameters } }` |

Core tools are registered by default.

### Tool Orchestrator

`createToolOrchestrator()` maps tool names to executor functions and dispatches calls:

| Method | Purpose |
|--------|---------|
| `registerExecutor(executor)` | Register a `{ toolName, execute }` pair |
| `canExecute(name)` | Check if executor exists |
| `execute(call)` | Execute a single tool call |
| `executeAll(calls)` | Execute calls sequentially, continue on failure |
| `getRegisteredTools()` | List registered tool names |

### Core Tools (13 total)

Registered by default via `CORE_TOOLS`:

#### File Tools (5)

| Tool | Description | Key Params |
|------|-------------|------------|
| `read_file` | Read file contents with optional line limit | `path`, `encoding?`, `maxLines?` |
| `write_file` | Write/append to file, creates parent dirs | `path`, `content`, `append?` |
| `list_files` | List directory entries with type and size | `path`, `recursive?`, `pattern?` |
| `search_files` | Regex search across files | `pattern`, `path?`, `filePattern?`, `maxResults?` |
| `read_document` | Parse binary docs (PDF, DOCX, XLSX, CSV, ZIP) | `path`, `maxPages?`, `maxRows?`, `format?`, `sheet?` |

**`write_file` rule**: User documents (budgets, notes, lists) go to `~/Documents/Tyrion/`, not the project repo.

**`read_document` formats**: PDF (text + metadata), DOCX (text or HTML), XLSX (structured rows per sheet), CSV (headers + rows), ZIP/TAR.GZ (archive listing). Format detected by magic bytes first, then extension.

#### Coding Tools (4)

| Tool | Description | Key Params |
|------|-------------|------------|
| `edit_file` | Search/replace in existing file with diff preview | `path`, `search`, `replace`, `replaceAll?` |
| `glob_files` | Pattern-based file discovery with metadata | `pattern`, `cwd?`, `filesOnly?`, `maxDepth?` |
| `grep_files` | Content search with context lines | `pattern`, `cwd?`, `include?`, `ignoreCase?`, `literal?`, `contextBefore?`, `contextAfter?`, `maxMatches?` |
| `validate_files` | Run parse/lint/typecheck/test pipeline | `files`, `quick?`, `skipTest?` |

#### Messaging Tools (1)

| Tool | Description | Key Params |
|------|-------------|------------|
| `send_message` | Send iMessage to phone number or email | `recipient`, `text` |

Not for replying to the current sender (that's automatic). Must use this tool, not bash + osascript.

#### Productivity Tools (3)

| Tool | Description | Key Params |
|------|-------------|------------|
| `calendar_read` | Read Apple Calendar events via AppleScript | `from?`, `to?`, `calendar?`, `limit?` |
| `reminder_create` | Create Apple Reminder | `title`, `dueDate?`, `notes?`, `list?`, `priority?` |
| `http_get` | HTTP GET with safety guards | `url`, `headers?`, `timeout?`, `maxSize?` |

**`http_get` safety**: GET only. Blocks private/internal IPs (localhost, 10.x, 172.16-31.x, 192.168.x, link-local, cloud metadata). Blocks `file:`, `ftp:`, `data:`, `javascript:` schemes. Blocks `Cookie` and `Authorization` headers. 30s default timeout, 2MB default / 10MB max response.

#### Shell Fallback (1)

| Tool | Description |
|------|-------------|
| `bash` | General-purpose shell execution via `/bin/zsh` |

The LLM is instructed to prefer native tools over bash equivalents. Bash goes through the three-tier safety gate (BLOCKED / APPROVAL_REQUIRED / SAFE) documented in `docs/security.md`.

### Executor Registration

All 13 native executors are registered in `registerNativeExecutors()`:

```text
Core file:    read_file, write_file, list_files, search_files, read_document
Coding:       edit_file, glob_files, grep_files, validate_files
Messaging:    send_message
Productivity: calendar_read, reminder_create, http_get
```

Bash execution is registered separately.

---

## Agent Tools (71)

In addition to the 13 native tools above, the autonomous agent loop has 58 additional tools defined in `src/autonomous/agent-tools.ts`. These are only available when the ReAct agent loop is running — not in interactive/pipeline mode.

See [autonomous-agent.md](autonomous-agent.md) for the full catalog. Key categories:

| Category | Tools |
|----------|-------|
| Reasoning | `think` |
| File ops | `read_file`, `edit_file`, `create_file` |
| Search | `grep`, `glob` |
| System | `bash` |
| Quality | `run_tests`, `typecheck`, `lint` |
| Git | `git_status`, `git_diff`, `git_commit`, `git_log` |
| State | `file_issue`, `close_issue`, `update_goal` |
| Memory | `recall`, `archive`, `recall_journal`, `consolidate` |
| World | `update_world_model`, `adversarial_test` |
| Self-knowledge (crystals) | `crystallize`, `dissolve`, `list_crystals` |
| Self-knowledge (constitution) | `create_rule`, `update_rule`, `list_rules` |
| Self-knowledge (traces) | `replay`, `compare_traces`, `search_traces` |
| Self-improvement (prompts) | `edit_prompt`, `revert_prompt`, `get_prompt` |
| Self-improvement (shadows) | `shadow`, `list_shadows` |
| Self-improvement (tools) | `create_tool`, `manage_tools`, `list_custom_tools` |
| Advanced self-improvement (challenges) | `run_challenges`, `challenge_history` |
| Advanced self-improvement (evolution) | `evolve_prompt`, `evolution_status` |
| Advanced self-improvement (LoRA) | `extract_training_data`, `list_adapters`, `load_adapter` |
| Pipeline control (Roadmap Phase 1) | `meta` |
| Promoted pipeline (Roadmap Phase 2) | `classify`, `plan`, `verify` |
| Introspection (Roadmap Phase 3) | `peek_queue`, `check_budget`, `list_context`, `review_steps`, `assess_self` |
| Context control (Roadmap Phase 4) | `load_context`, `evict_context`, `set_budget` |
| Self-initiated triggers (Roadmap Phase 5) | `schedule`, `list_schedules`, `cancel_schedule` |
| Semantic memory | `semantic_recall` |
| Parallel reasoning | `parallel_reason` |
| Dream cycle phases | `consolidate_reflections`, `reorganize_goals`, `explore_codebase`, `rebuild_self_model`, `write_retrospective` |
| Delegation | `delegate` |
| Communication | `message_user` |

The self-knowledge tools (9 total) are part of Vision Tier 1. They enable the agent to learn from experience (crystals), author its own operational rules (constitution), and debug past failures (trace replay).

The self-improvement tools (8 total) are part of Vision Tier 2. They enable the agent to modify its own prompts, record and analyze alternative approaches (shadows), and synthesize new tools.

The advanced self-improvement tools (7 total) are part of Vision Tier 3. They enable the agent to generate adversarial challenges for self-testing (`run_challenges`, `challenge_history`), evolve its system prompt through genetic algorithms (`evolve_prompt`, `evolution_status`), and manage LoRA fine-tuning data and adapters (`extract_training_data`, `list_adapters`, `load_adapter`).

The roadmap tools (18 total) implement the Vision Roadmap Phases 1-5 plus supporting work. They enable the LLM to override the pipeline (`meta`), optionally classify/plan/verify (`classify`, `plan`, `verify`), introspect its own state (`peek_queue`, `check_budget`, `list_context`, `review_steps`, `assess_self`), control its context window (`load_context`, `evict_context`, `set_budget`), create its own triggers (`schedule`, `list_schedules`, `cancel_schedule`), use semantic memory (`semantic_recall`), and request parallel multi-model inference (`parallel_reason`).

---

## Skills System

Skills are self-contained capability packages loaded from disk. Each skill is a directory containing a `SKILL.md` with YAML frontmatter and markdown instructions.

### Skill Structure

```
skills/
├── apple-calendar/
│   └── SKILL.md
├── imessage-send/
│   └── SKILL.md
├── system-control/
│   └── SKILL.md
├── self-update/
│   └── SKILL.md
└── 3d-printing/
    ├── SKILL.md
    └── scripts/
        ├── printer-api.sh
        ├── sdcp-client.mjs
        └── slice-model.sh
```

### SKILL.md Format

```yaml
---
name: skill-name
description: What the skill does
homepage: https://...                    # Optional
metadata:
  openclaw:
    emoji: "📅"
    os: ["darwin"]                       # Supported platforms
    requires:
      bins: ["orca-slicer"]             # Required binaries
      envVars: ["API_KEY"]              # Required env vars
    install:
      - id: orcaslicer
        kind: manual
        instructions: "Download from ..."
tools:                                   # Optional native tool schemas
  - name: tool_name
    description: What it does
    inputSchema: { ... }
---

# Skill Name

Markdown instructions for the LLM...
```

#### Frontmatter Properties

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `name` | `string` | Yes | Unique skill identifier |
| `description` | `string` | Yes | Short description |
| `homepage` | `string` | No | Project homepage URL |
| `metadata` | `object` | No | OpenClaw metadata |
| `tools` | `ToolSchema[]` | No | Native tool definitions |

### Skill Loading

**Search directories** (in priority order — first match wins):

1. `~/.casterly/skills/` — User workspace skills (highest priority)
2. `~/Casterly/skills/` — Project skills
3. `./skills/` — Current directory skills

**Loading process** (`loadSkills()`):

1. Scan each directory for subdirectories
2. Read `SKILL.md` in each subdirectory
3. Parse YAML frontmatter (name, description, metadata, tools)
4. Check requirements:
   - OS compatibility (`platform()` vs `metadata.openclaw.os`)
   - Required binaries (`which` check for each `requires.bins` entry)
   - Required env vars (`process.env` check)
5. Mark `available: true/false` with reason

### Skill Registry

`createSkillRegistry()` provides:

| Method | Purpose |
|--------|---------|
| `get(id)` | Look up skill by directory name |
| `getAvailable()` | All skills passing requirement checks |
| `getPromptSection()` | Names + descriptions for system prompt (no full instructions) |
| `getRelevantSkillInstructions(message)` | Full instructions for skills matching user intent |
| `getTools()` | Native `ToolSchema[]` defined by available skills |
| `reload()` | Rescan skill directories |

### Intent Matching

`getRelevantSkillInstructions()` uses keyword-to-skill-ID mappings to decide which skills are relevant for a given message:

| Keywords | Skill IDs |
|----------|-----------|
| note, notes | apple-notes |
| grocery, shopping list, list | apple-notes, apple-reminders |
| reminder, remind, todo | apple-reminders |
| calendar, event, meeting, schedule, appointment | apple-calendar |
| weather, forecast, temperature, rain | weather |
| text, message, send | imessage-send, imsg |
| email, mail | himalaya |
| spotify, music, play, song | spotify-player |
| photo, picture, camera, snap | camsnap |
| volume, brightness, screenshot | system-control |
| code | coding-agent |
| github, repo, pull request, pr | github |

Falls back to name/description substring matching.

**Prompt safety**: Full skill instructions contain example bash commands. The registry wraps them with a warning:
> "The documentation below contains EXAMPLE commands. Do NOT execute every example! Choose ONLY the ONE command that matches what the user asked for."

### Notes Skill Deduplication

If multiple notes skills are loaded (e.g. `apple-notes` and `bear-notes`), the registry filters to prefer `apple-notes`.

### Installed Skills

| Skill | Description | OS | Requirements | Native Tools |
|-------|-------------|-----|-------------|--------------|
| `apple-calendar` | Query Apple Calendar events via AppleScript | macOS | — | — |
| `imessage-send` | Send iMessages to contacts | macOS | — | — |
| `system-control` | Volume, brightness, apps, screenshots, processes | macOS | — | — |
| `self-update` | Check for updates, update, restart Tyrion | macOS, Linux | `git`, `npm` | `check_for_updates`, `update_tyrion`, `restart_tyrion` |
| `3d-printing` | Slice models, manage presets, control Elegoo Centauri Carbon | macOS, Linux | `orca-slicer`, `curl`, `jq` | 12 tools (slice, presets, upload, print control, status) |

---

## Creating Skills

### Adding a New Skill

1. Create a directory under one of the skill search paths
2. Add a `SKILL.md` with YAML frontmatter (`name` and `description` required)
3. Optionally define `metadata.openclaw` for OS/binary requirements
4. Optionally define `tools` array for native tool schemas
5. Write markdown instructions for the LLM in the body
6. Add supporting scripts in the skill directory if needed

The skill is automatically loaded on next startup (or `registry.reload()`).

### Tool Property Types

| Type | Description | Example |
|------|-------------|---------|
| `string` | Text value | `"hello"` |
| `number` | Decimal number | `3.14` |
| `integer` | Whole number | `42` |
| `boolean` | True/false | `true` |
| `object` | Nested object | `{"key": "value"}` |
| `array` | List of items | `["a", "b", "c"]` |

String enums restrict values: `enum: ["red", "green", "blue"]`

Array items are typed: `items: { type: string, description: "A tag" }`

### Creating Custom Tool Executors

To execute tools defined by skills, register custom executors:

```typescript
import { createToolOrchestrator } from './tools';

const orchestrator = createToolOrchestrator();

orchestrator.registerExecutor({
  toolName: 'get_weather',
  async execute(call) {
    const { location, units } = call.input as { location: string; units?: string };
    const weather = await fetchWeather(location, units);

    return {
      toolCallId: call.id,
      success: true,
      output: JSON.stringify(weather),
    };
  },
});
```

### Best Practices

**Skill instructions:**
1. Be specific — clearly explain when and how to use the skill
2. Include examples — show command patterns and expected outputs
3. Document limitations — note what the skill cannot do
4. Handle errors — explain how to recover from common failures

**Tool definitions:**
1. Use descriptive names (`get_weather` not `gw`)
2. Write clear descriptions explaining what the tool does and when to use it
3. Mark required fields and use enums where appropriate
4. Prefer flat structures over deep nesting

**Security:**
1. Validate all inputs in your executor before using them
2. Don't expose secrets in tool outputs
3. Use safety gates for destructive operations
4. Log through `safeLogger` — never log sensitive tool inputs directly

### Troubleshooting

**Skill not loading:** Check YAML frontmatter syntax; verify `name` and `description` are present; confirm file location.

**Skill shows as unavailable:** Check required binaries (`which binary-name`); check env vars (`echo $ENV_VAR`); check OS restriction matches platform.

**Tool not being called:** Verify tool schema is valid JSON Schema; check tool is registered with orchestrator; ensure model supports native tool use.

**Tool execution fails:** Check executor is registered for the tool name; verify input validation in executor; check safety gates aren't blocking execution.

---

## Key Files

| File | Purpose |
|------|---------|
| `src/tools/schemas/types.ts` | Core type definitions (ToolSchema, NativeToolCall, etc.) |
| `src/tools/schemas/core.ts` | Core tool definitions (bash, file tools) + aggregation |
| `src/tools/schemas/coding.ts` | Coding tool definitions (edit, glob, grep, validate) |
| `src/tools/schemas/messaging.ts` | Messaging tool definitions (send_message) |
| `src/tools/schemas/productivity.ts` | Productivity tool definitions (calendar, reminder, http_get) |
| `src/tools/schemas/registry.ts` | Tool registry with Anthropic/Ollama format conversion |
| `src/tools/orchestrator.ts` | Tool call dispatcher |
| `src/tools/executor.ts` | Bash executor with safety gates |
| `src/tools/executors/*.ts` | Individual native tool executor implementations |
| `src/skills/types.ts` | Skill type definitions (Skill, SkillRegistry, etc.) |
| `src/skills/loader.ts` | Skill loading, requirement checking, registry creation |
| `skills/*/SKILL.md` | Individual skill packages |
