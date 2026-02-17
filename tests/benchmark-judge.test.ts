import { describe, expect, it, vi } from 'vitest';

import {
  judgeResponse,
  normalizeJudgeScore,
  DEFAULT_RUBRIC,
} from '../src/benchmark/judge.js';
import type { JudgeConfig, JudgeRubric } from '../src/benchmark/judge.js';
import type { BenchmarkCase } from '../src/benchmark/types.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeCase(overrides: Partial<BenchmarkCase> = {}): BenchmarkCase {
  return {
    id: 'test-case',
    name: 'Test Case',
    description: 'A test case for judging',
    input: 'Write a function to add two numbers',
    expected: { shouldSucceed: true },
    difficulty: 'simple',
    category: 'tool_use',
    ...overrides,
  };
}

const judgeConfig: JudgeConfig = {
  baseUrl: 'http://localhost:11434',
  judgeModel: 'judge-model',
};

// ─── DEFAULT_RUBRIC ─────────────────────────────────────────────────────────

describe('DEFAULT_RUBRIC', () => {
  it('has 4 dimensions', () => {
    expect(DEFAULT_RUBRIC).toHaveLength(4);
  });

  it('weights sum to 1.0', () => {
    const sum = DEFAULT_RUBRIC.reduce((s, r) => s + r.weight, 0);
    expect(sum).toBeCloseTo(1.0);
  });

  it('includes correctness, helpfulness, tool_usage, safety', () => {
    const dims = DEFAULT_RUBRIC.map((r) => r.dimension);
    expect(dims).toContain('correctness');
    expect(dims).toContain('helpfulness');
    expect(dims).toContain('tool_usage');
    expect(dims).toContain('safety');
  });

  it('correctness has highest weight', () => {
    const correctness = DEFAULT_RUBRIC.find((r) => r.dimension === 'correctness')!;
    for (const r of DEFAULT_RUBRIC) {
      expect(correctness.weight).toBeGreaterThanOrEqual(r.weight);
    }
  });
});

// ─── normalizeJudgeScore ────────────────────────────────────────────────────

describe('normalizeJudgeScore', () => {
  it('normalizes 10 to 1.0', () => {
    expect(normalizeJudgeScore(10)).toBe(1);
  });

  it('normalizes 0 to 0.0', () => {
    expect(normalizeJudgeScore(0)).toBe(0);
  });

  it('normalizes 5 to 0.5', () => {
    expect(normalizeJudgeScore(5)).toBe(0.5);
  });

  it('normalizes 7.5 to 0.75', () => {
    expect(normalizeJudgeScore(7.5)).toBe(0.75);
  });

  it('clamps above 10 to 1.0', () => {
    expect(normalizeJudgeScore(15)).toBe(1);
  });

  it('clamps below 0 to 0.0', () => {
    expect(normalizeJudgeScore(-5)).toBe(0);
  });
});

// ─── judgeResponse ──────────────────────────────────────────────────────────

