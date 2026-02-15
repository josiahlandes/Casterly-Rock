import { describe, expect, it, afterEach } from 'vitest';
import { existsSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createSearchFilesExecutor } from '../src/tools/executors/search-files.js';

// ─── Temp dir helpers ────────────────────────────────────────────────────────

const TEST_BASE = join(tmpdir(), `casterly-search-files-exec-test-${Date.now()}`);

afterEach(() => {
  if (existsSync(TEST_BASE)) {
    rmSync(TEST_BASE, { recursive: true, force: true });
  }
});

function setupTree(): void {
  mkdirSync(join(TEST_BASE, 'src'), { recursive: true });
  writeFileSync(
    join(TEST_BASE, 'src', 'index.ts'),
    'const hello = "world";\nfunction greet() {\n  return hello;\n}\n'
  );
  writeFileSync(
    join(TEST_BASE, 'src', 'utils.ts'),
    'export function add(a: number, b: number) {\n  return a + b;\n}\n'
  );
  writeFileSync(join(TEST_BASE, 'readme.md'), '# Test project\n\nHello world example.\n');
}

function makeCall(input: Record<string, unknown>) {
  return { id: 'call-1', name: 'search_files', input };
}

// ═══════════════════════════════════════════════════════════════════════════════
// createSearchFilesExecutor — structure
// ═══════════════════════════════════════════════════════════════════════════════

describe('createSearchFilesExecutor — structure', () => {
  it('returns executor with correct toolName', () => {
    const executor = createSearchFilesExecutor();
    expect(executor.toolName).toBe('search_files');
  });

  it('has execute function', () => {
    const executor = createSearchFilesExecutor();
    expect(typeof executor.execute).toBe('function');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// createSearchFilesExecutor — basic search
// ═══════════════════════════════════════════════════════════════════════════════

describe('createSearchFilesExecutor — basic search', () => {
  it('finds pattern in files', async () => {
    setupTree();
    const executor = createSearchFilesExecutor();
    const result = await executor.execute(
      makeCall({ pattern: 'hello', path: TEST_BASE })
    );
    expect(result.success).toBe(true);

    const parsed = JSON.parse(result.output!);
    expect(parsed.totalMatches).toBeGreaterThan(0);
    expect(parsed.matches.length).toBeGreaterThan(0);
  });

  it('returns match details', async () => {
    setupTree();
    const executor = createSearchFilesExecutor();
    const result = await executor.execute(
      makeCall({ pattern: 'function', path: TEST_BASE })
    );
    const parsed = JSON.parse(result.output!);
    expect(parsed.matches.length).toBeGreaterThan(0);

    const match = parsed.matches[0];
    expect(match.file).toBeTruthy();
    expect(match.line).toBeGreaterThan(0);
    expect(match.content).toBeTruthy();
  });

  it('supports regex patterns', async () => {
    setupTree();
    const executor = createSearchFilesExecutor();
    const result = await executor.execute(
      makeCall({ pattern: 'function\\s+\\w+', path: TEST_BASE })
    );
    const parsed = JSON.parse(result.output!);
    expect(parsed.totalMatches).toBeGreaterThanOrEqual(2);
  });

  it('counts files searched', async () => {
    setupTree();
    const executor = createSearchFilesExecutor();
    const result = await executor.execute(
      makeCall({ pattern: 'export', path: TEST_BASE })
    );
    const parsed = JSON.parse(result.output!);
    expect(parsed.filesSearched).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// createSearchFilesExecutor — filtering
// ═══════════════════════════════════════════════════════════════════════════════

describe('createSearchFilesExecutor — filtering', () => {
  it('filters by file pattern', async () => {
    setupTree();
    const executor = createSearchFilesExecutor();
    const result = await executor.execute(
      makeCall({ pattern: 'hello', path: TEST_BASE, filePattern: '*.ts' })
    );
    const parsed = JSON.parse(result.output!);
    // Should only find in .ts files, not .md
    const allTs = parsed.matches.every((m: { file: string }) => m.file.endsWith('.ts'));
    expect(allTs).toBe(true);
  });

  it('respects maxResults', async () => {
    setupTree();
    const executor = createSearchFilesExecutor();
    const result = await executor.execute(
      makeCall({ pattern: '\\w+', path: TEST_BASE, maxResults: 2 })
    );
    const parsed = JSON.parse(result.output!);
    expect(parsed.matches.length).toBeLessThanOrEqual(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// createSearchFilesExecutor — error handling
// ═══════════════════════════════════════════════════════════════════════════════

describe('createSearchFilesExecutor — error handling', () => {
  it('fails for empty pattern', async () => {
    const executor = createSearchFilesExecutor();
    const result = await executor.execute(makeCall({ pattern: '', path: TEST_BASE }));
    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid input');
  });

  it('fails for nonexistent path', async () => {
    const executor = createSearchFilesExecutor();
    const result = await executor.execute(
      makeCall({ pattern: 'test', path: join(TEST_BASE, 'nonexistent') })
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });

  it('fails for invalid regex', async () => {
    setupTree();
    const executor = createSearchFilesExecutor();
    const result = await executor.execute(
      makeCall({ pattern: '[invalid', path: TEST_BASE })
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid regex');
  });

  it('returns zero matches for no hits', async () => {
    setupTree();
    const executor = createSearchFilesExecutor();
    const result = await executor.execute(
      makeCall({ pattern: 'zzznomatch999', path: TEST_BASE })
    );
    expect(result.success).toBe(true);
    const parsed = JSON.parse(result.output!);
    expect(parsed.totalMatches).toBe(0);
  });
});
