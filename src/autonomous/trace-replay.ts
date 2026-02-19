/**
 * Trace Replay — Self-debugging through execution trace analysis
 *
 * Provides the ability to re-examine past execution traces step-by-step
 * to identify failure patterns. This is qualitatively different from
 * reading the journal — the journal captures high-level reflections,
 * while replay captures the actual execution trace.
 *
 * Use cases:
 *   - Post-mortem analysis: "Replay the last 5 failed cycles."
 *   - Strategy comparison: "Compare the tool call sequences."
 *   - Context debugging: "What was in my context at the wrong decision?"
 *
 * Storage:
 *   ~/.casterly/traces/
 *     index.json     — lightweight index for searching traces
 *     <cycleId>.json — individual trace files
 *
 * Retention policy:
 *   - Successful traces: 7 days (configurable)
 *   - Failed traces: 30 days (configurable)
 *   - Referenced traces (by rules/crystals): indefinite
 *
 * Part of Vision Tier 1: Self-Debugging Replay.
 */

import { readFile, writeFile, readdir, mkdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { getTracer } from './debug.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A single step in an execution trace.
 */
export interface TraceStep {
  /** Step number (1-indexed) */
  step: number;

  /** Timestamp of this step */
  timestamp: string;

  /** Tool that was called (or 'reasoning' for think steps) */
  toolCalled: string;

  /** Parameters passed to the tool */
  parameters: Record<string, unknown>;

  /** Result returned by the tool */
  result: {
    success: boolean;
    output?: string;
    error?: string;
  };

  /** The LLM's reasoning that led to this tool call */
  reasoning?: string;

  /** Duration of this step in milliseconds */
  durationMs: number;
}

/**
 * A complete execution trace for one cycle.
 */
export interface ExecutionTrace {
  /** Cycle identifier */
  cycleId: string;

  /** When this cycle started */
  startedAt: string;

  /** When this cycle ended */
  endedAt: string;

  /** What triggered this cycle */
  triggerType: string;

  /** Whether the cycle succeeded overall */
  outcome: 'success' | 'failure' | 'partial';

  /** The execution steps */
  steps: TraceStep[];

  /** Total duration in milliseconds */
  totalDurationMs: number;

  /** Summary of what was accomplished */
  summary?: string;

  /** Error message if the cycle failed */
  error?: string;
}

/**
 * Index entry for fast trace lookup.
 */
export interface TraceIndexEntry {
  /** Cycle identifier */
  cycleId: string;

  /** When this trace was recorded */
  timestamp: string;

  /** Outcome of the cycle */
  outcome: 'success' | 'failure' | 'partial';

  /** What triggered the cycle */
  triggerType: string;

  /** Number of steps in the trace */
  stepCount: number;

  /** Tool names used in the trace */
  toolsUsed: string[];

  /** Total duration in milliseconds */
  totalDurationMs: number;

  /** Whether this trace is referenced by a crystal or rule (prevents deletion) */
  referenced: boolean;
}

/**
 * Result of comparing two traces.
 */
export interface TraceComparison {
  /** The two cycle IDs being compared */
  cycleIds: [string, string];

  /** Steps only in trace A */
  uniqueToA: TraceStep[];

  /** Steps only in trace B */
  uniqueToB: TraceStep[];

  /** Tool sequences for each trace */
  toolSequenceA: string[];
  toolSequenceB: string[];

  /** Where the tool sequences diverge */
  divergencePoint: number | null;

  /** Outcome comparison */
  outcomes: { a: string; b: string };

  /** Summary of differences */
  summary: string;
}

/**
 * Configuration for the trace replay system.
 */
export interface TraceReplayConfig {
  /** Base directory for trace storage */
  basePath: string;

  /** Days to retain successful traces */
  successRetentionDays: number;

  /** Days to retain failed traces */
  failureRetentionDays: number;

  /** Maximum number of traces to keep */
  maxTraces: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: TraceReplayConfig = {
  basePath: '~/.casterly/traces',
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
// Trace Replay System
// ─────────────────────────────────────────────────────────────────────────────

export class TraceReplay {
  private readonly config: TraceReplayConfig;
  private readonly resolvedBasePath: string;
  private index: TraceIndexEntry[] = [];
  private initialized: boolean = false;

  constructor(config?: Partial<TraceReplayConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.resolvedBasePath = resolvePath(this.config.basePath);
  }

  // ── Initialization ────────────────────────────────────────────────────────

  /**
   * Initialize the trace storage directory and load the index.
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    await mkdir(this.resolvedBasePath, { recursive: true });
    await this.loadIndex();
    this.initialized = true;
  }

  // ── Recording ─────────────────────────────────────────────────────────────

  /**
   * Record a complete execution trace.
   */
  async record(trace: ExecutionTrace): Promise<void> {
    await this.initialize();
    const tracer = getTracer();

    // Write trace file
    const traceFile = join(this.resolvedBasePath, `${trace.cycleId}.json`);
    await writeFile(traceFile, JSON.stringify(trace, null, 2), 'utf8');

    // Update index
    const indexEntry: TraceIndexEntry = {
      cycleId: trace.cycleId,
      timestamp: trace.startedAt,
      outcome: trace.outcome,
      triggerType: trace.triggerType,
      stepCount: trace.steps.length,
      toolsUsed: [...new Set(trace.steps.map((s) => s.toolCalled))],
      totalDurationMs: trace.totalDurationMs,
      referenced: false,
    };

    this.index.push(indexEntry);
    await this.saveIndex();

    tracer.log('memory', 'debug', `Trace recorded: ${trace.cycleId}`, {
      outcome: trace.outcome,
      steps: trace.steps.length,
    });

    // Enforce max traces
    if (this.index.length > this.config.maxTraces) {
      await this.enforceRetentionPolicy();
    }
  }

  // ── Replay ────────────────────────────────────────────────────────────────

  /**
   * Load and replay a past cycle's trace.
   */
  async replay(cycleId: string, options?: {
    stepRange?: [number, number];
    toolFilter?: string;
  }): Promise<ExecutionTrace | null> {
    await this.initialize();

    const traceFile = join(this.resolvedBasePath, `${cycleId}.json`);

    try {
      const content = await readFile(traceFile, 'utf8');
      const trace = JSON.parse(content) as ExecutionTrace;

      // Apply filters
      if (options?.stepRange) {
        const [start, end] = options.stepRange;
        trace.steps = trace.steps.filter(
          (s) => s.step >= start && s.step <= end,
        );
      }

      if (options?.toolFilter) {
        trace.steps = trace.steps.filter(
          (s) => s.toolCalled === options.toolFilter,
        );
      }

      return trace;
    } catch {
      return null;
    }
  }

  /**
   * Compare two execution traces side-by-side.
   */
  async compareTraces(cycleIdA: string, cycleIdB: string): Promise<TraceComparison | null> {
    const traceA = await this.replay(cycleIdA);
    const traceB = await this.replay(cycleIdB);

    if (!traceA || !traceB) return null;

    const toolSeqA = traceA.steps.map((s) => s.toolCalled);
    const toolSeqB = traceB.steps.map((s) => s.toolCalled);

    // Find divergence point
    let divergencePoint: number | null = null;
    const minLen = Math.min(toolSeqA.length, toolSeqB.length);
    for (let i = 0; i < minLen; i++) {
      if (toolSeqA[i] !== toolSeqB[i]) {
        divergencePoint = i;
        break;
      }
    }
    if (divergencePoint === null && toolSeqA.length !== toolSeqB.length) {
      divergencePoint = minLen;
    }

    // Find unique tools
    const toolSetA = new Set(toolSeqA);
    const toolSetB = new Set(toolSeqB);

    const uniqueToolsA = traceA.steps.filter((s) => !toolSetB.has(s.toolCalled));
    const uniqueToolsB = traceB.steps.filter((s) => !toolSetA.has(s.toolCalled));

    // Build summary
    const summaryParts: string[] = [];
    summaryParts.push(`Trace A (${cycleIdA}): ${traceA.outcome}, ${traceA.steps.length} steps, ${traceA.totalDurationMs}ms`);
    summaryParts.push(`Trace B (${cycleIdB}): ${traceB.outcome}, ${traceB.steps.length} steps, ${traceB.totalDurationMs}ms`);

    if (divergencePoint !== null) {
      summaryParts.push(`Strategies diverge at step ${divergencePoint + 1}: A uses "${toolSeqA[divergencePoint] ?? 'end'}", B uses "${toolSeqB[divergencePoint] ?? 'end'}"`);
    } else {
      summaryParts.push('Tool sequences are identical');
    }

    return {
      cycleIds: [cycleIdA, cycleIdB],
      uniqueToA: uniqueToolsA,
      uniqueToB: uniqueToolsB,
      toolSequenceA: toolSeqA,
      toolSequenceB: toolSeqB,
      divergencePoint,
      outcomes: { a: traceA.outcome, b: traceB.outcome },
      summary: summaryParts.join('\n'),
    };
  }

  // ── Query ─────────────────────────────────────────────────────────────────

  /**
   * Search traces by outcome, date range, or tools used.
   */
  searchTraces(params: {
    outcome?: 'success' | 'failure' | 'partial';
    triggerType?: string;
    toolUsed?: string;
    limit?: number;
  }): TraceIndexEntry[] {
    let results = [...this.index];

    if (params.outcome) {
      results = results.filter((t) => t.outcome === params.outcome);
    }
    if (params.triggerType) {
      results = results.filter((t) => t.triggerType === params.triggerType);
    }
    if (params.toolUsed) {
      results = results.filter((t) => t.toolsUsed.includes(params.toolUsed!));
    }

    // Sort by newest first
    results.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

    if (params.limit) {
      results = results.slice(0, params.limit);
    }

    return results;
  }

  /**
   * Get the N most recent failed traces for post-mortem analysis.
   */
  getRecentFailures(n: number = 5): TraceIndexEntry[] {
    return this.searchTraces({ outcome: 'failure', limit: n });
  }

  /**
   * Mark a trace as referenced (prevents deletion during retention cleanup).
   */
  markReferenced(cycleId: string): boolean {
    const entry = this.index.find((t) => t.cycleId === cycleId);
    if (!entry) return false;

    entry.referenced = true;
    return true;
  }

  /**
   * Get the trace index.
   */
  getIndex(): ReadonlyArray<TraceIndexEntry> {
    return this.index;
  }

  /**
   * Get the number of indexed traces.
   */
  count(): number {
    return this.index.length;
  }

  // ── Retention ─────────────────────────────────────────────────────────────

  /**
   * Enforce the retention policy. Deletes old traces based on outcome
   * and reference status.
   */
  async enforceRetentionPolicy(): Promise<number> {
    await this.initialize();
    const tracer = getTracer();
    const now = Date.now();
    let deleted = 0;

    const toDelete: string[] = [];

    for (const entry of this.index) {
      // Never delete referenced traces
      if (entry.referenced) continue;

      const age = now - new Date(entry.timestamp).getTime();
      const ageDays = age / (24 * 60 * 60 * 1000);

      const retentionDays = entry.outcome === 'success'
        ? this.config.successRetentionDays
        : this.config.failureRetentionDays;

      if (ageDays > retentionDays) {
        toDelete.push(entry.cycleId);
      }
    }

    for (const cycleId of toDelete) {
      try {
        const traceFile = join(this.resolvedBasePath, `${cycleId}.json`);
        await unlink(traceFile);
        deleted++;
      } catch {
        // File may already be deleted
      }
    }

    // Remove from index
    this.index = this.index.filter((e) => !toDelete.includes(e.cycleId));
    await this.saveIndex();

    if (deleted > 0) {
      tracer.log('memory', 'info', `Retention cleanup: deleted ${deleted} traces`);
    }

    return deleted;
  }

  // ── Formatting ────────────────────────────────────────────────────────────

  /**
   * Format a trace as a readable step-by-step narrative.
   */
  formatTrace(trace: ExecutionTrace): string {
    const lines: string[] = [];

    lines.push(`Cycle: ${trace.cycleId}`);
    lines.push(`Trigger: ${trace.triggerType}`);
    lines.push(`Outcome: ${trace.outcome}`);
    lines.push(`Duration: ${trace.totalDurationMs}ms`);
    lines.push(`Steps: ${trace.steps.length}`);
    lines.push('');

    for (const step of trace.steps) {
      const status = step.result.success ? 'OK' : 'FAIL';
      lines.push(`Step ${step.step}: ${step.toolCalled} [${status}] (${step.durationMs}ms)`);

      if (step.reasoning) {
        lines.push(`  Reasoning: ${step.reasoning.slice(0, 200)}`);
      }

      const params = Object.keys(step.parameters);
      if (params.length > 0) {
        lines.push(`  Params: ${params.join(', ')}`);
      }

      if (!step.result.success && step.result.error) {
        lines.push(`  Error: ${step.result.error.slice(0, 200)}`);
      }

      lines.push('');
    }

    if (trace.summary) {
      lines.push(`Summary: ${trace.summary}`);
    }
    if (trace.error) {
      lines.push(`Cycle Error: ${trace.error}`);
    }

    return lines.join('\n');
  }

  /**
   * Format a trace comparison as a readable diff.
   */
  formatComparison(comparison: TraceComparison): string {
    const lines: string[] = [];

    lines.push(comparison.summary);
    lines.push('');

    lines.push('Tool sequence A: ' + comparison.toolSequenceA.join(' -> '));
    lines.push('Tool sequence B: ' + comparison.toolSequenceB.join(' -> '));

    if (comparison.divergencePoint !== null) {
      lines.push('');
      lines.push(`Divergence at step ${comparison.divergencePoint + 1}`);
    }

    if (comparison.uniqueToA.length > 0) {
      lines.push('');
      lines.push('Tools unique to A:');
      for (const s of comparison.uniqueToA) {
        lines.push(`  Step ${s.step}: ${s.toolCalled}`);
      }
    }

    if (comparison.uniqueToB.length > 0) {
      lines.push('');
      lines.push('Tools unique to B:');
      for (const s of comparison.uniqueToB) {
        lines.push(`  Step ${s.step}: ${s.toolCalled}`);
      }
    }

    return lines.join('\n');
  }

  // ── Private ───────────────────────────────────────────────────────────────

  private async loadIndex(): Promise<void> {
    const indexFile = join(this.resolvedBasePath, 'index.json');

    try {
      const content = await readFile(indexFile, 'utf8');
      const parsed = JSON.parse(content);

      if (Array.isArray(parsed)) {
        this.index = parsed as TraceIndexEntry[];
      }
    } catch {
      // Index doesn't exist yet — rebuild from files
      await this.rebuildIndex();
    }
  }

  private async saveIndex(): Promise<void> {
    const indexFile = join(this.resolvedBasePath, 'index.json');
    await writeFile(indexFile, JSON.stringify(this.index, null, 2), 'utf8');
  }

  private async rebuildIndex(): Promise<void> {
    const tracer = getTracer();
    this.index = [];

    try {
      const files = await readdir(this.resolvedBasePath);
      const traceFiles = files.filter(
        (f) => f.endsWith('.json') && f !== 'index.json',
      );

      for (const file of traceFiles) {
        try {
          const content = await readFile(
            join(this.resolvedBasePath, file),
            'utf8',
          );
          const trace = JSON.parse(content) as ExecutionTrace;

          this.index.push({
            cycleId: trace.cycleId,
            timestamp: trace.startedAt,
            outcome: trace.outcome,
            triggerType: trace.triggerType,
            stepCount: trace.steps.length,
            toolsUsed: [...new Set(trace.steps.map((s) => s.toolCalled))],
            totalDurationMs: trace.totalDurationMs,
            referenced: false,
          });
        } catch {
          // Skip invalid trace files
        }
      }

      await this.saveIndex();
      tracer.log('memory', 'info', `Rebuilt trace index: ${this.index.length} entries`);
    } catch {
      // Traces directory doesn't exist yet
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────────────────────

export function createTraceReplay(
  config?: Partial<TraceReplayConfig>,
): TraceReplay {
  return new TraceReplay(config);
}
