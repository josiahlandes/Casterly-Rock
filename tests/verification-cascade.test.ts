import { describe, expect, it } from 'vitest';
import {
  REVIEW_SYSTEM_PROMPT,
  INTENT_REVIEW_SYSTEM_PROMPT,
  REVIEW_FORMAT_SCHEMA,
  buildReviewPrompt,
  buildIntentReviewPrompt,
  parseReviewResponse,
} from '../src/dual-loop/review-prompt.js';

// ─────────────────────────────────────────────────────────────────────────────
// REVIEW_SYSTEM_PROMPT (FastLoop)
// ─────────────────────────────────────────────────────────────────────────────

describe('REVIEW_SYSTEM_PROMPT (FastLoop)', () => {
  it('is a non-empty string', () => {
    expect(REVIEW_SYSTEM_PROMPT.length).toBeGreaterThan(100);
  });

  it('mentions correctness and security', () => {
    expect(REVIEW_SYSTEM_PROMPT).toContain('Correctness');
    expect(REVIEW_SYSTEM_PROMPT).toContain('Security');
  });

  it('includes JSON output format instructions', () => {
    expect(REVIEW_SYSTEM_PROMPT).toContain('approved');
    expect(REVIEW_SYSTEM_PROMPT).toContain('changes_requested');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// INTENT_REVIEW_SYSTEM_PROMPT (Phase 3)
// ─────────────────────────────────────────────────────────────────────────────

describe('INTENT_REVIEW_SYSTEM_PROMPT (Phase 3)', () => {
  it('is a non-empty string', () => {
    expect(INTENT_REVIEW_SYSTEM_PROMPT.length).toBeGreaterThan(100);
  });

  it('mentions tools (read_file, grep, glob)', () => {
    expect(INTENT_REVIEW_SYSTEM_PROMPT).toContain('read_file');
    expect(INTENT_REVIEW_SYSTEM_PROMPT).toContain('grep');
    expect(INTENT_REVIEW_SYSTEM_PROMPT).toContain('glob');
  });

  it('mentions that automated checks already passed', () => {
    expect(INTENT_REVIEW_SYSTEM_PROMPT).toContain('typecheck');
    expect(INTENT_REVIEW_SYSTEM_PROMPT).toContain('lint');
    expect(INTENT_REVIEW_SYSTEM_PROMPT).toContain('smoke tests');
  });

  it('focuses on intent matching', () => {
    expect(INTENT_REVIEW_SYSTEM_PROMPT).toContain('Intent Match');
  });

  it('tells reviewer NOT to check for type errors', () => {
    expect(INTENT_REVIEW_SYSTEM_PROMPT).toContain('DO NOT check');
  });

  it('defaults to approve when in doubt', () => {
    expect(INTENT_REVIEW_SYSTEM_PROMPT).toContain('When in doubt, approve');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// REVIEW_FORMAT_SCHEMA
// ─────────────────────────────────────────────────────────────────────────────

describe('REVIEW_FORMAT_SCHEMA', () => {
  it('is a valid JSON schema object', () => {
    expect(REVIEW_FORMAT_SCHEMA).toHaveProperty('type', 'object');
    expect(REVIEW_FORMAT_SCHEMA).toHaveProperty('properties');
    expect(REVIEW_FORMAT_SCHEMA).toHaveProperty('required');
  });

  it('includes result, notes, and feedback properties', () => {
    const props = REVIEW_FORMAT_SCHEMA['properties'] as Record<string, unknown>;
    expect(props).toHaveProperty('result');
    expect(props).toHaveProperty('notes');
    expect(props).toHaveProperty('feedback');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// buildIntentReviewPrompt
// ─────────────────────────────────────────────────────────────────────────────

describe('buildIntentReviewPrompt', () => {
  it('includes instructions to use tools', () => {
    const result = buildIntentReviewPrompt({
      plan: 'Build something',
      manifest: [],
    });
    expect(result).toContain('read_file');
    expect(result).toContain('grep');
    expect(result).toContain('glob');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// parseReviewResponse
// ─────────────────────────────────────────────────────────────────────────────

describe('parseReviewResponse', () => {
  it('fallback is approved on invalid JSON (prevents phantom rejection loops)', () => {
    const result = parseReviewResponse('not valid json at all');
    expect(result.result).toBe('approved');
    expect(result.notes).toContain('parse failure');
  });

  it('parses valid approved response', () => {
    const result = parseReviewResponse(JSON.stringify({
      result: 'approved',
      notes: 'Ship it',
    }));
    expect(result.result).toBe('approved');
    expect(result.notes).toBe('Ship it');
  });

  it('handles <think> tags from reasoner with thinking ON', () => {
    const response = `<think>
Analyzing the code carefully...
</think>
{"result": "changes_requested", "notes": "Missing edge case", "feedback": "Handle empty array"}`;
    const result = parseReviewResponse(response);
    expect(result.result).toBe('changes_requested');
    expect(result.feedback).toBe('Handle empty array');
  });
});
