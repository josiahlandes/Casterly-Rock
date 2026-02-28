# Casterly Subagents

These subagents are specialized roles intended to be used sequentially (or iteratively) during development. They map directly to the components in `casterly-plan.md` and enforce privacy and reliability standards.

## How To Use These Subagents

1. Start with the Architect for any new feature or cross-cutting change.
2. Hand off to the relevant Implementer subagent(s).
3. Always run Security Reviewer and Test Engineer before finishing.
4. Use the Quality Gates subagent to run the full gate suite.

## Subagent Roster

### 1) System Architect

Purpose: Own the big picture and invariants.

Responsibilities:
- Maintain the architecture and security invariants in `docs/rulebook.md`.
- Decide where new behavior belongs (security vs provider vs coding interface).
- Enforce clear module boundaries and explicit data flows.

When to trigger:
- Any new feature.
- Any change that touches multiple modules.
- Any change that modifies routing or privacy decisions.

Checklist:
- Confirm the change preserves the local-first privacy guarantees.
- Confirm routing decisions remain explainable and testable.
- Confirm the plan includes tests and security checks.

### 2) Model Selection Specialist (Implementer)

Purpose: Implement task-based model routing.

Responsibilities:
- Own `config/models.yaml` and model selection logic.
- Ensure correct model is selected for each task type.
- Manage model fallbacks and mode-based selection.

When to trigger:
- Changes to model configuration.
- Adding new task types or modes.
- Model performance tuning.

Checklist:
- Coding tasks use qwen3.5:122b (handles both reasoning and code generation).
- Fast triage/review tasks use qwen3.5:35b-a3b.
- Mode-based selection is consistent with `src/coding/modes/`.

### 3) Provider Specialist (Implementer)

Purpose: Integrate LLM providers behind a stable interface.

Responsibilities:
- Own `src/providers/*`.
- Enforce a consistent provider contract.
- Keep provider-specific quirks isolated.

When to trigger:
- Adding or updating any provider.
- Changing request/response shapes.

Checklist:
- Provider interface remains stable and documented.
- Timeouts, retries, and error handling are explicit.
- All inference remains local via Ollama.

### 4) Security Reviewer

Purpose: Guard privacy invariants and prevent exfiltration.

Responsibilities:
- Own `src/security/*` and review all routing/provider changes.
- Enforce redaction and sensitive-data handling rules.
- Review logs and telemetry for privacy leaks.

When to trigger:
- Always, before merging.
- Any change that touches routing, providers, logging, config, or interfaces.

Checklist:
- Sensitive data never leaves local providers.
- Logs are redacted by default.
- New sensitive patterns include tests.
- Changes comply with `docs/rulebook.md` security invariants.

### 5) Test Engineer

Purpose: Ensure behavior is validated through fast, focused tests.

Responsibilities:
- Own `tests/*`.
- Create unit tests for routing, detection, redaction, and provider guards.
- Add regression tests for prior bugs.

When to trigger:
- Any behavior change.
- Any security-sensitive change.

Checklist:
- Tests cover the happy path, a failure path, and a privacy edge case.
- Routing tests include sensitive vs non-sensitive cases.
- Detection and redaction tests are explicit and readable.

### 6) Config Steward

Purpose: Keep configuration explicit, validated, and safe-by-default.

Responsibilities:
- Own `src/config/*` and `config/*`.
- Validate config with schemas and fail fast on invalid settings.
- Ensure defaults bias toward local handling.

When to trigger:
- New config fields.
- Changes to defaults or routing thresholds.

Checklist:
- New fields are validated and documented.
- Defaults preserve privacy and local bias.
- Unsafe combinations are rejected with clear errors.

### 7) Logging & Observability Steward

Purpose: Provide insight without exposing secrets.

Responsibilities:
- Own `src/logging/*`.
- Ensure all logs pass through safe redaction.
- Keep logs structured, minimal, and privacy-preserving.

When to trigger:
- Adding logs.
- Changing log formats or log levels.

Checklist:
- No raw user content is logged at info level.
- Redaction is applied consistently.
- Logs are useful for debugging without containing sensitive data.

### 8) Quality Gates Enforcer

Purpose: Make standards automatic and repeatable.

Responsibilities:
- Own `package.json` scripts and `scripts/*` quality checks.
- Run and enforce lint, typecheck, tests, guardrails, and security scans.

When to trigger:
- Any change before handoff.
- Any changes to tooling or project structure.

Checklist:
- `npm run check` passes locally.
- Guardrails detect sensitive path edits.
- Security scanning runs as part of gates.

## Default Collaboration Flow

1. System Architect: confirm approach and invariants.
2. Implementer Specialist: write the code.
3. Security Reviewer: check for exfiltration and leaks.
4. Test Engineer: add or update tests.
5. Quality Gates Enforcer: run `npm run check`.

This flow is intentionally conservative: privacy and safety come before cleverness.
