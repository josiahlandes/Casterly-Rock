/**
 * Grep Tool
 *
 * Search file contents using patterns.
 * Returns structured results with context.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { glob } from './glob.js';

interface GrepOptions {
  /** Base directory to search from (default: cwd) */
  cwd?: string;
  /** File patterns to search (default: all files) */
  include?: string[];
  /** File patterns to exclude */
  exclude?: string[];
  /** Case insensitive search (default: false) */
  ignoreCase?: boolean;
  /** Treat pattern as literal string, not regex (default: false) */
  literal?: boolean;
  /** Lines of context before match */
  contextBefore?: number;
  /** Lines of context after match */
  contextAfter?: number;
  /** Maximum matches to return */
  maxMatches?: number;
  /** Only return file names, not content */
  filesOnly?: boolean;
  /** Search hidden files (default: false) */
  dot?: boolean;
}

interface GrepResult {
  success: boolean;
  pattern: string;
  matches: GrepMatch[];
  totalMatches: number;
  filesSearched: number;
  filesMatched: number;
  truncated: boolean;
  error?: string;
}

interface GrepMatch {
  file: string;
  relativePath: string;
  line: number;
  column: number;
  content: string;
  /** Lines before the match */
  contextBefore?: string[];
  /** Lines after the match */
  contextAfter?: string[];
}

/**
 * Default file patterns to search.
 */
const DEFAULT_INCLUDE = [
  '**/*.ts',
  '**/*.tsx',
  '**/*.js',
  '**/*.jsx',
  '**/*.mjs',
  '**/*.cjs',
  '**/*.json',
  '**/*.yaml',
  '**/*.yml',
  '**/*.md',
  '**/*.py',
  '**/*.rs',
  '**/*.go',
  '**/*.java',
  '**/*.c',
  '**/*.cpp',
  '**/*.h',
  '**/*.hpp',
  '**/*.css',
  '**/*.scss',
  '**/*.html',
  '**/*.xml',
  '**/*.sh',
  '**/*.bash',
  '**/*.zsh',
];

/**
 * Default patterns to exclude.
 */
const DEFAULT_EXCLUDE = [
  'node_modules/**',
  '.git/**',
  'dist/**',
  'build/**',
  'coverage/**',
  '*.min.js',
  '*.min.css',
  '*.map',
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
];

/**
 * Binary file extensions to skip.
 */
const BINARY_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.ico',
  '.svg',
  '.pdf',
  '.zip',
  '.tar',
  '.gz',
  '.exe',
  '.dll',
  '.so',
  '.dylib',
  '.woff',
  '.woff2',
  '.ttf',
  '.eot',
  '.mp3',
  '.mp4',
  '.wav',
  '.ogg',
  '.webm',
  '.mov',
]);

/**
 * Check if a file is likely binary based on extension.
 */
function isBinaryFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return BINARY_EXTENSIONS.has(ext);
}

/**
 * Escape special regex characters in a string.
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Search for a pattern in file contents.
 */
