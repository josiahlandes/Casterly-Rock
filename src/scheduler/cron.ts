/**
 * Cron Evaluator (ISSUE-003)
 *
 * Minimal 5-field cron expression parser and next-fire-time calculator.
 * Zero dependencies. Supports: wildcards, values, comma lists, ranges (1-5), steps (e.g. every 15 min).
 *
 * Fields: minute(0-59) hour(0-23) day-of-month(1-31) month(1-12) day-of-week(0-6, 0=Sun)
 */

// ─── Types ──────────────────────────────────────────────────────────────────

export interface CronParts {
  minutes: Set<number>;
  hours: Set<number>;
  daysOfMonth: Set<number>;
  months: Set<number>;
  daysOfWeek: Set<number>;
}

// ─── Field Parsing ──────────────────────────────────────────────────────────

/**
 * Parse a single cron field into a set of valid values.
 * Supports: *, N, N-M, N-M/S, * /S, N,M,O
 */
function parseField(field: string, min: number, max: number): Set<number> | null {
  const result = new Set<number>();

  const parts = field.split(',');
  for (const part of parts) {
    const trimmed = part.trim();

    // Step pattern: */N or N-M/S
    const stepMatch = trimmed.match(/^(\*|(\d+)-(\d+))\/(\d+)$/);
    if (stepMatch) {
      const step = parseInt(stepMatch[4]!, 10);
      if (step <= 0) return null;

      let rangeMin = min;
      let rangeMax = max;

      if (stepMatch[1] !== '*') {
        rangeMin = parseInt(stepMatch[2]!, 10);
        rangeMax = parseInt(stepMatch[3]!, 10);
      }

      if (rangeMin < min || rangeMax > max || rangeMin > rangeMax) return null;

      for (let i = rangeMin; i <= rangeMax; i += step) {
        result.add(i);
      }
      continue;
    }

    // Wildcard
    if (trimmed === '*') {
      for (let i = min; i <= max; i++) {
        result.add(i);
      }
      continue;
    }

    // Range: N-M
    const rangeMatch = trimmed.match(/^(\d+)-(\d+)$/);
    if (rangeMatch) {
      const rangeStart = parseInt(rangeMatch[1]!, 10);
      const rangeEnd = parseInt(rangeMatch[2]!, 10);
      if (rangeStart < min || rangeEnd > max || rangeStart > rangeEnd) return null;

      for (let i = rangeStart; i <= rangeEnd; i++) {
        result.add(i);
      }
      continue;
    }

    // Single value
    const num = parseInt(trimmed, 10);
    if (isNaN(num) || num < min || num > max) return null;
    result.add(num);
  }

  return result.size > 0 ? result : null;
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Parse a 5-field cron expression into structured parts.
 * Returns null if the expression is invalid.
 */
export function parseCronExpression(expression: string): CronParts | null {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return null;

  const minutes = parseField(fields[0]!, 0, 59);
  const hours = parseField(fields[1]!, 0, 23);
  const daysOfMonth = parseField(fields[2]!, 1, 31);
  const months = parseField(fields[3]!, 1, 12);
  const daysOfWeek = parseField(fields[4]!, 0, 6);

  if (!minutes || !hours || !daysOfMonth || !months || !daysOfWeek) {
    return null;
  }

  return { minutes, hours, daysOfMonth, months, daysOfWeek };
}

/**
 * Check if a cron expression is valid.
 */
export function isValidCronExpression(expression: string): boolean {
  return parseCronExpression(expression) !== null;
}

/**
 * Check whether a field is an unrestricted wildcard (contains every value in its range).
 */
function isWildcard(field: Set<number>, min: number, max: number): boolean {
  if (field.size !== max - min + 1) return false;
  for (let i = min; i <= max; i++) {
    if (!field.has(i)) return false;
  }
  return true;
}

/**
 * Extract date components in a given IANA timezone (or local time if omitted).
 *
 * Local-first: cron expressions mean local time by default. A "0 8 * * *"
 * schedule fires at 8am in the user's timezone, not 8am UTC.
 */
function datePartsInTz(
  date: Date,
  timezone?: string,
): { month: number; dayOfMonth: number; dayOfWeek: number; hour: number; minute: number } {
  if (!timezone) {
    return {
      month: date.getMonth() + 1,
      dayOfMonth: date.getDate(),
      dayOfWeek: date.getDay(),
      hour: date.getHours(),
      minute: date.getMinutes(),
    };
  }

  // Use Intl to resolve parts in the target timezone
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    weekday: 'short',
    hour12: false,
  });

  const parts = Object.fromEntries(
    formatter.formatToParts(date).map((p) => [p.type, p.value]),
  );

  const weekdayMap: Record<string, number> = {
    Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
  };

  return {
    month: parseInt(parts.month ?? '1', 10),
    dayOfMonth: parseInt(parts.day ?? '1', 10),
    dayOfWeek: weekdayMap[parts.weekday ?? 'Sun'] ?? 0,
    hour: parseInt(parts.hour ?? '0', 10),
    minute: parseInt(parts.minute ?? '0', 10),
  };
}

/**
 * Compute the next fire time after a given date.
 * Iterates forward minute-by-minute, capped at 366 days to prevent infinite loops.
 *
 * Standard cron semantics: when both day-of-month and day-of-week are
 * restricted (non-wildcard), the day matches if *either* field matches.
 * When only one is restricted, it alone determines the day match.
 *
 * @param timezone - Optional IANA timezone (e.g. "America/New_York"). Defaults to local time.
 */
export function getNextFireTime(cron: CronParts, after: Date, timezone?: string): Date {
  // Start from the next minute boundary.
  // Use absolute ms to advance — works correctly across DST transitions.
  const startMs = after.getTime();
  const offsetMs = (60 - after.getSeconds()) * 1000 - after.getMilliseconds();
  let candidateMs = startMs + offsetMs; // next whole minute
  if (candidateMs <= startMs) candidateMs += 60_000;

  const maxIterations = 366 * 24 * 60; // 366 days in minutes

  const domIsWildcard = isWildcard(cron.daysOfMonth, 1, 31);
  const dowIsWildcard = isWildcard(cron.daysOfWeek, 0, 6);

  for (let i = 0; i < maxIterations; i++) {
    const candidate = new Date(candidateMs);
    const { month, dayOfMonth, dayOfWeek, hour, minute } = datePartsInTz(candidate, timezone);

    // Standard cron day matching: OR when both DOM and DOW are restricted
    let dayMatches: boolean;
    if (!domIsWildcard && !dowIsWildcard) {
      dayMatches = cron.daysOfMonth.has(dayOfMonth) || cron.daysOfWeek.has(dayOfWeek);
    } else {
      dayMatches = cron.daysOfMonth.has(dayOfMonth) && cron.daysOfWeek.has(dayOfWeek);
    }

    if (
      cron.months.has(month) &&
      dayMatches &&
      cron.hours.has(hour) &&
      cron.minutes.has(minute)
    ) {
      return candidate;
    }

    // Advance one minute
    candidateMs += 60_000;
  }

  // Fallback: should not reach here for valid cron expressions
  // Return 366 days from after as a safety net
  return new Date(after.getTime() + 366 * 24 * 60 * 60 * 1000);
}
