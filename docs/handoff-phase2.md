# Phase 2 Handoff — ReAct Agent Loop

## What Was Built

Phase 2 replaces Tyrion's rigid 4-phase pipeline (`analyze → hypothesize → implement → validate`) with a flexible ReAct (Reason → Act → Observe) agent loop. The LLM now decides what to do next based on the full conversation history, available tools, and current state.

### New Files

| File | Lines | Purpose |
|------|-------|---------|
| `src/autonomous/agent-tools.ts` | ~850 | Agent toolkit: 19 tools with schemas + executors |
| `src/autonomous/agent-loop.ts` | ~560 | ReAct reasoning engine |
| `tests/agent-tools.test.ts` | ~390 | 39 tests for all tool executors |
| `tests/agent-loop.test.ts` | ~340 | 17 tests for the loop lifecycle |

### Modified Files

| File | Change |
|------|--------|
| `src/autonomous/loop.ts` | +183 lines: `runAgentCycle()`, state loading/saving, trigger determination, abort support |
| `src/autonomous/index.ts` | +21 lines: Phase 2 exports |
| `config/autonomous.yaml` | +36 lines: `agent_loop` configuration section |

### Test Results

- **166 tests passing** (56 new from Phase 2, 110 from Phase 1)
- All quality gates green (guardrails, lint, typecheck, tests, security scan)

---

## Architecture

### Agent Toolkit (`agent-tools.ts`)

19 tools organized by category:

**File Operations:**
- `think` — Explicit reasoning step (no-op, logged for transparency)
- `read_file` — Read with line numbers, offset, max_lines
- `edit_file` — Search-and-replace (requires unique match)
- `create_file` — New file creation (fails if exists)

**Search:**
- `grep` — Regex pattern search across files
- `glob` — File pattern matching via find

**System:**
- `bash` — Shell execution with blocked command patterns (rm -rf, git push --force, etc.)

**Quality:**
- `run_tests` — Vitest runner with optional pattern filter
- `typecheck` — tsc --noEmit
- `lint` — scripts/lint.mjs

**Git:**
- `git_status`, `git_diff`, `git_commit`, `git_log`

**State Management:**
- `file_issue` — File/update issues in the issue log
- `close_issue` — Resolve issues
- `update_goal` — Update goal status/notes

**Delegation:**
- `delegate` — Send sub-tasks to hermes3:70b or qwen3-coder-next (requires provider)

**Communication:**
- `message_user` — Phase 7 placeholder (disabled by default)

Each tool has:
1. A `ToolSchema` (JSON Schema) sent to the LLM
2. An executor function that performs the operation
3. Debug tracing for all operations
4. Path safety checks (allowed directories + forbidden patterns)
5. Output truncation to prevent context flooding

### Agent Loop (`agent-loop.ts`)

The ReAct loop cycle:

```
1. Load identity prompt (world model + goals + issues + character)
2. Build system prompt (trigger description + tool list + behavior guidelines)
3. Loop:
   a. Send conversation to LLM
   b. If LLM returns tool calls → execute them, append results, continue
   c. If LLM returns only text → cycle complete
4. Save state, return outcome
```

**Trigger types:**
- `scheduled` — Periodic autonomous cycle (checks goal stack and issue log)
- `event` — External event (Phase 3 will add file watchers, git hooks)
- `user` — User message (takes priority)
- `goal` — Specific goal from the goal stack

**Budget controls:**
- `maxTurns` (default 20): Hard limit on reasoning loops
- `maxTokensPerCycle` (default 50,000): Soft token estimate limit
- Token estimation: ~3.5 chars/token (conservative)

**Abort support:**
- `loop.abort()` — External signal to preempt autonomous work
- Checked before each turn
- Returns `stopReason: 'aborted'` in outcome

**Outcome tracking:**
- Full turn history (reasoning, tool calls, results, timing)
- Files modified, issues filed, goals updated
- Token estimates, duration, stop reason

### Integration with loop.ts

