/**
 * Native Read File Executor
 *
 * Reads file contents directly via Node fs, replacing bash `cat`/`head`/`tail`.
 * Returns structured output with content, size, and line count.
 */

import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { safeLogger } from '../../logging/safe-logger.js';
import type { NativeToolCall, NativeToolResult, NativeToolExecutor } from '../schemas/types.js';

/** Paths that should never be read by the tool executor */
const BLOCKED_READ_PATHS = [
  '.env',
  '.env.local',
  '.env.production',
];

/** Max file size to read (5MB) */
const MAX_FILE_SIZE = 5 * 1024 * 1024;

interface ReadFileInput {
  path: string;
  encoding?: 'utf-8' | 'ascii' | 'base64';
  maxLines?: number;
}

function isBlockedPath(filePath: string): boolean {
  const resolved = resolve(filePath);
  return BLOCKED_READ_PATHS.some((blocked) =>
    resolved.endsWith(blocked) || resolved.includes(`/${blocked}`)
  );
}

export function createReadFileExecutor(): NativeToolExecutor {
  return {
    toolName: 'read_file',

    async execute(call: NativeToolCall): Promise<NativeToolResult> {
      const { path: filePath, encoding = 'utf-8', maxLines } = call.input as unknown as ReadFileInput;

      if (typeof filePath !== 'string' || filePath.trim() === '') {
        return {
          toolCallId: call.id,
          success: false,
          error: 'Invalid input: path must be a non-empty string',
        };
      }

      const resolved = resolve(filePath);

      // Safety check
      if (isBlockedPath(resolved)) {
        safeLogger.warn('Blocked read_file on protected path', { path: resolved.substring(0, 50) });
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

      try {
        const fileStat = await stat(resolved);

        if (fileStat.isDirectory()) {
          return {
            toolCallId: call.id,
            success: false,
            error: `Path is a directory, not a file: ${filePath}`,
          };
        }

        if (fileStat.size > MAX_FILE_SIZE) {
          return {
            toolCallId: call.id,
            success: false,
            error: `File too large (${(fileStat.size / 1024 / 1024).toFixed(1)}MB). Maximum is 5MB.`,
          };
        }

        let content = await readFile(resolved, { encoding: encoding as BufferEncoding });

        let totalLines = content.split('\n').length;

        if (maxLines && maxLines > 0) {
          const lines = content.split('\n');
          content = lines.slice(0, maxLines).join('\n');
        }

        const result = {
          content,
          size: fileStat.size,
          lines: totalLines,
          truncated: maxLines ? totalLines > maxLines : false,
        };

        safeLogger.info('read_file executed', {
          path: resolved.substring(0, 80),
          size: fileStat.size,
          lines: totalLines,
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
          error: `Failed to read file: ${message}`,
        };
      }
    },
  };
}
