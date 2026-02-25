/**
 * Autonomous Controller (daemon-side)
 *
 * Wraps the AutonomousLoop with start/stop/interrupt/tick/status semantics
 * so the iMessage daemon can manage the autonomous cycle in-process.
 *
 * Key design: we never call AutonomousLoop.start() (blocking). Instead the
 * daemon calls tick() every poll interval, which calls runAgentCycle() once when
 * the cycle interval has elapsed and the loop is enabled.
 *
 * Handoff: when the work window closes (6am) or a cycle completes with
 * pending branches, a handoff file is written to persist overnight state.
 * The 8am morning summary reads this handoff to report pending work.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { safeLogger } from '../logging/safe-logger.js';
import { AutonomousLoop, AbortError } from './loop.js';
import type { AgentTrigger, AgentOutcome } from './agent-loop.js';
import type { Reflector } from './reflector.js';
import { formatDailyReport, formatMorningSummary } from './report.js';
import type { AutonomousConfig, HandoffState } from './types.js';

// ═══════════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════════

const HANDOFF_PATH = path.join(
  process.env['HOME'] || '~',
  '.casterly', 'autonomous', 'handoff.json'
);

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
  /** Generate an 8am morning summary with handoff state. */
  getMorningSummary(): Promise<string>;
  /** Write the handoff file (pending branches + night summary). */
  writeHandoff(): Promise<void>;
  /** Read the current handoff file, or null if none exists. */
  getHandoff(): Promise<HandoffState | null>;
  /** Run a triggered cycle (e.g., from user message). Bypasses enabled check. */
  runTriggeredCycle(trigger: AgentTrigger): Promise<AgentOutcome>;
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
  let wasInWorkWindow = false;

  // Access the reflector through the loop's public getter
  const reflector: Reflector = loop.reflectorInstance;
  const git = loop.gitInstance;

  // ─── start ──────────────────────────────────────────────────────────────

  function start(): void {
    if (enabled) return;
    enabled = true;
    wasInWorkWindow = isInWorkWindow(loop.configInstance);
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
    if (!enabled) return;

    // Detect work-window transition (night → day) and write handoff
    const inWorkWindow = isInWorkWindow(loop.configInstance);
    if (wasInWorkWindow && !inWorkWindow) {
      safeLogger.info('Work window closed — writing handoff');
      try {
        await writeHandoff();
      } catch (error) {
        safeLogger.error('Failed to write handoff on window close', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    wasInWorkWindow = inWorkWindow;

    if (busy) return;

    // Respect the cycle interval
    const timeSinceLast = Date.now() - lastCycleEnd;
    if (lastCycleEnd > 0 && timeSinceLast < intervalMs) return;

    busy = true;
    abortController = new AbortController();

    try {
      safeLogger.info('Autonomous: starting agent cycle');
      // The agent loop is the sole execution path
      await loop.runAgentCycle();

      totalCycles++;
      successfulCycles++;
      lastCycleAt = new Date().toISOString();
      safeLogger.info('Autonomous: agent cycle completed');

      // Write handoff after each cycle if there are pending branches
      if (loop.pendingBranchList.length > 0) {
        await writeHandoff();
      }
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

  // ─── runTriggeredCycle ──────────────────────────────────────────────────

  async function runTriggeredCycle(trigger: AgentTrigger): Promise<AgentOutcome> {
    // If a background cycle is running, interrupt it — user work takes priority
    if (busy) {
      safeLogger.info('Interrupting background cycle for triggered cycle');
      await interrupt();
    }

    busy = true;
    abortController = new AbortController();

    try {
      safeLogger.info('Running triggered agent cycle', { triggerType: trigger.type });
      const outcome = await loop.runAgentCycle(trigger);

      totalCycles++;
      successfulCycles++;
      lastCycleAt = new Date().toISOString();
      safeLogger.info('Triggered agent cycle completed', { stopReason: outcome.stopReason });

      return outcome;
    } catch (error) {
      totalCycles++;

      if (error instanceof AbortError) {
        safeLogger.info('Triggered cycle aborted');
      } else {
        safeLogger.error('Triggered cycle failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      }

      // Return a minimal error outcome so callers always get a result
      return {
        trigger,
        success: false,
        stopReason: 'error',
        summary: error instanceof Error ? error.message : 'Cycle failed unexpectedly.',
        turns: [],
        totalTurns: 0,
        totalTokensEstimate: 0,
        durationMs: 0,
        startedAt: new Date().toISOString(),
        endedAt: new Date().toISOString(),
        filesModified: [],
        issuesFiled: [],
        goalsUpdated: [],
        error: error instanceof Error ? error.message : String(error),
      };
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

  // ─── getMorningSummary ──────────────────────────────────────────────────

  async function getMorningSummary(): Promise<string> {
    const handoff = await getHandoff();
    const stats = await reflector.getStatistics(1);
    const reflections = await reflector.loadRecentReflections(20);
    return formatMorningSummary(stats, reflections, handoff);
  }

  // ─── writeHandoff ──────────────────────────────────────────────────────

  async function writeHandoff(): Promise<void> {
    const pending = loop.pendingBranchList;
    const stats = await reflector.getStatistics(1);

    const handoff: HandoffState = {
      timestamp: new Date().toISOString(),
      pendingBranches: pending,
      lastCycleId: lastCycleAt,
      nightSummary: {
        cyclesCompleted: totalCycles,
        hypothesesAttempted: stats.totalCycles > 0 ? stats.totalCycles : 0,
        hypothesesValidated: pending.length,
        tokenUsage: stats.totalTokensUsed,
      },
    };

    await fs.mkdir(path.dirname(HANDOFF_PATH), { recursive: true });
    await fs.writeFile(HANDOFF_PATH, JSON.stringify(handoff, null, 2), 'utf-8');
    safeLogger.info('Handoff file written', { pendingBranches: pending.length });
  }

  // ─── getHandoff ─────────────────────────────────────────────────────────

  async function getHandoff(): Promise<HandoffState | null> {
    try {
      const content = await fs.readFile(HANDOFF_PATH, 'utf-8');
      return JSON.parse(content) as HandoffState;
    } catch {
      return null;
    }
  }

  // ─── controller object ──────────────────────────────────────────────────

  return {
    start,
    stop,
    interrupt,
    tick,
    getStatus,
    getDailyReport,
    getMorningSummary,
    writeHandoff,
    getHandoff,
    runTriggeredCycle,
    get enabled() { return enabled; },
    get busy() { return busy; },
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Check if the current time is within quiet hours.
 * Returns true always — quiet hours are a scheduling preference, not
 * a hard gate. The LLM receives quiet hours info via the system prompt
 * and prefers consolidation work during those times.
 *
 * The function is kept for backward compatibility (callers that check
 * work window transitions for handoff writing). It now returns true
 * unconditionally — the loop always works. See docs/vision.md.
 */
export function isInWorkWindow(_config: AutonomousConfig): boolean {
  return true;
}

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
