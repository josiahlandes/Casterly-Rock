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

// ─── Score a Single Case ─────────────────────────────────────────────────────

/**
 * Score a single benchmark case from its TestResult and PerformanceMetrics.
 * The toolsCalled array is used for v2 agent dimension scoring.
 */
export function scoreCase(
  benchmarkCase: BenchmarkCase,
  result: TestResult,
  metrics: PerformanceMetrics,
  toolsCalled?: string[],
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
    ...(hasV2 ? { toolSelectionScore, reasoningScore, delegationScore } : {}),
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
  };
}
