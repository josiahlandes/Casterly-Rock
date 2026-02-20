/**
 * Dream Cycle Runner — Quiet-hours strategic consolidation
 *
 * During quiet hours, Tyrion runs dream cycles instead of normal agent
 * cycles. Dream cycles consolidate learnings, explore the codebase,
 * update the self-model, and write retrospectives.
 *
 * Dream cycle phases:
 *   1. consolidateReflections — Find patterns across recent reflections.
 *   2. updateWorldModel — Full codebase health check.
 *   3. reorganizeGoals — Reprioritize based on new information.
 *   4. explore — Read unfamiliar code, build understanding.
 *   5. updateSelfModel — Recalculate strengths/weaknesses.
 *   6. writeRetrospective — Weekly summary to MEMORY.md.
 *
 * Dream cycles are budget-limited (turns and time) and produce a
 * structured outcome for logging.
 *
 * Privacy: All operations are local. Dream cycle results contain
 * only codebase metadata and Tyrion's own observations.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getTracer } from '../debug.js';
import type { WorldModel } from '../world-model.js';
import type { GoalStack } from '../goal-stack.js';
import type { IssueLog } from '../issue-log.js';
import type { Reflector } from '../reflector.js';
import type { ContextManager } from '../context-manager.js';
import { SelfModel } from './self-model.js';
import { CodeArchaeologist } from './archaeology.js';
import type { FragileFile } from './archaeology.js';
import type { PromptStore } from '../prompt-store.js';
import type { ShadowStore } from '../shadow-store.js';
import type { ToolSynthesizer } from '../../tools/synthesizer.js';
import type { ChallengeGenerator } from './challenge-generator.js';
import type { ChallengeEvaluator } from './challenge-evaluator.js';
import type { PromptEvolution } from './prompt-evolution.js';
import type { TrainingExtractor } from './training-extractor.js';
import type { LoraTrainer } from './lora-trainer.js';
import type { Journal } from '../journal.js';
import type { LinkNetwork } from '../memory/link-network.js';
import type { AudnConsolidator } from '../memory/audn-consolidator.js';
import type { EntropyMigrator } from '../memory/entropy-migrator.js';
import type { MemoryVersioning } from '../memory/memory-versioning.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Configuration for dream cycles.
 */
export interface DreamCycleConfig {
  /** Whether dream cycles are enabled */
  enabled: boolean;

  /** Hours between consolidation runs */
  consolidationIntervalHours: number;

  /** Maximum turns for the exploration phase */
  explorationBudgetTurns: number;

  /** Hours between self-model rebuilds */
  selfModelRebuildIntervalHours: number;

  /** Days to look back for code archaeology */
  archaeologyLookbackDays: number;

  /** Days between retrospective writes */
  retrospectiveIntervalDays: number;

  /** Project root for code archaeology */
  projectRoot: string;
}

/**
 * Outcome of a dream cycle.
 */
export interface DreamOutcome {
  /** Phases that were executed */
  phasesCompleted: string[];

  /** Phases that were skipped */
  phasesSkipped: string[];

  /** Number of reflections consolidated */
  reflectionsConsolidated: number;

  /** Number of fragile files found */
  fragileFilesFound: number;

  /** Number of abandoned files found */
  abandonedFilesFound: number;

  /** Number of goals reorganized */
  goalsReorganized: number;

  /** Whether a retrospective was written */
  retrospectiveWritten: boolean;

  /** Whether the self-model was rebuilt */
  selfModelRebuilt: boolean;

  /** Number of shadows analyzed (Vision Tier 2) */
  shadowsAnalyzed: number;

  /** Number of old shadows pruned (Vision Tier 2) */
  shadowsPruned: number;

  /** Number of unused tools flagged (Vision Tier 2) */
  unusedToolsFlagged: number;

  /** Number of challenges generated (Vision Tier 3) */
  challengesGenerated: number;

  /** Number of challenges passed (Vision Tier 3) */
  challengesPassed: number;

  /** Whether prompt evolution ran (Vision Tier 3) */
  promptEvolutionRan: boolean;

  /** Number of training examples extracted (Vision Tier 3) */
  trainingExamplesExtracted: number;

  /** Number of weak memory links pruned by decay (Advanced Memory) */
  linksPruned: number;

  /** AUDN consolidation: candidates processed / added / updated / deleted / skipped */
  audnProcessed: number;
  audnAdded: number;
  audnUpdated: number;
  audnDeleted: number;
  audnSkipped: number;

