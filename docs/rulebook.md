# Casterly Rulebook

This file defines the architecture and security invariants that must remain true as the project evolves. Treat these as non-negotiable unless the user explicitly asks to change them.

## Mission

Casterly is a local-first LLM router. It protects user privacy by default and only sends requests to cloud providers when it is safe and necessary.

## Architecture Invariants

1. Local-first routing bias.
2. Sensitive detection runs before any cloud decision.
3. Routing decisions are explicit, structured, and testable.
4. Provider integrations sit behind a stable, minimal interface.
5. Security and redaction logic are centralized in `src/security/*`.
6. Logging goes through a privacy-safe logger, never direct `console.log` for user data.
7. Configuration is validated at startup and fails fast on invalid or unsafe settings.
8. All external network calls are isolated to provider modules.

## Security Invariants

1. Sensitive user content must never be sent to cloud providers.
2. If routing confidence is low, route locally.
3. Redaction is the default for any user-provided text in logs.
4. Secrets (API keys, tokens, credentials) are never logged or echoed.
5. Privacy-critical behavior is covered by unit tests.
6. Guardrails must flag changes to critical privacy modules and sensitive paths.

## Sensitive Data Categories

These categories are always considered sensitive and must stay local:

1. Calendar and schedules.
2. Financial information and transactions.
3. Health and medical information.
4. Credentials, passwords, secrets, or API keys.
5. Private notes, journals, voice memos, or documents.
6. Personal contacts and relationships.

## Protected Paths And Modules

Changes to the following areas are high risk and should trigger extra caution:

1. `docs/rulebook.md`
2. `docs/subagents.md`
3. `src/security/*`
4. `src/router/classifier.ts`
5. `src/providers/*`
6. `config/*`
7. `.env` and `.env.*`
8. `scripts/guardrails.mjs`

The guardrails script treats these paths as protected by default.

## Required Development Workflow

1. Read this rulebook and the relevant module README or source.
2. Use the System Architect subagent to confirm the approach for cross-cutting changes.
3. Implement with clear boundaries and minimal surface area.
4. Add or update tests for any behavior change.
5. Run `npm run check` before finishing.
6. If guardrails fail, either revert the risky changes or set `ALLOW_PROTECTED_CHANGES=1` intentionally.

## Definition Of Done

A change is done only when all of the following are true:

1. The change respects all invariants above.
2. Tests cover the new or modified behavior.
3. `npm run check` passes locally.
4. Any remaining risk is called out explicitly in the final summary.
