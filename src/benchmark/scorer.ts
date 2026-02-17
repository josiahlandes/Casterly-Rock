/**
 * Benchmark Scorer (ISSUE-008)
 *
 * Graduated scoring that replaces binary pass/fail with 0-1 scores.
 * Uses evaluateResult() from src/testing for structural checks,
 * then computes fractional scores from the check results.
 *
 * v2 adds scoring for agent-oriented dimensions:
 * - Tool selection: Did the model pick the right tool from the full toolkit?
 * - Reasoning: Did the model think before acting on complex tasks?
 * - Delegation: Did the model correctly decide when to hand off?
 *
 * Scoring profiles (v1 vs v2) control how dimensions are weighted.
 */

import type { TestResult, ExpectedOutcome } from '../testing/test-cases.js';
import type {
  BenchmarkCase,
  CaseResult,
  AggregateScore,
  ScoringProfile,
} from './types.js';
import { V1_SCORING_PROFILE } from './types.js';
import type { PerformanceMetrics } from './metrics.js';

// ─── Scoring Constants ───────────────────────────────────────────────────────

/** Minimum eval rate (tok/s) for performance normalization: maps to 0.0 */
const EVAL_RATE_MIN = 5;
/** Maximum eval rate (tok/s) for performance normalization: maps to 1.0 */
const EVAL_RATE_MAX = 50;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Count the number of structural checks that were actually evaluated
 * for a given ExpectedOutcome.
 */
export function countChecks(expected: ExpectedOutcome): number {
  let count = 0;
  if (expected.shouldSucceed !== undefined) count++;
  if (expected.shouldCallTools !== undefined) count++;
  if (expected.expectedToolNames !== undefined) count += expected.expectedToolNames.length;
  if (expected.toolCallCount !== undefined) {
    if (expected.toolCallCount.min !== undefined) count++;
    if (expected.toolCallCount.max !== undefined) count++;
  }
  if (expected.responsePattern !== undefined) count++;
  if (expected.responseExcludePattern !== undefined) count++;
  if (expected.responseContains !== undefined) count += expected.responseContains.length;
  if (expected.maxDurationMs !== undefined) count++;
  return count;
}

/**
 * Normalize eval rate to 0-1 scale.
 * Linear interpolation between EVAL_RATE_MIN and EVAL_RATE_MAX, clamped.
 */
export function normalizeEvalRate(evalRate: number): number {
  if (evalRate <= EVAL_RATE_MIN) return 0;
  if (evalRate >= EVAL_RATE_MAX) return 1;
  return (evalRate - EVAL_RATE_MIN) / (EVAL_RATE_MAX - EVAL_RATE_MIN);
}

// ─── v2: Agent Dimension Scoring ────────────────────────────────────────────

/**
 * Score tool selection: did the model use preferred tools and avoid bad ones?
 * Returns 0-1 where 1 means perfect tool selection.
 */
export function scoreToolSelection(
  benchmarkCase: BenchmarkCase,
  toolsCalled: string[],
): number {
  const preferred = benchmarkCase.preferredTools;
  const avoid = benchmarkCase.avoidTools;

  if (!preferred && !avoid) return 1; // No preference defined — full score

  let score = 1;
  const calledSet = new Set(toolsCalled);

  // Check preferred tools: fraction of preferred tools that were called
  if (preferred && preferred.length > 0) {
    const found = preferred.filter((t) => calledSet.has(t)).length;
    score *= found / preferred.length;
  }

  // Penalize avoided tools: each avoided tool used reduces score by 0.5
  if (avoid && avoid.length > 0) {
    const violations = avoid.filter((t) => calledSet.has(t)).length;
    score *= Math.max(0, 1 - violations * 0.5);
  }

  return Math.max(0, Math.min(1, score));
}

/**
 * Score reasoning: did the model use the think tool when it should have?
 * Returns 0 or 1.
 */
export function scoreReasoning(
  benchmarkCase: BenchmarkCase,
  toolsCalled: string[],
): number {
  if (benchmarkCase.shouldReason === undefined) return 1; // No expectation

  const usedThink = toolsCalled.includes('think');

  if (benchmarkCase.shouldReason) {
    return usedThink ? 1 : 0;
  }
  // shouldReason === false: penalize unnecessary reasoning on trivial tasks
  // But don't penalize hard — thinking is rarely harmful
  return usedThink ? 0.5 : 1;
}

