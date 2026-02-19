/**
 * Semaphore — Promise-based concurrency limiter
 *
 * Replaces the busy-wait semaphore in ConcurrentProvider with a proper
 * non-blocking implementation. Shared utility for any component that
 * needs bounded concurrency.
 *
 * Usage:
 *   const sem = new Semaphore(3); // max 3 concurrent
 *   const release = await sem.acquire();
 *   try { ... } finally { release(); }
 */

// ─────────────────────────────────────────────────────────────────────────────
// Semaphore
// ─────────────────────────────────────────────────────────────────────────────

export class Semaphore {
  private readonly maxConcurrent: number;
  private active: number = 0;
  private readonly waitQueue: Array<() => void> = [];

  constructor(maxConcurrent: number) {
    if (maxConcurrent < 1) {
      throw new Error('Semaphore maxConcurrent must be >= 1');
    }
    this.maxConcurrent = maxConcurrent;
  }

  /**
   * Acquire a slot. Returns a release function that MUST be called
   * when the work is done. If all slots are taken, the promise
   * resolves when a slot becomes available.
   */
  async acquire(): Promise<() => void> {
    if (this.active < this.maxConcurrent) {
      this.active++;
      return this.createRelease();
    }

    // Wait for a slot
    return new Promise<() => void>((resolve) => {
      this.waitQueue.push(() => {
        this.active++;
        resolve(this.createRelease());
      });
    });
  }

  /**
   * Run an async function with automatic acquire/release.
   */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /**
   * Current number of active slots.
   */
  getActive(): number {
    return this.active;
  }

  /**
   * Number of waiters in the queue.
   */
  getWaiting(): number {
    return this.waitQueue.length;
  }

  /**
   * Maximum concurrent slots.
   */
  getMax(): number {
    return this.maxConcurrent;
  }

  // ── Private ──────────────────────────────────────────────────────────────

  private createRelease(): () => void {
    let released = false;
    return () => {
      if (released) return; // Idempotent
      released = true;
      this.active--;

      // Wake the next waiter
      const next = this.waitQueue.shift();
      if (next) {
        next();
      }
    };
  }
}
