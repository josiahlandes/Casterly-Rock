import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { GraphMemory, createGraphMemory } from '../src/autonomous/memory/graph-memory.js';
import { resetTracer, initTracer } from '../src/autonomous/debug.js';

let tempDir: string;

beforeEach(async () => {
  resetTracer();
  initTracer({ enabled: false });
  tempDir = await mkdtemp(join(tmpdir(), 'casterly-graph-test-'));
});

afterEach(async () => {
  resetTracer();
  await rm(tempDir, { recursive: true, force: true });
});

function makeGraph(): GraphMemory {
  return createGraphMemory({ path: join(tempDir, 'graph.json') });
}

describe('GraphMemory', () => {
  describe('addNode', () => {
    it('adds a new node', () => {
      const g = makeGraph();
      const node = g.addNode({ label: 'journal.ts', type: 'file' });

      expect(node.id).toBe('file:journal-ts');
      expect(node.mentionCount).toBe(1);
      expect(g.nodeCount()).toBe(1);
    });

    it('increments mention count for existing nodes', () => {
      const g = makeGraph();
      g.addNode({ label: 'journal.ts', type: 'file' });
      const updated = g.addNode({ label: 'journal.ts', type: 'file' });

      expect(updated.mentionCount).toBe(2);
      expect(g.nodeCount()).toBe(1);
    });

    it('tracks memory IDs', () => {
      const g = makeGraph();
      g.addNode({ label: 'journal.ts', type: 'file', memoryId: 'crystal-1' });
      const node = g.addNode({ label: 'journal.ts', type: 'file', memoryId: 'journal-2' });

      expect(node.memoryIds).toContain('crystal-1');
      expect(node.memoryIds).toContain('journal-2');
    });
  });

  describe('addEdge', () => {
    it('creates an edge between nodes', () => {
      const g = makeGraph();
      g.addNode({ label: 'journal.ts', type: 'file' });
      g.addNode({ label: 'debug.ts', type: 'file' });

      const result = g.addEdge({
        sourceId: 'file:journal-ts',
        targetId: 'file:debug-ts',
        type: 'depends_on',
      });

      expect(result).toBe(true);
      expect(g.edgeCount()).toBe(1);
    });

    it('strengthens existing edges', () => {
      const g = makeGraph();
      g.addNode({ label: 'a', type: 'file' });
      g.addNode({ label: 'b', type: 'file' });

      g.addEdge({ sourceId: 'file:a', targetId: 'file:b', type: 'depends_on', weight: 0.5 });
      g.addEdge({ sourceId: 'file:a', targetId: 'file:b', type: 'depends_on' });

      const edges = g.getEdgesForNode('file:a');
      expect(edges).toHaveLength(1);
      expect(edges[0]!.weight).toBeGreaterThan(0.5);
    });

    it('prevents self-edges', () => {
      const g = makeGraph();
      g.addNode({ label: 'a', type: 'file' });
      const result = g.addEdge({ sourceId: 'file:a', targetId: 'file:a', type: 'related_to' });
      expect(result).toBe(false);
    });

    it('returns false for non-existent nodes', () => {
      const g = makeGraph();
      const result = g.addEdge({ sourceId: 'file:x', targetId: 'file:y', type: 'depends_on' });
      expect(result).toBe(false);
    });
  });

  describe('getNeighbors', () => {
    it('returns directly connected nodes', () => {
      const g = makeGraph();
      g.addNode({ label: 'a', type: 'file' });
      g.addNode({ label: 'b', type: 'file' });
      g.addNode({ label: 'c', type: 'file' });

      g.addEdge({ sourceId: 'file:a', targetId: 'file:b', type: 'depends_on' });
      g.addEdge({ sourceId: 'file:c', targetId: 'file:a', type: 'uses' });

      const neighbors = g.getNeighbors('file:a');
      expect(neighbors.map((n) => n.id)).toContain('file:b');
      expect(neighbors.map((n) => n.id)).toContain('file:c');
    });
  });

  describe('shortestPath', () => {
    it('finds the shortest path between nodes', () => {
      const g = makeGraph();
      g.addNode({ label: 'a', type: 'file' });
      g.addNode({ label: 'b', type: 'file' });
      g.addNode({ label: 'c', type: 'file' });
      g.addNode({ label: 'd', type: 'file' });

      g.addEdge({ sourceId: 'file:a', targetId: 'file:b', type: 'depends_on' });
      g.addEdge({ sourceId: 'file:b', targetId: 'file:c', type: 'depends_on' });
      g.addEdge({ sourceId: 'file:c', targetId: 'file:d', type: 'depends_on' });

      const path = g.shortestPath('file:a', 'file:d');
      expect(path).toEqual(['file:a', 'file:b', 'file:c', 'file:d']);
    });

    it('returns null when no path exists', () => {
      const g = makeGraph();
      g.addNode({ label: 'a', type: 'file' });
      g.addNode({ label: 'b', type: 'file' });

      const path = g.shortestPath('file:a', 'file:b');
      expect(path).toBeNull();
    });

    it('returns single node for same source and target', () => {
      const g = makeGraph();
      g.addNode({ label: 'a', type: 'file' });
      expect(g.shortestPath('file:a', 'file:a')).toEqual(['file:a']);
    });
  });

  describe('getConnectedComponents', () => {
    it('finds separate clusters', () => {
      const g = makeGraph();
      g.addNode({ label: 'a', type: 'file' });
      g.addNode({ label: 'b', type: 'file' });
      g.addNode({ label: 'c', type: 'file' });
      g.addNode({ label: 'd', type: 'file' });

      g.addEdge({ sourceId: 'file:a', targetId: 'file:b', type: 'depends_on' });
      g.addEdge({ sourceId: 'file:c', targetId: 'file:d', type: 'depends_on' });

      const components = g.getConnectedComponents();
      expect(components).toHaveLength(2);
      expect(components[0]).toHaveLength(2);
    });
  });

  describe('searchNodes', () => {
    it('finds nodes by label substring', () => {
      const g = makeGraph();
      g.addNode({ label: 'journal.ts', type: 'file' });
      g.addNode({ label: 'world-model.ts', type: 'file' });
      g.addNode({ label: 'testing', type: 'concept' });

      const results = g.searchNodes('journal');
      expect(results).toHaveLength(1);
      expect(results[0]!.label).toBe('journal.ts');
    });
  });

  describe('removeNode', () => {
    it('removes a node and its edges', () => {
      const g = makeGraph();
      g.addNode({ label: 'a', type: 'file' });
      g.addNode({ label: 'b', type: 'file' });
      g.addNode({ label: 'c', type: 'file' });

      g.addEdge({ sourceId: 'file:a', targetId: 'file:b', type: 'depends_on' });
      g.addEdge({ sourceId: 'file:a', targetId: 'file:c', type: 'depends_on' });

      g.removeNode('file:a');
      expect(g.nodeCount()).toBe(2);
      expect(g.edgeCount()).toBe(0);
    });
  });

  describe('persistence', () => {
    it('saves and loads the graph', async () => {
      const g1 = makeGraph();
      g1.addNode({ label: 'journal.ts', type: 'file' });
      g1.addNode({ label: 'testing', type: 'concept' });
      g1.addEdge({ sourceId: 'file:journal-ts', targetId: 'concept:testing', type: 'related_to' });
      await g1.save();

      const g2 = makeGraph();
      await g2.load();
      expect(g2.nodeCount()).toBe(2);
      expect(g2.edgeCount()).toBe(1);
    });
  });
});
