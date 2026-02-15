/**
 * Coding Tool Schemas
 *
 * Tool definitions for the coding-powered tools:
 * edit_file, glob_files, grep_files, validate_files.
 *
 * These bridge the src/coding/ module to the LLM tool system.
 */

import type { ToolSchema } from './types.js';

/**
 * Search/replace editing tool — more precise than write_file for modifications
 */
export const EDIT_FILE_TOOL: ToolSchema = {
  name: 'edit_file',
  description: `Edit a file using search/replace. Finds an exact text match and replaces it.

More precise than write_file for modifications to existing files.
Includes a diff preview in the output.`,

  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Path to the file to edit.',
      },
      search: {
        type: 'string',
        description: 'Exact text to find in the file. Must match precisely including whitespace.',
      },
      replace: {
        type: 'string',
        description: 'Text to replace the search match with.',
      },
      replaceAll: {
        type: 'boolean',
        description: 'Replace all occurrences instead of just the first. Defaults to false.',
      },
    },
    required: ['path', 'search', 'replace'],
  },
};

/**
 * Glob-based file discovery with metadata
 */
export const GLOB_FILES_TOOL: ToolSchema = {
  name: 'glob_files',
  description: `Find files matching a glob pattern. Returns file paths with sizes and modification dates.

Use for pattern-based file discovery (e.g. "**/*.test.ts", "src/**/*.yaml").
For just listing a directory's immediate contents, use list_files instead.`,

  inputSchema: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description: 'Glob pattern to match (e.g. "**/*.ts", "src/**/*.yaml", "*.json").',
      },
      cwd: {
        type: 'string',
        description: 'Directory to search from. Defaults to current directory.',
      },
      filesOnly: {
        type: 'boolean',
        description: 'Only return files, not directories. Defaults to true.',
      },
      maxDepth: {
        type: 'integer',
        description: 'Maximum directory depth to traverse.',
      },
    },
    required: ['pattern'],
  },
};

/**
 * Content search with context lines
 */
export const GREP_FILES_TOOL: ToolSchema = {
  name: 'grep_files',
  description: `Search file contents for a pattern with optional context lines.

Returns matching lines with file paths, line numbers, and surrounding context.
Supports regex and literal matching, case sensitivity control.
Prefer over search_files when you need context lines or structured results.`,

  inputSchema: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description: 'Search pattern (regex by default, or literal with literal=true).',
      },
      cwd: {
        type: 'string',
        description: 'Directory to search in. Defaults to current directory.',
      },
      include: {
        type: 'array',
        description: 'File patterns to include (e.g. ["*.ts", "*.js"]).',
        items: { type: 'string', description: 'A glob pattern.' },
      },
      ignoreCase: {
        type: 'boolean',
        description: 'Case-insensitive search. Defaults to false.',
      },
      literal: {
        type: 'boolean',
        description: 'Treat pattern as literal string, not regex. Defaults to false.',
      },
      contextBefore: {
        type: 'integer',
        description: 'Number of lines to show before each match.',
      },
      contextAfter: {
        type: 'integer',
        description: 'Number of lines to show after each match.',
      },
      maxMatches: {
        type: 'integer',
        description: 'Maximum matches to return. Defaults to 100.',
      },
    },
    required: ['pattern'],
  },
};

/**
 * Code validation pipeline
 */
export const VALIDATE_FILES_TOOL: ToolSchema = {
  name: 'validate_files',
  description: `Validate code files by running parse, lint, typecheck, and test stages.

Use after editing files to catch errors early.
Runs: parse (syntax) -> lint -> typecheck -> test (optional).
Quick mode runs only the parse stage for fast syntax checks.`,

  inputSchema: {
    type: 'object',
    properties: {
      files: {
        type: 'array',
        description: 'File paths to validate.',
        items: { type: 'string', description: 'A file path.' },
      },
      quick: {
        type: 'boolean',
        description: 'Quick mode: only run parse/syntax check. Defaults to false.',
      },
      skipTest: {
        type: 'boolean',
        description: 'Skip the test stage. Defaults to false.',
      },
    },
    required: ['files'],
  },
};

/**
 * All coding tool schemas
 */
export const CODING_TOOLS: ToolSchema[] = [
  EDIT_FILE_TOOL,
  GLOB_FILES_TOOL,
  GREP_FILES_TOOL,
  VALIDATE_FILES_TOOL,
];
