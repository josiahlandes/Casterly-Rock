# Autonomous Agent

> **Source**: `src/autonomous/`

Tyrion's autonomous agent is a ReAct (Reason-Act-Observe) loop that can work independently — investigating issues, fixing code, filing bug reports, and managing its own priorities — without waiting for human input. It replaces the earlier rigid 4-phase pipeline with a flexible turn-based loop where the LLM decides what to do next.

## Architecture Overview

```
                    ┌─────────────┐
                    │   Trigger    │  scheduled / event / user / goal
                    └──────┬──────┘
                           │
                           ▼
┌──────────────────────────────────────────────────┐
│                   AgentLoop                       │
│                                                   │
│  ┌────────────────────────────────────────────┐   │
│  │  Identity Prompt                           │   │
│  │  (world model + goals + issues + self)     │   │
│  └────────────────────────────────────────────┘   │
│                                                   │
│  ┌──── ReAct Loop (max N turns) ──────────────┐   │
│  │                                            │   │
│  │  1. Check abort signal + token budget      │   │
│  │  2. Send conversation to LLM              │   │
│  │  3. If tool calls → execute, loop          │   │
│  │     If text only → done                    │   │
│  │                                            │   │
│  └────────────────────────────────────────────┘   │
│                                                   │
│  ┌────────────────────────────────────────────┐   │
│  │  Outcome                                   │   │
│  │  (summary, turns, files, issues, goals)    │   │
│  └────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────┘
           │                    │
           ▼                    ▼
    State persistence     Journal handoff
    (goals, issues,       (summary for
     world model)          next session)
```

## Trigger Types

Every agent cycle starts from one of four trigger types:

| Trigger | Source | Priority | Prompt Behavior |
|---------|--------|----------|-----------------|
| `scheduled` | Cron / timer | Lowest | Review goal stack + issue log; work on highest-priority item |
| `event` | System event | Medium | Investigate the event (e.g. test failure, build error) |
| `user` | iMessage / CLI | Highest | User message becomes the prompt; user tasks override autonomous work |
| `goal` | Goal stack | Varies | Work on a specific goal; include notes from prior attempts |

## The ReAct Loop

Each turn in the loop:

1. **Check guards**: Abort signal (external interrupt) and token budget
2. **Call LLM**: Send system prompt (identity + state + tools) + conversation history
3. **Evaluate response**:
   - **Tool calls present** → execute each tool, append results, loop back to step 1
   - **Text only, no tools** → agent is done; text becomes the cycle summary
4. **Track state changes**: Record modified files, filed issues, updated goals

### Stop Reasons

| Reason | Meaning |
|--------|---------|
| `completed` | Agent finished and returned a text summary |
| `max_turns` | Hit the turn limit (default 100) |
| `max_tokens` | Estimated token budget exceeded (default 50,000) |
| `aborted` | External interrupt (e.g. user message arrived during autonomous work) |
| `error` | Unrecoverable error during a turn |

### Budget Controls

| Control | Default | Behavior |
|---------|---------|----------|
| `maxTurns` | 100 | Hard limit on reasoning loops per cycle |
| `maxTokensPerCycle` | 50,000 | Soft limit on total tokens (input + output). Estimated at ~3.5 chars/token |
| `maxResponseTokens` | 4,096 | Maximum tokens per individual LLM response |
| `temperature` | 0.2 | Low temperature for deterministic reasoning |

### Interruptibility

The loop checks an `aborted` flag before each turn. External code (e.g. the message handler) can call `agentLoop.abort()` to preempt autonomous work when a user message arrives. The current turn completes, but no new turn starts.

## Agent Toolkit (81 tools)

The agent has its own expanded tool set beyond the 13 core native tools. These are organized into categories:

### Reasoning (1)

| Tool | Description |
|------|-------------|
| `think` | No-op tool for explicit step-by-step reasoning. Logged but has no side effects. Used to plan before acting. |

### File Operations (3)

| Tool | Description |
|------|-------------|
| `read_file` | Read file with line numbers, optional offset/limit |
| `edit_file` | Search/replace (exact unique match required) |
| `create_file` | Create new file, fails if exists |

