/**
 * Challenge Evaluator — Adversarial Dual-Model Self-Testing (Vision Tier 3)
 *
 * Evaluates challenge results and updates the self-model with granular
 * sub-skill data. Tracks challenge history for trend analysis.
 *
 * Flow:
 *   1. Receive challenge batch with results from the dream cycle.
 *   2. Score each result.
 *   3. Update self-model with per-skill and per-sub-skill data.
 *   4. Persist evaluation history for trend tracking.
 *
 * Privacy: Only synthetic challenge data and aggregate statistics.
 * No user data is involved.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { getTracer } from '../debug.js';
import type {
  ChallengeBatch,
  ChallengeBatchSummary,
  ChallengeResult,
} from './challenge-generator.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Granular sub-skill assessment extending the self-model.
 */
export interface SubSkillAssessment {
  /** Full key: "regex.lookaheads" */
  key: string;

  /** Parent skill */
  skill: string;

  /** Sub-skill name */
  subSkill: string;

  /** Success rate from challenges */
  challengeSuccessRate: number;

  /** Total challenge attempts */
  challengeAttempts: number;

  /** Successes */
  challengeSuccesses: number;

  /** Last assessed */
  lastAssessed: string;
}

/**
 * Evaluation history for trend tracking.
 */
export interface EvaluationHistory {
  /** All batch summaries (most recent first) */
  batches: EvaluationRecord[];

  /** Sub-skill assessments (accumulated across batches) */
  subSkills: SubSkillAssessment[];

  /** When history was last updated */
  lastUpdated: string;
}

/**
 * A single evaluation record in history.
 */
export interface EvaluationRecord {
  /** Batch ID */
  batchId: string;

  /** When evaluated */
  timestamp: string;

  /** Cycle that generated the batch */
  cycleId: string;

  /** Summary stats */
  summary: ChallengeBatchSummary;
}

/**
 * Configuration for the evaluator.
 */
export interface ChallengeEvaluatorConfig {
  /** Path to evaluation history file */
  historyPath: string;

  /** Maximum number of batch records to keep */
  maxBatchRecords: number;

  /** Minimum challenge attempts before sub-skill is considered "assessed" */
  minSubSkillSamples: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: ChallengeEvaluatorConfig = {
  historyPath: '~/.casterly/challenge-history.json',
  maxBatchRecords: 50,
  minSubSkillSamples: 3,
};

// ─────────────────────────────────────────────────────────────────────────────
// Challenge Evaluator
// ─────────────────────────────────────────────────────────────────────────────

export class ChallengeEvaluator {
  private readonly config: ChallengeEvaluatorConfig;
  private history: EvaluationHistory;
  private loaded = false;
  private dirty = false;

  constructor(config?: Partial<ChallengeEvaluatorConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.history = {
      batches: [],
      subSkills: [],
      lastUpdated: new Date().toISOString(),
    };
  }

  // ── Persistence ─────────────────────────────────────────────────────────

  /**
   * Load evaluation history from disk.
   */
  async load(): Promise<void> {
    const resolvedPath = this.config.historyPath.replace(/^~/, process.env['HOME'] ?? '~');

    try {
      const content = await readFile(resolvedPath, 'utf8');
      const parsed = JSON.parse(content) as EvaluationHistory;
      if (parsed && Array.isArray(parsed.batches)) {
        this.history = parsed;
      }
    } catch {
      // No existing history — start fresh
    }

    this.loaded = true;
  }

  /**
   * Save evaluation history to disk.
   */
  async save(): Promise<void> {
    if (!this.dirty) return;

    const resolvedPath = this.config.historyPath.replace(/^~/, process.env['HOME'] ?? '~');
    await mkdir(dirname(resolvedPath), { recursive: true });
    await writeFile(resolvedPath, JSON.stringify(this.history, null, 2), 'utf8');

    this.dirty = false;
    getTracer().log('dream', 'debug', `Challenge history saved: ${this.history.batches.length} batches`);
  }

  // ── Evaluation ──────────────────────────────────────────────────────────

  /**
   * Record a completed challenge batch, updating sub-skill assessments.
   */
  recordBatch(batch: ChallengeBatch, summary: ChallengeBatchSummary): void {
    const tracer = getTracer();

    // Record the batch summary
    this.history.batches.unshift({
      batchId: batch.id,
      timestamp: batch.timestamp,
      cycleId: batch.cycleId,
      summary,
    });

    // Prune old batch records
    if (this.history.batches.length > this.config.maxBatchRecords) {
      this.history.batches = this.history.batches.slice(0, this.config.maxBatchRecords);
    }

    // Update sub-skill assessments from results
    for (const result of batch.results) {
      this.updateSubSkill(result);
    }

    this.history.lastUpdated = new Date().toISOString();
    this.dirty = true;

    tracer.log('dream', 'info', `Recorded batch ${batch.id}: ${summary.passed}/${summary.total} passed`);
  }

