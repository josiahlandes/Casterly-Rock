# AGENTS.md — Casterly Contributor Rules

This file defines repository-local instructions for coding agents working on Casterly.

## Required Context

1. Read `docs/rulebook.md` before making changes.
2. Use `docs/subagents.md` to choose the right role flow.
3. Preserve the local-first privacy invariants.

## Protected Paths

Treat these paths as high risk:

1. `src/security/*`
2. `src/router/classifier.ts`
3. `src/providers/*`
4. `config/*`
5. `.env` and `.env.*`
6. `docs/rulebook.md`
7. `docs/subagents.md`
8. `scripts/guardrails.mjs`

If you must change them, say so explicitly and run the full gates.

## Quality Gates

1. Run `npm run check` after changes.
2. Expect `npm run typecheck` to be slow in this environment.
3. Do not mark work complete if gates are failing.

## Code Standards

1. Keep code explicit and readable.
2. Centralize privacy logic in `src/security/*`.
3. Keep provider-specific logic in `src/providers/*`.
4. Route all logging through `src/logging/safe-logger.ts`.