All file-mutating tools enforce path restrictions:
- **Allowed**: `src/`, `scripts/`, `tests/`, `config/`, `skills/`
- **Forbidden**: `**/*.env*`, `**/credentials*`, `**/secrets*`, `**/.git/**`

### Search (2)

| Tool | Description |
|------|-------------|
| `grep` | Regex search across files with max results |
| `glob` | Pattern-based file discovery |

### Shell (1)

| Tool | Description |
|------|-------------|
| `bash` | General shell execution with destructive command blocking |

Blocked patterns: `rm -rf`, `mkfs`, `dd`, `shutdown`, `reboot`, `sudo rm`, `git push --force`, `git reset --hard`, `git clean -f`, write to `/dev/sd*`.

### Quality (3)

| Tool | Description | Command |
|------|-------------|---------|
| `run_tests` | Run test suite (optionally filtered) | `npx vitest run [pattern]` |
| `typecheck` | TypeScript compiler check | `npx tsc --noEmit` |
| `lint` | Run project linter | `node scripts/lint.mjs` |

### Git (4)

| Tool | Description |
|------|-------------|
| `git_status` | Branch name + short status |
| `git_diff` | Diff (staged or unstaged, optionally path-scoped) |
| `git_commit` | Stage files + commit (respects path restrictions) |
| `git_log` | Recent commit history (oneline format) |

### State Management (3)

| Tool | Description |
|------|-------------|
| `file_issue` | File a new issue in the issue log (or update existing by title) |
| `close_issue` | Resolve an issue (status: `resolved` or `wontfix`) |
| `update_goal` | Update goal status (`pending`/`in_progress`/`blocked`/`done`/`abandoned`) or notes |

### World Model (1)

| Tool | Description |
|------|-------------|
| `update_world_model` | Add or resolve a concern (severity: `informational`/`worth-watching`/`needs-action`) |

### Memory (4)

| Tool | Description |
|------|-------------|
| `recall` | Search cool/cold memory tiers for past observations. Keyword-ranked results. |
| `archive` | Save a note/observation to cool tier for future recall |
| `recall_journal` | Search journal entries (handoff, reflection, opinion, observation) |
| `consolidate` | Summarize recent work to journal, clear warm tier. Deliberate memory management. |

### Delegation (1)

| Tool | Description |
|------|-------------|
| `delegate` | Send a sub-task to a specific model. `hermes3:70b` for reasoning/planning, `qwen3-coder-next:latest` for code generation. Optionally includes file contents as context. |

### Communication (1)

| Tool | Description |
|------|-------------|
| `message_user` | Send a message to the user. Phase 7 placeholder — currently logs but doesn't deliver. Urgency levels: `low`/`medium`/`high`. |

### Adversarial Testing (1)

| Tool | Description |
|------|-------------|
| `adversarial_test` | Generate edge-case test inputs for a function (empty/null, boundary, unicode, injection, type coercion). Uses LLM to produce attack vectors, writes a Vitest test file. |

### Self-Knowledge — Crystals (3)

| Tool | Description |
|------|-------------|
| `crystallize` | Promote a high-value insight to a permanent crystal — always loaded into context. Limited to 30 crystals sharing 500 tokens in the hot tier. |
| `dissolve` | Remove or invalidate a crystal. Logs dissolution to the journal. |
| `list_crystals` | List all active crystals with confidence scores and metadata. |

### Self-Knowledge — Constitution (3)

| Tool | Description |
|------|-------------|
| `create_rule` | Create a new operational rule based on observed experience. Rules are tactical ("do X when Y") with evidence (journal references). |
| `update_rule` | Modify a rule's text, confidence, or tags based on new evidence. |
| `list_rules` | List all constitutional rules with confidence, success rate, and invocation count. Optionally filter by keyword. |

### Self-Knowledge — Trace Replay (3)

| Tool | Description |
|------|-------------|
| `replay` | Load and replay a past execution trace step-by-step. Shows tool calls, parameters, results, and timing. Supports step range and tool filters. |
| `compare_traces` | Compare two execution traces side-by-side. Highlights divergence points and unique strategies. |
| `search_traces` | Search past traces by outcome, trigger type, or tools used. Returns index entries (use `replay` for full details). |

