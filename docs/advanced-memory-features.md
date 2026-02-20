# Advanced Memory Features

Ten research-backed memory features implemented in `src/autonomous/memory/`.

| # | Feature | Source | Module |
|---|---------|--------|--------|
| 1 | Zettelkasten link network | A-MEM | `link-network.ts` |
| 2 | AUDN consolidation cycle | Mem0 | `audn-consolidator.ts` |
| 3 | Entropy-based tier migration | SAGE | `entropy-migrator.ts` |
| 4 | Git-backed memory versioning | Letta | `memory-versioning.ts` |
| 5 | Memory evolution | A-MEM | `memory-evolution.ts` |
| 6 | Temporal invalidation | Mem0 | `temporal-invalidation.ts` |
| 7 | Checker pattern | SAGE | `checker.ts` |
| 8 | Skill files | Letta | `skill-files.ts` |
| 9 | Concurrent dream processing | Letta | `concurrent-dreams.ts` |
| 10 | Graph relational memory | Mem0 | `graph-memory.ts` |

## Feature Details

### 1. Zettelkasten Link Network (A-MEM)

Bidirectional links between memory entries across all subsystems. Links are typed (`supports`, `contradicts`, `extends`, `derived_from`, `related`) and carry a strength score that decays over time. Supports multi-hop neighborhood traversal for context enrichment.

**Integration:**
- **State lifecycle**: Loaded at cycle start, saved at cycle end (`loop.ts` `loadState`/`saveState`).
- **Agent tools**: Three tools exposed to the LLM — `link_memories` (create/strengthen links), `get_links` (retrieve links for an entry), `traverse_links` (BFS neighborhood traversal).
- **Dream cycle**: Phase 10 (`linkDecay`) applies time-based decay and prunes weak links during consolidation.
- **MemoryEvolution coupling**: Evolution operations auto-create typed links between source and result memories (see Feature 5).

### 2. AUDN Consolidation Cycle (Mem0)

During dream cycles, each incoming memory candidate is evaluated against existing knowledge. The consolidator makes one of four decisions: **A**dd (novel), **U**pdate (partial overlap — merge), **D**elete (contradicted/superseded), or **N**othing (already known). Uses bigram Jaccard similarity for overlap detection.

**Integration:**
- **State lifecycle**: Queue loaded at cycle start, saved at cycle end (`loop.ts` `loadState`/`saveState`).
- **Agent tools**: Two tools exposed to the LLM — `audn_enqueue` (queue a candidate for evaluation), `audn_status` (check queue size and source breakdown).
- **Dream cycle**: Phase 11 (`audnConsolidation`) runs the full AUDN evaluation on all queued candidates, then clears the queue.

### 3. Entropy-Based Tier Migration (SAGE)

Uses Shannon entropy over word frequency distributions to measure information density. Combined with access frequency and recency into a composite migration score that determines whether an entry should be promoted to a hotter tier or demoted to a colder one.

**Integration:**
- **Agent tools**: Two tools exposed to the LLM — `entropy_score` (quick entropy + normalized score for content), `evaluate_tiers` (batch evaluate entries for tier migration recommendations).
- **Dream cycle**: Phase 12 (`entropyTierMigration`) evaluates warm-tier entries and produces promotion/demotion recommendations.
- **Stateless**: No persistent storage — the migrator is a pure computation engine instantiated in the constructor. No load/save lifecycle needed.

### 4. Git-Backed Memory Versioning (Letta)

Lightweight internal snapshot system for memory state. Each snapshot captures the contents of key memory files (crystals, constitution, goals, issues) at a point in time. Supports line-level diffing between snapshots and deduplicates unchanged state.

**Integration:**
- **State lifecycle**: Snapshot index loaded at cycle start, saved at cycle end (`loop.ts` `loadState`/`saveState`).
- **Agent tools**: Three tools exposed to the LLM — `snapshot_memory` (create a snapshot), `list_snapshots` (view history), `diff_snapshots` (compare changes between snapshots).
- **Dream cycle**: Phase 13 (`memorySnapshot`) automatically creates a snapshot after all other dream phases complete, capturing the post-consolidation state.

### 5. Memory Evolution (A-MEM)

Structured transformations that go beyond CRUD: **strengthen** (corroboration), **weaken** (contradiction), **merge** (combine two into one), **split** (decompose into focused parts), **generalize** (abstract to principle), and **specialize** (narrow to context). Full lineage tracking across generations.

**Integration:**
- **State lifecycle**: Loaded at cycle start, saved at cycle end (`loop.ts` `loadState`/`saveState`).
- **LinkNetwork coupling**: When a `LinkNetwork` is wired in via `setLinkNetwork()`, every evolution operation auto-creates a typed link between source and result memories. The mapping is: strengthen→`supports`, weaken→`contradicts`, merge/split/generalize/specialize→`derived_from`.

### 6. Temporal Invalidation (Mem0)

TTL policies per memory category with configurable decay functions (linear or exponential). Facts get 90-day TTLs, opinions get 14 days, working notes get 7 days. Access can reset the expiry clock. Expired entries enter a grace period before hard deletion.

### 7. Checker Pattern (SAGE)

Pre-storage validation guard that runs five checks on every memory candidate: **consistency** (contradiction detection), **relevance** (entropy and length), **duplicate** (Jaccard similarity), **freshness** (stale date references), and **safety** (sensitive data patterns). Produces a composite verdict with per-check explanations.

### 8. Skill Files (Letta)

Persistent procedural memory capturing learned task patterns. Each skill has ordered steps, preconditions, success criteria, and a mastery level (`novice` → `competent` → `proficient` → `expert`) that advances based on tracked success rates.

### 9. Concurrent Dream Processing (Letta)

Runs independent dream cycle phases in parallel using `Promise.allSettled`. Phases are organized into dependency groups that execute sequentially, while phases within each group run concurrently. Supports configurable concurrency limits, per-phase timeouts, and critical-failure abort.

### 10. Graph Relational Memory (Mem0)

In-memory entity-relationship graph with typed nodes (`file`, `concept`, `person`, `tool`, `module`, `pattern`) and edges (`depends_on`, `related_to`, `uses`, `modifies`, `contains`, `authored_by`, `tested_by`). Supports BFS shortest path, connected component detection, and deterministic node deduplication.

## Sources

- **A-MEM**: Agentic memory architecture emphasizing interconnected, evolving knowledge structures.
- **Mem0**: Memory layer for AI agents with consolidation cycles, temporal awareness, and graph-based relations.
- **SAGE**: Information-theoretic approach to memory management using entropy and verification patterns.
- **Letta**: Stateful agent framework with versioned memory, skill persistence, and concurrent processing.
