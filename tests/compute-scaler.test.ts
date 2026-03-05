import { describe, expect, it } from 'vitest';
import {
  ComputeScaler,
  createComputeScaler,
  SELF_ASSESSMENT_PROMPT,
} from '../src/autonomous/reasoning/compute-scaler.js';
import type {
  ComputeBudget,
  SelfAssessment,
  CalibrationRecord,
  CalibrationSummary,
} from '../src/autonomous/reasoning/compute-scaler.js';
import type { Difficulty } from '../src/autonomous/reasoning/scaling.js';

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('ComputeScaler — Construction', () => {
  it('creates scaler with default config', () => {
    const scaler = createComputeScaler();
    const config = scaler.getConfig();
    expect(config.selfAssessmentEnabled).toBe(true);
    expect(config.calibrationEnabled).toBe(true);
    expect(config.maxCalibrationRecords).toBe(500);
    expect(config.calibrationWeight).toBe(0.3);
  });

  it('creates scaler with custom config', () => {
    const scaler = createComputeScaler({
      selfAssessmentEnabled: false,
      calibrationWeight: 0.5,
    });
    const config = scaler.getConfig();
    expect(config.selfAssessmentEnabled).toBe(false);
    expect(config.calibrationWeight).toBe(0.5);
  });

  it('exports self-assessment prompt', () => {
    expect(SELF_ASSESSMENT_PROMPT).toContain('difficulty');
    expect(SELF_ASSESSMENT_PROMPT).toContain('JSON');
  });
});

describe('ComputeScaler — Budget Allocation', () => {
  it('allocates easy budget', () => {
    const scaler = createComputeScaler();
    const budget = scaler.getBudget('easy');

    expect(budget.maxTurns).toBe(25);
    expect(budget.verificationDepth).toBe(1);
    expect(budget.maxRetries).toBe(1);
    expect(budget.parallelCandidates).toBe(1);
    expect(budget.temperature).toBe(0.3);
    expect(budget.contextTier).toBe('standard');
    expect(budget.useJudge).toBe(false);
    expect(budget.difficulty).toBe('easy');
  });

  it('allocates medium budget', () => {
    const scaler = createComputeScaler();
    const budget = scaler.getBudget('medium');

    expect(budget.maxTurns).toBe(50);
    expect(budget.verificationDepth).toBe(2);
    expect(budget.parallelCandidates).toBe(2);
    expect(budget.contextTier).toBe('standard');
    expect(budget.useJudge).toBe(false);
    expect(budget.difficulty).toBe('medium');
  });

  it('allocates hard budget', () => {
    const scaler = createComputeScaler();
    const budget = scaler.getBudget('hard');

    expect(budget.maxTurns).toBe(100);
    expect(budget.verificationDepth).toBe(3);
    expect(budget.maxRetries).toBe(3);
    expect(budget.parallelCandidates).toBe(4);
    expect(budget.temperature).toBe(0.3);
    expect(budget.maxTokens).toBe(8192);
    expect(budget.contextTier).toBe('extended');
    expect(budget.useJudge).toBe(true);
    expect(budget.difficulty).toBe('hard');
  });

  it('allows custom budget overrides', () => {
    const scaler = createComputeScaler({
      easyBudget: { maxTurns: 5, temperature: 0.0 },
    });
    const budget = scaler.getBudget('easy');

    expect(budget.maxTurns).toBe(5);
    expect(budget.temperature).toBe(0.0);
    // Other fields should keep defaults
    expect(budget.verificationDepth).toBe(1);
  });

  it('harder difficulty has strictly more compute', () => {
    const scaler = createComputeScaler();
    const easy = scaler.getBudget('easy');
    const medium = scaler.getBudget('medium');
    const hard = scaler.getBudget('hard');

    expect(easy.maxTurns).toBeLessThan(medium.maxTurns);
    expect(medium.maxTurns).toBeLessThan(hard.maxTurns);

    expect(easy.parallelCandidates).toBeLessThanOrEqual(medium.parallelCandidates);
    expect(medium.parallelCandidates).toBeLessThanOrEqual(hard.parallelCandidates);
  });

  it('getBudget returns a copy (not a reference)', () => {
    const scaler = createComputeScaler();
    const budget1 = scaler.getBudget('easy');
    const budget2 = scaler.getBudget('easy');

    budget1.maxTurns = 999;
    expect(budget2.maxTurns).toBe(25); // Unchanged
  });
});

