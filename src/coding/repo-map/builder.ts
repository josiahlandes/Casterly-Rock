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
import { extractPython } from './extractors/python.js';
import { extractGo } from './extractors/go.js';
import { extractRust } from './extractors/rust.js';
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
      } else if (language === 'python') {
        extraction = extractPython(content);
      } else if (language === 'go') {
        extraction = extractGo(content);
      } else if (language === 'rust') {
        extraction = extractRust(content);
      }

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
 *
 * Re-parses only the changed files and merges them back into the map.
 * Falls back to a full rebuild if changed files exceed 30% of the map.
 */
export async function updateRepoMap(
  existingMap: RepoMap,
  changedFiles: string[],
  config: RepoMapConfig
): Promise<RepoMap> {
  // Fall back to full rebuild when too many files changed
  if (changedFiles.length > existingMap.files.length * 0.3) {
    return buildRepoMap(config);
  }

  const fullConfig = { ...DEFAULT_CONFIG, ...config };
  const absoluteRoot = path.isAbsolute(fullConfig.rootPath)
    ? fullConfig.rootPath
    : path.resolve(fullConfig.rootPath);

  // Normalize changed file paths to relative
  const changedRelative = new Set(
    changedFiles.map((f) =>
      path.isAbsolute(f) ? path.relative(absoluteRoot, f) : f
    )
  );

  // Keep unchanged files
  const kept = existingMap.files.filter((f) => !changedRelative.has(f.path));

  // Re-parse changed files
  const referenceGraph = new Map<string, Set<string>>();
  for (const fm of kept) {
    referenceGraph.set(fm.path, new Set(fm.references));
  }

  // Find all source files (needed for reference resolution)
  const allSourceFiles = await findSourceFiles(
    absoluteRoot,
    fullConfig.includePatterns,
    fullConfig.excludePatterns,
    fullConfig.languages
  );

  for (const relativePath of changedRelative) {
    const filePath = path.join(absoluteRoot, relativePath);
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const ext = path.extname(filePath).toLowerCase();
      const language = EXTENSION_TO_LANGUAGE[ext];

      let extraction = { symbols: [] as FileMap['symbols'], references: [] as string[] };

      if (language === 'typescript' || language === 'javascript') {
        extraction = extractTypeScript(content);
      } else if (language === 'python') {
        extraction = extractPython(content);
      } else if (language === 'go') {
        extraction = extractGo(content);
      } else if (language === 'rust') {
        extraction = extractRust(content);
      }

      let symbols = extraction.symbols;
      if (!fullConfig.includePrivate) {
        symbols = symbols.filter((s) => s.exported);
      }

      const resolvedRefs = resolveReferences(extraction.references, relativePath, allSourceFiles, absoluteRoot);
      const mapEntry = formatFileMapEntry({ path: relativePath, symbols, references: resolvedRefs, importance: 0, tokens: 0 });
      const tokens = tokenCounter.count(mapEntry);

      kept.push({
        path: relativePath,
        symbols,
        references: resolvedRefs,
        importance: 0,
        tokens,
      });

      referenceGraph.set(relativePath, new Set(resolvedRefs));
    } catch {
      // File was deleted or unreadable — skip it
    }
  }

  // Recompute importance with updated graph
  const importanceScores = computeImportance(referenceGraph);
  for (const fm of kept) {
    fm.importance = importanceScores.get(fm.path) ?? 0;
  }

  kept.sort((a, b) => b.importance - a.importance);
  const trimmed = trimToBudget(kept, fullConfig.tokenBudget);
  const totalTokens = trimmed.reduce((sum, f) => sum + f.tokens, 0);

  return {
    files: trimmed,
    totalTokens,
    generatedAt: new Date().toISOString(),
    rootPath: absoluteRoot,
  };
}
