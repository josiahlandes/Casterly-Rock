# Configuration & Environment

> **Source**: `config/`, `src/config/`

Casterly uses YAML configuration files validated at load time by Zod schemas. All config is checked into the repository except secrets (`.env*` files, which are gitignored).

## Configuration Files

| File | Purpose | Validated By |
|------|---------|-------------|
| `config/default.yaml` | Main app config: provider, sensitivity, session, tools, skills, logging, hardware | `src/config/schema.ts` |
| `config/autonomous.yaml` | Autonomous agent: timing, scope, agent loop, events, memory, hardware, dream, communication, git, invariants | `src/autonomous/loop.ts` + `src/autonomous/memory-config.ts` |
| `config/models.yaml` | Model registry: per-role models, task routing, hardware constraints, Ollama settings | Read by model loading code |
| `config/model-profiles.yaml` | Per-model tuning overrides: temperature, token limits, tool-specific hints | Model profile system |
| `config/backlog.yaml` | Feature backlog for autonomous improvement: prioritized items with acceptance criteria | `src/autonomous/analyzer.ts` |

## Main Config (`config/default.yaml`)

### Provider Configuration

```yaml
local:
  provider: ollama
  model: qwen3.5:122b                   # Primary: reasoning + conversation
  codingModel: qwen3-coder-next:latest   # Coding: code gen + review
  baseUrl: http://localhost:11434
  timeoutMs: 120000                      # 2 min (70B models need longer)
```

**Schema** (`src/config/schema.ts`):

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `provider` | `'ollama'` | Yes | Always `ollama` (local-only) |
| `model` | `string` | Yes | Primary Ollama model name |
| `codingModel` | `string?` | No | Separate coding model (creates a second provider if different from `model`) |
| `baseUrl` | URL | Yes | Ollama API endpoint |
| `timeoutMs` | `number?` | No | Request timeout in milliseconds |

### Sensitivity Detection

```yaml
sensitivity:
  alwaysLocal:
    - calendar
    - finances
    - voice_memos
    - health
    - credentials
    - documents
    - contacts
    - location
```

These categories **always** route locally, regardless of LLM classification. This is the privacy guardrail — data in these categories never leaves the machine.

Valid categories: `calendar`, `finances`, `voice_memos`, `health`, `credentials`, `documents`, `contacts`, `location`.

### Session Management

```yaml
session:
  scope: per-peer          # main | per-peer | per-channel
  maxHistoryMessages: 50
  dailyResetHour: 4        # Reset at 4 AM (null to disable)
  basePath: ~/.casterly/sessions
```

### Tools Configuration

```yaml
tools:
  enabled: true
  maxIterations: 5           # Max tool call loops per request
  bash:
    autoApprove: false       # Set true for non-interactive mode
    blockedPatterns:
      - "rm -rf /"
      - ":(){ :|:& };:"     # Fork bomb
      - "dd if=/dev/"
      - "> /dev/sd"
      - "mkfs"
      - "chmod -R 777 /"
```

### Skills Configuration

```yaml
skills:
  paths:
    - ~/.casterly/workspace/skills
    - ./skills
```

### Logging

```yaml
logging:
  level: info              # debug | info | warn | error
  redactSensitive: true    # Always redact sensitive content
```

### Hardware (Phase 5)

```yaml
hardware:
  concurrent_inference: true
  test_time_scaling: true
  adversarial_testing: true
  max_parallel_generations: 4
  bestofn_judge_model: qwen3.5:122b
```

## Config Loading

> **Source**: `src/config/index.ts`

```typescript
function loadConfig(configPath = 'config/default.yaml'): AppConfig
```

1. Reads the YAML file from disk (synchronous `readFileSync`)
2. Parses YAML into a plain object
3. Validates with `appConfigSchema.parse()` (Zod)
4. Returns typed `AppConfig` — throws on validation failure

The validated schema only covers `local` and `sensitivity` sections. Other sections (`session`, `tools`, `skills`, `logging`, `hardware`) are read directly from the parsed YAML by their respective consumers.

## Autonomous Config (`config/autonomous.yaml`)

This is the largest config file, controlling all 7 phases of the autonomous system.

### Core Autonomous Settings

