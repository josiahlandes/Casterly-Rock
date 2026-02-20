import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { EmbeddingProvider } from '../src/providers/embedding.js';

// ═══════════════════════════════════════════════════════════════════════════════
// Embedding Provider Tests
//
// Since Ollama is not available in the test environment, we mock fetch()
// to test the provider logic: caching, batching, graceful degradation.
// ═══════════════════════════════════════════════════════════════════════════════

let provider: EmbeddingProvider;
let fetchMock: ReturnType<typeof vi.fn>;
const originalFetch = globalThis.fetch;

/**
 * Create a mock embedding vector of the given dimensions.
 */
function mockEmbedding(dims: number = 768, seed: number = 1): number[] {
  const vec: number[] = [];
  for (let i = 0; i < dims; i++) {
    vec.push(Math.sin(seed * (i + 1)) * 0.5);
  }
  return vec;
}

/**
 * Create a mock fetch response for /api/embed.
 */
function mockFetchOk(embeddings: number[][]): ReturnType<typeof vi.fn> {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ embeddings }),
  });
}

beforeEach(() => {
  fetchMock = mockFetchOk([mockEmbedding()]);
  globalThis.fetch = fetchMock as unknown as typeof fetch;

  provider = new EmbeddingProvider({
    baseUrl: 'http://localhost:11434',
    model: 'nomic-embed-text',
    dimensions: 768,
    cacheSize: 10,
    timeoutMs: 5000,
  });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  provider.clearCache();
});

// ─────────────────────────────────────────────────────────────────────────────
// Single Embedding
// ─────────────────────────────────────────────────────────────────────────────

describe('EmbeddingProvider — embed', () => {
  it('returns an embedding vector for valid text', async () => {
    const result = await provider.embed('hello world');
    expect(result).not.toBeNull();
    expect(result!.length).toBe(768);
  });

  it('calls Ollama /api/embed with correct payload', async () => {
    await provider.embed('test query');

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, options] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://localhost:11434/api/embed');

    const body = JSON.parse(options.body as string);
    expect(body.model).toBe('nomic-embed-text');
    expect(body.input).toEqual(['test query']);
  });

  it('returns null for empty text', async () => {
    expect(await provider.embed('')).toBeNull();
    expect(await provider.embed('  ')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns null when Ollama returns non-ok response', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
    }) as unknown as typeof fetch;

    const result = await provider.embed('test');
    expect(result).toBeNull();
  });

  it('returns null when Ollama returns malformed response', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ something: 'wrong' }),
    }) as unknown as typeof fetch;

    const result = await provider.embed('test');
    expect(result).toBeNull();
  });

  it('returns null when fetch throws (network error)', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) as unknown as typeof fetch;

    const result = await provider.embed('test');
    expect(result).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// LRU Cache
// ─────────────────────────────────────────────────────────────────────────────

describe('EmbeddingProvider — caching', () => {
  it('caches embeddings for repeated text', async () => {
    await provider.embed('cached text');
    await provider.embed('cached text');

    // Should only call fetch once (second hit comes from cache)
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('cache hit returns same vector', async () => {
    const first = await provider.embed('same text');
    const second = await provider.embed('same text');

    expect(first).toEqual(second);
  });

  it('different texts get separate cache entries', async () => {
    fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ embeddings: [mockEmbedding(768, 1)] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ embeddings: [mockEmbedding(768, 2)] }),
      });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const a = await provider.embed('text a');
    const b = await provider.embed('text b');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(a).not.toEqual(b);
  });

  it('evicts oldest entries when cache is full', async () => {
    // Cache size is 10
    for (let i = 0; i < 12; i++) {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ embeddings: [mockEmbedding(768, i)] }),
      });
      await provider.embed(`text-${i}`);
    }

    expect(provider.getCacheStats().size).toBe(10);
  });

  it('clearCache empties the cache', async () => {
    await provider.embed('cached');
    expect(provider.getCacheStats().size).toBe(1);

    provider.clearCache();
    expect(provider.getCacheStats().size).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Batch Embedding
// ─────────────────────────────────────────────────────────────────────────────

describe('EmbeddingProvider — embedBatch', () => {
  it('returns embeddings for multiple texts', async () => {
    fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        embeddings: [mockEmbedding(768, 1), mockEmbedding(768, 2), mockEmbedding(768, 3)],
      }),
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const results = await provider.embedBatch(['hello', 'world', 'test']);
    expect(results).toHaveLength(3);
    expect(results[0]).not.toBeNull();
    expect(results[1]).not.toBeNull();
    expect(results[2]).not.toBeNull();
  });

  it('returns empty array for empty input', async () => {
    const results = await provider.embedBatch([]);
    expect(results).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('uses cache for previously embedded texts', async () => {
    // First embed one text
    await provider.embed('already cached');

    // Now batch with one cached and one new
    fetchMock.mockClear();
    fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ embeddings: [mockEmbedding(768, 99)] }),
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const results = await provider.embedBatch(['already cached', 'new text']);

    expect(results).toHaveLength(2);
    expect(results[0]).not.toBeNull(); // from cache
    expect(results[1]).not.toBeNull(); // from API

    // Only the uncached text should trigger a fetch
    expect(fetchMock).toHaveBeenCalledOnce();
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(body.input).toEqual(['new text']);
  });

  it('handles empty strings in batch', async () => {
    const results = await provider.embedBatch(['', 'valid', '']);
    expect(results[0]).toBeNull();
    expect(results[2]).toBeNull();
    // Only 'valid' should be embedded
  });

  it('handles fetch failure gracefully in batch', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('network')) as unknown as typeof fetch;

    const results = await provider.embedBatch(['a', 'b', 'c']);
    expect(results).toHaveLength(3);
    // All null due to network failure
    expect(results[0]).toBeNull();
    expect(results[1]).toBeNull();
    expect(results[2]).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

describe('EmbeddingProvider — configuration', () => {
  it('getModel returns configured model', () => {
    expect(provider.getModel()).toBe('nomic-embed-text');
  });

  it('getDimensions returns configured dimensions', () => {
    expect(provider.getDimensions()).toBe(768);
  });

  it('getCacheStats returns correct info', () => {
    const stats = provider.getCacheStats();
    expect(stats.size).toBe(0);
    expect(stats.maxSize).toBe(10);
  });

  it('uses default config when none provided', () => {
    const defaultProvider = new EmbeddingProvider();
    expect(defaultProvider.getModel()).toBe('nomic-embed-text');
    expect(defaultProvider.getDimensions()).toBe(768);
    expect(defaultProvider.getCacheStats().maxSize).toBe(512);
  });
});
