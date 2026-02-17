import { describe, expect, it } from 'vitest';

import {
  AGENT_BENCHMARK_SUITE,
  AGENT_BENCHMARK_SUITE_ID,
  getAgentBenchmarkCasesByCategory,
  getAgentBenchmarkCasesByDifficulty,
} from '../src/benchmark/agent-suite.js';
import type { BenchmarkCategory, BenchmarkDifficulty } from '../src/benchmark/types.js';

// ═══════════════════════════════════════════════════════════════════════════════
// AGENT_BENCHMARK_SUITE — structure validation
// ═══════════════════════════════════════════════════════════════════════════════

describe('AGENT_BENCHMARK_SUITE — structure', () => {
  it('has expected suite ID', () => {
    expect(AGENT_BENCHMARK_SUITE_ID).toBe('casterly-v2');
  });

  it('contains 13 benchmark cases', () => {
    expect(AGENT_BENCHMARK_SUITE).toHaveLength(13);
  });

  it('every case has a unique ID', () => {
    const ids = AGENT_BENCHMARK_SUITE.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every case has required fields', () => {
    for (const c of AGENT_BENCHMARK_SUITE) {
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
    for (const c of AGENT_BENCHMARK_SUITE) {
      expect(c.tags!.length).toBeGreaterThan(0);
    }
  });

  it('every case includes "v2" tag', () => {
    for (const c of AGENT_BENCHMARK_SUITE) {
      expect(c.tags).toContain('v2');
    }
  });

  it('IDs follow agent-{category}-{number} pattern', () => {
    for (const c of AGENT_BENCHMARK_SUITE) {
      expect(c.id).toMatch(/^agent-[a-z]+-\d{3}$/);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Difficulty distribution
// ═══════════════════════════════════════════════════════════════════════════════

describe('AGENT_BENCHMARK_SUITE — difficulty distribution', () => {
  it('has trivial cases', () => {
    const trivial = AGENT_BENCHMARK_SUITE.filter((c) => c.difficulty === 'trivial');
    expect(trivial.length).toBeGreaterThan(0);
  });

  it('has simple cases', () => {
    const simple = AGENT_BENCHMARK_SUITE.filter((c) => c.difficulty === 'simple');
    expect(simple.length).toBeGreaterThan(0);
  });

  it('has moderate cases', () => {
    const moderate = AGENT_BENCHMARK_SUITE.filter((c) => c.difficulty === 'moderate');
    expect(moderate.length).toBeGreaterThan(0);
  });

  it('has complex cases', () => {
    const complex = AGENT_BENCHMARK_SUITE.filter((c) => c.difficulty === 'complex');
    expect(complex.length).toBeGreaterThan(0);
  });

  it('has expert cases', () => {
    const expert = AGENT_BENCHMARK_SUITE.filter((c) => c.difficulty === 'expert');
    expect(expert.length).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Category distribution — v2 categories covered
// ═══════════════════════════════════════════════════════════════════════════════

describe('AGENT_BENCHMARK_SUITE — v2 category coverage', () => {
  it('has reasoning cases', () => {
    const cases = AGENT_BENCHMARK_SUITE.filter((c) => c.category === 'reasoning');
    expect(cases.length).toBeGreaterThanOrEqual(2);
  });

  it('has tool_selection cases', () => {
    const cases = AGENT_BENCHMARK_SUITE.filter((c) => c.category === 'tool_selection');
    expect(cases.length).toBeGreaterThanOrEqual(3);
  });

  it('has delegation cases', () => {
    const cases = AGENT_BENCHMARK_SUITE.filter((c) => c.category === 'delegation');
    expect(cases.length).toBeGreaterThanOrEqual(2);
  });

  it('has safety cases', () => {
    const cases = AGENT_BENCHMARK_SUITE.filter((c) => c.category === 'safety');
    expect(cases.length).toBeGreaterThanOrEqual(1);
  });

  it('has planning cases', () => {
    const cases = AGENT_BENCHMARK_SUITE.filter((c) => c.category === 'planning');
    expect(cases.length).toBeGreaterThanOrEqual(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// v2 metadata fields
// ═══════════════════════════════════════════════════════════════════════════════

describe('AGENT_BENCHMARK_SUITE — v2 metadata', () => {
  it('reasoning cases define shouldReason', () => {
    const reasoning = AGENT_BENCHMARK_SUITE.filter((c) => c.category === 'reasoning');
    for (const c of reasoning) {
      expect(c.shouldReason).toBeDefined();
    }
  });

  it('delegation cases define shouldDelegate', () => {
    const delegation = AGENT_BENCHMARK_SUITE.filter((c) => c.category === 'delegation');
    for (const c of delegation) {
      expect(c.shouldDelegate).toBeDefined();
    }
  });

  it('tool_selection cases define preferredTools', () => {
    const toolSel = AGENT_BENCHMARK_SUITE.filter((c) => c.category === 'tool_selection');
    for (const c of toolSel) {
      expect(c.preferredTools).toBeDefined();
      expect(c.preferredTools!.length).toBeGreaterThan(0);
    }
  });

  it('tool_selection cases that should avoid bash define avoidTools', () => {
    const toolSel = AGENT_BENCHMARK_SUITE.filter(
      (c) => c.category === 'tool_selection' && c.avoidTools
    );
    for (const c of toolSel) {
      expect(c.avoidTools).toContain('bash');
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Filter functions
// ═══════════════════════════════════════════════════════════════════════════════

describe('getAgentBenchmarkCasesByCategory', () => {
  it('filters reasoning cases', () => {
    const cases = getAgentBenchmarkCasesByCategory('reasoning');
    expect(cases.length).toBeGreaterThan(0);
    for (const c of cases) {
      expect(c.category).toBe('reasoning');
    }
  });

  it('returns empty for nonexistent category', () => {
    const cases = getAgentBenchmarkCasesByCategory('nonexistent' as BenchmarkCategory);
    expect(cases).toHaveLength(0);
  });
});

describe('getAgentBenchmarkCasesByDifficulty', () => {
  it('filters by difficulty', () => {
    const cases = getAgentBenchmarkCasesByDifficulty('simple');
    expect(cases.length).toBeGreaterThan(0);
    for (const c of cases) {
      expect(c.difficulty).toBe('simple');
    }
  });

  it('returns empty for nonexistent difficulty', () => {
    const cases = getAgentBenchmarkCasesByDifficulty('impossible' as BenchmarkDifficulty);
    expect(cases).toHaveLength(0);
  });
});
