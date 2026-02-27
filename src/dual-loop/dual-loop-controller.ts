/**
 * Dual-Loop Controller — Adapts LoopCoordinator to the AutonomousController interface.
 *
 * When `dual_loop.enabled: true` in autonomous.yaml, the daemon creates this
 * controller instead of the standard AutonomousController. It wraps the
 * LoopCoordinator (FastLoop + DeepLoop + TaskBoard) while implementing the
 * same interface the daemon expects: start/stop/interrupt/tick/runTriggeredCycle.
 *
 * Key differences from the standard controller:
 *   - User messages are routed to FastLoop (instant triage) rather than
 *     running a full AgentLoop cycle.
 *   - The coordinator runs continuously (both loops as coroutines), not
 *     on a tick-driven cycle interval.
 *   - Status reports use TaskBoard state rather than Reflector statistics.
 *
 * See docs/dual-loop-architecture.md Section 8.5 (Migration Path).
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { safeLogger } from '../logging/safe-logger.js';
import { getTracer } from '../autonomous/debug.js';
import type { LlmProvider } from '../providers/base.js';
import type { ConcurrentProvider } from '../providers/concurrent.js';
import type { EventBus } from '../autonomous/events.js';
import type { GoalStack } from '../autonomous/goal-stack.js';
import type {
  AutonomousController,
  AutonomousStatus,
} from '../autonomous/controller.js';
import type { AgentTrigger, AgentOutcome } from '../autonomous/agent-loop.js';
import type { VoiceFilter } from '../imessage/voice-filter.js';
import type { HandoffState } from '../autonomous/types.js';
import { LoopCoordinator, createLoopCoordinator } from './coordinator.js';
import type { CoordinatorConfig } from './coordinator.js';
import type { DeliverFn } from './fast-loop.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Options for creating a DualLoopController.
 */
export interface DualLoopControllerOptions {
  /** LlmProvider for the FastLoop (27B model) */
  fastProvider: LlmProvider;
  /** LlmProvider for the DeepLoop (122B model) */
  deepProvider: LlmProvider;
  /** ConcurrentProvider for Coder dispatch */
  concurrentProvider: ConcurrentProvider;
  /** Shared event bus (same instance used by watchers) */
  eventBus: EventBus;
  /** Goal stack for idle-time goal work */
  goalStack: GoalStack;
  /** Voice filter for response delivery */
  voiceFilter: VoiceFilter;
  /** Coordinator configuration from autonomous.yaml */
  coordinatorConfig?: Partial<CoordinatorConfig> | undefined;
  /** Function to send a message to a user (iMessage sender) */
  sendMessageFn: (sender: string, text: string) => void;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const HANDOFF_PATH = path.join(
  process.env['HOME'] || '~',
  '.casterly', 'autonomous', 'handoff.json',
);

// ─────────────────────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a DualLoopController that implements AutonomousController.
 *
 * The daemon calls this instead of createAutonomousController() when
 * dual_loop.enabled is true.
 */
export function createDualLoopController(
  options: DualLoopControllerOptions,
): AutonomousController {
  const tracer = getTracer();

  // ── State ────────────────────────────────────────────────────────────────
  let enabled = false;
  let busy = false;
  let totalCycles = 0;
  let successfulCycles = 0;
  let lastCycleAt: string | null = null;
  let coordinatorPromise: Promise<void> | null = null;

  // ── Coordinator ──────────────────────────────────────────────────────────
  const coordinator = createLoopCoordinator(
    options.fastProvider,
    options.deepProvider,
    options.concurrentProvider,
    options.eventBus,
    options.coordinatorConfig,
  );

  // Wire up response delivery: FastLoop → voice filter → iMessage
  const deliverFn: DeliverFn = async (sender: string, text: string) => {
    // TODO(pass-2): apply voice filter and send via iMessage
    void sender;
    void text;
  };
  coordinator.setDeliverFn(deliverFn);

  // ── AutonomousController interface ───────────────────────────────────────

  function start(): void {
    // TODO(pass-2): start coordinator, launch loops
    if (enabled) return;
    enabled = true;
  }

  function stop(): void {
    // TODO(pass-2): stop coordinator gracefully
    if (!enabled) return;
    enabled = false;
  }

  async function interrupt(): Promise<void> {
    // TODO(pass-2): stop coordinator for preemption
  }

  async function tick(): Promise<void> {
    // TODO(pass-2): no-op for dual-loop (coordinator runs continuously)
  }

  function getStatus(): AutonomousStatus {
    // TODO(pass-2): derive from coordinator health
    return {
      enabled,
      busy,
      totalCycles,
      successfulCycles,
      lastCycleAt,
      nextCycleIn: enabled ? 'continuous' : 'disabled',
    };
  }

  async function runTriggeredCycle(trigger: AgentTrigger): Promise<AgentOutcome> {
    // TODO(pass-2): route user messages to FastLoop, return synthetic outcome
    const startedAt = new Date().toISOString();
    return {
      trigger,
      success: true,
      stopReason: 'completed',
      summary: 'Routed to dual-loop.',
      turns: [],
      totalTurns: 0,
      totalTokensEstimate: 0,
      durationMs: 0,
      startedAt,
      endedAt: new Date().toISOString(),
      filesModified: [],
      issuesFiled: [],
      goalsUpdated: [],
    };
  }

  function getStatusReport(command: string): string {
    // TODO(pass-2): format from coordinator health + task board
    return `Dual-loop mode: ${enabled ? 'active' : 'inactive'}`;
  }

  async function getDailyReport(): Promise<string> {
    // TODO(pass-2): generate from task board history
    return 'Dual-loop daily report not yet implemented.';
  }

  async function getMorningSummary(): Promise<string> {
    // TODO(pass-2): generate from task board + handoff
    return 'Dual-loop morning summary not yet implemented.';
  }

  async function writeHandoff(): Promise<void> {
    // TODO(pass-2): persist task board state as handoff
  }

  async function getHandoff(): Promise<HandoffState | null> {
    try {
      const content = await fs.readFile(HANDOFF_PATH, 'utf-8');
      return JSON.parse(content) as HandoffState;
    } catch {
      return null;
    }
  }

  // ── Return controller ──────────────────────────────────────────────────

  return {
    start,
    stop,
    interrupt,
    tick,
    getStatus,
    getStatusReport,
    getDailyReport,
    getMorningSummary,
    writeHandoff,
    getHandoff,
    runTriggeredCycle,
    get enabled() { return enabled; },
    get busy() { return busy; },
  };
}
