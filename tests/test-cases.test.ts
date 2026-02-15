import { describe, expect, it } from 'vitest';

import {
  BUILT_IN_TEST_CASES,
  getTestCasesByTag,
  getTestCaseById,
  getAllTestCases,
} from '../src/testing/test-cases.js';

// ═══════════════════════════════════════════════════════════════════════════════
// BUILT_IN_TEST_CASES — structure
// ═══════════════════════════════════════════════════════════════════════════════

describe('BUILT_IN_TEST_CASES — structure', () => {
  it('has test cases', () => {
    expect(BUILT_IN_TEST_CASES.length).toBeGreaterThan(0);
  });

  it('every case has a unique ID', () => {
    const ids = BUILT_IN_TEST_CASES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every case has required fields', () => {
    for (const tc of BUILT_IN_TEST_CASES) {
      expect(tc.id).toBeTruthy();
      expect(tc.name).toBeTruthy();
      expect(tc.description).toBeTruthy();
      expect(tc.input).toBeTruthy();
      expect(tc.expected).toBeDefined();
    }
  });

  it('every case has tags array', () => {
    for (const tc of BUILT_IN_TEST_CASES) {
      expect(Array.isArray(tc.tags)).toBe(true);
      expect(tc.tags!.length).toBeGreaterThan(0);
    }
  });

  it('IDs follow category-number pattern', () => {
    for (const tc of BUILT_IN_TEST_CASES) {
      expect(tc.id).toMatch(/^[a-z]+-\d{3}$/);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// BUILT_IN_TEST_CASES — coverage
// ═══════════════════════════════════════════════════════════════════════════════

describe('BUILT_IN_TEST_CASES — coverage', () => {
  it('has basic tests', () => {
    const basic = BUILT_IN_TEST_CASES.filter((tc) => tc.tags?.includes('basic'));
    expect(basic.length).toBeGreaterThan(0);
  });

  it('has safety tests', () => {
    const safety = BUILT_IN_TEST_CASES.filter((tc) => tc.tags?.includes('safety'));
    expect(safety.length).toBeGreaterThan(0);
  });

  it('has tool tests', () => {
    const tools = BUILT_IN_TEST_CASES.filter((tc) => tc.tags?.includes('tools'));
    expect(tools.length).toBeGreaterThan(0);
  });

  it('has sensitive data tests', () => {
    const sensitive = BUILT_IN_TEST_CASES.filter((tc) => tc.tags?.includes('sensitive'));
    expect(sensitive.length).toBeGreaterThan(0);
  });

  it('has edge case tests', () => {
    const edge = BUILT_IN_TEST_CASES.filter((tc) => tc.tags?.includes('edge-case'));
    expect(edge.length).toBeGreaterThan(0);
  });

  it('has performance tests', () => {
    const perf = BUILT_IN_TEST_CASES.filter((tc) => tc.tags?.includes('performance'));
    expect(perf.length).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// getTestCasesByTag
// ═══════════════════════════════════════════════════════════════════════════════

describe('getTestCasesByTag', () => {
  it('returns cases matching tag', () => {
    const cases = getTestCasesByTag('basic');
    expect(cases.length).toBeGreaterThan(0);
    expect(cases.every((tc) => tc.tags?.includes('basic'))).toBe(true);
  });

  it('returns empty for nonexistent tag', () => {
    const cases = getTestCasesByTag('nonexistent-tag-xyz');
    expect(cases).toEqual([]);
  });

  it('excludes skipped cases', () => {
    // All built-in cases currently have skip=undefined, so all should be returned
    const all = getTestCasesByTag('basic');
    expect(all.every((tc) => !tc.skip)).toBe(true);
  });

  it('returns safety cases', () => {
    const safety = getTestCasesByTag('safety');
    expect(safety.length).toBeGreaterThanOrEqual(2);
  });

  it('returns tool cases', () => {
    const tools = getTestCasesByTag('tools');
    expect(tools.length).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// getTestCaseById
// ═══════════════════════════════════════════════════════════════════════════════

describe('getTestCaseById', () => {
  it('returns case by ID', () => {
    const tc = getTestCaseById('basic-001');
    expect(tc).toBeDefined();
    expect(tc!.id).toBe('basic-001');
    expect(tc!.name).toBeTruthy();
  });

  it('returns undefined for nonexistent ID', () => {
    expect(getTestCaseById('nonexistent-999')).toBeUndefined();
  });

  it('finds tool test case', () => {
    const tc = getTestCaseById('tool-001');
    expect(tc).toBeDefined();
    expect(tc!.expected.shouldCallTools).toBe(true);
  });

  it('finds safety test case', () => {
    const tc = getTestCaseById('safety-001');
    expect(tc).toBeDefined();
    expect(tc!.tags).toContain('safety');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// getAllTestCases
// ═══════════════════════════════════════════════════════════════════════════════

describe('getAllTestCases', () => {
  it('returns all non-skipped cases', () => {
    const all = getAllTestCases();
    expect(all.length).toBe(BUILT_IN_TEST_CASES.filter((tc) => !tc.skip).length);
  });

  it('excludes skipped cases', () => {
    const all = getAllTestCases();
    expect(all.every((tc) => !tc.skip)).toBe(true);
  });

  it('returns cases in order', () => {
    const all = getAllTestCases();
    expect(all[0]!.id).toBe(BUILT_IN_TEST_CASES[0]!.id);
  });
});
