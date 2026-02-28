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
import { createLoopCoordinator } from './coordinator.js';
import type { CoordinatorConfig } from './coordinator.js';
import type { DeliverFn } from './fast-loop.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Options for creating a DualLoopController.
 */
export interface DualLoopControllerOptions {
  /** LlmProvider for the FastLoop (35B-A3B model) */
  fastProvider: LlmProvider;
  /** LlmProvider for the DeepLoop (122B model) */
  deepProvider: LlmProvider;
  /** ConcurrentProvider for model dispatch */
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

  // Wire the GoalStack into DeepLoop for idle-time goal work
  coordinator.getDeepLoop().setGoalStack(options.goalStack);

  // Wire response delivery: FastLoop → voice filter → iMessage
  const deliverFn: DeliverFn = async (sender: string, text: string) => {
    try {
      const voiced = await options.voiceFilter.apply(text);
      options.sendMessageFn(sender, voiced);
    } catch (error) {
      safeLogger.error('Dual-loop delivery failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      // Fall back to unvoiced delivery
      options.sendMessageFn(sender, text);
    }
  };
  coordinator.setDeliverFn(deliverFn);

  // ── start ──────────────────────────────────────────────────────────────

  function start(): void {
    if (enabled) return;
    enabled = true;
    busy = true;

    // Launch the coordinator as a long-running background task.
    // Unlike the standard controller (which waits for tick()), the
    // dual-loop coordinator runs both loops continuously.
    coordinatorPromise = coordinator.start().then(() => {
      tracer.log('coordinator', 'info', 'Coordinator exited');
      busy = false;
    }).catch((error: unknown) => {
      tracer.log('coordinator', 'error', 'Coordinator crashed', {
        error: error instanceof Error ? error.message : String(error),
      });
      busy = false;
    });

    safeLogger.info('Dual-loop controller started (coordinator launched)');
  }

  // ── stop ───────────────────────────────────────────────────────────────

  async function stop(): Promise<void> {
    if (!enabled) return;
    enabled = false;

    await coordinator.stop();
    if (coordinatorPromise) {
      await coordinatorPromise;
      coordinatorPromise = null;
    }

    safeLogger.info('Dual-loop controller stopped');
  }

  // ── interrupt ──────────────────────────────────────────────────────────
  // The dual-loop doesn't need interrupt in the same way — the FastLoop
  // is always responsive. But we honour the interface for preemption.

  async function interrupt(): Promise<void> {
    if (!busy) return;
    tracer.log('coordinator', 'info', 'Dual-loop interrupt requested');
    // The coordinator handles preemption via TaskBoard priority —
    // new high-priority tasks naturally preempt low-priority ones.
  }

  // ── tick ────────────────────────────────────────────────────────────────
  // No-op for the dual-loop. The coordinator runs continuously; it does
  // not need the daemon to tick it forward.

  async function tick(): Promise<void> {
    // Intentionally empty — the coordinator's own heartbeat and idle
    // timers handle all scheduling.
  }

  // ── runTriggeredCycle ──────────────────────────────────────────────────
  // The daemon calls this when a user message arrives. In the dual-loop
  // model, we route it to the FastLoop for instant triage rather than
  // running a full AgentLoop cycle.

  async function runTriggeredCycle(trigger: AgentTrigger): Promise<AgentOutcome> {
    const startedAt = new Date().toISOString();
    totalCycles++;

    if (trigger.type === 'user') {
      // Route to FastLoop — this returns immediately (enqueue, no await)
      coordinator.handleUserMessage(trigger.message, trigger.sender);

      successfulCycles++;
      lastCycleAt = new Date().toISOString();

      // Return a synthetic outcome with an empty summary. The real
      // response is delivered asynchronously by the FastLoop via
      // deliverFn — the daemon skips sending when summary is empty.
      return {
        trigger,
        success: true,
        stopReason: 'completed',
        summary: '',
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

    // Non-user triggers (events, goals, scheduled) are handled by
    // the DeepLoop's idle check automatically.
    successfulCycles++;
    lastCycleAt = new Date().toISOString();

    return {
      trigger,
      success: true,
      stopReason: 'completed',
      summary: 'Trigger handled by dual-loop coordinator.',
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

  // ── getStatus ──────────────────────────────────────────────────────────

  function getStatus(): AutonomousStatus {
    return {
      enabled,
      busy,
      totalCycles,
      successfulCycles,
      lastCycleAt,
      nextCycleIn: enabled ? 'continuous' : 'disabled',
    };
  }

  // ── getStatusReport ────────────────────────────────────────────────────

  function getStatusReport(command: string): string {
    const health = coordinator.getHealth();

    switch (command) {
      case 'status':
        return [
          `Dual-loop: ${health.running ? 'active' : 'inactive'}`,
          `FastLoop: ${health.fast.running ? 'running' : 'stopped'} (${health.fast.errorCount} errors)`,
          `DeepLoop: ${health.deep.running ? 'running' : 'stopped'}${health.deep.currentTask ? ` [${health.deep.currentTask}]` : ''}`,
          `Tasks: ${health.taskBoard.active} active, ${health.taskBoard.queued} queued, ${health.taskBoard.doneToday} done today`,
          `Cycles: ${totalCycles} total, ${successfulCycles} succeeded`,
        ].join('\n');
      case 'health':
        return coordinator.getHealthSummary();
      case 'activity':
        return coordinator.getTaskBoard().getSummaryText();
      default:
        return `Dual-loop mode: ${enabled ? 'active' : 'inactive'}. Commands: status, health, activity`;
    }
  }

  // ── getDailyReport ────────────────────────────────────────────────────

  async function getDailyReport(): Promise<string> {
    const health = coordinator.getHealth();
    const taskBoard = coordinator.getTaskBoard();
    return [
      '--- Dual-Loop Daily Report ---',
      `Tasks completed today: ${health.taskBoard.doneToday}`,
      `Active tasks: ${health.taskBoard.active}`,
      `Cycles processed: ${totalCycles}`,
      `FastLoop errors: ${health.fast.errorCount}`,
      `DeepLoop errors: ${health.deep.errorCount}`,
      '',
      taskBoard.getSummaryText(),
    ].join('\n');
  }

  // ── getMorningSummary ──────────────────────────────────────────────────

  async function getMorningSummary(): Promise<string> {
    const handoff = await getHandoff();
    const health = coordinator.getHealth();

    const parts: string[] = ['Good morning. Dual-loop summary:'];
    parts.push(`Tasks completed: ${health.taskBoard.doneToday}`);
    parts.push(`Active tasks: ${health.taskBoard.active}`);

    if (handoff) {
      parts.push(`Pending branches: ${handoff.pendingBranches.length}`);
      if (handoff.nightSummary.cyclesCompleted > 0) {
        parts.push(`Overnight cycles: ${handoff.nightSummary.cyclesCompleted}`);
      }
    }

    return parts.join('\n');
  }

  // ── writeHandoff ──────────────────────────────────────────────────────

  async function writeHandoff(): Promise<void> {
    const handoff: HandoffState = {
      timestamp: new Date().toISOString(),
      pendingBranches: [],
      lastCycleId: lastCycleAt,
      nightSummary: {
        cyclesCompleted: totalCycles,
        hypothesesAttempted: 0,
        hypothesesValidated: 0,
        tokenUsage: { input: 0, output: 0 },
      },
    };

    await fs.mkdir(path.dirname(HANDOFF_PATH), { recursive: true });
    await fs.writeFile(HANDOFF_PATH, JSON.stringify(handoff, null, 2), 'utf-8');
    safeLogger.info('Dual-loop handoff written');
  }

  // ── getHandoff ─────────────────────────────────────────────────────────

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
