import { describe, expect, it } from 'vitest';
import {
  deriveFromIntensity,
  formatIntensitySummary,
} from '../src/autonomous/dream/intensity-dial.js';

describe('IntensityDial', () => {
  describe('deriveFromIntensity()', () => {
    it('should clamp intensity to [1, 10]', () => {
      expect(deriveFromIntensity(0).intensity).toBe(1);
      expect(deriveFromIntensity(-5).intensity).toBe(1);
      expect(deriveFromIntensity(15).intensity).toBe(10);
      expect(deriveFromIntensity(5).intensity).toBe(5);
    });

    it('should produce shorter intervals at higher intensity', () => {
      const low = deriveFromIntensity(1);
      const mid = deriveFromIntensity(5);
      const high = deriveFromIntensity(10);

      expect(low.scheduler.intervalHours!).toBeGreaterThan(mid.scheduler.intervalHours!);
      expect(mid.scheduler.intervalHours!).toBeGreaterThan(high.scheduler.intervalHours!);
    });

    it('should produce larger exploration budgets at higher intensity', () => {
      const low = deriveFromIntensity(1);
      const high = deriveFromIntensity(10);

      expect(high.dream.explorationBudgetTurns!).toBeGreaterThan(
        low.dream.explorationBudgetTurns!,
      );
    });

    it('should produce more autoresearch experiments at higher intensity', () => {
      const low = deriveFromIntensity(2);
      const high = deriveFromIntensity(9);

      expect(high.autoresearch.maxExperimentsPerCycle!).toBeGreaterThan(
        low.autoresearch.maxExperimentsPerCycle!,
      );
    });

    it('should produce larger challenge budgets at higher intensity', () => {
      const low = deriveFromIntensity(1);
      const high = deriveFromIntensity(10);

      expect(high.challengeBudget).toBeGreaterThan(low.challengeBudget);
    });

    it('should produce larger prompt populations at higher intensity', () => {
      const low = deriveFromIntensity(1);
      const high = deriveFromIntensity(10);

      expect(high.promptPopulationSize).toBeGreaterThanOrEqual(low.promptPopulationSize);
    });

    it('should produce shorter min-idle at higher intensity', () => {
      const low = deriveFromIntensity(1);
      const high = deriveFromIntensity(10);

      expect(low.scheduler.minIdleBeforeDreamSeconds!).toBeGreaterThan(
        high.scheduler.minIdleBeforeDreamSeconds!,
      );
    });

    it('should produce integer values for counts', () => {
      for (let i = 1; i <= 10; i++) {
        const settings = deriveFromIntensity(i);
        expect(Number.isInteger(settings.dream.explorationBudgetTurns)).toBe(true);
        expect(Number.isInteger(settings.challengeBudget)).toBe(true);
        expect(Number.isInteger(settings.promptPopulationSize)).toBe(true);
        expect(Number.isInteger(settings.phaseBudgetSeconds)).toBe(true);
        expect(Number.isInteger(settings.autoresearch.maxExperimentsPerCycle)).toBe(true);
      }
    });

    it('should respect minimum bounds at intensity 1', () => {
      const s = deriveFromIntensity(1);
      expect(s.scheduler.intervalHours!).toBeLessThanOrEqual(72);
      expect(s.scheduler.minIdleBeforeDreamSeconds!).toBeLessThanOrEqual(1800);
      expect(s.dream.explorationBudgetTurns!).toBeGreaterThanOrEqual(10);
      expect(s.challengeBudget).toBeGreaterThanOrEqual(5);
      expect(s.phaseBudgetSeconds).toBeGreaterThanOrEqual(60);
    });

    it('should respect maximum bounds at intensity 10', () => {
      const s = deriveFromIntensity(10);
      expect(s.scheduler.intervalHours!).toBeGreaterThanOrEqual(4);
      expect(s.scheduler.minIdleBeforeDreamSeconds!).toBeGreaterThanOrEqual(60);
      expect(s.dream.explorationBudgetTurns!).toBeLessThanOrEqual(200);
      expect(s.challengeBudget).toBeLessThanOrEqual(50);
      expect(s.phaseBudgetSeconds).toBeLessThanOrEqual(1800);
    });

    it('should produce reference values at intensity 5', () => {
      const s = deriveFromIntensity(5);
      // At the reference point, values should be close to defaults
      expect(s.scheduler.intervalHours!).toBeCloseTo(24, 0);
      expect(s.scheduler.minIdleBeforeDreamSeconds!).toBeCloseTo(300, -1);
      expect(s.dream.explorationBudgetTurns!).toBeCloseTo(50, -1);
    });
  });

  describe('formatIntensitySummary()', () => {
    it('should produce a readable summary', () => {
      const settings = deriveFromIntensity(5);
      const summary = formatIntensitySummary(settings);

      expect(summary).toContain('Intensity Dial: 5/10');
      expect(summary).toContain('Dream interval:');
      expect(summary).toContain('Min idle:');
      expect(summary).toContain('Exploration budget:');
      expect(summary).toContain('Challenge budget:');
      expect(summary).toContain('Autoresearch:');
    });
  });
});
