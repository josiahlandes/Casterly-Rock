/**
 * Productivity Tool Schemas
 *
 * Tool definitions for macOS-native productivity tools:
 * calendar_read, reminder_create, http_get.
 */

import type { ToolSchema } from './types.js';

/**
 * Read calendar events from macOS Calendar.app
 */
export const CALENDAR_READ_TOOL: ToolSchema = {
  name: 'calendar_read',
  description: `Read upcoming calendar events from macOS Calendar.app.

Returns structured event data: title, start/end times, location, notes, calendar name.
Supports date ranges, filtering by calendar name, and result limits.

Date values accept: ISO date strings, "today", "tomorrow", "this week", or "+Nd" offsets.
Default range is today's events.`,

  inputSchema: {
    type: 'object',
    properties: {
      from: {
        type: 'string',
        description: 'Start date for event query. Defaults to "today". Accepts ISO, "today", "tomorrow", "this week", "+Nd".',
      },
      to: {
        type: 'string',
        description: 'End date for event query. Defaults to "tomorrow". Accepts same formats as "from".',
      },
      calendar: {
        type: 'string',
        description: 'Filter events to a specific calendar name (e.g. "Work", "Personal").',
      },
      limit: {
        type: 'integer',
        description: 'Maximum number of events to return. Defaults to 50, max 200.',
      },
    },
    required: [],
  },
};

/**
 * Create an Apple Reminder via Reminders.app
 */
export const REMINDER_CREATE_TOOL: ToolSchema = {
  name: 'reminder_create',
  description: `Create a reminder in macOS Reminders.app.

Supports: title, due date, notes, list name, and priority level.
Due date accepts: ISO date strings, "today", "tomorrow", "+Nd" (days), or "+Nh" (hours).
Priority: 1-3 = high, 4-6 = medium, 7-9 = low, 0 = none.`,

  inputSchema: {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        description: 'The reminder title (required).',
      },
      dueDate: {
        type: 'string',
        description: 'When the reminder is due. Accepts ISO, "today", "tomorrow", "+Nd", "+Nh".',
      },
      notes: {
        type: 'string',
        description: 'Additional notes for the reminder. Max 2000 characters.',
      },
      list: {
        type: 'string',
        description: 'Reminders list name (e.g. "Groceries", "Work"). Defaults to the default list.',
      },
      priority: {
        type: 'integer',
        description: 'Priority level: 1-3 high, 4-6 medium, 7-9 low, 0 none.',
      },
    },
    required: ['title'],
  },
};

/**
 * Make an HTTP GET request
 */
export const HTTP_GET_TOOL: ToolSchema = {
  name: 'http_get',
  description: `Make an HTTP GET request and return the response.

Use for fetching web APIs, checking URLs, downloading JSON data, or reading web content.
Returns: status code, headers, and response body (auto-parsed as JSON when applicable).

Safety: Only GET requests. Blocks internal/private network IPs and sensitive headers.
Max response size defaults to 2MB.`,

  inputSchema: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'The URL to fetch (must be http or https).',
      },
      headers: {
        type: 'object',
        description: 'Custom request headers as key-value pairs. Cannot set Cookie or Authorization.',
        properties: {},
        required: [],
      },
      timeout: {
        type: 'integer',
        description: 'Request timeout in milliseconds. Defaults to 30000, max 60000.',
      },
      maxSize: {
        type: 'integer',
        description: 'Max response body size in bytes. Defaults to 2MB, max 10MB.',
      },
    },
    required: ['url'],
  },
};

/**
 * All productivity tool schemas
 */
export const PRODUCTIVITY_TOOLS: ToolSchema[] = [
  CALENDAR_READ_TOOL,
  REMINDER_CREATE_TOOL,
  HTTP_GET_TOOL,
];
