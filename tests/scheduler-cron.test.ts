import { describe, expect, it } from 'vitest';

import {
  parseCronExpression,
  isValidCronExpression,
  getNextFireTime,
  type CronParts,
} from '../src/scheduler/cron.js';

// ─── parseCronExpression ────────────────────────────────────────────────────

describe('parseCronExpression', () => {
  it('parses every-minute wildcard', () => {
    const parts = parseCronExpression('* * * * *');
    expect(parts).not.toBeNull();
    expect(parts!.minutes.size).toBe(60);
    expect(parts!.hours.size).toBe(24);
  });

  it('parses specific values: 0 9 * * 1 (Monday 9am)', () => {
    const parts = parseCronExpression('0 9 * * 1');
    expect(parts).not.toBeNull();
    expect(parts!.minutes).toEqual(new Set([0]));
    expect(parts!.hours).toEqual(new Set([9]));
    expect(parts!.daysOfWeek).toEqual(new Set([1]));
  });

  it('parses step values: */15 * * * *', () => {
    const parts = parseCronExpression('*/15 * * * *');
    expect(parts).not.toBeNull();
    expect(parts!.minutes).toEqual(new Set([0, 15, 30, 45]));
  });

  it('parses ranges: 30 17 * * 1-5 (weekdays 5:30pm)', () => {
    const parts = parseCronExpression('30 17 * * 1-5');
    expect(parts).not.toBeNull();
    expect(parts!.minutes).toEqual(new Set([30]));
    expect(parts!.hours).toEqual(new Set([17]));
    expect(parts!.daysOfWeek).toEqual(new Set([1, 2, 3, 4, 5]));
  });

  it('parses comma lists: 0 8,12,18 * * *', () => {
    const parts = parseCronExpression('0 8,12,18 * * *');
    expect(parts).not.toBeNull();
    expect(parts!.hours).toEqual(new Set([8, 12, 18]));
  });

  it('parses range with step: 0-30/10 * * * *', () => {
    const parts = parseCronExpression('0-30/10 * * * *');
    expect(parts).not.toBeNull();
    expect(parts!.minutes).toEqual(new Set([0, 10, 20, 30]));
  });

  it('parses specific date: 0 0 1 1 * (Jan 1 midnight)', () => {
    const parts = parseCronExpression('0 0 1 1 *');
    expect(parts).not.toBeNull();
    expect(parts!.daysOfMonth).toEqual(new Set([1]));
    expect(parts!.months).toEqual(new Set([1]));
  });

  it('rejects too few fields', () => {
    expect(parseCronExpression('* * *')).toBeNull();
  });

  it('rejects too many fields', () => {
    expect(parseCronExpression('* * * * * *')).toBeNull();
  });

  it('rejects invalid text', () => {
    expect(parseCronExpression('invalid')).toBeNull();
  });

  it('rejects out-of-range hour (25)', () => {
    expect(parseCronExpression('0 25 * * *')).toBeNull();
  });

  it('rejects out-of-range minute (60)', () => {
    expect(parseCronExpression('60 * * * *')).toBeNull();
  });

  it('rejects out-of-range day-of-week (7)', () => {
    expect(parseCronExpression('* * * * 7')).toBeNull();
  });

  it('rejects empty string', () => {
    expect(parseCronExpression('')).toBeNull();
  });
});

// ─── isValidCronExpression ──────────────────────────────────────────────────

describe('isValidCronExpression', () => {
  it('returns true for valid expressions', () => {
    expect(isValidCronExpression('0 9 * * 1')).toBe(true);
    expect(isValidCronExpression('*/15 * * * *')).toBe(true);
  });

  it('returns false for invalid expressions', () => {
    expect(isValidCronExpression('invalid')).toBe(false);
    expect(isValidCronExpression('* * *')).toBe(false);
  });
});

// ─── getNextFireTime ────────────────────────────────────────────────────────

describe('getNextFireTime', () => {
  it('finds next Monday 9am from a Wednesday', () => {
    const cron = parseCronExpression('0 9 * * 1')!;
    // Wednesday Feb 12, 2026 10:00
    const after = new Date(2026, 1, 12, 10, 0, 0);
    const next = getNextFireTime(cron, after);

    expect(next.getDay()).toBe(1); // Monday
    expect(next.getHours()).toBe(9);
    expect(next.getMinutes()).toBe(0);
    // Should be Feb 16, 2026 (next Monday)
    expect(next.getDate()).toBe(16);
    expect(next.getMonth()).toBe(1); // February
  });

  it('finds next daily 8am occurrence (same day, before 8am)', () => {
    const cron = parseCronExpression('0 8 * * *')!;
    // Feb 12, 2026 7:00
    const after = new Date(2026, 1, 12, 7, 0, 0);
    const next = getNextFireTime(cron, after);

    expect(next.getDate()).toBe(12); // Same day
    expect(next.getHours()).toBe(8);
    expect(next.getMinutes()).toBe(0);
  });

  it('finds next daily 8am occurrence (same day, after 8am → next day)', () => {
    const cron = parseCronExpression('0 8 * * *')!;
    // Feb 12, 2026 9:00
    const after = new Date(2026, 1, 12, 9, 0, 0);
    const next = getNextFireTime(cron, after);

    expect(next.getDate()).toBe(13); // Next day
    expect(next.getHours()).toBe(8);
  });

  it('finds weekday 5:30pm from Friday 6pm → next Monday', () => {
    const cron = parseCronExpression('30 17 * * 1-5')!;
    // Friday Feb 13, 2026 18:00
    const after = new Date(2026, 1, 13, 18, 0, 0);
    const next = getNextFireTime(cron, after);

    expect(next.getDay()).toBe(1); // Monday
    expect(next.getHours()).toBe(17);
    expect(next.getMinutes()).toBe(30);
  });

  it('handles every 15 minutes', () => {
    const cron = parseCronExpression('*/15 * * * *')!;
    // Feb 12, 2026 10:07
    const after = new Date(2026, 1, 12, 10, 7, 0);
    const next = getNextFireTime(cron, after);

    expect(next.getMinutes()).toBe(15);
    expect(next.getHours()).toBe(10);
  });

  it('handles month boundary', () => {
    const cron = parseCronExpression('0 0 1 * *')!;
    // Jan 15, 2026
    const after = new Date(2026, 0, 15, 0, 0, 0);
    const next = getNextFireTime(cron, after);

    expect(next.getMonth()).toBe(1); // February
    expect(next.getDate()).toBe(1);
    expect(next.getHours()).toBe(0);
  });

  it('handles year rollover', () => {
    const cron = parseCronExpression('0 0 1 1 *')!;
    // Feb 1, 2026
    const after = new Date(2026, 1, 1, 0, 0, 0);
    const next = getNextFireTime(cron, after);

    expect(next.getFullYear()).toBe(2027);
    expect(next.getMonth()).toBe(0); // January
    expect(next.getDate()).toBe(1);
  });

  it('advances past the after time even if it matches', () => {
    const cron = parseCronExpression('0 9 * * *')!;
    // Exactly at 9:00 — next should be tomorrow
    const after = new Date(2026, 1, 12, 9, 0, 0);
    const next = getNextFireTime(cron, after);

    expect(next.getTime()).toBeGreaterThan(after.getTime());
  });
});
