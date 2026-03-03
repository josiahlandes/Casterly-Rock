/**
 * SPIN Self-Play Trainer — Self-Play Fine-Tuning (Vision Tier 3)
 *
 * Implements the SPIN (Self-Play Fine-Tuning) approach where the model
 * plays against its previous iteration. The current model generates
 * responses on the same prompts as the previous model, and DPO loss
 * trains it to prefer its own responses over the previous version's.
 *
 * This creates a continuous improvement loop that doesn't require new
 * human-labeled data — the model's own improvement trajectory becomes
 * the training signal.
 *
 * Lifecycle:
 *   1. Store previous iteration's adapter
 *   2. Generate response pairs on benchmark prompts
 *   3. Build DPO training data (current=chosen, previous=rejected)
 *   4. Train with DPO loss
 *   5. Evaluate improvement with statistical significance test
 *   6. Promote only if statistically significant improvement
 *
 * See docs/roadmap.md Tier 3, Item 10.
 * Reference: Chen et al. (2024) "Self-Play Fine-Tuning Converts
 *   Weak Language Models to Strong Language Models"
 */

import { readFile, writeFile, mkdir, access, copyFile, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { getTracer } from '../debug.js';
import type { PreferencePair } from './training-extractor.js';
import type { LoraTrainer, BenchmarkTask, LoraTrainingParams } from './lora-trainer.js';
import type { MlxLoraTrainer, TrainingResult } from './mlx-lora-trainer.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Configuration for SPIN self-play training.
 */
export interface SpinConfig {
  /** Path to store SPIN state and iterations */
  spinPath: string;

  /** Maximum SPIN iterations per dream cycle (default: 2) */
  maxIterationsPerCycle: number;

  /** Minimum benchmarks required to run SPIN (default: 5) */
  minBenchmarksRequired: number;

  /** Number of prompts to generate per iteration (default: 20) */
  promptsPerIteration: number;

  /** P-value threshold for statistical significance (default: 0.05) */
  significanceThreshold: number;

  /** Minimum score improvement to consider (default: 0.02 = 2%) */
  minScoreImprovement: number;

  /** DPO training parameters */
  dpoParams: LoraTrainingParams;
}

/**
 * A SPIN iteration record.
 */
export interface SpinIteration {
  /** Iteration number (0-indexed) */
  iteration: number;

  /** When this iteration was run */
  timestamp: string;

  /** Skill domain */
  skill: string;

  /** Path to the previous adapter */
  previousAdapterPath: string;

  /** Path to the new adapter */
  newAdapterPath: string;

  /** Scores from previous model */
  previousScores: number[];

  /** Scores from current model */
  currentScores: number[];

  /** Mean improvement (current - previous) */
  meanImprovement: number;

  /** P-value from Wilcoxon signed-rank test */
  pValue: number;

  /** Whether the improvement was statistically significant */
  significant: boolean;

  /** Whether the new adapter was promoted */
  promoted: boolean;

  /** Training result */
  trainingResult: TrainingResult | null;

  /** Number of DPO pairs generated */
  dpoPairsGenerated: number;
}

/**
 * Persistent state for SPIN across dream cycles.
 */
export interface SpinState {
  /** All iterations run across dream cycles */
  iterations: SpinIteration[];

  /** Current iteration count per skill */
  iterationCounts: Record<string, number>;

  /** When the state was last updated */
  lastUpdated: string;

  /** Total iterations run */
  totalIterations: number;

  /** Total successful promotions */
  totalPromotions: number;
}

/**
 * A response pair generated during self-play.
 */
export interface ResponsePair {
  /** The prompt that was given */
  prompt: string;

  /** Response from the current model */
  currentResponse: string;

  /** Response from the previous model */
  previousResponse: string;

  /** Score assigned to current response (0-1) */
  currentScore: number;

  /** Score assigned to previous response (0-1) */
  previousScore: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: SpinConfig = {
  spinPath: '~/.casterly/spin',
  maxIterationsPerCycle: 2,
  minBenchmarksRequired: 5,
  promptsPerIteration: 20,
  significanceThreshold: 0.05,
  minScoreImprovement: 0.02,
  dpoParams: {
    rank: 16,
    alpha: 32,
    targetModules: ['q_proj', 'v_proj'],
    learningRate: 0.00005,
    epochs: 2,
    batchSize: 4,
    format: 'preference_dpo',
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// SPIN Trainer
// ─────────────────────────────────────────────────────────────────────────────

export class SpinTrainer {
  private readonly config: SpinConfig;
  private state: SpinState;
  private dirty = false;

  constructor(config?: Partial<SpinConfig>) {
    this.config = {
      ...DEFAULT_CONFIG,
      ...config,
      // Deep merge dpoParams to preserve nested defaults
      dpoParams: { ...DEFAULT_CONFIG.dpoParams, ...config?.dpoParams },
    };
    this.state = {
      iterations: [],
      iterationCounts: {},
      lastUpdated: new Date().toISOString(),
      totalIterations: 0,
      totalPromotions: 0,
    };
  }

  // ── Persistence ─────────────────────────────────────────────────────────

  /**
   * Load SPIN state from disk.
   */
  async load(): Promise<void> {
    const resolvedPath = this.resolvePath(join(this.config.spinPath, 'state.json'));

    try {
      const content = await readFile(resolvedPath, 'utf8');
      const parsed = JSON.parse(content) as SpinState;
      if (parsed && Array.isArray(parsed.iterations)) {
        this.state = parsed;
      }
    } catch {
      // No existing state
    }
  }

  /**
   * Save SPIN state to disk.
   */
  async save(): Promise<void> {
    if (!this.dirty) return;

    const resolvedPath = this.resolvePath(join(this.config.spinPath, 'state.json'));
    await mkdir(dirname(resolvedPath), { recursive: true });
    await writeFile(resolvedPath, JSON.stringify(this.state, null, 2), 'utf8');
    this.dirty = false;
  }

  // ── Self-Play Logic ──────────────────────────────────────────────────

  /**
   * Check if SPIN can run for a given skill.
   *
   * Requirements:
   *   1. An active adapter exists for the skill (this becomes "previous")
   *   2. Sufficient benchmark tasks exist
   *   3. Haven't exceeded max iterations this cycle
   */
  canRunSpin(
    skill: string,
    loraTrainer: LoraTrainer,
  ): { canRun: boolean; reason: string } {
    const adapter = loraTrainer.getActiveAdapter(skill);
    if (!adapter) {
      return { canRun: false, reason: `No active adapter for skill: ${skill}` };
    }

    const benchmarks = loraTrainer.getBenchmarkTasks(skill);
    if (benchmarks.length < this.config.minBenchmarksRequired) {
      return {
        canRun: false,
        reason: `Insufficient benchmarks: ${benchmarks.length}/${this.config.minBenchmarksRequired}`,
      };
    }

    const iterCount = this.state.iterationCounts[skill] ?? 0;
    if (iterCount >= this.config.maxIterationsPerCycle) {
      return {
        canRun: false,
        reason: `Max iterations reached for this cycle: ${iterCount}/${this.config.maxIterationsPerCycle}`,
      };
    }

    return { canRun: true, reason: 'Ready for SPIN iteration' };
  }

  /**
   * Build DPO training pairs from response pairs.
   *
   * Current model's responses are "chosen", previous model's are "rejected".
   * Only includes pairs where the current model scored higher.
   */
  buildDPOPairs(responsePairs: ResponsePair[], skill: string): PreferencePair[] {
    const pairs: PreferencePair[] = [];

    for (const rp of responsePairs) {
      // Only create DPO pair if current model scored higher
      if (rp.currentScore > rp.previousScore) {
        pairs.push({
          id: `spin-${skill}-${pairs.length}`,
          skill,
          instruction: rp.prompt,
          chosen: rp.currentResponse,
          rejected: rp.previousResponse,
          chosenSourceId: 'spin-current',
          rejectedSourceId: 'spin-previous',
          extractedAt: new Date().toISOString(),
        });
      }
    }

    return pairs;
  }

  /**
   * Record a SPIN iteration result.
   */
  recordIteration(iteration: SpinIteration): void {
    this.state.iterations.push(iteration);
    this.state.totalIterations++;

    if (iteration.promoted) {
      this.state.totalPromotions++;
    }

    const currentCount = this.state.iterationCounts[iteration.skill] ?? 0;
    this.state.iterationCounts[iteration.skill] = currentCount + 1;

    this.state.lastUpdated = new Date().toISOString();
    this.dirty = true;
  }

  /**
   * Reset iteration counts for a new dream cycle.
   */
  resetCycleCounts(): void {
    this.state.iterationCounts = {};
    this.dirty = true;
  }

  // ── Statistical Testing ──────────────────────────────────────────────

  /**
   * Perform the Wilcoxon signed-rank test for paired samples.
   *
   * Tests whether the current model's scores are significantly
   * better than the previous model's scores. Returns a p-value.
   *
   * Uses a one-tailed test (H1: current > previous) with normal
   * approximation including tie correction and continuity correction.
   * For n < 5, returns conservative p=1.0 (insufficient data).
   */
  wilcoxonSignedRankTest(
    currentScores: number[],
    previousScores: number[],
  ): { pValue: number; significant: boolean } {
    if (currentScores.length !== previousScores.length) {
      throw new Error('Score arrays must have equal length');
    }

    const n = currentScores.length;
    if (n < 5) {
      // Too few samples for reliable inference
      return { pValue: 1.0, significant: false };
    }

    // Compute differences, discard zeros
    const diffs: Array<{ diff: number; absDiff: number }> = [];
    for (let i = 0; i < n; i++) {
      const diff = currentScores[i]! - previousScores[i]!;
      if (diff !== 0) {
        diffs.push({ diff, absDiff: Math.abs(diff) });
      }
    }

    if (diffs.length === 0) {
      return { pValue: 1.0, significant: false };
    }

    // Rank by absolute difference
    diffs.sort((a, b) => a.absDiff - b.absDiff);

    // Assign ranks (handle ties with average rank)
    const ranks = new Array(diffs.length).fill(0) as number[];
    const tieGroups: number[] = []; // sizes of tie groups for correction
    let i = 0;
    while (i < diffs.length) {
      let j = i;
      while (j < diffs.length && diffs[j]!.absDiff === diffs[i]!.absDiff) {
        j++;
      }
      const tieSize = j - i;
      if (tieSize > 1) {
        tieGroups.push(tieSize);
      }
      const avgRank = (i + j + 1) / 2; // Average of 1-indexed positions
      for (let k = i; k < j; k++) {
        ranks[k] = avgRank;
      }
      i = j;
    }

    // Compute W+ (sum of ranks where current > previous)
    let wPlus = 0;
    for (let idx = 0; idx < diffs.length; idx++) {
      if (diffs[idx]!.diff > 0) {
        wPlus += ranks[idx]!;
      }
    }

    const nr = diffs.length;
    const meanW = (nr * (nr + 1)) / 4;

    // Variance with tie correction
    let tieCorrection = 0;
    for (const t of tieGroups) {
      tieCorrection += (t * (t - 1) * (t + 1)) / 2;
    }
    const variance = ((nr * (nr + 1) * (2 * nr + 1)) - tieCorrection) / 24;
    const stdW = Math.sqrt(variance);

    if (stdW === 0) {
      return { pValue: 1.0, significant: false };
    }

    // One-tailed test: H1 is current > previous
    // Under H1, wPlus should be large. Use continuity correction.
    const z = (wPlus - meanW - 0.5) / stdW;
    // One-tailed p-value: P(Z > z) for the direction we care about
    const pValue = 1 - this.normalCDF(z);

    return {
      pValue,
      significant: pValue < this.config.significanceThreshold,
    };
  }

  /**
   * Check if improvement is both statistically significant and
   * practically meaningful.
   */
  isSignificantImprovement(
    currentScores: number[],
    previousScores: number[],
  ): { significant: boolean; pValue: number; meanImprovement: number } {
    // Check statistical significance
    const { pValue, significant } = this.wilcoxonSignedRankTest(
      currentScores,
      previousScores,
    );

    // Check practical significance (minimum score improvement)
    let totalImprovement = 0;
    for (let i = 0; i < currentScores.length; i++) {
      totalImprovement += currentScores[i]! - previousScores[i]!;
    }
    const meanImprovement = totalImprovement / currentScores.length;

    return {
      significant: significant && meanImprovement >= this.config.minScoreImprovement,
      pValue,
      meanImprovement,
    };
  }

  // ── Queries ───────────────────────────────────────────────────────────

  /**
   * Get the SPIN state.
   */
  getState(): Readonly<SpinState> {
    return this.state;
  }

  /**
   * Get iterations for a specific skill.
   */
  getIterationsForSkill(skill: string): SpinIteration[] {
    return this.state.iterations.filter((it) => it.skill === skill);
  }

  /**
   * Get the latest iteration for a skill.
   */
  getLatestIteration(skill: string): SpinIteration | undefined {
    const iterations = this.getIterationsForSkill(skill);
    return iterations.length > 0 ? iterations[iterations.length - 1] : undefined;
  }

  /**
   * Build a summary of SPIN state.
   */
  buildSummary(): string {
    const lines: string[] = [
      'SPIN Self-Play Summary',
      `Total iterations: ${this.state.totalIterations}`,
      `Total promotions: ${this.state.totalPromotions}`,
      `Promotion rate: ${this.state.totalIterations > 0
        ? ((this.state.totalPromotions / this.state.totalIterations) * 100).toFixed(1)
        : 0}%`,
    ];

    // Group by skill
    const bySkill = new Map<string, SpinIteration[]>();
    for (const it of this.state.iterations) {
      const list = bySkill.get(it.skill) ?? [];
      list.push(it);
      bySkill.set(it.skill, list);
    }

    if (bySkill.size > 0) {
      lines.push('');
      for (const [skill, iterations] of bySkill) {
        const promoted = iterations.filter((it) => it.promoted).length;
        const latest = iterations[iterations.length - 1]!;
        lines.push(`  ${skill}: ${iterations.length} iterations, ${promoted} promoted`);
        lines.push(`    Latest: improvement=${(latest.meanImprovement * 100).toFixed(1)}%, p=${latest.pValue.toFixed(4)}`);
      }
    }

    return lines.join('\n');
  }

  // ── Private Helpers ──────────────────────────────────────────────────

  /**
   * Standard normal cumulative distribution function.
   * Uses Horner's method approximation (Abramowitz & Stegun).
   */
  private normalCDF(x: number): number {
    const a1 = 0.254829592;
    const a2 = -0.284496736;
    const a3 = 1.421413741;
    const a4 = -1.453152027;
    const a5 = 1.061405429;
    const p = 0.3275911;

    const sign = x < 0 ? -1 : 1;
    x = Math.abs(x) / Math.SQRT2;

    const t = 1.0 / (1.0 + p * x);
    const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);

    return 0.5 * (1.0 + sign * y);
  }

  private resolvePath(path: string): string {
    return path.replace(/^~/, process.env['HOME'] ?? '~');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────────────────────

export function createSpinTrainer(
  config?: Partial<SpinConfig>,
): SpinTrainer {
  return new SpinTrainer(config);
}
