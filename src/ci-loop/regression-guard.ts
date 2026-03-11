/**
 * Regression Guard
 *
 * Detects regressions between test runs by comparing test results
 * across CI loop iterations. The key insight from SWE-CI: most agents
 * are local optimizers that fix failing tests but break passing ones.
 *
 * The Regression Guard:
 * 1. Compares test results between iterations
 * 2. Identifies which tests regressed (were passing, now failing)
 * 3. Produces a RegressionReport for the Architect to consider
 * 4. Tracks zero-regression streaks for EvoScore
 *
 * Privacy: All computation is local. No data leaves the machine.
 */

import type {
  TestRunResult,
  TestCase,
  TestDiff,
  TestDelta,
  RegressionReport,
} from './types.js';

/**
 * Compare two test runs and produce a regression report.
 *
 * @param previous - Test results from the previous iteration
 * @param current - Test results from the current iteration
 * @returns RegressionReport detailing all changes
 */
export function compareTestRuns(
  previous: TestRunResult,
  current: TestRunResult,
): RegressionReport {
  const previousMap = buildTestMap(previous.tests);
  const currentMap = buildTestMap(current.tests);

  const diffs: TestDiff[] = [];
  const allTestNames = new Set([...previousMap.keys(), ...currentMap.keys()]);

  for (const name of allTestNames) {
    const prev = previousMap.get(name);
    const curr = currentMap.get(name);
    const diff = classifyTestChange(name, prev, curr);
    diffs.push(diff);
  }

  const regressions = diffs.filter((d) => d.delta === 'regressed');
  const fixed = diffs.filter((d) => d.delta === 'fixed');
  const stablePass = diffs.filter((d) => d.delta === 'stable-pass');
  const stableFail = diffs.filter((d) => d.delta === 'stable-fail');
  const newTests = diffs.filter((d) => d.delta === 'new');
  const removed = diffs.filter((d) => d.delta === 'removed');

  return {
    diffs,
    regressionCount: regressions.length,
    fixedCount: fixed.length,
    stablePassCount: stablePass.length,
    stableFailCount: stableFail.length,
    newCount: newTests.length,
    removedCount: removed.length,
    hasRegressions: regressions.length > 0,
    regressedTests: regressions.map((d) => d.name),
  };
}

/**
 * Build a map from test name to TestCase for fast lookup.
 */
function buildTestMap(tests: TestCase[]): Map<string, TestCase> {
  const map = new Map<string, TestCase>();
  for (const test of tests) {
    map.set(test.name, test);
  }
  return map;
}

/**
 * Classify how a single test changed between runs.
 */
function classifyTestChange(
  name: string,
  previous: TestCase | undefined,
  current: TestCase | undefined,
): TestDiff {
  // New test (didn't exist before)
  if (!previous && current) {
    const diff: TestDiff = {
      name,
      delta: 'new',
      currentStatus: current.status,
    };
    if (current.status === 'failed' && current.errorMessage) {
      diff.errorMessage = current.errorMessage;
    }
    return diff;
  }

  // Removed test (existed before, doesn't now)
  if (previous && !current) {
    return {
      name,
      delta: 'removed',
      previousStatus: previous.status,
    };
  }

  // Both exist — compare statuses
  const prevPassing = isPassing(previous!.status);
  const currPassing = isPassing(current!.status);

  let delta: TestDelta;
  if (prevPassing && currPassing) {
    delta = 'stable-pass';
  } else if (!prevPassing && !currPassing) {
    delta = 'stable-fail';
  } else if (!prevPassing && currPassing) {
    delta = 'fixed';
  } else {
    delta = 'regressed';
  }

  const diff: TestDiff = {
    name,
    delta,
    previousStatus: previous!.status,
    currentStatus: current!.status,
  };
  if (current!.status === 'failed' && current!.errorMessage) {
    diff.errorMessage = current!.errorMessage;
  }
  return diff;
}

/**
 * Determine if a test status counts as "passing".
 * Skipped tests are treated as non-failing (not counted as regressions).
 */
function isPassing(status: string): boolean {
  return status === 'passed' || status === 'skipped';
}

/**
 * Format a regression report as a human-readable string.
 * Used to include in the Architect's context so it can design
 * requirements that avoid regressions.
 */
export function formatRegressionReport(report: RegressionReport): string {
  const lines: string[] = [];

  lines.push('## Regression Report');
  lines.push('');

  if (!report.hasRegressions) {
    lines.push('No regressions detected. All previously passing tests continue to pass.');
  } else {
    lines.push(`**WARNING: ${report.regressionCount} regression(s) detected.**`);
    lines.push('');
    lines.push('The following tests were passing but are now failing:');
    for (const name of report.regressedTests) {
      const diff = report.diffs.find((d) => d.name === name);
      const msg = diff?.errorMessage ? `: ${diff.errorMessage}` : '';
      lines.push(`  - ${name}${msg}`);
    }
  }

  lines.push('');
  lines.push('### Summary');
  lines.push(`- Fixed: ${report.fixedCount}`);
  lines.push(`- Regressed: ${report.regressionCount}`);
  lines.push(`- Stable (passing): ${report.stablePassCount}`);
  lines.push(`- Stable (failing): ${report.stableFailCount}`);
  lines.push(`- New tests: ${report.newCount}`);
  lines.push(`- Removed tests: ${report.removedCount}`);

  return lines.join('\n');
}

/**
 * Extract the names of all currently passing tests.
 * Used by the Architect to identify which tests must be protected
 * during the next iteration.
 */
export function getPassingTests(result: TestRunResult): string[] {
  return result.tests
    .filter((t) => t.status === 'passed')
    .map((t) => t.name);
}

/**
 * Extract the names of all currently failing tests.
 * Used by the Architect to focus its analysis.
 */
export function getFailingTests(result: TestRunResult): string[] {
  return result.tests
    .filter((t) => t.status === 'failed' || t.status === 'error')
    .map((t) => t.name);
}
