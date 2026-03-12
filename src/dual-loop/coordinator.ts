/**
 * Loop Coordinator — Starts, stops, and monitors both loops.
 *
 * The LoopCoordinator is the entry point for the dual-loop system.
 * It creates and manages the FastLoop and DeepLoop, handles health
 * monitoring, and implements graceful degradation when one loop fails.
 *
 * Both loops run as concurrent async coroutines in the same Node.js
 * process. The bottleneck is Ollama (I/O-bound), not TypeScript (CPU-bound),
 * so single-process concurrency via the event loop is sufficient.
 *
 * See docs/dual-loop-architecture.md Sections 16 and Phase 5.
 */

import type { LlmProvider } from '../providers/base.js';
import type { ConcurrentProvider } from '../providers/concurrent.js';
import type { EventBus } from '../autonomous/events.js';
import type { AgentToolkit } from '../autonomous/tools/types.js';
import { getTracer } from '../autonomous/debug.js';
import { TaskBoard, createTaskBoard } from './task-board.js';
import { FastLoop, createFastLoop } from './fast-loop.js';
import type { FastLoopConfig, DeliverFn } from './fast-loop.js';
import { DeepLoop, createDeepLoop } from './deep-loop.js';
import type { DeepLoopConfig } from './deep-loop.js';
import type { ContextTiersConfig } from './context-tiers.js';
import type { TaskBoardConfig } from './task-board-types.js';
import { DreamScheduler } from './dream-scheduler.js';
import type { DreamSchedulerConfig, DreamSchedulerDeps } from './dream-scheduler.js';
import type { GoalStack } from '../autonomous/goal-stack.js';
import type { IssueLog } from '../autonomous/issue-log.js';
import type { ChangeApplier } from '../autonomous/dream/autoresearch.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Health status of a single loop.
 */
export interface LoopHealth {
  running: boolean;
  lastHeartbeat?: string | undefined;
  currentTask?: string | undefined;
  errorCount: number;
  restartCount: number;
}

/**
 * Combined health status for the coordinator dashboard.
 */
export interface CoordinatorHealth {
  running: boolean;
  upSince?: string | undefined;
  fast: LoopHealth;
  deep: LoopHealth;
  taskBoard: {
    active: number;
    queued: number;
    reviewing: number;
    doneToday: number;
  };
}

/**
 * Full configuration for the coordinator.
 */
export interface CoordinatorConfig {
  /** FastLoop settings */
  fast: Partial<FastLoopConfig>;
  /** DeepLoop settings */
  deep: Partial<DeepLoopConfig>;
  /** TaskBoard settings */
  taskBoard: Partial<TaskBoardConfig>;
  /** Context tier settings */
  contextTiers: ContextTiersConfig;
  /** Maximum restart attempts for a crashed loop */
  maxRestartAttempts: number;
  /** Delay between restart attempts (ms) */
  restartDelayMs: number;
  /** How often to save TaskBoard state (ms) */
  saveIntervalMs: number;
  /** How often to archive old tasks (ms) */
  archiveIntervalMs: number;
  /** Dream cycle scheduler settings (undefined = disabled) */
  dreamScheduler?: Partial<DreamSchedulerConfig>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Default Configuration
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: CoordinatorConfig = {
  fast: {},
  deep: {},
  taskBoard: {},
  contextTiers: {
    fast: { compact: 4096, standard: 12288, extended: 24576, reviewLargeThresholdLines: 150 },
    deep: { compact: 8192, standard: 24576, extended: 262144, contextPressureSoftThreshold: 0.70, contextPressureWarningThreshold: 0.80, contextPressureActionThreshold: 0.85 },
    coder: { compact: 8192, standard: 65536, extended: 262144, responseBufferTokens: 2000 },
  },
  maxRestartAttempts: 3,
  restartDelayMs: 5000,
  saveIntervalMs: 30_000,      // Save TaskBoard every 30 seconds
  archiveIntervalMs: 3_600_000, // Archive old tasks every hour
};

// ─────────────────────────────────────────────────────────────────────────────
// LoopCoordinator
// ─────────────────────────────────────────────────────────────────────────────

export class LoopCoordinator {
  private readonly config: CoordinatorConfig;
  private readonly taskBoard: TaskBoard;
  private readonly fastLoop: FastLoop;
  private readonly deepLoop: DeepLoop;
  private readonly eventBus: EventBus;
  private dreamScheduler: DreamScheduler | null = null;
  private goalStack: GoalStack | null = null;
  private issueLog: IssueLog | null = null;
  private running: boolean = false;
  private startedAt: string | null = null;
  private fastHealth: LoopHealth = { running: false, errorCount: 0, restartCount: 0 };
  private deepHealth: LoopHealth = { running: false, errorCount: 0, restartCount: 0 };
  private saveTimer: ReturnType<typeof setInterval> | null = null;
  private archiveTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    fastProvider: LlmProvider,
    deepProvider: LlmProvider,
    concurrentProvider: ConcurrentProvider,
    eventBus: EventBus,
    config?: Partial<CoordinatorConfig>,
    toolkit?: AgentToolkit,
    coderProvider?: LlmProvider,
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.eventBus = eventBus;

