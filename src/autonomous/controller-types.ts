/**
 * Autonomous Controller Types
 *
 * Shared interface that the daemon uses to manage the autonomous system.
 * Both the legacy single-loop controller and the dual-loop controller
 * implement this interface.
 */

import type { AgentTrigger, AgentOutcome } from './agent-loop.js';
import type { HandoffState } from './types.js';

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
  /** Generate a concise status dashboard for iMessage. */
  getStatusReport(command: string): string;
  /** Whether autonomous mode is enabled. */
  readonly enabled: boolean;
  /** Whether a cycle is currently executing. */
  readonly busy: boolean;
}
