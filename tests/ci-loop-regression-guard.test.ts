import { describe, expect, it } from 'vitest';

import {
  compareTestRuns,
  formatRegressionReport,
  getPassingTests,
  getFailingTests,
} from '../src/ci-loop/regression-guard.js';
import type { TestRunResult } from '../src/ci-loop/types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeTestRun(tests: Array<{ name: string; status: 'passed' | 'failed' | 'error' | 'skipped' }>): TestRunResult {
  return {
    tests: tests.map((t) => ({ name: t.name, status: t.status })),
    total: tests.length,
    passed: tests.filter((t) => t.status === 'passed').length,
    failed: tests.filter((t) => t.status === 'failed').length,
    errored: tests.filter((t) => t.status === 'error').length,
    skipped: tests.filter((t) => t.status === 'skipped').length,
    exitCode: 0,
    rawOutput: '',
    timestamp: Date.now(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('compareTestRuns', () => {
  it('should detect regressions (previously passing, now failing)', () => {
    const prev = makeTestRun([
      { name: 'test-a', status: 'passed' },
      { name: 'test-b', status: 'passed' },
      { name: 'test-c', status: 'failed' },
    ]);
    const curr = makeTestRun([
      { name: 'test-a', status: 'passed' },
      { name: 'test-b', status: 'failed' },  // REGRESSED
      { name: 'test-c', status: 'failed' },
    ]);

    const report = compareTestRuns(prev, curr);
    expect(report.hasRegressions).toBe(true);
    expect(report.regressionCount).toBe(1);
    expect(report.regressedTests).toEqual(['test-b']);
  });

  it('should detect fixes (previously failing, now passing)', () => {
    const prev = makeTestRun([
      { name: 'test-a', status: 'failed' },
      { name: 'test-b', status: 'passed' },
    ]);
    const curr = makeTestRun([
      { name: 'test-a', status: 'passed' },  // FIXED
      { name: 'test-b', status: 'passed' },
    ]);

    const report = compareTestRuns(prev, curr);
    expect(report.hasRegressions).toBe(false);
    expect(report.fixedCount).toBe(1);
    expect(report.stablePassCount).toBe(1);
  });

  it('should detect stable tests', () => {
    const prev = makeTestRun([
      { name: 'test-a', status: 'passed' },
      { name: 'test-b', status: 'failed' },
    ]);
    const curr = makeTestRun([
      { name: 'test-a', status: 'passed' },
      { name: 'test-b', status: 'failed' },
    ]);

    const report = compareTestRuns(prev, curr);
    expect(report.hasRegressions).toBe(false);
    expect(report.stablePassCount).toBe(1);
    expect(report.stableFailCount).toBe(1);
    expect(report.fixedCount).toBe(0);
    expect(report.regressionCount).toBe(0);
  });

  it('should detect new tests', () => {
    const prev = makeTestRun([
      { name: 'test-a', status: 'passed' },
    ]);
    const curr = makeTestRun([
      { name: 'test-a', status: 'passed' },
      { name: 'test-b', status: 'passed' },  // NEW
    ]);

    const report = compareTestRuns(prev, curr);
    expect(report.newCount).toBe(1);
  });

  it('should detect removed tests', () => {
    const prev = makeTestRun([
      { name: 'test-a', status: 'passed' },
      { name: 'test-b', status: 'passed' },
    ]);
    const curr = makeTestRun([
      { name: 'test-a', status: 'passed' },
      // test-b REMOVED
    ]);

    const report = compareTestRuns(prev, curr);
    expect(report.removedCount).toBe(1);
  });

  it('should handle empty previous run', () => {
    const prev = makeTestRun([]);
    const curr = makeTestRun([
      { name: 'test-a', status: 'passed' },
      { name: 'test-b', status: 'failed' },
    ]);

    const report = compareTestRuns(prev, curr);
    expect(report.newCount).toBe(2);
    expect(report.hasRegressions).toBe(false);
  });

  it('should handle empty current run', () => {
    const prev = makeTestRun([
      { name: 'test-a', status: 'passed' },
      { name: 'test-b', status: 'failed' },
    ]);
    const curr = makeTestRun([]);

    const report = compareTestRuns(prev, curr);
    expect(report.removedCount).toBe(2);
  });

  it('should treat skipped tests as non-failing for regression purposes', () => {
    const prev = makeTestRun([
      { name: 'test-a', status: 'passed' },
    ]);
    const curr = makeTestRun([
      { name: 'test-a', status: 'skipped' },  // Skipped, not regressed
    ]);

    const report = compareTestRuns(prev, curr);
    expect(report.hasRegressions).toBe(false);
    expect(report.stablePassCount).toBe(1);
  });

  it('should handle complex mixed scenario', () => {
    const prev = makeTestRun([
      { name: 'test-a', status: 'passed' },
      { name: 'test-b', status: 'passed' },
      { name: 'test-c', status: 'failed' },
      { name: 'test-d', status: 'failed' },
      { name: 'test-e', status: 'passed' },
    ]);
    const curr = makeTestRun([
      { name: 'test-a', status: 'passed' },   // stable-pass
      { name: 'test-b', status: 'failed' },   // regressed
      { name: 'test-c', status: 'passed' },   // fixed
      { name: 'test-d', status: 'failed' },   // stable-fail
      // test-e removed
      { name: 'test-f', status: 'passed' },   // new
    ]);

    const report = compareTestRuns(prev, curr);
    expect(report.stablePassCount).toBe(1);
    expect(report.regressionCount).toBe(1);
    expect(report.fixedCount).toBe(1);
    expect(report.stableFailCount).toBe(1);
    expect(report.removedCount).toBe(1);
    expect(report.newCount).toBe(1);
    expect(report.hasRegressions).toBe(true);
    expect(report.regressedTests).toEqual(['test-b']);
  });
});

describe('formatRegressionReport', () => {
  it('should format a clean report with no regressions', () => {
    const prev = makeTestRun([
      { name: 'test-a', status: 'passed' },
    ]);
    const curr = makeTestRun([
      { name: 'test-a', status: 'passed' },
    ]);
    const report = compareTestRuns(prev, curr);
    const formatted = formatRegressionReport(report);

    expect(formatted).toContain('No regressions detected');
    expect(formatted).toContain('Fixed: 0');
  });

  it('should format a report with regressions', () => {
    const prev = makeTestRun([
      { name: 'test-a', status: 'passed' },
    ]);
    const curr = makeTestRun([
      { name: 'test-a', status: 'failed' },
    ]);
    const report = compareTestRuns(prev, curr);
    const formatted = formatRegressionReport(report);

    expect(formatted).toContain('WARNING');
    expect(formatted).toContain('1 regression');
    expect(formatted).toContain('test-a');
  });
});

describe('getPassingTests / getFailingTests', () => {
  it('should extract passing test names', () => {
    const result = makeTestRun([
      { name: 'test-a', status: 'passed' },
      { name: 'test-b', status: 'failed' },
      { name: 'test-c', status: 'passed' },
    ]);
    expect(getPassingTests(result)).toEqual(['test-a', 'test-c']);
  });

  it('should extract failing test names including errors', () => {
    const result = makeTestRun([
      { name: 'test-a', status: 'passed' },
      { name: 'test-b', status: 'failed' },
      { name: 'test-c', status: 'error' },
    ]);
    expect(getFailingTests(result)).toEqual(['test-b', 'test-c']);
  });
});
