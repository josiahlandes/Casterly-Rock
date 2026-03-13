# Casterly Architecture

Casterly is a local-only AI assistant running on macOS (Apple Silicon) with 128GB unified memory. All inference happens on-device via Ollama and vllm-mlx. No data ever leaves the machine.

## System Overview

Casterly runs a **triple-model architecture** where three LLMs serve distinct roles, coordinated through a shared TaskBoard:

```
Event Sources (iMessage, CLI, File Watcher, Git Hooks, Cron, Goals)
         |
         v
+------------------------------------------------------------------+
|                   Loop Coordinator                                |
|                                                                   |
|  +------------------------+    +-------------------------------+  |
|  |     FastLoop            |    |          DeepLoop             | |
|  |  (qwen3.5:35b-a3b)     |    |                                | |
|  |  Ollama :11434          |    |  Reasoner (27B dense)         | |
|  |                         |    |  MLX :8000 -- plans, reviews  | |
|  |  - Triage messages      |    |                               | |
|  |  - Answer simple Qs     |    |  Coder (80B-A3B MoE)          | |
|  |  - Deliver responses    |    |  MLX :8001 -- tools, code gen | |
|  |  - Progress updates     |    |                               | |
|  |                         |    |  - Plan complex tasks         | |
|  |  ~2s heartbeat          |    |  - Execute via 96-tool kit    | |
|  |                         |    |  - Generate & review code     | |
|  +------------+------------+    +-------------+-----------------+ |
|               |                               |                   |
|               +---------------+---------------+                   |
|                               v                                   |
|                +--------------------+                             |
|                |    TaskBoard       |  In-memory shared state     |
|                |  (JSON-backed)     |  Sole communication channel |
|                +--------------------+                             |
+------------------------------------------------------------------+
         |
         v
+------------------------------------------------------------------+
|  Voice Filter -> Response Delivery (iMessage / CLI)              |
+------------------------------------------------------------------+
```

The two loops never call each other directly. All coordination happens through the TaskBoard. See [dual-loop.md](dual-loop.md) for details.

## Memory Budget

| Component | VRAM | Server | Role |
|-----------|------|--------|------|
| Qwen3.5-27B Reasoner (dense) | ~18 GB | MLX :8000 | DeepLoop: planning, review, self-correction (thinking ON) |
| Qwen3-Coder-80B-A3B (MoE, MXFP4) | ~42 GB | MLX :8001 | DeepLoop: tool-calling code generation (thinking OFF) |
| qwen3.5:35b-a3b (MoE) | ~24 GB | Ollama :11434 | FastLoop: triage, review, acknowledgment (3B active/token) |
| **Total** | **~84 GB** | | **~44 GB headroom on 128 GB** |

The 27B reasoner and 80B coder run on vllm-mlx (Apple Silicon-native, faster than llama.cpp for large models). The 35B FastLoop runs on Ollama. All models loaded persistently (never unloaded).

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
| **Providers** | `src/providers/` | Ollama provider, MLX provider, concurrent inference, model registry |
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
│   ├── dream/                # Challenge gen/eval, prompt evolution, LoRA,
│   │   │                     #   intensity dial, phase progress, autoresearch
│   ├── memory/               # Advanced memory (links, evolution, AUDN)
│   ├── tools/                # Agent tool registry and map
│   ├── watchers/             # File, git, issue watchers
│   └── communication/        # Message delivery and policy
├── providers/                # LlmProvider interface, Ollama, MLX, concurrent
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

1. **Triple-model specialization** -- Dense reasoner for planning/review, MoE coder for tool-calling code generation, MoE fast model for triage. Each model is optimized for its role.
2. **Data-structure coupling** -- Loops communicate only through the TaskBoard. No direct RPC.
3. **LLM-driven execution** -- The LLM drives the ReAct loop, chooses tools, manages context. The system provides capability; the LLM provides judgment.
4. **Local-only inference** -- All computation via Ollama and vllm-mlx on localhost. No cloud APIs, no outbound network.
5. **Defense-in-depth security** -- Input guard -> sensitive detector -> tool gates -> output sanitizer -> safe logger.
6. **Free tokens change everything** -- Unlimited local inference enables self-correction loops, redundant verification, exploration, and dream cycles.
