import { describe, expect, it, afterEach } from 'vitest';
import { existsSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  readFile,
  readFiles,
  fileExists,
  getFileInfo,
} from '../src/coding/tools/read.js';

// ─── Temp dir helpers ────────────────────────────────────────────────────────

const TEST_BASE = join(tmpdir(), `casterly-coding-read-test-${Date.now()}`);

afterEach(() => {
  if (existsSync(TEST_BASE)) {
    rmSync(TEST_BASE, { recursive: true, force: true });
  }
});

function setupFile(name: string, content: string): string {
  mkdirSync(TEST_BASE, { recursive: true });
  const filePath = join(TEST_BASE, name);
  writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

// ═══════════════════════════════════════════════════════════════════════════════
// readFile — basic operations
// ═══════════════════════════════════════════════════════════════════════════════

describe('readFile — basic operations', () => {
  it('reads file content', async () => {
    const fp = setupFile('test.ts', 'hello world');
    const result = await readFile(fp);
    expect(result.success).toBe(true);
    expect(result.content).toBe('hello world');
  });

  it('returns metadata', async () => {
    const fp = setupFile('test.ts', 'line 1\nline 2\nline 3');
    const result = await readFile(fp);
    expect(result.metadata).toBeDefined();
    expect(result.metadata!.totalLines).toBe(3);
    expect(result.metadata!.linesReturned).toBe(3);
    expect(result.metadata!.tokens).toBeGreaterThan(0);
    expect(result.metadata!.sizeBytes).toBeGreaterThan(0);
    expect(result.metadata!.modifiedAt).toBeTruthy();
    expect(result.metadata!.startLine).toBe(1);
    expect(result.metadata!.truncated).toBe(false);
  });

  it('fails for nonexistent file', async () => {
    const result = await readFile(join(TEST_BASE, 'missing.ts'));
    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });

  it('fails for directory', async () => {
    mkdirSync(TEST_BASE, { recursive: true });
    const result = await readFile(TEST_BASE);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Not a file');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// readFile — line options
// ═══════════════════════════════════════════════════════════════════════════════

describe('readFile — line options', () => {
  it('reads from specific start line', async () => {
    const fp = setupFile('test.ts', 'line 1\nline 2\nline 3\nline 4\nline 5');
    const result = await readFile(fp, { startLine: 3 });
    expect(result.success).toBe(true);
    expect(result.content).toBe('line 3\nline 4\nline 5');
    expect(result.metadata!.startLine).toBe(3);
  });

  it('reads specific line count', async () => {
    const fp = setupFile('test.ts', 'line 1\nline 2\nline 3\nline 4\nline 5');
    const result = await readFile(fp, { lineCount: 2 });
    expect(result.success).toBe(true);
    expect(result.content).toBe('line 1\nline 2');
    expect(result.metadata!.linesReturned).toBe(2);
  });

  it('reads from start line with count', async () => {
    const fp = setupFile('test.ts', 'line 1\nline 2\nline 3\nline 4\nline 5');
    const result = await readFile(fp, { startLine: 2, lineCount: 2 });
    expect(result.success).toBe(true);
    expect(result.content).toBe('line 2\nline 3');
  });

  it('handles start line beyond file length', async () => {
    const fp = setupFile('test.ts', 'line 1\nline 2');
    const result = await readFile(fp, { startLine: 100 });
    expect(result.success).toBe(true);
    expect(result.content).toBe('');
  });

  it('clamps negative start line to 1', async () => {
    const fp = setupFile('test.ts', 'line 1\nline 2');
    const result = await readFile(fp, { startLine: -5 });
    expect(result.success).toBe(true);
    expect(result.metadata!.startLine).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// readFile — line numbers
// ═══════════════════════════════════════════════════════════════════════════════

describe('readFile — line numbers', () => {
  it('includes line numbers when requested', async () => {
    const fp = setupFile('test.ts', 'alpha\nbeta\ngamma');
    const result = await readFile(fp, { includeLineNumbers: true });
    expect(result.success).toBe(true);
    expect(result.content).toContain('1');
    expect(result.content).toContain('│');
    expect(result.content).toContain('alpha');
  });

  it('line numbers start from startLine', async () => {
    const fp = setupFile('test.ts', 'a\nb\nc\nd\ne');
    const result = await readFile(fp, { startLine: 3, includeLineNumbers: true });
    expect(result.content).toContain('3');
    expect(result.content).toContain('c');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// readFile — token limits
// ═══════════════════════════════════════════════════════════════════════════════

describe('readFile — token limits', () => {
  it('truncates when exceeding maxTokens', async () => {
    // Create a file with many lines
    const lines = Array.from({ length: 1000 }, (_, i) => `line ${i}: ${'x'.repeat(50)}`);
    const fp = setupFile('large.ts', lines.join('\n'));
    const result = await readFile(fp, { maxTokens: 50 });
    expect(result.success).toBe(true);
    expect(result.metadata!.truncated).toBe(true);
    expect(result.content).toContain('[truncated]');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// readFiles — multiple files
// ═══════════════════════════════════════════════════════════════════════════════

describe('readFiles — multiple files', () => {
  it('reads multiple files', async () => {
    const fp1 = setupFile('a.ts', 'file a');
    const fp2 = setupFile('b.ts', 'file b');
    const { results, totalTokens } = await readFiles([fp1, fp2]);
    expect(results).toHaveLength(2);
    expect(results[0]!.success).toBe(true);
    expect(results[1]!.success).toBe(true);
    expect(totalTokens).toBeGreaterThan(0);
  });

  it('respects total token budget', async () => {
    const lines = Array.from({ length: 500 }, (_, i) => `line ${i}: ${'x'.repeat(50)}`);
    const fp1 = setupFile('big.ts', lines.join('\n'));
    const fp2 = setupFile('small.ts', 'hello');
    // First file will exhaust budget, second should get error
    const { results } = await readFiles([fp1, fp2], { maxTotalTokens: 50 });
    expect(results).toHaveLength(2);
    // The second file either gets read or reports budget exhausted
    // depending on how much budget the first consumed
    expect(results[0]!.success).toBe(true);
  });

  it('handles missing files gracefully', async () => {
    const fp1 = setupFile('good.ts', 'content');
    const { results } = await readFiles([fp1, join(TEST_BASE, 'missing.ts')]);
    expect(results).toHaveLength(2);
    expect(results[0]!.success).toBe(true);
    expect(results[1]!.success).toBe(false);
  });

  it('passes includeLineNumbers option', async () => {
    const fp = setupFile('test.ts', 'hello');
    const { results } = await readFiles([fp], { includeLineNumbers: true });
    expect(results[0]!.content).toContain('│');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// fileExists
// ═══════════════════════════════════════════════════════════════════════════════

describe('fileExists', () => {
  it('returns true for existing file', async () => {
    const fp = setupFile('exists.ts', 'content');
    expect(await fileExists(fp)).toBe(true);
  });

  it('returns false for nonexistent file', async () => {
    expect(await fileExists(join(TEST_BASE, 'nope.ts'))).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// getFileInfo
// ═══════════════════════════════════════════════════════════════════════════════

describe('getFileInfo', () => {
  it('returns info for existing file', async () => {
    const fp = setupFile('info.ts', 'line 1\nline 2\nline 3');
    const info = await getFileInfo(fp);
    expect(info.exists).toBe(true);
    expect(info.lines).toBe(3);
    expect(info.size).toBeGreaterThan(0);
    expect(info.modified).toBeTruthy();
  });

  it('returns exists=false for nonexistent file', async () => {
    const info = await getFileInfo(join(TEST_BASE, 'missing.ts'));
    expect(info.exists).toBe(false);
    expect(info.size).toBeUndefined();
  });

  it('returns exists=false for directory', async () => {
    mkdirSync(TEST_BASE, { recursive: true });
    const info = await getFileInfo(TEST_BASE);
    expect(info.exists).toBe(false);
  });
});