  /** Entropy tier migration: entries evaluated / promotions / demotions */
  entropyEvaluated: number;
  entropyPromotions: number;
  entropyDemotions: number;

  /** Whether a memory snapshot was taken */
  snapshotTaken: boolean;

  /** Total duration in milliseconds */
  durationMs: number;

  /** Timestamp */
  timestamp: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: DreamCycleConfig = {
  enabled: true,
  consolidationIntervalHours: 24,
  explorationBudgetTurns: 50,
  selfModelRebuildIntervalHours: 48,
  archaeologyLookbackDays: 90,
  retrospectiveIntervalDays: 7,
  projectRoot: process.cwd(),
};

// ─────────────────────────────────────────────────────────────────────────────
// Dream Cycle Runner
// ─────────────────────────────────────────────────────────────────────────────

export class DreamCycleRunner {
  private readonly config: DreamCycleConfig;
  private readonly selfModel: SelfModel;
  private readonly archaeologist: CodeArchaeologist;
  private lastRetrospectiveDate: string = '';

  constructor(config?: Partial<DreamCycleConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.selfModel = new SelfModel();
    this.archaeologist = new CodeArchaeologist({
      projectRoot: this.config.projectRoot,
      fragileLookbackDays: this.config.archaeologyLookbackDays,
    });
  }

  // ── Main Entry Point ────────────────────────────────────────────────────

