/**
 * KVSplit K8V4 — Mixed-precision KV cache quantization for MLX inference.
 *
 * Uses asymmetric quantization where keys are stored at 8-bit and values at
 * 4-bit precision. Research shows keys are more sensitive to quantization
 * than values (KIVI, Liu et al. 2024; KVQuant, Hooper et al. 2024).
 *
 * Implementation reality:
 *   - mlx_lm's QuantizedKVCache supports UNIFORM quantization only (same bits
 *     for both K and V). The `kv_bits` param in `generate_step` controls this.
 *   - Asymmetric K8V4 requires a custom cache class (K8V4KVCache) that calls
 *     mx.quantize with different bits for keys vs values. This is implemented
 *     in scripts/benchmark-kvcache.py and can be injected at the Python level.
 *   - vllm-mlx does NOT have --kv-cache-key-bits or --kv-cache-value-bits
 *     flags. KV cache quantization is configured via mlx_lm's generate_step.
 *
 * Architecture (Qwen3.5-122B-A10B):
 *   - 48 layers total: 12 full attention + 36 linear attention
 *   - Only the 12 full attention layers use standard KV cache
 *   - 2 KV heads per full attention layer, head_dim = 256
 *   - KV cache per token (FP16): 2 * 12 * 2 * 256 * 2 bytes = 24,576 bytes
 *
 * Privacy: All computation stays on-device. No data leaves the machine.
 *
 * See docs/roadmap.md Tier 4, Item 12.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * KV cache quantization strategy.
 */
export type KvQuantStrategy =
  | 'fp16'    // Full precision baseline
  | 'q8_0'    // Uniform 8-bit (keys=8, values=8)
  | 'q4'      // Uniform 4-bit (keys=4, values=4)
  | 'k8v4';   // Asymmetric: keys=8-bit, values=4-bit (custom cache class)

/**
 * Configuration for KVSplit.
 */
export interface KvSplitConfig {
  /** Quantization strategy (default: k8v4) */
  strategy: KvQuantStrategy;

  /** Key precision in bits (default: 8) */
  keyBits: number;

  /** Value precision in bits (default: 4) */
  valueBits: number;

  /** Maximum acceptable perplexity increase over FP16 baseline (default: 0.1) */
  maxPerplexityDegradation: number;

  /** Minimum context length at which KV quantization provides meaningful savings (default: 8192) */
  minContextForKvSplit: number;

  /** Enable quality monitoring (default: true) */
  qualityMonitoringEnabled: boolean;

  /** Number of quality samples to keep for rolling average (default: 50) */
  qualitySampleWindow: number;

  /** Auto-disable if quality degrades beyond threshold (default: true) */
  autoDisableOnDegradation: boolean;
}

/**
 * Memory estimate for the KV cache at different quantization levels.
 */
export interface KvMemoryEstimate {
  /** Strategy used */
  strategy: KvQuantStrategy;

  /** Estimated memory in bytes */
  memoryBytes: number;

  /** Estimated memory in GB */
  memoryGb: number;

  /** Savings compared to FP16 (as fraction, e.g. 0.59 = 59%) */
  savingsVsFp16: number;

  /** Savings compared to Q8 (as fraction) */
  savingsVsQ8: number;
}

/**
 * Quality monitoring sample.
 */
export interface QualitySample {
  timestamp: string;
  contextLength: number;
  perplexity: number;
  degraded: boolean;
}

/**
 * Quality monitoring summary.
 */
export interface QualityMonitorSummary {
  totalSamples: number;
  avgPerplexity: number;
  degradedSamples: number;
  degradationRate: number;
  healthy: boolean;
  autoDisabled: boolean;
}

/**
 * MLX KV cache configuration args.
 *
 * For uniform quantization (q8_0, q4): pass kvBits to mlx_lm's generate_step.
 * For asymmetric (k8v4): use the custom K8V4KVCache class instead.
 */
export interface MlxKvCacheArgs {
  /** Uniform KV cache quantization bits (maps to kv_bits in generate_step).
   *  Undefined means FP16 (no quantization). */
  kvBits?: number;

  /** Group size for quantization (default: 64) */
  kvGroupSize?: number;

