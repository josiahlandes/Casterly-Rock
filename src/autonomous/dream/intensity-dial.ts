/**
 * Intensity Dial — Single-Parameter Dream Cycle Configuration
 *
 * Inspired by nanochat's `--depth` parameter that derives all hyperparameters
 * from a single integer, the Intensity Dial lets users set one number (1-10)
 * and all dream cycle settings are auto-derived via power-law relationships.
 *
 * The dial controls:
 *   - Dream cycle frequency (intervalHours)
 *   - Minimum idle before dreaming (minIdleBeforeDreamSeconds)
 *   - Exploration budget (turns)
 *   - Challenge budget (count)
 *   - Autoresearch experiments per cycle
 *   - Prompt evolution population size
 *   - Time budget per dream phase (seconds)
 *
 * Scaling philosophy:
 *   - intensity=1: "whisper" — barely there, once every 72h, minimal budgets
 *   - intensity=5: "balanced" — daily cycles, moderate exploration
 *   - intensity=10: "obsessive" — every 4h, aggressive self-improvement
 *
 * Privacy: Pure computation, no external calls.
 */

import type { DreamSchedulerConfig } from '../../dual-loop/dream-scheduler.js';
import type { DreamCycleConfig } from './runner.js';
import type { AutoresearchConfig } from './autoresearch.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** The full set of derived settings from the intensity dial. */
export interface IntensityDerivedSettings {
  /** The input intensity (1-10) */
  intensity: number;

  /** Dream scheduler settings */
  scheduler: Partial<DreamSchedulerConfig>;

  /** Dream cycle runner settings */
  dream: Partial<DreamCycleConfig>;

  /** Autoresearch settings */
  autoresearch: Partial<AutoresearchConfig>;

  /** Challenge budget per cycle */
  challengeBudget: number;

  /** Prompt evolution population size */
  promptPopulationSize: number;

