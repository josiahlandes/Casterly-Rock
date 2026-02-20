# Casterly — System Architecture Wireframe

A visual reference for the full system: layers, components, data flows, and boundaries.
For prose descriptions of each subsystem, see [architecture.md](architecture.md).

---

## 1. Layer Diagram

```
┌─────────────────────────────────────────────────────────────────────────┐
│                          ENTRY POINTS                                   │
│                                                                         │
│  ┌──────────┐  ┌─────────────┐  ┌──────────┐  ┌──────────┐            │
│  │   CLI    │  │  iMessage   │  │ Terminal  │  │ Benchmark│            │
│  │ index.ts │  │  Daemon     │  │   REPL   │  │   CLI    │            │
│  └────┬─────┘  └──────┬──────┘  └────┬─────┘  └────┬─────┘            │
│       │               │              │              │                   │
└───────┼───────────────┼──────────────┼──────────────┼───────────────────┘
        │               │              │              │
        ▼               ▼              ▼              ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                        TRIGGER LAYER                                    │
│                                                                         │
│  ┌──────────────────────────────────────────────────────────────────┐   │
│  │                    Trigger Router                                │   │
│  │         (normalizes all inputs into Trigger shape)              │   │
│  │                                                                  │   │
│  │  Sources:  message | event | schedule | goal                    │   │
│  └──────────────────────────┬───────────────────────────────────────┘   │
│                             │                                           │
│  ┌──────────┐  ┌───────────┴───┐  ┌────────────┐  ┌─────────────┐     │
│  │  File    │  │   iMessage    │  │    Cron     │  │    Goal     │     │
│  │ Watcher  │  │   Messages    │  │  Scheduler  │  │   Stack     │     │
│  └──────────┘  └───────────────┘  └────────────┘  └─────────────┘     │
│                                                                         │
└────────────────────────────────┬────────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                     INTELLIGENCE LAYER                                  │
│                                                                         │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │                     Agent Loop (ReAct)                          │    │
│  │                                                                 │    │
│  │  ┌───────────┐   ┌──────────────┐   ┌──────────────────────┐   │    │
│  │  │  Identity  │   │ Task         │   │ Pipeline             │   │    │
│  │  │  Builder   │   │ Classifier   │   │ (classify → plan →   │   │    │
│  │  │           │   │              │   │  run → verify)       │   │    │
│  │  └───────────┘   └──────────────┘   └──────────────────────┘   │    │
│  │                                                                 │    │
│  │  ┌──────────────────────────────────────────────────────────┐   │    │
│  │  │  ReAct Cycle                                             │   │    │
│  │  │  ┌─────────┐    ┌──────────┐    ┌──────────────────┐    │   │    │
│  │  │  │  Think  │───▶│  Act     │───▶│  Observe         │──┐ │   │    │
│  │  │  │  (LLM)  │    │  (Tools) │    │  (Tool Results)  │  │ │   │    │
│  │  │  └─────────┘    └──────────┘    └──────────────────┘  │ │   │    │
│  │  │       ▲                                                │ │   │    │
│  │  │       └────────────────────────────────────────────────┘ │   │    │
│  │  └──────────────────────────────────────────────────────────┘   │    │
│  └─────────────────────────────────────────────────────────────────┘    │
│                                                                         │
│  ┌──────────────────────────────────────────────────────────────────┐   │
│  │  Model Selection & Routing                                      │   │
│  │                                                                  │   │
│  │  ┌────────────────┐   ┌────────────────┐   ┌────────────────┐   │   │
│  │  │ coding tasks   │   │ general tasks  │   │ autonomous     │   │   │
│  │  │ → qwen3-coder  │   │ → gpt-oss:120b│   │ → qwen3-coder  │   │   │
│  │  └────────────────┘   └────────────────┘   └────────────────┘   │   │
│  └──────────────────────────────────────────────────────────────────┘   │
│                                                                         │
└────────────────────────────────┬────────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                        PROVIDER LAYER                                   │
│                                                                         │
│  ┌──────────────────────────────────────────────────────────────────┐   │
│  │  LlmProvider Interface                                          │   │
│  │  ┌────────────────────────────────────────────────────────────┐  │   │
│  │  │  generateWithTools(request, tools, prevResults)            │  │   │
│  │  │  → { providerId, model, text, toolCalls[] }               │  │   │
│  │  └────────────────────────────────────────────────────────────┘  │   │
│  │                                                                  │   │
│  │  ┌──────────────┐   ┌──────────────────┐   ┌────────────────┐   │   │
│  │  │   Ollama     │   │   Concurrent     │   │   Embedding    │   │   │
│  │  │  Provider    │   │   Provider       │   │   Provider     │   │   │
│  │  │  (local)     │   │   (parallel)     │   │   (local)      │   │   │
│  │  └──────┬───────┘   └────────┬─────────┘   └───────┬────────┘   │   │
│  │         │                    │                      │            │   │
│  │         └────────────────────┼──────────────────────┘            │   │
│  │                              │                                   │   │
│  │                    ┌─────────▼────────┐                          │   │
│  │                    │  Ollama Server   │                          │   │
│  │                    │  localhost:11434  │                          │   │
│  │                    └──────────────────┘                          │   │
│  └──────────────────────────────────────────────────────────────────┘   │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Tool & Capability Map

```
┌─────────────────────────────────────────────────────────────────────────┐
│                          TOOL SYSTEM                                    │
│                                                                         │
│  ┌─────────────────┐   ┌─────────────────┐   ┌─────────────────────┐   │
│  │  Tool Registry  │──▶│  Tool Schemas   │──▶│  Tool Orchestrator  │   │
│  │  (discovery)    │   │  (definitions)  │   │  (multi-turn exec)  │   │
│  └─────────────────┘   └────────┬────────┘   └──────────┬──────────┘   │
│                                 │                        │              │
│                    ┌────────────┼────────────┐           │              │
│                    ▼            ▼            ▼           ▼              │
│  ┌──────────────────────────────────────────────────────────────────┐   │
│  │                      Tool Categories                            │   │
│  │                                                                  │   │
│  │  CORE                  CODING               MESSAGING            │   │
│  │  ├─ READ_FILE          ├─ EDIT_FILE         └─ SEND_MESSAGE     │   │
│  │  ├─ WRITE_FILE         ├─ GLOB_FILES                            │   │
│  │  ├─ LIST_FILES         ├─ GREP_FILES        PRODUCTIVITY        │   │
│  │  ├─ SEARCH_FILES       └─ VALIDATE_FILES    ├─ CALENDAR_READ    │   │
│  │  ├─ READ_DOCUMENT                           ├─ REMINDER_CREATE  │   │
│  │  └─ BASH                                    └─ HTTP_GET         │   │
│  │                                                                  │   │
│  │  AUTONOMOUS (76 tools)                                          │   │
│  │  ├─ All core + coding + messaging + productivity                │   │
│  │  ├─ Memory: recall, remember, forget, search_memory             │   │
│  │  ├─ Goals: add_goal, complete_goal, reprioritize                │   │
│  │  ├─ Journal: write_entry, read_entries, compress                │   │
│  │  ├─ World Model: update_user_model, assess_health               │   │
│  │  ├─ Self-knowledge: crystals, constitution, traces              │   │
│  │  ├─ Dream: consolidate, explore, rebuild_self_model             │   │
│  │  ├─ Scheduling: schedule_task, list_jobs                        │   │
│  │  └─ Meta: classify, plan, verify, introspect                    │   │
│  └──────────────────────────────────────────────────────────────────┘   │
│                                                                         │
│  ┌──────────────────────────────────────────────────────────────────┐   │
│  │  Skills System                                                  │   │
│  │  ├─ SKILL.md loader (YAML frontmatter → tool registration)     │   │
│  │  ├─ ~/.casterly/workspace/skills/                               │   │
│  │  └─ ./skills/                                                   │   │
│  └──────────────────────────────────────────────────────────────────┘   │
│                                                                         │
│  ┌──────────────────────────────────────────────────────────────────┐   │
│  │  Bash Safety Gates                                              │   │
│  │  ├─ Blocked patterns: rm -rf /, fork bomb, dd, chmod, mkfs     │   │
│  │  ├─ Approval bridge for destructive commands                    │   │
│  │  └─ Tool output sanitization                                    │   │
│  └──────────────────────────────────────────────────────────────────┘   │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Security & Privacy Wireframe

