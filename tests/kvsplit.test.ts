import { describe, expect, it } from 'vitest';
import {
  KvSplitManager,
  createKvSplitManager,
} from '../src/providers/kvsplit.js';
import type {
  KvQuantStrategy,
  KvMemoryEstimate,
  QualitySample,
  MlxKvCacheArgs,
} from '../src/providers/kvsplit.js';

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('KvSplitManager — Construction', () => {
  it('creates manager with default config', () => {
    const manager = createKvSplitManager();
    const config = manager.getConfig();
    expect(config.strategy).toBe('k8v4');
    expect(config.keyBits).toBe(8);
    expect(config.valueBits).toBe(4);
    expect(config.maxPerplexityDegradation).toBe(0.1);
  });

  it('creates manager with custom config', () => {
    const manager = createKvSplitManager({
      strategy: 'q8_0',
      keyBits: 8,
      valueBits: 8,
    });
    const config = manager.getConfig();
    expect(config.strategy).toBe('q8_0');
    expect(config.valueBits).toBe(8);
  });

  it('getStrategy returns active strategy', () => {
    const manager = createKvSplitManager({ strategy: 'k8v4' });
    expect(manager.getStrategy()).toBe('k8v4');
  });
});

describe('KvSplitManager — Memory Estimation', () => {
  it('estimates memory for K8V4 at 128K context', () => {
    const manager = createKvSplitManager();
    const estimate = manager.estimateMemory(131072, 'k8v4');

    expect(estimate.strategy).toBe('k8v4');
    expect(estimate.memoryBytes).toBeGreaterThan(0);
    expect(estimate.memoryGb).toBeGreaterThan(0);
    expect(estimate.savingsVsFp16).toBeGreaterThan(0);
  });

  it('K8V4 saves ~62.5% vs FP16', () => {
    const manager = createKvSplitManager();
    const estimate = manager.estimateMemory(131072, 'k8v4');

    // K8V4: 0.75 bytes/element, FP16: 2 bytes/element
    // Savings = 1 - 0.75/2 = 0.625 = 62.5%
    expect(estimate.savingsVsFp16).toBeGreaterThanOrEqual(0.5);
    expect(estimate.savingsVsFp16).toBeLessThanOrEqual(0.7);
  });

  it('K8V4 saves ~25% vs Q8', () => {
    const manager = createKvSplitManager();
    const estimate = manager.estimateMemory(131072, 'k8v4');

    // K8V4: 0.75 bytes/element, Q8: 1 byte/element
    // Savings = 1 - 0.75/1 = 0.25 = 25%
    expect(estimate.savingsVsQ8).toBeGreaterThanOrEqual(0.2);
    expect(estimate.savingsVsQ8).toBeLessThanOrEqual(0.3);
  });

  it('FP16 has zero savings vs itself', () => {
    const manager = createKvSplitManager();
    const estimate = manager.estimateMemory(131072, 'fp16');

    expect(estimate.savingsVsFp16).toBe(0);
  });

  it('larger context = more memory', () => {
    const manager = createKvSplitManager();
    const small = manager.estimateMemory(8192, 'k8v4');
    const large = manager.estimateMemory(131072, 'k8v4');

    expect(large.memoryBytes).toBeGreaterThan(small.memoryBytes);
  });

  it('Q4 saves more than K8V4', () => {
    const manager = createKvSplitManager();
    const q4 = manager.estimateMemory(131072, 'q4');
    const k8v4 = manager.estimateMemory(131072, 'k8v4');

    expect(q4.memoryBytes).toBeLessThan(k8v4.memoryBytes);
    expect(q4.savingsVsFp16).toBeGreaterThan(k8v4.savingsVsFp16);
  });

  it('compareStrategies returns fp16, q8_0, k8v4', () => {
    const manager = createKvSplitManager();
    const results = manager.compareStrategies(65536);

    expect(results).toHaveLength(3);
    expect(results.map((r) => r.strategy)).toEqual(['fp16', 'q8_0', 'k8v4']);
  });

  it('compareStrategies shows FP16 > Q8 > K8V4 memory order', () => {
    const manager = createKvSplitManager();
    const [fp16, q8, k8v4] = manager.compareStrategies(65536);

    expect(fp16!.memoryBytes).toBeGreaterThan(q8!.memoryBytes);
    expect(q8!.memoryBytes).toBeGreaterThan(k8v4!.memoryBytes);
  });
});

