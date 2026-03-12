/**
 * Activity Ledger — Append-only JSONL log of autonomous actions.
 *
 * Records meaningful actions (task completions, dream cycles, goal attempts,
 * issues filed, morning summaries) so the user can review what Tyrion did
 * during idle time. One JSON line per action.
 *
 * File: ~/.casterly/activity.jsonl
 *
 * Privacy: Summaries must never contain raw user message content.
 * All data stays local.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { getTracer } from '../autonomous/debug.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type ActivityType =
  | 'task_completed'
  | 'goal_attempted'
  | 'dream_cycle'
  | 'issue_filed'
  | 'morning_summary'
  | 'autoresearch_experiment';

export interface ActivityEntry {
  timestamp: string;
  type: ActivityType;
  summary: string;
  durationMs?: number;
  metrics?: Record<string, number>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Path
// ─────────────────────────────────────────────────────────────────────────────

function resolvePath(filePath: string): string {
  if (filePath.startsWith('~')) {
    const home = process.env['HOME'] ?? process.env['USERPROFILE'] ?? '/tmp';
    return filePath.replace('~', home);
  }
  return filePath;
}

const LEDGER_PATH = '~/.casterly/activity.jsonl';

let dirEnsured = false;

// ─────────────────────────────────────────────────────────────────────────────
// Write
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Append a single activity entry to the ledger file.
 * Creates the parent directory on the first call.
 */
export async function appendActivity(entry: ActivityEntry): Promise<void> {
  const resolved = resolvePath(LEDGER_PATH);

  if (!dirEnsured) {
    await fs.mkdir(path.dirname(resolved), { recursive: true });
    dirEnsured = true;
  }

  const line = JSON.stringify(entry) + '\n';
  await fs.appendFile(resolved, line, 'utf-8');
}

// ─────────────────────────────────────────────────────────────────────────────
// Read
// ─────────────────────────────────────────────────────────────────────────────

/** Maximum lines to read from the tail of the file. */
const MAX_LINES = 500;

/**
 * Read activity entries from the last `hours` hours.
 * Returns newest-first. Skips malformed lines gracefully.
 */
export async function readRecentActivity(hours: number): Promise<ActivityEntry[]> {
  const resolved = resolvePath(LEDGER_PATH);
  const tracer = getTracer();

  let raw: string;
  try {
    raw = await fs.readFile(resolved, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    tracer.log('coordinator', 'warn', `Failed to read activity ledger: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }

  const lines = raw.trim().split('\n');
  const tail = lines.slice(-MAX_LINES);
  const cutoff = Date.now() - hours * 3_600_000;
  const entries: ActivityEntry[] = [];

  for (const line of tail) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as ActivityEntry;
      if (new Date(entry.timestamp).getTime() >= cutoff) {
        entries.push(entry);
      }
    } catch {
      // Skip malformed lines
    }
  }

  return entries.reverse();
}

// ─────────────────────────────────────────────────────────────────────────────
// Format
// ─────────────────────────────────────────────────────────────────────────────

const TYPE_LABELS: Record<ActivityType, string> = {
  task_completed: 'Task done',
  goal_attempted: 'Goal work',
  dream_cycle: 'Dream cycle',
  issue_filed: 'Issue filed',
  morning_summary: 'Morning summary',
  autoresearch_experiment: 'Autoresearch',
};

/**
 * Format activity entries for iMessage display.
 * Truncates to ~1500 chars to fit iMessage comfortably.
 */
export function formatLedgerReport(entries: ActivityEntry[], hours: number): string {
  const lines: string[] = [];
  const unit = hours >= 48 ? `${Math.round(hours / 24)} days` : `${hours} hours`;
  lines.push(`Activity log (last ${unit}): ${entries.length} entries`);
  lines.push('');

  for (const entry of entries) {
    const ago = formatRelativeTime(entry.timestamp);
    const label = TYPE_LABELS[entry.type] ?? entry.type;
    let line = `[${ago}] ${label}: ${entry.summary}`;
    if (entry.durationMs) {
      line += ` (${(entry.durationMs / 1000).toFixed(0)}s)`;
    }
    lines.push(line);

    // Check if we're approaching the character limit
    const current = lines.join('\n');
    if (current.length > 1400) {
      const remaining = entries.length - lines.length + 1;
      if (remaining > 0) {
        lines.push(`... and ${remaining} more entries`);
      }
      break;
    }
  }

  return lines.join('\n');
}

export function formatRelativeTime(isoTimestamp: string): string {
  const diffMs = Date.now() - new Date(isoTimestamp).getTime();
  const minutes = Math.floor(diffMs / 60_000);

  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
