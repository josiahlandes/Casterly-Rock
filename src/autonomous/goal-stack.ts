/**
 * Goal Stack — Tyrion's persistent priority queue of things he cares about
 *
 * The goal stack is what gives Tyrion direction. Instead of analyzing the
 * codebase from scratch each cycle, Tyrion consults his goal stack: "What
 * am I working on? What's next? What has the user asked for?"
 *
 * Goals come from three sources:
 *   - user:  Explicitly requested by the human (always highest priority).
 *   - self:  Identified by Tyrion during autonomous cycles or dream cycles.
 *   - event: Created automatically in response to system events (test failures,
 *            build errors, stale issues).
 *
 * Priority is numeric (1 = highest). User goals default to priority 1.
 * Self-generated goals start at priority 3+. Event goals start at priority 2.
 *
 * Goals age: if a goal sits without progress for longer than a configurable
 * threshold, its priority is bumped up (the number increases, making it
 * lower priority... actually, let's be explicit: stale goals get a flag,
 * and the agent decides whether to reprioritize or prune them).
 *
 * Storage: YAML file at a configurable path (default ~/.casterly/goals.yaml).
 *
 * Privacy: Goals contain only task descriptions and codebase references.
 * No user-provided sensitive data is stored in goals.
 */

import { readFile } from 'node:fs/promises';
import { safeWriteFile } from '../persistence/safe-write.js';
import YAML from 'yaml';
import { getTracer } from './debug.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Where the goal originated from.
 */
export type GoalSource = 'user' | 'self' | 'event';

/**
 * Current status of a goal in its lifecycle.
 */
export type GoalStatus = 'pending' | 'in_progress' | 'blocked' | 'done' | 'abandoned';

/**
 * A single goal in the stack.
 */
export interface Goal {
  /** Unique identifier (auto-generated: goal-001, goal-002, etc.) */
  id: string;

  /** Where this goal came from */
  source: GoalSource;

  /** Priority level: 1 = highest. Lower numbers = more important */
  priority: number;

  /** Human-readable description of what needs to be done */
  description: string;

  /** ISO timestamp when this goal was created */
  created: string;

  /** ISO timestamp when this goal was last updated */
  updated: string;

  /** Current lifecycle status */
  status: GoalStatus;

  /** How many times Tyrion has attempted this goal */
  attempts: number;

  /** Free-form notes about progress, blockers, approach ideas */
  notes: string;

  /** Related files in the codebase */
  relatedFiles: string[];

  /** If this goal was created from an issue, the issue ID */
  issueId?: string;

  /** If this goal was created from an event, the event type */
  eventType?: string;

  /** Tags for categorization (e.g., 'bug', 'refactor', 'feature', 'maintenance') */
  tags: string[];
}

/**
 * The complete goal stack data stored on disk.
 */
export interface GoalStackData {
  /** Schema version for forward compatibility */
  version: number;

  /** Auto-incrementing counter for goal IDs */
  nextId: number;

  /** All goals (active and completed) */
  goals: Goal[];
}

/**
 * Configuration for the goal stack.
 */
export interface GoalStackConfig {
  /** Path to the goals YAML file */
  path: string;

  /** Maximum number of open (non-done, non-abandoned) goals */
  maxOpenGoals: number;

  /** Maximum total goals to retain (including completed) */
  maxTotalGoals: number;

  /** Days without activity before a goal is flagged as stale */
  staleDays: number;

  /** Default priority for user-created goals */
  defaultUserPriority: number;

  /** Default priority for self-created goals */
  defaultSelfPriority: number;

  /** Default priority for event-created goals */
  defaultEventPriority: number;
}

/**
 * Summary of the goal stack for inclusion in the identity prompt.
 * Contains only what the LLM needs to see — not the full history.
 */
export interface GoalStackSummary {
  /** Total open goals */
  totalOpen: number;

  /** Goals currently in progress */
  inProgress: Goal[];

  /** Top N pending goals by priority */
  topPending: Goal[];

  /** Goals that are blocked */
  blocked: Goal[];

  /** Goals that are stale (no activity for staleDays) */
  stale: Goal[];

