import { describe, expect, it } from 'vitest';

import {
  parseVitestJson,
  testFileToSourceModule,
  failuresToErrorLogEntries,
  failuresToObservations,
  parseCoverageSummary,
  computeCoverageDelta,
} from '../src/autonomous/test-parser.js';

// ─── Fixtures ────────────────────────────────────────────────────────────────

/** Minimal passing Vitest JSON output. */
const PASSING_JSON = JSON.stringify({
  success: true,
  numTotalTests: 5,
  numPassedTests: 5,
  numFailedTests: 0,
  numPendingTests: 0,
  startTime: 1000,
  testResults: [
    {
      name: '/project/tests/foo.test.ts',
      status: 'passed',
      endTime: 2500,
      assertionResults: [
        { fullName: 'adds numbers', ancestorTitles: ['math'], status: 'passed', title: 'adds numbers', duration: 12, failureMessages: [] },
        { fullName: 'subtracts', ancestorTitles: ['math'], status: 'passed', title: 'subtracts', duration: 8, failureMessages: [] },
      ],
    },
    {
      name: '/project/tests/bar.test.ts',
      status: 'passed',
      endTime: 3000,
      assertionResults: [
        { fullName: 'renders', ancestorTitles: ['ui'], status: 'passed', title: 'renders', duration: 45, failureMessages: [] },
        { fullName: 'clicks', ancestorTitles: ['ui'], status: 'passed', title: 'clicks', duration: 30, failureMessages: [] },
        { fullName: 'submits', ancestorTitles: ['ui'], status: 'passed', title: 'submits', duration: 22, failureMessages: [] },
      ],
    },
  ],
});

/** Vitest JSON with failures. */
const FAILING_JSON = JSON.stringify({
  success: false,
  numTotalTests: 4,
  numPassedTests: 2,
  numFailedTests: 2,
  numPendingTests: 0,
  startTime: 1000,
  testResults: [
    {
      name: '/project/tests/tool-executor.test.ts',
      status: 'failed',
      endTime: 4000,
      assertionResults: [
        { fullName: 'blocks rm', ancestorTitles: ['safety'], status: 'passed', title: 'blocks rm', duration: 5, failureMessages: [] },
        {
          fullName: 'allows echo',
          ancestorTitles: ['safety', 'commands'],
          status: 'failed',
          title: 'allows echo',
          duration: 10,
          failureMessages: ['AssertionError: expected true to be false', 'at Object.<anonymous> (/test.ts:42)'],
        },
      ],
    },
    {
      name: '/project/tests/router-classifier.test.ts',
      status: 'failed',
      endTime: 5000,
      assertionResults: [
        { fullName: 'routes local', ancestorTitles: ['router'], status: 'passed', title: 'routes local', duration: 15, failureMessages: [] },
        {
          fullName: 'routes cloud',
          ancestorTitles: ['router'],
          status: 'failed',
          title: 'routes cloud',
          duration: 20,
          failureMessages: ['Error: route was undefined'],
        },
      ],
    },
  ],
});

/** Coverage summary JSON fixture. */
const COVERAGE_JSON = JSON.stringify({
  total: {
    statements: { total: 1000, covered: 750, pct: 75, skipped: 0 },
    branches: { total: 200, covered: 140, pct: 70, skipped: 0 },
    functions: { total: 100, covered: 80, pct: 80, skipped: 0 },
    lines: { total: 900, covered: 700, pct: 77.78, skipped: 0 },
  },
  'src/tools/executor.ts': {
    statements: { total: 50, covered: 45, pct: 90, skipped: 0 },
    branches: { total: 10, covered: 8, pct: 80, skipped: 0 },
    functions: { total: 5, covered: 5, pct: 100, skipped: 0 },
    lines: { total: 48, covered: 43, pct: 89.58, skipped: 0 },
  },
  'src/router/classifier.ts': {
    statements: { total: 30, covered: 10, pct: 33.33, skipped: 0 },
    branches: { total: 8, covered: 2, pct: 25, skipped: 0 },
    functions: { total: 4, covered: 2, pct: 50, skipped: 0 },
    lines: { total: 28, covered: 9, pct: 32.14, skipped: 0 },
  },
});

// ═══════════════════════════════════════════════════════════════════════════════
// parseVitestJson
// ═══════════════════════════════════════════════════════════════════════════════

