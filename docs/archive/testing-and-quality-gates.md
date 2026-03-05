# Testing & Quality Gates

> **Source**: `tests/`, `scripts/`, `src/autonomous/validator.ts`, `src/testing/`

Casterly enforces quality through a multi-layer gate system. Every change — whether from a human or the autonomous agent — must pass all gates before integration.

## Quality Gates Command

The master command that runs all gates in sequence:

```bash
npm run check
```

This executes:

```
guardrails → lint → typecheck → test → security:scan
```

If any gate fails, the pipeline stops. The autonomous agent runs this after every change via its `run_tests`, `typecheck`, and `lint` tools, and the `Validator` class runs the full invariant suite.

## Gate 1: Protected Path Guardrails

> **Source**: `scripts/guardrails.mjs`

```bash
npm run guardrails
```

Prevents unauthorized modification of critical files. Checks all staged and unstaged changes against a protected path list:

| Protected Path | Why |
|----------------|-----|
| `docs/rulebook.md` | Core operating rules |
| `docs/subagents.md` | Subagent flow documentation |
| `src/security/` | Security modules |
| `src/router/classifier.ts` | Routing logic |
| `src/providers/` | Provider implementations |
| `config/` | All configuration files |
| `.env`, `.env.*` | Environment secrets |
| `scripts/guardrails.mjs` | Self-protection |

### Behavior

- Reads `git diff --name-only` for both staged and unstaged changes
- Checks each changed file against the protected prefix list
- **No protected changes**: exits 0 (pass)
- **Protected changes detected**: exits 1 (fail)
- **Override**: set `ALLOW_PROTECTED_CHANGES=1` to bypass (logs which files were changed)
- **No git available**: exits 0 (skips check gracefully)

## Gate 2: Lint

> **Source**: `scripts/lint.mjs`

```bash
npm run lint
```

Custom linter that scans all `.ts` files under `src/` and `tests/` for:

| Check | Description |
|-------|-------------|
| `@ts-ignore` | Banned — must use proper typing |
| `console.log` | Banned outside allowed files — must use `safeLogger` |
| Trailing whitespace | Banned on every line |

### Allowed `console.log` Files

Only these files may use `console.log` directly:

| File | Reason |
|------|--------|
| `src/logging/safe-logger.ts` | The logger itself |
| `src/interfaces/cli.ts` | CLI output |
| `src/index.ts` | Entry point |
| `src/test-cli.ts` | Test CLI |
| `src/autonomous/loop.ts` | Daemon output |
| `src/benchmark-cli.ts` | Benchmark CLI output |
| `src/terminal-repl.ts` | Terminal REPL output |
| `src/autonomous/debug.ts` | Debug tracer (applies redaction first) |
| `tests/validation-parser.test.ts` | Test fixtures contain console.log strings |

## Gate 3: TypeScript Typecheck

```bash
npm run typecheck    # tsc --noEmit
```

Full TypeScript compilation check with strict settings:

| Setting | Value | Purpose |
|---------|-------|---------|
| `strict` | `true` | Enable all strict type checks |
| `noUncheckedIndexedAccess` | `true` | Index signatures return `T \| undefined` |
| `exactOptionalPropertyTypes` | `true` | Distinguish `undefined` from missing |
| `verbatimModuleSyntax` | `true` | Enforce explicit `import type` |
| `isolatedModules` | `true` | Each file must be independently compilable |
| `target` | `es2022` | Modern JavaScript target |
| `module` | `nodenext` | Node.js ESM resolution |

Covers `src/`, `tests/`, and `scripts/`.

## Gate 4: Tests

```bash
npm run test    # vitest run
```

### Test Framework

- **Runner**: Vitest v4 with `node` environment
- **Pattern**: `tests/**/*.test.ts`
- **Globals**: `true` (describe, it, expect available without imports)
- **Coverage**: V8 provider, `text` + `json-summary` reporters
- **Coverage scope**: `src/**/*.ts` (excludes `*.d.ts` and `*/types.ts`)

### Test Suite (~100 test files)

Tests are organized by module area:

