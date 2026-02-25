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
│     crystals, constitution, vision stores)           │
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
| **Memory & State** | Journal, world model, user model, goal stack, issue log, crystals, constitution, traces, prompt store, shadow store | [memory-and-state.md](memory-and-state.md) |
| **Providers & Routing** | Ollama provider, model registry, task classifier, voice filter | [providers-and-routing.md](providers-and-routing.md) |
| **Security & Privacy** | Sensitive data detection, redaction, safe logging, command gates | [security-and-privacy.md](security-and-privacy.md) |
| **Configuration** | YAML + Zod validation, model routing, data layout | [configuration-and-environment.md](configuration-and-environment.md) |
| **Testing & Quality Gates** | 5-gate pipeline, trace collection, test cases, benchmarking | [testing-and-quality-gates.md](testing-and-quality-gates.md) |
| **Autonomous Agent** | ReAct loop, agent tools (81), budget controls, identity, dream cycles, self-knowledge (crystals, constitution, traces), self-improvement (prompts, shadows, tools), advanced self-improvement (challenges, evolution, LoRA), roadmap tools (meta, classify, plan, verify, introspection, context control, scheduling, semantic recall, parallel reasoning), dream cycle phase tools (consolidate_reflections, reorganize_goals, explore_codebase, rebuild_self_model, write_retrospective), advanced memory tools (link_memories, get_links, traverse_links, audn_enqueue, audn_status, entropy_score, evaluate_tiers, snapshot_memory, list_snapshots, diff_snapshots). **Vision Tier 2/3 stores** wired via `AgentState` and toggled by `config/autonomous.yaml` vision tier settings. **Communication** — `message_user` routes through `MessagePolicy` (throttle, quiet hours, event filtering) and `MessageDelivery` (iMessage or console JSONL outbox), configured via `communication` section in `config/autonomous.yaml`. **Dream scheduling** — dream cycles auto-trigger after each agent cycle when the configured interval has elapsed (default 24h), passing all Vision Tier stores and journal to `DreamCycleRunner`; meta persisted to `~/.casterly/dream-meta.json`. The legacy 4-phase `runCycle()` pipeline (analyze → hypothesize → implement → validate) has been retired; `runAgentCycle()` is now the sole execution path. | [autonomous-agent.md](autonomous-agent.md) |
| **API Reference** | Provider interface, tool schemas, key function signatures | [api-reference.md](api-reference.md) |
| **Error Codes** | Structured error system (E1xx–E9xx), auto-detection | [error-codes.md](error-codes.md) |
| **Installation** | Prerequisites, setup, configuration | [install.md](install.md) |

> **NOTE — Architecture Status**
>
> The system overview diagram above accurately reflects the current implementation. All triggers — including iMessage user messages — flow through the agent loop as the single execution path. The legacy pipeline (`processChatMessage()`, session manager, mode managers, skill registry, task pipeline, tool orchestrator) has been removed from the iMessage daemon. User messages enter via `triggerFromMessage()` → `autonomousController.runTriggeredCycle()` → agent loop. Responses pass through the voice filter (personality rewrite) before delivery.

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
│                             # crystal store, constitution, trace replay,
│                             # prompt store, shadow store,
│                             # communication/ (delivery backends, policy),
│                             # dream/ (challenge gen/eval, prompt evolution,
│                             #         training extractor, LoRA trainer)
├── utils/                    # Shared utilities (semaphore)
└── testing/                  # Trace collector, test cases, test runner
```
