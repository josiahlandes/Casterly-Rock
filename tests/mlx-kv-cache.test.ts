import { describe, expect, it } from 'vitest';
import {
  defaultKvCacheConfig,
  validateKvCacheConfig,
  resolveKvBits,
  estimateKvCacheMemory,
  buildKvCacheEnvVars,
  parseKvCacheFromEnv,
  summarizeKvCacheConfig,
  MODEL_PARAMS,
} from '../src/providers/mlx-kv-cache.js';
import type {
  MlxKvCacheConfig,
  KvCacheModelParams,
} from '../src/providers/mlx-kv-cache.js';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Build a config with overrides on top of defaults. */
function makeConfig(overrides: Partial<MlxKvCacheConfig> = {}): MlxKvCacheConfig {
  return { ...defaultKvCacheConfig(), ...overrides };
}

/** Small model params for deterministic memory calculations. */
const SMALL_MODEL: KvCacheModelParams = {
  numLayers: 4,
  numKvHeads: 2,
  headDim: 64,
  contextLength: 1024,
};

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('defaultKvCacheConfig', () => {
  it('returns sensible defaults', () => {
    const config = defaultKvCacheConfig();
    expect(config.preset).toBe('none');
    expect(config.groupSize).toBe(64);
    expect(config.quantizedKvStart).toBe(0);
    expect(config.serverSupport).toBe(false);
    expect(config.keyBits).toBeUndefined();
    expect(config.valueBits).toBeUndefined();
  });
});

describe('validateKvCacheConfig', () => {
  it('passes for valid default config', () => {
    expect(validateKvCacheConfig(defaultKvCacheConfig())).toEqual([]);
  });

  it('passes for valid k8v4 config', () => {
    const errors = validateKvCacheConfig(
      makeConfig({ preset: 'k8v4', keyBits: 8, valueBits: 4, groupSize: 64 }),
    );
    expect(errors).toEqual([]);
  });

  it('passes for all valid presets', () => {
    for (const preset of ['none', 'q8', 'q4', 'k8v4'] as const) {
      expect(validateKvCacheConfig(makeConfig({ preset }))).toEqual([]);
    }
  });

  it('passes for all valid bit widths', () => {
    for (const bits of [2, 3, 4, 5, 6, 8] as const) {
      expect(validateKvCacheConfig(makeConfig({ keyBits: bits }))).toEqual([]);
      expect(validateKvCacheConfig(makeConfig({ valueBits: bits }))).toEqual([]);
    }
  });

  it('passes for all valid group sizes', () => {
    for (const groupSize of [32, 64, 128] as const) {
      expect(validateKvCacheConfig(makeConfig({ groupSize }))).toEqual([]);
    }
  });

  it('rejects invalid preset', () => {
    const errors = validateKvCacheConfig(makeConfig({ preset: 'q16' as never }));
    expect(errors).toHaveLength(1);
    expect(errors[0]!.field).toBe('preset');
  });

  it('rejects invalid keyBits', () => {
    const errors = validateKvCacheConfig(makeConfig({ keyBits: 7 as never }));
    expect(errors).toHaveLength(1);
    expect(errors[0]!.field).toBe('keyBits');
  });

  it('rejects invalid valueBits', () => {
    const errors = validateKvCacheConfig(makeConfig({ valueBits: 1 as never }));
    expect(errors).toHaveLength(1);
    expect(errors[0]!.field).toBe('valueBits');
  });

  it('rejects invalid groupSize', () => {
    const errors = validateKvCacheConfig(makeConfig({ groupSize: 48 as never }));
    expect(errors).toHaveLength(1);
    expect(errors[0]!.field).toBe('groupSize');
  });

  it('rejects negative quantizedKvStart', () => {
    const errors = validateKvCacheConfig(makeConfig({ quantizedKvStart: -1 }));
    expect(errors).toHaveLength(1);
    expect(errors[0]!.field).toBe('quantizedKvStart');
  });

  it('collects multiple errors', () => {
    const errors = validateKvCacheConfig(
      makeConfig({
        preset: 'bad' as never,
        keyBits: 99 as never,
        groupSize: 256 as never,
      }),
    );
    expect(errors.length).toBeGreaterThanOrEqual(3);
  });
});

