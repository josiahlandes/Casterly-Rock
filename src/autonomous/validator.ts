/**
 * Validator Module for Autonomous Self-Improvement
 *
 * Validates changes by running tests, checking invariants, and
 * ensuring quality gates pass before integration.
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import type {
  AutonomousConfig,
  Invariant,
  InvariantCheckResult,
  ValidationResult,
} from './types.js';
import { parseVitestJson, computeCoverageDelta, parseCoverageSummary } from './test-parser.js';
import * as fs from 'fs/promises';
import * as path from 'path';

const execAsync = promisify(exec);

// ============================================================================
// DEFAULT INVARIANTS
// ============================================================================

const DEFAULT_INVARIANTS: Invariant[] = [
  {
    name: 'quality_gates',
    check: 'npm run check',
    description: 'All quality gates must pass',
  },
  {
    name: 'no_type_errors',
    check: 'npm run typecheck',
    description: 'TypeScript compilation must succeed',
  },
  {
    name: 'tests_pass',
    check: 'npm run test',
    description: 'All tests must pass',
  },
];

// ============================================================================
// VALIDATOR
// ============================================================================

export class Validator {
  private readonly projectRoot: string;
  private readonly invariants: Invariant[];
  private readonly timeoutMs: number;

  constructor(
    projectRoot: string,
    config?: { invariants?: Invariant[]; timeoutMs?: number }
  ) {
    this.projectRoot = projectRoot;
    this.invariants = config?.invariants || DEFAULT_INVARIANTS;
    this.timeoutMs = config?.timeoutMs || 300_000; // 5 minutes default
  }

  /**
   * Run full validation: tests and invariants.
   */
  async validate(): Promise<ValidationResult> {
    const startTime = Date.now();

    // Snapshot coverage before running tests (for delta calculation)
    const coverageBefore = await this.readCoveragePercentage();

    // Run all invariants
    const invariantResults = await this.checkAllInvariants();

    // Check if any invariant failed
    const invariantsHold = invariantResults.every((r) => r.passed);

    // Run structured test pass for detailed counts
    const structuredTests = await this.runTestsStructured();

    const testsPassed = structuredTests.success;
    const testsRun = structuredTests.summary.total;
    const testsFailed = structuredTests.summary.failed;

    // Collect all errors
    const errors = invariantResults.filter((r) => !r.passed).map((r) => `${r.name}: ${r.error || 'Failed'}`);

    // Add test failure details
    for (const f of structuredTests.failures) {
      errors.push(`test: ${f.suiteName ? f.suiteName + ' > ' : ''}${f.testName}`);
    }

    // Collect warnings (from stdout that might contain warnings)
    const warnings = invariantResults
      .filter((r) => r.passed && r.output?.includes('warning'))
      .map((r) => `${r.name}: has warnings`);

    const endTime = Date.now();

    // Compute coverage delta if data is available
    const coverageAfter = await this.readCoveragePercentage();
    const coverageDelta =
      coverageBefore > 0 && coverageAfter > 0
        ? computeCoverageDelta(coverageBefore, coverageAfter)
        : undefined;

    return {
      passed: invariantsHold && testsPassed,
      invariantsHold,
      testsPassed,
      testsRun,
      testsFailed,
      errors,
      warnings,
      metrics: {
        testDurationMs: endTime - startTime,
        coverageDelta,
      },
    };
  }

  /**
   * Check all invariants.
   */
  async checkAllInvariants(): Promise<InvariantCheckResult[]> {
    const results: InvariantCheckResult[] = [];

    for (const invariant of this.invariants) {
      const result = await this.checkInvariant(invariant);
      results.push(result);

      // If this invariant failed and is critical, we might want to stop early
      // For now, we continue checking all invariants
    }

    return results;
  }

  /**
   * Check a single invariant.
   */
  async checkInvariant(invariant: Invariant): Promise<InvariantCheckResult> {
    const startTime = Date.now();

    try {
      const { stdout, stderr } = await execAsync(invariant.check, {
        cwd: this.projectRoot,
        timeout: this.timeoutMs,
      });

      const endTime = Date.now();
      const output = stdout + stderr;

      // If invert is true, success means failure
      const passed = invariant.invert ? false : true;

      return {
        name: invariant.name,
        passed,
        output,
        durationMs: endTime - startTime,
      };
    } catch (error) {
      const endTime = Date.now();
      const err = error as { stdout?: string; stderr?: string; message?: string };

      // Command failed (non-zero exit code)
      // If invert is true, failure means success
      const passed = invariant.invert ? true : false;

      return {
        name: invariant.name,
        passed,
        output: err.stdout || '',
        error: err.stderr || err.message || 'Check failed',
        durationMs: endTime - startTime,
      };
    }
  }

  /**
   * Run tests with the Vitest JSON reporter and parse the structured output.
   */
  private async runTestsStructured() {
    try {
      const { stdout } = await execAsync(
        'npx vitest run --reporter=json 2>/dev/null',
        { cwd: this.projectRoot, timeout: this.timeoutMs }
      );
      return parseVitestJson(stdout);
    } catch (error) {
      // Even on failure, vitest may have printed JSON to stdout
      const err = error as { stdout?: string };
      if (err.stdout) {
        return parseVitestJson(err.stdout);
      }
      return parseVitestJson('');
    }
  }

  /**
   * Read the current coverage percentage from the coverage summary file.
   * Returns 0 if no coverage data is available.
   */
  private async readCoveragePercentage(): Promise<number> {
    try {
      const coveragePath = path.join(this.projectRoot, 'coverage', 'coverage-summary.json');
      const raw = await fs.readFile(coveragePath, 'utf-8');
      const summary = parseCoverageSummary(raw);
      return summary.percentage;
    } catch {
      return 0;
    }
  }

  /**
   * Quick check - just run typecheck and lint (faster than full validation).
   */
  async quickCheck(): Promise<boolean> {
    try {
      await execAsync('npm run typecheck && npm run lint', {
        cwd: this.projectRoot,
        timeout: 60000,
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Run tests only.
   */
  async runTests(): Promise<{ passed: boolean; output: string }> {
    try {
      const { stdout, stderr } = await execAsync('npm run test', {
        cwd: this.projectRoot,
        timeout: this.timeoutMs,
      });
      return { passed: true, output: stdout + stderr };
    } catch (error) {
      const err = error as { stdout?: string; stderr?: string };
      return { passed: false, output: (err.stdout || '') + (err.stderr || '') };
    }
  }

  /**
   * Parse test output to extract counts (basic implementation).
   */
  parseTestOutput(output: string): { total: number; passed: number; failed: number } {
    // Try to match vitest output format: "Tests: X passed, Y failed"
    const vitestMatch = output.match(/Tests?\s*(?:\[[\w-]+\])?\s*(\d+)\s*passed/i);
    const failedMatch = output.match(/(\d+)\s*failed/i);

    const passed = vitestMatch && vitestMatch[1] ? parseInt(vitestMatch[1], 10) : 0;
    const failed = failedMatch && failedMatch[1] ? parseInt(failedMatch[1], 10) : 0;

    return {
      total: passed + failed,
      passed,
      failed,
    };
  }
}

// ============================================================================
// INVARIANT BUILDER
// ============================================================================

/**
 * Helper to build invariant configurations.
 */
export function buildInvariants(config?: AutonomousConfig): Invariant[] {
  // Start with defaults
  const invariants = [...DEFAULT_INVARIANTS];

  // Add protected paths check
  invariants.push({
    name: 'protected_paths',
    check: 'node scripts/guardrails.mjs',
    description: 'Protected paths must remain unchanged',
  });

  // Add no-force-push check
  invariants.push({
    name: 'git_history',
    check: 'git reflog | head -1 | grep -v "force"',
    description: 'No force pushes or history rewrites',
  });

  return invariants;
}
