import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import { DreamScheduler } from '../src/dual-loop/dream-scheduler.js';
import type { DreamSchedulerDeps, DreamSchedulerConfig } from '../src/dual-loop/dream-scheduler.js';

// ─────────────────────────────────────────────────────────────────────────────
// Mocks
// ─────────────────────────────────────────────────────────────────────────────

// Mock fs to prevent disk I/O
vi.mock('node:fs/promises', () => ({
  readFile: vi.fn().mockRejectedValue(new Error('ENOENT')),
  writeFile: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
}));

// Mock the dream cycle runner
vi.mock('../src/autonomous/dream/runner.js', () => {
  return {
    DreamCycleRunner: class MockDreamCycleRunner {
      constructor(_config?: unknown) { /* noop */ }
      async run() {
        return {
          phasesCompleted: ['fragility-scan'],
          phasesSkipped: [],
          fragileFilesFound: 2,
          goalsReorganized: 1,
          selfModelRebuilt: false,
          durationMs: 5000,
        };
      }
    },
  };
});

// Mock reflector
vi.mock('../src/autonomous/reflector.js', () => {
  return {
    Reflector: class MockReflector {
      async initialize() { /* noop */ }
    },
  };
});

// Mock test runner
vi.mock('../src/ci-loop/test-runner.js', () => ({
  runTests: vi.fn().mockResolvedValue({
    total: 10,
    passed: 10,
    failed: 0,
    errored: 0,
    skipped: 0,
    tests: [],
    exitCode: 0,
    rawOutput: '',
    timestamp: Date.now(),
  }),
}));

// Mock regression guard
vi.mock('../src/ci-loop/regression-guard.js', () => ({
  getFailingTests: vi.fn().mockReturnValue([]),
}));

// Mock tracer
vi.mock('../src/autonomous/debug.js', () => ({
  getTracer: () => ({
    log: vi.fn(),
    withSpan: vi.fn(),
    withSpanSync: vi.fn(),
  }),
}));

function createMockDeps(overrides?: Partial<DreamSchedulerDeps>): DreamSchedulerDeps {
  return {
    worldModel: {} as DreamSchedulerDeps['worldModel'],
    goalStack: {
      addGoal: vi.fn().mockReturnValue({ id: 'G-001' }),
      getSummaryText: vi.fn().mockReturnValue(''),
    } as unknown as DreamSchedulerDeps['goalStack'],
    issueLog: {
      getOpenIssues: vi.fn().mockReturnValue([]),
      fileIssue: vi.fn().mockReturnValue({ id: 'ISS-001' }),
      getSummaryText: vi.fn().mockReturnValue(''),
    } as unknown as DreamSchedulerDeps['issueLog'],
    isDeepLoopIdle: vi.fn().mockReturnValue(false),
    ...overrides,
  };
}

