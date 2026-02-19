/**
 * Validation Pipeline
 *
 * Orchestrates the validation loop: parse -> lint -> typecheck -> test -> commit
 */

import * as path from 'path';
import type {
  ValidationConfig,
  ValidationResult,
  ValidationStepResult,
  ValidationError,
} from './types.js';
import { DEFAULT_VALIDATION_CONFIG } from './types.js';
import { parseFiles } from './parser.js';
import { runLint, runTypecheck, runTest } from './runner.js';

/**
 * Validation pipeline for running checks on edited files.
 */
export class ValidationPipeline {
  private config: Required<Omit<ValidationConfig, 'rootPath'>>;
  private rootPath: string;

  /** Baseline errors (pre-existing before edits) */
  private baselineErrors: Map<string, Set<string>> = new Map();

  constructor(config: ValidationConfig) {
    this.rootPath = path.isAbsolute(config.rootPath)
      ? config.rootPath
      : path.resolve(config.rootPath);

    this.config = {
      ...DEFAULT_VALIDATION_CONFIG,
      ...config,
    };
  }

  /**
   * Run the full validation pipeline on the given files.
   */
  async validate(files: string[]): Promise<ValidationResult> {
    const startTime = Date.now();
    const steps: ValidationStepResult[] = [];
    let allPassed = true;

    // Resolve file paths
    const absoluteFiles = files.map((f) =>
      path.isAbsolute(f) ? f : path.join(this.rootPath, f)
    );

    // Step 1: Parse check
    if (this.config.parseCheck) {
      const parseResult = await parseFiles(absoluteFiles);
      steps.push(parseResult);

      if (!parseResult.passed) {
        allPassed = false;
        // Don't continue if parse fails
        return this.buildResult(allPassed, steps, files, startTime);
      }
    }

    // Step 2: Lint
    if (this.config.lintOnEdit) {
      const lintResult = await runLint(
        this.config.lintCommand,
        this.rootPath,
        this.config.stepTimeout
      );

      // Filter to only new errors if configured
      if (this.config.onlyNewErrors) {
        lintResult.errors = this.filterNewErrors(lintResult.errors, 'lint');
      }

      steps.push(lintResult);

      if (!lintResult.passed && lintResult.errors.length > 0) {
        allPassed = false;
      }
    }

    // Step 3: Typecheck
    if (this.config.typecheckOnEdit) {
      const typecheckResult = await runTypecheck(
        this.config.typecheckCommand,
        this.rootPath,
        this.config.stepTimeout
      );

      // Filter to only new errors if configured
      if (this.config.onlyNewErrors) {
        typecheckResult.errors = this.filterNewErrors(typecheckResult.errors, 'typecheck');
      }

      steps.push(typecheckResult);

      if (!typecheckResult.passed && typecheckResult.errors.length > 0) {
        allPassed = false;
      }
    }

    // Step 4: Test (optional)
    if (this.config.testOnEdit) {
      const testResult = await runTest(
        this.config.testCommand,
        this.rootPath,
        this.config.stepTimeout
      );

      steps.push(testResult);

      if (!testResult.passed) {
        allPassed = false;
      }
    }

    return this.buildResult(allPassed, steps, files, startTime);
  }

  /**
   * Run a quick validation (parse only).
   */
  async validateQuick(files: string[]): Promise<ValidationResult> {
    const startTime = Date.now();
    const absoluteFiles = files.map((f) =>
      path.isAbsolute(f) ? f : path.join(this.rootPath, f)
    );

    const parseResult = await parseFiles(absoluteFiles);

    return this.buildResult(parseResult.passed, [parseResult], files, startTime);
  }

  /**
   * Run only lint validation.
   */
  async validateLint(): Promise<ValidationStepResult> {
    return runLint(this.config.lintCommand, this.rootPath, this.config.stepTimeout);
  }

  /**
   * Run only typecheck validation.
   */
  async validateTypecheck(): Promise<ValidationStepResult> {
    return runTypecheck(
      this.config.typecheckCommand,
      this.rootPath,
      this.config.stepTimeout
    );
  }

  /**
   * Run only test validation.
   */
  async validateTest(): Promise<ValidationStepResult> {
    return runTest(this.config.testCommand, this.rootPath, this.config.stepTimeout);
  }

