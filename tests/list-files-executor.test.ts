import { describe, expect, it, afterEach } from 'vitest';
import { existsSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createListFilesExecutor } from '../src/tools/executors/list-files.js';

// ─── Temp dir helpers ────────────────────────────────────────────────────────

const TEST_BASE = join(tmpdir(), `casterly-list-files-exec-test-${Date.now()}`);

afterEach(() => {
  if (existsSync(TEST_BASE)) {
    rmSync(TEST_BASE, { recursive: true, force: true });
  }
});

function setupTree(): void {
  mkdirSync(join(TEST_BASE, 'src'), { recursive: true });
  mkdirSync(join(TEST_BASE, 'tests'), { recursive: true });
  writeFileSync(join(TEST_BASE, 'src', 'index.ts'), 'export {}');
  writeFileSync(join(TEST_BASE, 'src', 'utils.ts'), 'export {}');
  writeFileSync(join(TEST_BASE, 'tests', 'index.test.ts'), 'test');
  writeFileSync(join(TEST_BASE, 'package.json'), '{}');
}

function makeCall(input: Record<string, unknown>) {
  return { id: 'call-1', name: 'list_files', input };
}

// ═══════════════════════════════════════════════════════════════════════════════
// createListFilesExecutor — structure
// ═══════════════════════════════════════════════════════════════════════════════

describe('createListFilesExecutor — structure', () => {
  it('returns executor with correct toolName', () => {
    const executor = createListFilesExecutor();
    expect(executor.toolName).toBe('list_files');
  });

  it('has execute function', () => {
    const executor = createListFilesExecutor();
    expect(typeof executor.execute).toBe('function');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// createListFilesExecutor — basic listing
// ═══════════════════════════════════════════════════════════════════════════════

describe('createListFilesExecutor — basic listing', () => {
  it('lists directory contents', async () => {
    setupTree();
    const executor = createListFilesExecutor();
    const result = await executor.execute(makeCall({ path: TEST_BASE }));
    expect(result.success).toBe(true);
    expect(result.toolCallId).toBe('call-1');

    const parsed = JSON.parse(result.output!);
    expect(parsed.files.length).toBeGreaterThan(0);
    expect(parsed.totalEntries).toBeGreaterThan(0);
  });

  it('lists files with sizes', async () => {
    setupTree();
    const executor = createListFilesExecutor();
    const result = await executor.execute(makeCall({ path: TEST_BASE }));
    const parsed = JSON.parse(result.output!);
    const fileEntry = parsed.files.find((f: { type: string }) => f.type === 'file');
    expect(fileEntry).toBeDefined();
    expect(typeof fileEntry.size).toBe('number');
  });

  it('includes directory entries', async () => {
    setupTree();
    const executor = createListFilesExecutor();
    const result = await executor.execute(makeCall({ path: TEST_BASE }));
    const parsed = JSON.parse(result.output!);
    const dirEntry = parsed.files.find((f: { type: string }) => f.type === 'directory');
    expect(dirEntry).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// createListFilesExecutor — recursive
// ═══════════════════════════════════════════════════════════════════════════════

describe('createListFilesExecutor — recursive', () => {
  it('lists recursively when enabled', async () => {
    setupTree();
    const executor = createListFilesExecutor();
    const result = await executor.execute(makeCall({ path: TEST_BASE, recursive: true }));
    const parsed = JSON.parse(result.output!);
    // Should find files in subdirectories
    const hasNested = parsed.files.some((f: { path: string }) => f.path.includes('src/'));
    expect(hasNested).toBe(true);
  });

  it('non-recursive excludes nested files', async () => {
    setupTree();
    const executor = createListFilesExecutor();
    const result = await executor.execute(makeCall({ path: TEST_BASE, recursive: false }));
    const parsed = JSON.parse(result.output!);
    // Should NOT find files in subdirectories (except the dirs themselves)
    const nested = parsed.files.filter(
      (f: { type: string; path: string }) => f.type === 'file' && f.path.includes('/')
    );
    expect(nested).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// createListFilesExecutor — pattern filtering
// ═══════════════════════════════════════════════════════════════════════════════

describe('createListFilesExecutor — pattern filtering', () => {
  it('filters by glob pattern', async () => {
    setupTree();
    const executor = createListFilesExecutor();
    const result = await executor.execute(
      makeCall({ path: TEST_BASE, recursive: true, pattern: '*.ts' })
    );
    const parsed = JSON.parse(result.output!);
    const files = parsed.files.filter((f: { type: string }) => f.type === 'file');
    expect(files.every((f: { name: string }) => f.name.endsWith('.ts'))).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// createListFilesExecutor — error handling
// ═══════════════════════════════════════════════════════════════════════════════

describe('createListFilesExecutor — error handling', () => {
  it('fails for nonexistent directory', async () => {
    const executor = createListFilesExecutor();
    const result = await executor.execute(
      makeCall({ path: join(TEST_BASE, 'nonexistent') })
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });

  it('fails for empty path', async () => {
    const executor = createListFilesExecutor();
    const result = await executor.execute(makeCall({ path: '' }));
    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid input');
  });

  it('fails for file path (not directory)', async () => {
    setupTree();
    const executor = createListFilesExecutor();
    const result = await executor.execute(
      makeCall({ path: join(TEST_BASE, 'package.json') })
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('not a directory');
  });
});
