import { describe, expect, it } from 'vitest';

import {
  scoreCase,
  aggregateScores,
  countChecks,
  normalizeEvalRate,
} from '../src/benchmark/scorer.js';
import type { TestResult } from '../src/testing/test-cases.js';
import type { BenchmarkCase, CaseResult } from '../src/benchmark/types.js';
import type { PerformanceMetrics } from '../src/benchmark/metrics.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeMetrics(overrides: Partial<PerformanceMetrics> = {}): PerformanceMetrics {
  return {
    tokensInput: 100,
    tokensOutput: 50,
    ttftMs: 200,
    totalMs: 1000,
    evalRate: 25,
    ...overrides,
  };
}

function makeBenchmarkCase(overrides: Partial<BenchmarkCase> = {}): BenchmarkCase {
  return {
    id: 'test-case',
    name: 'Test Case',
    description: 'A test case',
    input: 'test input',
    expected: {
      shouldSucceed: true,
      shouldCallTools: true,
      expectedToolNames: ['bash'],
      responseContains: ['result'],
    },
    difficulty: 'simple',
    category: 'tool_use',
    optimalToolCalls: 1,
    ...overrides,
  };
}

function makeTestResult(overrides: Partial<TestResult> = {}): TestResult {
  return {
    testCase: makeBenchmarkCase(),
    passed: true,
    failures: [],
    warnings: [],
    actualOutcome: {
      provider: 'local',
      model: 'test-model',
      toolsCalled: ['bash'],
      toolCallCount: 1,
      response: 'result done',
      durationMs: 1000,
      error: null,
    },
    trace: null,
    ...overrides,
  };
}

// ─── countChecks ─────────────────────────────────────────────────────────────

describe('countChecks', () => {
  it('counts shouldSucceed as 1 check', () => {
    expect(countChecks({ shouldSucceed: true })).toBe(1);
  });

  it('counts shouldCallTools as 1 check', () => {
    expect(countChecks({ shouldCallTools: true })).toBe(1);
  });

  it('counts each expectedToolName', () => {
    expect(countChecks({ expectedToolNames: ['bash', 'read_file'] })).toBe(2);
  });

  it('counts toolCallCount min and max separately', () => {
    expect(countChecks({ toolCallCount: { min: 1, max: 3 } })).toBe(2);
    expect(countChecks({ toolCallCount: { min: 1 } })).toBe(1);
  });

  it('counts responsePattern as 1', () => {
    expect(countChecks({ responsePattern: /test/ })).toBe(1);
  });

  it('counts responseExcludePattern as 1', () => {
    expect(countChecks({ responseExcludePattern: /error/ })).toBe(1);
  });

  it('counts each responseContains keyword', () => {
    expect(countChecks({ responseContains: ['foo', 'bar', 'baz'] })).toBe(3);
  });

  it('counts maxDurationMs as 1', () => {
    expect(countChecks({ maxDurationMs: 5000 })).toBe(1);
  });

  it('counts multiple checks together', () => {
    expect(countChecks({
      shouldSucceed: true,
      shouldCallTools: true,
      expectedToolNames: ['bash'],
      responseContains: ['result'],
    })).toBe(4);
  });

  it('returns 0 for empty expected', () => {
    expect(countChecks({})).toBe(0);
  });
});

// ─── normalizeEvalRate ───────────────────────────────────────────────────────

describe('normalizeEvalRate', () => {
  it('returns 0 at minimum rate (5 tok/s)', () => {
    expect(normalizeEvalRate(5)).toBe(0);
  });

  it('returns 1 at maximum rate (50 tok/s)', () => {
    expect(normalizeEvalRate(50)).toBe(1);
  });

  it('returns ~0.44 at 25 tok/s', () => {
    const result = normalizeEvalRate(25);
    expect(result).toBeCloseTo(0.444, 2);
  });

  it('clamps below minimum to 0', () => {
    expect(normalizeEvalRate(2)).toBe(0);
  });

  it('clamps above maximum to 1', () => {
    expect(normalizeEvalRate(100)).toBe(1);
  });
});

// ─── scoreCase ───────────────────────────────────────────────────────────────

