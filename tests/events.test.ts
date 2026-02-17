import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

import {
  EventBus,
  getEventPriority,
  compareEventPriority,
} from '../src/autonomous/events.js';
import type {
  SystemEvent,
  FileChangedEvent,
  TestFailedEvent,
  UserMessageEvent,
  ScheduledEvent,
} from '../src/autonomous/events.js';
import { resetTracer, initTracer } from '../src/autonomous/debug.js';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const now = () => new Date().toISOString();

function makeFileEvent(paths: string[] = ['src/test.ts']): FileChangedEvent {
  return { type: 'file_changed', paths, changeKind: 'modified', timestamp: now() };
}

function makeTestFailedEvent(testName: string = 'detector.test.ts'): TestFailedEvent {
  return { type: 'test_failed', testName, output: 'FAIL', timestamp: now() };
}

function makeUserEvent(message: string = 'hello'): UserMessageEvent {
  return { type: 'user_message', sender: 'Josiah', message, timestamp: now() };
}

function makeScheduledEvent(): ScheduledEvent {
  return { type: 'scheduled', reason: 'timer', timestamp: now() };
}

// ─────────────────────────────────────────────────────────────────────────────
// Setup
// ─────────────────────────────────────────────────────────────────────────────

let bus: EventBus;

beforeEach(() => {
  resetTracer();
  initTracer({ enabled: false });
  bus = new EventBus({ maxQueueSize: 10, logEvents: false });
});

