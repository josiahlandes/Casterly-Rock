import { describe, expect, it, afterEach } from 'vitest';
import { existsSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { Analyzer } from '../src/autonomous/analyzer.js';

// ─── Temp dir helpers ────────────────────────────────────────────────────────

const TEST_BASE = join(tmpdir(), `casterly-analyzer-test-${Date.now()}`);

afterEach(() => {
  if (existsSync(TEST_BASE)) {
    rmSync(TEST_BASE, { recursive: true, force: true });
  }
});

function setupLogsDir(): string {
  const logsDir = join(TEST_BASE, 'logs');
  mkdirSync(logsDir, { recursive: true });
  return logsDir;
}

function setupReflectionsDir(): string {
  const reflDir = join(TEST_BASE, 'reflections');
  mkdirSync(reflDir, { recursive: true });
  return reflDir;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Analyzer — construction
// ═══════════════════════════════════════════════════════════════════════════════

describe('Analyzer — construction', () => {
  it('creates with default paths', () => {
    const analyzer = new Analyzer(TEST_BASE);
    expect(analyzer).toBeDefined();
  });

  it('creates with custom logsDir', () => {
    const logsDir = join(TEST_BASE, 'custom-logs');
    const analyzer = new Analyzer(TEST_BASE, { logsDir });
    expect(analyzer).toBeDefined();
  });

  it('creates with custom reflectionsDir', () => {
    const reflDir = join(TEST_BASE, 'custom-reflections');
    const analyzer = new Analyzer(TEST_BASE, { reflectionsDir: reflDir });
    expect(analyzer).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// parseErrorLogs — daemon log parsing
// ═══════════════════════════════════════════════════════════════════════════════

describe('Analyzer — parseErrorLogs', () => {
  it('returns empty array when no logs exist', async () => {
    const logsDir = join(TEST_BASE, 'empty-logs');
    const analyzer = new Analyzer(TEST_BASE, { logsDir });

    const entries = await analyzer.parseErrorLogs();
    expect(entries).toEqual([]);
  });

  it('parses error patterns from daemon log', async () => {
    const logsDir = setupLogsDir();
    const now = new Date();
    const today = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
    const logFile = join(logsDir, `daemon-${today}.log`);

    writeFileSync(
      logFile,
      '[ERROR] E1001: Provider timeout\n[ERROR] E1002: Model not found\n[INFO] Normal log\n',
    );

    const analyzer = new Analyzer(TEST_BASE, { logsDir });
    const entries = await analyzer.parseErrorLogs();

    // parseErrorLogs also calls parseTestLogs which may add a TEST_FAILURE entry
    // So we check that our daemon entries exist rather than exact count
    const daemonEntries = entries.filter((e) => e.code !== 'TEST_FAILURE');
    expect(daemonEntries.length).toBe(2);

    const e1001 = entries.find((e) => e.code === 'E1001');
    expect(e1001).toBeDefined();
    expect(e1001!.message).toBe('Provider timeout');

    const e1002 = entries.find((e) => e.code === 'E1002');
    expect(e1002).toBeDefined();
    expect(e1002!.message).toBe('Model not found');
  });

  it('aggregates duplicate errors by frequency', async () => {
    const logsDir = setupLogsDir();
    const now = new Date();
    const today = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
    const logFile = join(logsDir, `daemon-${today}.log`);

    writeFileSync(
      logFile,
      '[ERROR] E1001: Provider timeout\n[ERROR] E1001: Provider timeout\n[ERROR] E1001: Provider timeout\n[ERROR] E1002: Model not found\n',
    );

    const analyzer = new Analyzer(TEST_BASE, { logsDir });
    const entries = await analyzer.parseErrorLogs();

    // May also contain TEST_FAILURE from parseTestLogs, so check daemon entries
    const daemonEntries = entries.filter((e) => e.code !== 'TEST_FAILURE');
    expect(daemonEntries.length).toBe(2);

    // Most frequent first
    const timeout = entries.find((e) => e.code === 'E1001');
    expect(timeout).toBeDefined();
    expect(timeout!.frequency).toBe(3);

    const notFound = entries.find((e) => e.code === 'E1002');
    expect(notFound).toBeDefined();
    expect(notFound!.frequency).toBe(1);
  });

  it('sorts by frequency descending', async () => {
    const logsDir = setupLogsDir();
    const now = new Date();
    const today = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
    const logFile = join(logsDir, `daemon-${today}.log`);

    writeFileSync(
      logFile,
      '[ERROR] E1002: Model not found\n[ERROR] E1001: Provider timeout\n[ERROR] E1001: Provider timeout\n[ERROR] E1001: Provider timeout\n',
    );

    const analyzer = new Analyzer(TEST_BASE, { logsDir });
    const entries = await analyzer.parseErrorLogs();

    expect(entries[0]!.frequency).toBeGreaterThanOrEqual(entries[1]!.frequency);
  });

  it('ignores non-error lines in daemon log', async () => {
    const logsDir = setupLogsDir();
    const now = new Date();
    const today = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
    const logFile = join(logsDir, `daemon-${today}.log`);

    writeFileSync(
      logFile,
      '[INFO] Application started\n[WARN] Low memory\n[DEBUG] Checking something\n',
    );

    const analyzer = new Analyzer(TEST_BASE, { logsDir });
    const entries = await analyzer.parseErrorLogs();

    // No daemon errors, but parseTestLogs may add a TEST_FAILURE entry
    const daemonEntries = entries.filter((e) => e.code !== 'TEST_FAILURE');
    expect(daemonEntries).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// gatherPerformanceMetrics
// ═══════════════════════════════════════════════════════════════════════════════

describe('Analyzer — gatherPerformanceMetrics', () => {
  it('returns default metric when no metrics file exists', async () => {
    const logsDir = join(TEST_BASE, 'empty-logs');
    const analyzer = new Analyzer(TEST_BASE, { logsDir });

    const metrics = await analyzer.gatherPerformanceMetrics();
    expect(metrics.length).toBe(1);
    expect(metrics[0]!.name).toBe('response_time');
    expect(metrics[0]!.samples).toBe(0);
    expect(metrics[0]!.trend).toBe('stable');
  });

  it('loads metrics from file', async () => {
    const logsDir = setupLogsDir();
    const metricsFile = join(logsDir, 'metrics.json');

    writeFileSync(
      metricsFile,
      JSON.stringify([
        { name: 'response_time', p50: 120, p95: 350, p99: 800, samples: 1000, trend: 'improving' },
        { name: 'token_rate', p50: 45, p95: 40, p99: 35, samples: 500, trend: 'stable' },
      ]),
    );

    const analyzer = new Analyzer(TEST_BASE, { logsDir });
    const metrics = await analyzer.gatherPerformanceMetrics();

    expect(metrics.length).toBe(2);
    expect(metrics[0]!.name).toBe('response_time');
    expect(metrics[0]!.p50).toBe(120);
    expect(metrics[1]!.name).toBe('token_rate');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// loadRecentReflections
// ═══════════════════════════════════════════════════════════════════════════════

describe('Analyzer — loadRecentReflections', () => {
  it('returns empty array when no reflections exist', async () => {
    const reflDir = join(TEST_BASE, 'no-reflections');
    const analyzer = new Analyzer(TEST_BASE, { reflectionsDir: reflDir });

    const reflections = await analyzer.loadRecentReflections();
    expect(reflections).toEqual([]);
  });

  it('loads reflections from JSON files', async () => {
    const reflDir = setupReflectionsDir();
    const reflection = {
      cycleId: 'cycle-001',
      timestamp: '2025-06-15T10:00:00.000Z',
      observation: {
        id: 'obs-1',
        type: 'error_pattern',
        severity: 'high',
        frequency: 5,
        context: {},
        suggestedArea: 'provider',
        timestamp: '2025-06-15T10:00:00.000Z',
        source: 'error_logs',
      },
      hypothesis: {
        id: 'hyp-1',
        observation: {} as never,
        proposal: 'Fix timeout',
        approach: 'fix_bug',
        expectedImpact: 'high',
        confidence: 0.8,
        affectedFiles: ['src/provider.ts'],
        estimatedComplexity: 'simple',
        previousAttempts: 0,
        reasoning: 'Common timeout',
      },
      outcome: 'success',
      learnings: 'Increased timeout',
      durationMs: 5000,
    };

    writeFileSync(
      join(reflDir, '2025-06-15T10-00-00-000Z-cycle-001.json'),
      JSON.stringify(reflection),
    );

    const analyzer = new Analyzer(TEST_BASE, { reflectionsDir: reflDir });
    const reflections = await analyzer.loadRecentReflections();

    expect(reflections.length).toBe(1);
    expect(reflections[0]!.cycleId).toBe('cycle-001');
    expect(reflections[0]!.outcome).toBe('success');
  });

  it('respects limit parameter', async () => {
    const reflDir = setupReflectionsDir();

    for (let i = 0; i < 5; i++) {
      const reflection = {
        cycleId: `cycle-${i}`,
        timestamp: `2025-06-15T1${i}:00:00.000Z`,
        observation: {},
        hypothesis: { proposal: `Fix #${i}` },
        outcome: 'success',
        learnings: '',
        durationMs: 1000,
      };
      writeFileSync(
        join(reflDir, `2025-06-15T1${i}-00-00-000Z-cycle-${i}.json`),
        JSON.stringify(reflection),
      );
    }

    const analyzer = new Analyzer(TEST_BASE, { reflectionsDir: reflDir });
    const reflections = await analyzer.loadRecentReflections(3);

    expect(reflections.length).toBe(3);
  });

  it('sorts by timestamp descending (most recent first)', async () => {
    const reflDir = setupReflectionsDir();

    for (let i = 0; i < 3; i++) {
      const reflection = {
        cycleId: `cycle-${i}`,
        timestamp: `2025-06-1${5 + i}T10:00:00.000Z`,
        observation: {},
        hypothesis: { proposal: `Fix #${i}` },
        outcome: 'success',
        learnings: '',
        durationMs: 1000,
      };
      writeFileSync(
        join(reflDir, `2025-06-1${5 + i}T10-00-00-000Z-cycle-${i}.json`),
        JSON.stringify(reflection),
      );
    }

    const analyzer = new Analyzer(TEST_BASE, { reflectionsDir: reflDir });
    const reflections = await analyzer.loadRecentReflections();

    // Most recent first (2025-06-17 before 2025-06-16 before 2025-06-15)
    expect(reflections[0]!.cycleId).toBe('cycle-2');
    expect(reflections[1]!.cycleId).toBe('cycle-1');
    expect(reflections[2]!.cycleId).toBe('cycle-0');
  });

  it('skips invalid JSON files', async () => {
    const reflDir = setupReflectionsDir();

    writeFileSync(join(reflDir, 'valid.json'), JSON.stringify({ cycleId: 'good', outcome: 'success' }));
    writeFileSync(join(reflDir, 'invalid.json'), 'not valid json {{{');

    const analyzer = new Analyzer(TEST_BASE, { reflectionsDir: reflDir });
    const reflections = await analyzer.loadRecentReflections();

    expect(reflections.length).toBe(1);
  });

  it('ignores non-JSON files', async () => {
    const reflDir = setupReflectionsDir();

    writeFileSync(join(reflDir, 'valid.json'), JSON.stringify({ cycleId: 'good' }));
    writeFileSync(join(reflDir, 'readme.txt'), 'Not a reflection');
    writeFileSync(join(reflDir, 'data.md'), '# Markdown');

    const analyzer = new Analyzer(TEST_BASE, { reflectionsDir: reflDir });
    const reflections = await analyzer.loadRecentReflections();

    expect(reflections.length).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// readFile / readFiles
// ═══════════════════════════════════════════════════════════════════════════════

describe('Analyzer — readFile', () => {
  it('reads a file from project root', async () => {
    mkdirSync(join(TEST_BASE, 'src'), { recursive: true });
    writeFileSync(join(TEST_BASE, 'src', 'index.ts'), 'export const x = 1;\n');

    const analyzer = new Analyzer(TEST_BASE);
    const content = await analyzer.readFile('src/index.ts');

    expect(content).toBe('export const x = 1;\n');
  });

  it('reads a file with absolute path', async () => {
    mkdirSync(join(TEST_BASE, 'src'), { recursive: true });
    const filePath = join(TEST_BASE, 'src', 'abs.ts');
    writeFileSync(filePath, 'const y = 2;\n');

    const analyzer = new Analyzer(TEST_BASE);
    const content = await analyzer.readFile(filePath);

    expect(content).toBe('const y = 2;\n');
  });

  it('returns null for non-existent file', async () => {
    const analyzer = new Analyzer(TEST_BASE);
    const content = await analyzer.readFile('nonexistent.ts');
    expect(content).toBeNull();
  });
});

describe('Analyzer — readFiles', () => {
  it('reads multiple files into a Map', async () => {
    mkdirSync(join(TEST_BASE, 'src'), { recursive: true });
    writeFileSync(join(TEST_BASE, 'src', 'a.ts'), 'const a = 1;\n');
    writeFileSync(join(TEST_BASE, 'src', 'b.ts'), 'const b = 2;\n');

    const analyzer = new Analyzer(TEST_BASE);
    const contents = await analyzer.readFiles(['src/a.ts', 'src/b.ts']);

    expect(contents.size).toBe(2);
    expect(contents.get('src/a.ts')).toBe('const a = 1;\n');
    expect(contents.get('src/b.ts')).toBe('const b = 2;\n');
  });

  it('skips non-existent files', async () => {
    mkdirSync(join(TEST_BASE, 'src'), { recursive: true });
    writeFileSync(join(TEST_BASE, 'src', 'exists.ts'), 'const x = 1;\n');

    const analyzer = new Analyzer(TEST_BASE);
    const contents = await analyzer.readFiles(['src/exists.ts', 'src/missing.ts']);

    expect(contents.size).toBe(1);
    expect(contents.has('src/exists.ts')).toBe(true);
    expect(contents.has('src/missing.ts')).toBe(false);
  });

  it('returns empty map for empty input', async () => {
    const analyzer = new Analyzer(TEST_BASE);
    const contents = await analyzer.readFiles([]);
    expect(contents.size).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// gatherContext
// ═══════════════════════════════════════════════════════════════════════════════

describe('Analyzer — gatherContext', () => {
  it('returns full context with all sections', async () => {
    const logsDir = setupLogsDir();
    const reflDir = setupReflectionsDir();

    const analyzer = new Analyzer(TEST_BASE, { logsDir, reflectionsDir: reflDir });
    const context = await analyzer.gatherContext();

    expect(context).toBeDefined();
    expect(context.errorLogs).toBeDefined();
    expect(context.performanceMetrics).toBeDefined();
    expect(context.recentReflections).toBeDefined();
    expect(context.codebaseStats).toBeDefined();
  });

  it('codebaseStats has default structure', async () => {
    const logsDir = setupLogsDir();
    const reflDir = setupReflectionsDir();

    const analyzer = new Analyzer(TEST_BASE, { logsDir, reflectionsDir: reflDir });
    const context = await analyzer.gatherContext();

    expect(typeof context.codebaseStats.totalFiles).toBe('number');
    expect(typeof context.codebaseStats.totalLines).toBe('number');
    expect(typeof context.codebaseStats.lintErrors).toBe('number');
    expect(typeof context.codebaseStats.typeErrors).toBe('number');
    expect(typeof context.codebaseStats.lastCommit).toBe('string');
  });
});
