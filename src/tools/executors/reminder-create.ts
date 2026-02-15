/**
 * Reminder Create Executor
 *
 * Creates Apple Reminders via JXA (JavaScript for Automation).
 * Supports: title, due date, notes, list name, priority.
 */

import { execSync } from 'node:child_process';
import { safeLogger } from '../../logging/safe-logger.js';
import type { NativeToolCall, NativeToolResult, NativeToolExecutor } from '../schemas/types.js';

// ─── Types ──────────────────────────────────────────────────────────────────

interface ReminderCreateInput {
  title: string;
  dueDate?: string;
  notes?: string;
  list?: string;
  priority?: number;
}

// ─── JXA Script ─────────────────────────────────────────────────────────────

function buildJxaScript(
  title: string,
  dueDate?: string,
  notes?: string,
  list?: string,
  priority?: number,
): string {
  const escapedTitle = JSON.stringify(title);
  const escapedNotes = notes ? JSON.stringify(notes) : 'null';
  const escapedList = list ? JSON.stringify(list) : 'null';
  const dueDateExpr = dueDate ? `new Date("${dueDate}")` : 'null';
  // Apple Reminders priority: 0 = none, 1 = high, 5 = medium, 9 = low
  const apPriority = priority ?? 0;

  return `
var app = Application("Reminders");
app.includeStandardAdditions = true;

var listName = ${escapedList};
var targetList;

if (listName) {
  try {
    targetList = app.lists.byName(listName);
    targetList.name();
  } catch(e) {
    targetList = app.defaultList();
  }
} else {
  targetList = app.defaultList();
}

var props = {
  name: ${escapedTitle},
  body: ${escapedNotes} || ""
};

var dueDate = ${dueDateExpr};
if (dueDate) {
  props.dueDate = dueDate;
}

if (${apPriority} > 0) {
  props.priority = ${apPriority};
}

var reminder = app.Reminder(props);
targetList.reminders.push(reminder);

JSON.stringify({
  id: reminder.id(),
  name: reminder.name(),
  list: targetList.name(),
  dueDate: dueDate ? dueDate.toISOString() : null,
  priority: ${apPriority}
});
`.trim();
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Map user-friendly priority to Apple's 0/1/5/9 scale */
function mapPriority(input?: number | string): number {
  if (input === undefined || input === null) return 0;
  const n = typeof input === 'string' ? parseInt(input, 10) : input;
  if (n <= 0 || isNaN(n)) return 0;
  if (n <= 3) return 1;  // high
  if (n <= 6) return 5;  // medium
  return 9;              // low
}

/** Parse a flexible date/time string into ISO format */
function parseDueDate(input: string): string {
  const trimmed = input.trim().toLowerCase();
  const now = new Date();

  if (trimmed === 'today') {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 0);
    return d.toISOString();
  }
  if (trimmed === 'tomorrow') {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 9, 0, 0);
    return d.toISOString();
  }

  // +Nd offset
  const dayOffset = trimmed.match(/^\+(\d+)d$/);
  if (dayOffset) {
    const days = parseInt(dayOffset[1]!, 10);
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + days, 9, 0, 0);
    return d.toISOString();
  }

  // +Nh offset
  const hourOffset = trimmed.match(/^\+(\d+)h$/);
  if (hourOffset) {
    const hours = parseInt(hourOffset[1]!, 10);
    const d = new Date(now.getTime() + hours * 60 * 60 * 1000);
    return d.toISOString();
  }

  // Try parsing as ISO or natural date
  const parsed = new Date(input);
  if (isNaN(parsed.getTime())) {
    throw new Error(`Cannot parse due date: "${input}". Use ISO format, "today", "tomorrow", "+Nd", or "+Nh".`);
  }
  return parsed.toISOString();
}

// ─── Executor ───────────────────────────────────────────────────────────────

export function createReminderCreateExecutor(): NativeToolExecutor {
  return {
    toolName: 'reminder_create',

    async execute(call: NativeToolCall): Promise<NativeToolResult> {
      const input = call.input as unknown as ReminderCreateInput;

      // Validate title
      if (typeof input.title !== 'string' || input.title.trim() === '') {
        return {
          toolCallId: call.id,
          success: false,
          error: 'Invalid input: title must be a non-empty string',
        };
      }

      // Cap title length
      if (input.title.length > 500) {
        return {
          toolCallId: call.id,
          success: false,
          error: 'Title too long. Maximum 500 characters.',
        };
      }

      // Cap notes length
      if (input.notes && input.notes.length > 2000) {
        return {
          toolCallId: call.id,
          success: false,
          error: 'Notes too long. Maximum 2000 characters.',
        };
      }

      // Parse due date if provided
      let dueDate: string | undefined;
      if (input.dueDate) {
        try {
          dueDate = parseDueDate(input.dueDate);
        } catch (error) {
          return {
            toolCallId: call.id,
            success: false,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }

      const priority = mapPriority(input.priority);

      try {
        const script = buildJxaScript(
          input.title.trim(),
          dueDate,
          input.notes?.trim(),
          input.list?.trim(),
          priority,
        );

        const raw = execSync(`osascript -l JavaScript -e '${script.replace(/'/g, "'\\''")}'`, {
          encoding: 'utf-8',
          timeout: 15000,
        }).trim();

        let result: Record<string, unknown>;
        try {
          result = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          return {
            toolCallId: call.id,
            success: false,
            error: `Failed to parse Reminders response: ${raw.substring(0, 200)}`,
          };
        }

        safeLogger.info('reminder_create executed', {
          list: (result.list as string) ?? 'default',
          hasDueDate: !!dueDate,
          priority,
        });

        return {
          toolCallId: call.id,
          success: true,
          output: JSON.stringify({
            created: true,
            ...result,
          }),
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        if (message.includes('not allowed') || message.includes('permission')) {
          return {
            toolCallId: call.id,
            success: false,
            error: 'Reminders access denied. Grant "Automation" permission to Terminal in System Settings > Privacy & Security.',
          };
        }

        return {
          toolCallId: call.id,
          success: false,
          error: `Reminder creation failed: ${message.substring(0, 300)}`,
        };
      }
    },
  };
}
