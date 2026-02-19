import { describe, it, expect } from 'vitest';

import {
  EmbeddingProvider,
  cosineSimilarity,
  createEmbeddingProvider,
} from '../src/providers/embedding.js';
import { resetTracer, initTracer } from '../src/autonomous/debug.js';

// Ensure tracer is silent for tests
resetTracer();
initTracer({ enabled: false });

// ─────────────────────────────────────────────────────────────────────────────
// cosineSimilarity
// ─────────────────────────────────────────────────────────────────────────────

describe('cosineSimilarity', () => {
  it('returns 1.0 for identical unit vectors', () => {
    const v = [1, 0, 0];
    expect(cosineSimilarity(v, v)).toBeCloseTo(1.0, 5);
  });

  it('returns 1.0 for identical non-unit vectors', () => {
    const v = [3, 4, 5];
    expect(cosineSimilarity(v, v)).toBeCloseTo(1.0, 5);
  });

  it('returns 0.0 for orthogonal vectors', () => {
    const a = [1, 0, 0];
    const b = [0, 1, 0];
    expect(cosineSimilarity(a, b)).toBeCloseTo(0.0, 5);
  });

  it('returns -1.0 for opposite vectors', () => {
    const a = [1, 0, 0];
    const b = [-1, 0, 0];
    expect(cosineSimilarity(a, b)).toBeCloseTo(-1.0, 5);
  });

  it('returns 0 for empty vectors', () => {
    expect(cosineSimilarity([], [])).toBe(0);
  });

  it('returns 0 for different length vectors', () => {
    expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0);
  });

  it('returns 0 for zero vectors', () => {
    expect(cosineSimilarity([0, 0, 0], [0, 0, 0])).toBe(0);
  });

  it('computes correct similarity for arbitrary vectors', () => {
    const a = [1, 2, 3];
    const b = [4, 5, 6];
    // dot = 4+10+18 = 32
    // |a| = sqrt(14), |b| = sqrt(77)
    // cos = 32 / sqrt(14*77) = 32 / sqrt(1078)
    const expected = 32 / Math.sqrt(14 * 77);
    expect(cosineSimilarity(a, b)).toBeCloseTo(expected, 5);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// EmbeddingProvider — Config
// ─────────────────────────────────────────────────────────────────────────────

describe('EmbeddingProvider — Configuration', () => {
  it('default config has nomic-embed-text model', () => {
    const provider = new EmbeddingProvider();
    expect(provider.getModel()).toBe('nomic-embed-text');
  });

  it('custom config is applied', () => {
    const provider = new EmbeddingProvider({
      model: 'custom-embed',
      dimensions: 384,
    });
    expect(provider.getModel()).toBe('custom-embed');
    expect(provider.getDimensions()).toBe(384);
  });

  it('getDimensions returns the configured dimensions', () => {
    const provider = new EmbeddingProvider({ dimensions: 512 });
    expect(provider.getDimensions()).toBe(512);
  });

  it('getModel returns the configured model name', () => {
    const provider = new EmbeddingProvider({ model: 'all-minilm' });
    expect(provider.getModel()).toBe('all-minilm');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// EmbeddingProvider — Cache
// ─────────────────────────────────────────────────────────────────────────────

describe('EmbeddingProvider — Cache', () => {
  it('initial cache is empty', () => {
    const provider = new EmbeddingProvider();
    const stats = provider.getCacheStats();
    expect(stats.size).toBe(0);
    expect(stats.maxSize).toBe(500);
  });

  it('clearCache empties the cache', () => {
    const provider = new EmbeddingProvider();
    // Even with no entries, clearCache should not throw
    provider.clearCache();
    const stats = provider.getCacheStats();
    expect(stats.size).toBe(0);
  });

  it('cache respects custom maxCacheSize', () => {
    const provider = new EmbeddingProvider({ maxCacheSize: 42 });
    const stats = provider.getCacheStats();
    expect(stats.maxSize).toBe(42);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────────────────────

describe('EmbeddingProvider — Factory', () => {
  it('createEmbeddingProvider returns an EmbeddingProvider instance', () => {
    const provider = createEmbeddingProvider({ model: 'test-model' });
    expect(provider).toBeInstanceOf(EmbeddingProvider);
    expect(provider.getModel()).toBe('test-model');
  });

  it('createEmbeddingProvider with no args uses defaults', () => {
    const provider = createEmbeddingProvider();
    expect(provider).toBeInstanceOf(EmbeddingProvider);
    expect(provider.getModel()).toBe('nomic-embed-text');
    expect(provider.getDimensions()).toBe(768);
  });
});
