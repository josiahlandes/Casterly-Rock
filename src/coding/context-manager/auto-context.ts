/**
 * Auto-Context
 *
 * Automatically suggests relevant files based on the current task.
 * Uses keywords, file references, and repo map importance to suggest files.
 */

import * as path from 'path';
import { grep } from '../tools/grep.js';
import { glob } from '../tools/glob.js';
import type { RepoMap } from '../repo-map/types.js';

/**
 * Options for file suggestions.
 */
export interface SuggestOptions {
  /** Maximum number of files to suggest */
  maxFiles?: number;
  /** Minimum importance score for repo map files */
  minImportance?: number;
  /** Include files matching these patterns */
  includePatterns?: string[];
  /** Exclude files matching these patterns */
  excludePatterns?: string[];
}

/**
 * A suggested file with reasoning.
 */
export interface SuggestedFile {
  /** Relative file path */
  path: string;
  /** Why this file was suggested */
  reason: string;
  /** Confidence score (0-1) */
  confidence: number;
  /** Source of the suggestion */
  source: 'keyword' | 'reference' | 'importance' | 'pattern';
}

/**
 * Default options.
 */
const DEFAULT_OPTIONS: Required<SuggestOptions> = {
  maxFiles: 10,
  minImportance: 0.1,
  includePatterns: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx'],
  excludePatterns: ['node_modules/**', 'dist/**', 'build/**', '*.d.ts'],
};

/**
 * Suggest files relevant to a task description.
 */
export async function suggestFiles(
  task: string,
  rootPath: string,
  repoMap: RepoMap | null,
  options: SuggestOptions = {}
): Promise<SuggestedFile[]> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const suggestions: SuggestedFile[] = [];

  // Extract keywords from task
  const keywords = extractKeywords(task);

  // Extract file references from task
  const fileRefs = extractFileReferences(task);

  // 1. Add explicitly referenced files (highest confidence)
  for (const ref of fileRefs) {
    const matches = await glob(ref, {
      cwd: rootPath,
      ignore: opts.excludePatterns,
    });

    if (matches.success) {
      for (const match of matches.matches.slice(0, 3)) {
        suggestions.push({
          path: match.relativePath,
          reason: `Explicitly mentioned in task: "${ref}"`,
          confidence: 1.0,
          source: 'reference',
        });
      }
    }
  }

  // 2. Search for keyword matches
  for (const keyword of keywords) {
    try {
      const result = await grep(keyword, {
        cwd: rootPath,
        include: opts.includePatterns,
        exclude: opts.excludePatterns,
        filesOnly: true,
        maxMatches: 5,
        ignoreCase: true,
      });

      if (result.success) {
        for (const match of result.matches) {
          // Check if already suggested
          if (!suggestions.some((s) => s.path === match.relativePath)) {
            suggestions.push({
              path: match.relativePath,
              reason: `Contains keyword: "${keyword}"`,
              confidence: 0.7,
              source: 'keyword',
            });
          }
        }
      }
    } catch {
      // Skip failed searches
    }
  }

  // 3. Add important files from repo map
  if (repoMap) {
    for (const file of repoMap.files) {
      if (file.importance >= opts.minImportance) {
        // Check if already suggested
        if (!suggestions.some((s) => s.path === file.path)) {
          // Check if file matches any keywords
          const matchesKeyword = keywords.some(
            (kw) =>
              file.path.toLowerCase().includes(kw.toLowerCase()) ||
              file.symbols.some((s) => s.name.toLowerCase().includes(kw.toLowerCase()))
          );

          if (matchesKeyword) {
            suggestions.push({
              path: file.path,
              reason: `High importance (${(file.importance * 100).toFixed(0)}%) and matches keywords`,
              confidence: 0.6 + file.importance * 0.3,
              source: 'importance',
            });
          }
        }
      }
    }
  }

  // 4. Pattern-based suggestions
  const patternSuggestions = await suggestByPattern(task, rootPath, opts);
  for (const suggestion of patternSuggestions) {
    if (!suggestions.some((s) => s.path === suggestion.path)) {
      suggestions.push(suggestion);
    }
  }

  // Sort by confidence and limit
  return suggestions.sort((a, b) => b.confidence - a.confidence).slice(0, opts.maxFiles);
}

/**
 * Extract keywords from a task description.
 */
function extractKeywords(task: string): string[] {
  // Remove common words
  const stopWords = new Set([
    'the',
    'a',
    'an',
    'is',
    'are',
    'was',
    'were',
    'be',
    'been',
    'being',
    'have',
    'has',
    'had',
    'do',
    'does',
    'did',
    'will',
    'would',
    'could',
    'should',
    'may',
    'might',
    'must',
    'shall',
    'can',
    'need',
    'to',
    'of',
    'in',
    'for',
    'on',
    'with',
    'at',
    'by',
    'from',
    'as',
    'into',
    'through',
    'during',
    'before',
    'after',
    'above',
    'below',
    'between',
    'under',
    'again',
    'further',
    'then',
    'once',
    'and',
    'but',
    'or',
    'nor',
    'so',
    'yet',
    'both',
    'either',
    'neither',
    'not',
    'only',
    'own',
    'same',
    'than',
    'too',
    'very',
    'just',
    'also',
    'now',
    'here',
    'there',
    'when',
    'where',
    'why',
    'how',
    'all',
    'each',
    'every',
    'both',
    'few',
    'more',
    'most',
    'other',
    'some',
    'such',
    'no',
    'any',
    'this',
    'that',
    'these',
    'those',
    'i',
    'me',
    'my',
    'we',
    'our',
    'you',
    'your',
    'it',
    'its',
    'they',
    'them',
    'their',
    'what',
    'which',
    'who',
    'whom',
    'please',
    'add',
    'update',
    'fix',
    'change',
    'modify',
    'create',
    'make',
    'help',
    'want',
    'like',
    'file',
    'files',
    'code',
    'function',
    'class',
  ]);

  // Extract words
  const words = task
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !stopWords.has(w));

  // Also extract CamelCase and snake_case identifiers
  const identifierPattern = /\b([A-Z][a-zA-Z0-9]*|[a-z]+_[a-z_]+)\b/g;
  let match;
  while ((match = identifierPattern.exec(task)) !== null) {
    const identifier = match[1];
    if (identifier && !stopWords.has(identifier.toLowerCase())) {
      words.push(identifier);
    }
  }

  // Dedupe and limit
  return [...new Set(words)].slice(0, 10);
}