describe('ComputeScaler — Self-Assessment Parsing', () => {
  it('parses valid self-assessment JSON', () => {
    const scaler = createComputeScaler();
    const result = scaler.parseSelfAssessment(
      '{"difficulty": "hard", "confidence": 0.85, "signals": ["cross-file", "security"]}',
    );

    expect(result).not.toBeNull();
    expect(result!.difficulty).toBe('hard');
    expect(result!.confidence).toBe(0.85);
    expect(result!.signals).toEqual(['cross-file', 'security']);
  });

  it('parses JSON wrapped in markdown fences', () => {
    const scaler = createComputeScaler();
    const result = scaler.parseSelfAssessment(
      '```json\n{"difficulty": "medium", "confidence": 0.7, "signals": ["testing"]}\n```',
    );

    expect(result).not.toBeNull();
    expect(result!.difficulty).toBe('medium');
  });

  it('parses JSON with thinking blocks', () => {
    const scaler = createComputeScaler();
    const result = scaler.parseSelfAssessment(
      '<think>This looks like a simple rename task.</think>\n{"difficulty": "easy", "confidence": 0.95, "signals": ["rename"]}',
    );

    expect(result).not.toBeNull();
    expect(result!.difficulty).toBe('easy');
    expect(result!.confidence).toBe(0.95);
  });

  it('returns null for invalid JSON', () => {
    const scaler = createComputeScaler();
    const result = scaler.parseSelfAssessment('This is not JSON at all');
    expect(result).toBeNull();
  });

  it('returns null for invalid difficulty value', () => {
    const scaler = createComputeScaler();
    const result = scaler.parseSelfAssessment(
      '{"difficulty": "extreme", "confidence": 0.5, "signals": []}',
    );
    expect(result).toBeNull();
  });

  it('clamps confidence to [0, 1]', () => {
    const scaler = createComputeScaler();
    const result = scaler.parseSelfAssessment(
      '{"difficulty": "hard", "confidence": 1.5, "signals": []}',
    );

    expect(result).not.toBeNull();
    expect(result!.confidence).toBe(1);
  });

  it('defaults confidence to 0.5 when missing', () => {
    const scaler = createComputeScaler();
    const result = scaler.parseSelfAssessment(
      '{"difficulty": "easy", "signals": []}',
    );

    expect(result).not.toBeNull();
    expect(result!.confidence).toBe(0.5);
  });

  it('handles missing signals array', () => {
    const scaler = createComputeScaler();
    const result = scaler.parseSelfAssessment(
      '{"difficulty": "medium", "confidence": 0.6}',
    );

    expect(result).not.toBeNull();
    expect(result!.signals).toEqual([]);
  });
});

describe('ComputeScaler — Difficulty Combination', () => {
  it('combines equal estimates to same difficulty', () => {
    const scaler = createComputeScaler();
    const result = scaler.combineDifficultyEstimates('medium', {
      difficulty: 'medium',
      confidence: 0.9,
      signals: [],
    });
    expect(result).toBe('medium');
  });

  it('high-confidence self-assessment can shift difficulty up', () => {
    const scaler = createComputeScaler();
    const result = scaler.combineDifficultyEstimates('easy', {
      difficulty: 'hard',
      confidence: 1.0,
      signals: ['complex'],
    });
    // With max confidence (1.0 * 0.5 = 0.5 weight), easy(0)*0.5 + hard(2)*0.5 = 1.0 = medium
    expect(result).toBe('medium');
  });

  it('low-confidence self-assessment has minimal effect', () => {
    const scaler = createComputeScaler();
    const result = scaler.combineDifficultyEstimates('easy', {
      difficulty: 'hard',
      confidence: 0.1,
      signals: [],
    });
    // With low confidence (0.1 * 0.5 = 0.05 weight), easy dominates
    expect(result).toBe('easy');
  });

  it('heuristic dominates when confidence is zero', () => {
    const scaler = createComputeScaler();
    const result = scaler.combineDifficultyEstimates('hard', {
      difficulty: 'easy',
      confidence: 0,
      signals: [],
    });
    expect(result).toBe('hard');
  });
});

