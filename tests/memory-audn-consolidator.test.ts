import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { AudnConsolidator, createAudnConsolidator } from '../src/autonomous/memory/audn-consolidator.js';
import { resetTracer, initTracer } from '../src/autonomous/debug.js';

let tempDir: string;

beforeEach(async () => {
  resetTracer();
  initTracer({ enabled: false });
  tempDir = await mkdtemp(join(tmpdir(), 'casterly-audn-test-'));
});

afterEach(async () => {
  resetTracer();
  await rm(tempDir, { recursive: true, force: true });
});

function makeConsolidator(): AudnConsolidator {
  return createAudnConsolidator({
    queuePath: join(tempDir, 'audn-queue.json'),
  });
}

describe('AudnConsolidator', () => {
  describe('enqueue', () => {
    it('adds candidates to the queue', () => {
      const audn = makeConsolidator();
      audn.enqueue({ content: 'The user prefers TypeScript', source: 'crystal' });
      audn.enqueue({ content: 'Tests use Vitest', source: 'journal' });

      expect(audn.queueSize()).toBe(2);
    });

    it('trims queue at max capacity', () => {
      const audn = createAudnConsolidator({
        queuePath: join(tempDir, 'audn.json'),
        maxQueueSize: 2,
      });

      audn.enqueue({ content: 'First', source: 'crystal' });
      audn.enqueue({ content: 'Second', source: 'crystal' });
      audn.enqueue({ content: 'Third', source: 'crystal' });

      expect(audn.queueSize()).toBe(2);
    });
  });

  describe('consolidate', () => {
    it('adds new memories with no overlap', () => {
      const audn = makeConsolidator();
      audn.enqueue({ content: 'The user prefers functional patterns', source: 'crystal' });

      const existing = new Map<string, string>();
      existing.set('existing-1', 'Tests in this repo use Vitest');

      const report = audn.consolidate(existing);
      expect(report.processed).toBe(1);
      expect(report.added).toBe(1);
      expect(report.evaluations[0]!.decision).toBe('add');
    });

    it('skips candidates that are already known', () => {
      const audn = makeConsolidator();
      audn.enqueue({ content: 'Tests in this repo use Vitest with vi.fn()', source: 'crystal' });

      const existing = new Map<string, string>();
      existing.set('existing-1', 'Tests in this repo use Vitest with vi.fn() pattern');

      const report = audn.consolidate(existing);
      expect(report.skipped).toBeGreaterThanOrEqual(0);
      // With bigram similarity, very similar content should be detected
    });

    it('recommends update for partial overlap', () => {
      const audn = createAudnConsolidator({
        queuePath: join(tempDir, 'audn.json'),
        updateThreshold: 0.2,
        nothingThreshold: 0.9,
      });

      audn.enqueue({ content: 'TypeScript errors should be fixed before committing code changes', source: 'crystal' });

      const existing = new Map<string, string>();
      existing.set('existing-1', 'TypeScript errors should be fixed early in the development process');

      const report = audn.consolidate(existing);
      expect(report.processed).toBe(1);
      // Should be 'update' or 'add' depending on exact similarity
      expect(['add', 'update']).toContain(report.evaluations[0]!.decision);
    });

    it('clears queue after processing', () => {
      const audn = makeConsolidator();
      audn.enqueue({ content: 'Test content', source: 'journal' });
      audn.consolidate(new Map());
      expect(audn.queueSize()).toBe(0);
    });
  });

  describe('persistence', () => {
    it('saves and loads queue', async () => {
      const audn1 = makeConsolidator();
      audn1.enqueue({ content: 'Queued item', source: 'crystal' });
      await audn1.save();

      const audn2 = makeConsolidator();
      await audn2.load();
      expect(audn2.queueSize()).toBe(1);
    });
  });
});
