/**
 * Message Policy — Controls when Tyrion initiates communication
 *
 * This module determines whether Tyrion should send a message to the user,
 * enforces throttle limits, respects quiet hours, and formats messages.
 *
 * Rules:
 *   - Max N messages per hour and per day (configurable).
 *   - Never during user-configured quiet hours.
 *   - Failures: only notify if Tyrion can't fix them himself.
 *   - Successes: brief, factual ("Fixed flaky detector test. Merged to main.").
 *   - Decisions: only when Tyrion genuinely can't proceed without input.
 *
 * The `message_user` tool in the agent toolkit routes through this policy.
 *
 * Privacy: Messages contain only status information about Tyrion's work.
 * No sensitive user data is included in outbound messages.
 */

import { getTracer } from '../debug.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Events that may result in a user notification.
 */
export type NotifiableEvent =
  | { type: 'fix_complete'; description: string; branch: string }
  | { type: 'test_failure'; test: string; investigating: boolean }
  | { type: 'decision_needed'; question: string; options: string[] }
  | { type: 'daily_summary'; stats: DailySummaryStats }
  | { type: 'security_concern'; description: string; severity: 'low' | 'medium' | 'high' | 'critical' };

/**
 * Stats included in a daily summary notification.
 */
export interface DailySummaryStats {
  /** Number of cycles run today */
  cyclesRun: number;

  /** Number of issues fixed */
  issuesFixed: number;

  /** Number of tests passing */
  testsPassing: number;

  /** Number of tests failing */
  testsFailing: number;

  /** Brief description of codebase health */
  healthSummary: string;
}

/**
 * Throttle configuration.
 */
export interface ThrottleConfig {
  /** Maximum messages per hour */
  maxPerHour: number;

  /** Maximum messages per day */
  maxPerDay: number;

  /** Whether quiet hours are enforced */
  quietHours: boolean;

  /** Quiet hours start (HH:MM format) */
  quietStart: string;

  /** Quiet hours end (HH:MM format) */
  quietEnd: string;
}

/**
 * Full configuration for the message policy.
 */
export interface MessagePolicyConfig {
  /** Whether messaging is enabled at all */
  enabled: boolean;

  /** Throttle settings */
  throttle: ThrottleConfig;

  /** Minimum severity for test failure notifications */
  testFailureMinSeverity: 'always' | 'unresolvable';

  /** Whether to send daily summaries */
  dailySummaryEnabled: boolean;
}

/**
 * Result of a policy check.
 */
export interface PolicyDecision {
  /** Whether the message should be sent */
  allowed: boolean;

  /** Reason the message was blocked (if not allowed) */
  reason?: string | undefined;

  /** The formatted message (if allowed) */
  formattedMessage?: string | undefined;
}

/**
 * Internal record of a sent message (for throttle tracking).
 */
interface SentRecord {
  timestamp: number;
  type: NotifiableEvent['type'];
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: MessagePolicyConfig = {
  enabled: true,
  throttle: {
    maxPerHour: 3,
    maxPerDay: 10,
    quietHours: true,
    quietStart: '22:00',
    quietEnd: '08:00',
  },
  testFailureMinSeverity: 'unresolvable',
  dailySummaryEnabled: true,
};

const ONE_HOUR_MS = 60 * 60 * 1000;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

// ─────────────────────────────────────────────────────────────────────────────
// Message Policy
// ─────────────────────────────────────────────────────────────────────────────

export class MessagePolicy {
  private readonly config: MessagePolicyConfig;
  private readonly sentHistory: SentRecord[] = [];

  constructor(config?: Partial<MessagePolicyConfig>) {
    this.config = {
      ...DEFAULT_CONFIG,
      ...config,
      throttle: { ...DEFAULT_CONFIG.throttle, ...config?.throttle },
    };
  }

  // ── Policy Check ────────────────────────────────────────────────────────

  /**
   * Determine whether an event should result in a user notification.
   * Returns a decision with the formatted message if allowed.
   */
  shouldNotify(event: NotifiableEvent, now: Date = new Date()): PolicyDecision {
    const tracer = getTracer();

    // Master switch
    if (!this.config.enabled) {
      return { allowed: false, reason: 'Messaging is disabled' };
    }

    // Quiet hours check
    if (this.isQuietHours(now)) {
      tracer.log('agent-loop', 'debug', `Message blocked: quiet hours`);
      return { allowed: false, reason: 'Quiet hours are active' };
    }

    // Event-specific filtering
    const eventDecision = this.filterByEventType(event);
    if (!eventDecision.allowed) {
      return eventDecision;
    }

    // Throttle check
    const throttleDecision = this.checkThrottle(now);
    if (!throttleDecision.allowed) {
      tracer.log('agent-loop', 'debug', `Message throttled: ${throttleDecision.reason}`);
      return throttleDecision;
    }

    // Format the message
    const formattedMessage = this.formatMessage(event);

    tracer.log('agent-loop', 'info', `Message approved: [${event.type}]`);

    return { allowed: true, formattedMessage };
  }

