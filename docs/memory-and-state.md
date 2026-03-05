# Memory & State

> **Source**: `src/autonomous/`

Casterly maintains persistent state across sessions through 19 subsystems stored on disk. They are loaded in parallel at cycle start and saved (dirty-flag) at cycle end.

## Storage Layout

```
~/.casterly/
├── journal.jsonl              # Append-only narrative memory
├── world-model.yaml           # Codebase health, stats, concerns
├── goals.yaml                 # Priority queue of work items
├── issues.yaml                # Problem tracker with attempt history
├── crystals.yaml              # Permanent insights (Tier 1)
├── constitution.yaml          # Self-authored rules (Tier 1)
├── traces/                    # Execution trace archive (Tier 1)
├── system-prompt.md           # Editable system prompt (Tier 2)
├── prompt-versions.json       # Prompt version history (Tier 2)
├── shadow-analysis.json       # Shadow execution data (Tier 2)
├── tools/                     # Synthesized tools (Tier 2)
├── challenge-history.json     # Challenge evaluation (Tier 3)
├── prompt-evolution/          # Prompt genetic algorithm (Tier 3)
├── training-data.json         # LoRA training data (Tier 3)
├── adapters/                  # LoRA adapter registry (Tier 3)
├── benchmarks/                # Benchmark tasks (Tier 3)
├── memory/                    # Advanced memory (links, evolution, AUDN)
├── execution-log/             # Task execution outcomes
└── taskboard.json             # Dual-loop shared state
```

## Core Stores

### Journal

> `src/autonomous/journal.ts` — `~/.casterly/journal.jsonl`

Append-only narrative memory. Entry types: `handoff`, `reflection`, `opinion`, `observation`, `user_interaction`. The most recent handoff note is injected into the identity prompt at each cycle start. Last 200 entries cached in memory. Contains only Tyrion's reasoning — never raw user content.

### World Model

> `src/autonomous/world-model.ts` — `~/.casterly/world-model.yaml`

Structured codebase state: health snapshot (tsc/vitest/lint results), codebase stats (file count, last commit), concerns (lightweight observations), recent activity, and a derived user model (communication style, preferences — never verbatim quotes).

### Goal Stack

> `src/autonomous/goal-stack.ts` — `~/.casterly/goals.yaml`

Priority queue of work items. Max 20 open goals. Sources: `user` (priority 1), `event` (priority 2), `self` (priority 3). Goals track status, attempts, notes, and related files. Stale goals flagged after 7 days.

### Issue Log

> `src/autonomous/issue-log.ts` — `~/.casterly/issues.yaml`

Self-managed problem tracker. Each issue records title, description, priority, attempt history (approach + outcome + files modified), and a `nextIdea` field. Deduplication by title, priority escalation on re-filing. Max 50 open, 200 total.

## Self-Improvement Stores (Tier 1)

### Crystal Store — Memory Crystallization

> `src/autonomous/crystal-store.ts` — `~/.casterly/crystals.yaml`

Permanent high-value insights promoted from experience. Crystals have confidence scores (0-1), are validated/weakened over time, and pruned below 0.3 confidence during dream cycles. Max 30 crystals, 500 tokens in the hot tier. Always in the identity prompt.

### Constitution Store — Self-Governance

> `src/autonomous/constitution-store.ts` — `~/.casterly/constitution.yaml`

Self-authored operational rules with evidence. Each rule tracks invocations and success rate. Strengthened on success (+0.03), weakened on failure (-0.02), strongly weakened when violated successfully (-0.05). Max 50 rules.

### Trace Replay — Self-Debugging

> `src/autonomous/trace-replay.ts` — `~/.casterly/traces/`

Execution traces for post-mortem analysis. Each trace records tool calls, parameters, results, and timing. Supports replay, comparison, and search. Retention: 7 days (success), 30 days (failure), indefinite (referenced). Max 500 traces.

## Self-Improvement Stores (Tier 2)

### Prompt Store — Self-Modifying Prompts

> `src/autonomous/prompt-store.ts`

Versioned system prompt the LLM can edit during dream cycles. Protected patterns (safety boundary, path guards, redaction rules) cannot be removed. Max 20 versions with rationale tracking.

### Shadow Store — Shadow Execution

> `src/autonomous/shadow-store.ts`

Records alternative approaches before executing primary plan. During dream cycles, shadows are compared with outcomes to calibrate judgment. Extracts recurring patterns. Max 200 shadows.

### Tool Synthesizer

> `src/tools/synthesizer.ts`

LLM-authored custom tools with bash template implementations. Templates scanned against 13 dangerous patterns. Max 20 tools, unused tools flagged after 30 days.

## Self-Improvement Stores (Tier 3)

### Challenge Evaluator — Adversarial Self-Testing

> `src/autonomous/dream/challenge-evaluator.ts`

Tracks adversarial dual-model self-testing results. Sub-skill assessments with trend tracking and weakness identification.

### Prompt Evolution — Genetic Algorithm

> `src/autonomous/dream/prompt-evolution.ts`

Evolves system prompt through selection pressure. Population of 8 variants, elite preservation, mutation + crossover with protected sections.

### Training Extractor & LoRA Trainer

> `src/autonomous/dream/training-extractor.ts`, `src/autonomous/dream/lora-trainer.ts`

Extracts decision-outcome pairs for LoRA fine-tuning. Manages adapter lifecycle: training → evaluating → active → archived. Minimum 5% improvement threshold.

## Advanced Memory

### Link Network (Zettelkasten)

> `src/autonomous/memory/link-network.ts`

Bidirectional links between memory entries with strength decay.

### Memory Evolution

> `src/autonomous/memory/memory-evolution.ts`

Operations: strengthen, weaken, merge, split, generalize, specialize — with lineage tracking.

### AUDN Consolidator

> `src/autonomous/memory/audn-consolidator.ts`

Mem0-style consolidation: add/update/delete/nothing decisions using bigram Jaccard similarity.

## Context Manager (Tiered Memory)

> `src/autonomous/context-manager.ts`

Four tiers manage what Tyrion sees during a cycle:

| Tier | Budget | Content | Persistence |
|------|--------|---------|-------------|
| **Hot** | ~2K tokens | Identity + crystals + constitution | Rebuilt each cycle |
| **Warm** | ~20K tokens | Tool results, working notes | In-memory only |
| **Cool** | On-demand | Past 30 days archived notes | Disk (queried via `recall`) |
| **Cold** | Archive | Full historical archive | Disk (queried via `recall`) |

Warm tier uses LRU eviction. Significant tool results auto-added (truncated to 4K chars).

## Dream Cycles

Dream cycles run during idle periods. Six core phases the LLM drives:

1. **Consolidate reflections** — group outcomes, archive insights
2. **Update world model** — refresh codebase health
3. **Reorganize goals** — reprioritize from recent activity
4. **Explore** — code archaeology for fragile/abandoned files
5. **Update self-model** — recalculate strengths/weaknesses
6. **Write retrospective** — weekly journal summary

Plus advanced phases: adversarial challenges, prompt evolution, training data extraction, shadow analysis, tool inventory review.

## Privacy

All stores follow: **store only Tyrion's reasoning and codebase metadata, never raw user content.** Journal has derived summaries only. User model has derived preferences only. Crystals and constitution have only empirical rules. No verbatim user messages anywhere.
