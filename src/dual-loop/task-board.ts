/**
 * Task Board — In-memory shared state between FastLoop and DeepLoop.
 *
 * The TaskBoard is the sole communication channel between the two loops.
 * Both loops read and write tasks through synchronous in-memory operations.
 * State is persisted to a JSON file via load()/save().
 *
 * Since both loops run as async coroutines in the same Node.js process,
 * the event loop serializes all JS execution — no locks or mutexes needed.
 * Ownership claims are safe because no two synchronous code paths can
 * interleave within a single claim operation.
 *
 * Persistence pattern matches GoalStack/IssueLog: dirty-flag + explicit save().
 *
 * See docs/dual-loop-architecture.md Section 4.
 */

import { readFile } from 'node:fs/promises';
import { safeWriteFile } from '../persistence/safe-write.js';
import { randomUUID } from 'node:crypto';
import { getTracer } from '../autonomous/debug.js';

import type {
  Task,
  TaskStatus,
  TaskOwner,
  CreateTaskOptions,
  UpdateTaskFields,
  TaskBoardConfig,
  PlanStep,
  TaskArtifact,
  ParkedState,
} from './task-board-types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Persisted Data Shape
// ─────────────────────────────────────────────────────────────────────────────

interface TaskBoardData {
  version: number;
  tasks: Task[];
  deliveredTaskIds: string[];
}

function createEmptyData(): TaskBoardData {
  return { version: 1, tasks: [], deliveredTaskIds: [] };
}

// ─────────────────────────────────────────────────────────────────────────────
// Default Configuration
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: TaskBoardConfig = {
  dbPath: '~/.casterly/taskboard.json',
  archiveAfterDays: 7,
  maxActiveTasks: 10,
};

// ─────────────────────────────────────────────────────────────────────────────
// Path Resolution
// ─────────────────────────────────────────────────────────────────────────────

function resolvePath(filePath: string): string {
  if (filePath.startsWith('~')) {
    const home = process.env['HOME'] ?? process.env['USERPROFILE'] ?? '/tmp';
    return filePath.replace('~', home);
  }
  return filePath;
}

// ─────────────────────────────────────────────────────────────────────────────
// TaskBoard
// ─────────────────────────────────────────────────────────────────────────────

export class TaskBoard {
  private readonly config: TaskBoardConfig;
  private data: TaskBoardData;
  private dirty: boolean = false;
  /** Set of task IDs whose userFacing response has been delivered */
  private readonly delivered: Set<string> = new Set();

