import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

import { resetTracer, initTracer } from '../src/autonomous/debug.js';

// ─────────────────────────────────────────────────────────────────────────────
// Mock the modules that require file I/O
// ─────────────────────────────────────────────────────────────────────────────

const mockWorldModelLoad = vi.fn().mockResolvedValue(undefined);
const mockIsHealthy = vi.fn().mockReturnValue(true);
const mockGetConcerns = vi.fn().mockReturnValue([]);
const mockGetRecentActivity = vi.fn().mockReturnValue([]);
const mockGetData = vi.fn().mockReturnValue({
  lastFullUpdate: '2026-02-17T10:00:00.000Z',
});
const mockGetStats = vi.fn().mockReturnValue({
  branchName: 'main',
  totalFiles: 42,
  totalLines: 5000,
  lastCommitHash: 'abc1234567890',
  lastCommitMessage: 'Fix tests',
});

const mockGoalStackLoad = vi.fn().mockResolvedValue(undefined);
const mockGetGoalSummary = vi.fn().mockReturnValue({
  totalOpen: 3,
  inProgress: [{ id: 'goal-001', description: 'Refactor tools' }],
  topPending: [{ id: 'goal-002', description: 'Add tests' }],
  blocked: [],
  stale: [],
  recentlyCompleted: [],
});

const mockIssueLogLoad = vi.fn().mockResolvedValue(undefined);
const mockGetIssueSummary = vi.fn().mockReturnValue({
  totalOpen: 2,
  investigating: [{ id: 'ISS-001', title: 'Flaky test' }],
  openByPriority: [{ id: 'ISS-002', title: 'Type error' }],
  stale: [],
  recentlyResolved: [],
  mostAttempted: [],
});

const mockJournalLoad = vi.fn().mockResolvedValue(undefined);
const mockGetRecent = vi.fn().mockImplementation((n: number) => {
  if (n === 1) {
    return [{
      id: 'j-1',
      timestamp: '2026-02-17T09:00:00.000Z',
      type: 'observation',
      content: 'Tests are passing',
      tags: ['tests'],
    }];
  }
  return [
    {
      id: 'j-1',
      timestamp: '2026-02-17T09:00:00.000Z',
      type: 'observation',
      content: 'Tests are passing',
      tags: ['tests'],
    },
    {
      id: 'j-2',
      timestamp: '2026-02-17T08:00:00.000Z',
      type: 'handoff',
      content: 'Signing off after refactor session',
      tags: ['handoff'],
      cycleId: 'cycle-42',
    },
  ];
});
const mockGetHandoffNote = vi.fn().mockReturnValue({
  id: 'j-2',
  timestamp: '2026-02-17T08:00:00.000Z',
  type: 'handoff',
  content: 'Signing off after refactor session',
  tags: ['handoff'],
});

vi.mock('../src/autonomous/world-model.js', () => {
  return {
    WorldModel: class MockWorldModel {
      load = mockWorldModelLoad;
      isHealthy = mockIsHealthy;
      getConcerns = mockGetConcerns;
      getRecentActivity = mockGetRecentActivity;
      getData = mockGetData;
      getStats = mockGetStats;
    },
  };
});

vi.mock('../src/autonomous/goal-stack.js', () => {
  return {
    GoalStack: class MockGoalStack {
      load = mockGoalStackLoad;
      getSummary = mockGetGoalSummary;
    },
  };
});

vi.mock('../src/autonomous/issue-log.js', () => {
  return {
    IssueLog: class MockIssueLog {
      load = mockIssueLogLoad;
      getSummary = mockGetIssueSummary;
    },
  };
});

vi.mock('../src/autonomous/journal.js', () => {
  return {
    Journal: class MockJournal {
      load = mockJournalLoad;
      getRecent = mockGetRecent;
      getHandoffNote = mockGetHandoffNote;
    },
  };
});

// Import after mocking
import {
  takeStateSnapshot,
  computeStateDiff,
  formatStateDiff,
  inspectState,
  inspectJournal,
} from '../src/debug/inspector.js';
import type { StateSnapshot, StateDiff } from '../src/debug/inspector.js';

// ─────────────────────────────────────────────────────────────────────────────
// Test Setup
// ─────────────────────────────────────────────────────────────────────────────

beforeEach(() => {
  resetTracer();
  initTracer({ enabled: false });
  vi.clearAllMocks();
});

