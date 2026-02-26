/**
 * Status Report — Formatted status dashboards for iMessage
 *
 * Five pure formatting functions that read state from AutonomousLoop's
 * public getters and return plain-text strings optimized for iMessage.
 *
 * Design principles:
 * - Plain text (no markdown — renders poorly on iMessage)
 * - Emoji status indicators for quick scanning
 * - Concise — fits on one screen (~15-20 lines max)
 * - Relative timestamps ("2 min ago", "1h ago")
 * - Priority-sorted
 * - Recent completions to show progress
 */

import type { AutonomousLoop } from './loop.js';
import type { AutonomousStatus } from './controller.js';
import type { Goal, GoalStatus } from './goal-stack.js';
import type { Issue, IssuePriority } from './issue-log.js';
import type { JournalEntry } from './journal.js';
import type { ActivityEntry } from './world-model.js';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Format an ISO timestamp as a relative time string.
 * Returns strings like "2 min ago", "1h ago", "3 days ago".
 */
export function formatRelativeTime(isoTimestamp: string): string {
  const then = new Date(isoTimestamp).getTime();
  const now = Date.now();
  const diffMs = now - then;

  if (diffMs < 0) return 'just now';

  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return 'just now';

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  if (days === 1) return '1 day ago';
  return `${days} days ago`;
}

const GOAL_STATUS_EMOJI: Record<GoalStatus, string> = {
  in_progress: '\u25B6',  // ▶
  pending: '\u23F8',      // ⏸
  blocked: '\uD83D\uDEAB', // 🚫
  done: '\u2705',         // ✅
  abandoned: '\u274C',    // ❌
};

const PRIORITY_EMOJI: Record<IssuePriority, string> = {
  critical: '\uD83D\uDD34', // 🔴
  high: '\uD83D\uDFE0',     // 🟠
  medium: '\uD83D\uDFE1',   // 🟡
  low: '\uD83D\uDFE2',      // 🟢
};

// ─────────────────────────────────────────────────────────────────────────────
// Format: Status Overview
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compact overview of everything — health, cycles, goals, issues, current work.
 */
