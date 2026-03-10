import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  PhaseProgressManager,
} from '../src/autonomous/dream/phase-progress.js';
import type {
  PhaseRegistration,
  PhaseContext,
} from '../src/autonomous/dream/phase-progress.js';

// Mock fs to prevent disk I/O
vi.mock('node:fs/promises', () => ({
  readFile: vi.fn().mockRejectedValue(new Error('ENOENT')),
  writeFile: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
}));

// Mock tracer
vi.mock('../src/autonomous/debug.js', () => ({
  getTracer: () => ({
    log: vi.fn(),
    withSpan: vi.fn(),
    withSpanSync: vi.fn(),
  }),
}));

describe('PhaseProgressManager', () => {
  let manager: PhaseProgressManager;

  beforeEach(async () => {
    manager = new PhaseProgressManager({
      defaultPhaseBudgetMs: 5000,
    });
    await manager.load();
  });

  describe('beginCycle()', () => {
    it('should initialize a new cycle with pending phases', () => {
      manager.beginCycle('2026-03-10', ['phase-a', 'phase-b', 'phase-c']);

      const state = manager.getState();
      expect(state).not.toBeNull();
      expect(state!.cycleId).toBe('2026-03-10');
      expect(state!.phases).toHaveLength(3);
      expect(state!.phases[0]!.status).toBe('pending');
      expect(state!.phases[0]!.progress).toBe(0);
      expect(state!.cycleComplete).toBe(false);
    });

    it('should resume an incomplete cycle with matching ID', () => {
      manager.beginCycle('2026-03-10', ['phase-a', 'phase-b']);

      // Simulate one phase completing
      const state = manager.getState()!;
      state.phases[0]!.status = 'completed';
      state.phases[0]!.progress = 1;

      // Begin again with same ID — should resume
      manager.beginCycle('2026-03-10', ['phase-a', 'phase-b']);

      expect(manager.getState()!.phases[0]!.status).toBe('completed');
      expect(manager.getState()!.phases[0]!.progress).toBe(1);
    });

    it('should start fresh with a different cycle ID', () => {
      manager.beginCycle('2026-03-10', ['phase-a']);
      const state = manager.getState()!;
      state.phases[0]!.status = 'completed';

      manager.beginCycle('2026-03-11', ['phase-a']);
      expect(manager.getState()!.phases[0]!.status).toBe('pending');
    });

    it('should add new phases when resuming', () => {
      manager.beginCycle('2026-03-10', ['phase-a']);
      manager.beginCycle('2026-03-10', ['phase-a', 'phase-b']);

      expect(manager.getState()!.phases).toHaveLength(2);
    });
  });

  describe('executePhases()', () => {
    it('should run all phases in order', async () => {
      manager.beginCycle('test-cycle', ['a', 'b']);

      const executed: string[] = [];
      const registrations: PhaseRegistration[] = [
        {
          name: 'a',
          executor: async (ctx) => {
            executed.push('a');
            ctx.reportProgress(1);
          },
        },
        {
          name: 'b',
          executor: async (ctx) => {
            executed.push('b');
            ctx.reportProgress(1);
          },
        },
      ];

      const summary = await manager.executePhases(registrations);

      expect(executed).toEqual(['a', 'b']);
      expect(summary.phasesCompleted).toEqual(['a', 'b']);
      expect(summary.phasesFailed).toEqual([]);
      expect(manager.getState()!.cycleComplete).toBe(true);
    });

    it('should skip completed phases', async () => {
      manager.beginCycle('test-cycle', ['a', 'b']);
      const state = manager.getState()!;
      state.phases[0]!.status = 'completed';
      state.phases[0]!.progress = 1;

      const executed: string[] = [];
      const registrations: PhaseRegistration[] = [
        { name: 'a', executor: async () => { executed.push('a'); } },
        { name: 'b', executor: async (ctx) => { executed.push('b'); ctx.reportProgress(1); } },
      ];

      const summary = await manager.executePhases(registrations);
      expect(executed).toEqual(['b']);
      expect(summary.phasesSkipped).toContain('a');
    });

    it('should handle phase failures without aborting', async () => {
      manager.beginCycle('test-cycle', ['a', 'b']);

      const registrations: PhaseRegistration[] = [
        {
          name: 'a',
          executor: async () => { throw new Error('phase-a-error'); },
        },
        {
          name: 'b',
          executor: async (ctx) => { ctx.reportProgress(1); },
        },
      ];

      const summary = await manager.executePhases(registrations);

      expect(summary.phasesFailed).toEqual(['a']);
      expect(summary.phasesCompleted).toEqual(['b']);
    });

    it('should provide checkpoint save/restore on resume', async () => {
      manager.beginCycle('test-cycle', ['a']);

      // First run: save a checkpoint and interrupt
      const state = manager.getState()!;
      state.phases[0]!.status = 'interrupted';
      state.phases[0]!.checkpoint = { step: 3, items: ['x', 'y'] };
      state.phases[0]!.progress = 0.5;

      let restoredCheckpoint: Record<string, unknown> | null = null;
      let wasResume = false;

      const registrations: PhaseRegistration[] = [
        {
          name: 'a',
          executor: async (ctx) => {
            restoredCheckpoint = ctx.getCheckpoint();
            wasResume = ctx.isResume;
            ctx.reportProgress(1);
          },
        },
      ];

      const summary = await manager.executePhases(registrations);

      expect(wasResume).toBe(true);
      expect(restoredCheckpoint).toEqual({ step: 3, items: ['x', 'y'] });
      expect(summary.phasesResumed).toContain('a');
    });

    it('should respect preemption', async () => {
      manager.beginCycle('test-cycle', ['a', 'b', 'c']);

      const executed: string[] = [];
      const registrations: PhaseRegistration[] = [
        {
          name: 'a',
          executor: async (ctx) => {
            executed.push('a');
            ctx.reportProgress(1);
            manager.preempt(); // Preempt after first phase
          },
        },
        { name: 'b', executor: async () => { executed.push('b'); } },
        { name: 'c', executor: async () => { executed.push('c'); } },
      ];

      await manager.executePhases(registrations);

      // Only 'a' should have run because preemption happened
      expect(executed).toEqual(['a']);
    });

    it('should respect dependency ordering', async () => {
      manager.beginCycle('test-cycle', ['a', 'b']);

      const registrations: PhaseRegistration[] = [
        {
          name: 'b',
          dependsOn: ['a'],
          executor: async (ctx) => { ctx.reportProgress(1); },
        },
        {
          name: 'a',
          executor: async () => { throw new Error('fail'); },
        },
      ];

      const summary = await manager.executePhases(registrations);

      // b depends on a, but a failed, so b should be skipped
      expect(summary.phasesSkipped).toContain('b');
      expect(summary.phasesFailed).toContain('a');
    });
  });

  describe('getOverallProgress()', () => {
    it('should return 0 when no cycle is active', () => {
      expect(manager.getOverallProgress()).toBe(0);
    });

    it('should return average of all phase progresses', () => {
      manager.beginCycle('test', ['a', 'b', 'c', 'd']);
      const state = manager.getState()!;
      state.phases[0]!.progress = 1.0;
      state.phases[1]!.progress = 0.5;
      state.phases[2]!.progress = 0;
      state.phases[3]!.progress = 0;

      expect(manager.getOverallProgress()).toBeCloseTo(0.375);
    });
  });

  describe('getSummary()', () => {
    it('should return placeholder when no cycle active', () => {
      expect(manager.getSummary()).toBe('No active dream cycle');
    });

    it('should include cycle ID and phase states', () => {
      manager.beginCycle('2026-03-10', ['consolidate', 'explore']);
      const summary = manager.getSummary();

      expect(summary).toContain('2026-03-10');
      expect(summary).toContain('consolidate');
      expect(summary).toContain('explore');
    });
  });

  describe('preempt()', () => {
    it('should set preempted flag', () => {
      expect(manager.isPreempted()).toBe(false);
      manager.preempt();
      expect(manager.isPreempted()).toBe(true);
    });
  });
});
