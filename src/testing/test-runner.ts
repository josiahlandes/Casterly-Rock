/**
 * Test Runner
 *
 * Executes test cases and compares actual results with expected outcomes.
 */

import type { TestCase, TestResult, ExpectedOutcome } from './test-cases.js';
import type { RequestTrace, TraceCollector } from './trace.js';

export interface TestRunnerOptions {
  /** Function to execute a request and get trace */
  executeRequest: (input: string, collector: TraceCollector) => Promise<string>;
  /** Timeout for each test in ms */
  timeoutMs?: number | undefined;
  /** Continue on failure */
  continueOnFailure?: boolean | undefined;
  /** Callback for each test completion */
  onTestComplete?: ((result: TestResult) => void) | undefined;
}

export interface TestRunSummary {
  totalTests: number;
  passed: number;
  failed: number;
  skipped: number;
  totalDurationMs: number;
  results: TestResult[];
}

/**
 * Evaluate a test result against expected outcome
 */
export function evaluateResult(
  testCase: TestCase,
  trace: RequestTrace,
  response: string,
  error: string | null
): TestResult {
  const failures: string[] = [];
  const warnings: string[] = [];
  const { expected } = testCase;

  const summary = trace.summary;

  // Build actual outcome
  const actualOutcome = {
    provider: summary?.providerSelected?.provider ?? 'local',
    model: summary?.providerSelected?.model ?? null,
    toolsCalled: trace.events
      .filter((e) => e.type === 'tool_call_received')
      .map((e) => e.data.toolName as string),
    toolCallCount: summary?.toolCallsRequested ?? 0,
    response,
    durationMs: summary?.totalDurationMs ?? 0,
    error,
  };

  // Check: shouldSucceed
  if (expected.shouldSucceed !== undefined) {
    if (expected.shouldSucceed && error) {
      failures.push(`Expected success but got error: ${error}`);
    }
    if (!expected.shouldSucceed && !error) {
      failures.push('Expected error but request succeeded');
    }
  }

  // Check: shouldCallTools
  if (expected.shouldCallTools !== undefined) {
    const calledTools = actualOutcome.toolCallCount > 0;
    if (expected.shouldCallTools && !calledTools) {
      failures.push('Expected tool calls but none were made');
    }
    if (!expected.shouldCallTools && calledTools) {
      failures.push(`Expected no tool calls but ${actualOutcome.toolCallCount} were made`);
    }
  }

  // Check: expectedToolNames
  if (expected.expectedToolNames !== undefined) {
    for (const toolName of expected.expectedToolNames) {
      if (!actualOutcome.toolsCalled.includes(toolName)) {
        failures.push(
          `Expected tool "${toolName}" not called. Called tools: [${actualOutcome.toolsCalled.join(', ')}]`
        );
      }
    }
  }

  // Check: toolCallCount
  if (expected.toolCallCount !== undefined) {
    if (expected.toolCallCount.min !== undefined && actualOutcome.toolCallCount < expected.toolCallCount.min) {
      failures.push(
        `Tool call count ${actualOutcome.toolCallCount} below minimum ${expected.toolCallCount.min}`
      );
    }
    if (expected.toolCallCount.max !== undefined && actualOutcome.toolCallCount > expected.toolCallCount.max) {
      failures.push(
        `Tool call count ${actualOutcome.toolCallCount} above maximum ${expected.toolCallCount.max}`
      );
    }
  }

  // Check: responsePattern
  if (expected.responsePattern !== undefined) {
    if (!expected.responsePattern.test(response)) {
      failures.push(`Response does not match pattern: ${expected.responsePattern}`);
    }
  }

  // Check: responseExcludePattern
  if (expected.responseExcludePattern !== undefined) {
    if (expected.responseExcludePattern.test(response)) {
      failures.push(`Response matches exclusion pattern: ${expected.responseExcludePattern}`);
    }
  }

  // Check: responseContains
  if (expected.responseContains !== undefined) {
    for (const keyword of expected.responseContains) {
      if (!response.toLowerCase().includes(keyword.toLowerCase())) {
        failures.push(`Response does not contain expected keyword: "${keyword}"`);
      }
    }
  }

  // Check: maxDurationMs
  if (expected.maxDurationMs !== undefined) {
    if (actualOutcome.durationMs > expected.maxDurationMs) {
      failures.push(
        `Duration ${actualOutcome.durationMs}ms exceeds maximum ${expected.maxDurationMs}ms`
      );
    }
  }

  return {
    testCase,
    passed: failures.length === 0,
    failures,
    warnings,
    actualOutcome,
    trace,
  };
}