export function formatStatusOverview(loop: AutonomousLoop, status: AutonomousStatus): string {
  const health = loop.worldModelInstance.getHealth();
  const goalSummary = loop.goalStackInstance.getSummary();
  const issueSummary = loop.issueLogInstance.getSummary();

  const healthEmoji = health.healthy ? '\uD83D\uDFE2' : '\uD83D\uDD34'; // 🟢 / 🔴
  const healthLabel = health.healthy ? 'all passing' : 'issues detected';

  const statusLabel = status.busy ? 'running a cycle' : 'idle';
  const lastCycleLabel = status.lastCycleAt
    ? formatRelativeTime(status.lastCycleAt)
    : 'never';

  // Current work: the first in-progress goal
  const currentWork = goalSummary.inProgress.length > 0
    ? goalSummary.inProgress[0]!.description
    : 'nothing in progress';

  // Count goal statuses
  const inProgressCount = goalSummary.inProgress.length;
  const blockedCount = goalSummary.blocked.length;
  const goalDetail: string[] = [];
  if (inProgressCount > 0) goalDetail.push(`${inProgressCount} in progress`);
  if (blockedCount > 0) goalDetail.push(`${blockedCount} blocked`);

  // Count issue statuses
  const investigatingCount = issueSummary.investigating.length;

  const lines = [
    'System Status',
    '',
    `${healthEmoji} Health: ${healthLabel}`,
    `\u2699\uFE0F Status: ${statusLabel} (last cycle: ${lastCycleLabel})`,
    `Cycles: ${status.totalCycles} (${status.successfulCycles} successful)`,
    '',
    `Goals: ${goalSummary.totalOpen} open${goalDetail.length > 0 ? ` (${goalDetail.join(', ')})` : ''}`,
    `Issues: ${issueSummary.totalOpen} open${investigatingCount > 0 ? ` (${investigatingCount} investigating)` : ''}`,
    '',
    `Working on: ${currentWork}`,
    `Next cycle: ${status.nextCycleIn}`,
  ];

  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Format: Goals Summary
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Active + pending + blocked goals with recent completions.
 */
export function formatGoalsSummary(loop: AutonomousLoop): string {
  const goalStack = loop.goalStackInstance;
  const summary = goalStack.getSummary();
  const recentlyCompleted = goalStack.getRecentlyCompleted(3);

  const lines: string[] = [`Goal Stack (${summary.totalOpen} open)`];

  if (summary.totalOpen === 0 && recentlyCompleted.length === 0) {
    lines.push('', 'No goals on the stack.');
    return lines.join('\n');
  }

  // In progress first
  for (const g of summary.inProgress) {
    lines.push('');
    const attemptsLabel = g.attempts > 0 ? `, ${g.attempts} attempts` : '';
    lines.push(`${GOAL_STATUS_EMOJI.in_progress} [${g.id}] ${g.description} (in progress${attemptsLabel})`);
    if (g.notes) {
      lines.push(`  Notes: ${g.notes}`);
    }
  }

  // Pending
  for (const g of summary.topPending) {
    lines.push('');
    lines.push(`${GOAL_STATUS_EMOJI.pending} [${g.id}] ${g.description} (pending, priority ${g.priority})`);
  }

  // Blocked
  for (const g of summary.blocked) {
    lines.push('');
    lines.push(`${GOAL_STATUS_EMOJI.blocked} [${g.id}] ${g.description} (blocked)`);
    if (g.notes) {
      lines.push(`  Notes: ${g.notes}`);
    }
  }

  // Recently completed
  if (recentlyCompleted.length > 0) {
    lines.push('');
    lines.push(`${GOAL_STATUS_EMOJI.done} Recently completed:`);
    for (const g of recentlyCompleted) {
      lines.push(`- [${g.id}] ${g.description}`);
    }
  }

  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Format: Issues Summary
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Open + investigating issues with recent resolutions.
 */
export function formatIssuesSummary(loop: AutonomousLoop): string {
  const issueLog = loop.issueLogInstance;
  const summary = issueLog.getSummary();
  const recentlyResolved = issueLog.getRecentlyResolved(3);

  const lines: string[] = [`Issues (${summary.totalOpen} open)`];

  if (summary.totalOpen === 0 && recentlyResolved.length === 0) {
    lines.push('', 'No open issues.');
    return lines.join('\n');
  }

  // Investigating first
  for (const i of summary.investigating) {
    lines.push('');
    const emoji = PRIORITY_EMOJI[i.priority] ?? '\uD83D\uDD0D';
    const attemptsLabel = i.attempts.length > 0 ? `, ${i.attempts.length} attempts` : '';
    lines.push(`\uD83D\uDD0D [${i.id}] ${i.title} (investigating, ${i.priority}${attemptsLabel})`);
    if (i.nextIdea) {
      lines.push(`  Next: ${i.nextIdea}`);
    }
  }

  // Open (not investigating)
  const openNotInvestigating = summary.openByPriority.filter((i) => i.status === 'open');
  for (const i of openNotInvestigating.slice(0, 5)) {
    lines.push('');
    lines.push(`\uD83D\uDCCB [${i.id}] ${i.title} (${i.priority})`);
  }
  if (openNotInvestigating.length > 5) {
    lines.push(`  ... and ${openNotInvestigating.length - 5} more`);
  }

  // Recently resolved
  if (recentlyResolved.length > 0) {
    lines.push('');
    lines.push('\u2705 Recently resolved:');
    for (const i of recentlyResolved) {
      lines.push(`- [${i.id}] ${i.title}`);
    }
  }

  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Format: Health Report
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Codebase health — typecheck, tests, lint, branch, last commit.
 */
export function formatHealthReport(loop: AutonomousLoop): string {
  const health = loop.worldModelInstance.getHealth();
  const stats = loop.worldModelInstance.getStats();

  const tc = health.typecheck.passed ? '\u2705 passing' : `\u274C ${health.typecheck.errorCount} errors`;
  const tests = health.tests.passed
    ? `\u2705 ${health.tests.passing} passing, 0 failing`
    : `\u274C ${health.tests.passing} passing, ${health.tests.failing} failing`;
  const lint = health.lint.passed ? '\u2705 clean' : `\u274C ${health.lint.errorCount} errors`;

  const commitHash = stats.lastCommitHash ? stats.lastCommitHash.slice(0, 7) : 'unknown';
  const commitMsg = stats.lastCommitMessage || 'unknown';

  const lines = [
    'Codebase Health',
    '',
    `Typecheck: ${tc}`,
    `Tests: ${tests}`,
    `Lint: ${lint}`,
    '',
    `Branch: ${stats.branchName || 'unknown'}`,
    `Last commit: ${commitHash} ${commitMsg}`,
  ];

  // Add failing test names if any
  if (health.tests.failingTests.length > 0) {
    lines.push('');
    lines.push('Failing tests:');
    for (const t of health.tests.failingTests.slice(0, 5)) {
      lines.push(`- ${t}`);
    }
    if (health.tests.failingTests.length > 5) {
      lines.push(`  ... and ${health.tests.failingTests.length - 5} more`);
    }
  }

  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Format: Activity Report
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Recent activity — world model activity entries + journal entries, merged
 * chronologically and capped at 8 entries.
 */
export function formatActivityReport(loop: AutonomousLoop): string {
  const worldModel = loop.worldModelInstance;
  const journal = loop.journalInstance;

  // Merge world model activity and journal entries
  interface MergedEntry {
    timestamp: string;
    description: string;
  }

  const merged: MergedEntry[] = [];

  // Add world model activity entries
  const activities = worldModel.getRecentActivity(5);
  for (const a of activities) {
    merged.push({
      timestamp: a.timestamp,
      description: a.description,
    });
  }

  // Add recent journal entries (handoffs + user_interactions are most interesting)
  const journalEntries = journal.getRecent(5);
  for (const e of journalEntries) {
    // Skip if it would be too noisy — only show handoffs and user interactions
    if (e.type !== 'handoff' && e.type !== 'user_interaction') continue;

    const prefix = e.type === 'handoff' ? 'Cycle handoff' : 'User interaction';
    // Truncate content for iMessage readability
    const content = e.content.length > 60 ? e.content.slice(0, 57) + '...' : e.content;
    merged.push({
      timestamp: e.timestamp,
      description: `${prefix}: ${content}`,
    });
  }

  // Sort by timestamp descending (most recent first)
  merged.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

  // Cap at 8 entries
  const capped = merged.slice(0, 8);

  if (capped.length === 0) {
    return 'Recent Activity\n\nNo recent activity recorded.';
  }

  const lines = ['Recent Activity'];

  for (const entry of capped) {
    const timeLabel = formatRelativeTime(entry.timestamp);
    lines.push(`- [${timeLabel}] ${entry.description}`);
  }

  return lines.join('\n');
}
