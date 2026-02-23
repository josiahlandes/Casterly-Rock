/**
 * State Inspector CLI — Debug visibility into Tyrion's runtime state
 *
 * Provides subcommands for inspecting the agent's persistent state:
 *   - `casterly inspect state` — dump world model, goal stack, journal tail, issue log
 *   - `casterly inspect journal [--last N]` — read recent journal entries
 *   - `casterly inspect cycle [cycle-id]` — replay a cycle's decision trace
 *   - `casterly inspect watch --filter <categories>` — tail trace log in real-time
 *
 * Part of Phase 0: Debugging Infrastructure.
 */

import { WorldModel } from '../autonomous/world-model.js';
import { GoalStack } from '../autonomous/goal-stack.js';
import { IssueLog } from '../autonomous/issue-log.js';
import { Journal } from '../autonomous/journal.js';
import { safeLogger } from '../logging/safe-logger.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface InspectOptions {
  /** Number of recent entries to show */
  last?: number;
  /** Cycle ID for cycle replay */
  cycleId?: string;
  /** Comma-separated debug categories to filter */
  filter?: string;
  /** Project root directory */
  projectRoot?: string;
}

export interface StateSnapshot {
  worldModel: {
    healthy: boolean;
    concernCount: number;
    activityCount: number;
    lastFullUpdate: string;
    branch: string;
  };
  goalStack: {
    inProgress: number;
    pending: number;
    blocked: number;
    total: number;
  };
  issueLog: {
    open: number;
    investigating: number;
    resolved: number;
    total: number;
  };
  journal: {
    totalEntries: number;
    lastEntry: string | null;
    lastHandoff: string | null;
  };
}

export interface StateDiff {
  field: string;
  before: unknown;
  after: unknown;
}

// ─────────────────────────────────────────────────────────────────────────────
// State Snapshot
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Take a snapshot of the current state for comparison.
 */
export async function takeStateSnapshot(projectRoot?: string): Promise<StateSnapshot> {
  const worldModel = new WorldModel({ projectRoot: projectRoot ?? process.cwd() });
  const goalStack = new GoalStack();
  const issueLog = new IssueLog();
  const journal = new Journal();

  await Promise.all([
    worldModel.load(),
    goalStack.load(),
    issueLog.load(),
    journal.load(),
  ]);

  const goalSummary = goalStack.getSummary();
  const issueSummary = issueLog.getSummary();
  const stats = worldModel.getStats();
  const recentEntries = journal.getRecent(1);
  const lastHandoff = journal.getHandoffNote();

  return {
    worldModel: {
      healthy: worldModel.isHealthy(),
      concernCount: worldModel.getConcerns().length,
      activityCount: worldModel.getRecentActivity().length,
      lastFullUpdate: worldModel.getData().lastFullUpdate,
      branch: stats.branchName,
    },
    goalStack: {
      inProgress: goalSummary.inProgress.length,
      pending: goalSummary.topPending.length,
      blocked: goalSummary.blocked.length,
      total: goalSummary.inProgress.length + goalSummary.topPending.length + goalSummary.blocked.length,
    },
    issueLog: {
      open: issueSummary.openByPriority.length,
      investigating: issueSummary.investigating.length,
      resolved: issueSummary.recentlyResolved.length,
      total: issueSummary.openByPriority.length + issueSummary.investigating.length + issueSummary.recentlyResolved.length,
    },
    journal: {
      totalEntries: journal.getRecent(Infinity).length,
      lastEntry: recentEntries[0]?.timestamp ?? null,
      lastHandoff: lastHandoff?.timestamp ?? null,
    },
  };
}

/**
 * Compute the diff between two state snapshots.
 */
export function computeStateDiff(before: StateSnapshot, after: StateSnapshot): StateDiff[] {
  const diffs: StateDiff[] = [];

  const compare = (path: string, a: unknown, b: unknown) => {
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      diffs.push({ field: path, before: a, after: b });
    }
  };

  compare('worldModel.healthy', before.worldModel.healthy, after.worldModel.healthy);
  compare('worldModel.concernCount', before.worldModel.concernCount, after.worldModel.concernCount);
  compare('goalStack.inProgress', before.goalStack.inProgress, after.goalStack.inProgress);
  compare('goalStack.pending', before.goalStack.pending, after.goalStack.pending);
  compare('goalStack.blocked', before.goalStack.blocked, after.goalStack.blocked);
  compare('issueLog.open', before.issueLog.open, after.issueLog.open);
  compare('issueLog.investigating', before.issueLog.investigating, after.issueLog.investigating);
  compare('journal.totalEntries', before.journal.totalEntries, after.journal.totalEntries);

  return diffs;
}