  /**
   * Capture baseline errors for comparison.
   */
  async captureBaseline(): Promise<void> {
    this.baselineErrors.clear();

    // Run lint and capture errors
    if (this.config.lintOnEdit) {
      const lintResult = await this.validateLint();
      this.baselineErrors.set('lint', this.errorsToSet(lintResult.errors));
    }

    // Run typecheck and capture errors
    if (this.config.typecheckOnEdit) {
      const typecheckResult = await this.validateTypecheck();
      this.baselineErrors.set('typecheck', this.errorsToSet(typecheckResult.errors));
    }
  }

  /**
   * Clear baseline errors.
   */
  clearBaseline(): void {
    this.baselineErrors.clear();
  }

  /**
   * Filter to only new errors (not in baseline).
   */
  private filterNewErrors(errors: ValidationError[], step: string): ValidationError[] {
    const baseline = this.baselineErrors.get(step);
    if (!baseline) {
      return errors;
    }

    return errors.filter((error) => {
      const key = this.errorKey(error);
      return !baseline.has(key);
    });
  }

  /**
   * Convert errors to a Set of keys for comparison.
   */
  private errorsToSet(errors: ValidationError[]): Set<string> {
    return new Set(errors.map((e) => this.errorKey(e)));
  }

  /**
   * Create a unique key for an error.
   */
  private errorKey(error: ValidationError): string {
    return `${error.file}:${error.line ?? 0}:${error.column ?? 0}:${error.code ?? ''}:${error.message}`;
  }

  /**
   * Build the final validation result.
   */
  private buildResult(
    success: boolean,
    steps: ValidationStepResult[],
    files: string[],
    startTime: number
  ): ValidationResult {
    const totalDurationMs = Date.now() - startTime;

    // Build summary
    const passedSteps = steps.filter((s) => s.passed && !s.skipped).length;
    const failedSteps = steps.filter((s) => !s.passed && !s.skipped).length;
    let summary: string;
    if (success) {
      summary = `✓ Validation passed (${passedSteps} steps, ${totalDurationMs}ms)`;
    } else {
      const totalErrors = steps.reduce((sum, s) => sum + s.errors.length, 0);
      summary = `✗ Validation failed: ${totalErrors} error(s) in ${failedSteps} step(s)`;
    }

    return {
      success,
      steps,
      totalDurationMs,
      files,
      summary,
    };
  }

  /**
   * Get configuration.
   */
  getConfig(): ValidationConfig {
    return { ...this.config, rootPath: this.rootPath };
  }

  /**
   * Update configuration.
   */
  updateConfig(updates: Partial<Omit<ValidationConfig, 'rootPath'>>): void {
    Object.assign(this.config, updates);
  }
}

/**
 * Create a validation pipeline.
 */
export function createValidationPipeline(config: ValidationConfig): ValidationPipeline {
  return new ValidationPipeline(config);
}

/**
 * Format validation result for display.
 */
export function formatValidationResult(result: ValidationResult): string {
  const lines: string[] = [];

  lines.push(result.summary);
  lines.push('');

  for (const step of result.steps) {
    if (step.skipped) {
      lines.push(`  ○ ${step.step}: skipped${step.skipReason ? ` (${step.skipReason})` : ''}`);
      continue;
    }

    const icon = step.passed ? '✓' : '✗';
    lines.push(`  ${icon} ${step.step}: ${step.passed ? 'passed' : 'failed'} (${step.durationMs}ms)`);

    // Show errors
    for (const error of step.errors.slice(0, 10)) {
      const location = error.line ? `:${error.line}${error.column ? `:${error.column}` : ''}` : '';
      lines.push(`      ${error.file}${location}: ${error.message}`);
    }

    if (step.errors.length > 10) {
      lines.push(`      ... and ${step.errors.length - 10} more errors`);
    }

    // Show warnings (limited)
    for (const warning of step.warnings.slice(0, 3)) {
      lines.push(`      ⚠ ${warning.message}`);
    }

    if (step.warnings.length > 3) {
      lines.push(`      ... and ${step.warnings.length - 3} more warnings`);
    }
  }

  return lines.join('\n');
}

/**
 * Get a quick summary of errors.
 */
export function getErrorSummary(result: ValidationResult): string[] {
  const errors: string[] = [];

  for (const step of result.steps) {
    for (const error of step.errors) {
      const location = error.line ? `:${error.line}` : '';
      errors.push(`[${step.step}] ${error.file}${location}: ${error.message}`);
    }
  }

  return errors;
}
