/**
 * Test-Time Compute Scaler — Dynamic compute budget allocation based on task difficulty.
 *
 * Extends the existing ReasoningScaler with dynamic compute budget management.
 * Instead of fixed strategies per difficulty level, this scaler:
 *   - Lets the model self-assess difficulty during classification
 *   - Maps difficulty to compute budgets: turn limits, verification depth, retry count
 *   - Tracks difficulty estimates vs actual outcomes for calibration
 *   - Integrates with the dream cycle to recalibrate thresholds from historical data
 *
 * The key insight: not all tasks need the same compute. Easy tasks get fast,
 * single-pass treatment. Hard tasks get extended reasoning, multiple attempts,
 * and deep verification cascades.
 *
 * Privacy: All computation stays on-device. No data leaves the machine.
 *
 * See docs/roadmap.md Tier 4, Item 13.
 */

import type { Difficulty, ProblemContext } from './scaling.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute budget allocated for a task based on its difficulty.
 */
export interface ComputeBudget {
  /** Maximum tool-calling turns for this task */
  maxTurns: number;

  /** Maximum verification passes (review cycles) */
  verificationDepth: number;

  /** Maximum retry attempts on failure */
  maxRetries: number;

  /** Number of parallel candidates to generate */
  parallelCandidates: number;

  /** Temperature for generation (higher for hard tasks = more diversity) */
  temperature: number;

  /** Maximum tokens per response */
  maxTokens: number;

  /** Context tier to use ('compact' | 'standard' | 'extended') */
  contextTier: 'compact' | 'standard' | 'extended';

  /** Whether to use the judge model for selection */
  useJudge: boolean;

  /** Difficulty level this budget was derived from */
  difficulty: Difficulty;
}

/**
 * Configuration for the compute scaler.
 */
export interface ComputeScalerConfig {
  /** Budget for easy tasks */
  easyBudget: Partial<ComputeBudget>;

  /** Budget for medium tasks */
  mediumBudget: Partial<ComputeBudget>;

  /** Budget for hard tasks */
  hardBudget: Partial<ComputeBudget>;

  /** Enable self-assessment (model rates its own confidence) */
  selfAssessmentEnabled: boolean;

  /** Enable calibration tracking */
  calibrationEnabled: boolean;

  /** Maximum calibration records to keep */
  maxCalibrationRecords: number;

  /** Minimum records needed before using calibration data */
  minRecordsForCalibration: number;

  /** Weight given to calibration data vs heuristics (0.0-1.0) */
  calibrationWeight: number;
}

/**
 * A calibration record tracking predicted vs actual difficulty.
 */
export interface CalibrationRecord {
  /** Timestamp */
  timestamp: string;

  /** What was predicted */
  predictedDifficulty: Difficulty;

  /** What actually happened */
  actualDifficulty: Difficulty;

  /** Number of turns used */
  turnsUsed: number;

  /** Number of retries needed */
  retriesNeeded: number;

  /** Whether the task succeeded */
  succeeded: boolean;

  /** Task description (truncated for privacy) */
  taskSummary: string;
}

/**
 * Calibration summary for dream cycle analysis.
 */
export interface CalibrationSummary {
  /** Total records */
  totalRecords: number;

  /** Accuracy: fraction of correct difficulty predictions */
  accuracy: number;

  /** Overestimate rate: predicted harder than actual */
  overestimateRate: number;

  /** Underestimate rate: predicted easier than actual */
  underestimateRate: number;

  /** Per-difficulty breakdown */
  perDifficulty: Record<Difficulty, {
    count: number;
    avgTurnsUsed: number;
    successRate: number;
  }>;

  /** Recommended threshold adjustments */
  recommendedAdjustments: ThresholdAdjustment[];
}

/**
 * A recommended adjustment to difficulty thresholds.
 */
export interface ThresholdAdjustment {
  /** What to adjust */
  parameter: string;

  /** Current value */
  currentValue: number;

  /** Recommended value */
  recommendedValue: number;

  /** Reason for the adjustment */
  reason: string;
}

/**
 * Self-assessment result from the model's own difficulty rating.
 */
export interface SelfAssessment {
  /** Model's estimated difficulty */
  difficulty: Difficulty;

  /** Model's confidence in the estimate (0.0-1.0) */
  confidence: number;

