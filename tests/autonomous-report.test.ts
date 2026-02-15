import { describe, expect, it } from 'vitest';

import { formatDailyReport } from '../src/autonomous/report.js';
import type { AggregateStats } from '../src/autonomous/reflector.js';
import type { Reflection } from '../src/autonomous/types.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

function emptyStats(): AggregateStats {
  return {
    totalCycles: 0,
    successfulCycles: 0,
    failedCycles: 0,
    totalTokensUsed: { input: 0, output: 0 },
    estimatedCostUsd: 0,
    successRate: 0,
    averageDurationMs: 0,
    topFailureReasons: [],
  };
}

function makeReflection(overrides: Partial<Reflection> = {}): Reflection {
  return {
    cycleId: 'cycle-1',
    timestamp: '2025-01-15T10:00:00.000Z',
    observation: {
      id: 'obs-1',
      type: 'error_pattern',
      severity: 'medium',
      frequency: 1,
      context: {},
      suggestedArea: 'src/providers',
      timestamp: '2025-01-15T10:00:00.000Z',
      source: 'error_logs',
    },
    hypothesis: {
      id: 'hyp-1',
      observation: {
        id: 'obs-1',
        type: 'error_pattern',
        severity: 'medium',
        frequency: 1,
        context: {},
        suggestedArea: 'src/providers',
        timestamp: '2025-01-15T10:00:00.000Z',
        source: 'error_logs',
      },
      proposal: 'Add retry logic to provider',
      approach: 'fix_bug',
      expectedImpact: 'medium',
      confidence: 0.7,
      affectedFiles: ['src/providers/ollama.ts'],
      estimatedComplexity: 'simple',
      previousAttempts: 0,
      reasoning: 'Timeouts are frequent',
    },
    outcome: 'success',
    learnings: 'Retry with backoff works well.',
    durationMs: 45000,
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// formatDailyReport — no cycles
// ═══════════════════════════════════════════════════════════════════════════════

describe('formatDailyReport — no cycles', () => {
  it('reports no cycles ran', () => {
    const result = formatDailyReport(emptyStats(), []);
    expect(result).toContain('Autonomous Report (24h)');
    expect(result).toContain('No cycles ran');
  });

  it('does not include sections when no cycles', () => {
    const result = formatDailyReport(emptyStats(), []);
    expect(result).not.toContain('Cycles:');
    expect(result).not.toContain('Success rate:');
    expect(result).not.toContain('Tokens:');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// formatDailyReport — with cycles
// ═══════════════════════════════════════════════════════════════════════════════

describe('formatDailyReport — with cycles', () => {
  it('shows cycle count and success rate', () => {
    const stats: AggregateStats = {
      ...emptyStats(),
      totalCycles: 8,
      successfulCycles: 5,
      failedCycles: 3,
      successRate: 0.625,
    };
    const result = formatDailyReport(stats, []);
    expect(result).toContain('Cycles: 8 completed');
    expect(result).toContain('Success rate: 63%');
    expect(result).toContain('5/8');
  });

  it('shows hypothesis counts', () => {
    const stats = { ...emptyStats(), totalCycles: 3, successRate: 0.67 };
    const reflections = [
      makeReflection({ outcome: 'success', cycleId: 'c1' }),
      makeReflection({ outcome: 'failure', cycleId: 'c2' }),
      makeReflection({ outcome: 'success', cycleId: 'c3' }),
    ];
    const result = formatDailyReport(stats, reflections);
    expect(result).toContain('Hypotheses: 3 attempted, 2 integrated');
  });

  it('lists top improvements', () => {
    const stats = { ...emptyStats(), totalCycles: 2, successRate: 1 };
    const reflections = [
      makeReflection({
        outcome: 'success',
        hypothesis: {
          ...makeReflection().hypothesis,
          proposal: 'Fixed timeout on large context',
        },
      }),
      makeReflection({
        outcome: 'success',
        cycleId: 'c2',
        hypothesis: {
          ...makeReflection().hypothesis,
          proposal: 'Added pagination to file list',
        },
      }),
    ];
    const result = formatDailyReport(stats, reflections);
    expect(result).toContain('Top improvements:');
    expect(result).toContain('- Fixed timeout on large context');
    expect(result).toContain('- Added pagination to file list');
  });

  it('lists failed attempts', () => {
    const stats = { ...emptyStats(), totalCycles: 1, successRate: 0 };
    const reflections = [
      makeReflection({
        outcome: 'failure',
        hypothesis: {
          ...makeReflection().hypothesis,
          proposal: 'Refactor router',
        },
        learnings: 'Tests failed due to missing mock',
      }),
    ];
    const result = formatDailyReport(stats, reflections);
    expect(result).toContain('Failed attempts:');
    expect(result).toContain('- Refactor router');
    expect(result).toContain('Tests failed');
  });

  it('truncates long failure learnings', () => {
    const stats = { ...emptyStats(), totalCycles: 1, successRate: 0 };
    const longLearning = 'A'.repeat(100);
    const reflections = [
      makeReflection({
        outcome: 'failure',
        learnings: longLearning,
      }),
    ];
    const result = formatDailyReport(stats, reflections);
    expect(result).toContain('...');
    // Should be truncated to around 40 chars
    expect(result.length).toBeLessThan(
      result.indexOf('...') + 50 + longLearning.length
    );
  });

  it('shows token usage', () => {
    const stats: AggregateStats = {
      ...emptyStats(),
      totalCycles: 5,
      successRate: 0.6,
      totalTokensUsed: { input: 142000, output: 23000 },
    };
    const result = formatDailyReport(stats, []);
    expect(result).toContain('Tokens:');
    expect(result).toContain('142K input');
    expect(result).toContain('23K output');
  });

  it('formats million-level tokens', () => {
    const stats: AggregateStats = {
      ...emptyStats(),
      totalCycles: 100,
      successRate: 0.8,
      totalTokensUsed: { input: 2_500_000, output: 500_000 },
    };
    const result = formatDailyReport(stats, []);
    expect(result).toContain('2.5M input');
    expect(result).toContain('500K output');
  });

  it('hides token section when both zero', () => {
    const stats = { ...emptyStats(), totalCycles: 1, successRate: 1 };
    const result = formatDailyReport(stats, []);
    expect(result).not.toContain('Tokens:');
  });

  it('limits top improvements to 5', () => {
    const stats = { ...emptyStats(), totalCycles: 7, successRate: 1 };
    const reflections = Array.from({ length: 7 }, (_, i) =>
      makeReflection({
        cycleId: `c${i}`,
        outcome: 'success',
        hypothesis: {
          ...makeReflection().hypothesis,
          proposal: `Improvement ${i}`,
        },
      })
    );
    const result = formatDailyReport(stats, reflections);
    expect(result).toContain('Improvement 0');
    expect(result).toContain('Improvement 4');
    expect(result).not.toContain('Improvement 5');
  });

  it('limits failed attempts to 3', () => {
    const stats = { ...emptyStats(), totalCycles: 5, successRate: 0 };
    const reflections = Array.from({ length: 5 }, (_, i) =>
      makeReflection({
        cycleId: `c${i}`,
        outcome: 'failure',
        hypothesis: {
          ...makeReflection().hypothesis,
          proposal: `Failure ${i}`,
        },
      })
    );
    const result = formatDailyReport(stats, reflections);
    expect(result).toContain('Failure 0');
    expect(result).toContain('Failure 2');
    expect(result).not.toContain('Failure 3');
  });
});