```
┌─────────────────────────────────────────────────────────────────────────┐
│                   SECURITY PERIMETER (local-only)                       │
│                                                                         │
│  ┌──────────────────────────────────────────────────────────────────┐   │
│  │  Inbound Data                                                   │   │
│  │                                                                  │   │
│  │    User Input ──▶ ┌──────────────────┐                          │   │
│  │                   │  Input Guard     │                          │   │
│  │                   │  (rate limit,    │                          │   │
│  │                   │   validation)    │                          │   │
│  │                   └────────┬─────────┘                          │   │
│  │                            │                                    │   │
│  │                            ▼                                    │   │
│  │                   ┌──────────────────┐                          │   │
│  │                   │  Sensitivity     │                          │   │
│  │                   │  Detector        │                          │   │
│  │                   │                  │                          │   │
│  │                   │  Categories:     │                          │   │
│  │                   │  · calendar      │                          │   │
│  │                   │  · finances      │                          │   │
│  │                   │  · health        │                          │   │
│  │                   │  · credentials   │                          │   │
│  │                   │  · documents     │                          │   │
│  │                   │  · contacts      │                          │   │
│  │                   │  · location      │                          │   │
│  │                   └────────┬─────────┘                          │   │
│  │                            │                                    │   │
│  │                      always local                               │   │
│  │                            │                                    │   │
│  │                            ▼                                    │   │
│  │                   ┌──────────────────┐                          │   │
│  │                   │  Local Ollama    │◀── no cloud path exists  │   │
│  │                   │  Inference       │                          │   │
│  │                   └────────┬─────────┘                          │   │
│  │                            │                                    │   │
│  │                            ▼                                    │   │
│  └──────────────────────────────────────────────────────────────────┘   │
│                                                                         │
│  ┌──────────────────────────────────────────────────────────────────┐   │
│  │  Outbound Data (logging)                                        │   │
│  │                                                                  │   │
│  │  LLM Response ──▶ ┌──────────────────┐ ──▶ ┌────────────────┐  │   │
│  │                   │  Tool Output     │     │  Redactor      │  │   │
│  │  Tool Results ──▶ │  Sanitizer       │     │  (patterns.ts) │  │   │
│  │                   └──────────────────┘     └───────┬────────┘  │   │
│  │                                                    │           │   │
│  │                                                    ▼           │   │
│  │                                            ┌───────────────┐   │   │
│  │                                            │  Safe Logger  │   │   │
│  │                                            │  [REDACTED]   │   │   │
│  │                                            └───────────────┘   │   │
│  └──────────────────────────────────────────────────────────────────┘   │
│                                                                         │
│  ┌──────────────────────────────────────────────────────────────────┐   │
│  │  Protected Paths (guardrails.mjs)                               │   │
│  │                                                                  │   │
│  │  src/security/*  ·  src/tasks/classifier.ts  ·  src/providers/* │   │
│  │  config/*  ·  .env*  ·  docs/rulebook.md  ·  scripts/guardrails │   │
│  └──────────────────────────────────────────────────────────────────┘   │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 4. State & Memory Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                     PERSISTENT STATE                                    │
│                                                                         │
│  ┌──────────────────────────────────┐  ┌─────────────────────────────┐  │
│  │  Journal (append-only JSONL)     │  │  World Model               │  │
│  │  ├─ Every agent action logged    │  │  ├─ User behavior patterns │  │
│  │  ├─ Handoff notes between runs   │  │  ├─ Health snapshots       │  │
│  │  ├─ Compressed during dreams     │  │  ├─ Active concerns        │  │
│  │  └─ Source of truth for history  │  │  └─ Derived, not stored    │  │
│  └──────────────────────────────────┘  └─────────────────────────────┘  │
│                                                                         │
│  ┌──────────────────────────────────┐  ┌─────────────────────────────┐  │
│  │  Goal Stack                     │  │  Issue Log                  │  │
│  │  ├─ Hierarchical goals          │  │  ├─ Tracked issues          │  │
│  │  ├─ Sources (user, self, event) │  │  ├─ Attempted solutions     │  │
│  │  └─ Status tracking             │  │  └─ Resolution history      │  │
│  └──────────────────────────────────┘  └─────────────────────────────┘  │
│                                                                         │
│  ┌──────────────────────────────────┐  ┌─────────────────────────────┐  │
│  │  Context Store (tiered)         │  │  Session Store              │  │
│  │  ├─ HOT:  current conversation  │  │  ├─ Per-peer scoping       │  │
│  │  ├─ WARM: recent memories       │  │  ├─ 50-message history     │  │
│  │  └─ COLD: semantic search only  │  │  └─ Daily reset at 4 AM   │  │
│  └──────────────────────────────────┘  └─────────────────────────────┘  │
│                                                                         │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │  Self-Knowledge                                                 │    │
│  │  ├─ Crystals: distilled lessons (append, never delete)         │    │
│  │  ├─ Constitution: operating principles                          │    │
│  │  ├─ Prompt Store: versioned, self-modifiable prompts            │    │
│  │  ├─ Shadow Store: judgment pattern analysis                     │    │
│  │  └─ Self-Model: skills inventory and capability assessment      │    │
│  └─────────────────────────────────────────────────────────────────┘    │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 5. Task Execution Pipeline

```
                         ┌─────────────────┐
                         │  Incoming Task   │
                         └────────┬────────┘
                                  │
                                  ▼
                         ┌─────────────────┐
                         │  Classifier     │
                         │  (LLM-based)    │
                         └────────┬────────┘
                                  │
                  ┌───────────────┼───────────────┐
                  │               │               │
                  ▼               ▼               ▼
          ┌──────────┐   ┌──────────────┐  ┌──────────────┐
          │conversa- │   │ simple_task  │  │ complex_task │
          │tion      │   │              │  │              │
          └────┬─────┘   └──────┬───────┘  └──────┬───────┘
               │                │                  │
               ▼                ▼                  ▼
          Direct LLM       Single tool        ┌──────────┐
          response         loop               │ Planner  │
                                              │ (multi-  │
                                              │  step)   │
                                              └────┬─────┘
                                                   │
                                                   ▼
                                              ┌──────────┐
                                              │ Runner   │
                                              │ (execute │
                                              │  steps)  │
                                              └────┬─────┘
                                                   │
                                                   ▼
                                              ┌──────────┐
                                              │ Verifier │
                                              │ (confirm │
                                              │  done)   │
                                              └──────────┘
