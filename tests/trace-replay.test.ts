import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resetTracer, initTracer } from '../src/autonomous/debug.js';
import { TraceReplayStore } from '../src/autonomous/trace-replay.js';
import type { ExecutionTrace } from '../src/autonomous/trace-replay.js';

// ═══════════════════════════════════════════════════════════════════════════════
// Trace Replay Tests
// ═══════════════════════════════════════════════════════════════════════════════

let tempDir: string;
let store: TraceReplayStore;

function makeTrace(overrides?: Partial<ExecutionTrace>): ExecutionTrace {
  const id = `cycle-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  return {
    cycleId: id,
    startedAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
    outcome: 'success',
    trigger: 'user_message',
    steps: [
      {
        step: 1,
        timestamp: new Date().toISOString(),
        toolCalled: 'think',
        parameters: { reasoning: 'Planning approach' },
        result: 'Reasoning recorded.',
        durationMs: 50,
      },
      {
        step: 2,
        timestamp: new Date().toISOString(),
        toolCalled: 'read_file',
        parameters: { path: 'src/main.ts' },
        result: 'File contents...',
        durationMs: 10,
      },
    ],
    toolsUsed: ['think', 'read_file'],
    tags: ['refactoring'],
    pinned: false,
    ...overrides,
  };
}

beforeEach(async () => {
  resetTracer();
  initTracer({ enabled: false });
  tempDir = await mkdtemp(join(tmpdir(), 'casterly-traces-'));
  store = new TraceReplayStore({
    path: join(tempDir, 'traces'),
    successRetentionDays: 7,
    failureRetentionDays: 30,
    maxTraces: 10,
  });
  await store.load();
});

afterEach(async () => {
  resetTracer();
  await rm(tempDir, { recursive: true, force: true });
});

describe('TraceReplayStore — Lifecycle', () => {
  it('starts empty after load', () => {
    expect(store.count()).toBe(0);
    expect(store.isLoaded()).toBe(true);
  });

  it('persists index across save/load', async () => {
    await store.recordTrace(makeTrace({ cycleId: 'cycle-persist' }));

    const store2 = new TraceReplayStore({ path: join(tempDir, 'traces') });
    await store2.load();

    expect(store2.count()).toBe(1);
    expect(store2.getIndex()[0]!.cycleId).toBe('cycle-persist');
  });

  it('handles missing directory gracefully', async () => {
    const store2 = new TraceReplayStore({ path: join(tempDir, 'nonexistent') });
    await store2.load();
    expect(store2.count()).toBe(0);
    expect(store2.isLoaded()).toBe(true);
  });
});

describe('TraceReplayStore — Record', () => {
  it('records a trace and indexes it', async () => {
    const trace = makeTrace({ cycleId: 'cycle-record' });
    await store.recordTrace(trace);

    expect(store.count()).toBe(1);
    const entry = store.getIndex()[0]!;
    expect(entry.cycleId).toBe('cycle-record');
    expect(entry.outcome).toBe('success');
    expect(entry.stepCount).toBe(2);
    expect(entry.toolsUsed).toContain('think');
    expect(entry.toolsUsed).toContain('read_file');
  });

  it('enforces max traces by removing oldest non-pinned', async () => {
    for (let i = 0; i < 12; i++) {
      await store.recordTrace(makeTrace({ cycleId: `cycle-${i}` }));
    }
    expect(store.count()).toBe(10);
  });

  it('does not remove pinned traces when enforcing max', async () => {
    await store.recordTrace(makeTrace({ cycleId: 'pinned-1', pinned: true }));
    for (let i = 0; i < 11; i++) {
      await store.recordTrace(makeTrace({ cycleId: `cycle-${i}` }));
    }

    const pinned = store.getIndex().find((e) => e.cycleId === 'pinned-1');
    expect(pinned).toBeDefined();
  });

  it('replaces existing index entry for same cycleId', async () => {
    await store.recordTrace(makeTrace({ cycleId: 'cycle-dup', outcome: 'failure' }));
    await store.recordTrace(makeTrace({ cycleId: 'cycle-dup', outcome: 'success' }));

    expect(store.count()).toBe(1);
    expect(store.getIndex()[0]!.outcome).toBe('success');
  });
});

describe('TraceReplayStore — Replay', () => {
  it('replays a full trace', async () => {
    const trace = makeTrace({ cycleId: 'cycle-replay' });
    await store.recordTrace(trace);

    const replayed = await store.replay('cycle-replay');
    expect(replayed).not.toBeNull();
    expect(replayed!.cycleId).toBe('cycle-replay');
    expect(replayed!.steps).toHaveLength(2);
  });

  it('returns null for missing trace', async () => {
    const result = await store.replay('nonexistent');
    expect(result).toBeNull();
  });

  it('filters by step range', async () => {
    await store.recordTrace(makeTrace({ cycleId: 'cycle-range' }));

    const replayed = await store.replay('cycle-range', { stepRange: [2, 2] });
    expect(replayed!.steps).toHaveLength(1);
    expect(replayed!.steps[0]!.toolCalled).toBe('read_file');
  });

  it('filters by tool', async () => {
    await store.recordTrace(makeTrace({ cycleId: 'cycle-tool' }));

    const replayed = await store.replay('cycle-tool', { toolFilter: 'think' });
    expect(replayed!.steps).toHaveLength(1);
    expect(replayed!.steps[0]!.toolCalled).toBe('think');
  });
});

describe('TraceReplayStore — Compare', () => {
  it('compares two traces', async () => {
    await store.recordTrace(makeTrace({
      cycleId: 'cycle-a',
      outcome: 'success',
      toolsUsed: ['think', 'read_file', 'edit_file'],
    }));
    await store.recordTrace(makeTrace({
      cycleId: 'cycle-b',
      outcome: 'failure',
      toolsUsed: ['think', 'bash'],
    }));

    const comparison = await store.compareTraces('cycle-a', 'cycle-b');
    expect(comparison).not.toBeNull();
    expect(comparison!.commonTools).toContain('think');
    expect(comparison!.uniqueToA).toContain('read_file');
    expect(comparison!.uniqueToB).toContain('bash');
    expect(comparison!.outcomeA).toBe('success');
    expect(comparison!.outcomeB).toBe('failure');
    expect(comparison!.summary).toContain('Trace Comparison');
  });

  it('returns null if one trace is missing', async () => {
    await store.recordTrace(makeTrace({ cycleId: 'cycle-exists' }));
    const result = await store.compareTraces('cycle-exists', 'cycle-missing');
    expect(result).toBeNull();
  });
});

describe('TraceReplayStore — Search', () => {
  it('searches by outcome', async () => {
    await store.recordTrace(makeTrace({ cycleId: 'cycle-s1', outcome: 'success' }));
    await store.recordTrace(makeTrace({ cycleId: 'cycle-f1', outcome: 'failure' }));

    const results = store.searchTraces({ outcome: 'failure' });
    expect(results).toHaveLength(1);
    expect(results[0]!.cycleId).toBe('cycle-f1');
  });

  it('searches by trigger', async () => {
    await store.recordTrace(makeTrace({ cycleId: 'cycle-um', trigger: 'user_message' }));
    await store.recordTrace(makeTrace({ cycleId: 'cycle-ev', trigger: 'file_change' }));

    const results = store.searchTraces({ trigger: 'file' });
    expect(results).toHaveLength(1);
    expect(results[0]!.cycleId).toBe('cycle-ev');
  });

  it('searches by tool', async () => {
    await store.recordTrace(makeTrace({ cycleId: 'cycle-t1', toolsUsed: ['bash', 'think'] }));
    await store.recordTrace(makeTrace({ cycleId: 'cycle-t2', toolsUsed: ['read_file'] }));

    const results = store.searchTraces({ tool: 'bash' });
    expect(results).toHaveLength(1);
    expect(results[0]!.cycleId).toBe('cycle-t1');
  });

  it('searches by tag', async () => {
    await store.recordTrace(makeTrace({ cycleId: 'cycle-tagged', tags: ['refactoring', 'typescript'] }));
    await store.recordTrace(makeTrace({ cycleId: 'cycle-other', tags: ['bug-fix'] }));

    const results = store.searchTraces({ tag: 'refactoring' });
    expect(results).toHaveLength(1);
    expect(results[0]!.cycleId).toBe('cycle-tagged');
  });

  it('respects limit', async () => {
    for (let i = 0; i < 5; i++) {
      await store.recordTrace(makeTrace({ cycleId: `cycle-limited-${i}` }));
    }
    const results = store.searchTraces({ limit: 3 });
    expect(results).toHaveLength(3);
  });

  it('getRecentFailures returns recent failures', async () => {
    await store.recordTrace(makeTrace({ cycleId: 'cycle-ok', outcome: 'success' }));
    await store.recordTrace(makeTrace({ cycleId: 'cycle-fail', outcome: 'failure' }));

    const failures = store.getRecentFailures();
    expect(failures).toHaveLength(1);
    expect(failures[0]!.cycleId).toBe('cycle-fail');
  });
});

describe('TraceReplayStore — Pin Management', () => {
  it('pins and unpins traces', async () => {
    await store.recordTrace(makeTrace({ cycleId: 'cycle-pin' }));

    expect(store.pinTrace('cycle-pin')).toBe(true);
    expect(store.getIndex().find((e) => e.cycleId === 'cycle-pin')!.pinned).toBe(true);

    expect(store.unpinTrace('cycle-pin')).toBe(true);
    expect(store.getIndex().find((e) => e.cycleId === 'cycle-pin')!.pinned).toBe(false);
  });

  it('returns false for unknown cycle', () => {
    expect(store.pinTrace('nonexistent')).toBe(false);
    expect(store.unpinTrace('nonexistent')).toBe(false);
  });
});

describe('TraceReplayStore — Retention Pruning', () => {
  it('prunes old success traces', async () => {
    const oldDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(); // 10 days ago
    await store.recordTrace(makeTrace({
      cycleId: 'cycle-old-success',
      outcome: 'success',
      startedAt: oldDate,
    }));
    await store.recordTrace(makeTrace({
      cycleId: 'cycle-recent',
      outcome: 'success',
    }));

    const pruned = await store.pruneByRetention();
    expect(pruned).toBe(1);
    expect(store.count()).toBe(1);
    expect(store.getIndex()[0]!.cycleId).toBe('cycle-recent');
  });

  it('retains pinned traces regardless of age', async () => {
    const oldDate = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString();
    await store.recordTrace(makeTrace({
      cycleId: 'cycle-pinned-old',
      outcome: 'failure',
      startedAt: oldDate,
      pinned: true,
    }));

    const pruned = await store.pruneByRetention();
    expect(pruned).toBe(0);
    expect(store.count()).toBe(1);
  });
});