| Key | Default | Description |
|-----|---------|-------------|
| `autonomous.enabled` | `true` | Master switch |
| `autonomous.model` | `qwen3-coder-next:latest` | Model for autonomous improvement |
| `autonomous.cycle_interval_minutes` | `60` | Time between improvement cycles |
| `autonomous.max_cycles_per_day` | `12` | Daily cycle limit |
| `autonomous.quiet_hours.start` | `06:00` | Quiet hours start (stop working) |
| `autonomous.quiet_hours.end` | `22:00` | Quiet hours end (start working) |
| `autonomous.quiet_hours.enabled` | `true` | Quiet hours scheduling preference (soft — LLM prefers consolidation during quiet hours) |

### Scope Controls

| Key | Default | Description |
|-----|---------|-------------|
| `autonomous.max_attempts_per_cycle` | `3` | Max hypotheses attempted per cycle |
| `autonomous.max_files_per_change` | `5` | Max files modified per change |
| `autonomous.allowed_directories` | `[src/, skills/, scripts/, tests/, config/]` | Directories the agent can modify |
| `autonomous.forbidden_patterns` | `[**/*.env*, **/credentials*, **/secrets*, **/.git/**]` | Never-modify patterns |
| `autonomous.backlog_path` | `config/backlog.yaml` | Path to feature backlog |

### Confidence Thresholds

| Key | Default | Description |
|-----|---------|-------------|
| `autonomous.auto_integrate_threshold` | `0.9` | Minimum confidence for auto-merge |
| `autonomous.attempt_threshold` | `0.5` | Minimum confidence to even attempt a hypothesis |

### Resource Limits

| Key | Default | Description |
|-----|---------|-------------|
| `autonomous.max_branch_age_hours` | `24` | Max age for feature branches |
| `autonomous.max_concurrent_branches` | `3` | Max auto/ branches alive |
| `autonomous.sandbox_timeout_seconds` | `300` | Sandbox operation timeout |
| `autonomous.sandbox_memory_mb` | `2048` | Sandbox memory limit |

### Agent Loop

| Key | Default | Description |
|-----|---------|-------------|
| `agent_loop.max_turns` | `200` | Max reasoning turns per cycle (safety ceiling) |
| `agent_loop.max_tokens_per_cycle` | `500000` | Soft token limit for user/goal cycles. Local inference has no cost — set high to allow deep reflection. |
| `agent_loop.max_tokens_per_cycle_background` | `100000` | Moderate budget for background (scheduled/event) cycles |
| `agent_loop.reasoning_model` | `qwen3.5:122b` | Reasoning/planning model |
| `agent_loop.coding_model` | `qwen3-coder-next:latest` | Code generation model |
| `agent_loop.think_tool_enabled` | `true` | Enable explicit reasoning tool |
| `agent_loop.delegation_enabled` | `true` | Enable sub-model delegation |
| `agent_loop.temperature` | `0.2` | Reasoning temperature |
| `agent_loop.max_response_tokens` | `4096` | Per-response token limit |

### Events (Phase 3)

| Key | Default | Description |
|-----|---------|-------------|
| `events.enabled` | `false` | Enable event-driven awareness |
| `events.file_watcher.enabled` | `true` | Watch for file changes |
| `events.file_watcher.debounce_ms` | `500` | Batch rapid file changes |
| `events.git_watcher.enabled` | `true` | Watch for git ref changes |
| `events.git_watcher.poll_interval_ms` | `5000` | Git polling frequency |
| `events.issue_watcher.enabled` | `true` | Watch for stale issues |
| `events.issue_watcher.check_interval_ms` | `21600000` | Issue check frequency (6 hours) |
| `events.cooldown_seconds` | `120` | Min seconds between event-triggered cycles |
| `events.daily_budget_turns` | `200` | Max agent turns per day from events |

### Memory Tiers

| Key | Default | Description |
|-----|---------|-------------|
| `memory_tiers.hot_tier_max_tokens` | `2000` | Identity prompt budget |
| `memory_tiers.warm_tier_max_tokens` | `10000` | Working memory budget |
| `memory_tiers.context_window_tokens` | `40960` | Overall context window (qwen3.5:122b practical max with 128GB unified memory) |
| `memory_tiers.store_base_path` | `~/.casterly/memory` | Cool/cold storage path |
| `memory_tiers.max_cool_entries` | `200` | Max entries before cold promotion |
| `memory_tiers.cool_retention_days` | `30` | Days before cool → cold |
| `memory_tiers.reflections_path` | `~/.casterly/autonomous/reflections` | Cold tier integration |

