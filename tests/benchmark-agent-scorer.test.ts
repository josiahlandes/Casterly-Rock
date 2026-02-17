import { describe, expect, it } from 'vitest';

import {
  scoreToolSelection,
  scoreReasoning,
  scoreDelegation,
  scoreCase,
  aggregateScores,
} from '../src/benchmark/scorer.js';
import { V1_SCORING_PROFILE, V2_SCORING_PROFILE } from '../src/benchmark/types.js';
import type { TestResult } from '../src/testing/test-cases.js';
import type { BenchmarkCase, CaseResult } from '../src/benchmark/types.js';
import type { PerformanceMetrics } from '../src/benchmark/metrics.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeMetrics(overrides: Partial<PerformanceMetrics> = {}): PerformanceMetrics {
  return {
    tokensInput: 100,
    tokensOutput: 50,
    ttftMs: 200,
    totalMs: 1000,
    evalRate: 25,
    ...overrides,
  };
}

function makeAgentCase(overrides: Partial<BenchmarkCase> = {}): BenchmarkCase {
  return {
    id: 'agent-test-001',
    name: 'Test Agent Case',
    description: 'An agent test case',
    input: 'test input',
    expected: {
      shouldSucceed: true,
      shouldCallTools: true,
    },
    difficulty: 'moderate',
    category: 'tool_selection',
    preferredTools: ['read_file'],
    avoidTools: ['bash'],
    shouldReason: true,
    optimalToolCalls: 2,
    ...overrides,
  };
}

