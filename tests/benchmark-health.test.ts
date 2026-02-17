import { describe, expect, it, vi } from 'vitest';

import {
  runHealthCheck,
  formatHealthReport,
} from '../src/benchmark/health.js';
import type { HealthReport } from '../src/benchmark/health.js';

// ─── runHealthCheck ─────────────────────────────────────────────────────────

describe('runHealthCheck', () => {
  it('reports unhealthy when Ollama is unreachable', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('Connection refused'));

    try {
      const report = await runHealthCheck('http://localhost:11434', 'test-model');

      expect(report.ollama.healthy).toBe(false);
      expect(report.ollama.error).toContain('Connection refused');
      expect(report.model.available).toBe(false);
      expect(report.checkDurationMs).toBeGreaterThanOrEqual(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('reports healthy when Ollama responds', async () => {
    const originalFetch = globalThis.fetch;

    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      const urlStr = String(url);

      if (urlStr.includes('/api/version')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ version: '0.5.1' }),
        });
      }
      if (urlStr.includes('/api/tags')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            models: [
              {
                name: 'test-model:latest',
                details: { parameter_size: '7B', quantization_level: 'Q4_K_M' },
              },
            ],
          }),
        });
      }
      if (urlStr.includes('/api/ps')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            models: [
              {
                name: 'test-model:latest',
                size: 5_000_000_000,
                size_vram: 4_500_000_000,
                expires_at: '2026-02-17T20:00:00Z',
              },
            ],
          }),
        });
      }

      return Promise.reject(new Error(`Unexpected URL: ${urlStr}`));
    });

    try {
      const report = await runHealthCheck('http://localhost:11434', 'test-model');

      expect(report.ollama.healthy).toBe(true);
      expect(report.ollama.version).toBe('0.5.1');
      expect(report.model.available).toBe(true);
      expect(report.model.resolvedName).toBe('test-model:latest');
      expect(report.model.parameterSize).toBe('7B');
      expect(report.model.quantization).toBe('Q4_K_M');
      expect(report.memory).toBeDefined();
      expect(report.memory!.vramBytes).toBe(4_500_000_000);
      expect(report.memory!.fullyGpuLoaded).toBe(false);
      expect(report.warmth).toBeDefined();
      expect(report.warmth!.isWarm).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('reports model unavailable when not found', async () => {
    const originalFetch = globalThis.fetch;

    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      const urlStr = String(url);

      if (urlStr.includes('/api/version')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ version: '0.5.1' }),
        });
      }
      if (urlStr.includes('/api/tags')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            models: [
              { name: 'other-model:latest', details: {} },
            ],
          }),
        });
      }

      return Promise.reject(new Error(`Unexpected URL: ${urlStr}`));
    });

    try {
      const report = await runHealthCheck('http://localhost:11434', 'nonexistent-model', { skipWarmth: true });

      expect(report.ollama.healthy).toBe(true);
      expect(report.model.available).toBe(false);
      expect(report.model.error).toContain('nonexistent-model');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('skips warmth check when skipWarmth is true', async () => {
    const originalFetch = globalThis.fetch;
    const calledUrls: string[] = [];

    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      const urlStr = String(url);
      calledUrls.push(urlStr);

      if (urlStr.includes('/api/version')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ version: '0.5.1' }),
        });
      }
      if (urlStr.includes('/api/tags')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            models: [{ name: 'test-model:latest', details: {} }],
          }),
        });
      }
      if (urlStr.includes('/api/ps')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ models: [] }),
        });
      }

      return Promise.reject(new Error(`Unexpected URL: ${urlStr}`));
    });

    try {
      const report = await runHealthCheck('http://localhost:11434', 'test-model', { skipWarmth: true });

      expect(report.warmth).toBeUndefined();
      // Should not have called /api/chat for warmup probe
      expect(calledUrls.some((u) => u.includes('/api/chat'))).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ─── formatHealthReport ─────────────────────────────────────────────────────

describe('formatHealthReport', () => {
  it('formats healthy report', () => {
    const report: HealthReport = {
      ollama: { healthy: true, version: '0.5.1' },
      model: { available: true, resolvedName: 'qwen2.5-coder:7b', parameterSize: '7B', quantization: 'Q4_K_M' },
      memory: {
        vramBytes: 4_500_000_000,
        vramFormatted: '4.2 GB',
        ramBytes: 500_000_000,
        ramFormatted: '476.8 MB',
        fullyGpuLoaded: false,
        timestamp: Date.now(),
      },
      warmth: { isWarm: true, idleSecs: 0 },
      checkDurationMs: 150,
    };

    const output = formatHealthReport(report);
    expect(output).toContain('PRE-FLIGHT HEALTH CHECK');
    expect(output).toContain('OK');
    expect(output).toContain('qwen2.5-coder:7b');
    expect(output).toContain('7B');
    expect(output).toContain('Q4_K_M');
    expect(output).toContain('4.2 GB');
    expect(output).toContain('WARM');
    expect(output).toContain('150ms');
  });

  it('formats unhealthy report', () => {
    const report: HealthReport = {
      ollama: { healthy: false, error: 'Cannot reach Ollama' },
      model: { available: false, error: 'Skipped' },
      checkDurationMs: 50,
    };

    const output = formatHealthReport(report);
    expect(output).toContain('FAIL');
    expect(output).toContain('Cannot reach Ollama');
  });

  it('formats cold start report', () => {
    const report: HealthReport = {
      ollama: { healthy: true, version: '0.5.1' },
      model: { available: true, resolvedName: 'test:latest' },
      warmth: { isWarm: false, coldStartMs: 3500 },
      checkDurationMs: 4000,
    };

    const output = formatHealthReport(report);
    expect(output).toContain('COLD');
    expect(output).toContain('3500ms');
  });
});