  /** If true, use the custom asymmetric K8V4 cache class instead of
   *  mlx_lm's built-in uniform QuantizedKVCache. */
  useAsymmetricCache?: boolean;

  /** Key bits (only meaningful when useAsymmetricCache is true) */
  keyBits?: number;

  /** Value bits (only meaningful when useAsymmetricCache is true) */
  valueBits?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: KvSplitConfig = {
  strategy: 'k8v4',
  keyBits: 8,
  valueBits: 4,
  maxPerplexityDegradation: 0.1,
  minContextForKvSplit: 8192,
  qualityMonitoringEnabled: true,
  qualitySampleWindow: 50,
  autoDisableOnDegradation: true,
};

/**
 * KV cache bytes per token across all full-attention layers.
 *
 * Architecture: 12 full attention layers × 2 KV heads × 256 head_dim.
 * Per-token per-layer: 2 (K+V) × 2 heads × 256 dim = 1,024 elements.
 * Total elements per token: 1,024 × 12 layers = 12,288 elements.
 */
const ELEMENTS_PER_TOKEN = 2 * 12 * 2 * 256; // 12,288

const BYTES_PER_TOKEN: Record<KvQuantStrategy, number> = {
  fp16: ELEMENTS_PER_TOKEN * 2,       // 24,576 bytes (2 bytes/element)
  q8_0: ELEMENTS_PER_TOKEN * 1,       // 12,288 bytes (1 byte/element)
  q4:   ELEMENTS_PER_TOKEN * 0.5,     //  6,144 bytes (0.5 bytes/element)
  k8v4: ELEMENTS_PER_TOKEN * 0.75,    //  9,216 bytes (avg of 1 + 0.5)
};

/** Number of full attention layers (with standard KV cache) in Qwen3.5-122B */
const NUM_KV_LAYERS = 12;

/** Degradation rate threshold for auto-disabling */
const DEGRADATION_RATE_THRESHOLD = 0.20;

// ─────────────────────────────────────────────────────────────────────────────
// KVSplit Manager
// ─────────────────────────────────────────────────────────────────────────────

export class KvSplitManager {
  private readonly config: KvSplitConfig;
  private readonly qualitySamples: QualitySample[] = [];
  private autoDisabled = false;

