# Casterly Rulebook

This file defines the architecture and security invariants that must remain true as the project evolves. Treat these as non-negotiable unless the user explicitly asks to change them.

For the philosophical foundation behind these rules, see [vision.md](vision.md).

## Architecture Invariants

1. All inference is local via Ollama. No cloud APIs.
2. Provider integrations sit behind a stable, minimal `LlmProvider` interface.
3. Security and redaction logic are centralized in `src/security/*`.
4. Logging goes through the privacy-safe logger (`src/logging/safe-logger.ts`), never direct `console.log` for user data.
5. Configuration is validated at startup via Zod schemas and fails fast on invalid or unsafe settings.
6. Model selection is task-based (coding vs primary) via `config/models.yaml`.
7. The agent loop is the single execution path. No separate interactive/autonomous code paths.
8. The journal is append-only. Entries are never deleted, only compressed during dream cycles.
9. Delegation is transparent. Every delegated call is logged and reviewable.

## Security Invariants

1. All user data stays on the local machine.
2. Redaction is the default for any user-provided text in logs.
3. Secrets (API keys, tokens, credentials) are never logged or echoed.
4. Privacy-critical behavior is covered by unit tests.
5. Guardrails flag changes to critical privacy modules and sensitive paths.
6. The user model is local-only and never logged raw -- it is derived, not stored verbatim.

## Sensitive Data Categories

These categories are handled with particular care (all stay local by design):

1. Calendar and schedules
2. Financial information and transactions
3. Health and medical information
4. Credentials, passwords, secrets, or API keys
5. Private notes, journals, voice memos, or documents
6. Personal contacts and relationships

## Protected Paths

Changes to these paths are high risk and must be called out explicitly. The guardrails script treats them as protected by default.

- `docs/rulebook.md`
- `docs/subagents.md`
- `src/security/*`
- `src/tasks/classifier.ts`
- `src/providers/*`
- `config/*`
- `.env` and `.env.*`
- `scripts/guardrails.mjs`

## Required Development Workflow

1. Read this rulebook and the relevant module source before making changes.
2. Use the System Architect subagent to confirm the approach for cross-cutting changes.
3. Implement with clear boundaries and minimal surface area.
4. Add or update tests for any behavior change.
5. Run `npm run check` before finishing.
6. If guardrails fail, either revert the risky changes or set `ALLOW_PROTECTED_CHANGES=1` intentionally.

## Definition of Done

A change is done only when:

1. The change respects all invariants above.
2. Tests cover the new or modified behavior.
3. `npm run check` passes locally.
4. Any remaining risk is called out explicitly in the final summary.
