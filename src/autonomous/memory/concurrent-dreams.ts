/**
 * Concurrent Dream Processing — Parallel Dream Phases (Letta)
 *
 * Runs independent dream cycle phases in parallel using Promise.allSettled.
 * Phases are organized into dependency groups:
 *
 *   Group 1 (independent): consolidation, world model update, archaeology
 *   Group 2 (depends on Group 1): goal reorganization, self-model
 *   Group 3 (depends on Group 2): shadow analysis, tool inventory
 *   Group 4 (depends on Group 3): challenges, prompt evolution, training
 *   Group 5 (final): retrospective
 *
 * Within each group, phases run concurrently. Groups execute sequentially.
 * This maximizes throughput while respecting data dependencies.
 *
 * Part of Advanced Memory: Concurrent Dream Processing (Letta).
 */

import { getTracer } from '../debug.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A dream phase that can be executed.
 */
export interface DreamPhase {
  /** Unique phase name */
  name: string;

  /** Human-readable label */
  label: string;

  /** Which group this phase belongs to (phases in same group run concurrently) */
  group: number;

  /** The async function to execute */
  execute: () => Promise<PhaseResult>;
}

/**
 * Result of a single phase execution.
 */
export interface PhaseResult {
  /** Phase name */
  name: string;

  /** Whether it succeeded */
  success: boolean;

  /** Duration in ms */
  durationMs: number;

  /** Error message if failed */
  error?: string;

  /** Any metrics produced */
  metrics: Record<string, number>;
}

/**
 * Result of running all phases in a concurrent dream cycle.
 */
export interface ConcurrentDreamResult {
  /** Results for each phase */
  phases: PhaseResult[];

  /** Phases that succeeded */
  succeeded: string[];

  /** Phases that failed */
  failed: string[];

  /** Total duration (wall-clock, not sum) */
  totalDurationMs: number;

  /** Time saved vs sequential execution */
  timeSavedMs: number;

  /** Timestamp */
  timestamp: string;
}

export interface ConcurrentDreamConfig {
  /** Maximum concurrent phases within a group */
  maxConcurrency: number;

  /** Timeout per phase in ms */
  phaseTimeoutMs: number;

  /** Whether to abort remaining groups if a critical phase fails */
  abortOnCriticalFailure: boolean;

  /** Phase names considered critical */
  criticalPhases: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: ConcurrentDreamConfig = {
  maxConcurrency: 4,
  phaseTimeoutMs: 120_000, // 2 minutes per phase
  abortOnCriticalFailure: false,
  criticalPhases: ['consolidateReflections', 'updateWorldModel'],
};

// ─────────────────────────────────────────────────────────────────────────────
// Concurrent Dream Executor
// ─────────────────────────────────────────────────────────────────────────────

export class ConcurrentDreamExecutor {
  private readonly config: ConcurrentDreamConfig;

