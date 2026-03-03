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
  | 'reviewing'           // FastLoop is reviewing the output
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
 * Review outcome written by the FastLoop.
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

/**
 * State preserved when a task is parked (preempted by higher-priority work).
 */
export interface ParkedState {
  parkedAtTurn: number;
  reason: string;
  contextSnapshot?: string | undefined;  // Summary of work done so far
}

/**
 * The core Task entity. Central to the dual-loop coordination protocol.
 *
 * Fields are written by different loops at different lifecycle stages:
 *   - FastLoop writes: classification, triageNotes, reviewResult, reviewNotes, reviewFeedback
 *   - DeepLoop writes: plan, planSteps, artifacts, implementationNotes, userFacing, resolution
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

  // ── Review (written by FastLoop) ──────────────────────────────────────────
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
