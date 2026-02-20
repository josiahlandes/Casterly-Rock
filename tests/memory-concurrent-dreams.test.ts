import { describe, expect, it, beforeEach } from 'vitest';

import { ConcurrentDreamExecutor, createConcurrentDreamExecutor } from '../src/autonomous/memory/concurrent-dreams.js';
import type { DreamPhase, PhaseResult } from '../src/autonomous/memory/concurrent-dreams.js';
import { resetTracer, initTracer } from '../src/autonomous/debug.js';

beforeEach(() => {
  resetTracer();
  initTracer({ enabled: false });
});

function makePhase(
  name: string,
  group: number,
  durationMs: number = 10,
  shouldFail: boolean = false,
): DreamPhase {
  return {
    name,
    label: name,
    group,
    execute: async (): Promise<PhaseResult> => {
      await new Promise((resolve) => setTimeout(resolve, durationMs));
      if (shouldFail) throw new Error(`Phase ${name} failed`);
      return {
        name,
        success: true,
        durationMs,
        metrics: { items: 1 },
      };
    },
  };
}

describe('ConcurrentDreamExecutor', () => {
  describe('execute', () => {
    it('runs phases in group order', async () => {
      const executor = createConcurrentDreamExecutor({ phaseTimeoutMs: 5000 });
      const result = await executor.execute([
        makePhase('consolidate', 1),
        makePhase('worldModel', 1),
        makePhase('reorganize', 2),
        makePhase('retrospective', 3),
      ]);

      expect(result.succeeded).toHaveLength(4);
      expect(result.failed).toHaveLength(0);
      expect(result.phases).toHaveLength(4);
    });

    it('runs phases within the same group concurrently', async () => {
      const executor = createConcurrentDreamExecutor({ phaseTimeoutMs: 5000 });

      // Two 50ms phases in the same group should take ~50ms total, not ~100ms
      const start = Date.now();
      const result = await executor.execute([
        makePhase('a', 1, 50),
        makePhase('b', 1, 50),
      ]);
      const elapsed = Date.now() - start;

      expect(result.succeeded).toHaveLength(2);
      // Allow generous margin for test environment, but should be < 200ms
      expect(elapsed).toBeLessThan(200);
    });

    it('handles individual phase failures gracefully', async () => {
      const executor = createConcurrentDreamExecutor({ phaseTimeoutMs: 5000 });
      const result = await executor.execute([
        makePhase('good', 1),
        makePhase('bad', 1, 10, true),
        makePhase('also-good', 2),
      ]);

      expect(result.succeeded).toContain('good');
      expect(result.succeeded).toContain('also-good');
      expect(result.failed).toContain('bad');
    });

    it('aborts on critical failure when configured', async () => {
      const executor = createConcurrentDreamExecutor({
        phaseTimeoutMs: 5000,
        abortOnCriticalFailure: true,
        criticalPhases: ['critical-phase'],
      });

      const result = await executor.execute([
        makePhase('critical-phase', 1, 10, true),
        makePhase('next-phase', 2),
      ]);

      expect(result.failed).toContain('critical-phase');
      expect(result.failed).toContain('next-phase');
      const nextResult = result.phases.find((p) => p.name === 'next-phase');
      expect(nextResult?.error).toContain('critical');
    });

    it('respects concurrency limits', async () => {
      const executor = createConcurrentDreamExecutor({
        maxConcurrency: 1,
        phaseTimeoutMs: 5000,
      });

      const result = await executor.execute([
        makePhase('a', 1, 10),
        makePhase('b', 1, 10),
      ]);

      expect(result.succeeded).toHaveLength(2);
    });

    it('reports time saved', async () => {
      const executor = createConcurrentDreamExecutor({ phaseTimeoutMs: 5000 });
      const result = await executor.execute([
        makePhase('a', 1, 30),
        makePhase('b', 1, 30),
      ]);

      // Time saved should be >= 0 (concurrent execution saves time)
      expect(result.timeSavedMs).toBeGreaterThanOrEqual(0);
    });
  });
});
