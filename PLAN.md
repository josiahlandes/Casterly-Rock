# Plan: Architectural Hygiene — Six Targeted Improvements

Based on my review of the codebase, these are six focused changes that reduce
dead code, improve failure visibility, tighten resource limits, and add
crash-safety to persistence. Each change is small, explicit, and testable.

None of the changes touch protected paths (`src/security/*`, `src/providers/*`,
`config/*`, `src/tasks/classifier.ts`). The `config/autonomous.yaml` change
(removing `quiet_hours`) is noted as a protected-path edit and will be run
through the full quality gates.

---

## Change 1: Remove dead `isInWorkWindow` / quiet-hours code

**Problem:** `isInWorkWindow()` in `controller.ts:415` always returns `true`.
The `quiet_hours` config in `autonomous.yaml:27-33` is parsed but never
honored. The work-window transition check in `tick()` (lines 162-174) can
never fire because `isInWorkWindow` never returns `false`. This is dead code
that misleads readers.

**Changes:**
- `src/autonomous/controller.ts`: Remove `isInWorkWindow()` export. Remove the
  work-window transition block in `tick()` (lines 162-174) and the
  `wasInWorkWindow` state variable. Keep `writeHandoff()` — it's still called
  after cycles with pending branches (line 204).
- `config/autonomous.yaml` (protected path): Remove the `quiet_hours` block
  (lines 27-33). Add a comment pointing to `docs/vision.md` for the "always
  works" philosophy.
- `src/autonomous/loop.ts`: Remove any import/usage of `isInWorkWindow` if
  present.
- Update tests in `tests/autonomous-controller.test.ts` if they reference
  `isInWorkWindow` or work-window transitions.

**Risk:** Low. The function is already a no-op.

---

## Change 2: Add dream cycle phase-skip telemetry

**Problem:** Dream phases 7-17 silently skip when their stores are empty or
undefined. After months of operation, there's no signal that tells you "your
dream cycles have been 60% no-ops." The `phasesSkipped` array exists but is
only populated on *errors*, not on *conditional skips* (when the `if` guard
evaluates to false).

**Changes:**
- `src/autonomous/dream/runner.ts`: For every phase that has an `if (store)`
  guard (phases 7a, 7b, 8a, 8b, 8c, 10-17), add an `else` clause that pushes
  to `phasesSkipped` with a reason suffix like `'shadowAnalysis:not_configured'`
  or `'audnConsolidation:empty_queue'`. This distinguishes "skipped because not
  configured" from "skipped because it threw an error."
- Add a summary log at the end of `run()` that reports: `X/17 phases completed,
  Y skipped (Z not configured, W empty), E errors`.
- Add a `DreamOutcome.phaseSkipReasons` field (a `Record<string, string>`) to
  capture why each phase was skipped.

**Risk:** Low. Additive logging only. No behavioral change.

---

## Change 3: Add background turn limit (`maxTurnsBackground`)

**Problem:** Background cycles (scheduled/event) share the same 200-turn
ceiling as user cycles, despite having 1/5 the token budget (100K vs 500K).
A background cycle that reaches 50+ turns on 100K tokens is almost certainly
stuck, not productive.

**Changes:**
- `config/autonomous.yaml` (protected path): Add `max_turns_background: 40`
  in the `agent_loop` section (near line 108).
- `src/autonomous/agent-loop.ts`: Add `maxTurnsBackground?: number` to the
  `AgentLoopConfig` interface.
- `src/autonomous/loop.ts` (line ~884): Select turn limit based on trigger
  type, same pattern as the token budget selection:
  ```typescript
  const scaledMaxTurns = (effectiveTrigger.type === 'user' || effectiveTrigger.type === 'goal')
    ? (this.agentConfig.maxTurns ?? 200)
    : (this.agentConfig.maxTurnsBackground ?? this.agentConfig.maxTurns ?? 40);
  ```
- Parse `max_turns_background` from YAML in the config loader.
- Add a test that verifies background triggers get the lower turn limit.

**Risk:** Low. Tightens an existing safety ceiling for unattended work.

---

## Change 4: Reduce issue watcher polling interval

**Problem:** The issue watcher checks every 6 hours for issues that are stale
after 7 days. That's 28 polls before any issue could possibly trigger. Once
per 24 hours is sufficient.

