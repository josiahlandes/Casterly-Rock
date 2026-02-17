/**
 * Benchmark Report (ISSUE-008)
 *
 * Formatted output for benchmark runs and comparisons.
 * v2 adds agent-oriented dimension display (tool selection, reasoning, delegation).
 */

import type { BenchmarkRun } from './types.js';
import type { Comparison } from './compare.js';

// ─── Single Run Summary ──────────────────────────────────────────────────────

/**
 * Format a single benchmark run for console output.
 */
export function formatRunSummary(run: BenchmarkRun): string {
  const lines: string[] = [];

  lines.push('');
  lines.push('═'.repeat(60));
  lines.push(`BENCHMARK: ${run.modelId}`);
  lines.push(`Suite: ${run.suiteId}  |  ${new Date(run.timestamp).toISOString()}`);
  lines.push('═'.repeat(60));

  // Aggregate
  lines.push(`  Overall Score:    ${run.aggregate.overall}/100`);
  lines.push(`  Pass Rate:        ${(run.aggregate.passRate * 100).toFixed(1)}%`);
  lines.push(`  Structural Avg:   ${run.aggregate.structuralAvg.toFixed(3)}`);
  lines.push(`  Tool Efficiency:  ${run.aggregate.toolEfficiencyAvg.toFixed(3)}`);
  lines.push(`  Avg TTFT:         ${run.aggregate.avgTtftMs.toFixed(0)}ms`);
  lines.push(`  Avg Total:        ${run.aggregate.avgTotalMs.toFixed(0)}ms`);
  lines.push(`  Eval Rate:        ${run.aggregate.avgEvalRate.toFixed(1)} tok/s`);

  // v2 agent dimensions
  if (run.aggregate.toolSelectionAvg !== undefined) {
    lines.push('');
    lines.push('  Agent Dimensions:');
    lines.push(`    Tool Selection: ${run.aggregate.toolSelectionAvg.toFixed(3)}`);
    if (run.aggregate.reasoningAvg !== undefined) {
      lines.push(`    Reasoning:      ${run.aggregate.reasoningAvg.toFixed(3)}`);
    }
    if (run.aggregate.delegationAvg !== undefined) {
      lines.push(`    Delegation:     ${run.aggregate.delegationAvg.toFixed(3)}`);
    }
  }

  // Difficulty breakdown
  const diffs = Object.entries(run.aggregate.byDifficulty);
  if (diffs.length > 0) {
    lines.push('');
    lines.push('  By Difficulty:');
    for (const [diff, stats] of diffs) {
      lines.push(`    ${diff.padEnd(12)} ${stats.passed}/${stats.total} passed  avg ${stats.avgScore.toFixed(2)}`);
    }
  }

  // Category breakdown
  const cats = Object.entries(run.aggregate.byCategory);
  if (cats.length > 0) {
    lines.push('');
    lines.push('  By Category:');
    for (const [cat, stats] of cats) {
      lines.push(`    ${cat.padEnd(16)} ${stats.passed}/${stats.total} passed  avg ${stats.avgScore.toFixed(2)}`);
    }
  }

  // Individual cases
  if (run.cases.length > 0) {
    lines.push('');
    lines.push('─'.repeat(60));
    lines.push('  Cases:');
    for (const c of run.cases) {
      const status = c.passed ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
      let detail = `score=${c.structuralScore.toFixed(2)} eff=${c.toolEfficiency.toFixed(2)} ${c.totalMs.toFixed(0)}ms`;

      // v2 dimension details
      if (c.toolSelectionScore !== undefined) {
        detail += ` sel=${c.toolSelectionScore.toFixed(2)}`;
      }
      if (c.reasoningScore !== undefined) {
        detail += ` rsn=${c.reasoningScore.toFixed(0)}`;
      }
      if (c.delegationScore !== undefined) {
        detail += ` dlg=${c.delegationScore.toFixed(0)}`;
      }

      lines.push(`    ${status} [${c.caseId}] ${detail}`);
      for (const f of c.failures) {
        lines.push(`         - ${f}`);
      }
    }
  }

  lines.push('═'.repeat(60));
  return lines.join('\n');
}

// ─── Comparison Report ───────────────────────────────────────────────────────

/**
 * Format a multi-model comparison for console output.
 */
export function formatComparison(comparison: Comparison): string {
  const lines: string[] = [];

  lines.push('');
  lines.push('═'.repeat(60));
  lines.push('MODEL COMPARISON');
  lines.push('═'.repeat(60));

  // Rankings table
  lines.push('');
  lines.push(`${'Rank'.padEnd(6)}${'Model'.padEnd(22)}${'Score'.padEnd(10)}`);
  lines.push('─'.repeat(38));
  for (const r of comparison.rankings) {
    lines.push(`  ${String(r.rank).padEnd(4)}${r.modelId.padEnd(22)}${r.overall}/100`);
  }

  // Winner
  if (comparison.winner) {
    lines.push('');
    lines.push(`Winner: ${comparison.winner}`);
  }

  // Category breakdown
  const cats = Object.entries(comparison.byCategory);
  if (cats.length > 0) {
    lines.push('');
    lines.push('By Category:');
    for (const [cat, rankings] of cats) {
      const ranked = rankings.map((r) => r.modelId).join(' > ');
      lines.push(`  ${cat.padEnd(16)} ${ranked}`);
    }
  }

  // Difficulty breakdown
  const diffs = Object.entries(comparison.byDifficulty);
  if (diffs.length > 0) {
    lines.push('');
    lines.push('By Difficulty:');
    for (const [diff, rankings] of diffs) {
      const ranked = rankings.map((r) => r.modelId).join(' > ');
      lines.push(`  ${diff.padEnd(12)} ${ranked}`);
    }
  }

  lines.push('═'.repeat(60));
  return lines.join('\n');
}

// ─── JSON Export ─────────────────────────────────────────────────────────────

/**
 * Export a benchmark run as formatted JSON.
 */
export function formatRunAsJson(run: BenchmarkRun): string {
  return JSON.stringify(run, null, 2);
}