describe('ComputeScaler — allocateBudget', () => {
  it('uses heuristic alone when self-assessment disabled', () => {
    const scaler = createComputeScaler({ selfAssessmentEnabled: false });
    const budget = scaler.allocateBudget('hard');

    expect(budget.difficulty).toBe('hard');
    expect(budget.maxTurns).toBe(100);
  });

  it('combines with self-assessment when enabled', () => {
    const scaler = createComputeScaler({ selfAssessmentEnabled: true });
    const budget = scaler.allocateBudget('easy', {
      difficulty: 'hard',
      confidence: 1.0,
      signals: ['complex'],
    });

    // Should be bumped to medium
    expect(budget.difficulty).toBe('medium');
  });

  it('ignores self-assessment when not provided', () => {
    const scaler = createComputeScaler({ selfAssessmentEnabled: true });
    const budget = scaler.allocateBudget('easy');

    expect(budget.difficulty).toBe('easy');
  });
});

describe('ComputeScaler — Calibration', () => {
  it('records outcomes', () => {
    const scaler = createComputeScaler();
    scaler.recordOutcome('easy', 5, 0, true, 'Fix a typo');
    scaler.recordOutcome('hard', 40, 2, true, 'Refactor auth');

    expect(scaler.getCalibrationRecordCount()).toBe(2);
  });

  it('does not record when disabled', () => {
    const scaler = createComputeScaler({ calibrationEnabled: false });
    scaler.recordOutcome('easy', 5, 0, true, 'Fix a typo');

    expect(scaler.getCalibrationRecordCount()).toBe(0);
  });

  it('trims records to max size', () => {
    const scaler = createComputeScaler({ maxCalibrationRecords: 5 });

    for (let i = 0; i < 10; i++) {
      scaler.recordOutcome('medium', 15, 1, true, `Task ${i}`);
    }

    expect(scaler.getCalibrationRecordCount()).toBe(5);
  });

  it('inferActualDifficulty: easy for quick success', () => {
    const scaler = createComputeScaler();
    expect(scaler.inferActualDifficulty(3, 0, true)).toBe('easy');
  });

  it('inferActualDifficulty: medium for moderate effort', () => {
    const scaler = createComputeScaler();
    expect(scaler.inferActualDifficulty(20, 1, true)).toBe('medium');
  });

  it('inferActualDifficulty: hard for many turns and retries', () => {
    const scaler = createComputeScaler();
    expect(scaler.inferActualDifficulty(35, 3, true)).toBe('hard');
  });

  it('inferActualDifficulty: hard for failed tasks with many turns', () => {
    const scaler = createComputeScaler();
    expect(scaler.inferActualDifficulty(25, 0, false)).toBe('hard');
  });

  it('inferActualDifficulty: medium for failed tasks with few turns', () => {
    const scaler = createComputeScaler();
    expect(scaler.inferActualDifficulty(10, 0, false)).toBe('medium');
  });
});

describe('ComputeScaler — Calibration Adjustment', () => {
  it('no adjustment with insufficient data', () => {
    const scaler = createComputeScaler({ minRecordsForCalibration: 20 });

    // Only 5 records
    for (let i = 0; i < 5; i++) {
      scaler.recordOutcome('easy', 30, 2, true, `Task ${i}`);
    }

    const budget = scaler.allocateBudget('easy');
    expect(budget.difficulty).toBe('easy'); // No adjustment
  });

  it('bumps up when systematically underestimating', () => {
    const scaler = createComputeScaler({ minRecordsForCalibration: 5 });

    // All "easy" predictions end up needing hard-level effort
    for (let i = 0; i < 10; i++) {
      scaler.recordOutcome('easy', 40, 3, true, `Hard task ${i}`);
    }

    const budget = scaler.allocateBudget('easy');
    expect(budget.difficulty).toBe('medium'); // Bumped up
  });

  it('bumps down when systematically overestimating', () => {
    const scaler = createComputeScaler({ minRecordsForCalibration: 5 });

    // All "hard" predictions end up being easy
    for (let i = 0; i < 10; i++) {
      scaler.recordOutcome('hard', 3, 0, true, `Easy task ${i}`);
    }

    const budget = scaler.allocateBudget('hard');
    expect(budget.difficulty).toBe('medium'); // Bumped down
  });
});

