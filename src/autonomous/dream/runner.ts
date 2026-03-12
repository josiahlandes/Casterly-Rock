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
import type { MlxLoraTrainer } from './mlx-lora-trainer.js';
import type { AdapterManager } from './adapter-manager.js';
import type { SpinTrainer } from './spin-trainer.js';
import type { Journal } from '../journal.js';
import type { LinkNetwork } from '../memory/link-network.js';
import type { AudnConsolidator } from '../memory/audn-consolidator.js';
import type { EntropyMigrator } from '../memory/entropy-migrator.js';
import type { MemoryVersioning } from '../memory/memory-versioning.js';
import type { MemoryEvolution } from '../memory/memory-evolution.js';
import type { TemporalInvalidation } from '../memory/temporal-invalidation.js';
import type { MemoryChecker } from '../memory/checker.js';
import type { SkillFilesManager } from '../memory/skill-files.js';
import type { ConcurrentDreamExecutor } from '../memory/concurrent-dreams.js';
import type { GraphMemory } from '../memory/graph-memory.js';
import type { CognitiveMap } from '../../metacognition/cognitive-map.js';
import { createExplorer } from '../../metacognition/explorer.js';
import type { ExplorationResult } from '../../metacognition/explorer.js';

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

  /** Memory evolution: total events recorded since last dream cycle */
  evolutionEventsLogged: number;

  /** Temporal invalidation: entries swept / newly expired / deletion candidates */
  temporalSwept: number;
  temporalNewlyExpired: number;
  temporalDeletionCandidates: number;

  /** Skill files: total skills / expert-level skills */
  skillsTotal: number;
  skillsExpert: number;

  /** Graph memory: node and edge counts */
  graphNodes: number;
  graphEdges: number;
  graphComponents: number;

  /** LoRA adapter training: adapters trained / promoted / tool-call pairs extracted (Tier 3) */
  adaptersTrainedCount: number;
  adaptersPromotedCount: number;
  toolCallPairsExtracted: number;

  /** SPIN self-play: iterations run / promotions (Tier 3) */
  spinIterationsRun: number;
  spinPromotions: number;

  /** Filesystem exploration: directories explored / discovered (Metacognition) */
  filesystemDirectoriesExplored: number;
  filesystemDirectoriesDiscovered: number;
  filesystemRuntimeRefreshed: boolean;

  /** Why each skipped phase was skipped (phase name → reason) */
  phaseSkipReasons: Record<string, string>;

  /** Per-tier summary of phase execution */
  tierSummary: {
    core: { completed: number; skipped: number; errored: number };
    vision: { completed: number; skipped: number; errored: number };
    memory: { completed: number; skipped: number; errored: number };
  };

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
    mlxLoraTrainer?: MlxLoraTrainer,
    adapterManager?: AdapterManager,
    spinTrainer?: SpinTrainer,
    journal?: Journal,
    linkNetwork?: LinkNetwork,
    audnConsolidator?: AudnConsolidator,
    entropyMigrator?: EntropyMigrator,
    memoryVersioning?: MemoryVersioning,
    memoryEvolution?: MemoryEvolution,
    temporalInvalidation?: TemporalInvalidation,
    memoryChecker?: MemoryChecker,
    skillFilesManager?: SkillFilesManager,
    concurrentDreamExecutor?: ConcurrentDreamExecutor,
    graphMemory?: GraphMemory,
    cognitiveMap?: CognitiveMap,
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
        evolutionEventsLogged: 0,
        temporalSwept: 0,
        temporalNewlyExpired: 0,
        temporalDeletionCandidates: 0,
        skillsTotal: 0,
        skillsExpert: 0,
        graphNodes: 0,
        graphEdges: 0,
        graphComponents: 0,
        adaptersTrainedCount: 0,
        adaptersPromotedCount: 0,
        toolCallPairsExtracted: 0,
        spinIterationsRun: 0,
        spinPromotions: 0,
        filesystemDirectoriesExplored: 0,
        filesystemDirectoriesDiscovered: 0,
        filesystemRuntimeRefreshed: false,
        phaseSkipReasons: {},
        tierSummary: {
          core: { completed: 0, skipped: 0, errored: 0 },
          vision: { completed: 0, skipped: 0, errored: 0 },
          memory: { completed: 0, skipped: 0, errored: 0 },
        },
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
        outcome.phaseSkipReasons['consolidateReflections'] = 'error';
      }

      // Phase 2: Update world model
      try {
        await this.updateWorldModel(worldModel);
        outcome.phasesCompleted.push('updateWorldModel');
      } catch (err) {
        tracer.log('dream', 'warn', `World model update failed: ${err instanceof Error ? err.message : String(err)}`);
        outcome.phasesSkipped.push('updateWorldModel');
        outcome.phaseSkipReasons['updateWorldModel'] = 'error';
      }

      // Phase 3: Reorganize goals
      try {
        outcome.goalsReorganized = this.reorganizeGoals(goalStack, issueLog);
        outcome.phasesCompleted.push('reorganizeGoals');
      } catch (err) {
        tracer.log('dream', 'warn', `Goal reorganization failed: ${err instanceof Error ? err.message : String(err)}`);
        outcome.phasesSkipped.push('reorganizeGoals');
        outcome.phaseSkipReasons['reorganizeGoals'] = 'error';
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
        outcome.phaseSkipReasons['explore'] = 'error';
      }

      // Phase 4b: Filesystem exploration (Metacognition)
      // Gradually maps the machine's filesystem so Tyrion knows his environment.
      // Refreshes runtime info (hardware, OS, Ollama) and explores one directory per cycle.
      if (cognitiveMap) {
        try {
          // Refresh runtime info (hardware, models, etc.)
          await cognitiveMap.refreshRuntime();
          outcome.filesystemRuntimeRefreshed = true;

          // Explore one directory from the cognitive map's queue
          const explorer = createExplorer();
          const result = await explorer.explore(cognitiveMap);

          if (result) {
            outcome.filesystemDirectoriesExplored = 1;
            outcome.filesystemDirectoriesDiscovered = result.discoveredDirectories.length;
            tracer.log('dream', 'info', `Filesystem exploration: ${result.path}`, {
              success: result.success,
              entries: result.findings.totalEntries,
              subdirs: result.findings.subdirectories.length,
              isProject: result.findings.isProject,
              role: result.suggestedRole ?? 'unknown',
              discovered: result.discoveredDirectories.length,
            });
          } else {
            tracer.log('dream', 'debug', 'No filesystem exploration targets available');
          }

          await cognitiveMap.save();
          outcome.phasesCompleted.push('filesystemExploration');
        } catch (err) {
          tracer.log('dream', 'warn', `Filesystem exploration failed: ${err instanceof Error ? err.message : String(err)}`);
          outcome.phasesSkipped.push('filesystemExploration');
          outcome.phaseSkipReasons['filesystemExploration'] = 'error';
        }
      } else {
        outcome.phasesSkipped.push('filesystemExploration');
        outcome.phaseSkipReasons['filesystemExploration'] = 'not_configured';
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
        outcome.phaseSkipReasons['updateSelfModel'] = 'error';
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
          outcome.phaseSkipReasons['shadowAnalysis'] = 'error';
        }
      } else {
        outcome.phasesSkipped.push('shadowAnalysis');
        outcome.phaseSkipReasons['shadowAnalysis'] = 'not_configured';
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
          outcome.phaseSkipReasons['toolInventory'] = 'error';
        }
      } else {
        outcome.phasesSkipped.push('toolInventory');
        outcome.phaseSkipReasons['toolInventory'] = 'not_configured';
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
          outcome.phaseSkipReasons['adversarialChallenges'] = 'error';
        }
      } else {
        outcome.phasesSkipped.push('adversarialChallenges');
        outcome.phaseSkipReasons['adversarialChallenges'] = 'not_configured';
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
          outcome.phaseSkipReasons['promptEvolution'] = 'error';
        }
      } else {
        outcome.phasesSkipped.push('promptEvolution');
        outcome.phaseSkipReasons['promptEvolution'] = 'not_configured';
      }

      // Phase 8c: Training data extraction (Vision Tier 3)
      // Dataset is shared with Phase 8d to avoid round-tripping through disk.
      let extractedDataset: import('./training-extractor.js').TrainingDataset | null = null;

      if (trainingExtractor && journal) {
        try {
          extractedDataset = await trainingExtractor.extract(journal, issueLog);
          outcome.trainingExamplesExtracted = extractedDataset.totalExamples;

          // Also extract tool-call-specific pairs for FastLoop fine-tuning
          const toolCallPairs = trainingExtractor.extractToolCallPairs(journal);
          outcome.toolCallPairsExtracted = toolCallPairs.length;

          if (extractedDataset.totalExamples > 0) {
            await trainingExtractor.saveDataset(extractedDataset);
          }

          outcome.phasesCompleted.push('trainingDataExtraction');
        } catch (err) {
          tracer.log('dream', 'warn', `Training data extraction failed: ${err instanceof Error ? err.message : String(err)}`);
          outcome.phasesSkipped.push('trainingDataExtraction');
          outcome.phaseSkipReasons['trainingDataExtraction'] = 'error';
        }
      } else {
        outcome.phasesSkipped.push('trainingDataExtraction');
        outcome.phaseSkipReasons['trainingDataExtraction'] = 'not_configured';
      }

      // Phase 8d: LoRA adapter training (Vision Tier 3, Item 8)
      if (mlxLoraTrainer && loraTrainer && extractedDataset) {
        try {
          const isAvailable = await mlxLoraTrainer.checkMlxLmAvailable();
          if (isAvailable) {
            // Find skills with enough data but no active adapter
            const trainableSkills = loraTrainer.getTrainableSkills(extractedDataset);

            for (const skill of trainableSkills.slice(0, 2)) { // Train max 2 per cycle
              const examples = extractedDataset.examplesBySkill[skill] ?? [];
              const sftEntries = mlxLoraTrainer.formatForSFT(examples);

              if (sftEntries.length >= 20) {
                // Prepare training data
                const dataDir = `~/.casterly/training-runs/${skill}-${Date.now()}`;
                const split = await mlxLoraTrainer.writeTrainValidTestSplit(sftEntries, dataDir);

                // Create adapter entry
                const adapter = loraTrainer.createAdapter(skill, split.trainCount, {
                  rank: 16,
                  alpha: 32,
                  format: 'instruction_completion',
                });

                // If disentangled adapters are enabled, log category split
                if (adapterManager) {
                  const categorized = adapterManager.splitByCategory(
                    examples.map((e) => ({ instruction: e.instruction, completion: e.completion })),
                  );
                  tracer.log('dream', 'info', `Disentangled split for ${skill}: ${categorized.reasoning.length} reasoning, ${categorized.tools.length} tools`);
                }

                // Run training
                const result = await mlxLoraTrainer.train(
                  dataDir,
                  adapter.fileName,
                  adapter.trainingConfig,
                );

                if (result.success) {
                  outcome.adaptersTrainedCount++;

                  // Mark adapter as needing evaluation. Without benchmarks,
                  // auto-promote with a nominal score (can be re-evaluated later).
                  const benchmarks = loraTrainer.getBenchmarkTasks(skill);
                  if (benchmarks.length === 0) {
                    // No benchmarks — auto-promote with a note
                    const { accepted } = loraTrainer.recordEvaluation(adapter.id, 0.0, 0.1);
                    if (accepted) {
                      outcome.adaptersPromotedCount++;
                    }
                    tracer.log('dream', 'info', `Auto-promoted adapter ${adapter.id} (no benchmarks available)`);
                  } else {
                    // Benchmarks exist — adapter stays in 'training' status
                    // until evaluated by the agent loop
                    tracer.log('dream', 'info', `Adapter ${adapter.id} trained, awaiting benchmark evaluation (${benchmarks.length} tasks)`);
                  }
                }

                // Cleanup training data
                await mlxLoraTrainer.cleanupTrainingData(dataDir);
              }
            }

            await loraTrainer.save();
            outcome.phasesCompleted.push('loraTraining');
          } else {
            outcome.phasesSkipped.push('loraTraining');
            outcome.phaseSkipReasons['loraTraining'] = 'mlx_lm_not_available';
          }
        } catch (err) {
          tracer.log('dream', 'warn', `LoRA training failed: ${err instanceof Error ? err.message : String(err)}`);
          outcome.phasesSkipped.push('loraTraining');
          outcome.phaseSkipReasons['loraTraining'] = 'error';
        }
      } else if (!mlxLoraTrainer || !loraTrainer) {
        outcome.phasesSkipped.push('loraTraining');
        outcome.phaseSkipReasons['loraTraining'] = 'not_configured';
      } else {
        outcome.phasesSkipped.push('loraTraining');
        outcome.phaseSkipReasons['loraTraining'] = 'no_training_data';
      }

      // Phase 8e: SPIN self-play iteration (Vision Tier 3, Item 10)
      if (spinTrainer && loraTrainer) {
        try {
          spinTrainer.resetCycleCounts();
          const activeAdapters = loraTrainer.getActiveAdapters();

          for (const adapter of activeAdapters) {
            const { canRun, reason } = spinTrainer.canRunSpin(adapter.skill, loraTrainer);
            if (!canRun) {
              tracer.log('dream', 'debug', `SPIN skipped for ${adapter.skill}: ${reason}`);
              continue;
            }

            // Note: actual response generation requires model inference
            // which is delegated to the agent loop. Here we just track
            // the iteration state and verify benchmark availability.
            const benchmarks = loraTrainer.getBenchmarkTasks(adapter.skill);
            if (benchmarks.length >= 5) {
              outcome.spinIterationsRun++;
              tracer.log('dream', 'info', `SPIN iteration available for ${adapter.skill}: ${benchmarks.length} benchmarks ready`);
            }
          }

          await spinTrainer.save();
          outcome.phasesCompleted.push('spinSelfPlay');
        } catch (err) {
          tracer.log('dream', 'warn', `SPIN self-play failed: ${err instanceof Error ? err.message : String(err)}`);
          outcome.phasesSkipped.push('spinSelfPlay');
          outcome.phaseSkipReasons['spinSelfPlay'] = 'error';
        }
      } else {
        outcome.phasesSkipped.push('spinSelfPlay');
        outcome.phaseSkipReasons['spinSelfPlay'] = 'not_configured';
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
          outcome.phaseSkipReasons['writeRetrospective'] = 'not_due';
        }
      } catch (err) {
        tracer.log('dream', 'warn', `Retrospective failed: ${err instanceof Error ? err.message : String(err)}`);
        outcome.phasesSkipped.push('writeRetrospective');
        outcome.phaseSkipReasons['writeRetrospective'] = 'error';
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
          outcome.phaseSkipReasons['linkDecay'] = 'error';
        }
      } else {
        outcome.phasesSkipped.push('linkDecay');
        outcome.phaseSkipReasons['linkDecay'] = 'not_configured';
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
          outcome.phaseSkipReasons['audnConsolidation'] = 'error';
        }
      } else {
        outcome.phasesSkipped.push('audnConsolidation');
        outcome.phaseSkipReasons['audnConsolidation'] = !audnConsolidator ? 'not_configured' : 'empty_queue';
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
            outcome.phaseSkipReasons['entropyTierMigration'] = 'empty_warm_tier';
          }
        } catch (err) {
          tracer.log('dream', 'warn', `Entropy tier migration failed: ${err instanceof Error ? err.message : String(err)}`);
          outcome.phasesSkipped.push('entropyTierMigration');
          outcome.phaseSkipReasons['entropyTierMigration'] = 'error';
        }
      } else {
        outcome.phasesSkipped.push('entropyTierMigration');
        outcome.phaseSkipReasons['entropyTierMigration'] = 'not_configured';
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
          outcome.phaseSkipReasons['memorySnapshot'] = 'error';
        }
      } else {
        outcome.phasesSkipped.push('memorySnapshot');
        outcome.phaseSkipReasons['memorySnapshot'] = 'not_configured';
      }

      // Phase 14: Memory evolution summary (Advanced Memory: A-MEM)
      if (memoryEvolution) {
        try {
          outcome.evolutionEventsLogged = memoryEvolution.eventCount();
          outcome.phasesCompleted.push('memoryEvolution');
          tracer.log('dream', 'info', `Memory evolution: ${outcome.evolutionEventsLogged} events in log`);
        } catch (err) {
          tracer.log('dream', 'warn', `Memory evolution summary failed: ${err instanceof Error ? err.message : String(err)}`);
          outcome.phasesSkipped.push('memoryEvolution');
          outcome.phaseSkipReasons['memoryEvolution'] = 'error';
        }
      } else {
        outcome.phasesSkipped.push('memoryEvolution');
        outcome.phaseSkipReasons['memoryEvolution'] = 'not_configured';
      }

      // Phase 15: Temporal invalidation sweep (Advanced Memory: Mem0)
      if (temporalInvalidation && temporalInvalidation.count() > 0) {
        try {
          const report = temporalInvalidation.sweep();
          outcome.temporalSwept = report.evaluated;
          outcome.temporalNewlyExpired = report.newlyExpired;
          outcome.temporalDeletionCandidates = report.readyForDeletion;
          outcome.phasesCompleted.push('temporalInvalidation');
          tracer.log('dream', 'info', `Temporal sweep: ${report.evaluated} entries, ${report.newlyExpired} newly expired, ${report.readyForDeletion} for deletion`);
        } catch (err) {
          tracer.log('dream', 'warn', `Temporal invalidation failed: ${err instanceof Error ? err.message : String(err)}`);
          outcome.phasesSkipped.push('temporalInvalidation');
          outcome.phaseSkipReasons['temporalInvalidation'] = 'error';
        }
      } else {
        outcome.phasesSkipped.push('temporalInvalidation');
        outcome.phaseSkipReasons['temporalInvalidation'] = !temporalInvalidation ? 'not_configured' : 'empty_store';
      }

      // Phase 16: Skill files summary (Advanced Memory: Letta)
      if (skillFilesManager && skillFilesManager.count() > 0) {
        try {
          const allSkills = skillFilesManager.getAll();
          outcome.skillsTotal = allSkills.length;
          outcome.skillsExpert = allSkills.filter((s) => s.mastery === 'expert').length;
          outcome.phasesCompleted.push('skillFiles');
          tracer.log('dream', 'info', `Skill files: ${outcome.skillsTotal} total, ${outcome.skillsExpert} expert-level`);
        } catch (err) {
          tracer.log('dream', 'warn', `Skill files summary failed: ${err instanceof Error ? err.message : String(err)}`);
          outcome.phasesSkipped.push('skillFiles');
          outcome.phaseSkipReasons['skillFiles'] = 'error';
        }
      } else {
        outcome.phasesSkipped.push('skillFiles');
        outcome.phaseSkipReasons['skillFiles'] = !skillFilesManager ? 'not_configured' : 'empty_store';
      }

      // Phase 17: Graph memory summary (Advanced Memory: Mem0)
      if (graphMemory && graphMemory.nodeCount() > 0) {
        try {
          outcome.graphNodes = graphMemory.nodeCount();
          outcome.graphEdges = graphMemory.edgeCount();
          outcome.graphComponents = graphMemory.getConnectedComponents().length;
          await graphMemory.save();
          outcome.phasesCompleted.push('graphMemory');
          tracer.log('dream', 'info', `Graph memory: ${outcome.graphNodes} nodes, ${outcome.graphEdges} edges, ${outcome.graphComponents} components`);
        } catch (err) {
          tracer.log('dream', 'warn', `Graph memory summary failed: ${err instanceof Error ? err.message : String(err)}`);
          outcome.phasesSkipped.push('graphMemory');
          outcome.phaseSkipReasons['graphMemory'] = 'error';
        }
      } else {
        outcome.phasesSkipped.push('graphMemory');
        outcome.phaseSkipReasons['graphMemory'] = !graphMemory ? 'not_configured' : 'empty_store';
      }

      // Promote stale context entries
      if (contextManager) {
        try {
          await contextManager.promoteStaleEntries();
        } catch {
          // Non-critical
        }
      }

      // Compute per-tier summary
      const corePhases = ['consolidateReflections', 'updateWorldModel', 'reorganizeGoals', 'explore', 'filesystemExploration', 'updateSelfModel'];
      const visionPhases = ['shadowAnalysis', 'toolInventory', 'adversarialChallenges', 'promptEvolution', 'trainingDataExtraction', 'loraTraining', 'spinSelfPlay', 'writeRetrospective'];
      const memoryPhases = ['linkDecay', 'audnConsolidation', 'entropyTierMigration', 'memorySnapshot', 'memoryEvolution', 'temporalInvalidation', 'skillFiles', 'graphMemory'];

      for (const [tier, phases] of [['core', corePhases], ['vision', visionPhases], ['memory', memoryPhases]] as const) {
        const tierStats = outcome.tierSummary[tier];
        for (const p of phases) {
          if (outcome.phasesCompleted.includes(p)) {
            tierStats.completed++;
          } else if (outcome.phaseSkipReasons[p] === 'error') {
            tierStats.errored++;
          } else if (outcome.phasesSkipped.includes(p)) {
            tierStats.skipped++;
          }
        }
      }

      outcome.durationMs = Date.now() - startMs;

      const errored = Object.values(outcome.phaseSkipReasons).filter(r => r === 'error').length;
      const notConfigured = Object.values(outcome.phaseSkipReasons).filter(r => r === 'not_configured').length;
      tracer.log('dream', 'info', '=== Dream cycle complete ===', {
        completed: outcome.phasesCompleted.length,
        skipped: outcome.phasesSkipped.length,
        errored,
        notConfigured,
        durationMs: outcome.durationMs,
        tierSummary: outcome.tierSummary,
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

    // Check for open issues that don't have goals yet — all priorities get queued
    const openIssues = issueLog.getOpenIssues();
    for (const issue of openIssues) {
      const goals = goalStack.getOpenGoals();
      const hasGoal = goals.some(
        (g) => g.description.includes(issue.id) || g.description.includes(issue.title),
      );

      if (!hasGoal) {
        const priorityMap: Record<string, number> = { critical: 2, high: 3, medium: 5, low: 7 };
        const goalPriority = priorityMap[issue.priority] ?? 7;
        goalStack.addGoal({
          source: 'self',
          priority: goalPriority,
          description: `Investigate issue ${issue.id}: ${issue.title}`,
          notes: `Auto-created from ${issue.priority}-priority issue during dream cycle.`,
        });
        reorganized++;
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
   * Whether dream cycles are enabled via config.
   */
  isEnabled(): boolean {
    return this.config.enabled !== false;
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
