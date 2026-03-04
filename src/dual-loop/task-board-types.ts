/**
 * Task Board Types — Shared state layer for the dual-loop architecture.
 *
 * The TaskBoard is the sole communication channel between FastLoop and DeepLoop.
 * These types define the Task lifecycle, ownership protocol, and artifact schema.
 *
 * See docs/dual-loop-architecture.md Section 4.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Task Lifecycle
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The possible states of a task. Transitions are enforced by the TaskBoard.
 *
 * ```
 * queued → planning → implementing → reviewing → done
 *                                   → revision → implementing → reviewing ...
 *                                   → failed
 *          answered_directly (FastLoop handled without DeepLoop)
 * ```
 */
export type TaskStatus =
  | 'queued'              // Created by FastLoop, waiting for DeepLoop
  | 'planning'            // DeepLoop is planning the approach
  | 'implementing'        // DeepLoop is dispatching to Coder
  | 'reviewing'           // DeepLoop is self-reviewing the output
  | 'revision'            // DeepLoop is addressing review feedback
  | 'done'                // Completed successfully
  | 'failed'              // Failed after retries
  | 'answered_directly';  // FastLoop handled it without DeepLoop

/**
 * Who created this task.
 */
export type TaskOrigin = 'user' | 'event' | 'scheduled' | 'goal';

/**
 * Which loop currently owns this task. null = unclaimed.
 */
export type TaskOwner = 'fast' | 'deep' | null;

/**
 * Classification assigned by the FastLoop during triage.
 */
export type TaskClassification = 'simple' | 'complex' | 'conversational';

/**
 * Review outcome written by DeepLoop self-review.
 */
export type ReviewResult = 'approved' | 'changes_requested' | 'rejected';

// ─────────────────────────────────────────────────────────────────────────────
// Task Structure
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A single step in the DeepLoop's execution plan.
 */
export interface PlanStep {
  description: string;
  status: 'pending' | 'in_progress' | 'done' | 'failed';
  output?: string | undefined;
  /** Step-scoped context: only the spec sections relevant to this step.
   *  Populated by the planner so the coder sees focused context, not the full spec. */
  context?: string | undefined;
}

/**
 * An artifact produced during implementation (diff, file, test result, commit).
 */
export interface TaskArtifact {
  type: 'file_diff' | 'file_created' | 'test_result' | 'commit';
  path?: string | undefined;
  content?: string | undefined;   // Truncated if large
  timestamp: string;
}

/**
 * Tracks a file created or modified by tool calls within a step.
 * Accumulated across steps to form the workspace manifest.
 */
export interface FileOperation {
  path: string;
  action: 'created' | 'modified';
  lines?: number;
  exports?: string[];  // Exported symbol names, e.g. ['CONFIG', 'Player', 'InputHandler']
}

// ─────────────────────────────────────────────────────────────────────────────
// Structured Handoff (cross-cycle context transfer)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A structured snapshot of work done so far, used for cross-cycle context
 * transfer (parking, warm-tier compression, handoffs between cycles).
 *
 * XML-serializable via `serializeHandoff()` / `parseHandoff()`.
 */
export interface HandoffSnapshot {
  filesModified: { path: string; operation: 'created' | 'modified' | 'deleted'; summary: string }[];
  decisionsMade: { decision: string; rationale: string }[];
  blockersEncountered: string[];
  nextSteps: string[];
  keyLearnings: string[];
  testResults: { file: string; passed: number; failed: number; summary: string }[];
  stepsCompleted: number;
  totalSteps: number;
}

/**
 * State preserved when a task is parked (preempted by higher-priority work).
 */
export interface ParkedState {
  parkedAtTurn: number;
  reason: string;
  /** Free-form snapshot (legacy) or structured handoff */
  contextSnapshot?: string | undefined;
  /** Structured handoff snapshot for reliable cross-cycle transfer */
  handoff?: HandoffSnapshot | undefined;
}

/**
 * The core Task entity. Central to the dual-loop coordination protocol.
 *
 * Fields are written by different loops at different lifecycle stages:
 *   - FastLoop writes: classification, triageNotes
 *   - DeepLoop writes: plan, planSteps, artifacts, implementationNotes, userFacing, resolution,
 *     reviewResult, reviewNotes, reviewFeedback (via self-review)
 *   - Either loop writes: status, owner (via atomic TaskBoard operations)
 */
