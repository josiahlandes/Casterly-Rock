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

      // Phase 6: Write retrospective
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
   * Check if dream cycles are enabled.
   */
  isEnabled(): boolean {
    return this.config.enabled;
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
