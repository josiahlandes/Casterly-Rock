import { describe, expect, it } from 'vitest';

import type { ToolSchema, ToolInputSchema } from '../src/tools/schemas/types.js';
import { CORE_TOOLS, BASH_TOOL, READ_FILE_TOOL, WRITE_FILE_TOOL, LIST_FILES_TOOL, SEARCH_FILES_TOOL, READ_DOCUMENT_TOOL } from '../src/tools/schemas/core.js';
import { CODING_TOOLS, EDIT_FILE_TOOL, GLOB_FILES_TOOL, GREP_FILES_TOOL, VALIDATE_FILES_TOOL } from '../src/tools/schemas/coding.js';
import { MESSAGING_TOOLS, SEND_MESSAGE_TOOL } from '../src/tools/schemas/messaging.js';
import { SCHEDULE_REMINDER_TOOL, LIST_REMINDERS_TOOL, CANCEL_REMINDER_TOOL, getSchedulerToolSchemas } from '../src/scheduler/tools.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Validate a ToolSchema has the required structural properties.
 */
function assertValidSchema(tool: ToolSchema): void {
  expect(typeof tool.name).toBe('string');
  expect(tool.name.length).toBeGreaterThan(0);
  expect(typeof tool.description).toBe('string');
  expect(tool.description.length).toBeGreaterThan(0);
  expect(tool.inputSchema.type).toBe('object');
  expect(typeof tool.inputSchema.properties).toBe('object');
  expect(Array.isArray(tool.inputSchema.required)).toBe(true);
}

/**
 * Validate that all required fields are present in properties.
 */
function assertRequiredFieldsExist(schema: ToolInputSchema): void {
  for (const req of schema.required) {
    expect(schema.properties).toHaveProperty(req);
  }
}

/**
 * Validate that all properties have type and description.
 */
