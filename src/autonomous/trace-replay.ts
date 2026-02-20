/**
 * Trace Replay — Self-Debugging Replay (Vision Tier 1)
 *
 * Re-examine past execution traces step-by-step to identify failure
 * patterns. Every agent cycle's tool calls, results, and reasoning
 * are indexed for later retrieval.
 *
 * Use cases:
 *   - Post-mortem analysis of failed cycles.
 *   - Strategy comparison between two cycles.
 *   - Context debugging — what was available at the decision point.
 *
 * Storage:
 *   - ~/.casterly/traces/ — individual trace files (one per cycle)
 *   - ~/.casterly/traces/index.yaml — searchable trace index
 *
 * Retention:
 *   - Successful traces: 7 days (configurable)
 *   - Failed traces: 30 days (configurable)
 *   - Traces referenced by crystals/rules: retained indefinitely
 *
 * Part of Vision Tier 1: Self-Debugging Replay.
 */

import { readFile, writeFile, mkdir, readdir, unlink } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { getTracer } from './debug.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A single step in an execution trace.
 */
export interface TraceStep {
  /** Step number within the cycle (1-based) */
  step: number;

  /** ISO timestamp */
  timestamp: string;

  /** Tool that was called (or 'reasoning' for think steps) */
  toolCalled: string;

  /** Parameters passed to the tool */
  parameters: Record<string, unknown>;

  /** Result returned by the tool */
  result: string;

  /** The LLM's reasoning before this step (if available) */
  reasoning?: string;

  /** Duration of this step in milliseconds */
  durationMs?: number;
}

/**
 * A complete execution trace for a single cycle.
 */
export interface ExecutionTrace {
  /** Unique cycle ID */
  cycleId: string;

  /** ISO timestamp when the cycle started */
  startedAt: string;

  /** ISO timestamp when the cycle ended */
  endedAt: string;

  /** Outcome of the cycle */
  outcome: 'success' | 'failure' | 'partial';

  /** Trigger that initiated this cycle */
  trigger: string;

  /** All steps in order */
  steps: TraceStep[];

  /** Tools used in this trace (deduped) */
  toolsUsed: string[];

  /** Tags for search/filtering */
  tags: string[];

  /** Whether this trace is pinned (referenced by crystal/rule — exempt from retention) */
  pinned: boolean;
}

/**
 * Index entry for fast searching without loading full traces.
 */
export interface TraceIndexEntry {
  /** Cycle ID */
  cycleId: string;

  /** ISO start timestamp */
  startedAt: string;

  /** Outcome */
  outcome: 'success' | 'failure' | 'partial';

  /** Trigger type */
  trigger: string;

  /** Tools used */
  toolsUsed: string[];

  /** Number of steps */
  stepCount: number;

  /** Tags */
  tags: string[];

  /** Whether pinned */
  pinned: boolean;
}

/**
 * Configuration for the trace replay system.
 */
export interface TraceReplayConfig {
  /** Base path for trace storage */
  path: string;

  /** Days to retain successful traces */
  successRetentionDays: number;

  /** Days to retain failed traces */
  failureRetentionDays: number;

  /** Maximum number of traces to keep */
  maxTraces: number;
}

/**
 * Result of a comparison between two traces.
 */
export interface TraceComparison {
  /** Cycle IDs being compared */
  cycleA: string;
  cycleB: string;

  /** Common tools used by both */
  commonTools: string[];

  /** Tools unique to A */
  uniqueToA: string[];

  /** Tools unique to B */
  uniqueToB: string[];

  /** Step count difference */
  stepCountDiff: number;

  /** Outcome of each */
  outcomeA: string;
  outcomeB: string;

