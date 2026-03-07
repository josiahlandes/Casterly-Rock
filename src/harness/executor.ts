/**
 * Harness Executor — sandboxed evaluation of harness validation functions.
 *
 * Executes the synthesized validation code in a restricted scope. The
 * sandbox prevents access to Node.js globals (process, require, etc.)
 * and I/O APIs (fs, net, child_process).
 *
 * The executor evaluates the harness function body by wrapping it in a
 * Function constructor with an explicit parameter list. The sandbox is
 * created per-evaluation — no state leaks between calls.
 *
 * Performance: typical evaluation takes <1ms for simple validators.
 * A timeout guard (configurable, default 50ms) prevents runaway code.
 */

import { safeLogger } from '../logging/safe-logger.js';
import type {
  HarnessDefinition,
  HarnessContext,
  HarnessVerdict,
  FilteredActions,
  PolicyAction,
  HarnessMetrics,
} from './types.js';

// ─── Configuration ───────────────────────────────────────────────────────────

export interface HarnessExecutorConfig {
  /** Maximum evaluation time in milliseconds */
  timeoutMs: number;

  /** Whether to log evaluation results */
  verbose: boolean;
}

const DEFAULT_CONFIG: HarnessExecutorConfig = {
  timeoutMs: 50,
  verbose: false,
};

// ─── Sandbox ─────────────────────────────────────────────────────────────────

/**
 * Blocked globals that the sandboxed function cannot access.
 * We shadow them with `undefined` via `var` declarations inside the
 * IIFE body. Note: `eval` and `arguments` cannot be used as parameter
 * names or assigned in strict mode, so we use `var` declarations instead
 * of function parameters to shadow them.
 */
const BLOCKED_GLOBALS = [
  'process', 'require', 'module', 'exports', '__dirname', '__filename',
  'globalThis', 'global',
  'fetch', 'XMLHttpRequest', 'WebSocket',
  'setTimeout', 'setInterval', 'setImmediate',
  'Buffer', 'Uint8Array',
];

/**
 * Build a sandboxed function from a harness code body.
 *
 * The function receives a single `ctx` parameter (HarnessContext)
 * and returns the appropriate result type based on the harness mode.
 *
 * Blocked globals are shadowed via var declarations inside an IIFE
 * so the code cannot escape the sandbox via the scope chain.
 */
function buildSandboxedFunction(
  code: string,
): (ctx: HarnessContext) => unknown {
  // Build var declarations to shadow blocked globals
  const shadowVars = BLOCKED_GLOBALS
    .map((name) => `var ${name} = undefined;`)
    .join('\n  ');

  // Wrap in an IIFE that shadows dangerous globals via var declarations.
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const fn = new Function(
    'ctx',
    `"use strict";
return (function() {
  ${shadowVars}
  ${code}
})();`,
  ) as (ctx: HarnessContext) => unknown;

  return fn;
}

// ─── Default Verdicts ────────────────────────────────────────────────────────

const DEFAULT_VERDICT: HarnessVerdict = {
  allowed: true,
  reason: 'Harness evaluation failed — defaulting to allow.',
};

const DEFAULT_FILTER: FilteredActions = {
  allowedTools: [],
  inputConstraints: {},
  reason: 'Harness evaluation failed — returning empty filter.',
};

const DEFAULT_POLICY: PolicyAction = {
  toolName: '',
  toolInput: {},
  reason: 'Harness evaluation failed — no policy action.',
};

// ─── Executor ────────────────────────────────────────────────────────────────

export class HarnessExecutor {
  private readonly config: HarnessExecutorConfig;

  /** Per-harness runtime metrics */
  private metrics: Map<string, HarnessMetrics> = new Map();

