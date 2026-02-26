/**
 * Issue Log — Tyrion's self-managed issue tracker
 *
 * The issue log is where Tyrion tracks problems he's found but hasn't solved
 * yet. Unlike the goal stack (which tracks what to do), the issue log tracks
 * what's wrong and what's been tried. It's the institutional memory of failures,
 * partial fixes, and open questions.
 *
 * When something fails in the agent loop, Tyrion doesn't just reflect and
 * move on — he files an issue with what he tried, why it failed, and what
 * he'd try next. When he comes back to the problem (next cycle, next day),
 * he reads his own issue notes and picks up where he left off.
 *
 * Issues differ from concerns (world-model.ts):
 *   - Concerns are lightweight observations ("test coverage dropped 2%").
 *   - Issues are active problems being investigated ("flaky test in detector.test.ts").
 *
 * Issues differ from goals (goal-stack.ts):
 *   - Goals are forward-looking ("refactor the orchestrator").
 *   - Issues are problem-focused ("the regex doesn't match Unicode input").
 *
 * An issue can spawn a goal (e.g., a complex issue creates a goal to fix it),
 * and a goal can reference an issue (the goal's issueId field).
 *
 * Storage: YAML file at a configurable path (default ~/.casterly/issues.yaml).
 *
 * Privacy: Issues contain only codebase metadata and technical descriptions.
 * No user-provided sensitive data is stored in issues.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import YAML from 'yaml';
import { getTracer } from './debug.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Issue lifecycle status.
 */
export type IssueStatus = 'open' | 'investigating' | 'resolved' | 'wontfix';

/**
 * Issue priority level.
 */
export type IssuePriority = 'critical' | 'high' | 'medium' | 'low';

/**
 * A record of one attempt to fix an issue.
 */
export interface IssueAttempt {
  /** When this attempt was made */
  timestamp: string;

  /** What approach was tried */
  approach: string;

  /** What happened (success, failure, partial) */
  outcome: 'success' | 'failure' | 'partial';

  /** Details about the outcome */
  details: string;

  /** Files that were modified during the attempt */
  filesModified: string[];

  /** Git branch name, if applicable */
  branch?: string;

  /** Git commit hash, if applicable */
  commitHash?: string;
}

/**
 * A single issue in the log.
 */
export interface Issue {
  /** Unique identifier (auto-generated: ISS-001, ISS-002, etc.) */
  id: string;

  /** Short, descriptive title */
  title: string;

  /** Longer description of the problem */
  description: string;

  /** Current lifecycle status */
  status: IssueStatus;

  /** Priority level */
  priority: IssuePriority;

  /** ISO timestamp when this issue was first discovered */
  firstSeen: string;

  /** ISO timestamp when this issue was last updated */
  lastUpdated: string;

  /** Files related to this issue */
  relatedFiles: string[];

  /** Tags for categorization (e.g., 'test', 'type-error', 'performance', 'security') */
  tags: string[];

  /** History of attempts to fix this issue */
  attempts: IssueAttempt[];

  /** What Tyrion plans to try next (filled in after failed attempts) */
  nextIdea: string;

  /** How this issue was discovered */
  discoveredBy: 'autonomous' | 'user-report' | 'test-failure' | 'build-error' | 'dream-cycle';

  /** Resolution notes (filled in when status becomes 'resolved' or 'wontfix') */
  resolution: string;

  /** Related goal ID, if a goal was created for this issue */
  goalId?: string;
}

/**
 * The complete issue log data stored on disk.
 */
export interface IssueLogData {
  /** Schema version for forward compatibility */
  version: number;

  /** Auto-incrementing counter for issue IDs */
  nextId: number;

  /** All issues (open and closed) */
  issues: Issue[];
}

/**
 * Configuration for the issue log.
 */
export interface IssueLogConfig {
  /** Path to the issues YAML file */
  path: string;

  /** Maximum number of open issues */
  maxOpenIssues: number;

  /** Maximum total issues to retain (including resolved) */
  maxTotalIssues: number;

  /** Days without activity before an issue is flagged as stale */
  staleDays: number;
}

/**
 * Summary of the issue log for inclusion in the identity prompt.
 */
export interface IssueLogSummary {
  /** Total open issues */
  totalOpen: number;

  /** Issues currently being investigated */
  investigating: Issue[];

