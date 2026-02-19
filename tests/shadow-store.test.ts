import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { ShadowStore, createShadowStore } from '../src/autonomous/shadow-store.js';
import { resetTracer, initTracer } from '../src/autonomous/debug.js';

// ─────────────────────────────────────────────────────────────────────────────
// Setup
// ─────────────────────────────────────────────────────────────────────────────

let tempDir: string;

beforeEach(async () => {
  resetTracer();
  initTracer({ enabled: false });
  tempDir = await mkdtemp(join(tmpdir(), 'casterly-shadows-'));
});

afterEach(async () => {
  resetTracer();
  await rm(tempDir, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// Shadow Store Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('ShadowStore — Core Operations', () => {
  let store: ShadowStore;

  beforeEach(() => {
    store = new ShadowStore({
      analysisPath: join(tempDir, 'shadow-analysis.json'),
      maxShadows: 10,
      minScenariosForPattern: 3,
      retentionDays: 30,
    });
  });

  it('starts empty after load with no existing file', async () => {
    await store.load();
    expect(store.isLoaded()).toBe(true);
    expect(store.count()).toBe(0);
    expect(store.patternCount()).toBe(0);
  });

  it('records a shadow with all fields', async () => {
    await store.load();

    const shadow = store.recordShadow({
      cycleId: 'cycle-001',
      strategy: 'Use multi-file approach instead of single-file edit.',
      expectedSteps: ['Read all files', 'Plan changes', 'Apply changes', 'Test'],
      rationale: 'Single-file seems simpler for this case.',
      tags: ['refactoring', 'multi-file'],
    });

    expect(shadow.id).toMatch(/^shadow-/);
    expect(shadow.cycleId).toBe('cycle-001');
    expect(shadow.strategy).toContain('multi-file');
    expect(shadow.expectedSteps).toHaveLength(4);
    expect(shadow.tags).toContain('refactoring');
    expect(store.count()).toBe(1);
  });

  it('records primary outcome for a cycle', async () => {
    await store.load();

    store.recordShadow({
      cycleId: 'cycle-001',
      strategy: 'Alt approach.',
      expectedSteps: ['step1'],
      rationale: 'Testing.',
    });

    const result = store.recordPrimaryOutcome('cycle-001', 'failure');
    expect(result).toBe(true);

    const shadows = store.getShadowsForCycle('cycle-001');
    expect(shadows[0]!.primaryOutcome).toBe('failure');
  });

  it('returns false for recording outcome on unknown cycle', async () => {
    await store.load();
    expect(store.recordPrimaryOutcome('unknown', 'success')).toBe(false);
  });

  it('assesses a shadow', async () => {
    await store.load();

    const shadow = store.recordShadow({
      cycleId: 'cycle-001',
      strategy: 'Alt approach.',
      expectedSteps: ['step1'],
      rationale: 'Testing.',
    });

    store.recordPrimaryOutcome('cycle-001', 'failure');
    const result = store.assessShadow(shadow.id, 'likely_better');
    expect(result).toBe(true);

    const missed = store.getMissedOpportunities();
    expect(missed).toHaveLength(1);
    expect(missed[0]!.id).toBe(shadow.id);
  });

  it('tracks unassessed shadows', async () => {
    await store.load();

    store.recordShadow({
      cycleId: 'cycle-001',
      strategy: 'Approach A.',
      expectedSteps: ['step1'],
      rationale: 'Reason.',
    });
    store.recordPrimaryOutcome('cycle-001', 'success');

    store.recordShadow({
      cycleId: 'cycle-002',
      strategy: 'Approach B.',
      expectedSteps: ['step1'],
      rationale: 'Reason.',
    });
    // cycle-002 has no outcome yet

    const unassessed = store.getUnassessedShadows();
    expect(unassessed).toHaveLength(1);
    expect(unassessed[0]!.cycleId).toBe('cycle-001');
  });

  it('enforces max shadows capacity', async () => {
    const smallStore = new ShadowStore({
      analysisPath: join(tempDir, 'shadow-analysis.json'),
      maxShadows: 3,
    });
    await smallStore.load();

    for (let i = 0; i < 5; i++) {
      smallStore.recordShadow({
        cycleId: `cycle-${i}`,
        strategy: `Approach ${i}.`,
        expectedSteps: ['step'],
        rationale: 'Reason.',
      });
    }

    expect(smallStore.count()).toBe(3);
  });

  it('persists and reloads data', async () => {
    await store.load();

    store.recordShadow({
      cycleId: 'cycle-001',
      strategy: 'Persistent shadow.',
      expectedSteps: ['step1'],
      rationale: 'Testing persistence.',
    });
    await store.save();

    const store2 = new ShadowStore({
      analysisPath: join(tempDir, 'shadow-analysis.json'),
    });
    await store2.load();

    expect(store2.count()).toBe(1);
    expect(store2.getAllShadows()[0]!.strategy).toContain('Persistent');
  });
});

describe('ShadowStore — Judgment Patterns', () => {
  let store: ShadowStore;

  beforeEach(async () => {
    store = new ShadowStore({
      analysisPath: join(tempDir, 'shadow-analysis.json'),
      minScenariosForPattern: 3,
    });
    await store.load();
  });

  it('adds a new judgment pattern', () => {
    const pattern = store.addPattern({
      pattern: 'Multi-file refactoring works better with planning.',
      exampleCycleId: 'cycle-001',
    });

    expect(pattern.id).toMatch(/^pattern-/);
    expect(pattern.supportCount).toBe(1);
    expect(pattern.confidence).toBe(1.0);
    expect(store.patternCount()).toBe(1);
  });

  it('strengthens existing patterns on duplicate add', () => {
    store.addPattern({
      pattern: 'Planning first helps.',
      exampleCycleId: 'cycle-001',
    });

    const strengthened = store.addPattern({
      pattern: 'Planning first helps.',
      exampleCycleId: 'cycle-002',
    });

    expect(strengthened.supportCount).toBe(2);
    expect(store.patternCount()).toBe(1);
  });

  it('records contradictions', () => {
    const pattern = store.addPattern({
      pattern: 'Always plan.',
      exampleCycleId: 'cycle-001',
    });

    store.contradictPattern(pattern.id);
    const patterns = store.getAllPatterns();

    expect(patterns[0]!.contradictCount).toBe(1);
    expect(patterns[0]!.confidence).toBe(0.5); // 1/(1+1)
  });

  it('filters established patterns by min scenarios', () => {
    const pattern = store.addPattern({
      pattern: 'Test pattern.',
      exampleCycleId: 'cycle-001',
    });

    // Only 1 observation, threshold is 3
    expect(store.getEstablishedPatterns()).toHaveLength(0);

    // Add more observations
    store.addPattern({ pattern: 'Test pattern.', exampleCycleId: 'cycle-002' });
    store.addPattern({ pattern: 'Test pattern.', exampleCycleId: 'cycle-003' });

    expect(store.getEstablishedPatterns()).toHaveLength(1);
  });

  it('prunes weak patterns', () => {
    const pattern = store.addPattern({
      pattern: 'Weak pattern.',
      exampleCycleId: 'cycle-001',
    });

    // Add enough data to meet threshold
    store.addPattern({ pattern: 'Weak pattern.', exampleCycleId: 'cycle-002' });
    store.addPattern({ pattern: 'Weak pattern.', exampleCycleId: 'cycle-003' });

    // Contradict heavily to push confidence below threshold
    store.contradictPattern(pattern.id);
    store.contradictPattern(pattern.id);
    store.contradictPattern(pattern.id);
    store.contradictPattern(pattern.id);

    // confidence = 3/(3+4) ≈ 0.43, which is below 0.5
    const pruned = store.pruneWeakPatterns(0.5);
    expect(pruned).toHaveLength(1);
    expect(store.patternCount()).toBe(0);
  });

  it('builds an analysis summary', () => {
    store.recordShadow({
      cycleId: 'cycle-001',
      strategy: 'Alt approach.',
      expectedSteps: ['step1'],
      rationale: 'Reason.',
    });
    store.recordPrimaryOutcome('cycle-001', 'failure');
    store.assessShadow(store.getAllShadows()[0]!.id, 'likely_better');

    store.addPattern({
      pattern: 'Planning helps.',
      exampleCycleId: 'cycle-001',
    });

    const summary = store.buildAnalysisSummary();
    expect(summary).toContain('missed opportunit');
    expect(summary).not.toBe('No shadow data yet.');
  });
});

describe('ShadowStore — Factory', () => {
  it('createShadowStore returns a ShadowStore', () => {
    const store = createShadowStore({
      analysisPath: join(tempDir, 'test.json'),
    });
    expect(store).toBeInstanceOf(ShadowStore);
  });
});