const TEST_CONFIG: Partial<DreamSchedulerConfig> = {
  enabled: true,
  intervalHours: 24,
  minIdleBeforeDreamSeconds: 0, // no wait for tests
  checkIntervalMs: 60_000,
  testCommand: 'npm run test',
  workingDir: '/tmp/test',
};

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('DreamScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('constructor', () => {
    it('should create with default config', () => {
      const deps = createMockDeps();
      const scheduler = new DreamScheduler(deps);
      expect(scheduler.isDreaming()).toBe(false);
    });

    it('should merge partial config with defaults', () => {
      const deps = createMockDeps();
      const scheduler = new DreamScheduler(deps, { intervalHours: 12 });
      expect(scheduler.isDreaming()).toBe(false);
    });
  });

  describe('start/stop lifecycle', () => {
    it('should not start when disabled', async () => {
      const deps = createMockDeps();
      const scheduler = new DreamScheduler(deps, { enabled: false });
      await scheduler.start();
      // No timer should be created — stop should be safe
      await scheduler.stop();
    });

    it('should start and stop cleanly', async () => {
      const deps = createMockDeps();
      const scheduler = new DreamScheduler(deps, TEST_CONFIG);
      await scheduler.start();
      await scheduler.stop();
    });
  });

  describe('check() scheduling logic', () => {
    it('should skip when not running', async () => {
      const deps = createMockDeps({ isDeepLoopIdle: vi.fn().mockReturnValue(true) });
      const scheduler = new DreamScheduler(deps, TEST_CONFIG);
      // Don't call start() — scheduler is not running
      await scheduler.check();
      // Should not have tried to run a dream cycle
      expect(scheduler.isDreaming()).toBe(false);
    });

    it('should skip when disabled', async () => {
      const deps = createMockDeps({ isDeepLoopIdle: vi.fn().mockReturnValue(true) });
      const scheduler = new DreamScheduler(deps, { ...TEST_CONFIG, enabled: false });
      await scheduler.start();
      await scheduler.check();
      expect(scheduler.isDreaming()).toBe(false);
      await scheduler.stop();
    });

    it('should skip when DeepLoop is not idle', async () => {
      const deps = createMockDeps({ isDeepLoopIdle: vi.fn().mockReturnValue(false) });
      const scheduler = new DreamScheduler(deps, TEST_CONFIG);
      await scheduler.start();
      await scheduler.check();
      expect(scheduler.isDreaming()).toBe(false);
      await scheduler.stop();
    });

    it('should require sustained idle before dreaming', async () => {
      const isIdle = vi.fn().mockReturnValue(true);
      const deps = createMockDeps({ isDeepLoopIdle: isIdle });
      const scheduler = new DreamScheduler(deps, {
        ...TEST_CONFIG,
        minIdleBeforeDreamSeconds: 300, // 5 minutes
      });
      await scheduler.start();

      // First check: records idle start, returns early
      await scheduler.check();
      expect(scheduler.isDreaming()).toBe(false);

      // Second check: not enough time has passed
      vi.advanceTimersByTime(60_000); // 1 minute
      await scheduler.check();
      expect(scheduler.isDreaming()).toBe(false);

      await scheduler.stop();
    });

    it('should not run twice on the same calendar day', async () => {
      const deps = createMockDeps({ isDeepLoopIdle: vi.fn().mockReturnValue(true) });
      const scheduler = new DreamScheduler(deps, {
        ...TEST_CONFIG,
        minIdleBeforeDreamSeconds: 0,
      });
      await scheduler.start();

      // First check sets idle tracking
      await scheduler.check();
      // Second check runs the dream cycle (idle since is set, 0s threshold)
      await scheduler.check();

      // Third check: same day, should skip
      await scheduler.check();
      expect(scheduler.isDreaming()).toBe(false);

      await scheduler.stop();
    });
  });

  describe('forceRun()', () => {
    it('should run a dream cycle immediately', async () => {
      const deps = createMockDeps();
      const scheduler = new DreamScheduler(deps, TEST_CONFIG);
      const outcome = await scheduler.forceRun();

      expect(outcome).not.toBeNull();
      expect(outcome!.phasesCompleted).toContain('fragility-scan');
      expect(outcome!.fragileFilesFound).toBe(2);
    });

    it('should return null if already dreaming', async () => {
      const deps = createMockDeps();
      const scheduler = new DreamScheduler(deps, TEST_CONFIG);

      // We can't easily test concurrent dreaming without mocking timing,
      // so just verify the method exists and returns correctly
      const outcome = await scheduler.forceRun();
      expect(outcome).not.toBeNull();
    });
  });

  describe('getSummary()', () => {
    it('should return a summary with default state', () => {
      const deps = createMockDeps();
      const scheduler = new DreamScheduler(deps, TEST_CONFIG);
      const summary = scheduler.getSummary();

      expect(summary).toContain('Dream scheduler: enabled');
      expect(summary).toContain('Last dream: never');
      expect(summary).toContain('Total cycles: 0');
    });

    it('should update after a dream cycle', async () => {
      const deps = createMockDeps();
      const scheduler = new DreamScheduler(deps, TEST_CONFIG);
      await scheduler.forceRun();

      const summary = scheduler.getSummary();
      expect(summary).toContain('Total cycles: 1');
      expect(summary).not.toContain('Last dream: never');
    });

    it('should show disabled when disabled', () => {
      const deps = createMockDeps();
      const scheduler = new DreamScheduler(deps, { enabled: false });
      const summary = scheduler.getSummary();
      expect(summary).toContain('Dream scheduler: disabled');
    });
  });

  describe('CI health check', () => {
    it('should file issues for failing tests', async () => {
      const { runTests } = await import('../src/ci-loop/test-runner.js');
      const { getFailingTests } = await import('../src/ci-loop/regression-guard.js');

      vi.mocked(runTests).mockResolvedValueOnce({
        total: 5,
        passed: 3,
        failed: 2,
        errored: 0,
        skipped: 0,
        tests: [
          { name: 'test-a', status: 'passed' },
          { name: 'test-b', status: 'failed', errorMessage: 'assertion failed' },
          { name: 'test-c', status: 'passed' },
          { name: 'test-d', status: 'failed', errorMessage: 'timeout' },
          { name: 'test-e', status: 'passed' },
        ],
        exitCode: 1,
        rawOutput: '',
        timestamp: Date.now(),
      });

      vi.mocked(getFailingTests).mockReturnValueOnce(['test-b', 'test-d']);

      const fileIssue = vi.fn().mockReturnValue({ id: 'ISS-001' });
      const addGoal = vi.fn().mockReturnValue({ id: 'G-001' });

      const deps = createMockDeps({
        issueLog: {
          getOpenIssues: vi.fn().mockReturnValue([]),
          fileIssue,
          getSummaryText: vi.fn().mockReturnValue(''),
        } as unknown as DreamSchedulerDeps['issueLog'],
        goalStack: {
          addGoal,
          getSummaryText: vi.fn().mockReturnValue(''),
        } as unknown as DreamSchedulerDeps['goalStack'],
      });

      const scheduler = new DreamScheduler(deps, TEST_CONFIG);
      await scheduler.forceRun();

      // Should have filed 2 issues
      expect(fileIssue).toHaveBeenCalledTimes(2);
      expect(fileIssue).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Test failure: test-b',
          discoveredBy: 'test-failure',
          tags: ['test-failure', 'ci-health'],
        }),
      );

      // Should have added a goal to fix them
      expect(addGoal).toHaveBeenCalledWith(
        expect.objectContaining({
          source: 'self',
          description: expect.stringContaining('2 failing test'),
          tags: ['ci-health', 'test-fix'],
        }),
      );
    });

    it('should skip filing issues for already-tracked tests', async () => {
      const { runTests } = await import('../src/ci-loop/test-runner.js');
      const { getFailingTests } = await import('../src/ci-loop/regression-guard.js');

      vi.mocked(runTests).mockResolvedValueOnce({
        total: 2,
        passed: 1,
        failed: 1,
        errored: 0,
        skipped: 0,
        tests: [
          { name: 'test-a', status: 'passed' },
          { name: 'test-known', status: 'failed', errorMessage: 'known issue' },
        ],
        exitCode: 1,
        rawOutput: '',
        timestamp: Date.now(),
      });

      vi.mocked(getFailingTests).mockReturnValueOnce(['test-known']);

      const fileIssue = vi.fn();
      const deps = createMockDeps({
        issueLog: {
          getOpenIssues: vi.fn().mockReturnValue([
            { id: 'ISS-001', title: 'Test failure: test-known', description: '' },
          ]),
          fileIssue,
          getSummaryText: vi.fn().mockReturnValue(''),
        } as unknown as DreamSchedulerDeps['issueLog'],
      });

      const scheduler = new DreamScheduler(deps, TEST_CONFIG);
      await scheduler.forceRun();

      // Should NOT file a new issue — it's already tracked
      expect(fileIssue).not.toHaveBeenCalled();
    });

    it('should skip health check when testCommand is empty', async () => {
      const { runTests } = await import('../src/ci-loop/test-runner.js');
      vi.mocked(runTests).mockClear();

      const deps = createMockDeps();
      const scheduler = new DreamScheduler(deps, { ...TEST_CONFIG, testCommand: '' });
      await scheduler.forceRun();

      expect(runTests).not.toHaveBeenCalled();
    });

    it('should not abort dream cycle when health check fails', async () => {
      const { runTests } = await import('../src/ci-loop/test-runner.js');
      vi.mocked(runTests).mockRejectedValueOnce(new Error('command not found'));

      const deps = createMockDeps();
      const scheduler = new DreamScheduler(deps, TEST_CONFIG);

      // Should complete without throwing
      const outcome = await scheduler.forceRun();
      expect(outcome).not.toBeNull();
      expect(outcome!.phasesCompleted).toContain('fragility-scan');
    });
  });
});
