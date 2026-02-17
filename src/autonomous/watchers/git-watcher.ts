/**
 * Git Watcher — Monitors git refs for branch updates
 *
 * Uses `fs.watch` on `.git/refs/heads/` to detect when commits land
 * on watched branches. When a ref file changes, it means a commit
 * was pushed to that branch.
 *
 * On detecting a change:
 *   - Reads the new commit hash from the ref file.
 *   - Uses `git log` to get recent commit messages.
 *   - Emits a `git_push` event to the EventBus.
 *
 * This is intentionally lightweight — it watches ref files rather than
 * running a polling `git fetch` loop. It works for local commits and
 * pulls but does not detect remote-only changes (use `fetchLatest()`
 * in the agent loop for that).
 *
 * Privacy: Only branch names and commit hashes/subjects are logged.
 * No sensitive commit content is read.
 */

import { watch, type FSWatcher } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getTracer } from '../debug.js';
import type { EventBus } from '../events.js';

const execFileAsync = promisify(execFile);

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface GitWatcherConfig {
  /** Root directory of the project */
  projectRoot: string;

  /** Branches to watch for changes */
  watchBranches: string[];

  /** Debounce interval in milliseconds */
  debounceMs: number;

  /** Number of recent commits to include in the event */
  recentCommitCount: number;

  /** Whether this watcher is enabled */
  enabled: boolean;
}

const DEFAULT_CONFIG: GitWatcherConfig = {
  projectRoot: process.cwd(),
  watchBranches: ['main', 'master'],
  debounceMs: 1000,
  recentCommitCount: 5,
  enabled: true,
};

// ─────────────────────────────────────────────────────────────────────────────
// GitWatcher
// ─────────────────────────────────────────────────────────────────────────────

export class GitWatcher {
  private readonly config: GitWatcherConfig;
  private readonly eventBus: EventBus;
  private fsWatcher: FSWatcher | null = null;
  private running: boolean = false;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;

  /** Track known commit hashes to detect actual changes */
  private knownHashes: Map<string, string> = new Map();

  constructor(eventBus: EventBus, config?: Partial<GitWatcherConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.eventBus = eventBus;
  }

  /**
   * Start watching git refs.
   */
  async start(): Promise<void> {
    const tracer = getTracer();

    if (!this.config.enabled) {
      tracer.log('events', 'info', 'Git watcher is disabled');
      return;
    }

    if (this.running) {
      tracer.log('events', 'warn', 'Git watcher already running');
      return;
    }

    const refsPath = join(this.config.projectRoot, '.git', 'refs', 'heads');

    try {
      const stats = await stat(refsPath);
      if (!stats.isDirectory()) {
        tracer.log('events', 'warn', `Not a git repository (no refs/heads): ${refsPath}`);
        return;
      }
    } catch {
      tracer.log('events', 'warn', `Cannot access git refs: ${refsPath}`);
      return;
    }

    // Read initial commit hashes for watched branches
    for (const branch of this.config.watchBranches) {
      try {
        const refFile = join(refsPath, branch);
        const hash = (await readFile(refFile, 'utf8')).trim();
        this.knownHashes.set(branch, hash);
        tracer.log('events', 'debug', `Git watcher: initial hash for ${branch}: ${hash.slice(0, 7)}`);
      } catch {
        // Branch may not exist yet
        tracer.log('events', 'debug', `Git watcher: branch ${branch} not found locally`);
      }
    }

    this.fsWatcher = watch(refsPath, { recursive: false }, (_eventType, filename) => {
      if (filename && this.config.watchBranches.includes(filename)) {
        this.handleRefChange(filename);
      }
    });

    this.fsWatcher.on('error', (err) => {
      tracer.log('events', 'error', `Git watcher error: ${err.message}`);
    });

    this.running = true;
    tracer.log('events', 'info', `Git watcher started. Watching branches: ${this.config.watchBranches.join(', ')}`);
  }

  /**
   * Stop the git watcher.
   */
  stop(): void {
    const tracer = getTracer();

    this.running = false;
    if (this.fsWatcher) {
      this.fsWatcher.close();
      this.fsWatcher = null;
    }
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.knownHashes.clear();

    tracer.log('events', 'info', 'Git watcher stopped');
  }

  /**
   * Whether the watcher is currently active.
   */
  isRunning(): boolean {
    return this.running;
  }

  // ── Private ──────────────────────────────────────────────────────────────

  /**
   * Handle a ref file change with debouncing.
   */
  private handleRefChange(branch: string): void {
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = setTimeout(() => {
      this.processRefChange(branch).catch((err) => {
        const tracer = getTracer();
        tracer.log('events', 'error', `Failed to process ref change for ${branch}`, {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, this.config.debounceMs);
  }

  /**
   * Process a ref change: read the new hash, get recent commits, emit event.
   */
  private async processRefChange(branch: string): Promise<void> {
    const tracer = getTracer();
    const refFile = join(this.config.projectRoot, '.git', 'refs', 'heads', branch);

    try {
      const newHash = (await readFile(refFile, 'utf8')).trim();
      const oldHash = this.knownHashes.get(branch);

      // Only emit if the hash actually changed
      if (newHash === oldHash) {
        tracer.log('events', 'debug', `Git ref unchanged for ${branch}`);
        return;
      }

      this.knownHashes.set(branch, newHash);

      // Get recent commit subjects
      const commits = await this.getRecentCommits(branch);
      const now = new Date().toISOString();

      this.eventBus.emit({
        type: 'git_push',
        branch,
        commits,
        timestamp: now,
      });

      tracer.log('events', 'info', `Git change detected on ${branch}: ${newHash.slice(0, 7)}`, {
        commits: commits.length,
      });
    } catch (err) {
      tracer.log('events', 'error', `Failed to read ref for ${branch}`, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Get recent commit subjects for a branch.
   */
  private async getRecentCommits(branch: string): Promise<string[]> {
    try {
      const { stdout } = await execFileAsync(
        'git',
        ['log', branch, `--oneline`, `-${this.config.recentCommitCount}`],
        { cwd: this.config.projectRoot, timeout: 10_000 },
      );

      return stdout.trim().split('\n').filter(Boolean);
    } catch {
      return [];
    }
  }
}
