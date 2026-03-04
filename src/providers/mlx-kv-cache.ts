/**
 * MLX KV Cache Configuration — K8V4 Mixed-Precision Support
 *
 * Configures asymmetric KV cache quantization for MLX inference.
 * Keys use higher precision (8-bit) because they're more sensitive to
 * quantization; values use lower precision (4-bit) since they tolerate
 * aggressive quantization with minimal quality loss.
 *
 * The K8V4 split achieves ~59% KV cache memory reduction with <0.1
 * perplexity degradation (KIVI, Liu et al. 2024).
 *
 * Current status: mlx_lm.generate supports --kv-bits and --kv-group-size
 * but vllm-mlx (the OpenAI-compatible server) does not yet expose these
 * parameters (see mlx-lm Issue #615). This module pre-builds the full
 * configuration pipeline so that when server support lands, activation is
 * a single flag flip.
 *
 * See docs/roadmap.md Tier 4, Item 12.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** Bit widths supported by mlx.core.quantize. */
export type KvBits = 2 | 3 | 4 | 5 | 6 | 8;

/** Group sizes supported by mlx.core.quantize. */
export type KvGroupSize = 32 | 64 | 128;

/**
 * KV cache quantization preset.
 *
 * - `q8`   — Uniform 8-bit keys and values (~50% reduction, near-lossless)
 * - `q4`   — Uniform 4-bit keys and values (~75% reduction, some quality loss)
 * - `k8v4` — 8-bit keys, 4-bit values (~59% reduction, best quality/memory tradeoff)
 * - `none` — No quantization (FP16 baseline)
 */
export type KvCachePreset = 'none' | 'q8' | 'q4' | 'k8v4';

/**
 * Full KV cache quantization configuration.
 *
 * When `preset` is set, `keyBits`/`valueBits` are derived automatically.
 * Explicit `keyBits`/`valueBits` override the preset for advanced tuning.
 */
export interface MlxKvCacheConfig {
  /** Quantization preset (default: 'none'). */
  preset: KvCachePreset;

  /** Bits for key cache (overrides preset if set). */
  keyBits?: KvBits;

  /** Bits for value cache (overrides preset if set). */
  valueBits?: KvBits;

  /** Quantization group size (default: 64). */
  groupSize: KvGroupSize;

  /**
   * Generation step at which quantization begins (default: 0).
   * mlx-lm defaults to 5000, but for server use 0 is more appropriate
   * since each request is independent.
   */
  quantizedKvStart: number;

