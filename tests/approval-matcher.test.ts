import { describe, expect, it } from 'vitest';

import { parseApprovalResponse, type ApprovalAnswer } from '../src/approval/matcher.js';

// ─── Approve keywords ─────────────────────────────────────────────────────────

describe('parseApprovalResponse — approve', () => {
  const approveInputs = [
    'yes', 'y', 'yep', 'yeah', 'yup',
    'approve', 'approved',
    'go ahead', 'do it', 'proceed', 'go for it',
    'ok', 'okay', 'sure',
  ];

  for (const input of approveInputs) {
    it(`"${input}" → approve`, () => {
      expect(parseApprovalResponse(input)).toBe('approve');
    });
  }

  it('is case insensitive', () => {
    expect(parseApprovalResponse('YES')).toBe('approve');
    expect(parseApprovalResponse('Yes')).toBe('approve');
    expect(parseApprovalResponse('Go Ahead')).toBe('approve');
  });

  it('strips trailing punctuation', () => {
    expect(parseApprovalResponse('yes!')).toBe('approve');
    expect(parseApprovalResponse('yes.')).toBe('approve');
    expect(parseApprovalResponse('ok!!')).toBe('approve');
  });

  it('trims whitespace', () => {
    expect(parseApprovalResponse('  yes  ')).toBe('approve');
    expect(parseApprovalResponse(' ok ')).toBe('approve');
  });
});

// ─── Deny keywords ────────────────────────────────────────────────────────────

describe('parseApprovalResponse — deny', () => {
  const denyInputs = [
    'no', 'n', 'nah', 'nope',
    'deny', 'denied',
    'cancel', 'abort', 'stop',
    "don't", 'dont',
    'reject',
  ];

  for (const input of denyInputs) {
    it(`"${input}" → deny`, () => {
      expect(parseApprovalResponse(input)).toBe('deny');
    });
  }

  it('is case insensitive', () => {
    expect(parseApprovalResponse('NO')).toBe('deny');
    expect(parseApprovalResponse('No')).toBe('deny');
    expect(parseApprovalResponse('CANCEL')).toBe('deny');
  });

  it('strips trailing punctuation', () => {
    expect(parseApprovalResponse('no.')).toBe('deny');
    expect(parseApprovalResponse('nope!')).toBe('deny');
  });
});

// ─── Not answers ──────────────────────────────────────────────────────────────

describe('parseApprovalResponse — not_an_answer', () => {
  it('rejects empty string', () => {
    expect(parseApprovalResponse('')).toBe('not_an_answer');
  });

  it('rejects whitespace-only', () => {
    expect(parseApprovalResponse('   ')).toBe('not_an_answer');
  });

  it('rejects "maybe"', () => {
    expect(parseApprovalResponse('maybe')).toBe('not_an_answer');
  });

  it('rejects messages over 80 characters', () => {
    const long = 'yes '.repeat(25); // Well over 80 chars
    expect(parseApprovalResponse(long)).toBe('not_an_answer');
  });

  it('rejects messages containing question marks (blocklist)', () => {
    expect(parseApprovalResponse('yes?')).toBe('not_an_answer');
  });

  it('rejects messages containing "can you"', () => {
    expect(parseApprovalResponse('yes can you also check email')).toBe('not_an_answer');
  });

  it('rejects messages containing "could you"', () => {
    expect(parseApprovalResponse('ok could you do that first')).toBe('not_an_answer');
  });

  it('rejects messages containing "please"', () => {
    expect(parseApprovalResponse('yes please do that')).toBe('not_an_answer');
  });

  it('rejects messages containing "but"', () => {
    expect(parseApprovalResponse('yes but wait')).toBe('not_an_answer');
  });

  it('rejects messages containing "also"', () => {
    expect(parseApprovalResponse('ok also do this')).toBe('not_an_answer');
  });

  it('rejects random text', () => {
    expect(parseApprovalResponse('hello world')).toBe('not_an_answer');
  });

  it('rejects sentences that contain yes/no as substrings', () => {
    expect(parseApprovalResponse('yesterday was great')).toBe('not_an_answer');
  });

  it('rejects messages containing "however"', () => {
    expect(parseApprovalResponse('yes however I need something')).toBe('not_an_answer');
  });
});
