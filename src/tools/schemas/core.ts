/**
 * Core Tool Schemas
 *
 * These are the built-in tools available to the LLM.
 * Native tools (read_file, write_file, etc.) are preferred over bash equivalents.
 */

import type { ToolSchema } from './types.js';
import { CODING_TOOLS } from './coding.js';
import { MESSAGING_TOOLS } from './messaging.js';

/**
 * Bash command execution tool
 *
 * General-purpose fallback for commands without a native executor.
 */
export const BASH_TOOL: ToolSchema = {
  name: 'bash',
  description: `Execute a shell command on the local system.

Use this tool ONLY for operations that don't have a dedicated tool:
- Get system information (date, whoami, pwd, uname)
- Run installed CLI tools (git, npm, brew, icalbuddy, etc.)
- Process management (ps, kill)
- Network operations (ping, curl for APIs)

IMPORTANT: Prefer native tools when available:
- Use read_file instead of cat/head/tail
- Use write_file instead of echo/cat heredoc
- Use list_files instead of ls/find
- Use edit_file for search/replace edits to existing files
- Use glob_files for pattern-based file discovery
- Use search_files or grep_files instead of grep/rg
- Use validate_files after editing to catch errors
- Use send_message to text someone (never bash with osascript)

Safety notes:
- Destructive commands (rm, mv with overwrite) will be blocked or require approval
- Never execute commands you don't understand`,

  inputSchema: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'The shell command to execute. Use standard bash syntax.',
      },
    },
    required: ['command'],
  },
};

/**
 * Native file read tool
 */
export const READ_FILE_TOOL: ToolSchema = {
  name: 'read_file',
  description: 'Read the contents of a file. Returns structured output with content, size, and line count.',
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Absolute or relative path to the file to read.',
      },
      encoding: {
        type: 'string',
        description: 'File encoding. Defaults to utf-8.',
        enum: ['utf-8', 'ascii', 'base64'],
      },
      maxLines: {
        type: 'integer',
        description: 'Maximum number of lines to read. Omit to read all.',
      },
    },
    required: ['path'],
  },
};

/**
 * Native file write tool
 */
export const WRITE_FILE_TOOL: ToolSchema = {
  name: 'write_file',
  description: 'Write content to a file. Creates parent directories if needed. Supports append mode.',
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Absolute or relative path to the file to write.',
      },
      content: {
        type: 'string',
        description: 'Content to write to the file.',
      },
      append: {
        type: 'boolean',
        description: 'Append to file instead of overwriting. Defaults to false.',
      },
    },
    required: ['path', 'content'],
  },
};

/**
 * Native file listing tool
 */
export const LIST_FILES_TOOL: ToolSchema = {
  name: 'list_files',
  description: 'List files and directories at a path. Returns structured entries with type and size.',
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Directory path to list.',
      },
      recursive: {
        type: 'boolean',
        description: 'List recursively into subdirectories. Defaults to false.',
      },
      pattern: {
        type: 'string',
        description: 'Glob pattern to filter results (e.g. "*.ts", "*.md").',
      },
    },
    required: ['path'],
  },
};

/**
 * Native file search tool
 */
export const SEARCH_FILES_TOOL: ToolSchema = {
  name: 'search_files',
  description: 'Search for a text pattern in files. Returns matching lines with file paths and line numbers.',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description: 'Regex pattern to search for.',
      },
      path: {
        type: 'string',
        description: 'Directory to search in. Defaults to current directory.',
      },
      filePattern: {
        type: 'string',
        description: 'Glob pattern to filter which files to search (e.g. "*.ts").',
      },
      maxResults: {
        type: 'integer',
        description: 'Maximum results to return. Defaults to 100.',
      },
    },
    required: ['pattern'],
  },
};

/**
 * Native document read tool
 */
export const READ_DOCUMENT_TOOL: ToolSchema = {
  name: 'read_document',
  description: `Read and extract content from document files (PDF, DOCX, XLSX, CSV).

Use this tool for binary document formats. For plain text files (.txt, .md, .ts, .json, etc.), use read_file instead.

Supported formats:
- PDF: Extracts text content with page count and metadata
- DOCX: Extracts text (or HTML) from Word documents
- XLSX/XLS: Extracts spreadsheet data as structured rows per sheet
- CSV: Parses comma-separated values into structured headers + rows

Returns structured JSON with format-specific fields.`,
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Path to the document file to read.',
      },
      maxPages: {
        type: 'integer',
        description: 'PDF only: Maximum pages to extract. Defaults to 50.',
      },
      maxRows: {
        type: 'integer',
        description: 'XLSX/CSV only: Maximum rows per sheet/file. Defaults to 1000 (XLSX) or 5000 (CSV).',
      },
      format: {
        type: 'string',
        description: 'DOCX only: Output format. Defaults to "text".',
        enum: ['text', 'html'],
      },
      sheet: {
        type: 'string',
        description: 'XLSX only: Name of specific sheet to read. Omit to read all sheets.',
      },
    },
    required: ['path'],
  },
};

/**
 * All core tools available by default
 */
export const CORE_TOOLS: ToolSchema[] = [
  BASH_TOOL,
  READ_FILE_TOOL,
  WRITE_FILE_TOOL,
  LIST_FILES_TOOL,
  SEARCH_FILES_TOOL,
  READ_DOCUMENT_TOOL,
  ...CODING_TOOLS,
  ...MESSAGING_TOOLS,
];
