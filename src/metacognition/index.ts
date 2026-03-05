/**
 * Metacognition Module — Tyrion's Self-Awareness Layer
 *
 * This module gives Tyrion the ability to know what he knows, know what
 * he doesn't know, and avoid confidently stating things he hasn't verified.
 *
 * Components:
 *   - CognitiveMap: Persistent spatial model of the machine & filesystem
 *   - KnowledgeManifest: Hot-tier table of contents for all knowledge sources
 *   - Preflection: Pre-planning retrieval planner (cheap LLM or heuristic)
 *   - ConfabulationGuard: System prompt injection + post-response audit
 *   - Explorer: Dream-cycle curiosity & territory mapping
 *
 * Integration points:
 *   - identity.ts: cognitive map summary + knowledge manifest → hot tier
 *   - agent-loop.ts: preflection before planning, guard in system prompt
 *   - deep-loop.ts: contextual guard injection based on preflection
 *   - dream cycle: explorer runs one directory per cycle
 *   - state-manager.ts: cognitive map load/save alongside other stores
 *
 * @module metacognition
 */

// ── Core Components ──────────────────────────────────────────────────────────

export { CognitiveMap, createCognitiveMap } from './cognitive-map.js';
export type {
  CognitiveMapConfig,
  CognitiveMapData,
  MachineInfo,
  RuntimeInfo,
  DirectoryEntry,
  DirectoryFamiliarity,
} from './cognitive-map.js';

export { buildKnowledgeManifest } from './knowledge-manifest.js';
export type {
  KnowledgeSource,
  ManifestInputs,
} from './knowledge-manifest.js';

export { preflect, preflectHeuristic } from './preflect.js';
export type {
  PreflectionResult,
  PreflectConfig,
} from './preflect.js';

export {
  CONFABULATION_GUARD_PROMPT,
  buildContextualGuard,
  auditResponse,
  requiresGrounding,
} from './confabulation-guard.js';
export type {
  ClaimConfidence,
  FactualClaim,
  AuditResult,
} from './confabulation-guard.js';

export { Explorer, createExplorer } from './explorer.js';
export type {
  ExplorationResult,
  ExplorationFindings,
  ExplorerConfig,
} from './explorer.js';