  /**
   * Whether the current vllm-mlx server version supports KV cache params.
   * When false, config is validated and logged but not passed to the server.
   * Flip to true when vllm-mlx gains --kv-bits support.
   */
  serverSupport: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const VALID_BITS = new Set<KvBits>([2, 3, 4, 5, 6, 8]);
const VALID_GROUP_SIZES = new Set<KvGroupSize>([32, 64, 128]);

/** Preset → { keyBits, valueBits } mapping. */
const PRESET_BITS: Record<KvCachePreset, { keyBits: KvBits; valueBits: KvBits } | null> = {
  none: null,
  q8: { keyBits: 8, valueBits: 8 },
  q4: { keyBits: 4, valueBits: 4 },
  k8v4: { keyBits: 8, valueBits: 4 },
};

/**
 * Bytes per element at each bit width, accounting for group quantization
 * overhead (scale + bias per group). For group_size=64:
 *   effective_bytes = bits/8 + 2*4/group_size  (two float32 per group)
 *
 * We simplify to bits/8 since the overhead is <1% for group_size >= 32.
 */
const FP16_BYTES_PER_ELEMENT = 2;

// ─────────────────────────────────────────────────────────────────────────────
// Defaults
// ─────────────────────────────────────────────────────────────────────────────

export function defaultKvCacheConfig(): MlxKvCacheConfig {
  return {
    preset: 'none',
    groupSize: 64,
    quantizedKvStart: 0,
    serverSupport: false,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Validation
// ─────────────────────────────────────────────────────────────────────────────

export interface KvCacheValidationError {
  field: string;
  message: string;
}

/**
 * Validate a KV cache configuration. Returns an empty array if valid.
 */
export function validateKvCacheConfig(config: MlxKvCacheConfig): KvCacheValidationError[] {
  const errors: KvCacheValidationError[] = [];

  if (!Object.hasOwn(PRESET_BITS, config.preset)) {
    errors.push({
      field: 'preset',
      message: `Invalid preset "${config.preset}". Must be one of: ${Object.keys(PRESET_BITS).join(', ')}`,
    });
  }

  if (config.keyBits !== undefined && !VALID_BITS.has(config.keyBits)) {
    errors.push({
      field: 'keyBits',
      message: `Invalid keyBits ${config.keyBits}. Must be one of: ${[...VALID_BITS].join(', ')}`,
    });
  }

  if (config.valueBits !== undefined && !VALID_BITS.has(config.valueBits)) {
    errors.push({
      field: 'valueBits',
      message: `Invalid valueBits ${config.valueBits}. Must be one of: ${[...VALID_BITS].join(', ')}`,
    });
  }

  if (!VALID_GROUP_SIZES.has(config.groupSize)) {
    errors.push({
      field: 'groupSize',
      message: `Invalid groupSize ${config.groupSize}. Must be one of: ${[...VALID_GROUP_SIZES].join(', ')}`,
    });
  }

  if (!Number.isInteger(config.quantizedKvStart) || config.quantizedKvStart < 0) {
    errors.push({
      field: 'quantizedKvStart',
      message: `quantizedKvStart must be a non-negative integer, got ${config.quantizedKvStart}`,
    });
  }

  return errors;
}

// ─────────────────────────────────────────────────────────────────────────────
// Resolution
// ─────────────────────────────────────────────────────────────────────────────

export interface ResolvedKvBits {
  keyBits: KvBits;
  valueBits: KvBits;
}

/**
 * Resolve the effective key/value bit widths from a config.
 * Returns null for the 'none' preset (no quantization).
 * Explicit keyBits/valueBits override the preset.
 */
export function resolveKvBits(config: MlxKvCacheConfig): ResolvedKvBits | null {
  const presetBits = PRESET_BITS[config.preset];

  if (!presetBits && config.keyBits === undefined && config.valueBits === undefined) {
    return null;
  }

  return {
    keyBits: config.keyBits ?? presetBits?.keyBits ?? 8,
    valueBits: config.valueBits ?? presetBits?.valueBits ?? 8,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Memory Estimation
// ─────────────────────────────────────────────────────────────────────────────

export interface KvCacheMemoryEstimate {
  /** Memory for key cache in bytes. */
  keyBytes: number;
  /** Memory for value cache in bytes. */
  valueBytes: number;
  /** Total KV cache memory in bytes. */
  totalBytes: number;
  /** Total in human-readable format (e.g., "4.2 GiB"). */
  totalFormatted: string;
  /** Reduction vs FP16 baseline as a fraction (0.0 - 1.0). */
  reductionFraction: number;
  /** Reduction vs FP16 baseline as percentage string (e.g., "59%"). */
  reductionFormatted: string;
}

export interface KvCacheModelParams {
  /** Number of layers in the model. */
  numLayers: number;
  /** Number of key-value heads (after GQA). */
  numKvHeads: number;
  /** Dimension per head. */
  headDim: number;
  /** Context length (number of tokens). */
  contextLength: number;
}

/**
 * Well-known model architectures for memory estimation.
 */
export const MODEL_PARAMS: Record<string, KvCacheModelParams> = {
  'qwen3.5-122b': {
    numLayers: 64,
    numKvHeads: 8,     // GQA: 8 KV heads for 64 attention heads
    headDim: 192,
    contextLength: 131072,
  },
  'qwen3.5-32b': {
    numLayers: 64,
    numKvHeads: 8,
    headDim: 128,
    contextLength: 131072,
  },
};

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) {
    return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
  }
  if (bytes >= 1024 ** 2) {
    return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  }
  return `${(bytes / 1024).toFixed(1)} KiB`;
}

/**
 * Estimate KV cache memory for a given model and quantization config.
 *
 * Formula per cache (K or V):
 *   bytes = numLayers * numKvHeads * headDim * contextLength * (bits / 8)
 *
 * FP16 baseline uses 2 bytes per element.
 */
export function estimateKvCacheMemory(
  modelParams: KvCacheModelParams,
  config: MlxKvCacheConfig,
): KvCacheMemoryEstimate {
  const { numLayers, numKvHeads, headDim, contextLength } = modelParams;
  const elementsPerCache = numLayers * numKvHeads * headDim * contextLength;

  const resolved = resolveKvBits(config);
  const keyBytesPerElement = resolved ? resolved.keyBits / 8 : FP16_BYTES_PER_ELEMENT;
  const valueBytesPerElement = resolved ? resolved.valueBits / 8 : FP16_BYTES_PER_ELEMENT;

  const keyBytes = elementsPerCache * keyBytesPerElement;
  const valueBytes = elementsPerCache * valueBytesPerElement;
  const totalBytes = keyBytes + valueBytes;

  const fp16Total = elementsPerCache * FP16_BYTES_PER_ELEMENT * 2;
  const reductionFraction = fp16Total > 0 ? 1 - totalBytes / fp16Total : 0;

  return {
    keyBytes,
    valueBytes,
    totalBytes,
    totalFormatted: formatBytes(totalBytes),
    reductionFraction,
    reductionFormatted: `${Math.round(reductionFraction * 100)}%`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Environment Variable Bridge
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build environment variables for the MLX server start script.
 * These are passed through to vllm-mlx or mlx_lm.
 */
export function buildKvCacheEnvVars(config: MlxKvCacheConfig): Record<string, string> {
  const resolved = resolveKvBits(config);
  if (!resolved) {
    return {};
  }

  const vars: Record<string, string> = {
    MLX_KV_KEY_BITS: String(resolved.keyBits),
    MLX_KV_VALUE_BITS: String(resolved.valueBits),
    MLX_KV_GROUP_SIZE: String(config.groupSize),
  };

  if (config.quantizedKvStart > 0) {
    vars['MLX_KV_QUANTIZED_START'] = String(config.quantizedKvStart);
  }

  return vars;
}

/**
 * Parse KV cache config from environment variables.
 * Used by mlx-server.sh (via ensureMlxServerReady) and tests.
 */
export function parseKvCacheFromEnv(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): MlxKvCacheConfig {
  const config = defaultKvCacheConfig();

  const preset = env['MLX_KV_CACHE_PRESET'];
  if (preset && Object.hasOwn(PRESET_BITS, preset)) {
    config.preset = preset as KvCachePreset;
  }

  const keyBits = parseInt(env['MLX_KV_KEY_BITS'] ?? '', 10);
  if (VALID_BITS.has(keyBits as KvBits)) {
    config.keyBits = keyBits as KvBits;
  }

  const valueBits = parseInt(env['MLX_KV_VALUE_BITS'] ?? '', 10);
  if (VALID_BITS.has(valueBits as KvBits)) {
    config.valueBits = valueBits as KvBits;
  }

  const groupSize = parseInt(env['MLX_KV_GROUP_SIZE'] ?? '', 10);
  if (VALID_GROUP_SIZES.has(groupSize as KvGroupSize)) {
    config.groupSize = groupSize as KvGroupSize;
  }

  const quantizedStart = parseInt(env['MLX_KV_QUANTIZED_START'] ?? '', 10);
  if (Number.isInteger(quantizedStart) && quantizedStart >= 0) {
    config.quantizedKvStart = quantizedStart;
  }

  const serverSupport = env['MLX_KV_SERVER_SUPPORT'];
  if (serverSupport === '1' || serverSupport === 'true') {
    config.serverSupport = true;
  }

  return config;
}

// ─────────────────────────────────────────────────────────────────────────────
// Summary (for logging / status display)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Produce a human-readable summary of the KV cache configuration.
 */
export function summarizeKvCacheConfig(
  config: MlxKvCacheConfig,
  modelParams?: KvCacheModelParams,
): string {
  const resolved = resolveKvBits(config);
  if (!resolved) {
    return 'KV cache: FP16 (no quantization)';
  }

  const lines: string[] = [];

  if (resolved.keyBits === resolved.valueBits) {
    lines.push(`KV cache: Q${resolved.keyBits} uniform (keys=${resolved.keyBits}b, values=${resolved.valueBits}b)`);
  } else {
    lines.push(`KV cache: K${resolved.keyBits}V${resolved.valueBits} split (keys=${resolved.keyBits}b, values=${resolved.valueBits}b)`);
  }

  lines.push(`  group_size=${config.groupSize}, quantized_start=${config.quantizedKvStart}`);

  if (!config.serverSupport) {
    lines.push('  (awaiting vllm-mlx server support — config validated but not active)');
  }

  if (modelParams) {
    const estimate = estimateKvCacheMemory(modelParams, config);
    lines.push(`  estimated: ${estimate.totalFormatted} (${estimate.reductionFormatted} reduction vs FP16)`);
  }

  return lines.join('\n');
}