**Changes:**
- `config/autonomous.yaml` (protected path): Change
  `check_interval_ms: 21600000` to `check_interval_ms: 86400000` (24 hours).
- No code changes required — the interval is config-driven.
- Update the `dream-scheduling.test.ts` if it hardcodes the old interval.

**Risk:** Minimal. Reduces unnecessary timer firings.

---

## Change 5: Add atomic file writes via `safeWriteFile` utility

**Problem:** Every persistence layer (handoff, taskboard, goal stack, issue
log) uses raw `writeFile()`. A crash mid-write corrupts the file. The journal
is safe (append-only JSONL), but all JSON/YAML stores are vulnerable.

**Changes:**
- Create `src/persistence/safe-write.ts` with a single function:
  ```typescript
  export async function safeWriteFile(
    filePath: string,
    content: string,
    encoding?: BufferEncoding,
  ): Promise<void> {
    const tmp = filePath + '.tmp';
    await writeFile(tmp, content, encoding ?? 'utf8');
    await rename(tmp, filePath);
  }
  ```
  The `rename()` syscall is atomic on POSIX filesystems (which is what this
  Mac Studio runs).
- Replace `writeFile()` calls with `safeWriteFile()` in:
  - `src/autonomous/controller.ts` (handoff write, line ~348)
  - `src/dual-loop/task-board.ts` (save, line ~170)
  - `src/autonomous/goal-stack.ts` (save, line ~280)
  - `src/autonomous/issue-log.ts` (save, line ~305)
- Add tests: write a file using `safeWriteFile`, verify it's readable. Simulate
  a crash-like scenario (verify `.tmp` doesn't linger on success).

**Risk:** Low. `rename()` is the standard POSIX pattern for atomic file
replacement. Node.js `fs.rename` maps directly to the syscall.

---

## Change 6: Add dream phase tier logging to DreamOutcome

**Problem:** Related to Change 2, but structural. The 17 dream phases span
three logical tiers (core phases 1-5, vision-tier phases 7-8, advanced memory
phases 10-17) but the outcome doesn't report by tier. This makes it hard to
understand the health of each subsystem.

**Changes:**
- `src/autonomous/dream/runner.ts`: After all phases complete, compute a
  per-tier summary on the `DreamOutcome`:
  ```typescript
  outcome.tierSummary = {
    core: { completed: X, skipped: Y, errored: Z },
    vision: { completed: X, skipped: Y, errored: Z },
    memory: { completed: X, skipped: Y, errored: Z },
  };
  ```
- Add `tierSummary` to the `DreamOutcome` interface.
- Log the tier summary at the end of the dream cycle at `info` level.

**Risk:** Low. Additive only.

---

## Execution Order

1. **Change 5** (safe writes) — foundation, no dependencies
2. **Change 1** (remove dead code) — simplification
3. **Change 3** (background turn limit) — config + wiring
4. **Change 4** (issue watcher interval) — config-only
5. **Changes 2 + 6** (dream telemetry) — related, do together
6. Run `npm run check` — full quality gates
7. Commit and push

## Protected Path Edits

`config/autonomous.yaml` is touched by changes 1, 3, and 4. These are
minimal config changes (removing dead config, adding one field, changing one
number). Full quality gates will run after all changes.

## Files Created

- `src/persistence/safe-write.ts` (new utility)
- `tests/safe-write.test.ts` (new test)

## Files Modified

- `src/autonomous/controller.ts` (remove dead isInWorkWindow code)
- `src/autonomous/dream/runner.ts` (phase skip reasons + tier summary)
- `src/autonomous/agent-loop.ts` (maxTurnsBackground config field)
- `src/autonomous/loop.ts` (background turn limit selection)
- `src/dual-loop/task-board.ts` (use safeWriteFile)
- `src/autonomous/goal-stack.ts` (use safeWriteFile)
- `src/autonomous/issue-log.ts` (use safeWriteFile)
- `config/autonomous.yaml` (remove quiet_hours, add max_turns_background, change issue watcher interval)
- `tests/autonomous-controller.test.ts` (if needed)
- `tests/dream-scheduling.test.ts` (if needed)
