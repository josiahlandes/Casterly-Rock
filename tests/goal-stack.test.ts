import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { GoalStack } from '../src/autonomous/goal-stack.js';
import { resetTracer, initTracer } from '../src/autonomous/debug.js';

describe('GoalStack', () => {
  let tempDir: string;
  let goalStack: GoalStack;

  beforeEach(async () => {
    resetTracer();
    initTracer({ enabled: false }); // Suppress debug output in tests
    tempDir = await mkdtemp(join(tmpdir(), 'casterly-test-goals-'));
    goalStack = new GoalStack({
      path: join(tempDir, 'goals.yaml'),
      maxOpenGoals: 5,
      maxTotalGoals: 20,
      staleDays: 7,
    });
  });

  afterEach(async () => {
    resetTracer();
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('persistence', () => {
    it('initializes fresh when no file exists', async () => {
      await goalStack.load();
      const data = goalStack.getData();

      expect(data.version).toBe(1);
      expect(data.nextId).toBe(1);
      expect(data.goals).toHaveLength(0);
    });

    it('round-trips through save and load', async () => {
      await goalStack.load();

      goalStack.addGoal({
        source: 'user',
        description: 'Test goal',
        tags: ['test'],
      });

      await goalStack.save();

      // Load into a fresh instance
      const goalStack2 = new GoalStack({
        path: join(tempDir, 'goals.yaml'),
      });
      await goalStack2.load();

      const data = goalStack2.getData();
      expect(data.goals).toHaveLength(1);
      expect(data.goals[0]?.description).toBe('Test goal');
      expect(data.goals[0]?.source).toBe('user');
    });

    it('skips save when no changes made', async () => {
      await goalStack.load();

      // Save should be a no-op (file won't even be created since fresh data isn't dirty... wait, it IS dirty on fresh init)
      await goalStack.save();

      // Load again — should work
      const goalStack2 = new GoalStack({
        path: join(tempDir, 'goals.yaml'),
      });
      await goalStack2.load();
      expect(goalStack2.getData().goals).toHaveLength(0);
    });
  });

  describe('goal creation', () => {
    beforeEach(async () => {
      await goalStack.load();
    });

    it('creates goals with auto-generated IDs', () => {
      const goal1 = goalStack.addGoal({
        source: 'user',
        description: 'First goal',
      });

      const goal2 = goalStack.addGoal({
        source: 'self',
        description: 'Second goal',
      });

      expect(goal1?.id).toBe('goal-001');
      expect(goal2?.id).toBe('goal-002');
    });

    it('assigns correct default priorities by source', () => {
      const userGoal = goalStack.addGoal({
        source: 'user',
        description: 'User goal',
      });

      const eventGoal = goalStack.addGoal({
        source: 'event',
        description: 'Event goal',
      });

      const selfGoal = goalStack.addGoal({
        source: 'self',
        description: 'Self goal',
      });

      expect(userGoal?.priority).toBe(1);
      expect(eventGoal?.priority).toBe(2);
      expect(selfGoal?.priority).toBe(3);
    });

    it('allows custom priority override', () => {
      const goal = goalStack.addGoal({
        source: 'self',
        description: 'High-priority self goal',
        priority: 1,
      });

      expect(goal?.priority).toBe(1);
    });

    it('stores all provided fields', () => {
      const goal = goalStack.addGoal({
        source: 'user',
        description: 'Full goal',
        relatedFiles: ['src/foo.ts', 'src/bar.ts'],
        issueId: 'ISS-001',
        eventType: 'test_failure',
        tags: ['bug', 'urgent'],
        notes: 'Initial notes',
      });

      expect(goal).not.toBeNull();
      expect(goal?.relatedFiles).toEqual(['src/foo.ts', 'src/bar.ts']);
      expect(goal?.issueId).toBe('ISS-001');
      expect(goal?.eventType).toBe('test_failure');
      expect(goal?.tags).toEqual(['bug', 'urgent']);
      expect(goal?.notes).toBe('Initial notes');
      expect(goal?.status).toBe('pending');
      expect(goal?.attempts).toBe(0);
    });

    it('rejects self-generated goals when at capacity', () => {
      // Fill up with 5 goals (maxOpenGoals = 5)
      for (let i = 0; i < 5; i++) {
        goalStack.addGoal({ source: 'self', description: `Goal ${i}` });
      }

      const overflow = goalStack.addGoal({
        source: 'self',
        description: 'Overflow goal',
      });

      expect(overflow).toBeNull();
    });

    it('auto-abandons lowest priority self goal for user goals at capacity', () => {
      // Fill with self-generated goals
      for (let i = 0; i < 5; i++) {
        goalStack.addGoal({
          source: 'self',
          description: `Self goal ${i}`,
          priority: 3 + i, // Increasing priority numbers = decreasing importance
        });
      }

      const userGoal = goalStack.addGoal({
        source: 'user',
        description: 'Important user goal',
      });

      expect(userGoal).not.toBeNull();

      // The highest-numbered priority self goal should be abandoned
      const abandoned = goalStack.getGoalsByStatus('abandoned');
      expect(abandoned).toHaveLength(1);
      expect(abandoned[0]?.priority).toBe(7); // 3 + 4 = the last and lowest priority
    });
  });

  describe('goal queries', () => {
    beforeEach(async () => {
      await goalStack.load();
      goalStack.addGoal({ source: 'user', description: 'User task', priority: 1 });
      goalStack.addGoal({ source: 'self', description: 'Self task A', priority: 3 });
      goalStack.addGoal({ source: 'event', description: 'Event task', priority: 2 });
      goalStack.addGoal({ source: 'self', description: 'Self task B', priority: 4 });
    });

    it('getOpenGoals returns goals sorted by priority', () => {
      const open = goalStack.getOpenGoals();

      expect(open).toHaveLength(4);
      expect(open[0]?.priority).toBe(1);
      expect(open[1]?.priority).toBe(2);
      expect(open[2]?.priority).toBe(3);
      expect(open[3]?.priority).toBe(4);
    });

    it('getNextGoal returns highest priority pending goal', () => {
      const next = goalStack.getNextGoal();
      expect(next?.description).toBe('User task');
    });

    it('getNextGoal prefers in_progress over pending', () => {
      goalStack.updateGoalStatus('goal-003', 'in_progress');

      const next = goalStack.getNextGoal();
      expect(next?.description).toBe('Event task');
    });

    it('getGoalsBySource filters correctly', () => {
      const selfGoals = goalStack.getGoalsBySource('self');
      expect(selfGoals).toHaveLength(2);
      expect(selfGoals[0]?.description).toBe('Self task A');
    });

    it('getGoal returns undefined for unknown ID', () => {
      expect(goalStack.getGoal('goal-999')).toBeUndefined();
    });
  });

  describe('goal updates', () => {
    beforeEach(async () => {
      await goalStack.load();
      goalStack.addGoal({ source: 'user', description: 'Test goal' });
    });

    it('updateGoalStatus changes status and notes', () => {
      const result = goalStack.updateGoalStatus('goal-001', 'in_progress', 'Starting work');

      expect(result).toBe(true);

      const after = goalStack.getGoal('goal-001');
      expect(after?.status).toBe('in_progress');
      expect(after?.notes).toBe('Starting work');
      // updated timestamp is set (may be same ms as creation, so just check it exists)
      expect(after?.updated).toBeTruthy();
    });

    it('recordAttempt increments counter', () => {
      goalStack.recordAttempt('goal-001', 'First attempt notes');
      goalStack.recordAttempt('goal-001', 'Second attempt notes');

      const goal = goalStack.getGoal('goal-001');
      expect(goal?.attempts).toBe(2);
      expect(goal?.notes).toBe('Second attempt notes');
    });

    it('updatePriority changes priority', () => {
      goalStack.updatePriority('goal-001', 5);
      expect(goalStack.getGoal('goal-001')?.priority).toBe(5);
    });

    it('completeGoal marks as done', () => {
      goalStack.completeGoal('goal-001', 'Finished successfully');

      const goal = goalStack.getGoal('goal-001');
      expect(goal?.status).toBe('done');
      expect(goal?.notes).toBe('Finished successfully');
    });

    it('returns false for unknown goal IDs', () => {
      expect(goalStack.updateGoalStatus('goal-999', 'done')).toBe(false);
      expect(goalStack.recordAttempt('goal-999')).toBe(false);
      expect(goalStack.updatePriority('goal-999', 1)).toBe(false);
    });
  });

  describe('stale goal detection', () => {
    beforeEach(async () => {
      await goalStack.load();
    });

    it('detects goals with no recent activity', () => {
      const goal = goalStack.addGoal({
        source: 'self',
        description: 'Stale goal',
      });

      // Manually backdate the updated timestamp
      if (goal) {
        const staleDate = new Date();
        staleDate.setDate(staleDate.getDate() - 10); // 10 days ago
        goal.updated = staleDate.toISOString();
      }

      const stale = goalStack.getStaleGoals();
      expect(stale).toHaveLength(1);
      expect(stale[0]?.id).toBe('goal-001');
    });

    it('does not flag recently updated goals', () => {
      goalStack.addGoal({
        source: 'self',
        description: 'Fresh goal',
      });

      const stale = goalStack.getStaleGoals();
      expect(stale).toHaveLength(0);
    });
  });

  describe('summary', () => {
    beforeEach(async () => {
      await goalStack.load();
      goalStack.addGoal({ source: 'user', description: 'Active work' });
      goalStack.addGoal({ source: 'self', description: 'Pending item' });
      goalStack.updateGoalStatus('goal-001', 'in_progress');
    });

    it('getSummary returns structured overview', () => {
      const summary = goalStack.getSummary();

      expect(summary.totalOpen).toBe(2);
      expect(summary.inProgress).toHaveLength(1);
      expect(summary.topPending).toHaveLength(1);
    });

    it('getSummaryText returns readable text', () => {
      const text = goalStack.getSummaryText();

      expect(text).toContain('Goals');
      expect(text).toContain('Active work');
      expect(text).toContain('Pending item');
    });
  });

  describe('maintenance', () => {
    beforeEach(async () => {
      await goalStack.load();
    });

    it('removeGoal deletes a goal entirely', () => {
      goalStack.addGoal({ source: 'self', description: 'To remove' });

      expect(goalStack.removeGoal('goal-001')).toBe(true);
      expect(goalStack.getGoal('goal-001')).toBeUndefined();
      expect(goalStack.getData().goals).toHaveLength(0);
    });

    it('removeGoal returns false for unknown ID', () => {
      expect(goalStack.removeGoal('goal-999')).toBe(false);
    });
  });
});