  constructor(config?: Partial<KvSplitConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // ── Memory Estimation ─────────────────────────────────────────────────────

  /**
   * Estimate KV cache memory for a given context length and strategy.
   * Only counts full-attention layers (12 of 48 total).
   */
  estimateMemory(
    contextLength: number,
    strategy?: KvQuantStrategy,
  ): KvMemoryEstimate {
    const s = strategy ?? this.config.strategy;

    const memoryBytes = contextLength * BYTES_PER_TOKEN[s];
    const memoryGb = memoryBytes / (1024 * 1024 * 1024);

    const fp16Bytes = contextLength * BYTES_PER_TOKEN.fp16;
    const q8Bytes = contextLength * BYTES_PER_TOKEN.q8_0;

    const savingsVsFp16 = fp16Bytes > 0 ? 1 - memoryBytes / fp16Bytes : 0;
    const savingsVsQ8 = q8Bytes > 0 ? 1 - memoryBytes / q8Bytes : 0;

    return {
      strategy: s,
      memoryBytes,
      memoryGb: Math.round(memoryGb * 100) / 100,
      savingsVsFp16: Math.round(savingsVsFp16 * 100) / 100,
      savingsVsQ8: Math.round(savingsVsQ8 * 100) / 100,
    };
  }

  /**
   * Compare memory estimates across all strategies.
   */
  compareStrategies(contextLength: number): KvMemoryEstimate[] {
    const strategies: KvQuantStrategy[] = ['fp16', 'q8_0', 'k8v4'];
    return strategies.map((s) => this.estimateMemory(contextLength, s));
  }

  // ── MLX Configuration ──────────────────────────────────────────────────────

  /**
   * Get MLX KV cache args for the active strategy.
   *
   * For uniform strategies (q8_0, q4): returns kvBits for generate_step.
   * For k8v4: returns useAsymmetricCache=true with key/value bits.
   * For fp16 or auto-disabled: returns empty (no quantization).
   */
  getMlxArgs(): MlxKvCacheArgs {
    if (this.autoDisabled || this.config.strategy === 'fp16') {
      return {};
    }

    if (this.config.strategy === 'q8_0') {
      return { kvBits: 8, kvGroupSize: 64 };
    }

    if (this.config.strategy === 'q4') {
      return { kvBits: 4, kvGroupSize: 64 };
    }

    // k8v4 — requires custom cache class
    return {
      useAsymmetricCache: true,
      keyBits: this.config.keyBits,
      valueBits: this.config.valueBits,
      kvGroupSize: 64,
    };
  }

  /**
   * Build CLI arguments for mlx_lm's generate command.
   *
   * Note: vllm-mlx serve does NOT support KV cache flags.
   * These args are for direct mlx_lm usage (e.g., benchmarks).
   */
  buildCliArgs(): string[] {
    const args = this.getMlxArgs();
    const result: string[] = [];

    if (args.kvBits !== undefined) {
      result.push(`--kv-bits=${args.kvBits}`);
    }
    if (args.kvGroupSize !== undefined && args.kvBits !== undefined) {
      result.push(`--kv-group-size=${args.kvGroupSize}`);
    }

    return result;
  }

  /**
   * @deprecated Use buildCliArgs() instead. vllm-mlx serve does not support
   * --kv-cache-key-bits or --kv-cache-value-bits flags.
   */
  buildServerArgs(): string[] {
    return this.buildCliArgs();
  }

  /**
   * Check if KV quantization should be applied for a given context length.
   */
  shouldApplyKvSplit(contextLength: number): boolean {
    if (this.autoDisabled) return false;
    if (this.config.strategy === 'fp16') return false;
    if (this.config.strategy !== 'k8v4') return false;
    return contextLength >= this.config.minContextForKvSplit;
  }

  // ── Quality Monitoring ─────────────────────────────────────────────────────

  /**
   * Record a quality sample from inference output.
   */
  recordQualitySample(contextLength: number, perplexity: number): void {
    if (!this.config.qualityMonitoringEnabled) return;

    const degraded = perplexity > this.config.maxPerplexityDegradation;

    this.qualitySamples.push({
      timestamp: new Date().toISOString(),
      contextLength,
      perplexity,
      degraded,
    });

    while (this.qualitySamples.length > this.config.qualitySampleWindow) {
      this.qualitySamples.shift();
    }

    if (this.config.autoDisableOnDegradation && !this.autoDisabled) {
      const summary = this.getQualitySummary();
      if (
        summary.totalSamples >= 10 &&
        summary.degradationRate >= DEGRADATION_RATE_THRESHOLD
      ) {
        this.autoDisabled = true;
      }
    }
  }

  /**
   * Get quality monitoring summary.
   */
  getQualitySummary(): QualityMonitorSummary {
    if (this.qualitySamples.length === 0) {
      return {
        totalSamples: 0,
        avgPerplexity: 0,
        degradedSamples: 0,
        degradationRate: 0,
        healthy: true,
        autoDisabled: this.autoDisabled,
      };
    }

    const total = this.qualitySamples.length;
    const degraded = this.qualitySamples.filter((s) => s.degraded).length;
    const avgPerplexity =
      this.qualitySamples.reduce((sum, s) => sum + s.perplexity, 0) / total;
    const degradationRate = degraded / total;

    return {
      totalSamples: total,
      avgPerplexity: Math.round(avgPerplexity * 1000) / 1000,
      degradedSamples: degraded,
      degradationRate: Math.round(degradationRate * 100) / 100,
      healthy: degradationRate < DEGRADATION_RATE_THRESHOLD,
      autoDisabled: this.autoDisabled,
    };
  }

  /**
   * Reset quality monitoring.
   */
  resetQualityMonitor(): void {
    this.qualitySamples.length = 0;
    this.autoDisabled = false;
  }

  // ── Accessors ──────────────────────────────────────────────────────────────

  getStrategy(): KvQuantStrategy {
    if (this.autoDisabled) return 'q8_0';
    return this.config.strategy;
  }

  isAutoDisabled(): boolean {
    return this.autoDisabled;
  }

  getConfig(): Readonly<KvSplitConfig> {
    return this.config;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────────────────────

export function createKvSplitManager(
  config?: Partial<KvSplitConfig>,
): KvSplitManager {
  return new KvSplitManager(config);
}
