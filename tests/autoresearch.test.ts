import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  AutoresearchEngine,
} from '../src/autonomous/dream/autoresearch.js';
import type {
  Hypothesis,
  TestRunner,
  ChangeApplier,
} from '../src/autonomous/dream/autoresearch.js';
import type { TestRunResult } from '../src/ci-loop/types.js';

// Mock fs
vi.mock('node:fs/promises', () => ({
  readFile: vi.fn().mockRejectedValue(new Error('ENOENT')),
  writeFile: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
}));

// Mock child_process (git operations)
vi.mock('node:child_process', () => ({
  execSync: vi.fn().mockReturnValue(Buffer.from('')),
}));

// Mock tracer
vi.mock('../src/autonomous/debug.js', () => ({
  getTracer: () => ({
    log: vi.fn(),
    withSpan: vi.fn(),
    withSpanSync: vi.fn(),
  }),
}));

function makeTestResult(overrides: Partial<TestRunResult> = {}): TestRunResult {
  return {
    tests: [
      { name: 'test-a', status: 'passed' },
      { name: 'test-b', status: 'passed' },
      { name: 'test-c', status: 'passed' },
    ],
    total: 3,
    passed: 3,
    failed: 0,
    errored: 0,
    skipped: 0,
    exitCode: 0,
    rawOutput: '',
    timestamp: Date.now(),
    ...overrides,
  };
}

function makeHypothesis(overrides: Partial<Hypothesis> = {}): Hypothesis {
  return {
    id: 'hyp-1',
    title: 'Fix test-b',
    description: 'Fix the failing test-b',
    targetFiles: ['src/foo.ts'],
    expectedOutcome: 'test-b passes',
    source: 'test-failure',
    ...overrides,
  };
}

