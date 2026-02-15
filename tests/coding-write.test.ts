import { describe, expect, it, afterEach } from 'vitest';
import { existsSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  writeFile,
  deleteFile,
  moveFile,
  copyFile,
  ensureDir,
} from '../src/coding/tools/write.js';

// ─── Temp dir helpers ────────────────────────────────────────────────────────

const TEST_BASE = join(tmpdir(), `casterly-coding-write-test-${Date.now()}`);

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

// ═══════════════════════════════════════════════════════════════════════════════
// writeFile — basic operations
// ═══════════════════════════════════════════════════════════════════════════════

describe('writeFile — basic operations', () => {
  it('creates a new file', async () => {
    mkdirSync(TEST_BASE, { recursive: true });
    const fp = join(TEST_BASE, 'new.ts');
    const result = await writeFile(fp, 'hello world');
    expect(result.success).toBe(true);
    expect(result.created).toBe(true);
    expect(result.bytesWritten).toBeGreaterThan(0);
    expect(readFileSync(fp, 'utf-8')).toBe('hello world');
  });

  it('overwrites existing file', async () => {
    const fp = setupFile('existing.ts', 'old content');
    const result = await writeFile(fp, 'new content');
    expect(result.success).toBe(true);
    expect(result.created).toBe(false);
    expect(result.previousContent).toBe('old content');
    expect(readFileSync(fp, 'utf-8')).toBe('new content');
  });

  it('creates parent directories when createDirs=true', async () => {
    const fp = join(TEST_BASE, 'deep', 'nested', 'file.ts');
    const result = await writeFile(fp, 'content');
    expect(result.success).toBe(true);
    expect(existsSync(fp)).toBe(true);
  });

  it('returns token count and bytes written', async () => {
    mkdirSync(TEST_BASE, { recursive: true });
    const fp = join(TEST_BASE, 'tokens.ts');
    const result = await writeFile(fp, 'hello world');
    expect(result.tokens).toBeGreaterThan(0);
    expect(result.bytesWritten).toBe(Buffer.byteLength('hello world', 'utf-8'));
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// writeFile — options
// ═══════════════════════════════════════════════════════════════════════════════

describe('writeFile — options', () => {
  it('fails when overwrite=false and file exists', async () => {
    const fp = setupFile('existing.ts', 'content');
    const result = await writeFile(fp, 'new', { overwrite: false });
    expect(result.success).toBe(false);
    expect(result.error).toContain('overwrite');
  });

  it('creates backup when backup=true', async () => {
    const fp = setupFile('backup-test.ts', 'original');
    await writeFile(fp, 'new content', { backup: true });
    expect(existsSync(`${fp}.bak`)).toBe(true);
    expect(readFileSync(`${fp}.bak`, 'utf-8')).toBe('original');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// writeFile — forbidden paths
// ═══════════════════════════════════════════════════════════════════════════════

describe('writeFile — forbidden paths', () => {
  it('blocks .env files', async () => {
    mkdirSync(TEST_BASE, { recursive: true });
    const fp = join(TEST_BASE, '.env');
    const result = await writeFile(fp, 'SECRET=key');
    expect(result.success).toBe(false);
    expect(result.error).toContain('sensitive');
  });

  it('blocks .env.local files', async () => {
    mkdirSync(TEST_BASE, { recursive: true });
    const fp = join(TEST_BASE, '.env.local');
    const result = await writeFile(fp, 'SECRET=key');
    expect(result.success).toBe(false);
  });

  it('blocks credentials files', async () => {
    mkdirSync(TEST_BASE, { recursive: true });
    const fp = join(TEST_BASE, 'credentials.json');
    const result = await writeFile(fp, '{}');
    expect(result.success).toBe(false);
    expect(result.error).toContain('sensitive');
  });

  it('blocks .pem files', async () => {
    mkdirSync(TEST_BASE, { recursive: true });
    const fp = join(TEST_BASE, 'cert.pem');
    const result = await writeFile(fp, 'cert data');
    expect(result.success).toBe(false);
  });

  it('blocks .key files', async () => {
    mkdirSync(TEST_BASE, { recursive: true });
    const fp = join(TEST_BASE, 'server.key');
    const result = await writeFile(fp, 'key data');
    expect(result.success).toBe(false);
  });

  it('blocks secrets.json', async () => {
    mkdirSync(TEST_BASE, { recursive: true });
    const fp = join(TEST_BASE, 'secrets.json');
    const result = await writeFile(fp, '{}');
    expect(result.success).toBe(false);
  });

  it('blocks id_rsa files', async () => {
    mkdirSync(TEST_BASE, { recursive: true });
    const fp = join(TEST_BASE, 'id_rsa');
    const result = await writeFile(fp, 'key');
    expect(result.success).toBe(false);
  });

  it('blocks writing to node_modules', async () => {
    mkdirSync(join(TEST_BASE, 'node_modules', 'pkg'), { recursive: true });
    const fp = join(TEST_BASE, 'node_modules', 'pkg', 'index.js');
    const result = await writeFile(fp, 'bad');
    expect(result.success).toBe(false);
    expect(result.error).toContain('protected directory');
  });

  it('blocks writing to .git/objects', async () => {
    mkdirSync(join(TEST_BASE, '.git', 'objects'), { recursive: true });
    const fp = join(TEST_BASE, '.git', 'objects', 'ab1234');
    const result = await writeFile(fp, 'bad');
    expect(result.success).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// deleteFile
// ═══════════════════════════════════════════════════════════════════════════════

describe('deleteFile', () => {
  it('deletes an existing file', async () => {
    const fp = setupFile('delete-me.ts', 'content');
    const result = await deleteFile(fp);
    expect(result.success).toBe(true);
    expect(existsSync(fp)).toBe(false);
  });

  it('returns previousContent', async () => {
    const fp = setupFile('delete-me.ts', 'saved content');
    const result = await deleteFile(fp);
    expect(result.previousContent).toBe('saved content');
  });

  it('fails for nonexistent file', async () => {
    const fp = join(TEST_BASE, 'nonexistent.ts');
    const result = await deleteFile(fp);
    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });

  it('blocks deleting forbidden files', async () => {
    mkdirSync(TEST_BASE, { recursive: true });
    const fp = join(TEST_BASE, '.env');
    writeFileSync(fp, 'secret');
    const result = await deleteFile(fp);
    expect(result.success).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// moveFile
// ═══════════════════════════════════════════════════════════════════════════════

describe('moveFile', () => {
  it('moves a file to a new location', async () => {
    const fp = setupFile('source.ts', 'content');
    const dest = join(TEST_BASE, 'dest.ts');
    const result = await moveFile(fp, dest);
    expect(result.success).toBe(true);
    expect(existsSync(dest)).toBe(true);
    expect(existsSync(fp)).toBe(false);
  });

  it('creates parent directories for destination', async () => {
    const fp = setupFile('source.ts', 'content');
    const dest = join(TEST_BASE, 'sub', 'dir', 'dest.ts');
    const result = await moveFile(fp, dest);
    expect(result.success).toBe(true);
    expect(existsSync(dest)).toBe(true);
  });

  it('fails for nonexistent source', async () => {
    const result = await moveFile(
      join(TEST_BASE, 'missing.ts'),
      join(TEST_BASE, 'dest.ts')
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });

  it('blocks moving forbidden source files', async () => {
    mkdirSync(TEST_BASE, { recursive: true });
    const fp = join(TEST_BASE, '.env');
    writeFileSync(fp, 'secret');
    const result = await moveFile(fp, join(TEST_BASE, 'moved.env'));
    expect(result.success).toBe(false);
  });

  it('blocks moving to forbidden destination', async () => {
    const fp = setupFile('source.ts', 'content');
    const result = await moveFile(fp, join(TEST_BASE, '.env'));
    expect(result.success).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// copyFile
// ═══════════════════════════════════════════════════════════════════════════════

describe('copyFile', () => {
  it('copies a file', async () => {
    const fp = setupFile('original.ts', 'content');
    const dest = join(TEST_BASE, 'copy.ts');
    const result = await copyFile(fp, dest);
    expect(result.success).toBe(true);
    expect(readFileSync(dest, 'utf-8')).toBe('content');
    // Original still exists
    expect(existsSync(fp)).toBe(true);
  });

  it('creates parent directories for destination', async () => {
    const fp = setupFile('original.ts', 'content');
    const dest = join(TEST_BASE, 'deep', 'copy.ts');
    const result = await copyFile(fp, dest);
    expect(result.success).toBe(true);
    expect(existsSync(dest)).toBe(true);
  });

  it('fails for nonexistent source', async () => {
    const result = await copyFile(
      join(TEST_BASE, 'missing.ts'),
      join(TEST_BASE, 'dest.ts')
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });

  it('blocks copying to forbidden destination', async () => {
    const fp = setupFile('source.ts', 'content');
    const result = await copyFile(fp, join(TEST_BASE, '.env'));
    expect(result.success).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ensureDir
// ═══════════════════════════════════════════════════════════════════════════════

describe('ensureDir', () => {
  it('creates a new directory', async () => {
    const dir = join(TEST_BASE, 'new-dir');
    const result = await ensureDir(dir);
    expect(result.success).toBe(true);
    expect(result.created).toBe(true);
    expect(existsSync(dir)).toBe(true);
  });

  it('returns created=false for existing directory', async () => {
    mkdirSync(TEST_BASE, { recursive: true });
    const result = await ensureDir(TEST_BASE);
    expect(result.success).toBe(true);
    expect(result.created).toBe(false);
  });

  it('creates nested directories', async () => {
    const dir = join(TEST_BASE, 'a', 'b', 'c');
    const result = await ensureDir(dir);
    expect(result.success).toBe(true);
    expect(existsSync(dir)).toBe(true);
  });

  it('fails if path is a file', async () => {
    const fp = setupFile('file.txt', 'content');
    const result = await ensureDir(fp);
    expect(result.success).toBe(false);
    expect(result.error).toContain('not a directory');
  });
});
