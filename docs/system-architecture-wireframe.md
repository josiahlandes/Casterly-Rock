# Casterly Rock — System Architecture Wireframe

A visual reference for the full system. Each module is numbered for cross-reference with the key below.

---

## System Wireframe

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                              ENTRY POINTS                                       │
│                                                                                 │
│    [1] CLI         [2] iMessage       [3] Terminal      [4] Benchmark           │
│    index.ts         Daemon             REPL              CLI                    │
│        │               │                  │                 │                    │
└────────┼───────────────┼──────────────────┼─────────────────┼────────────────────┘
         │               │                  │                 │
         └───────────────┼──────────────────┼─────────────────┘
                         ▼                  ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                             TRIGGER LAYER                                       │
│                                                                                 │
│  ┌─────────────────────────────────────────────────────────────────────────┐    │
│  │                       [5] Trigger Router                                │    │
│  │            Normalizes all inputs into uniform Trigger shape             │    │
│  │                                                                         │    │
│  │   Sources:  message  │  event  │  schedule  │  goal                    │    │
│  └───────────────────────────────┬─────────────────────────────────────────┘    │
│                                  │                                              │
│  [6] File       [7] iMessage    [8] Cron         [9] Goal       [10] Git       │
│  Watcher        Messages        Scheduler        Stack          Watcher        │
│  (FSEvents)     (chat.db)       (local time)     (priority Q)   (.git/refs)    │
│                                                                                 │
│                        [11] Event Bus                                           │
│                        (emit / drain / peek / on)                               │
│                                                                                 │
└──────────────────────────────────┬──────────────────────────────────────────────┘
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                         INTELLIGENCE LAYER                                      │
│                                                                                 │
│  ┌─────────────────────────────────────────────────────────────────────────┐    │
│  │                    [12] Agent Loop (ReAct)                               │    │
│  │                    Sole execution path for all triggers                  │    │
│  │                                                                         │    │
│  │   [13] Runtime         [14] Identity        [15] Context                │    │
│  │   Context Injection    Builder              Manager                     │    │
│  │   (date, bootstrap     (world model,        (4-tier:                    │    │
│  │    files, contacts,     goals, issues,       hot/warm/                   │    │
│  │    file guidance)       crystals, rules,     cool/cold)                  │    │
│  │                         handoff note)                                    │    │
│  │                                                                         │    │
│  │   ┌─────────────────────────────────────────────────────────────────┐   │    │
│  │   │               ReAct Cycle (up to 200 turns)                    │   │    │
│  │   │                                                                 │   │    │
│  │   │   ┌──────────┐     ┌──────────────┐     ┌────────────────┐     │   │    │
│  │   │   │  Think   │────▶│  Act         │────▶│  Observe       │──┐  │   │    │
│  │   │   │  (LLM)   │     │  (96 tools)  │     │  (results)     │  │  │   │    │
│  │   │   └──────────┘     └──────────────┘     └────────────────┘  │  │   │    │
│  │   │        ▲                                                     │  │   │    │
│  │   │        └─────────────────────────────────────────────────────┘  │   │    │
│  │   └─────────────────────────────────────────────────────────────────┘   │    │
│  │                                                                         │    │
│  │   Budget: 500K tokens (user/goal) · 100K (background) · 200 turns max  │    │
│  └─────────────────────────────────────────────────────────────────────────┘    │
│                                                                                 │
│  ┌──────────────────────────────┐    ┌──────────────────────────────────────┐   │
│  │  [16] Voice Filter           │    │  [17] Model Selection & Routing     │   │
│  │  Personality rewrite before  │    │                                      │   │
│  │  message delivery. Reasoning │    │  qwen3.5:122b ◀── reasoning/general │   │
│  │  stays neutral; Tyrion's     │    │  qwen3-coder  ◀── code generation   │   │
│  │  voice applied at output     │    │  Embedding    ◀── semantic search   │   │
│  │  boundary only.              │    │                                      │   │
│  └──────────────────────────────┘    │  LLM decides routing via delegate   │   │
│                                      └──────────────────────────────────────┘   │
│                                                                                 │
└──────────────────────────────────┬──────────────────────────────────────────────┘
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                          TOOL SYSTEM [18]                                        │
│                                                                                 │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐    ┌──────────────┐   │
│  │ [19] Core    │    │ [20] Coding  │    │ [21] Comms   │    │ [22] Prod.   │   │
│  │ read_file    │    │ edit_file    │    │ send_message │    │ calendar     │   │
│  │ write_file   │    │ glob_files   │    │ message_user │    │ reminder     │   │
│  │ list_files   │    │ grep_files   │    │              │    │ http_get     │   │
│  │ search_files │    │ validate     │    │              │    │              │   │
│  │ read_doc     │    │              │    │              │    │              │   │
│  │ bash         │    │              │    │              │    │              │   │
│  └──────────────┘    └──────────────┘    └──────────────┘    └──────────────┘   │
│                                                                                 │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐    ┌──────────────┐   │
│  │ [23] State   │    │ [24] Memory  │    │ [25] Self-   │    │ [26] Self-   │   │
│  │ file_issue   │    │ recall       │    │ Knowledge    │    │ Improvement  │   │
│  │ close_issue  │    │ archive      │    │ crystallize  │    │ edit_prompt  │   │
│  │ update_goal  │    │ recall_jrnl  │    │ create_rule  │    │ shadow       │   │
│  │ update_world │    │ consolidate  │    │ replay       │    │ create_tool  │   │
│  │              │    │ semantic_rcl │    │              │    │ evolve_prompt│   │
│  └──────────────┘    └──────────────┘    └──────────────┘    └──────────────┘   │
│                                                                                 │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐    ┌──────────────┐   │
│  │ [27] Meta    │    │ [28] Intro-  │    │ [29] Context │    │ [30] Sched-  │   │
│  │ classify     │    │ spection     │    │ Control      │    │ uling        │   │
│  │ plan         │    │ peek_queue   │    │ load_context │    │ schedule     │   │
│  │ verify       │    │ check_budget │    │ evict_context│    │ list_sched   │   │
│  │ meta         │    │ list_context │    │ set_budget   │    │ cancel_sched │   │
│  │              │    │ review_steps │    │              │    │              │   │
│  │              │    │ assess_self  │    │              │    │              │   │
│  └──────────────┘    └──────────────┘    └──────────────┘    └──────────────┘   │
│                                                                                 │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐                       │
│  │ [31] Quality │    │ [32] Git     │    │ [33] Reason  │                       │
│  │ run_tests    │    │ git_status   │    │ think        │                       │
│  │ typecheck    │    │ git_diff     │    │ delegate     │                       │
│  │ lint         │    │ git_commit   │    │ parallel_rsn │                       │
│  │              │    │ git_log      │    │              │                       │
│  └──────────────┘    └──────────────┘    └──────────────┘                       │
│                                                                                 │
│  ┌─────────────────────────────────────────────────────────────────────────┐    │
│  │  [34] Skills System                                                     │    │
│  │  SKILL.md loader · ~/.casterly/skills/ · ./skills/                      │    │
│  │  apple-calendar · imessage-send · system-control · self-update · 3d    │    │
│  └─────────────────────────────────────────────────────────────────────────┘    │
│                                                                                 │
│  ┌─────────────────────────────────────────────────────────────────────────┐    │
│  │  [35] Bash Safety Gates                                                 │    │
│  │  BLOCKED (rm -rf /, mkfs, fork bomb) · APPROVAL_REQUIRED (rm, sudo,    │    │
│  │  chmod) · SAFE (echo, cat, ls, grep)  ·  Tool output sanitization      │    │
│  └─────────────────────────────────────────────────────────────────────────┘    │
│                                                                                 │
└──────────────────────────────────┬──────────────────────────────────────────────┘
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                          PROVIDER LAYER                                         │
│                                                                                 │
│  ┌─────────────────────────────────────────────────────────────────────────┐    │
│  │  [36] LlmProvider Interface                                             │    │
│  │  generateWithTools(request, tools, prevResults) → response              │    │
│  └──────────┬──────────────────────────┬───────────────────┬───────────────┘    │
│             │                          │                   │                    │
│  ┌──────────▼──────────┐  ┌────────────▼────────┐  ┌──────▼──────────────┐     │
│  │  [37] Ollama        │  │  [38] Concurrent    │  │  [39] Embedding     │     │
│  │  Provider           │  │  Provider           │  │  Provider           │     │
│  │  (primary + coding) │  │  (parallel/bestOfN) │  │  (semantic search)  │     │
│  └──────────┬──────────┘  └────────────┬────────┘  └──────┬──────────────┘     │
│             └──────────────────────────┼───────────────────┘                    │
│                                        ▼                                        │
│                           ┌────────────────────────┐                            │
│                           │  [40] Ollama Server    │                            │
│                           │  localhost:11434        │                            │
│                           │  qwen3.5:122b (81GB)   │                            │
│                           │  + qwen3-coder-next    │                            │
│                           │  + embedding model     │                            │
│                           └────────────────────────┘                            │
│                                                                                 │
└─────────────────────────────────────────────────────────────────────────────────┘
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                          SECURITY PERIMETER [41]                                │
│                                                                                 │
│  ┌────────────┐  ┌────────────┐  ┌────────────┐  ┌────────────┐  ┌──────────┐  │
│  │ [42] Input │  │ [43] Sens. │  │ [44] Tool  │  │ [45] Redac-│  │ [46] Safe│  │
│  │ Guard      │  │ Detector   │  │ Output     │  │ tor        │  │ Logger   │  │
│  │ rate limit │  │ 8 categs.  │  │ Sanitizer  │  │ patterns   │  │ [REDACT] │  │
│  │ validation │  │ always     │  │ injection  │  │ SSN, CC,   │  │ no raw   │  │
│  │ size check │  │ local      │  │ stripping  │  │ phone, etc │  │ user data│  │
│  └────────────┘  └────────────┘  └────────────┘  └────────────┘  └──────────┘  │
│                                                                                 │
│  [47] Protected Paths (guardrails.mjs)                                          │
│  src/security/* · src/tasks/classifier.ts · src/providers/* · config/*          │
│  .env* · docs/rulebook.md · docs/subagents.md · scripts/guardrails.mjs         │
│                                                                                 │
└─────────────────────────────────────────────────────────────────────────────────┘
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                       PERSISTENT STATE & MEMORY [48]                            │
│                                                                                 │
│  ┌──────────────────────────┐  ┌──────────────────────────┐                     │
│  │ [49] Journal             │  │ [50] World Model         │                     │
│  │ Append-only JSONL        │  │ Health, stats, concerns, │                     │
│  │ Handoff notes, reflect-  │  │ activity, user model     │                     │
│  │ ions, opinions, observ-  │  │                          │                     │
│  │ ations, interactions     │  │                          │                     │
│  └──────────────────────────┘  └──────────────────────────┘                     │
│                                                                                 │
│  ┌──────────────────────────┐  ┌──────────────────────────┐                     │
│  │ [51] Goal Stack          │  │ [52] Issue Log           │                     │
│  │ Priority queue, capacity │  │ Problems with attempt    │                     │
│  │ limits, sources (user,   │  │ history, severity,       │                     │
│  │ self, event)             │  │ resolution tracking      │                     │
│  └──────────────────────────┘  └──────────────────────────┘                     │
│                                                                                 │
│  ┌──────────────────────────┐  ┌──────────────────────────┐                     │
│  │ [53] Crystal Store       │  │ [54] Constitution Store  │                     │
│  │ Permanent insights       │  │ Self-authored rules      │                     │
│  │ (max 30, confidence      │  │ (max 50, success rates,  │                     │
│  │  tracking, lifecycle)    │  │  lifecycle management)   │                     │
│  └──────────────────────────┘  └──────────────────────────┘                     │
│                                                                                 │
│  ┌──────────────────────────┐  ┌──────────────────────────┐                     │
│  │ [55] Prompt Store        │  │ [56] Shadow Store        │                     │
│  │ Versioned system prompt  │  │ Alternative approaches,  │                     │
│  │ (max 20 versions,        │  │ judgment patterns        │                     │
│  │  self-modifying)         │  │                          │                     │
│  └──────────────────────────┘  └──────────────────────────┘                     │
│                                                                                 │
│  ┌──────────────────────────┐  ┌──────────────────────────┐                     │
│  │ [57] Trace Replay        │  │ [58] Execution Log       │                     │
│  │ Execution traces for     │  │ Bounded JSONL of task    │                     │
│  │ post-mortem analysis     │  │ outcomes for operational │                     │
│  │ (max 500 traces)         │  │ memory (max 500/30d)     │                     │
│  └──────────────────────────┘  └──────────────────────────┘                     │
│                                                                                 │
│  ┌──────────────────────────┐  ┌──────────────────────────┐                     │
│  │ [59] Advanced Memory     │  │ [60] Context Store       │                     │
│  │ A-MEM link network       │  │ 4-tier: hot (2K), warm   │                     │
│  │ AUDN consolidator (Mem0) │  │ (10K), cool (30d search),│                     │
│  │ SAGE entropy tiers       │  │ cold (archive search)    │                     │
│  │ Letta snapshots          │  │ Context window: 40,960   │                     │
│  └──────────────────────────┘  └──────────────────────────┘                     │
│                                                                                 │
└─────────────────────────────────────────────────────────────────────────────────┘
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                       DREAM CYCLES [61]                                         │
│                       (idle-time self-improvement)                               │
│                                                                                 │
│  [62] consolidate        [63] reorganize       [64] explore                     │
│  reflections ──────────▶ goals ──────────────▶ codebase ──┐                    │
│                                                            │                    │
│                                                            ▼                    │
│  [67] prompt       [66] training    [65] rebuild                                │
│  evolution ◀────── extractor ◀───── self_model ◀── write_retrospective          │
│       │                                                                         │
│       ▼                                                                         │
│  [68] LoRA trainer ──▶ adapter lifecycle (train → eval → active → archive)     │
│                                                                                 │
│  [69] Challenge gen ──▶ Challenge eval ──▶ sub-skill tracking                  │
│                                                                                 │
└─────────────────────────────────────────────────────────────────────────────────┘
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                       iMESSAGE SUBSYSTEM [70]                                   │
│                                                                                 │
│  ┌────────────┐    ┌────────────┐    ┌────────────┐    ┌────────────────────┐   │
│  │ [71] SQLite│───▶│ [72] Input │───▶│ [73] Trig- │───▶│ [74] Agent Loop   │   │
│  │ Reader     │    │ Guard      │    │ ger Router │    │ (runTriggeredCycle)│   │
│  │ (chat.db)  │    │ (rate lim) │    │            │    │                    │   │
│  └────────────┘    └────────────┘    └────────────┘    └─────────┬──────────┘   │
│                                                                   │              │
│                                        ┌──────────────────────────┘              │
│                                        ▼                                        │
│  ┌────────────────────┐    ┌───────────────────┐    ┌────────────────────────┐   │
│  │ [75] AppleScript   │◀───│ [76] Voice Filter │◀───│ Agent Loop Response   │   │
│  │ Sender             │    │ (personality)      │    │                        │   │
│  │ (sender.ts)        │    │                    │    │                        │   │
│  └────────────────────┘    └───────────────────┘    └────────────────────────┘   │
│                                                                                 │
│  [77] Approval Bridge — destructive commands require user approval via iMessage │
│                                                                                 │
└─────────────────────────────────────────────────────────────────────────────────┘
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                       QUALITY GATES [78]                                         │
│                                                                                 │
│  npm run check                                                                  │
│       │                                                                         │
│       ▼                                                                         │
│  [79] Guardrails ──▶ [80] ESLint ──▶ [81] TypeScript ──▶ [82] Vitest ──▶      │
│  (protected paths)   (code style)   (tsc --noEmit)      (3300+ tests)          │
│                                                               │                 │
│                                                               ▼                 │
│                                                          [83] Security          │
│                                                          Scan                   │
│                                                          (npm audit +           │
│                                                           console.log)          │
│                                                               │                 │
│                                                               ▼                 │
│                                                          PASS or FAIL           │
│                                                                                 │
└─────────────────────────────────────────────────────────────────────────────────┘
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                       HARDWARE [84]                                              │
│                                                                                 │
│  Mac Studio M4 Max · 128GB Unified Memory · NVMe SSD                           │
│                                                                                 │
│  ┌─────────────────────────────────────────────────────────────────────────┐    │
│  │  Ollama Server (localhost:11434)                                        │    │
│  │                                                                         │    │
│  │  [85] qwen3.5:122b (81GB)  ◀── primary reasoning (40K context)         │    │
│  │  [86] qwen3-coder-next     ◀── code generation                         │    │
│  │  [87] Embedding model      ◀── semantic search                          │    │
│  │                                                                         │    │
│  │  ~90GB model memory · ~38GB headroom for OS + KV cache                  │    │
│  └─────────────────────────────────────────────────────────────────────────┘    │
│                                                                                 │
│  Economics: all tokens free → maximize LLM calls → self-correction,            │
│  redundant verification, exploration, shadow execution, prompt evolution        │
│                                                                                 │
└─────────────────────────────────────────────────────────────────────────────────┘
```

---

## Module Key

| # | Module | Description |
|---|--------|-------------|
| **Entry Points** | | |
| 1 | CLI | Command-line interface entry point (`index.ts`). Single-query mode with optional `--execute` flag. |
| 2 | iMessage Daemon | Polls macOS Messages.app SQLite database every 2 seconds for new messages. Routes all messages through the agent loop via `triggerFromMessage()` → `runTriggeredCycle()`. |
| 3 | Terminal REPL | Interactive terminal session for local development and testing. |
| 4 | Benchmark CLI | Performance benchmarking harness for model evaluation across standardized test suites. |
| **Trigger Layer** | | |
| 5 | Trigger Router | Normalizes all inputs (messages, events, schedules, goals) into a uniform `Trigger` shape with source, priority, and payload. User messages are priority 0 (highest). |
| 6 | File Watcher | FSEvents-based watcher that emits `file_changed` events with 500ms debounce. |
| 7 | iMessage Messages | User messages from iMessage, converted to `user_message` triggers. |
| 8 | Cron Scheduler | Time-based job scheduling with local-time evaluation (not UTC). Parses cron expressions and fires triggers when jobs are due. |
| 9 | Goal Stack | Priority queue of goals (user, self, event sources). Generates `goal` triggers for pending work items. |
| 10 | Git Watcher | Monitors `.git/refs/heads` for branch changes with 1000ms debounce. |
| 11 | Event Bus | Central event queue with `emit()`, `drain()`, `peek()`, `on()`, `onAny()`, `pause()`/`resume()`. Cooldown and daily budget controls prevent runaway cycles. |
| **Intelligence Layer** | | |
| 12 | Agent Loop (ReAct) | The sole execution path for all triggers. A ReAct (Reason-Act-Observe) cycle engine with 96 tools, budget controls (500K tokens user/goal, 100K background, 200 turns max), and interruptibility. |
| 13 | Runtime Context Injection | Assembles the system prompt at cycle start: current date/time/timezone, workspace bootstrap files (IDENTITY.md, USER.md, TOOLS.md — not SOUL.md), contacts roster, file guidance, task description, and working guidelines. |
| 14 | Identity Builder | Builds the operational identity prompt from live state: character prompt (neutral voice), world model summary, goal stack, issue log, self-model, crystals, constitution, and handoff note. ~4000 chars. |
| 15 | Context Manager | 4-tier memory hierarchy. Hot (~2K tokens, always present), Warm (~20K, session working memory), Cool (30 days, searchable), Cold (archive, searchable). Auto-populates from significant tool results. |
| 16 | Voice Filter | Post-processing personality rewrite. After the agent loop produces a response, a single LLM call rewrites it in Tyrion's voice before `sendMessage()`. Reasoning stays neutral; personality applied only at the output boundary. Skips text <10 chars or on provider failure (graceful fallback). |
| 17 | Model Selection & Routing | Two-model setup: qwen3.5:122b (reasoning/planning) + qwen3-coder-next (code generation). Hardcoded task-type routing deprecated — the LLM decides via the `delegate` tool at runtime. |
| **Tool System** | | |
| 18 | Tool System | Registry, schemas, orchestrator. Manages 96 tools across 15+ categories. Formats tool schemas for Ollama wire format. |
| 19 | Core Tools | File operations: `read_file`, `write_file`, `list_files`, `search_files`, `read_document`, `bash`. |
| 20 | Coding Tools | Code editing: `edit_file`, `glob_files`, `grep_files`, `validate_files`. |
| 21 | Communication | `send_message` (iMessage to contacts), `message_user` (notify user with urgency levels). |
| 22 | Productivity | `calendar_read` (Apple Calendar), `reminder_create` (Apple Reminders), `http_get` (with IP/scheme safety guards). |
| 23 | State Management | `file_issue`, `close_issue`, `update_goal`, `update_world_model`, `adversarial_test`. |
| 24 | Memory Tools | `recall`, `archive`, `recall_journal`, `consolidate`, `semantic_recall`. |
| 25 | Self-Knowledge (Vision Tier 1) | Crystals: `crystallize`, `dissolve`, `list_crystals`. Constitution: `create_rule`, `update_rule`, `list_rules`. Traces: `replay`, `compare_traces`, `search_traces`. |
| 26 | Self-Improvement (Vision Tier 2+3) | Prompts: `edit_prompt`, `revert_prompt`, `get_prompt`. Shadows: `shadow`, `list_shadows`. Tools: `create_tool`, `manage_tools`. Evolution: `evolve_prompt`, `evolution_status`. LoRA: `extract_training_data`, `list_adapters`, `load_adapter`. |
| 27 | Meta/Pipeline Tools (Phase 1-2) | `meta` (override pipeline behavior), `classify` (optional classification), `plan` (task decomposition), `verify` (outcome verification). All optional — the LLM invokes by judgment. |
| 28 | Introspection (Phase 3) | `peek_queue`, `check_budget`, `list_context`, `review_steps`, `assess_self`. The agent can inspect its own state during execution. |
| 29 | Context Control (Phase 4) | `load_context`, `evict_context`, `set_budget`. LLM-controlled context window management. |
| 30 | Scheduling (Phase 5) | `schedule`, `list_schedules`, `cancel_schedule`. The agent can create its own triggers. |
| 31 | Quality Tools | `run_tests`, `typecheck`, `lint`. The agent validates its own code changes. |
| 32 | Git Tools | `git_status`, `git_diff`, `git_commit`, `git_log`. Version control within the agent loop. |
| 33 | Reasoning Tools | `think` (explicit reasoning scratchpad), `delegate` (route sub-task to specific model), `parallel_reason` (multi-model concurrent inference via `ConcurrentProvider`). |
| 34 | Skills System | Drop-in markdown skill packages loaded from `~/.casterly/skills/` and `./skills/`. YAML frontmatter defines metadata, OS requirements, and optional tool schemas. 5 installed: apple-calendar, imessage-send, system-control, self-update, 3d-printing. |
| 35 | Bash Safety Gates | Three-tier command safety: BLOCKED (rm -rf /, mkfs, fork bomb, dd), APPROVAL_REQUIRED (rm, sudo, chmod, kill, shutdown), SAFE (echo, cat, ls, grep, curl). Tool output sanitization strips injection patterns. |
| **Provider Layer** | | |
| 36 | LlmProvider Interface | Stable contract: `generateWithTools(request, tools, prevResults)`. Supports multi-turn tool calling, streaming, and response normalization. |
| 37 | Ollama Provider | Primary provider. HTTP client to `localhost:11434/api/chat`. Normalizes tool call formats, handles multi-turn threading. 5-minute timeout for local inference. |
| 38 | Concurrent Provider | Parallel inference across registered models. Supports `bestOfN` and `parallel` strategies. Powers the `parallel_reason` agent tool. |
| 39 | Embedding Provider | On-device embeddings for semantic memory search. Does not compete for memory with inference models. |
| 40 | Ollama Server | Local inference server. Hosts qwen3.5:122b (~81GB), qwen3-coder-next, and embedding model concurrently on 128GB unified memory. 40,960 token context window (practical max for 128GB with 81GB model + KV cache). |
| **Security Perimeter** | | |
| 41 | Security Perimeter | Defense-in-depth with 5 layers. All data stays local — no cloud path exists. |
| 42 | Input Guard | Pre-LLM: size limit (10K chars), control char stripping, rate limiting (20/60s), injection detection (11 pattern categories). |
| 43 | Sensitivity Detector | 8 categories: calendar, finances, voice_memos, health, credentials, documents, contacts, location. All flagged content stays local. |
| 44 | Tool Output Sanitizer | Detects and strips injection patterns in tool outputs. Fences web content. Warns on suspicious non-web tool results. |
| 45 | Redactor | Pattern-based replacement of sensitive data (SSN, credit cards, phone numbers, emails, etc.) with `[REDACTED]`. |
| 46 | Safe Logger | All log output passes through redaction. No `console.log` of raw user content allowed (enforced by lint gate). |
| 47 | Protected Paths | Git hooks and guardrails script block changes to security-critical files unless `ALLOW_PROTECTED_CHANGES=1`. |
| **Persistent State & Memory** | | |
| 48 | State Layer | 19 persistent subsystems under `~/.casterly/`. All loaded in parallel at cycle start, saved at cycle end (only if dirty, except journal which always appends). |
| 49 | Journal | Append-only JSONL narrative memory. Entry types: handoff, reflection, opinion, observation, user_interaction. Source of truth for history. |
| 50 | World Model | Codebase health snapshot (typecheck, tests, lint status), statistics, active concerns, recent activity, user model (derived preferences). |
| 51 | Goal Stack | Priority queue with capacity limits (max 20 open). Sources: user, self, event. Tracks status and progress. |
| 52 | Issue Log | Problem tracker with attempt history, severity levels, and resolution tracking. Max 50 open, 200 total. |
| 53 | Crystal Store (Tier 1) | Permanent insights distilled from experience. Max 30 crystals, 500 tokens each. Confidence tracking with lifecycle: formation → validation → weakening → pruning → dissolution. |
| 54 | Constitution Store (Tier 1) | Self-authored operational rules. Max 50 rules, 500 tokens each. Success rate tracking and lifecycle management. |
| 55 | Prompt Store (Tier 2) | Versioned system prompt. Max 20 versions. Protected patterns are immutable. The agent can modify its own instructions. |
| 56 | Shadow Store (Tier 2) | Records alternative approaches not taken. Judgment patterns extracted from recurring assessments. Enables learning without requiring real failures. |
| 57 | Trace Replay (Tier 1) | Execution trace recording for post-mortem analysis. Retention: successful 7d, failed 30d, referenced indefinitely. Max 500 traces. |
| 58 | Execution Log | Bounded JSONL of completed task outcomes. Max 500 records or 30 days. Operational memory for the planner. |
| 59 | Advanced Memory | A-MEM link network (zettelkasten-style), AUDN consolidator (Mem0, similarity-based), SAGE entropy tier migration, Letta git-backed snapshots. |
| 60 | Context Store | 4-tier memory with auto-population. Hot (identity prompt), Warm (working memory), Cool (30-day searchable), Cold (archive). Context window: 40,960 tokens. |
| **Dream Cycles** | | |
| 61 | Dream Cycles | Idle-time self-improvement. Auto-trigger after each agent cycle when configured interval has elapsed (default 24h). All 5 phases available as agent tools. |
| 62 | Consolidate Reflections | Review recent journal entries, extract patterns, update crystals and constitution. |
| 63 | Reorganize Goals | Re-prioritize goal stack based on current state and recent outcomes. |
| 64 | Explore Codebase | Code archaeology — analyze file history, discover patterns, build understanding. |
| 65 | Rebuild Self-Model | Periodic self-reflection. Rebuilds understanding of strengths, weaknesses, and working patterns from journal history. 13 tracked skills with success rates. |
| 66 | Training Extractor | Extracts decision-outcome pairs from journal/issue log grouped by skill domain. Feeds LoRA fine-tuning pipeline. |
| 67 | Prompt Evolution | Genetic algorithm over system prompt variants. Population of 8, fitness measured against benchmark suite. Evolves prompt engineering for the specific model. |
| 68 | LoRA Trainer | Adapter lifecycle management: training → evaluating → active → discarded/archived. Local fine-tuning from extracted training data. |
| 69 | Challenge System | Adversarial self-testing. Generator creates challenges, evaluator tracks sub-skill performance and identifies weaknesses. |
| **iMessage Subsystem** | | |
| 70 | iMessage Subsystem | Full macOS Messages.app integration. Requires Full Disk Access permission. |
| 71 | SQLite Reader | Reads `chat.db` directly. Polls every 2 seconds for new messages. |
| 72 | Input Guard | Rate limiting and validation at the iMessage boundary. |
| 73 | Trigger Router | Converts iMessage text → `triggerFromMessage(text, sender)` → agent loop. |
| 74 | Agent Loop Execution | `autonomousController.runTriggeredCycle(trigger)`. Interrupts background cycles for user messages. |
| 75 | AppleScript Sender | Sends responses via AppleScript → Messages.app. |
| 76 | Voice Filter | Rewrites agent loop response in Tyrion's personality before delivery. |
| 77 | Approval Bridge | Destructive commands require explicit user approval via iMessage. Async request → wait → parse response. |
| **Quality Gates** | | |
| 78 | Quality Gates | 5-gate pipeline run by `npm run check`. All gates must pass. |
| 79 | Guardrails | Protected path detection. Blocks changes to security-critical files unless explicitly allowed. |
| 80 | ESLint | Code style enforcement. Bans `@ts-ignore`, enforces `safeLogger` usage, checks trailing whitespace. |
| 81 | TypeScript | `tsc --noEmit` with strict settings (strict, noUncheckedIndexedAccess, exactOptionalPropertyTypes). |
| 82 | Vitest | 3,300+ unit tests across 154 test files. Covers routing, detection, redaction, provider guards, and all agent tools. |
| 83 | Security Scan | `npm audit` + console.log enforcement (no direct console.log outside 9 allowed files). |
| **Hardware** | | |
| 84 | Hardware Platform | Mac Studio M4 Max with 128GB unified memory and NVMe SSD. All inference local. |
| 85 | qwen3.5:122b | Primary reasoning model. 81GB at Q4_K_M quantization. 40,960 token context window. |
| 86 | qwen3-coder-next | Coding-specialized model for code generation, review, and file operations. |
| 87 | Embedding Model | On-device embeddings for semantic memory search. Separate from inference memory budget. |

---

## Competitive Comparison

### Casterly Rock vs. Local-First Agent Software

PLACEHOLDER_FOR_COMPETITIVE_COMPARISON

---

*Last updated: 2026-02-25. Reflects commits through `641a029`.*