  /**
   * Run a full dream cycle. Executes each phase in sequence.
   * Individual phase failures don't abort the entire cycle.
   */
  async run(
    worldModel: WorldModel,
    goalStack: GoalStack,
    issueLog: IssueLog,
    reflector: Reflector,
    contextManager?: ContextManager,
    promptStore?: PromptStore,
    shadowStore?: ShadowStore,
    toolSynthesizer?: ToolSynthesizer,
    challengeGenerator?: ChallengeGenerator,
    challengeEvaluator?: ChallengeEvaluator,
    promptEvolution?: PromptEvolution,
    trainingExtractor?: TrainingExtractor,
    loraTrainer?: LoraTrainer,
    journal?: Journal,
    linkNetwork?: LinkNetwork,
    audnConsolidator?: AudnConsolidator,
    entropyMigrator?: EntropyMigrator,
    memoryVersioning?: MemoryVersioning,
  ): Promise<DreamOutcome> {
    const tracer = getTracer();
    const startMs = Date.now();

    return tracer.withSpan('dream', 'dreamCycle', async () => {
      tracer.log('dream', 'info', '=== Dream cycle starting ===');

      const outcome: DreamOutcome = {
        phasesCompleted: [],
        phasesSkipped: [],
        reflectionsConsolidated: 0,
        fragileFilesFound: 0,
        abandonedFilesFound: 0,
        goalsReorganized: 0,
        retrospectiveWritten: false,
        selfModelRebuilt: false,
        shadowsAnalyzed: 0,
        shadowsPruned: 0,
        unusedToolsFlagged: 0,
        challengesGenerated: 0,
        challengesPassed: 0,
        promptEvolutionRan: false,
        trainingExamplesExtracted: 0,
        linksPruned: 0,
        audnProcessed: 0,
        audnAdded: 0,
        audnUpdated: 0,
        audnDeleted: 0,
        audnSkipped: 0,
        entropyEvaluated: 0,
        entropyPromotions: 0,
        entropyDemotions: 0,
        snapshotTaken: false,
        durationMs: 0,
        timestamp: new Date().toISOString(),
      };

      // Phase 1: Consolidate reflections
      try {
        outcome.reflectionsConsolidated = await this.consolidateReflections(
          reflector,
          contextManager,
        );
        outcome.phasesCompleted.push('consolidateReflections');
      } catch (err) {
        tracer.log('dream', 'warn', `Consolidation failed: ${err instanceof Error ? err.message : String(err)}`);
        outcome.phasesSkipped.push('consolidateReflections');
      }

      // Phase 2: Update world model
      try {
        await this.updateWorldModel(worldModel);
        outcome.phasesCompleted.push('updateWorldModel');
      } catch (err) {
        tracer.log('dream', 'warn', `World model update failed: ${err instanceof Error ? err.message : String(err)}`);
        outcome.phasesSkipped.push('updateWorldModel');
      }

      // Phase 3: Reorganize goals
      try {
        outcome.goalsReorganized = this.reorganizeGoals(goalStack, issueLog);
        outcome.phasesCompleted.push('reorganizeGoals');
      } catch (err) {
        tracer.log('dream', 'warn', `Goal reorganization failed: ${err instanceof Error ? err.message : String(err)}`);
        outcome.phasesSkipped.push('reorganizeGoals');
      }

      // Phase 4: Explore (code archaeology)
      try {
        const { fragile, abandoned } = await this.explore();
        outcome.fragileFilesFound = fragile.length;
        outcome.abandonedFilesFound = abandoned.length;

        // File issues for very fragile code
        for (const f of fragile.slice(0, 3)) {
          if (f.fragilityScore > 10) {
            const existing = issueLog.getIssuesByFile(f.path);
            if (existing.length === 0) {
              issueLog.fileIssue({
                title: `Fragile code: ${f.path}`,
                description: `This file has been changed ${f.changeCount} times (${f.fixCount} fixes) in ${this.config.archaeologyLookbackDays} days. Consider refactoring.`,
                priority: 'low',
                relatedFiles: [f.path],
                discoveredBy: 'dream-cycle',
                tags: ['fragile', 'archaeology'],
              });
            }
          }
        }

        outcome.phasesCompleted.push('explore');
      } catch (err) {
        tracer.log('dream', 'warn', `Exploration failed: ${err instanceof Error ? err.message : String(err)}`);
        outcome.phasesSkipped.push('explore');
      }

      // Phase 5: Update self-model
      try {
        await this.selfModel.rebuild(issueLog, reflector);
        await this.selfModel.save();
        outcome.selfModelRebuilt = true;
        outcome.phasesCompleted.push('updateSelfModel');
      } catch (err) {
        tracer.log('dream', 'warn', `Self-model update failed: ${err instanceof Error ? err.message : String(err)}`);
        outcome.phasesSkipped.push('updateSelfModel');
      }

      // Phase 7a: Shadow analysis (Vision Tier 2)
      if (shadowStore) {
        try {
          const unassessed = shadowStore.getUnassessedShadows();
          outcome.shadowsAnalyzed = unassessed.length;

          // Prune old shadows
          outcome.shadowsPruned = shadowStore.pruneOldShadows();

          // Prune weak patterns
          shadowStore.pruneWeakPatterns();

          if (outcome.shadowsAnalyzed > 0 || outcome.shadowsPruned > 0) {
            await shadowStore.save();
          }
          outcome.phasesCompleted.push('shadowAnalysis');
        } catch (err) {
          tracer.log('dream', 'warn', `Shadow analysis failed: ${err instanceof Error ? err.message : String(err)}`);
          outcome.phasesSkipped.push('shadowAnalysis');
        }
      }

      // Phase 7b: Tool inventory management (Vision Tier 2)
      if (toolSynthesizer) {
        try {
          const unused = toolSynthesizer.getUnusedTools();
          outcome.unusedToolsFlagged = unused.length;

          // Auto-archive tools unused for the threshold period
          for (const tool of unused) {
            toolSynthesizer.archiveTool(tool.name);
            tracer.log('dream', 'info', `Archived unused tool: ${tool.name}`);
          }

          if (unused.length > 0) {
            await toolSynthesizer.save();
          }
          outcome.phasesCompleted.push('toolInventory');
        } catch (err) {
          tracer.log('dream', 'warn', `Tool inventory failed: ${err instanceof Error ? err.message : String(err)}`);
          outcome.phasesSkipped.push('toolInventory');
        }
      }

      // Phase 8a: Adversarial challenge generation (Vision Tier 3)
      if (challengeGenerator && challengeEvaluator) {
        try {
          const cycleId = `dream-${Date.now()}`;
          const batch = challengeGenerator.generateBatch(this.selfModel, cycleId);
          outcome.challengesGenerated = batch.challenges.length;

          // Summarize results (in a real run, challenges would be executed)
          if (batch.results.length > 0) {
            const summary = challengeGenerator.summarizeBatch(batch);
            challengeEvaluator.recordBatch(batch, summary);
            outcome.challengesPassed = summary.passed;
            await challengeEvaluator.save();
          }

          outcome.phasesCompleted.push('adversarialChallenges');
        } catch (err) {
          tracer.log('dream', 'warn', `Adversarial challenges failed: ${err instanceof Error ? err.message : String(err)}`);
          outcome.phasesSkipped.push('adversarialChallenges');
        }
      }

      // Phase 8b: Prompt evolution generation (Vision Tier 3)
      if (promptEvolution) {
        try {
          if (promptEvolution.isInitialized()) {
            // Only evolve if we have fitness data
            const pop = promptEvolution.getPopulation();
            const evaluated = pop.filter((v) => v.fitness !== null);
            if (evaluated.length >= 2) {
              promptEvolution.evolve();
              await promptEvolution.save();
              outcome.promptEvolutionRan = true;
            }
          }
          outcome.phasesCompleted.push('promptEvolution');
        } catch (err) {
          tracer.log('dream', 'warn', `Prompt evolution failed: ${err instanceof Error ? err.message : String(err)}`);
          outcome.phasesSkipped.push('promptEvolution');
        }
      }

      // Phase 8c: Training data extraction (Vision Tier 3)
      if (trainingExtractor && journal) {
        try {
          const dataset = await trainingExtractor.extract(journal, issueLog);
          outcome.trainingExamplesExtracted = dataset.totalExamples;

          if (dataset.totalExamples > 0) {
            await trainingExtractor.saveDataset(dataset);
          }

          outcome.phasesCompleted.push('trainingDataExtraction');
        } catch (err) {
          tracer.log('dream', 'warn', `Training data extraction failed: ${err instanceof Error ? err.message : String(err)}`);
          outcome.phasesSkipped.push('trainingDataExtraction');
        }
      }

      // Phase 9: Write retrospective
      try {
        outcome.retrospectiveWritten = await this.writeRetrospective(
          reflector,
          outcome,
        );
        if (outcome.retrospectiveWritten) {
          outcome.phasesCompleted.push('writeRetrospective');
        } else {
          outcome.phasesSkipped.push('writeRetrospective');
        }
      } catch (err) {
        tracer.log('dream', 'warn', `Retrospective failed: ${err instanceof Error ? err.message : String(err)}`);
        outcome.phasesSkipped.push('writeRetrospective');
      }

      // Phase 10: Link network decay (Advanced Memory: Zettelkasten A-MEM)
      if (linkNetwork) {
        try {
          outcome.linksPruned = linkNetwork.applyDecay();
          if (outcome.linksPruned > 0 || linkNetwork.count() > 0) {
            await linkNetwork.save();
          }
          outcome.phasesCompleted.push('linkDecay');
          tracer.log('dream', 'info', `Link decay: ${outcome.linksPruned} weak links pruned, ${linkNetwork.count()} remaining`);
        } catch (err) {
          tracer.log('dream', 'warn', `Link decay failed: ${err instanceof Error ? err.message : String(err)}`);
          outcome.phasesSkipped.push('linkDecay');
        }
      }

      // Phase 11: AUDN consolidation (Advanced Memory: Mem0)
      if (audnConsolidator && audnConsolidator.queueSize() > 0) {
        try {
          // Build existing memories map from crystals (via context manager cold tier)
          // For now, run consolidation against an empty map — the AUDN decision
          // engine still produces meaningful Add decisions for novel content,
          // and the dream cycle caller can supply richer maps in the future.
          const existingMemories = new Map<string, string>();

          // If we have a context manager, try to populate from crystal store
          // entries available in state. The crystal prompt is a reasonable proxy.
          // (Full integration with crystal store would require passing it here.)

          const report = audnConsolidator.consolidate(existingMemories);
          outcome.audnProcessed = report.processed;
          outcome.audnAdded = report.added;
          outcome.audnUpdated = report.updated;
          outcome.audnDeleted = report.deleted;
          outcome.audnSkipped = report.skipped;

          await audnConsolidator.save();
          outcome.phasesCompleted.push('audnConsolidation');
          tracer.log('dream', 'info', `AUDN consolidation: ${report.processed} candidates → ${report.added} add, ${report.updated} update, ${report.deleted} delete, ${report.skipped} skip`);
        } catch (err) {
          tracer.log('dream', 'warn', `AUDN consolidation failed: ${err instanceof Error ? err.message : String(err)}`);
          outcome.phasesSkipped.push('audnConsolidation');
        }
      }

      // Phase 12: Entropy-based tier migration evaluation (Advanced Memory: SAGE)
      if (entropyMigrator && contextManager) {
        try {
          // Build entries for scoring from warm tier (the most actionable tier for migration)
          const warmEntries = contextManager.getWarmTierContents();
          if (warmEntries.length > 0) {
            const entries = warmEntries.map((e) => ({
              id: e.key,
              content: e.content,
              currentTier: 'warm' as const,
              accessCount: e.accessCount,
              lastAccessedAt: e.addedAt,
              createdAt: e.addedAt,
            }));

            const report = entropyMigrator.evaluate(entries);
            outcome.entropyEvaluated = report.evaluated;
            outcome.entropyPromotions = report.promotions;
            outcome.entropyDemotions = report.demotions;

            outcome.phasesCompleted.push('entropyTierMigration');
            tracer.log('dream', 'info', `Entropy tier migration: ${report.evaluated} evaluated → ${report.promotions} promote, ${report.demotions} demote, ${report.stable} stable`);
          } else {
            outcome.phasesSkipped.push('entropyTierMigration');
          }
        } catch (err) {
          tracer.log('dream', 'warn', `Entropy tier migration failed: ${err instanceof Error ? err.message : String(err)}`);
          outcome.phasesSkipped.push('entropyTierMigration');
        }
      }

      // Phase 13: Memory snapshot (Advanced Memory: Git-Backed Versioning Letta)
      if (memoryVersioning) {
        try {
          const snapshot = await memoryVersioning.createSnapshot({
            trigger: 'dream_cycle',
            message: `Dream cycle snapshot — ${outcome.phasesCompleted.length} phases completed`,
          });
          outcome.snapshotTaken = true;
          await memoryVersioning.save();
          outcome.phasesCompleted.push('memorySnapshot');
          tracer.log('dream', 'info', `Memory snapshot created: ${snapshot.id}`);
        } catch (err) {
          tracer.log('dream', 'warn', `Memory snapshot failed: ${err instanceof Error ? err.message : String(err)}`);
          outcome.phasesSkipped.push('memorySnapshot');
        }
      }

      // Promote stale context entries
      if (contextManager) {
        try {
          await contextManager.promoteStaleEntries();
        } catch {
          // Non-critical
        }
      }

      outcome.durationMs = Date.now() - startMs;

      tracer.log('dream', 'info', '=== Dream cycle complete ===', {
        completed: outcome.phasesCompleted.length,
        skipped: outcome.phasesSkipped.length,
        durationMs: outcome.durationMs,
      });

      return outcome;
    });
  }

