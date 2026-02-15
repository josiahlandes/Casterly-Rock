import { describe, expect, it, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { Reflector, type AggregateStats, type MemoryEntry } from '../src/autonomous/reflector.js';
import type { Reflection, CycleMetrics } from '../src/autonomous/types.js';

// ─── Temp dir helpers ────────────────────────────────────────────────────────

const TEST_BASE = join(tmpdir(), `casterly-reflector-test-${Date.now()}`);

afterEach(() => {
  if (existsSync(TEST_BASE)) {
    rmSync(TEST_BASE, { recursive: true, force: true });
  }
});

function reflectionsDir(): string {
  return join(TEST_BASE, 'reflections');
}

function makeReflection(overrides: Partial<Reflection> = {}): Reflection {
  return {
    cycleId: 'cycle-001',
    timestamp: '2025-01-15T10:30:00.000Z',
    observation: {
      id: 'obs-1',
      type: 'error_pattern',
      severity: 'medium',
      frequency: 3,
      context: {},
      suggestedArea: 'src/providers',
      timestamp: '2025-01-15T10:00:00.000Z',
      source: 'error_logs',
    },
    hypothesis: {
      id: 'hyp-1',
      observation: {
        id: 'obs-1',
        type: 'error_pattern',
        severity: 'medium',
        frequency: 3,
        context: {},
        suggestedArea: 'src/providers',
        timestamp: '2025-01-15T10:00:00.000Z',
        source: 'error_logs',
      },
      proposal: 'Add retry logic',
      approach: 'fix_bug',
      expectedImpact: 'medium',
      confidence: 0.7,
      affectedFiles: ['src/providers/ollama.ts'],
      estimatedComplexity: 'simple',
      previousAttempts: 0,
      reasoning: 'Timeouts are frequent',
    },
    outcome: 'success',
    learnings: 'Retry with backoff works well.',
    durationMs: 45000,
    ...overrides,
  };
}

function makeMetrics(overrides: Partial<CycleMetrics> = {}): CycleMetrics {
  return {
    cycleId: 'cycle-001',
    startTime: new Date().toISOString(),
    observationsFound: 5,
    hypothesesGenerated: 3,
    hypothesesAttempted: 2,
    hypothesesSucceeded: 1,
    tokensUsed: { input: 5000, output: 1000 },
    estimatedCostUsd: 0,
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Reflector — saveReflection & loadRecentReflections
// ═══════════════════════════════════════════════════════════════════════════════

describe('Reflector — saveReflection', () => {
  it('saves a reflection as JSON file', async () => {
    const reflector = new Reflector({ reflectionsDir: reflectionsDir() });
    const reflection = makeReflection();

    await reflector.saveReflection(reflection);

    // File should exist
    const files = require('fs').readdirSync(reflectionsDir());
    expect(files.length).toBe(1);
    expect(files[0]!.endsWith('.json')).toBe(true);
  });

  it('uses timestamp and cycleId in filename', async () => {
    const reflector = new Reflector({ reflectionsDir: reflectionsDir() });
    const reflection = makeReflection({
      timestamp: '2025-01-15T10:30:00.000Z',
      cycleId: 'cycle-abc',
    });

    await reflector.saveReflection(reflection);

    const files = require('fs').readdirSync(reflectionsDir());
    expect(files[0]).toContain('cycle-abc');
  });

  it('saves parseable JSON', async () => {
    const reflector = new Reflector({ reflectionsDir: reflectionsDir() });
    const reflection = makeReflection();

    await reflector.saveReflection(reflection);

    const files = require('fs').readdirSync(reflectionsDir());
    const content = readFileSync(join(reflectionsDir(), files[0]!), 'utf-8');
    const parsed = JSON.parse(content) as Reflection;
    expect(parsed.cycleId).toBe('cycle-001');
    expect(parsed.outcome).toBe('success');
  });
});

describe('Reflector — loadRecentReflections', () => {
  it('returns empty array when no reflections', async () => {
    const reflector = new Reflector({ reflectionsDir: reflectionsDir() });
    const result = await reflector.loadRecentReflections();
    expect(result).toEqual([]);
  });

  it('loads saved reflections', async () => {
    const reflector = new Reflector({ reflectionsDir: reflectionsDir() });
    await reflector.saveReflection(makeReflection({ cycleId: 'c1' }));
    await reflector.saveReflection(makeReflection({ cycleId: 'c2', timestamp: '2025-01-15T11:00:00.000Z' }));

    const result = await reflector.loadRecentReflections();
    expect(result.length).toBe(2);
  });

  it('respects limit', async () => {
    const reflector = new Reflector({ reflectionsDir: reflectionsDir() });
    for (let i = 0; i < 5; i++) {
      await reflector.saveReflection(
        makeReflection({ cycleId: `c${i}`, timestamp: `2025-01-15T1${i}:00:00.000Z` })
      );
    }

    const result = await reflector.loadRecentReflections(3);
    expect(result.length).toBe(3);
  });

  it('returns newest first (by filename sort)', async () => {
    const reflector = new Reflector({ reflectionsDir: reflectionsDir() });
    await reflector.saveReflection(makeReflection({ cycleId: 'early', timestamp: '2025-01-01T00:00:00.000Z' }));
    await reflector.saveReflection(makeReflection({ cycleId: 'late', timestamp: '2025-12-31T23:59:00.000Z' }));

    const result = await reflector.loadRecentReflections();
    expect(result[0]!.cycleId).toBe('late');
  });

  it('skips invalid JSON files', async () => {
    const reflector = new Reflector({ reflectionsDir: reflectionsDir() });
    await reflector.saveReflection(makeReflection());

    // Write an invalid JSON file
    mkdirSync(reflectionsDir(), { recursive: true });
    writeFileSync(join(reflectionsDir(), 'invalid.json'), 'not json');

    const result = await reflector.loadRecentReflections();
    // Should have at least the valid one
    expect(result.length).toBeGreaterThanOrEqual(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// getReflectionsByOutcome
// ═══════════════════════════════════════════════════════════════════════════════

describe('Reflector — getReflectionsByOutcome', () => {
  it('filters by outcome', async () => {
    const reflector = new Reflector({ reflectionsDir: reflectionsDir() });
    await reflector.saveReflection(makeReflection({ cycleId: 's1', outcome: 'success', timestamp: '2025-01-15T10:00:00.000Z' }));
    await reflector.saveReflection(makeReflection({ cycleId: 'f1', outcome: 'failure', timestamp: '2025-01-15T11:00:00.000Z' }));
    await reflector.saveReflection(makeReflection({ cycleId: 's2', outcome: 'success', timestamp: '2025-01-15T12:00:00.000Z' }));

    const successes = await reflector.getReflectionsByOutcome('success');
    expect(successes.length).toBe(2);
    expect(successes.every((r) => r.outcome === 'success')).toBe(true);
  });

  it('returns empty when no matching outcome', async () => {
    const reflector = new Reflector({ reflectionsDir: reflectionsDir() });
    await reflector.saveReflection(makeReflection({ outcome: 'success' }));

    const failures = await reflector.getReflectionsByOutcome('failure');
    expect(failures).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Metrics tracking
// ═══════════════════════════════════════════════════════════════════════════════

describe('Reflector — logMetrics', () => {
  it('appends metrics as JSONL', async () => {
    const reflector = new Reflector({ reflectionsDir: reflectionsDir() });
    await reflector.logMetrics(makeMetrics({ cycleId: 'c1' }));
    await reflector.logMetrics(makeMetrics({ cycleId: 'c2' }));

    const metricsFile = join(reflectionsDir(), 'metrics.jsonl');
    const content = readFileSync(metricsFile, 'utf-8');
    const lines = content.trim().split('\n');
    expect(lines.length).toBe(2);

    const first = JSON.parse(lines[0]!) as CycleMetrics;
    expect(first.cycleId).toBe('c1');
  });
});

describe('Reflector — getStatistics', () => {
  it('returns zero stats when no metrics file', async () => {
    const reflector = new Reflector({ reflectionsDir: reflectionsDir() });
    const stats = await reflector.getStatistics();
    expect(stats.totalCycles).toBe(0);
    expect(stats.successRate).toBe(0);
  });

  it('computes aggregate stats from recent metrics', async () => {
    const reflector = new Reflector({ reflectionsDir: reflectionsDir() });

    // Log some metrics
    await reflector.logMetrics(makeMetrics({
      cycleId: 'c1',
      hypothesesSucceeded: 1,
      tokensUsed: { input: 5000, output: 1000 },
      durationMs: 30000,
    }));
    await reflector.logMetrics(makeMetrics({
      cycleId: 'c2',
      hypothesesSucceeded: 0,
      tokensUsed: { input: 3000, output: 500 },
      durationMs: 20000,
    }));

    const stats = await reflector.getStatistics(30); // last 30 days
    expect(stats.totalCycles).toBe(2);
    expect(stats.successfulCycles).toBe(1);
    expect(stats.failedCycles).toBe(1);
    expect(stats.successRate).toBe(0.5);
    expect(stats.totalTokensUsed.input).toBe(8000);
    expect(stats.totalTokensUsed.output).toBe(1500);
  });

  it('filters metrics by date range', async () => {
    const reflector = new Reflector({ reflectionsDir: reflectionsDir() });

    // Log an old metric (more than 7 days ago)
    await reflector.logMetrics(makeMetrics({
      cycleId: 'old',
      startTime: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
      hypothesesSucceeded: 1,
    }));
    // Log a recent metric
    await reflector.logMetrics(makeMetrics({
      cycleId: 'recent',
      startTime: new Date().toISOString(),
      hypothesesSucceeded: 1,
    }));

    const stats = await reflector.getStatistics(7);
    expect(stats.totalCycles).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Memory integration
// ═══════════════════════════════════════════════════════════════════════════════

describe('Reflector — appendToMemory', () => {
  it('creates MEMORY.md with autonomous section when no file exists', async () => {
    const memoryFile = join(TEST_BASE, 'MEMORY.md');
    const reflector = new Reflector({ reflectionsDir: reflectionsDir(), projectRoot: TEST_BASE });

    mkdirSync(TEST_BASE, { recursive: true });

    const entry: MemoryEntry = {
      cycleId: 'cycle-1',
      title: 'Retry logic added',
      content: 'Adding retry with exponential backoff reduced timeout errors by 80%.',
    };

    await reflector.appendToMemory(entry);

    const content = readFileSync(memoryFile, 'utf-8');
    expect(content).toContain('## Autonomous Learnings');
    expect(content).toContain('Retry logic added');
    expect(content).toContain('exponential backoff');
    expect(content).toContain('Cycle: cycle-1');
  });

  it('appends to existing Autonomous Learnings section', async () => {
    const memoryFile = join(TEST_BASE, 'MEMORY.md');
    mkdirSync(TEST_BASE, { recursive: true });
    writeFileSync(memoryFile, '# Memory\n\n## Autonomous Learnings\n\n### Old entry\n\nOld content\n');

    const reflector = new Reflector({ reflectionsDir: reflectionsDir(), projectRoot: TEST_BASE });

    await reflector.appendToMemory({
      cycleId: 'cycle-2',
      title: 'New learning',
      content: 'Something new.',
    });

    const content = readFileSync(memoryFile, 'utf-8');
    expect(content).toContain('Old entry');
    expect(content).toContain('New learning');
    expect(content).toContain('Something new.');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Cleanup
// ═══════════════════════════════════════════════════════════════════════════════

describe('Reflector — cleanupOldReflections', () => {
  it('returns 0 when no reflections exist', async () => {
    const reflector = new Reflector({ reflectionsDir: reflectionsDir() });
    const deleted = await reflector.cleanupOldReflections();
    expect(deleted).toBe(0);
  });

  it('does not delete recent reflections', async () => {
    const reflector = new Reflector({ reflectionsDir: reflectionsDir() });
    await reflector.saveReflection(makeReflection());

    const deleted = await reflector.cleanupOldReflections(90);
    expect(deleted).toBe(0);
  });
});