  /** Recently completed goals (last 5) */
  recentlyCompleted: Goal[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: GoalStackConfig = {
  path: '~/.casterly/goals.yaml',
  maxOpenGoals: 20,
  maxTotalGoals: 100,
  staleDays: 7,
  defaultUserPriority: 1,
  defaultSelfPriority: 3,
  defaultEventPriority: 2,
};

function createEmptyGoalStack(): GoalStackData {
  return {
    version: 1,
    nextId: 1,
    goals: [],
  };
}

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
// GoalStack Class
// ─────────────────────────────────────────────────────────────────────────────

export class GoalStack {
  private readonly config: GoalStackConfig;
  private data: GoalStackData;
  private dirty: boolean = false;

  constructor(config?: Partial<GoalStackConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.data = createEmptyGoalStack();
  }

  // ── Persistence ──────────────────────────────────────────────────────────

  /**
   * Load the goal stack from disk. If the file doesn't exist, initializes
   * with empty defaults. If the file is corrupt, logs and starts fresh.
   */
  async load(): Promise<void> {
    const tracer = getTracer();
    await tracer.withSpan('goal-stack', 'load', async (span) => {
      const resolvedPath = resolvePath(this.config.path);
      tracer.log('goal-stack', 'debug', `Loading goal stack from ${resolvedPath}`);

      const startMs = Date.now();
      try {
        const raw = await readFile(resolvedPath, 'utf8');
        const parsed = YAML.parse(raw) as unknown;

        if (parsed && typeof parsed === 'object' && 'version' in parsed) {
          this.data = parsed as GoalStackData;
          this.dirty = false;

          const openGoals = this.getOpenGoals();
          tracer.logIO('goal-stack', 'read', resolvedPath, Date.now() - startMs, {
            success: true,
            bytesOrLines: raw.length,
          });
          tracer.log('goal-stack', 'info', 'Goal stack loaded', {
            totalGoals: this.data.goals.length,
            openGoals: openGoals.length,
            inProgress: openGoals.filter((g) => g.status === 'in_progress').length,
            nextId: this.data.nextId,
          });
        } else {
          tracer.log('goal-stack', 'warn', 'Goal stack file has unexpected structure, starting fresh');
          this.data = createEmptyGoalStack();
          this.dirty = true;
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          tracer.log('goal-stack', 'info', 'No existing goal stack found, initializing fresh');
          this.data = createEmptyGoalStack();
          this.dirty = true;
        } else {
          tracer.log('goal-stack', 'error', 'Failed to load goal stack', {
            error: err instanceof Error ? err.message : String(err),
          });
          this.data = createEmptyGoalStack();
          this.dirty = true;
          span.status = 'failure';
          span.error = err instanceof Error ? err.message : String(err);
        }
      }
    });
  }

  /**
   * Save the goal stack to disk. Only writes if changes have been made.
   * Creates the parent directory if it doesn't exist.
   */
  async save(): Promise<void> {
    const tracer = getTracer();
    await tracer.withSpan('goal-stack', 'save', async () => {
      if (!this.dirty) {
        tracer.log('goal-stack', 'debug', 'Goal stack unchanged, skipping save');
        return;
      }

      const resolvedPath = resolvePath(this.config.path);

      const content = YAML.stringify(this.data, { lineWidth: 120 });
      const startMs = Date.now();

      await safeWriteFile(resolvedPath, content, 'utf8');
      this.dirty = false;

      tracer.logIO('goal-stack', 'write', resolvedPath, Date.now() - startMs, {
        success: true,
        bytesOrLines: content.length,
      });
      tracer.log('goal-stack', 'info', 'Goal stack saved', {
        totalGoals: this.data.goals.length,
      });
    });
  }

  // ── Goal Creation ────────────────────────────────────────────────────────

  /**
   * Add a new goal to the stack. Returns the created goal with its
   * auto-generated ID.
   *
   * If the maximum number of open goals has been reached, the lowest-priority
   * self-generated goal is automatically abandoned to make room — but only
   * if the new goal is from the user or an event. Self-generated goals
   * that exceed the limit are rejected.
   */
  addGoal(params: {
    source: GoalSource;
    description: string;
    priority?: number;
    relatedFiles?: string[];
    issueId?: string;
    eventType?: string;
    tags?: string[];
    notes?: string;
  }): Goal | null {
    const tracer = getTracer();
    return tracer.withSpanSync('goal-stack', 'addGoal', (span) => {
      const openGoals = this.getOpenGoals();

      // Check capacity
      if (openGoals.length >= this.config.maxOpenGoals) {
        if (params.source === 'self') {
          tracer.log('goal-stack', 'warn', 'Cannot add self-generated goal: at capacity', {
            openGoals: openGoals.length,
            max: this.config.maxOpenGoals,
          });
          span.status = 'failure';
          span.error = 'At capacity for self-generated goals';
          return null;
        }

        // For user/event goals, abandon the lowest-priority self-generated goal
        const selfGoals = openGoals
          .filter((g) => g.source === 'self')
          .sort((a, b) => b.priority - a.priority); // Highest number = lowest priority

        if (selfGoals.length > 0 && selfGoals[0]) {
          const abandoned = selfGoals[0];
          this.updateGoalStatus(abandoned.id, 'abandoned', 'Auto-abandoned to make room for higher-priority goal');
          tracer.log('goal-stack', 'info', `Auto-abandoned goal ${abandoned.id} to make room`, {
            abandoned: abandoned.description,
            newGoal: params.description,
          });
        }
      }

      // Determine priority
      let priority: number;
      if (params.priority !== undefined) {
        priority = params.priority;
      } else {
        switch (params.source) {
          case 'user':
            priority = this.config.defaultUserPriority;
            break;
          case 'event':
            priority = this.config.defaultEventPriority;
            break;
          case 'self':
            priority = this.config.defaultSelfPriority;
            break;
        }
      }

      const now = new Date().toISOString();
      const id = `goal-${String(this.data.nextId).padStart(3, '0')}`;
      this.data.nextId += 1;

      const goal: Goal = {
        id,
        source: params.source,
        priority,
        description: params.description,
        created: now,
        updated: now,
        status: 'pending',
        attempts: 0,
        notes: params.notes ?? '',
        relatedFiles: params.relatedFiles ?? [],
        ...(params.issueId !== undefined ? { issueId: params.issueId } : {}),
        ...(params.eventType !== undefined ? { eventType: params.eventType } : {}),
        tags: params.tags ?? [],
      };

      this.data.goals.push(goal);
      this.dirty = true;

      // Prune old completed/abandoned goals if over total limit
      this.pruneOldGoals();

      tracer.log('goal-stack', 'info', `Goal added: ${id}`, {
        source: params.source,
        priority,
        description: params.description,
      });

      return goal;
    });
  }

  // ── Goal Queries ─────────────────────────────────────────────────────────

  /**
   * Get a goal by its ID.
   */
  getGoal(id: string): Goal | undefined {
    return this.data.goals.find((g) => g.id === id);
  }

  /**
   * Get all open goals (not done, not abandoned), sorted by priority
   * (ascending: 1 first) then by creation date (oldest first).
   */
  getOpenGoals(): Goal[] {
    return this.data.goals
      .filter((g) => g.status !== 'done' && g.status !== 'abandoned')
      .sort((a, b) => {
        if (a.priority !== b.priority) {
          return a.priority - b.priority;
        }
        return a.created.localeCompare(b.created);
      });
  }

  /**
   * Get the next goal to work on. This is the highest-priority open goal
   * that is not blocked. If a goal is already in_progress, that one is
   * returned first (don't context-switch unless blocked).
   */
  getNextGoal(): Goal | undefined {
    const tracer = getTracer();
    const open = this.getOpenGoals();

    // Prefer continuing an in-progress goal
    const inProgress = open.find((g) => g.status === 'in_progress');
    if (inProgress) {
      tracer.log('goal-stack', 'debug', `Next goal (continuing): ${inProgress.id}`, {
        description: inProgress.description,
      });
      return inProgress;
    }

    // Otherwise, pick the highest-priority pending goal
    const next = open.find((g) => g.status === 'pending');
    if (next) {
      tracer.log('goal-stack', 'debug', `Next goal (new): ${next.id}`, {
        description: next.description,
      });
    } else {
      tracer.log('goal-stack', 'debug', 'No pending goals available');
    }
    return next;
  }

  /**
   * Get goals filtered by source.
   */
  getGoalsBySource(source: GoalSource): Goal[] {
    return this.data.goals.filter((g) => g.source === source);
  }

  /**
   * Get goals filtered by status.
   */
  getGoalsByStatus(status: GoalStatus): Goal[] {
    return this.data.goals.filter((g) => g.status === status);
  }

  /**
   * Get goals that are stale (no activity for staleDays days).
   */
  getStaleGoals(): Goal[] {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - this.config.staleDays);
    const cutoffStr = cutoff.toISOString();

    return this.getOpenGoals().filter((g) => g.updated < cutoffStr);
  }

  /**
   * Get recently completed goals, most recent first.
   */
  getRecentlyCompleted(limit: number = 5): Goal[] {
    return this.data.goals
      .filter((g) => g.status === 'done')
      .sort((a, b) => b.updated.localeCompare(a.updated))
      .slice(0, limit);
  }

  /**
   * Get a summary suitable for the identity prompt.
   */
  getSummary(topPendingLimit: number = 5): GoalStackSummary {
    const open = this.getOpenGoals();
    return {
      totalOpen: open.length,
      inProgress: open.filter((g) => g.status === 'in_progress'),
      topPending: open.filter((g) => g.status === 'pending').slice(0, topPendingLimit),
      blocked: open.filter((g) => g.status === 'blocked'),
      stale: this.getStaleGoals(),
      recentlyCompleted: this.getRecentlyCompleted(),
    };
  }

  /**
   * Get a compact text summary for the identity prompt.
   */
  getSummaryText(): string {
    const summary = this.getSummary();
    const lines: string[] = [];

    lines.push(`## Goals (${summary.totalOpen} open)`);

    if (summary.inProgress.length > 0) {
      lines.push('### In Progress');
      for (const g of summary.inProgress) {
        lines.push(`- [${g.id}] ${g.description} (${g.source}, ${g.attempts} attempts)`);
        if (g.notes) {
          lines.push(`  Notes: ${g.notes}`);
        }
      }
    }

    if (summary.topPending.length > 0) {
      lines.push('### Pending');
      for (const g of summary.topPending) {
        lines.push(`- [${g.id}] P${g.priority} ${g.description} (${g.source})`);
      }
    }

    if (summary.blocked.length > 0) {
      lines.push('### Blocked');
      for (const g of summary.blocked) {
        lines.push(`- [${g.id}] ${g.description}: ${g.notes}`);
      }
    }

    if (summary.stale.length > 0) {
      lines.push(`### Stale (>${this.config.staleDays} days inactive)`);
      for (const g of summary.stale) {
        lines.push(`- [${g.id}] ${g.description} (last updated: ${g.updated.split('T')[0]})`);
      }
    }

    if (summary.recentlyCompleted.length > 0) {
      lines.push('### Recently Completed');
      for (const g of summary.recentlyCompleted) {
        lines.push(`- [${g.id}] ${g.description}`);
      }
    }

    return lines.join('\n');
  }

  // ── Goal Updates ─────────────────────────────────────────────────────────

  /**
   * Update a goal's status. This is the primary way goals move through
   * their lifecycle. Automatically updates the 'updated' timestamp.
   */
  updateGoalStatus(id: string, status: GoalStatus, notes?: string): boolean {
    const tracer = getTracer();
    const goal = this.data.goals.find((g) => g.id === id);

    if (!goal) {
      tracer.log('goal-stack', 'warn', `Goal not found for status update: ${id}`);
      return false;
    }

    const oldStatus = goal.status;
    goal.status = status;
    goal.updated = new Date().toISOString();
    if (notes !== undefined) {
      goal.notes = notes;
    }

    this.dirty = true;

    tracer.logStateChange('goal-stack', `${id}.status`, oldStatus, status);
    if (notes !== undefined) {
      tracer.log('goal-stack', 'debug', `${id} notes updated: ${notes}`);
    }

    return true;
  }

  /**
   * Record an attempt on a goal. Increments the attempt counter and
   * updates the timestamp.
   */
  recordAttempt(id: string, notes?: string): boolean {
    const tracer = getTracer();
    const goal = this.data.goals.find((g) => g.id === id);

    if (!goal) {
      tracer.log('goal-stack', 'warn', `Goal not found for attempt recording: ${id}`);
      return false;
    }

    goal.attempts += 1;
    goal.updated = new Date().toISOString();
    if (notes !== undefined) {
      goal.notes = notes;
    }

    this.dirty = true;

    tracer.log('goal-stack', 'debug', `${id} attempt #${goal.attempts} recorded`, {
      description: goal.description,
      notes,
    });

    return true;
  }

  /**
   * Update a goal's priority.
   */
  updatePriority(id: string, priority: number): boolean {
    const tracer = getTracer();
    const goal = this.data.goals.find((g) => g.id === id);

    if (!goal) {
      tracer.log('goal-stack', 'warn', `Goal not found for priority update: ${id}`);
      return false;
    }

    const oldPriority = goal.priority;
    goal.priority = priority;
    goal.updated = new Date().toISOString();
    this.dirty = true;

    tracer.logStateChange('goal-stack', `${id}.priority`, oldPriority, priority);
    return true;
  }

  /**
   * Add or update notes on a goal without changing its status.
   */
  updateNotes(id: string, notes: string): boolean {
    const tracer = getTracer();
    const goal = this.data.goals.find((g) => g.id === id);

    if (!goal) {
      tracer.log('goal-stack', 'warn', `Goal not found for notes update: ${id}`);
      return false;
    }

    goal.notes = notes;
    goal.updated = new Date().toISOString();
    this.dirty = true;

    tracer.log('goal-stack', 'debug', `${id} notes updated`);
    return true;
  }

  /**
   * Mark a goal as done with optional completion notes.
   */
  completeGoal(id: string, notes?: string): boolean {
    const tracer = getTracer();
    const result = this.updateGoalStatus(id, 'done', notes);
    if (result) {
      tracer.log('goal-stack', 'info', `Goal completed: ${id}`, {
        description: this.getGoal(id)?.description,
        notes,
      });
    }
    return result;
  }

  // ── Maintenance ──────────────────────────────────────────────────────────

  /**
   * Prune old completed/abandoned goals to keep the total count
   * within limits. Removes the oldest closed goals first.
   */
  private pruneOldGoals(): void {
    const tracer = getTracer();

    if (this.data.goals.length <= this.config.maxTotalGoals) {
      return;
    }

    // Sort closed goals by update time (oldest first)
    const closedGoals = this.data.goals
      .filter((g) => g.status === 'done' || g.status === 'abandoned')
      .sort((a, b) => a.updated.localeCompare(b.updated));

    const toRemove = this.data.goals.length - this.config.maxTotalGoals;
    const removing = closedGoals.slice(0, toRemove);

    if (removing.length > 0) {
      const removingIds = new Set(removing.map((g) => g.id));
      this.data.goals = this.data.goals.filter((g) => !removingIds.has(g.id));
      this.dirty = true;

      tracer.log('goal-stack', 'debug', `Pruned ${removing.length} old goals`, {
        removedIds: removing.map((g) => g.id),
      });
    }
  }

  /**
   * Remove a specific goal entirely (not just mark as done/abandoned).
   * Use sparingly — prefer completeGoal() or updateGoalStatus('abandoned').
   */
  removeGoal(id: string): boolean {
    const tracer = getTracer();
    const index = this.data.goals.findIndex((g) => g.id === id);

    if (index < 0) {
      tracer.log('goal-stack', 'warn', `Goal not found for removal: ${id}`);
      return false;
    }

    const removed = this.data.goals.splice(index, 1)[0];
    this.dirty = true;

    tracer.log('goal-stack', 'info', `Goal removed: ${id}`, {
      description: removed?.description,
      status: removed?.status,
    });

    return true;
  }

  /**
   * Get the raw data (for testing and debugging).
   */
  getData(): GoalStackData {
    return structuredClone(this.data);
  }
}
