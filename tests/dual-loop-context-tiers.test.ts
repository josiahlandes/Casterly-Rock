import { describe, expect, it } from 'vitest';
import {
  selectFastTier,
  selectDeepTier,
  selectCoderTier,
  selectReviewTier,
  resolveNumCtx,
  buildProviderOptions,
  estimateTokens,
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
      // ~20000 chars → ~5714 tokens + 2000 buffer = 7714 > 6144, < 0.75 * 32768 = 24576
      expect(selectCoderTier(20000, config)).toBe('standard');
    });

    it('returns extended for large prompts', () => {
      // ~90000 chars → ~25714 tokens + 2000 buffer = 27714 > 24576
      expect(selectCoderTier(90000, config)).toBe('extended');
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
      expect(resolveNumCtx(DEFAULT_CONTEXT_TIERS.coder, 'extended')).toBe(131072);
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
});
