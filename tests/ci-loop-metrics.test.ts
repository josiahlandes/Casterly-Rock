import { describe, expect, it } from 'vitest';

import {
  computeNormalizedChange,
  computeEvoScore,
  computeZeroRegressionRate,
  computeFullEvoScore,
  formatEvoScoreReport,
} from '../src/ci-loop/metrics.js';
import type {
  RegressionReport,
  NormalizedChange,
  CiIteration,
  TestRunResult,
} from '../src/ci-loop/types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeRegressionReport(overrides: Partial<RegressionReport>): RegressionReport {
  return {
    diffs: [],
    regressionCount: 0,
    fixedCount: 0,
    stablePassCount: 0,
    stableFailCount: 0,
    newCount: 0,
    removedCount: 0,
    hasRegressions: false,
    regressedTests: [],
    ...overrides,
  };
}

function makeTestResult(passed: number, failed: number): TestRunResult {
  const tests = [
    ...Array.from({ length: passed }, (_, i) => ({ name: `pass-${i}`, status: 'passed' as const })),
    ...Array.from({ length: failed }, (_, i) => ({ name: `fail-${i}`, status: 'failed' as const })),
  ];
  return {
    tests,
    total: passed + failed,
    passed,
    failed,
    errored: 0,
    skipped: 0,
    exitCode: failed > 0 ? 1 : 0,
    rawOutput: '',
    timestamp: Date.now(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Normalized Change
// ─────────────────────────────────────────────────────────────────────────────

describe('computeNormalizedChange', () => {
  it('should return +1 when all failing tests are fixed and none regress', () => {
    const report = makeRegressionReport({ fixedCount: 5, regressionCount: 0 });
    const nc = computeNormalizedChange(report, 5, 10, 0, 15);
    expect(nc.value).toBe(1);
  });

  it('should return -1 when all passing tests regress and none are fixed', () => {
    const report = makeRegressionReport({
      fixedCount: 0,
      regressionCount: 10,
      hasRegressions: true,
      regressedTests: Array.from({ length: 10 }, (_, i) => `test-${i}`),
    });
    const nc = computeNormalizedChange(report, 5, 10, 0, 15);
    expect(nc.value).toBe(-1);
  });

  it('should return 0 when nothing changes', () => {
    const report = makeRegressionReport({ fixedCount: 0, regressionCount: 0 });
    const nc = computeNormalizedChange(report, 5, 10, 0, 15);
    expect(nc.value).toBe(0);
  });

  it('should return 0 when fixes and regressions cancel out', () => {
    const report = makeRegressionReport({
      fixedCount: 3,
      regressionCount: 3,
      hasRegressions: true,
      regressedTests: ['a', 'b', 'c'],
    });
    const nc = computeNormalizedChange(report, 5, 10, 0, 15);
    expect(nc.value).toBe(0);
  });

  it('should compute positive NC for net improvement', () => {
    const report = makeRegressionReport({ fixedCount: 3, regressionCount: 1 });
    // net = 2, previouslyFailing = 5
    const nc = computeNormalizedChange(report, 5, 10, 0, 15);
    expect(nc.value).toBeCloseTo(0.4); // 2/5
  });

  it('should compute negative NC for net regression', () => {
    const report = makeRegressionReport({
      fixedCount: 1,
      regressionCount: 3,
      hasRegressions: true,
      regressedTests: ['a', 'b', 'c'],
    });
    // net = -2, previouslyPassing = 10
    const nc = computeNormalizedChange(report, 5, 10, 0, 15);
    expect(nc.value).toBeCloseTo(-0.2); // -2/10
  });

  it('should handle zero previously failing', () => {
    const report = makeRegressionReport({ fixedCount: 0, regressionCount: 2 });
    // net = -2, previouslyPassing = 10
    const nc = computeNormalizedChange(report, 0, 10, 0, 10);
    expect(nc.value).toBeCloseTo(-0.2);
  });

  it('should handle zero previously passing', () => {
    const report = makeRegressionReport({ fixedCount: 2, regressionCount: 0 });
    // net = 2, previouslyFailing = 10
    const nc = computeNormalizedChange(report, 10, 0, 0, 10);
    expect(nc.value).toBeCloseTo(0.2);
  });

  it('should include metadata in result', () => {
    const report = makeRegressionReport({ fixedCount: 3, regressionCount: 1 });
    const nc = computeNormalizedChange(report, 5, 10, 2, 15);
    expect(nc.iteration).toBe(2);
    expect(nc.fixed).toBe(3);
    expect(nc.regressed).toBe(1);
    expect(nc.netChange).toBe(2);
    expect(nc.totalTests).toBe(15);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// EvoScore
// ─────────────────────────────────────────────────────────────────────────────

describe('computeEvoScore', () => {
  it('should return 0 for empty changes', () => {
    expect(computeEvoScore([], 1.0)).toBe(0);
  });

  it('should return the single NC value for one iteration with gamma=1', () => {
    const ncs: NormalizedChange[] = [
      { iteration: 0, value: 0.5, fixed: 5, regressed: 0, netChange: 5, totalTests: 10 },
    ];
    expect(computeEvoScore(ncs, 1.0)).toBeCloseTo(0.5);
  });

  it('should compute equal-weight average for gamma=1', () => {
    const ncs: NormalizedChange[] = [
      { iteration: 0, value: 0.4, fixed: 4, regressed: 0, netChange: 4, totalTests: 10 },
      { iteration: 1, value: 0.6, fixed: 6, regressed: 0, netChange: 6, totalTests: 10 },
      { iteration: 2, value: 0.2, fixed: 2, regressed: 0, netChange: 2, totalTests: 10 },
    ];
    // Average: (0.4 + 0.6 + 0.2) / 3 = 0.4
    expect(computeEvoScore(ncs, 1.0)).toBeCloseTo(0.4);
  });

  it('should weight later iterations higher with gamma > 1', () => {
    const ncs: NormalizedChange[] = [
      { iteration: 0, value: 0.1, fixed: 1, regressed: 0, netChange: 1, totalTests: 10 },
      { iteration: 1, value: 0.5, fixed: 5, regressed: 0, netChange: 5, totalTests: 10 },
      { iteration: 2, value: 0.9, fixed: 9, regressed: 0, netChange: 9, totalTests: 10 },
    ];
    const gamma1Score = computeEvoScore(ncs, 1.0);
    const gamma2Score = computeEvoScore(ncs, 2.0);

    // With gamma > 1, later (higher value) iterations get more weight
    expect(gamma2Score).toBeGreaterThan(gamma1Score);
  });

  it('should weight earlier iterations higher with gamma < 1', () => {
    const ncs: NormalizedChange[] = [
      { iteration: 0, value: 0.9, fixed: 9, regressed: 0, netChange: 9, totalTests: 10 },
      { iteration: 1, value: 0.5, fixed: 5, regressed: 0, netChange: 5, totalTests: 10 },
      { iteration: 2, value: 0.1, fixed: 1, regressed: 0, netChange: 1, totalTests: 10 },
    ];
    const gamma1Score = computeEvoScore(ncs, 1.0);
    const gammaHalfScore = computeEvoScore(ncs, 0.5);

    // With gamma < 1, earlier (higher value) iterations get more weight
    expect(gammaHalfScore).toBeGreaterThan(gamma1Score);
  });

  it('should handle negative NC values', () => {
    const ncs: NormalizedChange[] = [
      { iteration: 0, value: 0.5, fixed: 5, regressed: 0, netChange: 5, totalTests: 10 },
      { iteration: 1, value: -0.3, fixed: 0, regressed: 3, netChange: -3, totalTests: 10 },
    ];
    const score = computeEvoScore(ncs, 1.0);
    // Average: (0.5 + -0.3) / 2 = 0.1
    expect(score).toBeCloseTo(0.1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Zero-Regression Rate
// ─────────────────────────────────────────────────────────────────────────────

describe('computeZeroRegressionRate', () => {
  it('should return 1 for empty reports', () => {
    expect(computeZeroRegressionRate([])).toBe(1);
  });

  it('should return 1 when no iterations have regressions', () => {
    const reports = [
      makeRegressionReport({ hasRegressions: false }),
      makeRegressionReport({ hasRegressions: false }),
      makeRegressionReport({ hasRegressions: false }),
    ];
    expect(computeZeroRegressionRate(reports)).toBe(1);
  });

  it('should return 0 when all iterations have regressions', () => {
    const reports = [
      makeRegressionReport({ hasRegressions: true }),
      makeRegressionReport({ hasRegressions: true }),
    ];
    expect(computeZeroRegressionRate(reports)).toBe(0);
  });

  it('should compute correct rate for mixed results', () => {
    const reports = [
      makeRegressionReport({ hasRegressions: false }),
      makeRegressionReport({ hasRegressions: true }),
      makeRegressionReport({ hasRegressions: false }),
      makeRegressionReport({ hasRegressions: true }),
    ];
    expect(computeZeroRegressionRate(reports)).toBe(0.5);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Full EvoScore
// ─────────────────────────────────────────────────────────────────────────────

describe('computeFullEvoScore', () => {
  it('should compute EvoScore from iterations', () => {
    const iterations: CiIteration[] = [
      {
        index: 0,
        status: 'completed',
        preTestResult: makeTestResult(5, 5),
        postTestResult: makeTestResult(7, 3),
        regressionReport: makeRegressionReport({ fixedCount: 2, regressionCount: 0 }),
        startedAt: 0,
        completedAt: 100,
        durationMs: 100,
      },
      {
        index: 1,
        status: 'completed',
        preTestResult: makeTestResult(7, 3),
        postTestResult: makeTestResult(9, 1),
        regressionReport: makeRegressionReport({ fixedCount: 2, regressionCount: 0 }),
        startedAt: 100,
        completedAt: 200,
        durationMs: 100,
      },
    ];

    const result = computeFullEvoScore(iterations, 1.0);
    expect(result.totalIterations).toBe(2);
    expect(result.normalizedChanges).toHaveLength(2);
    expect(result.zeroRegressionRate).toBe(1);
    expect(result.score).toBeGreaterThan(0);
    expect(result.initialPassRate).toBeCloseTo(0.5);
    expect(result.finalPassRate).toBeCloseTo(0.9);
  });

  it('should handle iterations without post-test results', () => {
    const iterations: CiIteration[] = [
      {
        index: 0,
        status: 'completed',
        preTestResult: makeTestResult(5, 5),
        startedAt: 0,
        completedAt: 100,
      },
    ];

    const result = computeFullEvoScore(iterations, 1.0);
    expect(result.normalizedChanges).toHaveLength(0);
    expect(result.score).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Report Formatting
// ─────────────────────────────────────────────────────────────────────────────

describe('formatEvoScoreReport', () => {
  it('should produce a readable report', () => {
    const iterations: CiIteration[] = [
      {
        index: 0,
        status: 'completed',
        preTestResult: makeTestResult(5, 5),
        postTestResult: makeTestResult(8, 2),
        regressionReport: makeRegressionReport({ fixedCount: 3, regressionCount: 0 }),
        startedAt: 0,
        completedAt: 100,
        durationMs: 100,
      },
    ];

    const result = computeFullEvoScore(iterations, 1.5);
    const report = formatEvoScoreReport(result);

    expect(report).toContain('EvoScore Report');
    expect(report).toContain('γ = 1.5');
    expect(report).toContain('Zero-Regression Rate');
    expect(report).toContain('Iteration');
  });
});
