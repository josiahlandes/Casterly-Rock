# Casterly Architecture

This document describes the architecture of Casterly, a local-first privacy-aware hybrid LLM router.

## Overview

Casterly routes requests between local and cloud LLM providers based on content sensitivity. The core principle: **sensitive data stays local**.

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
│                     Router Layer                                │
│  ┌─────────────────────────────┐  ┌───────────────────────────┐ │
│  │   Pattern Matcher           │  │   LLM Classifier          │ │
│  │   (fast, regex-based)       │  │   (local model)           │ │
│  └─────────────────────────────┘  └───────────────────────────┘ │
│                          │                                      │
│                          ▼                                      │
│              ┌───────────────────────┐                          │
│              │   Route Decision      │                          │
│              │   {route, reason,     │                          │
│              │    confidence}        │                          │
│              └───────────────────────┘                          │
└─────────────────────────┬───────────────────────────────────────┘
                          │
            ┌─────────────┴─────────────┐
            ▼                           ▼
┌───────────────────────┐   ┌───────────────────────┐
│    Local Provider     │   │    Cloud Provider     │
│       (Ollama)        │   │       (Claude)        │
│                       │   │                       │
│  • Privacy-safe       │   │  • Advanced tasks     │
│  • No data leaves     │   │  • Better reasoning   │
│  • Always available   │   │  • Requires API key   │
└───────────────────────┘   └───────────────────────┘
            │                           │
            └─────────────┬─────────────┘
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
├── providers/               # LLM provider abstractions
│   ├── base.ts              # LlmProvider interface
│   ├── ollama.ts            # Local Ollama client
│   ├── claude.ts            # Anthropic Claude client
│   └── index.ts             # Provider registry
│
├── router/                  # Request routing
│   ├── index.ts             # Main router logic
│   ├── classifier.ts        # LLM-based classification
│   └── patterns.ts          # Regex pattern matching
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
│   │   ├── core.ts          # BASH_TOOL, ROUTE_DECISION_TOOL
│   │   └── registry.ts      # Tool registry
│   ├── executor.ts          # Bash tool executor with safety gates
│   ├── orchestrator.ts      # Multi-tool orchestration
│   └── index.ts             # Module exports
│
├── skills/                  # Extensible skills
│   ├── types.ts             # Skill definitions (with optional tools)
│   └── loader.ts            # Skill discovery and tool registration
│
├── testing/                 # Testing & verification (see docs/testing.md)
│   ├── trace.ts             # Trace collector, event types
│   ├── test-cases.ts        # Built-in test definitions
│   ├── test-runner.ts       # Test execution & evaluation
│   └── testable-runner.ts   # Pipeline wrapper with instrumentation
│
└── test-cli.ts              # Test CLI entry point
```

## Data Flow

### 1. Request Processing Pipeline

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
│ 2. SENSITIVITY DETECTION                                       │
│    • Run regex patterns (fast, first pass)                     │
│    • Detect: SSN, credit cards, passwords, calendar, etc.      │
│    • If "always local" category → route LOCAL immediately      │
└────────────────────────────────────────────────────────────────┘
     │
     ▼ (if not obviously sensitive)
┌────────────────────────────────────────────────────────────────┐
│ 3. LLM CLASSIFICATION (via Native Tool Use)                    │
│    • Call local Ollama with route_decision tool                │
│    • Model calls tool with: {route, reason, confidence}        │
│    • Low confidence → fallback to local                        │
└────────────────────────────────────────────────────────────────┘
     │
     ▼
┌────────────────────────────────────────────────────────────────┐
│ 4. CONTEXT ASSEMBLY                                            │
│    • Build system prompt (identity, skills, safety)            │
│    • Include conversation history (trimmed to token budget)    │
│    • Add current message                                       │
└────────────────────────────────────────────────────────────────┘
     │
     ▼
┌────────────────────────────────────────────────────────────────┐
│ 5. LLM INFERENCE WITH TOOLS                                    │
│    • Call generateWithTools() on selected provider             │
│    • Pass tool schemas (bash, skill tools)                     │
│    • Handle billing errors (fallback to local)                 │
└────────────────────────────────────────────────────────────────┘
     │
     ▼
┌────────────────────────────────────────────────────────────────┐
│ 6. NATIVE TOOL LOOP (if tool calls in response)                │
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

### 2. Routing Decision Flow

```
Input Text
     │
     ▼
