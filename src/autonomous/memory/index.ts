/**
 * Advanced Memory Module — Barrel Exports
 *
 * Collects all advanced memory features into a single import point.
 * Each feature is sourced from leading memory research:
 *
 *   1. Zettelkasten Link Network (A-MEM) — Bidirectional memory links
 *   2. AUDN Consolidation Cycle (Mem0) — Add/Update/Delete/Nothing decisions
 *   3. Entropy-Based Tier Migration (SAGE) — Information-theoretic tier placement
 *   4. Git-Backed Memory Versioning (Letta) — Snapshot and rollback
 *   5. Memory Evolution (A-MEM) — Merge, split, generalize, specialize
 *   6. Temporal Invalidation (Mem0) — TTL-based memory expiry
 *   7. Checker Pattern (SAGE) — Pre-storage validation
 *   8. Skill Files (Letta) — Persistent procedural memory
 *   9. Concurrent Dream Processing (Letta) — Parallel dream phases
 *  10. Graph Relational Memory (Mem0) — Entity-relationship graph
 */

// Feature 1: Zettelkasten Link Network (A-MEM)
export { LinkNetwork, createLinkNetwork } from './link-network.js';
export type { MemoryLink, LinkType, LinkNetworkConfig, LinkResult } from './link-network.js';

// Feature 2: AUDN Consolidation Cycle (Mem0)
export { AudnConsolidator, createAudnConsolidator } from './audn-consolidator.js';
export type {
  AudnDecision,
  MemoryCandidate,
  AudnEvaluation,
  ConsolidationReport,
  AudnConfig,
} from './audn-consolidator.js';

// Feature 3: Entropy-Based Tier Migration (SAGE)
export { EntropyMigrator, createEntropyMigrator, calculateEntropy } from './entropy-migrator.js';
export type {
  MemoryTier,
  MigrationCandidate,
  EntryForScoring,
  EntropyMigratorConfig,
  MigrationReport,
} from './entropy-migrator.js';

// Feature 4: Git-Backed Memory Versioning (Letta)
export { MemoryVersioning, createMemoryVersioning } from './memory-versioning.js';
export type {
  MemorySnapshot,
  SnapshotDiff,
  VersionDiff,
  MemoryVersioningConfig,
} from './memory-versioning.js';

// Feature 5: Memory Evolution (A-MEM)
export { MemoryEvolution, createMemoryEvolution } from './memory-evolution.js';
export type {
  EvolutionOp,
  EvolutionEvent,
  EvolvableMemory,
  EvolutionConfig,
} from './memory-evolution.js';

// Feature 6: Temporal Invalidation (Mem0)
export { TemporalInvalidation, createTemporalInvalidation } from './temporal-invalidation.js';
export type {
  DecayFunction,
  TtlPolicy,
  TrackedEntry,
  InvalidationReport,
  TemporalInvalidationConfig,
} from './temporal-invalidation.js';

// Feature 7: Checker Pattern (SAGE)
export { MemoryChecker, createMemoryChecker } from './checker.js';
export type {
  CheckName,
  Verdict,
  CheckResult,
  CheckerVerdict,
  ExistingKnowledge,
  CheckerConfig,
} from './checker.js';

// Feature 8: Skill Files (Letta)
export { SkillFilesManager, createSkillFilesManager } from './skill-files.js';
export type {
  MasteryLevel,
  SkillFile,
  SkillFilesConfig,
  SkillResult,
} from './skill-files.js';

// Feature 9: Concurrent Dream Processing (Letta)
export { ConcurrentDreamExecutor, createConcurrentDreamExecutor } from './concurrent-dreams.js';
export type {
  DreamPhase,
  PhaseResult,
  ConcurrentDreamResult,
  ConcurrentDreamConfig,
} from './concurrent-dreams.js';

// Feature 10: Graph Relational Memory (Mem0)
export { GraphMemory, createGraphMemory } from './graph-memory.js';
export type {
  NodeType,
  EdgeType,
  GraphNode,
  GraphEdge,
  GraphMemoryConfig,
} from './graph-memory.js';
