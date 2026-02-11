# Casterly Architecture

This document describes the architecture of Casterly, a local-only AI assistant running on Mac Studio M4 Max.

## Overview

Casterly runs entirely locally via Ollama. All inference happens on-device with 128GB unified memory. No data ever leaves the machine.

```
┌─────────────────────────────────────────────────────────────────┐
│                        User Input                               │
│                  (iMessage, CLI, HTTP)                          │
└─────────────────────────┬───────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────────┐
│                   Interface Layer                               │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────┐  │
│  │  Bootstrap  │  │   Session   │  │     Prompt Builder      │  │
│  │   Loader    │  │  Manager    │  │                         │  │
│  └─────────────┘  └─────────────┘  └─────────────────────────┘  │
└─────────────────────────┬───────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Security Layer                               │
│  ┌─────────────────────────────┐  ┌───────────────────────────┐ │
│  │   Sensitive Content         │  │      Redactor             │ │
│  │   Detector                  │  │   (for logging)           │ │
│  └─────────────────────────────┘  └───────────────────────────┘ │
└─────────────────────────┬───────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Model Selection                              │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │   Task → Model Router (config/models.yaml)                  ││
│  │   • coding tasks → qwen3-coder-next                         ││
│  │   • general tasks → hermes3:70b                             ││
│  └─────────────────────────────────────────────────────────────┘│
└─────────────────────────┬───────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────────┐
│                   Ollama Provider                               │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │                   Local Inference                           ││
│  │   • 128GB unified memory                                    ││
│  │   • Multiple 70B models simultaneously                      ││
│  │   • All data stays on device                                ││
│  └─────────────────────────────────────────────────────────────┘│
└─────────────────────────┬───────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────────┐
│                     Tools Layer                                 │
│  ┌─────────────────────────────┐  ┌───────────────────────────┐ │
│  │   Tool Registry             │  │   Executor                │ │
│  │   (native tool schemas)     │  │   (safety gates)          │ │
│  └─────────────────────────────┘  └───────────────────────────┘ │
│  ┌─────────────────────────────┐  ┌───────────────────────────┐ │
│  │   Orchestrator              │  │   Skills → Tools          │ │
│  │   (multi-turn loop)         │  │   (auto-registration)     │ │
│  └─────────────────────────────┘  └───────────────────────────┘ │
└─────────────────────────┬───────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────────┐
│                      Response                                   │
└─────────────────────────────────────────────────────────────────┘
```

## Module Structure

```
src/
├── index.ts                 # CLI entry point
├── imessage-daemon.ts       # iMessage daemon entry
│
├── config/                  # Configuration management
│   ├── index.ts             # YAML loader with validation
│   └── schema.ts            # Zod schemas
│
├── providers/               # LLM provider (Ollama only)
│   ├── base.ts              # LlmProvider interface
│   ├── ollama.ts            # Local Ollama client
│   └── index.ts             # Provider registry
│
├── security/                # Privacy & safety
│   ├── detector.ts          # Sensitive content detection
│   └── redactor.ts          # Log redaction
│
├── logging/
│   └── safe-logger.ts       # Privacy-aware logging
│
├── interface/               # Context & prompt assembly
│   ├── bootstrap.ts         # Workspace file loader
│   ├── prompt-builder.ts    # System prompt assembly
│   ├── context.ts           # Context assembly
│   ├── session.ts           # Conversation state
│   ├── memory.ts            # Long-term memory
│   └── users.ts             # Multi-user support
│
├── imessage/                # iMessage integration
│   ├── daemon.ts            # Polling loop with native tool use
│   ├── reader.ts            # Database reader
│   ├── sender.ts            # Message sender
│   └── tool-filter.ts       # Tool call restrictions
│
├── tools/                   # Native tool use system
│   ├── schemas/
│   │   ├── types.ts         # ToolSchema, NativeToolCall, etc.
│   │   ├── core.ts          # BASH_TOOL
│   │   └── registry.ts      # Tool registry
│   ├── executor.ts          # Bash tool executor with safety gates
│   ├── orchestrator.ts      # Multi-tool orchestration
│   └── index.ts             # Module exports
│
├── skills/                  # Extensible skills
│   ├── types.ts             # Skill definitions (with optional tools)
│   └── loader.ts            # Skill discovery and tool registration
│
├── coding/                  # Aider-style coding interface
│   ├── tools/               # Read, edit, write, glob, grep
│   ├── repo-map/            # PageRank-based file importance
│   ├── context-manager/     # Token budgeting
│   ├── session-memory/      # Conversation persistence
│   ├── validation/          # Parse, lint, typecheck, test
│   └── modes/               # Code, Architect, Ask, Review
│
├── autonomous/              # Self-improvement system
│   ├── loop.ts              # Improvement cycle
│   ├── analyzer.ts          # Codebase analysis
│   ├── provider.ts          # LLM interface
│   └── providers/ollama.ts  # Ollama implementation
│
├── testing/                 # Testing & verification
│   ├── trace.ts             # Trace collector
│   ├── test-cases.ts        # Test definitions
│   └── test-runner.ts       # Test execution
│
└── test-cli.ts              # Test CLI entry point
```

## Data Flow

### Request Processing Pipeline

