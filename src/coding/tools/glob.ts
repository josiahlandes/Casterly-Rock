/**
 * Glob Tool
 *
 * Find files matching glob patterns.
 * Returns structured results with metadata.
 */

import * as fs from 'fs/promises';
import * as path from 'path';

export interface GlobOptions {
  /** Base directory to search from (default: cwd) */
  cwd?: string;
  /** Include hidden files (default: false) */
  dot?: boolean;
  /** Follow symlinks (default: false) */
  followSymlinks?: boolean;
  /** Maximum depth to traverse (default: unlimited) */
  maxDepth?: number;
  /** Patterns to exclude */
  ignore?: string[];
  /** Only return files (not directories) */
  filesOnly?: boolean;
  /** Only return directories (not files) */
  dirsOnly?: boolean;
}

export interface GlobResult {
  success: boolean;
  pattern: string;
  cwd: string;
  matches: GlobMatch[];
  error?: string;
}

export interface GlobMatch {
  path: string;
  relativePath: string;
  isDirectory: boolean;
  size?: number;
  modified?: string;
}

/**
 * Default patterns to ignore.
 */
const DEFAULT_IGNORE = [
  'node_modules/**',
  '.git/**',
  'dist/**',
  'build/**',
  'coverage/**',
  '__pycache__/**',
  '*.pyc',
  '.DS_Store',
  'Thumbs.db',
];

/**
 * Convert a glob pattern to a RegExp.
 *
 * Supports:
 * - * matches any characters except /
 * - ** matches any characters including /
 * - ? matches single character
 * - [abc] character classes
 * - {a,b} alternatives
 */
function globToRegex(pattern: string): RegExp {
  let regex = '';
  let i = 0;

  while (i < pattern.length) {
    const char = pattern[i];
    if (char === undefined) break;

    if (char === '*') {
      if (pattern[i + 1] === '*') {
        // ** matches anything including /
        regex += '.*';
        i += 2;
        // Skip trailing /
        if (pattern[i] === '/') i++;
      } else {
        // * matches anything except /
        regex += '[^/]*';
        i++;
      }
    } else if (char === '?') {
      regex += '[^/]';
      i++;
    } else if (char === '[') {
      // Character class
      const end = pattern.indexOf(']', i);
      if (end === -1) {
        regex += '\\[';
        i++;
      } else {
        regex += pattern.slice(i, end + 1);
        i = end + 1;
      }
    } else if (char === '{') {
      // Alternatives
      const end = pattern.indexOf('}', i);
      if (end === -1) {
        regex += '\\{';
        i++;
      } else {
        const alternatives = pattern.slice(i + 1, end).split(',');
        regex += '(' + alternatives.map(escapeRegex).join('|') + ')';
        i = end + 1;
      }
    } else if (char === '/') {
      regex += '\\/';
      i++;
    } else if ('.+^$|()'.includes(char)) {
      // Escape special regex characters
      regex += '\\' + char;
      i++;
    } else {
      regex += char;
      i++;
    }
  }

  return new RegExp('^' + regex + '$');
}

/**
 * Escape special regex characters.
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Check if a path matches any of the ignore patterns.
 */
function isIgnored(relativePath: string, ignorePatterns: RegExp[]): boolean {
  return ignorePatterns.some((pattern) => pattern.test(relativePath));
}

/**
 * Recursively walk a directory.
 */
async function* walkDir(
  dir: string,
  basePath: string,
  options: GlobOptions,
  ignorePatterns: RegExp[],
  depth: number = 0
): AsyncGenerator<{ path: string; relativePath: string; isDirectory: boolean; stats: fs.FileHandle extends never ? never : Awaited<ReturnType<typeof fs.stat>> }> {
  if (options.maxDepth !== undefined && depth > options.maxDepth) {
    return;
  }

  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    // Skip hidden files unless dot option is set
    if (!options.dot && entry.name.startsWith('.')) {
      continue;
    }

    const fullPath = path.join(dir, entry.name);
    const relativePath = path.relative(basePath, fullPath);

    // Check ignore patterns
    if (isIgnored(relativePath, ignorePatterns)) {
      continue;
    }

    const isDirectory = entry.isDirectory();

    // Get stats
    let stats;
    try {
      stats = await fs.stat(fullPath);
    } catch {
      continue;
    }

    yield {
      path: fullPath,
      relativePath,
      isDirectory,
      stats,
    };

    // Recurse into directories
    if (isDirectory) {
      yield* walkDir(fullPath, basePath, options, ignorePatterns, depth + 1);
    }
  }
}

