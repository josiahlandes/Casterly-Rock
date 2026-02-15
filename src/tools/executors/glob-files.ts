/**
 * Glob Files Executor
 *
 * Bridges the coding module's glob tool to the NativeToolExecutor pattern.
 * Returns structured file discovery results with metadata.
 */

import { safeLogger } from '../../logging/safe-logger.js';
import { glob } from '../../coding/tools/glob.js';
import type { NativeToolCall, NativeToolResult, NativeToolExecutor } from '../schemas/types.js';

interface GlobFilesInput {
  pattern: string;
  cwd?: string;
  filesOnly?: boolean;
  maxDepth?: number;
}

export function createGlobFilesExecutor(): NativeToolExecutor {
  return {
    toolName: 'glob_files',

    async execute(call: NativeToolCall): Promise<NativeToolResult> {
      const {
        pattern,
        cwd,
        filesOnly = true,
        maxDepth,
      } = call.input as unknown as GlobFilesInput;

      if (typeof pattern !== 'string' || pattern.trim() === '') {
        return {
          toolCallId: call.id,
          success: false,
          error: 'Invalid input: pattern must be a non-empty string',
        };
      }

      try {
        // Build options object, omitting undefined values (exactOptionalPropertyTypes)
        const options: Parameters<typeof glob>[1] = { filesOnly };
        if (cwd !== undefined) options.cwd = cwd;
        if (maxDepth !== undefined) options.maxDepth = maxDepth;

        const result = await glob(pattern, options);

        if (!result.success) {
          return {
            toolCallId: call.id,
            success: false,
            error: result.error ?? 'Glob failed',
          };
        }

        // Build concise output — limit to 200 matches to avoid overwhelming context
        const matches = result.matches.slice(0, 200).map((m) => ({
          path: m.relativePath,
          size: m.size,
          modified: m.modified,
          isDir: m.isDirectory || undefined,
        }));

        const output = JSON.stringify({
          pattern,
          cwd: result.cwd,
          matchCount: result.matches.length,
          truncated: result.matches.length > 200,
          matches,
        });

        safeLogger.info('glob_files executed', {
          pattern,
          matchCount: result.matches.length,
        });

        return {
          toolCallId: call.id,
          success: true,
          output,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          toolCallId: call.id,
          success: false,
          error: `Glob failed: ${message}`,
        };
      }
    },
  };
}
