import { describe, expect, it, afterEach } from 'vitest';
import { existsSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createGrepFilesExecutor } from '../src/tools/executors/grep-files.js';

// ─── Temp dir helpers ────────────────────────────────────────────────────────

const TEST_BASE = join(tmpdir(), `casterly-grep-files-exec-test-${Date.now()}`);

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
  return { id: 'call-1', name: 'grep_files', input };
}

// ═══════════════════════════════════════════════════════════════════════════════
// createGrepFilesExecutor — structure
// ═══════════════════════════════════════════════════════════════════════════════

describe('createGrepFilesExecutor — structure', () => {
  it('returns executor with correct toolName', () => {
    const executor = createGrepFilesExecutor();
    expect(executor.toolName).toBe('grep_files');
  });

  it('has execute function', () => {
    const executor = createGrepFilesExecutor();
    expect(typeof executor.execute).toBe('function');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// createGrepFilesExecutor — basic search
// ═══════════════════════════════════════════════════════════════════════════════

describe('createGrepFilesExecutor — basic search', () => {
  it('finds pattern in files', async () => {
    setupTree();
    const executor = createGrepFilesExecutor();
    const result = await executor.execute(
      makeCall({ pattern: 'hello', cwd: TEST_BASE })
    );
    expect(result.success).toBe(true);
    expect(result.output).toBeTruthy();
    // Output should contain matches
    expect(result.output!.length).toBeGreaterThan(0);
  });

  it('returns formatted output', async () => {
    setupTree();
    const executor = createGrepFilesExecutor();
    const result = await executor.execute(
      makeCall({ pattern: 'function', cwd: TEST_BASE })
    );
    expect(result.success).toBe(true);
    // Formatted output from formatGrepResults
    expect(result.output).toBeTruthy();
  });

  it('supports ignoreCase', async () => {
    setupTree();
    const executor = createGrepFilesExecutor();
    const result = await executor.execute(
      makeCall({ pattern: 'HELLO', cwd: TEST_BASE, ignoreCase: true })
    );
    expect(result.success).toBe(true);
    expect(result.output).toBeTruthy();
    expect(result.output!.length).toBeGreaterThan(0);
  });

  it('supports include filter', async () => {
    setupTree();
    const executor = createGrepFilesExecutor();
    const result = await executor.execute(
      makeCall({ pattern: 'hello', cwd: TEST_BASE, include: ['*.ts'] })
    );
    expect(result.success).toBe(true);
    // Should only find in .ts files
    expect(result.output).toBeTruthy();
  });

  it('supports maxMatches', async () => {
    setupTree();
    const executor = createGrepFilesExecutor();
    const result = await executor.execute(
      makeCall({ pattern: '\\w+', cwd: TEST_BASE, maxMatches: 1 })
    );
    expect(result.success).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// createGrepFilesExecutor — input validation
// ═══════════════════════════════════════════════════════════════════════════════

describe('createGrepFilesExecutor — input validation', () => {
  it('fails for empty pattern', async () => {
    const executor = createGrepFilesExecutor();
    const result = await executor.execute(makeCall({ pattern: '' }));
    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid input');
  });

  it('fails for whitespace-only pattern', async () => {
    const executor = createGrepFilesExecutor();
    const result = await executor.execute(makeCall({ pattern: '   ' }));
    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid input');
  });

  it('returns toolCallId', async () => {
    const executor = createGrepFilesExecutor();
    const result = await executor.execute(makeCall({ pattern: '' }));
    expect(result.toolCallId).toBe('call-1');
  });
});
