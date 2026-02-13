import { describe, expect, it } from 'vitest';

import {
  parseTimeSpec,
  createScheduledJob,
  redactJobDescription,
  generateJobId,
} from '../src/scheduler/trigger.js';

// ─── parseTimeSpec ──────────────────────────────────────────────────────────

describe('parseTimeSpec', () => {
  // Fixed reference time: Feb 12, 2026 10:00:00
  const now = new Date(2026, 1, 12, 10, 0, 0);

  describe('relative times', () => {
    it('parses "in 30 minutes"', () => {
      const result = parseTimeSpec('in 30 minutes', now);
      expect(result).toBe(now.getTime() + 30 * 60 * 1000);
    });

    it('parses "in 2 hours"', () => {
      const result = parseTimeSpec('in 2 hours', now);
      expect(result).toBe(now.getTime() + 2 * 60 * 60 * 1000);
    });

    it('parses "in 1 day"', () => {
      const result = parseTimeSpec('in 1 day', now);
      expect(result).toBe(now.getTime() + 24 * 60 * 60 * 1000);
    });

    it('parses singular "in 1 minute"', () => {
      const result = parseTimeSpec('in 1 minute', now);
      expect(result).toBe(now.getTime() + 60 * 1000);
    });
  });

  describe('time only', () => {
    it('parses "3pm" (future today)', () => {
      const result = parseTimeSpec('3pm', now);
      expect(result).not.toBeNull();
      const date = new Date(result!);
      expect(date.getHours()).toBe(15);
      expect(date.getMinutes()).toBe(0);
      expect(date.getDate()).toBe(12); // Same day (3pm > 10am)
    });

    it('parses "8am" (past today → tomorrow)', () => {
      const result = parseTimeSpec('8am', now);
      expect(result).not.toBeNull();
      const date = new Date(result!);
      expect(date.getHours()).toBe(8);
      expect(date.getDate()).toBe(13); // Tomorrow (8am < 10am)
    });

    it('parses "15:00"', () => {
      const result = parseTimeSpec('15:00', now);
      expect(result).not.toBeNull();
      const date = new Date(result!);
      expect(date.getHours()).toBe(15);
      expect(date.getMinutes()).toBe(0);
    });

    it('parses "3:30 PM"', () => {
      const result = parseTimeSpec('3:30 PM', now);
      expect(result).not.toBeNull();
      const date = new Date(result!);
      expect(date.getHours()).toBe(15);
      expect(date.getMinutes()).toBe(30);
    });

    it('parses "12pm" as noon', () => {
      const result = parseTimeSpec('12pm', now);
      expect(result).not.toBeNull();
      const date = new Date(result!);
      expect(date.getHours()).toBe(12);
    });

    it('parses "12am" as midnight', () => {
      const result = parseTimeSpec('12am', now);
      expect(result).not.toBeNull();
      const date = new Date(result!);
      expect(date.getHours()).toBe(0);
    });
  });

  describe('tomorrow', () => {
    it('parses "tomorrow at 9am"', () => {
      const result = parseTimeSpec('tomorrow at 9am', now);
      expect(result).not.toBeNull();
      const date = new Date(result!);
      expect(date.getDate()).toBe(13);
      expect(date.getHours()).toBe(9);
      expect(date.getMinutes()).toBe(0);
    });

    it('parses "tomorrow at 3:30pm"', () => {
      const result = parseTimeSpec('tomorrow at 3:30pm', now);
      expect(result).not.toBeNull();
      const date = new Date(result!);
      expect(date.getDate()).toBe(13);
      expect(date.getHours()).toBe(15);
      expect(date.getMinutes()).toBe(30);
    });
  });

  describe('ISO 8601', () => {
    it('parses ISO datetime', () => {
      const result = parseTimeSpec('2026-02-15T14:30:00', now);
      expect(result).not.toBeNull();
      const date = new Date(result!);
      expect(date.getFullYear()).toBe(2026);
      expect(date.getMonth()).toBe(1); // February
      expect(date.getDate()).toBe(15);
    });
  });

  describe('invalid inputs', () => {
    it('returns null for unparseable text', () => {
      expect(parseTimeSpec('sometime next week', now)).toBeNull();
    });

    it('returns null for empty string', () => {
      expect(parseTimeSpec('', now)).toBeNull();
    });

    it('returns null for random text', () => {
      expect(parseTimeSpec('hello world', now)).toBeNull();
    });
  });
});

// ─── redactJobDescription ───────────────────────────────────────────────────

describe('redactJobDescription', () => {
  it('keeps short messages as-is', () => {
    expect(redactJobDescription('Call dentist')).toBe('Call dentist');
  });

  it('truncates long messages', () => {
    const long = 'x'.repeat(200);
    const result = redactJobDescription(long);
    expect(result.length).toBeLessThan(200);
    expect(result).toContain('[truncated]');
  });
});

// ─── generateJobId ──────────────────────────────────────────────────────────

describe('generateJobId', () => {
  it('returns a string starting with "job-"', () => {
    expect(generateJobId()).toMatch(/^job-/);
  });

  it('generates unique IDs', () => {
    const ids = new Set(Array.from({ length: 10 }, () => generateJobId()));
    expect(ids.size).toBe(10);
  });
});

// ─── createScheduledJob ─────────────────────────────────────────────────────

describe('createScheduledJob', () => {
  it('creates a one-shot job from fireAt', () => {
    const result = createScheduledJob(
      { message: 'Call dentist', fireAt: 'in 30 minutes', label: 'dentist' },
      '+1555000000'
    );

    expect(result.success).toBe(true);
    expect(result.job).toBeDefined();
    expect(result.job!.triggerType).toBe('one_shot');
    expect(result.job!.recipient).toBe('+1555000000');
    expect(result.job!.label).toBe('dentist');
    expect(result.job!.fireAt).toBeGreaterThan(Date.now());
  });

  it('creates a cron job from cronExpression', () => {
    const result = createScheduledJob(
      { message: 'Weekly summary', cronExpression: '0 9 * * 1' },
      '+1555000000'
    );

    expect(result.success).toBe(true);
    expect(result.job).toBeDefined();
    expect(result.job!.triggerType).toBe('cron');
    expect(result.job!.cronExpression).toBe('0 9 * * 1');
    expect(result.job!.nextFireTime).toBeGreaterThan(Date.now());
  });

  it('rejects empty message', () => {
    const result = createScheduledJob(
      { message: '' },
      '+1555000000'
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('required');
  });

  it('rejects missing fireAt and cronExpression', () => {
    const result = createScheduledJob(
      { message: 'Call dentist' },
      '+1555000000'
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('Either fireAt or cronExpression');
  });

  it('rejects both fireAt and cronExpression', () => {
    const result = createScheduledJob(
      { message: 'Call dentist', fireAt: 'in 30 minutes', cronExpression: '0 9 * * 1' },
      '+1555000000'
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('not both');
  });

  it('rejects unparseable fireAt', () => {
    const result = createScheduledJob(
      { message: 'Call dentist', fireAt: 'sometime' },
      '+1555000000'
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('Cannot parse');
  });

  it('rejects invalid cron expression', () => {
    const result = createScheduledJob(
      { message: 'Test', cronExpression: 'invalid' },
      '+1555000000'
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid cron');
  });
});
