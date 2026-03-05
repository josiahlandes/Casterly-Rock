/**
 * Explorer — Dream-Cycle Curiosity & Territory Mapping
 *
 * During dream/idle cycles, the Explorer picks one unexplored or stale
 * directory from the cognitive map and explores it. Over time, Tyrion
 * gradually learns his entire machine — like settling into a new apartment.
 *
 * The Explorer:
 *   - Picks the next target from the cognitive map
 *   - Scans the directory: lists contents, notes file types and sizes
 *   - Classifies what it found: useful/not useful/needs deeper look
 *   - Updates the cognitive map with what was discovered
 *   - Optionally logs interesting findings to the journal
 *
 * This runs as part of the dream cycle, not during active interaction.
 * One directory per dream pass — slow, steady exploration.
 */

import { readdir, stat } from 'node:fs/promises';
import { join, extname } from 'node:path';
import type { CognitiveMap, DirectoryEntry } from './cognitive-map.js';
import { getTracer } from '../autonomous/debug.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What the Explorer found during a scan.
 */
export interface ExplorationResult {
  /** The directory that was explored */
  path: string;
  /** Whether the exploration succeeded */
  success: boolean;
  /** New familiarity level after exploration */
  familiarity: DirectoryEntry['familiarity'];
  /** What was found */
  findings: ExplorationFindings;
  /** Suggested role annotation for this directory */
  suggestedRole?: string;
  /** Interesting sub-directories that should be added to the map */
  discoveredDirectories: Array<{ path: string; role: string }>;
}

export interface ExplorationFindings {
  /** Total entries in the directory */
  totalEntries: number;
  /** Breakdown by type */
  filesByExtension: Record<string, number>;
  /** Sub-directories found */
  subdirectories: string[];
  /** Notably large files (>1MB) */
  largeFiles: Array<{ name: string; sizeBytes: number }>;
  /** Recently modified files (within 7 days) */
  recentlyModified: string[];
  /** Whether directory contains a package.json (project marker) */
  isProject: boolean;
  /** Whether directory contains a .git (repo marker) */
  isGitRepo: boolean;
}

export interface ExplorerConfig {
  /** Maximum entries to scan per directory (safety limit) */
  maxEntriesPerScan: number;
  /** Threshold for "large file" in bytes */
  largeFileThresholdBytes: number;
  /** How many days back for "recently modified" */
  recentDays: number;
  /** Extensions to track (group others as "other") */
  trackedExtensions: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Defaults
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: ExplorerConfig = {
  maxEntriesPerScan: 500,
  largeFileThresholdBytes: 1_000_000, // 1MB
  recentDays: 7,
  trackedExtensions: [
    '.ts', '.js', '.json', '.yaml', '.yml', '.md', '.txt',
    '.py', '.sh', '.css', '.html', '.swift', '.rs', '.go',
    '.toml', '.env', '.cfg', '.ini', '.xml', '.csv',
  ],
};

// ─────────────────────────────────────────────────────────────────────────────
// Explorer
// ─────────────────────────────────────────────────────────────────────────────

export class Explorer {
  private readonly config: ExplorerConfig;

