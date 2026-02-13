/**
 * Benchmark Store (ISSUE-008)
 *
 * Persistent store for benchmark runs.
 * Single JSON file at ~/.casterly/benchmarks/runs.json.
 * In-memory cache with full rewrite on mutation.
 *
 * Follows the factory pattern from src/scheduler/store.ts.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { BenchmarkRun, BenchmarkStoreData } from './types.js';

/** Default storage path */
const DEFAULT_STORAGE_PATH = join(homedir(), '.casterly', 'benchmarks');

/** Max age for runs before compaction (90 days) */
const RUN_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;

// ─── Interface ──────────────────────────────────────────────────────────────

export interface BenchmarkStore {
  /** Add a benchmark run */
  add(run: BenchmarkRun): void;
  /** Get all runs */
  getAll(): BenchmarkRun[];
  /** Get runs for a specific model */
  getByModel(modelId: string): BenchmarkRun[];
  /** Get the most recent run for a model */
  getLatest(modelId: string): BenchmarkRun | undefined;
  /** Remove runs older than 90 days. Returns count removed. */
  compact(): number;
}

// ─── Persistence ────────────────────────────────────────────────────────────

function loadRuns(filePath: string): BenchmarkRun[] {
  if (!existsSync(filePath)) {
    return [];
  }

  try {
    const content = readFileSync(filePath, 'utf-8').trim();
    if (!content) return [];

    const data = JSON.parse(content) as BenchmarkStoreData;
    if (data.version !== 1 || !Array.isArray(data.runs)) {
      return [];
    }

    return data.runs;
  } catch {
    return [];
  }
}

function saveRuns(filePath: string, runs: BenchmarkRun[]): void {
  const data: BenchmarkStoreData = { version: 1, runs };
  try {
    writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
  } catch {
    // Silently fail — benchmark store is non-critical
  }
}

// ─── Factory ────────────────────────────────────────────────────────────────

export function createBenchmarkStore(storagePath?: string): BenchmarkStore {
  const baseDir = storagePath ?? DEFAULT_STORAGE_PATH;
  const filePath = join(baseDir, 'runs.json');

  // Ensure directory exists
  if (!existsSync(baseDir)) {
    mkdirSync(baseDir, { recursive: true });
  }

  // Load existing runs
  let runs = loadRuns(filePath);

  // Compact on creation
  const now = Date.now();
  const beforeCount = runs.length;
  runs = runs.filter((r) => r.timestamp > now - RUN_MAX_AGE_MS);

  if (runs.length !== beforeCount) {
    saveRuns(filePath, runs);
  }

  return {
    add(run: BenchmarkRun): void {
      runs.push(run);
      saveRuns(filePath, runs);
    },

    getAll(): BenchmarkRun[] {
      return [...runs];
    },

    getByModel(modelId: string): BenchmarkRun[] {
      return runs.filter((r) => r.modelId === modelId);
    },

    getLatest(modelId: string): BenchmarkRun | undefined {
      const modelRuns = runs.filter((r) => r.modelId === modelId);
      if (modelRuns.length === 0) return undefined;
      return modelRuns.reduce((latest, r) =>
        r.timestamp > latest.timestamp ? r : latest,
      );
    },

    compact(): number {
      const now = Date.now();
      const beforeCount = runs.length;

      runs = runs.filter((r) => r.timestamp > now - RUN_MAX_AGE_MS);

      const removed = beforeCount - runs.length;
      if (removed > 0) {
        saveRuns(filePath, runs);
      }

      return removed;
    },
  };
}