describe('parseVitestJson — passing results', () => {
  it('reports success', () => {
    const result = parseVitestJson(PASSING_JSON);
    expect(result.success).toBe(true);
  });

  it('counts total tests', () => {
    const result = parseVitestJson(PASSING_JSON);
    expect(result.summary.total).toBe(5);
    expect(result.summary.passed).toBe(5);
    expect(result.summary.failed).toBe(0);
  });

  it('captures test file results', () => {
    const result = parseVitestJson(PASSING_JSON);
    expect(result.testFiles).toHaveLength(2);
    expect(result.testFiles[0]!.passed).toBe(2);
    expect(result.testFiles[1]!.passed).toBe(3);
  });

  it('has no failures', () => {
    const result = parseVitestJson(PASSING_JSON);
    expect(result.failures).toHaveLength(0);
  });

  it('computes duration from endTime', () => {
    const result = parseVitestJson(PASSING_JSON);
    // max endTime = 3000, startTime = 1000
    expect(result.summary.durationMs).toBe(2000);
  });
});

describe('parseVitestJson — failing results', () => {
  it('reports failure', () => {
    const result = parseVitestJson(FAILING_JSON);
    expect(result.success).toBe(false);
  });

  it('counts total and failed', () => {
    const result = parseVitestJson(FAILING_JSON);
    expect(result.summary.total).toBe(4);
    expect(result.summary.passed).toBe(2);
    expect(result.summary.failed).toBe(2);
  });

  it('captures failure details', () => {
    const result = parseVitestJson(FAILING_JSON);
    expect(result.failures).toHaveLength(2);

    const first = result.failures[0]!;
    expect(first.testName).toBe('allows echo');
    expect(first.suiteName).toBe('safety > commands');
    expect(first.message).toContain('AssertionError');
    expect(first.stack).toContain('Object.<anonymous>');
  });

  it('captures second failure from different file', () => {
    const result = parseVitestJson(FAILING_JSON);
    const second = result.failures[1]!;
    expect(second.testFile).toContain('router-classifier');
    expect(second.testName).toBe('routes cloud');
    expect(second.message).toBe('Error: route was undefined');
  });

  it('sets per-file counts correctly', () => {
    const result = parseVitestJson(FAILING_JSON);
    const toolFile = result.testFiles.find((f) => f.path.includes('tool-executor'));
    expect(toolFile?.passed).toBe(1);
    expect(toolFile?.failed).toBe(1);
  });
});

