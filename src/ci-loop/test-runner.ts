/**
 * Test Runner
 *
 * Executes test commands and parses results into structured TestRunResult.
 * Supports common test runner output formats (TAP, Vitest/Jest JSON, and
 * generic pass/fail line parsing).
 *
 * Privacy: All test execution is local. No data leaves the machine.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { TestCase, TestRunResult, TestStatus } from './types.js';

const execFileAsync = promisify(execFile);

/** Options for running tests */
export interface TestRunnerOptions {
  /** The test command to execute (e.g., 'npm test') */
  command: string;

  /** Working directory */
  cwd: string;

  /** Timeout in milliseconds (default: 300_000 = 5 min) */
  timeoutMs?: number;

  /** Environment variables to pass */
  env?: Record<string, string>;
}

/**
 * Run tests and return structured results.
 *
 * Executes the given command in a shell and parses the output to extract
 * individual test case results. Falls back to line-by-line parsing if
 * structured output is not available.
 */
export async function runTests(options: TestRunnerOptions): Promise<TestRunResult> {
  const { command, cwd, timeoutMs = 300_000, env } = options;
  const timestamp = Date.now();

  // Split command for shell execution
  const parts = command.split(/\s+/);
  const cmd = parts[0]!;
  const args = parts.slice(1);

  let stdout = '';
  let stderr = '';
  let exitCode = 0;

  try {
    const result = await execFileAsync(cmd, args, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024, // 10 MB
      shell: true,
      env: { ...process.env, ...env },
    });
    stdout = result.stdout;
    stderr = result.stderr;
  } catch (err: unknown) {
    // Test failures cause non-zero exit — this is expected
    const execErr = err as { stdout?: string; stderr?: string; code?: number };
    stdout = execErr.stdout ?? '';
    stderr = execErr.stderr ?? '';
    exitCode = execErr.code ?? 1;
  }

  const rawOutput = `${stdout}\n${stderr}`.trim();
  const tests = parseTestOutput(rawOutput);

  const passed = tests.filter((t) => t.status === 'passed').length;
  const failed = tests.filter((t) => t.status === 'failed').length;
  const errored = tests.filter((t) => t.status === 'error').length;
  const skipped = tests.filter((t) => t.status === 'skipped').length;

  return {
    tests,
    total: tests.length,
    passed,
    failed,
    errored,
    skipped,
    exitCode,
    rawOutput,
    timestamp,
  };
}

/**
 * Parse test output into individual test cases.
 *
 * Tries multiple formats in order:
 * 1. JSON reporter output (Vitest/Jest --json)
 * 2. TAP format
 * 3. Generic line-by-line parsing (✓/✗, PASS/FAIL patterns)
 */
export function parseTestOutput(output: string): TestCase[] {
  // Try JSON format first
  const jsonTests = tryParseJson(output);
  if (jsonTests.length > 0) return jsonTests;

  // Try TAP format
  const tapTests = tryParseTap(output);
  if (tapTests.length > 0) return tapTests;

  // Fall back to generic line parsing
  return parseGenericOutput(output);
}

/**
 * Try to parse JSON test reporter output (Vitest/Jest format).
 */
function tryParseJson(output: string): TestCase[] {
  // Look for JSON block in output
  const jsonMatch = output.match(/\{[\s\S]*"testResults"[\s\S]*\}/);
  if (!jsonMatch) return [];

  try {
    const data = JSON.parse(jsonMatch[0]) as {
      testResults?: Array<{
        testResults?: Array<{
          fullName?: string;
          title?: string;
          status?: string;
          duration?: number;
          failureMessages?: string[];
        }>;
      }>;
    };

    const tests: TestCase[] = [];
    for (const suite of data.testResults ?? []) {
      for (const test of suite.testResults ?? []) {
        const tc: TestCase = {
          name: test.fullName ?? test.title ?? 'unknown',
          status: mapJsonStatus(test.status),
        };
        if (test.duration !== undefined) tc.durationMs = test.duration;
        if (test.failureMessages && test.failureMessages.length > 0) {
          tc.errorMessage = test.failureMessages.join('\n');
        }
        tests.push(tc);
      }
    }
    return tests;
  } catch {
    return [];
  }
}

function mapJsonStatus(status?: string): TestStatus {
  switch (status) {
    case 'passed': return 'passed';
    case 'failed': return 'failed';
    case 'pending':
    case 'skipped':
    case 'todo': return 'skipped';
    default: return 'error';
  }
}

/**
 * Try to parse TAP (Test Anything Protocol) format.
 */
function tryParseTap(output: string): TestCase[] {
  const lines = output.split('\n');
  const tests: TestCase[] = [];

  // Check for TAP header
  const hasTap = lines.some((l) => /^TAP version/i.test(l) || /^1\.\.\d+/.test(l));
  if (!hasTap) return [];

  for (const line of lines) {
    const okMatch = line.match(/^ok\s+\d*\s*[-–]?\s*(.*)/);
    if (okMatch) {
      const name = okMatch[1]?.trim() || 'unnamed test';
      const isSkip = /# skip/i.test(line) || /# todo/i.test(line);
      tests.push({
        name,
        status: isSkip ? 'skipped' : 'passed',
      });
      continue;
    }

    const notOkMatch = line.match(/^not ok\s+\d*\s*[-–]?\s*(.*)/);
    if (notOkMatch) {
      const name = notOkMatch[1]?.trim() || 'unnamed test';
      tests.push({
        name,
        status: 'failed',
        errorMessage: name,
      });
    }
  }

  return tests;
}

/**
 * Parse generic test output by looking for common patterns.
 *
 * Recognizes:
 * - ✓ / ✗ / ✔ / ✘ prefixed lines
 * - PASS / FAIL prefixed lines
 * - "passed" / "failed" suffixed lines
 * - Vitest-style "✓ test name" and "× test name"
 */
export function parseGenericOutput(output: string): TestCase[] {
  const lines = output.split('\n');
  const tests: TestCase[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // ✓ or ✔ = passed
    const passMatch = trimmed.match(/^[✓✔]\s+(.*)/);
    if (passMatch) {
      tests.push({ name: passMatch[1]!.trim(), status: 'passed' });
      continue;
    }

    // ✗ or ✘ or × = failed
    const failMatch = trimmed.match(/^[✗✘×]\s+(.*)/);
    if (failMatch) {
      tests.push({ name: failMatch[1]!.trim(), status: 'failed' });
      continue;
    }

    // PASS: or FAIL: prefix
    const passPrefix = trimmed.match(/^PASS[:\s]+(.+)/);
    if (passPrefix) {
      tests.push({ name: passPrefix[1]!.trim(), status: 'passed' });
      continue;
    }
    const failPrefix = trimmed.match(/^FAIL[:\s]+(.+)/);
    if (failPrefix) {
      tests.push({ name: failPrefix[1]!.trim(), status: 'failed' });
      continue;
    }

    // "test name ... passed" or "test name ... failed"
    const suffixPass = trimmed.match(/^(.+?)\s+\.{2,}\s+passed$/i);
    if (suffixPass) {
      tests.push({ name: suffixPass[1]!.trim(), status: 'passed' });
      continue;
    }
    const suffixFail = trimmed.match(/^(.+?)\s+\.{2,}\s+failed$/i);
    if (suffixFail) {
      tests.push({ name: suffixFail[1]!.trim(), status: 'failed' });
      continue;
    }
  }

  return tests;
}
