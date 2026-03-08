# Casterly Documentation

> Local-first, privacy-first AI steward — all inference on-device via Ollama and vllm-mlx.

## Start Here

| Doc | What You'll Learn |
|-----|-------------------|
| [Vision](vision.md) | Mission: local-first autonomy, capability amplification, privacy-by-architecture |
| [Rulebook](rulebook.md) | Non-negotiable invariants (mandatory reading before changes) |
| [Install Guide](install.md) | Prerequisites, Ollama + MLX setup, macOS (Apple Silicon) config |

## Architecture

| Doc | Scope |
|-----|-------|
| [Architecture](architecture.md) | System overview: triple-model architecture, event flow, module map |
| [Dual-Loop System](dual-loop.md) | FastLoop + DeepLoop (27B reasoner + 80B coder) + TaskBoard |
| [Providers & Routing](providers-and-routing.md) | Ollama + MLX providers, three-model registry, concurrent inference |

## Subsystems

| Doc | Scope |
|-----|-------|
| [Memory & State](memory-and-state.md) | 19 persistent stores, tiered context, self-improvement mechanisms |
| [Security & Privacy](security-and-privacy.md) | 5 defense layers, input guard, redaction, command gates |
| [Tools & Skills](tools-and-skills.md) | Native tools, skill packages, tool synthesis |
| [Configuration](configuration.md) | YAML config files, Zod schemas, environment setup |
| [Testing & Quality Gates](testing.md) | 5-gate pipeline, test patterns, autonomous validation |

## Development

| Doc | Purpose |
|-----|---------|
| [Subagents](subagents.md) | 8 specialized development roles for workflow sequencing |

## Archived

Previous docs moved to `docs/archive/` for historical reference. These were consolidated into the docs above.

## Reading Order

1. **[Vision](vision.md)** — understand the mission
2. **[Rulebook](rulebook.md)** — know the invariants
3. **[Architecture](architecture.md)** — see the system overview
4. **[Dual-Loop System](dual-loop.md)** — understand the core execution model
5. Browse subsystem docs as needed
