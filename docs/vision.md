# The Soul of Casterly

## Mission

Casterly is a local-first, privacy-first autonomous AI steward running on a Mac Studio M4 Max with 128GB unified memory. All inference is local. No data leaves the machine. Ever. Casterly exists to be genuinely useful to one person -- managing their digital life, writing code, executing tasks, remembering context -- without surrendering a single byte to the cloud.

## Philosophy

### Privacy by Architecture, Not by Policy

Privacy is not a toggle, a policy page, or a promise. It is a structural property of the system. There are no cloud API keys to leak, no telemetry endpoints to disable, no "send anonymized data" checkboxes. Every computation happens on local hardware. Every byte of user data stays on local storage. The architecture makes exfiltration impossible, not merely prohibited.

### Local-First, Not Local-Fallback

Local inference is not a degraded mode activated when the network is down. It is the primary and only mode. The system is designed around the capabilities and constraints of on-device models. Cloud providers exist in the codebase as a historical artifact; they are not used.

### Autonomous Agency, Not a Chatbot

Casterly is not a question-answering service waiting for input. It is an agent that can initiate actions, schedule work, monitor events, and maintain continuity across sessions. It classifies incoming work, decomposes complex tasks into plans, executes those plans with verification, and learns from outcomes. When idle, it can consolidate memory and reflect on past interactions.

### Journal-Driven Continuity

State is not a structured object passed between pipeline stages. It is a narrative. The journal -- an append-only JSONL log -- is the source of truth for what Casterly has done, what it noticed, what it thinks, and what it would tell its future self. Every session begins by reading the most recent handoff note and ends by writing one. Opinions emerge from experience. Self-knowledge is derived from patterns in the journal, not hardcoded.

## Hardware as Strategy

The Mac Studio M4 Max with 128GB unified memory is not a deployment target. It is the strategic advantage.

### What This Enables Now

- **gpt-oss:120b running locally** with headroom for a second concurrent model (qwen3-coder-next for code editing). No API latency. No rate limits. No per-token costs.
- **128GB unified memory** means two 70B+ parameter models can coexist in memory simultaneously, enabling task-based model routing without cold starts.
- **NVMe storage** for fast journal reads, session loading, and repo-map generation.
- **Full macOS integration** -- iMessage, Calendar, Reminders, Notes, Finder, System Events -- all accessible locally via AppleScript and native APIs with no network dependency.

### What This Unlocks

- **On-device embeddings** for semantic memory (beyond keyword matching in the journal).
- **Concurrent agent reasoning** to maximize hardware utilization -- multiple subagents reasoning in parallel within the hardware's concurrency budget.
- **Real-time event processing** -- file watchers, git hooks, and calendar polling feeding triggers into the agent loop with minimal latency.
- **Large context windows** -- local models with 128K context windows, paired with intelligent context budgeting, enable complex multi-file code operations.

## Models

| Role | Model | Purpose |
|------|-------|---------|
| Primary reasoning | gpt-oss:120b | Planning, conversation, classification, verification, general tasks |
| Code editing | qwen3-coder-next | Code generation, refactoring, review, implementation |

Task-based routing is configured in `config/models.yaml`. Ollama is the sole inference provider. Model selection follows these rules:

- **Coding tasks** (code generation, refactoring, bug fixes, review) route to `qwen3-coder-next`.
- **General tasks** (reasoning, planning, conversation, classification) route to the primary model.
- **Autonomous cycles** use the primary model for reasoning and delegate coding subtasks to the coding model via the `delegate` tool.

The agent can also perform metacognitive delegation -- deciding at runtime which model is best suited for a subtask based on its self-assessment of the task's characteristics.

## Identity and Personality

Casterly's deployed instance is named **Tyrion**. The personality is defined in workspace files that the agent reads at the start of every session:

