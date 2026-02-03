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
│                    Skills Layer                                 │
│  ┌─────────────────────────────┐  ┌───────────────────────────┐ │
│  │   Command Parser            │  │   Executor                │ │
│  │   (bash code blocks)        │  │   (safety gates)          │ │
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
│   ├── daemon.ts            # Polling loop
│   ├── reader.ts            # Database reader
│   ├── sender.ts            # Message sender
│   └── tool-filter.ts       # Tool restrictions
│
└── skills/                  # Extensible skills
    ├── types.ts             # Skill definitions
    ├── loader.ts            # Skill discovery
    └── executor.ts          # Command execution
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
│ 3. LLM CLASSIFICATION                                          │
│    • Call local Ollama with classification prompt              │
│    • Output: {route, reason, confidence}                       │
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
│ 5. LLM INFERENCE                                               │
│    • Call selected provider (local or cloud)                   │
│    • Handle billing errors (fallback to local)                 │
│    • Parse response                                            │
└────────────────────────────────────────────────────────────────┘
     │
     ▼
┌────────────────────────────────────────────────────────────────┐
│ 6. TOOL EXECUTION (if commands in response)                    │
│    • Parse bash code blocks                                    │
│    • Check safety gates (blocked, approval, safe)              │
│    • Execute and collect results                               │
│    • Continue conversation with results                        │
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

The provider system abstracts LLM interactions behind a common interface:

| Provider | Type | Use Case |
|----------|------|----------|
| Ollama | Local | Privacy-sensitive requests, always available |
| Claude | Cloud | Advanced reasoning, complex tasks |

Both providers implement `LlmProvider` interface with `generate()` method.

### Router

Two-stage routing ensures privacy:

1. **Pattern Matching** (fast): Regex patterns catch obvious sensitive content
2. **LLM Classification** (smart): Local model classifies ambiguous requests

### Security

- **Detector**: Identifies sensitive content categories
- **Redactor**: Sanitizes logs to prevent data leaks
- **Safe Logger**: Wraps all logging with automatic redaction

### Interface Layer

- **Bootstrap**: Loads personality files (SOUL.md, IDENTITY.md, etc.)
- **Session**: Manages conversation state and persistence
- **Context**: Assembles complete prompt within token budget
- **Memory**: Long-term memory across sessions

### Skills

OpenClaw-compatible skill system:

- Skills defined in `SKILL.md` files with frontmatter
- Automatic discovery and loading
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
  model: qwen:7b
  baseUrl: http://localhost:11434

cloud:
  provider: claude
  model: claude-sonnet-4
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