### Self-Improvement — Prompts (3)

| Tool | Description |
|------|-------------|
| `edit_prompt` | Edit the system prompt via search/replace with rationale. Protected patterns (Safety Boundary, Path Guards, Redaction Rules, Security Invariants) cannot be removed. Creates a new versioned entry. |
| `revert_prompt` | Revert the system prompt to a specific version number. Useful when performance degrades after a change. |
| `get_prompt` | Get the current prompt content, version history, or diff between two versions. Supports `content`, `versions`, and `diff` actions. |

### Self-Improvement — Shadows (2)

| Tool | Description |
|------|-------------|
| `shadow` | Record an alternative approach before executing the primary plan. Takes strategy, expected steps, and rationale for why primary was chosen. |
| `list_shadows` | List shadows for a specific cycle, show missed opportunities, or display judgment patterns. Supports `cycle`, `missed`, and `patterns` views. |

### Self-Improvement — Tools (3)

| Tool | Description |
|------|-------------|
| `create_tool` | Synthesize a new custom tool with a bash template. Security-scanned against 13 dangerous patterns. Templates use `{{param}}` substitution. |
| `manage_tools` | Archive, reactivate, or delete custom tools. Supports lifecycle management of synthesized tools. |
| `list_custom_tools` | List all custom tools with usage stats, creation date, and status. Shows active tools and archived count. |

### Advanced Self-Improvement — Challenges (2)

| Tool | Description |
|------|-------------|
| `run_challenges` | Generate and return a batch of adversarial challenges for self-testing. Prioritizes weak skills from the self-model. Supports sub-skill granularity (e.g., `regex.lookaheads`). |
| `challenge_history` | View challenge evaluation history: overall stats, skill trends over recent batches, and weakest/strongest sub-skills. |

### Advanced Self-Improvement — Prompt Evolution (2)

| Tool | Description |
|------|-------------|
| `evolve_prompt` | Manage the prompt genetic algorithm. Actions: `initialize` (create population from current prompt), `record_fitness` (record metrics for a variant), `evolve` (advance to next generation via mutation + crossover). |
| `evolution_status` | View the current state of prompt evolution: generation number, population size, best fitness, and variant summaries. |

### Advanced Self-Improvement — LoRA (3)

| Tool | Description |
|------|-------------|
| `extract_training_data` | Extract training examples from journal and issue log. Produces instruction/completion pairs and DPO preference pairs grouped by skill domain. |
| `list_adapters` | List all LoRA adapters with status, improvement scores, and load counts. Optionally filter by status (active, training, archived, discarded). |
| `load_adapter` | Load a specific LoRA adapter for the current task. Records the load event and returns adapter metadata. |

### Pipeline Control — Roadmap Phase 1 (1)

| Tool | Description |
|------|-------------|
| `meta` | Override default pipeline behavior (skip classification, skip planning, force verification, or change strategy). Overrides are journaled for self-improvement analysis. |

### Promoted Pipeline — Roadmap Phase 2 (3)

| Tool | Description |
|------|-------------|
| `classify` | Optionally classify a message or task description. Returns task class, confidence, and task type. Skip for tasks you understand clearly. |
| `plan` | Optionally generate a structured execution plan for complex tasks. Returns ordered steps with dependencies and verification criteria. |
| `verify` | Optionally verify task completion against criteria. Returns pass/partial/fail verdict with evidence matching. |

### Introspection — Roadmap Phase 3 (5)

| Tool | Description |
|------|-------------|
| `peek_queue` | See the event queue: pending triggers, their types, and priorities. |
| `check_budget` | Check resource consumption: turns used, tokens consumed, time elapsed, remaining budget. |
| `list_context` | See what's loaded in each memory tier with token counts and entry keys. |
| `review_steps` | Review tool call history for the current cycle: tools called, success/failure, duration. |
| `assess_self` | Query the self-model for strengths and weaknesses relevant to the current task. |