  // ── Individual Phases ───────────────────────────────────────────────────

  /**
   * Phase 1: Find patterns across recent reflections and archive them.
   */
  private async consolidateReflections(
    reflector: Reflector,
    contextManager?: ContextManager,
  ): Promise<number> {
    const tracer = getTracer();
    const reflections = await reflector.loadRecentReflections(50);

    if (reflections.length === 0) {
      tracer.log('dream', 'debug', 'No reflections to consolidate');
      return 0;
    }

    // Group reflections by outcome
    const successful = reflections.filter((r) => r.outcome === 'success');
    const failed = reflections.filter((r) => r.outcome === 'failure');

    // Archive consolidated insights to cool tier
    if (contextManager && successful.length > 0) {
      const insights = successful
        .map((r) => `- [${r.cycleId}] ${r.observation.suggestedArea}: ${r.learnings}`)
        .join('\n');

      await contextManager.archive({
        title: `Dream consolidation: ${successful.length} successful patterns`,
        content: insights,
        tags: ['dream', 'consolidation', 'success-patterns'],
        source: 'reflection',
      });
    }

    if (contextManager && failed.length > 0) {
      const failures = failed
        .map((r) => `- [${r.cycleId}] ${r.observation.suggestedArea}: ${r.learnings}`)
        .join('\n');

      await contextManager.archive({
        title: `Dream consolidation: ${failed.length} failure patterns`,
        content: failures,
        tags: ['dream', 'consolidation', 'failure-patterns'],
        source: 'reflection',
      });
    }

    // Ingest MEMORY.md into cold tier so recall() can search it.
    // MEMORY.md is write-only from the reflector's perspective — this
    // bridges it into the tiered memory system.
    if (contextManager) {
      try {
        const memoryPath = join(this.config.projectRoot, 'MEMORY.md');
        const memoryContent = await readFile(memoryPath, 'utf8');

        if (memoryContent.length > 100) {
          await contextManager.archive({
            title: 'MEMORY.md snapshot',
            content: memoryContent,
            tags: ['memory-md', 'learnings', 'dream'],
            tier: 'cold',
            source: 'archive',
          });
          tracer.log('dream', 'info', `Ingested MEMORY.md (${memoryContent.length} chars) into cold tier`);
        }
      } catch {
        // MEMORY.md doesn't exist yet — that's fine
      }
    }

    tracer.log('dream', 'info', `Consolidated ${reflections.length} reflections`, {
      successful: successful.length,
      failed: failed.length,
    });

    return reflections.length;
  }

