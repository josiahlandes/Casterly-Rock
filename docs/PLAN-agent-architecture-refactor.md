# Agent Architecture Refactor — From Pipeline to Steward

## Status: ACTIVE

This plan supersedes:
- `plan-tyrion-evolution.md` (deleted)
- `PLAN-hallucination-prevention.md` (deleted — completed)
- `PLAN-architecture-rework.md` (deleted — completed)
- `PLAN-implementation-roadmap.md` (deleted — completed)
- `PLAN-interface-layer.md` (deleted — completed)
- `handoff-phase2.md` (deleted — completed)
- `autonomous-improvement.md` (deleted — superseded)

---

## Problem Statement

Tyrion has two separate execution paths that don't share state or logic:

1. **Interactive** — iMessage daemon receives a message, calls `processChatMessage()`, runs a flat tool loop via `provider.generateWithTools()`, responds.
2. **Autonomous** — `AutonomousLoop` runs either the legacy pipeline (`analyze → hypothesize → implement → validate`) or the newer `AgentLoop.run()` ReAct cycle.

The agent loop (Phase 2) was built as a parallel path inside `AutonomousLoop`, gated behind `useAgentLoop: true`. It was never wired into the interactive path. The result:

- Interactive messages don't benefit from the agent's identity, world model, goal stack, or tools.
- Autonomous cycles don't benefit from the rich context of user conversations.
- Two separate provider interfaces (`AutonomousProvider` vs `LlmProvider`) do the same thing differently.
- State management is duplicated — the daemon has its own session/context, the agent loop has its own state loading.

Additionally, the current state model (goal stack + world model + issue log) is all structured data. It's queryable and clean, but it loses the reasoning context that makes Tyrion effective. A goal like "refactor auth module" throws away the *why* — the moment Tyrion noticed the code was fragile, the half-formed idea about how to fix it, the nuance of what matters.

---

## Design Philosophy

### Journal, not goal stack, as the primary state

The goal stack remains as a derived index, but the **journal** is the source of truth. At the end of every cycle (interactive or autonomous), Tyrion writes a natural-language entry: what he was working on, what he noticed, what he thinks, what he'd tell his future self. This is loaded first in the next cycle. It's continuity through narrative, not through data structures.

### One loop, not two

Every interaction — user message, scheduled cycle, file change event — enters through `AgentLoop.run()` with the appropriate trigger type. The daemon becomes a thin event source. The agent loop handles context assembly, tool execution, state management, and response generation.

### Metacognition, not configuration

Model routing moves from `config/models.yaml` to Tyrion's runtime judgment via the `delegate` tool. Tyrion decides: "This is a focused TypeScript task. I'll hand it to the coding model." The delegation is a tool call. The review is Tyrion reasoning about the output.

### Opinions emerge from experience

The identity prompt sets character traits. Opinions — "I don't like how the provider interface is structured", "test coverage is thin here" — emerge from the journal over time. The self-model feeds back not as telemetry (`successRate: 0.7`) but as self-knowledge: "I tend to over-complicate refactors."

### The world model includes the user

Not just codebase health. After interactions, Tyrion builds understanding: what this person cares about, how they communicate, what level of detail they want. This emerges from journal entries about interactions.

---

## Architecture Overview

