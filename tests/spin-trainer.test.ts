import { describe, expect, it } from 'vitest';
import {
  SpinTrainer,
  createSpinTrainer,
  type SpinIteration,
  type ResponsePair,
} from '../src/autonomous/dream/spin-trainer.js';
import { LoraTrainer } from '../src/autonomous/dream/lora-trainer.js';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeLoraTrainer(): LoraTrainer {
  return new LoraTrainer({
    adaptersPath: '/tmp/test-adapters',
    benchmarksPath: '/tmp/test-benchmarks',
  });
}

function makeIteration(overrides?: Partial<SpinIteration>): SpinIteration {
  return {
    iteration: 0,
    timestamp: new Date().toISOString(),
    skill: 'testing',
    previousAdapterPath: '/tmp/prev.lora',
    newAdapterPath: '/tmp/new.lora',
    previousScores: [0.5, 0.6, 0.4],
    currentScores: [0.7, 0.8, 0.6],
    meanImprovement: 0.2,
    pValue: 0.03,
    significant: true,
    promoted: true,
    trainingResult: null,
    dpoPairsGenerated: 10,
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('SpinTrainer', () => {
  // ── Factory ──────────────────────────────────────────────────────────────

  it('factory creates instance', () => {
    const trainer = createSpinTrainer();
    expect(trainer).toBeInstanceOf(SpinTrainer);
  });

  it('deep merges dpoParams', () => {
    const trainer = createSpinTrainer({ dpoParams: { rank: 32 } as never });
    const state = trainer.getState();
    // Should have the default values for other fields
    expect(state).toBeDefined();
  });

  // ── canRunSpin ──────────────────────────────────────────────────────────

  describe('canRunSpin', () => {
    it('returns false when no active adapter exists', () => {
      const spin = createSpinTrainer();
      const lora = makeLoraTrainer();

      const { canRun, reason } = spin.canRunSpin('testing', lora);
      expect(canRun).toBe(false);
      expect(reason).toContain('No active adapter');
    });

    it('returns false when insufficient benchmarks', () => {
      const spin = createSpinTrainer();
      const lora = makeLoraTrainer();

      // Create and activate adapter
      const adapter = lora.createAdapter('testing', 20);
      lora.recordEvaluation(adapter.id, 0.5, 0.6);

      // Add only 2 benchmarks (need 5)
      lora.addBenchmarkTask({ id: 'b1', skill: 'testing', instruction: 'Test 1', expectedCriteria: 'Pass', maxScore: 1 });
      lora.addBenchmarkTask({ id: 'b2', skill: 'testing', instruction: 'Test 2', expectedCriteria: 'Pass', maxScore: 1 });

      const { canRun, reason } = spin.canRunSpin('testing', lora);
      expect(canRun).toBe(false);
      expect(reason).toContain('Insufficient benchmarks');
    });

    it('returns true when all requirements met', () => {
      const spin = createSpinTrainer();
      const lora = makeLoraTrainer();

      // Create and activate adapter
      const adapter = lora.createAdapter('testing', 20);
      lora.recordEvaluation(adapter.id, 0.5, 0.6);

      // Add 5 benchmarks
      for (let i = 0; i < 5; i++) {
        lora.addBenchmarkTask({
          id: `b${i}`,
          skill: 'testing',
          instruction: `Test ${i}`,
          expectedCriteria: 'Pass',
          maxScore: 1,
        });
      }

      const { canRun } = spin.canRunSpin('testing', lora);
      expect(canRun).toBe(true);
    });

    it('returns false when max iterations reached', () => {
      const spin = createSpinTrainer({ maxIterationsPerCycle: 1 });
      const lora = makeLoraTrainer();

      const adapter = lora.createAdapter('testing', 20);
      lora.recordEvaluation(adapter.id, 0.5, 0.6);
      for (let i = 0; i < 5; i++) {
        lora.addBenchmarkTask({ id: `b${i}`, skill: 'testing', instruction: `Test ${i}`, expectedCriteria: 'Pass', maxScore: 1 });
      }

      // Record an iteration to use up the budget
      spin.recordIteration(makeIteration());

      const { canRun, reason } = spin.canRunSpin('testing', lora);
      expect(canRun).toBe(false);
      expect(reason).toContain('Max iterations');
    });
  });

  // ── DPO Pair Building ──────────────────────────────────────────────────

  describe('buildDPOPairs', () => {
    it('builds pairs where current scores higher', () => {
      const spin = createSpinTrainer();
      const pairs: ResponsePair[] = [
        { prompt: 'Q1', currentResponse: 'Good', previousResponse: 'Bad', currentScore: 0.8, previousScore: 0.5 },
        { prompt: 'Q2', currentResponse: 'OK', previousResponse: 'Better', currentScore: 0.4, previousScore: 0.6 },
        { prompt: 'Q3', currentResponse: 'Great', previousResponse: 'Meh', currentScore: 0.9, previousScore: 0.3 },
      ];

      const dpoPairs = spin.buildDPOPairs(pairs, 'testing');

      expect(dpoPairs).toHaveLength(2); // Only Q1 and Q3 (current > previous)
      expect(dpoPairs[0]!.chosen).toBe('Good');
      expect(dpoPairs[0]!.rejected).toBe('Bad');
      expect(dpoPairs[1]!.chosen).toBe('Great');
      expect(dpoPairs[1]!.rejected).toBe('Meh');
    });

    it('returns empty when previous always beats current', () => {
      const spin = createSpinTrainer();
      const pairs: ResponsePair[] = [
        { prompt: 'Q1', currentResponse: 'A', previousResponse: 'B', currentScore: 0.3, previousScore: 0.7 },
      ];

      expect(spin.buildDPOPairs(pairs, 'testing')).toHaveLength(0);
    });

    it('excludes ties', () => {
      const spin = createSpinTrainer();
      const pairs: ResponsePair[] = [
        { prompt: 'Q1', currentResponse: 'A', previousResponse: 'B', currentScore: 0.5, previousScore: 0.5 },
      ];

      expect(spin.buildDPOPairs(pairs, 'testing')).toHaveLength(0);
    });
  });

  // ── Wilcoxon Signed-Rank Test ──────────────────────────────────────────

  describe('wilcoxonSignedRankTest', () => {
    it('detects significant improvement', () => {
      const spin = createSpinTrainer();
      const current =  [0.8, 0.9, 0.7, 0.85, 0.75, 0.9, 0.8, 0.85, 0.7, 0.9];
      const previous = [0.5, 0.6, 0.4, 0.55, 0.45, 0.5, 0.6, 0.5,  0.4, 0.55];

      const { pValue, significant } = spin.wilcoxonSignedRankTest(current, previous);

      expect(pValue).toBeLessThan(0.05);
      expect(significant).toBe(true);
    });

    it('rejects when scores are similar', () => {
      const spin = createSpinTrainer();
      const current =  [0.5, 0.51, 0.49, 0.5, 0.52, 0.48, 0.5, 0.51, 0.49, 0.5];
      const previous = [0.5, 0.49, 0.51, 0.5, 0.48, 0.52, 0.5, 0.49, 0.51, 0.5];

      const { significant } = spin.wilcoxonSignedRankTest(current, previous);

      expect(significant).toBe(false);
    });

    it('returns p=1.0 for too few samples', () => {
      const spin = createSpinTrainer();
      const { pValue } = spin.wilcoxonSignedRankTest([0.8, 0.9], [0.5, 0.6]);
      expect(pValue).toBe(1.0);
    });

    it('returns p=1.0 for identical scores', () => {
      const spin = createSpinTrainer();
      const scores = [0.5, 0.6, 0.7, 0.8, 0.5];
      const { pValue } = spin.wilcoxonSignedRankTest(scores, [...scores]);
      expect(pValue).toBe(1.0);
    });

    it('throws for unequal length arrays', () => {
      const spin = createSpinTrainer();
      expect(() => spin.wilcoxonSignedRankTest([0.5], [0.5, 0.6])).toThrow('equal length');
    });

    it('handles ties correctly', () => {
      const spin = createSpinTrainer();
      // All differences are the same magnitude (ties in ranks)
      const current =  [0.6, 0.7, 0.8, 0.6, 0.7, 0.8, 0.6, 0.7, 0.8, 0.6];
      const previous = [0.5, 0.6, 0.7, 0.5, 0.6, 0.7, 0.5, 0.6, 0.7, 0.5];

      const { pValue } = spin.wilcoxonSignedRankTest(current, previous);

      // All positive, should be significant
      expect(pValue).toBeLessThan(0.05);
    });
  });

  // ── isSignificantImprovement ──────────────────────────────────────────

  describe('isSignificantImprovement', () => {
    it('requires both statistical and practical significance', () => {
      const spin = createSpinTrainer({ minScoreImprovement: 0.1 });

      // Large and significant improvement
      const current =  [0.8, 0.9, 0.7, 0.85, 0.75, 0.9, 0.8, 0.85, 0.7, 0.9];
      const previous = [0.5, 0.6, 0.4, 0.55, 0.45, 0.5, 0.6, 0.5,  0.4, 0.55];

      const result = spin.isSignificantImprovement(current, previous);
      expect(result.significant).toBe(true);
      expect(result.meanImprovement).toBeGreaterThan(0.1);
    });

    it('rejects when mean improvement below threshold', () => {
      const spin = createSpinTrainer({ minScoreImprovement: 0.5 });

      // Statistically significant but small improvement
      const current =  [0.55, 0.56, 0.54, 0.55, 0.57, 0.53, 0.55, 0.56, 0.54, 0.55];
      const previous = [0.50, 0.51, 0.49, 0.50, 0.52, 0.48, 0.50, 0.51, 0.49, 0.50];

      const result = spin.isSignificantImprovement(current, previous);
      expect(result.significant).toBe(false);
      expect(result.meanImprovement).toBeLessThan(0.5);
    });
  });

  // ── Iteration Tracking ──────────────────────────────────────────────────

  describe('recordIteration', () => {
    it('records and tracks iterations', () => {
      const spin = createSpinTrainer();
      spin.recordIteration(makeIteration({ promoted: true }));

      const state = spin.getState();
      expect(state.totalIterations).toBe(1);
      expect(state.totalPromotions).toBe(1);
      expect(state.iterationCounts['testing']).toBe(1);
    });

    it('tracks non-promoted iterations', () => {
      const spin = createSpinTrainer();
      spin.recordIteration(makeIteration({ promoted: false }));

      const state = spin.getState();
      expect(state.totalIterations).toBe(1);
      expect(state.totalPromotions).toBe(0);
    });

    it('increments per-skill count', () => {
      const spin = createSpinTrainer();
      spin.recordIteration(makeIteration({ skill: 'testing' }));
      spin.recordIteration(makeIteration({ skill: 'testing', iteration: 1 }));
      spin.recordIteration(makeIteration({ skill: 'regex' }));

      const state = spin.getState();
      expect(state.iterationCounts['testing']).toBe(2);
      expect(state.iterationCounts['regex']).toBe(1);
    });
  });

  // ── Cycle Reset ──────────────────────────────────────────────────────────

  describe('resetCycleCounts', () => {
    it('resets iteration counts', () => {
      const spin = createSpinTrainer();
      spin.recordIteration(makeIteration());

      expect(spin.getState().iterationCounts['testing']).toBe(1);
      spin.resetCycleCounts();
      expect(spin.getState().iterationCounts['testing']).toBeUndefined();
    });

    it('preserves total counts', () => {
      const spin = createSpinTrainer();
      spin.recordIteration(makeIteration());
      spin.resetCycleCounts();

      expect(spin.getState().totalIterations).toBe(1);
      expect(spin.getState().totalPromotions).toBe(1);
    });
  });

  // ── Queries ──────────────────────────────────────────────────────────────

  describe('getIterationsForSkill', () => {
    it('filters by skill', () => {
      const spin = createSpinTrainer();
      spin.recordIteration(makeIteration({ skill: 'testing' }));
      spin.recordIteration(makeIteration({ skill: 'regex' }));
      spin.recordIteration(makeIteration({ skill: 'testing', iteration: 1 }));

      expect(spin.getIterationsForSkill('testing')).toHaveLength(2);
      expect(spin.getIterationsForSkill('regex')).toHaveLength(1);
      expect(spin.getIterationsForSkill('unknown')).toHaveLength(0);
    });
  });

  describe('getLatestIteration', () => {
    it('returns most recent iteration', () => {
      const spin = createSpinTrainer();
      spin.recordIteration(makeIteration({ iteration: 0 }));
      spin.recordIteration(makeIteration({ iteration: 1 }));

      const latest = spin.getLatestIteration('testing');
      expect(latest!.iteration).toBe(1);
    });

    it('returns undefined for unknown skill', () => {
      const spin = createSpinTrainer();
      expect(spin.getLatestIteration('unknown')).toBeUndefined();
    });
  });

  // ── Summary ──────────────────────────────────────────────────────────────

  describe('buildSummary', () => {
    it('includes iteration counts', () => {
      const spin = createSpinTrainer();
      spin.recordIteration(makeIteration());

      const summary = spin.buildSummary();
      expect(summary).toContain('Total iterations: 1');
      expect(summary).toContain('Total promotions: 1');
      expect(summary).toContain('testing');
    });

    it('handles empty state', () => {
      const spin = createSpinTrainer();
      const summary = spin.buildSummary();
      expect(summary).toContain('Total iterations: 0');
    });
  });
});