describe('KvSplitManager — MLX Args', () => {
  it('returns asymmetric cache args for k8v4 strategy', () => {
    const manager = createKvSplitManager({ strategy: 'k8v4' });
    const args = manager.getMlxArgs();

    expect(args.useAsymmetricCache).toBe(true);
    expect(args.keyBits).toBe(8);
    expect(args.valueBits).toBe(4);
    expect(args.kvGroupSize).toBe(64);
  });

  it('returns uniform kvBits=8 for q8_0 strategy', () => {
    const manager = createKvSplitManager({ strategy: 'q8_0' });
    const args = manager.getMlxArgs();

    expect(args.kvBits).toBe(8);
    expect(args.kvGroupSize).toBe(64);
    expect(args.useAsymmetricCache).toBeUndefined();
  });

  it('returns uniform kvBits=4 for q4 strategy', () => {
    const manager = createKvSplitManager({ strategy: 'q4' });
    const args = manager.getMlxArgs();

    expect(args.kvBits).toBe(4);
    expect(args.kvGroupSize).toBe(64);
  });

  it('returns empty args for fp16 strategy', () => {
    const manager = createKvSplitManager({ strategy: 'fp16' });
    const args = manager.getMlxArgs();

    expect(args.kvBits).toBeUndefined();
    expect(args.useAsymmetricCache).toBeUndefined();
  });

  it('buildCliArgs generates --kv-bits flag for uniform strategies', () => {
    const manager = createKvSplitManager({ strategy: 'q8_0' });
    const args = manager.buildCliArgs();

    expect(args).toContain('--kv-bits=8');
    expect(args).toContain('--kv-group-size=64');
  });

  it('buildCliArgs returns empty for k8v4 (needs custom cache class)', () => {
    const manager = createKvSplitManager({ strategy: 'k8v4' });
    const args = manager.buildCliArgs();

    // K8V4 can't be expressed as simple CLI flags
    expect(args).toHaveLength(0);
  });

  it('buildServerArgs returns same as buildCliArgs (deprecated)', () => {
    const manager = createKvSplitManager({ strategy: 'q8_0' });
    expect(manager.buildServerArgs()).toEqual(manager.buildCliArgs());
  });

  it('buildCliArgs returns empty for fp16', () => {
    const manager = createKvSplitManager({ strategy: 'fp16' });
    const args = manager.buildCliArgs();

    expect(args).toHaveLength(0);
  });
});

describe('KvSplitManager — shouldApplyKvSplit', () => {
  it('applies for large context lengths', () => {
    const manager = createKvSplitManager({ strategy: 'k8v4' });
    expect(manager.shouldApplyKvSplit(131072)).toBe(true);
  });

  it('does not apply for small context lengths', () => {
    const manager = createKvSplitManager({
      strategy: 'k8v4',
      minContextForKvSplit: 8192,
    });
    expect(manager.shouldApplyKvSplit(4096)).toBe(false);
  });

  it('does not apply for fp16 strategy', () => {
    const manager = createKvSplitManager({ strategy: 'fp16' });
    expect(manager.shouldApplyKvSplit(131072)).toBe(false);
  });

  it('does not apply for q8_0 strategy', () => {
    const manager = createKvSplitManager({ strategy: 'q8_0' });
    expect(manager.shouldApplyKvSplit(131072)).toBe(false);
  });

  it('does not apply when auto-disabled', () => {
    const manager = createKvSplitManager({
      strategy: 'k8v4',
      autoDisableOnDegradation: true,
      qualityMonitoringEnabled: true,
      qualitySampleWindow: 10,
    });

    for (let i = 0; i < 10; i++) {
      manager.recordQualitySample(131072, 0.5);
    }

    expect(manager.isAutoDisabled()).toBe(true);
    expect(manager.shouldApplyKvSplit(131072)).toBe(false);
  });
});

