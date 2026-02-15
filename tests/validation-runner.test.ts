import { describe, expect, it } from 'vitest';

import {
  executeCommand,
  parseTypeScriptErrors,
  parseEslintErrors,
  parseTestErrors,
} from '../src/coding/validation/runner.js';

// ═══════════════════════════════════════════════════════════════════════════════
// parseTypeScriptErrors
// ═══════════════════════════════════════════════════════════════════════════════

describe('parseTypeScriptErrors', () => {
  it('returns empty for clean output', () => {
    expect(parseTypeScriptErrors('No errors found.')).toEqual([]);
  });

  it('parses single TS error', () => {
    const output = `src/index.ts(10,5): error TS2322: Type 'string' is not assignable to type 'number'.`;
    const errors = parseTypeScriptErrors(output);
    expect(errors.length).toBe(1);
    expect(errors[0]!.file).toBe('src/index.ts');
    expect(errors[0]!.line).toBe(10);
    expect(errors[0]!.column).toBe(5);
    expect(errors[0]!.severity).toBe('error');
    expect(errors[0]!.code).toBe('TS2322');
    expect(errors[0]!.message).toContain('Type');
  });

  it('parses multiple TS errors', () => {
    const output = `src/a.ts(1,1): error TS1005: ';' expected.
src/b.ts(20,10): error TS2339: Property 'foo' does not exist on type 'Bar'.
src/c.ts(5,3): warning TS6133: 'x' is declared but its value is never read.`;
    const errors = parseTypeScriptErrors(output);
    expect(errors.length).toBe(3);
    expect(errors[0]!.severity).toBe('error');
    expect(errors[2]!.severity).toBe('warning');
    expect(errors[2]!.code).toBe('TS6133');
  });

  it('handles multiline output with non-error lines', () => {
    const output = `Starting compilation...
src/index.ts(3,1): error TS2304: Cannot find name 'foo'.
Done.`;
    const errors = parseTypeScriptErrors(output);
    expect(errors.length).toBe(1);
    expect(errors[0]!.message).toContain('Cannot find name');
  });

  it('returns empty for empty string', () => {
    expect(parseTypeScriptErrors('')).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// parseEslintErrors
// ═══════════════════════════════════════════════════════════════════════════════

describe('parseEslintErrors', () => {
  it('returns empty for clean output', () => {
    expect(parseEslintErrors('All files passed linting.')).toEqual([]);
  });

  it('parses eslint errors with file context', () => {
    const output = `src/index.ts
  3:10  error  'foo' is defined but never used  no-unused-vars
  7:5   warning  Unexpected console statement    no-console`;
    const errors = parseEslintErrors(output);
    expect(errors.length).toBe(2);
    expect(errors[0]!.file).toBe('src/index.ts');
    expect(errors[0]!.line).toBe(3);
    expect(errors[0]!.column).toBe(10);
    expect(errors[0]!.severity).toBe('error');
    expect(errors[0]!.code).toBe('no-unused-vars');
    expect(errors[1]!.severity).toBe('warning');
    expect(errors[1]!.code).toBe('no-console');
  });

  it('handles multiple files', () => {
    const output = `src/a.ts
  1:1  error  Missing semicolon  semi

src/b.ts
  5:3  error  Unexpected var  no-var`;
    const errors = parseEslintErrors(output);
    expect(errors.length).toBe(2);
    expect(errors[0]!.file).toBe('src/a.ts');
    expect(errors[1]!.file).toBe('src/b.ts');
  });

  it('returns empty for empty string', () => {
    expect(parseEslintErrors('')).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// parseTestErrors
// ═══════════════════════════════════════════════════════════════════════════════

describe('parseTestErrors', () => {
  it('returns empty for passing test output', () => {
    const output = 'Tests  100 passed (100)\n Duration 500ms';
    expect(parseTestErrors(output)).toEqual([]);
  });

  it('detects FAIL lines', () => {
    const output = `FAIL src/tests/index.test.ts
FAIL src/tests/utils.test.ts`;
    const errors = parseTestErrors(output);
    expect(errors.length).toBe(2);
    expect(errors[0]!.file).toContain('index.test.ts');
    expect(errors[0]!.severity).toBe('error');
    expect(errors[0]!.code).toBe('TEST_FAIL');
  });

  it('detects specific test failures with ✕', () => {
    const output = `  ✕ should handle null input
  ✕ should timeout after 5s`;
    const errors = parseTestErrors(output);
    expect(errors.length).toBe(2);
    expect(errors[0]!.message).toContain('should handle null input');
    expect(errors[1]!.message).toContain('should timeout after 5s');
  });

  it('returns empty for empty string', () => {
    expect(parseTestErrors('')).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// executeCommand
// ═══════════════════════════════════════════════════════════════════════════════

describe('executeCommand', () => {
  it('executes simple echo command', async () => {
    const result = await executeCommand('echo "hello world"', '/tmp');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('hello world');
    expect(result.timedOut).toBe(false);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('captures non-zero exit code', async () => {
    const result = await executeCommand('exit 42', '/tmp');
    expect(result.exitCode).toBe(42);
  });

  it('captures stderr', async () => {
    const result = await executeCommand('echo "err" >&2', '/tmp');
    expect(result.stderr).toContain('err');
  });

  it('handles empty command', async () => {
    const result = await executeCommand('', '/tmp');
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Empty command');
  });

  it('times out long-running commands', async () => {
    const result = await executeCommand('sleep 10', '/tmp', 200);
    expect(result.timedOut).toBe(true);
  });

  it('measures duration', async () => {
    const result = await executeCommand('echo fast', '/tmp');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.durationMs).toBeLessThan(5000);
  });
});