### Context Control — Roadmap Phase 4 (3)

| Tool | Description |
|------|-------------|
| `load_context` | Search cool/cold memory and load matching entries into the warm tier for immediate access. |
| `evict_context` | Remove specific content from the warm tier to free working memory. |
| `set_budget` | Adjust warm tier token budget for the current cycle. |

### Self-Initiated Triggers — Roadmap Phase 5 (3)

| Tool | Description |
|------|-------------|
| `schedule` | Create a self-initiated trigger: schedule a future task, set a reminder, or create a recurring check. |
| `list_schedules` | List all active scheduled jobs. |
| `cancel_schedule` | Cancel an active scheduled job by ID. |

### Semantic Memory (1)

| Tool | Description |
|------|-------------|
| `semantic_recall` | Search memory using semantic similarity (embedding-based) combined with keyword matching. Falls back to keyword-only if embeddings are unavailable. |

### Parallel Reasoning (1)

| Tool | Description |
|------|-------------|
| `parallel_reason` | Send a problem to multiple models in parallel. Returns both responses or has a judge model pick the best. |

### Dream Cycle Phases (5)

| Tool | Description |
|------|-------------|
| `consolidate_reflections` | Groups past outcomes by success/failure, archives insights. Wraps dream cycle phase 1. |
| `reorganize_goals` | Reprioritizes the goal stack based on recent activity. Wraps dream cycle phase 3. |
| `explore_codebase` | Code archaeology pass to find fragile or abandoned files. Wraps dream cycle phase 4. |
| `rebuild_self_model` | Recalculates strengths and weaknesses from the issue log. Wraps dream cycle phase 5. |
| `write_retrospective` | Weekly summary written to the journal. Wraps dream cycle phase 6. |
| `link_memories` | Create a typed bidirectional link between two memory entries. Strengthens existing links on re-link. |
| `get_links` | Retrieve all links for a memory entry, sorted by strength. Optional type filter. |
| `traverse_links` | BFS traversal of the link network from a starting entry, within N hops. |
| `audn_enqueue` | Queue a memory candidate for AUDN (Add/Update/Delete/Nothing) evaluation during dream cycle. |
| `audn_status` | Check the AUDN queue — pending candidate count and source breakdown. |
| `entropy_score` | Calculate Shannon entropy (information density) of text content. Returns raw bits and normalized 0-1 score. |
| `evaluate_tiers` | Batch evaluate memory entries for tier migration using entropy, access frequency, and recency. |
| `snapshot_memory` | Create a point-in-time snapshot of all monitored memory files (crystals, constitution, goals, issues). |
| `list_snapshots` | List all memory snapshots, newest first. Shows ID, timestamp, trigger, and message. |
| `diff_snapshots` | Compare two memory snapshots to see what changed per subsystem. |

## Agent State

The agent operates on three persistent state stores, all loaded at cycle start and saved at cycle end:

### World Model

> **Source**: `src/autonomous/world-model.ts`, stored at `~/.casterly/world-model.yaml`

What Tyrion knows about the codebase:

| Section | Content | Update Frequency |
|---------|---------|------------------|
| `health` | Typecheck, test, lint results (pass/fail, error counts, failing tests) | Expensive — batched |
| `activity` | Recent commits, file changes, sources | Cheap — from git log |
| `concerns` | Lightweight observations not yet promoted to issues (severity, related files) | Agent loop |
| `codebaseStats` | File counts, module structure, dependencies | Periodic |

Privacy: Only codebase metadata. No user-provided sensitive data.

### Goal Stack

> **Source**: `src/autonomous/goal-stack.ts`, stored at `~/.casterly/goals.yaml`

Priority queue of what Tyrion is working on:

| Property | Description |
|----------|-------------|
| `id` | Auto-generated (`goal-001`, `goal-002`, ...) |
| `source` | `user` (priority 1), `event` (priority 2), `self` (priority 3+) |
| `priority` | Numeric, 1 = highest |
| `status` | `pending` → `in_progress` → `done` / `blocked` / `abandoned` |
| `attempts` | How many cycles have worked on this goal |
| `notes` | Progress notes, blockers, approach ideas |
| `relatedFiles` | Codebase references |

