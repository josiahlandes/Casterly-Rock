/**
 * Repo Map Builder
 *
 * Builds a compressed map of a repository's structure.
 * The map includes symbols (functions, classes, etc.) and their relationships,
 * organized by importance using PageRank.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { glob } from '../tools/glob.js';
import { tokenCounter } from '../token-counter.js';
import { extractTypeScript, getTypeScriptExtensions } from './extractors/typescript.js';
import { computeImportance } from './pagerank.js';
import type { RepoMap, FileMap, RepoMapConfig, Language } from './types.js';
import { DEFAULT_CONFIG, EXTENSION_TO_LANGUAGE } from './types.js';

/**
 * Build a repo map for the given repository.
 */
export async function buildRepoMap(config: RepoMapConfig): Promise<RepoMap> {
  const fullConfig = {
    ...DEFAULT_CONFIG,
    ...config,
  };

  const {
    rootPath,
    tokenBudget,
    languages,
    includePatterns,
    excludePatterns,
    includePrivate,
  } = fullConfig;

  const absoluteRoot = path.isAbsolute(rootPath) ? rootPath : path.resolve(rootPath);

  // 1. Find all source files
  const files = await findSourceFiles(absoluteRoot, includePatterns, excludePatterns, languages);

  if (files.length === 0) {
    return {
      files: [],
      totalTokens: 0,
      generatedAt: new Date().toISOString(),
      rootPath: absoluteRoot,
    };
  }

  // 2. Parse each file and extract symbols
  const fileMaps: FileMap[] = [];
  const referenceGraph = new Map<string, Set<string>>();

  for (const filePath of files) {
    const relativePath = path.relative(absoluteRoot, filePath);

    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const ext = path.extname(filePath).toLowerCase();
      const language = EXTENSION_TO_LANGUAGE[ext];

      let extraction = { symbols: [] as FileMap['symbols'], references: [] as string[] };

      // Use appropriate extractor based on language
      if (language === 'typescript' || language === 'javascript') {
        extraction = extractTypeScript(content);
      }
      // TODO: Add extractors for other languages

      // Filter to exported symbols only (unless includePrivate)
      let symbols = extraction.symbols;
      if (!includePrivate) {
        symbols = symbols.filter((s) => s.exported);
      }

      // Resolve references to relative paths
      const resolvedRefs = resolveReferences(extraction.references, relativePath, files, absoluteRoot);

      // Calculate token count for this file's map entry
      const mapEntry = formatFileMapEntry({ path: relativePath, symbols, references: resolvedRefs, importance: 0, tokens: 0 });
      const tokens = tokenCounter.count(mapEntry);

      fileMaps.push({
        path: relativePath,
        symbols,
        references: resolvedRefs,
        importance: 0,
        tokens,
      });

      referenceGraph.set(relativePath, new Set(resolvedRefs));
    } catch {
      // Skip files that can't be read
      continue;
    }
  }

  // 3. Compute importance using PageRank
  const importanceScores = computeImportance(referenceGraph);

  for (const fileMap of fileMaps) {
    fileMap.importance = importanceScores.get(fileMap.path) ?? 0;
  }

  // 4. Sort by importance
  fileMaps.sort((a, b) => b.importance - a.importance);

  // 5. Trim to token budget
  const trimmed = trimToBudget(fileMaps, tokenBudget);

  // Calculate total tokens
  const totalTokens = trimmed.reduce((sum, f) => sum + f.tokens, 0);

  return {
    files: trimmed,
    totalTokens,
    generatedAt: new Date().toISOString(),
    rootPath: absoluteRoot,
  };
}

/**
 * Find all source files matching the configuration.
 */
async function findSourceFiles(
  rootPath: string,
  includePatterns: string[],
  excludePatterns: string[],
  languages: Language[]
): Promise<string[]> {
  // Get valid extensions for the selected languages
  const validExtensions = new Set<string>();
  for (const lang of languages) {
    for (const [ext, language] of Object.entries(EXTENSION_TO_LANGUAGE)) {
      if (language === lang) {
        validExtensions.add(ext);
      }
    }
  }

  const allFiles: string[] = [];

  for (const pattern of includePatterns) {
    const result = await glob(pattern, {
      cwd: rootPath,
      ignore: excludePatterns,
      filesOnly: true,
    });

    if (result.success) {
      for (const match of result.matches) {
        const ext = path.extname(match.path).toLowerCase();
        if (validExtensions.has(ext)) {
          allFiles.push(match.path);
        }
      }
    }
  }

  // Dedupe and sort
  return [...new Set(allFiles)].sort();
}