/**
 * Score delegation: did the model correctly decide whether to delegate?
 * Returns 0 or 1.
 */
export function scoreDelegation(
  benchmarkCase: BenchmarkCase,
  toolsCalled: string[],
): number {
  if (benchmarkCase.shouldDelegate === undefined) return 1; // No expectation

  const usedDelegate = toolsCalled.includes('delegate');

  if (benchmarkCase.shouldDelegate) {
    return usedDelegate ? 1 : 0;
  }
  // Should NOT delegate — penalize if it did
  return usedDelegate ? 0 : 1;
}

// ─── v2: Argument Correctness ───────────────────────────────────────────────

interface ToolCallWithArgs {
  name: string;
  arguments?: Record<string, unknown>;
}

/**
 * Score tool argument correctness: did the model pass the right arguments?
 * Returns 0-1 where 1 means all expected arguments were correct.
 *
 * Expected args format: { toolName: { argName: expectedValue } }
 * Values can be:
 * - A string/number for exact match
 * - A RegExp-like string prefixed with "re:" for pattern match
 * - "*" for "must be present, any value"
 */
export function scoreArgCorrectness(
  expectedArgs: Record<string, Record<string, unknown>> | undefined,
  toolCalls: ToolCallWithArgs[],
): number {
  if (!expectedArgs || Object.keys(expectedArgs).length === 0) return 1;

  let totalChecks = 0;
  let passedChecks = 0;

  for (const [toolName, argExpectations] of Object.entries(expectedArgs)) {
    const matchingCall = toolCalls.find((c) => c.name === toolName);
    if (!matchingCall) {
      // Tool wasn't called at all — fail all arg checks for it
      totalChecks += Object.keys(argExpectations).length;
      continue;
    }

    const actualArgs = matchingCall.arguments ?? {};

    for (const [argName, expected] of Object.entries(argExpectations)) {
      totalChecks++;
      const actual = actualArgs[argName];

      if (expected === '*') {
        // Just needs to be present
        if (actual !== undefined && actual !== null) passedChecks++;
      } else if (typeof expected === 'string' && expected.startsWith('re:')) {
        // Regex match
        const pattern = new RegExp(expected.slice(3));
        if (typeof actual === 'string' && pattern.test(actual)) passedChecks++;
      } else {
        // Exact match (loose comparison for numbers)
        if (actual === expected) passedChecks++;
        else if (String(actual) === String(expected)) passedChecks++;
      }
    }
  }

  return totalChecks > 0 ? passedChecks / totalChecks : 1;
}

// ─── Score a Single Case ─────────────────────────────────────────────────────

/**
 * Score a single benchmark case from its TestResult and PerformanceMetrics.
 * The toolsCalled array is used for v2 agent dimension scoring.
 * Optional qualityScore (0-10) from LLM-as-judge and toolCallsWithArgs
 * for argument correctness scoring.
 */