afterEach(() => {
  resetTracer();
});

// ═══════════════════════════════════════════════════════════════════════════════
// takeStateSnapshot()
// ═══════════════════════════════════════════════════════════════════════════════

describe('takeStateSnapshot()', () => {
  it('returns a valid snapshot structure', async () => {
    const snapshot = await takeStateSnapshot('/tmp/test-project');

    // Verify all sections exist
    expect(snapshot).toHaveProperty('worldModel');
    expect(snapshot).toHaveProperty('goalStack');
    expect(snapshot).toHaveProperty('issueLog');
    expect(snapshot).toHaveProperty('journal');

    // Verify worldModel section
    expect(snapshot.worldModel.healthy).toBe(true);
    expect(snapshot.worldModel.concernCount).toBe(0);
    expect(snapshot.worldModel.activityCount).toBe(0);
    expect(snapshot.worldModel.lastFullUpdate).toBe('2026-02-17T10:00:00.000Z');
    expect(snapshot.worldModel.branch).toBe('main');

    // Verify goalStack section
    expect(snapshot.goalStack.inProgress).toBe(1);
    expect(snapshot.goalStack.pending).toBe(1);
    expect(snapshot.goalStack.blocked).toBe(0);
    expect(snapshot.goalStack.total).toBe(2);

    // Verify issueLog section
    expect(snapshot.issueLog.open).toBe(1);
    expect(snapshot.issueLog.investigating).toBe(1);
    expect(snapshot.issueLog.resolved).toBe(0);
    expect(snapshot.issueLog.total).toBe(2);

    // Verify journal section
    expect(snapshot.journal.lastEntry).toBe('2026-02-17T09:00:00.000Z');
    expect(snapshot.journal.lastHandoff).toBe('2026-02-17T08:00:00.000Z');
  });

  it('calls load on all state modules', async () => {
    await takeStateSnapshot();

    expect(mockWorldModelLoad).toHaveBeenCalledTimes(1);
    expect(mockGoalStackLoad).toHaveBeenCalledTimes(1);
    expect(mockIssueLogLoad).toHaveBeenCalledTimes(1);
    expect(mockJournalLoad).toHaveBeenCalledTimes(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// computeStateDiff()
// ═══════════════════════════════════════════════════════════════════════════════

describe('computeStateDiff()', () => {
  it('detects changes between snapshots', () => {
    const before: StateSnapshot = {
      worldModel: {
        healthy: true,
        concernCount: 0,
        activityCount: 5,
        lastFullUpdate: '2026-02-17T10:00:00.000Z',
        branch: 'main',
      },
      goalStack: { inProgress: 1, pending: 2, blocked: 0, total: 3 },
      issueLog: { open: 1, investigating: 0, resolved: 0, total: 1 },
      journal: { totalEntries: 5, lastEntry: null, lastHandoff: null },
    };

    const after: StateSnapshot = {
      worldModel: {
        healthy: false,  // Changed
        concernCount: 2, // Changed
        activityCount: 5,
        lastFullUpdate: '2026-02-17T12:00:00.000Z',
        branch: 'main',
      },
      goalStack: { inProgress: 0, pending: 3, blocked: 0, total: 3 }, // inProgress changed
      issueLog: { open: 3, investigating: 1, resolved: 0, total: 4 }, // open and investigating changed
      journal: { totalEntries: 8, lastEntry: null, lastHandoff: null }, // totalEntries changed
    };

    const diffs = computeStateDiff(before, after);

    expect(diffs.length).toBeGreaterThan(0);

    // Check specific diffs
    const healthyDiff = diffs.find((d) => d.field === 'worldModel.healthy');
    expect(healthyDiff).toBeDefined();
    expect(healthyDiff!.before).toBe(true);
    expect(healthyDiff!.after).toBe(false);

    const concernDiff = diffs.find((d) => d.field === 'worldModel.concernCount');
    expect(concernDiff).toBeDefined();
    expect(concernDiff!.before).toBe(0);
    expect(concernDiff!.after).toBe(2);

    const inProgressDiff = diffs.find((d) => d.field === 'goalStack.inProgress');
    expect(inProgressDiff).toBeDefined();
    expect(inProgressDiff!.before).toBe(1);
    expect(inProgressDiff!.after).toBe(0);

    const openDiff = diffs.find((d) => d.field === 'issueLog.open');
    expect(openDiff).toBeDefined();

    const journalDiff = diffs.find((d) => d.field === 'journal.totalEntries');
    expect(journalDiff).toBeDefined();
    expect(journalDiff!.before).toBe(5);
    expect(journalDiff!.after).toBe(8);
  });

  it('returns empty array when snapshots are identical', () => {
    const snapshot: StateSnapshot = {
      worldModel: {
        healthy: true,
        concernCount: 0,
        activityCount: 3,
        lastFullUpdate: '2026-02-17T10:00:00.000Z',
        branch: 'main',
      },
      goalStack: { inProgress: 0, pending: 1, blocked: 0, total: 1 },
      issueLog: { open: 0, investigating: 0, resolved: 0, total: 0 },
      journal: { totalEntries: 2, lastEntry: null, lastHandoff: null },
    };

    const diffs = computeStateDiff(snapshot, snapshot);
    expect(diffs).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// formatStateDiff()
// ═══════════════════════════════════════════════════════════════════════════════

describe('formatStateDiff()', () => {
  it('formats diffs for display', () => {
    const diffs: StateDiff[] = [
      { field: 'worldModel.healthy', before: true, after: false },
      { field: 'goalStack.inProgress', before: 1, after: 2 },
    ];

    const formatted = formatStateDiff(diffs);

    expect(formatted).toContain('worldModel.healthy');
    expect(formatted).toContain('true');
    expect(formatted).toContain('false');
    expect(formatted).toContain('goalStack.inProgress');
    expect(formatted).toContain('1');
    expect(formatted).toContain('2');
  });

  it('returns "(no state changes)" for empty diff array', () => {
    const formatted = formatStateDiff([]);
    expect(formatted).toBe('(no state changes)');
  });

  it('uses arrow notation between before and after values', () => {
    const diffs: StateDiff[] = [
      { field: 'issueLog.open', before: 0, after: 3 },
    ];

    const formatted = formatStateDiff(diffs);
    // The format is: "  field: before → after"
    expect(formatted).toMatch(/issueLog\.open.*0.*3/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// inspectState()
// ═══════════════════════════════════════════════════════════════════════════════

describe('inspectState()', () => {
  it('returns formatted state output', async () => {
    const output = await inspectState({ projectRoot: '/tmp/test' });

    expect(output).toContain('Tyrion State Inspector');
    expect(output).toContain('World Model');
    expect(output).toContain('Healthy: YES');
    expect(output).toContain('Concerns: 0');
    expect(output).toContain('Branch: main');
    expect(output).toContain('Goal Stack');
    expect(output).toContain('In progress: 1');
    expect(output).toContain('Pending: 1');
    expect(output).toContain('Issue Log');
    expect(output).toContain('Journal');
  });

  it('includes all sections in the output', async () => {
    const output = await inspectState();

    expect(output).toContain('## World Model');
    expect(output).toContain('## Goal Stack');
    expect(output).toContain('## Issue Log');
    expect(output).toContain('## Journal');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// inspectJournal()
// ═══════════════════════════════════════════════════════════════════════════════

describe('inspectJournal()', () => {
  it('returns formatted journal output', async () => {
    const output = await inspectJournal({ last: 10 });

    expect(output).toContain('Journal');
    expect(output).toContain('[observation]');
    expect(output).toContain('Tests are passing');
    expect(output).toContain('[handoff]');
    expect(output).toContain('Signing off after refactor session');
  });

  it('includes tags when present', async () => {
    const output = await inspectJournal({ last: 10 });

    expect(output).toContain('Tags:');
  });

  it('includes cycle ID when present', async () => {
    const output = await inspectJournal({ last: 10 });

    expect(output).toContain('Cycle: cycle-42');
  });

  it('returns "No journal entries found." when journal is empty', async () => {
    // Override getRecent to return empty
    mockGetRecent.mockReturnValueOnce([]);

    const output = await inspectJournal();

    expect(output).toBe('No journal entries found.');
  });

  it('uses default limit of 10 when not specified', async () => {
    await inspectJournal();

    // getRecent should have been called with 10 (the default)
    expect(mockGetRecent).toHaveBeenCalledWith(10);
  });

  it('uses custom limit when specified', async () => {
    await inspectJournal({ last: 5 });

    expect(mockGetRecent).toHaveBeenCalledWith(5);
  });
});
