import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { checkDueJobs, type MessageSender } from '../src/scheduler/checker.js';
import { createJobStore, type JobStore } from '../src/scheduler/store.js';
import type { ScheduledJob } from '../src/scheduler/types.js';

let testDir: string;
let store: JobStore;

function makeJob(overrides: Partial<ScheduledJob> = {}): ScheduledJob {
  return {
    id: `job-test-${Math.random().toString(36).substring(2, 8)}`,
    triggerType: 'one_shot',
    status: 'active',
    recipient: '+1555000000',
    message: 'Test reminder',
    description: 'Test reminder',
    fireAt: Date.now() - 1000, // Due (in the past)
    createdAt: Date.now() - 60000,
    fireCount: 0,
    source: 'user_request',
    ...overrides,
  };
}

beforeEach(() => {
  testDir = join(tmpdir(), `casterly-checker-test-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`);
  mkdirSync(testDir, { recursive: true });
  store = createJobStore(testDir);
});

afterEach(() => {
  if (existsSync(testDir)) {
    rmSync(testDir, { recursive: true, force: true });
  }
});

// ─── checkDueJobs ───────────────────────────────────────────────────────────

describe('checkDueJobs', () => {
  it('fires a due one-shot job and marks it as fired', async () => {
    const job = makeJob();
    store.add(job);

    const mockSender: MessageSender = vi.fn().mockReturnValue({ success: true });

    const count = await checkDueJobs(store, mockSender);

    expect(count).toBe(1);
    expect(mockSender).toHaveBeenCalledWith('+1555000000', 'Test reminder');

    // Job should be marked as fired
    const updated = store.getById(job.id);
    expect(updated?.status).toBe('fired');
    expect(updated?.lastFiredAt).toBeDefined();
    expect(updated?.fireCount).toBe(1);
  });

  it('fires a due cron job and updates nextFireTime', async () => {
    const cronJob = makeJob({
      triggerType: 'cron',
      cronExpression: '0 9 * * *',
      nextFireTime: Date.now() - 1000, // Due
      fireAt: undefined,
    });
    store.add(cronJob);

    const mockSender: MessageSender = vi.fn().mockReturnValue({ success: true });

    const count = await checkDueJobs(store, mockSender);

    expect(count).toBe(1);
    expect(mockSender).toHaveBeenCalledOnce();

    // Job should still be active but with updated nextFireTime
    const updated = store.getById(cronJob.id);
    expect(updated?.status).toBe('active');
    expect(updated?.nextFireTime).toBeGreaterThan(Date.now());
    expect(updated?.fireCount).toBe(1);
    expect(updated?.lastFiredAt).toBeDefined();
  });

  it('returns 0 when no jobs are due', async () => {
    const futureJob = makeJob({ fireAt: Date.now() + 60 * 60 * 1000 });
    store.add(futureJob);

    const mockSender: MessageSender = vi.fn().mockReturnValue({ success: true });

    const count = await checkDueJobs(store, mockSender);

    expect(count).toBe(0);
    expect(mockSender).not.toHaveBeenCalled();
  });

  it('skips cancelled jobs', async () => {
    const cancelled = makeJob({ status: 'cancelled' });
    store.add(cancelled);

    const mockSender: MessageSender = vi.fn().mockReturnValue({ success: true });

    const count = await checkDueJobs(store, mockSender);

    expect(count).toBe(0);
    expect(mockSender).not.toHaveBeenCalled();
  });

  it('skips fired jobs', async () => {
    const fired = makeJob({ status: 'fired' });
    store.add(fired);

    const mockSender: MessageSender = vi.fn().mockReturnValue({ success: true });

    const count = await checkDueJobs(store, mockSender);

    expect(count).toBe(0);
    expect(mockSender).not.toHaveBeenCalled();
  });

  it('does not crash when sendMessage fails', async () => {
    const job = makeJob();
    store.add(job);

    const mockSender: MessageSender = vi.fn().mockReturnValue({
      success: false,
      error: 'Send failed',
    });

    const count = await checkDueJobs(store, mockSender);

    // Job not counted as fired, stays active for retry
    expect(count).toBe(0);
    expect(store.getById(job.id)?.status).toBe('active');
  });

  it('fires multiple due jobs', async () => {
    const job1 = makeJob({ message: 'First' });
    const job2 = makeJob({ message: 'Second' });
    store.add(job1);
    store.add(job2);

    const mockSender: MessageSender = vi.fn().mockReturnValue({ success: true });

    const count = await checkDueJobs(store, mockSender);

    expect(count).toBe(2);
    expect(mockSender).toHaveBeenCalledTimes(2);
  });

  it('returns 0 with empty store', async () => {
    const mockSender: MessageSender = vi.fn().mockReturnValue({ success: true });

    const count = await checkDueJobs(store, mockSender);
    expect(count).toBe(0);
  });
});
