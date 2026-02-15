/**
 * Grep Files Executor
 *
 * Bridges the coding module's grep tool to the NativeToolExecutor pattern.
 * Returns structured search results with context lines.
 */

import { safeLogger } from '../../logging/safe-logger.js';
import { grep, formatGrepResults } from '../../coding/tools/grep.js';
import type { NativeToolCall, NativeToolResult, NativeToolExecutor } from '../schemas/types.js';

interface GrepFilesInput {
  pattern: string;
  cwd?: string;
  include?: string[];
  ignoreCase?: boolean;
  literal?: boolean;
  contextBefore?: number;
  contextAfter?: number;
  maxMatches?: number;
}

export function createGrepFilesExecutor(): NativeToolExecutor {
  return {
    toolName: 'grep_files',

    async execute(call: NativeToolCall): Promise<NativeToolResult> {
      const {
        pattern,
        cwd,
        include,
        ignoreCase,
        literal,
        contextBefore,
        contextAfter,
        maxMatches,
      } = call.input as unknown as GrepFilesInput;

      if (typeof pattern !== 'string' || pattern.trim() === '') {
        return {
          toolCallId: call.id,
          success: false,
          error: 'Invalid input: pattern must be a non-empty string',
        };
      }

      try {
        // Build options object, omitting undefined values (exactOptionalPropertyTypes)
        const options: Parameters<typeof grep>[1] = { maxMatches: maxMatches ?? 100 };
        if (cwd !== undefined) options.cwd = cwd;
        if (include !== undefined) options.include = include;
        if (ignoreCase !== undefined) options.ignoreCase = ignoreCase;
        if (literal !== undefined) options.literal = literal;
        if (contextBefore !== undefined) options.contextBefore = contextBefore;
        if (contextAfter !== undefined) options.contextAfter = contextAfter;

        const result = await grep(pattern, options);

        if (!result.success) {
          return {
            toolCallId: call.id,
            success: false,
            error: result.error ?? 'Grep failed',
          };
        }

        // Use the formatted output — it's human-readable and token-efficient
        const formatted = formatGrepResults(result);

        safeLogger.info('grep_files executed', {
          pattern,
          totalMatches: result.totalMatches,
          filesMatched: result.filesMatched,
          filesSearched: result.filesSearched,
        });

        return {
          toolCallId: call.id,
          success: true,
          output: formatted,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          toolCallId: call.id,
          success: false,
          error: `Grep failed: ${message}`,
        };
      }
    },
  };
}
