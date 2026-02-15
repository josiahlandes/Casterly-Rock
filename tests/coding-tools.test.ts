import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createEditFileExecutor } from '../src/tools/executors/edit-file.js';
import { createGlobFilesExecutor } from '../src/tools/executors/glob-files.js';
import { createGrepFilesExecutor } from '../src/tools/executors/grep-files.js';
import type { NativeToolCall } from '../src/tools/schemas/types.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

let tempDir: string;
let callId = 0;

function makeCall(name: string, input: Record<string, unknown>): NativeToolCall {
  callId++;
  return { id: `call-${callId}`, name, input };
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'coding-tools-test-'));
  callId = 0;
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

// ─── edit_file ───────────────────────────────────────────────────────────────

describe('edit_file executor', () => {
  const executor = createEditFileExecutor();

  it('replaces first occurrence of search text', async () => {
    const filePath = join(tempDir, 'hello.ts');
    writeFileSync(filePath, 'const greeting = "hello";\nprocess.stdout.write(greeting);\n');

    const result = await executor.execute(
      makeCall('edit_file', { path: filePath, search: '"hello"', replace: '"world"' }),
    );

    expect(result.success).toBe(true);
    const content = readFileSync(filePath, 'utf-8');
    expect(content).toContain('"world"');
    expect(content).not.toContain('"hello"');

    const output = JSON.parse(result.output!);
    expect(output.matchCount).toBe(1);
    expect(output.replacementsMade).toBe(1);
  });

  it('replaces all occurrences when replaceAll is true', async () => {
    const filePath = join(tempDir, 'multi.ts');
    writeFileSync(filePath, 'foo bar foo baz foo\n');

    const result = await executor.execute(
      makeCall('edit_file', { path: filePath, search: 'foo', replace: 'qux', replaceAll: true }),
    );

    expect(result.success).toBe(true);
    const content = readFileSync(filePath, 'utf-8');
    expect(content).toBe('qux bar qux baz qux\n');

    const output = JSON.parse(result.output!);
    expect(output.matchCount).toBe(3);
    expect(output.replacementsMade).toBe(3);
  });

  it('fails when search string is not found', async () => {
    const filePath = join(tempDir, 'nope.ts');
    writeFileSync(filePath, 'some content\n');

    const result = await executor.execute(
      makeCall('edit_file', { path: filePath, search: 'missing text', replace: 'new text' }),
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });

  it('fails when file does not exist', async () => {
    const result = await executor.execute(
      makeCall('edit_file', { path: join(tempDir, 'ghost.ts'), search: 'a', replace: 'b' }),
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });

  it('fails with empty path', async () => {
    const result = await executor.execute(
      makeCall('edit_file', { path: '', search: 'a', replace: 'b' }),
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('path');
  });

  it('fails with empty search string', async () => {
    const filePath = join(tempDir, 'file.ts');
    writeFileSync(filePath, 'content\n');

    const result = await executor.execute(
      makeCall('edit_file', { path: filePath, search: '', replace: 'b' }),
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('search');
  });

  it('preserves file content when only replacing first of multiple occurrences', async () => {
    const filePath = join(tempDir, 'first-only.ts');
    writeFileSync(filePath, 'AAA BBB AAA CCC AAA\n');

    const result = await executor.execute(
      makeCall('edit_file', { path: filePath, search: 'AAA', replace: 'ZZZ' }),
    );

    expect(result.success).toBe(true);
    const content = readFileSync(filePath, 'utf-8');
    expect(content).toBe('ZZZ BBB AAA CCC AAA\n');
  });

  it('includes diff preview in output', async () => {
    const filePath = join(tempDir, 'diff.ts');
    writeFileSync(filePath, 'const x = 1;\nconst y = 2;\n');

    const result = await executor.execute(
      makeCall('edit_file', { path: filePath, search: 'const x = 1;', replace: 'const x = 42;' }),
    );

    expect(result.success).toBe(true);
    const output = JSON.parse(result.output!);
    expect(output.preview).toBeTruthy();
    expect(output.preview).toContain('-');
    expect(output.preview).toContain('+');
  });
});

// ─── glob_files ──────────────────────────────────────────────────────────────

describe('glob_files executor', () => {
  const executor = createGlobFilesExecutor();

  it('finds files matching a pattern', async () => {
    writeFileSync(join(tempDir, 'a.ts'), '');
    writeFileSync(join(tempDir, 'b.ts'), '');
    writeFileSync(join(tempDir, 'c.js'), '');

    const result = await executor.execute(
      makeCall('glob_files', { pattern: '*.ts', cwd: tempDir }),
    );

    expect(result.success).toBe(true);
    const output = JSON.parse(result.output!);
    expect(output.matchCount).toBe(2);
    expect(output.matches.map((m: { path: string }) => m.path).sort()).toEqual(['a.ts', 'b.ts']);
  });

  it('finds files recursively with **', async () => {
    mkdirSync(join(tempDir, 'sub'), { recursive: true });
    writeFileSync(join(tempDir, 'top.ts'), '');
    writeFileSync(join(tempDir, 'sub', 'deep.ts'), '');

    const result = await executor.execute(
      makeCall('glob_files', { pattern: '**/*.ts', cwd: tempDir }),
    );

    expect(result.success).toBe(true);
    const output = JSON.parse(result.output!);
    expect(output.matchCount).toBe(2);
  });

  it('returns empty matches when no files match', async () => {
    writeFileSync(join(tempDir, 'file.js'), '');

    const result = await executor.execute(
      makeCall('glob_files', { pattern: '*.py', cwd: tempDir }),
    );

    expect(result.success).toBe(true);
    const output = JSON.parse(result.output!);
    expect(output.matchCount).toBe(0);
  });

  it('fails with empty pattern', async () => {
    const result = await executor.execute(
      makeCall('glob_files', { pattern: '' }),
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('pattern');
  });

  it('includes file size in results', async () => {
    writeFileSync(join(tempDir, 'sized.txt'), 'hello world');

    const result = await executor.execute(
      makeCall('glob_files', { pattern: '*.txt', cwd: tempDir }),
    );

    expect(result.success).toBe(true);
    const output = JSON.parse(result.output!);
    expect(output.matches[0].size).toBeGreaterThan(0);
  });
});

// ─── grep_files ──────────────────────────────────────────────────────────────

describe('grep_files executor', () => {
  const executor = createGrepFilesExecutor();

  it('finds matches in files', async () => {
    writeFileSync(join(tempDir, 'a.ts'), 'const hello = "world";\nconst foo = "bar";\n');
    writeFileSync(join(tempDir, 'b.ts'), 'nothing here\n');

    const result = await executor.execute(
      makeCall('grep_files', { pattern: 'hello', cwd: tempDir, include: ['*.ts'] }),
    );

    expect(result.success).toBe(true);
    expect(result.output).toContain('hello');
    expect(result.output).toContain('a.ts');
  });

  it('supports case-insensitive search', async () => {
    writeFileSync(join(tempDir, 'case.ts'), 'Hello World\nhello world\nHELLO WORLD\n');

    const result = await executor.execute(
      makeCall('grep_files', {
        pattern: 'hello',
        cwd: tempDir,
        include: ['*.ts'],
        ignoreCase: true,
      }),
    );

    expect(result.success).toBe(true);
    expect(result.output).toContain('3 matches');
  });

  it('supports literal string matching', async () => {
    writeFileSync(join(tempDir, 'regex.ts'), 'foo.*bar\nfoo and bar\n');

    const result = await executor.execute(
      makeCall('grep_files', {
        pattern: 'foo.*bar',
        cwd: tempDir,
        include: ['*.ts'],
        literal: true,
      }),
    );

    expect(result.success).toBe(true);
    // Literal match should only find the first line
    expect(result.output).toContain('1 matches in 1 files');
  });

  it('returns no matches message when nothing found', async () => {
    writeFileSync(join(tempDir, 'empty.ts'), 'nothing relevant here\n');

    const result = await executor.execute(
      makeCall('grep_files', { pattern: 'zzznotfound', cwd: tempDir, include: ['*.ts'] }),
    );

    expect(result.success).toBe(true);
    expect(result.output).toContain('No matches found');
  });

  it('fails with empty pattern', async () => {
    const result = await executor.execute(
      makeCall('grep_files', { pattern: '' }),
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('pattern');
  });

  it('supports context lines', async () => {
    writeFileSync(
      join(tempDir, 'ctx.ts'),
      'line 1\nline 2\nTARGET line\nline 4\nline 5\n',
    );

    const result = await executor.execute(
      makeCall('grep_files', {
        pattern: 'TARGET',
        cwd: tempDir,
        include: ['*.ts'],
        contextBefore: 1,
        contextAfter: 1,
      }),
    );

    expect(result.success).toBe(true);
    expect(result.output).toContain('line 2');
    expect(result.output).toContain('TARGET line');
    expect(result.output).toContain('line 4');
  });
});