    this.taskBoard = createTaskBoard(this.config.taskBoard);

    this.fastLoop = createFastLoop(
      fastProvider,
      this.taskBoard,
      eventBus,
      {
        ...this.config.fast,
        tiers: this.config.contextTiers.fast,
      },
      concurrentProvider,
    );

    this.deepLoop = createDeepLoop(
      deepProvider,
      concurrentProvider,
      this.taskBoard,
      eventBus,
      {
        ...this.config.deep,
        tiers: this.config.contextTiers.deep,
        coderTiers: this.config.contextTiers.coder,
      },
      toolkit,
      undefined, // stateManager
      coderProvider,
    );
  }

  // ── Dream Scheduler ─────────────────────────────────────────────────────

  /**
   * Initialize the dream scheduler with runtime dependencies.
   *
   * Called by the DualLoopController after construction, once the
   * necessary stores (worldModel, goalStack, issueLog) are available.
   * The scheduler checks whether DeepLoop is idle by inspecting the TaskBoard.
   */
  initDreamScheduler(deps: DreamSchedulerDeps): void {
    const schedulerConfig = this.config.dreamScheduler ?? { enabled: true };

    this.dreamScheduler = new DreamScheduler(
      {
        ...deps,
        isDeepLoopIdle: () => {
          // DeepLoop is idle when there are no active or queued tasks
          const active = this.taskBoard.getActive();
          const counts = this.taskBoard.getStatusCounts();
          return active.length === 0 && (counts['queued'] ?? 0) === 0;
        },
      },
      schedulerConfig,
    );
  }

  /**
   * Wire a ChangeApplier into the dream scheduler's autoresearch engine.
   * Must be called after initDreamScheduler().
   */
  setAutoresearchChangeApplier(applier: ChangeApplier): void {
    this.dreamScheduler?.setChangeApplier(applier);
  }

  /**
   * Store references to GoalStack and IssueLog so the coordinator
   * can load/save them alongside the TaskBoard.
   */
  setPersistableStores(goalStack: GoalStack, issueLog?: IssueLog): void {
    this.goalStack = goalStack;
    if (issueLog) this.issueLog = issueLog;
  }

