/**
 * EvoScore & Normalized Change Metrics
 *
 * Implements the SWE-CI evaluation metrics:
 *
 * 1. Normalized Change (NC) — relative improvement/regression per iteration
 *    on [-1, 1] scale. Symmetric normalization sharply distinguishes between
 *    advances and destructive regressions.
 *
 * 2. EvoScore — gamma-weighted aggregate that uses a weighting parameter γ:
 *    - γ < 1: higher weight to earlier iterations (favors immediate gains)
 *    - γ = 1: equal weight across all iterations
 *    - γ > 1: higher weight to later iterations (favors long-term stability)
 *
 * 3. Zero-Regression Rate — proportion of iterations with no regressions.
 *
 * Privacy: Pure computation, no external calls.
 */

import type {
  CiIteration,
  NormalizedChange,
  EvoScoreResult,
  RegressionReport,
} from './types.js';

/**
 * Compute the Normalized Change for a single iteration.
 *
 * NC is on a [-1, 1] scale:
 *   - NC = 1: all previously failing tests now pass (perfect fix)
 *   - NC = 0: no change
 *   - NC = -1: all previously passing tests now fail (complete regression)
 *
 * Formula:
 *   If net > 0 (improvement): NC = net / maxPossibleImprovement
 *   If net < 0 (regression):  NC = net / maxPossibleRegression
 *   If net = 0:               NC = 0
 *
 * Where:
 *   net = fixed - regressed
 *   maxPossibleImprovement = number of tests that were failing
 *   maxPossibleRegression = number of tests that were passing
 */
export function computeNormalizedChange(
  report: RegressionReport,
  previouslyFailing: number,
  previouslyPassing: number,
  iteration: number,
  totalTests: number,
): NormalizedChange {
  const fixed = report.fixedCount;
  const regressed = report.regressionCount;
  const net = fixed - regressed;

  let value = 0;

  if (net > 0 && previouslyFailing > 0) {
    // Improvement: normalize against max possible improvement
    value = net / previouslyFailing;
  } else if (net < 0 && previouslyPassing > 0) {
    // Regression: normalize against max possible regression (negative)
    value = net / previouslyPassing;
  }
  // If net === 0 or denominators are 0, value stays 0

  // Clamp to [-1, 1]
  value = Math.max(-1, Math.min(1, value));

  return {
    iteration,
    value,
    fixed,
    regressed,
    netChange: net,
    totalTests,
  };
}

/**
 * Compute the EvoScore for a complete CI loop run.
 *
 * EvoScore formula:
 *   EvoScore = Σ(γ^i * NC_i) / Σ(γ^i)
 *
 * Where:
 *   γ = gamma weighting parameter
 *   i = iteration index (0-based)
 *   NC_i = Normalized Change at iteration i
 *
 * This produces a weighted average of Normalized Changes:
 *   - γ > 1 amplifies later iterations (long-term stability)
 *   - γ < 1 amplifies earlier iterations (immediate gains)
 *   - γ = 1 equal weighting (simple average)
 */
export function computeEvoScore(
  normalizedChanges: NormalizedChange[],
  gamma: number,
): number {
  if (normalizedChanges.length === 0) return 0;

  let weightedSum = 0;
  let weightSum = 0;

  for (let i = 0; i < normalizedChanges.length; i++) {
    const weight = Math.pow(gamma, i);
    weightedSum += weight * normalizedChanges[i]!.value;
    weightSum += weight;
  }

  if (weightSum === 0) return 0;
  return weightedSum / weightSum;
}

/**
 * Compute the zero-regression rate across all iterations.
 *
 * Zero-regression rate = (iterations with 0 regressions) / (total iterations)
 *
 * This measures how often the agent avoids breaking existing functionality.
 * SWE-CI found that most agents achieve < 0.25 zero-regression rate.
 */
export function computeZeroRegressionRate(
  regressionReports: RegressionReport[],
): number {
  if (regressionReports.length === 0) return 1;

  const zeroRegressions = regressionReports.filter((r) => !r.hasRegressions).length;
  return zeroRegressions / regressionReports.length;
}

/**
 * Compute the full EvoScore result from completed CI loop iterations.
 *
 * @param iterations - All completed CI loop iterations
 * @param gamma - Gamma weighting parameter
 * @returns Complete EvoScore result with all metrics
 */
export function computeFullEvoScore(
  iterations: CiIteration[],
  gamma: number,
): EvoScoreResult {
  const normalizedChanges: NormalizedChange[] = [];
  const regressionReports: RegressionReport[] = [];

  for (const iteration of iterations) {
    if (!iteration.regressionReport || !iteration.postTestResult) continue;

    const report = iteration.regressionReport;
    regressionReports.push(report);

    const previouslyFailing = iteration.preTestResult.failed + iteration.preTestResult.errored;
    const previouslyPassing = iteration.preTestResult.passed;
    const totalTests = iteration.postTestResult.total;

    const nc = computeNormalizedChange(
      report,
      previouslyFailing,
      previouslyPassing,
      iteration.index,
      totalTests,
    );
    normalizedChanges.push(nc);
  }

  const score = computeEvoScore(normalizedChanges, gamma);
  const zeroRegressionRate = computeZeroRegressionRate(regressionReports);

  // Compute initial and final pass rates
  const firstIteration = iterations[0];
  const lastIteration = iterations[iterations.length - 1];

  const initialTotal = firstIteration?.preTestResult.total ?? 0;
  const initialPassRate = initialTotal > 0
    ? (firstIteration?.preTestResult.passed ?? 0) / initialTotal
    : 0;

  const finalResult = lastIteration?.postTestResult ?? lastIteration?.preTestResult;
  const finalTotal = finalResult?.total ?? 0;
  const finalPassRate = finalTotal > 0
    ? (finalResult?.passed ?? 0) / finalTotal
    : 0;

  return {
    score,
    gamma,
    normalizedChanges,
    zeroRegressionRate,
    totalIterations: iterations.length,
    finalPassRate,
    initialPassRate,
  };
}

/**
 * Format EvoScore result as a human-readable report.
 */
export function formatEvoScoreReport(result: EvoScoreResult): string {
  const lines: string[] = [];

  lines.push('# EvoScore Report');
  lines.push('');
  lines.push(`**EvoScore:** ${result.score.toFixed(4)} (γ = ${result.gamma})`);
  lines.push(`**Zero-Regression Rate:** ${(result.zeroRegressionRate * 100).toFixed(1)}%`);
  lines.push(`**Pass Rate:** ${(result.initialPassRate * 100).toFixed(1)}% → ${(result.finalPassRate * 100).toFixed(1)}%`);
  lines.push(`**Iterations:** ${result.totalIterations}`);
  lines.push('');

  // Per-iteration breakdown
  lines.push('## Iteration Breakdown');
  lines.push('');
  lines.push('| Iteration | NC | Fixed | Regressed | Net |');
  lines.push('|-----------|-----|-------|-----------|-----|');

  for (const nc of result.normalizedChanges) {
    const ncStr = nc.value >= 0 ? `+${nc.value.toFixed(3)}` : nc.value.toFixed(3);
    lines.push(`| ${nc.iteration} | ${ncStr} | ${nc.fixed} | ${nc.regressed} | ${nc.netChange >= 0 ? '+' : ''}${nc.netChange} |`);
  }

  return lines.join('\n');
}
