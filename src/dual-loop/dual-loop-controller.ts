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
import type { IssueLog } from '../autonomous/issue-log.js';
import type { WorldModel } from '../autonomous/world-model.js';
import type { AgentToolkit } from '../autonomous/tools/types.js';
import type {
  AutonomousController,
  AutonomousStatus,
} from '../autonomous/controller-types.js';
import type { AgentTrigger, AgentOutcome } from '../autonomous/agent-loop.js';
import type { VoiceFilter } from '../imessage/voice-filter.js';
import type { HandoffState } from '../autonomous/types.js';
import { createLoopCoordinator } from './coordinator.js';
import type { CoordinatorConfig } from './coordinator.js';
import type { DeliverFn } from './fast-loop.js';
import { readRecentActivity, formatLedgerReport, formatRelativeTime } from '../observability/activity-ledger.js';
import { createChangeApplier } from '../autonomous/dream/change-applier.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Options for creating a DualLoopController.
 */
export interface DualLoopControllerOptions {
  /** LlmProvider for the FastLoop (35B-A3B model) */
  fastProvider: LlmProvider;
  /** LlmProvider for the DeepLoop reasoning model (27B) */
  deepProvider: LlmProvider;
  /** LlmProvider for the DeepLoop coder model (80B-A3B). Falls back to deepProvider if omitted. */
  coderProvider?: LlmProvider | undefined;
  /** ConcurrentProvider for model dispatch */
  concurrentProvider: ConcurrentProvider;
  /** Shared event bus (same instance used by watchers) */
  eventBus: EventBus;
  /** Goal stack for idle-time goal work */
  goalStack: GoalStack;
  /** Issue log for tracking reported problems */
  issueLog?: IssueLog | undefined;
  /** World model for codebase health tracking (used by dream cycles) */
  worldModel?: WorldModel | undefined;
  /** Voice filter for response delivery */
  voiceFilter: VoiceFilter;
  /** Coordinator configuration from autonomous.yaml */
  coordinatorConfig?: Partial<CoordinatorConfig> | undefined;
  /** Function to send a message to a user (iMessage sender) */
  sendMessageFn: (sender: string, text: string) => void;
  /** Agent toolkit for DeepLoop tool use (read_file, bash, grep, etc.) */
  toolkit?: AgentToolkit | undefined;
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
    options.toolkit,
    options.coderProvider,
  );

  // Wire the GoalStack into DeepLoop for idle-time goal work
  coordinator.getDeepLoop().setGoalStack(options.goalStack);

  // Wire GoalStack + IssueLog persistence into coordinator save timer
  coordinator.setPersistableStores(options.goalStack, options.issueLog);

  // Wire dream scheduler for idle-time self-improvement cycles
  if (options.worldModel && options.issueLog) {
    coordinator.initDreamScheduler({
      worldModel: options.worldModel,
      goalStack: options.goalStack,
      issueLog: options.issueLog,
      isDeepLoopIdle: () => false, // placeholder — the coordinator overrides this
    });

    // Wire autoresearch ChangeApplier — uses coder model to implement hypotheses
    const autoresearchProvider = options.coderProvider ?? options.deepProvider;
    coordinator.setAutoresearchChangeApplier(
      createChangeApplier(autoresearchProvider, process.cwd()),
    );
  }

  // Wire response delivery: FastLoop → voice filter → send
  // Voice filter and delivery are separate concerns: if the voice filter
  // fails we fall back to unvoiced text, but if delivery itself fails
  // (e.g. readline closed on piped input) we do NOT retry — the message
  // may have already been partially delivered, and retrying would duplicate it.
  const deliverFn: DeliverFn = async (sender: string, text: string) => {
    let voiced: string;
    try {
      voiced = await options.voiceFilter.apply(text);
    } catch (error) {
      safeLogger.error('Voice filter failed, sending unvoiced', {
        error: error instanceof Error ? error.message : String(error),
      });
      voiced = text;
    }

    try {
      options.sendMessageFn(sender, voiced);
    } catch (error) {
      safeLogger.error('Dual-loop delivery failed', {
        error: error instanceof Error ? error.message : String(error),
      });
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

  async function getStatusReport(command: string): Promise<string> {
    // Parametric ledger command: "ledger:N" where N is hours
    if (command.startsWith('ledger:')) {
      const hours = parseInt(command.slice(7), 10);
      const entries = await readRecentActivity(hours);
      return formatLedgerReport(entries, hours);
    }

    const health = coordinator.getHealth();

    switch (command) {
      case 'status':
        return [
          `Dual-loop: ${health.running ? 'active' : 'inactive'}`,
          `FastLoop: ${health.fast.running ? 'running' : 'stopped'} (${health.fast.errorCount} errors)`,
          `DeepLoop: ${health.deep.running ? 'running' : 'stopped'}${health.deep.currentTask ? ` [${health.deep.currentTask}]` : ''}`,
          `Tasks: ${health.taskBoard.active} active, ${health.taskBoard.queued} queued, ${health.taskBoard.doneToday} done today`,
          `Cycles: ${totalCycles} total, ${successfulCycles} succeeded`,
          coordinator.getDreamSchedulerSummary(),
        ].join('\n');
      case 'health':
        return coordinator.getHealthSummary();
      case 'activity':
        return coordinator.getTaskBoard().getSummaryText();
      case 'goals':
        return options.goalStack.getSummaryText();
      case 'issues':
        return options.issueLog
          ? options.issueLog.getSummaryText()
          : 'Issue tracking not configured.';
      case 'autoresearch': {
        try {
          const logPath = path.join(
            process.env['HOME'] || '~',
            '.casterly', 'autoresearch-log.json',
          );
          const raw = await fs.readFile(logPath, 'utf-8');
          const log = JSON.parse(raw) as {
            experiments: Array<{
              hypothesisId: string;
              hypothesisTitle: string;
              outcome: string;
              timestamp: string;
              durationMs: number;
            }>;
          };
          const total = log.experiments.length;
          const accepted = log.experiments.filter((e) => e.outcome === 'accepted').length;
          const reverted = log.experiments.filter((e) => e.outcome === 'reverted').length;
          const errored = log.experiments.filter((e) => e.outcome === 'error').length;
          const last5 = log.experiments.slice(-5).reverse();
          const lines = [
            `Autoresearch: ${total} experiments (${accepted} accepted, ${reverted} reverted, ${errored} errored)`,
            '',
            'Recent:',
          ];
          for (const e of last5) {
            const ago = formatRelativeTime(e.timestamp);
            lines.push(`  [${ago}] ${e.outcome}: ${e.hypothesisTitle} (${(e.durationMs / 1000).toFixed(0)}s)`);
          }
          return lines.join('\n');
        } catch {
          return 'Autoresearch: no experiments recorded yet.';
        }
      }
      case 'commands':
        return [
          'Available commands:',
          '  status         — system dashboard',
          '  health         — loop health details',
          '  activity       — task board summary',
          '  goals          — goal stack overview',
          '  issues         — open issues',
          '  autoresearch   — experiment results',
          '  ledger N hours — activity log (last N hours)',
          '  ledger N days  — activity log (last N days)',
          '  commands       — this list',
        ].join('\n');
      default:
        return `Dual-loop mode: ${enabled ? 'active' : 'inactive'}. Send "commands" for a full list.`;
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
    const taskBoard = coordinator.getTaskBoard();

    const lines: string[] = [];
    lines.push('Good morning! Here is your overnight report:');
    lines.push('');

    // ── System health ────────────────────────────────────────────────────
    lines.push(`System: ${health.running ? 'running' : 'stopped'}`);
    lines.push(`FastLoop: ${health.fast.running ? 'up' : 'down'} (${health.fast.errorCount} errors, ${health.fast.restartCount} restarts)`);
    lines.push(`DeepLoop: ${health.deep.running ? 'up' : 'down'}${health.deep.currentTask ? ` [${health.deep.currentTask}]` : ''} (${health.deep.errorCount} errors, ${health.deep.restartCount} restarts)`);
    lines.push('');

    // ── Task board ───────────────────────────────────────────────────────
    lines.push(`Tasks: ${health.taskBoard.doneToday} done today, ${health.taskBoard.active} active, ${health.taskBoard.queued} queued`);
    if (health.taskBoard.reviewing > 0) {
      lines.push(`  ${health.taskBoard.reviewing} awaiting review`);
    }

    // ── Codebase health ──────────────────────────────────────────────────
    if (options.worldModel) {
      const wm = options.worldModel.getHealth();
      const tc = wm.typecheck.passed ? 'passing' : `${wm.typecheck.errorCount} errors`;
      const tests = wm.tests.passed
        ? `${wm.tests.passing} passing`
        : `${wm.tests.passing} passing, ${wm.tests.failing} failing`;
      const lint = wm.lint.passed ? 'clean' : `${wm.lint.errorCount} errors`;

      lines.push('');
      lines.push(`Typecheck: ${tc}`);
      lines.push(`Tests: ${tests}`);
      lines.push(`Lint: ${lint}`);

      if (wm.tests.failingTests.length > 0) {
        for (const t of wm.tests.failingTests.slice(0, 3)) {
          lines.push(`  - ${t}`);
        }
        if (wm.tests.failingTests.length > 3) {
          lines.push(`  ... and ${wm.tests.failingTests.length - 3} more`);
        }
      }
    }

    // ── Dream cycles ─────────────────────────────────────────────────────
    const dreamSummary = coordinator.getDreamSchedulerSummary();
    if (dreamSummary && !dreamSummary.includes('not initialized')) {
      lines.push('');
      lines.push(dreamSummary);
    }

    // ── Goals ────────────────────────────────────────────────────────────
    const goalSummary = options.goalStack.getSummary();
    if (goalSummary.totalOpen > 0) {
      lines.push('');
      const parts: string[] = [`Goals: ${goalSummary.totalOpen} open`];
      if (goalSummary.inProgress.length > 0) parts.push(`${goalSummary.inProgress.length} in progress`);
      if (goalSummary.blocked.length > 0) parts.push(`${goalSummary.blocked.length} blocked`);
      lines.push(parts.join(', '));

      for (const g of goalSummary.inProgress.slice(0, 3)) {
        lines.push(`  - ${g.description}`);
      }
    }

    // ── Issues ───────────────────────────────────────────────────────────
    if (options.issueLog) {
      const issueSummary = options.issueLog.getSummary();
      if (issueSummary.totalOpen > 0) {
        lines.push('');
        lines.push(`Issues: ${issueSummary.totalOpen} open`);
        for (const i of issueSummary.investigating.slice(0, 3)) {
          lines.push(`  - [investigating] ${i.title}`);
        }
        const openNotInvestigating = issueSummary.openByPriority.filter(
          (i) => i.status !== 'investigating',
        );
        for (const i of openNotInvestigating.slice(0, 2)) {
          lines.push(`  - [${i.priority}] ${i.title}`);
        }
      }
    }

    // ── Pending branches (from handoff) ──────────────────────────────────
    const pending = handoff?.pendingBranches ?? [];
    if (pending.length > 0) {
      lines.push('');
      lines.push('Branches ready for review:');
      for (const b of pending) {
        lines.push(`  - ${b.branch}: ${b.proposal}`);
        lines.push(`    Confidence: ${b.confidence.toFixed(2)}`);
      }
    }

    lines.push('');
    lines.push('Reply "status" for live dashboard or "merge <branch>" to integrate.');

    return lines.join('\n');
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
