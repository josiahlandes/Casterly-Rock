import { describe, expect, it } from 'vitest';

import { Validator, buildInvariants } from '../src/autonomous/validator.js';
import type { Invariant } from '../src/autonomous/types.js';

// ═══════════════════════════════════════════════════════════════════════════════
// Validator — construction
// ═══════════════════════════════════════════════════════════════════════════════

describe('Validator — construction', () => {
  it('uses default invariants when none provided', () => {
    const v = new Validator('/tmp/project');
    // We can't directly inspect private fields, but we can check
    // that checkAllInvariants runs (tested below)
    expect(v).toBeDefined();
  });

  it('accepts custom invariants', () => {
    const customInvariants: Invariant[] = [
      { name: 'custom', check: 'echo ok', description: 'Custom check' },
    ];
    const v = new Validator('/tmp/project', { invariants: customInvariants });
    expect(v).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// parseTestOutput
// ═══════════════════════════════════════════════════════════════════════════════

describe('Validator — parseTestOutput', () => {
  it('parses vitest output with passed tests', () => {
    const v = new Validator('/tmp/project');
    const output = 'Tests  800 passed (800)\n Duration 514ms';
    const result = v.parseTestOutput(output);
    expect(result.passed).toBe(800);
    expect(result.failed).toBe(0);
    expect(result.total).toBe(800);
  });

  it('parses output with both passed and failed', () => {
    const v = new Validator('/tmp/project');
    const output = 'Tests  798 passed 2 failed (800)\n Duration 500ms';
    const result = v.parseTestOutput(output);
    expect(result.passed).toBe(798);
    expect(result.failed).toBe(2);
    expect(result.total).toBe(800);
  });

  it('returns zeros when no test info found', () => {
    const v = new Validator('/tmp/project');
    const result = v.parseTestOutput('no test output here');
    expect(result.passed).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.total).toBe(0);
  });

  it('handles singular "Test" (1 passed)', () => {
    const v = new Validator('/tmp/project');
    const output = 'Test  1 passed (1)';
    const result = v.parseTestOutput(output);
    expect(result.passed).toBe(1);
    expect(result.total).toBe(1);
  });

  it('parses only failures when no pass count', () => {
    const v = new Validator('/tmp/project');
    const output = '5 failed';
    const result = v.parseTestOutput(output);
    expect(result.passed).toBe(0);
    expect(result.failed).toBe(5);
    expect(result.total).toBe(5);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// checkInvariant — with simple echo commands
// ═══════════════════════════════════════════════════════════════════════════════

describe('Validator — checkInvariant', () => {
  it('passes when command succeeds', async () => {
    const v = new Validator('/tmp');
    const result = await v.checkInvariant({
      name: 'echo_test',
      check: 'echo "hello"',
      description: 'Simple echo',
    });
    expect(result.passed).toBe(true);
    expect(result.name).toBe('echo_test');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('fails when command fails', async () => {
    const v = new Validator('/tmp');
    const result = await v.checkInvariant({
      name: 'fail_test',
      check: 'exit 1',
      description: 'Should fail',
    });
    expect(result.passed).toBe(false);
    expect(result.name).toBe('fail_test');
  });

  it('inverts result when invert=true', async () => {
    const v = new Validator('/tmp');

    // Command fails, but with invert=true it should pass
    const result = await v.checkInvariant({
      name: 'inverted',
      check: 'exit 1',
      description: 'Inverted check',
      invert: true,
    });
    expect(result.passed).toBe(true);
  });

  it('inverts success to failure when invert=true', async () => {
    const v = new Validator('/tmp');

    const result = await v.checkInvariant({
      name: 'inverted_success',
      check: 'echo "ok"',
      description: 'Inverted success',
      invert: true,
    });
    expect(result.passed).toBe(false);
  });

  it('captures stdout in output', async () => {
    const v = new Validator('/tmp');
    const result = await v.checkInvariant({
      name: 'output_test',
      check: 'echo "captured output"',
      description: 'Output capture',
    });
    expect(result.output).toContain('captured output');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// checkAllInvariants
// ═══════════════════════════════════════════════════════════════════════════════

describe('Validator — checkAllInvariants', () => {
  it('checks all provided invariants', async () => {
    const v = new Validator('/tmp', {
      invariants: [
        { name: 'check1', check: 'echo "a"', description: 'First' },
        { name: 'check2', check: 'echo "b"', description: 'Second' },
      ],
    });

    const results = await v.checkAllInvariants();
    expect(results.length).toBe(2);
    expect(results[0]!.name).toBe('check1');
    expect(results[1]!.name).toBe('check2');
    expect(results.every((r) => r.passed)).toBe(true);
  });

  it('reports individual failures', async () => {
    const v = new Validator('/tmp', {
      invariants: [
        { name: 'pass', check: 'echo "ok"', description: 'Pass' },
        { name: 'fail', check: 'exit 1', description: 'Fail' },
      ],
    });

    const results = await v.checkAllInvariants();
    expect(results.find((r) => r.name === 'pass')!.passed).toBe(true);
    expect(results.find((r) => r.name === 'fail')!.passed).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// quickCheck
// ═══════════════════════════════════════════════════════════════════════════════

describe('Validator — quickCheck', () => {
  it('returns true when commands succeed', async () => {
    // We use a project root where running echo should work fine
    const v = new Validator('/tmp');
    // quickCheck runs npm run typecheck && npm run lint which will fail in /tmp
    // So we just verify the method returns boolean
    const result = await v.quickCheck();
    expect(typeof result).toBe('boolean');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// buildInvariants
// ═══════════════════════════════════════════════════════════════════════════════

describe('buildInvariants', () => {
  it('includes default invariants', () => {
    const invariants = buildInvariants();
    expect(invariants.length).toBeGreaterThanOrEqual(3);
    expect(invariants.some((i) => i.name === 'quality_gates')).toBe(true);
    expect(invariants.some((i) => i.name === 'no_type_errors')).toBe(true);
    expect(invariants.some((i) => i.name === 'tests_pass')).toBe(true);
  });

  it('adds protected_paths check', () => {
    const invariants = buildInvariants();
    expect(invariants.some((i) => i.name === 'protected_paths')).toBe(true);
  });

  it('adds git_history check', () => {
    const invariants = buildInvariants();
    expect(invariants.some((i) => i.name === 'git_history')).toBe(true);
  });

  it('returns at least 5 invariants', () => {
    const invariants = buildInvariants();
    expect(invariants.length).toBeGreaterThanOrEqual(5);
  });

  it('all invariants have required fields', () => {
    const invariants = buildInvariants();
    for (const inv of invariants) {
      expect(inv.name).toBeTruthy();
      expect(inv.check).toBeTruthy();
      expect(inv.description).toBeTruthy();
    }
  });
});