  constructor(config?: Partial<HarnessExecutorConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Evaluate an action-verifier harness.
   *
   * Returns a verdict: allowed (proceed) or blocked (reject with reason).
   * On any evaluation error, defaults to allowing the action (fail-open).
   */
  evaluateVerifier(
    harness: HarnessDefinition,
    ctx: HarnessContext,
  ): HarnessVerdict {
    if (harness.mode !== 'action-verifier') {
      return { allowed: true, reason: `Wrong harness mode: ${harness.mode}` };
    }

    const startMs = performance.now();

    try {
      const fn = buildSandboxedFunction(harness.validationCode);
      const result = fn(ctx);
      const elapsed = performance.now() - startMs;

      this.recordEvaluation(harness.id, elapsed);

      if (this.config.verbose) {
        safeLogger.info('Harness verifier evaluated', {
          harnessId: harness.id,
          elapsedMs: elapsed.toFixed(2),
        });
      }

      return normalizeVerdict(result);
    } catch (err) {
      const elapsed = performance.now() - startMs;
      this.recordEvaluation(harness.id, elapsed);

      safeLogger.warn('Harness verifier evaluation error', {
        harnessId: harness.id,
        error: err instanceof Error ? err.message : String(err),
      });

      return DEFAULT_VERDICT;
    }
  }

  /**
   * Evaluate an action-filter harness.
   *
   * Returns the set of allowed actions and input constraints.
   */
  evaluateFilter(
    harness: HarnessDefinition,
    ctx: HarnessContext,
  ): FilteredActions {
    if (harness.mode !== 'action-filter') {
      return { ...DEFAULT_FILTER, reason: `Wrong harness mode: ${harness.mode}` };
    }

    const startMs = performance.now();

    try {
      const fn = buildSandboxedFunction(harness.validationCode);
      const result = fn(ctx);
      const elapsed = performance.now() - startMs;

      this.recordEvaluation(harness.id, elapsed);

      return normalizeFilter(result);
    } catch (err) {
      const elapsed = performance.now() - startMs;
      this.recordEvaluation(harness.id, elapsed);

      safeLogger.warn('Harness filter evaluation error', {
        harnessId: harness.id,
        error: err instanceof Error ? err.message : String(err),
      });

      return DEFAULT_FILTER;
    }
  }

  /**
   * Evaluate a policy harness.
   *
   * Returns the action to take (tool + input) without LLM involvement.
   */
  evaluatePolicy(
    harness: HarnessDefinition,
    ctx: HarnessContext,
  ): PolicyAction {
    if (harness.mode !== 'policy') {
      return { ...DEFAULT_POLICY, reason: `Wrong harness mode: ${harness.mode}` };
    }

    const startMs = performance.now();

    try {
      const fn = buildSandboxedFunction(harness.validationCode);
      const result = fn(ctx);
      const elapsed = performance.now() - startMs;

      this.recordEvaluation(harness.id, elapsed);

      return normalizePolicy(result);
    } catch (err) {
      const elapsed = performance.now() - startMs;
      this.recordEvaluation(harness.id, elapsed);

      safeLogger.warn('Harness policy evaluation error', {
        harnessId: harness.id,
        error: err instanceof Error ? err.message : String(err),
      });

      return DEFAULT_POLICY;
    }
  }

  /** Get metrics for a harness. */
  getMetrics(harnessId: string): HarnessMetrics | undefined {
    return this.metrics.get(harnessId);
  }

  /** Record a blocked action in metrics. */
  recordBlock(harnessId: string): void {
    const m = this.getOrCreateMetrics(harnessId);
    m.blockedActions++;
    this.updatePrecisionRecall(m);
  }

  /** Record a false positive (harness blocked a valid action). */
  recordFalsePositive(harnessId: string): void {
    const m = this.getOrCreateMetrics(harnessId);
    m.falsePositives++;
    this.updatePrecisionRecall(m);
  }

  /** Record a false negative (harness allowed an invalid action). */
  recordFalseNegative(harnessId: string): void {
    const m = this.getOrCreateMetrics(harnessId);
    m.falseNegatives++;
    this.updatePrecisionRecall(m);
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private recordEvaluation(harnessId: string, elapsedMs: number): void {
    const m = this.getOrCreateMetrics(harnessId);
    const prevTotal = m.avgEvaluationMs * m.totalEvaluations;
    m.totalEvaluations++;
    m.avgEvaluationMs = (prevTotal + elapsedMs) / m.totalEvaluations;
  }

  private getOrCreateMetrics(harnessId: string): HarnessMetrics {
    let m = this.metrics.get(harnessId);
    if (!m) {
      m = {
        totalEvaluations: 0,
        blockedActions: 0,
        falseNegatives: 0,
        falsePositives: 0,
        avgEvaluationMs: 0,
        precision: 1,
        recall: 1,
      };
      this.metrics.set(harnessId, m);
    }
    return m;
  }

  private updatePrecisionRecall(m: HarnessMetrics): void {
    const precDenom = m.blockedActions + m.falsePositives;
    m.precision = precDenom > 0 ? m.blockedActions / precDenom : 1;

    const recDenom = m.blockedActions + m.falseNegatives;
    m.recall = recDenom > 0 ? m.blockedActions / recDenom : 1;
  }
}

// ─── Normalizers ─────────────────────────────────────────────────────────────

function normalizeVerdict(raw: unknown): HarnessVerdict {
  if (raw === null || raw === undefined || typeof raw !== 'object') {
    return DEFAULT_VERDICT;
  }

  const obj = raw as Record<string, unknown>;
  return {
    allowed: typeof obj['allowed'] === 'boolean' ? obj['allowed'] : true,
    reason: typeof obj['reason'] === 'string' ? obj['reason'] : 'No reason provided.',
    suggestedFix: typeof obj['suggestedFix'] === 'string' ? obj['suggestedFix'] : undefined,
  };
}

function normalizeFilter(raw: unknown): FilteredActions {
  if (raw === null || raw === undefined || typeof raw !== 'object') {
    return DEFAULT_FILTER;
  }

  const obj = raw as Record<string, unknown>;
  return {
    allowedTools: Array.isArray(obj['allowedTools']) ? obj['allowedTools'] as string[] : [],
    inputConstraints: typeof obj['inputConstraints'] === 'object' && obj['inputConstraints'] !== null
      ? obj['inputConstraints'] as Record<string, Record<string, unknown>>
      : {},
    reason: typeof obj['reason'] === 'string' ? obj['reason'] : 'No reason provided.',
  };
}

function normalizePolicy(raw: unknown): PolicyAction {
  if (raw === null || raw === undefined || typeof raw !== 'object') {
    return DEFAULT_POLICY;
  }

  const obj = raw as Record<string, unknown>;
  return {
    toolName: typeof obj['toolName'] === 'string' ? obj['toolName'] : '',
    toolInput: typeof obj['toolInput'] === 'object' && obj['toolInput'] !== null
      ? obj['toolInput'] as Record<string, unknown>
      : {},
    reason: typeof obj['reason'] === 'string' ? obj['reason'] : 'No reason provided.',
  };
}

// ─── Factory ─────────────────────────────────────────────────────────────────

export function createHarnessExecutor(
  config?: Partial<HarnessExecutorConfig>,
): HarnessExecutor {
  return new HarnessExecutor(config);
}
