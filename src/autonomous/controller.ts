/**
 * Autonomous Controller (daemon-side)
 *
 * Wraps the AutonomousLoop with start/stop/interrupt/tick/status semantics
 * so the iMessage daemon can manage the autonomous cycle in-process.
 *
 * Key design: we never call AutonomousLoop.start() (blocking). Instead the
 * daemon calls tick() every poll interval, which calls runCycle() once when
 * the cycle interval has elapsed and the loop is enabled.
 */

import { safeLogger } from '../logging/safe-logger.js';
import { AutonomousLoop, AbortError } from './loop.js';
import type { Reflector } from './reflector.js';
import { formatDailyReport } from './report.js';

// ═══════════════════════════════════════════════════════════════════════════════
// PUBLIC TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface AutonomousStatus {
  enabled: boolean;
  busy: boolean;
  totalCycles: number;
  successfulCycles: number;
  lastCycleAt: string | null;
  nextCycleIn: string;
}

export interface AutonomousController {
  /** Start autonomous mode — begins running cycles on tick(). */
  start(): void;
  /** Stop autonomous mode — no more cycles will start. */
  stop(): void;
  /** Interrupt the current cycle immediately (abort signal + git revert). */
  interrupt(): Promise<void>;
  /** Called every daemon poll iteration — runs next cycle if ready. */
  tick(): Promise<void>;
  /** Get current status for iMessage response. */
  getStatus(): AutonomousStatus;
  /** Generate a formatted daily report string. */
  getDailyReport(): Promise<string>;
  /** Whether autonomous mode is enabled. */
  readonly enabled: boolean;
  /** Whether a cycle is currently executing. */
  readonly busy: boolean;
}

// ═══════════════════════════════════════════════════════════════════════════════
// FACTORY
// ═══════════════════════════════════════════════════════════════════════════════

export interface ControllerOptions {
  /** The autonomous loop instance (already constructed with config & provider). */
  loop: AutonomousLoop;
  /** Cycle interval in minutes (from config). */
  cycleIntervalMinutes: number;
}

/**
 * Create an AutonomousController that the daemon uses to manage
 * the self-improvement loop.
 */
export function createAutonomousController(options: ControllerOptions): AutonomousController {
  const { loop, cycleIntervalMinutes } = options;
  const intervalMs = cycleIntervalMinutes * 60_000;

  // Internal state
  let enabled = false;
  let busy = false;
  let abortController: AbortController | null = null;
  let lastCycleEnd = 0;
  let totalCycles = 0;
  let successfulCycles = 0;
  let lastCycleAt: string | null = null;

  // Access the reflector through the loop's public getter
  const reflector: Reflector = loop.reflectorInstance;
  const git = loop.gitInstance;

  // ─── start ──────────────────────────────────────────────────────────────

  function start(): void {
    if (enabled) return;
    enabled = true;
    safeLogger.info('Autonomous mode enabled');
  }

  // ─── stop ───────────────────────────────────────────────────────────────

  function stop(): void {
    if (!enabled) return;
    enabled = false;
    safeLogger.info('Autonomous mode disabled');
  }

  // ─── interrupt ──────────────────────────────────────────────────────────

  async function interrupt(): Promise<void> {
    if (!busy) return;

    safeLogger.info('Interrupting autonomous cycle');

    // Fire the abort signal
    if (abortController) {
      abortController.abort();
    }

    // Revert any partial git changes
    try {
      await git.checkoutBase();
    } catch {
      // Best-effort cleanup
    }

    busy = false;
    abortController = null;
  }

  // ─── tick ───────────────────────────────────────────────────────────────

  async function tick(): Promise<void> {
    if (!enabled || busy) return;

    // Respect the cycle interval
    const timeSinceLast = Date.now() - lastCycleEnd;
    if (lastCycleEnd > 0 && timeSinceLast < intervalMs) return;

    busy = true;
    abortController = new AbortController();

    try {
      safeLogger.info('Autonomous: starting cycle');
      await loop.runCycle(abortController.signal);

      totalCycles++;
      successfulCycles++;
      lastCycleAt = new Date().toISOString();
      safeLogger.info('Autonomous: cycle completed');
    } catch (error) {
      totalCycles++;

      if (error instanceof AbortError) {
        safeLogger.info('Autonomous: cycle aborted by interrupt');
      } else {
        safeLogger.error('Autonomous: cycle failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    } finally {
      busy = false;
      abortController = null;
      lastCycleEnd = Date.now();
    }
  }

  // ─── getStatus ──────────────────────────────────────────────────────────

  function getStatus(): AutonomousStatus {
    let nextCycleIn = 'now';

    if (!enabled) {
      nextCycleIn = 'disabled';
    } else if (busy) {
      nextCycleIn = 'running now';
    } else if (lastCycleEnd > 0) {
      const remaining = intervalMs - (Date.now() - lastCycleEnd);
      if (remaining > 0) {
        nextCycleIn = formatDuration(remaining);
      }
    }

    return {
      enabled,
      busy,
      totalCycles,
      successfulCycles,
      lastCycleAt,
      nextCycleIn,
    };
  }

  // ─── getDailyReport ────────────────────────────────────────────────────

  async function getDailyReport(): Promise<string> {
    const stats = await reflector.getStatistics(1);
    const reflections = await reflector.loadRecentReflections(20);
    return formatDailyReport(stats, reflections);
  }

  // ─── controller object ──────────────────────────────────────────────────

  return {
    start,
    stop,
    interrupt,
    tick,
    getStatus,
    getDailyReport,
    get enabled() { return enabled; },
    get busy() { return busy; },
  };
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function formatDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds} seconds`;

  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes !== 1 ? 's' : ''}`;

  const hours = Math.floor(minutes / 60);
  const remainMinutes = minutes % 60;
  if (remainMinutes === 0) return `${hours} hour${hours !== 1 ? 's' : ''}`;
  return `${hours}h ${remainMinutes}m`;
}