describe('scoreCase', () => {
  it('all checks passing gives structuralScore 1.0', () => {
    const bc = makeBenchmarkCase();
    const tr = makeTestResult();
    const result = scoreCase(bc, tr, makeMetrics());

    expect(result.structuralScore).toBe(1);
    expect(result.passed).toBe(true);
  });

  it('half checks failing gives structuralScore 0.5', () => {
    const bc = makeBenchmarkCase({
      expected: {
        shouldSucceed: true,
        shouldCallTools: true,
        expectedToolNames: ['bash'],
        responseContains: ['result'],
      },
    });
    // 4 checks total, 2 failures → 0.5
    const tr = makeTestResult({
      failures: [
        'Expected tool "bash" not called',
        'Response does not contain "result"',
      ],
    });
    const result = scoreCase(bc, tr, makeMetrics());

    expect(result.structuralScore).toBe(0.5);
  });

  it('optimal tool calls gives toolEfficiency 1.0', () => {
    const bc = makeBenchmarkCase({ optimalToolCalls: 2 });
    const tr = makeTestResult({
      actualOutcome: {
        provider: 'local',
        model: 'test',
        toolsCalled: ['bash', 'bash'],
        toolCallCount: 2,
        response: 'result',
        durationMs: 1000,
        error: null,
      },
    });
    const result = scoreCase(bc, tr, makeMetrics());

    expect(result.toolEfficiency).toBe(1);
  });

  it('more tool calls than optimal gives toolEfficiency < 1.0', () => {
    const bc = makeBenchmarkCase({ optimalToolCalls: 2 });
    const tr = makeTestResult({
      actualOutcome: {
        provider: 'local',
        model: 'test',
        toolsCalled: ['bash', 'bash', 'bash', 'bash'],
        toolCallCount: 4,
        response: 'result',
        durationMs: 1000,
        error: null,
      },
    });
    const result = scoreCase(bc, tr, makeMetrics());

    expect(result.toolEfficiency).toBe(0.5);
  });

  it('no tool expectations gives toolEfficiency 1.0', () => {
    const bc = makeBenchmarkCase({ optimalToolCalls: undefined });
    const tr = makeTestResult();
    const result = scoreCase(bc, tr, makeMetrics());

    expect(result.toolEfficiency).toBe(1);
  });

  it('zero actual tool calls when expected gives toolEfficiency 0', () => {
    const bc = makeBenchmarkCase({ optimalToolCalls: 2 });
    const tr = makeTestResult({
      actualOutcome: {
        provider: 'local',
        model: 'test',
        toolsCalled: [],
        toolCallCount: 0,
        response: 'result',
        durationMs: 1000,
        error: null,
      },
    });
    const result = scoreCase(bc, tr, makeMetrics());

    expect(result.toolEfficiency).toBe(0);
  });

  it('passes through performance metrics', () => {
    const metrics = makeMetrics({
      tokensInput: 200,
      tokensOutput: 100,
      ttftMs: 300,
      totalMs: 2000,
      evalRate: 30,
    });
    const result = scoreCase(makeBenchmarkCase(), makeTestResult(), metrics);

    expect(result.tokensInput).toBe(200);
    expect(result.tokensOutput).toBe(100);
    expect(result.ttftMs).toBe(300);
    expect(result.totalMs).toBe(2000);
    expect(result.evalRate).toBe(30);
  });

  it('no checks defined gives structuralScore 1.0', () => {
    const bc = makeBenchmarkCase({ expected: {} });
    const tr = makeTestResult();
    const result = scoreCase(bc, tr, makeMetrics());

    expect(result.structuralScore).toBe(1);
  });
});

// ─── aggregateScores ─────────────────────────────────────────────────────────