describe('AutoresearchEngine', () => {
  let engine: AutoresearchEngine;

  beforeEach(async () => {
    engine = new AutoresearchEngine({
      maxExperimentsPerCycle: 3,
      testTimeoutMs: 30_000,
      testCommand: 'npm test',
      workingDir: '/tmp/test',
      allowedDirectories: ['src/', 'tests/'],
      forbiddenPatterns: ['src/security/*'],
      useGitStash: false, // Disable git for tests
    });
    await engine.loadLog();
  });

  describe('runExperiment()', () => {
    it('should accept experiments with no regressions', async () => {
      const testRunner: TestRunner = vi.fn()
        .mockResolvedValueOnce(makeTestResult()) // pre-test: 3/3 pass
        .mockResolvedValueOnce(makeTestResult({  // post-test: 4/4 pass (1 new test)
          tests: [
            { name: 'test-a', status: 'passed' },
            { name: 'test-b', status: 'passed' },
            { name: 'test-c', status: 'passed' },
            { name: 'test-d', status: 'passed' },
          ],
          total: 4,
          passed: 4,
        }));

      const changeApplier: ChangeApplier = vi.fn().mockResolvedValue({
        success: true,
        modifiedFiles: ['src/foo.ts'],
      });

      const result = await engine.runExperiment(
        makeHypothesis(),
        testRunner,
        changeApplier,
      );

      expect(result.outcome).toBe('accepted');
      expect(result.netTestChange).toBe(1);
      expect(result.hasRegressions).toBe(false);
    });

    it('should revert experiments with regressions', async () => {
      const testRunner: TestRunner = vi.fn()
        .mockResolvedValueOnce(makeTestResult()) // pre: 3/3 pass
        .mockResolvedValueOnce(makeTestResult({  // post: test-a regressed
          tests: [
            { name: 'test-a', status: 'failed', errorMessage: 'broke' },
            { name: 'test-b', status: 'passed' },
            { name: 'test-c', status: 'passed' },
          ],
          total: 3,
          passed: 2,
          failed: 1,
        }));

      const changeApplier: ChangeApplier = vi.fn().mockResolvedValue({
        success: true,
        modifiedFiles: ['src/foo.ts'],
      });

      const result = await engine.runExperiment(
        makeHypothesis(),
        testRunner,
        changeApplier,
      );

      expect(result.outcome).toBe('reverted');
      expect(result.hasRegressions).toBe(true);
    });

    it('should revert when change application fails', async () => {
      const testRunner: TestRunner = vi.fn().mockResolvedValue(makeTestResult());

      const changeApplier: ChangeApplier = vi.fn().mockResolvedValue({
        success: false,
        modifiedFiles: [],
        error: 'Could not apply',
      });

      const result = await engine.runExperiment(
        makeHypothesis(),
        testRunner,
        changeApplier,
      );

      expect(result.outcome).toBe('reverted');
      expect(result.error).toBe('Could not apply');
    });

    it('should reject experiments targeting forbidden paths', async () => {
      const testRunner: TestRunner = vi.fn();
      const changeApplier: ChangeApplier = vi.fn();

      const result = await engine.runExperiment(
        makeHypothesis({ targetFiles: ['src/security/redactor.ts'] }),
        testRunner,
        changeApplier,
      );

      expect(result.outcome).toBe('error');
      expect(result.error).toContain('Forbidden paths');
      expect(testRunner).not.toHaveBeenCalled();
    });

    it('should reject experiments targeting paths outside allowed dirs', async () => {
      const testRunner: TestRunner = vi.fn();
      const changeApplier: ChangeApplier = vi.fn();

      const result = await engine.runExperiment(
        makeHypothesis({ targetFiles: ['config/models.yaml'] }),
        testRunner,
        changeApplier,
      );

      expect(result.outcome).toBe('error');
      expect(result.error).toContain('Forbidden paths');
    });
  });

  describe('runCycle()', () => {
    it('should run up to maxExperimentsPerCycle', async () => {
      const hypotheses = [
        makeHypothesis({ id: 'h1', title: 'Experiment 1' }),
        makeHypothesis({ id: 'h2', title: 'Experiment 2' }),
        makeHypothesis({ id: 'h3', title: 'Experiment 3' }),
        makeHypothesis({ id: 'h4', title: 'Experiment 4' }), // over limit
      ];

      const testRunner: TestRunner = vi.fn().mockResolvedValue(makeTestResult());
      const changeApplier: ChangeApplier = vi.fn().mockResolvedValue({
        success: true,
        modifiedFiles: ['src/foo.ts'],
      });

      const result = await engine.runCycle(hypotheses, testRunner, changeApplier);

      // Should only run 3 (the limit)
      expect(result.experiments).toHaveLength(3);
    });

    it('should accumulate log across cycles', async () => {
      const testRunner: TestRunner = vi.fn().mockResolvedValue(makeTestResult());
      const changeApplier: ChangeApplier = vi.fn().mockResolvedValue({
        success: true,
        modifiedFiles: ['src/foo.ts'],
      });

      // First cycle
      await engine.runCycle(
        [makeHypothesis({ id: 'h1' })],
        testRunner,
        changeApplier,
      );
      expect(engine.getLog().totalExperiments).toBe(1);

      // Second cycle
      await engine.runCycle(
        [makeHypothesis({ id: 'h2' })],
        testRunner,
        changeApplier,
      );
      expect(engine.getLog().totalExperiments).toBe(2);
    });

    it('should respect phase context shouldStop', async () => {
      let callCount = 0;
      const ctx = {
        reportProgress: vi.fn(),
        getProgress: () => 0,
        saveCheckpoint: vi.fn(),
        getCheckpoint: () => null,
        shouldStop: () => callCount >= 1, // stop after first experiment
        isResume: false,
        remainingMs: () => 10000,
      };

      const testRunner: TestRunner = vi.fn().mockResolvedValue(makeTestResult());
      const changeApplier: ChangeApplier = vi.fn().mockImplementation(async () => {
        callCount++;
        return { success: true, modifiedFiles: ['src/foo.ts'] };
      });

      const result = await engine.runCycle(
        [makeHypothesis({ id: 'h1' }), makeHypothesis({ id: 'h2' })],
        testRunner,
        changeApplier,
        ctx,
      );

      // Should stop after first due to shouldStop
      expect(result.experiments).toHaveLength(1);
    });
  });

  describe('getSummary()', () => {
    it('should return summary with no experiments', () => {
      const summary = engine.getSummary();
      expect(summary).toContain('Autoresearch: 0 total, 0 accepted');
    });

    it('should include recent experiments', async () => {
      const testRunner: TestRunner = vi.fn().mockResolvedValue(makeTestResult());
      const changeApplier: ChangeApplier = vi.fn().mockResolvedValue({
        success: true,
        modifiedFiles: ['src/foo.ts'],
      });

      await engine.runCycle(
        [makeHypothesis({ title: 'Fix widget' })],
        testRunner,
        changeApplier,
      );

      const summary = engine.getSummary();
      expect(summary).toContain('Fix widget');
      expect(summary).toContain('accepted');
    });
  });
});
