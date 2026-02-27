/**
 * Context Tiers — Dynamic num_ctx selection for the dual-loop architecture.
 *
 * Each loop selects a context tier (compact/standard/extended) per-operation.
 * The tier maps to a specific num_ctx value passed to Ollama for KV cache
 * allocation. This replaces a fixed num_ctx with operation-aware sizing.
 *
 * Design principles:
 *   - Tier selection is deterministic: based on operation type or measured
 *     prompt size, never on runtime prediction.
 *   - FastLoop and Coder use independent calls (no KV reuse), so per-call
 *     resizing is free.
 *   - DeepLoop uses multi-turn ReAct (KV reuse across turns), so the tier
 *     is set once at task start and never changed mid-task.
 *
 * See docs/dual-loop-architecture.md Section 28.
 */

import type { Task } from './task-board-types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The three context tiers, from smallest to largest KV cache allocation.
 */
export type ContextTier = 'compact' | 'standard' | 'extended';

/**
 * Per-model context tier configuration. Values are in tokens.
 * Invariant: compact <= standard <= extended.
 */
export interface ContextTierConfig {
  compact: number;
  standard: number;
  extended: number;
}

/**
 * Extended config for the FastLoop's tier selection.
 */
export interface FastTierConfig extends ContextTierConfig {
  /** Diffs with more lines than this use the 'extended' tier for review */
  reviewLargeThresholdLines: number;
}

/**
 * Extended config for the DeepLoop's tier selection.
 */
export interface DeepTierConfig extends ContextTierConfig {
  /** Log a warning when token usage exceeds this fraction of num_ctx */
  contextPressureWarningThreshold: number;
}

/**
 * Extended config for the Coder's tier selection.
 */
export interface CoderTierConfig extends ContextTierConfig {
  /** Tokens reserved for response generation (added to prompt estimate) */
  responseBufferTokens: number;
}

/**
 * Full context tiers configuration for all three models.
 */
export interface ContextTiersConfig {
  fast: FastTierConfig;
  deep: DeepTierConfig;
  coder: CoderTierConfig;
}

/**
 * Operations the FastLoop performs, used for deterministic tier selection.
 */
export type FastOperation =
  | 'triage'
  | 'acknowledge'
  | 'voice_filter'
  | 'direct_answer'
  | 'status_report'
  | 'review_small'
  | 'review_large'
  | 'batched_triage'
  | 'deliver_response';

// ─────────────────────────────────────────────────────────────────────────────
// Default Configuration
// ─────────────────────────────────────────────────────────────────────────────

export const DEFAULT_CONTEXT_TIERS: ContextTiersConfig = {
  fast: {
    compact: 4096,
    standard: 12288,
    extended: 24576,
    reviewLargeThresholdLines: 150,
  },
  deep: {
    compact: 8192,
    standard: 24576,
    extended: 40960,
    contextPressureWarningThreshold: 0.80,
  },
  coder: {
    compact: 8192,
    standard: 16384,
    extended: 32768,
    responseBufferTokens: 2000,
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Tier Selection Functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Select the context tier for a FastLoop operation.
 * Deterministic — based solely on operation type.
 */
export function selectFastTier(operation: FastOperation): ContextTier {
  switch (operation) {
    case 'triage':
    case 'acknowledge':
    case 'voice_filter':
    case 'deliver_response':
      return 'compact';

    case 'direct_answer':
    case 'status_report':
    case 'review_small':
      return 'standard';

    case 'review_large':
    case 'batched_triage':
      return 'extended';

    default: {
      // Exhaustive check — compile-time error if a new operation is added
      // without updating this switch.
      const _exhaustive: never = operation;
      void _exhaustive;
      return 'standard';
    }
  }
}

/**
 * Select the context tier for a DeepLoop task.
 * Set once at task start — never changed mid-ReAct-loop.
 */
export function selectDeepTier(task: Task): ContextTier {
  // Resumed parked tasks had significant context built up.
  if (task.parkedState) {
    return 'extended';
  }

  const stepCount = task.planSteps?.length ?? 0;

  // Multi-file tasks need room for file contents + tool results + reasoning
  if (stepCount > 3) return 'extended';
  if (stepCount > 1) return 'standard';

  // Default to standard for safety margin — even single-step tasks involve
  // file reads, tool calls, and multi-turn reasoning.
  return 'standard';
}

/**
 * Select the context tier for a Coder dispatch.
 * Based on measured prompt content — not prediction.
 */
export function selectCoderTier(
  promptLengthChars: number,
  config: CoderTierConfig,
): ContextTier {
  const estimatedTokens = Math.ceil(promptLengthChars / 3.5);
  const withBuffer = estimatedTokens + config.responseBufferTokens;

  if (withBuffer < config.compact * 0.75) return 'compact';
  if (withBuffer < config.standard * 0.75) return 'standard';
  return 'extended';
}

/**
 * Determine which review tier to use based on diff line count.
 */
export function selectReviewTier(
  diffLines: number,
  config: FastTierConfig,
): 'review_small' | 'review_large' {
  return diffLines >= config.reviewLargeThresholdLines
    ? 'review_large'
    : 'review_small';
}

// ─────────────────────────────────────────────────────────────────────────────
// Resolution
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve a context tier to its num_ctx value.
 */
export function resolveNumCtx(
  tiers: ContextTierConfig,
  tier: ContextTier,
): number {
  return tiers[tier];
}

/**
 * Build providerOptions with the resolved num_ctx for a given tier.
 * Convenience for passing into GenerateRequest.providerOptions.
 */
export function buildProviderOptions(
  tiers: ContextTierConfig,
  tier: ContextTier,
): Record<string, unknown> {
  return { num_ctx: resolveNumCtx(tiers, tier) };
}

/**
 * Estimate tokens from character count (conservative: ~3.5 chars/token).
 * Shared utility used by tier selection and budget tracking.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}
