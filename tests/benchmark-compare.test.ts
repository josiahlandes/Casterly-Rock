import { describe, expect, it } from 'vitest';

import { compareRuns, headToHead } from '../src/benchmark/compare.js';
import type { BenchmarkRun, AggregateScore } from '../src/benchmark/types.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeAggregate(overrides: Partial<AggregateScore> = {}): AggregateScore {
  return {
    overall: 75,
    structuralAvg: 0.8,
    toolEfficiencyAvg: 0.9,
    avgTtftMs: 200,
    avgTotalMs: 1000,
    avgEvalRate: 25,
    passRate: 0.9,
    byDifficulty: {},
    byCategory: {},
    ...overrides,
  };
}

function makeRun(overrides: Partial<BenchmarkRun> = {}): BenchmarkRun {
  return {
    id: `run-${Math.random().toString(36).substring(2, 8)}`,
    modelId: 'hermes3:70b',
    timestamp: Date.now(),
    suiteId: 'casterly-v1',
    cases: [],
    aggregate: makeAggregate(),
    ...overrides,
  };
}

// ─── compareRuns ─────────────────────────────────────────────────────────────

describe('compareRuns', () => {
  it('ranks models by overall score descending', () => {
    const runs = [
      makeRun({ modelId: 'modelA', aggregate: makeAggregate({ overall: 60 }) }),
      makeRun({ modelId: 'modelB', aggregate: makeAggregate({ overall: 85 }) }),
      makeRun({ modelId: 'modelC', aggregate: makeAggregate({ overall: 72 }) }),
    ];

    const comparison = compareRuns(runs);
    expect(comparison.rankings[0]!.modelId).toBe('modelB');
    expect(comparison.rankings[0]!.rank).toBe(1);
    expect(comparison.rankings[1]!.modelId).toBe('modelC');
    expect(comparison.rankings[1]!.rank).toBe(2);
    expect(comparison.rankings[2]!.modelId).toBe('modelA');
    expect(comparison.rankings[2]!.rank).toBe(3);
  });

  it('sets correct winner', () => {
    const runs = [
      makeRun({ modelId: 'loser', aggregate: makeAggregate({ overall: 50 }) }),
      makeRun({ modelId: 'winner', aggregate: makeAggregate({ overall: 90 }) }),
    ];

    const comparison = compareRuns(runs);
    expect(comparison.winner).toBe('winner');
  });

  it('produces category breakdowns', () => {
    const runs = [
      makeRun({
        modelId: 'modelA',
        aggregate: makeAggregate({
          byCategory: {
            conversation: { passed: 2, total: 3, avgScore: 0.8 },
            tool_use: { passed: 1, total: 2, avgScore: 0.5 },
          },
        }),
      }),
      makeRun({
        modelId: 'modelB',
        aggregate: makeAggregate({
          byCategory: {
            conversation: { passed: 3, total: 3, avgScore: 0.9 },
            tool_use: { passed: 2, total: 2, avgScore: 0.7 },
          },
        }),
      }),
    ];

    const comparison = compareRuns(runs);
    expect(comparison.byCategory['conversation']).toBeDefined();
    expect(comparison.byCategory['conversation']![0]!.modelId).toBe('modelB');
    expect(comparison.byCategory['tool_use']![0]!.modelId).toBe('modelB');
  });

  it('produces difficulty breakdowns', () => {
    const runs = [
      makeRun({
        modelId: 'fast',
        aggregate: makeAggregate({
          overall: 80,
          byDifficulty: {
            simple: { passed: 3, total: 3, avgScore: 1.0 },
            complex: { passed: 1, total: 2, avgScore: 0.5 },
          },
        }),
      }),
      makeRun({
        modelId: 'smart',
        aggregate: makeAggregate({
          overall: 70,
          byDifficulty: {
            simple: { passed: 2, total: 3, avgScore: 0.7 },
            complex: { passed: 2, total: 2, avgScore: 0.9 },
          },
        }),
      }),
    ];

    const comparison = compareRuns(runs);
    expect(comparison.byDifficulty['simple']![0]!.modelId).toBe('fast');
    expect(comparison.byDifficulty['complex']![0]!.modelId).toBe('smart');
  });

  it('single-model comparison returns rank 1', () => {
    const runs = [
      makeRun({ modelId: 'solo', aggregate: makeAggregate({ overall: 75 }) }),
    ];

    const comparison = compareRuns(runs);
    expect(comparison.rankings).toHaveLength(1);
    expect(comparison.rankings[0]!.rank).toBe(1);
    expect(comparison.winner).toBe('solo');
  });

  it('handles empty input', () => {
    const comparison = compareRuns([]);
    expect(comparison.rankings).toHaveLength(0);
    expect(comparison.winner).toBe('');
  });
});

// ─── headToHead ──────────────────────────────────────────────────────────────

describe('headToHead', () => {
  it('contains both model names', () => {
    const runA = makeRun({ modelId: 'hermes3:70b' });
    const runB = makeRun({ modelId: 'llama3.3:70b' });

    const output = headToHead(runA, runB);
    expect(output).toContain('hermes3:70b');
    expect(output).toContain('llama3.3:70b');
  });

  it('shows winner when scores differ', () => {
    const runA = makeRun({
      modelId: 'winner',
      aggregate: makeAggregate({ overall: 90 }),
    });
    const runB = makeRun({
      modelId: 'loser',
      aggregate: makeAggregate({ overall: 60 }),
    });

    const output = headToHead(runA, runB);
    expect(output).toContain('Winner: winner');
  });

  it('shows tie when scores are equal', () => {
    const runA = makeRun({
      modelId: 'modelA',
      aggregate: makeAggregate({ overall: 75 }),
    });
    const runB = makeRun({
      modelId: 'modelB',
      aggregate: makeAggregate({ overall: 75 }),
    });

    const output = headToHead(runA, runB);
    expect(output).toContain('Tie');
  });
});