function makeTestResult(overrides: Partial<TestResult> = {}): TestResult {
  return {
    testCase: makeAgentCase(),
    passed: true,
    failures: [],
    warnings: [],
    actualOutcome: {
      provider: 'local',
      model: 'test-model',
      toolsCalled: ['think', 'read_file'],
      toolCallCount: 2,
      response: 'result',
      durationMs: 1000,
      error: null,
    },
    trace: null,
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// scoreToolSelection
// ═══════════════════════════════════════════════════════════════════════════════

describe('scoreToolSelection', () => {
  it('returns 1 when no preferences defined', () => {
    const c = makeAgentCase({ preferredTools: undefined, avoidTools: undefined });
    expect(scoreToolSelection(c, ['bash'])).toBe(1);
  });

  it('returns 1 when all preferred tools are called', () => {
    const c = makeAgentCase({ preferredTools: ['read_file', 'grep'] });
    expect(scoreToolSelection(c, ['read_file', 'grep'])).toBe(1);
  });

  it('returns fraction when some preferred tools are called', () => {
    const c = makeAgentCase({ preferredTools: ['read_file', 'grep'], avoidTools: undefined });
    expect(scoreToolSelection(c, ['read_file'])).toBe(0.5);
  });

  it('returns 0 when no preferred tools are called', () => {
    const c = makeAgentCase({ preferredTools: ['read_file', 'grep'], avoidTools: undefined });
    expect(scoreToolSelection(c, ['bash'])).toBe(0);
  });

  it('penalizes avoided tools by 0.5 each', () => {
    const c = makeAgentCase({ preferredTools: undefined, avoidTools: ['bash'] });
    expect(scoreToolSelection(c, ['bash'])).toBe(0.5);
  });

  it('penalizes multiple avoided tools', () => {
    const c = makeAgentCase({ preferredTools: undefined, avoidTools: ['bash', 'edit_file'] });
    expect(scoreToolSelection(c, ['bash', 'edit_file'])).toBe(0);
  });

  it('combines preferred and avoided scoring', () => {
    const c = makeAgentCase({ preferredTools: ['read_file'], avoidTools: ['bash'] });
    // preferred: 1/1 = 1.0, avoided: 1 violation * 0.5 => 1 * 0.5 = 0.5
    expect(scoreToolSelection(c, ['read_file', 'bash'])).toBe(0.5);
  });

  it('full score when preferred used and avoided not used', () => {
    const c = makeAgentCase({ preferredTools: ['read_file'], avoidTools: ['bash'] });
    expect(scoreToolSelection(c, ['read_file'])).toBe(1);
  });

  it('handles empty tools called', () => {
    const c = makeAgentCase({ preferredTools: ['read_file'], avoidTools: undefined });
    expect(scoreToolSelection(c, [])).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// scoreReasoning
// ═══════════════════════════════════════════════════════════════════════════════

describe('scoreReasoning', () => {
  it('returns 1 when no expectation defined', () => {
    const c = makeAgentCase({ shouldReason: undefined });
    expect(scoreReasoning(c, ['bash'])).toBe(1);
  });

  it('returns 1 when shouldReason=true and think tool used', () => {
    const c = makeAgentCase({ shouldReason: true });
    expect(scoreReasoning(c, ['think', 'read_file'])).toBe(1);
  });

  it('returns 0 when shouldReason=true and think tool NOT used', () => {
    const c = makeAgentCase({ shouldReason: true });
    expect(scoreReasoning(c, ['read_file'])).toBe(0);
  });

  it('returns 1 when shouldReason=false and think tool NOT used', () => {
    const c = makeAgentCase({ shouldReason: false });
    expect(scoreReasoning(c, ['bash'])).toBe(1);
  });

  it('returns 0.5 when shouldReason=false but think tool used (soft penalty)', () => {
    const c = makeAgentCase({ shouldReason: false });
    expect(scoreReasoning(c, ['think', 'bash'])).toBe(0.5);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// scoreDelegation
// ═══════════════════════════════════════════════════════════════════════════════

describe('scoreDelegation', () => {
  it('returns 1 when no expectation defined', () => {
    const c = makeAgentCase({ shouldDelegate: undefined });
    expect(scoreDelegation(c, ['bash'])).toBe(1);
  });

  it('returns 1 when shouldDelegate=true and delegate tool used', () => {
    const c = makeAgentCase({ shouldDelegate: true });
    expect(scoreDelegation(c, ['think', 'delegate'])).toBe(1);
  });

  it('returns 0 when shouldDelegate=true and delegate tool NOT used', () => {
    const c = makeAgentCase({ shouldDelegate: true });
    expect(scoreDelegation(c, ['think', 'edit_file'])).toBe(0);
  });

  it('returns 1 when shouldDelegate=false and delegate tool NOT used', () => {
    const c = makeAgentCase({ shouldDelegate: false });
    expect(scoreDelegation(c, ['think', 'read_file'])).toBe(1);
  });

  it('returns 0 when shouldDelegate=false but delegate tool used', () => {
    const c = makeAgentCase({ shouldDelegate: false });
    expect(scoreDelegation(c, ['delegate'])).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// scoreCase — v2 dimensions
// ═══════════════════════════════════════════════════════════════════════════════

describe('scoreCase — v2 dimensions', () => {
  it('includes v2 scores when case defines v2 expectations', () => {
    const c = makeAgentCase({ preferredTools: ['read_file'], shouldReason: true });
    const result = makeTestResult();
    const metrics = makeMetrics();

    const scored = scoreCase(c, result, metrics, ['think', 'read_file']);

    expect(scored.toolSelectionScore).toBeDefined();
    expect(scored.reasoningScore).toBeDefined();
    expect(scored.toolSelectionScore).toBe(1);
    expect(scored.reasoningScore).toBe(1);
  });

  it('omits v2 scores when case has no v2 expectations', () => {
    const c = makeAgentCase({
      preferredTools: undefined,
      avoidTools: undefined,
      shouldReason: undefined,
      shouldDelegate: undefined,
    });
    const result = makeTestResult();
    const metrics = makeMetrics();

    const scored = scoreCase(c, result, metrics);

    expect(scored.toolSelectionScore).toBeUndefined();
    expect(scored.reasoningScore).toBeUndefined();
    expect(scored.delegationScore).toBeUndefined();
  });

  it('uses toolsCalled param when provided', () => {
    const c = makeAgentCase({ preferredTools: ['grep'], avoidTools: ['bash'] });
    const result = makeTestResult({
      actualOutcome: {
        provider: 'local',
        model: 'test',
        toolsCalled: ['bash'], // would score poorly
        toolCallCount: 1,
        response: 'result',
        durationMs: 1000,
        error: null,
      },
    });

    // When toolsCalled is explicitly passed, it overrides actualOutcome.toolsCalled
    const scored = scoreCase(c, result, makeMetrics(), ['grep']);
    expect(scored.toolSelectionScore).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// aggregateScores — v2 scoring profile
// ═══════════════════════════════════════════════════════════════════════════════

describe('aggregateScores — v2 profile', () => {
  function makeV2CaseResult(overrides: Partial<CaseResult> = {}): CaseResult {
    return {
      caseId: 'agent-test-001',
      passed: true,
      structuralScore: 1,
      toolEfficiency: 1,
      tokensInput: 100,
      tokensOutput: 50,
      ttftMs: 200,
      totalMs: 1000,
      evalRate: 25,
      failures: [],
      toolSelectionScore: 0.8,
      reasoningScore: 1,
      delegationScore: 1,
      ...overrides,
    };
  }

  it('includes v2 dimension averages when cases have them', () => {
    const cases = [
      makeV2CaseResult({ caseId: 'agent-test-001', toolSelectionScore: 0.8, reasoningScore: 1, delegationScore: 0 }),
      makeV2CaseResult({ caseId: 'agent-test-002', toolSelectionScore: 0.6, reasoningScore: 0, delegationScore: 1 }),
    ];
    const suite = [
      makeAgentCase({ id: 'agent-test-001' }),
      makeAgentCase({ id: 'agent-test-002' }),
    ];

    const agg = aggregateScores(cases, suite, V2_SCORING_PROFILE);

    expect(agg.toolSelectionAvg).toBe(0.7);
    expect(agg.reasoningAvg).toBe(0.5);
    expect(agg.delegationAvg).toBe(0.5);
  });

  it('omits v2 dimension averages when no cases have them', () => {
    const cases = [
      {
        caseId: 'bench-simple-001',
        passed: true,
        structuralScore: 1,
        toolEfficiency: 1,
        tokensInput: 100,
        tokensOutput: 50,
        ttftMs: 200,
        totalMs: 1000,
        evalRate: 25,
        failures: [],
      } satisfies CaseResult,
    ];
    const suite = [
      makeAgentCase({
        id: 'bench-simple-001',
        preferredTools: undefined,
        avoidTools: undefined,
        shouldReason: undefined,
        shouldDelegate: undefined,
      }),
    ];

    const agg = aggregateScores(cases, suite, V1_SCORING_PROFILE);

    expect(agg.toolSelectionAvg).toBeUndefined();
    expect(agg.reasoningAvg).toBeUndefined();
    expect(agg.delegationAvg).toBeUndefined();
  });

  it('v2 profile produces different overall score than v1', () => {
    const cases = [
      makeV2CaseResult({ structuralScore: 1, toolEfficiency: 0.5, evalRate: 25, toolSelectionScore: 1, reasoningScore: 1, delegationScore: 1 }),
    ];
    const suite = [makeAgentCase()];

    const v1Score = aggregateScores(cases, suite, V1_SCORING_PROFILE);
    const v2Score = aggregateScores(cases, suite, V2_SCORING_PROFILE);

    // Scores should differ because weights differ
    expect(v1Score.overall).not.toBe(v2Score.overall);
  });

  it('v1 profile backward compat — same behavior as before', () => {
    // v1 case with no v2 scores
    const cases: CaseResult[] = [{
      caseId: 'bench-simple-001',
      passed: true,
      structuralScore: 1,
      toolEfficiency: 1,
      tokensInput: 100,
      tokensOutput: 50,
      ttftMs: 200,
      totalMs: 1000,
      evalRate: 50, // max eval rate → performance = 1.0
      failures: [],
    }];
    const suite = [makeAgentCase({
      id: 'bench-simple-001',
      preferredTools: undefined,
      avoidTools: undefined,
      shouldReason: undefined,
      shouldDelegate: undefined,
    })];

    const agg = aggregateScores(cases, suite, V1_SCORING_PROFILE);

    // structural(1.0)*0.4 + efficiency(1.0)*0.3 + performance(1.0)*0.3 = 1.0 → 100
    expect(agg.overall).toBe(100);
  });

  it('handles empty cases', () => {
    const agg = aggregateScores([], [], V2_SCORING_PROFILE);
    expect(agg.overall).toBe(0);
    expect(agg.passRate).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Scoring profiles
// ═══════════════════════════════════════════════════════════════════════════════

describe('ScoringProfile constants', () => {
  it('v1 profile weights sum to 1.0', () => {
    const sum = V1_SCORING_PROFILE.structural
      + V1_SCORING_PROFILE.toolEfficiency
      + V1_SCORING_PROFILE.performance
      + V1_SCORING_PROFILE.toolSelection
      + V1_SCORING_PROFILE.reasoning
      + V1_SCORING_PROFILE.delegation;
    expect(sum).toBeCloseTo(1.0);
  });

  it('v2 profile weights sum to 1.0', () => {
    const sum = V2_SCORING_PROFILE.structural
      + V2_SCORING_PROFILE.toolEfficiency
      + V2_SCORING_PROFILE.performance
      + V2_SCORING_PROFILE.toolSelection
      + V2_SCORING_PROFILE.reasoning
      + V2_SCORING_PROFILE.delegation;
    expect(sum).toBeCloseTo(1.0);
  });

  it('v1 profile has zero v2 weights', () => {
    expect(V1_SCORING_PROFILE.toolSelection).toBe(0);
    expect(V1_SCORING_PROFILE.reasoning).toBe(0);
    expect(V1_SCORING_PROFILE.delegation).toBe(0);
  });

  it('v2 profile has non-zero v2 weights', () => {
    expect(V2_SCORING_PROFILE.toolSelection).toBeGreaterThan(0);
    expect(V2_SCORING_PROFILE.reasoning).toBeGreaterThan(0);
    expect(V2_SCORING_PROFILE.delegation).toBeGreaterThan(0);
  });
});
