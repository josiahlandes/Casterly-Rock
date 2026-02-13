/**
 * Trigger Normalization (ISSUE-003)
 *
 * Parses user-provided time specifications into absolute UTC timestamps
 * and creates ScheduledJob objects. Handles ISO 8601, "3pm", "in 30 minutes",
 * "tomorrow at 9am".
 */

import { parseCronExpression, getNextFireTime } from './cron.js';
import type { CreateJobInput, CreateJobResult, ScheduledJob } from './types.js';

// ─── Job ID Generation ──────────────────────────────────────────────────────

/**
 * Generate a unique job identifier.
 */
export function generateJobId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return `job-${timestamp}-${random}`;
}

// ─── Redaction ──────────────────────────────────────────────────────────────

/**
 * Redact a message for the job description field.
 * Keeps structure but limits length for safe logging.
 */
export function redactJobDescription(message: string): string {
  if (message.length <= 100) {
    return message;
  }
  return message.substring(0, 100) + '... [truncated]';
}

// ─── Time Parsing ───────────────────────────────────────────────────────────

/** Pattern: "in N minutes/hours/days" */
const RELATIVE_PATTERN = /^in\s+(\d+)\s+(minute|hour|day)s?$/i;

/** Pattern: "Xpm", "Xam", "X:MM PM", "X:MM AM", "HH:MM" */
const TIME_ONLY_PATTERN = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i;

/** Pattern: "tomorrow at Xam/Xpm" */
const TOMORROW_PATTERN = /^tomorrow\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i;

/**
 * Parse a time-only string into hours and minutes.
 * Returns null if invalid.
 */
function parseTimeComponents(
  hourStr: string,
  minuteStr: string | undefined,
  ampm: string | undefined
): { hours: number; minutes: number } | null {
  let hours = parseInt(hourStr, 10);
  const minutes = minuteStr ? parseInt(minuteStr, 10) : 0;

  if (isNaN(hours) || isNaN(minutes) || minutes < 0 || minutes > 59) {
    return null;
  }

  if (ampm) {
    const isPm = ampm.toLowerCase() === 'pm';
    if (hours < 1 || hours > 12) return null;
    if (hours === 12) hours = 0;
    if (isPm) hours += 12;
  } else {
    if (hours < 0 || hours > 23) return null;
  }

  return { hours, minutes };
}

/**
 * Parse a time specification into an absolute UTC timestamp (ms).
 *
 * Supported formats:
 * - ISO 8601: "2026-02-12T15:00:00"
 * - Time only (today): "3pm", "15:00", "3:00 PM"
 * - Relative: "in 30 minutes", "in 2 hours", "in 1 day"
 * - Natural: "tomorrow at 9am"
 *
 * @param input - The time specification string
 * @param now - Optional reference time (defaults to Date.now())
 * @returns Absolute UTC timestamp in ms, or null if unparseable
 */
export function parseTimeSpec(input: string, now?: Date): number | null {
  const trimmed = input.trim();
  const refDate = now ?? new Date();

  // Try relative: "in N minutes/hours/days"
  const relMatch = trimmed.match(RELATIVE_PATTERN);
  if (relMatch) {
    const amount = parseInt(relMatch[1]!, 10);
    const unit = relMatch[2]!.toLowerCase();

    let ms = 0;
    if (unit === 'minute') ms = amount * 60 * 1000;
    else if (unit === 'hour') ms = amount * 60 * 60 * 1000;
    else if (unit === 'day') ms = amount * 24 * 60 * 60 * 1000;

    return refDate.getTime() + ms;
  }

  // Try "tomorrow at Xam/pm"
  const tomorrowMatch = trimmed.match(TOMORROW_PATTERN);
  if (tomorrowMatch) {
    const components = parseTimeComponents(tomorrowMatch[1]!, tomorrowMatch[2], tomorrowMatch[3]);
    if (!components) return null;

    const target = new Date(refDate);
    target.setDate(target.getDate() + 1);
    target.setHours(components.hours, components.minutes, 0, 0);
    return target.getTime();
  }

  // Try time only: "3pm", "15:00", "3:00 PM"
  const timeMatch = trimmed.match(TIME_ONLY_PATTERN);
  if (timeMatch) {
    const components = parseTimeComponents(timeMatch[1]!, timeMatch[2], timeMatch[3]);
    if (!components) return null;

    const target = new Date(refDate);
    target.setHours(components.hours, components.minutes, 0, 0);

    // If the time is in the past today, schedule for tomorrow
    if (target.getTime() <= refDate.getTime()) {
      target.setDate(target.getDate() + 1);
    }

    return target.getTime();
  }

  // Try ISO 8601
  const isoDate = new Date(trimmed);
  if (!isNaN(isoDate.getTime())) {
    return isoDate.getTime();
  }

  return null;
}

// ─── Job Creation ───────────────────────────────────────────────────────────

/**
 * Create a ScheduledJob from user input.
 *
 * Validates that either fireAt or cronExpression is provided.
 * For one-shot: parses the time spec into an absolute timestamp.
 * For cron: validates the expression and computes the first fire time.
 */
export function createScheduledJob(
  input: CreateJobInput,
  recipient: string
): CreateJobResult {
  const { message, label, fireAt, cronExpression, source = 'user_request' } = input;

  if (!message || message.trim() === '') {
    return { success: false, error: 'Message is required' };
  }

  if (!fireAt && !cronExpression) {
    return { success: false, error: 'Either fireAt or cronExpression is required' };
  }

  if (fireAt && cronExpression) {
    return { success: false, error: 'Provide either fireAt or cronExpression, not both' };
  }

  const now = Date.now();
  const description = redactJobDescription(message);

  // One-shot timer
  if (fireAt) {
    const timestamp = parseTimeSpec(fireAt);
    if (timestamp === null) {
      return { success: false, error: `Cannot parse time: "${fireAt}"` };
    }

    if (timestamp <= now) {
      return { success: false, error: 'Fire time is in the past' };
    }

    const job: ScheduledJob = {
      id: generateJobId(),
      triggerType: 'one_shot',
      status: 'active',
      recipient,
      message: message.trim(),
      description,
      fireAt: timestamp,
      createdAt: now,
      fireCount: 0,
      source,
      label,
    };

    return { success: true, job };
  }

  // Cron job
  if (cronExpression) {
    const cron = parseCronExpression(cronExpression);
    if (!cron) {
      return { success: false, error: `Invalid cron expression: "${cronExpression}"` };
    }

    const nextFire = getNextFireTime(cron, new Date(now));

    const job: ScheduledJob = {
      id: generateJobId(),
      triggerType: 'cron',
      status: 'active',
      recipient,
      message: message.trim(),
      description,
      cronExpression,
      nextFireTime: nextFire.getTime(),
      createdAt: now,
      fireCount: 0,
      source,
      label,
    };

    return { success: true, job };
  }

  return { success: false, error: 'Unexpected state' };
}
