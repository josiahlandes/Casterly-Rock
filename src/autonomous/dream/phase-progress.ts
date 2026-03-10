/**
 * Progress-Based Dream Phases with Interruption Recovery
 *
 * Inspired by nanochat's checkpoint-based training that resumes after
 * preemption, each dream phase reports normalized progress (0→1) and
 * can save/restore partial state. This allows:
 *
 *   1. Time-budgeted phases — each phase has a wall-clock budget
 *   2. Graceful interruption — DeepLoop preemption saves progress
 *   3. Resume after restart — next dream cycle picks up where it left off
 *   4. Progress visibility — the scheduler knows how far along each phase is
 *
 * Phase lifecycle:
 *   pending → running(progress 0→1) → completed | interrupted | failed
 *
 * Privacy: Only phase metadata is persisted. No user data involved.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { getTracer } from '../debug.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** Status of a dream phase. */
export type PhaseStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'interrupted'
  | 'failed'
  | 'skipped';

/** Persisted state for a single phase. */
export interface PhaseState {
  /** Phase name */
  name: string;

  /** Current status */
  status: PhaseStatus;

  /** Normalized progress 0.0 → 1.0 */
  progress: number;

  /** Phase-specific checkpoint data (opaque to the framework) */
  checkpoint: Record<string, unknown> | null;

  /** When this phase last started */
  startedAt: string | null;

  /** When this phase last completed/interrupted */
  endedAt: string | null;

  /** Wall-clock time spent so far (ms), accumulates across resumes */
  elapsedMs: number;

  /** Number of times this phase has been resumed */
  resumeCount: number;

  /** Error message if failed */
  error: string | null;
}

/** Persisted state for all phases in a dream cycle. */
export interface DreamPhaseState {
  /** Cycle identifier (date-based, e.g. "2026-03-10") */
  cycleId: string;

  /** Per-phase state */
  phases: PhaseState[];

  /** When this state was last saved */
  lastSavedAt: string;

  /** Whether this cycle has been fully completed */
  cycleComplete: boolean;
}

/** A phase execution function that receives a progress reporter. */
export type PhaseExecutor = (
  ctx: PhaseContext,
) => Promise<void>;

/** Context passed to each phase executor. */
export interface PhaseContext {
  /** Report progress (0.0 → 1.0). Call periodically during long operations. */
  reportProgress: (progress: number) => void;

  /** Get the current progress. */
  getProgress: () => number;

  /** Save a checkpoint that can be restored on resume. */
  saveCheckpoint: (data: Record<string, unknown>) => void;

  /** Get the previously saved checkpoint (null on first run). */
  getCheckpoint: () => Record<string, unknown> | null;

  /** Check if this phase should stop (time budget exceeded or preempted). */
  shouldStop: () => boolean;

  /** Whether this is a resumed execution (vs first run). */
  isResume: boolean;

  /** Time budget remaining for this phase (ms). */
  remainingMs: () => number;
}

/** Configuration for the phase progress system. */
export interface PhaseProgressConfig {
  /** Path to persist phase state */
  statePath: string;

  /** Default time budget per phase (ms) */
  defaultPhaseBudgetMs: number;
}

/** Registration of a phase with its executor and optional budget. */
export interface PhaseRegistration {
  /** Phase name (must be unique) */
  name: string;

  /** The function that executes this phase */
  executor: PhaseExecutor;

  /** Time budget override for this phase (ms). Uses default if not set. */
  budgetMs?: number;

  /** Phase dependencies — these phases must be completed first */
  dependsOn?: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: PhaseProgressConfig = {
  statePath: path.join(
    process.env['HOME'] || '~',
    '.casterly', 'dream-phase-state.json',
  ),
  defaultPhaseBudgetMs: 300_000, // 5 minutes
};

// ─────────────────────────────────────────────────────────────────────────────
// Phase Progress Manager
// ─────────────────────────────────────────────────────────────────────────────

export class PhaseProgressManager {
  private readonly config: PhaseProgressConfig;
  private state: DreamPhaseState | null = null;
  private preempted = false;

