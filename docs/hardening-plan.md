# Hardening Plan — Closing the Gaps

This document is an actionable plan to address the ten weaknesses identified during
the February 2026 project analysis. Each section maps to a specific weakness,
states the goal, lists concrete steps, identifies affected files, and defines
acceptance criteria.

Priority scale: **P0** (fix now — correctness/security), **P1** (fix soon — reliability),
**P2** (fix next — maintainability), **P3** (fix later — polish).

---

## 1. Finish and Wire the Autonomous Subsystems

**Weakness:** The autonomous system's modules are individually well-implemented,
but several are not wired into the production agent loop. Vision Tier 2/3 stores
(`PromptStore`, `ShadowStore`, `ToolSynthesizer`, `ChallengeGenerator`,
`ChallengeEvaluator`, `PromptEvolution`, `TrainingExtractor`, `LoraTrainer`) are
defined as optional fields on `AgentState` but never populated in
`loop.ts:runAgentCycle()`. The `message_user` tool ignores the fully-implemented
`MessagePolicy`. Dream cycles have no automatic trigger in the modern path. The
deprecated `runCycle()` creates a second execution path to maintain.

**Priority:** P1

**Goal:** Wire every implemented module into the production agent loop so the full
vision stack is live and testable. Remove the legacy execution path.

### 1A. Wire Vision Tier 2/3 Stores into AgentState

The following stores are implemented but never instantiated in
`loop.ts:runAgentCycle()` (lines 700–717). The `agentState` object must be
extended to include them.

**Steps:**

1. In the `AutonomousLoop` class (`src/autonomous/loop.ts`), add private fields
   and initialization for each store, mirroring the pattern already used for
   `worldModel`, `goalStack`, `issueLog`, and `journal`:
   ```typescript
   private promptStore: PromptStore;
   private shadowStore: ShadowStore;
   private toolSynthesizer: ToolSynthesizer;
   private challengeGenerator: ChallengeGenerator;
   private challengeEvaluator: ChallengeEvaluator;
   private promptEvolution: PromptEvolution;
   private trainingExtractor: TrainingExtractor;
   private loraTrainer: LoraTrainer;
   ```
2. Instantiate each in the constructor or in a `loadVisionStores()` helper called
   from `loadState()`. Each store already has a `load()` or factory method — use
   it. Pass the LLM provider where required (e.g., `ChallengeGenerator` needs an
   LLM for generation).
3. Populate `agentState` in `runAgentCycle()` (around line 700):
   ```typescript
   const agentState: AgentState = {
     // ... existing fields ...
     promptStore: this.promptStore,
     shadowStore: this.shadowStore,
     toolSynthesizer: this.toolSynthesizer,
     challengeGenerator: this.challengeGenerator,
     challengeEvaluator: this.challengeEvaluator,
     promptEvolution: this.promptEvolution,
     trainingExtractor: this.trainingExtractor,
     loraTrainer: this.loraTrainer,
   };
   ```
4. Add `saveVisionStores()` to the `saveState()` path so any mutations during a
   cycle are persisted.
5. Add a config toggle in `config/autonomous.yaml`:
   ```yaml
   visionTiers:
     tier2: true   # prompt-store, shadow-store, tool-synthesizer
     tier3: true   # challenges, prompt-evolution, lora
   ```
   When a tier is disabled, those fields remain `undefined` on `AgentState` and
   the corresponding agent tools gracefully return "not enabled" (which they
   already do via null-checks in `agent-tools.ts`).

**Affected Paths:**
- `src/autonomous/loop.ts` (instantiate and wire stores)
- `config/autonomous.yaml` (add tier toggles)
- `config/schema.ts` (extend Zod schema)

**Acceptance Criteria:**
- [x] All 8 Vision Tier 2/3 stores are populated in `agentState` when their tier
      is enabled.
- [ ] Agent tools that depend on these stores (`edit_prompt`, `shadow`,
      `run_challenges`, `evolve_prompt`, `extract_training_data`, `load_adapter`)
      function end-to-end in a test cycle.
- [x] Disabling a tier via config causes graceful "not enabled" responses.
- [x] `npm run check` passes (no regressions; pre-existing failures unchanged).