  constructor(config?: Partial<TaskBoardConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.data = createEmptyData();
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────

  /** Initialize the board (no-op for in-memory; call load() to hydrate from disk) */
  init(): void {
    // No-op — load() handles hydration.
  }

  /** Close the board (no-op for in-memory; call save() to persist first) */
  close(): void {
    // No-op.
  }

  // ── Persistence ─────────────────────────────────────────────────────────

  /**
   * Load tasks from disk. If the file doesn't exist, starts empty.
   */
  async load(): Promise<void> {
    const tracer = getTracer();
    await tracer.withSpan('task-board', 'load', async (span) => {
      const resolvedPath = resolvePath(this.config.dbPath);
      tracer.log('task-board', 'debug', `Loading task board from ${resolvedPath}`);

      const startMs = Date.now();
      try {
        const raw = await readFile(resolvedPath, 'utf8');
        const parsed = JSON.parse(raw) as unknown;

        if (parsed && typeof parsed === 'object' && 'version' in parsed) {
          const loaded = parsed as Partial<TaskBoardData>;
          this.data = {
            version: typeof loaded.version === 'number' ? loaded.version : 1,
            tasks: Array.isArray(loaded.tasks) ? loaded.tasks : [],
            deliveredTaskIds: Array.isArray(loaded.deliveredTaskIds) ? loaded.deliveredTaskIds : [],
          };
          this.delivered.clear();
          for (const id of this.data.deliveredTaskIds) this.delivered.add(id);
          this.dirty = false;

          tracer.logIO('task-board', 'read', resolvedPath, Date.now() - startMs, {
            success: true,
            bytesOrLines: raw.length,
          });
          tracer.log('task-board', 'info', 'Task board loaded', {
            totalTasks: this.data.tasks.length,
            active: this.getActive().length,
          });
        } else {
          tracer.log('task-board', 'warn', 'Task board file has unexpected structure, starting fresh');
          this.data = createEmptyData();
          this.dirty = true;
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          tracer.log('task-board', 'info', 'No existing task board found, initializing fresh');
          this.data = createEmptyData();
          this.dirty = true;
        } else {
          tracer.log('task-board', 'error', 'Failed to load task board', {
            error: err instanceof Error ? err.message : String(err),
          });
          this.data = createEmptyData();
          this.dirty = true;
          span.status = 'failure';
          span.error = err instanceof Error ? err.message : String(err);
        }
      }
    });
  }

  /**
   * Save tasks to disk. Only writes if changes have been made.
   */
  async save(): Promise<void> {
    const tracer = getTracer();
    await tracer.withSpan('task-board', 'save', async () => {
      if (!this.dirty) {
        tracer.log('task-board', 'debug', 'Task board unchanged, skipping save');
        return;
      }

      const resolvedPath = resolvePath(this.config.dbPath);

      const content = JSON.stringify(this.data, null, 2);
      const startMs = Date.now();

      await safeWriteFile(resolvedPath, content, 'utf8');
      this.dirty = false;

      tracer.logIO('task-board', 'write', resolvedPath, Date.now() - startMs, {
        success: true,
        bytesOrLines: content.length,
      });
      tracer.log('task-board', 'info', 'Task board saved', {
        totalTasks: this.data.tasks.length,
      });
    });
  }

  /** Whether unsaved changes exist */
  isDirty(): boolean {
    return this.dirty;
  }

  // ── CRUD ────────────────────────────────────────────────────────────────

  /** Create a new task and return its ID */
  create(options: CreateTaskOptions): string {
    const tracer = getTracer();
    const now = new Date().toISOString();
    const id = `task-${randomUUID().slice(0, 8)}`;

    if (this.getActive().length >= this.config.maxActiveTasks) {
      const oldestActive = this.getActive()
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
      if (oldestActive) {
        oldestActive.status = 'failed';
        oldestActive.owner = null;
        oldestActive.resolution = `Task board capacity reached (${this.config.maxActiveTasks} active tasks)`;
        oldestActive.resolvedAt = now;
        oldestActive.updatedAt = now;
        tracer.log('task-board', 'warn', `Task board capacity reached; failed oldest active task ${oldestActive.id}`);
      }
    }

    const task: Task = {
      id,
      createdAt: now,
      updatedAt: now,
      status: options.status ?? 'queued',
      owner: null,
      origin: options.origin,
      priority: options.priority,
      sender: options.sender,
      originalMessage: options.originalMessage,
      classification: options.classification,
      triageNotes: options.triageNotes,
      userFacing: options.userFacing,
      ...(options.projectDir ? { projectDir: options.projectDir } : {}),
    };

    this.data.tasks.push(task);
    this.dirty = true;

    tracer.log('task-board', 'info', `Task created: ${id}`, {
      origin: options.origin,
      priority: options.priority,
      status: task.status,
    });

    return id;
  }

  /** Get a task by ID */
  get(id: string): Task | null {
    return this.data.tasks.find((t) => t.id === id) ?? null;
  }

  /** Update fields on a task */
  update(id: string, fields: UpdateTaskFields): boolean {
    const tracer = getTracer();
    const task = this.data.tasks.find((t) => t.id === id);

    if (!task) {
      tracer.log('task-board', 'warn', `Task not found for update: ${id}`);
      return false;
    }

    // Merge provided fields onto the task.
    // Uses 'in' instead of '!== undefined' so that explicitly passing
    // undefined clears the field (e.g., clearing reviewResult on revision).
    if ('status' in fields) task.status = fields.status!;
    if ('owner' in fields) task.owner = fields.owner!;
    if ('classification' in fields) task.classification = fields.classification;
    if ('triageNotes' in fields) task.triageNotes = fields.triageNotes;
    if ('plan' in fields) task.plan = fields.plan;
    if ('planSteps' in fields) task.planSteps = fields.planSteps;
    if ('artifacts' in fields) task.artifacts = fields.artifacts;
    if ('implementationNotes' in fields) task.implementationNotes = fields.implementationNotes;
    if ('workspaceManifest' in fields) task.workspaceManifest = fields.workspaceManifest;
    if ('projectDir' in fields) task.projectDir = fields.projectDir;
    if ('reviewResult' in fields) task.reviewResult = fields.reviewResult;
    if ('reviewNotes' in fields) task.reviewNotes = fields.reviewNotes;
    if ('reviewFeedback' in fields) task.reviewFeedback = fields.reviewFeedback;
    if ('parkedState' in fields) task.parkedState = fields.parkedState;
    if ('resolvedAt' in fields) task.resolvedAt = fields.resolvedAt;
    if ('resolution' in fields) task.resolution = fields.resolution;
    if ('userFacing' in fields) task.userFacing = fields.userFacing;
    if ('priority' in fields) task.priority = fields.priority!;
    if ('planSummaryDelivered' in fields) task.planSummaryDelivered = fields.planSummaryDelivered;
    if ('lastProgressDeliveredAt' in fields) task.lastProgressDeliveredAt = fields.lastProgressDeliveredAt;
    if ('lastProgressStepsCompleted' in fields) task.lastProgressStepsCompleted = fields.lastProgressStepsCompleted;
    if ('currentVerificationPass' in fields) task.currentVerificationPass = fields.currentVerificationPass;

    task.updatedAt = new Date().toISOString();
    this.dirty = true;

    tracer.log('task-board', 'debug', `Task updated: ${id}`, {
      fields: Object.keys(fields),
    });

    return true;
  }

  // ── Ownership Protocol ──────────────────────────────────────────────────

  /**
   * Claim the next available task matching the given statuses.
   * Returns the claimed task, or null if nothing is available.
   *
   * Since JS is single-threaded, this is inherently atomic —
   * no two callers can interleave within this synchronous method.
   */
  claimNext(owner: NonNullable<TaskOwner>, statuses: TaskStatus[]): Task | null {
    const tracer = getTracer();
    const statusSet = new Set(statuses);

    // Find the highest-priority unclaimed task matching the requested statuses
    const candidates = this.data.tasks
      .filter((t) => t.owner === null && statusSet.has(t.status))
      .sort((a, b) => {
        if (a.priority !== b.priority) return a.priority - b.priority;
        return a.createdAt.localeCompare(b.createdAt);
      });

    const task = candidates[0];
    if (!task) return null;

    task.owner = owner;
    task.updatedAt = new Date().toISOString();
    this.dirty = true;

    tracer.log('task-board', 'info', `Task claimed: ${task.id} by ${owner}`, {
      status: task.status,
      priority: task.priority,
    });

    return task;
  }

  /**
   * Release ownership of a task (set owner to null).
   */
  release(id: string): boolean {
    const tracer = getTracer();
    const task = this.data.tasks.find((t) => t.id === id);

    if (!task) {
      tracer.log('task-board', 'warn', `Task not found for release: ${id}`);
      return false;
    }

    const oldOwner = task.owner;
    task.owner = null;
    task.updatedAt = new Date().toISOString();
    this.dirty = true;

    tracer.log('task-board', 'debug', `Task released: ${id} (was ${oldOwner})`);
    return true;
  }

  // ── Queries ─────────────────────────────────────────────────────────────

  /** Get the next task in 'reviewing' status (unclaimed) */
  getNextReviewable(): Task | null {
    return this.data.tasks
      .filter((t) => t.status === 'reviewing' && t.owner === null)
      .sort((a, b) => {
        if (a.priority !== b.priority) return a.priority - b.priority;
        return a.createdAt.localeCompare(b.createdAt);
      })[0] ?? null;
  }

  /** Get the next completed task with a userFacing response ready for delivery */
  getCompletedWithResponse(): Task | null {
    return this.data.tasks.find(
      (t) => t.status === 'done' && t.userFacing && !this.delivered.has(t.id),
    ) ?? null;
  }

  /** Mark a task's response as delivered */
  markDelivered(id: string): void {
    if (this.delivered.has(id)) return;
    this.delivered.add(id);
    if (!this.data.deliveredTaskIds.includes(id)) {
      this.data.deliveredTaskIds.push(id);
      this.dirty = true;
    }
  }

  /**
   * Mark all already-completed tasks as delivered.
   * Called after load() to prevent re-delivery of tasks from previous sessions.
   */
  markExistingDoneAsDelivered(): void {
    for (const task of this.data.tasks) {
      if (task.status === 'done' || task.status === 'answered_directly' || task.status === 'failed') {
        this.delivered.add(task.id);
      }
    }
  }

  /** Get a queued, unclaimed task with higher priority (lower number) than the threshold */
  getHigherPriorityTask(currentPriority: number): Task | null {
    return this.data.tasks
      .filter((t) => t.priority < currentPriority && t.status === 'queued' && t.owner === null)
      .sort((a, b) => {
        if (a.priority !== b.priority) return a.priority - b.priority;
        return a.createdAt.localeCompare(b.createdAt);
      })[0] ?? null;
  }

  /** Get all active (non-done, non-failed) tasks */
  getActive(): Task[] {
    return this.data.tasks.filter(
      (t) => t.status !== 'done' && t.status !== 'failed' && t.status !== 'answered_directly',
    );
  }

  /** Get count of tasks by status */
  getStatusCounts(): Partial<Record<TaskStatus, number>> {
    const counts: Partial<Record<TaskStatus, number>> = {};
    for (const task of this.data.tasks) {
      counts[task.status] = (counts[task.status] ?? 0) + 1;
    }
    return counts;
  }

  /** Get count of tasks completed today */
  getCompletedToday(): number {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayStr = todayStart.toISOString();

    return this.data.tasks.filter(
      (t) => (t.status === 'done' || t.status === 'answered_directly') && t.updatedAt >= todayStr,
    ).length;
  }

  /** Build a compact text summary of the board for triage context */
  getSummaryText(): string {
    const active = this.getActive();
    if (active.length === 0) return '(no active tasks)';

    const lines: string[] = [];
    for (const task of active.slice(0, 5)) {
      const ownerTag = task.owner ? ` [${task.owner}]` : '';
      lines.push(`- [${task.id}] P${task.priority} ${task.status}${ownerTag}: ${task.originalMessage?.slice(0, 60) ?? '(no message)'}`);
    }
    if (active.length > 5) {
      lines.push(`  ... and ${active.length - 5} more`);
    }
    return lines.join('\n');
  }

  // ── Parking (Preemption) ────────────────────────────────────────────────

  /** Park a task: preserve state, re-queue it, release ownership */
  parkTask(id: string, parkedState: ParkedState): boolean {
    const tracer = getTracer();
    const task = this.data.tasks.find((t) => t.id === id);

    if (!task) {
      tracer.log('task-board', 'warn', `Task not found for parking: ${id}`);
      return false;
    }

    task.parkedState = parkedState;
    task.status = 'queued';
    task.owner = null;
    task.updatedAt = new Date().toISOString();
    this.dirty = true;

    tracer.log('task-board', 'info', `Task parked: ${id}`, {
      reason: parkedState.reason,
      atTurn: parkedState.parkedAtTurn,
    });

    return true;
  }

  // ── Maintenance ─────────────────────────────────────────────────────────

  /** Remove old completed/failed tasks beyond archiveAfterDays (tiered retention) */
  archiveOld(): number {
    const tracer = getTracer();
    const now = new Date();

    // Standard retention for done/failed tasks
    const standardCutoff = new Date(now);
    standardCutoff.setDate(standardCutoff.getDate() - this.config.archiveAfterDays);
    const standardCutoffStr = standardCutoff.toISOString();

    // Fast retention (1 day) for trivial answered_directly tasks
    const fastCutoff = new Date(now);
    fastCutoff.setDate(fastCutoff.getDate() - 1);
    const fastCutoffStr = fastCutoff.toISOString();

    const before = this.data.tasks.length;
    this.data.tasks = this.data.tasks.filter((t) => {
      // Keep active tasks unconditionally
      if (t.status !== 'done' && t.status !== 'failed' && t.status !== 'answered_directly') {
        return true;
      }
      // Trivial triage responses: 1-day retention
      const cutoff = t.status === 'answered_directly' ? fastCutoffStr : standardCutoffStr;
      return t.updatedAt >= cutoff;
    });

    const removed = before - this.data.tasks.length;
    if (removed > 0) {
      // Prune orphaned deliveredTaskIds
      const taskIds = new Set(this.data.tasks.map((t) => t.id));
      this.data.deliveredTaskIds = this.data.deliveredTaskIds.filter((id) => taskIds.has(id));
      this.delivered.clear();
      for (const id of this.data.deliveredTaskIds) this.delivered.add(id);

      this.dirty = true;
      tracer.log('task-board', 'info', `Archived ${removed} old tasks`);
    }
    return removed;
  }

  // ── Testing / Debug ─────────────────────────────────────────────────────

  /** Get the raw data (for testing and debugging) */
  getData(): TaskBoardData {
    return structuredClone(this.data);
  }

  /** Get all tasks (for testing and debugging) */
  getAllTasks(): Task[] {
    return [...this.data.tasks];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────────────────────

export function createTaskBoard(config?: Partial<TaskBoardConfig>): TaskBoard {
  return new TaskBoard(config);
}