/**
 * Extract file references from task text.
 */
function extractFileReferences(task: string): string[] {
  const refs: string[] = [];

  // Match file paths like src/foo/bar.ts
  const pathPattern = /\b([\w./-]+\.(ts|tsx|js|jsx|py|rs|go|java|c|cpp|h|hpp|md|json|yaml|yml))\b/gi;
  let match;
  while ((match = pathPattern.exec(task)) !== null) {
    const filePath = match[1];
    if (filePath) {
      refs.push(filePath);
    }
  }

  // Match quoted paths
  const quotedPattern = /["'`]([\w./-]+)["'`]/g;
  while ((match = quotedPattern.exec(task)) !== null) {
    const filePath = match[1];
    if (filePath && (filePath.includes('/') || filePath.includes('.'))) {
      refs.push(filePath);
    }
  }

  return [...new Set(refs)];
}

/**
 * Suggest files based on common patterns in the task.
 */
async function suggestByPattern(
  task: string,
  rootPath: string,
  options: Required<SuggestOptions>
): Promise<SuggestedFile[]> {
  const suggestions: SuggestedFile[] = [];
  const taskLower = task.toLowerCase();

  // Common patterns
  const patterns: Array<{ trigger: string[]; patterns: string[]; reason: string }> = [
    {
      trigger: ['test', 'testing', 'spec'],
      patterns: ['**/*.test.ts', '**/*.spec.ts', '**/tests/**/*.ts'],
      reason: 'Task mentions testing',
    },
    {
      trigger: ['config', 'configuration', 'settings'],
      patterns: ['**/config/**', '**/*.config.*', '**/settings.*'],
      reason: 'Task mentions configuration',
    },
    {
      trigger: ['api', 'endpoint', 'route', 'router'],
      patterns: ['**/api/**', '**/routes/**', '**/router.*'],
      reason: 'Task mentions API/routing',
    },
    {
      trigger: ['component', 'ui', 'view', 'page'],
      patterns: ['**/components/**', '**/views/**', '**/pages/**'],
      reason: 'Task mentions UI components',
    },
    {
      trigger: ['database', 'db', 'model', 'schema'],
      patterns: ['**/models/**', '**/schema/**', '**/db/**'],
      reason: 'Task mentions database',
    },
    {
      trigger: ['auth', 'authentication', 'login', 'user'],
      patterns: ['**/auth/**', '**/user/**', '**/login.*'],
      reason: 'Task mentions authentication',
    },
    {
      trigger: ['util', 'utility', 'helper', 'lib'],
      patterns: ['**/utils/**', '**/helpers/**', '**/lib/**'],
      reason: 'Task mentions utilities',
    },
  ];

  for (const pattern of patterns) {
    if (pattern.trigger.some((t) => taskLower.includes(t))) {
      for (const globPattern of pattern.patterns) {
        try {
          const result = await glob(globPattern, {
            cwd: rootPath,
            ignore: options.excludePatterns,
          });

          if (result.success) {
            for (const match of result.matches.slice(0, 3)) {
              suggestions.push({
                path: match.relativePath,
                reason: pattern.reason,
                confidence: 0.5,
                source: 'pattern',
              });
            }
          }
        } catch {
          // Skip failed globs
        }
      }
    }
  }

  return suggestions;
}

/**
 * Rank files by relevance to a task.
 *
 * Returns a score from 0-1 for how relevant a file is.
 */
export function rankFileRelevance(
  filePath: string,
  task: string,
  repoMap: RepoMap | null
): number {
  let score = 0;
  const taskLower = task.toLowerCase();
  const fileBasename = path.basename(filePath).toLowerCase();
  const fileDirname = path.dirname(filePath).toLowerCase();

  // Check if file is mentioned directly
  if (taskLower.includes(filePath.toLowerCase())) {
    score += 1.0;
  }

  // Check if basename is mentioned
  if (taskLower.includes(fileBasename.replace(/\.[^.]+$/, ''))) {
    score += 0.5;
  }

  // Check if directory is mentioned
  const dirParts = fileDirname.split('/');
  for (const part of dirParts) {
    if (part && taskLower.includes(part)) {
      score += 0.2;
    }
  }

  // Check repo map importance
  if (repoMap) {
    const fileMap = repoMap.files.find((f) => f.path === filePath);
    if (fileMap) {
      score += fileMap.importance * 0.3;
    }
  }

  return Math.min(1, score);
}
