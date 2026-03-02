/**
 * Event System — Tyrion's awareness backbone
 *
 * The EventBus is the central nervous system that connects watchers
 * (file changes, git activity, issue aging) to the agent loop. Events
 * arrive asynchronously and are queued for processing. The agent loop
 * drains the queue at the start of each cycle and picks the highest-
 * priority event to act on.
 *
 * Event lifecycle:
 *   1. A watcher detects a change and calls `eventBus.emit(event)`.
 *   2. The event is added to the queue and timestamped.
 *   3. Registered handlers are notified (for logging, metrics, etc.).
 *   4. The agent loop calls `eventBus.drain()` to consume queued events.
 *   5. Events are sorted by priority and the top one triggers a cycle.
 *
 * Design principles:
 *   - Events are immutable once created.
 *   - The queue has a bounded size (old low-priority events are dropped).
 *   - All event processing is logged through the debug tracer.
 *   - Events never contain raw sensitive user data (file paths only).
 *
 * Privacy: Events contain only codebase metadata (file paths, branch
 * names, test names). No user-provided content is stored in events.
 */

import { getTracer } from './debug.js';

// ─────────────────────────────────────────────────────────────────────────────
// Event Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * All system event types. Each watcher emits one or more of these.
 */
export type SystemEvent =
  | FileChangedEvent
  | TestFailedEvent
  | GitPushEvent
  | BuildErrorEvent
  | IssueStalledEvent
  | UserMessageEvent
  | ScheduledEvent;

/**
 * Files in the project were created, modified, or deleted.
 * Emitted by the file watcher after debouncing.
 */
interface FileChangedEvent {
  type: 'file_changed';
  paths: string[];
  changeKind: 'created' | 'modified' | 'deleted' | 'mixed';
  timestamp: string;
}

/**
 * A test failed (detected by the file watcher after a test file change,
 * or by the agent loop after running tests).
 */
interface TestFailedEvent {
  type: 'test_failed';
  testName: string;
  output: string;
  timestamp: string;
}

/**
 * A git push or commit was detected on a watched branch.
 * Emitted by the git watcher.
 */
interface GitPushEvent {
  type: 'git_push';
  branch: string;
  commits: string[];
  timestamp: string;
}

/**
 * A build or compilation error was detected.
 */
interface BuildErrorEvent {
  type: 'build_error';
  error: string;
  timestamp: string;
}

/**
 * An issue has been stale for too long without activity.
 * Emitted by the issue aging watcher.
 */
interface IssueStalledEvent {
  type: 'issue_stale';
  issueId: string;
  daysSinceActivity: number;
  timestamp: string;
}

/**
 * The user sent a message (e.g., via iMessage or CLI).
 */
interface UserMessageEvent {
  type: 'user_message';
  sender: string;
  message: string;
  timestamp: string;
}

/**
 * A scheduled timer fired (fallback when no events arrive).
 */
interface ScheduledEvent {
  type: 'scheduled';
  reason: string;
  timestamp: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Priority
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Priority ranking for events. Lower number = higher priority.
 * User messages always preempt everything else.
 */
const EVENT_PRIORITY: Record<SystemEvent['type'], number> = {
  user_message: 0,
  test_failed: 1,
  build_error: 2,
  file_changed: 3,
  git_push: 4,
  issue_stale: 5,
  scheduled: 6,
};

/**
 * Get the priority of an event (lower is more urgent).
 */
export function getEventPriority(event: SystemEvent): number {
  return EVENT_PRIORITY[event.type];
}

/**
 * Compare two events by priority (for sorting: highest priority first).
 */
export function compareEventPriority(a: SystemEvent, b: SystemEvent): number {
  const priorityDiff = getEventPriority(a) - getEventPriority(b);
  if (priorityDiff !== 0) return priorityDiff;
  // Same priority: older events first (FIFO within priority)
  return a.timestamp.localeCompare(b.timestamp);
}

// ─────────────────────────────────────────────────────────────────────────────
// Event Handler Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Handler function for a specific event type.
 */
export type EventHandler<T extends SystemEvent = SystemEvent> = (event: T) => void;

/**
 * Wildcard handler that receives all events.
 */
type WildcardHandler = (event: SystemEvent) => void;

// ─────────────────────────────────────────────────────────────────────────────
// EventBus Configuration
// ─────────────────────────────────────────────────────────────────────────────

export interface EventBusConfig {
  /** Maximum events to keep in the queue before dropping old low-priority ones */
  maxQueueSize: number;

