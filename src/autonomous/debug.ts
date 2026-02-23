/**
 * Debug and Tracing Infrastructure for the Autonomous System
 *
 * Provides structured, hierarchical debug output that makes every operation
 * in the autonomous system transparent and traceable. All output goes through
 * the safe logger to ensure sensitive data is never exposed.
 *
 * Design principles:
 * - Every state transition is logged with before/after context.
 * - Every I/O operation (file read/write, LLM call) is logged with timing.
 * - Trace spans nest hierarchically so you can follow a full operation.
 * - All output respects the privacy redaction pipeline.
 * - Debug output can be enabled/disabled per subsystem via config.
 */

import { redactSensitiveText } from '../security/redactor.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Subsystems that can independently enable/disable debug output.
 * This allows focusing on specific areas during development without
 * drowning in noise from unrelated subsystems.
 */
export type DebugSubsystem =
  | 'world-model'
  | 'goal-stack'
  | 'issue-log'
  | 'identity'
  | 'agent-loop'
  | 'events'
  | 'memory'
  | 'hardware'
  | 'dream'
  | 'communication'
  | 'provider'
  | 'validator'
  | 'git'
  | 'reflector'
  | 'analyzer'
  | 'journal'
  | 'delegation'
  | 'context-budget'
  | 'state-diff'
  | 'trigger'
  | 'session'
  | 'embedding';

export type DebugLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error';

/**
 * A trace span represents a logical unit of work. Spans can nest to form
 * a tree that shows exactly how an operation broke down into sub-operations.
 *
 * Example:
 *   [world-model] ┌ updateFromCodebase
 *   [world-model] │ ├ runTypecheck (142ms, success)
 *   [world-model] │ ├ runTests (3,412ms, 47 passed, 0 failed)
 *   [world-model] │ ├ gitLog (23ms, 5 commits)
 *   [world-model] │ └ writeFile (~/.casterly/world-model.md, 1,204 bytes)
 *   [world-model] └ updateFromCodebase (3,601ms, success)
 */
export interface TraceSpan {
  /** Unique identifier for this span */
  readonly id: string;

  /** The subsystem this span belongs to */
  readonly subsystem: DebugSubsystem;

  /** Human-readable name for this operation */
  readonly name: string;

  /** When this span started */
  readonly startTime: number;

  /** When this span ended (set on close) */
  endTime?: number;

  /** Parent span id, if nested */
  readonly parentId?: string;

  /** Depth in the span tree (0 = root) */
  readonly depth: number;

  /** Key-value metadata attached to this span */
  readonly metadata: Record<string, unknown>;

  /** Whether the operation succeeded, failed, or is still running */
  status: 'running' | 'success' | 'failure';

  /** Error message if status is 'failure' */
  error?: string;
}

/**
 * Configuration for the debug system. Allows fine-grained control over
 * what gets logged and at what verbosity.
 */
export interface DebugConfig {
  /** Master switch — if false, no debug output at all */
  enabled: boolean;

  /** Minimum level to output. 'trace' is most verbose, 'error' is least */
  level: DebugLevel;

  /** Per-subsystem enable/disable. If a subsystem is not listed, it defaults to enabled */
  subsystems: Partial<Record<DebugSubsystem, boolean>>;

  /** Whether to include timestamps in output */
  timestamps: boolean;

  /** Whether to include span duration in output */
  durations: boolean;

  /** Whether to write debug output to a file in addition to console */
  logToFile: boolean;

  /** Path to write debug log file (if logToFile is true) */
  logFilePath: string;
}

/**
 * Listener that receives debug events. Used for testing and for
 * routing debug output to files, dashboards, etc.
 */