```
User Message
     │
     ▼
┌────────────────────────────────────────────────────────────────┐
│ 1. SESSION MANAGEMENT                                          │
│    • Load/create session (per-peer or shared)                  │
│    • Retrieve conversation history                             │
│    • Persist incoming message                                  │
└────────────────────────────────────────────────────────────────┘
     │
     ▼
┌────────────────────────────────────────────────────────────────┐
│ 2. MODEL SELECTION                                             │
│    • Detect task type (coding, general, autonomous)            │
│    • Select model from config/models.yaml                      │
│    • qwen3-coder-next for code, hermes3:70b for general        │
└────────────────────────────────────────────────────────────────┘
     │
     ▼
┌────────────────────────────────────────────────────────────────┐
│ 3. CONTEXT ASSEMBLY                                            │
│    • Build system prompt (identity, skills, safety)            │
│    • Include conversation history (trimmed to token budget)    │
│    • Add current message                                       │
└────────────────────────────────────────────────────────────────┘
     │
     ▼
┌────────────────────────────────────────────────────────────────┐
│ 4. LOCAL INFERENCE                                             │
│    • Call generateWithTools() on Ollama provider               │
│    • Pass tool schemas (bash, skill tools)                     │
│    • All inference on Mac Studio M4 Max                        │
└────────────────────────────────────────────────────────────────┘
     │
     ▼
┌────────────────────────────────────────────────────────────────┐
│ 5. NATIVE TOOL LOOP (if tool calls in response)                │
│    • Model returns structured NativeToolCall objects           │
│    • Check safety gates (blocked, approval, safe)              │
│    • Execute via tool orchestrator                             │
│    • Return tool results to model for next iteration           │
│    • Continue until model returns text-only response           │
└────────────────────────────────────────────────────────────────┘
     │
     ▼
Response to User
```

## Key Components

### Provider

Single provider system - Ollama only:

| Provider | Models | Use Case |
|----------|--------|----------|
| Ollama | qwen3-coder-next | Coding tasks |
| Ollama | hermes3:70b | General reasoning |

Provider implements `LlmProvider` interface with `generateWithTools()` method.

### Model Selection

Task-based model routing via `config/models.yaml`:

- **coding**: Code generation, refactoring, bug fixes → `qwen3-coder-next`
- **primary**: Reasoning, planning, conversation → `hermes3:70b`
- **autonomous**: Self-improvement cycles → `qwen3-coder-next`

### Security

- **Detector**: Identifies sensitive content categories
- **Redactor**: Sanitizes logs to prevent data leaks
- **Safe Logger**: Wraps all logging with automatic redaction

All data stays local by design - no cloud APIs to leak to.

### Interface Layer

- **Bootstrap**: Loads personality files (SOUL.md, IDENTITY.md, etc.)
- **Session**: Manages conversation state and persistence
- **Context**: Assembles complete prompt within token budget
- **Memory**: Long-term memory across sessions

### Tools

Native tool use system for LLM interactions:

- **Tool Registry**: Manages available tools (bash, skill tools)
- **Executor**: Runs bash commands with safety gates
- **Orchestrator**: Handles multi-tool execution in loops

### Coding Interface

Aider-style coding scaffolding:

- **Tools**: Read, edit, write, glob, grep
- **Repo Map**: PageRank-based file importance scoring
- **Context Manager**: Token budgeting and prioritization
- **Session Memory**: Conversation persistence
- **Validation**: Parse → lint → typecheck → test pipeline
- **Modes**: Code, Architect, Ask, Review

### Skills

OpenClaw-compatible skill system with native tool support:

- Skills defined in `SKILL.md` files with frontmatter
- Optional `tools` array in frontmatter for native tool definitions
- Automatic discovery and tool registration
- Safety gates for command execution

## Configuration

Configuration loaded from `config/default.yaml` and `config/models.yaml`:

```yaml
# config/default.yaml
local:
  provider: ollama
  model: hermes3:70b
  baseUrl: http://localhost:11434
  timeoutMs: 300000  # 5 minutes for large models

# config/models.yaml
models:
  coding:
    provider: ollama
    model: qwen3-coder-next:latest
    temperature: 0.1

  primary:
    provider: ollama
    model: hermes3:70b
    temperature: 0.7

hardware:
  platform: mac-studio-m4-max
  memory_gb: 128
  max_concurrent_models: 2
```

## Protected Paths

Changes to these paths require extra caution:

- `src/security/*` - Privacy-critical detection and redaction
- `src/providers/*` - Provider implementations
- `config/*` - Configuration files
- `.env*` - Environment variables
- `docs/rulebook.md` - Architecture invariants

## Error Handling

- **ProviderError**: Provider failures with retry logic
- **Timeout**: Configurable timeouts (generous for 70B models)
- **Safety Gate**: Blocked commands return error without execution

## Session Storage

```
~/.casterly/
├── workspace/           # Bootstrap files
│   ├── SOUL.md
│   ├── IDENTITY.md
│   ├── TOOLS.md
│   └── USER.md
├── sessions/            # Conversation history
│   └── imessage/
│       └── <chat-id>.jsonl
├── memory/              # Long-term memory
└── users.json           # Multi-user config
```

## Hardware

Mac Studio M4 Max with 128GB unified memory:

- Run multiple 70B parameter models simultaneously
- No cloud APIs required
- All inference on-device
- Privacy by architecture
