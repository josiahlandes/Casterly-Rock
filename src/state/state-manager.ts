/**
 * State Manager — Central lifecycle manager for all system stores
 *
 * Owns the AllStores instance and provides:
 *   - Parallel load/save of all persistent stores
 *   - Role-scoped views (planner, coder, reviewer) that project only
 *     what each role needs
 *   - Direct store access for backward compatibility with AutonomousLoop
 *   - Vision tier activation
 *
 * This replaces the scattered state management in AutonomousLoop with a
 * single, testable, composable unit. The loop delegates to StateManager
 * for all store lifecycle operations.
 */

import type { PlannerView, CoderView, ReviewerView } from './views.js';
import type { AllStores } from './store-registry.js';
import {
  createAllStores,
  enableVisionTier2,
  enableVisionTier3,
  loadableStores,
  savableStores,
} from './store-registry.js';
import type { AgentToolkit } from '../autonomous/tools/types.js';
import { getTracer } from '../autonomous/debug.js';

// ─────────────────────────────────────────────────────────────────────────────
// StateManager
// ─────────────────────────────────────────────────────────────────────────────

export class StateManager {
  private stores: AllStores;
  private projectDir: string;
  private toolkit: AgentToolkit | undefined;

  constructor(projectDir: string, toolkit?: AgentToolkit) {
    this.stores = createAllStores();
    this.projectDir = projectDir;
    this.toolkit = toolkit;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  /**
   * Load all persistent stores in parallel.
   *
   * Uses Promise.allSettled so a single store failure doesn't block the
   * rest. Failures are logged but not thrown — the system continues with
   * whatever state loaded successfully.
   */
  async load(): Promise<void> {
    const tracer = getTracer();
    tracer.log('memory', 'debug', 'Loading all persistent stores');

    const loadable = loadableStores(this.stores);
    const results = await Promise.allSettled(loadable.map(s => s.load()));

    // Log any failures
    for (let i = 0; i < results.length; i++) {
      const result = results[i]!;
      if (result.status === 'rejected') {
        const storeName = loadable[i]!.name;
        tracer.log('memory', 'warn', `Failed to load store: ${storeName}`, {
          error: result.reason instanceof Error ? result.reason.message : String(result.reason),
        });
      }
    }

    tracer.log('memory', 'debug', `Loaded ${loadable.length} stores`);
  }

  /**
   * Save all persistent stores in parallel.
   *
   * Uses Promise.allSettled so a single store failure doesn't block the
   * rest. Failures are logged but not thrown.
   */
  async save(): Promise<void> {
    const tracer = getTracer();
    tracer.log('memory', 'debug', 'Saving all persistent stores');

    const savable = savableStores(this.stores);
    const results = await Promise.allSettled(savable.map(s => s.save()));

    // Log any failures
    for (let i = 0; i < results.length; i++) {
      const result = results[i]!;
      if (result.status === 'rejected') {
        const storeName = savable[i]!.name;
        tracer.log('memory', 'warn', `Failed to save store: ${storeName}`, {
          error: result.reason instanceof Error ? result.reason.message : String(result.reason),
        });
      }
    }

    tracer.log('memory', 'debug', `Saved ${savable.length} stores`);
  }

  // ── Vision Tier Activation ─────────────────────────────────────────────────

  /**
   * Enable Vision Tier 2 stores (promptStore, shadowStore, toolSynthesizer).
   */
  enableTier2(): void {
    enableVisionTier2(this.stores);
  }

  /**
   * Enable Vision Tier 3 stores (challengeGenerator, challengeEvaluator,
   * promptEvolution, trainingExtractor, loraTrainer, mlxLoraTrainer,
   * adapterManager, spinTrainer).
   */
  enableTier3(): void {
    enableVisionTier3(this.stores);
  }

  // ── Role-Scoped Views ──────────────────────────────────────────────────────

  /**
   * Planner view — rich context for planning decisions.
   */
  plannerView(): PlannerView {
    return {
      worldModel: this.stores.worldModel,
      goalStack: this.stores.goalStack,
      issueLog: this.stores.issueLog,
      skillFiles: this.stores.skillFilesManager,
      journal: this.stores.journal,
      contextManager: this.stores.contextManager,
      linkNetwork: this.stores.linkNetwork,
      memoryEvolution: this.stores.memoryEvolution,
      graphMemory: this.stores.graphMemory,
    };
  }

  /**
   * Coder view — minimal, just project root and tools.
   */
  coderView(): CoderView {
    return {
      projectDir: this.projectDir,
      toolkit: this.toolkit,
    };
  }

  /**
   * Reviewer view — read-only state for informed review.
   */
  reviewerView(): ReviewerView {
    return {
      worldModel: this.stores.worldModel,
      goalStack: this.stores.goalStack,
      issueLog: this.stores.issueLog,
    };
  }

  // ── Direct Store Access (FullView for AutonomousLoop) ──────────────────────

  /**
   * Get all stores directly. Used by AutonomousLoop for full access.
   */
  getStores(): AllStores {
    return this.stores;
  }

  // ── Convenience Getters (backward compatibility) ───────────────────────────

  get worldModel() { return this.stores.worldModel; }
  get goalStack() { return this.stores.goalStack; }
  get issueLog() { return this.stores.issueLog; }
  get skillFiles() { return this.stores.skillFilesManager; }
  get journal() { return this.stores.journal; }
  get contextManager() { return this.stores.contextManager; }
  get eventBus() { return this.stores.eventBus; }
  get linkNetwork() { return this.stores.linkNetwork; }
  get memoryEvolution() { return this.stores.memoryEvolution; }
  get audnConsolidator() { return this.stores.audnConsolidator; }
  get entropyMigrator() { return this.stores.entropyMigrator; }
  get memoryVersioning() { return this.stores.memoryVersioning; }
  get temporalInvalidation() { return this.stores.temporalInvalidation; }
  get memoryChecker() { return this.stores.memoryChecker; }
  get skillFilesManager() { return this.stores.skillFilesManager; }
  get concurrentDreamExecutor() { return this.stores.concurrentDreamExecutor; }
  get graphMemory() { return this.stores.graphMemory; }

  // Vision Tier 2
  get promptStore() { return this.stores.promptStore; }
  get shadowStore() { return this.stores.shadowStore; }
  get toolSynthesizer() { return this.stores.toolSynthesizer; }

  // Vision Tier 3
  get challengeGenerator() { return this.stores.challengeGenerator; }
  get challengeEvaluator() { return this.stores.challengeEvaluator; }
  get promptEvolution() { return this.stores.promptEvolution; }
  get trainingExtractor() { return this.stores.trainingExtractor; }
  get loraTrainer() { return this.stores.loraTrainer; }
  get mlxLoraTrainer() { return this.stores.mlxLoraTrainer; }
  get adapterManager() { return this.stores.adapterManager; }
  get spinTrainer() { return this.stores.spinTrainer; }

  // ── Toolkit Management ─────────────────────────────────────────────────────

  /**
   * Update the toolkit reference. Called when the toolkit is rebuilt
   * (e.g., after enabling new tool categories).
   */
  setToolkit(toolkit: AgentToolkit): void {
    this.toolkit = toolkit;
  }

  /**
   * Get the current project directory.
   */
  getProjectDir(): string {
    return this.projectDir;
  }
}