  constructor(config?: Partial<ExplorerConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Run one exploration pass — pick the next target and scan it.
   * Returns null if there's nothing to explore.
   */
  async explore(cognitiveMap: CognitiveMap): Promise<ExplorationResult | null> {
    const tracer = getTracer();

    return tracer.withSpan('metacognition', 'explore', async (span) => {
      const target = cognitiveMap.getNextExplorationTarget();
      if (!target) {
        tracer.log('metacognition', 'debug', 'No exploration targets available');
        return null;
      }

      tracer.log('metacognition', 'info', `Exploring: ${target.path}`);
      span.metadata['target'] = target.path;

      const result = await this.scanDirectory(target.path);

      if (result.success) {
        // Update cognitive map
        await cognitiveMap.exploreDirectory(target.path);

        // Set role if we inferred one
        if (result.suggestedRole) {
          cognitiveMap.setDirectoryRole(target.path, result.suggestedRole);
        }

        // Add discovered sub-directories to the map
        for (const discovered of result.discoveredDirectories) {
          const existing = cognitiveMap.getDirectories().find(
            (d) => d.path === discovered.path,
          );
          if (!existing) {
            await cognitiveMap.exploreDirectory(discovered.path);
            cognitiveMap.setDirectoryRole(discovered.path, discovered.role);
          }
        }

        span.metadata['totalEntries'] = result.findings.totalEntries;
        span.metadata['subdirectories'] = result.findings.subdirectories.length;
        span.metadata['isProject'] = result.findings.isProject;
      }

      tracer.log('metacognition', 'info', `Exploration complete: ${target.path}`, {
        success: result.success,
        entries: result.findings.totalEntries,
        subdirs: result.findings.subdirectories.length,
        isProject: result.findings.isProject,
      });

      return result;
    });
  }

  /**
   * Scan a single directory and return findings.
   */
  async scanDirectory(dirPath: string): Promise<ExplorationResult> {
    const tracer = getTracer();
    const findings: ExplorationFindings = {
      totalEntries: 0,
      filesByExtension: {},
      subdirectories: [],
      largeFiles: [],
      recentlyModified: [],
      isProject: false,
      isGitRepo: false,
    };
    const discoveredDirectories: ExplorationResult['discoveredDirectories'] = [];

    try {
      const entries = await readdir(dirPath);
      findings.totalEntries = entries.length;

      // Safety limit
      const toScan = entries.slice(0, this.config.maxEntriesPerScan);
      const now = Date.now();
      const recentThreshold = now - this.config.recentDays * 24 * 60 * 60 * 1000;

      for (const entry of toScan) {
        // Skip hidden files in the top-level scan (except markers)
        if (entry.startsWith('.') && entry !== '.git' && entry !== '.env') {
          continue;
        }

        const fullPath = join(dirPath, entry);

        try {
          const stats = await stat(fullPath);

          if (stats.isDirectory()) {
            findings.subdirectories.push(entry);

            // Check for project markers
            if (entry === '.git') {
              findings.isGitRepo = true;
            }

            // Discover notable sub-directories
            if (!entry.startsWith('.') && entry !== 'node_modules' && entry !== 'dist') {
              discoveredDirectories.push({
                path: fullPath,
                role: `subdirectory of ${dirPath}`,
              });
            }
          } else if (stats.isFile()) {
            // Track extension
            const ext = extname(entry).toLowerCase() || '(no ext)';
            if (this.config.trackedExtensions.includes(ext)) {
              findings.filesByExtension[ext] = (findings.filesByExtension[ext] ?? 0) + 1;
            } else {
              findings.filesByExtension['(other)'] = (findings.filesByExtension['(other)'] ?? 0) + 1;
            }

            // Check for project markers
            if (entry === 'package.json' || entry === 'Cargo.toml' || entry === 'go.mod' || entry === 'pyproject.toml') {
              findings.isProject = true;
            }

            // Large files
            if (stats.size > this.config.largeFileThresholdBytes) {
              findings.largeFiles.push({ name: entry, sizeBytes: stats.size });
            }

            // Recently modified
            if (stats.mtime.getTime() > recentThreshold) {
              findings.recentlyModified.push(entry);
            }
          }
        } catch {
          // Permission denied or broken symlink — skip
        }
      }

      // Infer role from findings
      const suggestedRole = this.inferRole(dirPath, findings);

      return {
        path: dirPath,
        success: true,
        familiarity: 'visited',
        findings,
        suggestedRole,
        discoveredDirectories: discoveredDirectories.slice(0, 10), // Cap discovered dirs
      };
    } catch (err) {
      tracer.log('metacognition', 'debug', `Cannot scan ${dirPath}: ${err instanceof Error ? err.message : String(err)}`);

      return {
        path: dirPath,
        success: false,
        familiarity: 'unexplored',
        findings,
        discoveredDirectories: [],
      };
    }
  }

  // ── Private Helpers ──────────────────────────────────────────────────────

  private inferRole(dirPath: string, findings: ExplorationFindings): string | undefined {
    const name = dirPath.split('/').pop() ?? '';

    // Project detection
    if (findings.isProject && findings.isGitRepo) {
      const dominant = this.dominantExtension(findings.filesByExtension);
      if (dominant) {
        return `${dominant} project (git repo)`;
      }
      return 'software project (git repo)';
    }
    if (findings.isProject) {
      return 'software project';
    }

    // Common directory names
    const roleMap: Record<string, string> = {
      'Documents': 'user documents',
      'Downloads': 'user downloads',
      'Desktop': 'user desktop',
      'Pictures': 'user photos and images',
      'Music': 'user music',
      'Movies': 'user videos',
      'Library': 'macOS system library',
      '.config': 'user tool configurations',
      '.ssh': 'SSH keys and config',
      '.local': 'user local data',
    };

    if (roleMap[name]) {
      return roleMap[name];
    }

    // Infer from contents
    if (findings.subdirectories.length > 5 && findings.totalEntries < 30) {
      return 'directory of projects or subdirectories';
    }

    const mdCount = findings.filesByExtension['.md'] ?? 0;
    const txtCount = findings.filesByExtension['.txt'] ?? 0;
    if (mdCount + txtCount > findings.totalEntries * 0.5) {
      return 'documentation or notes';
    }

    return undefined;
  }

  private dominantExtension(byExt: Record<string, number>): string | undefined {
    let maxExt = '';
    let maxCount = 0;

    for (const [ext, count] of Object.entries(byExt)) {
      if (ext === '(other)' || ext === '(no ext)') continue;
      if (count > maxCount) {
        maxExt = ext;
        maxCount = count;
      }
    }

    const langMap: Record<string, string> = {
      '.ts': 'TypeScript',
      '.js': 'JavaScript',
      '.py': 'Python',
      '.rs': 'Rust',
      '.go': 'Go',
      '.swift': 'Swift',
      '.java': 'Java',
    };

    return langMap[maxExt];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────────────────────

export function createExplorer(config?: Partial<ExplorerConfig>): Explorer {
  return new Explorer(config);
}
