/**
 * Daily Report Formatter (Autonomous Loop)
 *
 * Pure function that formats AggregateStats + recent reflections into
 * a concise iMessage-friendly daily progress report.
 */

import type { Reflection } from './types.js';
import type { AggregateStats } from './reflector.js';

/**
 * Format a daily autonomous report for sending via iMessage.
 *
 * The output is kept short and scannable — no markdown tables,
 * just plain text with bullet points that render well on iOS.
 */
export function formatDailyReport(
  stats: AggregateStats,
  reflections: Reflection[],
): string {
  const lines: string[] = [];

  lines.push('Autonomous Report (24h)');
  lines.push('');

  // ── Cycle summary ──────────────────────────────────────────────

  if (stats.totalCycles === 0) {
    lines.push('No cycles ran in the last 24 hours.');
    return lines.join('\n');
  }

  const successPct = Math.round(stats.successRate * 100);
  lines.push(`Cycles: ${stats.totalCycles} completed`);
  lines.push(`Success rate: ${successPct}% (${stats.successfulCycles}/${stats.totalCycles})`);

  // ── Hypothesis breakdown ───────────────────────────────────────

  const attempted = reflections.length;
  const integrated = reflections.filter((r) => r.outcome === 'success').length;

  if (attempted > 0) {
    lines.push(`Hypotheses: ${attempted} attempted, ${integrated} integrated`);
  }

  // ── Top improvements (successes) ───────────────────────────────

  const successes = reflections
    .filter((r) => r.outcome === 'success')
    .slice(0, 5);

  if (successes.length > 0) {
    lines.push('');
    lines.push('Top improvements:');
    for (const s of successes) {
      lines.push(`- ${s.hypothesis.proposal}`);
    }
  }

  // ── Failed attempts ────────────────────────────────────────────

  const failures = reflections
    .filter((r) => r.outcome === 'failure')
    .slice(0, 3);

  if (failures.length > 0) {
    lines.push('');
    lines.push('Failed attempts:');
    for (const f of failures) {
      const reason = f.learnings ? ` (${truncate(f.learnings, 40)})` : '';
      lines.push(`- ${f.hypothesis.proposal}${reason}`);
    }
  }

  // ── Token usage ────────────────────────────────────────────────

  const totalIn = stats.totalTokensUsed.input;
  const totalOut = stats.totalTokensUsed.output;

  if (totalIn > 0 || totalOut > 0) {
    lines.push('');
    lines.push(`Tokens: ${formatTokenCount(totalIn)} input / ${formatTokenCount(totalOut)} output`);
  }

  return lines.join('\n');
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return String(n);
}

function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return s.substring(0, maxLen - 3) + '...';
}
