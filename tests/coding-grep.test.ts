import { describe, expect, it, afterEach } from 'vitest';
import { existsSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { grep, grepFiles, grepCount, formatGrepResults } from '../src/coding/tools/grep.js';

// ─── Temp dir helpers ────────────────────────────────────────────────────────

const TEST_BASE = join(tmpdir(), `casterly-coding-grep-test-${Date.now()}`);

afterEach(() => {
  if (existsSync(TEST_BASE)) {
    rmSync(TEST_BASE, { recursive: true, force: true });
  }
});

function setupTree(): void {
  mkdirSync(join(TEST_BASE, 'src'), { recursive: true });
  writeFileSync(
    join(TEST_BASE, 'src', 'index.ts'),
    'const greeting = "hello";\nfunction greet() {\n  return greeting;\n}\nexport { greet };\n'
  );
  writeFileSync(
    join(TEST_BASE, 'src', 'utils.ts'),
    'export function add(a: number, b: number) {\n  return a + b;\n}\n\nexport function subtract(a: number, b: number) {\n  return a - b;\n}\n'
  );
  writeFileSync(
    join(TEST_BASE, 'src', 'config.json'),
    '{\n  "name": "test",\n  "version": "1.0.0"\n}\n'
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// grep — basic matching
// ═══════════════════════════════════════════════════════════════════════════════

describe('grep — basic matching', () => {
  it('finds pattern in files', async () => {
    setupTree();
    const result = await grep('greeting', {
      cwd: TEST_BASE,
      include: ['**/*.ts'],
    });
    expect(result.success).toBe(true);
    expect(result.totalMatches).toBeGreaterThan(0);
    expect(result.filesMatched).toBeGreaterThan(0);
    expect(result.matches.some((m) => m.content.includes('greeting'))).toBe(true);
  });

  it('returns match positions', async () => {
    setupTree();
    const result = await grep('hello', {
      cwd: TEST_BASE,
      include: ['**/*.ts'],
    });
    expect(result.success).toBe(true);
    expect(result.matches.length).toBeGreaterThan(0);
    const match = result.matches[0]!;
    expect(match.line).toBeGreaterThan(0);
    expect(match.column).toBeGreaterThan(0);
    expect(match.file).toBeTruthy();
    expect(match.relativePath).toBeTruthy();
  });

  it('supports regex patterns', async () => {
    setupTree();
    const result = await grep('function\\s+\\w+', {
      cwd: TEST_BASE,
      include: ['**/*.ts'],
    });
    expect(result.success).toBe(true);
    expect(result.totalMatches).toBeGreaterThanOrEqual(3); // greet, add, subtract
  });

  it('counts files searched', async () => {
    setupTree();
    const result = await grep('export', {
      cwd: TEST_BASE,
      include: ['**/*.ts'],
    });
    expect(result.filesSearched).toBeGreaterThanOrEqual(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// grep — options
// ═══════════════════════════════════════════════════════════════════════════════

describe('grep — options', () => {
  it('supports case insensitive search', async () => {
    setupTree();
    const result = await grep('GREETING', {
      cwd: TEST_BASE,
      include: ['**/*.ts'],
      ignoreCase: true,
    });
    expect(result.success).toBe(true);
    expect(result.totalMatches).toBeGreaterThan(0);
  });

  it('supports literal pattern matching', async () => {
    setupTree();
    const result = await grep('a + b', {
      cwd: TEST_BASE,
      include: ['**/*.ts'],
      literal: true,
    });
    expect(result.success).toBe(true);
    expect(result.totalMatches).toBeGreaterThan(0);
  });

  it('includes context before', async () => {
    setupTree();
    const result = await grep('return greeting', {
      cwd: TEST_BASE,
      include: ['**/*.ts'],
      contextBefore: 2,
    });
    expect(result.success).toBe(true);
    const match = result.matches[0];
    if (match) {
      expect(match.contextBefore).toBeDefined();
      expect(match.contextBefore!.length).toBeGreaterThan(0);
    }
  });

  it('includes context after', async () => {
    setupTree();
    const result = await grep('const greeting', {
      cwd: TEST_BASE,
      include: ['**/*.ts'],
      contextAfter: 2,
    });
    expect(result.success).toBe(true);
    const match = result.matches[0];
    if (match) {
      expect(match.contextAfter).toBeDefined();
      expect(match.contextAfter!.length).toBeGreaterThan(0);
    }
  });

  it('respects maxMatches', async () => {
    setupTree();
    const result = await grep('\\w+', {
      cwd: TEST_BASE,
      include: ['**/*.ts'],
      maxMatches: 2,
    });
    expect(result.matches.length).toBeLessThanOrEqual(2);
  });

  it('returns truncated=true when exceeding maxMatches', async () => {
    setupTree();
    const result = await grep('\\w+', {
      cwd: TEST_BASE,
      include: ['**/*.ts'],
      maxMatches: 1,
    });
    if (result.totalMatches > 1) {
      expect(result.truncated).toBe(true);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// grep — errors
// ═══════════════════════════════════════════════════════════════════════════════

describe('grep — errors', () => {
  it('returns error for invalid regex', async () => {
    setupTree();
    const result = await grep('[invalid', {
      cwd: TEST_BASE,
      include: ['**/*.ts'],
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid regex');
  });

  it('returns empty for no matches', async () => {
    setupTree();
    const result = await grep('zzznonexistent999', {
      cwd: TEST_BASE,
      include: ['**/*.ts'],
    });
    expect(result.success).toBe(true);
    expect(result.matches).toHaveLength(0);
    expect(result.totalMatches).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// grepFiles
// ═══════════════════════════════════════════════════════════════════════════════

describe('grepFiles', () => {
  it('returns matching file paths', async () => {
    setupTree();
    const result = await grepFiles('function', {
      cwd: TEST_BASE,
      include: ['**/*.ts'],
    });
    expect(result.success).toBe(true);
    expect(result.files.length).toBeGreaterThan(0);
    expect(result.files.every((f) => typeof f === 'string')).toBe(true);
  });

  it('returns error for invalid regex', async () => {
    setupTree();
    const result = await grepFiles('[bad', {
      cwd: TEST_BASE,
      include: ['**/*.ts'],
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid regex');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// grepCount
// ═══════════════════════════════════════════════════════════════════════════════

describe('grepCount', () => {
  it('counts total matches', async () => {
    setupTree();
    const result = await grepCount('function', {
      cwd: TEST_BASE,
      include: ['**/*.ts'],
    });
    expect(result.success).toBe(true);
    expect(result.totalMatches).toBeGreaterThanOrEqual(3);
    expect(result.filesMatched).toBeGreaterThan(0);
  });

  it('returns zero for no matches', async () => {
    setupTree();
    const result = await grepCount('zzznope999', {
      cwd: TEST_BASE,
      include: ['**/*.ts'],
    });
    expect(result.success).toBe(true);
    expect(result.totalMatches).toBe(0);
    expect(result.filesMatched).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// formatGrepResults
// ═══════════════════════════════════════════════════════════════════════════════

describe('formatGrepResults', () => {
  it('formats successful results', async () => {
    setupTree();
    const result = await grep('greeting', {
      cwd: TEST_BASE,
      include: ['**/*.ts'],
    });
    const formatted = formatGrepResults(result);
    expect(formatted).toContain('matches');
    expect(formatted).toContain('files');
  });

  it('formats error results', () => {
    const formatted = formatGrepResults({
      success: false,
      pattern: '[bad',
      matches: [],
      totalMatches: 0,
      filesSearched: 0,
      filesMatched: 0,
      truncated: false,
      error: 'Invalid regex pattern',
    });
    expect(formatted).toContain('Error');
  });

  it('formats empty results', () => {
    const formatted = formatGrepResults({
      success: true,
      pattern: 'nope',
      matches: [],
      totalMatches: 0,
      filesSearched: 5,
      filesMatched: 0,
      truncated: false,
    });
    expect(formatted).toContain('No matches');
  });

  it('shows truncation notice', () => {
    const formatted = formatGrepResults({
      success: true,
      pattern: 'test',
      matches: [{
        file: '/a.ts',
        relativePath: 'a.ts',
        line: 1,
        column: 1,
        content: 'test',
      }],
      totalMatches: 100,
      filesSearched: 10,
      filesMatched: 5,
      truncated: true,
    });
    expect(formatted).toContain('truncated');
  });
});
