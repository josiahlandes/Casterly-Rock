/**
 * CI Loop Orchestrator
 *
 * Implements the full SWE-CI continuous integration loop:
 *   run_tests → architect (analyze gaps) → programmer (modify code) → run_tests → ...
 *
 * The orchestrator manages the iteration lifecycle, coordinates the Architect
 * and Programmer agents, tracks regression, computes metrics, and determines
 * when to stop.
 *
 * Stop conditions:
 *   1. All tests pass (success)
 *   2. Maximum iterations reached
 *   3. Stagnation (no progress for N consecutive iterations)
 *   4. Unrecoverable error
 *
 * Privacy: All inference and test execution is local.
 */

import type { LlmProvider } from '../providers/base.js';
import type { NativeToolCall, NativeToolResult } from '../tools/schemas/types.js';
import { resultToMessage } from '../dual-loop/agent.js';
import type {
  CiLoopConfig,
  CiLoopResult,
  CiIteration,
  TestRunResult,
  RegressionReport,
} from './types.js';
import { DEFAULT_CI_LOOP_CONFIG } from './types.js';
import { runTests } from './test-runner.js';
import { compareTestRuns } from './regression-guard.js';
import { runArchitect } from './architect.js';
import type { ArchitectConfig } from './architect.js';
import { runProgrammer } from './programmer.js';
import type { ProgrammerConfig } from './programmer.js';
import { computeFullEvoScore, formatEvoScoreReport } from './metrics.js';

// ─────────────────────────────────────────────────────────────────────────────
// CI Loop Configuration
// ─────────────────────────────────────────────────────────────────────────────

export interface CiLoopOptions {
  /** Configuration overrides */
  config?: Partial<CiLoopConfig>;

  /** LLM provider for the Architect (reasoner model) */
  architectProvider: LlmProvider;

  /** LLM provider for the Programmer (coder model) */
  programmerProvider: LlmProvider;

  /** Tool executor for the Architect (read-only tools) */
  architectToolExecutor: (call: NativeToolCall) => Promise<NativeToolResult>;

  /** Tool executor for the Programmer (read-write tools) */
  programmerToolExecutor: (call: NativeToolCall) => Promise<NativeToolResult>;

  /** Callback for iteration progress (optional) */
  onIterationComplete?: (iteration: CiIteration) => void;

  /** Callback for metrics update (optional) */
  onMetricsUpdate?: (report: string) => void;
}

// ─────────────────────────────────────────────────────────────────────────────
// CI Loop Execution
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Run the full CI loop.
 *
 * This is the main entry point for the SWE-CI implementation.
 * It orchestrates the iterative cycle of test → architect → programmer → test
 * until a stop condition is met.
 */