```
                    ┌──────────────────────────────────────────┐
                    │              Event Sources                │
                    │                                          │
                    │  iMessage    CLI    File     Git    Cron  │
                    │  Daemon      REPL   Watcher  Hook  Timer │
                    └────────┬─────┬──────┬───────┬─────┬──────┘
                             │     │      │       │     │
                             ▼     ▼      ▼       ▼     ▼
                    ┌──────────────────────────────────────────┐
                    │          Trigger Router                   │
                    │                                          │
                    │  Normalize all inputs into AgentTrigger   │
                    │  { type: user | event | scheduled | goal }│
                    └──────────────────┬───────────────────────┘
                                       │
                                       ▼
                    ┌──────────────────────────────────────────┐
                    │            Agent Loop (unified)           │
                    │                                          │
                    │  1. Load state (journal, world, goals)   │
                    │  2. Build identity prompt                │
                    │  3. Reason → Act → Observe loop          │
                    │  4. Write journal entry (handoff note)   │
                    │  5. Save state                           │
                    └──────────────────┬───────────────────────┘
                                       │
                           ┌───────────┼───────────┐
                           ▼           ▼           ▼
                    ┌────────────┐ ┌────────┐ ┌──────────┐
                    │   Tools    │ │Delegate│ │  State   │
                    │            │ │        │ │ Mutation │
                    │ read_file  │ │ Send   │ │          │
                    │ edit_file  │ │ sub-   │ │ journal  │
                    │ bash       │ │ task   │ │ goals    │
                    │ grep/glob  │ │ to     │ │ issues   │
                    │ run_tests  │ │ coding │ │ world    │
                    │ think      │ │ model  │ │ model    │
                    │ recall     │ │        │ │          │
                    │ ...        │ │        │ │          │
                    └────────────┘ └────────┘ └──────────┘
```

---

## Implementation Phases

### Phase 0: Debugging Infrastructure

**Why first:** Every subsequent phase needs observable behavior. We build the instruments before we build the thing.

**Changes:**

1. **State inspector CLI** (`src/debug/inspector.ts`)
   - `casterly inspect state` — dump current world model, goal stack, journal tail, issue log
   - `casterly inspect journal [--last N]` — read recent journal entries
   - `casterly inspect cycle [cycle-id]` — replay a cycle's decision trace
   - Uses the existing `debug.ts` tracer infrastructure

2. **Decision trace logging** (extend `src/autonomous/debug.ts`)
   - Every agent loop turn logs: trigger, context budget, tool calls considered, tool calls made, reasoning
   - Structured JSON output alongside the existing hierarchical span tree
   - New trace categories: `journal`, `delegation`, `context-budget`, `state-diff`

3. **State diff on save** (extend `src/autonomous/debug.ts`)
   - After each `saveState()`, log what changed: new journal entry, goal status changes, world model delta, new issues
   - Makes it possible to understand what a cycle *did* without reading every tool call

4. **Provider call logging** (extend `src/autonomous/debug.ts`)
   - Log every `generateWithTools()` call with: model, token count, tool schemas sent, response type (text vs tool_use), latency
   - Critical for debugging model routing and delegation

**Files:**
- Create: `src/debug/inspector.ts` (~200 lines)
- Modify: `src/autonomous/debug.ts` (add trace categories, state diff)
- Modify: `src/providers/ollama.ts` (add call-level tracing)
- Modify: `package.json` (add `inspect` script)

**Tests:**
- State inspector outputs correct format for each subcommand
- State diff correctly identifies changes between two snapshots
- Provider call logging captures expected fields

**Quality gate:** `npm run check`

---

### Phase 1: Journal System

**Why:** The journal is the foundation for continuity, opinions, and self-knowledge. Everything else builds on it.

**Changes:**

1. **Journal module** (`src/autonomous/journal.ts`)

   ```typescript
   interface JournalEntry {
     id: string;
     timestamp: string;
     type: 'handoff' | 'reflection' | 'opinion' | 'observation' | 'user_interaction';
     content: string;          // Natural language — the thinking
     tags: string[];           // For recall: ['provider-interface', 'refactor', 'stuck']
     cycleId?: string;         // Which cycle produced this
     triggerType?: string;     // What started the cycle
   }

   class Journal {
     async load(): Promise<void>
     async save(): Promise<void>
     async append(entry: Omit<JournalEntry, 'id' | 'timestamp'>): Promise<JournalEntry>
     getRecent(n: number): JournalEntry[]
     getByType(type: JournalEntry['type']): JournalEntry[]
     search(query: string): JournalEntry[]        // Keyword search
     getHandoffNote(): JournalEntry | null         // Most recent handoff
     summarize(entries: JournalEntry[]): string    // Compress for context
   }
   ```

   Storage: `~/.casterly/journal.jsonl` — append-only, one JSON object per line.

