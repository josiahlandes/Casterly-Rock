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
import { TaskBoard, createTaskBoard } from './task-board.js';
import { FastLoop, createFastLoop } from './fast-loop.js';
import type { FastLoopConfig } from './fast-loop.js';
import { DeepLoop, createDeepLoop } from './deep-loop.js';
import type { DeepLoopConfig } from './deep-loop.js';
import type { ContextTiersConfig } from './context-tiers.js';
import type { TaskBoardConfig } from './task-board-types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Health status of a single loop.
 */
export interface LoopHealth {
  running: boolean;
  lastHeartbeat?: string | undefined;
  currentTask?: string | undefined;    // Task ID if working
  errorCount: number;
}

/**
 * Combined health status for the coordinator dashboard.
 */
export interface CoordinatorHealth {
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
    deep: { compact: 8192, standard: 24576, extended: 40960, contextPressureWarningThreshold: 0.80 },
    coder: { compact: 8192, standard: 16384, extended: 32768, responseBufferTokens: 2000 },
  },
  maxRestartAttempts: 3,
  restartDelayMs: 5000,
};

// ─────────────────────────────────────────────────────────────────────────────
// LoopCoordinator
// ─────────────────────────────────────────────────────────────────────────────

export class LoopCoordinator {
  private readonly config: CoordinatorConfig;
  private readonly taskBoard: TaskBoard;
  private readonly fastLoop: FastLoop;
  private readonly deepLoop: DeepLoop;
  private running: boolean = false;

  constructor(
    fastProvider: LlmProvider,
    deepProvider: LlmProvider,
    concurrentProvider: ConcurrentProvider,
    eventBus: EventBus,
    config?: Partial<CoordinatorConfig>,
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };

    this.taskBoard = createTaskBoard(this.config.taskBoard);

    this.fastLoop = createFastLoop(
      fastProvider,
      this.taskBoard,
      eventBus,
      {
        ...this.config.fast,
        tiers: this.config.contextTiers.fast,
      },
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
    );
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────

  /**
   * Start both loops concurrently.
   * Returns when either loop exits (crash or stop).
   */
  async start(): Promise<void> {
    this.running = true;
    this.taskBoard.init();

    // TODO(pass-4): Health monitoring, restart logic, logging

    // Both loops launched as concurrent promises
    const fastPromise = this.runWithRestart('fast', () => this.fastLoop.run());
    const deepPromise = this.runWithRestart('deep', () => this.deepLoop.run());

    // Wait for either to exit
    await Promise.race([fastPromise, deepPromise]);
  }

  /**
   * Stop both loops gracefully.
   */
  async stop(): Promise<void> {
    this.running = false;
    this.fastLoop.stop();
    this.deepLoop.stop();
    this.taskBoard.close();
  }

  // ── Health ──────────────────────────────────────────────────────────────

  /**
   * Get the health status of both loops and the task board.
   */
  getHealth(): CoordinatorHealth {
    // TODO(pass-4): Populate from actual loop state
    const currentTask = this.deepLoop.getCurrentTask();
    return {
      fast: {
        running: this.fastLoop.isRunning(),
        errorCount: 0,
      },
      deep: {
        running: this.deepLoop.isRunning(),
        currentTask: currentTask?.id,
        errorCount: 0,
      },
      taskBoard: {
        active: 0,
        queued: 0,
        reviewing: 0,
        doneToday: 0,
      },
    };
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
    let attempts = 0;

    while (this.running && attempts < this.config.maxRestartAttempts) {
      try {
        await fn();
        // Normal exit — don't restart
        return;
      } catch (error) {
        attempts++;
        // TODO(pass-4): Log error, health update, notify
        if (this.running && attempts < this.config.maxRestartAttempts) {
          await this.sleep(this.config.restartDelayMs);
        }
      }
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
): LoopCoordinator {
  return new LoopCoordinator(fastProvider, deepProvider, concurrentProvider, eventBus, config);
}