describe('aggregateScores', () => {
  function makeCaseResult(overrides: Partial<CaseResult> = {}): CaseResult {
    return {
      caseId: 'test-case',
      passed: true,
      structuralScore: 1,
      toolEfficiency: 1,
      tokensInput: 100,
      tokensOutput: 50,
      ttftMs: 200,
      totalMs: 1000,
      evalRate: 25,
      failures: [],
      ...overrides,
    };
  }

  it('produces correct weighted overall score', () => {
    const cases: CaseResult[] = [
      makeCaseResult({ structuralScore: 1.0, toolEfficiency: 1.0, evalRate: 50 }),
    ];
    const suite: BenchmarkCase[] = [
      makeBenchmarkCase({ id: 'test-case' }),
    ];

    const agg = aggregateScores(cases, suite);
    // structural=1.0*0.4 + toolEff=1.0*0.3 + perf=1.0*0.3 = 1.0 → 100
    expect(agg.overall).toBe(100);
  });

  it('handles mixed scores', () => {
    const cases: CaseResult[] = [
      makeCaseResult({ caseId: 'a', structuralScore: 0.5, toolEfficiency: 0.5, evalRate: 5 }),
      makeCaseResult({ caseId: 'b', structuralScore: 1.0, toolEfficiency: 1.0, evalRate: 50 }),
    ];
    const suite: BenchmarkCase[] = [
      makeBenchmarkCase({ id: 'a', difficulty: 'simple', category: 'tool_use' }),
      makeBenchmarkCase({ id: 'b', difficulty: 'moderate', category: 'knowledge' }),
    ];

    const agg = aggregateScores(cases, suite);
    // structural avg = 0.75, toolEff avg = 0.75
    // eval rate avg = 27.5, normalized = (27.5-5)/(50-5) = 0.5
    // overall = (0.75*0.4 + 0.75*0.3 + 0.5*0.3) * 100 = (0.3 + 0.225 + 0.15) * 100 = 68 (rounded)
    expect(agg.structuralAvg).toBe(0.75);
    expect(agg.toolEfficiencyAvg).toBe(0.75);
    expect(agg.overall).toBe(68);
  });

  it('produces correct byDifficulty breakdowns', () => {
    const cases: CaseResult[] = [
      makeCaseResult({ caseId: 'a', passed: true, structuralScore: 1.0 }),
      makeCaseResult({ caseId: 'b', passed: false, structuralScore: 0.5 }),
    ];
    const suite: BenchmarkCase[] = [
      makeBenchmarkCase({ id: 'a', difficulty: 'simple' }),
      makeBenchmarkCase({ id: 'b', difficulty: 'simple' }),
    ];

    const agg = aggregateScores(cases, suite);
    expect(agg.byDifficulty['simple']).toEqual({
      passed: 1,
      total: 2,
      avgScore: 0.75,
    });
  });

  it('produces correct byCategory breakdowns', () => {
    const cases: CaseResult[] = [
      makeCaseResult({ caseId: 'a', passed: true, structuralScore: 0.8 }),
      makeCaseResult({ caseId: 'b', passed: true, structuralScore: 0.6 }),
    ];
    const suite: BenchmarkCase[] = [
      makeBenchmarkCase({ id: 'a', category: 'conversation' }),
      makeBenchmarkCase({ id: 'b', category: 'tool_use' }),
    ];

    const agg = aggregateScores(cases, suite);
    expect(agg.byCategory['conversation']).toEqual({
      passed: 1,
      total: 1,
      avgScore: 0.8,
    });
    expect(agg.byCategory['tool_use']).toEqual({
      passed: 1,
      total: 1,
      avgScore: 0.6,
    });
  });

  it('returns zeroed aggregate for empty cases', () => {
    const agg = aggregateScores([], []);
    expect(agg.overall).toBe(0);
    expect(agg.passRate).toBe(0);
  });

  it('computes correct passRate', () => {
    const cases: CaseResult[] = [
      makeCaseResult({ caseId: 'a', passed: true }),
      makeCaseResult({ caseId: 'b', passed: false }),
      makeCaseResult({ caseId: 'c', passed: true }),
    ];
    const suite: BenchmarkCase[] = [
      makeBenchmarkCase({ id: 'a' }),
      makeBenchmarkCase({ id: 'b' }),
      makeBenchmarkCase({ id: 'c' }),
    ];

    const agg = aggregateScores(cases, suite);
    expect(agg.passRate).toBeCloseTo(2 / 3, 5);
  });
});