export async function grep(pattern: string, options: GrepOptions = {}): Promise<GrepResult> {
  const {
    cwd = process.cwd(),
    include = DEFAULT_INCLUDE,
    exclude = DEFAULT_EXCLUDE,
    ignoreCase = false,
    literal = false,
    contextBefore = 0,
    contextAfter = 0,
    maxMatches = 1000,
    filesOnly = false,
    dot = false,
  } = options;

  const absoluteCwd = path.isAbsolute(cwd) ? cwd : path.resolve(cwd);

  try {
    // Build regex
    let regex: RegExp;
    try {
      const regexPattern = literal ? escapeRegex(pattern) : pattern;
      const flags = ignoreCase ? 'gi' : 'g';
      regex = new RegExp(regexPattern, flags);
    } catch (err) {
      return {
        success: false,
        pattern,
        matches: [],
        totalMatches: 0,
        filesSearched: 0,
        filesMatched: 0,
        truncated: false,
        error: `Invalid regex pattern: ${(err as Error).message}`,
      };
    }

    // Find files to search
    const globPattern = include.length === 1 && include[0] ? include[0] : `{${include.join(',')}}`;
    const globResult = await glob(globPattern, {
      cwd: absoluteCwd,
      ignore: exclude,
      filesOnly: true,
      dot,
    });

    if (!globResult.success) {
      const errorResult: GrepResult = {
        success: false,
        pattern,
        matches: [],
        totalMatches: 0,
        filesSearched: 0,
        filesMatched: 0,
        truncated: false,
      };
      if (globResult.error) {
        errorResult.error = globResult.error;
      }
      return errorResult;
    }

    const matches: GrepMatch[] = [];
    let totalMatches = 0;
    let filesSearched = 0;
    let filesMatched = 0;
    let truncated = false;

    // Search each file
    for (const file of globResult.matches) {
      // Skip binary files
      if (isBinaryFile(file.path)) {
        continue;
      }

      filesSearched++;

      // Check if we've hit max matches
      if (matches.length >= maxMatches) {
        truncated = true;
        break;
      }

      try {
        const content = await fs.readFile(file.path, 'utf-8');
        const lines = content.split('\n');

        let fileHasMatch = false;

        for (let lineNum = 0; lineNum < lines.length; lineNum++) {
          const line = lines[lineNum];
          if (line === undefined) continue;

          // Reset regex lastIndex for each line
          regex.lastIndex = 0;

          let match;
          while ((match = regex.exec(line)) !== null) {
            totalMatches++;
            fileHasMatch = true;

            if (!filesOnly && matches.length < maxMatches) {
              // Get context lines
              const ctxBefore: string[] = [];
              const ctxAfter: string[] = [];

              if (contextBefore > 0) {
                for (let i = Math.max(0, lineNum - contextBefore); i < lineNum; i++) {
                  const ctxLine = lines[i];
                  if (ctxLine !== undefined) {
                    ctxBefore.push(ctxLine);
                  }
                }
              }

              if (contextAfter > 0) {
                for (
                  let i = lineNum + 1;
                  i <= Math.min(lines.length - 1, lineNum + contextAfter);
                  i++
                ) {
                  const ctxLine = lines[i];
                  if (ctxLine !== undefined) {
                    ctxAfter.push(ctxLine);
                  }
                }
              }

              const grepMatch: GrepMatch = {
                file: file.path,
                relativePath: file.relativePath,
                line: lineNum + 1,
                column: match.index + 1,
                content: line,
              };
              if (ctxBefore.length > 0) {
                grepMatch.contextBefore = ctxBefore;
              }
              if (ctxAfter.length > 0) {
                grepMatch.contextAfter = ctxAfter;
              }
              matches.push(grepMatch);
            }

            // If not global search or filesOnly, break after first match
            if (filesOnly || !regex.global) {
              break;
            }
          }

          // For filesOnly mode, break after first match in file
          if (filesOnly && fileHasMatch) {
            break;
          }
        }

        if (fileHasMatch) {
          filesMatched++;

          // For filesOnly mode, just add one entry per file
          if (filesOnly) {
            matches.push({
              file: file.path,
              relativePath: file.relativePath,
              line: 0,
              column: 0,
              content: '',
            });
          }
        }
      } catch {
        // Skip files we can't read
        continue;
      }
    }

    return {
      success: true,
      pattern,
      matches,
      totalMatches,
      filesSearched,
      filesMatched,
      truncated,
    };
  } catch (err) {
    return {
      success: false,
      pattern,
      matches: [],
      totalMatches: 0,
      filesSearched: 0,
      filesMatched: 0,
      truncated: false,
      error: `Grep failed: ${(err as Error).message}`,
    };
  }
}

/**
 * Format grep results for display.
 */
export function formatGrepResults(results: GrepResult, options: { color?: boolean } = {}): string {
  if (!results.success) {
    return `Error: ${results.error}`;
  }

  if (results.matches.length === 0) {
    return `No matches found for pattern: ${results.pattern}`;
  }

  const lines: string[] = [];

  // Group by file
  const byFile = new Map<string, GrepMatch[]>();
  for (const match of results.matches) {
    const existing = byFile.get(match.relativePath) || [];
    existing.push(match);
    byFile.set(match.relativePath, existing);
  }

  for (const [file, matches] of byFile) {
    lines.push(`${file}:`);

    for (const match of matches) {
      if (match.line === 0) {
        // filesOnly mode
        continue;
      }

      // Context before
      if (match.contextBefore) {
        for (let i = 0; i < match.contextBefore.length; i++) {
          const lineNum = match.line - match.contextBefore.length + i;
          lines.push(`  ${lineNum}: ${match.contextBefore[i]}`);
        }
      }

      // Matching line
      lines.push(`  ${match.line}: ${match.content}`);

      // Context after
      if (match.contextAfter) {
        for (let i = 0; i < match.contextAfter.length; i++) {
          const lineNum = match.line + i + 1;
          lines.push(`  ${lineNum}: ${match.contextAfter[i]}`);
        }
      }
    }

    lines.push('');
  }

  // Summary
  lines.push(
    `Found ${results.totalMatches} matches in ${results.filesMatched} files (${results.filesSearched} files searched)`
  );

  if (results.truncated) {
    lines.push('(results truncated)');
  }

  return lines.join('\n');
}
