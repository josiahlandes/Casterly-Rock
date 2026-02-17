import { describe, expect, it } from 'vitest';

import { scoreArgCorrectness } from '../src/benchmark/scorer.js';

// ═══════════════════════════════════════════════════════════════════════════════
// scoreArgCorrectness
// ═══════════════════════════════════════════════════════════════════════════════

describe('scoreArgCorrectness', () => {
  it('returns 1 when no expectations defined', () => {
    expect(scoreArgCorrectness(undefined, [])).toBe(1);
  });

  it('returns 1 when expectations empty object', () => {
    expect(scoreArgCorrectness({}, [])).toBe(1);
  });

  it('returns 1 when all args match exactly', () => {
    const expected = {
      read_file: { path: 'src/index.ts' },
    };
    const calls = [
      { name: 'read_file', arguments: { path: 'src/index.ts' } },
    ];
    expect(scoreArgCorrectness(expected, calls)).toBe(1);
  });

  it('returns 0 when tool not called', () => {
    const expected = {
      read_file: { path: 'src/index.ts' },
    };
    expect(scoreArgCorrectness(expected, [])).toBe(0);
  });

  it('returns 0 when arg does not match', () => {
    const expected = {
      read_file: { path: 'src/index.ts' },
    };
    const calls = [
      { name: 'read_file', arguments: { path: 'wrong/path.ts' } },
    ];
    expect(scoreArgCorrectness(expected, calls)).toBe(0);
  });

  it('returns fraction when some args match', () => {
    const expected = {
      git_commit: { message: 'fix bug', files: '*' },
    };
    const calls = [
      { name: 'git_commit', arguments: { message: 'fix bug' } },
    ];
    // 'message' matches exactly, 'files' with '*' expects presence but is undefined → 1/2
    expect(scoreArgCorrectness(expected, calls)).toBe(0.5);
  });

  it('wildcard * checks for presence', () => {
    const expected = {
      grep: { pattern: '*' },
    };
    const calls = [
      { name: 'grep', arguments: { pattern: 'some pattern' } },
    ];
    expect(scoreArgCorrectness(expected, calls)).toBe(1);
  });

  it('wildcard * fails when arg is missing', () => {
    const expected = {
      grep: { pattern: '*' },
    };
    const calls = [
      { name: 'grep', arguments: {} },
    ];
    expect(scoreArgCorrectness(expected, calls)).toBe(0);
  });

  it('wildcard * fails when arg is null', () => {
    const expected = {
      grep: { pattern: '*' },
    };
    const calls = [
      { name: 'grep', arguments: { pattern: null } },
    ];
    expect(scoreArgCorrectness(expected, calls)).toBe(0);
  });

  it('regex pattern matching with re: prefix', () => {
    const expected = {
      grep: { pattern: 're:import.*from' },
    };
    const calls = [
      { name: 'grep', arguments: { pattern: 'import { foo } from' } },
    ];
    expect(scoreArgCorrectness(expected, calls)).toBe(1);
  });

  it('regex pattern fails when no match', () => {
    const expected = {
      grep: { pattern: 're:^export' },
    };
    const calls = [
      { name: 'grep', arguments: { pattern: 'import something' } },
    ];
    expect(scoreArgCorrectness(expected, calls)).toBe(0);
  });

  it('loose number comparison', () => {
    const expected = {
      git_log: { count: 5 },
    };
    const calls = [
      { name: 'git_log', arguments: { count: '5' } },
    ];
    expect(scoreArgCorrectness(expected, calls)).toBe(1);
  });

  it('checks across multiple tools', () => {
    const expected = {
      read_file: { path: 'src/a.ts' },
      edit_file: { path: 'src/a.ts', old_string: '*', new_string: '*' },
    };
    const calls = [
      { name: 'read_file', arguments: { path: 'src/a.ts' } },
      { name: 'edit_file', arguments: { path: 'src/a.ts', old_string: 'old', new_string: 'new' } },
    ];
    // read_file: path matches (1/1)
    // edit_file: path matches (1/1), old_string present (1/1), new_string present (1/1)
    // Total: 4/4 = 1.0
    expect(scoreArgCorrectness(expected, calls)).toBe(1);
  });

  it('handles tool with no arguments object', () => {
    const expected = {
      typecheck: {},
    };
    const calls = [
      { name: 'typecheck' },
    ];
    // No arg checks → 1
    expect(scoreArgCorrectness(expected, calls)).toBe(1);
  });

  it('returns partial score when one tool matches and another does not', () => {
    const expected = {
      read_file: { path: 'src/a.ts' },
      edit_file: { path: 'src/b.ts' },
    };
    const calls = [
      { name: 'read_file', arguments: { path: 'src/a.ts' } },
      // edit_file not called
    ];
    // read_file: 1/1, edit_file: 0/1 → 1/2 = 0.5
    expect(scoreArgCorrectness(expected, calls)).toBe(0.5);
  });
});
