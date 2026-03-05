# Security & Privacy

> **Source**: `src/security/`, `src/logging/safe-logger.ts`, `src/imessage/input-guard.ts`, `src/tools/executor.ts`

Casterly is local-first and privacy-first. All LLM inference runs on-device through Ollama. No data ever leaves the machine. Security is defense-in-depth across five layers.

## Security Layers

```
Inbound Message
    │
    ▼
┌──────────────────────┐
│  1. Input Guard      │  Size limit, rate limit, injection detection
└──────────┬───────────┘
           ▼
┌──────────────────────┐
│  2. Sensitive Detect  │  Category detection (flags, doesn't block)
└──────────┬───────────┘
           ▼
       [ LLM call ]
           ▼
┌──────────────────────┐
│  3. Tool Executor    │  Command safety gates (BLOCKED / APPROVAL / SAFE)
└──────────┬───────────┘
           ▼
┌──────────────────────┐
│  4. Output Sanitizer │  Injection detection in tool results, fence web content
└──────────┬───────────┘
           ▼
┌──────────────────────┐
│  5. Safe Logger      │  Redact all sensitive text before logging
└──────────────────────┘
```

## Sensitive Data Categories

> **Source**: `src/security/patterns.ts`

| Category | Examples | Handling |
|----------|---------|----------|
| `calendar` | "my calendar", "schedule" | Detect, flag, keep local |
| `finances` | SSN patterns, "credit card", "bank account" | Detect, redact from logs |
| `voice_memos` | "voice memo", "journal", "private note" | Detect, flag |
| `health` | "diagnosis", "prescription", "medical" | Detect, flag |
| `credentials` | "password", "api_key", bearer tokens | Detect, redact, never log |
| `documents` | "contract", "confidential", "NDA" | Detect, flag |
| `contacts` | "my contact", "phone number" | Detect, flag |
| `location` | "my location", "GPS", lat/lon pairs | Detect, flag, keep local |

All 8 categories configured as `sensitivity.alwaysLocal` in config.

## Input Guard (Pre-LLM)

> **Source**: `src/imessage/input-guard.ts`

Deterministic regex checks before any message reaches the LLM:

1. **Size limit** — Block messages > 10,000 characters
2. **Control chars** — Strip C0 controls (except tab, newline, CR)
3. **Rate limit** — Max 20 messages per 60 seconds per sender
4. **Injection detection** — 10 pattern categories: instruction-override, role-hijack, mode-switch, prompt-extraction, DAN-jailbreak, XML/bracket/markdown system tags, base64 blobs, hex sequences
5. **Sensitive content** — Non-blocking warnings for all 8 categories

## Command Safety Gates

> **Source**: `src/tools/executor.ts`

| Tier | Examples | Behavior |
|------|----------|----------|
| **BLOCKED** | `rm -rf /`, `mkfs`, `dd if=`, fork bombs, `curl \| sh` | Always rejected |
| **APPROVAL** | `rm`, `sudo`, `chmod`, `kill`, `shutdown`, `osascript (System Events)` | Needs user approval |
| **SAFE** | `echo`, `cat`, `ls`, `grep`, `find`, `git`, `curl`, `jq` | Always allowed |

Even safe commands are reclassified as APPROVAL if piped to `sh`/`bash`/`zsh`.

## Redaction

> **Source**: `src/security/redactor.ts`

`redactSensitiveText()` replaces all matches from the 8 categories plus secret-like patterns (SSN, API key prefixes, bearer tokens) with `[REDACTED]`. Applied automatically by the safe logger on every log message.

## Output Sanitizer

> **Source**: `src/security/tool-output-sanitizer.ts`

For web content (`http_get`): detect injection patterns, strip dangerous content, fence all output in `--- BEGIN UNTRUSTED WEB CONTENT ---` boundary.

For non-web tools: detect and prefix with warning if injection patterns found.

## Agent Path Safety

> **Source**: `src/autonomous/agent-tools.ts`

- **Allowed directories**: `src/`, `scripts/`, `tests/`, `config/`, `skills/`
- **Forbidden patterns**: `**/*.env*`, `**/credentials*`, `**/secrets*`, `**/.git/**`
- Agent's `bash` tool blocks: `rm -rf`, `mkfs`, `dd`, `shutdown`, `sudo rm`, `git push --force`, `git reset --hard`

## Protected Path Guardrails

> **Source**: `scripts/guardrails.mjs`

Blocks changes to critical files unless `ALLOW_PROTECTED_CHANGES=1`:

`docs/rulebook.md`, `docs/subagents.md`, `src/security/`, `src/tasks/classifier.ts`, `src/providers/`, `config/`, `.env*`, `scripts/guardrails.mjs`

## Autonomous Safety

> **Source**: `src/autonomous/validator.ts`, `config/autonomous.yaml`

After every autonomous change, the validator runs quality gates. If any fail, the change is reverted:

- `npm run check` (all gates)
- `npm run typecheck` (no type errors)
- `npm run test` (no broken tests)

Scope limits: max 5 files per change, max 3 concurrent branches, 300s timeout.

## Local-Only Enforcement

- Only `OllamaProvider` (kind: `local`)
- Only network activity: localhost Ollama at `http://localhost:11434`
- No outbound HTTP to external AI APIs
- All models in `ConcurrentProvider` are local Ollama instances

## Key Files

| File | Purpose |
|------|---------|
| `src/security/patterns.ts` | 8 sensitive categories with regex patterns |
| `src/security/detector.ts` | `detectSensitiveContent()` |
| `src/security/redactor.ts` | `redactSensitiveText()` |
| `src/security/tool-output-sanitizer.ts` | Injection detection + fencing |
| `src/imessage/input-guard.ts` | Pre-LLM message filtering |
| `src/tools/executor.ts` | Command safety gates |
| `src/logging/safe-logger.ts` | Privacy-safe logging |
| `scripts/guardrails.mjs` | Protected path enforcement |
| `scripts/security-scan.mjs` | npm audit + console.log enforcement |
| `src/autonomous/validator.ts` | Post-change validation |
