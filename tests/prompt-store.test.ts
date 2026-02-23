import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { PromptStore, createPromptStore } from '../src/autonomous/prompt-store.js';
import { resetTracer, initTracer } from '../src/autonomous/debug.js';

// ─────────────────────────────────────────────────────────────────────────────
// Setup
// ─────────────────────────────────────────────────────────────────────────────

let tempDir: string;

beforeEach(async () => {
  resetTracer();
  initTracer({ enabled: false });
  tempDir = await mkdtemp(join(tmpdir(), 'casterly-prompts-'));
});

afterEach(async () => {
  resetTracer();
  await rm(tempDir, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// Prompt Store Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('PromptStore — Core Operations', () => {
  let store: PromptStore;

  beforeEach(() => {
    store = new PromptStore({
      promptPath: join(tempDir, 'system-prompt.md'),
      versionsPath: join(tempDir, 'prompt-versions.json'),
      maxVersions: 10,
      protectedPatterns: ['Safety Boundary', 'NEVER'],
    });
  });

  it('initializes with default content on first load', async () => {
    await store.load();

    expect(store.isLoaded()).toBe(true);
    expect(store.getVersion()).toBe(0);
    expect(store.getContent()).toContain('Workflow Guidance');
    expect(store.getVersions().length).toBe(1);
  });

  it('persists and reloads content', async () => {
    await store.load();

    const store2 = new PromptStore({
      promptPath: join(tempDir, 'system-prompt.md'),
      versionsPath: join(tempDir, 'prompt-versions.json'),
    });
    await store2.load();

    expect(store2.getContent()).toBe(store.getContent());
    expect(store2.getVersion()).toBe(0);
  });

  it('edits the prompt with search-and-replace', async () => {
    await store.load();

    const result = store.editPrompt({
      oldText: 'Skip planning for simple single-file edits.',
      newText: 'Always plan for all edits, regardless of size.',
      rationale: 'Planning helps avoid mistakes.',
    });

    expect(result.success).toBe(true);
    expect(result.version).toBe(1);
    expect(store.getContent()).toContain('Always plan for all edits');
    expect(store.getContent()).not.toContain('Skip planning for simple');
  });

  it('rejects edits when old text is not found', async () => {
    await store.load();

    const result = store.editPrompt({
      oldText: 'This text does not exist in the prompt.',
      newText: 'Replacement.',
      rationale: 'Testing.',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });

  it('rejects edits that remove protected patterns', async () => {
    await store.load();

    // First, add protected content
    const content = store.getContent();
    store.editPrompt({
      oldText: '## Workflow Guidance',
      newText: '## Workflow Guidance\n\nSafety Boundary: respect always.',
      rationale: 'Adding safety note.',
    });

    // Now try to remove it
    const result = store.editPrompt({
      oldText: 'Safety Boundary: respect always.',
      newText: '',
      rationale: 'Trying to remove safety.',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Protected pattern');
  });

  it('versions each edit correctly', async () => {
    await store.load();

    store.editPrompt({
      oldText: '## Workflow Guidance',
      newText: '## Workflow Guidance (v1)',
      rationale: 'First edit.',
    });

    store.editPrompt({
      oldText: '## Workflow Guidance (v1)',
      newText: '## Workflow Guidance (v2)',
      rationale: 'Second edit.',
    });

    expect(store.getVersion()).toBe(2);
    expect(store.getVersions().length).toBe(3); // v0, v1, v2
  });

  it('reverts to a previous version', async () => {
    await store.load();
    const originalContent = store.getContent();

    store.editPrompt({
      oldText: '## Workflow Guidance',
      newText: '## CHANGED Guidance',
      rationale: 'Testing revert.',
    });

    expect(store.getContent()).toContain('CHANGED');

    const result = store.revertPrompt(0, 'Reverting to original.');

    expect(result.success).toBe(true);
    expect(store.getContent()).toBe(originalContent);
    expect(store.getVersion()).toBe(2); // v0, v1, v2 (revert)
  });

  it('rejects revert to nonexistent version', async () => {
    await store.load();

    const result = store.revertPrompt(999, 'Testing.');

    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });

  it('prunes versions when over the max', async () => {
    const smallStore = new PromptStore({
      promptPath: join(tempDir, 'system-prompt.md'),
      versionsPath: join(tempDir, 'prompt-versions.json'),
      maxVersions: 3,
    });
    await smallStore.load();

    // Make 5 edits to exceed max of 3
    for (let i = 1; i <= 5; i++) {
      smallStore.editPrompt({
        oldText: i === 1 ? '## Workflow Guidance' : `## Edit ${i - 1}`,
        newText: `## Edit ${i}`,
        rationale: `Edit ${i}.`,
      });
    }

    expect(smallStore.getVersions().length).toBeLessThanOrEqual(3);
  });

  it('records and retrieves performance metrics', async () => {
    await store.load();

    store.recordMetrics({
      cyclesRun: 10,
      successRate: 0.8,
      avgTurns: 5.5,
    });

    const trend = store.getPerformanceTrend();
    expect(trend.length).toBe(1);
    expect(trend[0]!.metrics!.successRate).toBe(0.8);
  });

  it('diffs two versions', async () => {
    await store.load();

    store.editPrompt({
      oldText: '## Workflow Guidance',
      newText: '## Updated Guidance',
      rationale: 'Testing diff.',
    });

    const diff = store.diffVersions(0, 1);
    expect(diff).not.toBeNull();
    expect(diff).toContain('--- v0');
    expect(diff).toContain('+++ v1');
  });

  it('builds a prompt section for identity', async () => {
    await store.load();

    const section = store.buildPromptSection();
    expect(section.length).toBeGreaterThan(0);
    expect(section).toContain('Workflow Guidance');
  });

  it('saves and reloads edits', async () => {
    await store.load();

    store.editPrompt({
      oldText: '## Workflow Guidance',
      newText: '## Persisted Guidance',
      rationale: 'Testing persistence.',
    });
    await store.save();

    const store2 = new PromptStore({
      promptPath: join(tempDir, 'system-prompt.md'),
      versionsPath: join(tempDir, 'prompt-versions.json'),
    });
    await store2.load();

    expect(store2.getContent()).toContain('Persisted Guidance');
    expect(store2.getVersion()).toBe(1);
  });
});

describe('PromptStore — Factory', () => {
  it('createPromptStore returns a PromptStore', () => {
    const store = createPromptStore({
      promptPath: join(tempDir, 'test.md'),
      versionsPath: join(tempDir, 'versions.json'),
    });
    expect(store).toBeInstanceOf(PromptStore);
  });
});
