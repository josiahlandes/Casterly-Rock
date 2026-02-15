import { describe, expect, it, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import { tmpdir } from 'os';

import { buildRepoMap, formatRepoMap, getRepoMapSummary, updateRepoMap } from '../src/coding/repo-map/builder.js';
import type { RepoMap, FileMap, Symbol, Language } from '../src/coding/repo-map/types.js';
import { DEFAULT_CONFIG, EXTENSION_TO_LANGUAGE } from '../src/coding/repo-map/types.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeSymbol(overrides: Partial<Symbol> = {}): Symbol {
  return {
    name: 'foo',
    kind: 'function',
    signature: 'function foo(): void',
    line: 1,
    exported: true,
    ...overrides,
  };
}

function makeFileMap(overrides: Partial<FileMap> = {}): FileMap {
  return {
    path: 'src/utils.ts',
    symbols: [makeSymbol()],
    references: [],
    importance: 0.5,
    tokens: 10,
    ...overrides,
  };
}

function makeRepoMap(overrides: Partial<RepoMap> = {}): RepoMap {
  return {
    files: [makeFileMap()],
    totalTokens: 10,
    generatedAt: '2025-01-15T10:00:00.000Z',
    rootPath: '/home/project',
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// formatRepoMap
// ═══════════════════════════════════════════════════════════════════════════════

describe('formatRepoMap', () => {
  it('returns placeholder for empty repo map', () => {
    const map = makeRepoMap({ files: [], totalTokens: 0 });
    const result = formatRepoMap(map);
    expect(result).toBe('(no files in repo map)');
  });

  it('formats single file with symbols', () => {
    const map = makeRepoMap({
      files: [
        makeFileMap({
          path: 'src/index.ts',
          symbols: [
            makeSymbol({ name: 'main', signature: 'function main(): void', exported: true }),
          ],
          references: [],
        }),
      ],
    });
    const result = formatRepoMap(map);
    expect(result).toContain('src/index.ts:');
    expect(result).toContain('function main(): void');
  });

  it('includes references section', () => {
    const map = makeRepoMap({
      files: [
        makeFileMap({
          path: 'src/app.ts',
          references: ['src/utils.ts', 'src/config.ts'],
        }),
      ],
    });
    const result = formatRepoMap(map);
    expect(result).toContain('references:');
    expect(result).toContain('src/utils.ts');
    expect(result).toContain('src/config.ts');
  });

  it('formats multiple files', () => {
    const map = makeRepoMap({
      files: [
        makeFileMap({ path: 'src/a.ts', tokens: 5 }),
        makeFileMap({ path: 'src/b.ts', tokens: 7 }),
      ],
      totalTokens: 12,
    });
    const result = formatRepoMap(map);
    expect(result).toContain('src/a.ts:');
    expect(result).toContain('src/b.ts:');
    expect(result).toContain('2 files');
    expect(result).toContain('12 tokens');
  });

  it('marks private symbols', () => {
    const map = makeRepoMap({
      files: [
        makeFileMap({
          symbols: [
            makeSymbol({ name: 'pub', exported: true }),
            makeSymbol({ name: 'priv', exported: false }),
          ],
        }),
      ],
    });
    const result = formatRepoMap(map);
    expect(result).toContain('(private)');
  });

  it('includes footer with file count and token count', () => {
    const map = makeRepoMap({
      files: [makeFileMap(), makeFileMap({ path: 'src/b.ts' })],
      totalTokens: 42,
    });
    const result = formatRepoMap(map);
    expect(result).toContain('--- 2 files, 42 tokens ---');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// getRepoMapSummary
// ═══════════════════════════════════════════════════════════════════════════════

describe('getRepoMapSummary', () => {
  it('returns correct counts for empty map', () => {
    const map = makeRepoMap({ files: [], totalTokens: 0 });
    const summary = getRepoMapSummary(map);
    expect(summary.fileCount).toBe(0);
    expect(summary.symbolCount).toBe(0);
    expect(summary.totalTokens).toBe(0);
    expect(summary.topFiles).toEqual([]);
  });

  it('counts files and symbols', () => {
    const map = makeRepoMap({
      files: [
        makeFileMap({
          path: 'a.ts',
          symbols: [makeSymbol(), makeSymbol({ name: 'bar' })],
        }),
        makeFileMap({
          path: 'b.ts',
          symbols: [makeSymbol({ name: 'baz' })],
        }),
      ],
      totalTokens: 30,
    });
    const summary = getRepoMapSummary(map);
    expect(summary.fileCount).toBe(2);
    expect(summary.symbolCount).toBe(3);
    expect(summary.totalTokens).toBe(30);
  });

  it('returns top 5 files', () => {
    const files = Array.from({ length: 8 }, (_, i) =>
      makeFileMap({ path: `src/file${i}.ts`, tokens: 5 })
    );
    const map = makeRepoMap({ files, totalTokens: 40 });
    const summary = getRepoMapSummary(map);
    expect(summary.topFiles.length).toBe(5);
    expect(summary.topFiles[0]).toBe('src/file0.ts');
  });

  it('returns fewer than 5 when map has fewer files', () => {
    const map = makeRepoMap({
      files: [makeFileMap({ path: 'only.ts' })],
    });
    const summary = getRepoMapSummary(map);
    expect(summary.topFiles.length).toBe(1);
    expect(summary.topFiles[0]).toBe('only.ts');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// DEFAULT_CONFIG
// ═══════════════════════════════════════════════════════════════════════════════

describe('DEFAULT_CONFIG', () => {
  it('has sensible token budget defaults', () => {
    expect(DEFAULT_CONFIG.tokenBudget).toBe(2048);
    expect(DEFAULT_CONFIG.tokenBudgetMax).toBe(8192);
  });

  it('includes TypeScript and JavaScript by default', () => {
    expect(DEFAULT_CONFIG.languages).toContain('typescript');
    expect(DEFAULT_CONFIG.languages).toContain('javascript');
  });

  it('excludes node_modules and dist', () => {
    expect(DEFAULT_CONFIG.excludePatterns).toContain('node_modules/**');
    expect(DEFAULT_CONFIG.excludePatterns).toContain('dist/**');
  });

  it('does not include private symbols by default', () => {
    expect(DEFAULT_CONFIG.includePrivate).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// EXTENSION_TO_LANGUAGE
// ═══════════════════════════════════════════════════════════════════════════════

describe('EXTENSION_TO_LANGUAGE', () => {
  it('maps .ts to typescript', () => {
    expect(EXTENSION_TO_LANGUAGE['.ts']).toBe('typescript');
  });

  it('maps .tsx to typescript', () => {
    expect(EXTENSION_TO_LANGUAGE['.tsx']).toBe('typescript');
  });

  it('maps .js to javascript', () => {
    expect(EXTENSION_TO_LANGUAGE['.js']).toBe('javascript');
  });

  it('maps .jsx to javascript', () => {
    expect(EXTENSION_TO_LANGUAGE['.jsx']).toBe('javascript');
  });

  it('maps .mjs and .cjs to javascript', () => {
    expect(EXTENSION_TO_LANGUAGE['.mjs']).toBe('javascript');
    expect(EXTENSION_TO_LANGUAGE['.cjs']).toBe('javascript');
  });

  it('maps .py to python', () => {
    expect(EXTENSION_TO_LANGUAGE['.py']).toBe('python');
  });

  it('maps .rs to rust', () => {
    expect(EXTENSION_TO_LANGUAGE['.rs']).toBe('rust');
  });

  it('maps .go to go', () => {
    expect(EXTENSION_TO_LANGUAGE['.go']).toBe('go');
  });

  it('maps C/C++ extensions', () => {
    expect(EXTENSION_TO_LANGUAGE['.c']).toBe('c');
    expect(EXTENSION_TO_LANGUAGE['.h']).toBe('c');
    expect(EXTENSION_TO_LANGUAGE['.cpp']).toBe('cpp');
    expect(EXTENSION_TO_LANGUAGE['.cc']).toBe('cpp');
    expect(EXTENSION_TO_LANGUAGE['.cxx']).toBe('cpp');
    expect(EXTENSION_TO_LANGUAGE['.hpp']).toBe('cpp');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// buildRepoMap + updateRepoMap (integration with real files)
// ═══════════════════════════════════════════════════════════════════════════════

describe('buildRepoMap — integration', () => {
  const tempDir = path.join(tmpdir(), `repo-map-test-${Date.now()}`);

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  async function setupRepo(files: Record<string, string>): Promise<void> {
    for (const [filePath, content] of Object.entries(files)) {
      const fullPath = path.join(tempDir, filePath);
      await fs.mkdir(path.dirname(fullPath), { recursive: true });
      await fs.writeFile(fullPath, content, 'utf-8');
    }
  }

  it('builds a map for a TypeScript project', async () => {
    await setupRepo({
      'src/index.ts': 'export function main(): void {}\n',
      'src/utils.ts': 'export function helper(): string { return ""; }\n',
    });

    const map = await buildRepoMap({
      rootPath: tempDir,
      tokenBudget: 4096,
      languages: ['typescript'],
      includePatterns: ['**/*.ts'],
      excludePatterns: ['node_modules/**'],
    });

    expect(map.files.length).toBe(2);
    expect(map.files.some((f) => f.path.includes('index.ts'))).toBe(true);
    expect(map.files.some((f) => f.path.includes('utils.ts'))).toBe(true);
  });

  it('builds a map for Python files', async () => {
    await setupRepo({
      'app.py': 'def main():\n    pass\n\nclass App:\n    pass\n',
    });

    const map = await buildRepoMap({
      rootPath: tempDir,
      tokenBudget: 4096,
      languages: ['python'],
      includePatterns: ['**/*.py'],
      excludePatterns: [],
    });

    expect(map.files.length).toBe(1);
    const file = map.files[0];
    const names = file?.symbols.map((s) => s.name) ?? [];
    expect(names).toContain('main');
    expect(names).toContain('App');
  });

  it('returns empty map for empty directory', async () => {
    await fs.mkdir(tempDir, { recursive: true });
    const map = await buildRepoMap({
      rootPath: tempDir,
      tokenBudget: 4096,
    });
    expect(map.files).toHaveLength(0);
    expect(map.totalTokens).toBe(0);
  });
});

describe('updateRepoMap — incremental', () => {
  const tempDir = path.join(tmpdir(), `repo-map-update-${Date.now()}`);

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  async function setupRepo(files: Record<string, string>): Promise<void> {
    for (const [filePath, content] of Object.entries(files)) {
      const fullPath = path.join(tempDir, filePath);
      await fs.mkdir(path.dirname(fullPath), { recursive: true });
      await fs.writeFile(fullPath, content, 'utf-8');
    }
  }

  it('incrementally updates only changed files', async () => {
    await setupRepo({
      'src/a.ts': 'export function alpha(): void {}\n',
      'src/b.ts': 'export function beta(): void {}\n',
    });

    const config = {
      rootPath: tempDir,
      tokenBudget: 4096,
      languages: ['typescript'] as Language[],
      includePatterns: ['**/*.ts'],
      excludePatterns: [] as string[],
    };

    // Build initial map
    const initial = await buildRepoMap(config);
    expect(initial.files.length).toBe(2);

    // Modify b.ts
    await fs.writeFile(
      path.join(tempDir, 'src/b.ts'),
      'export function betaRenamed(): void {}\nexport function extra(): void {}\n',
      'utf-8',
    );

    // Incremental update
    const updated = await updateRepoMap(initial, ['src/b.ts'], config);

    // a.ts should be preserved, b.ts should be re-parsed
    expect(updated.files.length).toBe(2);
    const bFile = updated.files.find((f) => f.path.includes('b.ts'));
    const bNames = bFile?.symbols.map((s) => s.name) ?? [];
    expect(bNames).toContain('betaRenamed');
    expect(bNames).toContain('extra');
    expect(bNames).not.toContain('beta');
  });

  it('falls back to full rebuild when too many files changed', async () => {
    await setupRepo({
      'src/a.ts': 'export function a(): void {}\n',
      'src/b.ts': 'export function b(): void {}\n',
      'src/c.ts': 'export function c(): void {}\n',
    });

    const config = {
      rootPath: tempDir,
      tokenBudget: 4096,
      languages: ['typescript'] as Language[],
      includePatterns: ['**/*.ts'],
      excludePatterns: [] as string[],
    };

    const initial = await buildRepoMap(config);

    // Change all 3 files (> 30% threshold = full rebuild)
    const updated = await updateRepoMap(initial, ['src/a.ts', 'src/b.ts', 'src/c.ts'], config);
    expect(updated.files.length).toBe(3);
  });

  it('handles deleted files gracefully', async () => {
    await setupRepo({
      'src/a.ts': 'export function a(): void {}\n',
      'src/b.ts': 'export function b(): void {}\n',
    });

    const config = {
      rootPath: tempDir,
      tokenBudget: 4096,
      languages: ['typescript'] as Language[],
      includePatterns: ['**/*.ts'],
      excludePatterns: [] as string[],
    };

    const initial = await buildRepoMap(config);

    // Delete b.ts
    await fs.unlink(path.join(tempDir, 'src/b.ts'));

    // b.ts is in changedFiles but file doesn't exist — should be dropped
    const updated = await updateRepoMap(initial, ['src/b.ts'], config);
    expect(updated.files.length).toBe(1);
    expect(updated.files[0]?.path).toContain('a.ts');
  });
});