  /** Human-readable diff summary */
  summary: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: TraceReplayConfig = {
  path: '~/.casterly/traces',
  successRetentionDays: 7,
  failureRetentionDays: 30,
  maxTraces: 500,
};

function resolvePath(filePath: string): string {
  if (filePath.startsWith('~')) {
    const home = process.env['HOME'] ?? process.env['USERPROFILE'] ?? '/tmp';
    return filePath.replace('~', home);
  }
  return filePath;
}

// ─────────────────────────────────────────────────────────────────────────────
// Simple YAML serializer/deserializer for index
// ─────────────────────────────────────────────────────────────────────────────

function serializeIndex(entries: TraceIndexEntry[]): string {
  // Use JSON for the index — it's internal and benefits from exact parsing
  return JSON.stringify(entries, null, 2);
}

function deserializeIndex(content: string): TraceIndexEntry[] {
  try {
    const parsed = JSON.parse(content);
    if (Array.isArray(parsed)) return parsed as TraceIndexEntry[];
  } catch {
    // Corrupted index — will be rebuilt
  }
  return [];
}

// ─────────────────────────────────────────────────────────────────────────────
// Trace Replay Store
// ─────────────────────────────────────────────────────────────────────────────

export class TraceReplayStore {
  private readonly config: TraceReplayConfig;
  private index: TraceIndexEntry[] = [];
  private loaded: boolean = false;