```

---

## 6. Autonomous Agent Lifecycle

```
┌─────────────────────────────────────────────────────────────────────────┐
│                  AUTONOMOUS AGENT LIFECYCLE                              │
│                                                                         │
│  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────┐                   │
│  │ Message │  │  Event  │  │ Schedule│  │  Goal   │                   │
│  │ Trigger │  │ Trigger │  │ Trigger │  │ Trigger │                   │
│  └────┬────┘  └────┬────┘  └────┬────┘  └────┬────┘                   │
│       └────────────┼────────────┼────────────┘                         │
│                    ▼                                                     │
│       ┌────────────────────────┐                                        │
│       │    Load Persistent     │                                        │
│       │    State               │                                        │
│       │    · journal           │                                        │
│       │    · world model       │                                        │
│       │    · goal stack        │                                        │
│       │    · issue log         │                                        │
│       │    · crystals          │                                        │
│       │    · constitution      │                                        │
│       └───────────┬────────────┘                                        │
│                   ▼                                                      │
│       ┌────────────────────────┐                                        │
│       │  Build Identity Prompt │                                        │
│       │  + rules + context     │                                        │
│       └───────────┬────────────┘                                        │
│                   ▼                                                      │
│       ┌────────────────────────────────────────────────┐                │
│       │              ReAct Loop                        │                │
│       │                                                │                │
│       │   ┌────────┐   ┌──────────┐   ┌────────────┐  │                │
│       │   │  LLM   │──▶│  Tools   │──▶│  Results   │  │                │
│       │   │  Call   │   │  (76)    │   │  Observed  │──┤                │
│       │   └────────┘   └──────────┘   └────────────┘  │                │
│       │       ▲                                        │                │
│       │       └──────────── loop ◀─────────────────────┘                │
│       │                                                                 │
│       │   Exit: text response = summary                                │
│       └───────────────────┬────────────────────────────┘                │
│                           ▼                                              │
│       ┌────────────────────────┐                                        │
│       │  Write Handoff Note    │                                        │
│       │  (append to journal)   │                                        │
│       └───────────┬────────────┘                                        │
│                   ▼                                                      │
│       ┌────────────────────────┐                                        │
│       │  Save Updated State    │                                        │
│       └────────────────────────┘                                        │
│                                                                         │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │  Dream Cycles (idle-time self-improvement)                      │    │
│  │                                                                  │    │
│  │  consolidate_reflections ──▶ reorganize_goals                   │    │
│  │          │                        │                              │    │
│  │          ▼                        ▼                              │    │
│  │  explore_codebase ──▶ rebuild_self_model ──▶ write_retrospective│    │
│  │          │                                                       │    │
│  │          ▼                                                       │    │
│  │  challenge_generator ──▶ challenge_evaluator                    │    │
│  │          │                                                       │    │
│  │          ▼                                                       │    │
│  │  prompt_evolution ──▶ training_extractor ──▶ lora_trainer       │    │
│  └─────────────────────────────────────────────────────────────────┘    │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 7. Configuration & Validation Flow

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    CONFIGURATION SYSTEM                                  │
│                                                                         │
│  config/                                                                │
│  ├─ default.yaml ────────┐                                             │
│  ├─ models.yaml ─────────┤                                             │
│  ├─ autonomous.yaml ─────┤                                             │
│  └─ model-profiles.yaml ─┤                                             │
│                           ▼                                             │
│              ┌────────────────────────┐                                 │
│              │  YAML Loader          │                                 │
│              │  (src/config/index.ts) │                                 │
│              └───────────┬────────────┘                                 │
│                          │                                              │
│                          ▼                                              │
│              ┌────────────────────────┐                                 │
│              │  Zod Schema Validation │                                 │
│              │  (src/config/schema.ts)│                                 │
│              │                        │                                 │
│              │  · Type checking       │                                 │
│              │  · Required fields     │                                 │
│              │  · Default values      │                                 │
│              │  · Fail-fast on error  │                                 │
│              └───────────┬────────────┘                                 │
│                          │                                              │
│                          ▼                                              │
│              ┌────────────────────────┐                                 │
│              │  Validated Config      │                                 │
│              │                        │                                 │
│              │  provider: ollama      │                                 │
│              │  model: gpt-oss:120b   │                                 │
│              │  codingModel: qwen3... │                                 │
│              │  sensitivity: [...]    │                                 │
│              │  tools: { enabled, ... }│                                │
│              │  logging: { redact }   │                                 │
│              └────────────────────────┘                                 │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 8. iMessage Integration

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    iMESSAGE SUBSYSTEM                                    │
│                                                                         │
│  ┌──────────────────────────────────────────────────────────────────┐   │
│  │  macOS                                                          │   │
│  │  ┌───────────────────┐                                          │   │
│  │  │  Messages.app     │                                          │   │
│  │  │  (chat.db SQLite) │                                          │   │
│  │  └────────┬──────────┘                                          │   │
│  │           │ poll                                                 │   │
│  │           ▼                                                      │   │
│  │  ┌───────────────────┐    ┌────────────────┐                    │   │
│  │  │  SQLite Reader    │───▶│  Input Guard   │                    │   │
│  │  │  (reader.ts)      │    │  (rate limit)  │                    │   │
│  │  └───────────────────┘    └───────┬────────┘                    │   │
│  │                                   │                              │   │
│  │                                   ▼                              │   │
│  │  ┌───────────────────────────────────────────────────────────┐   │   │
│  │  │  iMessage Daemon                                         │   │   │
│  │  │  ├─ Polls for new messages                               │   │   │
│  │  │  ├─ Filters through tool filter (subset of tools)        │   │   │
│  │  │  ├─ Routes to pipeline / trigger router                  │   │   │
│  │  │  └─ Session scoped per-peer                              │   │   │
│  │  └───────────────────────────────┬───────────────────────────┘   │   │
│  │                                  │                               │   │
│  │                                  ▼                               │   │
│  │  ┌───────────────────┐    ┌─────────────────┐                   │   │
│  │  │  AppleScript      │◀───│  Response        │                   │   │
│  │  │  Sender           │    │  (from agent)    │                   │   │
│  │  │  (sender.ts)      │    └─────────────────┘                   │   │
│  │  └───────────────────┘                                          │   │
│  └──────────────────────────────────────────────────────────────────┘   │
│                                                                         │
│  ┌──────────────────────────────────────────────────────────────────┐   │
│  │  Approval Bridge                                                │   │
│  │  ├─ Destructive commands require user approval via iMessage     │   │
│  │  ├─ Async request → wait → parse response                      │   │
│  │  └─ Approval store persists pending requests                    │   │
│  └──────────────────────────────────────────────────────────────────┘   │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 9. Coding Interface

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    CODING INTERFACE                                      │
│                                                                         │
│  ┌──────────────────────────────────────────────────────────────────┐   │
│  │  Modes                                                          │   │
│  │  ┌────────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐         │   │
│  │  │ Architect  │ │  Code    │ │  Review  │ │   Ask    │         │   │
│  │  │ (plan)     │ │ (write)  │ │ (audit)  │ │ (query)  │         │   │
│  │  └────────────┘ └──────────┘ └──────────┘ └──────────┘         │   │
│  └──────────────────────────────────────────────────────────────────┘   │
│                                                                         │
│  ┌──────────────────────────────────────────────────────────────────┐   │
│  │  Context Manager                                                │   │
│  │  ├─ Token budget management                                     │   │
│  │  ├─ Auto-context from open files                                │   │
│  │  └─ File tracking and relevance scoring                         │   │
│  └──────────────────────────────────────────────────────────────────┘   │
│                                                                         │
│  ┌──────────────────────────────────────────────────────────────────┐   │
│  │  Repo Map                                                       │   │
│  │  ├─ Language extractors: TypeScript, Python, Rust, Go           │   │
│  │  ├─ Symbol extraction (functions, classes, interfaces)          │   │
│  │  ├─ PageRank for importance scoring                             │   │
│  │  └─ Structured codebase index                                   │   │
│  └──────────────────────────────────────────────────────────────────┘   │
│                                                                         │
│  ┌──────────────────────────────────────────────────────────────────┐   │
│  │  Validation                                                     │   │
│  │  ├─ Code validation and execution                               │   │
│  │  └─ Type checking and lint integration                          │   │
│  └──────────────────────────────────────────────────────────────────┘   │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 10. Quality Gates Pipeline