  /**
   * Get the dream scheduler summary (for status reports).
   */
  getDreamSchedulerSummary(): string {
    return this.dreamScheduler?.getSummary() ?? 'Dream scheduler not initialized';
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────

  /**
   * Start both loops concurrently.
   *
   * 1. Load TaskBoard from disk
   * 2. Start periodic save and archive timers
   * 3. Start the dream scheduler (if configured)
   * 4. Launch both loops as concurrent coroutines
   * 5. Wait for any loop to exit (crash or stop)
   */
  async start(): Promise<void> {
    const tracer = getTracer();
    this.running = true;
    this.startedAt = new Date().toISOString();

    tracer.log('coordinator', 'info', 'LoopCoordinator starting');

    // 1. Load TaskBoard state from disk
    this.taskBoard.init();
    await this.taskBoard.load();
    this.taskBoard.markExistingDoneAsDelivered(); // Don't re-deliver old tasks
    tracer.log('coordinator', 'info', 'TaskBoard loaded');

    // Load GoalStack and IssueLog from disk (if wired)
    if (this.goalStack) {
      await this.goalStack.load();
      tracer.log('coordinator', 'info', 'GoalStack loaded');
    }
    if (this.issueLog) {
      await this.issueLog.load();
      tracer.log('coordinator', 'info', 'IssueLog loaded');
    }

    // 2. Start periodic save timer (persist dirty state to disk)
    this.saveTimer = setInterval(() => {
      if (this.taskBoard.isDirty()) {
        void this.taskBoard.save().catch((err) => {
          tracer.log('coordinator', 'error', 'TaskBoard save failed', {
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }
      if (this.goalStack) {
        void this.goalStack.save().catch((err) => {
          tracer.log('coordinator', 'error', 'GoalStack save failed', {
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }
      if (this.issueLog) {
        void this.issueLog.save().catch((err) => {
          tracer.log('coordinator', 'error', 'IssueLog save failed', {
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }
    }, this.config.saveIntervalMs);

    // 3. Start periodic archive timer (clean up old tasks)
    this.archiveTimer = setInterval(() => {
      const archived = this.taskBoard.archiveOld();
      if (archived > 0) {
        tracer.log('coordinator', 'info', `Archived ${archived} old tasks`);
      }
    }, this.config.archiveIntervalMs);

    // 4. Start the dream scheduler (runs dream cycles during idle periods)
    if (this.dreamScheduler) {
      await this.dreamScheduler.start();
      tracer.log('coordinator', 'info', 'Dream scheduler started');
    }

    // 5. Launch both loops
    const fastPromise = this.runWithRestart('fast', () => this.fastLoop.run());
    const deepPromise = this.runWithRestart('deep', () => this.deepLoop.run());

    tracer.log('coordinator', 'info', 'Both loops launched');

    // Wait for both loops to finish (each handles its own restarts).
    // allSettled ensures a crashed loop doesn't orphan the surviving one.
    const results = await Promise.allSettled([fastPromise, deepPromise]);

    for (const r of results) {
      if (r.status === 'rejected') {
        tracer.log('coordinator', 'error', 'Loop exited with unhandled error', {
          error: r.reason instanceof Error ? r.reason.message : String(r.reason),
        });
      }
    }

    tracer.log('coordinator', 'info', 'LoopCoordinator exiting (both loops stopped)');
  }

  /**
   * Stop both loops gracefully and persist state.
   */
  async stop(): Promise<void> {
    const tracer = getTracer();
    tracer.log('coordinator', 'info', 'LoopCoordinator stopping');

    this.running = false;
    this.fastLoop.stop();
    this.deepLoop.stop();

    // Stop dream scheduler
    if (this.dreamScheduler) {
      await this.dreamScheduler.stop();
    }

    // Clear timers
    if (this.saveTimer) {
      clearInterval(this.saveTimer);
      this.saveTimer = null;
    }
    if (this.archiveTimer) {
      clearInterval(this.archiveTimer);
      this.archiveTimer = null;
    }

    // Final save
    if (this.goalStack) await this.goalStack.save();
    if (this.issueLog) await this.issueLog.save();
    await this.taskBoard.save();
    this.taskBoard.close();

    tracer.log('coordinator', 'info', 'LoopCoordinator stopped');
  }

  // ── Message Routing ─────────────────────────────────────────────────────

  /**
   * Route a user message into the dual-loop system.
   * This is the primary external interface — called by the iMessage daemon
   * or CLI when a user message arrives.
   */
  handleUserMessage(message: string, sender: string): void {
    this.fastLoop.enqueueMessage(message, sender);
  }

  /**
   * Set the delivery function for sending responses back to users.
   */
  setDeliverFn(fn: DeliverFn): void {
    this.fastLoop.setDeliverFn(fn);
  }

  // ── Health ──────────────────────────────────────────────────────────────

  /**
   * Get the health status of both loops and the task board.
   */
  getHealth(): CoordinatorHealth {
    const currentTask = this.deepLoop.getCurrentTask();
    const counts = this.taskBoard.getStatusCounts();

    return {
      running: this.running,
      upSince: this.startedAt ?? undefined,
      fast: {
        ...this.fastHealth,
        running: this.fastLoop.isRunning(),
      },
      deep: {
        ...this.deepHealth,
        running: this.deepLoop.isRunning(),
        currentTask: currentTask?.id,
      },
      taskBoard: {
        active: this.taskBoard.getActive().length,
        queued: counts['queued'] ?? 0,
        reviewing: counts['reviewing'] ?? 0,
        doneToday: this.taskBoard.getCompletedToday(),
      },
    };
  }

  /**
   * Get a human-readable health summary for status reporting.
   */
  getHealthSummary(): string {
    const h = this.getHealth();
    const lines: string[] = [];

    lines.push(`Coordinator: ${h.running ? 'running' : 'stopped'}${h.upSince ? ` (since ${h.upSince})` : ''}`);
    lines.push(`FastLoop: ${h.fast.running ? 'running' : 'stopped'} (${h.fast.errorCount} errors, ${h.fast.restartCount} restarts)`);
    lines.push(`DeepLoop: ${h.deep.running ? 'running' : 'stopped'}${h.deep.currentTask ? ` [working on ${h.deep.currentTask}]` : ''} (${h.deep.errorCount} errors, ${h.deep.restartCount} restarts)`);
    lines.push(`TaskBoard: ${h.taskBoard.active} active, ${h.taskBoard.queued} queued, ${h.taskBoard.reviewing} reviewing, ${h.taskBoard.doneToday} done today`);
    lines.push(this.getDreamSchedulerSummary());

    return lines.join('\n');
  }

  // ── Accessors ───────────────────────────────────────────────────────────

  getTaskBoard(): TaskBoard {
    return this.taskBoard;
  }

  getFastLoop(): FastLoop {
    return this.fastLoop;
  }

  getDeepLoop(): DeepLoop {
    return this.deepLoop;
  }

  // ── Internal ────────────────────────────────────────────────────────────

  /**
   * Run a loop with automatic restart on crash (up to maxRestartAttempts).
   */
  private async runWithRestart(
    name: 'fast' | 'deep',
    fn: () => Promise<void>,
  ): Promise<void> {
    const tracer = getTracer();
    const health = name === 'fast' ? this.fastHealth : this.deepHealth;
    let attempts = 0;

    while (this.running && attempts < this.config.maxRestartAttempts) {
      try {
        await fn();
        // Normal exit — don't restart
        tracer.log('coordinator', 'info', `${name} loop exited normally`);
        return;
      } catch (error) {
        attempts++;
        health.errorCount++;
        health.restartCount++;

        tracer.log('coordinator', 'error', `${name} loop crashed (attempt ${attempts}/${this.config.maxRestartAttempts})`, {
          error: error instanceof Error ? error.message : String(error),
        });

        if (this.running && attempts < this.config.maxRestartAttempts) {
          tracer.log('coordinator', 'info', `Restarting ${name} loop in ${this.config.restartDelayMs}ms`);
          await this.sleep(this.config.restartDelayMs);
        }
      }
    }

    if (attempts >= this.config.maxRestartAttempts) {
      tracer.log('coordinator', 'error', `${name} loop exhausted restart attempts`, {
        maxAttempts: this.config.maxRestartAttempts,
        totalErrors: health.errorCount,
      });
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────────────────────

export function createLoopCoordinator(
  fastProvider: LlmProvider,
  deepProvider: LlmProvider,
  concurrentProvider: ConcurrentProvider,
  eventBus: EventBus,
  config?: Partial<CoordinatorConfig>,
  toolkit?: AgentToolkit,
  coderProvider?: LlmProvider,
): LoopCoordinator {
  return new LoopCoordinator(fastProvider, deepProvider, concurrentProvider, eventBus, config, toolkit, coderProvider);
}
