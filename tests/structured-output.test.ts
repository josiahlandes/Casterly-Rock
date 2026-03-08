import { describe, expect, it } from 'vitest';
import { TRIAGE_FORMAT_SCHEMA, parseTriageResponse } from '../src/dual-loop/triage-prompt.js';
import { REVIEW_FORMAT_SCHEMA, parseReviewResponse } from '../src/dual-loop/review-prompt.js';

// ─────────────────────────────────────────────────────────────────────────────
// Triage Format Schema
// ─────────────────────────────────────────────────────────────────────────────

describe('TRIAGE_FORMAT_SCHEMA', () => {
  it('has correct required fields', () => {
    expect(TRIAGE_FORMAT_SCHEMA.required).toEqual(['classification', 'confidence', 'triageNotes']);
  });

  it('defines classification as an enum', () => {
    const props = TRIAGE_FORMAT_SCHEMA.properties as Record<string, Record<string, unknown>>;
    expect(props['classification']!['enum']).toEqual(['simple', 'complex', 'conversational', 'system_inquiry']);
  });

  it('defines confidence as a number', () => {
    const props = TRIAGE_FORMAT_SCHEMA.properties as Record<string, Record<string, unknown>>;
    expect(props['confidence']!['type']).toBe('number');
  });

  it('does not require directResponse', () => {
    const required = TRIAGE_FORMAT_SCHEMA.required as string[];
    expect(required).not.toContain('directResponse');
  });
});

describe('parseTriageResponse with structured output', () => {
  it('parses valid JSON from structured output (no markdown wrapping)', () => {
    const json = JSON.stringify({
      classification: 'simple',
      confidence: 0.95,
      triageNotes: '',
      directResponse: 'The answer is 42.',
    });

    const result = parseTriageResponse(json);
    expect(result.classification).toBe('simple');
    expect(result.confidence).toBe(0.95);
    expect(result.directResponse).toBe('The answer is 42.');
  });

  it('handles complex classification', () => {
    const json = JSON.stringify({
      classification: 'complex',
      confidence: 0.8,
      triageNotes: 'Multi-file refactoring needed',
    });

    const result = parseTriageResponse(json);
    expect(result.classification).toBe('complex');
    expect(result.triageNotes).toBe('Multi-file refactoring needed');
  });

  it('falls back to complex on parse failure', () => {
    const result = parseTriageResponse('not json at all');
    expect(result.classification).toBe('complex');
    expect(result.confidence).toBe(0.0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Review Format Schema
// ─────────────────────────────────────────────────────────────────────────────

describe('REVIEW_FORMAT_SCHEMA', () => {
  it('has correct required fields', () => {
    expect(REVIEW_FORMAT_SCHEMA.required).toEqual(['result', 'notes']);
  });

  it('defines result as an enum', () => {
    const props = REVIEW_FORMAT_SCHEMA.properties as Record<string, Record<string, unknown>>;
    expect(props['result']!['enum']).toEqual(['approved', 'changes_requested', 'rejected']);
  });

  it('does not require feedback', () => {
    const required = REVIEW_FORMAT_SCHEMA.required as string[];
    expect(required).not.toContain('feedback');
  });
});

describe('parseReviewResponse with structured output', () => {
  it('parses approved review', () => {
    const json = JSON.stringify({
      result: 'approved',
      notes: 'Code looks good.',
    });

    const result = parseReviewResponse(json);
    expect(result.result).toBe('approved');
    expect(result.notes).toBe('Code looks good.');
    expect(result.feedback).toBeUndefined();
  });

  it('parses changes_requested with feedback', () => {
    const json = JSON.stringify({
      result: 'changes_requested',
      notes: 'Missing null check',
      feedback: 'Add a null check on line 42',
    });

    const result = parseReviewResponse(json);
    expect(result.result).toBe('changes_requested');
    expect(result.feedback).toBe('Add a null check on line 42');
  });

  it('falls back to approved on parse failure (prevents phantom rejection loops)', () => {
    const result = parseReviewResponse('not valid json');
    expect(result.result).toBe('approved');
  });
});