  /** Time budget per dream phase in seconds */
  phaseBudgetSeconds: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Reference Point (intensity=5)
// All other values are derived from scaling around this reference.
// ─────────────────────────────────────────────────────────────────────────────

const REF_INTENSITY = 5;

const REF_VALUES = {
  intervalHours: 24,
  minIdleSeconds: 300,
  explorationBudgetTurns: 50,
  challengeBudget: 20,
  autoresearchExperiments: 3,
  promptPopulationSize: 8,
  phaseBudgetSeconds: 300,
  consolidationIntervalHours: 24,
  selfModelRebuildIntervalHours: 48,
  archaeologyLookbackDays: 90,
  retrospectiveIntervalDays: 7,
};

// ─────────────────────────────────────────────────────────────────────────────
// Scaling Functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Power-law scaling relative to the reference intensity.
 *
 * For values that should DECREASE with higher intensity (e.g., interval),
 * use a negative exponent.
 *
 * For values that should INCREASE with higher intensity (e.g., budget),
 * use a positive exponent.
 */
function powerScale(
  refValue: number,
  intensity: number,
  exponent: number,
): number {
  const ratio = intensity / REF_INTENSITY;
  return refValue * Math.pow(ratio, exponent);
}

/**
 * Clamp a value to [min, max] and optionally round to integer.
 */
function clampInt(value: number, min: number, max: number): number {
  return Math.round(Math.max(min, Math.min(max, value)));
}

function clampFloat(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

// ─────────────────────────────────────────────────────────────────────────────
// Intensity Dial
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Derive all dream cycle settings from a single intensity parameter.
 *
 * @param intensity - Integer from 1 to 10 (clamped if out of range)
 * @returns Complete set of derived settings
 */
export function deriveFromIntensity(intensity: number): IntensityDerivedSettings {
  // Clamp intensity to [1, 10]
  const i = clampInt(intensity, 1, 10);

  // ── Scheduler settings ─────────────────────────────────────────────────
  // Higher intensity → shorter intervals (inverse scaling)
  const intervalHours = clampFloat(
    powerScale(REF_VALUES.intervalHours, i, -1.2),
    4,   // min: every 4 hours at intensity 10
    72,  // max: every 3 days at intensity 1
  );

  // Higher intensity → less idle time required
  const minIdleSeconds = clampInt(
    powerScale(REF_VALUES.minIdleSeconds, i, -0.8),
    60,    // min: 1 minute
    1800,  // max: 30 minutes
  );

  // ── Dream cycle settings ───────────────────────────────────────────────
  // Higher intensity → more exploration
  const explorationBudgetTurns = clampInt(
    powerScale(REF_VALUES.explorationBudgetTurns, i, 0.7),
    10,   // min turns
    200,  // max turns
  );

  const consolidationIntervalHours = clampFloat(
    powerScale(REF_VALUES.consolidationIntervalHours, i, -1.0),
    4,
    72,
  );

  const selfModelRebuildIntervalHours = clampFloat(
    powerScale(REF_VALUES.selfModelRebuildIntervalHours, i, -0.8),
    12,
    168, // 1 week
  );

  const archaeologyLookbackDays = clampInt(
    powerScale(REF_VALUES.archaeologyLookbackDays, i, 0.5),
    30,
    365,
  );

  const retrospectiveIntervalDays = clampInt(
    powerScale(REF_VALUES.retrospectiveIntervalDays, i, -0.6),
    1,
    30,
  );

  // ── Autoresearch settings ──────────────────────────────────────────────
  const autoresearchExperiments = clampInt(
    powerScale(REF_VALUES.autoresearchExperiments, i, 0.8),
    1,
    10,
  );

  // ── Challenge & Evolution settings ─────────────────────────────────────
  const challengeBudget = clampInt(
    powerScale(REF_VALUES.challengeBudget, i, 0.6),
    5,
    50,
  );

  const promptPopulationSize = clampInt(
    powerScale(REF_VALUES.promptPopulationSize, i, 0.5),
    4,
    16,
  );

  // ── Phase time budget ──────────────────────────────────────────────────
  const phaseBudgetSeconds = clampInt(
    powerScale(REF_VALUES.phaseBudgetSeconds, i, 0.8),
    60,
    1800,
  );

  return {
    intensity: i,
    scheduler: {
      intervalHours,
      minIdleBeforeDreamSeconds: minIdleSeconds,
    },
    dream: {
      consolidationIntervalHours,
      explorationBudgetTurns,
      selfModelRebuildIntervalHours,
      archaeologyLookbackDays,
      retrospectiveIntervalDays,
    },
    autoresearch: {
      maxExperimentsPerCycle: autoresearchExperiments,
      testTimeoutMs: clampInt(phaseBudgetSeconds * 1000, 30_000, 600_000),
    },
    challengeBudget,
    promptPopulationSize,
    phaseBudgetSeconds,
  };
}

/**
 * Format the derived settings as a human-readable summary.
 */
export function formatIntensitySummary(settings: IntensityDerivedSettings): string {
  const lines: string[] = [];
  lines.push(`Intensity Dial: ${settings.intensity}/10`);
  lines.push(`  Dream interval: ${settings.scheduler.intervalHours?.toFixed(1)}h`);
  lines.push(`  Min idle: ${settings.scheduler.minIdleBeforeDreamSeconds}s`);
  lines.push(`  Exploration budget: ${settings.dream.explorationBudgetTurns} turns`);
  lines.push(`  Phase budget: ${settings.phaseBudgetSeconds}s per phase`);
  lines.push(`  Challenge budget: ${settings.challengeBudget} per cycle`);
  lines.push(`  Prompt population: ${settings.promptPopulationSize} variants`);
  lines.push(`  Autoresearch: ${settings.autoresearch.maxExperimentsPerCycle} experiments/cycle`);
  return lines.join('\n');
}
