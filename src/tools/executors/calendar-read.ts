/**
 * Calendar Read Executor
 *
 * Reads calendar events from macOS Calendar.app via JXA (JavaScript for Automation).
 * Returns structured event data: title, start/end times, location, notes, calendar name.
 */

import { execSync } from 'node:child_process';
import { safeLogger } from '../../logging/safe-logger.js';
import type { NativeToolCall, NativeToolResult, NativeToolExecutor } from '../schemas/types.js';

// ─── Types ──────────────────────────────────────────────────────────────────

interface CalendarReadInput {
  from?: string;
  to?: string;
  calendar?: string;
  limit?: number;
}

interface CalendarEvent {
  title: string;
  startDate: string;
  endDate: string;
  isAllDay: boolean;
  location: string;
  notes: string;
  calendar: string;
}

// ─── JXA Script ─────────────────────────────────────────────────────────────

/**
 * Build a JXA script that queries Calendar.app for events in a date range.
 *
 * JXA is used instead of icalbuddy because it ships with macOS — no extra install.
 * The script runs in `osascript -l JavaScript` mode.
 */
function buildJxaScript(from: string, to: string, calendarFilter?: string, limit?: number): string {
  const maxEvents = limit ?? 50;
  // Escape the calendar filter for embedding in JS string
  const calFilter = calendarFilter
    ? `var calFilter = ${JSON.stringify(calendarFilter)};`
    : 'var calFilter = null;';

  return `
var app = Application("Calendar");
var fromDate = new Date("${from}");
var toDate = new Date("${to}");
${calFilter}
var maxEvents = ${maxEvents};
var results = [];

var calendars = app.calendars();
for (var ci = 0; ci < calendars.length; ci++) {
  var cal = calendars[ci];
  var calName = cal.name();
  if (calFilter && calName !== calFilter) continue;

  var events = cal.events.whose({
    _and: [
      { startDate: { _greaterThan: fromDate } },
      { startDate: { _lessThan: toDate } }
    ]
  })();

  for (var ei = 0; ei < events.length && results.length < maxEvents; ei++) {
    var ev = events[ei];
    results.push({
      title: ev.summary() || "",
      startDate: ev.startDate().toISOString(),
      endDate: ev.endDate().toISOString(),
      isAllDay: ev.alldayEvent(),
      location: ev.location() || "",
      notes: (ev.description() || "").substring(0, 500),
      calendar: calName
    });
  }
  if (results.length >= maxEvents) break;
}

JSON.stringify(results);
`.trim();
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Parse a date string or offset like "today", "tomorrow", "+3d" into an ISO string */
function resolveDate(input: string, isEnd: boolean): string {
  const trimmed = input.trim().toLowerCase();
  const now = new Date();

  if (trimmed === 'today') {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    if (isEnd) d.setDate(d.getDate() + 1);
    return d.toISOString();
  }
  if (trimmed === 'tomorrow') {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    if (isEnd) d.setDate(d.getDate() + 1);
    return d.toISOString();
  }
  if (trimmed === 'this week') {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const dayOfWeek = d.getDay();
    if (!isEnd) {
      d.setDate(d.getDate() - dayOfWeek);
    } else {
      d.setDate(d.getDate() + (7 - dayOfWeek));
    }
    return d.toISOString();
  }

  // +Nd offset
  const offsetMatch = trimmed.match(/^\+(\d+)d$/);
  if (offsetMatch) {
    const days = parseInt(offsetMatch[1]!, 10);
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + days);
    if (isEnd) d.setDate(d.getDate() + 1);
    return d.toISOString();
  }

  // Try parsing as ISO date
  const parsed = new Date(input);
  if (isNaN(parsed.getTime())) {
    throw new Error(`Cannot parse date: "${input}". Use ISO format, "today", "tomorrow", "this week", or "+Nd".`);
  }
  return parsed.toISOString();
}

// ─── Executor ───────────────────────────────────────────────────────────────

export function createCalendarReadExecutor(): NativeToolExecutor {
  return {
    toolName: 'calendar_read',

    async execute(call: NativeToolCall): Promise<NativeToolResult> {
      const input = call.input as unknown as CalendarReadInput;

      // Default range: today
      const fromStr = input.from ?? 'today';
      const toStr = input.to ?? 'tomorrow';

      let fromDate: string;
      let toDate: string;

      try {
        fromDate = resolveDate(fromStr, false);
        toDate = resolveDate(toStr, true);
      } catch (error) {
        return {
          toolCallId: call.id,
          success: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }

      // Limit cap
      const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);

      try {
        const script = buildJxaScript(fromDate, toDate, input.calendar, limit);
        const raw = execSync(`osascript -l JavaScript -e '${script.replace(/'/g, "'\\''")}'`, {
          encoding: 'utf-8',
          timeout: 15000,
        }).trim();

        let events: CalendarEvent[];
        try {
          events = JSON.parse(raw) as CalendarEvent[];
        } catch {
          return {
            toolCallId: call.id,
            success: false,
            error: `Failed to parse Calendar response: ${raw.substring(0, 200)}`,
          };
        }

        // Sort by start date
        events.sort((a, b) => new Date(a.startDate).getTime() - new Date(b.startDate).getTime());

        safeLogger.info('calendar_read executed', {
          from: fromDate.substring(0, 10),
          to: toDate.substring(0, 10),
          events: events.length,
          calendar: input.calendar ?? 'all',
        });

        return {
          toolCallId: call.id,
          success: true,
          output: JSON.stringify({
            from: fromDate,
            to: toDate,
            calendar: input.calendar ?? 'all',
            count: events.length,
            events,
          }),
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        // Common: Calendar.app not running or no permission
        if (message.includes('not allowed') || message.includes('permission')) {
          return {
            toolCallId: call.id,
            success: false,
            error: 'Calendar access denied. Grant "Automation" permission to Terminal in System Settings > Privacy & Security.',
          };
        }

        return {
          toolCallId: call.id,
          success: false,
          error: `Calendar read failed: ${message.substring(0, 300)}`,
        };
      }
    },
  };
}