  /** Key signals the model identified */
  signals: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_EASY_BUDGET: ComputeBudget = {
  maxTurns: 25,
  verificationDepth: 1,
  maxRetries: 1,
  parallelCandidates: 1,
  temperature: 0.3,
  maxTokens: 4096,
  contextTier: 'standard',
  useJudge: false,
  difficulty: 'easy',
};

const DEFAULT_MEDIUM_BUDGET: ComputeBudget = {
  maxTurns: 50,
  verificationDepth: 2,
  maxRetries: 2,
  parallelCandidates: 2,
  temperature: 0.3,
  maxTokens: 4096,
  contextTier: 'standard',
  useJudge: false,
  difficulty: 'medium',
};

const DEFAULT_HARD_BUDGET: ComputeBudget = {
  maxTurns: 100,
  verificationDepth: 3,
  maxRetries: 3,
  parallelCandidates: 4,
  temperature: 0.3,
  maxTokens: 8192,
  contextTier: 'extended',
  useJudge: true,
  difficulty: 'hard',
};

const DEFAULT_CONFIG: ComputeScalerConfig = {
  easyBudget: {},
  mediumBudget: {},
  hardBudget: {},
  selfAssessmentEnabled: true,
  calibrationEnabled: true,
  maxCalibrationRecords: 500,
  minRecordsForCalibration: 20,
  calibrationWeight: 0.3,
};

/**
 * Prompt template for self-assessment.
 * The model analyzes the task and estimates difficulty.
 */
export const SELF_ASSESSMENT_PROMPT = `Analyze this task and estimate its difficulty. Consider:
- Number of files/components involved
- Complexity of the logic required
- Risk of regressions or side effects
- Whether it requires cross-file coordination

Rate as: easy (simple change, 1-2 files), medium (moderate change, needs testing), or hard (complex, multi-file, high risk).

Respond with ONLY a JSON object:
{"difficulty": "easy|medium|hard", "confidence": 0.0-1.0, "signals": ["signal1", "signal2"]}`;

// ─────────────────────────────────────────────────────────────────────────────
// Compute Scaler
// ─────────────────────────────────────────────────────────────────────────────

export class ComputeScaler {
  private readonly config: ComputeScalerConfig;
  private readonly budgets: Record<Difficulty, ComputeBudget>;
  private readonly calibrationRecords: CalibrationRecord[] = [];

  constructor(config?: Partial<ComputeScalerConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };

    this.budgets = {
      easy: { ...DEFAULT_EASY_BUDGET, ...this.config.easyBudget },
      medium: { ...DEFAULT_MEDIUM_BUDGET, ...this.config.mediumBudget },
      hard: { ...DEFAULT_HARD_BUDGET, ...this.config.hardBudget },
    };
  }

  // ── Budget Allocation ─────────────────────────────────────────────────────

  /**
   * Get the compute budget for a given difficulty level.
   */
  getBudget(difficulty: Difficulty): ComputeBudget {
    return { ...this.budgets[difficulty] };
  }

  /**
   * Allocate a compute budget based on combined heuristic + self-assessment.
   * This is the primary entry point for the dual-loop.
   */
  allocateBudget(
    heuristicDifficulty: Difficulty,
    selfAssessment?: SelfAssessment,
  ): ComputeBudget {
    let finalDifficulty = heuristicDifficulty;

    // Combine heuristic with self-assessment when available
    if (selfAssessment && this.config.selfAssessmentEnabled) {
      finalDifficulty = this.combineDifficultyEstimates(
        heuristicDifficulty,
        selfAssessment,
      );
    }

    // Apply calibration adjustments if enough data exists
    if (this.config.calibrationEnabled) {
      finalDifficulty = this.applyCalibrationAdjustment(finalDifficulty);
    }

    return this.getBudget(finalDifficulty);
  }

  // ── Self-Assessment ───────────────────────────────────────────────────────

  /**
   * Parse a self-assessment response from the model.
   */
  parseSelfAssessment(response: string): SelfAssessment | null {
    try {
      // Strip markdown fences and thinking blocks
      let cleaned = response
        .replace(/<think>[\s\S]*?<\/think>/g, '')
        .replace(/```json\n?/g, '')
        .replace(/```\n?/g, '')
        .trim();

      // Find JSON object
      const match = /\{[\s\S]*\}/.exec(cleaned);
      if (!match) return null;

      const parsed = JSON.parse(match[0]) as Record<string, unknown>;

      const difficulty = parsed['difficulty'] as string;
      if (!['easy', 'medium', 'hard'].includes(difficulty)) return null;

      const confidence = typeof parsed['confidence'] === 'number'
        ? Math.max(0, Math.min(1, parsed['confidence']))
        : 0.5;

      const signals = Array.isArray(parsed['signals'])
        ? (parsed['signals'] as unknown[]).filter((s): s is string => typeof s === 'string')
        : [];

      return {
        difficulty: difficulty as Difficulty,
        confidence,
        signals,
      };
    } catch {
      return null;
    }
  }