export interface DebugListener {
  onSpanStart(span: TraceSpan): void;
  onSpanEnd(span: TraceSpan): void;
  onLog(subsystem: DebugSubsystem, level: DebugLevel, message: string, meta?: unknown): void;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const LEVEL_PRIORITY: Record<DebugLevel, number> = {
  trace: 0,
  debug: 1,
  info: 2,
  warn: 3,
  error: 4,
};

const LEVEL_LABELS: Record<DebugLevel, string> = {
  trace: 'TRC',
  debug: 'DBG',
  info: 'INF',
  warn: 'WRN',
  error: 'ERR',
};

const DEFAULT_CONFIG: DebugConfig = {
  enabled: true,
  level: 'debug',
  subsystems: {},
  timestamps: true,
  durations: true,
  logToFile: false,
  logFilePath: '',
};

// Visual indicators for span tree rendering
const TREE_CHARS = {
  open: '\u250C',     // ┌
  close: '\u2514',    // └
  pipe: '\u2502',     // │
  branch: '\u251C',   // ├
  dash: '\u2500',     // ─
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Debug Tracer (singleton)
// ─────────────────────────────────────────────────────────────────────────────

let spanCounter = 0;

/**
 * The DebugTracer is the central hub for all debug output in the autonomous
 * system. It manages trace spans, routes log messages, and enforces the
 * debug configuration.
 *
 * Usage:
 *   const tracer = getTracer();
 *   const span = tracer.startSpan('world-model', 'updateFromCodebase');
 *   try {
 *     // ... do work, log progress ...
 *     tracer.log('world-model', 'debug', 'Typecheck passed', { errors: 0 });
 *     span.status = 'success';
 *   } catch (err) {
 *     span.status = 'failure';
 *     span.error = String(err);
 *     throw err;
 *   } finally {
 *     tracer.endSpan(span);
 *   }
 *
 * Or use the convenience helper:
 *   const result = await tracer.withSpan('world-model', 'updateFromCodebase', async (span) => {
 *     // ... do work ...
 *     return result;
 *   });
 */
export class DebugTracer {
  private config: DebugConfig;
  private activeSpans: Map<string, TraceSpan> = new Map();
  private spanStack: string[] = [];
  private listeners: DebugListener[] = [];
  private fileBuffer: string[] = [];

  constructor(config?: Partial<DebugConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // ── Configuration ────────────────────────────────────────────────────────

  /**
   * Update the debug configuration at runtime. This allows enabling/disabling
   * debug output without restarting the system.
   */
  updateConfig(config: Partial<DebugConfig>): void {
    this.config = { ...this.config, ...config };
    this.log('world-model', 'debug', 'Debug config updated', {
      enabled: this.config.enabled,
      level: this.config.level,
    });
  }

  /**
   * Get a copy of the current configuration.
   */
  getConfig(): Readonly<DebugConfig> {
    return { ...this.config };
  }

  /**
   * Enable or disable a specific subsystem's debug output.
   */
  setSubsystemEnabled(subsystem: DebugSubsystem, enabled: boolean): void {
    this.config.subsystems[subsystem] = enabled;
  }

  // ── Listeners ────────────────────────────────────────────────────────────

  /**
   * Add a listener that receives all debug events. Useful for testing
   * (capture events and assert on them) and for external integrations.
   */
  addListener(listener: DebugListener): void {
    this.listeners.push(listener);
  }

  /**
   * Remove a previously added listener.
   */
  removeListener(listener: DebugListener): void {
    const index = this.listeners.indexOf(listener);
    if (index >= 0) {
      this.listeners.splice(index, 1);
    }
  }

  /**
   * Remove all listeners. Primarily used in tests for clean teardown.
   */
  clearListeners(): void {
    this.listeners = [];
  }

  // ── Span Management ─────────────────────────────────────────────────────

  /**
   * Start a new trace span. The span remains open until endSpan() is called.
   * Spans automatically nest based on the current span stack.
   */
  startSpan(subsystem: DebugSubsystem, name: string, metadata?: Record<string, unknown>): TraceSpan {
    const id = `span-${++spanCounter}`;
    const parentId = this.spanStack.length > 0
      ? this.spanStack[this.spanStack.length - 1]
      : undefined;

    const span: TraceSpan = {
      id,
      subsystem,
      name,
      startTime: Date.now(),
      ...(parentId !== undefined ? { parentId } : {}),
      depth: this.spanStack.length,
      metadata: metadata ?? {},
      status: 'running',
    };

    this.activeSpans.set(id, span);
    this.spanStack.push(id);

    // Emit start event
    for (const listener of this.listeners) {
      listener.onSpanStart(span);
    }

    // Log the span opening
    if (this.shouldLog(subsystem, 'debug')) {
      const indent = this.buildIndent(span.depth);
      const metaStr = metadata ? ` ${this.formatMeta(metadata)}` : '';
      this.emit(
        subsystem,
        'debug',
        `${indent}${TREE_CHARS.open}${TREE_CHARS.dash} ${name}${metaStr}`
      );
    }

    return span;
  }

  /**
   * End a trace span. Records the duration and emits the closing log line.
   */
  endSpan(span: TraceSpan): void {
    span.endTime = Date.now();
    const durationMs = span.endTime - span.startTime;

    // Remove from stack
    const stackIndex = this.spanStack.lastIndexOf(span.id);
    if (stackIndex >= 0) {
      this.spanStack.splice(stackIndex, 1);
    }
    this.activeSpans.delete(span.id);

    // Emit end event
    for (const listener of this.listeners) {
      listener.onSpanEnd(span);
    }

    // Log the span closing
    if (this.shouldLog(span.subsystem, 'debug')) {
      const indent = this.buildIndent(span.depth);
      const duration = this.config.durations ? ` (${this.formatDuration(durationMs)})` : '';
      const status = span.status === 'failure'
        ? ` FAILED: ${span.error ?? 'unknown error'}`
        : '';
      this.emit(
        span.subsystem,
        span.status === 'failure' ? 'error' : 'debug',
        `${indent}${TREE_CHARS.close}${TREE_CHARS.dash} ${span.name}${duration}${status}`
      );
    }
  }

  /**
   * Convenience method that wraps an async operation in a span. The span
   * is automatically ended when the operation completes (success or failure).
   *
   * Usage:
   *   const result = await tracer.withSpan('world-model', 'runTests', async () => {
   *     return await runTestSuite();
   *   });
   */
  async withSpan<T>(
    subsystem: DebugSubsystem,
    name: string,
    fn: (span: TraceSpan) => Promise<T>,
    metadata?: Record<string, unknown>,
  ): Promise<T> {
    const span = this.startSpan(subsystem, name, metadata);
    try {
      const result = await fn(span);
      if (span.status === 'running') {
        span.status = 'success';
      }
      return result;
    } catch (err) {
      span.status = 'failure';
      span.error = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      this.endSpan(span);
    }
  }

  /**
   * Synchronous version of withSpan for operations that don't need async.
   */
  withSpanSync<T>(
    subsystem: DebugSubsystem,
    name: string,
    fn: (span: TraceSpan) => T,
    metadata?: Record<string, unknown>,
  ): T {
    const span = this.startSpan(subsystem, name, metadata);
    try {
      const result = fn(span);
      if (span.status === 'running') {
        span.status = 'success';
      }
      return result;
    } catch (err) {
      span.status = 'failure';
      span.error = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      this.endSpan(span);
    }
  }

  // ── Logging ──────────────────────────────────────────────────────────────

  /**
   * Log a message from a specific subsystem at a specific level.
   * The message is automatically redacted for sensitive content.
   */
  log(subsystem: DebugSubsystem, level: DebugLevel, message: string, meta?: unknown): void {
    if (!this.shouldLog(subsystem, level)) {
      return;
    }

    // Notify listeners
    for (const listener of this.listeners) {
      listener.onLog(subsystem, level, message, meta);
    }

    // Build the log line with current span context
    const currentDepth = this.spanStack.length;
    const indent = currentDepth > 0
      ? this.buildIndent(currentDepth) + `${TREE_CHARS.pipe} `
      : '';
    const metaStr = meta !== undefined ? ` ${this.formatMeta(meta)}` : '';
    this.emit(subsystem, level, `${indent}${message}${metaStr}`);
  }

  /**
   * Log a state transition — useful for tracking how values change over time.
   * Automatically formats the before/after values.
   */
  logStateChange(
    subsystem: DebugSubsystem,
    field: string,
    before: unknown,
    after: unknown,
  ): void {
    this.log(subsystem, 'debug', `State change: ${field}`, {
      before: this.truncateForLog(before),
      after: this.truncateForLog(after),
    });
  }

  /**
   * Log an I/O operation (file read/write, network call, etc.) with timing.
   */
  logIO(
    subsystem: DebugSubsystem,
    operation: string,
    target: string,
    durationMs: number,
    result: { success: boolean; bytesOrLines?: number; error?: string },
  ): void {
    const size = result.bytesOrLines !== undefined
      ? `, ${result.bytesOrLines} ${result.bytesOrLines === 1 ? 'byte' : 'bytes'}`
      : '';
    const status = result.success ? 'ok' : `FAILED: ${result.error ?? 'unknown'}`;
    this.log(
      subsystem,
      result.success ? 'debug' : 'error',
      `${operation} ${target} (${this.formatDuration(durationMs)}${size}) [${status}]`,
    );
  }

  // ── Inspection ───────────────────────────────────────────────────────────

  /**
   * Get all currently active (open) spans. Useful for debugging stuck operations.
   */
  getActiveSpans(): ReadonlyArray<TraceSpan> {
    return Array.from(this.activeSpans.values());
  }

  /**
   * Get the current span stack depth. Useful for assertions in tests.
   */
  getSpanDepth(): number {
    return this.spanStack.length;
  }

  /**
   * Flush any buffered file output. Call this before process exit to ensure
   * all debug output is written.
   */
  async flush(): Promise<void> {
    if (this.config.logToFile && this.fileBuffer.length > 0) {
      const { appendFile } = await import('node:fs/promises');
      const content = this.fileBuffer.join('\n') + '\n';
      this.fileBuffer = [];
      await appendFile(this.config.logFilePath, content, 'utf8');
    }
  }

  /**
   * Reset all internal state. Used in tests for clean setup.
   */
  reset(): void {
    this.activeSpans.clear();
    this.spanStack = [];
    this.fileBuffer = [];
    spanCounter = 0;
  }

  // ── Internal helpers ─────────────────────────────────────────────────────

  /**
   * Determine if a log message should be emitted based on the current
   * configuration (master switch, level threshold, subsystem filter).
   */
  private shouldLog(subsystem: DebugSubsystem, level: DebugLevel): boolean {
    if (!this.config.enabled) {
      return false;
    }

    // Check subsystem filter
    const subsystemEnabled = this.config.subsystems[subsystem];
    if (subsystemEnabled === false) {
      return false;
    }

    // Check level threshold
    return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[this.config.level];
  }

  /**
   * Emit a formatted log line to console and optionally to file.
   * All output passes through the security redactor.
   */
  private emit(subsystem: DebugSubsystem, level: DebugLevel, message: string): void {
    const timestamp = this.config.timestamps
      ? `${new Date().toISOString()} `
      : '';
    const levelLabel = LEVEL_LABELS[level];
    const line = `${timestamp}[${levelLabel}] [${subsystem}] ${message}`;

    // Redact sensitive content before output
    const safeLine = redactSensitiveText(line);

    // Console output
    if (level === 'error') {
      console.error(safeLine);
    } else if (level === 'warn') {
      console.warn(safeLine);
    } else {
      console.log(safeLine);
    }

    // Buffer for file output
    if (this.config.logToFile) {
      this.fileBuffer.push(safeLine);

      // Auto-flush when buffer gets large
      if (this.fileBuffer.length >= 100) {
        void this.flush();
      }
    }
  }

  /**
   * Build indentation for the current span depth using tree characters.
   */
  private buildIndent(depth: number): string {
    if (depth === 0) {
      return '';
    }
    return `${TREE_CHARS.pipe} `.repeat(depth);
  }

  /**
   * Format metadata for inclusion in log lines. Handles objects, arrays,
   * and primitives. Truncates large values to prevent log flooding.
   */
  private formatMeta(meta: unknown): string {
    if (meta === undefined || meta === null) {
      return '';
    }

    if (typeof meta === 'string') {
      return meta.length > 200 ? `${meta.slice(0, 200)}...` : meta;
    }

    if (typeof meta === 'number' || typeof meta === 'boolean') {
      return String(meta);
    }

    try {
      const serialized = JSON.stringify(meta);
      if (serialized.length > 500) {
        return `${serialized.slice(0, 500)}...`;
      }
      return serialized;
    } catch {
      return '[unserializable]';
    }
  }

  /**
   * Truncate a value for state-change logging. Shows enough to understand
   * the change without flooding the log.
   */
  private truncateForLog(value: unknown): unknown {
    if (value === undefined || value === null) {
      return value;
    }

    if (typeof value === 'string') {
      return value.length > 100 ? `${value.slice(0, 100)}...` : value;
    }

    if (Array.isArray(value)) {
      return `[Array(${value.length})]`;
    }

    if (typeof value === 'object') {
      const keys = Object.keys(value);
      return `{${keys.slice(0, 5).join(', ')}${keys.length > 5 ? ', ...' : ''}}`;
    }

    return value;
  }

  /**
   * Format a duration in milliseconds into a human-readable string.
   */
  private formatDuration(ms: number): string {
    if (ms < 1) {
      return '<1ms';
    }
    if (ms < 1000) {
      return `${Math.round(ms)}ms`;
    }
    if (ms < 60_000) {
      return `${(ms / 1000).toFixed(1)}s`;
    }
    const minutes = Math.floor(ms / 60_000);
    const seconds = Math.round((ms % 60_000) / 1000);
    return `${minutes}m${seconds}s`;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Singleton Access
// ─────────────────────────────────────────────────────────────────────────────

let globalTracer: DebugTracer | undefined;

/**
 * Get the global debug tracer instance. Creates one with default config
 * if none exists. This is the primary entry point for all debug operations.
 */
export function getTracer(): DebugTracer {
  if (!globalTracer) {
    globalTracer = new DebugTracer();
  }
  return globalTracer;
}

/**
 * Initialize the global tracer with specific configuration. Should be called
 * once at startup. If called again, replaces the existing tracer.
 */
export function initTracer(config: Partial<DebugConfig>): DebugTracer {
  globalTracer = new DebugTracer(config);
  return globalTracer;
}

/**
 * Reset the global tracer. Used in tests for clean state.
 */
export function resetTracer(): void {
  if (globalTracer) {
    globalTracer.reset();
    globalTracer.clearListeners();
  }
  globalTracer = undefined;
}
