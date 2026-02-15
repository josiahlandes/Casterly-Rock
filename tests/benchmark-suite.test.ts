import { describe, expect, it } from 'vitest';

import {
  BENCHMARK_SUITE,
  BENCHMARK_SUITE_ID,
  getBenchmarkCasesByCategory,
  getBenchmarkCasesByDifficulty,
} from '../src/benchmark/suite.js';
import type { BenchmarkCategory, BenchmarkDifficulty } from '../src/benchmark/types.js';

// ═══════════════════════════════════════════════════════════════════════════════
// BENCHMARK_SUITE — structure validation
// ═══════════════════════════════════════════════════════════════════════════════

describe('BENCHMARK_SUITE — structure', () => {
  it('has expected suite ID', () => {
    expect(BENCHMARK_SUITE_ID).toBe('casterly-v1');
  });

  it('contains 12 benchmark cases', () => {
    expect(BENCHMARK_SUITE).toHaveLength(12);
  });

  it('every case has a unique ID', () => {
    const ids = BENCHMARK_SUITE.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every case has required fields', () => {
    for (const c of BENCHMARK_SUITE) {
      expect(c.id).toBeTruthy();
      expect(c.name).toBeTruthy();
      expect(c.description).toBeTruthy();
      expect(c.input).toBeTruthy();
      expect(c.expected).toBeDefined();
      expect(c.difficulty).toBeTruthy();
      expect(c.category).toBeTruthy();
      expect(c.tags).toBeDefined();
      expect(Array.isArray(c.tags)).toBe(true);
    }
  });

  it('every case has at least one tag', () => {
    for (const c of BENCHMARK_SUITE) {
      expect(c.tags!.length).toBeGreaterThan(0);
    }
  });

  it('every case includes "benchmark" tag', () => {
    for (const c of BENCHMARK_SUITE) {
      expect(c.tags).toContain('benchmark');
    }
  });

  it('IDs follow bench-{difficulty}-{number} pattern', () => {
    for (const c of BENCHMARK_SUITE) {
      expect(c.id).toMatch(/^bench-(trivial|simple|moderate|complex|expert)-\d{3}$/);
    }
  });

  it('case difficulty matches ID prefix', () => {
    for (const c of BENCHMARK_SUITE) {
      expect(c.id).toContain(c.difficulty);
    }
  });

  it('expected.shouldSucceed is true for all cases', () => {
    for (const c of BENCHMARK_SUITE) {
      expect(c.expected.shouldSucceed).toBe(true);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// BENCHMARK_SUITE — difficulty distribution
// ═══════════════════════════════════════════════════════════════════════════════

describe('BENCHMARK_SUITE — difficulty distribution', () => {
  it('has trivial cases', () => {
    const trivial = BENCHMARK_SUITE.filter((c) => c.difficulty === 'trivial');
    expect(trivial.length).toBe(3);
  });

  it('has simple cases', () => {
    const simple = BENCHMARK_SUITE.filter((c) => c.difficulty === 'simple');
    expect(simple.length).toBe(3);
  });

  it('has moderate cases', () => {
    const moderate = BENCHMARK_SUITE.filter((c) => c.difficulty === 'moderate');
    expect(moderate.length).toBe(3);
  });

  it('has complex cases', () => {
    const complex = BENCHMARK_SUITE.filter((c) => c.difficulty === 'complex');
    expect(complex.length).toBe(2);
  });

  it('has expert cases', () => {
    const expert = BENCHMARK_SUITE.filter((c) => c.difficulty === 'expert');
    expect(expert.length).toBe(1);
  });

  it('covers all 5 difficulty levels', () => {
    const difficulties = new Set(BENCHMARK_SUITE.map((c) => c.difficulty));
    expect(difficulties.size).toBe(5);
    expect(difficulties).toContain('trivial');
    expect(difficulties).toContain('simple');
    expect(difficulties).toContain('moderate');
    expect(difficulties).toContain('complex');
    expect(difficulties).toContain('expert');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// BENCHMARK_SUITE — category distribution
// ═══════════════════════════════════════════════════════════════════════════════

describe('BENCHMARK_SUITE — category distribution', () => {
  it('has conversation cases', () => {
    const conv = BENCHMARK_SUITE.filter((c) => c.category === 'conversation');
    expect(conv.length).toBeGreaterThanOrEqual(1);
  });

  it('has tool_use cases', () => {
    const toolUse = BENCHMARK_SUITE.filter((c) => c.category === 'tool_use');
    expect(toolUse.length).toBeGreaterThanOrEqual(1);
  });

  it('has knowledge cases', () => {
    const know = BENCHMARK_SUITE.filter((c) => c.category === 'knowledge');
    expect(know.length).toBeGreaterThanOrEqual(1);
  });

  it('has multi_step cases', () => {
    const multi = BENCHMARK_SUITE.filter((c) => c.category === 'multi_step');
    expect(multi.length).toBeGreaterThanOrEqual(1);
  });

  it('has safety cases', () => {
    const safety = BENCHMARK_SUITE.filter((c) => c.category === 'safety');
    expect(safety.length).toBeGreaterThanOrEqual(1);
  });

  it('has planning cases', () => {
    const planning = BENCHMARK_SUITE.filter((c) => c.category === 'planning');
    expect(planning.length).toBeGreaterThanOrEqual(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// getBenchmarkCasesByCategory
// ═══════════════════════════════════════════════════════════════════════════════

describe('getBenchmarkCasesByCategory', () => {
  it('returns only conversation cases', () => {
    const cases = getBenchmarkCasesByCategory('conversation');
    expect(cases.length).toBeGreaterThan(0);
    expect(cases.every((c) => c.category === 'conversation')).toBe(true);
  });

  it('returns only tool_use cases', () => {
    const cases = getBenchmarkCasesByCategory('tool_use');
    expect(cases.length).toBeGreaterThan(0);
    expect(cases.every((c) => c.category === 'tool_use')).toBe(true);
  });

  it('returns only safety cases', () => {
    const cases = getBenchmarkCasesByCategory('safety');
    expect(cases.length).toBeGreaterThan(0);
    expect(cases.every((c) => c.category === 'safety')).toBe(true);
  });

  it('returns only multi_step cases', () => {
    const cases = getBenchmarkCasesByCategory('multi_step');
    expect(cases.length).toBeGreaterThan(0);
    expect(cases.every((c) => c.category === 'multi_step')).toBe(true);
  });

  it('returns only knowledge cases', () => {
    const cases = getBenchmarkCasesByCategory('knowledge');
    expect(cases.length).toBeGreaterThan(0);
    expect(cases.every((c) => c.category === 'knowledge')).toBe(true);
  });

  it('returns only planning cases', () => {
    const cases = getBenchmarkCasesByCategory('planning');
    expect(cases.length).toBeGreaterThan(0);
    expect(cases.every((c) => c.category === 'planning')).toBe(true);
  });

  it('returns empty array for unused category', () => {
    const cases = getBenchmarkCasesByCategory('coding');
    expect(cases).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// getBenchmarkCasesByDifficulty
// ═══════════════════════════════════════════════════════════════════════════════

describe('getBenchmarkCasesByDifficulty', () => {
  it('returns only trivial cases', () => {
    const cases = getBenchmarkCasesByDifficulty('trivial');
    expect(cases.length).toBe(3);
    expect(cases.every((c) => c.difficulty === 'trivial')).toBe(true);
  });

  it('returns only simple cases', () => {
    const cases = getBenchmarkCasesByDifficulty('simple');
    expect(cases.length).toBe(3);
    expect(cases.every((c) => c.difficulty === 'simple')).toBe(true);
  });

  it('returns only moderate cases', () => {
    const cases = getBenchmarkCasesByDifficulty('moderate');
    expect(cases.length).toBe(3);
    expect(cases.every((c) => c.difficulty === 'moderate')).toBe(true);
  });

  it('returns only complex cases', () => {
    const cases = getBenchmarkCasesByDifficulty('complex');
    expect(cases.length).toBe(2);
    expect(cases.every((c) => c.difficulty === 'complex')).toBe(true);
  });

  it('returns only expert cases', () => {
    const cases = getBenchmarkCasesByDifficulty('expert');
    expect(cases.length).toBe(1);
    expect(cases.every((c) => c.difficulty === 'expert')).toBe(true);
  });

  it('returns empty for nonexistent difficulty', () => {
    const cases = getBenchmarkCasesByDifficulty('impossible' as BenchmarkDifficulty);
    expect(cases).toEqual([]);
  });
});