2. **Handoff note generation** — integrated into agent loop completion

   At the end of every `AgentLoop.run()`, before returning the outcome, the agent writes a handoff note using the `think` tool pattern. The note is a journal entry of type `handoff` that captures:
   - What was being worked on
   - What's unfinished
   - What Tyrion would tell his future self
   - What the user seems to care about (for user-triggered cycles)

3. **Handoff note loading** — integrated into agent loop startup

   At the start of every `AgentLoop.run()`, the most recent handoff note is loaded into the system prompt as the first section after identity. This gives Tyrion "waking up and remembering" rather than "waking up and being briefed."

4. **Journal recall tool** — extend `agent-tools.ts`

   ```typescript
   {
     name: 'recall_journal',
     parameters: {
       query: string,       // keyword search
       type?: string,       // filter by entry type
       limit?: number       // max results (default 5)
     }
   }
   ```

   This replaces the `recall` tool's dependency on structured reflection data with natural language search over the journal.

5. **Goal derivation from journal**

   Goals are still stored in the goal stack, but new goals can be derived from journal entries. When Tyrion writes an observation like "the provider interface is fragile", the `file_issue` or `update_goal` tools remain available — but the journal is the *reason* the goal exists, and loading the journal entry alongside the goal gives richer context than the goal description alone.

**Files:**
- Create: `src/autonomous/journal.ts` (~300 lines)
- Modify: `src/autonomous/agent-loop.ts` (load handoff note at start, write at end)
- Modify: `src/autonomous/agent-tools.ts` (add `recall_journal` tool)
- Modify: `src/autonomous/identity.ts` (include handoff note in identity prompt)

**Tests:**
- Journal CRUD: append, load, search, filter by type
- Handoff note is written at cycle end
- Handoff note is loaded at cycle start and appears in context
- `recall_journal` tool returns relevant entries for known queries
- Journal handles concurrent writes (append-only JSONL is safe)
- Journal file grows correctly, entries are valid JSON per line

**Debugging:**
- Journal writes are traced with `journal` category in debug
- Each journal entry includes the cycleId that produced it
- `casterly inspect journal` shows recent entries with formatting

**Quality gate:** `npm run check`

---

### Phase 2: Unify the Loop

**Why:** This is the central structural change. One loop for everything.

**Changes:**

1. **Trigger router** (`src/autonomous/trigger-router.ts`)

   Normalizes all input sources into `AgentTrigger`:

   ```typescript
   // From iMessage daemon
   function triggerFromMessage(message: string, sender: string): AgentTrigger {
     return { type: 'user', message, sender };
   }

   // From event bus (file watcher, git hook, etc.)
   function triggerFromEvent(event: SystemEvent): AgentTrigger { ... }

   // From scheduler
   function triggerFromSchedule(job: ScheduledJob): AgentTrigger { ... }

   // From goal stack (autonomous)
   function triggerFromGoal(goal: Goal): AgentTrigger { ... }
   ```