Stale goals (no progress beyond a threshold) get flagged for the agent to reprioritize or prune.

### Issue Log

> **Source**: `src/autonomous/issue-log.ts`, stored at `~/.casterly/issues.yaml`

Tracked problems the agent has discovered:

| Property | Description |
|----------|-------------|
| `id` | Auto-generated (`ISS-001`, `ISS-002`, ...) |
| `title` | Short description |
| `priority` | `critical` / `high` / `medium` / `low` |
| `status` | `open` → `resolved` / `wontfix` |
| `relatedFiles` | Affected files |
| `nextIdea` | What to try next |
| `discoveredBy` | `autonomous` or `user` |

## Self-Knowledge (Vision Tier 1)

Three stores provide Tyrion with the ability to learn from experience, author his own rules, and debug past failures.

## Self-Improvement (Vision Tier 2)

Three mechanisms provide Tyrion with the ability to modify his own behavior, calibrate his judgment, and extend his capabilities.

### Prompt Store

> **Source**: `src/autonomous/prompt-store.ts`, stored at `~/.casterly/system-prompt.md` + `~/.casterly/prompt-versions.json`

Versioned, editable system prompt. The LLM can modify its own workflow guidance, default strategies, tool preferences, and self-correction triggers. Protected patterns (Safety Boundary, Path Guards, Redaction Rules, Security Invariants) are immutable.

Budget: max 20 versions. Metrics tracked per version (success rate, average turns, errors).

### Shadow Store

> **Source**: `src/autonomous/shadow-store.ts`, stored at `~/.casterly/shadow-analysis.json`

Alternative approach recording before executing the primary plan. Shadows are assessed during dream cycles to calibrate judgment. Judgment patterns are extracted from recurring assessments.

Budget: max 200 shadows, 90-day retention. Patterns require 5+ observations to be considered established.

### Tool Synthesizer

> **Source**: `src/tools/synthesizer.ts`, stored at `~/.casterly/tools/`

LLM-authored custom tools with bash template implementations. Security-scanned against 13 dangerous patterns. Tools unused for 30 days auto-archived during dream cycles.

Budget: max 20 active tools. Templates max 2000 chars.

### Crystal Store

> **Source**: `src/autonomous/crystal-store.ts`, stored at `~/.casterly/crystals.yaml`

Permanent, always-available insights promoted from memory tiers. Crystals represent stable facts the LLM doesn't have to re-derive each cycle.

| Property | Description |
|----------|-------------|
| `id` | Auto-generated (`crys-<timestamp>-<random>`) |
| `content` | The insight — concise and actionable |
| `sourceEntries` | IDs of memory/journal entries that motivated this crystal |
| `formedDate` | When first crystallized |
| `lastValidated` | When last confirmed against recent experience |
| `recallCount` | Times referenced |
| `confidence` | 0-1 score. Strengthens on validation, decays when contradicted. |

Budget: max 30 crystals, 500 tokens in the hot tier. Pruned during dream cycles when confidence drops below 0.3.

### Constitution Store

> **Source**: `src/autonomous/constitution-store.ts`, stored at `~/.casterly/constitution.yaml`

Self-authored operational rules discovered through experience. Distinct from safety rules (those are immutable).

| Property | Description |
|----------|-------------|
| `id` | Auto-generated (`rule-<timestamp>-<random>`) |
| `rule` | The directive — concise and actionable |
| `added` | When created |
| `motivation` | Journal reference explaining why this rule exists |
| `confidence` | 0-1 score. Strengthens with success, decays on violation+success. |
| `invocations` | Times the rule was relevant |
| `successes` | Times following the rule led to success |
| `tags` | Categorization tags |

Budget: max 50 rules, 500 tokens in the hot tier. Pruned during dream cycles when confidence drops below 0.3.

### Trace Replay

> **Source**: `src/autonomous/trace-replay.ts`, stored at `~/.casterly/traces/`

Execution trace recording for post-mortem analysis. Each cycle's tool calls, parameters, results, and timing are stored as structured traces.

