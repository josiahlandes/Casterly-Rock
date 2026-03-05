/**
 * Embedding Provider — On-device embeddings via ANE or Ollama
 *
 * Wraps embedding computation with a two-tier strategy:
 *   1. ANE (Apple Neural Engine) — zero-cost NPU inference when available
 *   2. Ollama /api/embed — GPU-based fallback via nomic-embed-text
 *
 * Uses nomic-embed-text (~40MB, 768 dimensions) by default, with an
 * in-memory LRU cache keyed by content hash.
 *
 * Design:
 *   - Local-only: all computation stays on-device.
 *   - ANE-first: when the CoreML bridge is running, embeddings route to
 *     the Neural Engine (19 TFLOPS at 2.8W), freeing the GPU for main
 *     inference models.
 *   - LRU cache: avoids redundant API calls for repeated content.
 *   - Graceful degradation: if both ANE and Ollama are unreachable,
 *     returns null instead of throwing. Callers fall back to keyword-only
 *     recall.
 *
 * Part of Supporting Work: Semantic Memory.
 * ANE integration: docs/roadmap.md Tier 4, Item 11.
 */

import { createHash } from 'node:crypto';
import type { AneProvider } from './ane.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Configuration for the embedding provider.
 */
export interface EmbeddingProviderConfig {
  /** Ollama base URL (default: http://localhost:11434) */
  baseUrl: string;

  /** Embedding model name (default: nomic-embed-text) */
  model: string;

  /** Expected embedding dimensions (default: 768 for nomic-embed-text) */
  dimensions: number;

  /** Maximum entries in the LRU cache (default: 512) */
  cacheSize: number;

  /** Request timeout in milliseconds (default: 10000) */
  timeoutMs: number;
}

/**
 * Ollama /api/embed request format.
 */
interface OllamaEmbedRequest {
  model: string;
  input: string[];
}

/**
 * Ollama /api/embed response format.
 */
interface OllamaEmbedResponse {
  embeddings: number[][];
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: EmbeddingProviderConfig = {
  baseUrl: 'http://localhost:11434',
  model: 'nomic-embed-text',
  dimensions: 768,
  cacheSize: 512,
  timeoutMs: 10_000,
};

// ─────────────────────────────────────────────────────────────────────────────
// LRU Cache
// ─────────────────────────────────────────────────────────────────────────────

class LRUCache<V> {
  private readonly maxSize: number;
  private readonly cache = new Map<string, V>();

  constructor(maxSize: number) {
    this.maxSize = maxSize;
  }

  get(key: string): V | undefined {
    const value = this.cache.get(key);
    if (value !== undefined) {
      // Move to end (most recently used)
      this.cache.delete(key);
      this.cache.set(key, value);
    }
    return value;
  }

