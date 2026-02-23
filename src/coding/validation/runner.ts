/**
 * Command Runner
 *
 * Executes validation commands (lint, typecheck, test) and parses output.
 */

import { spawn } from 'child_process';
import type { ValidationError, ValidationStepResult, ValidationStep } from './types.js';

/**
 * Command execution result.
 */
export interface CommandResult {
  /** Exit code */
  exitCode: number;
  /** Standard output */
  stdout: string;
  /** Standard error */
  stderr: string;
  /** Whether the command timed out */
  timedOut: boolean;
  /** Duration in milliseconds */
  durationMs: number;
}

/**
 * Execute a command and capture output.
 */
export async function executeCommand(
  command: string,
  cwd: string,
  timeout: number = 60000
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const startTime = Date.now();
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    // Parse command into parts
    const parts = command.split(' ');
    const cmd = parts[0];
    const args = parts.slice(1);

    if (!cmd) {
      resolve({
        exitCode: 1,
        stdout: '',
        stderr: 'Empty command',
        timedOut: false,
        durationMs: 0,
      });
      return;
    }

    const proc = spawn(cmd, args, {
      cwd,
      shell: true,
      env: { ...process.env, FORCE_COLOR: '0' },
    });

    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGTERM');
    }, timeout);

    proc.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        exitCode: code ?? 1,
        stdout,
        stderr,
        timedOut,
        durationMs: Date.now() - startTime,
      });
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        exitCode: 1,
        stdout,
        stderr: err.message,
        timedOut: false,
        durationMs: Date.now() - startTime,
      });
    });
  });
}

/**
 * Parse TypeScript compiler errors from output.
 */
export function parseTypeScriptErrors(output: string): ValidationError[] {
  const errors: ValidationError[] = [];

  // TypeScript error format: file(line,col): error TSxxxx: message
  const pattern = /^(.+?)\((\d+),(\d+)\):\s*(error|warning)\s+TS(\d+):\s*(.+)$/gm;

  let match;
  while ((match = pattern.exec(output)) !== null) {
    const file = match[1];
    const line = match[2];
    const column = match[3];
    const severity = match[4];
    const code = match[5];
    const message = match[6];

    if (file && line && column && message) {
      const error: ValidationError = {
        file,
        line: parseInt(line, 10),
        column: parseInt(column, 10),
        message,
        severity: severity === 'error' ? 'error' : 'warning',
      };
      if (code) error.code = `TS${code}`;
      errors.push(error);
    }
  }

  return errors;
}

/**
 * Parse ESLint errors from output.
 */
export function parseEslintErrors(output: string): ValidationError[] {
  const errors: ValidationError[] = [];

  // ESLint default format: /path/file.ts
  //   line:col  error/warning  message  rule-name
  let currentFile = '';
  const lines = output.split('\n');

  for (const line of lines) {
    // Check if this is a file path
    const fileMatch = /^([^\s].+\.[a-z]+)$/.exec(line);
    if (fileMatch && fileMatch[1]) {
      currentFile = fileMatch[1];
      continue;
    }

    // Check if this is an error line
    const errorMatch = /^\s+(\d+):(\d+)\s+(error|warning)\s+(.+?)\s{2,}(.+)$/.exec(line);
    if (errorMatch && currentFile) {
      const lineNum = errorMatch[1];
      const column = errorMatch[2];
      const severity = errorMatch[3];
      const message = errorMatch[4];
      const rule = errorMatch[5];

      if (lineNum && column && message) {
        const error: ValidationError = {
          file: currentFile,
          line: parseInt(lineNum, 10),
          column: parseInt(column, 10),
          message,
          severity: severity === 'error' ? 'error' : 'warning',
        };
        if (rule) error.code = rule;
        errors.push(error);
      }
    }
  }

  return errors;
}

/**
 * Parse Jest/Vitest test errors from output.
 */
export function parseTestErrors(output: string): ValidationError[] {
  const errors: ValidationError[] = [];

  // Look for FAIL lines
  const failPattern = /FAIL\s+(.+)/g;
  let match;
  while ((match = failPattern.exec(output)) !== null) {
    const file = match[1];
    if (file) {
      errors.push({
        file: file.trim(),
        message: 'Test failed',
        severity: 'error',
        code: 'TEST_FAIL',
      });
    }
  }

  // Look for specific test failures
  const testFailPattern = /✕\s+(.+)/g;
  while ((match = testFailPattern.exec(output)) !== null) {
    const testName = match[1];
    if (testName) {
      errors.push({
        file: 'test',
        message: `Test failed: ${testName.trim()}`,
        severity: 'error',
        code: 'TEST_FAIL',
      });
    }
  }

  return errors;
}

/**
 * Run a validation command and return structured result.
 */
async function runValidationCommand(
  step: ValidationStep,
  command: string,
  cwd: string,
  timeout: number,
  parseErrors: (output: string) => ValidationError[]
): Promise<ValidationStepResult> {
  const result = await executeCommand(command, cwd, timeout);

  if (result.timedOut) {
    return {
      step,
      passed: false,
      errors: [
        {
          file: '',
          message: `Command timed out after ${timeout}ms`,
          severity: 'error',
          code: 'TIMEOUT',
        },
      ],
      warnings: [],
      durationMs: result.durationMs,
      skipped: false,
    };
  }

  const combinedOutput = result.stdout + '\n' + result.stderr;
  const errors = parseErrors(combinedOutput);

  // Filter to only actual errors (not warnings)
  const actualErrors = errors.filter((e) => e.severity === 'error');
  const warnings = errors.filter((e) => e.severity === 'warning');

  return {
    step,
    passed: result.exitCode === 0 && actualErrors.length === 0,
    errors: actualErrors,
    warnings,
    durationMs: result.durationMs,
    skipped: false,
  };
}

/**
 * Run lint validation.
 */
export async function runLint(
  command: string,
  cwd: string,
  timeout: number
): Promise<ValidationStepResult> {
  return runValidationCommand('lint', command, cwd, timeout, parseEslintErrors);
}

/**
 * Run typecheck validation.
 */
export async function runTypecheck(
  command: string,
  cwd: string,
  timeout: number
): Promise<ValidationStepResult> {
  return runValidationCommand('typecheck', command, cwd, timeout, parseTypeScriptErrors);
}

/**
 * Run test validation.
 */
export async function runTest(
  command: string,
  cwd: string,
  timeout: number
): Promise<ValidationStepResult> {
  return runValidationCommand('test', command, cwd, timeout, parseTestErrors);
}
