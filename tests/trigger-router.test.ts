import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import {
  triggerFromMessage,
  triggerFromSchedule,
  triggerFromGoal,
  triggerFromEvent,
  getTriggerPriority,
} from '../src/autonomous/trigger-router.js';
import type { AgentTrigger } from '../src/autonomous/agent-loop.js';
import type { Goal } from '../src/autonomous/goal-stack.js';
import type { SystemEvent } from '../src/autonomous/events.js';
import { resetTracer, initTracer } from '../src/autonomous/debug.js';

// ─────────────────────────────────────────────────────────────────────────────
// Test Setup
// ─────────────────────────────────────────────────────────────────────────────

beforeEach(() => {
  resetTracer();
  initTracer({ enabled: false });
});

afterEach(() => {
  resetTracer();
});

// ═══════════════════════════════════════════════════════════════════════════════
// triggerFromMessage()
// ═══════════════════════════════════════════════════════════════════════════════

describe('triggerFromMessage()', () => {
  it('creates a user trigger with message and sender', () => {
    const trigger = triggerFromMessage('Please refactor the provider', 'Josiah');

    expect(trigger.type).toBe('user');
    expect(trigger).toHaveProperty('message', 'Please refactor the provider');
    expect(trigger).toHaveProperty('sender', 'Josiah');
  });

  it('preserves empty messages', () => {
    const trigger = triggerFromMessage('', 'User');
    expect(trigger.type).toBe('user');
    expect(trigger).toHaveProperty('message', '');
  });

  it('preserves long messages', () => {
    const longMessage = 'A'.repeat(5000);
    const trigger = triggerFromMessage(longMessage, 'User');
    expect(trigger).toHaveProperty('message', longMessage);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// triggerFromSchedule()
// ═══════════════════════════════════════════════════════════════════════════════

describe('triggerFromSchedule()', () => {
  it('creates a scheduled trigger', () => {
    const trigger = triggerFromSchedule();

    expect(trigger.type).toBe('scheduled');
  });

  it('does not include event, message, or goal fields', () => {
    const trigger = triggerFromSchedule();

    expect(trigger).not.toHaveProperty('event');
    expect(trigger).not.toHaveProperty('message');
    expect(trigger).not.toHaveProperty('goal');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// triggerFromGoal()
// ═══════════════════════════════════════════════════════════════════════════════

describe('triggerFromGoal()', () => {
  it('creates a goal trigger from a Goal object', () => {
    const goal: Goal = {
      id: 'goal-001',
      source: 'user',
      priority: 1,
      description: 'Refactor the tool system',
      created: '2026-02-17T10:00:00.000Z',
      updated: '2026-02-17T10:00:00.000Z',
      status: 'pending',
      attempts: 0,
      notes: '',
      relatedFiles: [],
      tags: ['refactor'],
    };

    const trigger = triggerFromGoal(goal);

    expect(trigger.type).toBe('goal');
    expect(trigger).toHaveProperty('goal');
    expect((trigger as { type: 'goal'; goal: Goal }).goal.id).toBe('goal-001');
    expect((trigger as { type: 'goal'; goal: Goal }).goal.description).toBe('Refactor the tool system');
  });

  it('preserves goal metadata including attempts and priority', () => {
    const goal: Goal = {
      id: 'goal-005',
      source: 'self',
      priority: 3,
      description: 'Improve test coverage',
      created: '2026-02-15T08:00:00.000Z',
      updated: '2026-02-16T14:00:00.000Z',
      status: 'in_progress',
      attempts: 2,
      notes: 'Partially done',
      relatedFiles: ['src/detector.ts'],
      tags: ['testing'],
    };

    const trigger = triggerFromGoal(goal);
    const goalFromTrigger = (trigger as { type: 'goal'; goal: Goal }).goal;

    expect(goalFromTrigger.priority).toBe(3);
    expect(goalFromTrigger.attempts).toBe(2);
    expect(goalFromTrigger.status).toBe('in_progress');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// triggerFromEvent()
// ═══════════════════════════════════════════════════════════════════════════════

describe('triggerFromEvent()', () => {
  it('creates an event trigger from a file_changed SystemEvent', () => {
    const event: SystemEvent = {
      type: 'file_changed',
      paths: ['src/detector.ts', 'src/router.ts'],
      changeKind: 'modified',
      timestamp: '2026-02-17T10:00:00.000Z',
    };

    const trigger = triggerFromEvent(event);

    expect(trigger.type).toBe('event');
    expect(trigger).toHaveProperty('event');
    const agentEvent = (trigger as Extract<AgentTrigger, { type: 'event' }>).event;
    expect(agentEvent.kind).toBe('file_changed');
    expect(agentEvent.description).toContain('2 files modified');
    expect(agentEvent.timestamp).toBe('2026-02-17T10:00:00.000Z');
  });

  it('creates an event trigger from a test_failed SystemEvent', () => {
    const event: SystemEvent = {
      type: 'test_failed',
      testName: 'detector.test.ts',
      output: 'AssertionError: expected true to be false',
      timestamp: '2026-02-17T11:00:00.000Z',
    };

    const trigger = triggerFromEvent(event);
    const agentEvent = (trigger as Extract<AgentTrigger, { type: 'event' }>).event;

    expect(agentEvent.kind).toBe('test_failed');
    expect(agentEvent.description).toContain('Test failed');
    expect(agentEvent.description).toContain('detector.test.ts');
  });

  it('creates an event trigger from a git_push SystemEvent', () => {
    const event: SystemEvent = {
      type: 'git_push',
      branch: 'main',
      commits: ['abc123', 'def456'],
      timestamp: '2026-02-17T12:00:00.000Z',
    };

    const trigger = triggerFromEvent(event);
    const agentEvent = (trigger as Extract<AgentTrigger, { type: 'event' }>).event;

    expect(agentEvent.kind).toBe('git_push');
    expect(agentEvent.description).toContain('Push to main');
    expect(agentEvent.description).toContain('2 commits');
  });

  it('creates an event trigger from a build_error SystemEvent', () => {
    const event: SystemEvent = {
      type: 'build_error',
      error: 'Cannot find module ./missing-dep',
      timestamp: '2026-02-17T13:00:00.000Z',
    };

    const trigger = triggerFromEvent(event);
    const agentEvent = (trigger as Extract<AgentTrigger, { type: 'event' }>).event;

    expect(agentEvent.kind).toBe('build_error');
    expect(agentEvent.description).toContain('Build error');
  });

  it('creates an event trigger from an issue_stale SystemEvent', () => {
    const event: SystemEvent = {
      type: 'issue_stale',
      issueId: 'ISS-003',
      daysSinceActivity: 14,
      timestamp: '2026-02-17T14:00:00.000Z',
    };

    const trigger = triggerFromEvent(event);
    const agentEvent = (trigger as Extract<AgentTrigger, { type: 'event' }>).event;

    expect(agentEvent.kind).toBe('issue_stale');
    expect(agentEvent.description).toContain('ISS-003');
    expect(agentEvent.description).toContain('14 days');
  });

  it('creates an event trigger from a scheduled SystemEvent', () => {
    const event: SystemEvent = {
      type: 'scheduled',
      reason: 'Hourly maintenance cycle',
      timestamp: '2026-02-17T15:00:00.000Z',
    };

    const trigger = triggerFromEvent(event);
    const agentEvent = (trigger as Extract<AgentTrigger, { type: 'event' }>).event;

    expect(agentEvent.kind).toBe('scheduled');
    expect(agentEvent.description).toBe('Hourly maintenance cycle');
  });

  it('includes metadata from the system event', () => {
    const event: SystemEvent = {
      type: 'file_changed',
      paths: ['src/foo.ts'],
      changeKind: 'created',
      timestamp: '2026-02-17T16:00:00.000Z',
    };

    const trigger = triggerFromEvent(event);
    const agentEvent = (trigger as Extract<AgentTrigger, { type: 'event' }>).event;

    expect(agentEvent.metadata).toBeDefined();
    expect(agentEvent.metadata).toHaveProperty('paths');
    expect(agentEvent.metadata).toHaveProperty('changeKind', 'created');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// getTriggerPriority()
// ═══════════════════════════════════════════════════════════════════════════════

describe('getTriggerPriority()', () => {
  it('returns 0 for user triggers (highest priority)', () => {
    const trigger: AgentTrigger = { type: 'user', message: 'Hi', sender: 'Josiah' };
    expect(getTriggerPriority(trigger)).toBe(0);
  });

  it('returns 1 for event triggers', () => {
    const trigger: AgentTrigger = {
      type: 'event',
      event: {
        kind: 'test_failed',
        description: 'Test failed',
        timestamp: new Date().toISOString(),
      },
    };
    expect(getTriggerPriority(trigger)).toBe(1);
  });

  it('returns 2 for goal triggers', () => {
    const goal: Goal = {
      id: 'goal-001',
      source: 'user',
      priority: 1,
      description: 'Fix tests',
      created: new Date().toISOString(),
      updated: new Date().toISOString(),
      status: 'pending',
      attempts: 0,
      notes: '',
      relatedFiles: [],
      tags: [],
    };
    const trigger: AgentTrigger = { type: 'goal', goal };
    expect(getTriggerPriority(trigger)).toBe(2);
  });

  it('returns 3 for scheduled triggers (lowest priority)', () => {
    const trigger: AgentTrigger = { type: 'scheduled' };
    expect(getTriggerPriority(trigger)).toBe(3);
  });

  it('maintains correct priority ordering: user < event < goal < scheduled', () => {
    const userPriority = getTriggerPriority({ type: 'user', message: '', sender: '' });
    const eventPriority = getTriggerPriority({
      type: 'event',
      event: { kind: 'test', description: '', timestamp: '' },
    });
    const goalPriority = getTriggerPriority({
      type: 'goal',
      goal: {
        id: 'g-1', source: 'self', priority: 1, description: '',
        created: '', updated: '', status: 'pending', attempts: 0,
        notes: '', relatedFiles: [], tags: [],
      },
    });
    const scheduledPriority = getTriggerPriority({ type: 'scheduled' });

    expect(userPriority).toBeLessThan(eventPriority);
    expect(eventPriority).toBeLessThan(goalPriority);
    expect(goalPriority).toBeLessThan(scheduledPriority);
  });
});
