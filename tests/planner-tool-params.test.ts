import { describe, expect, it } from 'vitest';

import { formatToolParams } from '../src/tasks/planner.js';
import type { ToolInputSchema, ToolSchema } from '../src/tools/schemas/types.js';
import { SCHEDULE_REMINDER_TOOL, LIST_REMINDERS_TOOL, CANCEL_REMINDER_TOOL } from '../src/scheduler/tools.js';

// ─── Fixtures ────────────────────────────────────────────────────────────────

/** Schema with mixed required and optional params. */
const MIXED_SCHEMA: ToolInputSchema = {
  type: 'object',
  properties: {
    message: { type: 'string', description: 'The message body.' },
    priority: { type: 'number', description: 'Priority level.' },
    verbose: { type: 'boolean', description: 'Verbose output.' },
  },
  required: ['message'],
};

/** Schema with no properties. */
const EMPTY_SCHEMA: ToolInputSchema = {
  type: 'object',
  properties: {},
  required: [],
};

/** Schema where all params are required. */
const ALL_REQUIRED_SCHEMA: ToolInputSchema = {
  type: 'object',
  properties: {
    name: { type: 'string', description: 'Name of the item.' },
    count: { type: 'integer', description: 'How many.' },
  },
  required: ['name', 'count'],
};

/** Schema with a single optional param. */
const SINGLE_OPTIONAL_SCHEMA: ToolInputSchema = {
  type: 'object',
  properties: {
    query: { type: 'string', description: 'Search query.' },
  },
  required: [],
};

// ═══════════════════════════════════════════════════════════════════════════════
// formatToolParams()
// ═══════════════════════════════════════════════════════════════════════════════

describe('formatToolParams', () => {
  it('returns empty string for schema with no properties', () => {
    expect(formatToolParams(EMPTY_SCHEMA)).toBe('');
  });

  it('marks required params with asterisk', () => {
    const result = formatToolParams(MIXED_SCHEMA);
    expect(result).toContain('message* (string)');
  });

  it('does not mark optional params with asterisk', () => {
    const result = formatToolParams(MIXED_SCHEMA);
    expect(result).toContain('priority (number)');
    expect(result).toContain('verbose (boolean)');
    // Make sure they don't have asterisks
    expect(result).not.toContain('priority*');
    expect(result).not.toContain('verbose*');
  });

  it('includes all params separated by commas', () => {
    const result = formatToolParams(MIXED_SCHEMA);
    expect(result).toContain('message* (string), priority (number), verbose (boolean)');
  });

  it('starts with newline + indented Params label', () => {
    const result = formatToolParams(MIXED_SCHEMA);
    expect(result).toMatch(/^\n {4}Params: /);
  });

  it('marks all params as required when all are required', () => {
    const result = formatToolParams(ALL_REQUIRED_SCHEMA);
    expect(result).toContain('name* (string)');
    expect(result).toContain('count* (integer)');
  });

  it('handles single optional param', () => {
    const result = formatToolParams(SINGLE_OPTIONAL_SCHEMA);
    expect(result).toContain('query (string)');
    expect(result).not.toContain('query*');
  });

  it('handles the schedule_reminder tool schema correctly', () => {
    const result = formatToolParams(SCHEDULE_REMINDER_TOOL.inputSchema);
    expect(result).toContain('message* (string)');
    expect(result).toContain('fireAt (string)');
    expect(result).toContain('cronExpression (string)');
    expect(result).toContain('actionable (boolean)');
    expect(result).toContain('label (string)');
  });

  it('returns empty for list_reminders (no params)', () => {
    expect(formatToolParams(LIST_REMINDERS_TOOL.inputSchema)).toBe('');
  });

  it('handles cancel_reminder (all optional params)', () => {
    const result = formatToolParams(CANCEL_REMINDER_TOOL.inputSchema);
    expect(result).toContain('id (string)');
    expect(result).toContain('label (string)');
    expect(result).not.toContain('id*');
    expect(result).not.toContain('label*');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Planner prompt includes parameter schemas (integration-level)
// ═══════════════════════════════════════════════════════════════════════════════

describe('planner prompt includes parameter schemas', () => {
  /**
   * Build a planner-style tool listing (mirrors buildPlannerSystemPrompt logic)
   * to verify the format without needing to call the private function.
   */
  function buildToolListing(tools: ToolSchema[]): string {
    return tools
      .map((t) => {
        const firstLine = t.description.split('\n')[0] ?? '';
        const params = formatToolParams(t.inputSchema);
        return `- ${t.name}: ${firstLine}${params}`;
      })
      .join('\n');
  }

  it('schedule_reminder listing includes fireAt parameter', () => {
    const listing = buildToolListing([SCHEDULE_REMINDER_TOOL]);
    expect(listing).toContain('fireAt');
    // The original bug: planner would not include param names, so LLM guessed "time"
    expect(listing).not.toContain('Params: time');
  });

  it('schedule_reminder listing includes the first line of description', () => {
    const listing = buildToolListing([SCHEDULE_REMINDER_TOOL]);
    expect(listing).toContain('Schedule a reminder or recurring task');
  });

  it('schedule_reminder listing includes required marker for message', () => {
    const listing = buildToolListing([SCHEDULE_REMINDER_TOOL]);
    expect(listing).toContain('message* (string)');
  });

  it('list_reminders has no Params line (empty schema)', () => {
    const listing = buildToolListing([LIST_REMINDERS_TOOL]);
    expect(listing).not.toContain('Params:');
  });

  it('multiple tools each get their own param line', () => {
    const listing = buildToolListing([
      SCHEDULE_REMINDER_TOOL,
      LIST_REMINDERS_TOOL,
      CANCEL_REMINDER_TOOL,
    ]);

    // schedule_reminder has params
    expect(listing).toContain('schedule_reminder: Schedule a reminder');
    expect(listing).toContain('fireAt (string)');

    // list_reminders has no params
    const listLine = listing
      .split('\n')
      .find((l) => l.startsWith('- list_reminders:'));
    expect(listLine).toBeDefined();
    expect(listLine).not.toContain('Params:');

    // cancel_reminder has params
    expect(listing).toContain('cancel_reminder: Cancel an active reminder');
    expect(listing).toContain('id (string)');
  });

  it('custom tool with nested object type shows type correctly', () => {
    const customTool: ToolSchema = {
      name: 'custom_tool',
      description: 'A custom tool for testing.',
      inputSchema: {
        type: 'object',
        properties: {
          config: { type: 'object', description: 'Configuration object.' },
          items: { type: 'array', description: 'List of items.' },
        },
        required: ['config'],
      },
    };
    const listing = buildToolListing([customTool]);
    expect(listing).toContain('config* (object)');
    expect(listing).toContain('items (array)');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// schedule_reminder tool description semantics
// ═══════════════════════════════════════════════════════════════════════════════

describe('schedule_reminder tool description', () => {
  it('clarifies that reminders fire to the requesting user', () => {
    expect(SCHEDULE_REMINDER_TOOL.description).toContain(
      'Reminders always fire back to the person who scheduled them'
    );
  });

  it('explains actionable pattern for third-party messaging', () => {
    expect(SCHEDULE_REMINDER_TOOL.description).toContain('actionable=true');
    expect(SCHEDULE_REMINDER_TOOL.description).toContain('send_message');
  });

  it('provides an example with Send Katie', () => {
    expect(SCHEDULE_REMINDER_TOOL.description).toContain('Send Katie');
  });
});
