/**
 * Daily Report Formatter (Autonomous Loop)
 *
 * Pure function that formats AggregateStats + recent reflections into
 * a concise iMessage-friendly daily progress report.
 */

import type { Reflection, HandoffState } from './types.js';
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

/**
 * Format the 8am morning summary with overnight handoff state.
 *
 * This is an informational report — no approval prompt, no action required.
 * The owner reviews branches at their convenience and merges via iMessage.
 */
export function formatMorningSummary(
  stats: AggregateStats,
  reflections: Reflection[],
  handoff: HandoffState | null,
): string {
  const lines: string[] = [];

  lines.push('Good morning! Here is your overnight autonomous report:');
  lines.push('');

  // ── Night summary ──────────────────────────────────────────────

  if (handoff) {
    const ns = handoff.nightSummary;
    lines.push(`Cycles: ${ns.cyclesCompleted} completed (10pm - 6am)`);
    lines.push(`Hypotheses: ${ns.hypothesesAttempted} attempted, ${ns.hypothesesValidated} validated`);
  } else if (stats.totalCycles > 0) {
    lines.push(`Cycles: ${stats.totalCycles} completed`);
  } else {
    lines.push('No cycles ran overnight.');
    return lines.join('\n');
  }

  // ── Pending branches ───────────────────────────────────────────

  const pending = handoff?.pendingBranches ?? [];

  if (pending.length > 0) {
    lines.push('');
    lines.push('Branches ready for review:');
    for (const b of pending) {
      lines.push(`  - ${b.branch}: ${b.proposal}`);
      const fileList = b.filesChanged
        .map((f) => `${f.path} (${f.type})`)
        .join(', ');
      lines.push(`    Files: ${fileList}`);
      const time = new Date(b.validatedAt).toLocaleTimeString('en-US', {
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
      });
      lines.push(`    Confidence: ${b.confidence.toFixed(2)} | Validated at ${time}`);
    }
  }

  // ── Failed attempts ────────────────────────────────────────────

  const failures = reflections
    .filter((r) => r.outcome === 'failure')
    .slice(0, 5);

  if (failures.length > 0) {
    lines.push('');
    lines.push('Failed attempts:');
    for (const f of failures) {
      const reason = f.learnings ? ` (${truncate(f.learnings, 40)})` : '';
      lines.push(`  - ${f.hypothesis.proposal}${reason}`);
    }
  }

  // ── Token usage ────────────────────────────────────────────────

  const tokenInput = handoff?.nightSummary.tokenUsage.input ?? stats.totalTokensUsed.input;
  const tokenOutput = handoff?.nightSummary.tokenUsage.output ?? stats.totalTokensUsed.output;

  if (tokenInput > 0 || tokenOutput > 0) {
    lines.push('');
    lines.push(`Tokens: ${formatTokenCount(tokenInput)} input / ${formatTokenCount(tokenOutput)} output`);
  }

  lines.push('');
  lines.push('Review branches at your convenience. Tell me "merge auto/hyp-xxx" when ready.');

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
