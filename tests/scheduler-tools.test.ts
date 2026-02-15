import { describe, expect, it } from 'vitest';

import {
  SCHEDULE_REMINDER_TOOL,
  LIST_REMINDERS_TOOL,
  CANCEL_REMINDER_TOOL,
  getSchedulerToolSchemas,
} from '../src/scheduler/tools.js';

// ═══════════════════════════════════════════════════════════════════════════════
// getSchedulerToolSchemas — structure
// ═══════════════════════════════════════════════════════════════════════════════

describe('getSchedulerToolSchemas', () => {
  it('returns 3 tool schemas', () => {
    const schemas = getSchedulerToolSchemas();
    expect(schemas).toHaveLength(3);
  });

  it('returns the correct tool names', () => {
    const names = getSchedulerToolSchemas().map((s) => s.name);
    expect(names).toContain('schedule_reminder');
    expect(names).toContain('list_reminders');
    expect(names).toContain('cancel_reminder');
  });

  it('returns new array each call', () => {
    const a = getSchedulerToolSchemas();
    const b = getSchedulerToolSchemas();
    expect(a).not.toBe(b);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SCHEDULE_REMINDER_TOOL
// ═══════════════════════════════════════════════════════════════════════════════

describe('SCHEDULE_REMINDER_TOOL', () => {
  it('has correct name', () => {
    expect(SCHEDULE_REMINDER_TOOL.name).toBe('schedule_reminder');
  });

  it('has a description', () => {
    expect(SCHEDULE_REMINDER_TOOL.description).toBeTruthy();
    expect(SCHEDULE_REMINDER_TOOL.description.length).toBeGreaterThan(10);
  });

  it('has inputSchema of type object', () => {
    expect(SCHEDULE_REMINDER_TOOL.inputSchema.type).toBe('object');
  });

  it('has message property', () => {
    const props = SCHEDULE_REMINDER_TOOL.inputSchema.properties;
    expect(props).toBeDefined();
    expect(props!['message']).toBeDefined();
    expect(props!['message']!.type).toBe('string');
  });

  it('has label property', () => {
    const props = SCHEDULE_REMINDER_TOOL.inputSchema.properties;
    expect(props!['label']).toBeDefined();
    expect(props!['label']!.type).toBe('string');
  });

  it('has fireAt property', () => {
    const props = SCHEDULE_REMINDER_TOOL.inputSchema.properties;
    expect(props!['fireAt']).toBeDefined();
    expect(props!['fireAt']!.type).toBe('string');
  });

  it('has cronExpression property', () => {
    const props = SCHEDULE_REMINDER_TOOL.inputSchema.properties;
    expect(props!['cronExpression']).toBeDefined();
    expect(props!['cronExpression']!.type).toBe('string');
  });

  it('has actionable property', () => {
    const props = SCHEDULE_REMINDER_TOOL.inputSchema.properties;
    expect(props!['actionable']).toBeDefined();
    expect(props!['actionable']!.type).toBe('boolean');
  });

  it('requires only message', () => {
    expect(SCHEDULE_REMINDER_TOOL.inputSchema.required).toEqual(['message']);
  });

  it('description mentions fireAt and cronExpression', () => {
    expect(SCHEDULE_REMINDER_TOOL.description).toContain('fireAt');
    expect(SCHEDULE_REMINDER_TOOL.description).toContain('cronExpression');
  });

  it('description mentions actionable', () => {
    expect(SCHEDULE_REMINDER_TOOL.description).toContain('actionable');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// LIST_REMINDERS_TOOL
// ═══════════════════════════════════════════════════════════════════════════════

describe('LIST_REMINDERS_TOOL', () => {
  it('has correct name', () => {
    expect(LIST_REMINDERS_TOOL.name).toBe('list_reminders');
  });

  it('has a description', () => {
    expect(LIST_REMINDERS_TOOL.description).toBeTruthy();
  });

  it('has inputSchema of type object', () => {
    expect(LIST_REMINDERS_TOOL.inputSchema.type).toBe('object');
  });

  it('has empty properties', () => {
    const props = LIST_REMINDERS_TOOL.inputSchema.properties;
    expect(props).toBeDefined();
    expect(Object.keys(props!)).toHaveLength(0);
  });

  it('has empty required array', () => {
    expect(LIST_REMINDERS_TOOL.inputSchema.required).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// CANCEL_REMINDER_TOOL
// ═══════════════════════════════════════════════════════════════════════════════

describe('CANCEL_REMINDER_TOOL', () => {
  it('has correct name', () => {
    expect(CANCEL_REMINDER_TOOL.name).toBe('cancel_reminder');
  });

  it('has a description', () => {
    expect(CANCEL_REMINDER_TOOL.description).toBeTruthy();
  });

  it('has inputSchema of type object', () => {
    expect(CANCEL_REMINDER_TOOL.inputSchema.type).toBe('object');
  });

  it('has id property', () => {
    const props = CANCEL_REMINDER_TOOL.inputSchema.properties;
    expect(props!['id']).toBeDefined();
    expect(props!['id']!.type).toBe('string');
  });

  it('has label property', () => {
    const props = CANCEL_REMINDER_TOOL.inputSchema.properties;
    expect(props!['label']).toBeDefined();
    expect(props!['label']!.type).toBe('string');
  });

  it('has empty required array (id or label, not both required)', () => {
    expect(CANCEL_REMINDER_TOOL.inputSchema.required).toEqual([]);
  });

  it('description mentions list_reminders', () => {
    expect(CANCEL_REMINDER_TOOL.description).toContain('list_reminders');
  });
});
