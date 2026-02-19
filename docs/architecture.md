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
│  1. Load state (journal, world model, goals, issues, │
│     crystals, constitution)                          │
│  2. Build identity prompt + crystals + rules         │
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
| **Memory & State** | Journal, world model, user model, goal stack, issue log, crystals, constitution, traces | [memory-and-state.md](memory-and-state.md) |
| **Providers & Routing** | Ollama provider, model registry, task classifier, pipeline routing | [providers-and-routing.md](providers-and-routing.md) |
| **Security & Privacy** | Sensitive data detection, redaction, safe logging, command gates | [security-and-privacy.md](security-and-privacy.md) |
| **Configuration** | YAML + Zod validation, model routing, data layout | [configuration-and-environment.md](configuration-and-environment.md) |
| **Testing & Quality Gates** | 5-gate pipeline, trace collection, test cases, benchmarking | [testing-and-quality-gates.md](testing-and-quality-gates.md) |
| **Autonomous Agent** | ReAct loop, agent tools (34), budget controls, identity, dream cycles, self-knowledge (crystals, constitution, traces) | [autonomous-agent.md](autonomous-agent.md) |
| **API Reference** | Provider interface, tool schemas, key function signatures | [api-reference.md](api-reference.md) |
| **Error Codes** | Structured error system (E1xx–E9xx), auto-detection | [error-codes.md](error-codes.md) |
| **Installation** | Prerequisites, setup, configuration | [install.md](install.md) |

> **NOTE — Vision Reconciliation (System Overview)**
>
> The system overview diagram above is largely aligned with the vision, but needs one change: the diagram implies triggers flow through the agent loop as the single path, which is correct. However, the *implementation* still has a separate pipeline path (`src/pipeline/process.ts`) that bypasses the agent loop entirely for iMessage conversations, routing them through classify → flat tool loop or classify → task manager pipeline. The vision says the agent loop is the *only* execution path. The separate pipeline entry point needs to be retired, with all triggers (including iMessage) entering through the agent loop.
>
> **What to change:**
> - Remove `src/pipeline/process.ts` as a separate execution path. Route iMessage messages through `triggerFromMessage()` → agent loop like all other triggers.
> - The iMessage daemon (`src/imessage/daemon.ts`) should emit user triggers into the event queue rather than calling `processChatMessage()` directly.

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
│                             # events, triggers, identity, delegation,
│                             # crystal store, constitution, trace replay
└── testing/                  # Trace collector, test cases, test runner
```
