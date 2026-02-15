import { describe, expect, it, afterEach } from 'vitest';
import { existsSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createExecutionLog } from '../src/tasks/execution-log.js';
import type { ExecutionRecord, TaskPlan, StepOutcome } from '../src/tasks/types.js';

// ─── Temp dir helpers ────────────────────────────────────────────────────────

const TEST_BASE = join(tmpdir(), `casterly-execlog-test-${Date.now()}`);

afterEach(() => {
  if (existsSync(TEST_BASE)) {
    rmSync(TEST_BASE, { recursive: true, force: true });
  }
});

function makeRecord(overrides: Partial<ExecutionRecord> = {}): ExecutionRecord {
  return {
    id: `rec-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    timestamp: Date.now(),
    taskType: 'file_operation',
    originalInstruction: 'Test instruction',
    plan: {
      goal: 'Test goal',
      completionCriteria: ['done'],
      steps: [],
    },
    stepResults: [],
    overallSuccess: true,
    durationMs: 100,
    retries: 0,
    ...overrides,
  };
}

function makeStepOutcome(overrides: Partial<StepOutcome> = {}): StepOutcome {
  return {
    stepId: 'step-1',
    tool: 'bash',
    success: true,
    retries: 0,
    durationMs: 50,
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// createExecutionLog — creation
// ═══════════════════════════════════════════════════════════════════════════════

describe('createExecutionLog — creation', () => {
  it('creates the storage directory', () => {
    const dir = join(TEST_BASE, 'log-dir');
    createExecutionLog(dir);
    expect(existsSync(dir)).toBe(true);
  });

  it('starts with count 0 for new directory', () => {
    const dir = join(TEST_BASE, 'new-dir');
    const log = createExecutionLog(dir);
    expect(log.count()).toBe(0);
  });

  it('loads existing records from file', () => {
    const dir = join(TEST_BASE, 'existing');
    mkdirSync(dir, { recursive: true });

    const record = makeRecord({ id: 'pre-existing' });
    writeFileSync(join(dir, 'log.jsonl'), JSON.stringify(record) + '\n');

    const log = createExecutionLog(dir);
    expect(log.count()).toBe(1);
  });

  it('skips malformed lines on load', () => {
    const dir = join(TEST_BASE, 'malformed');
    mkdirSync(dir, { recursive: true });

    const good = makeRecord({ id: 'good' });
    writeFileSync(join(dir, 'log.jsonl'), [
      'not valid json',
      JSON.stringify(good),
      '{incomplete',
    ].join('\n') + '\n');

    const log = createExecutionLog(dir);
    expect(log.count()).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// append
// ═══════════════════════════════════════════════════════════════════════════════

describe('createExecutionLog — append', () => {
  it('appends a record', () => {
    const dir = join(TEST_BASE, 'append');
    const log = createExecutionLog(dir);

    log.append(makeRecord({ id: 'test-1' }));
    expect(log.count()).toBe(1);
  });

  it('appends to disk file', () => {
    const dir = join(TEST_BASE, 'append-disk');
    const log = createExecutionLog(dir);

    log.append(makeRecord({ id: 'disk-1' }));

    const content = readFileSync(join(dir, 'log.jsonl'), 'utf-8');
    expect(content).toContain('disk-1');
  });

  it('appends multiple records', () => {
    const dir = join(TEST_BASE, 'multi');
    const log = createExecutionLog(dir);

    log.append(makeRecord({ id: 'r1' }));
    log.append(makeRecord({ id: 'r2' }));
    log.append(makeRecord({ id: 'r3' }));

    expect(log.count()).toBe(3);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// queryByType
// ═══════════════════════════════════════════════════════════════════════════════

describe('createExecutionLog — queryByType', () => {
  it('filters by task type', () => {
    const dir = join(TEST_BASE, 'bytype');
    const log = createExecutionLog(dir);

    log.append(makeRecord({ taskType: 'coding' }));
    log.append(makeRecord({ taskType: 'file_operation' }));
    log.append(makeRecord({ taskType: 'coding' }));

    const results = log.queryByType('coding');
    expect(results.length).toBe(2);
    expect(results.every((r) => r.taskType === 'coding')).toBe(true);
  });

  it('returns empty for non-existent type', () => {
    const dir = join(TEST_BASE, 'bytype-empty');
    const log = createExecutionLog(dir);

    log.append(makeRecord({ taskType: 'coding' }));
    expect(log.queryByType('nonexistent')).toEqual([]);
  });

  it('respects limit', () => {
    const dir = join(TEST_BASE, 'bytype-limit');
    const log = createExecutionLog(dir);

    for (let i = 0; i < 20; i++) {
      log.append(makeRecord({ taskType: 'coding' }));
    }

    const results = log.queryByType('coding', 5);
    expect(results.length).toBe(5);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// queryByTool
// ═══════════════════════════════════════════════════════════════════════════════

describe('createExecutionLog — queryByTool', () => {
  it('filters by tool name in step results', () => {
    const dir = join(TEST_BASE, 'bytool');
    const log = createExecutionLog(dir);

    log.append(makeRecord({
      stepResults: [makeStepOutcome({ tool: 'bash' })],
    }));
    log.append(makeRecord({
      stepResults: [makeStepOutcome({ tool: 'read' })],
    }));
    log.append(makeRecord({
      stepResults: [makeStepOutcome({ tool: 'bash' }), makeStepOutcome({ tool: 'write' })],
    }));

    const results = log.queryByTool('bash');
    expect(results.length).toBe(2);
  });

  it('returns empty for unused tool', () => {
    const dir = join(TEST_BASE, 'bytool-empty');
    const log = createExecutionLog(dir);

    log.append(makeRecord({ stepResults: [makeStepOutcome({ tool: 'bash' })] }));
    expect(log.queryByTool('grep')).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// getRecent
// ═══════════════════════════════════════════════════════════════════════════════

describe('createExecutionLog — getRecent', () => {
  it('returns most recent records', () => {
    const dir = join(TEST_BASE, 'recent');
    const log = createExecutionLog(dir);

    for (let i = 0; i < 15; i++) {
      log.append(makeRecord({ id: `r${i}` }));
    }

    const recent = log.getRecent(5);
    expect(recent.length).toBe(5);
    expect(recent[recent.length - 1]!.id).toBe('r14');
  });

  it('defaults to 10', () => {
    const dir = join(TEST_BASE, 'recent-default');
    const log = createExecutionLog(dir);

    for (let i = 0; i < 20; i++) {
      log.append(makeRecord({}));
    }

    const recent = log.getRecent();
    expect(recent.length).toBe(10);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// getToolReliability
// ═══════════════════════════════════════════════════════════════════════════════

describe('createExecutionLog — getToolReliability', () => {
  it('calculates reliability for a tool', () => {
    const dir = join(TEST_BASE, 'reliability');
    const log = createExecutionLog(dir);

    log.append(makeRecord({
      stepResults: [
        makeStepOutcome({ tool: 'bash', success: true }),
        makeStepOutcome({ tool: 'bash', success: true }),
        makeStepOutcome({ tool: 'bash', success: false, failureReason: 'timeout' }),
      ],
    }));

    const stats = log.getToolReliability('bash');
    expect(stats.toolName).toBe('bash');
    expect(stats.totalCalls).toBe(3);
    expect(stats.totalFailures).toBe(1);
    expect(stats.successRate).toBeCloseTo(2 / 3);
    expect(stats.commonFailureReasons).toContain('timeout');
  });

  it('returns 100% for unused tool', () => {
    const dir = join(TEST_BASE, 'reliability-empty');
    const log = createExecutionLog(dir);

    const stats = log.getToolReliability('nonexistent');
    expect(stats.successRate).toBe(1);
    expect(stats.totalCalls).toBe(0);
    expect(stats.totalFailures).toBe(0);
  });

  it('aggregates failure reasons', () => {
    const dir = join(TEST_BASE, 'reliability-reasons');
    const log = createExecutionLog(dir);

    log.append(makeRecord({
      stepResults: [
        makeStepOutcome({ tool: 'bash', success: false, failureReason: 'timeout' }),
        makeStepOutcome({ tool: 'bash', success: false, failureReason: 'timeout' }),
        makeStepOutcome({ tool: 'bash', success: false, failureReason: 'permission denied' }),
      ],
    }));

    const stats = log.getToolReliability('bash');
    // timeout should be first (more frequent)
    expect(stats.commonFailureReasons[0]).toBe('timeout');
    expect(stats.commonFailureReasons).toContain('permission denied');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// getTaskTypes
// ═══════════════════════════════════════════════════════════════════════════════

describe('createExecutionLog — getTaskTypes', () => {
  it('returns unique task types', () => {
    const dir = join(TEST_BASE, 'types');
    const log = createExecutionLog(dir);

    log.append(makeRecord({ taskType: 'coding' }));
    log.append(makeRecord({ taskType: 'file_operation' }));
    log.append(makeRecord({ taskType: 'coding' }));

    const types = log.getTaskTypes();
    expect(types.length).toBe(2);
    expect(types).toContain('coding');
    expect(types).toContain('file_operation');
  });

  it('returns empty for no records', () => {
    const dir = join(TEST_BASE, 'types-empty');
    const log = createExecutionLog(dir);
    expect(log.getTaskTypes()).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// compact
// ═══════════════════════════════════════════════════════════════════════════════

describe('createExecutionLog — compact', () => {
  it('removes old records', () => {
    const dir = join(TEST_BASE, 'compact');
    mkdirSync(dir, { recursive: true });

    // Create records with old timestamps
    const oldTimestamp = Date.now() - 31 * 24 * 60 * 60 * 1000; // 31 days ago
    const old = makeRecord({ id: 'old', timestamp: oldTimestamp });
    const recent = makeRecord({ id: 'recent', timestamp: Date.now() });

    writeFileSync(join(dir, 'log.jsonl'), [
      JSON.stringify(old),
      JSON.stringify(recent),
    ].join('\n') + '\n');

    const log = createExecutionLog(dir);
    // Old record should have been compacted on load
    expect(log.count()).toBe(1);
  });

  it('compact() returns removed count', () => {
    const dir = join(TEST_BASE, 'compact-manual');
    const log = createExecutionLog(dir);

    // All records are fresh — nothing to compact
    for (let i = 0; i < 5; i++) {
      log.append(makeRecord({}));
    }

    const removed = log.compact();
    expect(removed).toBe(0);
  });
});
