# A-MEM Zettelkasten Link Network — Reference Research

Sources:
- https://arxiv.org/abs/2502.12110
- https://github.com/agiresearch/A-mem
- NeurIPS 2025 paper by Xu et al.

## Memory Note Structure (m_i)

Each note is a tuple: `m_i = (c_i, t_i, K_i, G_i, X_i, e_i, L_i)`

| Field | Name | Type | Description |
|-------|------|------|-------------|
| c_i | content | string | Original interaction content |
| t_i | timestamp | string | When the interaction occurred (YYYYMMDDHHMM) |
| K_i | keywords | List[str] | LLM-generated keywords capturing key concepts |
| G_i | tags | List[str] | LLM-generated tags for categorization |
| X_i | context | string | LLM-generated contextual description summarizing interaction |
| e_i | embedding | vector | Dense embedding via text encoder (e.g., all-MiniLM-L6-v2) |
| L_i | links | List[str] | Bidirectional links to related memory note IDs |

Additional fields in reference implementation:
- id: UUID unique identifier
- last_accessed: timestamp of last retrieval
- retrieval_count: usage counter
- evolution_history: record of changes over time
- category: classification category

## Three Core Modules

### 1. Note Construction
- Input: content + timestamp
- LLM generates: keywords, tags, contextual description (via JSON-structured prompts)
- Embedding computed via sentence transformer
- Links initialized empty
- Follows atomicity principle (one unit of info per note)

### 2. Link Generation (Zettelkasten Linking)
- On note insertion:
  1. Find nearest neighbors in embedding space (cosine similarity via ChromaDB)
  2. LLM evaluates whether connections should be established
  3. If yes: create **bidirectional links** between new and existing notes
- "Box" concept: related memories grouped by contextual similarity
- Notes can belong to multiple boxes simultaneously
- Links are stored as IDs in the `links` array

### 3. Memory Evolution
- After linking, existing memories may be updated:
  1. LLM evaluates whether to evolve based on new memory + nearest neighbors
  2. Returns JSON with: should_evolve, actions, suggested_connections, new_context, new_tags
  3. Actions include:
     - "strengthen": add new links to the new note, update its tags
     - "update_neighbor": update context and tags of existing neighbor notes
  4. Evolution counter tracks changes; consolidation triggered at threshold

## Search/Retrieval (search_agentic)
1. ChromaDB vector similarity search for top-k matches
2. For each match, follow its **links** to retrieve connected neighbors
3. Return both direct matches AND linked neighbors (marked with is_neighbor flag)
4. Deduplication via seen_ids set

## Key Design Principles
- Atomic notes (single unit of info)
- Unique identifiers (UUID)
- Bidirectional links (both directions)
- Dynamic evolution (memories update retroactively)
- Flexible categorization (multiple boxes)
- LLM-driven decisions (not static rules)

## Critical Requirements for Casterly Implementation
1. Note structure must have: content, timestamp, keywords, tags, context, embedding, links
2. Links must be BIDIRECTIONAL (if A→B then B→A)
3. Link generation must use BOTH embedding similarity AND LLM judgment
4. Memory evolution must update EXISTING notes when new ones arrive
5. Search must follow links to return connected memories (not just vector-similar)
6. Evolution history should be tracked
7. Consolidation should rebuild indices periodically

---

## Casterly Implementation Notes

### Module: `src/autonomous/memory/link-network.ts` (419 lines)

**What it implements well:**
- ✅ Bidirectional links with typed relationships (supports, contradicts, extends, derived_from, related)
- ✅ Strength scoring (0-1) on links
- ✅ Time-based decay (applyDecay) — links weaken over time when unaccessed
- ✅ Multi-hop neighborhood traversal (getNeighborhood via BFS)
- ✅ Adjacency index (Map<string, Set<string>>) for fast lookup
- ✅ Persistence (save/load to JSON at ~/.casterly/memory/links.json)
- ✅ Eviction of weakest links when at capacity (maxLinks=500)
- ✅ Self-link prevention
- ✅ Duplicate detection → strength reinforcement (+0.1)
- ✅ Annotation field for explaining links
- ✅ Good unit tests (tests/memory-link-network.test.ts, 153 lines)

### Module: `src/autonomous/memory/memory-evolution.ts` (405 lines)
- Companion A-MEM feature implementing strengthen/weaken/merge/split/generalize/specialize
- ✅ Full lineage tracking via EvolutionEvent records
- ✅ Persistence (save/load to JSON)
- ✅ Generation tracking for evolved memories

### What is MISSING or disconnected:

1. **NOT in the state lifecycle** — LinkNetwork is not loaded at cycle start or saved at cycle end.
   The memory-and-state.md State Lifecycle section shows all subsystems loaded/saved in parallel,
   but LinkNetwork is absent from both lists.

2. **No agent tools** — There are no tools (link_memories, get_links, etc.) that expose
   link operations to the LLM agent. The reserved tool list in synthesizer.ts does not include
   any link-related tools. The agent has no way to create or traverse links during a cycle.

3. **Not in memory-and-state.md** — The comprehensive state documentation lists 16 subsystems
   but does not mention LinkNetwork or MemoryEvolution.

4. **Not connected to MemoryEvolution** — In A-MEM, link generation and memory evolution are
   tightly coupled (process_memory creates links + evolves neighbors). Here they're fully
   separate modules with zero cross-references.

5. **No auto-link generation** — In A-MEM, links are automatically generated when new memories
   are added (embedding similarity → LLM judgment → bidirectional links). Casterly's LinkNetwork
   only supports manual createLink() calls but nothing triggers it automatically.

6. **No search integration** — In A-MEM, search_agentic follows links to return connected
   memories. The recall/search tools don't use LinkNetwork at all.

7. **Dream cycle integration missing** — applyDecay() exists but nothing calls it.
   Should run during dream cycles.

8. **GraphMemory overlap** — Feature 10 (GraphMemory) has a separate entity-relationship graph
   with no bridge to LinkNetwork. These could complement each other but currently don't interact.

---

## Fix List (Prioritized)

### Fix 1: Integrate LinkNetwork into state lifecycle
- Add LinkNetwork to the parallel load at cycle start
- Add LinkNetwork save at cycle end (if dirty)
- Add dirty flag tracking to LinkNetwork

### Fix 2: Connect MemoryEvolution to LinkNetwork
- When evolution events occur (strengthen, merge, split, generalize, specialize), automatically
  create corresponding links:
  - strengthen → 'supports' link between source and corroborating memory
  - merge → 'derived_from' links from merged result to both sources
  - split → 'derived_from' links from each sub-memory to original
  - generalize → 'derived_from' link from generalized to specific
  - specialize → 'derived_from' link from specialized to general

### Fix 3: Add dream cycle decay hook
- Call applyDecay() during dream cycle memory consolidation phase
- Save after decay

### Fix 4: Update memory-and-state.md documentation
- Add LinkNetwork and MemoryEvolution sections
- Add them to the State Lifecycle diagram
- Add them to the Key Files table