| File | Purpose |
|------|---------|
| `workspace/SOUL.md` | Core truths, personality traits, boundaries, communication style |
| `workspace/IDENTITY.md` | Name, platform, interface, vibe |
| `workspace/TOOLS.md` | Environment-specific notes, memory system, safety rules |
| `workspace/USER.md` | User profile -- built over time through interaction |

Tyrion has a voice, not just capabilities:

- **Concise** -- responses are brief, especially over iMessage.
- **Direct** -- says what it means without hedging.
- **Practical** -- focuses on solving problems.
- **Honest** -- admits limitations and uncertainty.
- **Attentive** -- remembers details and builds understanding of the user over time.

The personality is not cosmetic. It shapes how the agent communicates, what it prioritizes, and how it earns trust. "Be genuinely helpful, not performatively helpful" is the first core truth.

## Invariants

These rules are non-negotiable. They must remain true as the project evolves. Changing them requires explicit user authorization.

### Architecture Invariants

1. All inference is local via Ollama. No cloud APIs.
2. Provider integrations sit behind a stable, minimal `LlmProvider` interface.
3. Security and redaction logic are centralized in `src/security/*`.
4. Logging goes through the privacy-safe logger (`src/logging/safe-logger.ts`), never direct `console.log` for user data.
5. Configuration is validated at startup via Zod schemas and fails fast on invalid or unsafe settings.
6. Model selection is task-based (coding vs primary) via `config/models.yaml`.
7. The agent loop is the single execution path. No separate interactive/autonomous code paths.
8. The journal is append-only. Entries are never deleted, only compressed during dream cycles.
9. Delegation is transparent. Every delegated call is logged and reviewable.

### Security Invariants

1. All user data stays on the local machine.
2. Redaction is the default for any user-provided text in logs.
3. Secrets (API keys, tokens, credentials) are never logged or echoed.
4. Privacy-critical behavior is covered by unit tests.
5. Guardrails flag changes to critical privacy modules and sensitive paths.
6. The user model is local-only and never logged raw -- it is derived, not stored verbatim.

### Sensitive Data Categories

These categories are handled with particular care (all stay local by design):

1. Calendar and schedules
2. Financial information and transactions
3. Health and medical information
4. Credentials, passwords, secrets, or API keys
5. Private notes, journals, voice memos, or documents
6. Personal contacts and relationships

### Protected Paths

Changes to these paths are high risk and must be called out explicitly:

- `src/security/*`
- `src/tasks/classifier.ts`
- `src/providers/*`
- `config/*`
- `.env` and `.env.*`
- `scripts/guardrails.mjs`

### Development Workflow

1. Read this document and the relevant module source before making changes.
2. Use the System Architect subagent to confirm the approach for cross-cutting changes.
3. Implement with clear boundaries and minimal surface area.
4. Add or update tests for any behavior change.
5. Run `npm run check` before finishing.
6. If guardrails fail, either revert the risky changes or set `ALLOW_PROTECTED_CHANGES=1` intentionally.

### Definition of Done

A change is done only when:

1. The change respects all invariants above.
2. Tests cover the new or modified behavior.
3. `npm run check` passes locally.
4. Any remaining risk is called out explicitly in the final summary.

## Dream Cycles & Self-Knowledge

### Dream Cycle Consolidation

Background reasoning during idle time. When Casterly is not actively processing user requests, it analyzes its journal for patterns, consolidates operational memory, updates its self-model, and compresses old entries. The dream cycle runner (`src/autonomous/dream/runner.ts`) executes six phases:

1. **Consolidate reflections** -- groups past outcomes by success/failure, archives insights.
2. **Update world model** -- runs a codebase health check and refreshes the world model YAML.
3. **Reorganize goals** -- reprioritizes the goal stack based on recent activity.
4. **Explore** -- code archaeology pass to find fragile or abandoned files.
5. **Update self-model** -- recalculates strengths and weaknesses from the issue log.
6. **Write retrospective** -- weekly summary written to the journal.

