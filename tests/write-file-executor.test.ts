import { describe, expect, it, afterEach } from 'vitest';
import { existsSync, rmSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createWriteFileExecutor } from '../src/tools/executors/write-file.js';

// ─── Temp dir helpers ────────────────────────────────────────────────────────

const TEST_BASE = join(tmpdir(), `casterly-write-file-exec-test-${Date.now()}`);

afterEach(() => {
  if (existsSync(TEST_BASE)) {
    rmSync(TEST_BASE, { recursive: true, force: true });
  }
});

function makeCall(input: Record<string, unknown>) {
  return { id: 'call-1', name: 'write_file', input };
}

// ═══════════════════════════════════════════════════════════════════════════════
// createWriteFileExecutor — structure
// ═══════════════════════════════════════════════════════════════════════════════

describe('createWriteFileExecutor — structure', () => {
  it('returns executor with correct toolName', () => {
    const executor = createWriteFileExecutor();
    expect(executor.toolName).toBe('write_file');
  });

  it('has execute function', () => {
    const executor = createWriteFileExecutor();
    expect(typeof executor.execute).toBe('function');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// createWriteFileExecutor — basic writing
// ═══════════════════════════════════════════════════════════════════════════════

describe('createWriteFileExecutor — basic writing', () => {
  it('creates a new file', async () => {
    mkdirSync(TEST_BASE, { recursive: true });
    const fp = join(TEST_BASE, 'new-file.ts');
    const executor = createWriteFileExecutor();
    const result = await executor.execute(makeCall({ path: fp, content: 'hello world' }));
    expect(result.success).toBe(true);

    const parsed = JSON.parse(result.output!);
    expect(parsed.created).toBe(true);
    expect(parsed.bytesWritten).toBeGreaterThan(0);
    expect(readFileSync(fp, 'utf-8')).toBe('hello world');
  });

  it('overwrites existing file', async () => {
    mkdirSync(TEST_BASE, { recursive: true });
    const fp = join(TEST_BASE, 'existing.ts');
    writeFileSync(fp, 'old content');
    const executor = createWriteFileExecutor();
    const result = await executor.execute(makeCall({ path: fp, content: 'new content' }));
    expect(result.success).toBe(true);

    const parsed = JSON.parse(result.output!);
    expect(parsed.created).toBe(false);
    expect(readFileSync(fp, 'utf-8')).toBe('new content');
  });

  it('creates parent directories', async () => {
    const fp = join(TEST_BASE, 'deep', 'nested', 'file.ts');
    const executor = createWriteFileExecutor();
    const result = await executor.execute(makeCall({ path: fp, content: 'deep content' }));
    expect(result.success).toBe(true);
    expect(existsSync(fp)).toBe(true);
  });

  it('appends when append=true', async () => {
    mkdirSync(TEST_BASE, { recursive: true });
    const fp = join(TEST_BASE, 'append.ts');
    writeFileSync(fp, 'first');
    const executor = createWriteFileExecutor();
    const result = await executor.execute(makeCall({ path: fp, content: ' second', append: true }));
    expect(result.success).toBe(true);

    const parsed = JSON.parse(result.output!);
    expect(parsed.appended).toBe(true);
    expect(readFileSync(fp, 'utf-8')).toBe('first second');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// createWriteFileExecutor — protected paths
// ═══════════════════════════════════════════════════════════════════════════════

describe('createWriteFileExecutor — protected paths', () => {
  it('blocks writing to .env', async () => {
    mkdirSync(TEST_BASE, { recursive: true });
    const fp = join(TEST_BASE, '.env');
    const executor = createWriteFileExecutor();
    const result = await executor.execute(makeCall({ path: fp, content: 'SECRET=x' }));
    expect(result.success).toBe(false);
    expect(result.error).toContain('protected');
  });

  it('blocks writing to src/security/', async () => {
    mkdirSync(join(TEST_BASE, 'src', 'security'), { recursive: true });
    const fp = join(TEST_BASE, 'src', 'security', 'auth.ts');
    const executor = createWriteFileExecutor();
    const result = await executor.execute(makeCall({ path: fp, content: 'code' }));
    expect(result.success).toBe(false);
    expect(result.error).toContain('protected');
  });

  it('blocks writing to config/', async () => {
    mkdirSync(join(TEST_BASE, 'config'), { recursive: true });
    const fp = join(TEST_BASE, 'config', 'settings.yaml');
    const executor = createWriteFileExecutor();
    const result = await executor.execute(makeCall({ path: fp, content: 'data' }));
    expect(result.success).toBe(false);
    expect(result.error).toContain('protected');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// createWriteFileExecutor — input validation
// ═══════════════════════════════════════════════════════════════════════════════

describe('createWriteFileExecutor — input validation', () => {
  it('fails for empty path', async () => {
    const executor = createWriteFileExecutor();
    const result = await executor.execute(makeCall({ path: '', content: 'data' }));
    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid input');
  });

  it('fails for non-string content', async () => {
    const executor = createWriteFileExecutor();
    const result = await executor.execute(makeCall({ path: '/tmp/test', content: 123 }));
    expect(result.success).toBe(false);
    expect(result.error).toContain('content must be a string');
  });

  it('fails for oversized content', async () => {
    const executor = createWriteFileExecutor();
    const hugeContent = 'x'.repeat(11 * 1024 * 1024); // 11MB
    const result = await executor.execute(
      makeCall({ path: join(TEST_BASE, 'huge.ts'), content: hugeContent })
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('too large');
  });
});
