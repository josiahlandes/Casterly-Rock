import { describe, expect, it, afterEach } from 'vitest';
import { existsSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createReadFileExecutor } from '../src/tools/executors/read-file.js';

// ─── Temp dir helpers ────────────────────────────────────────────────────────

const TEST_BASE = join(tmpdir(), `casterly-read-file-exec-test-${Date.now()}`);

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
  return { id: 'call-1', name: 'read_file', input };
}

// ═══════════════════════════════════════════════════════════════════════════════
// createReadFileExecutor — structure
// ═══════════════════════════════════════════════════════════════════════════════

describe('createReadFileExecutor — structure', () => {
  it('returns executor with correct toolName', () => {
    const executor = createReadFileExecutor();
    expect(executor.toolName).toBe('read_file');
  });

  it('has execute function', () => {
    const executor = createReadFileExecutor();
    expect(typeof executor.execute).toBe('function');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// createReadFileExecutor — basic reading
// ═══════════════════════════════════════════════════════════════════════════════

describe('createReadFileExecutor — basic reading', () => {
  it('reads file content', async () => {
    const fp = setupFile('test.ts', 'hello world');
    const executor = createReadFileExecutor();
    const result = await executor.execute(makeCall({ path: fp }));
    expect(result.success).toBe(true);
    expect(result.toolCallId).toBe('call-1');

    const parsed = JSON.parse(result.output!);
    expect(parsed.content).toBe('hello world');
    expect(parsed.size).toBeGreaterThan(0);
    expect(parsed.lines).toBe(1);
  });

  it('returns line count', async () => {
    const fp = setupFile('test.ts', 'line 1\nline 2\nline 3');
    const executor = createReadFileExecutor();
    const result = await executor.execute(makeCall({ path: fp }));
    const parsed = JSON.parse(result.output!);
    expect(parsed.lines).toBe(3);
  });

  it('supports maxLines', async () => {
    const fp = setupFile('test.ts', 'line 1\nline 2\nline 3\nline 4\nline 5');
    const executor = createReadFileExecutor();
    const result = await executor.execute(makeCall({ path: fp, maxLines: 2 }));
    const parsed = JSON.parse(result.output!);
    expect(parsed.content).toBe('line 1\nline 2');
    expect(parsed.truncated).toBe(true);
  });

  it('returns truncated=false when all lines returned', async () => {
    const fp = setupFile('test.ts', 'line 1\nline 2');
    const executor = createReadFileExecutor();
    const result = await executor.execute(makeCall({ path: fp }));
    const parsed = JSON.parse(result.output!);
    expect(parsed.truncated).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// createReadFileExecutor — safety checks
// ═══════════════════════════════════════════════════════════════════════════════

describe('createReadFileExecutor — safety checks', () => {
  it('blocks .env files', async () => {
    const fp = setupFile('.env', 'SECRET=value');
    const executor = createReadFileExecutor();
    const result = await executor.execute(makeCall({ path: fp }));
    expect(result.success).toBe(false);
    expect(result.error).toContain('protected');
  });

  it('blocks .env.local files', async () => {
    const fp = setupFile('.env.local', 'SECRET=value');
    const executor = createReadFileExecutor();
    const result = await executor.execute(makeCall({ path: fp }));
    expect(result.success).toBe(false);
    expect(result.error).toContain('protected');
  });

  it('blocks .env.production files', async () => {
    const fp = setupFile('.env.production', 'SECRET=value');
    const executor = createReadFileExecutor();
    const result = await executor.execute(makeCall({ path: fp }));
    expect(result.success).toBe(false);
    expect(result.error).toContain('protected');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// createReadFileExecutor — error handling
// ═══════════════════════════════════════════════════════════════════════════════

describe('createReadFileExecutor — error handling', () => {
  it('fails for empty path', async () => {
    const executor = createReadFileExecutor();
    const result = await executor.execute(makeCall({ path: '' }));
    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid input');
  });

  it('fails for nonexistent file', async () => {
    const executor = createReadFileExecutor();
    const result = await executor.execute(makeCall({ path: join(TEST_BASE, 'nope.ts') }));
    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });

  it('fails for directory', async () => {
    mkdirSync(TEST_BASE, { recursive: true });
    const executor = createReadFileExecutor();
    const result = await executor.execute(makeCall({ path: TEST_BASE }));
    expect(result.success).toBe(false);
    expect(result.error).toContain('directory');
  });
});