Dream cycles are configured with intervals, budgets, and lookback windows in `config/autonomous.yaml`.

### Self-Knowledge Rebuilding

Periodic self-reflection where Casterly rebuilds its understanding of its own strengths, weaknesses, and working patterns from journal history. The self-model (`src/autonomous/dream/self-model.ts`) tracks 13 skills (regex, TypeScript, testing, refactoring, security, performance, concurrency, parsing, config, git, bug-fixing, documentation) with success rates and sample sizes. The model is stored in `~/.casterly/self-model.yaml` and rebuilt every 48 hours from the issue log and reflections. This replaces telemetry-based metrics with genuine self-knowledge: "I tend to over-complicate refactors" rather than "successRate: 0.7."

## Roadmap

### Semantic Memory

On-device embeddings for richer recall beyond keyword matching. The context store's `recall()` method currently uses keyword-weighted substring matching across the cool and cold memory tiers. Embedding-based similarity search would enable the agent to find relevant past context even when the exact words differ.

**What exists today:**
- Four-tier memory system (hot/warm/cool/cold) with keyword recall fully operational.
- Ollama supports embeddings via `/api/embed` -- the inference provider is already running.
- `ContextStore.recall()` (`src/autonomous/context-store.ts:216`) extracts keywords, scores entries with title (3x), tag (2x), and content (1x) weights, returns `RecallResult[]`.
- `ContextManager.recall()` (`src/autonomous/context-manager.ts:349`) delegates transparently to the store.
- Agent tool `recall` (`src/autonomous/agent-tools.ts:1661`) invokes `contextManager.recall()` and formats results.

**Implementation plan:**

#### Phase 1: Embedding Provider (~4-6 hours)

Create `src/providers/embedding.ts`:

```typescript
export interface EmbeddingProvider {
  embed(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
  dimensions: number;
}
```

- Call Ollama's `POST /api/embed` endpoint with model `nomic-embed-text` (~40MB, 768 dimensions).
- Reuse the existing Ollama base URL from `config/models.yaml`.
- Add an in-memory LRU cache (keyed by content hash) to avoid re-embedding identical text.
- No new dependencies -- use the same `fetch` calls as `src/providers/ollama.ts`.

#### Phase 2: Vector Storage (~3-5 hours)

Extend `MemoryEntry` in `src/autonomous/context-store.ts:35`:

```typescript
export interface MemoryEntry {
  // ... existing fields ...
  embedding?: number[];  // optional, only present when semantic memory enabled
}
```

Modify `archive()` (`context-store.ts:164`):
- After entry creation (line 185), call `embeddingProvider.embed(title + ' ' + content)` and store the vector in the entry's `embedding` field.
- Embeddings persist in the existing JSONL files alongside the entry -- no separate storage layer needed initially.
- Add `embeddingProvider?: EmbeddingProvider` to `ContextStoreConfig` (`context-store.ts:78`).

#### Phase 3: Hybrid Recall (~4-6 hours)

Add a `recallSemantic()` path inside the existing `recall()` method (`context-store.ts:216`):

```
recall(query)
  ├── extractKeywords(query)           # existing path
  ├── embeddingProvider.embed(query)   # new: embed the query
  ├── for each entry:
  │     ├── keywordScore = scoreEntry(entry, keywords)    # existing
  │     └── semanticScore = cosineSimilarity(queryVec, entry.embedding)  # new
  │         hybridScore = (1 - hybridWeight) * keywordScore + hybridWeight * semanticScore
  ├── filter by minSimilarity threshold
  └── return top N sorted by hybridScore
```

Cosine similarity is ~10 lines of math (dot product / magnitude product). No library needed.

Entries without embeddings (pre-existing or when disabled) fall back to keyword-only scoring transparently.

#### Phase 4: Configuration (~1-2 hours)

Add Zod schema in `src/config/schema.ts`:

