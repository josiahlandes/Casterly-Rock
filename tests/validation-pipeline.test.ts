import { describe, expect, it } from 'vitest';

import {
  formatValidationResult,
  getErrorSummary,
} from '../src/coding/validation/pipeline.js';
import type {
  ValidationResult,
  ValidationStepResult,
  ValidationError,
} from '../src/coding/validation/types.js';
import { DEFAULT_VALIDATION_CONFIG, VALIDATION_PRESETS, SUPPORTED_PARSERS } from '../src/coding/validation/types.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeStepResult(overrides: Partial<ValidationStepResult> = {}): ValidationStepResult {
  return {
    step: 'parse',
    passed: true,
    errors: [],
    warnings: [],
    durationMs: 10,
    skipped: false,
    ...overrides,
  };
}

function makeError(overrides: Partial<ValidationError> = {}): ValidationError {
  return {
    file: 'src/index.ts',
    message: 'Some error',
    severity: 'error',
    ...overrides,
  };
}

function makeResult(overrides: Partial<ValidationResult> = {}): ValidationResult {
  return {
    success: true,
    steps: [makeStepResult()],
    totalDurationMs: 100,
    files: ['src/index.ts'],
    summary: '✓ Validation passed (1 steps, 100ms)',
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// formatValidationResult
// ═══════════════════════════════════════════════════════════════════════════════

describe('formatValidationResult', () => {
  it('formats successful result', () => {
    const result = makeResult();
    const formatted = formatValidationResult(result);
    expect(formatted).toContain('Validation passed');
    expect(formatted).toContain('parse');
    expect(formatted).toContain('passed');
  });

  it('formats failed result with errors', () => {
    const result = makeResult({
      success: false,
      summary: '✗ Validation failed: 1 error(s) in 1 step(s)',
      steps: [
        makeStepResult({
          step: 'typecheck',
          passed: false,
          errors: [
            makeError({ file: 'src/a.ts', line: 10, column: 5, message: 'Type mismatch' }),
          ],
        }),
      ],
    });
    const formatted = formatValidationResult(result);
    expect(formatted).toContain('Validation failed');
    expect(formatted).toContain('typecheck');
    expect(formatted).toContain('failed');
    expect(formatted).toContain('src/a.ts:10:5');
    expect(formatted).toContain('Type mismatch');
  });

  it('formats skipped steps', () => {
    const result = makeResult({
      steps: [
        makeStepResult({ step: 'test', skipped: true, skipReason: 'testOnEdit disabled' }),
      ],
    });
    const formatted = formatValidationResult(result);
    expect(formatted).toContain('skipped');
    expect(formatted).toContain('testOnEdit disabled');
  });

  it('truncates errors beyond 10', () => {
    const errors = Array.from({ length: 15 }, (_, i) =>
      makeError({ file: `file${i}.ts`, message: `Error ${i}` })
    );
    const result = makeResult({
      success: false,
      steps: [makeStepResult({ passed: false, errors })],
    });
    const formatted = formatValidationResult(result);
    expect(formatted).toContain('5 more errors');
  });

  it('truncates warnings beyond 3', () => {
    const warnings = Array.from({ length: 5 }, (_, i) => ({
      message: `Warning ${i}`,
    }));
    const result = makeResult({
      steps: [makeStepResult({ warnings })],
    });
    const formatted = formatValidationResult(result);
    expect(formatted).toContain('2 more warnings');
  });

  it('includes duration for each step', () => {
    const result = makeResult({
      steps: [makeStepResult({ durationMs: 42 })],
    });
    const formatted = formatValidationResult(result);
    expect(formatted).toContain('42ms');
  });

  it('shows error location with line only (no column)', () => {
    const result = makeResult({
      success: false,
      steps: [
        makeStepResult({
          passed: false,
          errors: [makeError({ file: 'f.ts', line: 7, message: 'Bad' })],
        }),
      ],
    });
    const formatted = formatValidationResult(result);
    expect(formatted).toContain('f.ts:7');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// getErrorSummary
// ═══════════════════════════════════════════════════════════════════════════════

describe('getErrorSummary', () => {
  it('returns empty for passing result', () => {
    const result = makeResult();
    expect(getErrorSummary(result)).toEqual([]);
  });

  it('collects errors across steps', () => {
    const result = makeResult({
      success: false,
      steps: [
        makeStepResult({
          step: 'lint',
          passed: false,
          errors: [makeError({ file: 'a.ts', line: 1, message: 'Lint error' })],
        }),
        makeStepResult({
          step: 'typecheck',
          passed: false,
          errors: [makeError({ file: 'b.ts', line: 5, message: 'Type error' })],
        }),
      ],
    });
    const summary = getErrorSummary(result);
    expect(summary.length).toBe(2);
    expect(summary[0]).toContain('[lint]');
    expect(summary[0]).toContain('a.ts:1');
    expect(summary[1]).toContain('[typecheck]');
    expect(summary[1]).toContain('b.ts:5');
  });

  it('handles errors without line numbers', () => {
    const result = makeResult({
      success: false,
      steps: [
        makeStepResult({
          step: 'test',
          passed: false,
          errors: [makeError({ file: 'test.ts', message: 'Test failed' })],
        }),
      ],
    });
    const summary = getErrorSummary(result);
    expect(summary[0]).toContain('[test] test.ts: Test failed');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// DEFAULT_VALIDATION_CONFIG
// ═══════════════════════════════════════════════════════════════════════════════

describe('DEFAULT_VALIDATION_CONFIG', () => {
  it('has parse check enabled', () => {
    expect(DEFAULT_VALIDATION_CONFIG.parseCheck).toBe(true);
  });

  it('has lint enabled', () => {
    expect(DEFAULT_VALIDATION_CONFIG.lintOnEdit).toBe(true);
  });

  it('has typecheck enabled', () => {
    expect(DEFAULT_VALIDATION_CONFIG.typecheckOnEdit).toBe(true);
  });

  it('has tests disabled by default', () => {
    expect(DEFAULT_VALIDATION_CONFIG.testOnEdit).toBe(false);
  });

  it('has auto-commit disabled', () => {
    expect(DEFAULT_VALIDATION_CONFIG.autoCommit).toBe(false);
  });

  it('uses npm commands', () => {
    expect(DEFAULT_VALIDATION_CONFIG.lintCommand).toBe('npm run lint');
    expect(DEFAULT_VALIDATION_CONFIG.typecheckCommand).toBe('npm run typecheck');
    expect(DEFAULT_VALIDATION_CONFIG.testCommand).toBe('npm test');
  });

  it('has onlyNewErrors enabled', () => {
    expect(DEFAULT_VALIDATION_CONFIG.onlyNewErrors).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// VALIDATION_PRESETS
// ═══════════════════════════════════════════════════════════════════════════════

describe('VALIDATION_PRESETS', () => {
  it('quick preset skips typecheck and test', () => {
    expect(VALIDATION_PRESETS.quick.typecheckOnEdit).toBe(false);
    expect(VALIDATION_PRESETS.quick.testOnEdit).toBe(false);
    expect(VALIDATION_PRESETS.quick.parseCheck).toBe(true);
  });

  it('standard preset includes typecheck but not test', () => {
    expect(VALIDATION_PRESETS.standard.typecheckOnEdit).toBe(true);
    expect(VALIDATION_PRESETS.standard.testOnEdit).toBe(false);
  });

  it('full preset includes everything', () => {
    expect(VALIDATION_PRESETS.full.parseCheck).toBe(true);
    expect(VALIDATION_PRESETS.full.lintOnEdit).toBe(true);
    expect(VALIDATION_PRESETS.full.typecheckOnEdit).toBe(true);
    expect(VALIDATION_PRESETS.full.testOnEdit).toBe(true);
  });

  it('ci preset enables auto-commit', () => {
    expect(VALIDATION_PRESETS.ci.autoCommit).toBe(true);
    expect(VALIDATION_PRESETS.ci.testOnEdit).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SUPPORTED_PARSERS
// ═══════════════════════════════════════════════════════════════════════════════

describe('SUPPORTED_PARSERS', () => {
  it('includes TypeScript parser', () => {
    const ts = SUPPORTED_PARSERS.find((p) => p.name === 'typescript');
    expect(ts).toBeDefined();
    expect(ts!.extensions).toContain('.ts');
    expect(ts!.extensions).toContain('.tsx');
    expect(ts!.available).toBe(true);
  });

  it('includes JavaScript parser', () => {
    const js = SUPPORTED_PARSERS.find((p) => p.name === 'javascript');
    expect(js).toBeDefined();
    expect(js!.extensions).toContain('.js');
    expect(js!.extensions).toContain('.mjs');
    expect(js!.extensions).toContain('.cjs');
  });

  it('includes JSON parser', () => {
    const json = SUPPORTED_PARSERS.find((p) => p.name === 'json');
    expect(json).toBeDefined();
    expect(json!.extensions).toContain('.json');
  });

  it('includes YAML parser', () => {
    const yaml = SUPPORTED_PARSERS.find((p) => p.name === 'yaml');
    expect(yaml).toBeDefined();
    expect(yaml!.extensions).toContain('.yaml');
    expect(yaml!.extensions).toContain('.yml');
  });
});