describe('parseVitestJson — edge cases', () => {
  it('handles empty string', () => {
    const result = parseVitestJson('');
    expect(result.success).toBe(false);
    expect(result.summary.total).toBe(0);
    expect(result.failures).toHaveLength(0);
  });

  it('handles malformed JSON', () => {
    const result = parseVitestJson('{not valid json!!!');
    expect(result.success).toBe(false);
    expect(result.summary.total).toBe(0);
  });

  it('handles null JSON', () => {
    const result = parseVitestJson('null');
    expect(result.success).toBe(false);
  });

  it('handles JSON with missing fields', () => {
    const result = parseVitestJson('{"success": true}');
    expect(result.success).toBe(true);
    expect(result.summary.total).toBe(0);
    expect(result.testFiles).toHaveLength(0);
  });

  it('handles testResults with non-object entries', () => {
    const json = JSON.stringify({
      success: true,
      numTotalTests: 0,
      testResults: [null, 42, 'bad'],
    });
    const result = parseVitestJson(json);
    expect(result.testFiles).toHaveLength(0);
  });

  it('handles assertionResults with non-object entries', () => {
    const json = JSON.stringify({
      success: true,
      numTotalTests: 0,
      testResults: [{ name: 'test.ts', assertionResults: [null, 'bad'] }],
    });
    const result = parseVitestJson(json);
    expect(result.testFiles).toHaveLength(1);
    expect(result.testFiles[0]!.total).toBe(0);
  });

  it('skipped tests counted from numPendingTests', () => {
    const json = JSON.stringify({
      success: true,
      numTotalTests: 10,
      numPassedTests: 8,
      numFailedTests: 0,
      numPendingTests: 2,
      testResults: [],
    });
    const result = parseVitestJson(json);
    expect(result.summary.skipped).toBe(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// testFileToSourceModule
// ═══════════════════════════════════════════════════════════════════════════════

describe('testFileToSourceModule', () => {
  it('maps single-segment file', () => {
    expect(testFileToSourceModule('tests/utils.test.ts')).toBe('src/utils.ts');
  });

  it('maps two-segment file (dir-name)', () => {
    expect(testFileToSourceModule('tests/tool-executor.test.ts')).toBe('src/tool/executor.ts');
  });

  it('maps multi-segment file', () => {
    expect(testFileToSourceModule('tests/autonomous-loop.test.ts')).toBe('src/autonomous/loop.ts');
  });

  it('handles absolute paths', () => {
    expect(testFileToSourceModule('/project/tests/skills-loader.test.ts')).toBe('src/skills/loader.ts');
  });

  it('handles bare filename', () => {
    expect(testFileToSourceModule('router-classifier.test.ts')).toBe('src/router/classifier.ts');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// failuresToErrorLogEntries
// ═══════════════════════════════════════════════════════════════════════════════

describe('failuresToErrorLogEntries', () => {
  it('returns empty array for no failures', () => {
    expect(failuresToErrorLogEntries([])).toEqual([]);
  });

  it('converts a single failure', () => {
    const entries = failuresToErrorLogEntries([
      { testFile: 'test.ts', testName: 'adds', suiteName: 'math', message: 'expected 3 to be 4', durationMs: 5 },
    ]);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.code).toBe('TEST_FAILURE');
    expect(entries[0]!.message).toContain('math > adds');
    expect(entries[0]!.message).toContain('expected 3 to be 4');
    expect(entries[0]!.frequency).toBe(1);
  });

  it('converts multiple failures', () => {
    const entries = failuresToErrorLogEntries([
      { testFile: 'a.ts', testName: 'f1', suiteName: 's1', message: 'err1', durationMs: 1 },
      { testFile: 'b.ts', testName: 'f2', suiteName: 's2', message: 'err2', durationMs: 2 },
    ]);
    expect(entries).toHaveLength(2);
    expect(entries[0]!.message).toContain('s1 > f1');
    expect(entries[1]!.message).toContain('s2 > f2');
  });

  it('includes stack when present', () => {
    const entries = failuresToErrorLogEntries([
      { testFile: 'test.ts', testName: 't', suiteName: '', message: 'fail', stack: 'line 42', durationMs: 1 },
    ]);
    expect(entries[0]!.stack).toBe('line 42');
  });

  it('handles empty suite name', () => {
    const entries = failuresToErrorLogEntries([
      { testFile: 'test.ts', testName: 'standalone', suiteName: '', message: 'fail', durationMs: 1 },
    ]);
    // No " > " prefix when suite is empty
    expect(entries[0]!.message).toMatch(/^standalone: fail$/);
  });

  it('truncates long messages', () => {
    const longMsg = 'A'.repeat(200);
    const entries = failuresToErrorLogEntries([
      { testFile: 'test.ts', testName: 't', suiteName: 's', message: longMsg, durationMs: 1 },
    ]);
    expect(entries[0]!.message.length).toBeLessThan(200);
    expect(entries[0]!.message).toContain('...');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// failuresToObservations
// ═══════════════════════════════════════════════════════════════════════════════

describe('failuresToObservations', () => {
  it('returns empty for no failures', () => {
    expect(failuresToObservations([])).toEqual([]);
  });

  it('creates observation with correct type and source', () => {
    const obs = failuresToObservations([
      { testFile: 'tests/router-classifier.test.ts', testName: 'routes', suiteName: 'router', message: 'fail', durationMs: 10 },
    ]);
    expect(obs).toHaveLength(1);
    expect(obs[0]!.type).toBe('test_failure');
    expect(obs[0]!.source).toBe('test_results');
  });

  it('maps severity based on failure count', () => {
    // 1 failure → low
    const obs1 = failuresToObservations([
      { testFile: 'a.ts', testName: 't', suiteName: '', message: 'f', durationMs: 1 },
    ]);
    expect(obs1[0]!.severity).toBe('low');

    // 2 failures in same file → medium
    const obs2 = failuresToObservations([
      { testFile: 'a.ts', testName: 't1', suiteName: '', message: 'f', durationMs: 1 },
      { testFile: 'a.ts', testName: 't2', suiteName: '', message: 'f', durationMs: 1 },
    ]);
    expect(obs2[0]!.severity).toBe('medium');

    // 5 failures in same file → high
    const obs5 = failuresToObservations(
      Array.from({ length: 5 }, (_, i) => ({
        testFile: 'a.ts', testName: `t${i}`, suiteName: '', message: 'f', durationMs: 1,
      }))
    );
    expect(obs5[0]!.severity).toBe('high');
  });

  it('groups by file', () => {
    const obs = failuresToObservations([
      { testFile: 'a.ts', testName: 't1', suiteName: '', message: 'f', durationMs: 1 },
      { testFile: 'a.ts', testName: 't2', suiteName: '', message: 'f', durationMs: 1 },
      { testFile: 'b.ts', testName: 't3', suiteName: '', message: 'f', durationMs: 1 },
    ]);
    expect(obs).toHaveLength(2);
    expect(obs[0]!.frequency).toBe(2);
    expect(obs[1]!.frequency).toBe(1);
  });

  it('sets suggestedArea to source module', () => {
    const obs = failuresToObservations([
      { testFile: 'tests/tool-executor.test.ts', testName: 't', suiteName: '', message: 'f', durationMs: 1 },
    ]);
    expect(obs[0]!.suggestedArea).toBe('src/tool/executor.ts');
  });

  it('includes context fields', () => {
    const obs = failuresToObservations([
      { testFile: 'x.ts', testName: 'my test', suiteName: 'suite', message: 'oops', durationMs: 5 },
    ]);
    const ctx = obs[0]!.context as Record<string, unknown>;
    expect(ctx['testFile']).toBe('x.ts');
    expect(ctx['failedTests']).toBe('my test');
    expect(ctx['firstMessage']).toBe('oops');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// parseCoverageSummary
// ═══════════════════════════════════════════════════════════════════════════════

describe('parseCoverageSummary — normal data', () => {
  it('extracts total statement counts', () => {
    const cov = parseCoverageSummary(COVERAGE_JSON);
    expect(cov.totalStatements).toBe(1000);
    expect(cov.coveredStatements).toBe(750);
    expect(cov.percentage).toBe(75);
  });

  it('extracts per-file coverage', () => {
    const cov = parseCoverageSummary(COVERAGE_JSON);
    expect(cov.files.size).toBe(2);
    const executor = cov.files.get('src/tools/executor.ts');
    expect(executor).toBeDefined();
    expect(executor!.statements.pct).toBe(90);
    expect(executor!.functions.pct).toBe(100);
  });

  it('extracts branch coverage', () => {
    const cov = parseCoverageSummary(COVERAGE_JSON);
    const router = cov.files.get('src/router/classifier.ts');
    expect(router!.branches.pct).toBe(25);
    expect(router!.branches.covered).toBe(2);
  });
});

describe('parseCoverageSummary — edge cases', () => {
  it('handles empty string', () => {
    const cov = parseCoverageSummary('');
    expect(cov.totalStatements).toBe(0);
    expect(cov.percentage).toBe(0);
    expect(cov.files.size).toBe(0);
  });

  it('handles malformed JSON', () => {
    const cov = parseCoverageSummary('not json');
    expect(cov.totalStatements).toBe(0);
  });

  it('handles null JSON', () => {
    const cov = parseCoverageSummary('null');
    expect(cov.totalStatements).toBe(0);
  });

  it('handles missing total entry', () => {
    const json = JSON.stringify({
      'src/foo.ts': {
        statements: { total: 10, covered: 5, pct: 50 },
        branches: { total: 0, covered: 0, pct: 0 },
        functions: { total: 2, covered: 1, pct: 50 },
        lines: { total: 10, covered: 5, pct: 50 },
      },
    });
    const cov = parseCoverageSummary(json);
    // No 'total' key → totalStatements comes from parseFileCoverage(undefined) = 0
    expect(cov.totalStatements).toBe(0);
    expect(cov.files.size).toBe(1);
  });

  it('handles zero coverage', () => {
    const json = JSON.stringify({
      total: {
        statements: { total: 500, covered: 0, pct: 0 },
        branches: { total: 100, covered: 0, pct: 0 },
        functions: { total: 50, covered: 0, pct: 0 },
        lines: { total: 400, covered: 0, pct: 0 },
      },
    });
    const cov = parseCoverageSummary(json);
    expect(cov.percentage).toBe(0);
    expect(cov.coveredStatements).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// computeCoverageDelta
// ═══════════════════════════════════════════════════════════════════════════════

describe('computeCoverageDelta', () => {
  it('positive delta when coverage improved', () => {
    expect(computeCoverageDelta(70, 75)).toBe(5);
  });

  it('negative delta when coverage dropped', () => {
    expect(computeCoverageDelta(80, 75)).toBe(-5);
  });

  it('zero when unchanged', () => {
    expect(computeCoverageDelta(50, 50)).toBe(0);
  });

  it('handles fractional deltas', () => {
    expect(computeCoverageDelta(70.5, 71.3)).toBe(0.8);
  });

  it('handles zero to something', () => {
    expect(computeCoverageDelta(0, 42)).toBe(42);
  });
});
