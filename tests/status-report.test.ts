import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resetTracer, initTracer } from '../src/autonomous/debug.js';
import {
  formatStatusOverview,
  formatGoalsSummary,
  formatIssuesSummary,
  formatHealthReport,
  formatActivityReport,
  formatRelativeTime,
} from '../src/autonomous/status-report.js';
import type { AutonomousStatus } from '../src/autonomous/controller.js';
import type { AutonomousLoop } from '../src/autonomous/loop.js';
import type { Goal, GoalStackSummary } from '../src/autonomous/goal-stack.js';
import type { Issue, IssueLogSummary } from '../src/autonomous/issue-log.js';
import type { HealthSnapshot, ActivityEntry } from '../src/autonomous/world-model.js';
import type { JournalEntry } from '../src/autonomous/journal.js';

// ─────────────────────────────────────────────────────────────────────────────
// Mock Data Helpers
// ─────────────────────────────────────────────────────────────────────────────

const now = new Date().toISOString();
const twoMinAgo = new Date(Date.now() - 2 * 60 * 1000).toISOString();
const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

function makeGoal(overrides: Partial<Goal> = {}): Goal {
  return {
    id: 'goal-001',
    source: 'user',
    priority: 1,
    description: 'Fix login validation',
    created: now,
    updated: now,
    status: 'in_progress',
    attempts: 2,
    notes: 'Tried regex approach',
    relatedFiles: [],
    tags: [],
    ...overrides,
  };
}

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: 'ISS-001',
    title: 'TypeError in calendar parser',
    description: 'Calendar parser throws TypeError on invalid date',
    status: 'investigating',
    priority: 'high',
    firstSeen: now,
    lastUpdated: now,
    relatedFiles: [],
    tags: [],
    attempts: [],
    nextIdea: 'Try parsing with Temporal API',
    discoveredBy: 'autonomous',
    resolution: '',
    ...overrides,
  };
}

function makeHealthSnapshot(overrides: Partial<HealthSnapshot> = {}): HealthSnapshot {
  return {
    timestamp: now,
    typecheck: { passed: true, errorCount: 0, errors: [] },
    tests: { passed: true, total: 3398, passing: 3398, failing: 0, skipped: 0, failingTests: [] },
    lint: { passed: true, errorCount: 0, warningCount: 0 },
    healthy: true,
    ...overrides,
  };
}

function makeActivity(overrides: Partial<ActivityEntry> = {}): ActivityEntry {
  return {
    timestamp: twoMinAgo,
    description: 'Committed: fix login validation',
    source: 'tyrion',
    ...overrides,
  };
}

