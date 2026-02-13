import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createBenchmarkStore, type BenchmarkStore } from '../src/benchmark/store.js';
import type { BenchmarkRun, AggregateScore } from '../src/benchmark/types.js';

let testDir: string;
let store: BenchmarkStore;

function makeAggregate(overrides: Partial<AggregateScore> = {}): AggregateScore {
  return {
    overall: 75,
    structuralAvg: 0.8,
    toolEfficiencyAvg: 0.9,
    avgTtftMs: 200,
    avgTotalMs: 1000,
    avgEvalRate: 25,
    passRate: 0.9,
    byDifficulty: {},
    byCategory: {},
    ...overrides,
  };
}

function makeRun(overrides: Partial<BenchmarkRun> = {}): BenchmarkRun {
  return {
    id: `run-${Math.random().toString(36).substring(2, 8)}`,
    modelId: 'hermes3:70b',
    timestamp: Date.now(),
    suiteId: 'casterly-v1',
    cases: [],
    aggregate: makeAggregate(),
    ...overrides,
  };
}

beforeEach(() => {
  testDir = join(tmpdir(), `casterly-bench-test-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`);
  mkdirSync(testDir, { recursive: true });
  store = createBenchmarkStore(testDir);
});

afterEach(() => {
  if (existsSync(testDir)) {
    rmSync(testDir, { recursive: true, force: true });
  }
});

// ─── CRUD ───────────────────────────────────────────────────────────────────

describe('BenchmarkStore CRUD', () => {
  it('starts empty', () => {
    expect(store.getAll()).toHaveLength(0);
  });

  it('adds and retrieves a run', () => {
    const run = makeRun();
    store.add(run);

    const all = store.getAll();
    expect(all).toHaveLength(1);
    expect(all[0]!.id).toBe(run.id);
  });

  it('stores multiple runs', () => {
    store.add(makeRun());
    store.add(makeRun());
    store.add(makeRun());

    expect(store.getAll()).toHaveLength(3);
  });
});

// ─── getByModel ──────────────────────────────────────────────────────────────

describe('getByModel', () => {
  it('filters by model ID', () => {
    store.add(makeRun({ modelId: 'hermes3:70b' }));
    store.add(makeRun({ modelId: 'llama3.3:70b' }));
    store.add(makeRun({ modelId: 'hermes3:70b' }));

    expect(store.getByModel('hermes3:70b')).toHaveLength(2);
    expect(store.getByModel('llama3.3:70b')).toHaveLength(1);
  });

  it('returns empty for unknown model', () => {
    store.add(makeRun({ modelId: 'hermes3:70b' }));

    expect(store.getByModel('unknown:7b')).toHaveLength(0);
  });
});

// ─── getLatest ───────────────────────────────────────────────────────────────

describe('getLatest', () => {
  it('returns the most recent run for a model', () => {
    store.add(makeRun({ modelId: 'hermes3:70b', timestamp: 1000 }));
    store.add(makeRun({ modelId: 'hermes3:70b', timestamp: 3000 }));
    store.add(makeRun({ modelId: 'hermes3:70b', timestamp: 2000 }));

    const latest = store.getLatest('hermes3:70b');
    expect(latest?.timestamp).toBe(3000);
  });

  it('returns undefined for unknown model', () => {
    expect(store.getLatest('unknown:7b')).toBeUndefined();
  });
});

// ─── compact ─────────────────────────────────────────────────────────────────

describe('compact', () => {
  it('removes runs older than 90 days', () => {
    const oldRun = makeRun({
      timestamp: Date.now() - 91 * 24 * 60 * 60 * 1000,
    });
    store.add(oldRun);

    const removed = store.compact();
    expect(removed).toBe(1);
    expect(store.getAll()).toHaveLength(0);
  });

  it('keeps recent runs', () => {
    const recentRun = makeRun({
      timestamp: Date.now() - 1000,
    });
    store.add(recentRun);

    const removed = store.compact();
    expect(removed).toBe(0);
    expect(store.getAll()).toHaveLength(1);
  });
});

// ─── persistence ─────────────────────────────────────────────────────────────

describe('persistence', () => {
  it('persists runs across store instances', () => {
    const run = makeRun();
    store.add(run);

    const store2 = createBenchmarkStore(testDir);
    expect(store2.getAll()).toHaveLength(1);
    expect(store2.getAll()[0]!.id).toBe(run.id);
  });

  it('handles missing file gracefully', () => {
    const emptyDir = join(tmpdir(), `casterly-bench-empty-${Date.now()}`);
    const emptyStore = createBenchmarkStore(emptyDir);

    expect(emptyStore.getAll()).toHaveLength(0);

    if (existsSync(emptyDir)) {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });
});
