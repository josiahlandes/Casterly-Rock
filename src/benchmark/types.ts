/**
 * Benchmark Types (ISSUE-008)
 *
 * Foundation types for the model benchmarking framework.
 * BenchmarkCase extends TestCase with difficulty, category, and scoring metadata.
 *
 * v2 adds agent-oriented categories and scoring dimensions for the
 * unified agent loop architecture (reasoning, delegation, tool selection).
 */

import type { TestCase, ExpectedOutcome } from '../testing/test-cases.js';

// ─── Difficulty & Category ───────────────────────────────────────────────────

export type BenchmarkDifficulty = 'trivial' | 'simple' | 'moderate' | 'complex' | 'expert';

/** v1 + v2 categories. v2 adds reasoning, delegation, tool_selection. */
export type BenchmarkCategory =
  | 'conversation'
  | 'tool_use'
  | 'planning'
  | 'coding'
  | 'safety'
  | 'knowledge'
  | 'multi_step'
  // v2: Agent architecture categories
  | 'reasoning'
  | 'delegation'
  | 'tool_selection';

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
  /** v2: Expected tool names the model should prefer (for tool selection scoring) */
  preferredTools?: string[] | undefined;
  /** v2: Tools the model should avoid for this case */
  avoidTools?: string[] | undefined;
  /** v2: Whether the model should reason (think tool) before acting */
  shouldReason?: boolean | undefined;
  /** v2: Whether the model should delegate to another model */
  shouldDelegate?: boolean | undefined;
  /** v2: Multi-turn conversation metadata */
  multiTurn?: MultiTurnMeta | undefined;
  /** v2: Expected argument patterns for tool calls (for argument correctness scoring) */
  expectedArgs?: Record<string, Record<string, unknown>> | undefined;
}

// ─── Multi-Turn ─────────────────────────────────────────────────────────────

export interface MultiTurnMeta {
  /** Position in the multi-turn sequence (0-based) */
  turnIndex: number;
  /** Shared ID linking turns in the same conversation */
  sequenceId: string;
  /** The follow-up prompt for the next turn */
  followUp: string;
  /** Expected outcome for the follow-up turn */
  followUpExpected: ExpectedOutcome;
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
  /** v2: Did the model use the preferred tools? (0-1) */
  toolSelectionScore?: number | undefined;
  /** v2: Did the model reason before acting? (0 or 1) */
  reasoningScore?: number | undefined;
  /** v2: Did the model correctly decide whether to delegate? (0 or 1) */
  delegationScore?: number | undefined;
  /** v2: LLM-as-judge quality score (0-10) */
  qualityScore?: number | undefined;
  /** v2: Tool argument correctness score (0-1) */
  argCorrectnessScore?: number | undefined;
  /** v2: Whether this is a warm-start benchmark run */
  warmStart?: boolean | undefined;
  /** v2: Memory footprint in bytes at time of measurement */
  vramBytes?: number | undefined;
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
  /** v2: Agent-oriented dimension averages (only present for v2 suites) */
  toolSelectionAvg?: number | undefined;
  reasoningAvg?: number | undefined;
  delegationAvg?: number | undefined;
  /** v2: LLM-as-judge quality average (0-10) */
  qualityAvg?: number | undefined;
  /** v2: Tool argument correctness average (0-1) */
  argCorrectnessAvg?: number | undefined;
  /** v2: VRAM footprint in bytes for the benchmarked model */
  vramBytes?: number | undefined;
  /** v2: Whether the run was warm-start */
  warmStart?: boolean | undefined;
}

// ─── Scoring Profiles ────────────────────────────────────────────────────────

/**
 * Scoring weights that can be tuned per suite. v1 uses the original weights,
 * v2 shifts weight toward reasoning and tool selection.
 */
export interface ScoringProfile {
  structural: number;
  toolEfficiency: number;
  performance: number;
  /** v2 dimensions — ignored when not present in results */
  toolSelection: number;
  reasoning: number;
  delegation: number;
  /** v2: LLM-as-judge quality weight — ignored when not evaluated */
  quality: number;
  /** v2: Tool argument correctness weight */
  argCorrectness: number;
}

export const V1_SCORING_PROFILE: ScoringProfile = {
  structural: 0.40,
  toolEfficiency: 0.30,
  performance: 0.30,
  toolSelection: 0,
  reasoning: 0,
  delegation: 0,
  quality: 0,
  argCorrectness: 0,
};

export const V2_SCORING_PROFILE: ScoringProfile = {
  structural: 0.20,
  toolEfficiency: 0.10,
  performance: 0.05,
  toolSelection: 0.15,
  reasoning: 0.15,
  delegation: 0.10,
  quality: 0.15,
  argCorrectness: 0.10,
};

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