  /**
   * Phase 2: Run a full codebase health check.
   */
  private async updateWorldModel(worldModel: WorldModel): Promise<void> {
    const tracer = getTracer();

    await worldModel.updateFromCodebase();
    await worldModel.save();

    tracer.log('dream', 'info', 'World model updated from codebase');
  }

  /**
   * Phase 3: Reprioritize goals based on current state.
   */
  private reorganizeGoals(goalStack: GoalStack, issueLog: IssueLog): number {
    const tracer = getTracer();
    let reorganized = 0;

    // Prune stale goals
    const staleGoals = goalStack.getStaleGoals();
    for (const g of staleGoals) {
      goalStack.removeGoal(g.id);
      reorganized++;
    }
    const pruned = staleGoals.length;

    // Check for high-priority issues that don't have goals yet
    const openIssues = issueLog.getOpenIssues();
    for (const issue of openIssues) {
      if (issue.priority === 'critical' || issue.priority === 'high') {
        const goals = goalStack.getOpenGoals();
        const hasGoal = goals.some(
          (g) => g.description.includes(issue.id) || g.description.includes(issue.title),
        );

        if (!hasGoal) {
          goalStack.addGoal({
            source: 'self',
            priority: issue.priority === 'critical' ? 2 : 3,
            description: `Investigate issue ${issue.id}: ${issue.title}`,
            notes: `Auto-created from ${issue.priority}-priority issue during dream cycle.`,
          });
          reorganized++;
        }
      }
    }

    tracer.log('dream', 'info', `Goals reorganized: ${reorganized} changes`, {
      pruned,
      newFromIssues: reorganized - pruned,
    });

    return reorganized;
  }

