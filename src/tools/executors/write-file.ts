/**
 * Native Write File Executor
 *
 * Writes content to files directly via Node fs, replacing bash echo/cat heredoc.
 * Creates parent directories automatically. Supports append mode.
 */

import { writeFile, appendFile, mkdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, dirname, extname, basename, join } from 'node:path';
import { homedir } from 'node:os';
import { safeLogger } from '../../logging/safe-logger.js';
import type { NativeToolCall, NativeToolResult, NativeToolExecutor } from '../schemas/types.js';

/** Paths that must never be written to */
const PROTECTED_WRITE_PATHS = [
  'src/security/',
  'src/providers/',
  'config/',
  '.env',
  'docs/rulebook.md',
  'docs/subagents.md',
  'scripts/guardrails.mjs',
];

/** Max content size to write (10MB) */
const MAX_WRITE_SIZE = 10 * 1024 * 1024;

/** User document directory — non-code files go here, not the repo */
const USER_DOCUMENTS_DIR = join(homedir(), 'Documents', 'Tyrion');

/**
 * Extensions that are user documents, not code.
 * When these land in the repo root (relative path, no subdirectory), redirect to ~/Documents/Tyrion/.
 */
const DOCUMENT_EXTENSIONS = new Set([
  '.csv', '.txt', '.pdf', '.doc', '.docx', '.xls', '.xlsx',
  '.rtf', '.odt', '.ods', '.ppt', '.pptx', '.pages', '.numbers',
]);

interface WriteFileInput {
  path: string;
  content: string;
  append?: boolean;
}

function isProtectedPath(filePath: string): boolean {
  const resolved = resolve(filePath);
  return PROTECTED_WRITE_PATHS.some((protected_) =>
    resolved.includes(protected_)
  );
}

export function createWriteFileExecutor(): NativeToolExecutor {
  return {
    toolName: 'write_file',

    async execute(call: NativeToolCall): Promise<NativeToolResult> {
      const { path: filePath, content, append = false } = call.input as unknown as WriteFileInput;

      if (typeof filePath !== 'string' || filePath.trim() === '') {
        return {
          toolCallId: call.id,
          success: false,
          error: 'Invalid input: path must be a non-empty string',
        };
      }

      if (typeof content !== 'string') {
        return {
          toolCallId: call.id,
          success: false,
          error: 'Invalid input: content must be a string',
        };
      }

      if (content.length > MAX_WRITE_SIZE) {
        return {
          toolCallId: call.id,
          success: false,
          error: `Content too large (${(content.length / 1024 / 1024).toFixed(1)}MB). Maximum is 10MB.`,
        };
      }

      // Redirect user documents away from the repo root.
      // If the path is relative (no directory component) and has a document extension,
      // route it to ~/Documents/Tyrion/ instead of the current working directory.
      let effectivePath = filePath;
      if (filePath.startsWith('~/')) {
        effectivePath = join(homedir(), filePath.slice(2));
      } else {
        const ext = extname(filePath).toLowerCase();
        const dir = dirname(filePath);
        const isRelativeRoot = dir === '.' || dir === '';
        if (isRelativeRoot && DOCUMENT_EXTENSIONS.has(ext)) {
          effectivePath = join(USER_DOCUMENTS_DIR, basename(filePath));
          safeLogger.info('write_file redirected to user documents', {
            original: filePath,
            redirected: effectivePath,
          });
        }
      }

      const resolved = resolve(effectivePath);

      // Safety check
      if (isProtectedPath(resolved)) {
        safeLogger.warn('Blocked write_file on protected path', { path: resolved.substring(0, 50) });
        return {
          toolCallId: call.id,
          success: false,
          error: 'Cannot write to protected path',
        };
      }

      try {
        // Ensure parent directory exists
        const dir = dirname(resolved);
        if (!existsSync(dir)) {
          await mkdir(dir, { recursive: true });
        }

        const existed = existsSync(resolved);

        if (append) {
          await appendFile(resolved, content, 'utf-8');
        } else {
          await writeFile(resolved, content, 'utf-8');
        }

        const fileStat = await stat(resolved);

        const result = {
          path: resolved,
          bytesWritten: Buffer.byteLength(content, 'utf-8'),
          totalSize: fileStat.size,
          created: !existed,
          appended: append,
        };

        safeLogger.info('write_file executed', {
          path: resolved.substring(0, 80),
          bytesWritten: result.bytesWritten,
          created: result.created,
          appended: append,
        });

        return {
          toolCallId: call.id,
          success: true,
          output: JSON.stringify(result),
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          toolCallId: call.id,
          success: false,
          error: `Failed to write file: ${message}`,
        };
      }
    },
  };
}
