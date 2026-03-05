/**
 * Store Registry — Central catalog of all system stores
 *
 * Enumerates every store owned by the AutonomousLoop, provides a factory
 * to create them all with defaults, and exposes helpers to discover which
 * stores support load() and save() for lifecycle management.
 *
 * Store inventory is derived from src/autonomous/loop.ts — if a new store
 * is added there, it should be added here as well.
 *
 * Stores fall into four categories:
 *   1. Core stores (always created): worldModel, goalStack, issueLog, journal,
 *      contextManager, eventBus, linkNetwork, memoryEvolution, etc.
 *   2. Vision Tier 2 (optional): promptStore, shadowStore, toolSynthesizer.
 *   3. Vision Tier 3 (optional): challengeGenerator, challengeEvaluator,
 *      promptEvolution, trainingExtractor, loraTrainer, mlxLoraTrainer,
 *      adapterManager, spinTrainer.
 *   4. Stateless utilities: temporalInvalidation, memoryChecker,
 *      concurrentDreamExecutor, entropyMigrator, challengeGenerator,
 *      trainingExtractor, mlxLoraTrainer.
 */

// ── Core stores ──────────────────────────────────────────────────────────────
import { WorldModel } from '../autonomous/world-model.js';
import { GoalStack } from '../autonomous/goal-stack.js';
import { IssueLog } from '../autonomous/issue-log.js';
import { createJournal, type Journal } from '../autonomous/journal.js';
import { createContextManager, type ContextManager } from '../autonomous/context-manager.js';
import { EventBus } from '../autonomous/events.js';

// ── Advanced Memory stores ───────────────────────────────────────────────────
import { createLinkNetwork, type LinkNetwork } from '../autonomous/memory/link-network.js';
import { createMemoryEvolution, type MemoryEvolution } from '../autonomous/memory/memory-evolution.js';
import { createAudnConsolidator, type AudnConsolidator } from '../autonomous/memory/audn-consolidator.js';
import { createEntropyMigrator, type EntropyMigrator } from '../autonomous/memory/entropy-migrator.js';
import { createMemoryVersioning, type MemoryVersioning } from '../autonomous/memory/memory-versioning.js';
import { createTemporalInvalidation, type TemporalInvalidation } from '../autonomous/memory/temporal-invalidation.js';
import { createMemoryChecker, type MemoryChecker } from '../autonomous/memory/checker.js';
import { createSkillFilesManager, type SkillFilesManager } from '../autonomous/memory/skill-files.js';
import { createConcurrentDreamExecutor, type ConcurrentDreamExecutor } from '../autonomous/memory/concurrent-dreams.js';
import { createGraphMemory, type GraphMemory } from '../autonomous/memory/graph-memory.js';

// ── Vision Tier 2: Self-improvement stores ───────────────────────────────────
import { createPromptStore, type PromptStore } from '../autonomous/prompt-store.js';
import { createShadowStore, type ShadowStore } from '../autonomous/shadow-store.js';
import { createToolSynthesizer, type ToolSynthesizer } from '../tools/synthesizer.js';

// ── Vision Tier 3: Advanced self-improvement ─────────────────────────────────
import { createChallengeGenerator, type ChallengeGenerator } from '../autonomous/dream/challenge-generator.js';
import { createChallengeEvaluator, type ChallengeEvaluator } from '../autonomous/dream/challenge-evaluator.js';
import { createPromptEvolution, type PromptEvolution } from '../autonomous/dream/prompt-evolution.js';
import { createTrainingExtractor, type TrainingExtractor } from '../autonomous/dream/training-extractor.js';
import { createLoraTrainer, type LoraTrainer } from '../autonomous/dream/lora-trainer.js';
import { createMlxLoraTrainer, type MlxLoraTrainer } from '../autonomous/dream/mlx-lora-trainer.js';
import { createAdapterManager, type AdapterManager } from '../autonomous/dream/adapter-manager.js';
import { createSpinTrainer, type SpinTrainer } from '../autonomous/dream/spin-trainer.js';

// ─────────────────────────────────────────────────────────────────────────────
// AllStores Interface
// ─────────────────────────────────────────────────────────────────────────────

/**
 * All stores owned by the system.
 *
 * Core stores are always present. Vision tier stores are nullable — they
 * are only created when their respective tier is enabled.
 */
export interface AllStores {
  // ── Core (always present) ────────────────────────────────────────────────
  worldModel: WorldModel;
  goalStack: GoalStack;
  issueLog: IssueLog;
  journal: Journal;
  contextManager: ContextManager;
  eventBus: EventBus;

