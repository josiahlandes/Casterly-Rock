/**
 * Tasks Module
 *
 * Task management system for classifying, planning, executing,
 * and verifying user tasks.
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

// Operational memory
export type { ExecutionLog, ToolReliability } from './execution-log.js';
export { createExecutionLog } from './execution-log.js';
