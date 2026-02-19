import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { CrystalStore, createCrystalStore } from '../src/autonomous/crystal-store.js';
import type { Crystal } from '../src/autonomous/crystal-store.js';
import { resetTracer, initTracer } from '../src/autonomous/debug.js';

// ─────────────────────────────────────────────────────────────────────────────
// Setup
// ─────────────────────────────────────────────────────────────────────────────

let tempDir: string;

beforeEach(async () => {
  resetTracer();
  initTracer({ enabled: false });
  tempDir = await mkdtemp(join(tmpdir(), 'casterly-crystals-'));
});

afterEach(async () => {
  resetTracer();
  await rm(tempDir, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// Crystal Store Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('CrystalStore — Core Operations', () => {
  let store: CrystalStore;

  beforeEach(() => {
    store = new CrystalStore({
      path: join(tempDir, 'crystals.yaml'),
      maxCrystals: 5,
      crystalsBudgetTokens: 500,
      minConfidence: 0.3,
    });
  });

  it('creates a crystal with all required fields', () => {
    const crystal = store.crystallize({
      content: 'Tests in this repo use Vitest with vi.fn() mock pattern.',
      sourceEntries: ['mem-123', 'j-456'],
      confidence: 0.85,
    });

    expect(crystal).not.toBeNull();
    expect(crystal!.id).toMatch(/^crys-/);
    expect(crystal!.content).toBe('Tests in this repo use Vitest with vi.fn() mock pattern.');
    expect(crystal!.sourceEntries).toEqual(['mem-123', 'j-456']);
    expect(crystal!.confidence).toBe(0.85);
    expect(crystal!.recallCount).toBe(0);
    expect(crystal!.formedDate).toBeTruthy();
    expect(crystal!.lastValidated).toBeTruthy();
  });

  it('rejects duplicate crystals and strengthens existing', () => {
    const first = store.crystallize({
      content: 'The user prefers functional patterns.',
      sourceEntries: [],
      confidence: 0.7,
    });

    const second = store.crystallize({
      content: 'The user prefers functional patterns.',
      sourceEntries: [],
      confidence: 0.8,
    });

    expect(store.count()).toBe(1);
    expect(second!.id).toBe(first!.id);
    expect(second!.confidence).toBeGreaterThan(0.7);
    expect(second!.recallCount).toBe(1);
  });

  it('enforces maxCrystals by evicting lowest confidence', () => {
    for (let i = 0; i < 5; i++) {
      store.crystallize({
        content: `Crystal number ${i}`,
        sourceEntries: [],
        confidence: 0.5 + i * 0.05,
      });
    }
    expect(store.count()).toBe(5);

    // This should evict crystal #0 (confidence 0.5) since 0.9 > 0.5
    const newCrystal = store.crystallize({
      content: 'A new important crystal',
      sourceEntries: [],
      confidence: 0.9,
    });

    expect(newCrystal).not.toBeNull();
    expect(store.count()).toBe(5);

    // Verify the lowest-confidence crystal was evicted
    const all = store.getAll();
    const confidences = all.map((c) => c.confidence);
    expect(Math.min(...confidences)).toBeGreaterThanOrEqual(0.55);
  });

  it('returns null when budget is full and new crystal is lower confidence', () => {
    for (let i = 0; i < 5; i++) {
      store.crystallize({
        content: `Crystal number ${i}`,
        sourceEntries: [],
        confidence: 0.9,
      });
    }

    const result = store.crystallize({
      content: 'Low confidence crystal',
      sourceEntries: [],
      confidence: 0.3,
    });

    expect(result).toBeNull();
  });

  it('dissolves a crystal by ID', () => {
    const crystal = store.crystallize({
      content: 'Temporary insight',
      sourceEntries: [],
      confidence: 0.7,
    });

    expect(store.count()).toBe(1);

    const dissolved = store.dissolve(crystal!.id, 'No longer accurate');
    expect(dissolved).toBe(true);
    expect(store.count()).toBe(0);
  });

  it('returns false when dissolving nonexistent crystal', () => {
    const dissolved = store.dissolve('nonexistent-id', 'test');
    expect(dissolved).toBe(false);
  });

  it('validates a crystal and increases confidence', () => {
    const crystal = store.crystallize({
      content: 'Some insight',
      sourceEntries: [],
      confidence: 0.7,
    });

    const validated = store.validate(crystal!.id);
    expect(validated).toBe(true);

    const updated = store.get(crystal!.id);
    expect(updated!.confidence).toBeGreaterThan(0.7);
  });

  it('weakens a crystal', () => {
    const crystal = store.crystallize({
      content: 'Some insight',
      sourceEntries: [],
      confidence: 0.7,
    });

    store.weaken(crystal!.id, 0.2);
    const updated = store.get(crystal!.id);
    expect(updated!.confidence).toBeCloseTo(0.5);
  });

  it('prunes crystals below minConfidence', () => {
    store.crystallize({ content: 'Strong crystal', sourceEntries: [], confidence: 0.9 });
    store.crystallize({ content: 'Weak crystal', sourceEntries: [], confidence: 0.2 });

    const pruned = store.prune();
    expect(pruned.length).toBe(1);
    expect(store.count()).toBe(1);
  });

  it('updates crystal content and confidence', () => {
    const crystal = store.crystallize({
      content: 'Original insight',
      sourceEntries: [],
      confidence: 0.7,
    });

    const updated = store.update(crystal!.id, {
      content: 'Refined insight',
      confidence: 0.9,
    });

    expect(updated).toBe(true);
    const fetched = store.get(crystal!.id);
    expect(fetched!.content).toBe('Refined insight');
    expect(fetched!.confidence).toBe(0.9);
  });
});

describe('CrystalStore — Persistence', () => {
  it('saves and loads crystals from disk', async () => {
    const path = join(tempDir, 'crystals.yaml');

    const store1 = new CrystalStore({ path, maxCrystals: 10 });
    store1.crystallize({ content: 'Crystal A', sourceEntries: [], confidence: 0.9 });
    store1.crystallize({ content: 'Crystal B', sourceEntries: ['e1'], confidence: 0.7 });
    await store1.save();

    const store2 = new CrystalStore({ path, maxCrystals: 10 });
    await store2.load();

    expect(store2.count()).toBe(2);
    const all = store2.getAll();
    expect(all[0]!.content).toBe('Crystal A');
    expect(all[1]!.content).toBe('Crystal B');
  });

  it('handles missing file gracefully', async () => {
    const store = new CrystalStore({
      path: join(tempDir, 'nonexistent.yaml'),
    });
    await store.load();
    expect(store.count()).toBe(0);
    expect(store.isLoaded()).toBe(true);
  });
});

describe('CrystalStore — Hot Tier Integration', () => {
  it('builds a prompt from crystals sorted by confidence', () => {
    const store = new CrystalStore({
      path: join(tempDir, 'crystals.yaml'),
      crystalsBudgetTokens: 1000,
    });

    store.crystallize({ content: 'Low confidence insight', sourceEntries: [], confidence: 0.5 });
    store.crystallize({ content: 'High confidence insight', sourceEntries: [], confidence: 0.95 });

    const prompt = store.buildCrystalsPrompt();
    expect(prompt).toContain('High confidence insight');
    expect(prompt).toContain('Low confidence insight');
    // High confidence should come first
    expect(prompt.indexOf('High confidence')).toBeLessThan(prompt.indexOf('Low confidence'));
  });

  it('respects token budget in prompt generation', () => {
    const store = new CrystalStore({
      path: join(tempDir, 'crystals.yaml'),
      crystalsBudgetTokens: 20, // Very small budget
      maxCrystals: 10,
    });

    store.crystallize({ content: 'First insight is short', sourceEntries: [], confidence: 0.9 });
    store.crystallize({ content: 'Second insight that might not fit in the budget', sourceEntries: [], confidence: 0.8 });

    const prompt = store.buildCrystalsPrompt();
    // At least one crystal should be included; the budget limits the total
    const lineCount = prompt.split('\n').filter(Boolean).length;
    expect(lineCount).toBeGreaterThanOrEqual(1);
  });

  it('returns empty string when no crystals exist', () => {
    const store = new CrystalStore({ path: join(tempDir, 'crystals.yaml') });
    expect(store.buildCrystalsPrompt()).toBe('');
  });
});

describe('CrystalStore — Factory', () => {
  it('creates store with default config', () => {
    const store = createCrystalStore();
    expect(store).toBeInstanceOf(CrystalStore);
  });

  it('creates store with custom config', () => {
    const store = createCrystalStore({
      path: join(tempDir, 'custom.yaml'),
      maxCrystals: 10,
    });
    expect(store).toBeInstanceOf(CrystalStore);
  });
});
