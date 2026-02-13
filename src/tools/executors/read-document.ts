/**
 * Native Read Document Executor (ISSUE-001)
 *
 * Reads and extracts structured content from document files:
 * PDF, DOCX, XLSX/XLS, CSV.
 *
 * Dispatches to format-specific parsers based on file extension.
 * Follows the same pattern as read-file.ts for validation and safety.
 */

import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { safeLogger } from '../../logging/safe-logger.js';
import type { NativeToolCall, NativeToolResult, NativeToolExecutor } from '../schemas/types.js';
import { parseCsv } from './parsers/csv.js';
import { parsePdf } from './parsers/pdf.js';
import { parseDocx } from './parsers/docx.js';
import { parseXlsx } from './parsers/xlsx.js';

// ─── Constants ───────────────────────────────────────────────────────────────

/** Paths that should never be read by the tool executor */
const BLOCKED_READ_PATHS = [
  '.env',
  '.env.local',
  '.env.production',
];

/** Max file size for binary documents (20MB) */
const MAX_BINARY_FILE_SIZE = 20 * 1024 * 1024;

/** Max file size for CSV (50MB) */
const MAX_CSV_FILE_SIZE = 50 * 1024 * 1024;

/** Supported extensions and their format labels */
const SUPPORTED_EXTENSIONS = new Map<string, string>([
  ['.pdf', 'pdf'],
  ['.docx', 'docx'],
  ['.xlsx', 'xlsx'],
  ['.xls', 'xlsx'],
  ['.csv', 'csv'],
]);

// ─── Input ───────────────────────────────────────────────────────────────────

interface ReadDocumentInput {
  path: string;
  maxPages?: number;
  maxRows?: number;
  format?: 'text' | 'html';
  sheet?: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function isBlockedPath(filePath: string): boolean {
  const resolved = resolve(filePath);
  return BLOCKED_READ_PATHS.some((blocked) =>
    resolved.endsWith(blocked) || resolved.includes(`/${blocked}`)
  );
}

// ─── Executor ────────────────────────────────────────────────────────────────

export function createReadDocumentExecutor(): NativeToolExecutor {
  return {
    toolName: 'read_document',

    async execute(call: NativeToolCall): Promise<NativeToolResult> {
      const input = call.input as unknown as ReadDocumentInput;
      const filePath = input.path;

      // ── Input validation ───────────────────────────────────────────────
      if (typeof filePath !== 'string' || filePath.trim() === '') {
        return {
          toolCallId: call.id,
          success: false,
          error: 'Invalid input: path must be a non-empty string',
        };
      }

      const resolved = resolve(filePath);

      // ── Safety check ───────────────────────────────────────────────────
      if (isBlockedPath(resolved)) {
        safeLogger.warn('Blocked read_document on protected path', { path: resolved.substring(0, 50) });
        return {
          toolCallId: call.id,
          success: false,
          error: 'Cannot read protected file',
        };
      }

      if (!existsSync(resolved)) {
        return {
          toolCallId: call.id,
          success: false,
          error: `File not found: ${filePath}`,
        };
      }

      // ── File checks ────────────────────────────────────────────────────
      const fileStat = await stat(resolved);

      if (fileStat.isDirectory()) {
        return {
          toolCallId: call.id,
          success: false,
          error: `Path is a directory, not a file: ${filePath}`,
        };
      }

      // ── Extension check ────────────────────────────────────────────────
      const ext = extname(resolved).toLowerCase();
      const format = SUPPORTED_EXTENSIONS.get(ext);

      if (!format) {
        const supported = [...SUPPORTED_EXTENSIONS.keys()].join(', ');
        return {
          toolCallId: call.id,
          success: false,
          error: `Unsupported file type: ${ext}. Supported: ${supported}. Use read_file for text files.`,
        };
      }

      // ── Size check ─────────────────────────────────────────────────────
      const maxSize = format === 'csv' ? MAX_CSV_FILE_SIZE : MAX_BINARY_FILE_SIZE;
      if (fileStat.size > maxSize) {
        const sizeMb = (fileStat.size / 1024 / 1024).toFixed(1);
        const limitMb = (maxSize / 1024 / 1024).toFixed(0);
        return {
          toolCallId: call.id,
          success: false,
          error: `File too large (${sizeMb}MB). Maximum for ${format} is ${limitMb}MB.`,
        };
      }

      // ── Parse ──────────────────────────────────────────────────────────
      try {
        let result: unknown;

        if (format === 'csv') {
          const content = await readFile(resolved, 'utf-8');
          result = parseCsv(content, {
            maxRows: input.maxRows,
          });
        } else if (format === 'pdf') {
          const buffer = await readFile(resolved);
          result = await parsePdf(buffer, {
            maxPages: input.maxPages,
          });
        } else if (format === 'docx') {
          const buffer = await readFile(resolved);
          result = await parseDocx(buffer, {
            format: input.format,
          });
        } else {
          // xlsx
          const buffer = await readFile(resolved);
          result = await parseXlsx(buffer, {
            maxRows: input.maxRows,
            sheet: input.sheet,
          });
        }

        safeLogger.info('read_document executed', {
          path: resolved.substring(0, 80),
          format,
          size: fileStat.size,
        });

        return {
          toolCallId: call.id,
          success: true,
          output: JSON.stringify(result),
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        safeLogger.warn('read_document parse error', {
          path: resolved.substring(0, 80),
          format,
          error: message.substring(0, 200),
        });
        return {
          toolCallId: call.id,
          success: false,
          error: `Failed to parse ${format} file: ${message}`,
        };
      }
    },
  };
}
