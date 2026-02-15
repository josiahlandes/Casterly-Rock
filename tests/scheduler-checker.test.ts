import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { checkDueJobs, type MessageSender, type ActionableHandler } from '../src/scheduler/checker.js';
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

  // ─── Actionable jobs ─────────────────────────────────────────────────────

  it('routes actionable job through actionableHandler instead of messageSender', async () => {
    const job = makeJob({ message: 'Check the weather and tell me', actionable: true });
    store.add(job);

    const mockSender: MessageSender = vi.fn().mockReturnValue({ success: true });
    const mockHandler: ActionableHandler = vi.fn().mockResolvedValue(undefined);

    const count = await checkDueJobs(store, mockSender, mockHandler);

    expect(count).toBe(1);
    // Should NOT call messageSender for actionable jobs
    expect(mockSender).not.toHaveBeenCalled();
    // Should call the actionable handler with recipient, instruction, and jobId
    expect(mockHandler).toHaveBeenCalledWith('+1555000000', 'Check the weather and tell me', job.id);

    // Job should be marked as fired
    const updated = store.getById(job.id);
    expect(updated?.status).toBe('fired');
    expect(updated?.fireCount).toBe(1);
  });

  it('falls back to messageSender for actionable job when no handler provided', async () => {
    const job = makeJob({ message: 'Check the weather', actionable: true });
    store.add(job);

    const mockSender: MessageSender = vi.fn().mockReturnValue({ success: true });

    // No actionableHandler provided — should fall back to static send
    const count = await checkDueJobs(store, mockSender);

    expect(count).toBe(1);
    expect(mockSender).toHaveBeenCalledWith('+1555000000', 'Check the weather');

    const updated = store.getById(job.id);
    expect(updated?.status).toBe('fired');
  });

  it('handles actionable cron job: stays active with updated nextFireTime', async () => {
    const cronJob = makeJob({
      triggerType: 'cron',
      cronExpression: '0 9 * * 1',
      nextFireTime: Date.now() - 1000,
      fireAt: undefined,
      message: 'Summarize my unread emails',
      actionable: true,
    });
    store.add(cronJob);

    const mockSender: MessageSender = vi.fn().mockReturnValue({ success: true });
    const mockHandler: ActionableHandler = vi.fn().mockResolvedValue(undefined);

    const count = await checkDueJobs(store, mockSender, mockHandler);

    expect(count).toBe(1);
    expect(mockSender).not.toHaveBeenCalled();
    expect(mockHandler).toHaveBeenCalledOnce();

    const updated = store.getById(cronJob.id);
    expect(updated?.status).toBe('active');
    expect(updated?.nextFireTime).toBeGreaterThan(Date.now());
    expect(updated?.fireCount).toBe(1);
  });

  it('does not crash when actionableHandler throws', async () => {
    const job = makeJob({ message: 'Do something risky', actionable: true });
    store.add(job);

    const mockSender: MessageSender = vi.fn().mockReturnValue({ success: true });
    const mockHandler: ActionableHandler = vi.fn().mockRejectedValue(new Error('LLM failed'));

    const count = await checkDueJobs(store, mockSender, mockHandler);

    // Should not crash, job stays active for retry
    expect(count).toBe(0);
    expect(store.getById(job.id)?.status).toBe('active');
  });

  it('handles mixed static and actionable jobs in same batch', async () => {
    const staticJob = makeJob({ message: 'Take out the trash' });
    const actionableJob = makeJob({ message: 'Check the weather', actionable: true });
    store.add(staticJob);
    store.add(actionableJob);

    const mockSender: MessageSender = vi.fn().mockReturnValue({ success: true });
    const mockHandler: ActionableHandler = vi.fn().mockResolvedValue(undefined);

    const count = await checkDueJobs(store, mockSender, mockHandler);

    expect(count).toBe(2);
    expect(mockSender).toHaveBeenCalledOnce();
    expect(mockSender).toHaveBeenCalledWith('+1555000000', 'Take out the trash');
    expect(mockHandler).toHaveBeenCalledOnce();
    expect(mockHandler).toHaveBeenCalledWith('+1555000000', 'Check the weather', actionableJob.id);
  });
});