```
  npm run check
       │
       ▼
  ┌──────────────────┐     ┌──────────────────┐     ┌──────────────────┐
  │  1. Guardrails   │────▶│  2. ESLint       │────▶│  3. TypeScript   │
  │  (protected      │     │  (code style)    │     │  (type check)    │
  │   path check)    │     │                  │     │                  │
  └──────────────────┘     └──────────────────┘     └──────────────────┘
                                                            │
                                                            ▼
                           ┌──────────────────┐     ┌──────────────────┐
                           │  5. Security     │◀────│  4. Vitest       │
                           │  Scan            │     │  (unit tests)    │
                           │                  │     │                  │
                           └──────────────────┘     └──────────────────┘
                                   │
                                   ▼
                            PASS or FAIL
```

---

## 11. Source File Map

```
src/
├── index.ts                      # CLI entry point
├── imessage-daemon.ts            # iMessage daemon entry
├── terminal-repl.ts              # Terminal REPL
├── benchmark-cli.ts              # Benchmarking
├── test-cli.ts                   # Testing interface
│
├── config/                       # Configuration
│   ├── index.ts                  #   YAML loader
│   └── schema.ts                 #   Zod validation schemas
│
├── providers/                    # LLM Providers
│   ├── base.ts                   #   LlmProvider interface
│   ├── ollama.ts                 #   Ollama client (local-only)
│   ├── concurrent.ts             #   Parallel inference
│   ├── embedding.ts              #   Embedding support
│   └── index.ts                  #   Provider registry
│
├── security/                     # Privacy & Security
│   ├── detector.ts               #   Sensitive content detector
│   ├── patterns.ts               #   Detection regex patterns
│   ├── redactor.ts               #   Text redaction
│   └── tool-output-sanitizer.ts  #   Output sanitization
│
├── logging/                      # Safe Logging
│   └── safe-logger.ts            #   Redaction-aware logger
│
├── errors/                       # Error System
│   └── codes.ts                  #   Structured error codes (E1xx-E9xx)
│
├── tools/                        # Tool System
│   ├── schemas/                  #   Definitions
│   │   ├── types.ts              #     Tool interface
│   │   ├── core.ts               #     File ops, bash, search
│   │   ├── coding.ts             #     Edit, glob, grep, validate
│   │   ├── messaging.ts          #     Send message
│   │   ├── productivity.ts       #     Calendar, reminders, HTTP
│   │   └── registry.ts           #     Discovery and conversion
│   ├── executors/                #   Implementations
│   ├── executor.ts               #   Bash execution + safety
│   ├── orchestrator.ts           #   Multi-turn tool loop
│   └── synthesizer.ts            #   Dynamic tool creation
│
├── interface/                    # Prompt & Session
│   ├── bootstrap.ts              #   Workspace init
│   ├── prompt-builder.ts         #   System prompt assembly
│   ├── context.ts                #   Context + token management
│   ├── context-profiles.ts       #   Minimal context for classifier
│   ├── session.ts                #   Session lifecycle
│   ├── memory.ts                 #   Long-term memory
│   └── contacts.ts               #   Address book, admin ACL
│
├── imessage/                     # iMessage Integration
│   ├── daemon.ts                 #   SQLite polling loop
│   ├── reader.ts                 #   chat.db reader
│   ├── sender.ts                 #   AppleScript sender
│   ├── input-guard.ts            #   Rate limiting
│   └── tool-filter.ts            #   Tool subset for iMessage
│
├── tasks/                        # Task Pipeline
│   ├── classifier.ts             #   conversation/simple/complex
│   ├── planner.ts                #   Multi-step plan generation
│   ├── runner.ts                 #   Plan execution
│   ├── verifier.ts               #   Completion verification
│   ├── manager.ts                #   Pipeline orchestrator
│   └── execution-log.ts          #   Tool reliability tracking
│
├── pipeline/                     # Chat Pipeline
│   └── process.ts                #   Shared processing flow
│
├── coding/                       # Coding Mode
│   ├── context-manager/          #   Token budget
│   ├── repo-map/                 #   Codebase indexing (PageRank)
│   ├── token-counter.ts          #   Token estimation
│   ├── session-memory/           #   Coding session state
│   ├── modes/                    #   architect/code/review/ask
│   └── validation/               #   Code validation
│
├── autonomous/                   # Autonomous Agent
│   ├── agent-loop.ts             #   Main ReAct loop
│   ├── agent-tools.ts            #   76-tool toolkit
│   ├── provider.ts               #   Autonomous provider
│   ├── identity.ts               #   Persistent identity
│   ├── journal.ts                #   Append-only log
│   ├── world-model.ts            #   User/environment model
│   ├── goal-stack.ts             #   Goal hierarchy
│   ├── issue-log.ts              #   Issue tracking
│   ├── context-store.ts          #   Tiered memory (hot/warm/cold)
│   ├── context-manager.ts        #   Memory tier management
│   ├── events.ts                 #   Event bus
│   ├── trigger-router.ts         #   Trigger normalization
│   ├── prompt-store.ts           #   Self-modifying prompts
│   ├── shadow-store.ts           #   Judgment analysis
│   ├── communication/            #   Notification policy
│   ├── reasoning/                #   Scaling + adversarial
│   ├── watchers/                 #   File, git, issue watchers
│   └── dream/                    #   Self-improvement
│       ├── runner.ts             #     Dream cycle orchestrator
│       ├── self-model.ts         #     Capability assessment
│       ├── archaeology.ts        #     Code history analysis
│       ├── challenge-generator.ts#     Self-test generation
│       ├── challenge-evaluator.ts#     Sub-skill tracking
│       ├── prompt-evolution.ts   #     Genetic prompt optimization
│       ├── training-extractor.ts #     LoRA data extraction
│       └── lora-trainer.ts       #     LoRA adapter management
│
├── scheduler/                    # Job Scheduling
│   ├── trigger.ts                #   Time spec parsing
│   ├── cron.ts                   #   Cron evaluation
│   ├── store.ts                  #   Job persistence
│   ├── checker.ts                #   Due job detection
│   └── executor.ts               #   Reminder execution
│
├── approval/                     # Approval System
│   ├── bridge.ts                 #   Async approval flow
│   ├── matcher.ts                #   Response parsing
│   └── store.ts                  #   Request persistence
│
├── skills/                       # Skill System
│   ├── loader.ts                 #   SKILL.md discovery
│   └── types.ts                  #   Skill metadata
│
├── models/                       # Model Profiles
│   ├── profiles.ts               #   Generation parameters
│   ├── enrichment.ts             #   Prompt enrichment
│   └── types.ts                  #   Profile types
│
├── benchmark/                    # Benchmarking
│   └── ...                       #   Scoring, health, analysis
│
└── testing/                      # Debug & Testing
    ├── test-cases.ts             #   Test definitions
    ├── test-runner.ts            #   Test execution
    └── trace.ts                  #   Trace collection
```

