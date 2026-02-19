/**
 * Embedding Provider — On-device embeddings via Ollama
 *
 * Wraps Ollama's /api/embed endpoint for semantic search. Uses a lightweight
 * embedding model (nomic-embed-text, ~40MB, 768 dimensions) that coexists
 * with the main inference models in 128GB unified memory.
 *
 * Features:
 *   - In-memory LRU cache keyed by content hash (avoids re-embedding)
 *   - Configurable model and dimensions
 *   - Batch embedding support
 *   - Cosine similarity helper
 *
 * Privacy: All embeddings are computed locally. No data leaves the machine.
 */

import { createHash } from 'node:crypto';
import { getTracer } from '../autonomous/debug.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface EmbeddingProviderConfig {
  /** Ollama base URL */
  baseUrl: string;

  /** Embedding model name */
  model: string;

  /** Expected embedding dimensions (for validation) */
  dimensions: number;

  /** Request timeout in milliseconds */
  timeoutMs: number;

  /** Maximum LRU cache entries */
  maxCacheSize: number;
}

export interface EmbeddingResult {
  /** The embedding vector */
  embedding: number[];

  /** The model that produced it */
  model: string;

  /** Whether this result came from cache */
  cached: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: EmbeddingProviderConfig = {
  baseUrl: 'http://127.0.0.1:11434',
  model: 'nomic-embed-text',
  dimensions: 768,
  timeoutMs: 30_000,
  maxCacheSize: 500,
};

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Hash content for cache key. Uses SHA-256 truncated to 16 hex chars.
 */
function contentHash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

/**
 * Compute cosine similarity between two vectors.
 * Returns a value between -1 and 1 (1 = identical direction).
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    const ai = a[i]!;
    const bi = b[i]!;
    dotProduct += ai * bi;
    normA += ai * ai;
    normB += bi * bi;
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  if (denominator === 0) return 0;

  return dotProduct / denominator;
}

// ─────────────────────────────────────────────────────────────────────────────
// LRU Cache
// ─────────────────────────────────────────────────────────────────────────────

class LruCache<V> {
  private readonly maxSize: number;
  private readonly map = new Map<string, V>();

  constructor(maxSize: number) {
    this.maxSize = maxSize;
  }

  get(key: string): V | undefined {
    const value = this.map.get(key);
    if (value !== undefined) {
      // Move to end (most recently used)
      this.map.delete(key);
      this.map.set(key, value);
    }
    return value;
  }

  set(key: string, value: V): void {
    if (this.map.has(key)) {
      this.map.delete(key);
    } else if (this.map.size >= this.maxSize) {
      // Evict oldest (first entry)
      const firstKey = this.map.keys().next().value;
      if (firstKey !== undefined) {
        this.map.delete(firstKey);
      }
    }
    this.map.set(key, value);
  }

  get size(): number {
    return this.map.size;
  }

  clear(): void {
    this.map.clear();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Embedding Provider
// ─────────────────────────────────────────────────────────────────────────────

export class EmbeddingProvider {
  private readonly config: EmbeddingProviderConfig;
  private readonly cache: LruCache<number[]>;

  constructor(config?: Partial<EmbeddingProviderConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.cache = new LruCache(this.config.maxCacheSize);
  }

  /**
   * Embed a single text string.
   */
  async embed(text: string): Promise<EmbeddingResult> {
    const tracer = getTracer();
    const hash = contentHash(text);

    // Check cache
    const cached = this.cache.get(hash);
    if (cached) {
      tracer.log('embedding', 'debug', 'Cache hit', { hash });
      return { embedding: cached, model: this.config.model, cached: true };
    }

    // Call Ollama
    const embedding = await this.callOllama(text);
    this.cache.set(hash, embedding);

    return { embedding, model: this.config.model, cached: false };
  }

  /**
   * Embed multiple texts. Returns embeddings in the same order.
   * Uses cache where available.
   */
  async embedBatch(texts: string[]): Promise<EmbeddingResult[]> {
    const tracer = getTracer();
    const results: EmbeddingResult[] = [];
    const uncachedIndices: number[] = [];
    const uncachedTexts: string[] = [];

    // Separate cached from uncached
    for (let i = 0; i < texts.length; i++) {
      const text = texts[i]!;
      const hash = contentHash(text);
      const cached = this.cache.get(hash);

      if (cached) {
        results[i] = { embedding: cached, model: this.config.model, cached: true };
      } else {
        uncachedIndices.push(i);
        uncachedTexts.push(text);
      }
    }

    tracer.log('embedding', 'debug', `Batch embed: ${texts.length} total, ${uncachedTexts.length} uncached`);

    // Embed uncached texts one at a time (Ollama /api/embed supports single input)
    for (let j = 0; j < uncachedTexts.length; j++) {
      const text = uncachedTexts[j]!;
      const idx = uncachedIndices[j]!;
      const embedding = await this.callOllama(text);
      const hash = contentHash(text);
      this.cache.set(hash, embedding);
      results[idx] = { embedding, model: this.config.model, cached: false };
    }

    return results;
  }

  /**
   * Get cache statistics.
   */
  getCacheStats(): { size: number; maxSize: number } {
    return { size: this.cache.size, maxSize: this.config.maxCacheSize };
  }

  /**
   * Clear the embedding cache.
   */
  clearCache(): void {
    this.cache.clear();
  }

  /**
   * Get the configured model name.
   */
  getModel(): string {
    return this.config.model;
  }

  /**
   * Get the configured dimensions.
   */
  getDimensions(): number {
    return this.config.dimensions;
  }

  // ── Private ──────────────────────────────────────────────────────────────

  private async callOllama(text: string): Promise<number[]> {
    const tracer = getTracer();
    const url = `${this.config.baseUrl}/api/embed`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.config.model,
          input: text,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`Ollama embedding request failed: ${response.status} ${response.statusText}`);
      }

      const data = await response.json() as { embeddings?: number[][] };

      if (!data.embeddings || !Array.isArray(data.embeddings) || data.embeddings.length === 0) {
        throw new Error('Ollama returned no embeddings');
      }

      const embedding = data.embeddings[0]!;

      if (embedding.length !== this.config.dimensions) {
        tracer.log('embedding', 'warn', `Unexpected dimensions: got ${embedding.length}, expected ${this.config.dimensions}`);
      }

      return embedding;
    } finally {
      clearTimeout(timeout);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────────────────────

export function createEmbeddingProvider(
  config?: Partial<EmbeddingProviderConfig>,
): EmbeddingProvider {
  return new EmbeddingProvider(config);
}