describe('resolveKvBits', () => {
  it('returns null for "none" preset with no explicit bits', () => {
    expect(resolveKvBits(makeConfig({ preset: 'none' }))).toBeNull();
  });

  it('resolves q8 preset', () => {
    expect(resolveKvBits(makeConfig({ preset: 'q8' }))).toEqual({
      keyBits: 8,
      valueBits: 8,
    });
  });

  it('resolves q4 preset', () => {
    expect(resolveKvBits(makeConfig({ preset: 'q4' }))).toEqual({
      keyBits: 4,
      valueBits: 4,
    });
  });

  it('resolves k8v4 preset', () => {
    expect(resolveKvBits(makeConfig({ preset: 'k8v4' }))).toEqual({
      keyBits: 8,
      valueBits: 4,
    });
  });

  it('explicit bits override preset', () => {
    expect(
      resolveKvBits(makeConfig({ preset: 'q8', keyBits: 6, valueBits: 3 })),
    ).toEqual({ keyBits: 6, valueBits: 3 });
  });

  it('partial explicit override: keyBits only', () => {
    const result = resolveKvBits(makeConfig({ preset: 'k8v4', keyBits: 6 }));
    expect(result).toEqual({ keyBits: 6, valueBits: 4 });
  });

  it('partial explicit override: valueBits only', () => {
    const result = resolveKvBits(makeConfig({ preset: 'k8v4', valueBits: 2 }));
    expect(result).toEqual({ keyBits: 8, valueBits: 2 });
  });

  it('explicit bits with "none" preset activates quantization', () => {
    const result = resolveKvBits(makeConfig({ preset: 'none', keyBits: 4 }));
    expect(result).not.toBeNull();
    expect(result!.keyBits).toBe(4);
  });
});

describe('estimateKvCacheMemory', () => {
  it('computes FP16 baseline correctly', () => {
    // 4 layers * 2 heads * 64 dim * 1024 tokens = 524,288 elements per cache
    // FP16: 524,288 * 2 bytes * 2 (K+V) = 2,097,152 bytes = 2 MiB
    const estimate = estimateKvCacheMemory(SMALL_MODEL, makeConfig({ preset: 'none' }));
    expect(estimate.totalBytes).toBe(2_097_152);
    expect(estimate.reductionFraction).toBe(0);
    expect(estimate.reductionFormatted).toBe('0%');
  });

  it('computes q8 (50% reduction)', () => {
    // Q8: 524,288 * 1 byte * 2 = 1,048,576 bytes
    const estimate = estimateKvCacheMemory(SMALL_MODEL, makeConfig({ preset: 'q8' }));
    expect(estimate.totalBytes).toBe(1_048_576);
    expect(estimate.reductionFraction).toBeCloseTo(0.5, 2);
    expect(estimate.reductionFormatted).toBe('50%');
  });

  it('computes q4 (75% reduction)', () => {
    // Q4: 524,288 * 0.5 bytes * 2 = 524,288 bytes
    const estimate = estimateKvCacheMemory(SMALL_MODEL, makeConfig({ preset: 'q4' }));
    expect(estimate.totalBytes).toBe(524_288);
    expect(estimate.reductionFraction).toBeCloseTo(0.75, 2);
    expect(estimate.reductionFormatted).toBe('75%');
  });

  it('computes k8v4 (~62.5% reduction)', () => {
    // K8: 524,288 * 1 byte = 524,288
    // V4: 524,288 * 0.5 bytes = 262,144
    // Total: 786,432 bytes
    // Reduction: 1 - 786432/2097152 = 0.625
    const estimate = estimateKvCacheMemory(SMALL_MODEL, makeConfig({ preset: 'k8v4' }));
    expect(estimate.keyBytes).toBe(524_288);
    expect(estimate.valueBytes).toBe(262_144);
    expect(estimate.totalBytes).toBe(786_432);
    expect(estimate.reductionFraction).toBeCloseTo(0.625, 3);
  });

  it('formats output as human-readable GiB for large models', () => {
    const estimate = estimateKvCacheMemory(
      MODEL_PARAMS['qwen3.5-122b']!,
      makeConfig({ preset: 'none' }),
    );
    expect(estimate.totalFormatted).toContain('GiB');
  });

  it('handles well-known qwen3.5-122b model params', () => {
    const params = MODEL_PARAMS['qwen3.5-122b']!;
    expect(params.numLayers).toBe(64);
    expect(params.numKvHeads).toBe(8);
    expect(params.headDim).toBe(192);
    expect(params.contextLength).toBe(131072);
  });

  it('k8v4 on qwen3.5-122b shows significant reduction', () => {
    const fp16 = estimateKvCacheMemory(
      MODEL_PARAMS['qwen3.5-122b']!,
      makeConfig({ preset: 'none' }),
    );
    const k8v4 = estimateKvCacheMemory(
      MODEL_PARAMS['qwen3.5-122b']!,
      makeConfig({ preset: 'k8v4' }),
    );
    expect(k8v4.totalBytes).toBeLessThan(fp16.totalBytes * 0.5);
    expect(k8v4.reductionFraction).toBeGreaterThan(0.5);
  });
});