  /**
   * Record that a message was sent (for throttle tracking).
   * Call this after successfully delivering a message.
   */
  recordSent(event: NotifiableEvent, now: Date = new Date()): void {
    this.sentHistory.push({
      timestamp: now.getTime(),
      type: event.type,
    });

    // Prune old records (older than 24 hours)
    const cutoff = now.getTime() - ONE_DAY_MS;
    while (this.sentHistory.length > 0 && this.sentHistory[0]!.timestamp < cutoff) {
      this.sentHistory.shift();
    }
  }

  // ── Formatting ──────────────────────────────────────────────────────────

  /**
   * Format a notifiable event into a concise user-facing message.
   */
  formatMessage(event: NotifiableEvent): string {
    switch (event.type) {
      case 'fix_complete':
        return `Fixed: ${event.description}. Branch: ${event.branch}.`;

      case 'test_failure':
        if (event.investigating) {
          return `Test failing: ${event.test}. I'm investigating.`;
        }
        return `Test failing: ${event.test}. I need help with this one.`;

      case 'decision_needed':
        return `I need your input: ${event.question}\nOptions: ${event.options.join(', ')}`;

      case 'daily_summary':
        return this.formatDailySummary(event.stats);

      case 'security_concern':
        return `Security concern (${event.severity}): ${event.description}`;
    }
  }

  // ── Accessors ───────────────────────────────────────────────────────────

  /**
   * Get the current throttle configuration.
   */
  getThrottle(): ThrottleConfig {
    return { ...this.config.throttle };
  }

  /**
   * Check if messaging is enabled.
   */
  isEnabled(): boolean {
    return this.config.enabled;
  }

  /**
   * Get the number of messages sent in the last hour.
   */
  getMessagesSentLastHour(now: Date = new Date()): number {
    const hourAgo = now.getTime() - ONE_HOUR_MS;
    return this.sentHistory.filter((r) => r.timestamp >= hourAgo).length;
  }

  /**
   * Get the number of messages sent today.
   */
  getMessagesSentToday(now: Date = new Date()): number {
    const dayAgo = now.getTime() - ONE_DAY_MS;
    return this.sentHistory.filter((r) => r.timestamp >= dayAgo).length;
  }

  // ── Private Helpers ─────────────────────────────────────────────────────

  /**
   * Check if it's currently quiet hours.
   */
  private isQuietHours(now: Date): boolean {
    if (!this.config.throttle.quietHours) return false;

    const currentMinutes = now.getHours() * 60 + now.getMinutes();
    const startMinutes = parseTimeToMinutes(this.config.throttle.quietStart);
    const endMinutes = parseTimeToMinutes(this.config.throttle.quietEnd);

    // Handle overnight quiet hours (e.g., 22:00 - 08:00)
    if (startMinutes > endMinutes) {
      return currentMinutes >= startMinutes || currentMinutes < endMinutes;
    }

    // Same-day quiet hours (e.g., 12:00 - 14:00)
    return currentMinutes >= startMinutes && currentMinutes < endMinutes;
  }

  /**
   * Filter events by type-specific rules.
   */
  private filterByEventType(event: NotifiableEvent): PolicyDecision {
    switch (event.type) {
      case 'test_failure':
        // Only notify for unresolvable failures if configured that way
        if (this.config.testFailureMinSeverity === 'unresolvable' && event.investigating) {
          return { allowed: false, reason: 'Test failure is being investigated — not notifying yet' };
        }
        return { allowed: true };

      case 'daily_summary':
        if (!this.config.dailySummaryEnabled) {
          return { allowed: false, reason: 'Daily summaries are disabled' };
        }
        return { allowed: true };

      case 'security_concern':
        // Security concerns always pass event-level filtering
        return { allowed: true };

      case 'fix_complete':
      case 'decision_needed':
        return { allowed: true };
    }
  }

  /**
   * Check throttle limits.
   */
  private checkThrottle(now: Date): PolicyDecision {
    const hourCount = this.getMessagesSentLastHour(now);
    if (hourCount >= this.config.throttle.maxPerHour) {
      return {
        allowed: false,
        reason: `Hourly limit reached (${hourCount}/${this.config.throttle.maxPerHour})`,
      };
    }

    const dayCount = this.getMessagesSentToday(now);
    if (dayCount >= this.config.throttle.maxPerDay) {
      return {
        allowed: false,
        reason: `Daily limit reached (${dayCount}/${this.config.throttle.maxPerDay})`,
      };
    }

    return { allowed: true };
  }

  /**
   * Format a daily summary message.
   */
  private formatDailySummary(stats: DailySummaryStats): string {
    const lines: string[] = [
      'Daily Summary:',
      `- Cycles: ${stats.cyclesRun}`,
      `- Issues fixed: ${stats.issuesFixed}`,
      `- Tests: ${stats.testsPassing} passing, ${stats.testsFailing} failing`,
      `- Health: ${stats.healthSummary}`,
    ];
    return lines.join('\n');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse a time string (HH:MM) into minutes since midnight.
 */
function parseTimeToMinutes(time: string): number {
  const [hours, minutes] = time.split(':').map(Number);
  return (hours ?? 0) * 60 + (minutes ?? 0);
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────────────────────

export function createMessagePolicy(
  config?: Partial<MessagePolicyConfig>,
): MessagePolicy {
  return new MessagePolicy(config);
}