  constructor(config?: Partial<PhaseProgressConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // ── Persistence ─────────────────────────────────────────────────────────

  /** Load persisted phase state from disk. */
  async load(): Promise<void> {
    try {
      const content = await fs.readFile(this.config.statePath, 'utf-8');
      const data = JSON.parse(content) as DreamPhaseState;
      if (data && data.cycleId && Array.isArray(data.phases)) {
        this.state = data;
      }
    } catch {
      // No state file yet — start fresh
      this.state = null;
    }
  }

  /** Save current phase state to disk. */
  async save(): Promise<void> {
    if (!this.state) return;
    this.state.lastSavedAt = new Date().toISOString();
    try {
      await fs.mkdir(path.dirname(this.config.statePath), { recursive: true });
      await fs.writeFile(
        this.config.statePath,
        JSON.stringify(this.state, null, 2),
        'utf-8',
      );
    } catch (err) {
      getTracer().log('dream', 'error',
        `Failed to save phase state: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── Cycle Management ───────────────────────────────────────────────────

  /**
   * Begin or resume a dream cycle.
   *
   * If the persisted state matches today's cycle and is incomplete,
   * the manager resumes where it left off. Otherwise, it starts fresh.
   */
  beginCycle(cycleId: string, phaseNames: string[]): void {
    if (this.state && this.state.cycleId === cycleId && !this.state.cycleComplete) {
      // Resume existing cycle — keep existing phase states
      // Add any new phases that weren't in the previous state
      for (const name of phaseNames) {
        if (!this.state.phases.find(p => p.name === name)) {
          this.state.phases.push(createEmptyPhaseState(name));
        }
      }
      return;
    }

    // Start fresh
    this.state = {
      cycleId,
      phases: phaseNames.map(createEmptyPhaseState),
      lastSavedAt: new Date().toISOString(),
      cycleComplete: false,
    };
    this.preempted = false;
  }

  /**
   * Execute all registered phases in order, respecting budgets and
   * resuming from checkpoints.
   *
   * Returns a summary of what ran.
   */
  async executePhases(
    registrations: PhaseRegistration[],
  ): Promise<PhaseExecutionSummary> {
    if (!this.state) {
      throw new Error('No cycle started. Call beginCycle() first.');
    }

    const tracer = getTracer();
    const summary: PhaseExecutionSummary = {
      cycleId: this.state.cycleId,
      phasesRun: [],
      phasesResumed: [],
      phasesCompleted: [],
      phasesInterrupted: [],
      phasesFailed: [],
      phasesSkipped: [],
    };

    for (const reg of registrations) {
      if (this.preempted) break;

      const phaseState = this.getPhaseState(reg.name);
      if (!phaseState) continue;

      // Skip completed phases
      if (phaseState.status === 'completed') {
        summary.phasesSkipped.push(reg.name);
        continue;
      }

      // Check dependencies
      if (reg.dependsOn) {
        const unmet = reg.dependsOn.filter(dep => {
          const depState = this.getPhaseState(dep);
          return !depState || depState.status !== 'completed';
        });
        if (unmet.length > 0) {
          phaseState.status = 'skipped';
          phaseState.error = `Unmet dependencies: ${unmet.join(', ')}`;
          summary.phasesSkipped.push(reg.name);
          continue;
        }
      }

      const isResume = phaseState.status === 'interrupted' && phaseState.checkpoint !== null;
      const budgetMs = reg.budgetMs ?? this.config.defaultPhaseBudgetMs;
      const remainingBudget = Math.max(0, budgetMs - phaseState.elapsedMs);

      if (remainingBudget <= 0) {
        phaseState.status = 'completed';
        summary.phasesCompleted.push(reg.name);
        continue;
      }

      // Build context
      const startTime = Date.now();
      const deadline = startTime + remainingBudget;
      let currentProgress = phaseState.progress;

      const ctx: PhaseContext = {
        reportProgress: (p) => {
          currentProgress = Math.max(0, Math.min(1, p));
          phaseState.progress = currentProgress;
        },
        getProgress: () => currentProgress,
        saveCheckpoint: (data) => {
          phaseState.checkpoint = data;
        },
        getCheckpoint: () => phaseState.checkpoint,
        shouldStop: () => this.preempted || Date.now() >= deadline,
        isResume,
        remainingMs: () => Math.max(0, deadline - Date.now()),
      };

      // Execute
      phaseState.status = 'running';
      phaseState.startedAt = phaseState.startedAt ?? new Date().toISOString();
      if (isResume) {
        phaseState.resumeCount++;
        summary.phasesResumed.push(reg.name);
      }
      summary.phasesRun.push(reg.name);

      tracer.log('dream', 'info', `Phase ${reg.name}: ${isResume ? 'resuming' : 'starting'}`, {
        progress: currentProgress,
        budgetMs: remainingBudget,
        resumeCount: phaseState.resumeCount,
      });

      try {
        await reg.executor(ctx);

        const elapsed = Date.now() - startTime;
        phaseState.elapsedMs += elapsed;

        if (this.preempted || Date.now() >= deadline) {
          // Time ran out or preempted — mark as interrupted
          phaseState.status = 'interrupted';
          phaseState.endedAt = new Date().toISOString();
          summary.phasesInterrupted.push(reg.name);
          tracer.log('dream', 'info', `Phase ${reg.name}: interrupted at ${(currentProgress * 100).toFixed(0)}%`);
        } else {
          // Completed normally
          phaseState.status = 'completed';
          phaseState.progress = 1.0;
          phaseState.endedAt = new Date().toISOString();
          summary.phasesCompleted.push(reg.name);
          tracer.log('dream', 'info', `Phase ${reg.name}: completed in ${(elapsed / 1000).toFixed(1)}s`);
        }
      } catch (err) {
        const elapsed = Date.now() - startTime;
        phaseState.elapsedMs += elapsed;
        phaseState.status = 'failed';
        phaseState.error = err instanceof Error ? err.message : String(err);
        phaseState.endedAt = new Date().toISOString();
        summary.phasesFailed.push(reg.name);
        tracer.log('dream', 'warn', `Phase ${reg.name}: failed — ${phaseState.error}`);
      }

      // Persist after each phase
      await this.save();
    }

    // Check if all phases are done
    const allDone = this.state.phases.every(
      p => p.status === 'completed' || p.status === 'failed' || p.status === 'skipped',
    );
    if (allDone) {
      this.state.cycleComplete = true;
    }

    await this.save();
    return summary;
  }

  // ── Preemption ─────────────────────────────────────────────────────────

  /** Signal that the dream cycle should stop (e.g., user activity). */
  preempt(): void {
    this.preempted = true;
  }

  /** Whether the cycle has been preempted. */
  isPreempted(): boolean {
    return this.preempted;
  }

  // ── Queries ────────────────────────────────────────────────────────────

  /** Get the current state (or null if no cycle is active). */
  getState(): Readonly<DreamPhaseState> | null {
    return this.state;
  }

  /** Get the state for a specific phase. */
  getPhaseState(name: string): PhaseState | undefined {
    return this.state?.phases.find(p => p.name === name);
  }

  /** Get overall progress as a fraction (0→1). */
  getOverallProgress(): number {
    if (!this.state || this.state.phases.length === 0) return 0;
    const total = this.state.phases.reduce((sum, p) => sum + p.progress, 0);
    return total / this.state.phases.length;
  }

  /** Get a human-readable progress summary. */
  getSummary(): string {
    if (!this.state) return 'No active dream cycle';
    const lines: string[] = [];
    lines.push(`Dream cycle ${this.state.cycleId}: ${(this.getOverallProgress() * 100).toFixed(0)}% complete`);
    for (const p of this.state.phases) {
      const status = p.status === 'running'
        ? `running (${(p.progress * 100).toFixed(0)}%)`
        : p.status;
      lines.push(`  ${p.name}: ${status}${p.resumeCount > 0 ? ` [resumed ${p.resumeCount}x]` : ''}`);
    }
    if (this.state.cycleComplete) lines.push('  Cycle complete.');
    return lines.join('\n');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Summary type
// ─────────────────────────────────────────────────────────────────────────────

export interface PhaseExecutionSummary {
  cycleId: string;
  phasesRun: string[];
  phasesResumed: string[];
  phasesCompleted: string[];
  phasesInterrupted: string[];
  phasesFailed: string[];
  phasesSkipped: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function createEmptyPhaseState(name: string): PhaseState {
  return {
    name,
    status: 'pending',
    progress: 0,
    checkpoint: null,
    startedAt: null,
    endedAt: null,
    elapsedMs: 0,
    resumeCount: 0,
    error: null,
  };
}
