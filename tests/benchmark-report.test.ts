import { describe, expect, it } from 'vitest';

import { formatRunSummary, formatComparison, formatRunAsJson } from '../src/benchmark/report.js';
import { compareRuns, headToHead } from '../src/benchmark/compare.js';
import type { BenchmarkRun, AggregateScore, CaseResult } from '../src/benchmark/types.js';
import type { Comparison } from '../src/benchmark/compare.js';

// ─── Test Helpers ────────────────────────────────────────────────────────────

function makeAggregate(overrides: Partial<AggregateScore> = {}): AggregateScore {
  return {
    overall: 85,
    structuralAvg: 0.9,
    toolEfficiencyAvg: 0.85,
    avgTtftMs: 120,
    avgTotalMs: 1500,
    avgEvalRate: 35.5,
    passRate: 0.8,
    byDifficulty: {},
    byCategory: {},
    ...overrides,
  };
}

function makeCaseResult(overrides: Partial<CaseResult> = {}): CaseResult {
  return {
    caseId: 'case-1',
    passed: true,
    structuralScore: 0.95,
    toolEfficiency: 0.9,
    tokensInput: 100,
    tokensOutput: 50,
    ttftMs: 100,
    totalMs: 800,
    evalRate: 40,
    failures: [],
    ...overrides,
  };
}

