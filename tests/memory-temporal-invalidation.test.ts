import { describe, expect, it, beforeEach } from 'vitest';

import { TemporalInvalidation, createTemporalInvalidation } from '../src/autonomous/memory/temporal-invalidation.js';
import { resetTracer, initTracer } from '../src/autonomous/debug.js';

beforeEach(() => {
  resetTracer();
  initTracer({ enabled: false });
});

describe('TemporalInvalidation', () => {
  describe('register', () => {
    it('registers entries for tracking', () => {
      const ti = createTemporalInvalidation();
      ti.register({ id: 'entry-1', category: 'fact' });
      ti.register({ id: 'entry-2', category: 'opinion' });

      expect(ti.count()).toBe(2);
    });
  });

  describe('getFreshness', () => {
    it('returns 1.0 for freshly registered entries', () => {
      const ti = createTemporalInvalidation();
      ti.register({ id: 'entry-1', category: 'fact' });

      const freshness = ti.getFreshness('entry-1');
      expect(freshness).toBeCloseTo(1.0, 1);
    });

    it('returns null for unknown entries', () => {
      const ti = createTemporalInvalidation();
      expect(ti.getFreshness('unknown')).toBeNull();
    });

    it('returns lower freshness for old entries', () => {
      const ti = createTemporalInvalidation();
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      ti.register({
        id: 'old-entry',
        category: 'observation', // TTL: 30 days, linear
        createdAt: thirtyDaysAgo,
        lastAccessedAt: thirtyDaysAgo,
      });

      const freshness = ti.getFreshness('old-entry');
      expect(freshness).not.toBeNull();
      // After 30 days with linear decay on 30-day TTL, should be near 0
      expect(freshness!).toBeLessThan(0.1);
    });
  });

  describe('isExpired', () => {
    it('returns false for fresh entries', () => {
      const ti = createTemporalInvalidation();
      ti.register({ id: 'entry-1', category: 'fact' });
      expect(ti.isExpired('entry-1')).toBe(false);
    });

    it('returns true for entries past TTL', () => {
      const ti = createTemporalInvalidation();
      const longAgo = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString();
      ti.register({
        id: 'old-entry',
        category: 'working_note', // TTL: 7 days
        createdAt: longAgo,
        lastAccessedAt: longAgo,
      });

      expect(ti.isExpired('old-entry')).toBe(true);
    });
  });

  describe('recordAccess', () => {
    it('resets expiry for access-resettable categories', () => {
      const ti = createTemporalInvalidation();
      const oldDate = new Date(Date.now() - 89 * 24 * 60 * 60 * 1000).toISOString();
      ti.register({
        id: 'fact-1',
        category: 'fact', // TTL: 90 days, access resets
        createdAt: oldDate,
        lastAccessedAt: oldDate,
      });

      // Almost expired
      const beforeAccess = ti.getFreshness('fact-1');
      expect(beforeAccess!).toBeLessThan(0.1);

      // Access resets the clock
      ti.recordAccess('fact-1');
      const afterAccess = ti.getFreshness('fact-1');
      expect(afterAccess!).toBeCloseTo(1.0, 1);
    });
  });

  describe('sweep', () => {
    it('identifies expired entries', () => {
      const ti = createTemporalInvalidation();
      const longAgo = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString();

      ti.register({ id: 'fresh', category: 'fact' });
      ti.register({
        id: 'expired',
        category: 'working_note',
        createdAt: longAgo,
        lastAccessedAt: longAgo,
      });

      const report = ti.sweep();
      expect(report.evaluated).toBe(2);
      expect(report.fresh).toBeGreaterThanOrEqual(1);
      expect(report.deletionCandidates).toContain('expired');
    });
  });

  describe('getByCategory', () => {
    it('filters entries by category', () => {
      const ti = createTemporalInvalidation();
      ti.register({ id: 'a', category: 'fact' });
      ti.register({ id: 'b', category: 'opinion' });
      ti.register({ id: 'c', category: 'fact' });

      const facts = ti.getByCategory('fact');
      expect(facts).toHaveLength(2);
    });
  });

  describe('unregister', () => {
    it('removes entries from tracking', () => {
      const ti = createTemporalInvalidation();
      ti.register({ id: 'entry-1', category: 'fact' });
      expect(ti.count()).toBe(1);

      ti.unregister('entry-1');
      expect(ti.count()).toBe(0);
    });
  });
});
