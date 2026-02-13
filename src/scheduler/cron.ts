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
 * Compute the next fire time after a given date.
 * Iterates forward minute-by-minute, capped at 366 days to prevent infinite loops.
 */
export function getNextFireTime(cron: CronParts, after: Date): Date {
  // Start from the next minute boundary
  const candidate = new Date(after.getTime());
  candidate.setSeconds(0, 0);
  candidate.setMinutes(candidate.getMinutes() + 1);

  const maxIterations = 366 * 24 * 60; // 366 days in minutes

  for (let i = 0; i < maxIterations; i++) {
    const month = candidate.getMonth() + 1; // 1-12
    const dayOfMonth = candidate.getDate();
    const dayOfWeek = candidate.getDay(); // 0=Sun
    const hour = candidate.getHours();
    const minute = candidate.getMinutes();

    if (
      cron.months.has(month) &&
      cron.daysOfMonth.has(dayOfMonth) &&
      cron.daysOfWeek.has(dayOfWeek) &&
      cron.hours.has(hour) &&
      cron.minutes.has(minute)
    ) {
      return candidate;
    }

    // Advance one minute
    candidate.setMinutes(candidate.getMinutes() + 1);
  }

  // Fallback: should not reach here for valid cron expressions
  // Return 366 days from after as a safety net
  return new Date(after.getTime() + 366 * 24 * 60 * 60 * 1000);
}
