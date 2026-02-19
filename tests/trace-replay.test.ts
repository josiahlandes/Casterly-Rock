import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { TraceReplay, createTraceReplay } from '../src/autonomous/trace-replay.js';
import type { ExecutionTrace, TraceStep } from '../src/autonomous/trace-replay.js';
import { resetTracer, initTracer } from '../src/autonomous/debug.js';

// ─────────────────────────────────────────────────────────────────────────────
// Setup
// ─────────────────────────────────────────────────────────────────────────────

let tempDir: string;

beforeEach(async () => {
  resetTracer();
  initTracer({ enabled: false });
  tempDir = await mkdtemp(join(tmpdir(), 'casterly-traces-'));
});

afterEach(async () => {
  resetTracer();
  await rm(tempDir, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeStep(step: number, tool: string, success: boolean): TraceStep {
  return {
    step,
    timestamp: new Date().toISOString(),
    toolCalled: tool,
    parameters: { key: 'value' },
    result: {
      success,
      ...(success ? { output: 'ok' } : { error: 'failed' }),
    },
    reasoning: `Decided to use ${tool}`,
    durationMs: 100 * step,
  };
}

function makeTrace(cycleId: string, outcome: 'success' | 'failure', tools: string[]): ExecutionTrace {
  return {
    cycleId,
    startedAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
    triggerType: 'test',
    outcome,
    steps: tools.map((t, i) => makeStep(i + 1, t, outcome === 'success')),
    totalDurationMs: tools.length * 100,
    summary: `Test trace: ${outcome}`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('TraceReplay — Recording and Replay', () => {
  let replay: TraceReplay;

  beforeEach(() => {
    replay = new TraceReplay({
      basePath: join(tempDir, 'traces'),
      successRetentionDays: 7,
      failureRetentionDays: 30,
      maxTraces: 100,
    });
  });

  it('records a trace and replays it', async () => {
    const trace = makeTrace('cycle-001', 'success', ['think', 'read_file', 'edit_file']);
    await replay.record(trace);

    const replayed = await replay.replay('cycle-001');
    expect(replayed).not.toBeNull();
    expect(replayed!.cycleId).toBe('cycle-001');
    expect(replayed!.steps.length).toBe(3);
    expect(replayed!.outcome).toBe('success');
  });

  it('returns null for nonexistent trace', async () => {
    const result = await replay.replay('nonexistent');
    expect(result).toBeNull();
  });

  it('filters by step range', async () => {
    const trace = makeTrace('cycle-002', 'success', ['think', 'read_file', 'edit_file', 'run_tests']);
    await replay.record(trace);

    const replayed = await replay.replay('cycle-002', { stepRange: [2, 3] });
    expect(replayed!.steps.length).toBe(2);
    expect(replayed!.steps[0]!.toolCalled).toBe('read_file');
    expect(replayed!.steps[1]!.toolCalled).toBe('edit_file');
  });

  it('filters by tool name', async () => {
    const trace = makeTrace('cycle-003', 'success', ['think', 'read_file', 'think', 'edit_file']);
    await replay.record(trace);

    const replayed = await replay.replay('cycle-003', { toolFilter: 'think' });
    expect(replayed!.steps.length).toBe(2);
    expect(replayed!.steps.every((s) => s.toolCalled === 'think')).toBe(true);
  });

  it('maintains an index of recorded traces', async () => {
    await replay.record(makeTrace('c-1', 'success', ['think']));
    await replay.record(makeTrace('c-2', 'failure', ['read_file', 'edit_file']));

    expect(replay.count()).toBe(2);

    const index = replay.getIndex();
    expect(index[0]!.cycleId).toBe('c-1');
    expect(index[1]!.cycleId).toBe('c-2');
  });
});

describe('TraceReplay — Comparison', () => {
  let replay: TraceReplay;

  beforeEach(() => {
    replay = new TraceReplay({
      basePath: join(tempDir, 'traces'),
    });
  });

  it('compares two traces and finds divergence', async () => {
    await replay.record(makeTrace('a', 'success', ['think', 'read_file', 'edit_file']));
    await replay.record(makeTrace('b', 'failure', ['think', 'read_file', 'bash']));

    const comparison = await replay.compareTraces('a', 'b');
    expect(comparison).not.toBeNull();
    expect(comparison!.divergencePoint).toBe(2); // Diverge at step 3 (index 2)
    expect(comparison!.outcomes.a).toBe('success');
    expect(comparison!.outcomes.b).toBe('failure');
    expect(comparison!.toolSequenceA).toEqual(['think', 'read_file', 'edit_file']);
    expect(comparison!.toolSequenceB).toEqual(['think', 'read_file', 'bash']);
  });

  it('handles identical tool sequences', async () => {
    await replay.record(makeTrace('x', 'success', ['think', 'read_file']));
    await replay.record(makeTrace('y', 'success', ['think', 'read_file']));

    const comparison = await replay.compareTraces('x', 'y');
    expect(comparison!.divergencePoint).toBeNull();
    expect(comparison!.summary).toContain('identical');
  });

  it('returns null when one trace is missing', async () => {
    await replay.record(makeTrace('exists', 'success', ['think']));

    const comparison = await replay.compareTraces('exists', 'missing');
    expect(comparison).toBeNull();
  });
});

describe('TraceReplay — Search', () => {
  let replay: TraceReplay;

  beforeEach(async () => {
    replay = new TraceReplay({
      basePath: join(tempDir, 'traces'),
    });

    await replay.record(makeTrace('s-1', 'success', ['think', 'read_file']));
    await replay.record(makeTrace('f-1', 'failure', ['think', 'bash']));
    await replay.record(makeTrace('s-2', 'success', ['edit_file', 'run_tests']));
    await replay.record(makeTrace('f-2', 'failure', ['read_file', 'edit_file', 'run_tests']));
  });

  it('searches by outcome', () => {
    const failures = replay.searchTraces({ outcome: 'failure' });
    expect(failures.length).toBe(2);
    expect(failures.every((t) => t.outcome === 'failure')).toBe(true);
  });

  it('searches by tool used', () => {
    const bashTraces = replay.searchTraces({ toolUsed: 'bash' });
    expect(bashTraces.length).toBe(1);
    expect(bashTraces[0]!.cycleId).toBe('f-1');
  });

  it('limits search results', () => {
    const results = replay.searchTraces({ limit: 2 });
    expect(results.length).toBe(2);
  });

  it('gets recent failures', () => {
    const failures = replay.getRecentFailures(1);
    expect(failures.length).toBe(1);
    expect(failures[0]!.outcome).toBe('failure');
  });
});

describe('TraceReplay — Retention', () => {
  it('marks traces as referenced', async () => {
    const replay = new TraceReplay({
      basePath: join(tempDir, 'traces'),
    });

    await replay.record(makeTrace('ref-1', 'success', ['think']));
    const marked = replay.markReferenced('ref-1');
    expect(marked).toBe(true);

    const index = replay.getIndex();
    expect(index[0]!.referenced).toBe(true);
  });

  it('returns false marking nonexistent trace', async () => {
    const replay = new TraceReplay({
      basePath: join(tempDir, 'traces'),
    });
    expect(replay.markReferenced('nonexistent')).toBe(false);
  });
});

describe('TraceReplay — Formatting', () => {
  it('formats a trace as readable text', () => {
    const replay = new TraceReplay({
      basePath: join(tempDir, 'traces'),
    });

    const trace = makeTrace('fmt-1', 'success', ['think', 'read_file']);
    const formatted = replay.formatTrace(trace);

    expect(formatted).toContain('Cycle: fmt-1');
    expect(formatted).toContain('Outcome: success');
    expect(formatted).toContain('Step 1: think');
    expect(formatted).toContain('Step 2: read_file');
  });

  it('formats a comparison', async () => {
    const replay = new TraceReplay({
      basePath: join(tempDir, 'traces'),
    });

    await replay.record(makeTrace('cmp-a', 'success', ['think', 'edit_file']));
    await replay.record(makeTrace('cmp-b', 'failure', ['think', 'bash']));

    const comparison = await replay.compareTraces('cmp-a', 'cmp-b');
    const formatted = replay.formatComparison(comparison!);

    expect(formatted).toContain('cmp-a');
    expect(formatted).toContain('cmp-b');
    expect(formatted).toContain('Divergence');
  });
});

describe('TraceReplay — Factory', () => {
  it('creates replay with default config', () => {
    const replay = createTraceReplay();
    expect(replay).toBeInstanceOf(TraceReplay);
  });

  it('creates replay with custom config', () => {
    const replay = createTraceReplay({
      basePath: join(tempDir, 'custom-traces'),
      successRetentionDays: 14,
    });
    expect(replay).toBeInstanceOf(TraceReplay);
  });
});
