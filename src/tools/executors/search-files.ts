/**
 * Native Search Files Executor
 *
 * Searches file contents for a regex pattern, replacing bash `grep`/`rg`.
 * Returns structured match results with file paths, line numbers, and content.
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, join, relative, extname } from 'node:path';
import { safeLogger } from '../../logging/safe-logger.js';
import type { NativeToolCall, NativeToolResult, NativeToolExecutor } from '../schemas/types.js';

/** Maximum files to search */
const MAX_FILES_TO_SEARCH = 1000;

/** Maximum results to return */
const MAX_RESULTS = 100;

/** Maximum file size to search (1MB) */
const MAX_SEARCH_FILE_SIZE = 1 * 1024 * 1024;

/** Maximum recursion depth */
const MAX_DEPTH = 15;

/** Binary file extensions to skip */
const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp', '.svg',
  '.mp3', '.mp4', '.mov', '.avi', '.wav', '.ogg', '.webm',
  '.zip', '.tar', '.gz', '.bz2', '.7z', '.rar',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.pptx',
  '.exe', '.dll', '.so', '.dylib', '.o',
  '.woff', '.woff2', '.ttf', '.eot',
  '.sqlite', '.db',
]);

interface SearchFilesInput {
  pattern: string;
  path?: string;
  filePattern?: string;
  maxResults?: number;
  ignoreCase?: boolean;
}

interface SearchMatch {
  file: string;
  line: number;
  content: string;
}

function isBinaryFile(filePath: string): boolean {
  return BINARY_EXTENSIONS.has(extname(filePath).toLowerCase());
}

function matchesGlob(name: string, pattern: string): boolean {
  const regex = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '.');

  return new RegExp(`^${regex}$`).test(name);
}

async function collectFiles(
  dirPath: string,
  filePattern: string | undefined,
  files: string[],
  depth: number
): Promise<void> {
  if (depth > MAX_DEPTH || files.length >= MAX_FILES_TO_SEARCH) {
    return;
  }

  let entries;
  try {
    entries = await readdir(dirPath, { withFileTypes: true });
  } catch {
    return; // Permission denied, skip
  }

  for (const entry of entries) {
    if (files.length >= MAX_FILES_TO_SEARCH) {
      break;
    }

    const fullPath = join(dirPath, entry.name);

    // Skip hidden directories and node_modules
    if (entry.name.startsWith('.') || entry.name === 'node_modules') {
      continue;
    }

    if (entry.isFile()) {
      if (isBinaryFile(entry.name)) {
        continue;
      }
      if (filePattern && !matchesGlob(entry.name, filePattern)) {
        continue;
      }
      files.push(fullPath);
    } else if (entry.isDirectory()) {
      await collectFiles(fullPath, filePattern, files, depth + 1);
    }
  }
}

async function searchFile(
  filePath: string,
  regex: RegExp,
  basePath: string,
  matches: SearchMatch[],
  maxResults: number
): Promise<void> {
  if (matches.length >= maxResults) {
    return;
  }

  try {
    const fileStat = await stat(filePath);
    if (fileStat.size > MAX_SEARCH_FILE_SIZE) {
      return;
    }

    const content = await readFile(filePath, 'utf-8');
    const lines = content.split('\n');
    const relPath = relative(basePath, filePath);

    for (let i = 0; i < lines.length; i++) {
      if (matches.length >= maxResults) {
        break;
      }

      if (regex.test(lines[i] ?? '')) {
        matches.push({
          file: relPath,
          line: i + 1,
          content: (lines[i] ?? '').trim().substring(0, 200),
        });
      }
    }
  } catch {
    // Skip files that can't be read
  }
}

export function createSearchFilesExecutor(): NativeToolExecutor {
  return {
    toolName: 'search_files',

    async execute(call: NativeToolCall): Promise<NativeToolResult> {
      const {
        pattern,
        path: searchPath = '.',
        filePattern,
        maxResults = MAX_RESULTS,
        ignoreCase = false,
      } = call.input as unknown as SearchFilesInput;

      if (typeof pattern !== 'string' || pattern.trim() === '') {
        return {
          toolCallId: call.id,
          success: false,
          error: 'Invalid input: pattern must be a non-empty string',
        };
      }

      const resolved = resolve(searchPath);

      if (!existsSync(resolved)) {
        return {
          toolCallId: call.id,
          success: false,
          error: `Search path not found: ${searchPath}`,
        };
      }

      let regex: RegExp;
      try {
        regex = new RegExp(pattern, ignoreCase ? 'i' : '');
      } catch {
        return {
          toolCallId: call.id,
          success: false,
          error: `Invalid regex pattern: ${pattern}`,
        };
      }

      try {
        const effectiveMax = Math.min(maxResults, MAX_RESULTS);

        // Collect files to search
        const files: string[] = [];
        const dirStat = await stat(resolved);

        if (dirStat.isFile()) {
          files.push(resolved);
        } else {
          await collectFiles(resolved, filePattern, files, 0);
        }

        // Search each file
        const matches: SearchMatch[] = [];
        for (const file of files) {
          if (matches.length >= effectiveMax) {
            break;
          }
          await searchFile(file, regex, resolved, matches, effectiveMax);
        }

        const result = {
          pattern,
          searchPath: resolved,
          matches,
          totalMatches: matches.length,
          filesSearched: files.length,
          truncated: matches.length >= effectiveMax,
        };

        safeLogger.info('search_files executed', {
          pattern: pattern.substring(0, 50),
          filesSearched: files.length,
          matchesFound: matches.length,
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
          error: `Search failed: ${message}`,
        };
      }
    },
  };
}
