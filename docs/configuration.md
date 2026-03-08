# Configuration

> **Source**: `config/`, `src/config/`

Casterly uses YAML configuration validated at load time by Zod schemas. All config is checked into the repository except secrets (`.env*` files, gitignored).

## Config Files

| File | Purpose |
|------|---------|
| `config/default.yaml` | Main config: provider, sensitivity, session, tools, logging, hardware |
| `config/autonomous.yaml` | Autonomous agent: timing, scope, agent loop, events, memory, dream, communication, dual-loop |
| `config/models.yaml` | Model registry: per-role models, MLX config, hardware constraints, Ollama settings |
| `config/model-profiles.yaml` | Per-model tuning: temperature, token limits, tool-specific hints |
| `config/backlog.yaml` | Feature backlog for autonomous improvement |

## Main Config (`config/default.yaml`)

### Provider

```yaml
local:
  provider: ollama
  model: qwen3.5:35b-a3b
  baseUrl: http://localhost:11434
  timeoutMs: 120000
```

Only `ollama` is a valid provider for the main config (local-only enforcement). MLX providers are configured separately in `models.yaml`.

### Sensitivity

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

All 8 categories always route locally. This is the privacy guardrail.

### Tools

```yaml
tools:
  bash:
    blockedPatterns:
      - "rm -rf /"
      - ":(){ :|:& };:"
      - "dd if=/dev/"
      - "> /dev/sd"
      - "mkfs"
      - "chmod -R 777 /"
```

## Model Config (`config/models.yaml`)

```yaml
models:
  primary:
    provider: ollama
    model: qwen3.5:35b-a3b
    temperature: 0.6

  fast:
    provider: ollama
    model: qwen3.5:35b-a3b
    temperature: 0.3

mlx:
  base_url: http://localhost:8000
  model: nightmedia/Qwen3.5-27B-Claude-4.6-Opus-Reasoning-Distilled-qx64-hi-mlx
  timeout_ms: 300000
  kv_cache:
    preset: k8v4   # Asymmetric K8V4 -- lossless at 128K

mlx_coder:
  base_url: http://localhost:8001
  model: nightmedia/Qwen3-Coder-Next-mxfp4-mlx
  timeout_ms: 600000
  kv_cache:
    preset: none   # FP16 -- only 12 KV layers, not worth quantizing

hardware:
  platform: mac-studio-m4-max
  memory_gb: 128
  max_concurrent_models: 3
  target_memory_usage_pct: 66
```

The `mlx` section configures the 27B reasoner; `mlx_coder` configures the 80B coder. Both run on vllm-mlx on separate ports.

## Autonomous Config (`config/autonomous.yaml`)

Key settings:

| Section | What it controls |
|---------|-----------------|
| `timing` | Cycle interval, heartbeat |
| `scope` | Max files per change, concurrent branches, timeouts |
| `agent_loop` | Max turns, token budget, tool presets |
| `dual_loop` | FastLoop/DeepLoop model selection, context tiers, TaskBoard paths |
| `events` | File watcher, git watcher, issue watcher settings |
| `memory` | Vision tier toggles, dream cycle interval, store paths |
| `communication` | Message policy (throttle, quiet hours, event filtering) |
| `invariants` | Post-change validation commands |

### Dual-Loop Settings

```yaml
dual_loop:
  enabled: true
  fast_loop:
    model: qwen3.5:35b-a3b
    heartbeat_ms: 2000
    triage_timeout_ms: 10000
  deep_loop:
    model: qwen3.5-27b-reasoner
    coder_model: qwen3-coder-80b
    max_turns_per_task: 100
    max_turns_per_step: 25
    max_revision_rounds: 3
    idle_sleep_ms: 10000
  context_tiers:
    deep:
      standard: 24576
      extended: 131072    # 27B native context limit
    coder:
      base: 8192
      extended: 65536
      max: 262144          # 80B native 256K context
    fast:
      compact: 4096
      standard: 12288
      extended: 24576
  hard_budget:
    max_tokens: 16384      # Coder output budget per step
```

The `deep_loop.model` names (`qwen3.5-27b-reasoner`, `qwen3-coder-80b`) are logical names that map to ConcurrentProvider registrations in the daemon.

## Persistent State Paths

All state lives under `~/.casterly/`:

```
~/.casterly/
├── journal.jsonl
├── world-model.yaml
├── goals.yaml
├── issues.yaml
├── crystals.yaml
├── constitution.yaml
├── traces/
├── system-prompt.md
├── taskboard.json
├── autonomous/
│   └── handoff.json
├── mlx/
│   ├── reasoner.pid
│   ├── coder.pid
│   └── logs/
└── workspace/
    ├── IDENTITY.md
    ├── SOUL.md
    ├── TOOLS.md
    └── USER.md
```

See [memory-and-state.md](memory-and-state.md) for full details.

## Schema Validation

> **Source**: `src/config/schema.ts`

Config is validated at startup via Zod schemas. Invalid or unsafe settings cause fast failure with clear error messages. The schema enforces:

- `provider` must be `'ollama'` (no cloud providers)
- `baseUrl` must be a valid URL
- Sensitivity categories must be from the known set
- Numeric values have sensible bounds

## Key Files

| File | Purpose |
|------|---------|
| `config/default.yaml` | Main application config |
| `config/autonomous.yaml` | Autonomous agent config |
| `config/models.yaml` | Model registry (Ollama + MLX) |
| `config/model-profiles.yaml` | Per-model tuning |
| `src/config/schema.ts` | Zod validation schemas |
| `src/config/index.ts` | Config loader |
