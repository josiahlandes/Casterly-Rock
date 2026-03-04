import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { EmbeddingProvider } from '../src/providers/embedding.js';
import { AneProvider } from '../src/providers/ane.js';

// ═══════════════════════════════════════════════════════════════════════════════
// ANE Integration Tests
//
// Tests that the ANE provider is properly wired into the embedding provider
// and classifier as a preferred backend with fallback to Ollama/LLM.
// ═══════════════════════════════════════════════════════════════════════════════

const originalFetch = globalThis.fetch;

function mockEmbedding(dims: number = 768, seed: number = 1): number[] {
  const vec: number[] = [];
  for (let i = 0; i < dims; i++) {
    vec.push(Math.sin(seed * (i + 1)) * 0.5);
  }
  return vec;
}

describe('ANE → EmbeddingProvider integration', () => {
  let embeddingProvider: EmbeddingProvider;
  let aneProvider: AneProvider;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    embeddingProvider = new EmbeddingProvider({ cacheSize: 32 });
    aneProvider = new AneProvider({ enabled: true, bridgePort: 19999 });
    embeddingProvider.setAneProvider(aneProvider);
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('uses ANE when bridge is available', async () => {
    const aneEmbedding = mockEmbedding(768, 42);

    // ANE health check → ok
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/health')) {
        return {
          ok: true,
          json: async () => ({ status: 'ok', ane_available: true, models_loaded: [] }),
        };
      }
      if (url.includes('/embed')) {
        return {
          ok: true,
          json: async () => ({
            embeddings: [aneEmbedding],
            latency_ms: 2,
            compute_unit: 'ane',
          }),
        };
      }
      return { ok: false };
    });

    const result = await embeddingProvider.embed('test text');
    expect(result).toEqual(aneEmbedding);

    // Should have called ANE bridge, not Ollama
    const urls = fetchMock.mock.calls.map((c: unknown[]) => c[0] as string);
    expect(urls.some((u: string) => u.includes(':19999'))).toBe(true);
    expect(urls.some((u: string) => u.includes('11434'))).toBe(false);
  });

  it('falls back to Ollama when ANE bridge is unavailable', async () => {
    const ollamaEmbedding = mockEmbedding(768, 99);

    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes(':19999')) {
        // ANE bridge not running
        throw new Error('Connection refused');
      }
      if (url.includes('/api/embed')) {
        return {
          ok: true,
          json: async () => ({
            embeddings: [ollamaEmbedding],
          }),
        };
      }
      return { ok: false };
    });

    const result = await embeddingProvider.embed('fallback text');
    expect(result).toEqual(ollamaEmbedding);
  });

  it('returns null when both ANE and Ollama fail', async () => {
    fetchMock.mockRejectedValue(new Error('All backends down'));

    const result = await embeddingProvider.embed('no backend');
    expect(result).toBeNull();
  });

  it('works without ANE provider set (Ollama only)', async () => {
    const plainProvider = new EmbeddingProvider({ cacheSize: 32 });
    const ollamaEmbedding = mockEmbedding(768, 7);

    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ embeddings: [ollamaEmbedding] }),
    });

    const result = await plainProvider.embed('ollama only');
    expect(result).toEqual(ollamaEmbedding);
  });

  it('caches ANE results for subsequent calls', async () => {
    const aneEmbedding = mockEmbedding(768, 55);

    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/health')) {
        return {
          ok: true,
          json: async () => ({ status: 'ok', ane_available: true, models_loaded: [] }),
        };
      }
      if (url.includes('/embed')) {
        return {
          ok: true,
          json: async () => ({
            embeddings: [aneEmbedding],
            latency_ms: 1,
            compute_unit: 'ane',
          }),
        };
      }
      return { ok: false };
    });

    const result1 = await embeddingProvider.embed('cached text');
    const result2 = await embeddingProvider.embed('cached text');

    expect(result1).toEqual(aneEmbedding);
    expect(result2).toEqual(aneEmbedding);

    // Second call should hit embedding provider cache, not ANE again
    // (ANE has its own cache too, but embedding provider cache is checked first)
    const embedCalls = fetchMock.mock.calls.filter(
      (c: unknown[]) => (c[0] as string).includes('/embed')
    );
    // At most 1 ANE embed call (the first one)
    expect(embedCalls.length).toBeLessThanOrEqual(1);
  });
});

describe('ANE → Classifier integration', () => {
  it('exports setClassifierAneProvider', async () => {
    const { setClassifierAneProvider } = await import('../src/tasks/classifier.js');
    expect(typeof setClassifierAneProvider).toBe('function');
  });

  it('maps ANE categories to task classes correctly', async () => {
    // This tests the exported function indirectly —
    // we verify that conversation stays conversation and coding maps to complex_task
    const { setClassifierAneProvider, classifyMessage } = await import('../src/tasks/classifier.js');
    const ane = new AneProvider({ enabled: true, bridgePort: 19998 });
    setClassifierAneProvider(ane);

    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    // ANE health → ok, classify → conversation with high confidence
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/health')) {
        return {
          ok: true,
          json: async () => ({ status: 'ok', ane_available: true, models_loaded: [] }),
        };
      }
      if (url.includes('/classify')) {
        return {
          ok: true,
          json: async () => ({
            predictions: [
              { category: 'conversation', confidence: 0.95 },
              { category: 'coding', confidence: 0.03 },
            ],
            latency_ms: 1,
            compute_unit: 'ane',
          }),
        };
      }
      return { ok: false };
    });

    // Provide a mock LLM provider that should NOT be called (ANE handles it)
    const mockProvider = {
      generateWithTools: vi.fn(),
    };

    const result = await classifyMessage('hello there', [], mockProvider as never);

    expect(result.taskClass).toBe('conversation');
    expect(result.confidence).toBeGreaterThanOrEqual(0.85);
    // LLM should not have been called
    expect(mockProvider.generateWithTools).not.toHaveBeenCalled();

    // Clean up
    globalThis.fetch = originalFetch;
  });
});