export async function runCiLoop(options: CiLoopOptions): Promise<CiLoopResult> {
  const config: CiLoopConfig = { ...DEFAULT_CI_LOOP_CONFIG, ...options.config };
  const startTime = Date.now();
  const iterations: CiIteration[] = [];
  let stagnationCount = 0;
  let previousBestPassRate = 0;
  let stopReason: CiLoopResult['stopReason'] = 'max-iterations';

  // Configure agents
  const architectConfig: ArchitectConfig = {
    provider: options.architectProvider,
    executeTool: options.architectToolExecutor,
    maxRequirements: config.maxRequirementsPerIteration,
    maxTurns: config.architectMaxTurns,
    temperature: config.architectTemperature,
  };

  const programmerConfig: ProgrammerConfig = {
    provider: options.programmerProvider,
    executeTool: options.programmerToolExecutor,
    maxTurns: config.programmerMaxTurns,
    temperature: config.programmerTemperature,
  };

  // Main CI loop
  for (let i = 0; i < config.maxIterations; i++) {
    const iterationStart = Date.now();

    const iteration: CiIteration = {
      index: i,
      status: 'running',
      preTestResult: { tests: [], total: 0, passed: 0, failed: 0, errored: 0, skipped: 0, exitCode: -1, rawOutput: '', timestamp: 0 },
      startedAt: iterationStart,
    };

    try {
      // Step 1: Run tests to establish current state
      const preTestResult = await runTests({
        command: config.testCommand,
        cwd: config.workingDir,
      });
      iteration.preTestResult = preTestResult;

      // Check if all tests pass — we're done
      if (config.stopOnAllPass && preTestResult.failed === 0 && preTestResult.errored === 0 && preTestResult.total > 0) {
        iteration.status = 'completed';
        iteration.completedAt = Date.now();
        iteration.durationMs = Date.now() - iterationStart;
        iterations.push(iteration);
        stopReason = 'all-tests-pass';
        options.onIterationComplete?.(iteration);
        break;
      }

      // Compute regression report (compare with previous iteration's post-test)
      let regressionReport: RegressionReport | undefined;
      if (i > 0) {
        const previousPost = iterations[i - 1]?.postTestResult;
        if (previousPost) {
          regressionReport = compareTestRuns(previousPost, preTestResult);
          iteration.regressionReport = regressionReport;
        }
      }

      // Step 2: Run Architect to analyze failures and design requirements
      const { analysis, agentResult: architectResult } = await runArchitect(
        architectConfig,
        preTestResult,
        regressionReport,
        i,
      );
      iteration.architectAnalysis = analysis;

      // If no requirements produced, the Architect couldn't find actionable work
      if (analysis.requirements.length === 0) {
        iteration.status = 'completed';
        iteration.completedAt = Date.now();
        iteration.durationMs = Date.now() - iterationStart;
        iterations.push(iteration);
        stagnationCount++;

        if (stagnationCount >= config.stagnationLimit) {
          stopReason = 'stagnation';
          options.onIterationComplete?.(iteration);
          break;
        }
        options.onIterationComplete?.(iteration);
        continue;
      }

      // Step 3: Run Programmer to implement requirements
      const architectMessage = resultToMessage(architectResult);
      const { result: programmerResult } = await runProgrammer(
        programmerConfig,
        analysis,
        architectMessage,
      );
      iteration.programmerResult = programmerResult;

      // Step 4: Run tests again to measure impact
      const postTestResult = await runTests({
        command: config.testCommand,
        cwd: config.workingDir,
      });
      iteration.postTestResult = postTestResult;

      // Compute regression for this iteration's changes
      const postRegression = compareTestRuns(preTestResult, postTestResult);
      iteration.regressionReport = postRegression;

      // Check stagnation
      const currentPassRate = postTestResult.total > 0
        ? postTestResult.passed / postTestResult.total
        : 0;

      if (currentPassRate <= previousBestPassRate) {
        stagnationCount++;
      } else {
        stagnationCount = 0;
        previousBestPassRate = currentPassRate;
      }

      // Mark iteration complete
      iteration.status = 'completed';
      iteration.completedAt = Date.now();
      iteration.durationMs = Date.now() - iterationStart;
      iterations.push(iteration);

      options.onIterationComplete?.(iteration);

      // Check stagnation limit
      if (stagnationCount >= config.stagnationLimit) {
        stopReason = 'stagnation';
        break;
      }

      // Check if all tests now pass
      if (config.stopOnAllPass && postTestResult.failed === 0 && postTestResult.errored === 0 && postTestResult.total > 0) {
        stopReason = 'all-tests-pass';
        break;
      }
    } catch (err: unknown) {
      iteration.status = 'failed';
      iteration.completedAt = Date.now();
      iteration.durationMs = Date.now() - iterationStart;
      iterations.push(iteration);
      stopReason = 'error';
      options.onIterationComplete?.(iteration);
      break;
    }
  }

  // Compute final metrics
  const evoScore = computeFullEvoScore(iterations, config.gamma);

  // Notify with final metrics
  const metricsReport = formatEvoScoreReport(evoScore);
  options.onMetricsUpdate?.(metricsReport);

  const totalDurationMs = Date.now() - startTime;

  return {
    iterations,
    evoScore,
    stopReason,
    totalDurationMs,
    summary: buildLoopSummary(iterations, evoScore, stopReason, totalDurationMs),
    config,
  };
}

/**
 * Build a human-readable summary of the CI loop run.
 */
function buildLoopSummary(
  iterations: CiIteration[],
  evoScore: ReturnType<typeof computeFullEvoScore>,
  stopReason: CiLoopResult['stopReason'],
  totalDurationMs: number,
): string {
  const lines: string[] = [];

  lines.push('# CI Loop Summary');
  lines.push('');

  // Stop reason
  const stopReasonLabels: Record<string, string> = {
    'all-tests-pass': 'All tests passing',
    'max-iterations': 'Maximum iterations reached',
    'stagnation': 'No progress (stagnation limit reached)',
    'error': 'Error encountered',
  };
  lines.push(`**Stopped:** ${stopReasonLabels[stopReason] ?? stopReason}`);
  lines.push(`**Iterations:** ${iterations.length}`);
  lines.push(`**Duration:** ${(totalDurationMs / 1000).toFixed(1)}s`);
  lines.push('');

  // Metrics
  lines.push(`**EvoScore:** ${evoScore.score.toFixed(4)} (γ = ${evoScore.gamma})`);
  lines.push(`**Zero-Regression Rate:** ${(evoScore.zeroRegressionRate * 100).toFixed(1)}%`);
  lines.push(`**Pass Rate:** ${(evoScore.initialPassRate * 100).toFixed(1)}% → ${(evoScore.finalPassRate * 100).toFixed(1)}%`);
  lines.push('');

  // Per-iteration summary
  lines.push('## Iterations');
  for (const iter of iterations) {
    const pre = iter.preTestResult;
    const post = iter.postTestResult;
    const reqCount = iter.architectAnalysis?.requirements.length ?? 0;
    const modCount = iter.programmerResult?.modifications.length ?? 0;

    lines.push(`### Iteration ${iter.index}`);
    lines.push(`- Pre-tests: ${pre.passed}/${pre.total} passing`);
    if (post) {
      lines.push(`- Post-tests: ${post.passed}/${post.total} passing`);
    }
    lines.push(`- Requirements: ${reqCount}`);
    lines.push(`- Modifications: ${modCount}`);
    if (iter.regressionReport) {
      lines.push(`- Regressions: ${iter.regressionReport.regressionCount}`);
      lines.push(`- Fixed: ${iter.regressionReport.fixedCount}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}