export interface Task {
  // ── Identity ──────────────────────────────────────────────────────────────
  id: string;
  createdAt: string;            // ISO timestamp
  updatedAt: string;            // ISO timestamp

  // ── Lifecycle ─────────────────────────────────────────────────────────────
  status: TaskStatus;
  owner: TaskOwner;

  // ── Origin ────────────────────────────────────────────────────────────────
  origin: TaskOrigin;
  priority: number;             // 0 = highest (user), 3 = lowest (scheduled)
  sender?: string | undefined;
  originalMessage?: string | undefined;

  // ── Triage (written by FastLoop) ──────────────────────────────────────────
  classification?: TaskClassification | undefined;
  triageNotes?: string | undefined;

  // ── Plan (written by DeepLoop) ────────────────────────────────────────────
  plan?: string | undefined;
  planSteps?: PlanStep[] | undefined;

  // ── Implementation (written by DeepLoop) ──────────────────────────────────
  artifacts?: TaskArtifact[] | undefined;
  implementationNotes?: string | undefined;
  workspaceManifest?: FileOperation[] | undefined;
  projectDir?: string | undefined;           // e.g. "projects/neon-invaders"

  // ── Review (written by DeepLoop self-review) ────────────────────────────
  reviewResult?: ReviewResult | undefined;
  reviewNotes?: string | undefined;
  reviewFeedback?: string | undefined;

  // ── Verification Cascade (multi-pass review for high-stakes tasks) ──────
  /** Total cascade passes required (default: 1, multi-file: 2) */
  verificationPasses?: number | undefined;
  /** Current cascade pass (0-indexed, incremented after each approved pass) */
  currentVerificationPass?: number | undefined;

  // ── Parking (for preemption) ──────────────────────────────────────────────
  parkedState?: ParkedState | undefined;

  // ── Progress Tracking (for FastLoop delivery) ──────────────────────────
  /** Whether the plan summary has been delivered to the user */
  planSummaryDelivered?: boolean | undefined;
  /** ISO timestamp of last progress update delivered */
  lastProgressDeliveredAt?: string | undefined;
  /** Number of steps that were completed when the last progress update was sent */
  lastProgressStepsCompleted?: number | undefined;

  // ── Resolution ────────────────────────────────────────────────────────────
  resolvedAt?: string | undefined;
  resolution?: string | undefined;
  userFacing?: string | undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// TaskBoard Interface
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Options for creating a new task.
 */
export interface CreateTaskOptions {
  origin: TaskOrigin;
  priority: number;
  sender?: string | undefined;
  originalMessage?: string | undefined;
  classification?: TaskClassification | undefined;
  triageNotes?: string | undefined;
  /** Pre-set userFacing for tasks answered directly by FastLoop */
  userFacing?: string | undefined;
  /** Pre-set status (e.g., 'answered_directly' for simple/conversational) */
  status?: TaskStatus | undefined;
  /** Project directory relative to projectRoot (e.g., "projects/neon-invaders") */
  projectDir?: string | undefined;
}

/**
 * Fields that can be updated on a task.
 */
export interface UpdateTaskFields {
  status?: TaskStatus | undefined;
  owner?: TaskOwner | undefined;
  classification?: TaskClassification | undefined;
  triageNotes?: string | undefined;
  plan?: string | undefined;
  planSteps?: PlanStep[] | undefined;
  artifacts?: TaskArtifact[] | undefined;
  implementationNotes?: string | undefined;
  workspaceManifest?: FileOperation[] | undefined;
  projectDir?: string | undefined;
  reviewResult?: ReviewResult | undefined;
  reviewNotes?: string | undefined;
  reviewFeedback?: string | undefined;
  verificationPasses?: number | undefined;
  currentVerificationPass?: number | undefined;
  parkedState?: ParkedState | undefined;
  planSummaryDelivered?: boolean | undefined;
  lastProgressDeliveredAt?: string | undefined;
  lastProgressStepsCompleted?: number | undefined;
  resolvedAt?: string | undefined;
  resolution?: string | undefined;
  userFacing?: string | undefined;
  priority?: number | undefined;
}

/**
 * Configuration for the TaskBoard.
 */
export interface TaskBoardConfig {
  /** Path to the JSON persistence file */
  dbPath: string;
  /** Days after which completed tasks are archived */
  archiveAfterDays: number;
  /** Maximum number of active (non-archived) tasks */
  maxActiveTasks: number;
}
