import { describe, expect, it } from 'vitest';

import { createSchedulerExecutors } from '../src/scheduler/executor.js';
import type { JobStore } from '../src/scheduler/store.js';
import type { ScheduledJob } from '../src/scheduler/types.js';
import type { NativeToolCall } from '../src/tools/schemas/types.js';

// ─── Mock helpers ────────────────────────────────────────────────────────────

function makeCall(name: string, input: Record<string, unknown>, id = 'call-1'): NativeToolCall {
  return { id, name, input };
}

function makeJob(overrides: Partial<ScheduledJob> = {}): ScheduledJob {
  return {
    id: 'job-1',
    triggerType: 'one_shot',
    status: 'active',
    recipient: '+1234567890',
    message: 'Test reminder',
    description: 'Test reminder',
    fireAt: Date.now() + 60000,
    createdAt: Date.now(),
    fireCount: 0,
    source: 'user_request',
    label: 'test label',
    ...overrides,
  };
}

function createMockJobStore(initialJobs: ScheduledJob[] = []): JobStore {
  const jobs = [...initialJobs];

  return {
    getActive: () => jobs.filter((j) => j.status === 'active'),
    getForRecipient: (recipient: string) => jobs.filter((j) => j.recipient === recipient),
    getById: (id: string) => jobs.find((j) => j.id === id),
    add: (job: ScheduledJob) => { jobs.push(job); },
    update: (job: ScheduledJob) => {
      const idx = jobs.findIndex((j) => j.id === job.id);
      if (idx >= 0) jobs[idx] = job;
    },
    cancel: (id: string) => {
      const job = jobs.find((j) => j.id === id);
      if (!job || job.status !== 'active') return false;
      job.status = 'cancelled';
      return true;
    },
    getDueJobs: (_now: number) => [],
    compact: () => 0,
    count: () => jobs.length,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// createSchedulerExecutors — structure
// ═══════════════════════════════════════════════════════════════════════════════

describe('createSchedulerExecutors — structure', () => {
  it('returns 3 executors', () => {
    const store = createMockJobStore();
    const executors = createSchedulerExecutors(store, '+1234567890');
    expect(executors).toHaveLength(3);
  });

  it('returns executors with correct tool names', () => {
    const store = createMockJobStore();
    const executors = createSchedulerExecutors(store, '+1234567890');
    const names = executors.map((e) => e.toolName);
    expect(names).toContain('schedule_reminder');
    expect(names).toContain('list_reminders');
    expect(names).toContain('cancel_reminder');
  });

  it('all executors have execute function', () => {
    const store = createMockJobStore();
    const executors = createSchedulerExecutors(store, '+1234567890');
    for (const executor of executors) {
      expect(typeof executor.execute).toBe('function');
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// schedule_reminder executor
// ═══════════════════════════════════════════════════════════════════════════════

describe('schedule_reminder executor', () => {
  it('returns error for empty message', async () => {
    const store = createMockJobStore();
    const executors = createSchedulerExecutors(store, '+1234567890');
    const executor = executors.find((e) => e.toolName === 'schedule_reminder')!;

    const call = makeCall('schedule_reminder', { message: '' });
    const result = await executor.execute(call);
    expect(result.success).toBe(false);
    expect(result.error).toContain('message is required');
  });

  it('returns error for missing message', async () => {
    const store = createMockJobStore();
    const executors = createSchedulerExecutors(store, '+1234567890');
    const executor = executors.find((e) => e.toolName === 'schedule_reminder')!;

    const call = makeCall('schedule_reminder', {});
    const result = await executor.execute(call);
    expect(result.success).toBe(false);
    expect(result.error).toContain('message is required');
  });

  it('returns error for non-string message', async () => {
    const store = createMockJobStore();
    const executors = createSchedulerExecutors(store, '+1234567890');
    const executor = executors.find((e) => e.toolName === 'schedule_reminder')!;

    const call = makeCall('schedule_reminder', { message: 123 });
    const result = await executor.execute(call);
    expect(result.success).toBe(false);
  });

  it('creates a one-shot reminder with fireAt', async () => {
    const store = createMockJobStore();
    const executors = createSchedulerExecutors(store, '+1234567890');
    const executor = executors.find((e) => e.toolName === 'schedule_reminder')!;

    const call = makeCall('schedule_reminder', {
      message: 'Take the pills',
      fireAt: 'in 30 minutes',
      label: 'pills',
    });
    const result = await executor.execute(call);
    expect(result.success).toBe(true);
    expect(result.output).toBeTruthy();
    const parsed = JSON.parse(result.output!);
    expect(parsed.label).toBe('pills');
    expect(parsed.type).toBe('one_shot');
    expect(store.count()).toBe(1);
  });

  it('creates a cron reminder', async () => {
    const store = createMockJobStore();
    const executors = createSchedulerExecutors(store, '+1234567890');
    const executor = executors.find((e) => e.toolName === 'schedule_reminder')!;

    const call = makeCall('schedule_reminder', {
      message: 'Morning standup',
      cronExpression: '0 9 * * 1-5',
      label: 'standup',
    });
    const result = await executor.execute(call);
    expect(result.success).toBe(true);
    const parsed = JSON.parse(result.output!);
    expect(parsed.type).toBe('cron');
  });

  it('creates actionable reminder', async () => {
    const store = createMockJobStore();
    const executors = createSchedulerExecutors(store, '+1234567890');
    const executor = executors.find((e) => e.toolName === 'schedule_reminder')!;

    const call = makeCall('schedule_reminder', {
      message: 'Check the weather',
      fireAt: 'in 1 hour',
      actionable: true,
    });
    const result = await executor.execute(call);
    expect(result.success).toBe(true);
    const parsed = JSON.parse(result.output!);
    expect(parsed.actionable).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// list_reminders executor
// ═══════════════════════════════════════════════════════════════════════════════

describe('list_reminders executor', () => {
  it('returns "no active reminders" when empty', async () => {
    const store = createMockJobStore();
    const executors = createSchedulerExecutors(store, '+1234567890');
    const executor = executors.find((e) => e.toolName === 'list_reminders')!;

    const call = makeCall('list_reminders', {});
    const result = await executor.execute(call);
    expect(result.success).toBe(true);
    expect(result.output).toContain('No active reminders');
  });

  it('lists active jobs for the recipient', async () => {
    const job = makeJob({ recipient: '+1234567890', label: 'dentist' });
    const store = createMockJobStore([job]);
    const executors = createSchedulerExecutors(store, '+1234567890');
    const executor = executors.find((e) => e.toolName === 'list_reminders')!;

    const call = makeCall('list_reminders', {});
    const result = await executor.execute(call);
    expect(result.success).toBe(true);
    expect(result.output).toContain('dentist');
    expect(result.output).toContain('job-1');
  });

  it('skips non-active jobs', async () => {
    const job = makeJob({ recipient: '+1234567890', status: 'fired' });
    const store = createMockJobStore([job]);
    const executors = createSchedulerExecutors(store, '+1234567890');
    const executor = executors.find((e) => e.toolName === 'list_reminders')!;

    const call = makeCall('list_reminders', {});
    const result = await executor.execute(call);
    expect(result.output).toContain('No active reminders');
  });

  it('shows cron job details', async () => {
    const job = makeJob({
      recipient: '+1234567890',
      triggerType: 'cron',
      cronExpression: '0 9 * * 1',
      nextFireTime: Date.now() + 86400000,
      fireCount: 3,
    });
    const store = createMockJobStore([job]);
    const executors = createSchedulerExecutors(store, '+1234567890');
    const executor = executors.find((e) => e.toolName === 'list_reminders')!;

    const call = makeCall('list_reminders', {});
    const result = await executor.execute(call);
    expect(result.success).toBe(true);
    expect(result.output).toContain('cron');
    expect(result.output).toContain('fired 3 times');
  });

  it('shows actionable label', async () => {
    const job = makeJob({ recipient: '+1234567890', actionable: true });
    const store = createMockJobStore([job]);
    const executors = createSchedulerExecutors(store, '+1234567890');
    const executor = executors.find((e) => e.toolName === 'list_reminders')!;

    const call = makeCall('list_reminders', {});
    const result = await executor.execute(call);
    expect(result.output).toContain('[actionable]');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// cancel_reminder executor
// ═══════════════════════════════════════════════════════════════════════════════

describe('cancel_reminder executor', () => {
  it('returns error when neither id nor label provided', async () => {
    const store = createMockJobStore();
    const executors = createSchedulerExecutors(store, '+1234567890');
    const executor = executors.find((e) => e.toolName === 'cancel_reminder')!;

    const call = makeCall('cancel_reminder', {});
    const result = await executor.execute(call);
    expect(result.success).toBe(false);
    expect(result.error).toContain('id or label');
  });

  it('cancels by ID', async () => {
    const job = makeJob({ id: 'job-cancel-1', recipient: '+1234567890' });
    const store = createMockJobStore([job]);
    const executors = createSchedulerExecutors(store, '+1234567890');
    const executor = executors.find((e) => e.toolName === 'cancel_reminder')!;

    const call = makeCall('cancel_reminder', { id: 'job-cancel-1' });
    const result = await executor.execute(call);
    expect(result.success).toBe(true);
    expect(result.output).toContain('cancelled');
  });

  it('returns error for nonexistent ID', async () => {
    const store = createMockJobStore();
    const executors = createSchedulerExecutors(store, '+1234567890');
    const executor = executors.find((e) => e.toolName === 'cancel_reminder')!;

    const call = makeCall('cancel_reminder', { id: 'nonexistent' });
    const result = await executor.execute(call);
    expect(result.success).toBe(false);
    expect(result.error).toContain('No active reminder');
  });

  it('cancels by label (partial match)', async () => {
    const job = makeJob({
      id: 'job-label-1',
      recipient: '+1234567890',
      label: 'dentist appointment',
    });
    const store = createMockJobStore([job]);
    const executors = createSchedulerExecutors(store, '+1234567890');
    const executor = executors.find((e) => e.toolName === 'cancel_reminder')!;

    const call = makeCall('cancel_reminder', { label: 'dentist' });
    const result = await executor.execute(call);
    expect(result.success).toBe(true);
    expect(result.output).toContain('cancelled');
    expect(result.output).toContain('dentist appointment');
  });

  it('cancels by description match when label is partial', async () => {
    const job = makeJob({
      id: 'job-desc-1',
      recipient: '+1234567890',
      label: undefined,
      description: 'weekly standup reminder',
    });
    const store = createMockJobStore([job]);
    const executors = createSchedulerExecutors(store, '+1234567890');
    const executor = executors.find((e) => e.toolName === 'cancel_reminder')!;

    const call = makeCall('cancel_reminder', { label: 'standup' });
    const result = await executor.execute(call);
    expect(result.success).toBe(true);
    expect(result.output).toContain('cancelled');
  });

  it('returns error for no matching label', async () => {
    const job = makeJob({ recipient: '+1234567890', label: 'dentist' });
    const store = createMockJobStore([job]);
    const executors = createSchedulerExecutors(store, '+1234567890');
    const executor = executors.find((e) => e.toolName === 'cancel_reminder')!;

    const call = makeCall('cancel_reminder', { label: 'standup' });
    const result = await executor.execute(call);
    expect(result.success).toBe(false);
    expect(result.error).toContain('No active reminder matching');
  });

  it('label match is case insensitive', async () => {
    const job = makeJob({
      id: 'job-case-1',
      recipient: '+1234567890',
      label: 'DENTIST Appointment',
    });
    const store = createMockJobStore([job]);
    const executors = createSchedulerExecutors(store, '+1234567890');
    const executor = executors.find((e) => e.toolName === 'cancel_reminder')!;

    const call = makeCall('cancel_reminder', { label: 'dentist' });
    const result = await executor.execute(call);
    expect(result.success).toBe(true);
  });
});
