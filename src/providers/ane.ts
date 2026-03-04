/**
 * ANE Provider — Apple Neural Engine offloading for embeddings and classification.
 *
 * Offloads lightweight inference tasks (text embeddings, classification) to Apple's
 * Neural Engine (ANE/NPU), which delivers 19 TFLOPS at only 2.8W. This frees the
 * GPU entirely for the main inference models (122B + 35B-A3B).
 *
 * Architecture:
 *   - CoreML inference via a lightweight Swift/Python bridge process.
 *   - Models are pre-converted to CoreML format with ANE compute target.
 *   - Falls back to the standard Ollama EmbeddingProvider if ANE is unavailable.
 *   - Classification uses a small ANE-optimized model for zero-cost task routing.
 *
 * Privacy: All computation stays on-device. No data leaves the machine.
 *
 * See docs/roadmap.md Tier 4, Item 11.
 */

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Configuration for the ANE provider.
 */
export interface AneProviderConfig {
  /** Directory containing CoreML models (default: ~/.casterly/ane-models) */
  modelDir: string;

  /** Embedding model name (CoreML package, e.g., 'nomic-embed-text-ane') */
  embeddingModel: string;

  /** Classification model name (CoreML package, e.g., 'task-classifier-ane') */
  classificationModel: string;

  /** Expected embedding dimensions (must match the CoreML model, default: 768) */
  embeddingDimensions: number;

  /** Maximum entries in the LRU cache (default: 1024) */
  cacheSize: number;

  /** Request timeout in milliseconds (default: 5000 — ANE is fast) */
  timeoutMs: number;

  /** Whether to enable the ANE provider (default: auto-detect) */
  enabled: boolean;

  /** Port for the CoreML bridge server (default: 8100) */
  bridgePort: number;

  /** Host for the CoreML bridge server (default: 127.0.0.1) */
  bridgeHost: string;
}

/**
 * Classification result from the ANE classifier.
 */
export interface ClassificationResult {
  /** The predicted category */
  category: string;

  /** Confidence score (0.0 - 1.0) */
  confidence: number;

  /** All category scores (sorted by confidence descending) */
  scores: Array<{ category: string; confidence: number }>;

  /** Whether this came from the ANE or fallback */
  source: 'ane' | 'fallback';
}

/**
 * Embedding result from the ANE embedding model.
 */
export interface AneEmbeddingResult {
  /** The embedding vector */
  embedding: number[];

  /** Which backend produced this */
  source: 'ane' | 'fallback';

  /** Inference latency in milliseconds */
  latencyMs: number;
}

/**
 * Health status of the ANE provider.
 */
export interface AneHealthStatus {
  /** Whether the ANE bridge server is reachable */
  bridgeAvailable: boolean;

  /** Whether the embedding model is loaded */
  embeddingModelLoaded: boolean;

  /** Whether the classification model is loaded */
  classificationModelLoaded: boolean;

  /** ANE compute unit availability */
  aneAvailable: boolean;

  /** Total embeddings computed via ANE */
  totalAneEmbeddings: number;

  /** Total classifications computed via ANE */
  totalAneClassifications: number;

  /** Total fallbacks to CPU/GPU */
  totalFallbacks: number;
}

/**
 * CoreML bridge server response for embeddings.
 */
interface BridgeEmbedResponse {
  embeddings: number[][];
  latency_ms: number;
  compute_unit: 'ane' | 'gpu' | 'cpu';
}

/**
 * CoreML bridge server response for classification.
 */
interface BridgeClassifyResponse {
  predictions: Array<{
    category: string;
    confidence: number;
  }>;
  latency_ms: number;
  compute_unit: 'ane' | 'gpu' | 'cpu';
}

/**
 * CoreML bridge health response.
 */
interface BridgeHealthResponse {
  status: 'ok' | 'error';
  ane_available: boolean;
  models_loaded: string[];
}

/**
 * Task categories for classification.
 */
export type TaskCategory =
  | 'coding'
  | 'conversation'
  | 'analysis'
  | 'planning'
  | 'review'
  | 'unknown';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: AneProviderConfig = {
  modelDir: join(homedir(), '.casterly', 'ane-models'),
  embeddingModel: 'nomic-embed-text-ane',
  classificationModel: 'task-classifier-ane',
  embeddingDimensions: 768,
  cacheSize: 1024,
  timeoutMs: 5000,
  enabled: true,
  bridgePort: 8100,
  bridgeHost: '127.0.0.1',
};