afterEach(() => {
  bus.reset();
  resetTracer();
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('EventBus — Priority', () => {
  it('user_message has highest priority (0)', () => {
    expect(getEventPriority(makeUserEvent())).toBe(0);
  });

  it('test_failed has priority 1', () => {
    expect(getEventPriority(makeTestFailedEvent())).toBe(1);
  });

  it('file_changed has priority 3', () => {
    expect(getEventPriority(makeFileEvent())).toBe(3);
  });

  it('scheduled has lowest priority (6)', () => {
    expect(getEventPriority(makeScheduledEvent())).toBe(6);
  });

  it('compareEventPriority sorts highest priority first', () => {
    const events: SystemEvent[] = [
      makeScheduledEvent(),
      makeFileEvent(),
      makeUserEvent(),
      makeTestFailedEvent(),
    ];

    events.sort(compareEventPriority);

    expect(events[0]!.type).toBe('user_message');
    expect(events[1]!.type).toBe('test_failed');
    expect(events[2]!.type).toBe('file_changed');
    expect(events[3]!.type).toBe('scheduled');
  });
});

describe('EventBus — Emit and Queue', () => {
  it('adds events to the queue', () => {
    bus.emit(makeFileEvent());
    expect(bus.getQueueSize()).toBe(1);
  });

  it('returns events sorted by priority from getQueue()', () => {
    bus.emit(makeScheduledEvent());
    bus.emit(makeUserEvent());
    bus.emit(makeFileEvent());

    const queue = bus.getQueue();
    expect(queue[0]!.type).toBe('user_message');
    expect(queue[1]!.type).toBe('file_changed');
    expect(queue[2]!.type).toBe('scheduled');
  });

  it('drain() returns sorted events and clears the queue', () => {
    bus.emit(makeScheduledEvent());
    bus.emit(makeUserEvent());

    const events = bus.drain();
    expect(events).toHaveLength(2);
    expect(events[0]!.type).toBe('user_message');
    expect(events[1]!.type).toBe('scheduled');
    expect(bus.getQueueSize()).toBe(0);
  });

  it('peek() returns highest-priority event without removing', () => {
    bus.emit(makeScheduledEvent());
    bus.emit(makeTestFailedEvent());

    const top = bus.peek();
    expect(top?.type).toBe('test_failed');
    expect(bus.getQueueSize()).toBe(2); // not removed
  });

  it('peek() returns undefined when queue is empty', () => {
    expect(bus.peek()).toBeUndefined();
  });

  it('hasEventsOfType() checks correctly', () => {
    bus.emit(makeFileEvent());
    expect(bus.hasEventsOfType('file_changed')).toBe(true);
    expect(bus.hasEventsOfType('user_message')).toBe(false);
  });
});

describe('EventBus — Handlers', () => {
  it('notifies type-specific handlers', () => {
    const received: SystemEvent[] = [];
    bus.on('file_changed', (e) => received.push(e));

    bus.emit(makeFileEvent());
    bus.emit(makeUserEvent()); // different type, should not be received

    expect(received).toHaveLength(1);
    expect(received[0]!.type).toBe('file_changed');
  });

  it('notifies wildcard handlers for all events', () => {
    const received: SystemEvent[] = [];
    bus.onAny((e) => received.push(e));

    bus.emit(makeFileEvent());
    bus.emit(makeUserEvent());

    expect(received).toHaveLength(2);
  });

  it('off() removes a specific handler', () => {
    const received: SystemEvent[] = [];
    const handler = (e: SystemEvent) => received.push(e);

    bus.on('file_changed', handler as any);
    bus.emit(makeFileEvent());
    expect(received).toHaveLength(1);

    bus.off('file_changed', handler as any);
    bus.emit(makeFileEvent());
    expect(received).toHaveLength(1); // not called again
  });

  it('offAny() removes a wildcard handler', () => {
    const received: SystemEvent[] = [];
    const handler = (e: SystemEvent) => received.push(e);

    bus.onAny(handler);
    bus.emit(makeFileEvent());
    expect(received).toHaveLength(1);

    bus.offAny(handler);
    bus.emit(makeFileEvent());
    expect(received).toHaveLength(1); // not called again
  });

  it('handler errors do not crash the bus', () => {
    bus.on('file_changed', () => { throw new Error('handler explosion'); });

    // Should not throw
    expect(() => bus.emit(makeFileEvent())).not.toThrow();
    expect(bus.getQueueSize()).toBe(1);
  });
});

describe('EventBus — Pause/Resume', () => {
  it('drops events when paused', () => {
    bus.pause();
    bus.emit(makeFileEvent());
    expect(bus.getQueueSize()).toBe(0);
  });

  it('accepts events after resume', () => {
    bus.pause();
    bus.emit(makeFileEvent());
    bus.resume();
    bus.emit(makeFileEvent());

    expect(bus.getQueueSize()).toBe(1);
  });

  it('isPaused() reports correctly', () => {
    expect(bus.isPaused()).toBe(false);
    bus.pause();
    expect(bus.isPaused()).toBe(true);
    bus.resume();
    expect(bus.isPaused()).toBe(false);
  });
});

describe('EventBus — Queue Limits', () => {
  it('trims queue when exceeding maxQueueSize', () => {
    // maxQueueSize is 10
    for (let i = 0; i < 15; i++) {
      bus.emit(makeScheduledEvent());
    }

    expect(bus.getQueueSize()).toBeLessThanOrEqual(10);
  });

  it('keeps high-priority events when trimming', () => {
    // Fill with low-priority events
    for (let i = 0; i < 9; i++) {
      bus.emit(makeScheduledEvent());
    }

    // Add a high-priority event
    bus.emit(makeUserEvent());

    // Overfill to trigger trim
    bus.emit(makeScheduledEvent());

    const queue = bus.getQueue();
    const hasUser = queue.some((e) => e.type === 'user_message');
    expect(hasUser).toBe(true);
  });
});

describe('EventBus — Reset', () => {
  it('clears queue and handlers', () => {
    const received: SystemEvent[] = [];
    bus.onAny((e) => received.push(e));
    bus.emit(makeFileEvent());

    bus.reset();

    expect(bus.getQueueSize()).toBe(0);
    expect(bus.isPaused()).toBe(false);

    // Handler should be removed
    bus.emit(makeFileEvent());
    expect(received).toHaveLength(1); // from before reset
  });

  it('removeAllHandlers() keeps queue but clears handlers', () => {
    const received: SystemEvent[] = [];
    bus.onAny((e) => received.push(e));

    bus.emit(makeFileEvent());
    expect(bus.getQueueSize()).toBe(1);

    bus.removeAllHandlers();

    bus.emit(makeFileEvent());
    // Handler removed, but event still queued
    expect(bus.getQueueSize()).toBe(2);
    expect(received).toHaveLength(1); // only from before removal
  });
});
