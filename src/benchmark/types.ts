/**
 * Benchmark Types (ISSUE-008)
 *
 * Foundation types for the model benchmarking framework.
 * BenchmarkCase extends TestCase with difficulty, category, and scoring metadata.
 */

import type { TestCase } from '../testing/test-cases.js';

// ─── Difficulty & Category ───────────────────────────────────────────────────

export type BenchmarkDifficulty = 'trivial' | 'simple' | 'moderate' | 'complex' | 'expert';

export type BenchmarkCategory =
  | 'conversation'
  | 'tool_use'
  | 'planning'
  | 'coding'
  | 'safety'
  | 'knowledge'
  | 'multi_step';

// ─── Benchmark Case ──────────────────────────────────────────────────────────

export interface BenchmarkCase extends TestCase {
  difficulty: BenchmarkDifficulty;
  category: BenchmarkCategory;
  /** Ideal number of tool calls for efficiency scoring */
  optimalToolCalls?: number | undefined;
  /** Instructions for LLM-as-judge scoring (Phase 2) */
  qualityRubric?: string | undefined;
  /** Relative importance, default 1.0 */
  weight?: number | undefined;
}

// ─── Per-Case Result ─────────────────────────────────────────────────────────

export interface CaseResult {
  caseId: string;
  passed: boolean;
  /** Fraction of structural checks passed (0-1) */
  structuralScore: number;
  /** Optimal tool calls / actual tool calls, capped at 1.0 */
  toolEfficiency: number;
  tokensInput: number;
  tokensOutput: number;
  /** Time to first token in ms (from prompt_eval_duration) */
  ttftMs: number;
  /** Total completion time in ms */
  totalMs: number;
  /** Tokens per second (eval_count / eval_duration) */
  evalRate: number;
  failures: string[];
}

// ─── Aggregate Score ─────────────────────────────────────────────────────────

export interface AggregateScore {
  /** Weighted composite score 0-100 */
  overall: number;
  structuralAvg: number;
  toolEfficiencyAvg: number;
  avgTtftMs: number;
  avgTotalMs: number;
  avgEvalRate: number;
  /** Fraction of cases that passed */
  passRate: number;
  byDifficulty: Record<string, { passed: number; total: number; avgScore: number }>;
  byCategory: Record<string, { passed: number; total: number; avgScore: number }>;
}

// ─── Benchmark Run ───────────────────────────────────────────────────────────

export interface BenchmarkRun {
  id: string;
  modelId: string;
  timestamp: number;
  suiteId: string;
  cases: CaseResult[];
  aggregate: AggregateScore;
}

// ─── Store Data ──────────────────────────────────────────────────────────────

export interface BenchmarkStoreData {
  version: 1;
  runs: BenchmarkRun[];
}
