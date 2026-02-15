import { describe, expect, it } from 'vitest';

import {
  computePageRank,
  computeImportance,
  getTopFiles,
} from '../src/coding/repo-map/pagerank.js';

// ═══════════════════════════════════════════════════════════════════════════════
// computePageRank
// ═══════════════════════════════════════════════════════════════════════════════

describe('computePageRank', () => {
  it('returns empty map for empty graph', () => {
    const result = computePageRank(new Map());
    expect(result.size).toBe(0);
  });

  it('handles single node with no links', () => {
    const graph = new Map([['a.ts', new Set<string>()]]);
    const result = computePageRank(graph);
    expect(result.size).toBe(1);
    expect(result.get('a.ts')).toBe(1); // Normalized max = 1
  });

  it('gives higher score to heavily-imported file', () => {
    // b.ts and c.ts both import a.ts, but nobody imports b.ts or c.ts
    const graph = new Map<string, Set<string>>([
      ['a.ts', new Set<string>()],
      ['b.ts', new Set(['a.ts'])],
      ['c.ts', new Set(['a.ts'])],
    ]);
    const result = computePageRank(graph);

    expect(result.get('a.ts')).toBeDefined();
    expect(result.get('b.ts')).toBeDefined();
    expect(result.get('a.ts')!).toBeGreaterThan(result.get('b.ts')!);
  });

  it('distributes scores across chain', () => {
    // a → b → c (chain)
    const graph = new Map<string, Set<string>>([
      ['a.ts', new Set(['b.ts'])],
      ['b.ts', new Set(['c.ts'])],
      ['c.ts', new Set<string>()],
    ]);
    const result = computePageRank(graph);

    // c.ts is imported by b.ts, b.ts is imported by a.ts
    // c.ts should have highest score since it's the most "depended on"
    expect(result.get('c.ts')!).toBeGreaterThan(result.get('a.ts')!);
  });

  it('handles circular references', () => {
    // a → b → c → a (cycle)
    const graph = new Map<string, Set<string>>([
      ['a.ts', new Set(['b.ts'])],
      ['b.ts', new Set(['c.ts'])],
      ['c.ts', new Set(['a.ts'])],
    ]);
    const result = computePageRank(graph);

    // All should have similar scores in a cycle
    const scores = [result.get('a.ts')!, result.get('b.ts')!, result.get('c.ts')!];
    const maxDiff = Math.max(...scores) - Math.min(...scores);
    expect(maxDiff).toBeLessThan(0.1);
  });

  it('normalizes scores to 0-1 range', () => {
    const graph = new Map<string, Set<string>>([
      ['a.ts', new Set<string>()],
      ['b.ts', new Set(['a.ts'])],
      ['c.ts', new Set(['a.ts'])],
      ['d.ts', new Set(['b.ts'])],
    ]);
    const result = computePageRank(graph);

    for (const score of result.values()) {
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
    }

    // At least one should be 1 (the max)
    const maxScore = Math.max(...result.values());
    expect(maxScore).toBe(1);
  });

  it('ignores links to nodes not in the graph', () => {
    const graph = new Map<string, Set<string>>([
      ['a.ts', new Set(['external.ts'])], // external.ts not in graph
      ['b.ts', new Set(['a.ts'])],
    ]);
    const result = computePageRank(graph);
    expect(result.size).toBe(2);
    expect(result.has('external.ts')).toBe(false);
  });

  it('respects custom damping factor', () => {
    const graph = new Map<string, Set<string>>([
      ['a.ts', new Set<string>()],
      ['b.ts', new Set(['a.ts'])],
    ]);

    const highDamping = computePageRank(graph, { dampingFactor: 0.99 });
    const lowDamping = computePageRank(graph, { dampingFactor: 0.5 });

    // With higher damping, the difference between scores should be more pronounced
    const highDiff = highDamping.get('a.ts')! - highDamping.get('b.ts')!;
    const lowDiff = lowDamping.get('a.ts')! - lowDamping.get('b.ts')!;
    expect(highDiff).toBeGreaterThanOrEqual(lowDiff);
  });

  it('converges within maxIterations', () => {
    const graph = new Map<string, Set<string>>([
      ['a.ts', new Set(['b.ts'])],
      ['b.ts', new Set(['a.ts'])],
    ]);
    // With just 1 iteration, should still produce valid scores
    const result = computePageRank(graph, { maxIterations: 1 });
    expect(result.size).toBe(2);
    for (const score of result.values()) {
      expect(score).toBeGreaterThanOrEqual(0);
    }
  });

  it('handles star topology (hub and spokes)', () => {
    // hub.ts is imported by all spokes
    const graph = new Map<string, Set<string>>([
      ['hub.ts', new Set<string>()],
      ['spoke1.ts', new Set(['hub.ts'])],
      ['spoke2.ts', new Set(['hub.ts'])],
      ['spoke3.ts', new Set(['hub.ts'])],
      ['spoke4.ts', new Set(['hub.ts'])],
    ]);
    const result = computePageRank(graph);

    // Hub should have the highest score
    expect(result.get('hub.ts')).toBe(1);
    // All spokes should have equal, lower scores
    const spokeScores = ['spoke1.ts', 'spoke2.ts', 'spoke3.ts', 'spoke4.ts'].map(
      (s) => result.get(s)!,
    );
    const maxSpokeDiff = Math.max(...spokeScores) - Math.min(...spokeScores);
    expect(maxSpokeDiff).toBeLessThan(0.01);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// computeImportance
// ═══════════════════════════════════════════════════════════════════════════════

describe('computeImportance', () => {
  it('boosts entry point files', () => {
    // Use a graph where utils has a higher base score than index,
    // then entry point boost should push index even higher
    const graph = new Map<string, Set<string>>([
      ['src/index.ts', new Set<string>()],
      ['src/utils.ts', new Set<string>()],
      ['src/helper.ts', new Set(['src/utils.ts'])],
    ]);
    const result = computeImportance(graph);

    // index.ts should get boosted even though utils.ts has more in-links
    // The boost of 0.2 on the normalized 0-1 range should matter
    expect(result.get('src/index.ts')).toBeDefined();
    // Entry point boost applies to index.ts
    const indexScore = result.get('src/index.ts')!;
    const helperScore = result.get('src/helper.ts')!;
    expect(indexScore).toBeGreaterThan(helperScore);
  });

  it('recognizes multiple entry point patterns', () => {
    // Create a graph where entry points and helper all have the same base score,
    // but a non-entry node (helper) imports something to change relative scores
    const graph = new Map<string, Set<string>>([
      ['main.ts', new Set(['helper.ts'])],
      ['app.tsx', new Set(['helper.ts'])],
      ['mod.js', new Set(['helper.ts'])],
      ['lib.ts', new Set(['helper.ts'])],
      ['helper.ts', new Set<string>()],
      ['other.ts', new Set<string>()],
    ]);
    const result = computeImportance(graph);

    // Entry points should be boosted above "other.ts" (which has no boost and no in-links)
    expect(result.get('main.ts')!).toBeGreaterThan(result.get('other.ts')!);
    expect(result.get('app.tsx')!).toBeGreaterThan(result.get('other.ts')!);
    expect(result.get('mod.js')!).toBeGreaterThan(result.get('other.ts')!);
    expect(result.get('lib.ts')!).toBeGreaterThan(result.get('other.ts')!);
  });

  it('caps boosted score at 1', () => {
    const graph = new Map<string, Set<string>>([
      ['index.ts', new Set<string>()],
    ]);
    const result = computeImportance(graph);
    expect(result.get('index.ts')!).toBeLessThanOrEqual(1);
  });

  it('respects custom entryPointBoost', () => {
    const graph = new Map<string, Set<string>>([
      ['index.ts', new Set<string>()],
      ['other.ts', new Set<string>()],
    ]);
    const noBoost = computeImportance(graph, { entryPointBoost: 0 });
    // With zero boost, index and other should be equal
    expect(Math.abs(noBoost.get('index.ts')! - noBoost.get('other.ts')!)).toBeLessThan(0.01);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// getTopFiles
// ═══════════════════════════════════════════════════════════════════════════════

describe('getTopFiles', () => {
  it('returns top N files sorted by score', () => {
    const scores = new Map<string, number>([
      ['a.ts', 0.3],
      ['b.ts', 0.9],
      ['c.ts', 0.6],
      ['d.ts', 0.1],
    ]);
    const top = getTopFiles(scores, 2);
    expect(top).toHaveLength(2);
    expect(top[0]!.path).toBe('b.ts');
    expect(top[0]!.score).toBe(0.9);
    expect(top[1]!.path).toBe('c.ts');
    expect(top[1]!.score).toBe(0.6);
  });

  it('returns all files when N exceeds count', () => {
    const scores = new Map<string, number>([
      ['a.ts', 0.5],
      ['b.ts', 0.3],
    ]);
    const top = getTopFiles(scores, 10);
    expect(top).toHaveLength(2);
  });

  it('returns empty array for empty scores', () => {
    const top = getTopFiles(new Map(), 5);
    expect(top).toEqual([]);
  });

  it('returns files with correct shape', () => {
    const scores = new Map<string, number>([['test.ts', 0.42]]);
    const top = getTopFiles(scores, 1);
    expect(top[0]).toEqual({ path: 'test.ts', score: 0.42 });
  });
});
