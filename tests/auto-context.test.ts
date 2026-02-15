import { describe, expect, it } from 'vitest';

import { rankFileRelevance } from '../src/coding/context-manager/auto-context.js';
import type { RepoMap } from '../src/coding/repo-map/types.js';

// ─── Test helpers ────────────────────────────────────────────────────────────

function makeRepoMap(files: Array<{ path: string; importance: number; symbols?: Array<{ name: string }> }>): RepoMap {
  return {
    rootPath: '/project',
    generatedAt: new Date().toISOString(),
    totalTokens: 1000,
    files: files.map((f) => ({
      path: f.path,
      importance: f.importance,
      tokens: 50,
      symbols: (f.symbols ?? []).map((s) => ({
        name: s.name,
        kind: 'function' as const,
        signature: `function ${s.name}()`,
        line: 1,
        exported: true,
      })),
      references: [],
    })),
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// rankFileRelevance — direct path mention
// ═══════════════════════════════════════════════════════════════════════════════

describe('rankFileRelevance — direct path mention', () => {
  it('gives highest score when full path is mentioned', () => {
    const score = rankFileRelevance('src/utils/helper.ts', 'Fix the bug in src/utils/helper.ts', null);
    expect(score).toBe(1);
  });

  it('gives full score for case-insensitive path match', () => {
    const score = rankFileRelevance('src/Utils/Helper.ts', 'fix the bug in src/utils/helper.ts', null);
    expect(score).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// rankFileRelevance — basename mention
// ═══════════════════════════════════════════════════════════════════════════════

describe('rankFileRelevance — basename mention', () => {
  it('scores when basename (no extension) is mentioned', () => {
    const score = rankFileRelevance('src/router/classifier.ts', 'update the classifier logic', null);
    expect(score).toBeGreaterThanOrEqual(0.5);
  });

  it('does not score for unrelated names', () => {
    const score = rankFileRelevance('src/utils/math.ts', 'update the classifier logic', null);
    expect(score).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// rankFileRelevance — directory mention
// ═══════════════════════════════════════════════════════════════════════════════

describe('rankFileRelevance — directory mention', () => {
  it('scores when directory part is mentioned', () => {
    const score = rankFileRelevance('src/scheduler/cron.ts', 'fix the scheduler module', null);
    expect(score).toBeGreaterThan(0);
  });

  it('accumulates for multiple directory matches', () => {
    const score = rankFileRelevance(
      'src/tools/schemas/types.ts',
      'update the tools schemas for the new types',
      null
    );
    // Should match 'tools' and 'schemas' and 'types' (basename)
    expect(score).toBeGreaterThan(0.4);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// rankFileRelevance — repo map importance
// ═══════════════════════════════════════════════════════════════════════════════

describe('rankFileRelevance — repo map importance', () => {
  it('adds importance score from repo map', () => {
    const repoMap = makeRepoMap([{ path: 'src/index.ts', importance: 0.8 }]);

    const withMap = rankFileRelevance('src/index.ts', 'check the entry point', repoMap);
    const withoutMap = rankFileRelevance('src/index.ts', 'check the entry point', null);

    expect(withMap).toBeGreaterThan(withoutMap);
  });

  it('uses 0.3 * importance factor', () => {
    const repoMap = makeRepoMap([{ path: 'src/unknown.ts', importance: 1.0 }]);

    // No task text match — just importance
    const score = rankFileRelevance('src/unknown.ts', 'unrelated task about fish', repoMap);
    expect(score).toBeCloseTo(0.3, 1);
  });

  it('ignores repo map when null', () => {
    const score = rankFileRelevance('src/thing.ts', 'unrelated', null);
    expect(score).toBe(0);
  });

  it('ignores repo map when file not in map', () => {
    const repoMap = makeRepoMap([{ path: 'src/other.ts', importance: 1.0 }]);
    const score = rankFileRelevance('src/missing.ts', 'unrelated', repoMap);
    expect(score).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// rankFileRelevance — combined scoring
// ═══════════════════════════════════════════════════════════════════════════════

describe('rankFileRelevance — combined', () => {
  it('caps total score at 1', () => {
    const repoMap = makeRepoMap([{ path: 'src/router/classifier.ts', importance: 1.0 }]);

    // Path match (1.0) + basename match (0.5) + dir matches + importance = way over 1
    const score = rankFileRelevance(
      'src/router/classifier.ts',
      'fix the src/router/classifier.ts classifier in the router',
      repoMap
    );
    expect(score).toBeLessThanOrEqual(1);
  });

  it('returns 0 for no matches', () => {
    const score = rankFileRelevance('src/deep/nested/file.ts', 'hello world', null);
    expect(score).toBe(0);
  });
});
