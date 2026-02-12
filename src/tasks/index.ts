/**
 * Tasks Module
 *
 * Task management system for classifying, planning, executing,
 * and verifying user tasks.
 *
 * Pipeline: classifier → planner → runner → verifier → manager
 */

// Shared types
export type {
  TaskClass,
  ClassificationResult,
  TaskPlan,
  TaskStep,
  Verification,
  StepOutcome,
  TaskRunResult,
  ExecutionRecord,
} from './types.js';

// Classifier
export { classifyMessage } from './classifier.js';

// Planner
export { createTaskPlan } from './planner.js';

// Runner
export type { TaskRunnerOptions } from './runner.js';
export { runTaskPlan } from './runner.js';

// Verifier
export type { VerificationResult } from './verifier.js';
export { verifyStepOutcome, verifyTaskOutcome } from './verifier.js';

// Manager (top-level entry point)
export type { TaskManagerOptions, TaskHandleResult, TaskManager } from './manager.js';
export { createTaskManager } from './manager.js';

// Operational memory
export type { ExecutionLog, ToolReliability } from './execution-log.js';
export { createExecutionLog } from './execution-log.js';
