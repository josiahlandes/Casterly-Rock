import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createJobStore, type JobStore } from '../src/scheduler/store.js';
import type { ScheduledJob } from '../src/scheduler/types.js';

// Use a temp directory for each test
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
    fireAt: Date.now() + 60 * 60 * 1000, // 1 hour from now
    createdAt: Date.now(),
    fireCount: 0,
    source: 'user_request',
    ...overrides,
  };
}

beforeEach(() => {
  testDir = join(tmpdir(), `casterly-store-test-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`);
  mkdirSync(testDir, { recursive: true });
  store = createJobStore(testDir);
});

afterEach(() => {
  if (existsSync(testDir)) {
    rmSync(testDir, { recursive: true, force: true });
  }
});

// ─── CRUD ───────────────────────────────────────────────────────────────────

describe('JobStore CRUD', () => {
  it('starts empty', () => {
    expect(store.count()).toBe(0);
    expect(store.getActive()).toHaveLength(0);
  });

  it('adds and retrieves a job by ID', () => {
    const job = makeJob();
    store.add(job);

    expect(store.count()).toBe(1);
    expect(store.getById(job.id)).toEqual(job);
  });

  it('gets active jobs only', () => {
    const active = makeJob({ status: 'active' });
    const fired = makeJob({ status: 'fired' });
    const cancelled = makeJob({ status: 'cancelled' });

    store.add(active);
    store.add(fired);
    store.add(cancelled);

    expect(store.getActive()).toHaveLength(1);
    expect(store.getActive()[0]!.id).toBe(active.id);
  });

  it('gets jobs for a specific recipient', () => {
    const job1 = makeJob({ recipient: '+1555000000' });
    const job2 = makeJob({ recipient: '+1555000000' });
    const job3 = makeJob({ recipient: '+1999000000' });

    store.add(job1);
    store.add(job2);
    store.add(job3);

    expect(store.getForRecipient('+1555000000')).toHaveLength(2);
    expect(store.getForRecipient('+1999000000')).toHaveLength(1);
  });

  it('updates a job', () => {
    const job = makeJob();
    store.add(job);

    const updated = { ...job, status: 'fired' as const, lastFiredAt: Date.now() };
    store.update(updated);

    expect(store.getById(job.id)?.status).toBe('fired');
    expect(store.getById(job.id)?.lastFiredAt).toBeDefined();
  });

  it('cancels a job by ID', () => {
    const job = makeJob();
    store.add(job);

    expect(store.cancel(job.id)).toBe(true);
    expect(store.getById(job.id)?.status).toBe('cancelled');
  });

  it('returns false when cancelling non-existent job', () => {
    expect(store.cancel('nonexistent')).toBe(false);
  });

  it('returns false when cancelling already cancelled job', () => {
    const job = makeJob({ status: 'cancelled' });
    store.add(job);
    expect(store.cancel(job.id)).toBe(false);
  });
});

// ─── getDueJobs ─────────────────────────────────────────────────────────────

describe('getDueJobs', () => {
  it('returns one-shot jobs with past fireAt', () => {
    const pastJob = makeJob({ fireAt: Date.now() - 1000 });
    const futureJob = makeJob({ fireAt: Date.now() + 60000 });

    store.add(pastJob);
    store.add(futureJob);

    const due = store.getDueJobs(Date.now());
    expect(due).toHaveLength(1);
    expect(due[0]!.id).toBe(pastJob.id);
  });

  it('returns cron jobs with past nextFireTime', () => {
    const dueJob = makeJob({
      triggerType: 'cron',
      cronExpression: '0 9 * * *',
      nextFireTime: Date.now() - 1000,
      fireAt: undefined,
    });

    store.add(dueJob);

    const due = store.getDueJobs(Date.now());
    expect(due).toHaveLength(1);
  });

  it('does not return cancelled jobs', () => {
    const job = makeJob({ fireAt: Date.now() - 1000, status: 'cancelled' });
    store.add(job);

    expect(store.getDueJobs(Date.now())).toHaveLength(0);
  });

  it('does not return fired jobs', () => {
    const job = makeJob({ fireAt: Date.now() - 1000, status: 'fired' });
    store.add(job);

    expect(store.getDueJobs(Date.now())).toHaveLength(0);
  });
});

// ─── Compact ────────────────────────────────────────────────────────────────

describe('compact', () => {
  it('removes old fired one-shot jobs', () => {
    const oldFired = makeJob({
      status: 'fired',
      triggerType: 'one_shot',
      lastFiredAt: Date.now() - 8 * 24 * 60 * 60 * 1000, // 8 days ago
    });
    const recentFired = makeJob({
      status: 'fired',
      triggerType: 'one_shot',
      lastFiredAt: Date.now() - 1000, // just now
    });

    store.add(oldFired);
    store.add(recentFired);

    const removed = store.compact();
    expect(removed).toBe(1);
    expect(store.count()).toBe(1);
  });

  it('removes old cancelled jobs', () => {
    const oldCancelled = makeJob({
      status: 'cancelled',
      createdAt: Date.now() - 2 * 24 * 60 * 60 * 1000, // 2 days ago
    });

    store.add(oldCancelled);

    const removed = store.compact();
    expect(removed).toBe(1);
    expect(store.count()).toBe(0);
  });

  it('keeps active jobs regardless of age', () => {
    const oldActive = makeJob({
      status: 'active',
      createdAt: Date.now() - 30 * 24 * 60 * 60 * 1000, // 30 days ago
    });

    store.add(oldActive);

    const removed = store.compact();
    expect(removed).toBe(0);
    expect(store.count()).toBe(1);
  });
});

// ─── Persistence ────────────────────────────────────────────────────────────

describe('persistence', () => {
  it('persists jobs across store instances', () => {
    const job = makeJob();
    store.add(job);

    // Create a new store from the same directory
    const store2 = createJobStore(testDir);
    expect(store2.count()).toBe(1);
    expect(store2.getById(job.id)?.message).toBe(job.message);
  });

  it('handles missing file gracefully', () => {
    const emptyDir = join(tmpdir(), `casterly-empty-${Date.now()}`);
    const emptyStore = createJobStore(emptyDir);

    expect(emptyStore.count()).toBe(0);

    // Cleanup
    if (existsSync(emptyDir)) {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });
});