/**
 * Format test result for display
 */
export function formatTestResult(result: TestResult, verbose = false): string {
  const lines: string[] = [];
  const status = result.passed ? '✓ PASS' : '✗ FAIL';
  const statusColor = result.passed ? '\x1b[32m' : '\x1b[31m';
  const reset = '\x1b[0m';

  lines.push(`${statusColor}${status}${reset} [${result.testCase.id}] ${result.testCase.name}`);

  if (!result.passed || verbose) {
    lines.push(`  Description: ${result.testCase.description}`);
    lines.push(`  Input: "${result.testCase.input.substring(0, 60)}${result.testCase.input.length > 60 ? '...' : ''}"`);
    lines.push(`  Duration: ${result.actualOutcome.durationMs}ms`);
    lines.push(`  Provider: ${result.actualOutcome.provider}`);
    lines.push(`  Model: ${result.actualOutcome.model ?? 'N/A'}`);
    lines.push(`  Tools Called: ${result.actualOutcome.toolsCalled.join(', ') || 'none'}`);
  }

  if (result.failures.length > 0) {
    lines.push('  Failures:');
    for (const failure of result.failures) {
      lines.push(`    - ${failure}`);
    }
  }

  if (result.warnings.length > 0) {
    lines.push('  Warnings:');
    for (const warning of result.warnings) {
      lines.push(`    - ${warning}`);
    }
  }

  if (verbose && result.actualOutcome.response) {
    lines.push('  Response:');
    const responseLines = result.actualOutcome.response.split('\n').slice(0, 5);
    for (const line of responseLines) {
      lines.push(`    ${line.substring(0, 100)}`);
    }
    if (result.actualOutcome.response.split('\n').length > 5) {
      lines.push('    ...');
    }
  }

  return lines.join('\n');
}

/**
 * Format test run summary
 */
export function formatTestSummary(summary: TestRunSummary): string {
  const lines: string[] = [];

  lines.push('');
  lines.push('═'.repeat(60));
  lines.push('TEST RUN SUMMARY');
  lines.push('═'.repeat(60));
  lines.push(`Total Tests: ${summary.totalTests}`);
  lines.push(`\x1b[32mPassed: ${summary.passed}\x1b[0m`);
  lines.push(`\x1b[31mFailed: ${summary.failed}\x1b[0m`);
  lines.push(`Skipped: ${summary.skipped}`);
  lines.push(`Total Duration: ${summary.totalDurationMs}ms`);
  lines.push('═'.repeat(60));

  if (summary.failed > 0) {
    lines.push('');
    lines.push('Failed Tests:');
    for (const result of summary.results.filter((r) => !r.passed)) {
      lines.push(`  - [${result.testCase.id}] ${result.testCase.name}`);
      for (const failure of result.failures) {
        lines.push(`      ${failure}`);
      }
    }
  }

  return lines.join('\n');
}

/**
 * Create a test runner
 */
export function createTestRunner(options: TestRunnerOptions) {
  const { executeRequest, timeoutMs = 120000, continueOnFailure = true, onTestComplete } = options;

  return {
    /**
     * Run a single test case
     */
    async runTest(testCase: TestCase, collector: import('./trace.js').TraceCollector): Promise<TestResult> {
      let response = '';
      let error: string | null = null;

      try {
        const timeoutPromise = new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error(`Test timeout after ${timeoutMs}ms`)), timeoutMs);
        });

        response = await Promise.race([executeRequest(testCase.input, collector), timeoutPromise]);
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
        collector.setError(error);
      }

      const trace = collector.complete();
      const result = evaluateResult(testCase, trace, response, error);

      if (onTestComplete) {
        onTestComplete(result);
      }

      return result;
    },

    /**
     * Run multiple test cases
     */
    async runTests(
      testCases: TestCase[],
      createCollector: (input: string) => import('./trace.js').TraceCollector
    ): Promise<TestRunSummary> {
      const startTime = Date.now();
      const results: TestResult[] = [];
      let passed = 0;
      let failed = 0;
      let skipped = 0;

      for (const testCase of testCases) {
        if (testCase.skip) {
          skipped++;
          continue;
        }

        const collector = createCollector(testCase.input);
        const result = await this.runTest(testCase, collector);
        results.push(result);

        if (result.passed) {
          passed++;
        } else {
          failed++;
          if (!continueOnFailure) {
            break;
          }
        }
      }

      return {
        totalTests: testCases.length,
        passed,
        failed,
        skipped,
        totalDurationMs: Date.now() - startTime,
        results,
      };
    },
  };
}
