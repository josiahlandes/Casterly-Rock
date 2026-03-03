/**
 * Dual-Loop Architecture — Public API
 *
 * Re-exports all types and classes for the dual-loop system.
 * Import from 'src/dual-loop/index.js' for clean access.
 */

// ── Task Board Types ──────────────────────────────────────────────────────────

export type {
  Task,
  TaskStatus,
  TaskOrigin,
  TaskOwner,
  TaskClassification,
  ReviewResult,
  PlanStep,
  TaskArtifact,
  ParkedState,
  CreateTaskOptions,
  UpdateTaskFields,
  TaskBoardConfig,
} from './task-board-types.js';

// ── Task Board ────────────────────────────────────────────────────────────────

export { TaskBoard, createTaskBoard } from './task-board.js';

// ── Context Tiers ─────────────────────────────────────────────────────────────

export type {
  ContextTier,
  ContextTierConfig,
  FastTierConfig,
  DeepTierConfig,
  CoderTierConfig,
  ContextTiersConfig,
  FastOperation,
} from './context-tiers.js';

export {
  selectFastTier,
  selectDeepTier,
  selectCoderTier,
  selectReviewTier,
  resolveNumCtx,
  buildProviderOptions,
  estimateTokens,
  DEFAULT_CONTEXT_TIERS,
} from './context-tiers.js';

// ── Fast Loop ─────────────────────────────────────────────────────────────────

export { FastLoop, createFastLoop } from './fast-loop.js';
export type { FastLoopConfig, DeliverFn } from './fast-loop.js';

// ── Deep Loop ─────────────────────────────────────────────────────────────────

export { DeepLoop, createDeepLoop } from './deep-loop.js';
export type { DeepLoopConfig } from './deep-loop.js';

// ── Coordinator ───────────────────────────────────────────────────────────────

export { LoopCoordinator, createLoopCoordinator } from './coordinator.js';
export type {
  CoordinatorConfig,
  CoordinatorHealth,
  LoopHealth,
} from './coordinator.js';

// ── Triage Prompts ────────────────────────────────────────────────────────────

export {
  TRIAGE_SYSTEM_PROMPT,
  buildTriagePrompt,
  parseTriageResponse,
} from './triage-prompt.js';
export type { TriageResult } from './triage-prompt.js';

// ── Review Prompts ────────────────────────────────────────────────────────────

export {
  REVIEW_SYSTEM_PROMPT,
  buildReviewPrompt,
  countDiffLines,
  parseReviewResponse,
} from './review-prompt.js';
export type { ReviewOutcome } from './review-prompt.js';

// ── Fast Tools ────────────────────────────────────────────────────────────────

export {
  buildFastToolSchemas,
  buildFastToolkit,
  executeFastTool,
} from './fast-tools.js';
export type { FastToolContext, FastTool } from './fast-tools.js';

// ── Dual-Loop Controller ─────────────────────────────────────────────────────

export { createDualLoopController } from './dual-loop-controller.js';
export type { DualLoopControllerOptions } from './dual-loop-controller.js';

// ── Deep Loop Events & Goals ─────────────────────────────────────────────────

export {
  drainEventsToTasks,
  checkGoalStack,
  runIdleCheck,
  describeEvent,
  eventToOrigin,
  goalToTaskDescription,
  DEFAULT_EVENT_CONFIG,
} from './deep-loop-events.js';
export type {
  DeepLoopEventConfig,
  IdleCheckResult,
} from './deep-loop-events.js';

// ── Runtime Config ───────────────────────────────────────────────────────────

export { parseDualLoopRuntimeConfig } from './config.js';
export type { DualLoopRuntimeConfig } from './config.js';