export function scoreCase(
  benchmarkCase: BenchmarkCase,
  result: TestResult,
  metrics: PerformanceMetrics,
  toolsCalled?: string[],
  options?: {
    qualityScore?: number;
    toolCallsWithArgs?: ToolCallWithArgs[];
    warmStart?: boolean;
    vramBytes?: number;
  },
): CaseResult {
  // Structural score: fraction of checks that passed
  const totalChecks = countChecks(benchmarkCase.expected);
  const failedChecks = result.failures.length;
  const structuralScore = totalChecks > 0
    ? Math.max(0, (totalChecks - failedChecks) / totalChecks)
    : 1;

  // Tool efficiency: optimal / actual, capped at 1.0
  let toolEfficiency = 1;
  if (benchmarkCase.optimalToolCalls !== undefined && benchmarkCase.optimalToolCalls > 0) {
    const actual = result.actualOutcome.toolCallCount;
    if (actual > 0) {
      toolEfficiency = Math.min(1, benchmarkCase.optimalToolCalls / actual);
    } else {
      // Model didn't call tools but should have
      toolEfficiency = 0;
    }
  }

  // v2 dimensions (only computed when toolsCalled is available)
  const tools = toolsCalled ?? result.actualOutcome.toolsCalled;
  const toolSelectionScore = scoreToolSelection(benchmarkCase, tools);
  const reasoningScore = scoreReasoning(benchmarkCase, tools);
  const delegationScore = scoreDelegation(benchmarkCase, tools);

  // Argument correctness
  const argCorrectnessScore = scoreArgCorrectness(
    benchmarkCase.expectedArgs,
    options?.toolCallsWithArgs ?? [],
  );

  // Only include v2 scores if the case defines v2 expectations
  const hasV2 = benchmarkCase.preferredTools !== undefined
    || benchmarkCase.avoidTools !== undefined
    || benchmarkCase.shouldReason !== undefined
    || benchmarkCase.shouldDelegate !== undefined;

  return {
    caseId: benchmarkCase.id,
    passed: result.passed,
    structuralScore,
    toolEfficiency,
    tokensInput: metrics.tokensInput,
    tokensOutput: metrics.tokensOutput,
    ttftMs: metrics.ttftMs,
    totalMs: metrics.totalMs,
    evalRate: metrics.evalRate,
    failures: result.failures,
    ...(hasV2 ? {
      toolSelectionScore,
      reasoningScore,
      delegationScore,
      argCorrectnessScore,
    } : {}),
    ...(options?.qualityScore !== undefined ? { qualityScore: options.qualityScore } : {}),
    ...(options?.warmStart !== undefined ? { warmStart: options.warmStart } : {}),
    ...(options?.vramBytes !== undefined ? { vramBytes: options.vramBytes } : {}),
  };
}

// ─── Aggregate Scores ────────────────────────────────────────────────────────

/**
 * Aggregate case results into an overall score with breakdowns.
 * Uses the provided scoring profile for weighting (v1 or v2).
 */