Retention policy: successful traces kept 7 days, failed traces kept 30 days, traces referenced by crystals or rules kept indefinitely. Max 500 traces.

## Identity System

> **Source**: `src/autonomous/identity.ts`

The identity prompt is built fresh each cycle from live state. It defines who Tyrion is and provides situational awareness:

```
Identity prompt = Self model (who I am)
                + World model summary (codebase state)
                + Goal stack (what I'm working on)
                + Issue log (known problems)
                + Crystallized knowledge (permanent insights)
                + Operational rules (self-authored constitution)
                + Handoff note (what happened last session)
```

The self model (`SelfModelSummary`) captures:
- Name, description, personality traits
- Behavioral rules and values
- Current mode (autonomous, interactive, coding)

## Context Manager (Tiered Memory)

> **Source**: `src/autonomous/context-manager.ts`

Memory is organized into temperature tiers:

| Tier | Contents | Lifetime | Budget |
|------|----------|----------|--------|
| **Hot** | Identity prompt, world model, goals, issues | Always present | Core context |
| **Warm** | Recent tool results (read_file, search, test results) | Current cycle | Auto-populated from significant tool outputs, cleared on consolidate |
| **Cool** | Archived notes, observations | 30 days | Searchable via `recall` |
| **Cold** | Everything older than 30 days | Permanent | Searchable via `recall` |

The warm tier is automatically populated when the agent calls tools like `read_file`, `search_code`, `run_tests`, or `recall`. Large outputs are truncated to 4,000 chars. The `consolidate` tool writes a summary to the journal and clears the warm tier.

## Journal

> **Source**: `src/autonomous/journal.ts`

Tyrion's narrative memory. Stores entries of several types:

| Type | When Written | Purpose |
|------|-------------|---------|
| `handoff` | End of every cycle | Summary for the next session to pick up where this one left off |
| `reflection` | On `consolidate` | Synthesized understanding from recent work |
| `opinion` | Agent-initiated | Formed preferences about patterns, tools, approaches |
| `observation` | Agent-initiated | Facts noticed about the codebase |
| `user_interaction` | After user messages | Record of user requests and outcomes |

The most recent handoff note is included in the identity prompt for session continuity.

## Controller

> **Source**: `src/autonomous/controller.ts`

The controller manages the full lifecycle of an autonomous session:

1. Load state (world model, goals, issues) from disk
2. Build the agent toolkit with all 81 tools
3. Construct the agent loop with config + provider + state
4. Run the loop for a given trigger
5. Persist updated state back to disk
6. Return the outcome

It also handles:
- Creating goals from user requests
- Selecting the next goal to work on (highest priority, `pending` or `in_progress`)
- Recording goal attempts and progress notes

## Debug Tracer

> **Source**: `src/autonomous/debug.ts`

Every operation in the agent loop is traced through a structured debug system:

- **Spans**: Nested timing spans (`agent-loop > llm-call:turn-3 > tool:edit_file`)
- **Logs**: Leveled logging (`info`, `warn`, `error`, `debug`) with automatic redaction
- **I/O logging**: File read/write/create/edit operations with byte/line counts

All logged text passes through `redactSensitiveText()` before output.

## Reasoning Module

> **Source**: `src/autonomous/reasoning/`

### Adversarial Tester

> **Source**: `src/autonomous/reasoning/adversarial.ts`

Generates attack vectors for functions the agent has written or modified:

| Category | Examples |
|----------|---------|
| Empty/null | `""`, `null`, `undefined` |
| Boundary | Max int, empty arrays, single-char strings |
| Unicode | Emoji, RTL chars, zero-width joiners, combining marks |
| Injection | SQL injection, XSS, command injection, template literals |
| Type coercion | Wrong types, prototype pollution |
| Malformed | Truncated input, doubled delimiters, mixed encodings |
| Concurrency | Duplicate calls, interleaved operations |

Uses LLM delegation to generate test cases, then writes a Vitest test file.

## Execution Flow Example

A scheduled autonomous cycle:

