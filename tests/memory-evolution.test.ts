import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { MemoryEvolution, createMemoryEvolution } from '../src/autonomous/memory/memory-evolution.js';
import type { EvolvableMemory } from '../src/autonomous/memory/memory-evolution.js';
import { resetTracer, initTracer } from '../src/autonomous/debug.js';

let tempDir: string;

beforeEach(async () => {
  resetTracer();
  initTracer({ enabled: false });
  tempDir = await mkdtemp(join(tmpdir(), 'casterly-evolution-test-'));
});

afterEach(async () => {
  resetTracer();
  await rm(tempDir, { recursive: true, force: true });
});

function makeEvolution(): MemoryEvolution {
  return createMemoryEvolution({ logPath: join(tempDir, 'evolution.json') });
}

function makeMemory(overrides: Partial<EvolvableMemory> = {}): EvolvableMemory {
  const now = new Date().toISOString();
  return {
    id: `mem-${Math.random().toString(36).substring(2, 8)}`,
    content: 'Test memory content',
    confidence: 0.7,
    generation: 0,
    parentIds: [],
    tags: ['test'],
    createdAt: now,
    lastEvolvedAt: now,
    ...overrides,
  };
}

describe('MemoryEvolution', () => {
  describe('strengthen', () => {
    it('increases confidence', () => {
      const evo = makeEvolution();
      const mem = makeMemory({ confidence: 0.7 });
      const result = evo.strengthen(mem, 'corroborated by new evidence');

      expect(result.confidence).toBeCloseTo(0.8);
      expect(evo.eventCount()).toBe(1);
    });

    it('caps confidence at 1.0', () => {
      const evo = makeEvolution();
      const mem = makeMemory({ confidence: 0.95 });
      const result = evo.strengthen(mem, 'more evidence');

      expect(result.confidence).toBe(1.0);
    });
  });

  describe('weaken', () => {
    it('decreases confidence', () => {
      const evo = makeEvolution();
      const mem = makeMemory({ confidence: 0.7 });
      const result = evo.weaken(mem, 'contradicted by new data');

      expect(result.confidence).toBeCloseTo(0.55);
    });

    it('floors confidence at 0', () => {
      const evo = makeEvolution();
      const mem = makeMemory({ confidence: 0.1 });
      const result = evo.weaken(mem, 'strongly contradicted');

      expect(result.confidence).toBe(0);
    });
  });

  describe('merge', () => {
    it('creates a new memory from two sources', () => {
      const evo = makeEvolution();
      const memA = makeMemory({ tags: ['typescript'] });
      const memB = makeMemory({ tags: ['testing'] });

      const merged = evo.merge(memA, memB, 'Combined insight about TypeScript testing', 'overlap detected');

      expect(merged.id).toMatch(/^emem-/);
      expect(merged.parentIds).toContain(memA.id);
      expect(merged.parentIds).toContain(memB.id);
      expect(merged.generation).toBe(1);
      expect(merged.tags).toContain('typescript');
      expect(merged.tags).toContain('testing');
      expect(evo.eventCount()).toBe(1);
    });
  });

  describe('split', () => {
    it('creates multiple memories from one source', () => {
      const evo = makeEvolution();
      const mem = makeMemory({ generation: 2 });

      const parts = evo.split(mem, ['Part A', 'Part B', 'Part C'], 'decomposing complex memory');

      expect(parts).toHaveLength(3);
      expect(parts[0]!.content).toBe('Part A');
      expect(parts[0]!.parentIds).toContain(mem.id);
      expect(parts[0]!.generation).toBe(3);
    });
  });

  describe('generalize', () => {
    it('creates a broader memory with slightly less confidence', () => {
      const evo = makeEvolution();
      const mem = makeMemory({ confidence: 0.8 });
      const general = evo.generalize(mem, 'General principle about testing', 'pattern observed multiple times');

      expect(general.confidence).toBeCloseTo(0.72);
      expect(general.tags).toContain('generalized');
      expect(general.parentIds).toContain(mem.id);
    });
  });

  describe('specialize', () => {
    it('creates a narrower memory preserving confidence', () => {
      const evo = makeEvolution();
      const mem = makeMemory({ confidence: 0.8 });
      const special = evo.specialize(mem, 'Specific case for unit tests', 'applies to unit test context only');

      expect(special.confidence).toBe(0.8);
      expect(special.tags).toContain('specialized');
    });
  });

  describe('getLineage', () => {
    it('returns all events involving a memory', () => {
      const evo = makeEvolution();
      const mem = makeMemory();
      evo.strengthen(mem, 'first');
      evo.weaken(mem, 'second');

      const lineage = evo.getLineage(mem.id);
      expect(lineage).toHaveLength(2);
    });
  });

  describe('persistence', () => {
    it('saves and loads evolution log', async () => {
      const evo1 = makeEvolution();
      evo1.strengthen(makeMemory(), 'test');
      await evo1.save();

      const evo2 = makeEvolution();
      await evo2.load();
      expect(evo2.eventCount()).toBe(1);
    });
  });
});