/**
 * Resolve import references to actual file paths.
 */
function resolveReferences(
  refs: string[],
  fromPath: string,
  allFiles: string[],
  rootPath: string
): string[] {
  const resolved: string[] = [];
  const fromDir = path.dirname(fromPath);

  for (const ref of refs) {
    // Try to resolve the reference to an actual file
    const candidates = [
      path.join(fromDir, ref),
      path.join(fromDir, ref.replace(/\.[jt]sx?$/, '.ts')),
      path.join(fromDir, ref.replace(/\.[jt]sx?$/, '.tsx')),
      path.join(fromDir, ref.replace(/\.[jt]sx?$/, '.js')),
      path.join(fromDir, ref + '.ts'),
      path.join(fromDir, ref + '.tsx'),
      path.join(fromDir, ref + '.js'),
      path.join(fromDir, ref, 'index.ts'),
      path.join(fromDir, ref, 'index.tsx'),
      path.join(fromDir, ref, 'index.js'),
    ];

    for (const candidate of candidates) {
      const normalized = path.normalize(candidate);
      const absolute = path.join(rootPath, normalized);

      if (allFiles.includes(absolute)) {
        const relative = path.relative(rootPath, absolute);
        if (!resolved.includes(relative)) {
          resolved.push(relative);
        }
        break;
      }
    }
  }

  return resolved;
}

/**
 * Trim file maps to fit within token budget.
 */
function trimToBudget(fileMaps: FileMap[], tokenBudget: number): FileMap[] {
  const result: FileMap[] = [];
  let currentTokens = 0;

  for (const fileMap of fileMaps) {
    if (currentTokens + fileMap.tokens <= tokenBudget) {
      result.push(fileMap);
      currentTokens += fileMap.tokens;
    } else if (result.length === 0) {
      // Always include at least one file, even if over budget
      result.push(fileMap);
      break;
    }
  }

  return result;
}

/**
 * Format a file map entry for display.
 */
function formatFileMapEntry(fileMap: Omit<FileMap, 'tokens'> & { tokens?: number }): string {
  const lines: string[] = [];

  lines.push(`${fileMap.path}:`);

  for (const symbol of fileMap.symbols) {
    const prefix = symbol.exported ? '│ ' : '│ (private) ';
    lines.push(`${prefix}${symbol.signature}`);
  }

  if (fileMap.references.length > 0) {
    lines.push(`│`);
    lines.push(`│ references: ${fileMap.references.join(', ')}`);
  }

  return lines.join('\n');
}

/**
 * Format the complete repo map for display.
 */
export function formatRepoMap(repoMap: RepoMap): string {
  if (repoMap.files.length === 0) {
    return '(no files in repo map)';
  }

  const sections: string[] = [];

  for (const fileMap of repoMap.files) {
    sections.push(formatFileMapEntry(fileMap));
  }

  sections.push('');
  sections.push(`--- ${repoMap.files.length} files, ${repoMap.totalTokens} tokens ---`);

  return sections.join('\n\n');
}

/**
 * Get a summary of the repo map.
 */
export function getRepoMapSummary(repoMap: RepoMap): {
  fileCount: number;
  symbolCount: number;
  totalTokens: number;
  topFiles: string[];
} {
  let symbolCount = 0;
  for (const file of repoMap.files) {
    symbolCount += file.symbols.length;
  }

  return {
    fileCount: repoMap.files.length,
    symbolCount,
    totalTokens: repoMap.totalTokens,
    topFiles: repoMap.files.slice(0, 5).map((f) => f.path),
  };
}

/**
 * Incrementally update a repo map when files change.
 */
export async function updateRepoMap(
  existingMap: RepoMap,
  changedFiles: string[],
  config: RepoMapConfig
): Promise<RepoMap> {
  // For now, just rebuild the whole map
  // TODO: Implement incremental updates for better performance
  return buildRepoMap(config);
}
