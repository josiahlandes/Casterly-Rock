/**
 * Task Board — SQLite-backed shared state between FastLoop and DeepLoop.
 *
 * The TaskBoard is the sole communication channel between the two loops.
 * Both loops read and write tasks through atomic SQLite operations.
 * WAL mode enables concurrent reads/writes without blocking.
 *
 * Ownership protocol:
 *   - Tasks are claimed via atomic UPDATE ... WHERE owner IS NULL.
 *   - Only one loop can own a task at a time.
 *   - No locks, no mutexes — just SQL atomicity.
 *
 * See docs/dual-loop-architecture.md Section 4.
 */

import type {
  Task,
  TaskStatus,
  TaskOwner,
  CreateTaskOptions,
  UpdateTaskFields,
  TaskBoardConfig,
} from './task-board-types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Default Configuration
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: TaskBoardConfig = {
  dbPath: '~/.casterly/taskboard.db',
  archiveAfterDays: 7,
  maxActiveTasks: 10,
};

// ─────────────────────────────────────────────────────────────────────────────
// TaskBoard
// ─────────────────────────────────────────────────────────────────────────────

export class TaskBoard {
  private readonly config: TaskBoardConfig;
  // TODO(pass-2): private db: BetterSqlite3.Database

  constructor(config?: Partial<TaskBoardConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────

  /** Initialize the database (create tables, enable WAL mode) */
  init(): void {
    // TODO(pass-2): Create tables, indexes, WAL mode
  }

  /** Close the database connection */
  close(): void {
    // TODO(pass-2): Close db
  }

  // ── CRUD ────────────────────────────────────────────────────────────────

  /** Create a new task and return its ID */
  create(options: CreateTaskOptions): string {
    void options;
    // TODO(pass-2): INSERT into tasks table
    return '';
  }

  /** Get a task by ID */
  get(id: string): Task | null {
    void id;
    // TODO(pass-2): SELECT by id
    return null;
  }

  /** Update fields on a task */
  update(id: string, fields: UpdateTaskFields): boolean {
    void id; void fields;
    // TODO(pass-2): UPDATE with field merge
    return false;
  }

  // ── Ownership Protocol ──────────────────────────────────────────────────

  /**
   * Atomically claim the next available task matching the given statuses.
   * Returns the claimed task, or null if nothing is available.
   *
   * Uses: UPDATE SET owner=? WHERE owner IS NULL AND status IN (?) ORDER BY priority, createdAt
   */
  claimNext(owner: NonNullable<TaskOwner>, statuses: TaskStatus[]): Task | null {
    void owner; void statuses;
    // TODO(pass-2): Atomic claim
    return null;
  }

  /**
   * Release ownership of a task (set owner to null).
   */
  release(id: string): boolean {
    void id;
    // TODO(pass-2): UPDATE SET owner=NULL
    return false;
  }

  // ── Queries ─────────────────────────────────────────────────────────────

  /** Get the next task in 'reviewing' status (for FastLoop) */
  getNextReviewable(): Task | null {
    // TODO(pass-2): SELECT WHERE status='reviewing' AND owner IS NULL ORDER BY priority, createdAt
    return null;
  }

  /** Get completed tasks with a userFacing response ready for delivery */
  getCompletedWithResponse(): Task | null {
    // TODO(pass-2): SELECT WHERE status='done' AND userFacing IS NOT NULL AND delivered IS NULL
    return null;
  }

  /** Get a task with higher priority than the given threshold (for preemption checks) */
  getHigherPriorityTask(currentPriority: number): Task | null {
    void currentPriority;
    // TODO(pass-2): SELECT WHERE priority < ? AND status='queued' AND owner IS NULL
    return null;
  }

  /** Get all active (non-archived) tasks */
  getActive(): Task[] {
    // TODO(pass-2): SELECT WHERE status NOT IN ('done', 'failed') OR updatedAt > archive threshold
    return [];
  }

  /** Get count of active tasks by status */
  getStatusCounts(): Record<TaskStatus, number> {
    // TODO(pass-2): SELECT status, COUNT(*) GROUP BY status
    return {} as Record<TaskStatus, number>;
  }

  // ── Parking (Preemption) ────────────────────────────────────────────────

  /** Park a task (preserve state for later resumption) */
  parkTask(id: string, parkedState: { parkedAtTurn: number; reason: string; contextSnapshot?: string }): boolean {
    void id; void parkedState;
    // TODO(pass-2): UPDATE SET status='queued', parkedState=?, owner=NULL
    return false;
  }

  // ── Maintenance ─────────────────────────────────────────────────────────

  /** Archive old completed/failed tasks */
  archiveOld(): number {
    // TODO(pass-2): Move tasks older than archiveAfterDays to archive table
    return 0;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────────────────────

export function createTaskBoard(config?: Partial<TaskBoardConfig>): TaskBoard {
  return new TaskBoard(config);
}