/**
 * Keyword-based classification fallback patterns.
 * Used when the ANE classifier is unavailable.
 */
const CLASSIFICATION_PATTERNS: Array<{ category: TaskCategory; patterns: RegExp[] }> = [
  {
    category: 'coding',
    patterns: [
      /\b(?:fix|implement|refactor|debug|code|function|class|method|bug|error|test|compile)\b/i,
      /\b(?:typescript|javascript|python|rust|go|java|css|html)\b/i,
      /\b(?:npm|git|docker|build|deploy|ci)\b/i,
    ],
  },
  {
    category: 'review',
    patterns: [
      /\b(?:review|check|audit|inspect|validate|verify|assess)\b/i,
      /\b(?:pull\s*request|PR|diff|merge)\b/i,
    ],
  },
  {
    category: 'planning',
    patterns: [
      /\b(?:plan|design|architect|strategy|roadmap|milestone|approach)\b/i,
      /\b(?:how\s+should|what\s+approach|propose)\b/i,
    ],
  },
  {
    category: 'analysis',
    patterns: [
      /\b(?:analyze|explain|why|how\s+does|understand|investigate|profile|benchmark)\b/i,
      /\b(?:performance|memory|bottleneck|trace|log)\b/i,
    ],
  },
  {
    category: 'conversation',
    patterns: [
      /\b(?:hello|hi|hey|thanks|thank\s+you|what\s+is|who|when|where)\b/i,
      /\b(?:tell\s+me|describe|summarize|status|update)\b/i,
    ],
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// LRU Cache (shared with embedding.ts pattern)
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
      this.cache.delete(key);
      this.cache.set(key, value);
    }
    return value;
  }

  set(key: string, value: V): void {
    this.cache.delete(key);
    this.cache.set(key, value);

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
// ANE Provider
// ─────────────────────────────────────────────────────────────────────────────

export class AneProvider {
  private readonly config: AneProviderConfig;
  private readonly embeddingCache: LRUCache<number[]>;
  private readonly classificationCache: LRUCache<ClassificationResult>;
  private bridgeAvailable: boolean | null = null;
  private stats = {
    totalAneEmbeddings: 0,
    totalAneClassifications: 0,
    totalFallbacks: 0,
  };

  constructor(config?: Partial<AneProviderConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.embeddingCache = new LRUCache(this.config.cacheSize);
    this.classificationCache = new LRUCache(Math.floor(this.config.cacheSize / 4));
  }

  // ── Embedding ─────────────────────────────────────────────────────────────

  /**
   * Compute an embedding vector for a single text string.
   * Routes to ANE when available, falls back to null (caller uses Ollama).
   */
  async embed(text: string): Promise<AneEmbeddingResult | null> {
    if (!text || text.trim().length === 0) return null;
    if (!this.config.enabled) return null;

    // Check cache
    const key = this.cacheKey(text);
    const cached = this.embeddingCache.get(key);
    if (cached) {
      return {
        embedding: cached,
        source: 'ane',
        latencyMs: 0,
      };
    }

    // Try ANE bridge
    if (await this.isBridgeAvailable()) {
      try {
        const result = await this.callBridgeEmbed([text]);
        if (result && result.embeddings.length > 0) {
          const embedding = result.embeddings[0]!;
          this.embeddingCache.set(key, embedding);
          this.stats.totalAneEmbeddings++;
          return {
            embedding,
            source: 'ane',
            latencyMs: result.latency_ms,
          };
        }
      } catch {
        // Fall through to return null
      }
    }

    this.stats.totalFallbacks++;
    return null;
  }

  /**
   * Compute embeddings for multiple texts in a single batch call.
   */
  async embedBatch(texts: string[]): Promise<Array<AneEmbeddingResult | null>> {
    if (texts.length === 0) return [];
    if (!this.config.enabled) return texts.map(() => null);

    const results: Array<AneEmbeddingResult | null> = new Array(texts.length).fill(null);
    const toCompute: Array<{ index: number; text: string }> = [];

    // Check cache for each
    for (let i = 0; i < texts.length; i++) {
      const text = texts[i]!;
      if (!text || text.trim().length === 0) continue;

      const key = this.cacheKey(text);
      const cached = this.embeddingCache.get(key);
      if (cached) {
        results[i] = { embedding: cached, source: 'ane', latencyMs: 0 };
      } else {
        toCompute.push({ index: i, text });
      }
    }

    if (toCompute.length === 0) return results;

    // Try ANE bridge for uncached texts
    if (await this.isBridgeAvailable()) {
      try {
        const bridgeResult = await this.callBridgeEmbed(toCompute.map((t) => t.text));
        if (bridgeResult) {
          for (let i = 0; i < toCompute.length && i < bridgeResult.embeddings.length; i++) {
            const embedding = bridgeResult.embeddings[i]!;
            const item = toCompute[i]!;
            results[item.index] = {
              embedding,
              source: 'ane',
              latencyMs: bridgeResult.latency_ms,
            };
            this.embeddingCache.set(this.cacheKey(item.text), embedding);
            this.stats.totalAneEmbeddings++;
          }
          return results;
        }
      } catch {
        // Fall through to null results
      }
    }

    this.stats.totalFallbacks++;
    return results;
  }

  // ── Classification ────────────────────────────────────────────────────────

  /**
   * Classify a text message into a task category.
   * Routes to ANE classifier when available, falls back to keyword matching.
   */
  async classify(text: string): Promise<ClassificationResult> {
    if (!text || text.trim().length === 0) {
      return {
        category: 'unknown',
        confidence: 0,
        scores: [{ category: 'unknown', confidence: 0 }],
        source: 'fallback',
      };
    }

    // Check cache
    const key = this.cacheKey(text);
    const cached = this.classificationCache.get(key);
    if (cached) return cached;

    // Try ANE bridge
    if (this.config.enabled && await this.isBridgeAvailable()) {
      try {
        const bridgeResult = await this.callBridgeClassify(text);
        if (bridgeResult && bridgeResult.predictions.length > 0) {
          const result: ClassificationResult = {
            category: bridgeResult.predictions[0]!.category as TaskCategory,
            confidence: bridgeResult.predictions[0]!.confidence,
            scores: bridgeResult.predictions.map((p) => ({
              category: p.category,
              confidence: p.confidence,
            })),
            source: 'ane',
          };
          this.classificationCache.set(key, result);
          this.stats.totalAneClassifications++;
          return result;
        }
      } catch {
        // Fall through to keyword classification
      }
    }

    // Keyword-based fallback classification
    const result = this.classifyByKeywords(text);
    this.classificationCache.set(key, result);
    this.stats.totalFallbacks++;
    return result;
  }

  // ── Health & Stats ────────────────────────────────────────────────────────

  /**
   * Get the health status of the ANE provider.
   */
  async getHealth(): Promise<AneHealthStatus> {
    let bridgeAvailable = false;
    let embeddingModelLoaded = false;
    let classificationModelLoaded = false;
    let aneAvailable = false;

    try {
      const health = await this.callBridgeHealth();
      if (health) {
        bridgeAvailable = health.status === 'ok';
        aneAvailable = health.ane_available;
        embeddingModelLoaded = health.models_loaded.includes(this.config.embeddingModel);
        classificationModelLoaded = health.models_loaded.includes(this.config.classificationModel);
      }
    } catch {
      // Bridge not available
    }

    return {
      bridgeAvailable,
      embeddingModelLoaded,
      classificationModelLoaded,
      aneAvailable,
      totalAneEmbeddings: this.stats.totalAneEmbeddings,
      totalAneClassifications: this.stats.totalAneClassifications,
      totalFallbacks: this.stats.totalFallbacks,
    };
  }

  /**
   * Check if the ANE provider is available for use.
   */
  async isAvailable(): Promise<boolean> {
    if (!this.config.enabled) return false;
    return this.isBridgeAvailable();
  }

  /**
   * Get cache statistics.
   */
  getCacheStats(): {
    embeddingCache: { size: number; maxSize: number };
    classificationCache: { size: number; maxSize: number };
  } {
    return {
      embeddingCache: {
        size: this.embeddingCache.size,
        maxSize: this.config.cacheSize,
      },
      classificationCache: {
        size: this.classificationCache.size,
        maxSize: Math.floor(this.config.cacheSize / 4),
      },
    };
  }

  /**
   * Clear all caches.
   */
  clearCaches(): void {
    this.embeddingCache.clear();
    this.classificationCache.clear();
  }

  /**
   * Get the provider configuration (read-only).
   */
  getConfig(): Readonly<AneProviderConfig> {
    return this.config;
  }

  /**
   * Get the expected embedding dimensions.
   */
  getDimensions(): number {
    return this.config.embeddingDimensions;
  }

  // ── Internal: Bridge Communication ─────────────────────────────────────

  /**
   * Check if the CoreML bridge server is reachable.
   * Caches the result for 30 seconds to avoid excessive health checks.
   */
  private bridgeCheckTimestamp = 0;
  private readonly bridgeCacheDurationMs = 30_000;

  private async isBridgeAvailable(): Promise<boolean> {
    const now = Date.now();
    if (
      this.bridgeAvailable !== null &&
      now - this.bridgeCheckTimestamp < this.bridgeCacheDurationMs
    ) {
      return this.bridgeAvailable;
    }

    try {
      const health = await this.callBridgeHealth();
      this.bridgeAvailable = health !== null && health.status === 'ok';
    } catch {
      this.bridgeAvailable = false;
    }

    this.bridgeCheckTimestamp = now;
    return this.bridgeAvailable;
  }

  /**
   * Call the CoreML bridge's /embed endpoint.
   */
  private async callBridgeEmbed(texts: string[]): Promise<BridgeEmbedResponse | null> {
    const url = `http://${this.config.bridgeHost}:${this.config.bridgePort}/embed`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.config.embeddingModel,
          texts,
        }),
        signal: controller.signal,
      });

      if (!response.ok) return null;

      return (await response.json()) as BridgeEmbedResponse;
    } catch {
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Call the CoreML bridge's /classify endpoint.
   */
  private async callBridgeClassify(text: string): Promise<BridgeClassifyResponse | null> {
    const url = `http://${this.config.bridgeHost}:${this.config.bridgePort}/classify`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.config.classificationModel,
          text,
        }),
        signal: controller.signal,
      });

      if (!response.ok) return null;

      return (await response.json()) as BridgeClassifyResponse;
    } catch {
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Call the CoreML bridge's /health endpoint.
   */
  private async callBridgeHealth(): Promise<BridgeHealthResponse | null> {
    const url = `http://${this.config.bridgeHost}:${this.config.bridgePort}/health`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000); // Short timeout for health

    try {
      const response = await fetch(url, {
        method: 'GET',
        signal: controller.signal,
      });

      if (!response.ok) return null;

      return (await response.json()) as BridgeHealthResponse;
    } catch {
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }

  // ── Internal: Fallback Classification ─────────────────────────────────

  /**
   * Classify text using keyword pattern matching.
   * Used as fallback when the ANE classifier is unavailable.
   */
  classifyByKeywords(text: string): ClassificationResult {
    const scores: Array<{ category: TaskCategory; confidence: number }> = [];

    for (const { category, patterns } of CLASSIFICATION_PATTERNS) {
      let matchCount = 0;
      for (const pattern of patterns) {
        if (pattern.test(text)) {
          matchCount++;
        }
      }

      if (matchCount > 0) {
        // Normalize confidence: more matches = higher confidence
        const confidence = Math.min(matchCount / patterns.length, 1.0);
        scores.push({ category, confidence });
      }
    }

    // Sort by confidence descending
    scores.sort((a, b) => b.confidence - a.confidence);

    if (scores.length === 0) {
      return {
        category: 'unknown',
        confidence: 0,
        scores: [{ category: 'unknown', confidence: 0 }],
        source: 'fallback',
      };
    }

    return {
      category: scores[0]!.category,
      confidence: scores[0]!.confidence,
      scores,
      source: 'fallback',
    };
  }

  // ── Internal: Utilities ────────────────────────────────────────────────

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

/**
 * Create an ANE provider with the given configuration.
 */
export function createAneProvider(
  config?: Partial<AneProviderConfig>,
): AneProvider {
  return new AneProvider(config);
}

/**
 * Check if the current platform supports the Apple Neural Engine.
 * Returns true on macOS with Apple Silicon, false otherwise.
 */
export function isAneSupported(): boolean {
  if (process.platform !== 'darwin') return false;

  // Apple Silicon uses arm64 architecture
  return process.arch === 'arm64';
}
