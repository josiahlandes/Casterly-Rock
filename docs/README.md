# Casterly Documentation Index

> Local-first, privacy-first AI steward — all inference on-device via Ollama.

## Quick Start

| Doc | What You'll Learn |
|-----|-------------------|
| [Install Guide](install.md) | Prerequisites, Node.js, Ollama, Mac Studio M4 Max setup |
| [Vision](vision.md) | Mission: local-first autonomy, privacy-by-architecture |
| [Rulebook](rulebook.md) | Non-negotiable invariants for development (mandatory reading) |
| [Subagents](subagents.md) | Sequential roles for development workflows |

## Architecture & Design

| Doc | Scope |
|-----|-------|
| [Architecture Overview](architecture.md) | High-level system: event sources → trigger router → agent loop → subsystems |
| [Agent Loop Refactor Plan](PLAN-agent-architecture-refactor.md) | Unification plan for interactive + autonomous execution paths |

## Reference Documentation

These docs provide comprehensive coverage of every major subsystem:

### Core Systems

| Doc | Covers |
|-----|--------|
| [Skills & Tools](skills-and-tools.md) | 13 native tools, tool registry, skill packages, tool formatting per LLM, orchestration |
| [Task Execution](task-execution.md) | Message classification, task planning (DAG decomposition), runner, verifier, context profiles |
| [Memory & State](memory-and-state.md) | 5 persistent stores: journal, world model, goal stack, issue log, execution log; tiered memory |
| [Autonomous Agent](autonomous-agent.md) | ReAct loop, 25 agent tools, triggers, budget controls, identity system, context manager |
| [Providers & Routing](providers-and-routing.md) | Ollama provider, two-model registry, task classifier, pipeline routing, concurrent/best-of-N |
| [Configuration & Environment](configuration-and-environment.md) | All 5 config files, every setting documented, Zod schemas, persistent state paths |
| [Testing & Quality Gates](testing-and-quality-gates.md) | 5-gate pipeline, ~100 test files, Vitest config, autonomous validator, test parser |
| [Security & Privacy](security-and-privacy.md) | 5 defense layers, input guard, redactor, output sanitizer, command gates, privacy guarantees |

### Supplementary References

| Doc | Covers |
|-----|--------|
| [Agent Loop](agent-loop.md) | ReAct cycle engine: trigger → state loading → turn loop → outcome |
| [Triggers](triggers.md) | Event system: user messages, file changes, git commits, timers → unified AgentTrigger |
| [Coding Interface](coding-interface.md) | Context management between LLM and code editing, repo map architecture |
| [API Reference](api-reference.md) | Detailed API for providers, tools, security, interface, skills, config |
| [Error Codes](error-codes.md) | Structured error codes with messages and remediation steps |
| [Security (original)](security.md) | Earlier security doc — superseded by [Security & Privacy](security-and-privacy.md) |
| [Testing (original)](testing.md) | Trace collection, test case execution, CLI testing |
| [Test Registry](test-registry.md) | Test file → source module mapping, coverage instructions |

## Planning & Operations

| Doc | Purpose |
|-----|---------|
| [Open Issues](OPEN-ISSUES.md) | Tracked gaps and feature requests |
| [Implementation Guide](IMPLEMENTATION-GUIDE.md) | Handoff guide with integration points, function signatures, design decisions |
| [Mac Permissions Review](mac-permissions-review.md) | Permission handling analysis for Node.js CLI |
| [App Wrapper Plan](app-wrapper-plan.md) | Native Casterly.app plan: launcher, permissions, menu bar, IPC, signing |

## Documentation Map

How the reference docs relate to each other:

```
                    ┌─────────────────────────┐
                    │  Configuration &        │
                    │  Environment            │  All settings, schemas,
                    │                         │  persistent state paths
                    └────────┬────────────────┘
                             │ configures
          ┌──────────────────┼──────────────────┐
          │                  │                  │
          ▼                  ▼                  ▼
┌─────────────────┐ ┌───────────────┐ ┌─────────────────┐
│  Providers &    │ │  Security &   │ │  Testing &      │
│  Routing        │ │  Privacy      │ │  Quality Gates  │
│                 │ │               │ │                 │
│  Ollama, model  │ │  Input guard, │ │  5-gate pipeline│
│  registry,      │ │  redaction,   │ │  ~100 tests,    │
│  classifier     │ │  command gates│ │  validator       │
└────────┬────────┘ └───────┬───────┘ └────────┬────────┘
         │                  │                  │
         │    ┌─────────────┼──────────────────┘
         │    │             │
         ▼    ▼             ▼
┌─────────────────┐ ┌───────────────┐
│  Skills & Tools │ │  Task         │
│                 │ │  Execution    │
│  13 native +   │ │               │
│  drop-in skills│ │  Classify →   │
│  + orchestrator│ │  plan → run → │
│                │ │  verify        │
└────────┬───────┘ └───────┬───────┘
         │                 │
         └────────┬────────┘
                  │
                  ▼
       ┌─────────────────┐
       │  Memory & State │
       │                 │
       │  Journal, world │
       │  model, goals,  │
       │  issues, exec   │
       │  log, tiered    │
       │  memory         │
       └────────┬────────┘
                │
                ▼
       ┌─────────────────┐
       │  Autonomous     │
       │  Agent          │
       │                 │
       │  ReAct loop,    │
       │  25 tools,      │
       │  identity,      │
       │  context mgr    │
       └─────────────────┘
```

## Reading Order for New Contributors

1. **[Vision](vision.md)** — Understand the mission
2. **[Rulebook](rulebook.md)** — Know the invariants (mandatory)
3. **[Architecture Overview](architecture.md)** — See the big picture
4. **[Configuration & Environment](configuration-and-environment.md)** — Understand all settings
5. **[Skills & Tools](skills-and-tools.md)** — Learn the tool system
6. **[Task Execution](task-execution.md)** — Follow a message through the pipeline
7. **[Memory & State](memory-and-state.md)** — See how state persists
8. **[Security & Privacy](security-and-privacy.md)** — Understand all safety layers
9. **[Testing & Quality Gates](testing-and-quality-gates.md)** — Know how to validate changes
10. **[Providers & Routing](providers-and-routing.md)** — Understand model selection
11. **[Autonomous Agent](autonomous-agent.md)** — See how Tyrion works independently