```typescript
const embeddingConfigSchema = z.object({
  enabled: z.boolean().default(false),
  provider: z.enum(['ollama']).default('ollama'),
  model: z.string().default('nomic-embed-text'),
  dimensions: z.number().int().positive().default(768),
  hybridWeight: z.number().min(0).max(1).default(0.5),
  minSimilarity: z.number().min(0).max(1).default(0.3),
  cachePath: z.string().default('~/.casterly/memory/embeddings'),
});
```

Add to `config/autonomous.yaml`:

```yaml
semantic_memory:
  enabled: false
  provider: ollama
  model: nomic-embed-text:latest
  dimensions: 768
  hybrid_weight: 0.5
  min_similarity: 0.3
  cache_path: ~/.casterly/memory/embeddings
```

#### Phase 5: Tests (~4-6 hours)

Follow patterns in `tests/autonomous-context-manager.test.ts`:

- Mock `EmbeddingProvider` with deterministic vectors (seeded from content hash) to avoid Ollama dependency in CI.
- Test: archived entry gets an embedding vector of correct dimensions.
- Test: semantic recall finds entries that share no keywords with the query but are conceptually similar.
- Test: `hybridWeight=0` produces pure keyword results; `hybridWeight=1` produces pure semantic results.
- Test: entries without embeddings are scored by keyword only (backward compatibility).
- Test: `minSimilarity` threshold filters low-confidence matches.

**Files touched:** `src/providers/embedding.ts` (new), `src/autonomous/context-store.ts`, `src/config/schema.ts`, `config/autonomous.yaml`, `tests/embedding-provider.test.ts` (new), `tests/autonomous-context-manager.test.ts`.

**Estimated effort:** ~17-27 hours across 5 phases. No external dependencies. All computation stays on-device.

---

### Parallelism

Concurrent agent reasoning to maximize hardware utilization. The M4 Max can support two concurrent models. Independent branches of a task DAG should be processed in parallel by multiple subagents, each with a scoped context.

**What exists today:**
- `ConcurrentProvider` (`src/providers/concurrent.ts`) is fully implemented with `parallel()`, `bestOfN()`, `generate()`, bounded concurrency (max 3), and per-model timing metrics.
- `ReasoningScaler` (`src/autonomous/reasoning/scaling.ts`) maps task difficulty to strategy: `easy` → single generation, `medium` → 2 candidates with heuristic pick, `hard` → up to 4 candidates via `bestOfN` with judge.
- `AutonomousLoop` (`src/autonomous/loop.ts:211`) already creates a `ReasoningScaler` and calls `assessDifficulty()` at line 750 before each agent cycle.
- Difficulty currently only scales `maxTurns` (line 764: `easy=0.5x`, `medium=1.0x`, `hard=1.5x`). It does not route through `ConcurrentProvider`.
- Task runner (`src/tasks/runner.ts:71`) has a proper `Semaphore` class and executes DAG branches via `Promise.all`.

**Implementation plan:**

#### Phase A: Build ConcurrentProvider in AutonomousLoop (~2-3 hours)

Modify `src/autonomous/loop.ts` constructor (line 171):

1. Import `ConcurrentProvider` and `createConcurrentProvider`.
2. After the existing `ReasoningScaler` init (line 215), build a provider map:
   ```typescript
   const providerMap = new Map<string, LlmProvider>();
   providerMap.set(agentConfig.reasoningModel, primaryProvider);
   providerMap.set(agentConfig.codingModel, codingProvider);
   this.concurrentProvider = createConcurrentProvider(providerMap, {
     maxConcurrent: config.hardware?.max_concurrent_requests ?? 3,
     maxParallelGenerations: config.hardware?.max_parallel_generations ?? 4,
   });
   ```
3. Store as `private concurrentProvider: ConcurrentProvider`.

#### Phase B: Route Agent Loop Through ConcurrentProvider (~2-3 hours)

Modify `runAgentCycle()` in `src/autonomous/loop.ts` (lines 770-782):

