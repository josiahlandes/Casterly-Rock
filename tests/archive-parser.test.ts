import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';
import JSZip from 'jszip';

import { parseZip, parseTarGz } from '../src/tools/executors/parsers/archive.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'casterly-archive-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  }
  tempDirs.length = 0;
});

/**
 * Create a test ZIP buffer using jszip
 */
async function createTestZip(files: Record<string, string>): Promise<Buffer> {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(files)) {
    zip.file(name, content);
  }
  return Buffer.from(await zip.generateAsync({ type: 'nodebuffer' }));
}

/**
 * Create a test .tar.gz file on disk using system tar
 */
function createTestTarGz(dir: string, files: Record<string, string>): string {
  const sourceDir = join(dir, 'source');
  execSync(`mkdir -p ${sourceDir}`);

  for (const [name, content] of Object.entries(files)) {
    const filePath = join(sourceDir, name);
    const fileDir = join(filePath, '..');
    execSync(`mkdir -p "${fileDir}"`);
    writeFileSync(filePath, content);
  }

  const tarPath = join(dir, 'test.tar.gz');
  execSync(`tar -czf "${tarPath}" -C "${sourceDir}" .`);
  return tarPath;
}

// ═══════════════════════════════════════════════════════════════════════════════
// parseZip
// ═══════════════════════════════════════════════════════════════════════════════

describe('parseZip', () => {
  it('lists files from a zip archive', async () => {
    const buffer = await createTestZip({
      'hello.txt': 'Hello world',
      'data/config.json': '{"key": "value"}',
    });

    const result = await parseZip(buffer);
    expect(result.format).toBe('zip');
    expect(result.totalEntries).toBeGreaterThanOrEqual(2);

    const paths = result.entries.map((e) => e.path);
    expect(paths).toContain('hello.txt');
    expect(paths).toContain('data/config.json');
  });

  it('returns file sizes', async () => {
    const content = 'A'.repeat(100);
    const buffer = await createTestZip({ 'big.txt': content });

    const result = await parseZip(buffer);
    const file = result.entries.find((e) => e.path === 'big.txt');
    expect(file).toBeDefined();
    expect(file?.size).toBe(100);
    expect(file?.type).toBe('file');
  });

  it('handles empty zip', async () => {
    const buffer = await createTestZip({});
    const result = await parseZip(buffer);
    expect(result.totalEntries).toBe(0);
    expect(result.entries).toEqual([]);
  });

  it('respects maxEntries option', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 10; i++) {
      files[`file${i}.txt`] = `content ${i}`;
    }
    const buffer = await createTestZip(files);

    const result = await parseZip(buffer, { maxEntries: 3 });
    expect(result.entries.length).toBeLessThanOrEqual(3);
  });

  it('calculates totalSize', async () => {
    const buffer = await createTestZip({
      'a.txt': 'AAAA', // 4 bytes
      'b.txt': 'BB',   // 2 bytes
    });

    const result = await parseZip(buffer);
    expect(result.totalSize).toBeGreaterThanOrEqual(6);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// parseTarGz
// ═══════════════════════════════════════════════════════════════════════════════

describe('parseTarGz', () => {
  it('lists files from a tar.gz archive', async () => {
    const dir = makeTempDir();
    const tarPath = createTestTarGz(dir, {
      'readme.md': '# Hello',
      'src/main.ts': 'const greeting = "hi";',
    });

    const result = await parseTarGz(tarPath);
    expect(result.format).toBe('tar.gz');
    expect(result.totalEntries).toBeGreaterThanOrEqual(2);

    const paths = result.entries.map((e) => e.path);
    // tar adds ./ prefix
    const hasReadme = paths.some((p) => p.includes('readme.md'));
    const hasMain = paths.some((p) => p.includes('main.ts'));
    expect(hasReadme).toBe(true);
    expect(hasMain).toBe(true);
  });

  it('identifies directories', async () => {
    const dir = makeTempDir();
    const tarPath = createTestTarGz(dir, {
      'subdir/file.txt': 'content',
    });

    const result = await parseTarGz(tarPath);
    const dirs = result.entries.filter((e) => e.type === 'directory');
    expect(dirs.length).toBeGreaterThanOrEqual(1);
  });

  it('reports file sizes', async () => {
    const dir = makeTempDir();
    const content = 'X'.repeat(50);
    const tarPath = createTestTarGz(dir, { 'data.bin': content });

    const result = await parseTarGz(tarPath);
    const file = result.entries.find((e) => e.path.includes('data.bin'));
    expect(file).toBeDefined();
    expect(file?.size).toBeGreaterThan(0);
    expect(file?.type).toBe('file');
  });

  it('respects maxEntries option', async () => {
    const dir = makeTempDir();
    const files: Record<string, string> = {};
    for (let i = 0; i < 10; i++) {
      files[`f${i}.txt`] = `data ${i}`;
    }
    const tarPath = createTestTarGz(dir, files);

    const result = await parseTarGz(tarPath, { maxEntries: 3 });
    expect(result.entries.length).toBeLessThanOrEqual(3);
  });
});
