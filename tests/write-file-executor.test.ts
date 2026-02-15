import { describe, expect, it, afterEach } from 'vitest';
import { existsSync, rmSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';

import { createWriteFileExecutor } from '../src/tools/executors/write-file.js';

// ─── Temp dir helpers ────────────────────────────────────────────────────────

const TEST_BASE = join(tmpdir(), `casterly-write-file-exec-test-${Date.now()}`);
const USER_DOCS_DIR = join(homedir(), 'Documents', 'Tyrion');

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

// ═══════════════════════════════════════════════════════════════════════════════
// createWriteFileExecutor — document redirect
// ═══════════════════════════════════════════════════════════════════════════════

describe('createWriteFileExecutor — document redirect', () => {
  const redirectCleanup: string[] = [];

  afterEach(() => {
    for (const fp of redirectCleanup) {
      try { rmSync(fp, { force: true }); } catch { /* ignore */ }
    }
    redirectCleanup.length = 0;
  });

  it('redirects bare .csv to ~/Documents/Tyrion/', async () => {
    const executor = createWriteFileExecutor();
    const filename = `test-redirect-${Date.now()}.csv`;
    const expectedPath = join(USER_DOCS_DIR, filename);
    redirectCleanup.push(expectedPath);

    const result = await executor.execute(makeCall({ path: filename, content: 'a,b\n1,2' }));

    expect(result.success).toBe(true);
    const output = JSON.parse(result.output!);
    expect(output.path).toBe(expectedPath);
    expect(existsSync(expectedPath)).toBe(true);
    expect(readFileSync(expectedPath, 'utf-8')).toBe('a,b\n1,2');
  });

  it('redirects bare .txt to ~/Documents/Tyrion/', async () => {
    const executor = createWriteFileExecutor();
    const filename = `test-redirect-${Date.now()}.txt`;
    const expectedPath = join(USER_DOCS_DIR, filename);
    redirectCleanup.push(expectedPath);

    const result = await executor.execute(makeCall({ path: filename, content: 'hello' }));

    expect(result.success).toBe(true);
    const output = JSON.parse(result.output!);
    expect(output.path).toBe(expectedPath);
  });

  it('does NOT redirect .ts files (code)', async () => {
    mkdirSync(TEST_BASE, { recursive: true });
    const fp = join(TEST_BASE, 'module.ts');
    const executor = createWriteFileExecutor();

    const result = await executor.execute(makeCall({ path: fp, content: 'export const x = 1;' }));

    expect(result.success).toBe(true);
    const output = JSON.parse(result.output!);
    expect(output.path).toBe(fp);
  });

  it('does NOT redirect files with directory paths', async () => {
    mkdirSync(TEST_BASE, { recursive: true });
    const fp = join(TEST_BASE, 'data.csv');
    const executor = createWriteFileExecutor();

    const result = await executor.execute(makeCall({ path: fp, content: 'a,b' }));

    expect(result.success).toBe(true);
    const output = JSON.parse(result.output!);
    // Should stay in TEST_BASE, not redirect
    expect(output.path).toBe(fp);
  });

  it('expands ~/path to home directory', async () => {
    const executor = createWriteFileExecutor();
    const filename = `test-tilde-${Date.now()}.txt`;
    const tilded = `~/Documents/Tyrion/${filename}`;
    const expectedPath = join(homedir(), 'Documents', 'Tyrion', filename);
    redirectCleanup.push(expectedPath);

    const result = await executor.execute(makeCall({ path: tilded, content: 'tilde test' }));

    expect(result.success).toBe(true);
    const output = JSON.parse(result.output!);
    expect(output.path).toBe(expectedPath);
  });
});
