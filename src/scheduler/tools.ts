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

Provide either fireAt OR cronExpression, not both.`,

  inputSchema: {
    type: 'object',
    properties: {
      message: {
        type: 'string',
        description: 'The message to send when the reminder fires.',
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