describe('buildKvCacheEnvVars', () => {
  it('returns empty object for "none" preset', () => {
    expect(buildKvCacheEnvVars(makeConfig({ preset: 'none' }))).toEqual({});
  });

  it('returns env vars for k8v4 preset', () => {
    const vars = buildKvCacheEnvVars(makeConfig({ preset: 'k8v4' }));
    expect(vars).toEqual({
      MLX_KV_KEY_BITS: '8',
      MLX_KV_VALUE_BITS: '4',
      MLX_KV_GROUP_SIZE: '64',
    });
  });

  it('includes quantizedKvStart only when non-zero', () => {
    const withStart = buildKvCacheEnvVars(
      makeConfig({ preset: 'q8', quantizedKvStart: 5000 }),
    );
    expect(withStart['MLX_KV_QUANTIZED_START']).toBe('5000');

    const withoutStart = buildKvCacheEnvVars(
      makeConfig({ preset: 'q8', quantizedKvStart: 0 }),
    );
    expect(withoutStart['MLX_KV_QUANTIZED_START']).toBeUndefined();
  });

  it('uses explicit overrides over preset', () => {
    const vars = buildKvCacheEnvVars(
      makeConfig({ preset: 'q8', keyBits: 6, valueBits: 3, groupSize: 128 }),
    );
    expect(vars['MLX_KV_KEY_BITS']).toBe('6');
    expect(vars['MLX_KV_VALUE_BITS']).toBe('3');
    expect(vars['MLX_KV_GROUP_SIZE']).toBe('128');
  });
});

describe('parseKvCacheFromEnv', () => {
  it('returns defaults for empty env', () => {
    const config = parseKvCacheFromEnv({});
    expect(config).toEqual(defaultKvCacheConfig());
  });

  it('parses preset', () => {
    const config = parseKvCacheFromEnv({ MLX_KV_CACHE_PRESET: 'k8v4' });
    expect(config.preset).toBe('k8v4');
  });

  it('ignores invalid preset', () => {
    const config = parseKvCacheFromEnv({ MLX_KV_CACHE_PRESET: 'q16' });
    expect(config.preset).toBe('none');
  });

  it('parses key and value bits', () => {
    const config = parseKvCacheFromEnv({
      MLX_KV_KEY_BITS: '8',
      MLX_KV_VALUE_BITS: '4',
    });
    expect(config.keyBits).toBe(8);
    expect(config.valueBits).toBe(4);
  });

  it('ignores invalid bit values', () => {
    const config = parseKvCacheFromEnv({
      MLX_KV_KEY_BITS: '7',
      MLX_KV_VALUE_BITS: 'abc',
    });
    expect(config.keyBits).toBeUndefined();
    expect(config.valueBits).toBeUndefined();
  });

  it('parses group size', () => {
    const config = parseKvCacheFromEnv({ MLX_KV_GROUP_SIZE: '128' });
    expect(config.groupSize).toBe(128);
  });

  it('ignores invalid group size', () => {
    const config = parseKvCacheFromEnv({ MLX_KV_GROUP_SIZE: '48' });
    expect(config.groupSize).toBe(64); // default
  });

  it('parses quantized start', () => {
    const config = parseKvCacheFromEnv({ MLX_KV_QUANTIZED_START: '5000' });
    expect(config.quantizedKvStart).toBe(5000);
  });

  it('parses server support flag', () => {
    expect(parseKvCacheFromEnv({ MLX_KV_SERVER_SUPPORT: '1' }).serverSupport).toBe(true);
    expect(parseKvCacheFromEnv({ MLX_KV_SERVER_SUPPORT: 'true' }).serverSupport).toBe(true);
    expect(parseKvCacheFromEnv({ MLX_KV_SERVER_SUPPORT: '0' }).serverSupport).toBe(false);
    expect(parseKvCacheFromEnv({}).serverSupport).toBe(false);
  });

  it('round-trips through buildKvCacheEnvVars', () => {
    const original = makeConfig({ preset: 'k8v4', quantizedKvStart: 100 });
    const env = buildKvCacheEnvVars(original);
    const parsed = parseKvCacheFromEnv(env);

    // Resolved bits should match
    const originalResolved = resolveKvBits(original);
    const parsedResolved = resolveKvBits(parsed);
    expect(parsedResolved).toEqual(originalResolved);
    expect(parsed.groupSize).toBe(original.groupSize);
    expect(parsed.quantizedKvStart).toBe(original.quantizedKvStart);
  });
});

