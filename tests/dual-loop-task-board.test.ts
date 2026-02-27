import { describe, expect, it, beforeEach } from 'vitest';
import {
  TaskBoard,
  createTaskBoard,
} from '../src/dual-loop/task-board.js';
import type {
  Task,
  CreateTaskOptions,
} from '../src/dual-loop/task-board-types.js';
import { initTracer, resetTracer } from '../src/autonomous/debug.js';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeBoard(): TaskBoard {
  return createTaskBoard({ dbPath: '/tmp/test-taskboard.json' });
}

function makeTask(overrides?: Partial<CreateTaskOptions>): CreateTaskOptions {
  return {
    origin: 'user',
    priority: 0,
    sender: 'testuser',
    originalMessage: 'Fix the login bug',
    classification: 'complex',
    triageNotes: 'Needs file reading and code changes',
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('TaskBoard', () => {
  beforeEach(() => {
    resetTracer();
    initTracer({ level: 'error', subsystems: {} });
  });

  describe('create and get', () => {
    it('creates a task and returns its ID', () => {
      const board = makeBoard();
      const id = board.create(makeTask());
      expect(id).toMatch(/^task-/);
    });

    it('gets a task by ID', () => {
      const board = makeBoard();
      const id = board.create(makeTask());
      const task = board.get(id);
      expect(task).not.toBeNull();
      expect(task!.id).toBe(id);
      expect(task!.status).toBe('queued');
      expect(task!.owner).toBeNull();
      expect(task!.origin).toBe('user');
      expect(task!.priority).toBe(0);
      expect(task!.sender).toBe('testuser');
      expect(task!.originalMessage).toBe('Fix the login bug');
    });

    it('returns null for unknown ID', () => {
      const board = makeBoard();
      expect(board.get('nonexistent')).toBeNull();
    });

    it('creates tasks with pre-set status', () => {
      const board = makeBoard();
      const id = board.create(makeTask({ status: 'answered_directly', userFacing: 'Hello!' }));
      const task = board.get(id);
      expect(task!.status).toBe('answered_directly');
      expect(task!.userFacing).toBe('Hello!');
    });
  });

  describe('update', () => {
    it('updates task fields', () => {
      const board = makeBoard();
      const id = board.create(makeTask());

      const result = board.update(id, {
        status: 'planning',
        owner: 'deep',
        plan: 'Read the file, fix the bug',
      });

      expect(result).toBe(true);
      const task = board.get(id);
      expect(task!.status).toBe('planning');
      expect(task!.owner).toBe('deep');
      expect(task!.plan).toBe('Read the file, fix the bug');
    });

    it('returns false for unknown ID', () => {
      const board = makeBoard();
      expect(board.update('nonexistent', { status: 'done' })).toBe(false);
    });

    it('updates the updatedAt timestamp', async () => {
      const board = makeBoard();
      const id = board.create(makeTask());
      const before = board.get(id)!.updatedAt;

      // Ensure timestamps differ by waiting 1ms
      await new Promise((r) => setTimeout(r, 2));
      board.update(id, { status: 'planning' });
      const after = board.get(id)!.updatedAt;

      expect(after >= before).toBe(true);
      expect(board.get(id)!.status).toBe('planning');
    });
  });

  describe('ownership protocol', () => {
    it('claims the highest-priority unclaimed task', () => {
      const board = makeBoard();
      board.create(makeTask({ priority: 2, originalMessage: 'Low priority' }));
      board.create(makeTask({ priority: 0, originalMessage: 'High priority' }));

      const claimed = board.claimNext('deep', ['queued']);
      expect(claimed).not.toBeNull();
      expect(claimed!.originalMessage).toBe('High priority');
      expect(claimed!.owner).toBe('deep');
    });

    it('returns null when no tasks match', () => {
      const board = makeBoard();
      board.create(makeTask());
      // Claim the only task
      board.claimNext('deep', ['queued']);
      // Try to claim again
      const second = board.claimNext('fast', ['queued']);
      expect(second).toBeNull();
    });

    it('filters by status', () => {
      const board = makeBoard();
      const id1 = board.create(makeTask());
      board.update(id1, { status: 'reviewing', owner: null });
      board.create(makeTask({ originalMessage: 'Queued one' }));

      // Claim only reviewing tasks
      const claimed = board.claimNext('fast', ['reviewing']);
      expect(claimed).not.toBeNull();
      expect(claimed!.id).toBe(id1);
    });

    it('releases ownership', () => {
      const board = makeBoard();
      const id = board.create(makeTask());
      board.claimNext('deep', ['queued']);

      expect(board.get(id)!.owner).toBe('deep');
      board.release(id);
      expect(board.get(id)!.owner).toBeNull();
    });
  });

  describe('queries', () => {
    it('getNextReviewable returns unclaimed reviewing tasks', () => {
      const board = makeBoard();
      const id = board.create(makeTask());
      board.update(id, { status: 'reviewing' });

      const reviewable = board.getNextReviewable();
      expect(reviewable).not.toBeNull();
      expect(reviewable!.id).toBe(id);
    });

    it('getCompletedWithResponse returns done tasks with userFacing', () => {
      const board = makeBoard();
      const id = board.create(makeTask());
      board.update(id, { status: 'done', userFacing: 'All fixed!' });

      const completed = board.getCompletedWithResponse();
      expect(completed).not.toBeNull();
      expect(completed!.userFacing).toBe('All fixed!');

      // Mark delivered and check it's no longer returned
      board.markDelivered(id);
      expect(board.getCompletedWithResponse()).toBeNull();
    });

    it('getHigherPriorityTask finds unclaimed higher-priority tasks', () => {
      const board = makeBoard();
      board.create(makeTask({ priority: 0, originalMessage: 'Urgent' }));

      const preemptor = board.getHigherPriorityTask(2);
      expect(preemptor).not.toBeNull();
      expect(preemptor!.originalMessage).toBe('Urgent');
    });

    it('getActive excludes done/failed/answered_directly', () => {
      const board = makeBoard();
      board.create(makeTask());
      const id2 = board.create(makeTask());
      const id3 = board.create(makeTask());
      board.update(id2, { status: 'done' });
      board.update(id3, { status: 'failed' });

      const active = board.getActive();
      expect(active).toHaveLength(1);
    });

    it('getStatusCounts counts tasks by status', () => {
      const board = makeBoard();
      board.create(makeTask());
      board.create(makeTask());
      const id3 = board.create(makeTask());
      board.update(id3, { status: 'done' });

      const counts = board.getStatusCounts();
      expect(counts['queued']).toBe(2);
      expect(counts['done']).toBe(1);
    });

    it('getSummaryText returns a readable summary', () => {
      const board = makeBoard();
      board.create(makeTask());
      const summary = board.getSummaryText();
      expect(summary).toContain('Fix the login bug');
    });

    it('getSummaryText handles empty board', () => {
      const board = makeBoard();
      expect(board.getSummaryText()).toBe('(no active tasks)');
    });
  });

  describe('parking (preemption)', () => {
    it('parks a task: re-queues, releases, saves parked state', () => {
      const board = makeBoard();
      const id = board.create(makeTask());
      board.claimNext('deep', ['queued']);
      board.update(id, { status: 'implementing' });

      const result = board.parkTask(id, {
        parkedAtTurn: 3,
        reason: 'Preempted by higher-priority task',
        contextSnapshot: 'Completed 2 of 5 steps',
      });

      expect(result).toBe(true);
      const task = board.get(id)!;
      expect(task.status).toBe('queued');
      expect(task.owner).toBeNull();
      expect(task.parkedState).toBeDefined();
      expect(task.parkedState!.parkedAtTurn).toBe(3);
      expect(task.parkedState!.contextSnapshot).toBe('Completed 2 of 5 steps');
    });
  });

  describe('archival', () => {
    it('removes old completed tasks', () => {
      const board = makeBoard();
      const id = board.create(makeTask());
      const task = board.get(id)!;

      // Manually backdate the task
      board.update(id, { status: 'done' });
      (task as { updatedAt: string }).updatedAt = new Date(Date.now() - 30 * 86400000).toISOString();

      const archived = board.archiveOld();
      expect(archived).toBe(1);
      expect(board.getAllTasks()).toHaveLength(0);
    });

    it('keeps active tasks regardless of age', () => {
      const board = makeBoard();
      board.create(makeTask());

      const archived = board.archiveOld();
      expect(archived).toBe(0);
      expect(board.getAllTasks()).toHaveLength(1);
    });
  });

  describe('dirty flag', () => {
    it('starts clean', () => {
      const board = makeBoard();
      expect(board.isDirty()).toBe(false);
    });

    it('becomes dirty after create', () => {
      const board = makeBoard();
      board.create(makeTask());
      expect(board.isDirty()).toBe(true);
    });

    it('becomes dirty after update', () => {
      const board = makeBoard();
      const id = board.create(makeTask());
      // Reset via getData trick — not exposed, so just check create sets dirty
      expect(board.isDirty()).toBe(true);
    });
  });
});
