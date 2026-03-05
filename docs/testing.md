# Testing & Quality Gates

> **Source**: `tests/`, `scripts/`, `src/autonomous/validator.ts`

Every change — human or autonomous — must pass all quality gates before integration.

## Quality Gates

```bash
npm run check    # Runs all 5 gates in sequence
```

```
guardrails → lint → typecheck → test → security:scan
```

### Gate 1: Protected Path Guardrails

```bash
npm run guardrails
```

Blocks changes to critical files unless `ALLOW_PROTECTED_CHANGES=1` is set. See [security-and-privacy.md](security-and-privacy.md) for the protected paths list.

### Gate 2: Lint

```bash
npm run lint
```

Custom linter scanning `src/` and `tests/` for:
- `@ts-ignore` (banned — use proper typing)
- `console.log` outside allowed files (must use `safeLogger`)
- Trailing whitespace

### Gate 3: TypeScript Typecheck

```bash
npm run typecheck    # tsc --noEmit
```

Strict mode with `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, and `isolatedModules`.

### Gate 4: Tests

```bash
npm run test    # vitest run
```

~100 test files organized by module area (providers, tools, agent, security, config, coding, benchmarks, etc.). Uses Vitest v4 with V8 coverage.

Test patterns:
- Temporary directories for filesystem tests (`mkdtemp` + cleanup)
- `vi.spyOn` for mocking (no live LLM calls)
- Arrange → Act → Assert structure

### Gate 5: Security Scan

```bash
npm run security:scan
```

- `npm audit` at `high` severity
- `console.log` enforcement (duplicate of lint check for defense-in-depth)

## Autonomous Validator

> **Source**: `src/autonomous/validator.ts`

Runs quality gates programmatically during autonomous cycles:

1. Snapshot coverage before
2. Run all invariants (`npm run check`, `npm run typecheck`, `npm run test`)
3. Run structured test pass (Vitest JSON reporter)
4. Parse results (pass/fail/skip, failure details)
5. Compute coverage delta
6. Return `ValidationResult` with pass/fail and diagnostics

Timeout: 300s for full validation.

## NPM Scripts

| Script | Purpose |
|--------|---------|
| `npm run check` | **Master gate** — all 5 gates |
| `npm run guardrails` | Protected path check |
| `npm run lint` | Custom linter |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run test` | `vitest run` |
| `npm run test:coverage` | Tests with V8 coverage |
| `npm run security:scan` | npm audit + console.log check |
| `npm run build` | Compile TypeScript |
| `npm run benchmark` | Run benchmarks |
| `npm run benchmark:compare` | Compare benchmark results |