describe('ComputeScaler — Calibration Summary', () => {
  it('returns empty summary with no records', () => {
    const scaler = createComputeScaler();
    const summary = scaler.getCalibrationSummary();

    expect(summary.totalRecords).toBe(0);
    expect(summary.accuracy).toBe(0);
  });

  it('computes accuracy for matching predictions', () => {
    const scaler = createComputeScaler();

    // Correct predictions (easy tasks that actually were easy)
    for (let i = 0; i < 5; i++) {
      scaler.recordOutcome('easy', 3, 0, true, `Easy task ${i}`);
    }

    const summary = scaler.getCalibrationSummary();
    expect(summary.totalRecords).toBe(5);
    expect(summary.accuracy).toBe(1.0);
  });

  it('detects overestimates and underestimates', () => {
    const scaler = createComputeScaler();

    // Correct
    scaler.recordOutcome('easy', 3, 0, true, 'Easy task');

    // Overestimate: predicted hard, was actually easy
    scaler.recordOutcome('hard', 3, 0, true, 'Over-estimated task');

    // Underestimate: predicted easy, needed hard effort
    scaler.recordOutcome('easy', 40, 3, true, 'Under-estimated task');

    const summary = scaler.getCalibrationSummary();
    expect(summary.totalRecords).toBe(3);
    expect(summary.overestimateRate).toBeGreaterThan(0);
    expect(summary.underestimateRate).toBeGreaterThan(0);
  });

  it('generates recommended adjustments for high underestimate rate', () => {
    const scaler = createComputeScaler();

    // Most tasks underestimated
    for (let i = 0; i < 8; i++) {
      scaler.recordOutcome('easy', 40, 3, true, `Hard task ${i}`);
    }
    for (let i = 0; i < 2; i++) {
      scaler.recordOutcome('easy', 3, 0, true, `Easy task ${i}`);
    }

    const summary = scaler.getCalibrationSummary();
    expect(summary.recommendedAdjustments.length).toBeGreaterThan(0);
    expect(summary.recommendedAdjustments[0]!.parameter).toBe('difficulty_threshold');
  });

  it('per-difficulty breakdown tracks correctly', () => {
    const scaler = createComputeScaler();

    scaler.recordOutcome('easy', 3, 0, true, 'Easy 1');
    scaler.recordOutcome('easy', 5, 0, true, 'Easy 2');
    scaler.recordOutcome('hard', 40, 2, false, 'Hard 1');

    const summary = scaler.getCalibrationSummary();

    expect(summary.perDifficulty.easy.count).toBe(2);
    expect(summary.perDifficulty.easy.successRate).toBe(1.0);
    expect(summary.perDifficulty.hard.count).toBe(1);
    expect(summary.perDifficulty.hard.successRate).toBe(0);
  });
});

describe('ComputeScaler — Accessors', () => {
  it('isSelfAssessmentEnabled returns config value', () => {
    expect(createComputeScaler().isSelfAssessmentEnabled()).toBe(true);
    expect(
      createComputeScaler({ selfAssessmentEnabled: false }).isSelfAssessmentEnabled(),
    ).toBe(false);
  });

  it('isCalibrationEnabled returns config value', () => {
    expect(createComputeScaler().isCalibrationEnabled()).toBe(true);
    expect(
      createComputeScaler({ calibrationEnabled: false }).isCalibrationEnabled(),
    ).toBe(false);
  });
});