function makeJournalEntry(overrides: Partial<JournalEntry> = {}): JournalEntry {
  return {
    id: 'j-test-1',
    timestamp: oneHourAgo,
    type: 'handoff',
    content: 'Finished working on login validation, needs tests next',
    tags: ['login', 'validation'],
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Mock Loop Builder
// ─────────────────────────────────────────────────────────────────────────────

interface MockLoopOptions {
  goalSummary?: GoalStackSummary;
  recentlyCompleted?: Goal[];
  issueSummary?: IssueLogSummary;
  recentlyResolved?: Issue[];
  health?: HealthSnapshot;
  stats?: {
    totalFiles: number;
    totalLines: number;
    lastCommitHash: string;
    lastCommitMessage: string;
    branchName: string;
  };
  recentActivity?: ReadonlyArray<ActivityEntry>;
  journalEntries?: JournalEntry[];
}

function createMockLoop(opts: MockLoopOptions = {}): AutonomousLoop {
  const defaultGoalSummary: GoalStackSummary = {
    totalOpen: 0,
    inProgress: [],
    topPending: [],
    blocked: [],
    stale: [],
    recentlyCompleted: [],
  };

  const defaultIssueSummary: IssueLogSummary = {
    totalOpen: 0,
    investigating: [],
    openByPriority: [],
    stale: [],
    recentlyResolved: [],
    mostAttempted: [],
  };

  const defaultStats = {
    totalFiles: 155,
    totalLines: 32000,
    lastCommitHash: '9360d13abc',
    lastCommitMessage: 'feat: two-tier tool loading',
    branchName: 'main',
  };

  return {
    goalStackInstance: {
      getSummary: () => opts.goalSummary ?? defaultGoalSummary,
      getRecentlyCompleted: (limit?: number) =>
        (opts.recentlyCompleted ?? []).slice(0, limit ?? 5),
    },
    issueLogInstance: {
      getSummary: () => opts.issueSummary ?? defaultIssueSummary,
      getRecentlyResolved: (limit?: number) =>
        (opts.recentlyResolved ?? []).slice(0, limit ?? 5),
    },
    worldModelInstance: {
      getHealth: () => opts.health ?? makeHealthSnapshot(),
      getStats: () => opts.stats ?? defaultStats,
      getRecentActivity: (limit?: number) =>
        (opts.recentActivity ?? []).slice(0, limit ?? 50),
    },
    journalInstance: {
      getRecent: (n: number) => (opts.journalEntries ?? []).slice(0, n),
    },
  } as unknown as AutonomousLoop;
}

function makeStatus(overrides: Partial<AutonomousStatus> = {}): AutonomousStatus {
  return {
    enabled: true,
    busy: false,
    totalCycles: 47,
    successfulCycles: 45,
    lastCycleAt: twoMinAgo,
    nextCycleIn: '12 minutes',
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('formatRelativeTime', () => {
  it('returns "just now" for timestamps less than 60s ago', () => {
    const ts = new Date(Date.now() - 30 * 1000).toISOString();
    expect(formatRelativeTime(ts)).toBe('just now');
  });

  it('returns minutes for timestamps less than 1h ago', () => {
    const ts = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    expect(formatRelativeTime(ts)).toBe('15 min ago');
  });

  it('returns hours for timestamps less than 24h ago', () => {
    const ts = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    expect(formatRelativeTime(ts)).toBe('3h ago');
  });

  it('returns "1 day ago" for exactly 1 day', () => {
    const ts = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    expect(formatRelativeTime(ts)).toBe('1 day ago');
  });

  it('returns "N days ago" for multiple days', () => {
    const ts = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
    expect(formatRelativeTime(ts)).toBe('5 days ago');
  });

  it('returns "just now" for future timestamps', () => {
    const ts = new Date(Date.now() + 60 * 1000).toISOString();
    expect(formatRelativeTime(ts)).toBe('just now');
  });
});

describe('formatStatusOverview', () => {
  it('produces non-empty output with default state', () => {
    const loop = createMockLoop();
    const output = formatStatusOverview(loop, makeStatus());
    expect(output).toBeTruthy();
    expect(output.length).toBeGreaterThan(20);
  });

  it('includes health status', () => {
    const loop = createMockLoop();
    const output = formatStatusOverview(loop, makeStatus());
    expect(output).toContain('Health: all passing');
  });

  it('shows unhealthy status when codebase has issues', () => {
    const loop = createMockLoop({
      health: makeHealthSnapshot({ healthy: false }),
    });
    const output = formatStatusOverview(loop, makeStatus());
    expect(output).toContain('Health: issues detected');
  });

  it('includes goals count', () => {
    const loop = createMockLoop({
      goalSummary: {
        totalOpen: 3,
        inProgress: [makeGoal()],
        topPending: [],
        blocked: [makeGoal({ id: 'goal-002', status: 'blocked' })],
        stale: [],
        recentlyCompleted: [],
      },
    });
    const output = formatStatusOverview(loop, makeStatus());
    expect(output).toContain('Goals: 3 open');
    expect(output).toContain('1 in progress');
    expect(output).toContain('1 blocked');
  });

  it('includes issues count', () => {
    const loop = createMockLoop({
      issueSummary: {
        totalOpen: 2,
        investigating: [makeIssue()],
        openByPriority: [],
        stale: [],
        recentlyResolved: [],
        mostAttempted: [],
      },
    });
    const output = formatStatusOverview(loop, makeStatus());
    expect(output).toContain('Issues: 2 open');
    expect(output).toContain('1 investigating');
  });

  it('includes current work', () => {
    const loop = createMockLoop({
      goalSummary: {
        totalOpen: 1,
        inProgress: [makeGoal({ description: 'Implement dark mode' })],
        topPending: [],
        blocked: [],
        stale: [],
        recentlyCompleted: [],
      },
    });
    const output = formatStatusOverview(loop, makeStatus());
    expect(output).toContain('Working on: Implement dark mode');
  });

  it('shows "nothing in progress" when no goals are active', () => {
    const loop = createMockLoop();
    const output = formatStatusOverview(loop, makeStatus());
    expect(output).toContain('Working on: nothing in progress');
  });

  it('includes cycle info', () => {
    const output = formatStatusOverview(createMockLoop(), makeStatus());
    expect(output).toContain('Cycles: 47 (45 successful)');
    expect(output).toContain('Next cycle: 12 minutes');
  });
});

describe('formatGoalsSummary', () => {
  it('shows empty state message when no goals', () => {
    const loop = createMockLoop();
    const output = formatGoalsSummary(loop);
    expect(output).toContain('Goal Stack (0 open)');
    expect(output).toContain('No goals on the stack.');
  });

  it('groups goals by status: in_progress first', () => {
    const loop = createMockLoop({
      goalSummary: {
        totalOpen: 3,
        inProgress: [makeGoal({ id: 'goal-001', description: 'Fix login' })],
        topPending: [makeGoal({ id: 'goal-002', status: 'pending', description: 'Add tests', priority: 3 })],
        blocked: [makeGoal({ id: 'goal-003', status: 'blocked', description: 'Refactor auth', notes: 'Waiting on config' })],
        stale: [],
        recentlyCompleted: [],
      },
    });
    const output = formatGoalsSummary(loop);

    // Check ordering: in_progress first, then pending, then blocked
    const inProgressIdx = output.indexOf('Fix login');
    const pendingIdx = output.indexOf('Add tests');
    const blockedIdx = output.indexOf('Refactor auth');

    expect(inProgressIdx).toBeLessThan(pendingIdx);
    expect(pendingIdx).toBeLessThan(blockedIdx);
  });

  it('includes attempt count for in-progress goals', () => {
    const loop = createMockLoop({
      goalSummary: {
        totalOpen: 1,
        inProgress: [makeGoal({ attempts: 3 })],
        topPending: [],
        blocked: [],
        stale: [],
        recentlyCompleted: [],
      },
    });
    const output = formatGoalsSummary(loop);
    expect(output).toContain('3 attempts');
  });

  it('includes notes for in-progress goals', () => {
    const loop = createMockLoop({
      goalSummary: {
        totalOpen: 1,
        inProgress: [makeGoal({ notes: 'Trying different regex' })],
        topPending: [],
        blocked: [],
        stale: [],
        recentlyCompleted: [],
      },
    });
    const output = formatGoalsSummary(loop);
    expect(output).toContain('Notes: Trying different regex');
  });

  it('includes priority for pending goals', () => {
    const loop = createMockLoop({
      goalSummary: {
        totalOpen: 1,
        inProgress: [],
        topPending: [makeGoal({ status: 'pending', priority: 3 })],
        blocked: [],
        stale: [],
        recentlyCompleted: [],
      },
    });
    const output = formatGoalsSummary(loop);
    expect(output).toContain('priority 3');
  });

  it('includes notes for blocked goals', () => {
    const loop = createMockLoop({
      goalSummary: {
        totalOpen: 1,
        inProgress: [],
        topPending: [],
        blocked: [makeGoal({ status: 'blocked', notes: 'Waiting for schema' })],
        stale: [],
        recentlyCompleted: [],
      },
    });
    const output = formatGoalsSummary(loop);
    expect(output).toContain('Notes: Waiting for schema');
  });

  it('shows recently completed goals', () => {
    const loop = createMockLoop({
      recentlyCompleted: [
        makeGoal({ id: 'goal-010', status: 'done', description: 'Update API docs' }),
        makeGoal({ id: 'goal-009', status: 'done', description: 'Fix test flakes' }),
      ],
    });
    const output = formatGoalsSummary(loop);
    expect(output).toContain('Recently completed:');
    expect(output).toContain('Update API docs');
    expect(output).toContain('Fix test flakes');
  });
});

describe('formatIssuesSummary', () => {
  it('shows empty state message when no issues', () => {
    const loop = createMockLoop();
    const output = formatIssuesSummary(loop);
    expect(output).toContain('Issues (0 open)');
    expect(output).toContain('No open issues.');
  });

  it('shows investigating issues first', () => {
    const loop = createMockLoop({
      issueSummary: {
        totalOpen: 2,
        investigating: [makeIssue({ id: 'ISS-005', title: 'TypeError in parser' })],
        openByPriority: [makeIssue({ id: 'ISS-003', status: 'open', title: 'Flaky test' })],
        stale: [],
        recentlyResolved: [],
        mostAttempted: [],
      },
    });
    const output = formatIssuesSummary(loop);

    const investigatingIdx = output.indexOf('TypeError in parser');
    const openIdx = output.indexOf('Flaky test');
    expect(investigatingIdx).toBeLessThan(openIdx);
  });

  it('includes nextIdea for investigating issues', () => {
    const loop = createMockLoop({
      issueSummary: {
        totalOpen: 1,
        investigating: [makeIssue({ nextIdea: 'Try Temporal API' })],
        openByPriority: [],
        stale: [],
        recentlyResolved: [],
        mostAttempted: [],
      },
    });
    const output = formatIssuesSummary(loop);
    expect(output).toContain('Next: Try Temporal API');
  });

  it('shows recently resolved issues', () => {
    const loop = createMockLoop({
      recentlyResolved: [
        makeIssue({ id: 'ISS-004', status: 'resolved', title: 'Missing null check' }),
      ],
    });
    const output = formatIssuesSummary(loop);
    expect(output).toContain('Recently resolved:');
    expect(output).toContain('Missing null check');
  });

  it('truncates long open issue lists', () => {
    const issues = Array.from({ length: 8 }, (_, i) =>
      makeIssue({ id: `ISS-${i + 1}`, status: 'open', title: `Issue ${i + 1}` }),
    );
    const loop = createMockLoop({
      issueSummary: {
        totalOpen: 8,
        investigating: [],
        openByPriority: issues,
        stale: [],
        recentlyResolved: [],
        mostAttempted: [],
      },
    });
    const output = formatIssuesSummary(loop);
    expect(output).toContain('and 3 more');
  });
});

describe('formatHealthReport', () => {
  it('shows all-passing state', () => {
    const loop = createMockLoop();
    const output = formatHealthReport(loop);
    expect(output).toContain('Codebase Health');
    expect(output).toContain('Typecheck:');
    expect(output).toContain('passing');
    expect(output).toContain('Tests:');
    expect(output).toContain('3398 passing, 0 failing');
    expect(output).toContain('Lint:');
    expect(output).toContain('clean');
  });

  it('shows failing state', () => {
    const loop = createMockLoop({
      health: makeHealthSnapshot({
        healthy: false,
        typecheck: { passed: false, errorCount: 3, errors: ['TS2345', 'TS2339', 'TS7006'] },
        tests: { passed: false, total: 3398, passing: 3395, failing: 3, skipped: 0, failingTests: ['auth.test.ts', 'parser.test.ts', 'git.test.ts'] },
        lint: { passed: false, errorCount: 2, warningCount: 5 },
      }),
    });
    const output = formatHealthReport(loop);
    expect(output).toContain('3 errors');
    expect(output).toContain('3395 passing, 3 failing');
    expect(output).toContain('2 errors');
  });

  it('lists failing tests', () => {
    const loop = createMockLoop({
      health: makeHealthSnapshot({
        tests: { passed: false, total: 100, passing: 98, failing: 2, skipped: 0, failingTests: ['auth.test.ts', 'parser.test.ts'] },
      }),
    });
    const output = formatHealthReport(loop);
    expect(output).toContain('Failing tests:');
    expect(output).toContain('auth.test.ts');
    expect(output).toContain('parser.test.ts');
  });

  it('includes branch and commit info', () => {
    const loop = createMockLoop();
    const output = formatHealthReport(loop);
    expect(output).toContain('Branch: main');
    expect(output).toContain('9360d13');
    expect(output).toContain('feat: two-tier tool loading');
  });
});

describe('formatActivityReport', () => {
  it('shows empty state message when no activity', () => {
    const loop = createMockLoop();
    const output = formatActivityReport(loop);
    expect(output).toContain('Recent Activity');
    expect(output).toContain('No recent activity recorded.');
  });

  it('shows world model activity entries with relative timestamps', () => {
    const loop = createMockLoop({
      recentActivity: [
        makeActivity({ timestamp: twoMinAgo, description: 'Committed: fix login' }),
        makeActivity({ timestamp: oneHourAgo, description: 'Filed issue ISS-005' }),
      ],
    });
    const output = formatActivityReport(loop);
    expect(output).toContain('2 min ago');
    expect(output).toContain('Committed: fix login');
    expect(output).toContain('1h ago');
    expect(output).toContain('Filed issue ISS-005');
  });

  it('includes journal handoff entries', () => {
    const loop = createMockLoop({
      journalEntries: [
        makeJournalEntry({ type: 'handoff', content: 'Finished login work' }),
      ],
    });
    const output = formatActivityReport(loop);
    expect(output).toContain('Cycle handoff: Finished login work');
  });

  it('includes journal user_interaction entries', () => {
    const loop = createMockLoop({
      journalEntries: [
        makeJournalEntry({ type: 'user_interaction', content: 'Josiah asked about status' }),
      ],
    });
    const output = formatActivityReport(loop);
    expect(output).toContain('User interaction: Josiah asked about status');
  });

  it('filters out non-handoff/non-interaction journal entries', () => {
    const loop = createMockLoop({
      journalEntries: [
        makeJournalEntry({ type: 'reflection', content: 'The regex is too fragile' }),
        makeJournalEntry({ type: 'opinion', content: 'Should use Temporal API' }),
      ],
    });
    const output = formatActivityReport(loop);
    expect(output).not.toContain('The regex is too fragile');
    expect(output).not.toContain('Should use Temporal API');
  });

  it('merges and sorts entries chronologically', () => {
    const loop = createMockLoop({
      recentActivity: [
        makeActivity({ timestamp: oneHourAgo, description: 'Older activity' }),
      ],
      journalEntries: [
        makeJournalEntry({ timestamp: twoMinAgo, type: 'handoff', content: 'Recent handoff' }),
      ],
    });
    const output = formatActivityReport(loop);
    // Recent handoff should appear before older activity
    const recentIdx = output.indexOf('Recent handoff');
    const olderIdx = output.indexOf('Older activity');
    expect(recentIdx).toBeLessThan(olderIdx);
  });

  it('caps output at 8 entries', () => {
    const activities = Array.from({ length: 10 }, (_, i) =>
      makeActivity({
        timestamp: new Date(Date.now() - i * 60 * 1000).toISOString(),
        description: `Activity ${i + 1}`,
      }),
    );
    const loop = createMockLoop({ recentActivity: activities });
    const output = formatActivityReport(loop);
    // Count lines starting with "-"
    const entryLines = output.split('\n').filter((l) => l.startsWith('-'));
    expect(entryLines.length).toBeLessThanOrEqual(8);
  });

  it('truncates long journal content', () => {
    const loop = createMockLoop({
      journalEntries: [
        makeJournalEntry({
          type: 'handoff',
          content: 'This is a very long journal entry that should be truncated because it exceeds the sixty character limit we have set',
        }),
      ],
    });
    const output = formatActivityReport(loop);
    expect(output).toContain('...');
  });
});