**Current flow** (line 775):
```typescript
const llmProvider = this.provider as unknown as LlmProvider;
this.activeAgentLoop = createAgentLoop(config, llmProvider, ...);
```

**New flow:**
```typescript
if (this.agentConfig.useConcurrentProvider && difficulty !== 'easy') {
  // Wrap ConcurrentProvider as LlmProvider for agent loop consumption
  const concurrentLlm: LlmProvider = {
    id: 'concurrent',
    kind: 'local',
    model: this.agentConfig.reasoningModel,
    generateWithTools: async (request, tools, prev) => {
      if (difficulty === 'hard') {
        const result = await this.concurrentProvider.bestOfN(
          [this.agentConfig.reasoningModel, this.agentConfig.codingModel],
          request,
          this.agentConfig.reasoningModel,  // judge
          tools,
        );
        return result.best.response;
      }
      // medium: parallel, return first
      const results = await this.concurrentProvider.parallel(
        [this.agentConfig.reasoningModel, this.agentConfig.codingModel],
        request,
        tools,
      );
      return results[0]!.response;
    },
  };
  this.activeAgentLoop = createAgentLoop(config, concurrentLlm, ...);
} else {
  // easy: single model, existing path
  const llmProvider = this.provider as unknown as LlmProvider;
  this.activeAgentLoop = createAgentLoop(config, llmProvider, ...);
}
```

The agent loop itself (`src/autonomous/agent-loop.ts`) needs **zero changes** -- it calls `provider.generateWithTools()` at line 454, and the wrapper above handles the routing transparently.

#### Phase C: Fix ConcurrentProvider Semaphore (~1 hour)

Replace the busy-wait in `src/providers/concurrent.ts:292` with the proper `Semaphore` class from `src/tasks/runner.ts:71`:

```typescript
// Current (busy-wait with 50ms polling):
private async acquireSlot(): Promise<void> {
  while (this.activeRequests >= this.config.maxConcurrent) {
    await new Promise((r) => setTimeout(r, 50));
  }
  this.activeRequests++;
}

// Replace with Promise-based semaphore (same pattern as task runner):
private readonly semaphore: Semaphore;
// ... use semaphore.acquire() / semaphore.release()
```

Extract the `Semaphore` class from `runner.ts` into a shared `src/utils/semaphore.ts` so both can import it.

#### Phase D: Configuration (~1 hour)

Add to `config/autonomous.yaml` under `agent_loop`:

```yaml
agent_loop:
  # ... existing fields ...
  use_concurrent_provider: false    # Enable parallel/best-of-N reasoning
  concurrent_strategy: auto         # 'auto' uses ReasoningScaler, 'always_parallel', 'always_bestn'
```

Add Zod validation in schema:

```typescript
useConcurrentProvider: z.boolean().default(false),
concurrentStrategy: z.enum(['auto', 'always_parallel', 'always_bestn']).default('auto'),
```

#### Phase E: Tests (~2 hours)

Follow patterns in `tests/hardware.test.ts` (existing ConcurrentProvider tests) and `tests/agent-loop.test.ts`:

- Test: easy difficulty bypasses ConcurrentProvider, uses single model.
- Test: medium difficulty calls `parallel()` with both models.
- Test: hard difficulty calls `bestOfN()` with judge.
- Test: `useConcurrentProvider=false` always uses single model regardless of difficulty.
- Test: shared `Semaphore` bounds concurrent requests correctly.
- Test: agent loop outcome is identical whether routed through ConcurrentProvider wrapper or direct LlmProvider.

**Files touched:** `src/autonomous/loop.ts`, `src/providers/concurrent.ts`, `src/utils/semaphore.ts` (new, extracted from runner), `src/tasks/runner.ts` (import change), `config/autonomous.yaml`, `src/config/schema.ts`, `tests/hardware.test.ts`.

**Estimated effort:** ~8-10 hours across 5 phases. All components exist; this is primarily a wiring and routing task.