  /**
   * Get the trend for a specific skill over recent batches.
   */
  getSkillTrend(skill: string, lastN: number = 5): Array<{ batchId: string; rate: number }> {
    const trend: Array<{ batchId: string; rate: number }> = [];

    for (const record of this.history.batches.slice(0, lastN)) {
      const skillData = record.summary.bySkill[skill];
      if (skillData) {
        trend.push({ batchId: record.batchId, rate: skillData.rate });
      }
    }

    return trend;
  }

  /**
   * Get all sub-skill assessments, optionally filtered by parent skill.
   */
  getSubSkillAssessments(skill?: string): SubSkillAssessment[] {
    if (skill) {
      return this.history.subSkills.filter((s) => s.skill === skill);
    }
    return [...this.history.subSkills];
  }

  /**
   * Get the weakest sub-skills based on challenge performance.
   */
  getWeakestSubSkills(minSamples?: number, limit: number = 10): SubSkillAssessment[] {
    const threshold = minSamples ?? this.config.minSubSkillSamples;
    return this.history.subSkills
      .filter((s) => s.challengeAttempts >= threshold)
      .sort((a, b) => a.challengeSuccessRate - b.challengeSuccessRate)
      .slice(0, limit);
  }

  /**
   * Get the strongest sub-skills based on challenge performance.
   */
  getStrongestSubSkills(minSamples?: number, limit: number = 10): SubSkillAssessment[] {
    const threshold = minSamples ?? this.config.minSubSkillSamples;
    return this.history.subSkills
      .filter((s) => s.challengeAttempts >= threshold)
      .sort((a, b) => b.challengeSuccessRate - a.challengeSuccessRate)
      .slice(0, limit);
  }

  /**
   * Get overall statistics across all evaluations.
   */
  getOverallStats(): {
    totalBatches: number;
    totalChallenges: number;
    totalPassed: number;
    overallPassRate: number;
    assessedSubSkills: number;
  } {
    let totalChallenges = 0;
    let totalPassed = 0;

    for (const record of this.history.batches) {
      totalChallenges += record.summary.total;
      totalPassed += record.summary.passed;
    }

    return {
      totalBatches: this.history.batches.length,
      totalChallenges,
      totalPassed,
      overallPassRate: totalChallenges > 0 ? totalPassed / totalChallenges : 0,
      assessedSubSkills: this.history.subSkills.filter(
        (s) => s.challengeAttempts >= this.config.minSubSkillSamples,
      ).length,
    };
  }

  /**
   * Build a formatted summary for inclusion in dream cycle reports.
   */
  buildSummaryText(): string {
    const stats = this.getOverallStats();
    const weakest = this.getWeakestSubSkills(undefined, 5);
    const strongest = this.getStrongestSubSkills(undefined, 3);

    const lines: string[] = [
      `Challenge History: ${stats.totalBatches} batches, ${stats.totalChallenges} total challenges`,
      `Overall pass rate: ${Math.round(stats.overallPassRate * 100)}%`,
    ];

    if (weakest.length > 0) {
      lines.push('Weakest sub-skills:');
      for (const s of weakest) {
        lines.push(`  ${s.key}: ${Math.round(s.challengeSuccessRate * 100)}% (${s.challengeAttempts} attempts)`);
      }
    }

    if (strongest.length > 0) {
      lines.push('Strongest sub-skills:');
      for (const s of strongest) {
        lines.push(`  ${s.key}: ${Math.round(s.challengeSuccessRate * 100)}% (${s.challengeAttempts} attempts)`);
      }
    }

    return lines.join('\n');
  }

  /**
   * Get the full evaluation history (for testing/inspection).
   */
  getHistory(): Readonly<EvaluationHistory> {
    return this.history;
  }

  // ── Private Helpers ─────────────────────────────────────────────────────

  /**
   * Update a sub-skill assessment from a challenge result.
   */
  private updateSubSkill(result: ChallengeResult): void {
    const subSkill = result.subSkill ?? 'general';
    const key = `${result.skill}.${subSkill}`;

    let assessment = this.history.subSkills.find((s) => s.key === key);

    if (!assessment) {
      assessment = {
        key,
        skill: result.skill,
        subSkill,
        challengeSuccessRate: 0,
        challengeAttempts: 0,
        challengeSuccesses: 0,
        lastAssessed: new Date().toISOString(),
      };
      this.history.subSkills.push(assessment);
    }

    assessment.challengeAttempts++;
    if (result.passed) {
      assessment.challengeSuccesses++;
    }
    assessment.challengeSuccessRate = assessment.challengeSuccesses / assessment.challengeAttempts;
    assessment.lastAssessed = new Date().toISOString();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────────────────────

export function createChallengeEvaluator(
  config?: Partial<ChallengeEvaluatorConfig>,
): ChallengeEvaluator {
  return new ChallengeEvaluator(config);
}