### Dream Cycles (Phase 6)

| Key | Default | Description |
|-----|---------|-------------|
| `dream_cycles.enabled` | `false` | Enable quiet-hours strategic consolidation |
| `dream_cycles.consolidation_interval_hours` | `24` | Hours between consolidation runs |
| `dream_cycles.exploration_budget_turns` | `50` | Max turns for exploration phase |
| `dream_cycles.self_model_rebuild_interval_hours` | `48` | Self-model rebuild frequency |
| `dream_cycles.archaeology_lookback_days` | `90` | Code archaeology lookback window |
| `dream_cycles.retrospective_interval_days` | `7` | Retrospective writing frequency |

### Communication (Phase 7)

| Key | Default | Description |
|-----|---------|-------------|
| `communication.enabled` | `false` | Enable proactive user messaging |
| `communication.throttle.max_per_hour` | `3` | Max messages per hour |
| `communication.throttle.max_per_day` | `10` | Max messages per day |
| `communication.throttle.quiet_hours` | `true` | Respect quiet hours for messages |
| `communication.test_failure_min_severity` | `unresolvable` | When to notify about test failures |
| `communication.daily_summary_enabled` | `true` | Send daily summary |

### Git Configuration

| Key | Default | Description |
|-----|---------|-------------|
| `git.remote` | `origin` | Remote to push to |
| `git.base_branch` | `main` | Base branch for improvements |
| `git.branch_prefix` | `auto/` | Prefix for auto-generated branches |
| `git.integration_mode` | `approval_required` | Integration strategy |
| `git.cleanup.delete_merged_branches` | `true` | Clean up merged branches |
| `git.cleanup.delete_failed_branches` | `true` | Clean up failed branches |
| `git.cleanup.max_stale_branch_age_hours` | `48` | Max stale branch age |

Integration modes:
- `approval_required` — validate on branch, leave for owner review in morning summary
- `direct` — auto-merge to main after validation (no human review)
- `pull_request` — create a GitHub PR (requires `gh` CLI)

### Safety Invariants

```yaml
invariants:
  - name: quality_gates
    check: "npm run check"
  - name: no_type_errors
    check: "npm run typecheck"
  - name: tests_pass
    check: "npm run test"
  - name: protected_paths
    check: "node scripts/guardrails.mjs"
```

All invariants must pass after every autonomous change.

## Model Registry (`config/models.yaml`)

Defines per-role model assignments and routing:

| Role | Model | Temperature | Purpose |
|------|-------|-------------|---------|
| `coding` | `qwen3-coder-next:latest` | 0.1 | Code gen, refactoring, bug fixes |
| `primary` | `qwen3.5:122b` | 0.6 | Reasoning, planning, conversation |
| `autonomous` | `qwen3-coder-next:latest` | 0.2 | Improvement cycles |
| `specialist` | `tyrion-specialist:latest` | 0.2 | Self-distilled model (Phase 6, disabled) |

### Task-to-Model Routing

```yaml
routing:
  code: coding
  architect: primary
  ask: primary
  review: coding
  analyze: primary
  hypothesize: primary
  implement: coding
  validate: coding
  reflect: primary
```

### Hardware Constraints

```yaml
hardware:
  platform: mac-studio-m4-max
  memory_gb: 128
  max_concurrent_models: 3
  target_memory_usage_pct: 70  # Leave 30% headroom
```

## Memory Configuration Schema

> **Source**: `src/autonomous/memory-config.ts`

Validated by Zod, with sensible defaults for all fields.

### Memory Section

| Field | Default | Description |
|-------|---------|-------------|
| `world_model_path` | `~/.casterly/world-model.yaml` | World model storage |
| `goal_stack_path` | `~/.casterly/goals.yaml` | Goal stack storage |
| `issue_log_path` | `~/.casterly/issues.yaml` | Issue log storage |
| `self_model_path` | `~/.casterly/self-model.yaml` | Self-model storage |
| `update_on_cycle_end` | `true` | Persist after each autonomous cycle |
| `update_on_session_end` | `true` | Persist after each interactive session |
| `max_open_goals` | `20` | Maximum open goals |
| `max_open_issues` | `50` | Maximum open issues |
| `stale_days` | `7` | Days before stale flag |
| `max_activity_entries` | `50` | Activity history depth |
| `max_concerns` | `30` | World model concern limit |

