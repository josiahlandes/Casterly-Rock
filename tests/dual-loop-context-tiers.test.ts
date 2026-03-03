import { describe, expect, it } from 'vitest';
import {
  selectFastTier,
  selectDeepTier,
  selectCoderTier,
  selectReviewTier,
  resolveNumCtx,
  buildProviderOptions,
  estimateTokens,
  checkContextPressure,
  buildPressureWarning,
  compressPrompt,
  DEFAULT_CONTEXT_TIERS,
} from '../src/dual-loop/context-tiers.js';
import type { Task } from '../src/dual-loop/task-board-types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeTask(overrides?: Partial<Task>): Task {
  return {
    id: 'task-test',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: 'queued',
    owner: null,
    origin: 'user',
    priority: 0,
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('Context Tiers', () => {
  describe('selectFastTier', () => {
    it('returns compact for triage', () => {
      expect(selectFastTier('triage')).toBe('compact');
    });

    it('returns compact for acknowledge', () => {
      expect(selectFastTier('acknowledge')).toBe('compact');
    });

    it('returns compact for voice_filter', () => {
      expect(selectFastTier('voice_filter')).toBe('compact');
    });

    it('returns compact for deliver_response', () => {
      expect(selectFastTier('deliver_response')).toBe('compact');
    });

    it('returns standard for direct_answer', () => {
      expect(selectFastTier('direct_answer')).toBe('standard');
    });

    it('returns standard for status_report', () => {
      expect(selectFastTier('status_report')).toBe('standard');
    });

    it('returns standard for review_small', () => {
      expect(selectFastTier('review_small')).toBe('standard');
    });

    it('returns extended for review_large', () => {
      expect(selectFastTier('review_large')).toBe('extended');
    });

    it('returns extended for batched_triage', () => {
      expect(selectFastTier('batched_triage')).toBe('extended');
    });
  });

  describe('selectDeepTier', () => {
    it('returns standard for a simple task', () => {
      const task = makeTask();
      expect(selectDeepTier(task)).toBe('standard');
    });

    it('returns extended for a parked task', () => {
      const task = makeTask({
        parkedState: { parkedAtTurn: 3, reason: 'preempted' },
      });
      expect(selectDeepTier(task)).toBe('extended');
    });

    it('returns standard for a task with 2-3 plan steps', () => {
      const task = makeTask({
        planSteps: [
          { description: 'Step 1', status: 'pending' },
          { description: 'Step 2', status: 'pending' },
        ],
      });
      expect(selectDeepTier(task)).toBe('standard');
    });

    it('returns extended for a task with >3 plan steps', () => {
      const task = makeTask({
        planSteps: [
          { description: 'Step 1', status: 'pending' },
          { description: 'Step 2', status: 'pending' },
          { description: 'Step 3', status: 'pending' },
          { description: 'Step 4', status: 'pending' },
        ],
      });
      expect(selectDeepTier(task)).toBe('extended');
    });
  });

  describe('selectCoderTier', () => {
    const config = DEFAULT_CONTEXT_TIERS.coder;

    it('returns compact for small prompts', () => {
      // ~100 chars → ~29 tokens + 2000 buffer = 2029 < 0.75 * 8192 = 6144
      expect(selectCoderTier(100, config)).toBe('compact');
    });

    it('returns standard for medium prompts', () => {
      // ~20000 chars → ~5714 tokens + 2000 buffer = 7714 > 6144, < 0.75 * 65536 = 49152
      expect(selectCoderTier(20000, config)).toBe('standard');
    });

    it('returns extended for large prompts', () => {
      // ~180000 chars → ~51429 tokens + 2000 buffer = 53429 > 49152
      expect(selectCoderTier(180000, config)).toBe('extended');
    });
  });

  describe('selectReviewTier', () => {
    const config = DEFAULT_CONTEXT_TIERS.fast;

    it('returns review_small for diffs under threshold', () => {
      expect(selectReviewTier(50, config)).toBe('review_small');
    });

    it('returns review_large for diffs at or above threshold', () => {
      expect(selectReviewTier(150, config)).toBe('review_large');
      expect(selectReviewTier(200, config)).toBe('review_large');
    });
  });

  describe('resolveNumCtx', () => {
    it('resolves compact tier', () => {
      expect(resolveNumCtx(DEFAULT_CONTEXT_TIERS.fast, 'compact')).toBe(4096);
    });

    it('resolves standard tier', () => {
      expect(resolveNumCtx(DEFAULT_CONTEXT_TIERS.deep, 'standard')).toBe(24576);
    });

    it('resolves extended tier', () => {
      expect(resolveNumCtx(DEFAULT_CONTEXT_TIERS.coder, 'extended')).toBe(262144);
    });
  });

  describe('buildProviderOptions', () => {
    it('returns an object with num_ctx', () => {
      const opts = buildProviderOptions(DEFAULT_CONTEXT_TIERS.fast, 'standard');
      expect(opts).toEqual({ num_ctx: 12288 });
    });
  });

  describe('estimateTokens', () => {
    it('estimates tokens from text length', () => {
      // 350 chars / 3.5 = 100 tokens
      const text = 'a'.repeat(350);
      expect(estimateTokens(text)).toBe(100);
    });

    it('rounds up', () => {
      expect(estimateTokens('abc')).toBe(1); // 3/3.5 = 0.857 → ceil → 1
    });

    it('handles empty string', () => {
      expect(estimateTokens('')).toBe(0);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Context Pressure
  // ─────────────────────────────────────────────────────────────────────────

  describe('checkContextPressure', () => {
    const config = DEFAULT_CONTEXT_TIERS.deep;

    it('reports no thresholds exceeded when under soft threshold', () => {
      // 1000 chars prompt + 500 chars system = ~429 tokens. numCtx=24576 → pressure ~1.7%
      const result = checkContextPressure(1000, 500, 24576, config);
      expect(result.softExceeded).toBe(false);
      expect(result.warningExceeded).toBe(false);
      expect(result.actionExceeded).toBe(false);
      expect(result.pressure).toBeLessThan(0.70);
    });

    it('reports soft threshold exceeded at 70%', () => {
      // Need pressure >= 0.70. numCtx=1000. 0.70 * 1000 = 700 tokens. 700 * 3.5 = 2450 chars.
      const result = checkContextPressure(2450, 0, 1000, config);
      expect(result.softExceeded).toBe(true);
      expect(result.warningExceeded).toBe(false); // 0.70 < 0.80
      expect(result.actionExceeded).toBe(false);  // 0.70 < 0.85
    });

    it('reports warning threshold exceeded at 80%', () => {
      // Need pressure >= 0.80. numCtx=1000. 0.80 * 1000 = 800 tokens. 800 * 3.5 = 2800 chars.
      const result = checkContextPressure(2800, 0, 1000, config);
      expect(result.softExceeded).toBe(true);
      expect(result.warningExceeded).toBe(true);
      expect(result.actionExceeded).toBe(false);  // 0.80 < 0.85
    });

    it('reports all thresholds exceeded at 85%+', () => {
      // Need pressure >= 0.85. numCtx=1000. 0.85 * 1000 = 850 tokens. 850 * 3.5 = 2975 chars.
      const result = checkContextPressure(2975, 0, 1000, config);
      expect(result.softExceeded).toBe(true);
      expect(result.warningExceeded).toBe(true);
      expect(result.actionExceeded).toBe(true);
    });

    it('combines prompt and system prompt lengths', () => {
      // 1400 prompt + 1400 system = 2800 chars → 800 tokens. numCtx=1000 → pressure=0.80
      const result = checkContextPressure(1400, 1400, 1000, config);
      expect(result.estimatedTokens).toBe(800);
      expect(result.warningExceeded).toBe(true);
    });
  });

  describe('buildPressureWarning', () => {
    it('includes usage percentage and remaining tokens', () => {
      const warning = buildPressureWarning({
        pressure: 0.75,
        estimatedTokens: 750,
        numCtx: 1000,
        softExceeded: true,
        warningExceeded: false,
        actionExceeded: false,
      });
      expect(warning).toContain('75%');
      expect(warning).toContain('250');
      expect(warning).toContain('Context budget');
    });

    it('uses critical language when action threshold exceeded', () => {
      const warning = buildPressureWarning({
        pressure: 0.90,
        estimatedTokens: 900,
        numCtx: 1000,
        softExceeded: true,
        warningExceeded: true,
        actionExceeded: true,
      });
      expect(warning).toContain('CRITICAL');
      expect(warning).toContain('90%');
    });
  });

  describe('compressPrompt', () => {
    it('returns uncompressed when under target tokens', () => {
      const prompt = 'short prompt';
      const result = compressPrompt(prompt, 10000);
      expect(result.applied).toBe(false);
      expect(result.compressed).toBe(prompt);
    });

    it('returns uncompressed when too few sections', () => {
      const prompt = 'section1\n\nsection2\n\nsection3';
      const result = compressPrompt(prompt, 1); // target very low, but < 6 sections
      expect(result.applied).toBe(false);
    });

    it('compresses by removing middle sections', () => {
      // 6+ sections needed for compression
      const sections = Array.from({ length: 10 }, (_, i) => `Section ${i}: ${'x'.repeat(100)}`);
      const prompt = sections.join('\n\n');
      const result = compressPrompt(prompt, 1); // very low target to force compression

      expect(result.applied).toBe(true);
      // Should keep first 2 and last 3 sections
      expect(result.compressed).toContain('Section 0');
      expect(result.compressed).toContain('Section 1');
      expect(result.compressed).toContain('Section 7');
      expect(result.compressed).toContain('Section 8');
      expect(result.compressed).toContain('Section 9');
      // Middle sections should be removed
      expect(result.compressed).not.toContain('Section 3');
      expect(result.compressed).not.toContain('Section 5');
      // Should contain compression marker
      expect(result.compressed).toContain('compressed due to context pressure');
    });

    it('does not compress with exactly 5 sections (needs 6+)', () => {
      const sections = Array.from({ length: 5 }, (_, i) => `Section ${i}: ${'x'.repeat(100)}`);
      const prompt = sections.join('\n\n');
      const result = compressPrompt(prompt, 1);
      expect(result.applied).toBe(false);
    });

    it('compresses with exactly 6 sections', () => {
      const sections = Array.from({ length: 6 }, (_, i) => `Section ${i}: ${'x'.repeat(100)}`);
      const prompt = sections.join('\n\n');
      const result = compressPrompt(prompt, 1);
      expect(result.applied).toBe(true);
      expect(result.compressed).toContain('1 earlier sections compressed');
    });
  });
});