// ─────────────────────────────────────────────────────────────────────────────
// Inspect Subcommands
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Inspect the full current state.
 */
export async function inspectState(options?: InspectOptions): Promise<string> {
  const snapshot = await takeStateSnapshot(options?.projectRoot);

  const lines: string[] = [
    '=== Tyrion State Inspector ===',
    '',
    '## World Model',
    `  Healthy: ${snapshot.worldModel.healthy ? 'YES' : 'NO'}`,
    `  Concerns: ${snapshot.worldModel.concernCount}`,
    `  Recent activities: ${snapshot.worldModel.activityCount}`,
    `  Branch: ${snapshot.worldModel.branch}`,
    `  Last full update: ${snapshot.worldModel.lastFullUpdate}`,
    '',
    '## Goal Stack',
    `  In progress: ${snapshot.goalStack.inProgress}`,
    `  Pending: ${snapshot.goalStack.pending}`,
    `  Blocked: ${snapshot.goalStack.blocked}`,
    '',
    '## Issue Log',
    `  Open: ${snapshot.issueLog.open}`,
    `  Investigating: ${snapshot.issueLog.investigating}`,
    `  Recently resolved: ${snapshot.issueLog.resolved}`,
    '',
    '## Journal',
    `  Total entries: ${snapshot.journal.totalEntries}`,
    `  Last entry: ${snapshot.journal.lastEntry ?? '(none)'}`,
    `  Last handoff: ${snapshot.journal.lastHandoff ?? '(none)'}`,
  ];

  return lines.join('\n');
}

/**
 * Inspect recent journal entries.
 */
export async function inspectJournal(options?: InspectOptions): Promise<string> {
  const journal = new Journal();
  await journal.load();

  const limit = options?.last ?? 10;
  const entries = journal.getRecent(limit);

  if (entries.length === 0) {
    return 'No journal entries found.';
  }

  const lines: string[] = [`=== Journal (last ${entries.length} entries) ===`, ''];

  for (const entry of entries) {
    lines.push(`--- [${entry.type}] ${entry.timestamp} ---`);
    if (entry.tags.length > 0) {
      lines.push(`Tags: ${entry.tags.join(', ')}`);
    }
    if (entry.cycleId) {
      lines.push(`Cycle: ${entry.cycleId}`);
    }
    lines.push('');
    lines.push(entry.content);
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Format state diff for logging.
 */
export function formatStateDiff(diffs: StateDiff[]): string {
  if (diffs.length === 0) {
    return '(no state changes)';
  }

  return diffs
    .map((d) => `  ${d.field}: ${JSON.stringify(d.before)} → ${JSON.stringify(d.after)}`)
    .join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI Entry Point
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Run the inspector from CLI arguments.
 */
export async function runInspector(args: string[]): Promise<void> {
  const subcommand = args[0] ?? 'state';

  const options: InspectOptions = {};

  // Parse --last N
  const lastIdx = args.indexOf('--last');
  if (lastIdx >= 0) {
    const lastVal = args[lastIdx + 1];
    if (lastVal !== undefined) {
      options.last = parseInt(lastVal, 10);
    }
  }

  // Parse --filter
  const filterIdx = args.indexOf('--filter');
  if (filterIdx >= 0) {
    const filterVal = args[filterIdx + 1];
    if (filterVal !== undefined) {
      options.filter = filterVal;
    }
  }

  switch (subcommand) {
    case 'state': {
      const output = await inspectState(options);
      safeLogger.info(output);
      break;
    }
    case 'journal': {
      const output = await inspectJournal(options);
      safeLogger.info(output);
      break;
    }
    default:
      safeLogger.info(`Unknown inspector subcommand: ${subcommand}`);
      safeLogger.info('Available: state, journal');
  }
}