### Identity Section

| Field | Default | Description |
|-------|---------|-------------|
| `max_chars` | `8000` | Identity prompt character budget |
| `include_self_model` | `true` | Include self-model in identity |
| `max_goals_in_prompt` | `5` | Goals shown in identity prompt |
| `max_issues_in_prompt` | `5` | Issues shown in identity prompt |
| `max_activities_in_prompt` | `5` | Activities shown in identity prompt |

### Debug Section

| Field | Default | Description |
|-------|---------|-------------|
| `enabled` | `true` | Master debug switch |
| `level` | `debug` | `trace` / `debug` / `info` / `warn` / `error` |
| `timestamps` | `true` | Include timestamps |
| `durations` | `true` | Include span durations |
| `log_to_file` | `false` | Write to debug log file |
| `log_file_path` | `~/.casterly/autonomous/debug.log` | Debug log path |
| `subsystems` | `{}` | Per-subsystem enable/disable |

## Context Profiles

> **Source**: `src/interface/context-profiles.ts`

Each pipeline stage has a context profile that controls token budgets, prompt sections, and generation parameters:

| Profile | Max Context | Reserve | History | Temperature | Max Tokens | Sections |
|---------|-------------|---------|---------|-------------|------------|----------|
| `conversation` | 3,500 | 500 | 10 msgs | 0.7 | 2,048 | All |
| `classifier` | 1,024 | 256 | 3 msgs | 0.1 | 256 | None |
| `planner` | 2,048 | 2,048 | 0 | 0.2 | 2,048 | Safety only |
| `executor` | 1,536 | 512 | 0 | 0.1 | 512 | Safety only |
| `verifier` | 1,536 | 512 | 0 | 0.1 | 512 | None |

Prompt sections available: `identity`, `bootstrap`, `capabilities`, `skills`, `memory`, `safety`, `context`, `guidelines`.

## Feature Backlog (`config/backlog.yaml`)

The autonomous agent reads this file for owner-requested feature work. Each item has:

| Field | Description |
|-------|-------------|
| `id` | Unique ID (e.g. `bl-001`) |
| `title` | Short description |
| `description` | Detailed requirements |
| `priority` | 1 (highest) to 5 (lowest) |
| `approach` | `add_feature` / `fix_bug` / `refactor` / etc. |
| `affectedAreas` | Which directories are involved |
| `acceptanceCriteria` | Checklist for "done" |
| `status` | `pending` / `in_progress` / `completed` / `failed` |

## Persistent State Paths

All persistent state lives under `~/.casterly/`:

| Path | Content |
|------|---------|
| `~/.casterly/sessions/` | Conversation session history |
| `~/.casterly/world-model.yaml` | Codebase health, activity, concerns |
| `~/.casterly/goals.yaml` | Goal stack |
| `~/.casterly/issues.yaml` | Issue log |
| `~/.casterly/self-model.yaml` | Self-model (Phase 6) |
| `~/.casterly/memory/` | Cool/cold tier memory store |
| `~/.casterly/autonomous/reflections/` | Reflection logs (JSONL) |
| `~/.casterly/autonomous/handoff.json` | Overnight handoff state |
| `~/.casterly/autonomous/debug.log` | Debug log (if enabled) |
| `~/.casterly/workspace/skills/` | Installed skills |

## Key Files

| File | Purpose |
|------|---------|
| `config/default.yaml` | Main application configuration |
| `config/autonomous.yaml` | Autonomous system configuration (all 7 phases) |
| `config/models.yaml` | Model registry and routing |
| `config/model-profiles.yaml` | Per-model tuning overrides |
| `config/backlog.yaml` | Feature backlog for autonomous agent |
| `src/config/schema.ts` | Zod schema for `AppConfig` |
| `src/config/index.ts` | Config loader (`loadConfig()`) |
| `src/autonomous/memory-config.ts` | Zod schemas for memory/identity/debug config |
| `src/interface/context-profiles.ts` | Pipeline stage context profiles |
