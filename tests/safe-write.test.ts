import { describe, expect, it, afterEach } from 'vitest';
import { existsSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { safeWriteFile } from '../src/persistence/safe-write.js';

const TEST_BASE = join(tmpdir(), `casterly-safe-write-test-${Date.now()}`);

afterEach(() => {
  if (existsSync(TEST_BASE)) {
    rmSync(TEST_BASE, { recursive: true, force: true });
  }
});

describe('safeWriteFile', () => {
  it('writes a file that can be read back', async () => {
    const fp = join(TEST_BASE, 'test.json');
    await safeWriteFile(fp, '{"ok":true}');
    expect(readFileSync(fp, 'utf8')).toBe('{"ok":true}');
  });

  it('creates parent directories if missing', async () => {
    const fp = join(TEST_BASE, 'deep', 'nested', 'dir', 'file.yaml');
    await safeWriteFile(fp, 'hello: world');
    expect(readFileSync(fp, 'utf8')).toBe('hello: world');
  });

  it('does not leave a .tmp file on success', async () => {
    const fp = join(TEST_BASE, 'clean.json');
    await safeWriteFile(fp, '{}');
    expect(existsSync(fp + '.tmp')).toBe(false);
  });

  it('overwrites an existing file atomically', async () => {
    const fp = join(TEST_BASE, 'overwrite.json');
    await safeWriteFile(fp, '{"v":1}');
    await safeWriteFile(fp, '{"v":2}');
    expect(readFileSync(fp, 'utf8')).toBe('{"v":2}');
  });

  it('respects the encoding parameter', async () => {
    const fp = join(TEST_BASE, 'encoded.txt');
    await safeWriteFile(fp, 'café', 'utf8');
    expect(readFileSync(fp, 'utf8')).toBe('café');
  });
});