  set(key: string, value: V): void {
    // Delete first to reset order
    this.cache.delete(key);
    this.cache.set(key, value);

    // Evict oldest if over capacity
    if (this.cache.size > this.maxSize) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) {
        this.cache.delete(oldest);
      }
    }
  }

  get size(): number {
    return this.cache.size;
  }

  clear(): void {
    this.cache.clear();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Embedding Provider
// ─────────────────────────────────────────────────────────────────────────────

export class EmbeddingProvider {
  private readonly config: EmbeddingProviderConfig;
  private readonly cache: LRUCache<number[]>;
  private aneProvider: AneProvider | null = null;

  constructor(config?: Partial<EmbeddingProviderConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.cache = new LRUCache(this.config.cacheSize);
  }

  /**
   * Attach an ANE provider for NPU-accelerated embeddings.
   * When set, embed() tries ANE first and falls back to Ollama.
   */
  setAneProvider(ane: AneProvider): void {
    this.aneProvider = ane;
  }

  /**
   * Compute an embedding for a single text string.
   * Returns null if the embedding cannot be computed (Ollama unreachable,
   * model not loaded, etc.). Callers should fall back to keyword-only recall.
   */
  async embed(text: string): Promise<number[] | null> {
    if (!text || text.trim().length === 0) return null;

    // Check cache
    const key = this.cacheKey(text);
    const cached = this.cache.get(key);
    if (cached) return cached;

    // Try ANE first (NPU — frees GPU for main inference)
    if (this.aneProvider) {
      try {
        const aneResult = await this.aneProvider.embed(text);
        if (aneResult) {
          this.cache.set(key, aneResult.embedding);
          return aneResult.embedding;
        }
      } catch {
        // ANE failed, fall through to Ollama
      }
    }

    // Fall back to Ollama (GPU)
    try {
      const response = await this.callOllamaEmbed([text]);
      if (!response || response.length === 0) return null;

      const embedding = response[0]!;
      this.cache.set(key, embedding);
      return embedding;
    } catch {
      // Graceful degradation: return null, caller falls back to keyword recall
      return null;
    }
  }

  /**
   * Compute embeddings for multiple texts in a single batch call.
   * Returns an array of the same length as input; individual entries may be
   * null if embedding failed for that text.
   */
  async embedBatch(texts: string[]): Promise<Array<number[] | null>> {
    if (texts.length === 0) return [];

    // Check cache for each, track which need computation
    const results: Array<number[] | null> = new Array(texts.length).fill(null);
    const toCompute: Array<{ index: number; text: string }> = [];

    for (let i = 0; i < texts.length; i++) {
      const text = texts[i]!;
      if (!text || text.trim().length === 0) continue;

      const key = this.cacheKey(text);
      const cached = this.cache.get(key);
      if (cached) {
        results[i] = cached;
      } else {
        toCompute.push({ index: i, text });
      }
    }

    if (toCompute.length === 0) return results;

    // Try ANE first for uncached texts
    if (this.aneProvider) {
      try {
        const aneResults = await this.aneProvider.embedBatch(toCompute.map((t) => t.text));
        const remaining: Array<{ index: number; text: string }> = [];

        for (let i = 0; i < toCompute.length; i++) {
          const aneResult = aneResults[i];
          const item = toCompute[i]!;
          if (aneResult) {
            results[item.index] = aneResult.embedding;
            this.cache.set(this.cacheKey(item.text), aneResult.embedding);
          } else {
            remaining.push(item);
          }
        }

        // If ANE handled everything, return early
        if (remaining.length === 0) return results;

        // Fall back to Ollama for items ANE couldn't handle
        try {
          const embeddings = await this.callOllamaEmbed(remaining.map((t) => t.text));
          if (embeddings) {
            for (let i = 0; i < remaining.length && i < embeddings.length; i++) {
              const embedding = embeddings[i]!;
              const item = remaining[i]!;
              results[item.index] = embedding;
              this.cache.set(this.cacheKey(item.text), embedding);
            }
          }
        } catch {
          // Graceful degradation
        }

        return results;
      } catch {
        // ANE batch failed entirely, fall through to full Ollama fallback
      }
    }

    // Ollama fallback (no ANE or ANE failed)
    try {
      const embeddings = await this.callOllamaEmbed(toCompute.map((t) => t.text));
      if (embeddings) {
        for (let i = 0; i < toCompute.length && i < embeddings.length; i++) {
          const embedding = embeddings[i]!;
          const item = toCompute[i]!;
          results[item.index] = embedding;
          this.cache.set(this.cacheKey(item.text), embedding);
        }
      }
    } catch {
      // Graceful degradation: leave remaining entries as null
    }

    return results;
  }

  /**
   * Get the configured model name.
   */
  getModel(): string {
    return this.config.model;
  }

  /**
   * Get the expected embedding dimensions.
   */
  getDimensions(): number {
    return this.config.dimensions;
  }

  /**
   * Get cache statistics.
   */
  getCacheStats(): { size: number; maxSize: number } {
    return {
      size: this.cache.size,
      maxSize: this.config.cacheSize,
    };
  }

  /**
   * Clear the embedding cache.
   */
  clearCache(): void {
    this.cache.clear();
  }

  // ── Internal ─────────────────────────────────────────────────────────────

  /**
   * Call Ollama's /api/embed endpoint.
   */
  private async callOllamaEmbed(texts: string[]): Promise<number[][] | null> {
    const url = `${this.config.baseUrl}/api/embed`;

    const body: OllamaEmbedRequest = {
      model: this.config.model,
      input: texts,
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        return null;
      }

      const data = (await response.json()) as OllamaEmbedResponse;
      if (!data.embeddings || !Array.isArray(data.embeddings)) {
        return null;
      }

      return data.embeddings;
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Generate a cache key from content using SHA-256.
   */
  private cacheKey(text: string): string {
    return createHash('sha256').update(text).digest('hex').slice(0, 16);
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