| Area | Example Tests |
|------|--------------|
| **Providers** | `provider-base.test.ts` |
| **Tools** | `tool-registry.test.ts`, `tool-schemas.test.ts`, `tool-orchestrator.test.ts`, `tool-filter.test.ts` |
| **Tool executors** | `read-file-executor.test.ts`, `write-file-executor.test.ts`, `bash-executor.test.ts`, `grep-files-executor.test.ts`, `glob-files-executor.test.ts`, `search-files-executor.test.ts`, `validate-files-executor.test.ts`, `list-files-executor.test.ts`, `http-get-executor.test.ts`, `send-message-executor.test.ts` |
| **Pipeline** | `task-planner.test.ts`, `task-runner.test.ts`, `task-verifier.test.ts`, `planner-tool-params.test.ts` |
| **Interface** | `interface-bootstrap.test.ts`, `interface-bootstrap-memory.test.ts`, `interface-context-profiles.test.ts`, `prompt-builder.test.ts` |
| **Session** | `session-manager.test.ts`, `session-memory-manager.test.ts`, `session-memory-persistence.test.ts` |
| **Skills** | `skills-loader.test.ts`, `skills-registry.test.ts` |
| **Autonomous** | `autonomous-loop.test.ts`, `autonomous-provider.test.ts`, `autonomous-controller.test.ts`, `autonomous-validator.test.ts`, `autonomous-approval.test.ts`, `autonomous-reflector.test.ts`, `autonomous-backlog.test.ts`, `autonomous-context-manager.test.ts` |
| **Agent** | `agent-loop.test.ts`, `agent-tools.test.ts`, `identity.test.ts`, `journal.test.ts`, `memory-config.test.ts`, `crystal-store.test.ts`, `constitution-store.test.ts`, `trace-replay.test.ts`, `prompt-store.test.ts`, `shadow-store.test.ts`, `tool-synthesizer.test.ts`, `challenge-generator.test.ts`, `prompt-evolution.test.ts`, `lora-trainer.test.ts`, `roadmap-tools.test.ts`, `embedding-provider.test.ts`, `semaphore.test.ts`, `hybrid-recall.test.ts` |
| **Events** | `events.test.ts`, `watchers.test.ts`, `trigger-router.test.ts` |
| **Coding** | `coding-tools.test.ts`, `coding-read.test.ts`, `coding-write.test.ts`, `coding-edit.test.ts`, `coding-grep.test.ts`, `coding-glob.test.ts`, `mode-definitions.test.ts` |
| **Benchmarks** | `benchmark-suite.test.ts`, `benchmark-scorer.test.ts`, `benchmark-judge.test.ts`, `benchmark-store.test.ts`, `benchmark-report.test.ts`, `benchmark-agent-suite.test.ts`, `benchmark-agent-scorer.test.ts` |
| **Documents** | `document-csv.test.ts`, `document-pdf.test.ts`, `document-xlsx.test.ts`, `read-document.test.ts`, `mime-detection.test.ts` |
| **Extractors** | `typescript-extractor.test.ts`, `python-extractor.test.ts`, `go-extractor.test.ts`, `rust-extractor.test.ts` |
| **Scheduler** | `scheduler-trigger.test.ts`, `scheduler-checker.test.ts`, `scheduler-store.test.ts`, `scheduler-cron.test.ts`, `scheduler-cron-trigger.test.ts` |
| **Security** | `input-guard.test.ts`, `redactor.test.ts`, `safe-logger.test.ts` |
| **Config** | `config-schema.test.ts`, `model-profiles.test.ts` |
| **Other** | `error-codes.test.ts`, `token-counter.test.ts`, `message-utils.test.ts`, `budget-allocator.test.ts`, `auto-context.test.ts`, `repo-map-builder.test.ts`, `inspector.test.ts`, `trace-collector.test.ts`, `user-model.test.ts`, `dream-communication.test.ts`, `git-operations.test.ts`, `execution-log.test.ts`, `test-cases.test.ts` |
| **Integration** | `integration-config-validation.test.ts`, `integration-system-health.test.ts`, `integration-autonomous-cycle.test.ts`, `integration-phase-system.test.ts`, `integration-vision-traits.test.ts` |

### Test Patterns

Tests follow consistent conventions:

```typescript
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

describe('ModuleName', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'test-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true });
  });

  it('does specific behavior', () => {
    // Arrange → Act → Assert
  });
});
```

Key patterns:
- Temporary directories for filesystem tests (`mkdtemp` + cleanup in `afterEach`)
- `vi.spyOn` for mocking (console, fs, exec)
- No live LLM calls — provider responses are mocked
- Test fixtures inline or via temp files

### Coverage

```bash
npm run test:coverage    # vitest run --coverage
```

Coverage reports:
- `text` — terminal table output
- `json-summary` — machine-readable JSON at `coverage/`

Coverage targets: `src/**/*.ts`, excluding type-only files.

## Gate 5: Security Scan

> **Source**: `scripts/security-scan.mjs`

```bash
npm run security:scan
```

Two checks:

### npm Audit

```bash
npm audit --audit-level=high
```

Fails on any high-severity vulnerability in dependencies.

### Console.log Enforcement

Duplicate of the lint check — scans `src/` for `console.log` outside allowed files. Routes all logging through `src/logging/safe-logger.ts` to ensure sensitive data is redacted before output.

## Autonomous Validator

> **Source**: `src/autonomous/validator.ts`

The `Validator` class runs the full quality gate suite programmatically during autonomous improvement cycles.

