import { describe, expect, it, afterEach } from 'vitest';
import { existsSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { glob } from '../src/coding/tools/glob.js';

// ─── Temp dir helpers ────────────────────────────────────────────────────────

const TEST_BASE = join(tmpdir(), `casterly-coding-glob-test-${Date.now()}`);

afterEach(() => {
  if (existsSync(TEST_BASE)) {
    rmSync(TEST_BASE, { recursive: true, force: true });
  }
});

function setupTree(): void {
  mkdirSync(join(TEST_BASE, 'src'), { recursive: true });
  mkdirSync(join(TEST_BASE, 'tests'), { recursive: true });
  mkdirSync(join(TEST_BASE, 'docs'), { recursive: true });
  writeFileSync(join(TEST_BASE, 'src', 'index.ts'), 'export {}');
  writeFileSync(join(TEST_BASE, 'src', 'utils.ts'), 'export {}');
  writeFileSync(join(TEST_BASE, 'src', 'config.json'), '{}');
  writeFileSync(join(TEST_BASE, 'tests', 'index.test.ts'), 'test');
  writeFileSync(join(TEST_BASE, 'docs', 'README.md'), '# Readme');
  writeFileSync(join(TEST_BASE, 'package.json'), '{}');
}

// ═══════════════════════════════════════════════════════════════════════════════
// glob — basic matching
// ═══════════════════════════════════════════════════════════════════════════════

describe('glob — basic matching', () => {
  it('finds files with wildcard pattern', async () => {
    setupTree();
    const result = await glob('src/*.ts', { cwd: TEST_BASE });
    expect(result.success).toBe(true);
    expect(result.matches.length).toBeGreaterThanOrEqual(2);
    expect(result.matches.some((m) => m.relativePath.includes('index.ts'))).toBe(true);
    expect(result.matches.some((m) => m.relativePath.includes('utils.ts'))).toBe(true);
  });

  it('finds files with ** pattern', async () => {
    setupTree();
    const result = await glob('**/*.ts', { cwd: TEST_BASE });
    expect(result.success).toBe(true);
    // Should find src/*.ts and tests/*.test.ts
    expect(result.matches.length).toBeGreaterThanOrEqual(3);
  });

  it('returns metadata for files', async () => {
    setupTree();
    const result = await glob('src/*.ts', { cwd: TEST_BASE });
    for (const match of result.matches) {
      expect(match.path).toBeTruthy();
      expect(match.relativePath).toBeTruthy();
      expect(match.modified).toBeTruthy();
      expect(match.isDirectory).toBe(false);
      expect(typeof match.size).toBe('number');
    }
  });

  it('returns cwd in result', async () => {
    setupTree();
    const result = await glob('*.json', { cwd: TEST_BASE });
    expect(result.cwd).toBe(TEST_BASE);
    expect(result.pattern).toBe('*.json');
  });

  it('matches sorted alphabetically by relativePath', async () => {
    setupTree();
    const result = await glob('src/*.ts', { cwd: TEST_BASE });
    const paths = result.matches.map((m) => m.relativePath);
    const sorted = [...paths].sort();
    expect(paths).toEqual(sorted);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// glob — options
// ═══════════════════════════════════════════════════════════════════════════════

describe('glob — options', () => {
  it('filesOnly filters out directories', async () => {
    setupTree();
    const result = await glob('**/*', { cwd: TEST_BASE, filesOnly: true });
    expect(result.matches.every((m) => !m.isDirectory)).toBe(true);
  });

  it('dirsOnly filters out files', async () => {
    setupTree();
    const result = await glob('*', { cwd: TEST_BASE, dirsOnly: true });
    expect(result.matches.every((m) => m.isDirectory)).toBe(true);
  });

  it('maxDepth limits traversal', async () => {
    setupTree();
    const result = await glob('**/*.ts', { cwd: TEST_BASE, maxDepth: 0 });
    // maxDepth 0 means only root level — no *.ts files at root
    expect(result.matches).toHaveLength(0);
  });

  it('ignores default patterns like node_modules', async () => {
    mkdirSync(join(TEST_BASE, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(TEST_BASE, 'node_modules', 'pkg', 'index.js'), '');
    writeFileSync(join(TEST_BASE, 'src.ts'), '');
    mkdirSync(join(TEST_BASE, 'src'), { recursive: true });
    writeFileSync(join(TEST_BASE, 'src', 'app.ts'), '');

    const result = await glob('**/*.ts', { cwd: TEST_BASE });
    // node_modules should be ignored
    expect(result.matches.every((m) => !m.relativePath.includes('node_modules'))).toBe(true);
  });

  it('custom ignore patterns', async () => {
    setupTree();
    const result = await glob('**/*', {
      cwd: TEST_BASE,
      ignore: ['docs/**'],
      filesOnly: true,
    });
    expect(result.matches.every((m) => !m.relativePath.includes('docs'))).toBe(true);
  });

  it('hides hidden files by default', async () => {
    mkdirSync(TEST_BASE, { recursive: true });
    writeFileSync(join(TEST_BASE, '.hidden'), 'secret');
    writeFileSync(join(TEST_BASE, 'visible'), 'public');

    const result = await glob('*', { cwd: TEST_BASE });
    expect(result.matches.some((m) => m.relativePath === '.hidden')).toBe(false);
    expect(result.matches.some((m) => m.relativePath === 'visible')).toBe(true);
  });

  it('shows hidden files with dot=true', async () => {
    mkdirSync(TEST_BASE, { recursive: true });
    writeFileSync(join(TEST_BASE, '.hidden'), 'secret');

    const result = await glob('*', { cwd: TEST_BASE, dot: true });
    expect(result.matches.some((m) => m.relativePath === '.hidden')).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// glob — errors
// ═══════════════════════════════════════════════════════════════════════════════

describe('glob — errors', () => {
  it('returns empty matches for nonexistent cwd', async () => {
    const result = await glob('*.ts', { cwd: join(TEST_BASE, 'nonexistent') });
    expect(result.success).toBe(true);
    expect(result.matches).toHaveLength(0);
  });
});

