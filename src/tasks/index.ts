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

// Tool parameter registry (shared between planner and runner)
export { TOOL_REQUIRED_PARAMS } from './tool-params.js';

// Classifier
export { classifyMessage } from './classifier.js';

// Planner
export { createTaskPlan } from './planner.js';

// Runner
export { runTaskPlan } from './runner.js';

// Verifier
export { verifyStepOutcome, verifyTaskOutcome } from './verifier.js';

// Manager (top-level entry point)
export type { TaskManager } from './manager.js';
export { createTaskManager } from './manager.js';

// Operational memory
export type { ExecutionLog } from './execution-log.js';
export { createExecutionLog } from './execution-log.js';
