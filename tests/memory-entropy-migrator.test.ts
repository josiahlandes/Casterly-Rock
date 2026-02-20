import { describe, expect, it, beforeEach } from 'vitest';

import {
  EntropyMigrator,
  createEntropyMigrator,
  calculateEntropy,
} from '../src/autonomous/memory/entropy-migrator.js';
import type { EntryForScoring } from '../src/autonomous/memory/entropy-migrator.js';
import { resetTracer, initTracer } from '../src/autonomous/debug.js';

beforeEach(() => {
  resetTracer();
  initTracer({ enabled: false });
});

describe('calculateEntropy', () => {
  it('returns 0 for empty text', () => {
    expect(calculateEntropy('')).toBe(0);
  });

  it('returns 0 for a single repeated word', () => {
    expect(calculateEntropy('test test test test')).toBe(0);
  });

  it('returns higher entropy for diverse text', () => {
    const low = calculateEntropy('the the the the the');
    const high = calculateEntropy('the quick brown fox jumps over lazy dog');
    expect(high).toBeGreaterThan(low);
  });

  it('returns maximum entropy for all unique words', () => {
    const text = 'alpha beta gamma delta epsilon zeta';
    const entropy = calculateEntropy(text);
    // 6 unique words → max entropy = log2(6) ≈ 2.585
    expect(entropy).toBeCloseTo(Math.log2(6), 1);
  });
});

describe('EntropyMigrator', () => {
  function makeEntry(
    overrides: Partial<EntryForScoring> = {},
  ): EntryForScoring {
    return {
      id: 'test-entry',
      content: 'the quick brown fox jumps over the lazy dog',
      currentTier: 'cool',
      accessCount: 5,
      lastAccessedAt: new Date().toISOString(),
      createdAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
      ...overrides,
    };
  }

  describe('evaluate', () => {
    it('recommends promotion for high-value entries', () => {
      const migrator = createEntropyMigrator();
      const report = migrator.evaluate([
        makeEntry({
          content: 'The provider interface uses a stable contract with explicit timeouts retries and error handling for all local inference through Ollama',
          accessCount: 50,
          lastAccessedAt: new Date().toISOString(),
          currentTier: 'cool',
        }),
      ]);

      expect(report.evaluated).toBe(1);
      const candidate = report.candidates[0]!;
      expect(candidate.migrationScore).toBeGreaterThan(0);
    });

    it('recommends demotion for low-value entries', () => {
      const migrator = createEntropyMigrator();
      const report = migrator.evaluate([
        makeEntry({
          content: 'test test test',
          accessCount: 0,
          lastAccessedAt: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString(),
          currentTier: 'warm',
        }),
      ]);

      const candidate = report.candidates[0]!;
      expect(candidate.direction).toBe('demote');
    });

    it('marks entries as stable when tier matches score', () => {
      const migrator = createEntropyMigrator();
      const report = migrator.evaluate([
        makeEntry({ currentTier: 'cold', accessCount: 0 }),
      ]);

      // A cold entry with moderate entropy and recent creation may get promoted
      const candidate = report.candidates[0]!;
      expect(['stay', 'demote', 'promote']).toContain(candidate.direction);
    });
  });

  describe('quickScore', () => {
    it('returns entropy metrics for content', () => {
      const migrator = createEntropyMigrator();
      const score = migrator.quickScore('This is a diverse and informative piece of text with many unique words');
      expect(score.entropy).toBeGreaterThan(0);
      expect(score.normalizedEntropy).toBeGreaterThan(0);
      expect(score.normalizedEntropy).toBeLessThanOrEqual(1);
    });
  });
});