  /** Open issues sorted by priority */
  openByPriority: Issue[];

  /** Issues that are stale */
  stale: Issue[];

  /** Recently resolved issues */
  recentlyResolved: Issue[];

  /** Issues with the most failed attempts */
  mostAttempted: Issue[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: IssueLogConfig = {
  path: '~/.casterly/issues.yaml',
  maxOpenIssues: 50,
  maxTotalIssues: 200,
  staleDays: 7,
};

const PRIORITY_ORDER: Record<IssuePriority, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

function createEmptyIssueLog(): IssueLogData {
  return {
    version: 1,
    nextId: 1,
    issues: [],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Path Resolution
// ─────────────────────────────────────────────────────────────────────────────

function resolvePath(filePath: string): string {
  if (filePath.startsWith('~')) {
    const home = process.env['HOME'] ?? process.env['USERPROFILE'] ?? '/tmp';
    return home + filePath.slice(1);
  }
  return filePath;
}

// ─────────────────────────────────────────────────────────────────────────────
// IssueLog Class
// ─────────────────────────────────────────────────────────────────────────────

export class IssueLog {
  private readonly config: IssueLogConfig;
  private data: IssueLogData;
  private dirty: boolean = false;

  constructor(config?: Partial<IssueLogConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.data = createEmptyIssueLog();
  }

  // ── Persistence ──────────────────────────────────────────────────────────

  /**
   * Load the issue log from disk. If the file doesn't exist, initializes
   * with empty defaults.
   */
  async load(): Promise<void> {
    const tracer = getTracer();
    await tracer.withSpan('issue-log', 'load', async (span) => {
      const resolvedPath = resolvePath(this.config.path);
      tracer.log('issue-log', 'debug', `Loading issue log from ${resolvedPath}`);

      const startMs = Date.now();
      try {
        const raw = await readFile(resolvedPath, 'utf8');
        const parsed = YAML.parse(raw) as unknown;

        if (parsed && typeof parsed === 'object' && 'version' in parsed) {
          this.data = parsed as IssueLogData;
          this.dirty = false;

          const openIssues = this.getOpenIssues();
          tracer.logIO('issue-log', 'read', resolvedPath, Date.now() - startMs, {
            success: true,
            bytesOrLines: raw.length,
          });
          tracer.log('issue-log', 'info', 'Issue log loaded', {
            totalIssues: this.data.issues.length,
            openIssues: openIssues.length,
            investigating: openIssues.filter((i) => i.status === 'investigating').length,
            nextId: this.data.nextId,
          });
        } else {
          tracer.log('issue-log', 'warn', 'Issue log file has unexpected structure, starting fresh');
          this.data = createEmptyIssueLog();
          this.dirty = true;
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          tracer.log('issue-log', 'info', 'No existing issue log found, initializing fresh');
          this.data = createEmptyIssueLog();
          this.dirty = true;
        } else {
          tracer.log('issue-log', 'error', 'Failed to load issue log', {
            error: err instanceof Error ? err.message : String(err),
          });
          this.data = createEmptyIssueLog();
          this.dirty = true;
          span.status = 'failure';
          span.error = err instanceof Error ? err.message : String(err);
        }
      }
    });
  }

  /**
   * Save the issue log to disk. Only writes if changes have been made.
   */
  async save(): Promise<void> {
    const tracer = getTracer();
    await tracer.withSpan('issue-log', 'save', async () => {
      if (!this.dirty) {
        tracer.log('issue-log', 'debug', 'Issue log unchanged, skipping save');
        return;
      }

      const resolvedPath = resolvePath(this.config.path);
      const dir = dirname(resolvedPath);

      await mkdir(dir, { recursive: true });

      const content = YAML.stringify(this.data, { lineWidth: 120 });
      const startMs = Date.now();

      await writeFile(resolvedPath, content, 'utf8');
      this.dirty = false;

      tracer.logIO('issue-log', 'write', resolvedPath, Date.now() - startMs, {
        success: true,
        bytesOrLines: content.length,
      });
      tracer.log('issue-log', 'info', 'Issue log saved', {
        totalIssues: this.data.issues.length,
      });
    });
  }

  // ── Issue Creation ───────────────────────────────────────────────────────

  /**
   * File a new issue. If a similar issue already exists (matching title),
   * the existing issue is updated instead of creating a duplicate.
   *
   * Returns the issue (new or existing).
   */
  fileIssue(params: {
    title: string;
    description: string;
    priority: IssuePriority;
    relatedFiles?: string[];
    tags?: string[];
    discoveredBy: Issue['discoveredBy'];
    nextIdea?: string;
  }): Issue {
    const tracer = getTracer();
    return tracer.withSpanSync('issue-log', 'fileIssue', (span) => {
      // Check for existing issue with same title
      const existing = this.data.issues.find(
        (i) => i.title === params.title && (i.status === 'open' || i.status === 'investigating'),
      );

      if (existing) {
        tracer.log('issue-log', 'debug', `Issue already exists: ${existing.id} "${params.title}"`);

        // Update the existing issue with new info
        existing.lastUpdated = new Date().toISOString();
        if (params.description && params.description !== existing.description) {
          existing.description = params.description;
        }
        if (params.relatedFiles) {
          // Merge related files, deduplicate
          const allFiles = new Set([...existing.relatedFiles, ...params.relatedFiles]);
          existing.relatedFiles = Array.from(allFiles);
        }
        if (params.nextIdea) {
          existing.nextIdea = params.nextIdea;
        }
        // Escalate priority if new priority is higher
        if (PRIORITY_ORDER[params.priority] < PRIORITY_ORDER[existing.priority]) {
          const oldPriority = existing.priority;
          existing.priority = params.priority;
          tracer.logStateChange('issue-log', `${existing.id}.priority`, oldPriority, params.priority);
        }

        this.dirty = true;
        span.metadata['action'] = 'updated_existing';
        return existing;
      }

      // Check open issue capacity
      const openIssues = this.getOpenIssues();
      if (openIssues.length >= this.config.maxOpenIssues) {
        // Close the oldest low-priority issue to make room
        const lowPriority = openIssues
          .filter((i) => i.priority === 'low')
          .sort((a, b) => a.firstSeen.localeCompare(b.firstSeen));

        if (lowPriority.length > 0 && lowPriority[0]) {
          this.resolveIssue(lowPriority[0].id, 'wontfix', 'Auto-closed: capacity reached for new issues');
          tracer.log('issue-log', 'info', `Auto-closed low-priority issue ${lowPriority[0].id} for capacity`);
        }
      }

      // Create new issue
      const now = new Date().toISOString();
      const id = `ISS-${String(this.data.nextId).padStart(3, '0')}`;
      this.data.nextId += 1;

      const issue: Issue = {
        id,
        title: params.title,
        description: params.description,
        status: 'open',
        priority: params.priority,
        firstSeen: now,
        lastUpdated: now,
        relatedFiles: params.relatedFiles ?? [],
        tags: params.tags ?? [],
        attempts: [],
        nextIdea: params.nextIdea ?? '',
        discoveredBy: params.discoveredBy,
        resolution: '',
      };

      this.data.issues.push(issue);
      this.dirty = true;

      // Prune old resolved issues if over total limit
      this.pruneOldIssues();

      tracer.log('issue-log', 'info', `Issue filed: ${id}`, {
        title: params.title,
        priority: params.priority,
        discoveredBy: params.discoveredBy,
      });

      span.metadata['action'] = 'created_new';
      return issue;
    });
  }

  // ── Issue Queries ────────────────────────────────────────────────────────

  /**
   * Get an issue by its ID.
   */
  getIssue(id: string): Issue | undefined {
    return this.data.issues.find((i) => i.id === id);
  }

  /**
   * Get all open issues (status: open or investigating), sorted by priority.
   */
  getOpenIssues(): Issue[] {
    return this.data.issues
      .filter((i) => i.status === 'open' || i.status === 'investigating')
      .sort((a, b) => {
        const priorityDiff = PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
        if (priorityDiff !== 0) return priorityDiff;
        return a.firstSeen.localeCompare(b.firstSeen);
      });
  }

  /**
   * Get issues related to a specific file.
   */
  getIssuesByFile(filePath: string): Issue[] {
    return this.data.issues.filter((i) =>
      i.relatedFiles.some((f) => f === filePath || filePath.endsWith(f) || f.endsWith(filePath)),
    );
  }

  /**
   * Get issues with a specific tag.
   */
  getIssuesByTag(tag: string): Issue[] {
    return this.data.issues.filter((i) => i.tags.includes(tag));
  }

  /**
   * Get issues that are stale (no activity for staleDays).
   */
  getStaleIssues(): Issue[] {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - this.config.staleDays);
    const cutoffStr = cutoff.toISOString();

    return this.getOpenIssues().filter((i) => i.lastUpdated < cutoffStr);
  }

  /**
   * Get recently resolved issues, most recent first.
   */
  getRecentlyResolved(limit: number = 5): Issue[] {
    return this.data.issues
      .filter((i) => i.status === 'resolved' || i.status === 'wontfix')
      .sort((a, b) => b.lastUpdated.localeCompare(a.lastUpdated))
      .slice(0, limit);
  }

  /**
   * Get issues with the most failed attempts (indicating difficulty).
   */
  getMostAttempted(limit: number = 5): Issue[] {
    return this.getOpenIssues()
      .filter((i) => i.attempts.length > 0)
      .sort((a, b) => b.attempts.length - a.attempts.length)
      .slice(0, limit);
  }

  /**
   * Get a summary suitable for the identity prompt.
   */
  getSummary(): IssueLogSummary {
    const open = this.getOpenIssues();
    return {
      totalOpen: open.length,
      investigating: open.filter((i) => i.status === 'investigating'),
      openByPriority: open.slice(0, 10), // Top 10
      stale: this.getStaleIssues(),
      recentlyResolved: this.getRecentlyResolved(),
      mostAttempted: this.getMostAttempted(),
    };
  }

  /**
   * Get a compact text summary for the identity prompt.
   */
  getSummaryText(): string {
    const summary = this.getSummary();
    const lines: string[] = [];

    lines.push(`## Issues (${summary.totalOpen} open)`);

    if (summary.investigating.length > 0) {
      lines.push('### Investigating');
      for (const i of summary.investigating) {
        const attempts = i.attempts.length > 0 ? ` (${i.attempts.length} attempts)` : '';
        lines.push(`- [${i.id}] ${i.title}${attempts}`);
        if (i.nextIdea) {
          lines.push(`  Next idea: ${i.nextIdea}`);
        }
      }
    }

    const openNotInvestigating = summary.openByPriority.filter((i) => i.status === 'open');
    if (openNotInvestigating.length > 0) {
      lines.push('### Open');
      for (const i of openNotInvestigating.slice(0, 5)) {
        lines.push(`- [${i.id}] [${i.priority}] ${i.title}`);
      }
      if (openNotInvestigating.length > 5) {
        lines.push(`  ... and ${openNotInvestigating.length - 5} more`);
      }
    }

    if (summary.stale.length > 0) {
      lines.push(`### Stale (>${this.config.staleDays} days)`);
      for (const i of summary.stale) {
        lines.push(`- [${i.id}] ${i.title} (last updated: ${i.lastUpdated.split('T')[0]})`);
      }
    }

    if (summary.mostAttempted.length > 0) {
      const stubborn = summary.mostAttempted.filter((i) => i.attempts.length >= 3);
      if (stubborn.length > 0) {
        lines.push('### Stubborn (3+ failed attempts)');
        for (const i of stubborn) {
          lines.push(`- [${i.id}] ${i.title} (${i.attempts.length} attempts)`);
        }
      }
    }

    if (summary.recentlyResolved.length > 0) {
      lines.push('### Recently Resolved');
      for (const i of summary.recentlyResolved) {
        lines.push(`- [${i.id}] ${i.title}: ${i.resolution}`);
      }
    }

    return lines.join('\n');
  }

  // ── Issue Updates ────────────────────────────────────────────────────────

  /**
   * Record an attempt to fix an issue. This is called when the agent loop
   * tries to fix something, regardless of whether it succeeds or fails.
   */
  recordAttempt(id: string, attempt: Omit<IssueAttempt, 'timestamp'>): boolean {
    const tracer = getTracer();
    const issue = this.data.issues.find((i) => i.id === id);

    if (!issue) {
      tracer.log('issue-log', 'warn', `Issue not found for attempt recording: ${id}`);
      return false;
    }

    const fullAttempt: IssueAttempt = {
      ...attempt,
      timestamp: new Date().toISOString(),
    };

    issue.attempts.push(fullAttempt);
    issue.lastUpdated = fullAttempt.timestamp;

    // Auto-transition to 'investigating' if it was 'open'
    if (issue.status === 'open') {
      const oldStatus = issue.status;
      issue.status = 'investigating';
      tracer.logStateChange('issue-log', `${id}.status`, oldStatus, 'investigating');
    }

    this.dirty = true;

    tracer.log('issue-log', 'info', `Attempt recorded on ${id}`, {
      approach: attempt.approach,
      outcome: attempt.outcome,
      attemptNumber: issue.attempts.length,
    });

    return true;
  }

  /**
   * Update the "next idea" for an issue. Called after a failed attempt
   * to record what Tyrion wants to try next time.
   */
  updateNextIdea(id: string, nextIdea: string): boolean {
    const tracer = getTracer();
    const issue = this.data.issues.find((i) => i.id === id);

    if (!issue) {
      tracer.log('issue-log', 'warn', `Issue not found for next-idea update: ${id}`);
      return false;
    }

    issue.nextIdea = nextIdea;
    issue.lastUpdated = new Date().toISOString();
    this.dirty = true;

    tracer.log('issue-log', 'debug', `${id} next idea updated: ${nextIdea}`);
    return true;
  }

  /**
   * Resolve an issue (mark as resolved or wontfix).
   */
  resolveIssue(id: string, status: 'resolved' | 'wontfix', resolution: string): boolean {
    const tracer = getTracer();
    const issue = this.data.issues.find((i) => i.id === id);

    if (!issue) {
      tracer.log('issue-log', 'warn', `Issue not found for resolution: ${id}`);
      return false;
    }

    const oldStatus = issue.status;
    issue.status = status;
    issue.resolution = resolution;
    issue.lastUpdated = new Date().toISOString();
    this.dirty = true;

    tracer.logStateChange('issue-log', `${id}.status`, oldStatus, status);
    tracer.log('issue-log', 'info', `Issue ${status}: ${id}`, {
      title: issue.title,
      resolution,
      totalAttempts: issue.attempts.length,
    });

    return true;
  }

  /**
   * Update an issue's priority.
   */
  updatePriority(id: string, priority: IssuePriority): boolean {
    const tracer = getTracer();
    const issue = this.data.issues.find((i) => i.id === id);

    if (!issue) {
      tracer.log('issue-log', 'warn', `Issue not found for priority update: ${id}`);
      return false;
    }

    const oldPriority = issue.priority;
    issue.priority = priority;
    issue.lastUpdated = new Date().toISOString();
    this.dirty = true;

    tracer.logStateChange('issue-log', `${id}.priority`, oldPriority, priority);
    return true;
  }

  /**
   * Link a goal to an issue.
   */
  linkGoal(issueId: string, goalId: string): boolean {
    const tracer = getTracer();
    const issue = this.data.issues.find((i) => i.id === issueId);

    if (!issue) {
      tracer.log('issue-log', 'warn', `Issue not found for goal linking: ${issueId}`);
      return false;
    }

    issue.goalId = goalId;
    issue.lastUpdated = new Date().toISOString();
    this.dirty = true;

    tracer.log('issue-log', 'debug', `Linked ${issueId} to goal ${goalId}`);
    return true;
  }

  // ── Maintenance ──────────────────────────────────────────────────────────

  /**
   * Prune old resolved/wontfix issues to keep the total count within limits.
   */
  private pruneOldIssues(): void {
    const tracer = getTracer();

    if (this.data.issues.length <= this.config.maxTotalIssues) {
      return;
    }

    const closedIssues = this.data.issues
      .filter((i) => i.status === 'resolved' || i.status === 'wontfix')
      .sort((a, b) => a.lastUpdated.localeCompare(b.lastUpdated));

    const toRemove = this.data.issues.length - this.config.maxTotalIssues;
    const removing = closedIssues.slice(0, toRemove);

    if (removing.length > 0) {
      const removingIds = new Set(removing.map((i) => i.id));
      this.data.issues = this.data.issues.filter((i) => !removingIds.has(i.id));
      this.dirty = true;

      tracer.log('issue-log', 'debug', `Pruned ${removing.length} old issues`, {
        removedIds: removing.map((i) => i.id),
      });
    }
  }

  /**
   * Get the raw data (for testing and debugging).
   */
  getData(): IssueLogData {
    return structuredClone(this.data);
  }
}