describe('summarizeKvCacheConfig', () => {
  it('reports FP16 for "none" preset', () => {
    const summary = summarizeKvCacheConfig(makeConfig({ preset: 'none' }));
    expect(summary).toContain('FP16');
    expect(summary).toContain('no quantization');
  });

  it('reports uniform quantization for q8', () => {
    const summary = summarizeKvCacheConfig(makeConfig({ preset: 'q8' }));
    expect(summary).toContain('Q8 uniform');
    expect(summary).toContain('keys=8b');
    expect(summary).toContain('values=8b');
  });

  it('reports split quantization for k8v4', () => {
    const summary = summarizeKvCacheConfig(makeConfig({ preset: 'k8v4' }));
    expect(summary).toContain('K8V4 split');
    expect(summary).toContain('keys=8b');
    expect(summary).toContain('values=4b');
  });

  it('includes memory estimate when model params provided', () => {
    const summary = summarizeKvCacheConfig(
      makeConfig({ preset: 'k8v4' }),
      SMALL_MODEL,
    );
    expect(summary).toContain('reduction vs FP16');
  });

  it('warns when server support is false', () => {
    const summary = summarizeKvCacheConfig(
      makeConfig({ preset: 'k8v4', serverSupport: false }),
    );
    expect(summary).toContain('awaiting vllm-mlx');
  });

  it('does not warn when server support is true', () => {
    const summary = summarizeKvCacheConfig(
      makeConfig({ preset: 'k8v4', serverSupport: true }),
    );
    expect(summary).not.toContain('awaiting');
  });
});

describe('MlxProvider KV cache integration', () => {
  // Test that the provider correctly wires KV cache config through
  it('provider exposes kvCache config', async () => {
    const { MlxProvider } = await import('../src/providers/mlx.js');
    const provider = new MlxProvider({
      baseUrl: 'http://localhost:8000',
      model: 'test',
      kvCache: makeConfig({ preset: 'k8v4' }),
    });

    expect(provider.kvCache.preset).toBe('k8v4');
    expect(provider.kvBits).toEqual({ keyBits: 8, valueBits: 4 });
  });

  it('provider defaults to no quantization', async () => {
    const { MlxProvider } = await import('../src/providers/mlx.js');
    const provider = new MlxProvider({
      baseUrl: 'http://localhost:8000',
      model: 'test',
    });

    expect(provider.kvCache.preset).toBe('none');
    expect(provider.kvBits).toBeNull();
  });

  it('kvCacheSummary returns readable string', async () => {
    const { MlxProvider } = await import('../src/providers/mlx.js');
    const provider = new MlxProvider({
      baseUrl: 'http://localhost:8000',
      model: 'test',
      kvCache: makeConfig({ preset: 'k8v4' }),
    });

    const summary = provider.kvCacheSummary();
    expect(summary).toContain('K8V4');
  });
});