┌─────────────────────┐     YES     ┌─────────────────────┐
│ Pattern Match?      │────────────▶│ Route: LOCAL        │
│ (calendar, SSN,     │             │ Confidence: 1.0     │
│  passwords, etc.)   │             └─────────────────────┘
└─────────────────────┘
     │ NO
     ▼
┌─────────────────────┐
│ LLM Classification  │
│ (local model)       │
└─────────────────────┘
     │
     ▼
┌─────────────────────┐
│ Confidence Check    │
└─────────────────────┘
     │
     ├── confidence >= threshold ──▶ Route as classified
     │
     └── confidence < threshold ───▶ Route: LOCAL (safe default)
```

## Key Components

### Providers

The provider system abstracts LLM interactions with native tool use support:

| Provider | Type | Use Case |
|----------|------|----------|
| Ollama | Local | Privacy-sensitive requests, always available |
| Claude | Cloud | Advanced reasoning, complex tasks |

Both providers implement `LlmProvider` interface with `generateWithTools()` method.
This enables structured tool calling where the model returns `NativeToolCall` objects
instead of text-based command blocks.

### Router

Two-stage routing ensures privacy:

1. **Pattern Matching** (fast): Regex patterns catch obvious sensitive content
2. **LLM Classification via Tool Use** (smart): Local model calls `route_decision` tool with structured decision

The router uses native tool calling to get structured routing decisions, eliminating
JSON parsing errors that occurred with text-based classification.

### Security

- **Detector**: Identifies sensitive content categories
- **Redactor**: Sanitizes logs to prevent data leaks
- **Safe Logger**: Wraps all logging with automatic redaction

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

### Skills

OpenClaw-compatible skill system with native tool support:

- Skills defined in `SKILL.md` files with frontmatter
- Optional `tools` array in frontmatter for native tool definitions
- Automatic discovery and tool registration
- Safety gates for command execution

## Sensitive Data Categories

These categories always route locally:

| Category | Examples |
|----------|----------|
| Calendar | Schedules, appointments, meetings |
| Finances | Bank accounts, SSN, credit cards |
| Health | Medical info, prescriptions |
| Credentials | Passwords, API keys, tokens |
| Documents | Private notes, journals, voice memos |
| Contacts | Personal relationships, contact info |

## Configuration

Configuration is loaded from `config/default.yaml` and validated at startup:

```yaml
local:
  provider: ollama
  model: qwen3:14b          # Tool-capable model required
  baseUrl: http://localhost:11434
  timeoutMs: 60000          # 14B models need longer timeout

cloud:
  provider: claude
  model: claude-sonnet-4-20250514
  apiKeyEnv: ANTHROPIC_API_KEY

router:
  defaultRoute: local
  confidenceThreshold: 0.7

sensitivity:
  alwaysLocal:
    - calendar
    - finances
    - health
    - credentials
```

**Important**: Native tool use requires a tool-capable local model.
Recommended: `qwen3:14b` (~9GB RAM, 0.971 F1 on tool calling benchmarks)

## Protected Paths

Changes to these paths require extra caution:

- `src/security/*` - Privacy-critical detection and redaction
- `src/router/classifier.ts` - Routing decisions
- `src/providers/*` - Provider implementations
- `config/*` - Configuration files
- `.env*` - Environment secrets
- `docs/rulebook.md` - Architecture invariants

## Error Handling

- **BillingError**: Cloud provider billing issues trigger fallback to local
- **ProviderError**: Generic provider failures with retry logic
- **Timeout**: Configurable per-provider timeouts
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
