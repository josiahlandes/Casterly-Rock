import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { ContextManager, createContextManager } from '../src/autonomous/context-manager.js';
import type { TierUsage, WarmEntry } from '../src/autonomous/context-manager.js';
import { ContextStore } from '../src/autonomous/context-store.js';
import type { MemoryEntry, RecallResult } from '../src/autonomous/context-store.js';
import { WorldModel } from '../src/autonomous/world-model.js';
import { GoalStack } from '../src/autonomous/goal-stack.js';
import { IssueLog } from '../src/autonomous/issue-log.js';
import { resetTracer, initTracer } from '../src/autonomous/debug.js';

// ─────────────────────────────────────────────────────────────────────────────
// Setup
// ─────────────────────────────────────────────────────────────────────────────

let tempDir: string;

beforeEach(async () => {
  resetTracer();
  initTracer({ enabled: false });
  tempDir = await mkdtemp(join(tmpdir(), 'casterly-context-'));
  await mkdir(join(tempDir, 'memory'), { recursive: true });
  await mkdir(join(tempDir, 'reflections'), { recursive: true });
});

afterEach(async () => {
  resetTracer();
  await rm(tempDir, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// ContextStore Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('ContextStore — Archive and Recall', () => {
  let store: ContextStore;

  beforeEach(() => {
    store = new ContextStore({
      basePath: join(tempDir, 'memory'),
      maxCoolEntries: 5,
      coolRetentionDays: 30,
      defaultSearchLimit: 10,
      reflectionsPath: join(tempDir, 'reflections'),
    });
  });

  it('archives an entry and recalls it by keyword', async () => {
    await store.archive({
      content: 'Fixed a flaky test in detector.ts by adjusting the regex anchoring.',
      title: 'Flaky detector test fix',
      tags: ['fix', 'test', 'detector'],
    });

    const results = await store.recall({ query: 'detector test regex' });

    expect(results.length).toBe(1);
    expect(results[0]!.entry.title).toBe('Flaky detector test fix');
    expect(results[0]!.score).toBeGreaterThan(0);
    expect(results[0]!.matchedKeywords.length).toBeGreaterThan(0);
  });

  it('returns empty results for unmatched query', async () => {
    await store.archive({
      content: 'Added a new login endpoint.',
      title: 'Login endpoint',
      tags: ['feature', 'auth'],
    });

    const results = await store.recall({ query: 'quantum entanglement' });

    expect(results.length).toBe(0);
  });

  it('archives to cool tier by default', async () => {
    const id = await store.archive({
      content: 'Test content.',
      title: 'Test entry',
      tags: ['test'],
    });

    expect(id).toMatch(/^mem-/);

    const stats = await store.getStats();
    expect(stats.cool).toBe(1);
    expect(stats.cold).toBe(0);
  });

  it('archives to cold tier when specified', async () => {
    await store.archive({
      content: 'Historical data.',
      title: 'Old entry',
      tags: ['history'],
      tier: 'cold',
    });

    const stats = await store.getStats();
    expect(stats.cool).toBe(0);
    expect(stats.cold).toBe(1);
  });

  it('filters recall by tags', async () => {
    await store.archive({
      content: 'TypeScript fix.',
      title: 'TS fix',
      tags: ['typescript', 'fix'],
    });
    await store.archive({
      content: 'Python fix.',
      title: 'Python fix',
      tags: ['python', 'fix'],
    });

    const results = await store.recall({
      query: 'fix',
      tags: ['typescript'],
    });

    expect(results.length).toBe(1);
    expect(results[0]!.entry.tags).toContain('typescript');
  });

  it('filters recall by source', async () => {
    await store.archive({
      content: 'Agent observation.',
      title: 'Observation',
      tags: ['agent'],
      source: 'agent',
    });
    await store.archive({
      content: 'Archived note.',
      title: 'Note',
      tags: ['note'],
      source: 'archive',
    });

    const results = await store.recall({
      query: 'observation note',
      source: 'agent',
    });

    expect(results.length).toBe(1);
    expect(results[0]!.entry.source).toBe('agent');
  });

  it('respects search limit', async () => {
    for (let i = 0; i < 10; i++) {
      await store.archive({
        content: `Entry about testing number ${i}.`,
        title: `Test entry ${i}`,
        tags: ['test'],
      });
    }

    const results = await store.recall({
      query: 'testing',
      limit: 3,
    });

    expect(results.length).toBe(3);
  });

  it('trims cool tier when exceeding max entries', async () => {
    // maxCoolEntries is 5
    for (let i = 0; i < 8; i++) {
      await store.archive({
        content: `Content ${i}`,
        title: `Entry ${i}`,
        tags: ['test'],
      });
    }

    const stats = await store.getStats();
    expect(stats.cool).toBeLessThanOrEqual(5);
    // Excess should be promoted to cold
    expect(stats.cold).toBeGreaterThanOrEqual(3);
  });

  it('searches both tiers when tier is "both"', async () => {
    await store.archive({
      content: 'Cool tier debugging.',
      title: 'Debug cool',
      tags: ['debug'],
      tier: 'cool',
    });
    await store.archive({
      content: 'Cold tier debugging.',
      title: 'Debug cold',
      tags: ['debug'],
      tier: 'cold',
    });

    const results = await store.recall({
      query: 'debugging',
      tier: 'both',
    });

    expect(results.length).toBe(2);
  });

  it('loads reflections as cold tier entries', async () => {
    // Write a fake reflection file
    await writeFile(
      join(tempDir, 'reflections', '2026-02-17-cycle-001.json'),
      JSON.stringify({
        cycleId: 'cycle-001',
        timestamp: '2026-02-17T03:00:00Z',
        observation: { description: 'Regex anchoring issue in detector' },
        reasoning: 'The regex was not anchored to the start of the line.',
        outcome: 'success',
      }),
      'utf8',
    );

    const results = await store.recall({
      query: 'regex anchoring detector',
      tier: 'cold',
    });

    expect(results.length).toBe(1);
    expect(results[0]!.entry.source).toBe('reflection');
  });

  it('promotes stale entries from cool to cold', async () => {
    // Archive an entry with a very old timestamp
    // We need to manipulate the file directly for this
    const oldEntry: MemoryEntry = {
      id: 'mem-old',
      timestamp: '2025-01-01T00:00:00Z', // Very old
      tier: 'cool',
      tags: ['old'],
      source: 'archive',
      content: 'Old content.',
      title: 'Old entry',
    };

    await mkdir(join(tempDir, 'memory', 'cool'), { recursive: true });
    await writeFile(
      join(tempDir, 'memory', 'cool', 'entries.jsonl'),
      JSON.stringify(oldEntry) + '\n',
      'utf8',
    );

    const promoted = await store.promoteStaleEntries();
    expect(promoted).toBe(1);

    const stats = await store.getStats();
    expect(stats.cool).toBe(0);
    expect(stats.cold).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ContextManager Tests — Hot Tier
// ─────────────────────────────────────────────────────────────────────────────

describe('ContextManager — Hot Tier', () => {
  let cm: ContextManager;

  beforeEach(() => {
    cm = createContextManager({
      hotTierMaxTokens: 2000,
      warmTierMaxTokens: 5000,
      contextWindowTokens: 32768,
      storeConfig: {
        basePath: join(tempDir, 'memory'),
        reflectionsPath: join(tempDir, 'reflections'),
      },
    });
  });

  it('builds hot tier from null state (minimal prompt)', () => {
    const prompt = cm.buildHotTier(null, null, null);

    expect(prompt).toContain('Tyrion');
    expect(prompt).toContain('steward');
    expect(cm.getHotTierTokens()).toBeGreaterThan(0);
  });

  it('builds hot tier from live state', async () => {
    const wm = new WorldModel({
      path: join(tempDir, 'wm.yaml'),
      projectRoot: tempDir,
    });
    const gs = new GoalStack({ path: join(tempDir, 'goals.yaml') });
    const il = new IssueLog({ path: join(tempDir, 'issues.yaml') });

    gs.addGoal({ source: 'user', description: 'Fix the detector' });
    il.fileIssue({
      title: 'Flaky regex',
      description: 'Regex test fails intermittently',
      priority: 'high',
      relatedFiles: ['src/detector.ts'],
      discoveredBy: 'autonomous',
    });

    const prompt = cm.buildHotTier(wm, gs, il);

    expect(prompt).toContain('Tyrion');
    // Should include goal and issue sections
    expect(prompt).toContain('Fix the detector');
    expect(prompt).toContain('Flaky regex');
  });

  it('getHotTier returns minimal prompt when not built', () => {
    const prompt = cm.getHotTier();
    expect(prompt).toContain('Tyrion');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ContextManager Tests — Warm Tier
// ─────────────────────────────────────────────────────────────────────────────

describe('ContextManager — Warm Tier', () => {
  let cm: ContextManager;

  beforeEach(() => {
    cm = createContextManager({
      hotTierMaxTokens: 500,
      warmTierMaxTokens: 100, // Very small for testing eviction
      contextWindowTokens: 32768,
      storeConfig: {
        basePath: join(tempDir, 'memory'),
        reflectionsPath: join(tempDir, 'reflections'),
      },
    });
  });

  it('adds and retrieves from warm tier', () => {
    const result = cm.addToWarmTier({
      key: 'file:src/test.ts',
      kind: 'file',
      content: 'const x = 1;',
    });

    expect(result.added).toBe(true);
    expect(result.evicted).toHaveLength(0);

    const retrieved = cm.getFromWarmTier('file:src/test.ts');
    expect(retrieved).toBe('const x = 1;');
  });

  it('replaces existing warm tier entry with same key', () => {
    cm.addToWarmTier({
      key: 'note:plan',
      kind: 'working_note',
      content: 'First plan.',
    });
    cm.addToWarmTier({
      key: 'note:plan',
      kind: 'working_note',
      content: 'Updated plan.',
    });

    const retrieved = cm.getFromWarmTier('note:plan');
    expect(retrieved).toBe('Updated plan.');

    const contents = cm.getWarmTierContents();
    expect(contents.length).toBe(1);
  });

  it('evicts least-used entries when warm tier is full', () => {
    // Budget is 100 tokens. estimateTokens = ceil(length / 3.5)
    // Fill with two medium entries that together consume most of the budget.
    cm.addToWarmTier({
      key: 'entry-a',
      kind: 'snippet',
      content: 'a'.repeat(140), // 40 tokens
    });

    // Access entry-a to increase its count (LRU protection)
    cm.getFromWarmTier('entry-a');
    cm.getFromWarmTier('entry-a');

    // Add another medium entry (not accessed — LRU candidate)
    cm.addToWarmTier({
      key: 'entry-b',
      kind: 'snippet',
      content: 'b'.repeat(140), // 40 tokens. Total = 80 tokens.
    });

    // Add a larger entry that forces eviction (60 tokens, total would be 140 > 100)
    const result = cm.addToWarmTier({
      key: 'entry-c',
      kind: 'file',
      content: 'c'.repeat(210), // 60 tokens
    });

    expect(result.added).toBe(true);
    // entry-b should be evicted first (fewer accesses than entry-a)
    expect(result.evicted).toContain('entry-b');
  });

  it('rejects entries too large for the warm tier', () => {
    const result = cm.addToWarmTier({
      key: 'huge',
      kind: 'file',
      content: 'x'.repeat(1000), // Way over 100 tokens budget
    });

    expect(result.added).toBe(false);
    expect(cm.getFromWarmTier('huge')).toBeNull();
  });

  it('removes entries from warm tier', () => {
    cm.addToWarmTier({
      key: 'temp',
      kind: 'tool_result',
      content: 'result data',
    });

    expect(cm.removeFromWarmTier('temp')).toBe(true);
    expect(cm.getFromWarmTier('temp')).toBeNull();
    expect(cm.removeFromWarmTier('temp')).toBe(false);
  });

  it('clears warm tier', () => {
    cm.addToWarmTier({ key: 'a', kind: 'snippet', content: 'a' });
    cm.addToWarmTier({ key: 'b', kind: 'snippet', content: 'b' });

    cm.clearWarmTier();

    expect(cm.getWarmTierContents()).toHaveLength(0);
    expect(cm.getWarmTierTokens()).toBe(0);
  });

  it('builds warm tier prompt', () => {
    cm.addToWarmTier({
      key: 'file:src/index.ts',
      kind: 'file',
      content: 'export const main = () => {};',
    });
    cm.addToWarmTier({
      key: 'note:approach',
      kind: 'working_note',
      content: 'Try refactoring the router first.',
    });

    const prompt = cm.buildWarmTierPrompt();

    expect(prompt).toContain('## Working Memory');
    expect(prompt).toContain('file: file:src/index.ts');
    expect(prompt).toContain('working_note: note:approach');
    expect(prompt).toContain('export const main');
    expect(prompt).toContain('refactoring the router');
  });

  it('returns empty string for empty warm tier prompt', () => {
    expect(cm.buildWarmTierPrompt()).toBe('');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ContextManager Tests — Cool/Cold Tiers (via store)
// ─────────────────────────────────────────────────────────────────────────────

describe('ContextManager — Archive and Recall', () => {
  let cm: ContextManager;

  beforeEach(() => {
    cm = createContextManager({
      storeConfig: {
        basePath: join(tempDir, 'memory'),
        reflectionsPath: join(tempDir, 'reflections'),
      },
    });
  });

  it('archives and recalls through the context manager', async () => {
    await cm.archive({
      content: 'The tool orchestrator uses a chain-of-responsibility pattern.',
      title: 'Orchestrator architecture note',
      tags: ['architecture', 'orchestrator'],
    });

    const results = await cm.recall({ query: 'orchestrator chain pattern' });

    expect(results.length).toBe(1);
    expect(results[0]!.entry.title).toContain('Orchestrator');
  });

  it('promotes stale entries via context manager', async () => {
    // Set up an old cool entry
    const memDir = join(tempDir, 'memory', 'cool');
    await mkdir(memDir, { recursive: true });
    await writeFile(
      join(memDir, 'entries.jsonl'),
      JSON.stringify({
        id: 'mem-stale',
        timestamp: '2024-01-01T00:00:00Z',
        tier: 'cool',
        tags: ['old'],
        source: 'archive',
        content: 'Stale.',
        title: 'Stale entry',
      }) + '\n',
      'utf8',
    );

    const promoted = await cm.promoteStaleEntries();
    expect(promoted).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ContextManager Tests — Token Budget
// ─────────────────────────────────────────────────────────────────────────────

describe('ContextManager — Token Budget', () => {
  let cm: ContextManager;

  beforeEach(() => {
    cm = createContextManager({
      hotTierMaxTokens: 2000,
      warmTierMaxTokens: 5000,
      contextWindowTokens: 32768,
      storeConfig: {
        basePath: join(tempDir, 'memory'),
        reflectionsPath: join(tempDir, 'reflections'),
      },
    });
  });

  it('tracks total context tokens', () => {
    cm.buildHotTier(null, null, null);

    cm.addToWarmTier({
      key: 'file:test.ts',
      kind: 'file',
      content: 'const x = 42;\n'.repeat(10),
    });

    const total = cm.getTotalContextTokens();
    expect(total).toBe(cm.getHotTierTokens() + cm.getWarmTierTokens());
    expect(total).toBeGreaterThan(0);
  });

  it('calculates remaining warm budget', () => {
    const full = cm.getRemainingWarmBudget();
    expect(full).toBe(5000);

    cm.addToWarmTier({
      key: 'data',
      kind: 'snippet',
      content: 'x'.repeat(350), // ~100 tokens
    });

    const remaining = cm.getRemainingWarmBudget();
    expect(remaining).toBeLessThan(5000);
    expect(remaining).toBeGreaterThan(0);
  });

  it('getUsage returns complete tier summary', async () => {
    cm.buildHotTier(null, null, null);
    cm.addToWarmTier({ key: 'a', kind: 'snippet', content: 'data' });

    await cm.archive({
      content: 'Cool entry.',
      title: 'Cool',
      tags: ['test'],
      tier: 'cool',
    });

    const usage = await cm.getUsage();

    expect(usage.hot.tokens).toBeGreaterThan(0);
    expect(usage.warm.entries).toBe(1);
    expect(usage.warm.keys).toContain('a');
    expect(usage.cool.entries).toBe(1);
    expect(usage.totalTokensInContext).toBeGreaterThan(0);
    expect(usage.remainingTokens).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ContextManager Tests — Factory
// ─────────────────────────────────────────────────────────────────────────────

describe('ContextManager — Factory', () => {
  it('createContextManager creates a working instance', () => {
    const cm = createContextManager({
      storeConfig: {
        basePath: join(tempDir, 'memory'),
        reflectionsPath: join(tempDir, 'reflections'),
      },
    });

    expect(cm).toBeInstanceOf(ContextManager);
    expect(cm.getHotTierTokens()).toBe(0);
    expect(cm.getWarmTierTokens()).toBe(0);
  });
});
