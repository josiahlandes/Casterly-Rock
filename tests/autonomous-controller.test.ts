import { describe, expect, it, vi, beforeEach } from 'vitest';

import { formatDailyReport } from '../src/autonomous/report.js';
import { createAutonomousController, type AutonomousController } from '../src/autonomous/controller.js';
import { AbortError } from '../src/autonomous/loop.js';
import type { AggregateStats } from '../src/autonomous/reflector.js';
import type { Reflection, Hypothesis, Observation } from '../src/autonomous/types.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeObservation(overrides: Partial<Observation> = {}): Observation {
  return {
    id: 'obs-1',
    type: 'code_smell',
    severity: 'medium',
    frequency: 1,
    context: {},
    suggestedArea: 'src/test.ts',
    timestamp: new Date().toISOString(),
    source: 'static_analysis',
    ...overrides,
  };
}

function makeHypothesis(overrides: Partial<Hypothesis> = {}): Hypothesis {
  return {
    id: 'hyp-1',
    observation: makeObservation(),
    proposal: 'Fix something',
    approach: 'fix_bug',
    expectedImpact: 'medium',
    confidence: 0.8,
    affectedFiles: ['src/test.ts'],
    estimatedComplexity: 'simple',
    previousAttempts: 0,
    reasoning: 'Because it is broken',
    ...overrides,
  };
}

function makeReflection(overrides: Partial<Reflection> = {}): Reflection {
  return {
    cycleId: 'cycle-1',
    timestamp: new Date().toISOString(),
    observation: makeObservation(),
    hypothesis: makeHypothesis(),
    outcome: 'success',
    learnings: 'Learned something useful',
    durationMs: 5000,
    ...overrides,
  };
}

function makeStats(overrides: Partial<AggregateStats> = {}): AggregateStats {
  return {
    totalCycles: 8,
    successfulCycles: 5,
    failedCycles: 3,
    totalTokensUsed: { input: 142000, output: 23000 },
    estimatedCostUsd: 0,
    successRate: 0.625,
    averageDurationMs: 30000,
    topFailureReasons: [],
    ...overrides,
  };
}

/**
 * Create a mock AutonomousLoop with the minimal interface the controller needs.
 */
function createMockLoop(runCycleFn?: (signal?: AbortSignal) => Promise<void>) {
  const mockReflector = {
    getStatistics: vi.fn().mockResolvedValue(makeStats()),
    loadRecentReflections: vi.fn().mockResolvedValue([
      makeReflection({ hypothesis: makeHypothesis({ proposal: 'Added pagination' }) }),
    ]),
  };

  const mockGit = {
    checkoutBase: vi.fn().mockResolvedValue(undefined),
  };

  const loop = {
    runCycle: runCycleFn ? vi.fn().mockImplementation(runCycleFn) : vi.fn().mockResolvedValue(undefined),
    stop: vi.fn(),
    reflectorInstance: mockReflector,
    configInstance: { cycleIntervalMinutes: 60 },
    gitInstance: mockGit,
  };

  return { loop: loop as unknown as InstanceType<typeof import('../src/autonomous/loop.js').AutonomousLoop>, mockReflector, mockGit };
}

// ─── formatDailyReport ──────────────────────────────────────────────────────