```
1. Controller loads state from disk
2. Controller selects highest-priority pending goal
3. AgentLoop.run({ type: 'goal', goal }) starts

Turn 1: LLM uses `think` to plan approach
Turn 2: LLM uses `read_file` to examine relevant code
Turn 3: LLM uses `grep` to find related patterns
Turn 4: LLM uses `edit_file` to make a fix
Turn 5: LLM uses `run_tests` to verify
Turn 6: LLM uses `typecheck` to check types
Turn 7: LLM uses `git_commit` to commit the change
Turn 8: LLM uses `update_goal` to mark goal done
Turn 9: LLM returns text summary (no tools) → cycle complete

4. Controller persists updated state
5. Journal gets a handoff note
6. AgentOutcome returned with full turn history
```

## Default Configuration

```typescript
{
  maxTurns: 100,
  maxTokensPerCycle: 50_000,
  reasoningModel: 'hermes3:70b',
  codingModel: 'qwen3-coder-next:latest',
  thinkToolEnabled: true,
  delegationEnabled: true,
  userMessagingEnabled: false,
  temperature: 0.2,
  maxResponseTokens: 4096,
}
```

## Key Files

| File | Purpose |
|------|---------|
| `src/autonomous/agent-loop.ts` | ReAct loop: trigger → turns → outcome |
| `src/autonomous/agent-tools.ts` | 81 agent tools: schemas + executors |
| `src/autonomous/controller.ts` | Lifecycle management: load → run → persist |
| `src/autonomous/world-model.ts` | Codebase health, activity, concerns |
| `src/autonomous/goal-stack.ts` | Priority queue of goals |
| `src/autonomous/issue-log.ts` | Tracked problems |
| `src/autonomous/identity.ts` | Identity prompt builder + self model |
| `src/autonomous/context-manager.ts` | Tiered memory (hot/warm/cool/cold) |
| `src/autonomous/journal.ts` | Narrative memory (handoff, reflection, etc.) |
| `src/autonomous/debug.ts` | Structured tracing + redacted logging |
| `src/autonomous/reasoning/adversarial.ts` | Adversarial test case generation |
| `src/autonomous/loop.ts` | Legacy loop (superseded by agent-loop.ts) |
| `src/autonomous/crystal-store.ts` | Crystal store — permanent insights (Vision Tier 1) |
| `src/autonomous/constitution-store.ts` | Constitution — self-authored rules (Vision Tier 1) |
| `src/autonomous/trace-replay.ts` | Trace replay — self-debugging (Vision Tier 1) |
| `src/autonomous/prompt-store.ts` | Self-modifying prompts (Vision Tier 2) |
| `src/autonomous/shadow-store.ts` | Shadow execution and judgment patterns (Vision Tier 2) |
| `src/tools/synthesizer.ts` | Tool synthesis (Vision Tier 2) |
| `src/autonomous/dream/challenge-generator.ts` | Adversarial challenge generation (Vision Tier 3) |
| `src/autonomous/dream/challenge-evaluator.ts` | Challenge evaluation and sub-skill tracking (Vision Tier 3) |
| `src/autonomous/dream/prompt-evolution.ts` | Prompt genetic algorithm (Vision Tier 3) |
| `src/autonomous/dream/training-extractor.ts` | LoRA training data extraction (Vision Tier 3) |
| `src/autonomous/dream/lora-trainer.ts` | LoRA adapter lifecycle management (Vision Tier 3) |
| `src/providers/embedding.ts` | On-device embedding provider via Ollama (Semantic Memory) |
| `src/utils/semaphore.ts` | Promise-based concurrency limiter (Parallelism) |
| `src/autonomous/types.ts` | Shared type definitions |
| `src/autonomous/index.ts` | Public exports |

---

## Vision Reconciliation Notes — IMPLEMENTED

This module is closest to the vision's target architecture. The ReAct loop, agent toolkit, and state management are all well-designed. All reconciliation items below have been implemented.

### 1. Remove the "autonomous" framing — IMPLEMENTED

**Current:** The module is called "Autonomous Agent" and described as working "independently — without waiting for human input." The controller has `start()` and `stop()` methods. The self-model includes "current mode (autonomous, interactive, coding)" as a concept.

