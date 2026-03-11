import { describe, expect, it } from 'vitest';

import {
  parseTestOutput,
  parseGenericOutput,
} from '../src/ci-loop/test-runner.js';

// ─────────────────────────────────────────────────────────────────────────────
// Test Output Parsing
// ─────────────────────────────────────────────────────────────────────────────

describe('parseTestOutput', () => {
  describe('TAP format', () => {
    it('should parse TAP output with ok/not ok lines', () => {
      const output = `TAP version 13
1..4
ok 1 - addition works
ok 2 - subtraction works
not ok 3 - division by zero
ok 4 - multiplication works`;

      const tests = parseTestOutput(output);
      expect(tests).toHaveLength(4);
      expect(tests[0]).toEqual({
        name: 'addition works',
        status: 'passed',
      });
      expect(tests[2]).toEqual({
        name: 'division by zero',
        status: 'failed',
        errorMessage: 'division by zero',
      });
    });

    it('should handle TAP skip and todo directives', () => {
      const output = `TAP version 13
1..3
ok 1 - basic test
ok 2 - pending test # SKIP not implemented yet
not ok 3 - failing test`;

      const tests = parseTestOutput(output);
      expect(tests).toHaveLength(3);
      expect(tests[1]!.status).toBe('skipped');
    });
  });

  describe('Generic output format', () => {
    it('should parse checkmark/cross lines', () => {
      const output = `
  Test Suite
    ✓ should add numbers
    ✓ should subtract numbers
    ✗ should divide by zero
    ✓ should multiply numbers
`;

      const tests = parseGenericOutput(output);
      expect(tests).toHaveLength(4);
      expect(tests[0]!.status).toBe('passed');
      expect(tests[2]!.status).toBe('failed');
    });

    it('should parse PASS/FAIL prefixed lines', () => {
      const output = `
PASS: test_addition
PASS: test_subtraction
FAIL: test_division
PASS: test_multiplication
`;

      const tests = parseGenericOutput(output);
      expect(tests).toHaveLength(4);
      expect(tests[0]).toEqual({ name: 'test_addition', status: 'passed' });
      expect(tests[2]).toEqual({ name: 'test_division', status: 'failed' });
    });

    it('should parse dotted suffix lines', () => {
      const output = `
test_add ......... passed
test_sub ......... passed
test_div ......... failed
`;

      const tests = parseGenericOutput(output);
      expect(tests).toHaveLength(3);
      expect(tests[0]!.status).toBe('passed');
      expect(tests[2]!.status).toBe('failed');
    });

    it('should return empty array for unrecognized output', () => {
      const output = 'Some random output\nThat does not match any pattern';
      const tests = parseGenericOutput(output);
      expect(tests).toHaveLength(0);
    });
  });

  describe('JSON format', () => {
    it('should parse Vitest/Jest JSON reporter output', () => {
      const jsonResult = {
        testResults: [
          {
            testResults: [
              { fullName: 'math > add', status: 'passed', duration: 5 },
              { fullName: 'math > divide', status: 'failed', duration: 3, failureMessages: ['Cannot divide by zero'] },
              { fullName: 'math > pending', status: 'pending', duration: 0 },
            ],
          },
        ],
      };
      const output = JSON.stringify(jsonResult);

      const tests = parseTestOutput(output);
      expect(tests).toHaveLength(3);
      expect(tests[0]).toEqual({
        name: 'math > add',
        status: 'passed',
        durationMs: 5,
        errorMessage: undefined,
      });
      expect(tests[1]).toEqual({
        name: 'math > divide',
        status: 'failed',
        durationMs: 3,
        errorMessage: 'Cannot divide by zero',
      });
      expect(tests[2]!.status).toBe('skipped');
    });
  });
});