function makeRun(overrides: Partial<BenchmarkRun> = {}): BenchmarkRun {
  return {
    id: 'run-001',
    modelId: 'qwen3.5:122b',
    timestamp: Date.now(),
    suiteId: 'default',
    cases: [],
    aggregate: makeAggregate(),
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// formatRunSummary
// ═══════════════════════════════════════════════════════════════════════════════

describe('formatRunSummary', () => {
  it('includes model ID and suite', () => {
    const run = makeRun({ modelId: 'qwen3-coder-next:latest', suiteId: 'coding-suite' });
    const output = formatRunSummary(run);
    expect(output).toContain('qwen3-coder-next:latest');
    expect(output).toContain('coding-suite');
  });

  it('includes overall score', () => {
    const run = makeRun({ aggregate: makeAggregate({ overall: 92 }) });
    const output = formatRunSummary(run);
    expect(output).toContain('92/100');
  });

  it('includes pass rate as percentage', () => {
    const run = makeRun({ aggregate: makeAggregate({ passRate: 0.75 }) });
    const output = formatRunSummary(run);
    expect(output).toContain('75.0%');
  });

  it('includes structural avg', () => {
    const run = makeRun({ aggregate: makeAggregate({ structuralAvg: 0.876 }) });
    const output = formatRunSummary(run);
    expect(output).toContain('0.876');
  });

  it('includes TTFT and total ms', () => {
    const run = makeRun({ aggregate: makeAggregate({ avgTtftMs: 145.3, avgTotalMs: 2300.7 }) });
    const output = formatRunSummary(run);
    expect(output).toContain('145ms');
    expect(output).toContain('2301ms');
  });

  it('includes eval rate', () => {
    const run = makeRun({ aggregate: makeAggregate({ avgEvalRate: 42.3 }) });
    const output = formatRunSummary(run);
    expect(output).toContain('42.3 tok/s');
  });

  it('includes difficulty breakdown', () => {
    const run = makeRun({
      aggregate: makeAggregate({
        byDifficulty: {
          simple: { passed: 3, total: 4, avgScore: 0.88 },
          complex: { passed: 1, total: 3, avgScore: 0.55 },
        },
      }),
    });
    const output = formatRunSummary(run);
    expect(output).toContain('simple');
    expect(output).toContain('3/4');
    expect(output).toContain('complex');
    expect(output).toContain('1/3');
  });

  it('includes category breakdown', () => {
    const run = makeRun({
      aggregate: makeAggregate({
        byCategory: {
          coding: { passed: 5, total: 6, avgScore: 0.91 },
        },
      }),
    });
    const output = formatRunSummary(run);
    expect(output).toContain('coding');
    expect(output).toContain('5/6');
  });

  it('includes individual case results', () => {
    const run = makeRun({
      cases: [
        makeCaseResult({ caseId: 'test-case-A', passed: true, structuralScore: 0.95, toolEfficiency: 0.8, totalMs: 500 }),
        makeCaseResult({ caseId: 'test-case-B', passed: false, structuralScore: 0.3, failures: ['Missing output field'] }),
      ],
    });
    const output = formatRunSummary(run);
    expect(output).toContain('test-case-A');
    expect(output).toContain('test-case-B');
    expect(output).toContain('Missing output field');
  });

  it('handles empty cases', () => {
    const run = makeRun({ cases: [] });
    const output = formatRunSummary(run);
    expect(output).toContain('85/100'); // still shows aggregate
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// formatRunAsJson
// ═══════════════════════════════════════════════════════════════════════════════

describe('formatRunAsJson', () => {
  it('returns valid JSON string', () => {
    const run = makeRun();
    const json = formatRunAsJson(run);
    const parsed = JSON.parse(json);
    expect(parsed.modelId).toBe('qwen3.5:122b');
    expect(parsed.aggregate.overall).toBe(85);
  });

  it('is pretty-printed', () => {
    const run = makeRun();
    const json = formatRunAsJson(run);
    expect(json).toContain('\n');
    expect(json).toContain('  ');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// compareRuns
// ═══════════════════════════════════════════════════════════════════════════════

describe('compareRuns', () => {
  it('returns empty comparison for no runs', () => {
    const comparison = compareRuns([]);
    expect(comparison.rankings).toEqual([]);
    expect(comparison.winner).toBe('');
    expect(comparison.byCategory).toEqual({});
    expect(comparison.byDifficulty).toEqual({});
  });

  it('ranks single run as winner', () => {
    const comparison = compareRuns([makeRun({ modelId: 'alpha' })]);
    expect(comparison.rankings.length).toBe(1);
    expect(comparison.rankings[0]!.modelId).toBe('alpha');
    expect(comparison.rankings[0]!.rank).toBe(1);
    expect(comparison.winner).toBe('alpha');
  });

  it('ranks by overall score descending', () => {
    const comparison = compareRuns([
      makeRun({ modelId: 'low', aggregate: makeAggregate({ overall: 60 }) }),
      makeRun({ modelId: 'high', aggregate: makeAggregate({ overall: 95 }) }),
      makeRun({ modelId: 'mid', aggregate: makeAggregate({ overall: 80 }) }),
    ]);
    expect(comparison.rankings[0]!.modelId).toBe('high');
    expect(comparison.rankings[0]!.rank).toBe(1);
    expect(comparison.rankings[1]!.modelId).toBe('mid');
    expect(comparison.rankings[1]!.rank).toBe(2);
    expect(comparison.rankings[2]!.modelId).toBe('low');
    expect(comparison.rankings[2]!.rank).toBe(3);
    expect(comparison.winner).toBe('high');
  });

  it('produces category rankings', () => {
    const comparison = compareRuns([
      makeRun({
        modelId: 'alpha',
        aggregate: makeAggregate({
          overall: 80,
          byCategory: { coding: { passed: 3, total: 5, avgScore: 0.6 } },
        }),
      }),
      makeRun({
        modelId: 'beta',
        aggregate: makeAggregate({
          overall: 70,
          byCategory: { coding: { passed: 4, total: 5, avgScore: 0.8 } },
        }),
      }),
    ]);
    expect(comparison.byCategory.coding).toBeDefined();
    expect(comparison.byCategory.coding!.length).toBe(2);
    // Beta has higher avgScore in coding
    expect(comparison.byCategory.coding![0]!.modelId).toBe('beta');
  });

  it('produces difficulty rankings', () => {
    const comparison = compareRuns([
      makeRun({
        modelId: 'alpha',
        aggregate: makeAggregate({
          overall: 80,
          byDifficulty: { simple: { passed: 5, total: 5, avgScore: 1.0 } },
        }),
      }),
      makeRun({
        modelId: 'beta',
        aggregate: makeAggregate({
          overall: 70,
          byDifficulty: { simple: { passed: 3, total: 5, avgScore: 0.6 } },
        }),
      }),
    ]);
    expect(comparison.byDifficulty.simple).toBeDefined();
    expect(comparison.byDifficulty.simple![0]!.modelId).toBe('alpha');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// headToHead
// ═══════════════════════════════════════════════════════════════════════════════

describe('headToHead', () => {
  it('includes both model names', () => {
    const output = headToHead(
      makeRun({ modelId: 'alpha' }),
      makeRun({ modelId: 'beta' }),
    );
    expect(output).toContain('alpha');
    expect(output).toContain('beta');
  });

  it('includes key metrics', () => {
    const output = headToHead(
      makeRun({ aggregate: makeAggregate({ overall: 90, passRate: 0.9 }) }),
      makeRun({ aggregate: makeAggregate({ overall: 75, passRate: 0.7 }) }),
    );
    expect(output).toContain('Overall Score');
    expect(output).toContain('Pass Rate');
    expect(output).toContain('90/100');
    expect(output).toContain('75/100');
  });

  it('declares winner with higher overall score', () => {
    const output = headToHead(
      makeRun({ modelId: 'alpha', aggregate: makeAggregate({ overall: 90 }) }),
      makeRun({ modelId: 'beta', aggregate: makeAggregate({ overall: 75 }) }),
    );
    expect(output).toContain('Winner: alpha');
  });

  it('declares second model winner when it scores higher', () => {
    const output = headToHead(
      makeRun({ modelId: 'alpha', aggregate: makeAggregate({ overall: 60 }) }),
      makeRun({ modelId: 'beta', aggregate: makeAggregate({ overall: 90 }) }),
    );
    expect(output).toContain('Winner: beta');
  });

  it('declares tie when scores are equal', () => {
    const output = headToHead(
      makeRun({ aggregate: makeAggregate({ overall: 80 }) }),
      makeRun({ aggregate: makeAggregate({ overall: 80 }) }),
    );
    expect(output).toContain('Tie');
  });

  it('includes TTFT and eval rate', () => {
    const output = headToHead(
      makeRun({ aggregate: makeAggregate({ avgTtftMs: 100, avgEvalRate: 40.5 }) }),
      makeRun({ aggregate: makeAggregate({ avgTtftMs: 200, avgEvalRate: 25.3 }) }),
    );
    expect(output).toContain('Avg TTFT');
    expect(output).toContain('Eval Rate');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// formatComparison
// ═══════════════════════════════════════════════════════════════════════════════

describe('formatComparison', () => {
  it('includes MODEL COMPARISON header', () => {
    const comparison: Comparison = { rankings: [], winner: '', byCategory: {}, byDifficulty: {} };
    const output = formatComparison(comparison);
    expect(output).toContain('MODEL COMPARISON');
  });

  it('shows rankings table', () => {
    const comparison: Comparison = {
      rankings: [
        { modelId: 'alpha', overall: 95, rank: 1 },
        { modelId: 'beta', overall: 80, rank: 2 },
      ],
      winner: 'alpha',
      byCategory: {},
      byDifficulty: {},
    };
    const output = formatComparison(comparison);
    expect(output).toContain('alpha');
    expect(output).toContain('95/100');
    expect(output).toContain('beta');
    expect(output).toContain('80/100');
  });

  it('shows winner', () => {
    const comparison: Comparison = {
      rankings: [{ modelId: 'alpha', overall: 95, rank: 1 }],
      winner: 'alpha',
      byCategory: {},
      byDifficulty: {},
    };
    const output = formatComparison(comparison);
    expect(output).toContain('Winner: alpha');
  });

  it('omits winner line when empty', () => {
    const comparison: Comparison = {
      rankings: [],
      winner: '',
      byCategory: {},
      byDifficulty: {},
    };
    const output = formatComparison(comparison);
    expect(output).not.toContain('Winner:');
  });

  it('shows category breakdown', () => {
    const comparison: Comparison = {
      rankings: [],
      winner: '',
      byCategory: {
        coding: [
          { modelId: 'alpha', overall: 90, rank: 1 },
          { modelId: 'beta', overall: 70, rank: 2 },
        ],
      },
      byDifficulty: {},
    };
    const output = formatComparison(comparison);
    expect(output).toContain('By Category:');
    expect(output).toContain('coding');
    expect(output).toContain('alpha > beta');
  });

  it('shows difficulty breakdown', () => {
    const comparison: Comparison = {
      rankings: [],
      winner: '',
      byCategory: {},
      byDifficulty: {
        simple: [
          { modelId: 'beta', overall: 95, rank: 1 },
          { modelId: 'alpha', overall: 80, rank: 2 },
        ],
      },
    };
    const output = formatComparison(comparison);
    expect(output).toContain('By Difficulty:');
    expect(output).toContain('simple');
    expect(output).toContain('beta > alpha');
  });
});
