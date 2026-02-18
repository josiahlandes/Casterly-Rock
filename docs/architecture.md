# Casterly Architecture

Casterly is a local-only AI assistant running on Mac Studio M4 Max with 128GB unified memory. All inference happens on-device via Ollama. No data ever leaves the machine.

This document provides a high-level overview and links to detailed docs for each subsystem.

## System Overview

```
Event Sources (iMessage, CLI, File Watcher, Git Hooks, Cron, Goals)
         │
         ▼
┌─────────────────────┐
│   Trigger Router    │  Normalize all inputs into uniform Trigger shape
└────────┬────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────┐
│                  Agent Loop (unified)                │
│                                                     │
│  1. Load state (journal, world model, goals, issues)│
│  2. Build identity prompt + handoff note             │
│  3. ReAct cycle:                                    │
│     ┌──────────────────────────────────┐            │
│     │  Call LLM (Ollama)               │            │
│     │  ↓                               │            │
│     │  Tool calls? ──yes──→ Execute    │            │
│     │       │                  │       │            │
│     │       no                 └───────┘            │
│     │       ↓                                       │
│     │  Done (text response = summary)  │            │
│     └──────────────────────────────────┘            │
│  4. Write handoff note to journal                   │
│  5. Save state                                      │
└────────┬────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────┐
│  Tools / Delegation / State Mutation / Response      │
└─────────────────────────────────────────────────────┘
```

## Module Index

| Subsystem | Summary | Detail Doc |
|-----------|---------|------------|
| **Agent Loop** | ReAct cycle engine — triggers, identity prompt, tool execution, handoff notes, tiered memory | [agent-loop.md](agent-loop.md) |
| **Triggers** | Event sources normalized into uniform Trigger shape | [triggers.md](triggers.md) |
| **Task Execution** | Classifier, planner, runner, verifier pipeline | [task-execution.md](task-execution.md) |
| **Skills & Tools** | Tool registry, native executors, bash safety gates, OpenClaw skills | [skills-and-tools.md](skills-and-tools.md) |
| **Coding Interface** | Aider-style repo map, context budgeting, validation, modes | [coding-interface.md](coding-interface.md) |
| **iMessage** | Daemon polling, SQLite reader, AppleScript sender, tool filter | [imessage.md](imessage.md) |
| **Memory & State** | Journal, world model, user model, goal stack, issue log | [memory-and-state.md](memory-and-state.md) |
| **Security** | Sensitive data detection, redaction, safe logging | [security.md](security.md) |
| **Configuration** | YAML + Zod validation, model routing, data layout | [configuration.md](configuration.md) |
| **API Reference** | Provider interface, tool schemas, key function signatures | [api-reference.md](api-reference.md) |
| **Error Codes** | Structured error system (E1xx–E9xx), auto-detection | [error-codes.md](error-codes.md) |
| **Testing** | Trace collection, test cases, benchmarking, CLI | [testing.md](testing.md) |
| **Installation** | Prerequisites, setup, configuration | [install.md](install.md) |

## Source Layout

```
src/
├── index.ts                  # CLI entry point
├── imessage-daemon.ts        # iMessage daemon entry
├── config/                   # YAML loader, Zod schemas
├── providers/                # LlmProvider interface, Ollama client
├── security/                 # Sensitive content detection, redaction
├── logging/                  # Privacy-aware safe logger
├── interface/                # Bootstrap, prompt builder, session, memory
├── imessage/                 # Daemon, reader, sender, tool filter
├── tools/                    # Tool schemas, registry, executor, orchestrator
├── skills/                   # Skill types, discovery, tool registration
├── coding/                   # Repo map, context manager, validation, modes
├── autonomous/               # Agent loop, tools, journal, world model,
│                             # goal stack, issue log, context manager,
│                             # events, triggers, identity, delegation
└── testing/                  # Trace collector, test cases, test runner
```
