import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resetTracer, initTracer } from '../src/autonomous/debug.js';
import { CrystalStore } from '../src/autonomous/crystal-store.js';

// ═══════════════════════════════════════════════════════════════════════════════
// Crystal Store Tests
// ═══════════════════════════════════════════════════════════════════════════════

let tempDir: string;
let store: CrystalStore;

beforeEach(async () => {
  resetTracer();
  initTracer({ enabled: false });
  tempDir = await mkdtemp(join(tmpdir(), 'casterly-crystal-'));
  store = new CrystalStore({
    path: join(tempDir, 'crystals.yaml'),
    maxCrystals: 5,
    budgetTokens: 200,
    minConfidence: 0.3,
  });
  await store.load();
});

afterEach(async () => {
  resetTracer();
  await rm(tempDir, { recursive: true, force: true });
});

describe('CrystalStore — Lifecycle', () => {
  it('starts empty after load', () => {
    expect(store.count()).toBe(0);
    expect(store.isLoaded()).toBe(true);
  });

  it('persists crystals across save/load', async () => {
    store.crystallize({ content: 'Test fact' });
    await store.save();

    const store2 = new CrystalStore({ path: join(tempDir, 'crystals.yaml') });
    await store2.load();

    expect(store2.count()).toBe(1);
    const all = store2.getAll();
    expect(all[0]!.content).toBe('Test fact');
  });

  it('handles missing file gracefully', async () => {
    const store2 = new CrystalStore({ path: join(tempDir, 'nonexistent.yaml') });
    await store2.load();
    expect(store2.count()).toBe(0);
    expect(store2.isLoaded()).toBe(true);
  });
});

describe('CrystalStore — Crystallize', () => {
  it('creates a crystal with generated ID', () => {
    const result = store.crystallize({ content: 'Vitest uses vi.fn()' });
    expect(result.success).toBe(true);
    expect(result.crystalId).toMatch(/^crystal-/);
    expect(store.count()).toBe(1);
  });

  it('stores source entries and confidence', () => {
    store.crystallize({
      content: 'User prefers functional style',
      sourceEntries: ['mem-abc', 'mem-def'],
      confidence: 0.9,
    });

    const crystal = store.getAll()[0]!;
    expect(crystal.sourceEntries).toEqual(['mem-abc', 'mem-def']);
    expect(crystal.confidence).toBe(0.9);
  });

  it('defaults confidence to 0.8', () => {
    store.crystallize({ content: 'Default confidence' });
    expect(store.getAll()[0]!.confidence).toBe(0.8);
  });

  it('rejects when max crystals reached', () => {
    for (let i = 0; i < 5; i++) {
      store.crystallize({ content: `Crystal ${i}` });
    }
    const result = store.crystallize({ content: 'One too many' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Maximum crystal limit');
  });

  it('rejects when token budget exceeded', () => {
    // Each char ≈ 0.25 tokens, so 800 chars ≈ 200 tokens (the budget)
    store.crystallize({ content: 'A'.repeat(780) });
    const result = store.crystallize({ content: 'B'.repeat(100) });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Token budget exceeded');
  });

  it('rejects duplicate content', () => {
    store.crystallize({ content: 'Same knowledge' });
    const result = store.crystallize({ content: 'Same knowledge' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Duplicate crystal');
  });

  it('rejects duplicate content (case insensitive)', () => {
    store.crystallize({ content: 'SAME Knowledge' });
    const result = store.crystallize({ content: 'same knowledge' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Duplicate');
  });
});

describe('CrystalStore — Dissolve', () => {
  it('removes a crystal by ID', () => {
    const result = store.crystallize({ content: 'Temporary' });
    expect(store.count()).toBe(1);

    const dissolved = store.dissolve(result.crystalId!);
    expect(dissolved.success).toBe(true);
    expect(store.count()).toBe(0);
  });

  it('returns error for unknown ID', () => {
    const result = store.dissolve('crystal-nonexistent');
    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });
});

describe('CrystalStore — Confidence', () => {
  it('validate increases confidence', () => {
    const result = store.crystallize({ content: 'Validated', confidence: 0.5 });
    store.validate(result.crystalId!);
    expect(store.getById(result.crystalId!)!.confidence).toBeCloseTo(0.55, 2);
  });

  it('contradict decreases confidence', () => {
    const result = store.crystallize({ content: 'Contradicted', confidence: 0.8 });
    store.contradict(result.crystalId!);
    expect(store.getById(result.crystalId!)!.confidence).toBeCloseTo(0.65, 2);
  });

  it('validate caps at 1.0', () => {
    const result = store.crystallize({ content: 'Max confidence', confidence: 0.98 });
    store.validate(result.crystalId!);
    expect(store.getById(result.crystalId!)!.confidence).toBe(1.0);
  });

  it('contradict floors at 0', () => {
    const result = store.crystallize({ content: 'Min confidence', confidence: 0.1 });
    store.contradict(result.crystalId!);
    expect(store.getById(result.crystalId!)!.confidence).toBe(0);
  });
});

describe('CrystalStore — Pruning', () => {
  it('prunes crystals below min confidence', () => {
    store.crystallize({ content: 'Low confidence', confidence: 0.2 });
    store.crystallize({ content: 'High confidence', confidence: 0.9 });

    const pruned = store.pruneByConfidence();
    expect(pruned).toHaveLength(1);
    expect(store.count()).toBe(1);
    expect(store.getAll()[0]!.content).toBe('High confidence');
  });
});

describe('CrystalStore — Query', () => {
  it('getAll returns sorted by confidence descending', () => {
    store.crystallize({ content: 'Low', confidence: 0.4 });
    store.crystallize({ content: 'High', confidence: 0.9 });
    store.crystallize({ content: 'Mid', confidence: 0.6 });

    const all = store.getAll();
    expect(all[0]!.content).toBe('High');
    expect(all[1]!.content).toBe('Mid');
    expect(all[2]!.content).toBe('Low');
  });

  it('recordRecall increments recall count', () => {
    const result = store.crystallize({ content: 'Recalled' });
    store.recordRecall(result.crystalId!);
    store.recordRecall(result.crystalId!);

    expect(store.getById(result.crystalId!)!.recallCount).toBe(2);
  });

  it('buildPromptSection formats crystals for hot tier', () => {
    store.crystallize({ content: 'First crystal' });
    store.crystallize({ content: 'Second crystal' });

    const section = store.buildPromptSection();
    expect(section).toContain('## Crystals');
    expect(section).toContain('- First crystal');
    expect(section).toContain('- Second crystal');
  });

  it('buildPromptSection returns empty for no crystals', () => {
    expect(store.buildPromptSection()).toBe('');
  });
});
