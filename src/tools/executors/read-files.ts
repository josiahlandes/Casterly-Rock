/**
 * Batch File Read Executor
 *
 * Reads multiple files in a single tool call, cutting multi-file
 * exploration from N turns to 1. Supports explicit paths and glob patterns.
 *
 * See roadmap §20 and docs/qwen-code-vs-deeploop.md §3.
 */

import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { glob } from 'glob';
import { safeLogger } from '../../logging/safe-logger.js';
import type { NativeToolCall, NativeToolResult, NativeToolExecutor } from '../schemas/types.js';

/** Paths that should never be read */
const BLOCKED_READ_PATHS = [
  '.env',
  '.env.local',
  '.env.production',
];

/** Max file size per file (5MB) */
const MAX_FILE_SIZE = 5 * 1024 * 1024;

/** Max aggregate content size (~50K chars ≈ ~14K tokens) */
const MAX_AGGREGATE_CHARS = 50_000;

/** Max number of files per batch */
const MAX_FILES_PER_BATCH = 20;

interface ReadFilesInput {
  paths?: string[];
  glob_pattern?: string;
}

interface FileResult {
  path: string;
  content?: string;
  lines?: number;
  size?: number;
  error?: string;
  truncated?: boolean;
}

function isBlockedPath(filePath: string): boolean {
  const resolved = resolve(filePath);
  return BLOCKED_READ_PATHS.some((blocked) =>
    resolved.endsWith(blocked) || resolved.includes(`/${blocked}`)
  );
}

export function createReadFilesExecutor(): NativeToolExecutor {
  return {
    toolName: 'read_files',

    async execute(call: NativeToolCall): Promise<NativeToolResult> {
      const input = call.input as unknown as ReadFilesInput;
      const paths = input.paths ?? [];
      const globPattern = input.glob_pattern;

      if (paths.length === 0 && !globPattern) {
        return {
          toolCallId: call.id,
          success: false,
          error: 'Must provide either paths array or glob_pattern.',
        };
      }

      // Resolve glob pattern to paths
      let resolvedPaths = [...paths];
      if (globPattern) {
        try {
          const globResults = await glob(globPattern, {
            nodir: true,
            absolute: false,
            ignore: ['node_modules/**', '.git/**', 'dist/**'],
          });
          resolvedPaths.push(...globResults);
        } catch (err) {
          return {
            toolCallId: call.id,
            success: false,
            error: `Glob pattern error: ${err instanceof Error ? err.message : String(err)}`,
          };
        }
      }

      // Deduplicate
      resolvedPaths = [...new Set(resolvedPaths)];

      // Enforce max files
      if (resolvedPaths.length > MAX_FILES_PER_BATCH) {
        resolvedPaths = resolvedPaths.slice(0, MAX_FILES_PER_BATCH);
      }

      if (resolvedPaths.length === 0) {
        return {
          toolCallId: call.id,
          success: true,
          output: JSON.stringify({ files: [], note: 'No files matched.' }),
        };
      }

      // Read all files
      const results: FileResult[] = [];
      let totalChars = 0;

      for (const filePath of resolvedPaths) {
        const resolved = resolve(filePath);

        // Safety checks
        if (isBlockedPath(resolved)) {
          results.push({ path: filePath, error: 'Protected file' });
          continue;
        }

        if (!existsSync(resolved)) {
          results.push({ path: filePath, error: 'File not found' });
          continue;
        }

        try {
          const fileStat = await stat(resolved);

          if (fileStat.isDirectory()) {
            results.push({ path: filePath, error: 'Path is a directory' });
            continue;
          }

          if (fileStat.size > MAX_FILE_SIZE) {
            results.push({
              path: filePath,
              error: `Too large (${(fileStat.size / 1024 / 1024).toFixed(1)}MB)`,
            });
            continue;
          }

          let content = await readFile(resolved, 'utf-8');
          const lines = content.split('\n').length;
          let truncated = false;

          // Truncate if aggregate budget exceeded
          const remaining = MAX_AGGREGATE_CHARS - totalChars;
          if (remaining <= 0) {
            results.push({
              path: filePath,
              error: 'Aggregate size limit reached',
              size: fileStat.size,
              lines,
            });
            continue;
          }

          if (content.length > remaining) {
            content = content.slice(0, remaining) + '\n...(truncated)';
            truncated = true;
          }

          totalChars += content.length;

          results.push({
            path: filePath,
            content,
            lines,
            size: fileStat.size,
            truncated,
          });
        } catch (err) {
          results.push({
            path: filePath,
            error: `Read failed: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      }

      safeLogger.info('read_files executed', {
        fileCount: results.length,
        successCount: results.filter((r) => r.content !== undefined).length,
        totalChars,
      });

      return {
        toolCallId: call.id,
        success: true,
        output: JSON.stringify({ files: results }),
      };
    },
  };
}
