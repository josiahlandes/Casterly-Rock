import { describe, expect, it, beforeEach } from 'vitest';
import {
  drainEventsToTasks,
  checkGoalStack,
  runIdleCheck,
  describeEvent,
  eventToOrigin,
  goalToTaskDescription,
  DEFAULT_EVENT_CONFIG,
} from '../src/dual-loop/deep-loop-events.js';
import type { DeepLoopEventConfig } from '../src/dual-loop/deep-loop-events.js';
import { createTaskBoard } from '../src/dual-loop/task-board.js';
import type { TaskBoard } from '../src/dual-loop/task-board.js';
import { EventBus } from '../src/autonomous/events.js';
import type { SystemEvent } from '../src/autonomous/events.js';
import { GoalStack } from '../src/autonomous/goal-stack.js';
import { initTracer, resetTracer } from '../src/autonomous/debug.js';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeBoard(): TaskBoard {
  return createTaskBoard({ dbPath: '/tmp/test-events.json' });
}

function makeEventBus(): EventBus {
  return new EventBus({ maxQueueSize: 100, logEvents: false });
}

function makeGoalStack(): GoalStack {
  return new GoalStack();
}

function emitTestFailed(bus: EventBus): void {
  bus.emit({
    type: 'test_failed',
    testName: 'auth.test.ts',
    output: 'Expected true, got false',
    timestamp: new Date().toISOString(),
  });
}

function emitFileChanged(bus: EventBus): void {
  bus.emit({
    type: 'file_changed',
    paths: ['src/auth.ts', 'src/login.ts'],
    changeKind: 'modified',
    timestamp: new Date().toISOString(),
  });
}

function emitUserMessage(bus: EventBus): void {
  bus.emit({
    type: 'user_message',
    sender: 'alice',
    message: 'hello',
    timestamp: new Date().toISOString(),
  });
}