function assertPropertiesWellFormed(schema: ToolInputSchema): void {
  for (const [name, prop] of Object.entries(schema.properties)) {
    expect(typeof prop.type).toBe('string');
    expect(typeof prop.description).toBe('string');
    expect(prop.description.length, `${name} should have a non-empty description`).toBeGreaterThan(0);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Schema structural validity — all schemas should be well-formed
// ═══════════════════════════════════════════════════════════════════════════════

describe('tool schema structural validity', () => {
  const ALL_TOOLS: ToolSchema[] = [
    BASH_TOOL,
    READ_FILE_TOOL,
    WRITE_FILE_TOOL,
    LIST_FILES_TOOL,
    SEARCH_FILES_TOOL,
    READ_DOCUMENT_TOOL,
    EDIT_FILE_TOOL,
    GLOB_FILES_TOOL,
    GREP_FILES_TOOL,
    VALIDATE_FILES_TOOL,
    SEND_MESSAGE_TOOL,
    SCHEDULE_REMINDER_TOOL,
    LIST_REMINDERS_TOOL,
    CANCEL_REMINDER_TOOL,
  ];

  for (const tool of ALL_TOOLS) {
    describe(tool.name, () => {
      it('has valid schema structure', () => {
        assertValidSchema(tool);
      });

      it('required fields exist in properties', () => {
        assertRequiredFieldsExist(tool.inputSchema);
      });

      it('all properties have type and description', () => {
        assertPropertiesWellFormed(tool.inputSchema);
      });
    });
  }

  it('all tool names are unique', () => {
    const names = ALL_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('no tool name contains spaces', () => {
    for (const tool of ALL_TOOLS) {
      expect(tool.name).not.toMatch(/\s/);
    }
  });

  it('all descriptions start with a capital letter', () => {
    for (const tool of ALL_TOOLS) {
      const firstChar = tool.description.charAt(0);
      expect(firstChar, `${tool.name} description should start uppercase`).toBe(firstChar.toUpperCase());
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Core tools (core.ts)
// ═══════════════════════════════════════════════════════════════════════════════

describe('core tool schemas', () => {
  it('CORE_TOOLS includes all core + coding + messaging tools', () => {
    const coreNames = CORE_TOOLS.map((t) => t.name);
    expect(coreNames).toContain('bash');
    expect(coreNames).toContain('read_file');
    expect(coreNames).toContain('write_file');
    expect(coreNames).toContain('list_files');
    expect(coreNames).toContain('search_files');
    expect(coreNames).toContain('read_document');
    expect(coreNames).toContain('edit_file');
    expect(coreNames).toContain('glob_files');
    expect(coreNames).toContain('grep_files');
    expect(coreNames).toContain('validate_files');
    expect(coreNames).toContain('send_message');
  });

  describe('bash', () => {
    it('requires command parameter', () => {
      expect(BASH_TOOL.inputSchema.required).toContain('command');
    });

    it('command is a string', () => {
      expect(BASH_TOOL.inputSchema.properties.command?.type).toBe('string');
    });

    it('description warns about preferring native tools', () => {
      expect(BASH_TOOL.description).toContain('Prefer native tools');
    });

    it('description warns against osascript', () => {
      expect(BASH_TOOL.description).toContain('osascript');
    });
  });

  describe('read_file', () => {
    it('requires path parameter', () => {
      expect(READ_FILE_TOOL.inputSchema.required).toContain('path');
    });

    it('has optional encoding with enum values', () => {
      const encoding = READ_FILE_TOOL.inputSchema.properties.encoding;
      expect(encoding?.type).toBe('string');
      expect(encoding?.enum).toContain('utf-8');
      expect(encoding?.enum).toContain('base64');
    });

    it('has optional maxLines as integer', () => {
      expect(READ_FILE_TOOL.inputSchema.properties.maxLines?.type).toBe('integer');
    });
  });

  describe('write_file', () => {
    it('requires path and content', () => {
      expect(WRITE_FILE_TOOL.inputSchema.required).toContain('path');
      expect(WRITE_FILE_TOOL.inputSchema.required).toContain('content');
    });

    it('has optional append boolean', () => {
      expect(WRITE_FILE_TOOL.inputSchema.properties.append?.type).toBe('boolean');
    });
  });

  describe('read_document', () => {
    it('requires only path', () => {
      expect(READ_DOCUMENT_TOOL.inputSchema.required).toEqual(['path']);
    });

    it('has format enum for DOCX output', () => {
      const format = READ_DOCUMENT_TOOL.inputSchema.properties.format;
      expect(format?.enum).toContain('text');
      expect(format?.enum).toContain('html');
    });

    it('description lists supported formats', () => {
      expect(READ_DOCUMENT_TOOL.description).toContain('PDF');
      expect(READ_DOCUMENT_TOOL.description).toContain('DOCX');
      expect(READ_DOCUMENT_TOOL.description).toContain('XLSX');
      expect(READ_DOCUMENT_TOOL.description).toContain('CSV');
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Coding tools (coding.ts)
// ═══════════════════════════════════════════════════════════════════════════════

describe('coding tool schemas', () => {
  it('CODING_TOOLS has 4 tools', () => {
    expect(CODING_TOOLS).toHaveLength(4);
  });

  describe('edit_file', () => {
    it('requires path, search, replace', () => {
      expect(EDIT_FILE_TOOL.inputSchema.required).toContain('path');
      expect(EDIT_FILE_TOOL.inputSchema.required).toContain('search');
      expect(EDIT_FILE_TOOL.inputSchema.required).toContain('replace');
    });

    it('has optional replaceAll boolean', () => {
      expect(EDIT_FILE_TOOL.inputSchema.properties.replaceAll?.type).toBe('boolean');
    });
  });

  describe('glob_files', () => {
    it('requires pattern', () => {
      expect(GLOB_FILES_TOOL.inputSchema.required).toContain('pattern');
    });

    it('has optional cwd, filesOnly, maxDepth', () => {
      expect(GLOB_FILES_TOOL.inputSchema.properties.cwd?.type).toBe('string');
      expect(GLOB_FILES_TOOL.inputSchema.properties.filesOnly?.type).toBe('boolean');
      expect(GLOB_FILES_TOOL.inputSchema.properties.maxDepth?.type).toBe('integer');
    });
  });

  describe('grep_files', () => {
    it('requires pattern', () => {
      expect(GREP_FILES_TOOL.inputSchema.required).toContain('pattern');
    });

    it('has include as array type', () => {
      const include = GREP_FILES_TOOL.inputSchema.properties.include;
      expect(include?.type).toBe('array');
      expect(include?.items?.type).toBe('string');
    });

    it('has ignoreCase and literal booleans', () => {
      expect(GREP_FILES_TOOL.inputSchema.properties.ignoreCase?.type).toBe('boolean');
      expect(GREP_FILES_TOOL.inputSchema.properties.literal?.type).toBe('boolean');
    });

    it('has context line parameters as integers', () => {
      expect(GREP_FILES_TOOL.inputSchema.properties.contextBefore?.type).toBe('integer');
      expect(GREP_FILES_TOOL.inputSchema.properties.contextAfter?.type).toBe('integer');
    });
  });

  describe('validate_files', () => {
    it('requires files array', () => {
      expect(VALIDATE_FILES_TOOL.inputSchema.required).toContain('files');
    });

    it('files is array of strings', () => {
      const files = VALIDATE_FILES_TOOL.inputSchema.properties.files;
      expect(files?.type).toBe('array');
      expect(files?.items?.type).toBe('string');
    });

    it('has quick and skipTest booleans', () => {
      expect(VALIDATE_FILES_TOOL.inputSchema.properties.quick?.type).toBe('boolean');
      expect(VALIDATE_FILES_TOOL.inputSchema.properties.skipTest?.type).toBe('boolean');
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Messaging tools (messaging.ts)
// ═══════════════════════════════════════════════════════════════════════════════

describe('messaging tool schemas', () => {
  it('MESSAGING_TOOLS has 1 tool', () => {
    expect(MESSAGING_TOOLS).toHaveLength(1);
  });

  describe('send_message', () => {
    it('requires recipient and text', () => {
      expect(SEND_MESSAGE_TOOL.inputSchema.required).toContain('recipient');
      expect(SEND_MESSAGE_TOOL.inputSchema.required).toContain('text');
    });

    it('has phone number example in recipient description', () => {
      const desc = SEND_MESSAGE_TOOL.inputSchema.properties.recipient?.description ?? '';
      expect(desc).toContain('+1555');
    });

    it('description warns against replying to current sender', () => {
      expect(SEND_MESSAGE_TOOL.description).toContain('Do NOT use this to reply to the current sender');
    });

    it('description warns against osascript', () => {
      expect(SEND_MESSAGE_TOOL.description).toContain('osascript');
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Scheduler tools (scheduler/tools.ts)
// ═══════════════════════════════════════════════════════════════════════════════

describe('scheduler tool schemas', () => {
  it('getSchedulerToolSchemas returns 3 tools', () => {
    expect(getSchedulerToolSchemas()).toHaveLength(3);
  });

  describe('schedule_reminder', () => {
    it('requires only message', () => {
      expect(SCHEDULE_REMINDER_TOOL.inputSchema.required).toEqual(['message']);
    });

    it('has fireAt string parameter', () => {
      expect(SCHEDULE_REMINDER_TOOL.inputSchema.properties.fireAt?.type).toBe('string');
    });

    it('has cronExpression string parameter', () => {
      expect(SCHEDULE_REMINDER_TOOL.inputSchema.properties.cronExpression?.type).toBe('string');
    });

    it('has actionable boolean parameter', () => {
      expect(SCHEDULE_REMINDER_TOOL.inputSchema.properties.actionable?.type).toBe('boolean');
    });

    it('has label string parameter', () => {
      expect(SCHEDULE_REMINDER_TOOL.inputSchema.properties.label?.type).toBe('string');
    });

    it('description clarifies recipient semantics', () => {
      expect(SCHEDULE_REMINDER_TOOL.description).toContain('fire back to the person who scheduled them');
    });

    it('description explains actionable pattern for third-party messaging', () => {
      expect(SCHEDULE_REMINDER_TOOL.description).toContain('actionable=true');
      expect(SCHEDULE_REMINDER_TOOL.description).toContain('send_message');
    });
  });

  describe('list_reminders', () => {
    it('has no required parameters', () => {
      expect(LIST_REMINDERS_TOOL.inputSchema.required).toHaveLength(0);
    });

    it('has no properties', () => {
      expect(Object.keys(LIST_REMINDERS_TOOL.inputSchema.properties)).toHaveLength(0);
    });
  });

  describe('cancel_reminder', () => {
    it('has no required parameters', () => {
      expect(CANCEL_REMINDER_TOOL.inputSchema.required).toHaveLength(0);
    });

    it('has id and label optional parameters', () => {
      expect(CANCEL_REMINDER_TOOL.inputSchema.properties.id?.type).toBe('string');
      expect(CANCEL_REMINDER_TOOL.inputSchema.properties.label?.type).toBe('string');
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Cross-cutting: parameter name consistency (prevents the "time vs fireAt" bug)
// ═══════════════════════════════════════════════════════════════════════════════

describe('parameter name consistency', () => {
  it('schedule_reminder uses fireAt not time', () => {
    const props = Object.keys(SCHEDULE_REMINDER_TOOL.inputSchema.properties);
    expect(props).toContain('fireAt');
    expect(props).not.toContain('time');
    expect(props).not.toContain('at');
    expect(props).not.toContain('when');
  });

  it('schedule_reminder uses message not text or body', () => {
    const props = Object.keys(SCHEDULE_REMINDER_TOOL.inputSchema.properties);
    expect(props).toContain('message');
    expect(props).not.toContain('text');
    expect(props).not.toContain('body');
  });

  it('send_message uses text not message', () => {
    const props = Object.keys(SEND_MESSAGE_TOOL.inputSchema.properties);
    expect(props).toContain('text');
    expect(props).toContain('recipient');
  });

  it('all file tools use path not file or filename', () => {
    const fileTools = [READ_FILE_TOOL, WRITE_FILE_TOOL, LIST_FILES_TOOL, EDIT_FILE_TOOL, READ_DOCUMENT_TOOL];
    for (const tool of fileTools) {
      expect(tool.inputSchema.properties, `${tool.name} should have 'path'`).toHaveProperty('path');
    }
  });
});
