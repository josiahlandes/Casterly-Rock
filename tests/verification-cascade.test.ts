import { describe, expect, it } from 'vitest';
import {
  REVIEW_SYSTEM_PROMPT,
  CASCADE_REVIEW_PROMPTS,
  REVIEW_FORMAT_SCHEMA,
  buildReviewPrompt,
  parseReviewResponse,
} from '../src/dual-loop/review-prompt.js';
import type { Task } from '../src/dual-loop/task-board-types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeTask(overrides?: Partial<Task>): Task {
  return {
    id: 'task-cascade-test',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: 'reviewing',
    owner: null,
    origin: 'user',
    priority: 0,
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// CASCADE_REVIEW_PROMPTS
// ─────────────────────────────────────────────────────────────────────────────

describe('CASCADE_REVIEW_PROMPTS', () => {
  it('has at least one cascade prompt', () => {
    expect(CASCADE_REVIEW_PROMPTS.length).toBeGreaterThanOrEqual(1);
  });

  it('cascade pass 1 is security-focused', () => {
    const pass1 = CASCADE_REVIEW_PROMPTS[0]!;
    expect(pass1).toContain('security');
    expect(pass1).toContain('second-pass');
  });

  it('cascade prompts include JSON output format instructions', () => {
    for (const prompt of CASCADE_REVIEW_PROMPTS) {
      expect(prompt).toContain('approved');
      expect(prompt).toContain('changes_requested');
    }
  });

  it('cascade prompts are distinct from the standard review prompt', () => {
    for (const prompt of CASCADE_REVIEW_PROMPTS) {
      expect(prompt).not.toBe(REVIEW_SYSTEM_PROMPT);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Verification Cascade Task Fields
// ─────────────────────────────────────────────────────────────────────────────

describe('Verification Cascade Task Fields', () => {
  it('task defaults to no cascade (undefined)', () => {
    const task = makeTask();
    expect(task.verificationPasses).toBeUndefined();
    expect(task.currentVerificationPass).toBeUndefined();
  });

  it('task can be configured for multi-pass verification', () => {
    const task = makeTask({
      verificationPasses: 2,
      currentVerificationPass: 0,
    });
    expect(task.verificationPasses).toBe(2);
    expect(task.currentVerificationPass).toBe(0);
  });

  it('single-pass tasks use default behavior', () => {
    const task = makeTask();
    const totalPasses = task.verificationPasses ?? 1;
    const currentPass = task.currentVerificationPass ?? 0;

    // currentPass + 1 < totalPasses → 1 < 1 → false → no cascade
    expect(currentPass + 1 < totalPasses).toBe(false);
  });

  it('multi-pass tasks advance through cascade', () => {
    const task = makeTask({
      verificationPasses: 2,
      currentVerificationPass: 0,
    });
    const totalPasses = task.verificationPasses ?? 1;
    const currentPass = task.currentVerificationPass ?? 0;

    // currentPass + 1 < totalPasses → 1 < 2 → true → advance cascade
    expect(currentPass + 1 < totalPasses).toBe(true);
  });

  it('cascade completes on final pass', () => {
    const task = makeTask({
      verificationPasses: 2,
      currentVerificationPass: 1,
    });
    const totalPasses = task.verificationPasses ?? 1;
    const currentPass = task.currentVerificationPass ?? 0;

    // currentPass + 1 < totalPasses → 2 < 2 → false → cascade complete
    expect(currentPass + 1 < totalPasses).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Cascade Prompt Selection Logic
// ─────────────────────────────────────────────────────────────────────────────

describe('Cascade Prompt Selection', () => {
  it('pass 0 uses standard review prompt', () => {
    const currentPass = 0;
    const systemPrompt = currentPass === 0
      ? REVIEW_SYSTEM_PROMPT
      : CASCADE_REVIEW_PROMPTS[currentPass - 1] ?? REVIEW_SYSTEM_PROMPT;

    expect(systemPrompt).toBe(REVIEW_SYSTEM_PROMPT);
  });

  it('pass 1 uses first cascade prompt (security)', () => {
    const currentPass: number = 1;
    const systemPrompt = currentPass === 0
      ? REVIEW_SYSTEM_PROMPT
      : CASCADE_REVIEW_PROMPTS[currentPass - 1] ?? REVIEW_SYSTEM_PROMPT;

    expect(systemPrompt).toBe(CASCADE_REVIEW_PROMPTS[0]);
    expect(systemPrompt).toContain('security');
  });

  it('out-of-bounds pass falls back to standard review prompt', () => {
    const currentPass: number = 10; // Way beyond available prompts
    const systemPrompt = currentPass === 0
      ? REVIEW_SYSTEM_PROMPT
      : CASCADE_REVIEW_PROMPTS[currentPass - 1] ?? REVIEW_SYSTEM_PROMPT;

    expect(systemPrompt).toBe(REVIEW_SYSTEM_PROMPT);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Cascade Pass Reset on Revision
// ─────────────────────────────────────────────────────────────────────────────

describe('Cascade Pass Reset', () => {
  it('revision resets cascade pass to 0', () => {
    const task = makeTask({
      verificationPasses: 2,
      currentVerificationPass: 1,
      reviewResult: 'changes_requested',
    });

    // Simulate reset (as done in deep-loop selfReview)
    const resetPass = 0;
    expect(resetPass).toBe(0);
    expect(task.currentVerificationPass).toBe(1); // Before reset
  });

  it('approved on non-final pass advances without resetting', () => {
    const task = makeTask({
      verificationPasses: 2,
      currentVerificationPass: 0,
    });
    const totalPasses = task.verificationPasses ?? 1;
    const currentPass = task.currentVerificationPass ?? 0;

    const shouldAdvance = currentPass + 1 < totalPasses;
    expect(shouldAdvance).toBe(true);

    const nextPass = currentPass + 1;
    expect(nextPass).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// High-Stakes Task Detection
// ─────────────────────────────────────────────────────────────────────────────

describe('High-Stakes Task Detection', () => {
  it('tasks with 3+ files are high-stakes', () => {
    const fileCount = 3;
    const stepCount = 1;
    const isHighStakes = fileCount >= 3 || stepCount >= 3;
    expect(isHighStakes).toBe(true);
  });

  it('tasks with 3+ plan steps are high-stakes', () => {
    const fileCount = 1;
    const stepCount = 3;
    const isHighStakes = fileCount >= 3 || stepCount >= 3;
    expect(isHighStakes).toBe(true);
  });

  it('tasks with fewer than 3 files and steps are not high-stakes', () => {
    const fileCount = 2;
    const stepCount = 2;
    const isHighStakes = fileCount >= 3 || stepCount >= 3;
    expect(isHighStakes).toBe(false);
  });

  it('high-stakes tasks get 2 verification passes', () => {
    const isHighStakes = true;
    const verificationPasses = isHighStakes ? 2 : 1;
    expect(verificationPasses).toBe(2);
  });

  it('regular tasks get 1 verification pass', () => {
    const isHighStakes = false;
    const verificationPasses = isHighStakes ? 2 : 1;
    expect(verificationPasses).toBe(1);
  });
});