  /**
   * Combine heuristic difficulty with model self-assessment.
   * Uses confidence-weighted averaging.
   */
  combineDifficultyEstimates(
    heuristic: Difficulty,
    selfAssessment: SelfAssessment,
  ): Difficulty {
    // Convert to numeric scale
    const difficultyToNum: Record<Difficulty, number> = {
      easy: 0,
      medium: 1,
      hard: 2,
    };

    const numToDifficulty = (n: number): Difficulty => {
      if (n <= 0.5) return 'easy';
      if (n <= 1.5) return 'medium';
      return 'hard';
    };

    const heuristicNum = difficultyToNum[heuristic];
    const assessmentNum = difficultyToNum[selfAssessment.difficulty];

    // Weight by self-assessment confidence
    // Higher confidence = more weight to self-assessment
    const assessWeight = selfAssessment.confidence * 0.5; // Max 50% influence
    const heuristicWeight = 1 - assessWeight;

    const combined = heuristicNum * heuristicWeight + assessmentNum * assessWeight;
    return numToDifficulty(combined);
  }

  // ── Calibration ───────────────────────────────────────────────────────────

  /**
   * Record the outcome of a task for calibration.
   */
  recordOutcome(
    predictedDifficulty: Difficulty,
    turnsUsed: number,
    retriesNeeded: number,
    succeeded: boolean,
    taskSummary: string,
  ): void {
    if (!this.config.calibrationEnabled) return;

    // Infer actual difficulty from outcome
    const actualDifficulty = this.inferActualDifficulty(
      turnsUsed,
      retriesNeeded,
      succeeded,
    );

    const record: CalibrationRecord = {
      timestamp: new Date().toISOString(),
      predictedDifficulty,
      actualDifficulty,
      turnsUsed,
      retriesNeeded,
      succeeded,
      taskSummary: taskSummary.slice(0, 100), // Truncate for privacy
    };

    this.calibrationRecords.push(record);

    // Trim to max size
    while (this.calibrationRecords.length > this.config.maxCalibrationRecords) {
      this.calibrationRecords.shift();
    }
  }

  /**
   * Infer actual difficulty from task outcome.
   */
  inferActualDifficulty(
    turnsUsed: number,
    retriesNeeded: number,
    succeeded: boolean,
  ): Difficulty {
    // Failed tasks after many turns = hard
    if (!succeeded && turnsUsed > 20) return 'hard';
    if (!succeeded) return 'medium';

    // Scoring based on resource usage
    let score = 0;

    if (turnsUsed > 30) score += 3;
    else if (turnsUsed > 15) score += 2;
    else if (turnsUsed > 5) score += 1;

    if (retriesNeeded >= 3) score += 2;
    else if (retriesNeeded >= 1) score += 1;

    if (score <= 1) return 'easy';
    if (score <= 3) return 'medium';
    return 'hard';
  }

  /**
   * Apply calibration adjustment to a difficulty prediction.
   * If historical data shows we consistently over/underestimate, adjust.
   */
  applyCalibrationAdjustment(predicted: Difficulty): Difficulty {
    if (this.calibrationRecords.length < this.config.minRecordsForCalibration) {
      return predicted; // Not enough data yet
    }

    // Check if we systematically under/overestimate for this difficulty
    const matchingRecords = this.calibrationRecords.filter(
      (r) => r.predictedDifficulty === predicted,
    );

    if (matchingRecords.length < 5) return predicted; // Not enough for this level

    const difficultyToNum: Record<Difficulty, number> = {
      easy: 0,
      medium: 1,
      hard: 2,
    };

    const avgActual =
      matchingRecords.reduce((sum, r) => sum + difficultyToNum[r.actualDifficulty], 0) /
      matchingRecords.length;

    const predictedNum = difficultyToNum[predicted];
    const bias = avgActual - predictedNum;

    // Significant underestimate (bias > 0.5): bump up
    if (bias > 0.5 && predicted !== 'hard') {
      return predicted === 'easy' ? 'medium' : 'hard';
    }

    // Significant overestimate (bias < -0.5): bump down
    if (bias < -0.5 && predicted !== 'easy') {
      return predicted === 'hard' ? 'medium' : 'easy';
    }

    return predicted;
  }