  /**
   * Phase 4: Explore the codebase — find fragile and abandoned code.
   */
  private async explore(): Promise<{
    fragile: FragileFile[];
    abandoned: string[];
  }> {
    const fragile = await this.archaeologist.findFragileCode();
    const abandoned = await this.archaeologist.findAbandonedCode();

    return { fragile, abandoned };
  }

  /**
   * Phase 6: Write a retrospective to MEMORY.md.
   * Only writes if enough time has passed since the last one
   * (respects retrospectiveIntervalDays config).
   */
  private async writeRetrospective(
    reflector: Reflector,
    outcome: DreamOutcome,
  ): Promise<boolean> {
    const tracer = getTracer();

    // Time-guard: only write once per retrospectiveIntervalDays
    const today = new Date().toISOString().split('T')[0] ?? '';
    if (this.lastRetrospectiveDate) {
      const lastDate = new Date(this.lastRetrospectiveDate).getTime();
      const intervalMs = this.config.retrospectiveIntervalDays * 24 * 60 * 60 * 1000;
      if (Date.now() - lastDate < intervalMs) {
        tracer.log('dream', 'debug', `Retrospective skipped: last written ${this.lastRetrospectiveDate}, interval is ${this.config.retrospectiveIntervalDays}d`);
        return false;
      }
    }

    // Build the narrative
    let narrative: string;
    try {
      narrative = await this.archaeologist.buildNarrative(
        this.config.retrospectiveIntervalDays,
      );
    } catch {
      narrative = 'Could not build project narrative.';
    }

    const summary = [
      `Dream cycle retrospective:`,
      `- Reflections consolidated: ${outcome.reflectionsConsolidated}`,
      `- Fragile files found: ${outcome.fragileFilesFound}`,
      `- Goals reorganized: ${outcome.goalsReorganized}`,
      `- Self-model rebuilt: ${outcome.selfModelRebuilt}`,
      '',
      narrative,
    ].join('\n');

    await reflector.appendToMemory({
      cycleId: `dream-${Date.now()}`,
      title: 'Dream Cycle Retrospective',
      content: summary,
    });

    this.lastRetrospectiveDate = today;
    tracer.log('dream', 'info', 'Retrospective written to MEMORY.md');
    return true;
  }

  // ── Accessors ──────────────────────────────────────────────────────────

  /**
   * Get the self-model for use in identity prompts.
   */
  getSelfModel(): SelfModel {
    return this.selfModel;
  }

  /**
   * Dream cycles are always available — the LLM decides when to run
   * them as low-priority goals. There is no toggle.
   */
  isEnabled(): boolean {
    return true;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────────────────────

export function createDreamCycleRunner(
  config?: Partial<DreamCycleConfig>,
): DreamCycleRunner {
  return new DreamCycleRunner(config);
}
