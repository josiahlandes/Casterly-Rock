import { describe, expect, it, afterEach } from 'vitest';
import { existsSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  editFile,
} from '../src/coding/tools/edit.js';

// ─── Temp dir helpers ────────────────────────────────────────────────────────

const TEST_BASE = join(tmpdir(), `casterly-coding-edit-test-${Date.now()}`);

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
// editFile — basic operations
// ═══════════════════════════════════════════════════════════════════════════════

describe('editFile — basic operations', () => {
  it('replaces first occurrence', async () => {
    const fp = setupFile('test.ts', 'const a = 1;\nconst a = 2;\n');
    const result = await editFile({ path: fp, search: 'const a = 1', replace: 'const a = 10' });
    expect(result.success).toBe(true);
    expect(result.matchCount).toBe(1);
    expect(result.replacementsMade).toBe(1);
    const content = readFileSync(fp, 'utf-8');
    expect(content).toContain('const a = 10');
  });

  it('replaces all occurrences when replaceAll=true', async () => {
    const fp = setupFile('test.ts', 'foo bar foo baz foo');
    const result = await editFile({ path: fp, search: 'foo', replace: 'qux', replaceAll: true });
    expect(result.success).toBe(true);
    expect(result.matchCount).toBe(3);
    expect(result.replacementsMade).toBe(3);
    const content = readFileSync(fp, 'utf-8');
    expect(content).toBe('qux bar qux baz qux');
  });

  it('returns preview diff', async () => {
    const fp = setupFile('test.ts', 'hello world');
    const result = await editFile({ path: fp, search: 'hello', replace: 'goodbye' });
    expect(result.preview).toBeDefined();
    expect(result.preview).toContain('-');
    expect(result.preview).toContain('+');
  });

  it('returns originalContent', async () => {
    const fp = setupFile('test.ts', 'original content here');
    const result = await editFile({ path: fp, search: 'original', replace: 'modified' });
    expect(result.originalContent).toBe('original content here');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// editFile — validation
// ═══════════════════════════════════════════════════════════════════════════════

describe('editFile — validation', () => {
  it('fails with empty search string', async () => {
    const fp = setupFile('test.ts', 'content');
    const result = await editFile({ path: fp, search: '', replace: 'new' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('empty');
  });

  it('fails when search equals replace', async () => {
    const fp = setupFile('test.ts', 'content');
    const result = await editFile({ path: fp, search: 'same', replace: 'same' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('identical');
  });

  it('fails when search string not found', async () => {
    const fp = setupFile('test.ts', 'hello world');
    const result = await editFile({ path: fp, search: 'nonexistent', replace: 'new' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
    expect(result.matchCount).toBe(0);
  });

  it('fails for nonexistent file', async () => {
    const result = await editFile({
      path: join(TEST_BASE, 'nonexistent.ts'),
      search: 'a',
      replace: 'b',
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });
});