---

## 12. Hardware & Runtime

```
┌─────────────────────────────────────────────────────────────────────────┐
│  Mac Studio M4 Max · 128 GB Unified Memory                              │
│                                                                         │
│  ┌───────────────────────────────────────┐                              │
│  │  Ollama Server (localhost:11434)      │                              │
│  │                                       │                              │
│  │  Loaded Models (up to 3 concurrent):  │                              │
│  │  ┌─────────────────────────────────┐  │                              │
│  │  │  gpt-oss:120b (primary)        │  │  ◀── general reasoning       │
│  │  │  96/100 benchmark score        │  │                              │
│  │  └─────────────────────────────────┘  │                              │
│  │  ┌─────────────────────────────────┐  │                              │
│  │  │  qwen3-coder-next (coding)     │  │  ◀── code generation        │
│  │  └─────────────────────────────────┘  │                              │
│  │  ┌─────────────────────────────────┐  │                              │
│  │  │  Embedding model               │  │  ◀── semantic search         │
│  │  └─────────────────────────────────┘  │                              │
│  │                                       │                              │
│  │  Target: 70% memory · 30% for OS     │                              │
│  └───────────────────────────────────────┘                              │
│                                                                         │
│  Economics: all tokens are free → maximize LLM calls                    │
│  Strategy: redundant verification, self-correction, exploration         │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 13. Key Interfaces (Reference)

```typescript
// Provider contract — all providers implement this
interface LlmProvider {
  id: string
  kind: 'local' | 'cloud'          // always 'local' in practice
  model: string
  generateWithTools(
    request: GenerateRequest,
    tools: ToolSchema[],
    previousResults?: ToolResultMessage[]
  ): Promise<GenerateWithToolsResponse>
}

