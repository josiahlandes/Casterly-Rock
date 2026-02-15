import { describe, expect, it } from 'vitest';

import {
  parseCronExpression,
  isValidCronExpression,
  getNextFireTime,
} from '../src/scheduler/cron.js';
import {
  generateJobId,
  redactJobDescription,
  parseTimeSpec,
  createScheduledJob,
} from '../src/scheduler/trigger.js';

// ═══════════════════════════════════════════════════════════════════════════════
// Cron — parseCronExpression
// ═══════════════════════════════════════════════════════════════════════════════

describe('parseCronExpression', () => {
  it('parses wildcard-only expression', () => {
    const cron = parseCronExpression('* * * * *');
    expect(cron).not.toBeNull();
    expect(cron!.minutes.size).toBe(60); // 0-59
    expect(cron!.hours.size).toBe(24);   // 0-23
    expect(cron!.daysOfMonth.size).toBe(31); // 1-31
    expect(cron!.months.size).toBe(12);  // 1-12
    expect(cron!.daysOfWeek.size).toBe(7); // 0-6
  });

  it('parses specific values', () => {
    const cron = parseCronExpression('30 8 15 6 3');
    expect(cron).not.toBeNull();
    expect(cron!.minutes.has(30)).toBe(true);
    expect(cron!.minutes.size).toBe(1);
    expect(cron!.hours.has(8)).toBe(true);
    expect(cron!.daysOfMonth.has(15)).toBe(true);
    expect(cron!.months.has(6)).toBe(true);
    expect(cron!.daysOfWeek.has(3)).toBe(true);
  });

  it('parses comma-separated values', () => {
    const cron = parseCronExpression('0,30 * * * *');
    expect(cron).not.toBeNull();
    expect(cron!.minutes.has(0)).toBe(true);
    expect(cron!.minutes.has(30)).toBe(true);
    expect(cron!.minutes.size).toBe(2);
  });

  it('parses ranges', () => {
    const cron = parseCronExpression('* 9-17 * * *');
    expect(cron).not.toBeNull();
    expect(cron!.hours.size).toBe(9); // 9,10,11,12,13,14,15,16,17
    expect(cron!.hours.has(9)).toBe(true);
    expect(cron!.hours.has(17)).toBe(true);
    expect(cron!.hours.has(8)).toBe(false);
  });

  it('parses step patterns with wildcard', () => {
    const cron = parseCronExpression('*/15 * * * *');
    expect(cron).not.toBeNull();
    expect(cron!.minutes.has(0)).toBe(true);
    expect(cron!.minutes.has(15)).toBe(true);
    expect(cron!.minutes.has(30)).toBe(true);
    expect(cron!.minutes.has(45)).toBe(true);
    expect(cron!.minutes.size).toBe(4);
  });

  it('parses step patterns with range', () => {
    const cron = parseCronExpression('0-30/10 * * * *');
    expect(cron).not.toBeNull();
    expect(cron!.minutes.has(0)).toBe(true);
    expect(cron!.minutes.has(10)).toBe(true);
    expect(cron!.minutes.has(20)).toBe(true);
    expect(cron!.minutes.has(30)).toBe(true);
    expect(cron!.minutes.size).toBe(4);
  });

  it('returns null for too few fields', () => {
    expect(parseCronExpression('* *')).toBeNull();
    expect(parseCronExpression('* * *')).toBeNull();
  });

  it('returns null for too many fields', () => {
    expect(parseCronExpression('* * * * * *')).toBeNull();
  });

  it('returns null for out-of-range values', () => {
    expect(parseCronExpression('60 * * * *')).toBeNull(); // minutes max is 59
    expect(parseCronExpression('* 24 * * *')).toBeNull(); // hours max is 23
    expect(parseCronExpression('* * 32 * *')).toBeNull(); // day max is 31
    expect(parseCronExpression('* * * 13 *')).toBeNull(); // month max is 12
    expect(parseCronExpression('* * * * 7')).toBeNull();  // day-of-week max is 6
  });

  it('returns null for invalid range (start > end)', () => {
    expect(parseCronExpression('30-10 * * * *')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(parseCronExpression('')).toBeNull();
  });

  it('returns null for step of 0', () => {
    expect(parseCronExpression('*/0 * * * *')).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Cron — isValidCronExpression
// ═══════════════════════════════════════════════════════════════════════════════

describe('isValidCronExpression', () => {
  it('returns true for valid expressions', () => {
    expect(isValidCronExpression('0 8 * * *')).toBe(true);
    expect(isValidCronExpression('*/5 * * * *')).toBe(true);
    expect(isValidCronExpression('0 0 1 1 *')).toBe(true);
  });

  it('returns false for invalid expressions', () => {
    expect(isValidCronExpression('invalid')).toBe(false);
    expect(isValidCronExpression('')).toBe(false);
    expect(isValidCronExpression('60 * * * *')).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Cron — getNextFireTime
// ═══════════════════════════════════════════════════════════════════════════════

describe('getNextFireTime', () => {
  it('returns next minute for * * * * *', () => {
    const cron = parseCronExpression('* * * * *')!;
    const now = new Date('2025-06-15T10:30:00');
    const next = getNextFireTime(cron, now);
    expect(next.getTime()).toBe(new Date('2025-06-15T10:31:00').getTime());
  });

  it('finds next hour match', () => {
    const cron = parseCronExpression('0 12 * * *')!; // noon every day
    const now = new Date('2025-06-15T10:00:00');
    const next = getNextFireTime(cron, now);
    expect(next.getHours()).toBe(12);
    expect(next.getMinutes()).toBe(0);
    expect(next.getDate()).toBe(15);
  });

  it('rolls to next day if past today', () => {
    const cron = parseCronExpression('0 8 * * *')!; // 8am daily
    const now = new Date('2025-06-15T09:00:00'); // after 8am
    const next = getNextFireTime(cron, now);
    expect(next.getHours()).toBe(8);
    expect(next.getDate()).toBe(16); // next day
  });

  it('handles every-15-minutes', () => {
    const cron = parseCronExpression('*/15 * * * *')!;
    const now = new Date('2025-06-15T10:02:00');
    const next = getNextFireTime(cron, now);
    expect(next.getMinutes()).toBe(15);
    expect(next.getHours()).toBe(10);
  });

  it('finds next matching day of week', () => {
    // Monday only (1)
    const cron = parseCronExpression('0 9 * * 1')!;
    const now = new Date('2025-06-15T10:00:00'); // Sunday
    const next = getNextFireTime(cron, now);
    expect(next.getDay()).toBe(1); // Monday
    expect(next.getHours()).toBe(9);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Trigger — generateJobId
// ═══════════════════════════════════════════════════════════════════════════════

describe('generateJobId', () => {
  it('starts with job-', () => {
    const id = generateJobId();
    expect(id.startsWith('job-')).toBe(true);
  });

  it('generates unique IDs', () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateJobId()));
    expect(ids.size).toBe(100);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Trigger — redactJobDescription
// ═══════════════════════════════════════════════════════════════════════════════

describe('redactJobDescription', () => {
  it('returns short messages unchanged', () => {
    expect(redactJobDescription('Check the weather')).toBe('Check the weather');
  });

  it('keeps messages at exactly 100 chars', () => {
    const msg = 'a'.repeat(100);
    expect(redactJobDescription(msg)).toBe(msg);
  });

  it('truncates messages over 100 chars', () => {
    const msg = 'a'.repeat(150);
    const result = redactJobDescription(msg);
    expect(result.length).toBeLessThan(150);
    expect(result).toContain('... [truncated]');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Trigger — parseTimeSpec
// ═══════════════════════════════════════════════════════════════════════════════

describe('parseTimeSpec', () => {
  const refDate = new Date('2025-06-15T10:00:00.000Z');

  it('parses "in N minutes"', () => {
    const result = parseTimeSpec('in 30 minutes', refDate);
    expect(result).toBe(refDate.getTime() + 30 * 60 * 1000);
  });

  it('parses "in N hours"', () => {
    const result = parseTimeSpec('in 2 hours', refDate);
    expect(result).toBe(refDate.getTime() + 2 * 60 * 60 * 1000);
  });

  it('parses "in N days"', () => {
    const result = parseTimeSpec('in 1 day', refDate);
    expect(result).toBe(refDate.getTime() + 24 * 60 * 60 * 1000);
  });

  it('parses "tomorrow at Xam"', () => {
    const result = parseTimeSpec('tomorrow at 9am', refDate);
    expect(result).not.toBeNull();
    const date = new Date(result!);
    expect(date.getDate()).toBe(16); // tomorrow
    expect(date.getHours()).toBe(9);
    expect(date.getMinutes()).toBe(0);
  });

  it('parses "tomorrow at X:MM pm"', () => {
    const result = parseTimeSpec('tomorrow at 3:30 PM', refDate);
    expect(result).not.toBeNull();
    const date = new Date(result!);
    expect(date.getDate()).toBe(16);
    expect(date.getHours()).toBe(15);
    expect(date.getMinutes()).toBe(30);
  });

  it('parses time-only "3pm"', () => {
    const result = parseTimeSpec('3pm', refDate);
    expect(result).not.toBeNull();
    const date = new Date(result!);
    expect(date.getHours()).toBe(15);
  });

  it('parses 24h time "15:00"', () => {
    const result = parseTimeSpec('15:00', refDate);
    expect(result).not.toBeNull();
    const date = new Date(result!);
    expect(date.getHours()).toBe(15);
    expect(date.getMinutes()).toBe(0);
  });

  it('parses ISO 8601', () => {
    const result = parseTimeSpec('2025-12-25T12:00:00', refDate);
    expect(result).not.toBeNull();
    const date = new Date(result!);
    expect(date.getMonth()).toBe(11); // December
    expect(date.getDate()).toBe(25);
  });

  it('returns null for unparseable input', () => {
    expect(parseTimeSpec('potato', refDate)).toBeNull();
    expect(parseTimeSpec('next tuesday', refDate)).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Trigger — createScheduledJob
// ═══════════════════════════════════════════════════════════════════════════════

describe('createScheduledJob', () => {
  it('creates a one-shot job', () => {
    const result = createScheduledJob(
      { message: 'Check the weather', fireAt: 'in 30 minutes' },
      '+1234567890',
    );
    expect(result.success).toBe(true);
    expect(result.job).toBeDefined();
    expect(result.job!.triggerType).toBe('one_shot');
    expect(result.job!.status).toBe('active');
    expect(result.job!.recipient).toBe('+1234567890');
    expect(result.job!.message).toBe('Check the weather');
    expect(result.job!.fireCount).toBe(0);
  });

  it('creates a cron job', () => {
    const result = createScheduledJob(
      { message: 'Daily standup', cronExpression: '0 9 * * 1-5' },
      '+1234567890',
    );
    expect(result.success).toBe(true);
    expect(result.job).toBeDefined();
    expect(result.job!.triggerType).toBe('cron');
    expect(result.job!.cronExpression).toBe('0 9 * * 1-5');
    expect(result.job!.nextFireTime).toBeDefined();
  });

  it('includes label when provided', () => {
    const result = createScheduledJob(
      { message: 'Reminder', fireAt: 'in 1 hour', label: 'My Label' },
      '+1234567890',
    );
    expect(result.success).toBe(true);
    expect(result.job!.label).toBe('My Label');
  });

  it('includes actionable flag', () => {
    const result = createScheduledJob(
      { message: 'Check weather', fireAt: 'in 1 hour', actionable: true },
      '+1234567890',
    );
    expect(result.success).toBe(true);
    expect(result.job!.actionable).toBe(true);
  });

  it('fails for empty message', () => {
    const result = createScheduledJob(
      { message: '', fireAt: 'in 1 hour' },
      '+1234567890',
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('Message is required');
  });

  it('fails when neither fireAt nor cronExpression provided', () => {
    const result = createScheduledJob(
      { message: 'Test' },
      '+1234567890',
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('Either fireAt or cronExpression');
  });

  it('fails when both fireAt and cronExpression provided', () => {
    const result = createScheduledJob(
      { message: 'Test', fireAt: 'in 1 hour', cronExpression: '* * * * *' },
      '+1234567890',
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('not both');
  });

  it('fails for unparseable fireAt', () => {
    const result = createScheduledJob(
      { message: 'Test', fireAt: 'potato time' },
      '+1234567890',
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('Cannot parse time');
  });

  it('fails for invalid cron expression', () => {
    const result = createScheduledJob(
      { message: 'Test', cronExpression: 'invalid' },
      '+1234567890',
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid cron expression');
  });

  it('sets source to user_request by default', () => {
    const result = createScheduledJob(
      { message: 'Test', fireAt: 'in 1 hour' },
      '+1234567890',
    );
    expect(result.job!.source).toBe('user_request');
  });

  it('allows custom source', () => {
    const result = createScheduledJob(
      { message: 'Test', fireAt: 'in 1 hour', source: 'system' },
      '+1234567890',
    );
    expect(result.job!.source).toBe('system');
  });
});
