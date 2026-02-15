import { describe, expect, it, afterEach } from 'vitest';
import { existsSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  editFile,
  editFilesTransaction,
  undoLastEdit,
  undoEdit,
  getEditHistory,
  clearEditHistory,
  parseSearchReplaceBlocks,
} from '../src/coding/tools/edit.js';

// ─── Temp dir helpers ────────────────────────────────────────────────────────

const TEST_BASE = join(tmpdir(), `casterly-coding-edit-test-${Date.now()}`);

afterEach(() => {
  clearEditHistory();
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

// ═══════════════════════════════════════════════════════════════════════════════
// editFile — history
// ═══════════════════════════════════════════════════════════════════════════════

describe('editFile — history', () => {
  it('adds entry to edit history', async () => {
    const fp = setupFile('test.ts', 'before');
    await editFile({ path: fp, search: 'before', replace: 'after' });
    const history = getEditHistory();
    expect(history).toHaveLength(1);
    expect(history[0]!.type).toBe('edit');
    expect(history[0]!.before).toBe('before');
    expect(history[0]!.after).toBe('after');
  });

  it('getEditHistory respects limit', async () => {
    const fp = setupFile('test.ts', 'a b c');
    await editFile({ path: fp, search: 'a', replace: 'x' });
    await editFile({ path: fp, search: 'b', replace: 'y' });
    await editFile({ path: fp, search: 'c', replace: 'z' });
    expect(getEditHistory(2)).toHaveLength(2);
  });

  it('clearEditHistory removes all entries', async () => {
    const fp = setupFile('test.ts', 'content');
    await editFile({ path: fp, search: 'content', replace: 'new' });
    expect(getEditHistory()).toHaveLength(1);
    clearEditHistory();
    expect(getEditHistory()).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// undoLastEdit
// ═══════════════════════════════════════════════════════════════════════════════

describe('undoLastEdit', () => {
  it('reverts the last edit', async () => {
    const fp = setupFile('test.ts', 'original');
    await editFile({ path: fp, search: 'original', replace: 'modified' });
    expect(readFileSync(fp, 'utf-8')).toBe('modified');

    const result = await undoLastEdit();
    expect(result.success).toBe(true);
    expect(readFileSync(fp, 'utf-8')).toBe('original');
  });

  it('returns error when no edits to undo', async () => {
    const result = await undoLastEdit();
    expect(result.success).toBe(false);
    expect(result.error).toContain('No edits');
  });

  it('removes entry from history after undo', async () => {
    const fp = setupFile('test.ts', 'abc');
    await editFile({ path: fp, search: 'abc', replace: 'xyz' });
    expect(getEditHistory()).toHaveLength(1);
    await undoLastEdit();
    expect(getEditHistory()).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// undoEdit (by ID)
// ═══════════════════════════════════════════════════════════════════════════════

describe('undoEdit', () => {
  it('reverts a specific edit by ID', async () => {
    const fp = setupFile('test.ts', 'original');
    await editFile({ path: fp, search: 'original', replace: 'modified' });
    const history = getEditHistory();
    const editId = history[0]!.id;

    const result = await undoEdit(editId);
    expect(result.success).toBe(true);
    expect(readFileSync(fp, 'utf-8')).toBe('original');
  });

  it('returns error for unknown edit ID', async () => {
    const result = await undoEdit('nonexistent-id');
    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// editFilesTransaction
// ═══════════════════════════════════════════════════════════════════════════════

describe('editFilesTransaction', () => {
  it('applies multiple edits', async () => {
    const fp1 = setupFile('a.ts', 'const a = 1;');
    const fp2 = setupFile('b.ts', 'const b = 2;');

    const result = await editFilesTransaction([
      { path: fp1, search: '1', replace: '10' },
      { path: fp2, search: '2', replace: '20' },
    ]);
    expect(result.success).toBe(true);
    expect(result.results).toHaveLength(2);
    expect(readFileSync(fp1, 'utf-8')).toContain('10');
    expect(readFileSync(fp2, 'utf-8')).toContain('20');
  });

  it('fails if search string not found in validation pass', async () => {
    const fp1 = setupFile('a.ts', 'const a = 1;');

    const result = await editFilesTransaction([
      { path: fp1, search: 'nonexistent', replace: 'new' },
    ]);
    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });

  it('fails if file does not exist', async () => {
    const result = await editFilesTransaction([
      { path: join(TEST_BASE, 'missing.ts'), search: 'a', replace: 'b' },
    ]);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Failed to read');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// parseSearchReplaceBlocks
// ═══════════════════════════════════════════════════════════════════════════════

describe('parseSearchReplaceBlocks', () => {
  it('parses a single block', () => {
    const text = `<<<<<<< SEARCH
old code
=======
new code
>>>>>>> REPLACE`;
    const blocks = parseSearchReplaceBlocks(text);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.search).toBe('old code');
    expect(blocks[0]!.replace).toBe('new code');
  });

  it('parses multiple blocks', () => {
    const text = `<<<<<<< SEARCH
alpha
=======
beta
>>>>>>> REPLACE

Some text between

<<<<<<< SEARCH
gamma
=======
delta
>>>>>>> REPLACE`;
    const blocks = parseSearchReplaceBlocks(text);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]!.search).toBe('alpha');
    expect(blocks[1]!.replace).toBe('delta');
  });

  it('handles multi-line content', () => {
    const text = `<<<<<<< SEARCH
line 1
line 2
line 3
=======
new line 1
new line 2
>>>>>>> REPLACE`;
    const blocks = parseSearchReplaceBlocks(text);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.search).toContain('line 2');
    expect(blocks[0]!.replace).toContain('new line 1');
  });

  it('returns empty array for no blocks', () => {
    expect(parseSearchReplaceBlocks('no blocks here')).toEqual([]);
  });

  it('returns empty array for empty string', () => {
    expect(parseSearchReplaceBlocks('')).toEqual([]);
  });
});