export function aggregateScores(
  cases: CaseResult[],
  suite: BenchmarkCase[],
  profile?: ScoringProfile,
): AggregateScore {
  const weights = profile ?? V1_SCORING_PROFILE;

  if (cases.length === 0) {
    return {
      overall: 0,
      structuralAvg: 0,
      toolEfficiencyAvg: 0,
      avgTtftMs: 0,
      avgTotalMs: 0,
      avgEvalRate: 0,
      passRate: 0,
      byDifficulty: {},
      byCategory: {},
    };
  }

  // Build lookup for suite metadata
  const suiteMap = new Map(suite.map((s) => [s.id, s]));

  // Simple averages
  const n = cases.length;
  const structuralAvg = cases.reduce((sum, c) => sum + c.structuralScore, 0) / n;
  const toolEfficiencyAvg = cases.reduce((sum, c) => sum + c.toolEfficiency, 0) / n;
  const avgTtftMs = cases.reduce((sum, c) => sum + c.ttftMs, 0) / n;
  const avgTotalMs = cases.reduce((sum, c) => sum + c.totalMs, 0) / n;
  const avgEvalRate = cases.reduce((sum, c) => sum + c.evalRate, 0) / n;
  const passRate = cases.filter((c) => c.passed).length / n;

  // v2 dimension averages (only from cases that have them)
  const v2Cases = cases.filter((c) => c.toolSelectionScore !== undefined);
  const hasV2 = v2Cases.length > 0;

  const toolSelectionAvg = hasV2
    ? v2Cases.reduce((sum, c) => sum + (c.toolSelectionScore ?? 0), 0) / v2Cases.length
    : undefined;
  const reasoningAvg = hasV2
    ? v2Cases.reduce((sum, c) => sum + (c.reasoningScore ?? 0), 0) / v2Cases.length
    : undefined;
  const delegationAvg = hasV2
    ? v2Cases.reduce((sum, c) => sum + (c.delegationScore ?? 0), 0) / v2Cases.length
    : undefined;

  // Performance normalization
  const performanceNorm = normalizeEvalRate(avgEvalRate);

  // Overall weighted score (0-100)
  // Sum of (dimension * weight) for all dimensions that have data
  let weightedSum = 0;
  let totalWeight = 0;

  weightedSum += structuralAvg * weights.structural;
  totalWeight += weights.structural;

  weightedSum += toolEfficiencyAvg * weights.toolEfficiency;
  totalWeight += weights.toolEfficiency;

  weightedSum += performanceNorm * weights.performance;
  totalWeight += weights.performance;

  if (hasV2 && weights.toolSelection > 0 && toolSelectionAvg !== undefined) {
    weightedSum += toolSelectionAvg * weights.toolSelection;
    totalWeight += weights.toolSelection;
  }

  if (hasV2 && weights.reasoning > 0 && reasoningAvg !== undefined) {
    weightedSum += reasoningAvg * weights.reasoning;
    totalWeight += weights.reasoning;
  }

  if (hasV2 && weights.delegation > 0 && delegationAvg !== undefined) {
    weightedSum += delegationAvg * weights.delegation;
    totalWeight += weights.delegation;
  }

  // v2: Quality score (0-10 normalized to 0-1)
  const qualityCases = cases.filter((c) => c.qualityScore !== undefined);
  const hasQuality = qualityCases.length > 0;
  const qualityAvg = hasQuality
    ? qualityCases.reduce((sum, c) => sum + (c.qualityScore ?? 0), 0) / qualityCases.length
    : undefined;

  if (hasQuality && weights.quality > 0 && qualityAvg !== undefined) {
    weightedSum += (qualityAvg / 10) * weights.quality;
    totalWeight += weights.quality;
  }

  // v2: Argument correctness
  const argCases = cases.filter((c) => c.argCorrectnessScore !== undefined);
  const hasArgCorrectness = argCases.length > 0;
  const argCorrectnessAvg = hasArgCorrectness
    ? argCases.reduce((sum, c) => sum + (c.argCorrectnessScore ?? 0), 0) / argCases.length
    : undefined;

  if (hasArgCorrectness && weights.argCorrectness > 0 && argCorrectnessAvg !== undefined) {
    weightedSum += argCorrectnessAvg * weights.argCorrectness;
    totalWeight += weights.argCorrectness;
  }

  // v2: VRAM footprint (informational, not weighted)
  const vramCases = cases.filter((c) => c.vramBytes !== undefined);
  const vramBytes = vramCases.length > 0 ? vramCases[0]!.vramBytes : undefined;
  const warmStart = cases.length > 0 ? cases[0]!.warmStart : undefined;

  const overall = totalWeight > 0
    ? Math.round((weightedSum / totalWeight) * 100)
    : 0;

  // Breakdowns
  const byDifficulty: Record<string, { passed: number; total: number; avgScore: number }> = {};
  const byCategory: Record<string, { passed: number; total: number; avgScore: number }> = {};

  for (const caseResult of cases) {
    const meta = suiteMap.get(caseResult.caseId);
    if (!meta) continue;

    // Difficulty
    if (!byDifficulty[meta.difficulty]) {
      byDifficulty[meta.difficulty] = { passed: 0, total: 0, avgScore: 0 };
    }
    const diffGroup = byDifficulty[meta.difficulty]!;
    diffGroup.total++;
    if (caseResult.passed) diffGroup.passed++;
    diffGroup.avgScore += caseResult.structuralScore;

    // Category
    if (!byCategory[meta.category]) {
      byCategory[meta.category] = { passed: 0, total: 0, avgScore: 0 };
    }
    const catGroup = byCategory[meta.category]!;
    catGroup.total++;
    if (caseResult.passed) catGroup.passed++;
    catGroup.avgScore += caseResult.structuralScore;
  }

  // Convert sums to averages
  for (const group of Object.values(byDifficulty)) {
    group.avgScore = group.total > 0 ? group.avgScore / group.total : 0;
  }
  for (const group of Object.values(byCategory)) {
    group.avgScore = group.total > 0 ? group.avgScore / group.total : 0;
  }

  return {
    overall,
    structuralAvg,
    toolEfficiencyAvg,
    avgTtftMs,
    avgTotalMs,
    avgEvalRate,
    passRate,
    byDifficulty,
    byCategory,
    ...(hasV2 ? { toolSelectionAvg, reasoningAvg, delegationAvg } : {}),
    ...(hasQuality ? { qualityAvg } : {}),
    ...(hasArgCorrectness ? { argCorrectnessAvg } : {}),
    ...(vramBytes !== undefined ? { vramBytes } : {}),
    ...(warmStart !== undefined ? { warmStart } : {}),
  };
}
