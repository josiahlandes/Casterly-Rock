/**
 * Benchmark Comparison (ISSUE-008)
 *
 * Side-by-side comparison utilities for benchmark runs.
 */

import type { BenchmarkRun } from './types.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ModelRanking {
  modelId: string;
  overall: number;
  rank: number;
}

export interface Comparison {
  rankings: ModelRanking[];
  winner: string;
  byCategory: Record<string, ModelRanking[]>;
  byDifficulty: Record<string, ModelRanking[]>;
}

// ─── Compare ─────────────────────────────────────────────────────────────────

/**
 * Compare multiple benchmark runs and produce rankings.
 */
export function compareRuns(runs: BenchmarkRun[]): Comparison {
  if (runs.length === 0) {
    return { rankings: [], winner: '', byCategory: {}, byDifficulty: {} };
  }

  // Overall ranking — sort by aggregate.overall descending
  const sorted = [...runs].sort((a, b) => b.aggregate.overall - a.aggregate.overall);
  const rankings: ModelRanking[] = sorted.map((run, i) => ({
    modelId: run.modelId,
    overall: run.aggregate.overall,
    rank: i + 1,
  }));

  const winner = rankings[0]?.modelId ?? '';

  // Category rankings
  const byCategory: Record<string, ModelRanking[]> = {};
  const allCategories = new Set<string>();
  for (const run of runs) {
    for (const cat of Object.keys(run.aggregate.byCategory)) {
      allCategories.add(cat);
    }
  }

  for (const cat of allCategories) {
    const catRuns = runs
      .filter((r) => r.aggregate.byCategory[cat] !== undefined)
      .map((r) => ({
        modelId: r.modelId,
        score: r.aggregate.byCategory[cat]!.avgScore,
      }))
      .sort((a, b) => b.score - a.score);

    byCategory[cat] = catRuns.map((r, i) => ({
      modelId: r.modelId,
      overall: Math.round(r.score * 100),
      rank: i + 1,
    }));
  }

  // Difficulty rankings
  const byDifficulty: Record<string, ModelRanking[]> = {};
  const allDifficulties = new Set<string>();
  for (const run of runs) {
    for (const diff of Object.keys(run.aggregate.byDifficulty)) {
      allDifficulties.add(diff);
    }
  }

  for (const diff of allDifficulties) {
    const diffRuns = runs
      .filter((r) => r.aggregate.byDifficulty[diff] !== undefined)
      .map((r) => ({
        modelId: r.modelId,
        score: r.aggregate.byDifficulty[diff]!.avgScore,
      }))
      .sort((a, b) => b.score - a.score);

    byDifficulty[diff] = diffRuns.map((r, i) => ({
      modelId: r.modelId,
      overall: Math.round(r.score * 100),
      rank: i + 1,
    }));
  }

  return { rankings, winner, byCategory, byDifficulty };
}

// ─── Head-to-Head ────────────────────────────────────────────────────────────

/**
 * Format a head-to-head comparison of two runs.
 */
export function headToHead(runA: BenchmarkRun, runB: BenchmarkRun): string {
  const lines: string[] = [];

  lines.push(`Head-to-Head: ${runA.modelId} vs ${runB.modelId}`);
  lines.push('─'.repeat(60));

  const metrics: [string, (r: BenchmarkRun) => string][] = [
    ['Overall Score', (r) => `${r.aggregate.overall}/100`],
    ['Pass Rate', (r) => `${(r.aggregate.passRate * 100).toFixed(1)}%`],
    ['Structural Avg', (r) => r.aggregate.structuralAvg.toFixed(3)],
    ['Tool Efficiency', (r) => r.aggregate.toolEfficiencyAvg.toFixed(3)],
    ['Avg TTFT', (r) => `${r.aggregate.avgTtftMs.toFixed(0)}ms`],
    ['Avg Total', (r) => `${r.aggregate.avgTotalMs.toFixed(0)}ms`],
    ['Eval Rate', (r) => `${r.aggregate.avgEvalRate.toFixed(1)} tok/s`],
  ];

  for (const [label, getter] of metrics) {
    const a = getter(runA);
    const b = getter(runB);
    lines.push(`  ${label.padEnd(18)} ${a.padEnd(15)} ${b}`);
  }

  // Winner
  lines.push('─'.repeat(60));
  if (runA.aggregate.overall > runB.aggregate.overall) {
    lines.push(`Winner: ${runA.modelId}`);
  } else if (runB.aggregate.overall > runA.aggregate.overall) {
    lines.push(`Winner: ${runB.modelId}`);
  } else {
    lines.push('Result: Tie');
  }

  return lines.join('\n');
}