  /**
   * Get calibration summary for dream cycle analysis.
   */
  getCalibrationSummary(): CalibrationSummary {
    const total = this.calibrationRecords.length;

    if (total === 0) {
      return {
        totalRecords: 0,
        accuracy: 0,
        overestimateRate: 0,
        underestimateRate: 0,
        perDifficulty: {
          easy: { count: 0, avgTurnsUsed: 0, successRate: 0 },
          medium: { count: 0, avgTurnsUsed: 0, successRate: 0 },
          hard: { count: 0, avgTurnsUsed: 0, successRate: 0 },
        },
        recommendedAdjustments: [],
      };
    }

    let correct = 0;
    let overestimates = 0;
    let underestimates = 0;

    const difficultyToNum: Record<Difficulty, number> = {
      easy: 0,
      medium: 1,
      hard: 2,
    };

    const perDifficulty: Record<Difficulty, {
      count: number;
      totalTurns: number;
      successes: number;
    }> = {
      easy: { count: 0, totalTurns: 0, successes: 0 },
      medium: { count: 0, totalTurns: 0, successes: 0 },
      hard: { count: 0, totalTurns: 0, successes: 0 },
    };

    for (const record of this.calibrationRecords) {
      const predNum = difficultyToNum[record.predictedDifficulty];
      const actNum = difficultyToNum[record.actualDifficulty];

      if (record.predictedDifficulty === record.actualDifficulty) {
        correct++;
      } else if (predNum > actNum) {
        overestimates++;
      } else {
        underestimates++;
      }

      const actual = perDifficulty[record.actualDifficulty];
      actual.count++;
      actual.totalTurns += record.turnsUsed;
      if (record.succeeded) actual.successes++;
    }

    // Build per-difficulty stats
    const perDifficultyResult: Record<Difficulty, {
      count: number;
      avgTurnsUsed: number;
      successRate: number;
    }> = {
      easy: {
        count: perDifficulty.easy.count,
        avgTurnsUsed: perDifficulty.easy.count > 0
          ? Math.round(perDifficulty.easy.totalTurns / perDifficulty.easy.count)
          : 0,
        successRate: perDifficulty.easy.count > 0
          ? Math.round(perDifficulty.easy.successes / perDifficulty.easy.count * 100) / 100
          : 0,
      },
      medium: {
        count: perDifficulty.medium.count,
        avgTurnsUsed: perDifficulty.medium.count > 0
          ? Math.round(perDifficulty.medium.totalTurns / perDifficulty.medium.count)
          : 0,
        successRate: perDifficulty.medium.count > 0
          ? Math.round(perDifficulty.medium.successes / perDifficulty.medium.count * 100) / 100
          : 0,
      },
      hard: {
        count: perDifficulty.hard.count,
        avgTurnsUsed: perDifficulty.hard.count > 0
          ? Math.round(perDifficulty.hard.totalTurns / perDifficulty.hard.count)
          : 0,
        successRate: perDifficulty.hard.count > 0
          ? Math.round(perDifficulty.hard.successes / perDifficulty.hard.count * 100) / 100
          : 0,
      },
    };

    // Generate recommended adjustments
    const adjustments: ThresholdAdjustment[] = [];

    const underestimateRate = underestimates / total;
    if (underestimateRate > 0.3) {
      adjustments.push({
        parameter: 'difficulty_threshold',
        currentValue: 4,
        recommendedValue: 3,
        reason: `${Math.round(underestimateRate * 100)}% of tasks were harder than predicted. Lower the medium→hard threshold.`,
      });
    }

    const overestimateRate = overestimates / total;
    if (overestimateRate > 0.3) {
      adjustments.push({
        parameter: 'difficulty_threshold',
        currentValue: 4,
        recommendedValue: 5,
        reason: `${Math.round(overestimateRate * 100)}% of tasks were easier than predicted. Raise the medium→hard threshold.`,
      });
    }

    return {
      totalRecords: total,
      accuracy: Math.round(correct / total * 100) / 100,
      overestimateRate: Math.round(overestimateRate * 100) / 100,
      underestimateRate: Math.round(underestimateRate * 100) / 100,
      perDifficulty: perDifficultyResult,
      recommendedAdjustments: adjustments,
    };
  }

  // ── Accessors ──────────────────────────────────────────────────────────────

  /**
   * Check if self-assessment is enabled.
   */
  isSelfAssessmentEnabled(): boolean {
    return this.config.selfAssessmentEnabled;
  }

  /**
   * Check if calibration is enabled.
   */
  isCalibrationEnabled(): boolean {
    return this.config.calibrationEnabled;
  }

  /**
   * Get the number of calibration records.
   */
  getCalibrationRecordCount(): number {
    return this.calibrationRecords.length;
  }

  /**
   * Get the full configuration (read-only).
   */
  getConfig(): Readonly<ComputeScalerConfig> {
    return this.config;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a compute scaler with the given configuration.
 */
export function createComputeScaler(
  config?: Partial<ComputeScalerConfig>,
): ComputeScaler {
  return new ComputeScaler(config);
}
