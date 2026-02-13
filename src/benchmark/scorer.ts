/**
 * Benchmark Scorer (ISSUE-008)
 *
 * Graduated scoring that replaces binary pass/fail with 0-1 scores.
 * Uses evaluateResult() from src/testing for structural checks,
 * then computes fractional scores from the check results.
 */

import type { TestResult, ExpectedOutcome } from '../testing/test-cases.js';
import type {
  BenchmarkCase,
  CaseResult,
  AggregateScore,
} from './types.js';
import type { PerformanceMetrics } from './metrics.js';

// ─── Scoring Constants ───────────────────────────────────────────────────────

/** Weight for structural correctness in overall score */
const STRUCTURAL_WEIGHT = 0.40;
/** Weight for tool efficiency in overall score */
const TOOL_EFFICIENCY_WEIGHT = 0.30;
/** Weight for performance (eval rate) in overall score */
const PERFORMANCE_WEIGHT = 0.30;

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

// ─── Score a Single Case ─────────────────────────────────────────────────────

/**
 * Score a single benchmark case from its TestResult and PerformanceMetrics.
 */
export function scoreCase(
  benchmarkCase: BenchmarkCase,
  result: TestResult,
  metrics: PerformanceMetrics,
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
  };
}

// ─── Aggregate Scores ────────────────────────────────────────────────────────

/**
 * Aggregate case results into an overall score with breakdowns.
 */
export function aggregateScores(
  cases: CaseResult[],
  suite: BenchmarkCase[],
): AggregateScore {
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

  // Performance normalization
  const performanceNorm = normalizeEvalRate(avgEvalRate);

  // Overall weighted score (0-100)
  const overall = Math.round(
    (structuralAvg * STRUCTURAL_WEIGHT +
      toolEfficiencyAvg * TOOL_EFFICIENCY_WEIGHT +
      performanceNorm * PERFORMANCE_WEIGHT) *
      100,
  );

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
  };
}