// Tool definition shape
interface ToolSchema {
  name: string
  description: string
  inputSchema: {
    type: 'object'
    properties: Record<string, ToolProperty>
    required: string[]
  }
}

// Task classification output
type TaskClass = 'conversation' | 'simple_task' | 'complex_task'
interface ClassificationResult {
  taskClass: TaskClass
  confidence: number
  reason: string
  taskType?: string
}

// Trigger shape — all event sources normalize to this
interface Trigger {
  source: 'message' | 'event' | 'schedule' | 'goal'
  payload: unknown
}
```

---

## 14. Subagent Development Flow

```
  New feature or cross-cutting change
       │
       ▼
  ┌──────────────────┐
  │ 1. System        │  Confirm approach, check invariants,
  │    Architect     │  verify local-first guarantees
  └────────┬─────────┘
           │
           ▼
  ┌──────────────────┐
  │ 2. Implementer   │  Model Selection | Provider | Config |
  │    Specialist    │  Logging | (domain-specific work)
  └────────┬─────────┘
           │
           ▼
  ┌──────────────────┐
  │ 3. Security      │  Check for exfiltration, verify redaction,
  │    Reviewer      │  review logs and routing
  └────────┬─────────┘
           │
           ▼
  ┌──────────────────┐
  │ 4. Test          │  Unit tests: happy path, failure path,
  │    Engineer      │  privacy edge case
  └────────┬─────────┘
           │
           ▼
  ┌──────────────────┐
  │ 5. Quality Gates │  npm run check
  │    Enforcer      │  (guardrails → lint → types → tests → security)
  └──────────────────┘
```
