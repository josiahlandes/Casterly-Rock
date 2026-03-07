/**
 * AutoHarness Types
 *
 * Type definitions for the AutoHarness system, inspired by:
 *   "AutoHarness: improving LLM agents by automatically synthesizing
 *    a code harness" (Lou et al., 2026, arXiv:2603.03329)
 *
 * The harness system wraps tool execution with auto-synthesized validation
 * code that prevents invalid actions. Three harness modes are supported:
 *
 *   1. action-verifier: Validates a proposed tool call and rejects invalid ones.
 *      The LLM retries with feedback when a call is rejected.
 *
 *   2. action-filter: Produces a set of legal actions for a given state.
 *      The LLM picks from the filtered set.
 *
 *   3. policy: Pure-code harness that selects the action without LLM involvement.
 *      Used when a deterministic strategy suffices (e.g., structured transforms).
 *
 * Harnesses are iteratively refined via execution feedback: when a tool call
 * fails or produces an invalid result, the failure is fed back to the LLM to
 * synthesize a better harness.
 */

// ─── Harness Mode ────────────────────────────────────────────────────────────

/** The three harness strategies from the AutoHarness paper. */
export type HarnessMode = 'action-verifier' | 'action-filter' | 'policy';

// ─── Harness Definition ──────────────────────────────────────────────────────

/**
 * A harness definition persisted on disk.
 *
 * The `validationCode` is a self-contained JavaScript function body that
 * receives a context object and returns a validation result. It is evaluated
 * in a sandboxed scope — no access to `process`, `require`, or the network.
 */
export interface HarnessDefinition {
  /** Unique identifier for this harness */
  id: string;

  /** Human-readable name */
  name: string;

  /** Which tool this harness constrains (or '*' for all tools) */
  toolName: string;

  /** Harness strategy */
  mode: HarnessMode;

  /**
   * The validation function body as a string.
   *
   * For action-verifier mode, signature is:
   *   (ctx: HarnessContext) => HarnessVerdict
   *
   * For action-filter mode, signature is:
   *   (ctx: HarnessContext) => FilteredActions
   *
   * For policy mode, signature is:
   *   (ctx: HarnessContext) => PolicyAction
   */
  validationCode: string;

  /** When this harness was created */
  createdAt: string;

  /** When this harness was last refined */
  updatedAt: string;

  /** How many refinement iterations this harness has been through */
  refinementCount: number;

  /** How many times this harness has been evaluated */
  evaluationCount: number;

  /** How many times this harness has blocked an invalid action */
  blockCount: number;

  /** Whether the harness is currently active */
  enabled: boolean;

  /** LLM-authored notes about what this harness guards against */
  description: string;

  /** Version number (incremented on each refinement) */
  version: number;
}

// ─── Harness Execution Context ───────────────────────────────────────────────

/**
 * Context passed to a harness validation function.
 */
export interface HarnessContext {
  /** The tool being called */
  toolName: string;

  /** The structured input to the tool */
  toolInput: Record<string, unknown>;

  /** Recent tool call history (last N calls) for pattern detection */
  recentCalls: RecentToolCall[];

  /** Current agent turn number (for budget-aware checks) */
  turnNumber: number;

  /** Available tool names for filter mode */
  availableTools: string[];
}

/**
 * A recent tool call for history-based validation.
 */
export interface RecentToolCall {
  toolName: string;
  input: Record<string, unknown>;
  success: boolean;
  timestamp: string;
}

// ─── Harness Verdicts ────────────────────────────────────────────────────────

/**
 * Result of an action-verifier harness evaluation.
 */
export interface HarnessVerdict {
  /** Whether the action is allowed */
  allowed: boolean;

  /** Why the action was blocked (when allowed is false) */
  reason: string;

  /** Optional suggested fix for the LLM to retry with */
  suggestedFix?: string;
}

/**
 * Result of an action-filter harness evaluation.
 */
export interface FilteredActions {
  /** The set of allowed tool names */
  allowedTools: string[];

  /** Per-tool constraints on inputs (key = tool name) */
  inputConstraints: Record<string, Record<string, unknown>>;

  /** Explanation of the filtering logic */
  reason: string;
}

/**
 * Result of a policy harness evaluation.
 */
export interface PolicyAction {
  /** The tool to call */
  toolName: string;

  /** The input for the tool */
  toolInput: Record<string, unknown>;

  /** Explanation of why this action was chosen */
  reason: string;
}

// ─── Refinement ──────────────────────────────────────────────────────────────

/**
 * A failure record used to refine a harness.
 */
export interface HarnessFailure {
  /** The harness that was evaluated */
  harnessId: string;

  /** The tool call that caused the failure */
  toolName: string;
  toolInput: Record<string, unknown>;

  /** What went wrong */
  errorType: 'execution_error' | 'invalid_output' | 'false_positive' | 'false_negative';

  /** Error details */
  errorMessage: string;

  /** The tool result that exposed the issue */
  toolResult?: {
    success: boolean;
    output?: string;
    error?: string;
  };

  /** Timestamp */
  timestamp: string;
}

/**
 * Request to refine a harness based on collected failures.
 */
export interface RefinementRequest {
  /** The current harness definition */
  current: HarnessDefinition;

  /** Failures collected since last refinement */
  failures: HarnessFailure[];

  /** Maximum number of refinement iterations to attempt */
  maxIterations: number;
}

/**
 * Result of a refinement attempt.
 */
export interface RefinementResult {
  /** Whether refinement succeeded */
  success: boolean;

  /** The updated harness (if successful) */
  updated?: HarnessDefinition;

  /** How many iterations were needed */
  iterationsUsed: number;

  /** Explanation of what changed */
  changelog: string;
}

// ─── Harness Metrics ─────────────────────────────────────────────────────────

/**
 * Runtime metrics for a harness.
 */
export interface HarnessMetrics {
  /** Total evaluations */
  totalEvaluations: number;

  /** Times the harness blocked an action */
  blockedActions: number;

  /** Times the harness allowed an action that later failed */
  falseNegatives: number;

  /** Times the harness blocked an action that was actually valid */
  falsePositives: number;

  /** Average evaluation time in milliseconds */
  avgEvaluationMs: number;

  /** Precision: blockedActions / (blockedActions + falsePositives) */
  precision: number;

  /** Recall: blockedActions / (blockedActions + falseNegatives) */
  recall: number;
}