function emitScheduled(bus: EventBus): void {
  bus.emit({
    type: 'scheduled',
    reason: 'Hourly check',
    timestamp: new Date().toISOString(),
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('Deep Loop Events', () => {
  beforeEach(() => {
    resetTracer();
    initTracer({ level: 'error', subsystems: {} });
  });

  // ── describeEvent ────────────────────────────────────────────────────────

  describe('describeEvent', () => {
    it('describes a test_failed event', () => {
      const desc = describeEvent({
        type: 'test_failed',
        testName: 'foo.test.ts',
        output: 'Error',
        timestamp: new Date().toISOString(),
      });
      expect(desc).toContain('Test failure');
      expect(desc).toContain('foo.test.ts');
    });

    it('describes a file_changed event', () => {
      const desc = describeEvent({
        type: 'file_changed',
        paths: ['a.ts', 'b.ts'],
        changeKind: 'modified',
        timestamp: new Date().toISOString(),
      });
      expect(desc).toContain('2 files modified');
    });

    it('truncates long file lists', () => {
      const desc = describeEvent({
        type: 'file_changed',
        paths: ['a.ts', 'b.ts', 'c.ts', 'd.ts'],
        changeKind: 'created',
        timestamp: new Date().toISOString(),
      });
      expect(desc).toContain('...');
    });

    it('describes a build_error event', () => {
      const desc = describeEvent({
        type: 'build_error',
        error: 'Module not found: foo',
        timestamp: new Date().toISOString(),
      });
      expect(desc).toContain('Build error');
      expect(desc).toContain('Module not found');
    });

    it('describes a git_push event', () => {
      const desc = describeEvent({
        type: 'git_push',
        branch: 'main',
        commits: ['abc123'],
        timestamp: new Date().toISOString(),
      });
      expect(desc).toContain('Push to main');
    });
  });

  // ── eventToOrigin ────────────────────────────────────────────────────────

  describe('eventToOrigin', () => {
    it('maps user_message to user', () => {
      expect(eventToOrigin({
        type: 'user_message', sender: 'a', message: 'b', timestamp: '',
      })).toBe('user');
    });

    it('maps scheduled to scheduled', () => {
      expect(eventToOrigin({
        type: 'scheduled', reason: 'test', timestamp: '',
      })).toBe('scheduled');
    });

    it('maps other events to event', () => {
      expect(eventToOrigin({
        type: 'test_failed', testName: 'x', output: '', timestamp: '',
      })).toBe('event');
    });
  });

  // ── drainEventsToTasks ───────────────────────────────────────────────────

  describe('drainEventsToTasks', () => {
    it('returns 0 when no events', () => {
      const bus = makeEventBus();
      const board = makeBoard();
      expect(drainEventsToTasks(bus, board)).toBe(0);
    });

    it('creates tasks for actionable events', () => {
      const bus = makeEventBus();
      const board = makeBoard();

      emitTestFailed(bus);
      emitFileChanged(bus);

      const created = drainEventsToTasks(bus, board);
      expect(created).toBe(2);
      expect(board.getActive().length).toBe(2);
    });

    it('skips user_message and scheduled events', () => {
      const bus = makeEventBus();
      const board = makeBoard();

      emitUserMessage(bus);
      emitScheduled(bus);
      emitTestFailed(bus);

      const created = drainEventsToTasks(bus, board);
      expect(created).toBe(1); // Only the test_failed event
    });

    it('respects maxEventsPerCheck', () => {
      const bus = makeEventBus();
      const board = makeBoard();

      // Emit 10 events
      for (let i = 0; i < 10; i++) {
        emitTestFailed(bus);
      }

      const config: DeepLoopEventConfig = { ...DEFAULT_EVENT_CONFIG, maxEventsPerCheck: 3 };
      const created = drainEventsToTasks(bus, board, config);
      expect(created).toBeLessThanOrEqual(3);
    });

    it('drains the event bus (events are consumed)', () => {
      const bus = makeEventBus();
      const board = makeBoard();

      emitTestFailed(bus);
      drainEventsToTasks(bus, board);

      // Second drain should find nothing
      const second = drainEventsToTasks(bus, board);
      expect(second).toBe(0);
    });

    it('sets event origin and complex classification on created tasks', () => {
      const bus = makeEventBus();
      const board = makeBoard();

      emitTestFailed(bus);
      drainEventsToTasks(bus, board);

      const tasks = board.getActive();
      expect(tasks[0]!.origin).toBe('event');
      expect(tasks[0]!.classification).toBe('complex');
    });
  });

  // ── goalToTaskDescription ────────────────────────────────────────────────

  describe('goalToTaskDescription', () => {
    it('includes goal description', () => {
      const desc = goalToTaskDescription({
        id: 'goal-001',
        source: 'self',
        priority: 2,
        description: 'Refactor auth module',
        created: '',
        updated: '',
        status: 'pending',
        attempts: 0,
        notes: '',
        relatedFiles: [],
        tags: [],
      });
      expect(desc).toContain('Refactor auth module');
    });

    it('includes related files when present', () => {
      const desc = goalToTaskDescription({
        id: 'goal-002',
        source: 'self',
        priority: 1,
        description: 'Fix auth',
        created: '',
        updated: '',
        status: 'pending',
        attempts: 0,
        notes: '',
        relatedFiles: ['src/auth.ts'],
        tags: [],
      });
      expect(desc).toContain('src/auth.ts');
    });

    it('includes tags when present', () => {
      const desc = goalToTaskDescription({
        id: 'goal-003',
        source: 'self',
        priority: 1,
        description: 'Add tests',
        created: '',
        updated: '',
        status: 'pending',
        attempts: 0,
        notes: '',
        relatedFiles: [],
        tags: ['testing', 'quality'],
      });
      expect(desc).toContain('testing');
      expect(desc).toContain('quality');
    });
  });

  // ── checkGoalStack ───────────────────────────────────────────────────────

  describe('checkGoalStack', () => {
    it('returns null when goalStack is null', () => {
      const board = makeBoard();
      expect(checkGoalStack(null, board)).toBeNull();
    });

    it('returns null when no goals available', () => {
      const stack = makeGoalStack();
      const board = makeBoard();
      expect(checkGoalStack(stack, board)).toBeNull();
    });

    it('creates a task from the next goal', () => {
      const stack = makeGoalStack();
      const board = makeBoard();

      stack.addGoal({
        source: 'self',
        priority: 2,
        description: 'Improve test coverage',
        relatedFiles: ['src/auth.ts'],
        tags: ['testing'],
      });

      const taskId = checkGoalStack(stack, board);
      expect(taskId).not.toBeNull();
      expect(taskId).toMatch(/^task-/);

      const task = board.get(taskId!)!;
      expect(task.origin).toBe('goal');
      expect(task.priority).toBe(2); // goalTaskPriority from config
      expect(task.originalMessage).toContain('Improve test coverage');
    });

    it('does not pile up goal tasks', () => {
      const stack = makeGoalStack();
      const board = makeBoard();

      stack.addGoal({
        source: 'self', priority: 2, description: 'Goal A',
        relatedFiles: [], tags: [],
      });
      stack.addGoal({
        source: 'self', priority: 3, description: 'Goal B',
        relatedFiles: [], tags: [],
      });

      // First call creates a task
      const first = checkGoalStack(stack, board);
      expect(first).not.toBeNull();

      // Second call should NOT create another (existing goal task is active)
      const second = checkGoalStack(stack, board);
      expect(second).toBeNull();
    });
  });

  // ── runIdleCheck ─────────────────────────────────────────────────────────

  describe('runIdleCheck', () => {
    it('returns zeros when nothing to do', () => {
      const bus = makeEventBus();
      const board = makeBoard();

      const result = runIdleCheck(bus, null, board);
      expect(result.tasksCreated).toBe(0);
      expect(result.eventsProcessed).toBe(0);
      expect(result.goalStarted).toBe(false);
    });

    it('processes events before goals', () => {
      const bus = makeEventBus();
      const stack = makeGoalStack();
      const board = makeBoard();

      emitTestFailed(bus);
      stack.addGoal({
        source: 'self', priority: 2, description: 'Goal',
        relatedFiles: [], tags: [],
      });

      const result = runIdleCheck(bus, stack, board);
      expect(result.eventsProcessed).toBe(1);
      expect(result.goalStarted).toBe(false); // Events took priority
    });

    it('falls through to goals when no events', () => {
      const bus = makeEventBus();
      const stack = makeGoalStack();
      const board = makeBoard();

      stack.addGoal({
        source: 'self', priority: 2, description: 'Goal',
        relatedFiles: [], tags: [],
      });

      const result = runIdleCheck(bus, stack, board);
      expect(result.eventsProcessed).toBe(0);
      expect(result.goalStarted).toBe(true);
      expect(result.tasksCreated).toBe(1);
    });
  });
});
