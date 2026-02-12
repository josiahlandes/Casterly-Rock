/**
 * Task System Types
 *
 * Shared types for the task management pipeline:
 * classifier → planner → runner → verifier
 *
 * These types are the foundation for ISSUE-002 (Task Manager)
 * and are used by ISSUE-005 (Operational Memory).
 */

// ─── Classification ──────────────────────────────────────────────────────────

/** How the classifier categorizes an incoming message */
export type TaskClass = 'conversation' | 'simple_task' | 'complex_task';

/** Result from the message classifier */
export interface ClassificationResult {
  /** What kind of message this is */
  taskClass: TaskClass;
  /** Classifier confidence 0-1 */
  confidence: number;
  /** Brief explanation of the classification */
  reason: string;
  /** Task category if applicable (e.g. 'calendar', 'file_operation', 'coding') */
  taskType?: string;
}

// ─── Planning ────────────────────────────────────────────────────────────────

/** Structured task plan — output of the planner, input to the runner */
export interface TaskPlan {
  /** What the user wants to accomplish */
  goal: string;
  /** Measurable criteria for "done" */
  completionCriteria: string[];
  /** Ordered steps with dependency graph */
  steps: TaskStep[];
}

/** A single step in a task plan */
export interface TaskStep {
  /** Unique step identifier (e.g. "step-1", "step-2") */
  id: string;
  /** Human-readable description of what this step does */
  description: string;
  /** Tool name to call for this step */
  tool: string;
  /** Structured input for the tool call */
  input: Record<string, unknown>;
  /** Step IDs that must complete before this step can run */
  dependsOn: string[];
  /** How to verify this step succeeded */
  verification: Verification;
}

/** Verification strategy for a completed step */
export type Verification =
  | { type: 'exit_code'; expect: number }
  | { type: 'file_exists'; path: string }
  | { type: 'output_contains'; substring: string }
  | { type: 'schema'; jsonSchema: Record<string, unknown> }
  | { type: 'llm_judge'; prompt: string }
  | { type: 'none' };

// ─── Execution ───────────────────────────────────────────────────────────────

/** Outcome of executing a single step */
export interface StepOutcome {
  /** Which step this outcome is for */
  stepId: string;
  /** Tool that was called */
  tool: string;
  /** Whether the step succeeded */
  success: boolean;
  /** Number of retry attempts */
  retries: number;
  /** Why it failed, if applicable */
  failureReason?: string;
  /** How long the step took in milliseconds */
  durationMs: number;
  /** Raw tool output (redacted for logging) */
  output?: string;
}

/** Result of running an entire task plan */
export interface TaskRunResult {
  /** The plan that was executed */
  plan: TaskPlan;
  /** Outcomes for each step */
  stepOutcomes: StepOutcome[];
  /** Whether all steps succeeded and criteria were met */
  overallSuccess: boolean;
  /** Total execution time in milliseconds */
  durationMs: number;
}

// ─── Execution Log (Operational Memory) ──────────────────────────────────────

/** A record of a completed task execution, stored for operational memory */
export interface ExecutionRecord {
  /** Unique record identifier */
  id: string;
  /** When the task was executed (Unix timestamp ms) */
  timestamp: number;
  /** Classified task category */
  taskType: string;
  /** Redacted summary of the original instruction — never raw user content */
  originalInstruction: string;
  /** The plan that was created and executed */
  plan: TaskPlan;
  /** Outcomes for each step */
  stepResults: StepOutcome[];
  /** Whether the overall task succeeded */
  overallSuccess: boolean;
  /** Total duration in milliseconds */
  durationMs: number;
  /** Number of times the task was retried */
  retries: number;
  /** Planner observations for next time */
  notes?: string;
}