**Status: IMPLEMENTED** — Vision Tier 2/3 stores are instantiated in the
`AutonomousLoop` constructor, loaded/saved alongside core state, and populated
in `agentState` during `runAgentCycle()`. Config-driven via `visionTiers` in
`config/autonomous.yaml`. 5 new tests added. End-to-end verification of
individual agent tools deferred to integration testing.

### 1B. Connect `message_user` to MessagePolicy and a Delivery Backend

The `MessagePolicy` class in `src/autonomous/communication/policy.ts` is fully
implemented (throttle, quiet hours, event filtering, formatting) but the
`message_user` tool executor (`agent-tools.ts:~2362`) ignores it entirely. It
checks a boolean `config.userMessagingEnabled` and returns a "Phase 7 not enabled"
string. There is also no actual delivery mechanism.

**Steps:**

1. Create `src/autonomous/communication/delivery.ts`:
   - Define a `MessageDelivery` interface:
     ```typescript
     export interface MessageDelivery {
       send(message: string, urgency: string): Promise<{ delivered: boolean; channel: string }>;
     }
     ```
   - Implement `IMessageDelivery` — uses the existing `src/imessage/sender.ts`
     to send via iMessage (the project's primary communication channel).
   - Implement `ConsoleDelivery` — writes to a `~/.casterly/outbox.jsonl` file
     (fallback when iMessage is not configured).
2. Add a `MessagePolicy` instance and `MessageDelivery` instance to
   `AgentState`:
   ```typescript
   messagePolicy?: MessagePolicy;
   messageDelivery?: MessageDelivery;
   ```
3. Instantiate both in `loop.ts` and populate `agentState`.
4. Rewrite the `message_user` executor to:
   - Build a `NotifiableEvent` from the tool call parameters.
   - Call `messagePolicy.shouldNotify(event)`.
   - If allowed, call `messageDelivery.send(decision.formattedMessage, urgency)`.
   - Call `messagePolicy.recordSent(event)`.
   - Return the delivery result (or the block reason).
5. Remove the `config.userMessagingEnabled` boolean check — the `MessagePolicy`
   `enabled` field replaces it.
6. Add config in `config/autonomous.yaml`:
   ```yaml
   messaging:
     enabled: true
     deliveryChannel: imessage   # 'imessage' | 'console'
     throttle:
       maxPerHour: 3
       maxPerDay: 10
       quietStart: '22:00'
       quietEnd: '08:00'
   ```

**Affected Paths:**
- `src/autonomous/communication/delivery.ts` (new)
- `src/autonomous/agent-tools.ts` (rewrite `message_user` executor)
- `src/autonomous/loop.ts` (instantiate policy + delivery)
- `config/autonomous.yaml` (messaging config)

**Acceptance Criteria:**
- [ ] `message_user` tool routes through `MessagePolicy.shouldNotify()`.
- [ ] Messages are delivered via iMessage when configured.
- [ ] Throttle and quiet hours are respected.
- [ ] Blocked messages return a clear reason to the agent.
- [ ] `npm run check` passes.

### 1C. Auto-Trigger Dream Cycles in the Modern Path

The legacy `runDreamCycleIfDue()` method exists (line ~1096) but is `private` and
never called from `runAgentCycle()`. Dream phase tools exist but require the agent
to decide to use them — there is no automatic scheduling.

**Steps:**

1. Add a `checkDreamCycleDue()` method to `AutonomousLoop`:
   - Check `lastDreamCycle` timestamp against configured interval (e.g., every
     24 hours or every N cycles).
   - Read from `config/autonomous.yaml`:
     ```yaml
     dream:
       intervalHours: 24
       minCyclesBetween: 10
     ```
2. In `runAgentCycle()`, after the main cycle completes (around line 793),
   call `checkDreamCycleDue()`. If due, fire a follow-up cycle with a
   `{ type: 'scheduled', reason: 'dream_cycle' }` trigger where the system
   prompt instructs the agent to run dream phase tools.
3. Alternative (simpler): add a `dreamCycleTrigger()` to `trigger-router.ts`
   that the main loop checks on each tick in `tick()`. If due, the next cycle's
   trigger is the dream trigger instead of a goal or event.
4. Persist `lastDreamCycleTimestamp` to `~/.casterly/state/dream-meta.json`.

**Affected Paths:**
- `src/autonomous/loop.ts` (add dream scheduling)
- `src/autonomous/trigger-router.ts` (add dream trigger type)
- `config/autonomous.yaml` (dream interval config)

**Acceptance Criteria:**
- [ ] Dream cycles trigger automatically after the configured interval.
- [ ] The dream trigger causes the agent to invoke dream phase tools.
- [ ] Manual `runDreamCycleIfDue()` still works as an escape hatch.
- [ ] `npm run check` passes.

### 1D. Retire the Legacy `runCycle()` Path

The deprecated `runCycle()` (line ~301) implements the old four-phase
Analyze → Hypothesize → Implement → Reflect pipeline. It shares code with
`runAgentCycle()` (state loading, saving) but maintains a parallel execution
path that doubles the maintenance surface.

**Steps:**

1. Audit all call sites of `runCycle()`:
   - Internal: the legacy `tick()` path (if `useAgentLoop` is false).
   - External: `scripts/run-single-cycle.ts`, `scripts/test-autonomous-cycle.ts`.
2. Update all external call sites to use `runAgentCycle()`.
3. Remove the `useAgentLoop` config flag — the agent loop is now the only path.
4. Delete `runCycle()` and its private helpers (`attemptHypothesis`,
   `generateHypotheses`, etc.).
5. Remove the `Analyzer`, `Validator`, and `Reflector` imports if they are no
   longer used by any remaining code. (Check first — `Reflector` is used by
   dream cycles via `agentState.reflector`; keep it if so.)
6. Remove the `@deprecated` markers on `runAgentCycle` references that exist
   only because of the dual-path situation.

**Affected Paths:**
- `src/autonomous/loop.ts` (delete ~500 lines of legacy code)
- `scripts/run-single-cycle.ts` (update call site)
- `scripts/test-autonomous-cycle.ts` (update call site)
- `config/autonomous.yaml` (remove `useAgentLoop` flag)

**Acceptance Criteria:**
- [ ] `runCycle()` no longer exists.
- [ ] Only one execution path remains: `runAgentCycle()`.
- [ ] All scripts and entry points use the modern path.
- [ ] No dead imports remain after cleanup.
- [ ] `npm run check` passes.

---

## 2. Strengthen Sensitive-Data Detection Beyond Regex

**Weakness:** Sensitive data detection and injection detection both rely on regex
patterns. These miss context-dependent data, sophisticated variants, and novel
injection techniques.

**Priority:** P0

**Goal:** Add a semantic detection layer that uses the local LLM as a second pass
for ambiguous inputs, while keeping regex as the fast first pass.

### Steps

1. Add a `SemanticDetector` class in `src/security/semantic-detector.ts`.
   - Input: text that the regex pass flagged as `uncertain` or `none`.
   - Output: same `SensitiveCategory[]` shape the regex detector returns.
   - Implementation: call the local primary model with a short classification
     prompt ("Does this text contain sensitive personal data? Respond with
     categories or NONE."). Parse the structured response.
2. Extend `src/security/detector.ts` to orchestrate two passes:
   - **Fast path:** regex patterns (existing). If confidence is high → return immediately.
   - **Slow path:** semantic detector (new). Only invoked when regex returns no
     match but the input exceeds a length/entropy threshold, or when the input
     is user-facing (iMessage, CLI).
3. Add a config toggle in `config/default.yaml`:
   ```yaml
   sensitivity:
     semanticDetection: true   # enable LLM second-pass
     semanticThreshold: 200    # min chars before invoking LLM
   ```
4. Add tests:
   - Unit tests for `SemanticDetector` with mocked LLM responses.
   - Integration tests with adversarial inputs that bypass regex but contain
     real sensitive data (e.g., "my social is three two one …" spelled out).

### Affected Paths

- `src/security/semantic-detector.ts` (new)
- `src/security/detector.ts` (extend)
- `config/default.yaml` (new config keys)
- `config/schema.ts` (extend Zod schema)

### Acceptance Criteria

- [ ] Regex-only path is unaffected when `semanticDetection: false`.
- [ ] Adversarial test cases (spelled-out SSN, obfuscated credit card) are caught.
- [ ] Latency for the fast path does not increase.
- [ ] `npm run check` passes.

---

## 3. Add CI/CD Pipeline

**Weakness:** No `.github/workflows/`, no pre-commit hooks. Quality gates only run
when someone remembers to invoke them.

**Priority:** P1

**Goal:** Automate quality gates so no code lands without passing them.

### Steps

1. Create `.github/workflows/ci.yml`:
   ```yaml
   name: CI
   on: [push, pull_request]
   jobs:
     check:
       runs-on: ubuntu-latest
       steps:
         - uses: actions/checkout@v4
         - uses: actions/setup-node@v4
           with: { node-version: 20 }
         - run: npm ci
         - run: npm run lint
         - run: npm run typecheck
         - run: npm run test
         - run: npm run security:scan
   ```
   Note: `npm run guardrails` is omitted from CI because it checks staged diffs;
   instead, add a separate workflow step that diffs against the base branch and
   checks for protected-path changes.
2. Create a protected-path CI check:
   - `scripts/ci-guardrails.mjs` — accepts a base ref, diffs, and fails if
     protected paths were changed without `ALLOW_PROTECTED_CHANGES=1`.
3. Add a pre-commit hook via a lightweight script (no Husky dependency):
   - `scripts/pre-commit.sh` — runs `npm run lint` and `npm run typecheck`.
   - Installation: `git config core.hooksPath scripts/hooks` documented in
     `docs/install.md`.
4. Add branch protection rules documentation for the main branch:
   - Require CI to pass before merge.
   - Require at least one review (even if self-review for solo dev).

### Affected Paths

- `.github/workflows/ci.yml` (new)
- `scripts/ci-guardrails.mjs` (new)
- `scripts/hooks/pre-commit` (new)
- `docs/install.md` (update with hook setup)

### Acceptance Criteria

- [ ] Every push and PR triggers CI.
- [ ] CI runs lint, typecheck, test, and security:scan.
- [ ] Protected-path changes without explicit opt-in fail CI.
- [ ] Pre-commit hook catches lint and type errors locally.

---

## 4. Replace Busy-Wait with Proper Semaphore in Concurrent Provider

**Weakness:** `src/providers/concurrent.ts` uses a `setTimeout(resolve, 50)` polling
loop instead of a proper semaphore. Wastes CPU cycles.

**Priority:** P2

**Goal:** Replace the busy-wait with an event-driven semaphore.

### Steps

1. Implement a `Semaphore` class in `src/providers/semaphore.ts`:
   ```typescript
   export class Semaphore {
     private queue: (() => void)[] = [];
     private active = 0;
     constructor(private readonly max: number) {}
     async acquire(): Promise<void> { ... }
     release(): void { ... }
   }
   ```
   Use a promise-based queue: `acquire()` returns immediately if `active < max`,
   otherwise pushes a resolver onto the queue. `release()` decrements and shifts
   the next resolver.
2. Replace the busy-wait loop in `src/providers/concurrent.ts` with
   `await semaphore.acquire()` / `semaphore.release()` in a try/finally.
3. Add unit tests for the `Semaphore` class:
   - Concurrent access up to limit.
   - Queuing beyond limit.
   - Release unblocks waiters in FIFO order.

### Affected Paths

- `src/providers/semaphore.ts` (new)
- `src/providers/concurrent.ts` (refactor)

### Acceptance Criteria

- [ ] No `setTimeout` polling loop remains in `concurrent.ts`.
- [ ] Semaphore tests pass under concurrent load.
- [ ] `npm run check` passes.

---

## 5. Derive Tool Parameters from Schemas (Eliminate Planner Duplication)

**Weakness:** `src/tasks/planner.ts` maintains a manual `TOOL_REQUIRED_PARAMS` map
that duplicates what tool schemas already define. This will silently drift.

**Priority:** P2

**Goal:** Single source of truth for tool parameter requirements.

### Steps

1. Add a `getRequiredParams(toolName: string): string[]` function to the tool
   registry (`src/tools/schemas/registry.ts`) that extracts required parameters
   from the schema definition.
2. Remove the `TOOL_REQUIRED_PARAMS` constant from `src/tasks/planner.ts`.
3. Replace all references to `TOOL_REQUIRED_PARAMS[tool]` with calls to
   `getRequiredParams(tool)`.
4. Add a test that asserts `getRequiredParams` returns the correct fields for
   every registered tool — this acts as a drift detector.

### Affected Paths

- `src/tools/schemas/registry.ts` (extend)
- `src/tasks/planner.ts` (remove duplication)

### Acceptance Criteria

- [ ] `TOOL_REQUIRED_PARAMS` no longer exists in planner.ts.
- [ ] Adding a new tool schema automatically makes its required params available.
- [ ] Drift-detection test passes.
- [ ] `npm run check` passes.

---

## 6. Add Encryption at Rest for Execution Logs

**Weakness:** The execution log and journal are stored as plaintext JSONL. Sensitive
task data is readable by any process with filesystem access.

**Priority:** P0

**Goal:** Encrypt execution logs at rest using a user-held key, while keeping the
append-only JSONL contract intact.

### Steps

1. Add a `src/security/encryption.ts` module:
   - `encrypt(plaintext: string, key: Buffer): string` — AES-256-GCM, returns
     base64-encoded `iv:ciphertext:tag`.
   - `decrypt(encrypted: string, key: Buffer): string` — reverse.
   - Key derivation: `deriveKey(passphrase: string, salt: Buffer): Buffer` via
     `crypto.scryptSync`.
2. Add config in `config/default.yaml`:
   ```yaml
   security:
     encryptJournal: true
     keySource: keychain   # 'keychain' | 'env' | 'file'
   ```
3. Integrate into the journal writer (`src/autonomous/journal.ts`):
   - On write: encrypt each JSONL line before appending.
   - On read: decrypt each line after reading.
   - The file format becomes one base64 blob per line (still line-delimited,
     still append-only).
4. Key management:
   - **macOS Keychain** (preferred): store/retrieve via `security` CLI.
   - **Environment variable** fallback: `CASTERLY_JOURNAL_KEY`.
   - **File** fallback: `~/.casterly/.journal-key` with `0600` permissions.
5. Add a migration script (`scripts/encrypt-existing-journal.ts`) that encrypts
   an existing plaintext journal in place.
6. Add tests:
   - Round-trip encrypt/decrypt.
   - Append-only property preserved (new lines don't invalidate old ones).
   - Graceful error when key is missing (fail-fast, don't write plaintext).

### Affected Paths

- `src/security/encryption.ts` (new)
- `src/autonomous/journal.ts` (integrate encryption)
- `config/default.yaml` (new config keys)
- `config/schema.ts` (extend Zod schema)
- `scripts/encrypt-existing-journal.ts` (new, migration)

### Acceptance Criteria

- [ ] Journal file is not readable without the key.
- [ ] Append-only contract is preserved (each line is independently decryptable).
- [ ] Key stored in macOS Keychain by default.
- [ ] Missing key causes a clear startup error, never silent plaintext fallback.
- [ ] Migration script handles existing journals.
- [ ] `npm run check` passes.

---

## 7. Improve Error Recovery with Backoff and Circuit Breakers

**Weakness:** Fixed 2-retry limit with no backoff and no circuit breaker. Fallback
plan on planning failure is a minimal bash `echo`.

**Priority:** P1

**Goal:** Implement graduated retry with exponential backoff, circuit breakers for
repeatedly failing tools, and meaningful fallback plans.

### Steps

1. Create `src/errors/retry.ts`:
   ```typescript
   export interface RetryOptions {
     maxAttempts: number;
     baseDelayMs: number;
     maxDelayMs: number;
     backoffFactor: number;
     retryableErrors?: (error: unknown) => boolean;
   }
   export async function withRetry<T>(
     fn: () => Promise<T>,
     options: RetryOptions,
   ): Promise<T> { ... }
   ```
2. Create `src/errors/circuit-breaker.ts`:
   ```typescript
   export class CircuitBreaker {
     // States: closed (normal), open (failing, reject fast), half-open (probe)
     // Configurable: failureThreshold, resetTimeoutMs, halfOpenMax
   }
   ```
3. Integrate into `src/tools/executor.ts`:
   - Wrap tool execution in `withRetry` with tool-specific retry config.
   - Wrap each tool in a `CircuitBreaker` instance so that a tool failing 5
     times in a row trips the breaker and returns a clear error instead of
     retrying indefinitely.
4. Integrate into `src/providers/ollama.ts`:
   - Replace the fixed retry logic with `withRetry` using exponential backoff
     (base 1s, factor 2, max 30s).
5. Improve fallback plans in `src/tasks/planner.ts`:
   - When planning fails, generate a diagnostic fallback that explains what
     failed and why, rather than a bare `echo`.
   - Include the error message and suggest manual intervention if appropriate.

### Affected Paths

- `src/errors/retry.ts` (new)
- `src/errors/circuit-breaker.ts` (new)
- `src/tools/executor.ts` (integrate)
- `src/providers/ollama.ts` (replace retry logic)
- `src/tasks/planner.ts` (improve fallback)

### Acceptance Criteria

- [ ] Transient errors are retried with exponential backoff.
- [ ] Permanently broken tools trip the circuit breaker after threshold.
- [ ] Circuit breaker resets after cooldown and probes with a single attempt.
- [ ] Planning fallback provides actionable diagnostic output.
- [ ] `npm run check` passes.

---

## 8. Implement Step-Level LLM Verification

**Weakness:** The `llm_judge` case at step level in `src/tasks/verifier.ts` always
returns `{ verified: true }` with a "deferred" message. Individual steps with
`llm_judge` verification have no actual verification.

**Priority:** P1

**Goal:** Make step-level LLM verification functional so that steps requesting it
actually get judged.

### Steps

1. In `src/tasks/verifier.ts`, implement the step-level `llm_judge` case:
   - Build a verification prompt that includes the step description, expected
     outcome, and actual tool output.
   - Call the primary model with a structured response format:
     `{ verified: boolean, reason: string }`.
   - Parse the response and return the result.
2. Add a cost guard: step-level LLM verification is only invoked when the step
   is marked with `verification: 'llm_judge'` explicitly. Steps without a
   verification strategy default to `output_contains` or `exit_code` as they
   do today.
3. Add a config toggle for step-level verification:
   ```yaml
   verification:
     stepLevelLlmJudge: true
     stepJudgeTimeoutMs: 30000
   ```
4. Add tests:
   - Step passes verification when LLM says yes.
   - Step fails verification when LLM says no.
   - Timeout produces a clear "verification inconclusive" result (not a crash).

### Affected Paths

- `src/tasks/verifier.ts` (implement)
- `config/default.yaml` (new config keys)
- `config/schema.ts` (extend Zod schema)

### Acceptance Criteria

- [ ] Step-level `llm_judge` calls the LLM and returns a real verdict.
- [ ] "Deferred" placeholder is removed.
- [ ] Verification timeout produces a graceful result.
- [ ] `npm run check` passes.

---

## 9. Tighten Typing at Tool Boundaries

**Weakness:** Tool inputs are `Record<string, unknown>` and provider options are
`Record<string, unknown>`. Type safety stops at the interface boundary where it
matters most.

**Priority:** P2

**Goal:** Add runtime validation at tool boundaries using Zod, and improve static
types where possible.

### Steps

1. For each tool executor in `src/tools/executors/`, define a Zod input schema:
   ```typescript
   // e.g., src/tools/executors/read-file.ts
   const ReadFileInput = z.object({
     path: z.string(),
     encoding: z.string().optional(),
   });
   ```
2. Add a `validateInput` step to `src/tools/executor.ts` that runs the Zod
   schema before calling the executor. On failure, return a structured error
   with the validation message (not a raw throw).
3. For provider options, define a `ProviderOptions` Zod schema in
   `src/providers/base.ts` and validate at the provider entry point.
4. Replace `Record<string, unknown>` with the Zod-inferred types in executor
   function signatures:
   ```typescript
   type ReadFileInput = z.infer<typeof ReadFileInput>;
   export async function executeReadFile(input: ReadFileInput): Promise<...>
   ```
5. Add tests that pass malformed inputs and verify structured error responses.

### Affected Paths

- `src/tools/executors/*.ts` (add Zod schemas)
- `src/tools/executor.ts` (add validation step)
- `src/providers/base.ts` (type provider options)

### Acceptance Criteria

- [ ] Every tool executor has a Zod input schema.
- [ ] Malformed tool inputs produce structured validation errors, not crashes.
- [ ] Provider options are validated at entry.
- [ ] `npm run check` passes.

---

## 10. Automate Journal Compaction

**Weakness:** The execution log has a 500-record / 30-day TTL, but `compact()` must
be called explicitly. For an autonomous system, manual maintenance is a design smell.

**Priority:** P2

**Goal:** Compact the journal automatically as part of the agent loop lifecycle.

### Steps

1. Add a `shouldCompact()` method to `src/autonomous/journal.ts`:
   - Returns `true` if record count exceeds threshold OR oldest entry exceeds
     TTL.
   - Read thresholds from config:
     ```yaml
     journal:
       maxRecords: 500
       maxAgeDays: 30
       compactOnStartup: true
     ```
2. Call `shouldCompact()` → `compact()` at two points:
   - **On startup:** in the agent loop initialization (`src/autonomous/loop.ts`),
     before the first cycle. Controlled by `compactOnStartup`.
   - **During dream cycles:** as the first step of the dream runner
     (`src/autonomous/dream/runner.ts`), since dream cycles are explicitly about
     consolidation.
3. Add a `compact()` mode that preserves summary entries:
   - Entries tagged as `summary` or `milestone` are never compacted.
   - Compaction writes a single summary entry for the compacted range.
4. Add tests:
   - `shouldCompact()` returns true/false correctly.
   - `compact()` preserves milestone entries.
   - Compaction produces a valid journal (append-only contract maintained).

### Affected Paths

- `src/autonomous/journal.ts` (extend)
- `src/autonomous/loop.ts` (call on startup)
- `src/autonomous/dream/runner.ts` (call during dream)
- `config/default.yaml` (new config keys)
- `config/schema.ts` (extend Zod schema)

### Acceptance Criteria

- [ ] Journal is compacted automatically on startup when over threshold.
- [ ] Milestone/summary entries survive compaction.
- [ ] Compaction produces a summary entry for the removed range.
- [ ] No manual invocation required for normal operation.
- [ ] `npm run check` passes.

---

## Implementation Order

The recommended sequence balances risk, dependencies, and effort:

| Phase | Items | Rationale |
|-------|-------|-----------|
| **Phase 1 — Security** | #6 (encryption), #2 (semantic detection) | P0 items. Core to the privacy promise. |
| **Phase 2 — Correctness** | #8 (step verification), #7 (error recovery) | P1 items. Fix silent no-ops and fragile retry. |
| **Phase 3 — Integration** | #1A (wire vision stores), #1B (message_user), #1C (dream scheduling), #3 (CI/CD) | P1 items. Complete the autonomous stack and prevent regressions. |
| **Phase 4 — Cleanup** | #1D (retire legacy path), #4 (semaphore), #5 (schema dedup) | P2 items. Remove dead code and duplication. |
| **Phase 5 — Hygiene** | #9 (typed boundaries), #10 (auto-compact) | P2 items. Reduce maintenance burden. |

Phase 3 has an internal dependency: wire vision stores (1A) before dream
scheduling (1C), since dream cycles use challenge and prompt-evolution tools.
Retire the legacy path (1D) last because it requires all other integration to
be stable first.

Each phase should end with a full `npm run check` pass and a tagged commit.

---

## Tracking

Progress on this plan should be tracked in `config/backlog.yaml` by adding entries
`bl-010` through `bl-022` with references back to this document. The autonomous loop
can then pick up items as part of its normal backlog processing.
