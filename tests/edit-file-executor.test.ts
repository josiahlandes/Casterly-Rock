import { describe, expect, it, afterEach } from 'vitest';
import { existsSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createEditFileExecutor } from '../src/tools/executors/edit-file.js';

// ─── Temp dir helpers ────────────────────────────────────────────────────────

const TEST_BASE = join(tmpdir(), `casterly-edit-file-exec-test-${Date.now()}`);

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

function makeCall(input: Record<string, unknown>) {
  return { id: 'call-1', name: 'edit_file', input };
}

// ═══════════════════════════════════════════════════════════════════════════════
// createEditFileExecutor — structure
// ═══════════════════════════════════════════════════════════════════════════════

describe('createEditFileExecutor — structure', () => {
  it('returns executor with correct toolName', () => {
    const executor = createEditFileExecutor();
    expect(executor.toolName).toBe('edit_file');
  });

  it('has execute function', () => {
    const executor = createEditFileExecutor();
    expect(typeof executor.execute).toBe('function');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// createEditFileExecutor — basic editing
// ═══════════════════════════════════════════════════════════════════════════════

describe('createEditFileExecutor — basic editing', () => {
  it('performs search/replace', async () => {
    const fp = setupFile('test.ts', 'const a = 1;');
    const executor = createEditFileExecutor();
    const result = await executor.execute(
      makeCall({ path: fp, search: 'const a = 1', replace: 'const a = 10' })
    );
    expect(result.success).toBe(true);

    const parsed = JSON.parse(result.output!);
    expect(parsed.matchCount).toBe(1);
    expect(parsed.replacementsMade).toBe(1);
    expect(readFileSync(fp, 'utf-8')).toContain('const a = 10');
  });

  it('includes preview in output', async () => {
    const fp = setupFile('test.ts', 'hello world');
    const executor = createEditFileExecutor();
    const result = await executor.execute(
      makeCall({ path: fp, search: 'hello', replace: 'goodbye' })
    );
    const parsed = JSON.parse(result.output!);
    expect(parsed.preview).toBeDefined();
  });

  it('supports replaceAll', async () => {
    const fp = setupFile('test.ts', 'foo bar foo baz foo');
    const executor = createEditFileExecutor();
    const result = await executor.execute(
      makeCall({ path: fp, search: 'foo', replace: 'qux', replaceAll: true })
    );
    const parsed = JSON.parse(result.output!);
    expect(parsed.replacementsMade).toBe(3);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// createEditFileExecutor — input validation
// ═══════════════════════════════════════════════════════════════════════════════

describe('createEditFileExecutor — input validation', () => {
  it('fails for empty path', async () => {
    const executor = createEditFileExecutor();
    const result = await executor.execute(
      makeCall({ path: '', search: 'a', replace: 'b' })
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid input');
  });

  it('fails for empty search', async () => {
    const executor = createEditFileExecutor();
    const result = await executor.execute(
      makeCall({ path: '/tmp/test.ts', search: '', replace: 'b' })
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('search');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// createEditFileExecutor — error handling
// ═══════════════════════════════════════════════════════════════════════════════

describe('createEditFileExecutor — error handling', () => {
  it('fails when search string not found', async () => {
    const fp = setupFile('test.ts', 'hello world');
    const executor = createEditFileExecutor();
    const result = await executor.execute(
      makeCall({ path: fp, search: 'nonexistent', replace: 'new' })
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });

  it('fails for nonexistent file', async () => {
    const executor = createEditFileExecutor();
    const result = await executor.execute(
      makeCall({ path: join(TEST_BASE, 'missing.ts'), search: 'a', replace: 'b' })
    );
    expect(result.success).toBe(false);
  });
});