2. **Daemon refactor** (`src/imessage/daemon.ts`)

   Replace `processChatMessage()` with a call to the unified agent loop:

   ```typescript
   // Before: daemon builds its own context, calls provider directly
   const response = await provider.generateWithTools(request, tools, previousResults);

   // After: daemon triggers the agent loop
   const state = await loadTyrionState();
   const toolkit = buildAgentToolkit(config, state);
   const loop = createAgentLoop(config, provider, toolkit, state);
   const outcome = await loop.run(triggerFromMessage(message, sender));
   const response = outcome.finalResponse;
   ```

   The daemon becomes:
   - A message source (iMessage polling)
   - A trigger emitter (calls the agent loop)
   - A response sender (sends the agent's output back via iMessage)

   It no longer owns context assembly, tool orchestration, or session management.

3. **Session bridge** — agent loop writes to existing session storage

   The agent loop's conversation history needs to persist to `~/.casterly/sessions/` for continuity across messages within the same session. The existing `SessionManager` is reused, but called from inside the agent loop rather than from the daemon.

4. **Deprecate legacy pipeline**

   - `AutonomousLoop.runCycle()` (the old analyze → hypothesize → implement → validate path) is removed
   - `AutonomousLoop.runAgentCycle()` becomes the only cycle method
   - The `useAgentLoop` flag is removed — the agent loop is always used
   - The `AutonomousProvider` interface is deprecated; all code uses `LlmProvider`
   - The provider cast (`this.provider as unknown as LlmProvider`) is cleaned up by removing the intermediate type

5. **Interactive priority**

   When a user message arrives while an autonomous cycle is running:
   - The autonomous cycle is aborted (existing `abortAgentCycle()`)
   - The user message triggers a new cycle immediately
   - The autonomous cycle's partial state is preserved (existing behavior)

**Files:**
- Create: `src/autonomous/trigger-router.ts` (~100 lines)
- Modify: `src/imessage/daemon.ts` (replace processChatMessage with agent loop)
- Modify: `src/autonomous/loop.ts` (remove legacy pipeline, remove useAgentLoop flag)
- Modify: `src/autonomous/agent-loop.ts` (add session persistence, handoff note integration)
- Modify: `src/autonomous/provider.ts` (deprecate AutonomousProvider)
- Modify: `src/autonomous/providers/ollama.ts` (implement LlmProvider directly)
- Modify: `src/interface/session.ts` (expose session save/load for agent loop use)

**Tests:**
- User message triggers agent loop and produces a response
- Autonomous trigger triggers agent loop with goal context
- Event trigger triggers agent loop with event context
- User message aborts running autonomous cycle
- Session history persists across consecutive user messages
- Legacy pipeline code is unreachable (removed)

**Debugging:**
- Trigger source is logged at cycle start
- Session bridging logs which session is loaded/saved
- Priority interruption logs: what was aborted, why

**Quality gate:** `npm run check`

---

### Phase 3: Provider Unification

**Why:** Two provider interfaces doing the same thing is confusing and creates the ugly `as unknown as` cast.

**Changes:**

1. **Remove `AutonomousProvider` interface**

   The current `AutonomousProvider` in `src/autonomous/provider.ts` has phase-specific methods:
   - `analyze(context)` — calls the LLM with an analysis prompt
   - `hypothesize(observations)` — calls the LLM with a hypothesis prompt
   - `implement(hypothesis, context)` — calls the LLM with an implementation prompt
   - `reflect(outcome)` — calls the LLM with a reflection prompt

   These are all just `generateWithTools()` calls with different system prompts. The agent loop already replaces them — the LLM decides what to do based on its tools and reasoning. Remove the interface.

2. **Single provider interface** (`src/providers/base.ts`)

   `LlmProvider` with `generateWithTools()` is the only interface. The `AutonomousProvider`-specific Ollama implementation in `src/autonomous/providers/ollama.ts` is merged into the main Ollama provider or removed.

3. **Provider registry** (`src/providers/index.ts`)

   Simplified: the registry holds named provider instances (one per model). The agent loop picks which provider to use via the `delegate` tool or defaults to the reasoning model.

   ```typescript
   interface ProviderRegistry {
     get(name: string): LlmProvider;           // 'reasoning', 'coding', etc.
     getDefault(): LlmProvider;                 // The primary reasoning model
     list(): { name: string; model: string }[];
   }
   ```

4. **Delegate tool enhancement** (`src/autonomous/agent-tools.ts`)

   The `delegate` tool becomes the primary model selection mechanism:

   ```typescript
   {
     name: 'delegate',
     parameters: {
       model: string,           // 'coding' | 'reasoning' | specific model name
       task: string,            // What the delegated model should do
       context_files: string[], // Files to include
       review: boolean          // Whether Tyrion should review the output (default true)
     }
   }
   ```

   When Tyrion calls `delegate`, the tool:
   1. Looks up the provider by name in the registry
   2. Builds a focused context (task description + file contents)
   3. Calls `generateWithTools()` on the delegated provider
   4. Returns the result to Tyrion for review

   This is metacognition — Tyrion knows the boundary of his own competence.

**Files:**
- Delete: `src/autonomous/provider.ts` (interface and factory)
- Delete: `src/autonomous/providers/ollama.ts` (redundant implementation)
- Modify: `src/providers/base.ts` (clean up, make canonical)
- Modify: `src/providers/ollama.ts` (ensure it handles all use cases)
- Modify: `src/providers/index.ts` (simplified registry)
- Modify: `src/autonomous/agent-tools.ts` (enhance delegate tool)
- Modify: `src/autonomous/loop.ts` (use LlmProvider directly, no cast)
- Modify: `src/autonomous/agent-loop.ts` (accept ProviderRegistry for delegation)

**Tests:**
- Delegate tool routes to correct provider
- Delegate tool returns structured result
- Agent loop works with unified provider (no cast needed)
- Provider registry returns correct provider by name
- Delegation with `review: true` passes output back to Tyrion

**Debugging:**
- `delegation` trace category: logs which model was delegated to, task description, result summary
- Provider call tracing (from Phase 0) captures all calls including delegated ones

**Quality gate:** `npm run check`

---

### Phase 4: World Model + User Model

**Why:** Tyrion needs to understand the person he's working with, not just the code.

**Changes:**

1. **User model section** in `WorldModel` (`src/autonomous/world-model.ts`)

   ```typescript
   interface UserModel {
     communicationStyle: string;      // "prefers brief responses", "thinks architecturally"
     priorities: string[];            // ["clean abstractions", "test coverage"]
     recentTopics: string[];          // Last 5 interaction topics
     preferences: Record<string, string>;  // "autoApprove: bash commands", etc.
     lastInteraction: string;         // ISO timestamp
   }
   ```

   The user model is populated from journal entries of type `user_interaction`. After each user-triggered cycle, the agent writes a journal entry reflecting on the interaction. Over time, patterns emerge.

2. **World model update from journal** (`src/autonomous/world-model.ts`)

   Add method `updateFromJournal(entries: JournalEntry[])` that:
   - Scans recent entries for user interaction patterns
   - Updates user model fields based on observed preferences
   - Updates active concerns from opinion/observation entries

3. **Identity prompt integration** (`src/autonomous/identity.ts`)

   The identity prompt now includes a "Your understanding of the user" section built from the user model. This gives Tyrion context about who he's talking to without being explicitly told each time.

**Files:**
- Modify: `src/autonomous/world-model.ts` (add UserModel, updateFromJournal)
- Modify: `src/autonomous/identity.ts` (add user model section to identity prompt)
- Modify: `src/autonomous/journal.ts` (add user_interaction analysis helpers)

**Tests:**
- User model updates from journal entries correctly
- Identity prompt includes user model when populated
- Identity prompt omits user model when empty (first interaction)
- World model saves/loads user model correctly

**Debugging:**
- User model changes logged as state diffs
- Identity prompt content logged at trace level (redacted)

**Quality gate:** `npm run check`

---

### Phase 5: Context Consolidation

**Why:** Every session starts cold. The journal helps, but rich reasoning context is still lost. Tyrion needs to actively consolidate his own context.

**Changes:**

1. **Consolidation tool** (`src/autonomous/agent-tools.ts`)

   ```typescript
   {
     name: 'consolidate',
     parameters: {
       summary: string,        // What Tyrion understands about the current situation
       key_insights: string[], // What must be carried forward
       can_drop: string[]      // What can be forgotten
     }
   }
   ```

   When the agent loop detects it's approaching token budget limits (>70% of `maxTokensPerCycle`), it can call `consolidate` to compress its working context. The tool:
   1. Writes a journal entry of type `reflection` with the summary
   2. Trims the conversation history in the current loop to keep only the consolidated summary + recent turns
   3. Continues with a lighter context

2. **Dream cycle as deep consolidation** (modify `src/autonomous/dream/runner.ts`)

   Dream cycles become consolidation-focused:
   - Read all journal entries since last dream cycle
   - Identify patterns, recurring themes, emerging opinions
   - Write a consolidation journal entry summarizing the period
   - Update self-model from journal patterns (not just issue log success rates)
   - Compress old journal entries (keep summaries, archive details)

3. **Self-knowledge from journal** (modify `src/autonomous/dream/self-model.ts`)

   The self-model rebuilds from journal analysis:
   - "I tend to over-complicate refactors" (from multiple journal entries about backing out complexity)
   - "I'm effective at TypeScript type fixes" (from success patterns)
   - "The user prefers architectural discussions before implementation" (from user interaction patterns)

   This replaces the current telemetry-based approach (`successRate: 0.7`) with genuine self-knowledge.

**Files:**
- Modify: `src/autonomous/agent-tools.ts` (add consolidate tool)
- Modify: `src/autonomous/agent-loop.ts` (detect token budget pressure, suggest consolidation)
- Modify: `src/autonomous/dream/runner.ts` (journal-based consolidation)
- Modify: `src/autonomous/dream/self-model.ts` (rebuild from journal patterns)
- Modify: `src/autonomous/dream/consolidation.ts` (journal compression)

**Tests:**
- Consolidate tool writes journal entry and trims context
- Token budget detection triggers at correct threshold
- Dream cycle produces consolidation entry from journal
- Self-model extracts patterns from journal entries
- Old journal entries are compressed (details archived, summaries kept)

**Debugging:**
- Token budget logging: current usage, threshold, consolidation trigger
- Context trimming: what was kept, what was dropped, token savings
- Dream cycle: journal entries processed, patterns found, self-model updates

**Quality gate:** `npm run check`

---

### Phase 6: Documentation Rewrite

**Why:** After the architecture changes, the docs need to reflect reality.

**Changes:**

1. **Rewrite `docs/architecture.md`** — new system diagram, unified loop, journal-centric state
2. **Rewrite `docs/api-reference.md`** — unified provider interface, new tools, journal API
3. **Update `docs/rulebook.md`** — new invariants for journal, unified loop, user model privacy
4. **Update `docs/subagents.md`** — remove Tyrion Behavior Reviewer (subsumed by journal), update collaboration flow
5. **Rewrite `docs/OPEN-ISSUES.md`** — most issues are "Implemented", clean up and add new issues from this refactor
6. **Update `CLAUDE.md`** — reference new architecture doc

**Quality gate:** `npm run check`

---

## Documentation Cleanup (Immediate)

These files are deleted with this plan because they describe completed work or are superseded:

| File | Reason |
|------|--------|
| `docs/PLAN-hallucination-prevention.md` | STATUS: COMPLETE — native tool use is shipped |
| `docs/PLAN-architecture-rework.md` | Completed — describes text-to-native migration |
| `docs/PLAN-implementation-roadmap.md` | Completed — 10-session native tool migration |
| `docs/PLAN-interface-layer.md` | Completed — bootstrap/prompt/session are built |
| `docs/plan-tyrion-evolution.md` | Superseded by this plan |
| `docs/handoff-phase2.md` | Completed — Phase 2 agent loop is shipped |
| `docs/autonomous-improvement.md` | Superseded — describes old pipeline architecture |
| `docs/mac-studio-refactor.md` | Completed — Mac Studio migration is done |

These files are **kept**:

| File | Reason |
|------|--------|
| `docs/architecture.md` | Will be rewritten in Phase 6 (still useful as-is until then) |
| `docs/api-reference.md` | Will be rewritten in Phase 6 |
| `docs/rulebook.md` | Protected — updated in Phase 6 |
| `docs/subagents.md` | Protected — updated in Phase 6 |
| `docs/OPEN-ISSUES.md` | Cleaned up in Phase 6 |
| `docs/coding-interface.md` | Still accurate — coding tools unchanged |
| `docs/skills-and-tools.md` | Still accurate — skill system unchanged |
| `docs/testing.md` | Still accurate — testing framework unchanged |
| `docs/test-registry.md` | Still accurate — test catalog |
| `docs/error-codes.md` | Still accurate — error code reference |
| `docs/install.md` | Still accurate — installation guide |
| `docs/app-wrapper-plan.md` | Separate concern — macOS app wrapper |
| `docs/mac-permissions-review.md` | Separate concern — macOS permissions |
| `docs/IMPLEMENTATION-GUIDE.md` | Reference for integration points |

---

## Implementation Order and Dependencies

```
Phase 0 ─── Debugging Infrastructure (no dependencies)
   │
Phase 1 ─── Journal System (depends on Phase 0)
   │
Phase 2 ─── Unify the Loop (depends on Phase 1)
   │
Phase 3 ─── Provider Unification (depends on Phase 2)
   │
Phase 4 ─── World Model + User Model (depends on Phase 1)
   │
Phase 5 ─── Context Consolidation (depends on Phase 1 + 2)
   │
Phase 6 ─── Documentation Rewrite (depends on all above)
```

Phases 3, 4, and 5 can proceed in parallel after Phase 2.

---

## File Count Summary

| Phase | New Files | Modified Files | Deleted Files | Estimated Lines |
|-------|-----------|----------------|---------------|-----------------|
| 0. Debugging | 1 | 3 | 0 | ~300 |
| 1. Journal | 1 | 3 | 0 | ~400 |
| 2. Unify Loop | 1 | 7 | 0 | ~500 |
| 3. Provider | 0 | 6 | 2 | ~300 (net negative) |
| 4. User Model | 0 | 3 | 0 | ~200 |
| 5. Consolidation | 0 | 5 | 0 | ~300 |
| 6. Documentation | 0 | 5 | 8 | ~docs |
| **Total** | **3** | **32** | **10** | **~2,000** |

---

## Invariants Preserved

Every phase maintains:
1. All inference local via Ollama — no cloud APIs
2. All user data stays on machine
3. Logging through safe redaction — journal entries are private, local-only
4. Quality gates (`npm run check`) pass
5. Protected paths only modified with explicit documentation
6. Security patterns and detection unchanged
7. User messages always preempt autonomous work

## New Invariants Added

1. The journal is append-only — entries are never deleted, only compressed during dream cycles
2. The agent loop is the single execution path — no separate interactive/autonomous code paths
3. Delegation is transparent — every delegated call is logged and reviewable
4. The user model is local-only and never logged raw — it's derived, not stored verbatim

---

## Debugging Strategy (Cross-Cutting)

Debugging is not a phase — it's built into every phase. The approach:

### 1. Trace Categories

Every subsystem gets a named trace category in `debug.ts`:

| Category | What it captures |
|----------|-----------------|
| `journal` | Entry writes, reads, searches, compression |
| `agent-loop` | Turn-by-turn decisions, trigger source, budget tracking |
| `delegation` | Model selection, task sent, result received, review decision |
| `context-budget` | Token usage, what's included, what's dropped, consolidation |
| `state-diff` | What changed in world model, goals, issues, journal after a cycle |
| `provider` | Every LLM call: model, tokens, latency, response type |
| `trigger` | Event source, normalization, priority |
| `session` | Load, save, history trim, per-peer isolation |

### 2. Debug Filtering

The existing `getTracer().setFilter()` mechanism lets you enable/disable categories:

```typescript
// See everything
tracer.setFilter('*');

// See only agent loop decisions
tracer.setFilter('agent-loop');

// See agent loop + delegation
tracer.setFilter('agent-loop,delegation');
```

### 3. State Snapshots

Before and after each cycle, the full state is snapshotted:
- World model health
- Goal stack (top 5)
- Issue log (open count)
- Journal (last entry timestamp)
- Context budget (current usage)

The diff between before/after is logged at `state-diff` level.

### 4. Replay Mode

The state inspector can load a cycle's trace and replay the decision sequence:
```bash
casterly inspect cycle cycle-2026-02-17T03-14-00-001
```
This shows: trigger → state loaded → turns (reasoning + tool calls) → state saved → outcome.

### 5. Live Watch

```bash
casterly inspect watch --filter agent-loop,delegation
```
Tails the trace log in real-time with category filtering. Useful during development.

---

## Risk Assessment

| Risk | Impact | Mitigation |
|------|--------|------------|
| Interactive response latency increases | High | Profile agent loop overhead; keep hot path fast |
| Journal grows unbounded | Medium | Dream cycle compression; max file size with rotation |
| Provider unification breaks existing tests | Medium | Incremental: deprecate first, remove later |
| User model captures sensitive information | High | Never store verbatim user content; derive summaries only |
| Delegation adds latency to coding tasks | Medium | Delegation is optional; direct tool use remains available |