  /** Whether to log all events through the debug tracer */
  logEvents: boolean;
}

const DEFAULT_CONFIG: EventBusConfig = {
  maxQueueSize: 100,
  logEvents: true,
};

// ─────────────────────────────────────────────────────────────────────────────
// EventBus
// ─────────────────────────────────────────────────────────────────────────────

export class EventBus {
  private readonly config: EventBusConfig;
  private readonly queue: SystemEvent[] = [];
  private readonly handlers: Map<string, EventHandler[]> = new Map();
  private readonly wildcardHandlers: WildcardHandler[] = [];
  private paused: boolean = false;

  constructor(config?: Partial<EventBusConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Emit an event. The event is added to the queue and all matching
   * handlers are notified synchronously.
   */
  emit(event: SystemEvent): void {
    const tracer = getTracer();

    if (this.paused) {
      tracer.log('events', 'debug', `Event dropped (bus paused): ${event.type}`);
      return;
    }

    // Add to queue
    this.queue.push(event);

    // Trim queue if over max size (drop oldest low-priority events)
    this.trimQueue();

    if (this.config.logEvents) {
      tracer.log('events', 'info', `Event emitted: ${event.type}`, {
        priority: getEventPriority(event),
        queueSize: this.queue.length,
        ...this.getEventMetadata(event),
      });
    }

    // Notify type-specific handlers
    const typeHandlers = this.handlers.get(event.type);
    if (typeHandlers) {
      for (const handler of typeHandlers) {
        try {
          handler(event);
        } catch (err) {
          tracer.log('events', 'error', `Handler error for ${event.type}`, {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    // Notify wildcard handlers
    for (const handler of this.wildcardHandlers) {
      try {
        handler(event);
      } catch (err) {
        tracer.log('events', 'error', `Wildcard handler error for ${event.type}`, {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  /**
   * Register a handler for a specific event type.
   */
  on<T extends SystemEvent['type']>(
    type: T,
    handler: EventHandler<Extract<SystemEvent, { type: T }>>,
  ): void {
    const existing = this.handlers.get(type) ?? [];
    existing.push(handler as EventHandler);
    this.handlers.set(type, existing);
  }

  /**
   * Register a wildcard handler that receives all events.
   */
  onAny(handler: WildcardHandler): void {
    this.wildcardHandlers.push(handler);
  }

  /**
   * Remove a specific event handler.
   */
  off<T extends SystemEvent['type']>(
    type: T,
    handler: EventHandler<Extract<SystemEvent, { type: T }>>,
  ): void {
    const existing = this.handlers.get(type);
    if (existing) {
      const filtered = existing.filter((h) => h !== handler);
      this.handlers.set(type, filtered);
    }
  }

  /**
   * Remove a wildcard handler.
   */
  offAny(handler: WildcardHandler): void {
    const index = this.wildcardHandlers.indexOf(handler);
    if (index >= 0) {
      this.wildcardHandlers.splice(index, 1);
    }
  }

  /**
   * Get the current event queue (read-only snapshot).
   * Events are returned sorted by priority (highest first).
   */
  getQueue(): ReadonlyArray<SystemEvent> {
    return [...this.queue].sort(compareEventPriority);
  }

  /**
   * Get the current queue size.
   */
  getQueueSize(): number {
    return this.queue.length;
  }

  /**
   * Drain the event queue.
   *
   * - Without `maxEvents`: returns all events sorted by priority and clears
   *   the queue.
   * - With `maxEvents`: returns up to that many highest-priority events and
   *   removes only those from the queue, leaving the remainder for future
   *   cycles.
   */
  drain(maxEvents?: number): SystemEvent[] {
    const tracer = getTracer();
    const events = [...this.queue].sort(compareEventPriority);

    if (maxEvents === undefined) {
      this.queue.length = 0;
      tracer.log('events', 'debug', `Drained ${events.length} events from queue`);
      return events;
    }

    const limit = Math.max(0, Math.floor(maxEvents));
    const selected = events.slice(0, limit);

    if (selected.length === 0) {
      tracer.log('events', 'debug', 'Drained 0 events from queue (bounded drain)');
      return selected;
    }

    const selectedSet = new Set(selected);
    this.queue.splice(
      0,
      this.queue.length,
      ...this.queue.filter((event) => !selectedSet.has(event)),
    );

    tracer.log('events', 'debug', `Drained ${selected.length} events from queue (bounded drain)`, {
      remaining: this.queue.length,
    });
    return selected;
  }

  /**
   * Peek at the highest-priority event without removing it.
   */
  peek(): SystemEvent | undefined {
    if (this.queue.length === 0) return undefined;
    return [...this.queue].sort(compareEventPriority)[0];
  }

  /**
   * Check if the queue has events of a given type.
   */
  hasEventsOfType(type: SystemEvent['type']): boolean {
    return this.queue.some((e) => e.type === type);
  }

  /**
   * Pause the event bus. Events emitted while paused are dropped.
   */
  pause(): void {
    this.paused = true;
    const tracer = getTracer();
    tracer.log('events', 'debug', 'EventBus paused');
  }

  /**
   * Resume the event bus.
   */
  resume(): void {
    this.paused = false;
    const tracer = getTracer();
    tracer.log('events', 'debug', 'EventBus resumed');
  }

  /**
   * Whether the bus is currently paused.
   */
  isPaused(): boolean {
    return this.paused;
  }

  /**
   * Clear the queue and all handlers.
   */
  reset(): void {
    this.queue.length = 0;
    this.handlers.clear();
    this.wildcardHandlers.length = 0;
    this.paused = false;
  }

  /**
   * Remove all handlers but keep the queue.
   */
  removeAllHandlers(): void {
    this.handlers.clear();
    this.wildcardHandlers.length = 0;
  }

  // ── Private ──────────────────────────────────────────────────────────────

  /**
   * Trim the queue to maxQueueSize by dropping oldest low-priority events.
   */
  private trimQueue(): void {
    if (this.queue.length <= this.config.maxQueueSize) {
      return;
    }

    const tracer = getTracer();

    // Sort by priority (highest priority / lowest number first)
    this.queue.sort((a, b) => compareEventPriority(a, b));

    // Remove excess events from the end (lowest priority)
    const removed = this.queue.length - this.config.maxQueueSize;
    this.queue.splice(this.config.maxQueueSize, removed);

    // Re-sort into insertion order (queue is treated as FIFO within priority)
    tracer.log('events', 'debug', `Trimmed ${removed} low-priority events from queue`);
  }

  /**
   * Extract loggable metadata from an event (without sensitive data).
   */
  private getEventMetadata(event: SystemEvent): Record<string, unknown> {
    switch (event.type) {
      case 'file_changed':
        return { paths: event.paths.length, changeKind: event.changeKind };
      case 'test_failed':
        return { testName: event.testName };
      case 'git_push':
        return { branch: event.branch, commits: event.commits.length };
      case 'build_error':
        return { errorLength: event.error.length };
      case 'issue_stale':
        return { issueId: event.issueId, days: event.daysSinceActivity };
      case 'user_message':
        return { sender: event.sender };
      case 'scheduled':
        return { reason: event.reason };
    }
  }
}
