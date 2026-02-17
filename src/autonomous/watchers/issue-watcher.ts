/**
 * Issue Aging Watcher — Detects stale issues
 *
 * Periodically checks the issue log for issues that haven't had
 * activity in a configurable number of days. When a stale issue is
 * found, it emits an `issue_stale` event so the agent loop can
 * prioritize revisiting it.
 *
 * This replaces continuous polling with a periodic check (default
 * every 6 hours), since issue staleness changes slowly.
 *
 * Privacy: Only issue IDs and metadata are used. No user content
 * is accessed or logged.
 */

import { getTracer } from '../debug.js';
import type { EventBus } from '../events.js';
import type { IssueLog } from '../issue-log.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface IssueWatcherConfig {
  /** How often to check for stale issues (in milliseconds) */
  checkIntervalMs: number;

  /** Number of days without activity before an issue is considered stale */
  staleDays: number;

  /** Whether this watcher is enabled */
  enabled: boolean;
}

const DEFAULT_CONFIG: IssueWatcherConfig = {
  checkIntervalMs: 6 * 60 * 60 * 1000, // 6 hours
  staleDays: 7,
  enabled: true,
};

// ─────────────────────────────────────────────────────────────────────────────
// IssueWatcher
// ─────────────────────────────────────────────────────────────────────────────

export class IssueWatcher {
  private readonly config: IssueWatcherConfig;
  private readonly eventBus: EventBus;
  private readonly issueLog: IssueLog;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running: boolean = false;

  /** Track which issues we've already emitted stale events for in this session */
  private notifiedStaleIssues: Set<string> = new Set();

  constructor(eventBus: EventBus, issueLog: IssueLog, config?: Partial<IssueWatcherConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.eventBus = eventBus;
    this.issueLog = issueLog;
  }

  /**
   * Start the periodic stale issue check.
   */
  start(): void {
    const tracer = getTracer();

    if (!this.config.enabled) {
      tracer.log('events', 'info', 'Issue watcher is disabled');
      return;
    }

    if (this.running) {
      tracer.log('events', 'warn', 'Issue watcher already running');
      return;
    }

    this.running = true;

    // Run an initial check immediately
    this.checkForStaleIssues();

    // Then schedule periodic checks
    this.timer = setInterval(() => {
      this.checkForStaleIssues();
    }, this.config.checkIntervalMs);

    // Mark the interval as non-blocking so it doesn't prevent process exit
    if (this.timer && typeof this.timer === 'object' && 'unref' in this.timer) {
      this.timer.unref();
    }

    const intervalHours = Math.round(this.config.checkIntervalMs / (60 * 60 * 1000) * 10) / 10;
    tracer.log('events', 'info', `Issue watcher started (checking every ${intervalHours}h, stale after ${this.config.staleDays} days)`);
  }

  /**
   * Stop the periodic check.
   */
  stop(): void {
    const tracer = getTracer();

    this.running = false;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.notifiedStaleIssues.clear();

    tracer.log('events', 'info', 'Issue watcher stopped');
  }

  /**
   * Whether the watcher is currently active.
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Run a stale issue check immediately (can be called manually for testing).
   */
  checkForStaleIssues(): void {
    const tracer = getTracer();

    const staleIssues = this.issueLog.getStaleIssues();
    const now = new Date().toISOString();

    let newStaleCount = 0;

    for (const issue of staleIssues) {
      // Only emit once per session per issue
      if (this.notifiedStaleIssues.has(issue.id)) {
        continue;
      }

      const daysSinceActivity = this.calculateDaysSince(issue.lastUpdated);

      this.eventBus.emit({
        type: 'issue_stale',
        issueId: issue.id,
        daysSinceActivity,
        timestamp: now,
      });

      this.notifiedStaleIssues.add(issue.id);
      newStaleCount++;
    }

    if (newStaleCount > 0) {
      tracer.log('events', 'info', `Issue watcher: ${newStaleCount} new stale issues detected`, {
        totalStale: staleIssues.length,
        newlyNotified: newStaleCount,
      });
    } else {
      tracer.log('events', 'debug', `Issue watcher: no new stale issues (${staleIssues.length} total stale)`);
    }
  }

  /**
   * Reset the "already notified" set. Called when an issue is updated,
   * so it can be re-detected as stale if it goes quiet again.
   */
  clearNotification(issueId: string): void {
    this.notifiedStaleIssues.delete(issueId);
  }

  /**
   * Clear all notifications (e.g., on session start).
   */
  clearAllNotifications(): void {
    this.notifiedStaleIssues.clear();
  }

  // ── Private ──────────────────────────────────────────────────────────────

  /**
   * Calculate days since a given ISO timestamp.
   */
  private calculateDaysSince(isoTimestamp: string): number {
    const then = new Date(isoTimestamp).getTime();
    const now = Date.now();
    return Math.floor((now - then) / (24 * 60 * 60 * 1000));
  }
}