  constructor(config?: Partial<ConcurrentDreamConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Execute all phases respecting group ordering and concurrency limits.
   */
  async execute(phases: DreamPhase[]): Promise<ConcurrentDreamResult> {
    const tracer = getTracer();
    const wallClockStart = Date.now();

    // Group phases by their group number
    const groups = this.groupPhases(phases);
    const allResults: PhaseResult[] = [];
    let sequentialTotal = 0;

    tracer.log('dream', 'info', `Concurrent dream: ${phases.length} phases in ${groups.size} groups`);

    // Execute groups sequentially
    for (const [groupNum, groupPhases] of [...groups.entries()].sort((a, b) => a[0] - b[0])) {
      tracer.log('dream', 'debug', `Running group ${groupNum}: ${groupPhases.map((p) => p.name).join(', ')}`);

      // Check for critical failures from previous groups
      if (this.config.abortOnCriticalFailure) {
        const criticalFailure = allResults.find(
          (r) => !r.success && this.config.criticalPhases.includes(r.name),
        );
        if (criticalFailure) {
          tracer.log('dream', 'warn', `Aborting: critical phase "${criticalFailure.name}" failed`);
          // Mark remaining phases as skipped
          for (const phase of groupPhases) {
            allResults.push({
              name: phase.name,
              success: false,
              durationMs: 0,
              error: `Skipped: critical phase "${criticalFailure.name}" failed`,
              metrics: {},
            });
          }
          continue;
        }
      }

      // Run phases in this group concurrently (with concurrency limit)
      const groupResults = await this.executeGroup(groupPhases);
      allResults.push(...groupResults);

      // Track sequential time for savings calculation
      sequentialTotal += groupResults.reduce((sum, r) => sum + r.durationMs, 0);
    }

    const totalDurationMs = Date.now() - wallClockStart;
    const succeeded = allResults.filter((r) => r.success).map((r) => r.name);
    const failed = allResults.filter((r) => !r.success).map((r) => r.name);

    const result: ConcurrentDreamResult = {
      phases: allResults,
      succeeded,
      failed,
      totalDurationMs,
      timeSavedMs: Math.max(0, sequentialTotal - totalDurationMs),
      timestamp: new Date().toISOString(),
    };

    tracer.log('dream', 'info', `Concurrent dream complete`, {
      succeeded: succeeded.length,
      failed: failed.length,
      wallClockMs: totalDurationMs,
      sequentialMs: sequentialTotal,
      savedMs: result.timeSavedMs,
    });

    return result;
  }

  /**
   * Execute a group of phases concurrently with a concurrency limit.
   */
  private async executeGroup(phases: DreamPhase[]): Promise<PhaseResult[]> {
    const results: PhaseResult[] = [];
    const limit = this.config.maxConcurrency;

    // Process in batches if phases exceed concurrency limit
    for (let i = 0; i < phases.length; i += limit) {
      const batch = phases.slice(i, i + limit);
      const batchResults = await Promise.allSettled(
        batch.map((phase) => this.executePhase(phase)),
      );

      for (let j = 0; j < batchResults.length; j++) {
        const settled = batchResults[j]!;
        if (settled.status === 'fulfilled') {
          results.push(settled.value);
        } else {
          results.push({
            name: batch[j]!.name,
            success: false,
            durationMs: 0,
            error: settled.reason instanceof Error
              ? settled.reason.message
              : String(settled.reason),
            metrics: {},
          });
        }
      }
    }

    return results;
  }

  /**
   * Execute a single phase with timeout.
   */
  private async executePhase(phase: DreamPhase): Promise<PhaseResult> {
    const tracer = getTracer();
    const start = Date.now();

    try {
      const result = await Promise.race([
        phase.execute(),
        this.timeout(phase.name),
      ]);

      tracer.log('dream', 'debug', `Phase "${phase.name}": ${result.success ? 'ok' : 'failed'} (${result.durationMs}ms)`);
      return result;
    } catch (err) {
      const durationMs = Date.now() - start;
      const errorMsg = err instanceof Error ? err.message : String(err);

      tracer.log('dream', 'warn', `Phase "${phase.name}" threw: ${errorMsg}`);

      return {
        name: phase.name,
        success: false,
        durationMs,
        error: errorMsg,
        metrics: {},
      };
    }
  }

  /**
   * Create a timeout promise that rejects after the configured timeout.
   */
  private timeout(phaseName: string): Promise<PhaseResult> {
    return new Promise((_, reject) => {
      setTimeout(() => {
        reject(new Error(`Phase "${phaseName}" timed out after ${this.config.phaseTimeoutMs}ms`));
      }, this.config.phaseTimeoutMs);
    });
  }

  // ── Utilities ──────────────────────────────────────────────────────────────

  private groupPhases(phases: DreamPhase[]): Map<number, DreamPhase[]> {
    const groups = new Map<number, DreamPhase[]>();
    for (const phase of phases) {
      if (!groups.has(phase.group)) {
        groups.set(phase.group, []);
      }
      groups.get(phase.group)!.push(phase);
    }
    return groups;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────────────────────

export function createConcurrentDreamExecutor(
  config?: Partial<ConcurrentDreamConfig>,
): ConcurrentDreamExecutor {
  return new ConcurrentDreamExecutor(config);
}
