import { describe, expect, it, afterEach } from 'vitest';
import { existsSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createGlobFilesExecutor } from '../src/tools/executors/glob-files.js';

// ─── Temp dir helpers ────────────────────────────────────────────────────────

const TEST_BASE = join(tmpdir(), `casterly-glob-files-exec-test-${Date.now()}`);

afterEach(() => {
  if (existsSync(TEST_BASE)) {
    rmSync(TEST_BASE, { recursive: true, force: true });
  }
});

function setupTree(): void {
  mkdirSync(join(TEST_BASE, 'src'), { recursive: true });
  mkdirSync(join(TEST_BASE, 'lib'), { recursive: true });
  writeFileSync(join(TEST_BASE, 'src', 'index.ts'), 'export const a = 1;');
  writeFileSync(join(TEST_BASE, 'src', 'utils.ts'), 'export function b() {}');
  writeFileSync(join(TEST_BASE, 'lib', 'helper.js'), 'module.exports = {};');
  writeFileSync(join(TEST_BASE, 'readme.md'), '# Test');
}

function makeCall(input: Record<string, unknown>) {
  return { id: 'call-1', name: 'glob_files', input };
}

// ═══════════════════════════════════════════════════════════════════════════════
// createGlobFilesExecutor — structure
// ═══════════════════════════════════════════════════════════════════════════════

describe('createGlobFilesExecutor — structure', () => {
  it('returns executor with correct toolName', () => {
    const executor = createGlobFilesExecutor();
    expect(executor.toolName).toBe('glob_files');
  });

  it('has execute function', () => {
    const executor = createGlobFilesExecutor();
    expect(typeof executor.execute).toBe('function');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// createGlobFilesExecutor — basic globbing
// ═══════════════════════════════════════════════════════════════════════════════

describe('createGlobFilesExecutor — basic globbing', () => {
  it('finds files by pattern', async () => {
    setupTree();
    const executor = createGlobFilesExecutor();
    const result = await executor.execute(
      makeCall({ pattern: '**/*.ts', cwd: TEST_BASE })
    );
    expect(result.success).toBe(true);

    const parsed = JSON.parse(result.output!);
    expect(parsed.matchCount).toBe(2);
    expect(parsed.matches.length).toBe(2);
  });

  it('returns match metadata', async () => {
    setupTree();
    const executor = createGlobFilesExecutor();
    const result = await executor.execute(
      makeCall({ pattern: '**/*.ts', cwd: TEST_BASE })
    );
    const parsed = JSON.parse(result.output!);
    const match = parsed.matches[0]!;
    expect(match.path).toBeTruthy();
    expect(typeof match.size).toBe('number');
    expect(match.modified).toBeTruthy();
  });

  it('includes pattern in output', async () => {
    setupTree();
    const executor = createGlobFilesExecutor();
    const result = await executor.execute(
      makeCall({ pattern: '**/*.md', cwd: TEST_BASE })
    );
    const parsed = JSON.parse(result.output!);
    expect(parsed.pattern).toBe('**/*.md');
    expect(parsed.matchCount).toBe(1);
  });

  it('supports filesOnly option', async () => {
    setupTree();
    const executor = createGlobFilesExecutor();
    const result = await executor.execute(
      makeCall({ pattern: '**/*', cwd: TEST_BASE, filesOnly: true })
    );
    const parsed = JSON.parse(result.output!);
    // Should only return files, not directories
    expect(parsed.matchCount).toBeGreaterThan(0);
    const hasDir = parsed.matches.some((m: { isDir?: boolean }) => m.isDir === true);
    expect(hasDir).toBe(false);
  });

  it('supports maxDepth option', async () => {
    setupTree();
    const executor = createGlobFilesExecutor();
    // maxDepth=2 should find .ts files in src/ (depth 2)
    const result = await executor.execute(
      makeCall({ pattern: '**/*.ts', cwd: TEST_BASE, maxDepth: 2 })
    );
    expect(result.success).toBe(true);
    const parsed = JSON.parse(result.output!);
    expect(parsed.matchCount).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// createGlobFilesExecutor — input validation
// ═══════════════════════════════════════════════════════════════════════════════

describe('createGlobFilesExecutor — input validation', () => {
  it('fails for empty pattern', async () => {
    const executor = createGlobFilesExecutor();
    const result = await executor.execute(makeCall({ pattern: '' }));
    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid input');
  });

  it('fails for whitespace-only pattern', async () => {
    const executor = createGlobFilesExecutor();
    const result = await executor.execute(makeCall({ pattern: '   ' }));
    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid input');
  });

  it('returns toolCallId', async () => {
    const executor = createGlobFilesExecutor();
    const result = await executor.execute(makeCall({ pattern: '' }));
    expect(result.toolCallId).toBe('call-1');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// createGlobFilesExecutor — truncation
// ═══════════════════════════════════════════════════════════════════════════════

describe('createGlobFilesExecutor — truncation', () => {
  it('sets truncated=false for small results', async () => {
    setupTree();
    const executor = createGlobFilesExecutor();
    const result = await executor.execute(
      makeCall({ pattern: '**/*.ts', cwd: TEST_BASE })
    );
    const parsed = JSON.parse(result.output!);
    expect(parsed.truncated).toBe(false);
  });
});
