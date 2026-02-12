/**
 * Native List Files Executor
 *
 * Lists files and directories via Node fs, replacing bash `ls`/`find`.
 * Returns structured array of file entries with type and size info.
 */

import { readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, join, relative } from 'node:path';
import { safeLogger } from '../../logging/safe-logger.js';
import type { NativeToolCall, NativeToolResult, NativeToolExecutor } from '../schemas/types.js';

/** Maximum files to return to avoid overwhelming the model */
const MAX_RESULTS = 500;

/** Maximum recursion depth */
const MAX_DEPTH = 10;

interface ListFilesInput {
  path: string;
  recursive?: boolean;
  pattern?: string;
}

interface FileEntry {
  name: string;
  path: string;
  type: 'file' | 'directory' | 'symlink' | 'other';
  size: number;
}

/**
 * Simple glob pattern matching (supports * and ** and ?)
 */
function matchesPattern(name: string, pattern: string): boolean {
  const regex = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '{{GLOBSTAR}}')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '.')
    .replace(/\{\{GLOBSTAR\}\}/g, '.*');

  return new RegExp(`^${regex}$`).test(name);
}

async function listDirectory(
  dirPath: string,
  basePath: string,
  recursive: boolean,
  pattern: string | undefined,
  entries: FileEntry[],
  depth: number
): Promise<void> {
  if (depth > MAX_DEPTH || entries.length >= MAX_RESULTS) {
    return;
  }

  const dirEntries = await readdir(dirPath, { withFileTypes: true });

  for (const entry of dirEntries) {
    if (entries.length >= MAX_RESULTS) {
      break;
    }

    // Skip hidden files/dirs at top level for cleanliness
    const fullPath = join(dirPath, entry.name);
    const relativePath = relative(basePath, fullPath);

    // Apply pattern filter
    if (pattern && !matchesPattern(entry.name, pattern)) {
      // For recursive, still descend into directories even if name doesn't match
      if (recursive && entry.isDirectory()) {
        await listDirectory(fullPath, basePath, recursive, pattern, entries, depth + 1);
      }
      continue;
    }

    let fileSize = 0;
    let fileType: FileEntry['type'] = 'other';

    if (entry.isFile()) {
      fileType = 'file';
      try {
        const fileStat = await stat(fullPath);
        fileSize = fileStat.size;
      } catch {
        // Permission denied or broken link — skip size
      }
    } else if (entry.isDirectory()) {
      fileType = 'directory';
    } else if (entry.isSymbolicLink()) {
      fileType = 'symlink';
    }

    entries.push({
      name: entry.name,
      path: relativePath,
      type: fileType,
      size: fileSize,
    });

    // Recurse into subdirectories
    if (recursive && entry.isDirectory()) {
      await listDirectory(fullPath, basePath, recursive, pattern, entries, depth + 1);
    }
  }
}

export function createListFilesExecutor(): NativeToolExecutor {
  return {
    toolName: 'list_files',

    async execute(call: NativeToolCall): Promise<NativeToolResult> {
      const { path: dirPath, recursive = false, pattern } = call.input as unknown as ListFilesInput;

      if (typeof dirPath !== 'string' || dirPath.trim() === '') {
        return {
          toolCallId: call.id,
          success: false,
          error: 'Invalid input: path must be a non-empty string',
        };
      }

      const resolved = resolve(dirPath);

      if (!existsSync(resolved)) {
        return {
          toolCallId: call.id,
          success: false,
          error: `Directory not found: ${dirPath}`,
        };
      }

      try {
        const dirStat = await stat(resolved);
        if (!dirStat.isDirectory()) {
          return {
            toolCallId: call.id,
            success: false,
            error: `Path is not a directory: ${dirPath}`,
          };
        }

        const entries: FileEntry[] = [];
        await listDirectory(resolved, resolved, recursive, pattern, entries, 0);

        const result = {
          directory: resolved,
          files: entries,
          totalEntries: entries.length,
          truncated: entries.length >= MAX_RESULTS,
        };

        safeLogger.info('list_files executed', {
          path: resolved.substring(0, 80),
          entries: entries.length,
          recursive,
          pattern: pattern ?? 'none',
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
          error: `Failed to list files: ${message}`,
        };
      }
    },
  };
}