  constructor(config?: Partial<TraceReplayConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // ── Persistence ──────────────────────────────────────────────────────────

  /**
   * Load the trace index from disk.
   */
  async load(): Promise<void> {
    const tracer = getTracer();
    const indexPath = this.getIndexPath();

    try {
      const content = await readFile(indexPath, 'utf8');
      this.index = deserializeIndex(content);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        tracer.log('memory', 'warn', 'Failed to load trace index', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      this.index = [];
    }

    this.loaded = true;
    tracer.log('memory', 'debug', `Trace replay loaded: ${this.index.length} traces indexed`);
  }

  /**
   * Save the trace index to disk.
   */
  async saveIndex(): Promise<void> {
    const tracer = getTracer();
    const indexPath = this.getIndexPath();

    await mkdir(dirname(indexPath), { recursive: true });
    await writeFile(indexPath, serializeIndex(this.index), 'utf8');

    tracer.log('memory', 'debug', `Trace index saved: ${this.index.length} entries`);
  }

  /**
   * Save a full trace to disk and update the index.
   */
  async recordTrace(trace: ExecutionTrace): Promise<void> {
    const tracer = getTracer();
    const basePath = resolvePath(this.config.path);

    // Save trace file
    const tracePath = join(basePath, `${trace.cycleId}.json`);
    await mkdir(basePath, { recursive: true });
    await writeFile(tracePath, JSON.stringify(trace, null, 2), 'utf8');

    // Update index
    const entry: TraceIndexEntry = {
      cycleId: trace.cycleId,
      startedAt: trace.startedAt,
      outcome: trace.outcome,
      trigger: trace.trigger,
      toolsUsed: trace.toolsUsed,
      stepCount: trace.steps.length,
      tags: trace.tags,
      pinned: trace.pinned,
    };

    // Replace existing entry if present, otherwise append
    const existingIdx = this.index.findIndex((e) => e.cycleId === trace.cycleId);
    if (existingIdx >= 0) {
      this.index[existingIdx] = entry;
    } else {
      this.index.push(entry);
    }

    // Enforce max traces (remove oldest non-pinned)
    while (this.index.length > this.config.maxTraces) {
      const removeIdx = this.index.findIndex((e) => !e.pinned);
      if (removeIdx < 0) break;
      const removed = this.index.splice(removeIdx, 1)[0]!;
      await this.deleteTraceFile(removed.cycleId);
    }

    await this.saveIndex();

    tracer.log('memory', 'info', `Trace recorded: ${trace.cycleId} (${trace.outcome}, ${trace.steps.length} steps)`);
  }

  // ── Replay ──────────────────────────────────────────────────────────────

  /**
   * Load and return a full execution trace for replay.
   */
  async replay(cycleId: string, options?: {
    stepRange?: [number, number];
    toolFilter?: string;
  }): Promise<ExecutionTrace | null> {
    const basePath = resolvePath(this.config.path);
    const tracePath = join(basePath, `${cycleId}.json`);

    try {
      const content = await readFile(tracePath, 'utf8');
      const trace = JSON.parse(content) as ExecutionTrace;

      // Apply filters
      if (options?.stepRange) {
        const [start, end] = options.stepRange;
        trace.steps = trace.steps.filter(
          (s) => s.step >= start && s.step <= end,
        );
      }

      if (options?.toolFilter) {
        const filter = options.toolFilter.toLowerCase();
        trace.steps = trace.steps.filter(
          (s) => s.toolCalled.toLowerCase().includes(filter),
        );
      }

      return trace;
    } catch {
      return null;
    }
  }

  /**
   * Compare two execution traces side by side.
   */
  async compareTraces(cycleIdA: string, cycleIdB: string): Promise<TraceComparison | null> {
    const traceA = await this.replay(cycleIdA);
    const traceB = await this.replay(cycleIdB);

    if (!traceA || !traceB) return null;

    const toolsA = new Set(traceA.toolsUsed);
    const toolsB = new Set(traceB.toolsUsed);

    const commonTools = [...toolsA].filter((t) => toolsB.has(t));
    const uniqueToA = [...toolsA].filter((t) => !toolsB.has(t));
    const uniqueToB = [...toolsB].filter((t) => !toolsA.has(t));

    const lines: string[] = [
      `## Trace Comparison: ${cycleIdA} vs ${cycleIdB}`,
      '',
      `| Metric | ${cycleIdA} | ${cycleIdB} |`,
      '|--------|-------|-------|',
      `| Outcome | ${traceA.outcome} | ${traceB.outcome} |`,
      `| Steps | ${traceA.steps.length} | ${traceB.steps.length} |`,
      `| Trigger | ${traceA.trigger} | ${traceB.trigger} |`,
      `| Tools | ${traceA.toolsUsed.length} | ${traceB.toolsUsed.length} |`,
      '',
    ];

    if (commonTools.length > 0) {
      lines.push(`**Common tools:** ${commonTools.join(', ')}`);
    }
    if (uniqueToA.length > 0) {
      lines.push(`**Only in ${cycleIdA}:** ${uniqueToA.join(', ')}`);
    }
    if (uniqueToB.length > 0) {
      lines.push(`**Only in ${cycleIdB}:** ${uniqueToB.join(', ')}`);
    }

    // Compare step sequences
    lines.push('', '### Step Sequence Comparison', '');
    const maxSteps = Math.max(traceA.steps.length, traceB.steps.length);
    for (let i = 0; i < Math.min(maxSteps, 20); i++) {
      const stepA = traceA.steps[i];
      const stepB = traceB.steps[i];
      const aStr = stepA ? stepA.toolCalled : '—';
      const bStr = stepB ? stepB.toolCalled : '—';
      const marker = aStr !== bStr ? ' ←' : '';
      lines.push(`${i + 1}. ${aStr} | ${bStr}${marker}`);
    }

    if (maxSteps > 20) {
      lines.push(`... (${maxSteps - 20} more steps)`);
    }

    return {
      cycleA: cycleIdA,
      cycleB: cycleIdB,
      commonTools,
      uniqueToA,
      uniqueToB,
      stepCountDiff: traceA.steps.length - traceB.steps.length,
      outcomeA: traceA.outcome,
      outcomeB: traceB.outcome,
      summary: lines.join('\n'),
    };
  }

  // ── Search ──────────────────────────────────────────────────────────────

  /**
   * Search traces by criteria.
   */
  searchTraces(criteria: {
    outcome?: 'success' | 'failure' | 'partial';
    trigger?: string;
    tool?: string;
    tag?: string;
    dateRange?: { from?: string; to?: string };
    limit?: number;
  }): TraceIndexEntry[] {
    let results = [...this.index];

    if (criteria.outcome) {
      results = results.filter((e) => e.outcome === criteria.outcome);
    }

    if (criteria.trigger) {
      const triggerLower = criteria.trigger.toLowerCase();
      results = results.filter((e) => e.trigger.toLowerCase().includes(triggerLower));
    }

    if (criteria.tool) {
      const toolLower = criteria.tool.toLowerCase();
      results = results.filter((e) =>
        e.toolsUsed.some((t) => t.toLowerCase().includes(toolLower)),
      );
    }

    if (criteria.tag) {
      const tagLower = criteria.tag.toLowerCase();
      results = results.filter((e) =>
        e.tags.some((t) => t.toLowerCase().includes(tagLower)),
      );
    }

    if (criteria.dateRange) {
      if (criteria.dateRange.from) {
        const from = new Date(criteria.dateRange.from).getTime();
        results = results.filter((e) => new Date(e.startedAt).getTime() >= from);
      }
      if (criteria.dateRange.to) {
        const to = new Date(criteria.dateRange.to).getTime();
        results = results.filter((e) => new Date(e.startedAt).getTime() <= to);
      }
    }

    // Sort by date descending (most recent first)
    results.sort((a, b) =>
      new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
    );

    const limit = criteria.limit ?? 20;
    return results.slice(0, limit);
  }

  // ── Pin Management ─────────────────────────────────────────────────────

  /**
   * Pin a trace to prevent it from being pruned by retention policy.
   */
  pinTrace(cycleId: string): boolean {
    const entry = this.index.find((e) => e.cycleId === cycleId);
    if (!entry) return false;
    entry.pinned = true;
    return true;
  }

  /**
   * Unpin a trace.
   */
  unpinTrace(cycleId: string): boolean {
    const entry = this.index.find((e) => e.cycleId === cycleId);
    if (!entry) return false;
    entry.pinned = false;
    return true;
  }

  // ── Pruning / Retention ─────────────────────────────────────────────────

  /**
   * Prune traces past their retention period.
   * Returns the number of traces pruned.
   */
  async pruneByRetention(): Promise<number> {
    const tracer = getTracer();
    const now = Date.now();
    const successCutoff = now - this.config.successRetentionDays * 24 * 60 * 60 * 1000;
    const failureCutoff = now - this.config.failureRetentionDays * 24 * 60 * 60 * 1000;

    const toRemove: string[] = [];

    this.index = this.index.filter((e) => {
      if (e.pinned) return true;

      const ts = new Date(e.startedAt).getTime();
      const cutoff = e.outcome === 'success' ? successCutoff : failureCutoff;

      if (ts < cutoff) {
        toRemove.push(e.cycleId);
        return false;
      }
      return true;
    });

    // Delete trace files
    for (const cycleId of toRemove) {
      await this.deleteTraceFile(cycleId);
    }

    if (toRemove.length > 0) {
      await this.saveIndex();
      tracer.log('memory', 'info', `Pruned ${toRemove.length} expired traces`);
    }

    return toRemove.length;
  }

  // ── Query ────────────────────────────────────────────────────────────────

  /**
   * Get the total number of indexed traces.
   */
  count(): number {
    return this.index.length;
  }

  /**
   * Get the full index.
   */
  getIndex(): ReadonlyArray<TraceIndexEntry> {
    return this.index;
  }

  /**
   * Get recent failed traces for dream cycle analysis.
   */
  getRecentFailures(limit: number = 5): TraceIndexEntry[] {
    return this.searchTraces({ outcome: 'failure', limit });
  }

  /**
   * Check if loaded.
   */
  isLoaded(): boolean {
    return this.loaded;
  }

  // ── Internal ─────────────────────────────────────────────────────────────

  private getIndexPath(): string {
    return join(resolvePath(this.config.path), 'index.json');
  }

  private async deleteTraceFile(cycleId: string): Promise<void> {
    const basePath = resolvePath(this.config.path);
    const tracePath = join(basePath, `${cycleId}.json`);

    try {
      await unlink(tracePath);
    } catch {
      // File may already be deleted
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────────────────────

export function createTraceReplayStore(
  config?: Partial<TraceReplayConfig>,
): TraceReplayStore {
  return new TraceReplayStore(config);
}