describe('judgeResponse', () => {
  it('handles fetch failure gracefully', async () => {
    // Mock fetch to fail
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('Connection refused'));

    try {
      const result = await judgeResponse(
        judgeConfig,
        makeCase(),
        'Here is a function that adds two numbers...',
        ['create_file'],
      );

      expect(result.success).toBe(false);
      expect(result.qualityScore).toBe(0);
      expect(result.error).toContain('Connection refused');
      expect(result.judgeTokensUsed).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('handles judge model returning error', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        message: { role: 'assistant', content: '' },
        done: true,
        error: 'Model not found',
        prompt_eval_count: 10,
        eval_count: 0,
      }),
    });

    try {
      const result = await judgeResponse(
        judgeConfig,
        makeCase(),
        'response',
        [],
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('Model not found');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('parses valid judge response correctly', async () => {
    const judgeOutput = JSON.stringify({
      dimensions: [
        { dimension: 'correctness', score: 8, reasoning: 'Good implementation' },
        { dimension: 'helpfulness', score: 9, reasoning: 'Very helpful' },
        { dimension: 'tool_usage', score: 7, reasoning: 'Used correct tool' },
        { dimension: 'safety', score: 10, reasoning: 'No safety issues' },
      ],
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        message: { role: 'assistant', content: judgeOutput },
        done: true,
        prompt_eval_count: 200,
        eval_count: 50,
      }),
    });

    try {
      const result = await judgeResponse(
        judgeConfig,
        makeCase(),
        'Great response with working code',
        ['create_file'],
      );

      expect(result.success).toBe(true);
      expect(result.dimensions).toHaveLength(4);
      expect(result.qualityScore).toBeGreaterThan(0);
      expect(result.qualityScore).toBeLessThanOrEqual(10);
      expect(result.judgeTokensUsed).toBe(250);

      // Weighted average: 8*0.35 + 9*0.25 + 7*0.25 + 10*0.15 = 2.8+2.25+1.75+1.5 = 8.3
      expect(result.qualityScore).toBeCloseTo(8.3, 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('handles judge response with markdown fences', async () => {
    const judgeOutput = '```json\n' + JSON.stringify({
      dimensions: [
        { dimension: 'correctness', score: 6, reasoning: 'OK' },
        { dimension: 'helpfulness', score: 7, reasoning: 'Decent' },
        { dimension: 'tool_usage', score: 8, reasoning: 'Good' },
        { dimension: 'safety', score: 9, reasoning: 'Safe' },
      ],
    }) + '\n```';

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        message: { role: 'assistant', content: judgeOutput },
        done: true,
        prompt_eval_count: 100,
        eval_count: 30,
      }),
    });

    try {
      const result = await judgeResponse(
        judgeConfig,
        makeCase(),
        'response',
        [],
      );

      expect(result.success).toBe(true);
      expect(result.dimensions).toHaveLength(4);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('handles malformed judge output', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        message: { role: 'assistant', content: 'I think the score is 8/10' },
        done: true,
        prompt_eval_count: 50,
        eval_count: 20,
      }),
    });

    try {
      const result = await judgeResponse(
        judgeConfig,
        makeCase(),
        'response',
        [],
      );

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('clamps scores to 0-10 range', async () => {
    const judgeOutput = JSON.stringify({
      dimensions: [
        { dimension: 'correctness', score: 15, reasoning: 'Overscored' },
        { dimension: 'helpfulness', score: -3, reasoning: 'Underscored' },
        { dimension: 'tool_usage', score: 7, reasoning: 'Normal' },
        { dimension: 'safety', score: 10, reasoning: 'Perfect' },
      ],
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        message: { role: 'assistant', content: judgeOutput },
        done: true,
        prompt_eval_count: 100,
        eval_count: 30,
      }),
    });

    try {
      const result = await judgeResponse(
        judgeConfig,
        makeCase(),
        'response',
        [],
      );

      expect(result.success).toBe(true);
      const correctness = result.dimensions.find((d) => d.dimension === 'correctness');
      const helpfulness = result.dimensions.find((d) => d.dimension === 'helpfulness');
      expect(correctness!.score).toBe(10); // Clamped from 15
      expect(helpfulness!.score).toBe(0);  // Clamped from -3
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('uses custom rubric when provided', async () => {
    const customRubric: JudgeRubric[] = [
      { dimension: 'accuracy', criteria: 'Is it accurate?', weight: 0.6 },
      { dimension: 'brevity', criteria: 'Is it concise?', weight: 0.4 },
    ];

    const judgeOutput = JSON.stringify({
      dimensions: [
        { dimension: 'accuracy', score: 9, reasoning: 'Accurate' },
        { dimension: 'brevity', score: 5, reasoning: 'Wordy' },
      ],
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        message: { role: 'assistant', content: judgeOutput },
        done: true,
        prompt_eval_count: 100,
        eval_count: 30,
      }),
    });

    try {
      const result = await judgeResponse(
        judgeConfig,
        makeCase(),
        'response',
        [],
        customRubric,
      );

      expect(result.success).toBe(true);
      expect(result.dimensions).toHaveLength(2);
      // Weighted: 9*0.6 + 5*0.4 = 5.4 + 2.0 = 7.4
      expect(result.qualityScore).toBeCloseTo(7.4, 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('includes case-specific rubric in judge prompt', async () => {
    const caseWithRubric = makeCase({
      qualityRubric: 'The response must include working TypeScript code with proper types.',
    });

    let capturedBody = '';
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockImplementation((_url: string, opts: RequestInit) => {
      capturedBody = opts.body as string;
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          message: { role: 'assistant', content: JSON.stringify({
            dimensions: [
              { dimension: 'correctness', score: 8, reasoning: 'Good' },
              { dimension: 'helpfulness', score: 8, reasoning: 'Good' },
              { dimension: 'tool_usage', score: 8, reasoning: 'Good' },
              { dimension: 'safety', score: 8, reasoning: 'Good' },
            ],
          })},
          done: true,
          prompt_eval_count: 100,
          eval_count: 30,
        }),
      });
    });

    try {
      await judgeResponse(judgeConfig, caseWithRubric, 'response', []);

      const body = JSON.parse(capturedBody);
      const userMessage = body.messages[0].content;
      expect(userMessage).toContain('working TypeScript code');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
