/**
 * Scheduler Tool Schemas (ISSUE-003)
 *
 * Tool schemas for the LLM to create, list, and cancel scheduled reminders.
 * Registered dynamically in the daemon per-message (not in core tools).
 */

import type { ToolSchema } from '../tools/schemas/types.js';

export const SCHEDULE_REMINDER_TOOL: ToolSchema = {
  name: 'schedule_reminder',
  description: `Schedule a reminder or recurring task to be sent via iMessage.

Use fireAt for one-shot reminders:
- ISO 8601: "2026-02-12T15:00:00"
- Time today: "3pm", "15:00"
- Relative: "in 30 minutes", "in 2 hours"
- Tomorrow: "tomorrow at 9am"

Use cronExpression for recurring:
- "0 9 * * 1" = every Monday at 9am
- "0 8 * * *" = every day at 8am
- "30 17 * * 1-5" = weekdays at 5:30pm

Provide either fireAt OR cronExpression, not both.

Set actionable to true when the user wants something DONE at fire time
(e.g. "check the weather", "summarize my emails"). When false (default),
the message is sent verbatim as a plain reminder.

IMPORTANT: Reminders always fire back to the person who scheduled them.
To send a message to someone else at a specific time, set actionable=true
and put the full instruction as the message (e.g. message="Send Katie a
message saying Hi"). The instruction will be executed through the full
assistant pipeline at fire time, which can call send_message.`,

  inputSchema: {
    type: 'object',
    properties: {
      message: {
        type: 'string',
        description: 'The message to send when the reminder fires, or the instruction to execute if actionable is true.',
      },
      label: {
        type: 'string',
        description: 'Short label for the reminder (e.g., "dentist call", "weekly summary").',
      },
      fireAt: {
        type: 'string',
        description: 'When to fire (one-shot): ISO datetime, time ("3pm"), relative ("in 30 minutes"), or natural ("tomorrow at 9am").',
      },
      cronExpression: {
        type: 'string',
        description: 'For recurring: 5-field cron expression (e.g., "0 9 * * 1" for every Monday at 9am).',
      },
      actionable: {
        type: 'boolean',
        description: 'If true, the message is executed as a task at fire time (e.g. check weather, run a command) instead of sent as a plain reminder. Default false.',
      },
    },
    required: ['message'],
  },
};

export const LIST_REMINDERS_TOOL: ToolSchema = {
  name: 'list_reminders',
  description: 'List all active scheduled reminders for the current user.',
  inputSchema: {
    type: 'object',
    properties: {},
    required: [],
  },
};

export const CANCEL_REMINDER_TOOL: ToolSchema = {
  name: 'cancel_reminder',
  description: 'Cancel an active reminder by its ID or label. Use list_reminders first to find the ID.',
  inputSchema: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'The job ID to cancel (from list_reminders output).',
      },
      label: {
        type: 'string',
        description: 'Cancel by label (partial match). Use if the user says "cancel the dentist reminder".',
      },
    },
    required: [],
  },
};

/**
 * Get all scheduler tool schemas for registration.
 */
export function getSchedulerToolSchemas(): ToolSchema[] {
  return [SCHEDULE_REMINDER_TOOL, LIST_REMINDERS_TOOL, CANCEL_REMINDER_TOOL];
}
