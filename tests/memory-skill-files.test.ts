import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { SkillFilesManager, createSkillFilesManager } from '../src/autonomous/memory/skill-files.js';
import { resetTracer, initTracer } from '../src/autonomous/debug.js';

let tempDir: string;

beforeEach(async () => {
  resetTracer();
  initTracer({ enabled: false });
  tempDir = await mkdtemp(join(tmpdir(), 'casterly-skills-test-'));
});

afterEach(async () => {
  resetTracer();
  await rm(tempDir, { recursive: true, force: true });
});

function makeManager(): SkillFilesManager {
  return createSkillFilesManager({ path: join(tempDir, 'skills.json') });
}

describe('SkillFilesManager', () => {
  describe('learn', () => {
    it('creates a new skill', () => {
      const mgr = makeManager();
      const result = mgr.learn({
        name: 'fix-typescript-errors',
        description: 'Fix TypeScript compilation errors',
        steps: ['Run typecheck', 'Read error output', 'Fix each error', 'Re-run typecheck'],
        tags: ['typescript', 'debugging'],
      });

      expect(result.success).toBe(true);
      expect(result.skillId).toMatch(/^skill-/);
      expect(mgr.count()).toBe(1);
    });

    it('prevents duplicate skill names', () => {
      const mgr = makeManager();
      mgr.learn({ name: 'fix-errors', description: 'Fix errors', steps: ['step1'] });
      const result = mgr.learn({ name: 'fix-errors', description: 'Another', steps: ['step2'] });

      expect(result.success).toBe(false);
      expect(result.error).toContain('already exists');
    });

    it('evicts least-used skill at capacity', () => {
      const mgr = createSkillFilesManager({
        path: join(tempDir, 'skills.json'),
        maxSkills: 2,
      });

      const s1 = mgr.learn({ name: 'skill-a', description: 'A', steps: ['a'] });
      mgr.learn({ name: 'skill-b', description: 'B', steps: ['b'] });
      mgr.recordUse(s1.skillId!, true); // skill-a has 1 use, skill-b has 0

      mgr.learn({ name: 'skill-c', description: 'C', steps: ['c'] });

      expect(mgr.count()).toBe(2);
      // skill-b (0 uses) should have been evicted
      expect(mgr.getByName('skill-b')).toBeUndefined();
    });
  });

  describe('refine', () => {
    it('updates skill steps and increments version', () => {
      const mgr = makeManager();
      const result = mgr.learn({ name: 'test-skill', description: 'Test', steps: ['old step'] });
      const refined = mgr.refine(result.skillId!, { steps: ['new step 1', 'new step 2'] });

      expect(refined.success).toBe(true);
      const skill = mgr.getById(result.skillId!);
      expect(skill!.steps).toEqual(['new step 1', 'new step 2']);
      expect(skill!.version).toBe(2);
    });
  });

  describe('recordUse', () => {
    it('tracks usage and updates mastery', () => {
      const mgr = makeManager();
      const result = mgr.learn({ name: 'test-skill', description: 'Test', steps: ['step'] });

      mgr.recordUse(result.skillId!, true);
      mgr.recordUse(result.skillId!, true);
      mgr.recordUse(result.skillId!, true);

      const skill = mgr.getById(result.skillId!)!;
      expect(skill.useCount).toBe(3);
      expect(skill.successCount).toBe(3);
      expect(skill.mastery).toBe('expert'); // 3 uses, 100% success
    });

    it('sets competent mastery with mixed results', () => {
      const mgr = makeManager();
      const result = mgr.learn({ name: 'test-skill', description: 'Test', steps: ['step'] });

      mgr.recordUse(result.skillId!, true);
      mgr.recordUse(result.skillId!, false);
      mgr.recordUse(result.skillId!, false);

      const skill = mgr.getById(result.skillId!)!;
      expect(skill.mastery).toBe('competent'); // 33% success, >= 3 uses
    });
  });

  describe('search', () => {
    it('finds skills by name, description, and tags', () => {
      const mgr = makeManager();
      mgr.learn({ name: 'fix-errors', description: 'Fix TypeScript errors', steps: ['a'], tags: ['typescript'] });
      mgr.learn({ name: 'run-tests', description: 'Run Vitest suite', steps: ['b'], tags: ['testing'] });

      expect(mgr.search('typescript')).toHaveLength(1);
      expect(mgr.search('vitest')).toHaveLength(1);
      expect(mgr.search('fix')).toHaveLength(1);
    });
  });

  describe('getSuccessRate', () => {
    it('returns correct success rate', () => {
      const mgr = makeManager();
      const result = mgr.learn({ name: 'test', description: 'Test', steps: ['a'] });
      mgr.recordUse(result.skillId!, true);
      mgr.recordUse(result.skillId!, false);

      expect(mgr.getSuccessRate(result.skillId!)).toBe(0.5);
    });

    it('returns null for unused skills', () => {
      const mgr = makeManager();
      const result = mgr.learn({ name: 'test', description: 'Test', steps: ['a'] });
      expect(mgr.getSuccessRate(result.skillId!)).toBeNull();
    });
  });

  describe('persistence', () => {
    it('saves and loads skills', async () => {
      const mgr1 = makeManager();
      mgr1.learn({ name: 'persistent-skill', description: 'Test', steps: ['step1'] });
      await mgr1.save();

      const mgr2 = makeManager();
      await mgr2.load();
      expect(mgr2.count()).toBe(1);
      expect(mgr2.getByName('persistent-skill')).toBeDefined();
    });
  });
});