**Why change:** The vision says "there is no modal boundary between 'interactive' and 'autonomous.'" Responding to a user and fixing a self-discovered bug are the same thing — a trigger arrives, the LLM decides what to do. The word "autonomous" implies a special mode.

**What to do:** Reframe this module as "the agent loop" — the single execution path for all triggers. Remove the `start()` / `stop()` methods from the controller. Remove the mode concept from the self-model (there is only one mode: running). The iMessage `handleAutonomousCommand()` intercept in `daemon.ts` (lines 98-109) that catches "start autonomous" / "stop autonomous" should be removed — those become normal messages the LLM responds to.

### 2. Remove the `dream_cycles.enabled` toggle — IMPLEMENTED

**Current:** `config/autonomous.yaml` has `dream_cycles.enabled: false` (line 253). The dream cycle runner only runs when enabled.

**Why change:** The vision says dream cycles are "low-priority goals that the LLM pursues when no higher-priority triggers are pending." They are not a feature to toggle on/off.

**What to do:** Remove the toggle. Convert the six dream phases into agent tools: `consolidate_reflections`, `update_world_model`, `reorganize_goals`, `explore_codebase`, `update_self_model`, `write_retrospective`. The system prompt should suggest running them during quiet hours as low-priority work. The LLM decides which phases to run, in what order, and when.

> **Status:** Toggle removed. 5 dream cycle phases converted to agent tools (`consolidate_reflections`, `reorganize_goals`, `explore_codebase`, `rebuild_self_model`, `write_retrospective`). `runCycle` marked `@deprecated`. Total tools: 81.

### 3. Convert the hardcoded dream sequence into tools — IMPLEMENTED

**Current:** `src/autonomous/dream/runner.ts` (lines 165-249) runs six phases in a fixed order: consolidate → world model → goals → explore → self-model → retrospective. Every dream cycle runs all six.

**Why change:** The vision says the LLM should invoke these "in any order, skip, or extend based on its judgment." If the codebase hasn't changed, archaeology is pointless. If the model has been struggling with a skill, self-model rebuilding should happen sooner.

**What to do:** Create six agent tools (one per phase). Each wraps the existing phase logic from `DreamCycleRunner`. The `DreamCycleRunner.run()` method becomes a suggested sequence in the system prompt, not code. The LLM might run only 2 phases in a short cycle, or all 6 during a long quiet-hours session.

> **Status:** 5 dream cycle phases converted to agent tools. Legacy `runCycle` marked `@deprecated`. Controller uses `runAgentCycle` instead of `runCycle`.

### 4. The controller should not manage lifecycle — IMPLEMENTED

**Current:** `src/autonomous/controller.ts` manages load → run → persist as a lifecycle wrapper around the agent loop.

**Why change:** In the thin runtime architecture, state loading and persistence happen at the system level, not as a managed lifecycle. The agent loop loads state at cycle start and saves at cycle end — the controller's orchestration is redundant when the loop is always running.

**What to do:** Merge the controller's state management into the loop itself (much of this is already done in `AutonomousLoop`). The controller's goal-selection logic ("select highest priority pending goal") should become part of the agent loop's scheduled trigger handling, or an agent tool the LLM calls to decide what to work on next.

> **Status:** Controller now uses `runAgentCycle` instead of `runCycle`.

### 5. The legacy loop reference should be removed — IMPLEMENTED

**Current:** `src/autonomous/loop.ts` is listed as "Legacy loop (superseded by agent-loop.ts)" in the key files table.

**Why change:** The vision has no concept of a legacy loop. The agent loop is the only path.

**What to do:** Once the agent loop is the sole execution path, `loop.ts` should be refactored to be the orchestration layer (event handling, state persistence, watcher management) rather than carrying the "legacy" label. Its `runAgentCycle()` method already delegates to `createAgentLoop()` — the legacy 4-phase path inside it should be deleted.

> **Status:** Legacy 4-phase fallback deprecated (`runCycle` marked `@deprecated`). `runAgentCycle` is the sole execution path.