describe('KvSplitManager — Quality Monitoring', () => {
  it('starts with empty summary', () => {
    const manager = createKvSplitManager();
    const summary = manager.getQualitySummary();

    expect(summary.totalSamples).toBe(0);
    expect(summary.healthy).toBe(true);
    expect(summary.autoDisabled).toBe(false);
  });

  it('records and tracks quality samples', () => {
    const manager = createKvSplitManager();

    manager.recordQualitySample(65536, 0.03);
    manager.recordQualitySample(65536, 0.05);
    manager.recordQualitySample(65536, 0.02);

    const summary = manager.getQualitySummary();
    expect(summary.totalSamples).toBe(3);
    expect(summary.degradedSamples).toBe(0);
    expect(summary.healthy).toBe(true);
  });

  it('detects degraded samples', () => {
    const manager = createKvSplitManager({
      maxPerplexityDegradation: 0.1,
    });

    manager.recordQualitySample(65536, 0.03); // Good
    manager.recordQualitySample(65536, 0.15); // Degraded
    manager.recordQualitySample(65536, 0.02); // Good

    const summary = manager.getQualitySummary();
    expect(summary.degradedSamples).toBe(1);
    expect(summary.degradationRate).toBeGreaterThan(0);
  });

  it('auto-disables when degradation rate exceeds threshold', () => {
    const manager = createKvSplitManager({
      autoDisableOnDegradation: true,
      qualitySampleWindow: 10,
      maxPerplexityDegradation: 0.1,
    });

    // 3 degraded out of 10 = 30% > 20% threshold
    for (let i = 0; i < 7; i++) {
      manager.recordQualitySample(65536, 0.05);
    }
    for (let i = 0; i < 3; i++) {
      manager.recordQualitySample(65536, 0.2);
    }

    expect(manager.isAutoDisabled()).toBe(true);
    expect(manager.getStrategy()).toBe('q8_0');
  });

  it('does not auto-disable with insufficient samples', () => {
    const manager = createKvSplitManager({
      autoDisableOnDegradation: true,
      qualitySampleWindow: 50,
      maxPerplexityDegradation: 0.1,
    });

    for (let i = 0; i < 5; i++) {
      manager.recordQualitySample(65536, 0.2);
    }

    expect(manager.isAutoDisabled()).toBe(false);
  });

  it('resetQualityMonitor clears samples and re-enables', () => {
    const manager = createKvSplitManager({
      autoDisableOnDegradation: true,
      qualitySampleWindow: 10,
    });

    for (let i = 0; i < 10; i++) {
      manager.recordQualitySample(65536, 0.5);
    }
    expect(manager.isAutoDisabled()).toBe(true);

    manager.resetQualityMonitor();
    expect(manager.isAutoDisabled()).toBe(false);
    expect(manager.getQualitySummary().totalSamples).toBe(0);
  });

  it('respects qualitySampleWindow limit', () => {
    const manager = createKvSplitManager({
      qualitySampleWindow: 5,
    });

    for (let i = 0; i < 10; i++) {
      manager.recordQualitySample(65536, 0.02);
    }

    const summary = manager.getQualitySummary();
    expect(summary.totalSamples).toBe(5);
  });

  it('does not record when monitoring is disabled', () => {
    const manager = createKvSplitManager({
      qualityMonitoringEnabled: false,
    });

    manager.recordQualitySample(65536, 0.02);
    expect(manager.getQualitySummary().totalSamples).toBe(0);
  });
});

describe('KvSplitManager — Auto-disable MLX args fallback', () => {
  it('returns empty args when auto-disabled', () => {
    const manager = createKvSplitManager({
      strategy: 'k8v4',
      autoDisableOnDegradation: true,
      qualitySampleWindow: 10,
    });

    for (let i = 0; i < 10; i++) {
      manager.recordQualitySample(131072, 0.5);
    }

    const args = manager.getMlxArgs();
    expect(args.kvBits).toBeUndefined();
    expect(args.useAsymmetricCache).toBeUndefined();
  });
});
