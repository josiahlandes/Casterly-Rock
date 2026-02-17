/**
 * File Watcher — Monitors the codebase for changes
 *
 * Uses Node's native `fs.watch` to detect file changes in watched
 * directories (src/, tests/, config/ by default). Changes are debounced
 * to avoid flooding the event bus with rapid saves.
 *
 * When files change:
 *   - A `file_changed` event is emitted to the EventBus.
 *   - If the changed files are test files, a note is added to metadata
 *     so the agent loop knows to re-run tests.
 *
 * Uses fs.watch (not fs.watchFile / chokidar) to minimize dependencies.
 * fs.watch is platform-native and efficient on macOS (uses FSEvents).
 *
 * Privacy: Only file paths are reported — file contents are never read
 * or logged by the watcher.
 */

import { watch, type FSWatcher } from 'node:fs';
import { join, relative } from 'node:path';
import { stat } from 'node:fs/promises';
import { getTracer } from '../debug.js';
import type { EventBus } from '../events.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface FileWatcherConfig {
  /** Root directory of the project */
  projectRoot: string;

  /** Directories to watch (relative to projectRoot) */
  watchPaths: string[];

  /** Debounce interval in milliseconds */
  debounceMs: number;

  /** Glob patterns to ignore (simple substring matching) */
  ignorePatterns: string[];

  /** Whether this watcher is enabled */
  enabled: boolean;
}

const DEFAULT_CONFIG: FileWatcherConfig = {
  projectRoot: process.cwd(),
  watchPaths: ['src/', 'tests/', 'config/'],
  debounceMs: 500,
  ignorePatterns: ['node_modules/', 'dist/', '.git/', '.DS_Store'],
  enabled: true,
};

// ─────────────────────────────────────────────────────────────────────────────
// FileWatcher
// ─────────────────────────────────────────────────────────────────────────────

export class FileWatcher {
  private readonly config: FileWatcherConfig;
  private readonly eventBus: EventBus;
  private readonly fsWatchers: FSWatcher[] = [];
  private running: boolean = false;

  /** Debounce state: accumulate changed paths, flush after debounce window */
  private pendingChanges: Set<string> = new Set();
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(eventBus: EventBus, config?: Partial<FileWatcherConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.eventBus = eventBus;
  }

  /**
   * Start watching all configured directories.
   */
  async start(): Promise<void> {
    const tracer = getTracer();

    if (!this.config.enabled) {
      tracer.log('events', 'info', 'File watcher is disabled');
      return;
    }

    if (this.running) {
      tracer.log('events', 'warn', 'File watcher already running');
      return;
    }

    this.running = true;

    for (const watchPath of this.config.watchPaths) {
      const fullPath = join(this.config.projectRoot, watchPath);

      try {
        // Verify the directory exists
        const stats = await stat(fullPath);
        if (!stats.isDirectory()) {
          tracer.log('events', 'warn', `Watch path is not a directory: ${watchPath}`);
          continue;
        }

        const watcher = watch(fullPath, { recursive: true }, (eventType, filename) => {
          if (filename) {
            this.handleChange(eventType, join(watchPath, filename));
          }
        });

        watcher.on('error', (err) => {
          tracer.log('events', 'error', `File watcher error on ${watchPath}`, {
            error: err.message,
          });
        });

        this.fsWatchers.push(watcher);
        tracer.log('events', 'info', `Watching: ${watchPath} (recursive)`);
      } catch (err) {
        tracer.log('events', 'warn', `Cannot watch ${watchPath}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    tracer.log('events', 'info', `File watcher started with ${this.fsWatchers.length} watchers`);
  }

  /**
   * Stop all file watchers and clean up.
   */
  stop(): void {
    const tracer = getTracer();

    this.running = false;

    // Close all watchers
    for (const watcher of this.fsWatchers) {
      watcher.close();
    }
    this.fsWatchers.length = 0;

    // Clear any pending debounce
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.pendingChanges.clear();

    tracer.log('events', 'info', 'File watcher stopped');
  }

  /**
   * Whether the watcher is currently active.
   */
  isRunning(): boolean {
    return this.running;
  }

  // ── Private ──────────────────────────────────────────────────────────────

  /**
   * Handle a raw file change event. Debounces changes within the
   * configured window before emitting to the EventBus.
   */
  private handleChange(_eventType: string, filePath: string): void {
    // Check ignore patterns
    if (this.shouldIgnore(filePath)) {
      return;
    }

    // Add to pending changes
    this.pendingChanges.add(filePath);

    // Reset the debounce timer
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = setTimeout(() => {
      this.flushChanges();
    }, this.config.debounceMs);
  }

  /**
   * Flush all accumulated changes as a single event.
   */
  private flushChanges(): void {
    if (this.pendingChanges.size === 0) {
      return;
    }

    const tracer = getTracer();
    const paths = Array.from(this.pendingChanges);
    this.pendingChanges.clear();
    this.debounceTimer = null;

    // Determine change kind
    const changeKind = paths.length === 1 ? 'modified' as const : 'mixed' as const;

    const now = new Date().toISOString();

    this.eventBus.emit({
      type: 'file_changed',
      paths,
      changeKind,
      timestamp: now,
    });

    tracer.log('events', 'debug', `File changes flushed: ${paths.length} files`, {
      paths: paths.slice(0, 5),
      hasMore: paths.length > 5,
    });
  }

  /**
   * Check if a file path matches any ignore pattern.
   */
  private shouldIgnore(filePath: string): boolean {
    return this.config.ignorePatterns.some((pattern) => filePath.includes(pattern));
  }
}
