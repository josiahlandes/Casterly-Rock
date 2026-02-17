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
├── agent/                   # Unified agent architecture
│   ├── loop.ts              # AgentLoop.run() — single entry point
│   ├── trigger-router.ts    # Normalize all inputs to Trigger shape
│   ├── journal.ts           # Append-only JSONL journal
│   ├── world-model.ts       # World state and user model
│   ├── state.ts             # State inspection and snapshots
│   └── types.ts             # Trigger, JournalEntry, WorldModel types
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

---

## Unified Agent Architecture (Phase 6)

The agent architecture refactor (Phases 0-5) replaced the original per-channel processing pipelines with a single unified agent loop. All interaction channels now converge through one entry point with journal-based state continuity.

### Unified Agent Loop

All interactions flow through a single `AgentLoop.run()` entry point regardless of source:

- **Single entry point**: `AgentLoop.run()` handles every interaction — iMessage, CLI, scheduled events, goal-driven actions, and file/git events.
- **Trigger Router**: Normalizes all input sources (iMessage, CLI, events, schedule, goals) into a uniform `Trigger` shape before the agent loop processes them. Each trigger carries its source, payload, and any associated context.
- **Journal-based state continuity**: Instead of relying on structured state objects passed between pipeline stages, the agent reads and writes an append-only journal. Handoff notes, reflections, opinions, and observations persist across interactions and restarts.
- **Provider registry with metacognitive delegation**: The provider registry supports multiple models with metacognitive routing — the agent can delegate subtasks to different models based on task characteristics, using self-assessment to choose the right provider for each step.

### Journal System

The journal is the primary continuity mechanism, replacing structured state as the source of truth for the agent's ongoing context.

- **Format**: Append-only JSONL stored at `~/.casterly/journal.jsonl`
- **Entry types**:
  - `handoff` — Notes written at the end of an interaction to brief the next invocation
  - `reflection` — The agent's self-assessment of how an interaction or task went
  - `opinion` — Formed views on tools, approaches, or user preferences
  - `observation` — Facts noticed during execution (e.g., "user prefers short replies")
  - `user_interaction` — Records of meaningful user exchanges for user model building
- **Replaces structured state**: Rather than passing a state object through a pipeline, the agent loads relevant journal entries at the start of each run and writes new entries at the end.
- **Search via `recall_journal` tool**: The agent can search its own journal using natural-language queries, surfacing relevant past context without loading the entire history.

### Data Flow Diagram

```
Event Sources (iMessage, CLI, File, Git, Cron)
         |
    Trigger Router
         |
    Agent Loop (unified)
    |-- Load state (journal, world, goals)
    |-- Build identity prompt (+ handoff note + user model)
    |-- Reason -> Act -> Observe
    |-- Write journal entry
    \-- Save state
         |
    Tools | Delegate | State Mutation
```

All event sources are normalized by the Trigger Router into a common shape. The Agent Loop loads its state from the journal and world model, builds an identity-aware prompt that includes the most recent handoff note and user model, then enters the reason-act-observe cycle. After completing work, it writes a journal entry (handoff, reflection, or observation) and saves any state mutations. Output flows to tools, delegated subtasks, or state updates.

---

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
├── journal.jsonl        # Append-only agent journal (handoffs, reflections, opinions)
├── sessions/            # Conversation history
│   └── imessage/
│       └── <chat-id>.jsonl
├── memory/              # Long-term memory
├── state/               # World model and snapshots
└── users.json           # Multi-user config
```

## Hardware

Mac Studio M4 Max with 128GB unified memory:

- Run multiple 70B parameter models simultaneously
- No cloud APIs required
- All inference on-device
- Privacy by architecture