describe('formatDailyReport', () => {
  it('formats a report with cycles and reflections', () => {
    const stats = makeStats();
    const reflections = [
      makeReflection({ outcome: 'success', hypothesis: makeHypothesis({ proposal: 'Added pagination' }) }),
      makeReflection({ outcome: 'success', hypothesis: makeHypothesis({ proposal: 'Fixed timeout' }) }),
      makeReflection({ outcome: 'failure', hypothesis: makeHypothesis({ proposal: 'Refactor router' }), learnings: 'tests failed' }),
    ];

    const report = formatDailyReport(stats, reflections);

    expect(report).toContain('Autonomous Report (24h)');
    expect(report).toContain('Cycles: 8 completed');
    expect(report).toContain('63%');
    expect(report).toContain('Top improvements:');
    expect(report).toContain('Added pagination');
    expect(report).toContain('Fixed timeout');
    expect(report).toContain('Failed attempts:');
    expect(report).toContain('Refactor router');
    expect(report).toContain('142K input');
    expect(report).toContain('23K output');
  });

  it('handles zero cycles', () => {
    const stats = makeStats({ totalCycles: 0, successRate: 0, successfulCycles: 0 });
    const report = formatDailyReport(stats, []);

    expect(report).toContain('Autonomous Report (24h)');
    expect(report).toContain('No cycles ran');
  });

  it('formats large token counts with M suffix', () => {
    const stats = makeStats({ totalTokensUsed: { input: 2_500_000, output: 350_000 } });
    const report = formatDailyReport(stats, []);

    expect(report).toContain('2.5M input');
    expect(report).toContain('350K output');
  });

  it('formats small token counts without suffix', () => {
    const stats = makeStats({ totalTokensUsed: { input: 500, output: 200 } });
    const report = formatDailyReport(stats, []);

    expect(report).toContain('500 input');
    expect(report).toContain('200 output');
  });

  it('truncates long learning strings in failures', () => {
    const longLearning = 'A'.repeat(100);
    const reflections = [
      makeReflection({ outcome: 'failure', learnings: longLearning }),
    ];
    const stats = makeStats({ totalCycles: 1, successfulCycles: 0, failedCycles: 1, successRate: 0 });
    const report = formatDailyReport(stats, reflections);

    // Should be truncated at 40 chars
    expect(report).toContain('...');
    expect(report.length).toBeLessThan(500);
  });
});

// ─── createAutonomousController ─────────────────────────────────────────────

