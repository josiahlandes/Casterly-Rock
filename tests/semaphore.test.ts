import { describe, it, expect } from 'vitest';

import { Semaphore } from '../src/utils/semaphore.js';

// ─────────────────────────────────────────────────────────────────────────────
// Constructor
// ─────────────────────────────────────────────────────────────────────────────

describe('Semaphore — Constructor', () => {
  it('throws for maxConcurrent < 1', () => {
    expect(() => new Semaphore(0)).toThrow('maxConcurrent must be >= 1');
    expect(() => new Semaphore(-1)).toThrow('maxConcurrent must be >= 1');
  });

  it('getMax returns the configured max', () => {
    const sem = new Semaphore(5);
    expect(sem.getMax()).toBe(5);
  });

  it('getActive starts at 0', () => {
    const sem = new Semaphore(3);
    expect(sem.getActive()).toBe(0);
  });

  it('getWaiting starts at 0', () => {
    const sem = new Semaphore(3);
    expect(sem.getWaiting()).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Acquire / Release
// ─────────────────────────────────────────────────────────────────────────────

describe('Semaphore — Acquire / Release', () => {
  it('acquire returns a release function', async () => {
    const sem = new Semaphore(1);
    const release = await sem.acquire();
    expect(typeof release).toBe('function');
    release();
  });

  it('getActive increments after acquire', async () => {
    const sem = new Semaphore(3);
    expect(sem.getActive()).toBe(0);

    const release = await sem.acquire();
    expect(sem.getActive()).toBe(1);

    const release2 = await sem.acquire();
    expect(sem.getActive()).toBe(2);

    release();
    release2();
  });

  it('release decrements getActive', async () => {
    const sem = new Semaphore(3);
    const release = await sem.acquire();
    expect(sem.getActive()).toBe(1);

    release();
    expect(sem.getActive()).toBe(0);
  });

  it('double release is idempotent', async () => {
    const sem = new Semaphore(2);
    const release = await sem.acquire();
    expect(sem.getActive()).toBe(1);

    release();
    expect(sem.getActive()).toBe(0);

    // Second release should be a no-op, not go negative
    release();
    expect(sem.getActive()).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// run()
// ─────────────────────────────────────────────────────────────────────────────

describe('Semaphore — run()', () => {
  it('auto-acquires and releases on success', async () => {
    const sem = new Semaphore(1);
    const result = await sem.run(async () => {
      expect(sem.getActive()).toBe(1);
      return 42;
    });

    expect(result).toBe(42);
    expect(sem.getActive()).toBe(0);
  });

  it('releases even on error', async () => {
    const sem = new Semaphore(1);
    await expect(
      sem.run(async () => {
        throw new Error('intentional test error');
      }),
    ).rejects.toThrow('intentional test error');

    expect(sem.getActive()).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Concurrency Limit
// ─────────────────────────────────────────────────────────────────────────────

describe('Semaphore — Concurrency', () => {
  it('acquire blocks at max concurrency and resumes when released', async () => {
    const sem = new Semaphore(2);

    // Acquire both slots
    const release1 = await sem.acquire();
    const release2 = await sem.acquire();
    expect(sem.getActive()).toBe(2);

    // Third acquire should be queued
    let thirdAcquired = false;
    const thirdPromise = sem.acquire().then((release) => {
      thirdAcquired = true;
      return release;
    });

    // Allow microtasks to settle
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(thirdAcquired).toBe(false);
    expect(sem.getWaiting()).toBe(1);

    // Release one slot — the waiter should proceed
    release1();

    const release3 = await thirdPromise;
    expect(thirdAcquired).toBe(true);
    expect(sem.getActive()).toBe(2);
    expect(sem.getWaiting()).toBe(0);

    release2();
    release3();
  });

  it('waiting queue is processed FIFO', async () => {
    const sem = new Semaphore(1);
    const order: number[] = [];

    const release1 = await sem.acquire();

    // Queue two waiters
    const p2 = sem.acquire().then((release) => {
      order.push(2);
      release();
    });
    const p3 = sem.acquire().then((release) => {
      order.push(3);
      release();
    });

    // Allow microtasks to settle — both should be waiting
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(sem.getWaiting()).toBe(2);

    // Release the first — should process in FIFO order
    release1();

    await Promise.all([p2, p3]);
    expect(order).toEqual([2, 3]);
  });
});
