import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  AneProvider,
  createAneProvider,
  isAneSupported,
} from '../src/providers/ane.js';
import type {
  AneProviderConfig,
  ClassificationResult,
  AneEmbeddingResult,
  AneHealthStatus,
  TaskCategory,
} from '../src/providers/ane.js';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Mock bridge embed response */
function mockBridgeEmbedResponse(embeddings: number[][]): Response {
  return new Response(
    JSON.stringify({
      embeddings,
      latency_ms: 1.5,
      compute_unit: 'ane',
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

/** Mock bridge classify response */
function mockBridgeClassifyResponse(
  predictions: Array<{ category: string; confidence: number }>,
): Response {
  return new Response(
    JSON.stringify({
      predictions,
      latency_ms: 0.8,
      compute_unit: 'ane',
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

/** Mock bridge health response */
function mockBridgeHealthResponse(options?: {
  status?: 'ok' | 'error';
  ane_available?: boolean;
  models_loaded?: string[];
}): Response {
  return new Response(
    JSON.stringify({
      status: options?.status ?? 'ok',
      ane_available: options?.ane_available ?? true,
      models_loaded: options?.models_loaded ?? [
        'nomic-embed-text-ane',
        'task-classifier-ane',
      ],
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

function defaultConfig(): Partial<AneProviderConfig> {
  return {
    enabled: true,
    bridgeHost: '127.0.0.1',
    bridgePort: 8100,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('AneProvider — Platform Detection', () => {
  it('isAneSupported returns boolean', () => {
    const result = isAneSupported();
    expect(typeof result).toBe('boolean');
  });

  it('returns true on darwin/arm64', () => {
    // This test verifies the function works — actual result depends on platform
    const result = isAneSupported();
    if (process.platform === 'darwin' && process.arch === 'arm64') {
      expect(result).toBe(true);
    }
  });
});

describe('AneProvider — Construction', () => {
  it('creates provider with default config', () => {
    const provider = createAneProvider();
    const config = provider.getConfig();
    expect(config.embeddingDimensions).toBe(768);
    expect(config.cacheSize).toBe(1024);
    expect(config.timeoutMs).toBe(5000);
    expect(config.bridgePort).toBe(8100);
  });

  it('creates provider with custom config', () => {
    const provider = createAneProvider({
      embeddingDimensions: 384,
      cacheSize: 256,
      timeoutMs: 2000,
      bridgePort: 9100,
    });
    const config = provider.getConfig();
    expect(config.embeddingDimensions).toBe(384);
    expect(config.cacheSize).toBe(256);
    expect(config.timeoutMs).toBe(2000);
    expect(config.bridgePort).toBe(9100);
  });

  it('getDimensions returns configured dimensions', () => {
    const provider = createAneProvider({ embeddingDimensions: 512 });
    expect(provider.getDimensions()).toBe(512);
  });
});

describe('AneProvider — Embedding', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns null for empty text', async () => {
    const provider = createAneProvider(defaultConfig());
    const result = await provider.embed('');
    expect(result).toBeNull();
  });

  it('returns null for whitespace-only text', async () => {
    const provider = createAneProvider(defaultConfig());
    const result = await provider.embed('   ');
    expect(result).toBeNull();
  });

  it('returns null when disabled', async () => {
    const provider = createAneProvider({ enabled: false });
    const result = await provider.embed('hello world');
    expect(result).toBeNull();
  });

  it('returns embedding from ANE bridge', async () => {
    const embedding = [0.1, 0.2, 0.3, 0.4, 0.5];
    fetchSpy
      .mockResolvedValueOnce(mockBridgeHealthResponse())
      .mockResolvedValueOnce(mockBridgeEmbedResponse([embedding]));

    const provider = createAneProvider(defaultConfig());
    const result = await provider.embed('hello world');

    expect(result).not.toBeNull();
    expect(result!.embedding).toEqual(embedding);
    expect(result!.source).toBe('ane');
    expect(result!.latencyMs).toBe(1.5);
  });

  it('returns cached embedding on second call', async () => {
    const embedding = [0.1, 0.2, 0.3];
    fetchSpy
      .mockResolvedValueOnce(mockBridgeHealthResponse())
      .mockResolvedValueOnce(mockBridgeEmbedResponse([embedding]));

    const provider = createAneProvider(defaultConfig());

    const result1 = await provider.embed('hello world');
    expect(result1).not.toBeNull();
    expect(result1!.embedding).toEqual(embedding);

    // Second call should use cache — no additional fetch
    const result2 = await provider.embed('hello world');
    expect(result2).not.toBeNull();
    expect(result2!.embedding).toEqual(embedding);
    expect(result2!.latencyMs).toBe(0); // Cached
  });

  it('returns null when bridge is unavailable', async () => {
    fetchSpy.mockRejectedValue(new Error('Connection refused'));

    const provider = createAneProvider(defaultConfig());
    const result = await provider.embed('hello world');

    expect(result).toBeNull();
  });

  it('batch embedding handles mixed cache/compute', async () => {
    const embeddings = [[0.1, 0.2], [0.3, 0.4], [0.5, 0.6]];
    fetchSpy
      .mockResolvedValueOnce(mockBridgeHealthResponse())
      .mockResolvedValueOnce(mockBridgeEmbedResponse(embeddings));

    const provider = createAneProvider(defaultConfig());
    const results = await provider.embedBatch(['hello', 'world', 'test']);

    expect(results).toHaveLength(3);
    expect(results[0]!.embedding).toEqual([0.1, 0.2]);
    expect(results[1]!.embedding).toEqual([0.3, 0.4]);
    expect(results[2]!.embedding).toEqual([0.5, 0.6]);
  });

  it('batch embedding returns nulls when disabled', async () => {
    const provider = createAneProvider({ enabled: false });
    const results = await provider.embedBatch(['hello', 'world']);

    expect(results).toHaveLength(2);
    expect(results[0]).toBeNull();
    expect(results[1]).toBeNull();
  });

  it('batch embedding returns empty array for empty input', async () => {
    const provider = createAneProvider(defaultConfig());
    const results = await provider.embedBatch([]);
    expect(results).toHaveLength(0);
  });
});

describe('AneProvider — Classification', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('classifies empty text as unknown', async () => {
    const provider = createAneProvider(defaultConfig());
    const result = await provider.classify('');

    expect(result.category).toBe('unknown');
    expect(result.confidence).toBe(0);
    expect(result.source).toBe('fallback');
  });

  it('classifies coding tasks via ANE bridge', async () => {
    fetchSpy
      .mockResolvedValueOnce(mockBridgeHealthResponse())
      .mockResolvedValueOnce(
        mockBridgeClassifyResponse([
          { category: 'coding', confidence: 0.92 },
          { category: 'review', confidence: 0.05 },
        ]),
      );

    const provider = createAneProvider(defaultConfig());
    const result = await provider.classify('Fix the broken test in the detector module.');

    expect(result.category).toBe('coding');
    expect(result.confidence).toBe(0.92);
    expect(result.source).toBe('ane');
    expect(result.scores).toHaveLength(2);
  });

  it('falls back to keyword classification when bridge unavailable', async () => {
    fetchSpy.mockRejectedValue(new Error('Connection refused'));

    const provider = createAneProvider(defaultConfig());
    const result = await provider.classify(
      'Fix the broken test in the detector module.',
    );

    expect(result.category).toBe('coding');
    expect(result.source).toBe('fallback');
  });

  it('keyword classifier identifies conversation tasks', async () => {
    const provider = createAneProvider({ enabled: false });
    const result = await provider.classify(
      'Hello, what is the status of the project?',
    );

    expect(result.category).toBe('conversation');
    expect(result.source).toBe('fallback');
  });

  it('keyword classifier identifies analysis tasks', async () => {
    const provider = createAneProvider({ enabled: false });
    const result = await provider.classify(
      'Analyze the performance bottleneck in the memory allocator.',
    );

    expect(result.category).toBe('analysis');
    expect(result.source).toBe('fallback');
  });

  it('keyword classifier identifies planning tasks', async () => {
    const provider = createAneProvider({ enabled: false });
    const result = await provider.classify(
      'Design the architecture for the new authentication system.',
    );

    expect(result.category).toBe('planning');
    expect(result.source).toBe('fallback');
  });

  it('keyword classifier identifies review tasks', async () => {
    const provider = createAneProvider({ enabled: false });
    const result = await provider.classify(
      'Review the pull request and check for issues.',
    );

    expect(result.category).toBe('review');
    expect(result.source).toBe('fallback');
  });

  it('keyword classifier returns unknown for ambiguous input', async () => {
    const provider = createAneProvider({ enabled: false });
    const result = await provider.classify('lorem ipsum dolor sit amet');

    expect(result.category).toBe('unknown');
    expect(result.source).toBe('fallback');
  });

  it('caches classification results', async () => {
    fetchSpy
      .mockResolvedValueOnce(mockBridgeHealthResponse())
      .mockResolvedValueOnce(
        mockBridgeClassifyResponse([
          { category: 'coding', confidence: 0.9 },
        ]),
      );

    const provider = createAneProvider(defaultConfig());

    const result1 = await provider.classify('fix the bug');
    const result2 = await provider.classify('fix the bug');

    // Same result, second should be cached
    expect(result1.category).toBe(result2.category);
  });
});

describe('AneProvider — Health & Stats', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reports healthy status when bridge is available', async () => {
    fetchSpy.mockResolvedValue(mockBridgeHealthResponse());

    const provider = createAneProvider(defaultConfig());
    const health = await provider.getHealth();

    expect(health.bridgeAvailable).toBe(true);
    expect(health.aneAvailable).toBe(true);
    expect(health.embeddingModelLoaded).toBe(true);
    expect(health.classificationModelLoaded).toBe(true);
  });

  it('reports unhealthy when bridge is down', async () => {
    fetchSpy.mockRejectedValue(new Error('Connection refused'));

    const provider = createAneProvider(defaultConfig());
    const health = await provider.getHealth();

    expect(health.bridgeAvailable).toBe(false);
    expect(health.aneAvailable).toBe(false);
  });

  it('tracks ANE embedding count', async () => {
    const embedding = [0.1, 0.2, 0.3];
    fetchSpy
      .mockResolvedValueOnce(mockBridgeHealthResponse())
      .mockResolvedValueOnce(mockBridgeEmbedResponse([embedding]))
      .mockResolvedValueOnce(mockBridgeHealthResponse());

    const provider = createAneProvider(defaultConfig());
    await provider.embed('hello');

    const health = await provider.getHealth();
    expect(health.totalAneEmbeddings).toBe(1);
  });

  it('cache stats reflect usage', async () => {
    const provider = createAneProvider({ cacheSize: 100, enabled: false });
    const stats = provider.getCacheStats();

    expect(stats.embeddingCache.size).toBe(0);
    expect(stats.embeddingCache.maxSize).toBe(100);
    expect(stats.classificationCache.size).toBe(0);
    expect(stats.classificationCache.maxSize).toBe(25);
  });

  it('clearCaches resets all caches', async () => {
    const provider = createAneProvider({ enabled: false });

    // Classify something to populate the classification cache
    await provider.classify('fix the bug in the test');
    let stats = provider.getCacheStats();
    expect(stats.classificationCache.size).toBe(1);

    provider.clearCaches();
    stats = provider.getCacheStats();
    expect(stats.embeddingCache.size).toBe(0);
    expect(stats.classificationCache.size).toBe(0);
  });
});

describe('AneProvider — isAvailable', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns false when disabled', async () => {
    const provider = createAneProvider({ enabled: false });
    const available = await provider.isAvailable();
    expect(available).toBe(false);
  });

  it('returns true when bridge is healthy', async () => {
    fetchSpy.mockResolvedValue(mockBridgeHealthResponse());

    const provider = createAneProvider(defaultConfig());
    const available = await provider.isAvailable();
    expect(available).toBe(true);
  });

  it('returns false when bridge is down', async () => {
    fetchSpy.mockRejectedValue(new Error('Connection refused'));

    const provider = createAneProvider(defaultConfig());
    const available = await provider.isAvailable();
    expect(available).toBe(false);
  });
});

describe('AneProvider — Keyword Classifier (unit)', () => {
  it('returns scores sorted by confidence descending', () => {
    const provider = createAneProvider({ enabled: false });
    const result = provider.classifyByKeywords(
      'implement and review the authentication module code',
    );

    expect(result.scores.length).toBeGreaterThan(0);
    for (let i = 1; i < result.scores.length; i++) {
      expect(result.scores[i]!.confidence).toBeLessThanOrEqual(
        result.scores[i - 1]!.confidence,
      );
    }
  });

  it('highest score becomes the category', () => {
    const provider = createAneProvider({ enabled: false });
    const result = provider.classifyByKeywords('debug and fix the typescript compile error');

    expect(result.category).toBe(result.scores[0]!.category);
  });
});
