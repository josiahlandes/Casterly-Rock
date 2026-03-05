# Casterly Architecture

Casterly is a local-only AI assistant running on Mac Studio M4 Max with 128GB unified memory. All inference happens on-device via Ollama. No data ever leaves the machine.

## System Overview

Casterly runs a **dual-loop architecture** where two LLM models operate concurrently through a shared TaskBoard:

```
Event Sources (iMessage, CLI, File Watcher, Git Hooks, Cron, Goals)
         │
         ▼
┌─────────────────────────────────────────────────────────────┐
│              Loop Coordinator                                │
│                                                              │
│  ┌─────────────────────┐    ┌───────────────────────────┐   │
│  │     FastLoop         │    │       DeepLoop             │   │
│  │  (qwen3.5:35b-a3b)  │    │    (qwen3.5:122b)         │   │
│  │                      │    │                            │   │
│  │  • Triage messages   │    │  • Plan complex tasks      │   │
│  │  • Answer simple Qs  │    │  • Execute via tools       │   │
│  │  • Deliver responses │    │  • Generate code            │   │
│  │  • Progress updates  │    │  • Handle events & goals   │   │
│  │                      │    │                            │   │
│  │  ~2s heartbeat       │    │  Natural pace (10-60s)     │   │
│  └──────────┬───────────┘    └──────────┬─────────────────┘   │
│             │                           │                     │
│             └───────────┬───────────────┘                     │
│                         ▼                                     │
│              ┌──────────────────┐                             │
│              │    TaskBoard     │  In-memory shared state     │
│              │  (JSON-backed)   │  Sole communication channel │
│              └──────────────────┘                             │
└─────────────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────────┐
│  Voice Filter → Response Delivery (iMessage / CLI)           │
└─────────────────────────────────────────────────────────────┘
```

The two loops never call each other directly. All coordination happens through the TaskBoard. See [dual-loop.md](dual-loop.md) for details.

## Memory Budget

| Component | VRAM | Role |
|-----------|------|------|
| qwen3.5:122b | ~81 GB | DeepLoop: reasoning, planning, code generation |
| qwen3.5:35b-a3b | ~24 GB | FastLoop: triage, review, acknowledgment (MoE: 3B active/token) |
| **Total** | **~105 GB** | ~23 GB headroom on 128 GB |

Both models loaded with `keep_alive: -1` (never unloaded).

## Module Map

| Module | Source | Purpose |
|--------|--------|---------|
| **Dual-Loop** | `src/dual-loop/` | FastLoop, DeepLoop, TaskBoard, Coordinator, context tiers |
| **Agent Loop** | `src/autonomous/agent-loop.ts` | ReAct reasoning engine used by DeepLoop |
| **Triggers** | `src/autonomous/trigger-router.ts` | Normalize events into uniform trigger shape |
| **Tools** | `src/tools/`, `src/autonomous/tools/` | Tool registry, executors, agent toolkit (96 tools) |
| **Coding** | `src/coding/` | Repo map, context budgeting, validation, editing modes |
| **iMessage** | `src/imessage/` | Daemon, SQLite reader, AppleScript sender, voice filter |
| **Memory** | `src/autonomous/` | Journal, world model, goals, issues, crystals, constitution |
| **Providers** | `src/providers/` | Ollama provider, concurrent inference, model registry |
| **Security** | `src/security/` | Sensitive detection, redaction, output sanitizer |
| **Config** | `src/config/` | YAML loader, Zod schemas |
| **Testing** | `src/testing/` | Trace collector, test runner |

## Source Layout

```
src/
├── index.ts                  # CLI entry point
├── imessage-daemon.ts        # iMessage daemon entry
├── dual-loop/                # FastLoop, DeepLoop, TaskBoard, Coordinator
├── autonomous/               # Agent loop, tools, memory stores, dream cycles
│   ├── dream/                # Challenge gen/eval, prompt evolution, LoRA
│   ├── memory/               # Advanced memory (links, evolution, AUDN)
│   ├── tools/                # Agent tool registry and map
│   ├── watchers/             # File, git, issue watchers
│   └── communication/        # Message delivery and policy
├── providers/                # LlmProvider interface, Ollama, concurrent
├── security/                 # Detection, redaction, sanitizer
├── imessage/                 # Daemon, reader, sender, voice filter, input guard
├── tools/                    # Core tool schemas, registry, executor
├── skills/                   # Skill types, discovery, registration
├── coding/                   # Repo map, context manager, validation, modes
├── config/                   # YAML loader, Zod schemas
├── logging/                  # Privacy-safe logger
├── errors/                   # Structured error codes
└── testing/                  # Trace collector, test runner
```

## Key Architectural Principles

1. **Dual-loop concurrency** — FastLoop for responsiveness, DeepLoop for depth. Both run as async coroutines in the same Node.js process.
2. **Data-structure coupling** — Loops communicate only through the TaskBoard. No direct RPC.
3. **LLM-driven execution** — The LLM drives the ReAct loop, chooses tools, manages context. The system provides capability; the LLM provides judgment.
4. **Local-only inference** — All computation via Ollama on localhost. No cloud APIs, no outbound network.
5. **Defense-in-depth security** — Input guard → sensitive detector → tool gates → output sanitizer → safe logger.
6. **Free tokens change everything** — Unlimited local inference enables self-correction loops, redundant verification, exploration, and dream cycles.