  // ── Advanced Memory (always present) ─────────────────────────────────────
  linkNetwork: LinkNetwork;
  memoryEvolution: MemoryEvolution;
  audnConsolidator: AudnConsolidator;
  entropyMigrator: EntropyMigrator;
  memoryVersioning: MemoryVersioning;
  temporalInvalidation: TemporalInvalidation;
  memoryChecker: MemoryChecker;
  skillFilesManager: SkillFilesManager;
  concurrentDreamExecutor: ConcurrentDreamExecutor;
  graphMemory: GraphMemory;

  // ── Vision Tier 2 (optional) ─────────────────────────────────────────────
  promptStore: PromptStore | null;
  shadowStore: ShadowStore | null;
  toolSynthesizer: ToolSynthesizer | null;

  // ── Vision Tier 3 (optional) ─────────────────────────────────────────────
  challengeGenerator: ChallengeGenerator | null;
  challengeEvaluator: ChallengeEvaluator | null;
  promptEvolution: PromptEvolution | null;
  trainingExtractor: TrainingExtractor | null;
  loraTrainer: LoraTrainer | null;
  mlxLoraTrainer: MlxLoraTrainer | null;
  adapterManager: AdapterManager | null;
  spinTrainer: SpinTrainer | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Loadable / Savable descriptor
// ─────────────────────────────────────────────────────────────────────────────

export interface LifecycleOp {
  name: string;
  load: () => Promise<void>;
}

export interface SaveOp {
  name: string;
  save: () => Promise<void>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Factory to create all stores with defaults.
 *
 * Core stores are always created. Vision tier stores start as null —
 * call `enableVisionTier2()` / `enableVisionTier3()` on the returned
 * object to populate them.
 */
export function createAllStores(): AllStores {
  const linkNetwork = createLinkNetwork();
  const memoryEvolution = createMemoryEvolution();
  // Couple: evolution operations auto-create links (matches loop.ts pattern)
  memoryEvolution.setLinkNetwork(linkNetwork);

  return {
    // Core
    worldModel: new WorldModel(),
    goalStack: new GoalStack(),
    issueLog: new IssueLog(),
    journal: createJournal(),
    contextManager: createContextManager(),
    eventBus: new EventBus({ maxQueueSize: 100, logEvents: true }),

    // Advanced Memory
    linkNetwork,
    memoryEvolution,
    audnConsolidator: createAudnConsolidator(),
    entropyMigrator: createEntropyMigrator(),
    memoryVersioning: createMemoryVersioning(),
    temporalInvalidation: createTemporalInvalidation(),
    memoryChecker: createMemoryChecker(),
    skillFilesManager: createSkillFilesManager(),
    concurrentDreamExecutor: createConcurrentDreamExecutor(),
    graphMemory: createGraphMemory(),

    // Vision Tier 2 — null by default
    promptStore: null,
    shadowStore: null,
    toolSynthesizer: null,

    // Vision Tier 3 — null by default
    challengeGenerator: null,
    challengeEvaluator: null,
    promptEvolution: null,
    trainingExtractor: null,
    loraTrainer: null,
    mlxLoraTrainer: null,
    adapterManager: null,
    spinTrainer: null,
  };
}

/**
 * Populate Vision Tier 2 stores on an existing AllStores instance.
 */
export function enableVisionTier2(stores: AllStores): void {
  stores.promptStore = createPromptStore();
  stores.shadowStore = createShadowStore();
  stores.toolSynthesizer = createToolSynthesizer();
}

/**
 * Populate Vision Tier 3 stores on an existing AllStores instance.
 */
export function enableVisionTier3(stores: AllStores): void {
  stores.challengeGenerator = createChallengeGenerator();
  stores.challengeEvaluator = createChallengeEvaluator();
  stores.promptEvolution = createPromptEvolution();
  stores.trainingExtractor = createTrainingExtractor();
  stores.loraTrainer = createLoraTrainer();
  stores.mlxLoraTrainer = createMlxLoraTrainer();
  stores.adapterManager = createAdapterManager();
  stores.spinTrainer = createSpinTrainer();
}

// ─────────────────────────────────────────────────────────────────────────────
// Lifecycle Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Get stores that support load().
 *
 * Includes core stores with load(), plus any active vision tier stores
 * that have load(). Stateless stores (temporalInvalidation, memoryChecker,
 * concurrentDreamExecutor, entropyMigrator, challengeGenerator,
 * trainingExtractor, mlxLoraTrainer) are excluded.
 *
 * Matches the set loaded in AutonomousLoop.loadState().
 */
export function loadableStores(stores: AllStores): LifecycleOp[] {
  const ops: LifecycleOp[] = [
    // Core — always loadable
    { name: 'worldModel', load: () => stores.worldModel.load() },
    { name: 'goalStack', load: () => stores.goalStack.load() },
    { name: 'issueLog', load: () => stores.issueLog.load() },
    { name: 'journal', load: () => stores.journal.load() },

    // Advanced Memory — loadable subset
    { name: 'linkNetwork', load: () => stores.linkNetwork.load() },
    { name: 'memoryEvolution', load: () => stores.memoryEvolution.load() },
    { name: 'audnConsolidator', load: () => stores.audnConsolidator.load() },
    { name: 'memoryVersioning', load: () => stores.memoryVersioning.load() },
    { name: 'skillFilesManager', load: () => stores.skillFilesManager.load() },
    { name: 'graphMemory', load: () => stores.graphMemory.load() },
  ];

  // Vision Tier 2 (optional)
  if (stores.promptStore) {
    const ps = stores.promptStore;
    ops.push({ name: 'promptStore', load: () => ps.load() });
  }
  if (stores.shadowStore) {
    const ss = stores.shadowStore;
    ops.push({ name: 'shadowStore', load: () => ss.load() });
  }
  if (stores.toolSynthesizer) {
    const ts = stores.toolSynthesizer;
    ops.push({ name: 'toolSynthesizer', load: () => ts.load() });
  }

  // Vision Tier 3 (optional, only those with load)
  if (stores.challengeEvaluator) {
    const ce = stores.challengeEvaluator;
    ops.push({ name: 'challengeEvaluator', load: () => ce.load() });
  }
  if (stores.promptEvolution) {
    const pe = stores.promptEvolution;
    ops.push({ name: 'promptEvolution', load: () => pe.load() });
  }
  if (stores.loraTrainer) {
    const lt = stores.loraTrainer;
    ops.push({ name: 'loraTrainer', load: () => lt.load() });
  }
  if (stores.adapterManager) {
    const am = stores.adapterManager;
    ops.push({ name: 'adapterManager', load: () => am.load() });
  }
  if (stores.spinTrainer) {
    const st = stores.spinTrainer;
    ops.push({ name: 'spinTrainer', load: () => st.load() });
  }

  return ops;
}

/**
 * Get stores that support save().
 *
 * Matches the set saved in AutonomousLoop.saveState().
 * Journal is excluded — it's append-only (no bulk save()).
 */
export function savableStores(stores: AllStores): SaveOp[] {
  const ops: SaveOp[] = [
    // Core — savable subset (journal is append-only, no save)
    { name: 'worldModel', save: () => stores.worldModel.save() },
    { name: 'goalStack', save: () => stores.goalStack.save() },
    { name: 'issueLog', save: () => stores.issueLog.save() },

    // Advanced Memory — savable subset
    { name: 'linkNetwork', save: () => stores.linkNetwork.save() },
    { name: 'memoryEvolution', save: () => stores.memoryEvolution.save() },
    { name: 'audnConsolidator', save: () => stores.audnConsolidator.save() },
    { name: 'memoryVersioning', save: () => stores.memoryVersioning.save() },
    { name: 'skillFilesManager', save: () => stores.skillFilesManager.save() },
    { name: 'graphMemory', save: () => stores.graphMemory.save() },
  ];

  // Vision Tier 2 (optional)
  if (stores.promptStore) {
    const ps = stores.promptStore;
    ops.push({ name: 'promptStore', save: () => ps.save() });
  }
  if (stores.shadowStore) {
    const ss = stores.shadowStore;
    ops.push({ name: 'shadowStore', save: () => ss.save() });
  }
  if (stores.toolSynthesizer) {
    const ts = stores.toolSynthesizer;
    ops.push({ name: 'toolSynthesizer', save: () => ts.save() });
  }

  // Vision Tier 3 (optional, only those with save)
  if (stores.challengeEvaluator) {
    const ce = stores.challengeEvaluator;
    ops.push({ name: 'challengeEvaluator', save: () => ce.save() });
  }
  if (stores.promptEvolution) {
    const pe = stores.promptEvolution;
    ops.push({ name: 'promptEvolution', save: () => pe.save() });
  }
  if (stores.loraTrainer) {
    const lt = stores.loraTrainer;
    ops.push({ name: 'loraTrainer', save: () => lt.save() });
  }
  if (stores.adapterManager) {
    const am = stores.adapterManager;
    ops.push({ name: 'adapterManager', save: () => am.save() });
  }
  if (stores.spinTrainer) {
    const st = stores.spinTrainer;
    ops.push({ name: 'spinTrainer', save: () => st.save() });
  }

  return ops;
}