/**
 * Find files matching a glob pattern.
 */
export async function glob(pattern: string, options: GlobOptions = {}): Promise<GlobResult> {
  const {
    cwd = process.cwd(),
    dot = false,
    ignore = [],
    filesOnly = false,
    dirsOnly = false,
  } = options;

  const absoluteCwd = path.isAbsolute(cwd) ? cwd : path.resolve(cwd);

  try {
    // Build ignore patterns
    const allIgnore = [...DEFAULT_IGNORE, ...ignore];
    const ignorePatterns = allIgnore.map(globToRegex);

    // Build match pattern
    const matchRegex = globToRegex(pattern);

    const matches: GlobMatch[] = [];

    // Walk directory tree
    for await (const entry of walkDir(absoluteCwd, absoluteCwd, { ...options, dot }, ignorePatterns)) {
      // Check if matches pattern
      if (!matchRegex.test(entry.relativePath)) {
        continue;
      }

      // Apply filesOnly/dirsOnly filters
      if (filesOnly && entry.isDirectory) continue;
      if (dirsOnly && !entry.isDirectory) continue;

      const match: GlobMatch = {
        path: entry.path,
        relativePath: entry.relativePath,
        isDirectory: entry.isDirectory,
        modified: entry.stats.mtime.toISOString(),
      };
      if (!entry.isDirectory && typeof entry.stats.size === 'number') {
        match.size = entry.stats.size;
      }
      matches.push(match);
    }

    // Sort by path
    matches.sort((a, b) => a.relativePath.localeCompare(b.relativePath));

    return {
      success: true,
      pattern,
      cwd: absoluteCwd,
      matches,
    };
  } catch (err) {
    return {
      success: false,
      pattern,
      cwd: absoluteCwd,
      matches: [],
      error: `Glob failed: ${(err as Error).message}`,
    };
  }
}

/**
 * Find files matching multiple patterns.
 */
export async function globMultiple(
  patterns: string[],
  options: GlobOptions = {}
): Promise<{ success: boolean; matches: GlobMatch[]; errors: string[] }> {
  const allMatches = new Map<string, GlobMatch>();
  const errors: string[] = [];

  for (const pattern of patterns) {
    const result = await glob(pattern, options);

    if (!result.success) {
      errors.push(result.error || `Failed to match pattern: ${pattern}`);
      continue;
    }

    for (const match of result.matches) {
      allMatches.set(match.path, match);
    }
  }

  const matches = Array.from(allMatches.values()).sort((a, b) =>
    a.relativePath.localeCompare(b.relativePath)
  );

  return {
    success: errors.length === 0,
    matches,
    errors,
  };
}

/**
 * List directory contents (non-recursive).
 */
export async function listDir(
  dirPath: string,
  options: { dot?: boolean } = {}
): Promise<{
  success: boolean;
  path: string;
  entries: Array<{ name: string; isDirectory: boolean; size?: number }>;
  error?: string;
}> {
  const absolutePath = path.isAbsolute(dirPath) ? dirPath : path.resolve(dirPath);

  try {
    const entries = await fs.readdir(absolutePath, { withFileTypes: true });
    const results: Array<{ name: string; isDirectory: boolean; size?: number }> = [];

    for (const entry of entries) {
      if (!options.dot && entry.name.startsWith('.')) {
        continue;
      }

      const fullPath = path.join(absolutePath, entry.name);
      const isDirectory = entry.isDirectory();

      let size: number | undefined;
      if (!isDirectory) {
        try {
          const stats = await fs.stat(fullPath);
          size = stats.size;
        } catch {
          // Ignore stat errors
        }
      }

      const result: { name: string; isDirectory: boolean; size?: number } = {
        name: entry.name,
        isDirectory,
      };
      if (size !== undefined) {
        result.size = size;
      }
      results.push(result);
    }

    // Sort: directories first, then alphabetically
    results.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) {
        return a.isDirectory ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    });

    return {
      success: true,
      path: absolutePath,
      entries: results,
    };
  } catch (err) {
    const error = err as NodeJS.ErrnoException;

    if (error.code === 'ENOENT') {
      return {
        success: false,
        path: absolutePath,
        entries: [],
        error: `Directory not found: ${absolutePath}`,
      };
    }

    if (error.code === 'ENOTDIR') {
      return {
        success: false,
        path: absolutePath,
        entries: [],
        error: `Not a directory: ${absolutePath}`,
      };
    }

    return {
      success: false,
      path: absolutePath,
      entries: [],
      error: `Failed to list directory: ${error.message}`,
    };
  }
}