The `AutonomousLoop` class now has:
- `runAgentCycle()` — New ReAct-based cycle (parallel to legacy `runCycle()`)
- `loadState()` / `saveState()` — Persistent state management
- `determineTrigger()` — Picks the next goal or defaults to scheduled
- `abortAgentCycle()` — External abort for active agent loops
- `getState()` — Access to WorldModel, GoalStack, IssueLog

The `useAgentLoop` flag (from config) determines which cycle runs.
Currently defaults to `false` — legacy pipeline remains the default.

---

## Key Design Decisions

1. **Provider cast**: `loop.ts` casts `AutonomousProvider` to `LlmProvider` via `unknown`. Both interfaces are implemented by Ollama, but they have different shapes. Phase 3+ should unify the provider interface.

2. **Tool results accumulate**: The full conversation history (tool results) is passed to the LLM via `previousResults` on each turn. This gives the model context about what it's already done.

3. **Think tool**: A no-op tool that lets the LLM reason explicitly before acting. This is critical for ReAct — without it, the model tends to jump straight to tool calls without planning.

4. **Path safety**: All file-mutating tools check `allowedDirectories` and `forbiddenPatterns` from config. Destructive bash commands are pattern-matched and blocked.

5. **Delegation placeholder**: The `delegate` tool requires an `LlmProvider` at construction time. When no provider is passed, delegation returns "disabled". Full delegation with model switching comes in Phase 5.

6. **message_user placeholder**: Returns "not yet enabled" until Phase 7 implements iMessage delivery.

---

## Configuration (`config/autonomous.yaml`)

```yaml
agent_loop:
  enabled: false        # Master switch (legacy pipeline is default)
  max_turns: 20         # Max reasoning loops per cycle
  max_tokens_per_cycle: 50000  # Soft token budget
  reasoning_model: hermes3:70b
  coding_model: qwen3-coder-next:latest
  think_tool_enabled: true
  delegation_enabled: true
  user_messaging_enabled: false
  temperature: 0.2
  max_response_tokens: 4096
```

---

## TypeScript Strictness Notes

Two `exactOptionalPropertyTypes` issues were fixed:
1. `selfModel` field: Changed from `SelfModelSummary | null | undefined` to `SelfModelSummary | null` with a `?? null` coercion in the constructor.
2. `trackStateChanges` parameter: Changed from inline type `{ success: boolean; output?: string; error?: string }` to `NativeToolResult` directly, which already has the correct optional property types.

---

## What Comes Next

### Phase 3: Event-Driven Awareness
- File watchers (chokidar) that trigger agent cycles on file changes
- Git hooks that trigger on commits/pushes
- Issue aging that promotes stale issues to higher priority
- Replaces the timer-based cycle interval with event-driven triggers

### Phase 4: Tiered Memory
- MemGPT-style hot/warm/cool/cold context management
- Agent-managed paging of context into/out of the prompt
- Long-term memory persistence beyond the identity prompt

### Phase 5: Hardware Maximization
- Always-hot dual models (hermes3 + qwen3 loaded simultaneously)
- Concurrent inference for the delegate tool
- Test-time compute scaling (parallel candidates for hard problems)
- Adversarial self-testing

### Phase 6: Dream Cycles
- Background consolidation of learning
- Code archaeology (git history analysis)
- Self-model calibration from cycle outcomes
- Training data collection for self-distillation

### Phase 7: Proactive Communication
- iMessage delivery with throttling
- Judgment about when to message vs. when to be silent
- User preference learning

---

## How to Test Manually

Enable the agent loop:
```yaml
# config/autonomous.yaml
agent_loop:
  enabled: true
```

Or use the API directly:
```typescript
import { createAgentLoop, buildAgentToolkit } from './src/autonomous/index.js';

const toolkit = buildAgentToolkit({ projectRoot: '/path/to/project' }, state);
const loop = createAgentLoop({ maxTurns: 5 }, provider, toolkit, state);
const outcome = await loop.run({ type: 'scheduled' });
console.log(outcome.summary);
```

---

## Commit History

| Hash | Description |
|------|-------------|
| `e171cb6` | Plan document |
| `319d9cc` | Phase 1: Persistent identity and memory |
| `a90c87c` | Phase 2: ReAct agent loop with full toolkit |
