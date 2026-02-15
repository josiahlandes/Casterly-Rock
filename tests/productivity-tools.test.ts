import { describe, expect, it } from 'vitest';
import {
  CALENDAR_READ_TOOL,
  REMINDER_CREATE_TOOL,
  HTTP_GET_TOOL,
  PRODUCTIVITY_TOOLS,
} from '../src/tools/schemas/productivity.js';
import { CORE_TOOLS } from '../src/tools/schemas/core.js';

describe('Productivity Tool Schemas', () => {
  describe('CALENDAR_READ_TOOL', () => {
    it('has the correct name', () => {
      expect(CALENDAR_READ_TOOL.name).toBe('calendar_read');
    });

    it('has no required parameters', () => {
      expect(CALENDAR_READ_TOOL.inputSchema.required).toEqual([]);
    });

    it('has from, to, calendar, and limit properties', () => {
      const props = Object.keys(CALENDAR_READ_TOOL.inputSchema.properties);
      expect(props).toContain('from');
      expect(props).toContain('to');
      expect(props).toContain('calendar');
      expect(props).toContain('limit');
    });
  });

  describe('REMINDER_CREATE_TOOL', () => {
    it('has the correct name', () => {
      expect(REMINDER_CREATE_TOOL.name).toBe('reminder_create');
    });

    it('requires title', () => {
      expect(REMINDER_CREATE_TOOL.inputSchema.required).toContain('title');
    });

    it('has title, dueDate, notes, list, and priority properties', () => {
      const props = Object.keys(REMINDER_CREATE_TOOL.inputSchema.properties);
      expect(props).toContain('title');
      expect(props).toContain('dueDate');
      expect(props).toContain('notes');
      expect(props).toContain('list');
      expect(props).toContain('priority');
    });
  });

  describe('HTTP_GET_TOOL', () => {
    it('has the correct name', () => {
      expect(HTTP_GET_TOOL.name).toBe('http_get');
    });

    it('requires url', () => {
      expect(HTTP_GET_TOOL.inputSchema.required).toContain('url');
    });

    it('has url, headers, timeout, and maxSize properties', () => {
      const props = Object.keys(HTTP_GET_TOOL.inputSchema.properties);
      expect(props).toContain('url');
      expect(props).toContain('headers');
      expect(props).toContain('timeout');
      expect(props).toContain('maxSize');
    });
  });

  describe('PRODUCTIVITY_TOOLS array', () => {
    it('contains all three tools', () => {
      expect(PRODUCTIVITY_TOOLS).toHaveLength(3);
      const names = PRODUCTIVITY_TOOLS.map((t) => t.name);
      expect(names).toContain('calendar_read');
      expect(names).toContain('reminder_create');
      expect(names).toContain('http_get');
    });
  });

  describe('CORE_TOOLS integration', () => {
    it('includes productivity tools in CORE_TOOLS', () => {
      const names = CORE_TOOLS.map((t) => t.name);
      expect(names).toContain('calendar_read');
      expect(names).toContain('reminder_create');
      expect(names).toContain('http_get');
    });
  });
});