### Default Invariants

| Invariant | Command | Description |
|-----------|---------|-------------|
| `quality_gates` | `npm run check` | All quality gates must pass |
| `no_type_errors` | `npm run typecheck` | TypeScript compilation must succeed |
| `tests_pass` | `npm run test` | All tests must pass |

Additional invariants can be configured in `config/autonomous.yaml`:

| Invariant | Command | Description |
|-----------|---------|-------------|
| `protected_paths` | `node scripts/guardrails.mjs` | Protected paths must remain unchanged |

### Validation Flow

```
1. Snapshot coverage percentage (before)
2. Run all invariants (npm run check, etc.)
3. Run structured test pass (vitest --reporter=json)
4. Parse test results (pass/fail/skip counts, failure details)
5. Compute coverage delta (after - before)
6. Return ValidationResult
```

### ValidationResult

| Field | Description |
|-------|-------------|
| `passed` | Overall pass/fail |
| `invariantsHold` | All invariants passed |
| `testsPassed` | All tests passed |
| `testsRun` | Total test count |
| `testsFailed` | Number of failures |
| `errors` | Error messages |
| `warnings` | Warning messages |
| `metrics.testDurationMs` | Test execution time |

### Timeout

Default: 300,000ms (5 minutes) for the full validation run. Configurable per instance.

## Test Parser

> **Source**: `src/autonomous/test-parser.ts`

Pure functions for parsing Vitest and coverage output:

| Function | Input | Output |
|----------|-------|--------|
| `parseVitestJson(json)` | Vitest JSON reporter output | `ParsedTestResults` (summary, per-file results, failures) |
| `parseCoverageSummary(json)` | V8 coverage JSON summary | `CoverageSummary` (totals, per-file coverage) |
| `computeCoverageDelta(before, after)` | Two coverage percentages | Delta value |

### ParsedTestResults

```typescript
interface ParsedTestResults {
  success: boolean;
  summary: { total, passed, failed, skipped, durationMs };
  testFiles: Array<{ path, total, passed, failed }>;
  failures: Array<{ testFile, testName, suiteName, message, stack, durationMs }>;
}
```

## Testable Runner

> **Source**: `src/testing/testable-runner.ts`

A wrapper around the full processing pipeline for integration testing and debugging. Creates a complete runtime environment with:

- Config loading
- Provider setup
- Skill registry
- Session manager
- Tool registry + orchestrator
- Trace collection

### Usage

```typescript
const runner = createTestableRunner({
  enableTools: true,
  maxToolIterations: 5,
  autoApproveBash: true,
});
const response = await runner.processRequest('Your prompt here', traceCollector);
```

The trace collector captures events for every phase: provider selection, context assembly, LLM requests, tool calls, tool execution, and response completion.

## NPM Scripts Summary

| Script | Command | Purpose |
|--------|---------|---------|
| `npm run check` | Full quality gates | **The master gate** — run after every change |
| `npm run guardrails` | Protected path check | Prevent unauthorized changes to critical files |
| `npm run lint` | Custom linter | `@ts-ignore`, `console.log`, trailing whitespace |
| `npm run typecheck` | `tsc --noEmit` | TypeScript compilation |
| `npm run test` | `vitest run` | Run all tests |
| `npm run test:coverage` | `vitest run --coverage` | Tests with V8 coverage |
| `npm run test:e2e` | `tsx src/test-cli.ts` | End-to-end test CLI |
| `npm run test:trace` | `tsx src/test-cli.ts --trace` | E2E with trace output |
| `npm run test:interactive` | `tsx src/test-cli.ts --interactive` | Interactive test mode |
| `npm run security:scan` | Security checks | npm audit + console.log enforcement |
| `npm run benchmark` | `tsx src/benchmark-cli.ts run` | Run benchmarks |
| `npm run benchmark:compare` | `tsx src/benchmark-cli.ts compare` | Compare benchmark results |
| `npm run build` | `tsc -p tsconfig.json` | Compile TypeScript |
| `npm run inspect` | `tsx src/debug/inspector.ts` | Debug inspector |

## Key Files

| File | Purpose |
|------|---------|
| `scripts/guardrails.mjs` | Protected path guardrails |
| `scripts/lint.mjs` | Custom linter (ts-ignore, console.log, whitespace) |
| `scripts/security-scan.mjs` | npm audit + console.log enforcement |
| `src/autonomous/validator.ts` | Programmatic validation for autonomous loop |
| `src/autonomous/test-parser.ts` | Vitest JSON + coverage parsers |
| `src/testing/testable-runner.ts` | Integration test runner with trace collection |
| `vitest.config.ts` | Vitest configuration |
| `tsconfig.json` | TypeScript compiler configuration |
| `package.json` | NPM scripts and dependencies |
