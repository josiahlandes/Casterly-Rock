# CLAUDE.md — Project Operating Rules

If you are Claude Code working in this repository, follow these rules on every task.

## First Principles

1. Casterly is local-first and privacy-first.
2. Sensitive data never goes to the cloud.
3. When unsure, route locally and ask for clarification.

## Mandatory Reading

1. Read `docs/rulebook.md` before making changes.
2. Use `docs/subagents.md` to choose the right role flow.

## Guardrails

1. Treat the following as protected paths: `src/security/*`, `src/tasks/classifier.ts`, `src/providers/*`, `config/*`, `.env*`, `docs/rulebook.md`, `docs/subagents.md`, `scripts/guardrails.mjs`.
2. Do not change protected paths unless the user’s request requires it.
3. If you must change protected paths, state it clearly and run the full quality gates.

## Quality Gates (Required)

1. After changes, run: `npm run check`.
2. If any gate fails, fix it or explain exactly what is blocked.

## Implementation Standards

1. Prefer small, explicit, and readable code.
2. Keep provider-specific logic inside provider modules.
3. Ensure routing decisions are structured and testable.
4. Never log raw sensitive user content.

## Subagent Flow

Use this default sequence unless the task is trivial:

1. System Architect
2. Relevant Implementer Specialist
3. Security Reviewer
4. Test Engineer
5. Quality Gates Enforcer