describe('createAutonomousController', () => {
  let controller: AutonomousController;
  let mockLoop: ReturnType<typeof createMockLoop>;

  beforeEach(() => {
    mockLoop = createMockLoop();
    controller = createAutonomousController({
      loop: mockLoop.loop,
      cycleIntervalMinutes: 60,
    });
  });

  // ── start/stop ──────────────────────────────────────────────────────

  it('starts disabled', () => {
    expect(controller.enabled).toBe(false);
    expect(controller.busy).toBe(false);
  });

  it('start() enables the controller', () => {
    controller.start();
    expect(controller.enabled).toBe(true);
  });

  it('stop() disables the controller', () => {
    controller.start();
    controller.stop();
    expect(controller.enabled).toBe(false);
  });

  it('start() is idempotent', () => {
    controller.start();
    controller.start();
    expect(controller.enabled).toBe(true);
  });

  it('stop() is idempotent', () => {
    controller.stop();
    controller.stop();
    expect(controller.enabled).toBe(false);
  });

  // ── tick ────────────────────────────────────────────────────────────

  it('tick() does nothing when disabled', async () => {
    await controller.tick();
    expect(mockLoop.loop.runCycle).not.toHaveBeenCalled();
  });

  it('tick() runs a cycle when enabled', async () => {
    controller.start();
    await controller.tick();

    expect(mockLoop.loop.runCycle).toHaveBeenCalledOnce();
    expect(controller.busy).toBe(false);
  });

  it('tick() skips when busy', async () => {
    // Simulate a long-running cycle
    let resolveRunCycle!: () => void;
    const longRunning = createMockLoop(
      () => new Promise<void>((resolve) => { resolveRunCycle = resolve; })
    );
    const ctrl = createAutonomousController({
      loop: longRunning.loop,
      cycleIntervalMinutes: 0,
    });

    ctrl.start();

    // Start tick but don't await it — it's blocked in runCycle
    const tickPromise = ctrl.tick();

    // busy should be true now (the runCycle promise hasn't resolved)
    // A second tick should be a no-op
    await ctrl.tick();
    expect(longRunning.loop.runCycle).toHaveBeenCalledTimes(1);

    // Let it complete
    resolveRunCycle();
    await tickPromise;
  });

  it('tick() respects cycle interval', async () => {
    controller.start();

    // First tick runs
    await controller.tick();
    expect(mockLoop.loop.runCycle).toHaveBeenCalledOnce();

    // Immediately calling tick again should skip (interval not elapsed)
    await controller.tick();
    expect(mockLoop.loop.runCycle).toHaveBeenCalledOnce();
  });

  it('tick() increments totalCycles on success', async () => {
    controller.start();
    await controller.tick();

    const status = controller.getStatus();
    expect(status.totalCycles).toBe(1);
    expect(status.successfulCycles).toBe(1);
  });

  it('tick() increments totalCycles on failure', async () => {
    const failingLoop = createMockLoop(() => Promise.reject(new Error('Something broke')));
    const ctrl = createAutonomousController({
      loop: failingLoop.loop,
      cycleIntervalMinutes: 0,
    });

    ctrl.start();
    await ctrl.tick();

    const status = ctrl.getStatus();
    expect(status.totalCycles).toBe(1);
    expect(status.successfulCycles).toBe(0);
    expect(ctrl.busy).toBe(false);
  });

  it('tick() handles AbortError gracefully', async () => {
    const abortingLoop = createMockLoop(() => Promise.reject(new AbortError('cycle-1')));
    const ctrl = createAutonomousController({
      loop: abortingLoop.loop,
      cycleIntervalMinutes: 0,
    });

    ctrl.start();
    await ctrl.tick();

    const status = ctrl.getStatus();
    expect(status.totalCycles).toBe(1);
    expect(status.successfulCycles).toBe(0);
    expect(ctrl.busy).toBe(false);
  });

  // ── interrupt ───────────────────────────────────────────────────────

  it('interrupt() is a no-op when not busy', async () => {
    await controller.interrupt();
    expect(controller.busy).toBe(false);
  });

  it('interrupt() sets busy to false when running', async () => {
    let resolveRunCycle!: () => void;
    const blockingLoop = createMockLoop(
      () => new Promise<void>((resolve) => { resolveRunCycle = resolve; })
    );
    const ctrl = createAutonomousController({
      loop: blockingLoop.loop,
      cycleIntervalMinutes: 0,
    });

    ctrl.start();
    const tickPromise = ctrl.tick();

    // Now interrupt
    await ctrl.interrupt();
    expect(ctrl.busy).toBe(false);
    expect(blockingLoop.mockGit.checkoutBase).toHaveBeenCalled();

    // Resolve the blocked cycle so the promise settles
    resolveRunCycle();
    await tickPromise;
  });

  // ── getStatus ───────────────────────────────────────────────────────

  it('getStatus() returns correct initial status', () => {
    const status = controller.getStatus();

    expect(status.enabled).toBe(false);
    expect(status.busy).toBe(false);
    expect(status.totalCycles).toBe(0);
    expect(status.successfulCycles).toBe(0);
    expect(status.lastCycleAt).toBeNull();
    expect(status.nextCycleIn).toBe('disabled');
  });

  it('getStatus() shows "now" when enabled and no previous cycle', () => {
    controller.start();
    const status = controller.getStatus();
    expect(status.nextCycleIn).toBe('now');
  });

  it('getStatus() shows time remaining after a cycle', async () => {
    controller.start();
    await controller.tick();

    const status = controller.getStatus();
    expect(status.lastCycleAt).toBeTruthy();
    // With a 60-minute interval, nextCycleIn should show a time
    expect(status.nextCycleIn).not.toBe('now');
    expect(status.nextCycleIn).not.toBe('disabled');
  });

  // ── getDailyReport ──────────────────────────────────────────────────

  it('getDailyReport() uses reflector and returns formatted text', async () => {
    const report = await controller.getDailyReport();

    expect(report).toContain('Autonomous Report (24h)');
    expect(report).toContain('Cycles: 8 completed');
    expect(mockLoop.mockReflector.getStatistics).toHaveBeenCalledWith(1);
    expect(mockLoop.mockReflector.loadRecentReflections).toHaveBeenCalledWith(20);
  });
});
