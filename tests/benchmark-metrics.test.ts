import { describe, expect, it } from 'vitest';

import {
  extractMetrics,
  type OllamaBenchmarkResponse,
  type PerformanceMetrics,
} from '../src/benchmark/metrics.js';

// ═══════════════════════════════════════════════════════════════════════════════
// extractMetrics — full response
// ═══════════════════════════════════════════════════════════════════════════════

describe('extractMetrics — full response', () => {
  it('converts nanoseconds to milliseconds for TTFT', () => {
    const resp: OllamaBenchmarkResponse = {
      done: true,
      prompt_eval_duration: 50_000_000, // 50ms in ns
      prompt_eval_count: 20,
      eval_count: 100,
      eval_duration: 2_000_000_000, // 2s in ns
      total_duration: 3_000_000_000, // 3s in ns
    };

    const m = extractMetrics(resp);
    expect(m.ttftMs).toBe(50);
  });

  it('converts nanoseconds to milliseconds for totalMs', () => {
    const resp: OllamaBenchmarkResponse = {
      done: true,
      total_duration: 5_500_000_000, // 5500ms
    };

    const m = extractMetrics(resp);
    expect(m.totalMs).toBe(5500);
  });

  it('calculates evalRate as tokens per second', () => {
    const resp: OllamaBenchmarkResponse = {
      done: true,
      eval_count: 200,
      eval_duration: 4_000_000_000, // 4s in ns
    };

    const m = extractMetrics(resp);
    expect(m.evalRate).toBe(50); // 200 tokens / 4 seconds
  });

  it('extracts tokensInput from prompt_eval_count', () => {
    const resp: OllamaBenchmarkResponse = {
      done: true,
      prompt_eval_count: 42,
    };

    const m = extractMetrics(resp);
    expect(m.tokensInput).toBe(42);
  });

  it('extracts tokensOutput from eval_count', () => {
    const resp: OllamaBenchmarkResponse = {
      done: true,
      eval_count: 137,
    };

    const m = extractMetrics(resp);
    expect(m.tokensOutput).toBe(137);
  });

  it('returns all PerformanceMetrics fields', () => {
    const resp: OllamaBenchmarkResponse = {
      done: true,
      prompt_eval_count: 50,
      prompt_eval_duration: 100_000_000,
      eval_count: 200,
      eval_duration: 2_000_000_000,
      total_duration: 3_000_000_000,
    };

    const m = extractMetrics(resp);
    expect(m).toEqual({
      tokensInput: 50,
      tokensOutput: 200,
      ttftMs: 100,
      totalMs: 3000,
      evalRate: 100, // 200 / 2
    } satisfies PerformanceMetrics);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// extractMetrics — missing fields
// ═══════════════════════════════════════════════════════════════════════════════

describe('extractMetrics — missing fields', () => {
  it('defaults tokensInput to 0 when prompt_eval_count is undefined', () => {
    const resp: OllamaBenchmarkResponse = { done: true };
    expect(extractMetrics(resp).tokensInput).toBe(0);
  });

  it('defaults tokensOutput to 0 when eval_count is undefined', () => {
    const resp: OllamaBenchmarkResponse = { done: true };
    expect(extractMetrics(resp).tokensOutput).toBe(0);
  });

  it('defaults ttftMs to 0 when prompt_eval_duration is undefined', () => {
    const resp: OllamaBenchmarkResponse = { done: true };
    expect(extractMetrics(resp).ttftMs).toBe(0);
  });

  it('defaults totalMs to 0 when total_duration is undefined', () => {
    const resp: OllamaBenchmarkResponse = { done: true };
    expect(extractMetrics(resp).totalMs).toBe(0);
  });

  it('defaults evalRate to 0 when eval_duration is undefined', () => {
    const resp: OllamaBenchmarkResponse = { done: true, eval_count: 100 };
    expect(extractMetrics(resp).evalRate).toBe(0);
  });

  it('defaults evalRate to 0 when eval_count is 0', () => {
    const resp: OllamaBenchmarkResponse = {
      done: true,
      eval_count: 0,
      eval_duration: 1_000_000_000,
    };
    expect(extractMetrics(resp).evalRate).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// extractMetrics — edge cases
// ═══════════════════════════════════════════════════════════════════════════════

describe('extractMetrics — edge cases', () => {
  it('handles very small durations', () => {
    const resp: OllamaBenchmarkResponse = {
      done: true,
      prompt_eval_duration: 1, // 1 nanosecond
      total_duration: 1,
      eval_count: 1,
      eval_duration: 1,
    };

    const m = extractMetrics(resp);
    expect(m.ttftMs).toBeCloseTo(0.000001, 6);
    expect(m.totalMs).toBeCloseTo(0.000001, 6);
  });

  it('handles very large durations', () => {
    const resp: OllamaBenchmarkResponse = {
      done: true,
      total_duration: 600_000_000_000, // 600 seconds
      eval_count: 10_000,
      eval_duration: 500_000_000_000, // 500 seconds
    };

    const m = extractMetrics(resp);
    expect(m.totalMs).toBe(600_000);
    expect(m.evalRate).toBe(20); // 10000 / 500
  });

  it('does not depend on message or done_reason fields', () => {
    const resp: OllamaBenchmarkResponse = {
      done: false,
      done_reason: 'stop',
      message: { role: 'assistant', content: 'Hello' },
      eval_count: 5,
      eval_duration: 1_000_000_000,
    };

    const m = extractMetrics(resp);
    expect(m.tokensOutput).toBe(5);
    expect(m.evalRate).toBe(5);
  });
});
