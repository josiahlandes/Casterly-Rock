/**
 * Code Archaeology — Git history analysis for dream cycles
 *
 * During the exploration phase of dream cycles, Tyrion analyzes the git
 * history to find:
 *   - Fragile code: files that are frequently changed or fixed.
 *   - Abandoned code: files not touched in N months.
 *   - Project narrative: a summary of recent evolution.
 *
 * Results feed into the world model and goal stack:
 *   - Fragile files → flagged for investigation.
 *   - Abandoned files → flagged for cleanup or removal.
 *   - Narrative → enriches Tyrion's understanding of the project arc.
 *
 * All analysis uses `git log` and `git diff` — no external APIs.
 *
 * Privacy: Only codebase metadata (file paths, commit messages,
 * change counts). No sensitive content is extracted.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getTracer } from '../debug.js';

const execFileAsync = promisify(execFile);

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * History analysis for a single file.
 */
export interface FileHistory {
  /** File path */
  path: string;

  /** Total number of commits touching this file */
  commitCount: number;

  /** Number of distinct authors */
  authorCount: number;

  /** First commit date */
  firstCommit: string;

  /** Most recent commit date */
  lastCommit: string;

  /** Number of commits in the last 30 days */
  recentCommits: number;

  /** Summary of recent commit messages */
  recentMessages: string[];
}

/**
 * A file identified as fragile (frequently changed/fixed).
 */
export interface FragileFile {
  /** File path */
  path: string;

  /** Number of changes in the analysis window */
  changeCount: number;

  /** Number of fix-related commits */
  fixCount: number;

  /** Fragility score (higher = more fragile) */
  fragilityScore: number;

  /** Recent commit messages for context */
  recentMessages: string[];
}

/**
 * Configuration for the code archaeologist.
 */
export interface ArchaeologyConfig {
  /** Project root directory */
  projectRoot: string;

  /** How many days back to look for fragile code analysis */
  fragileLookbackDays: number;

  /** Minimum commits to consider a file fragile */
  fragileThreshold: number;

  /** How many months of inactivity marks a file as abandoned */
  abandonedMonths: number;

  /** Maximum files to return from analysis */
  maxResults: number;

  /** Timeout for git commands in milliseconds */
  gitTimeoutMs: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: ArchaeologyConfig = {
  projectRoot: process.cwd(),
  fragileLookbackDays: 90,
  fragileThreshold: 5,
  abandonedMonths: 6,
  maxResults: 20,
  gitTimeoutMs: 30_000,
};

const FIX_PATTERNS = [
  /\bfix\b/i,
  /\bbug\b/i,
  /\bpatch\b/i,
  /\bhotfix\b/i,
  /\brevert\b/i,
  /\brepair\b/i,
];

// ─────────────────────────────────────────────────────────────────────────────
// Code Archaeologist
// ─────────────────────────────────────────────────────────────────────────────

export class CodeArchaeologist {
  private readonly config: ArchaeologyConfig;

  constructor(config?: Partial<ArchaeologyConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // ── File History ────────────────────────────────────────────────────────

  /**
   * Analyze git history for a specific file.
   */
  async analyzeFileHistory(filePath: string): Promise<FileHistory> {
    const tracer = getTracer();

    return tracer.withSpan('dream', `archaeology:${filePath}`, async () => {
      // Get commit log for this file
      const logOutput = await this.git(
        'log', '--format=%H|%aI|%aN|%s', '--follow', '--', filePath,
      );

      const commits = logOutput
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const [hash, date, author, message] = line.split('|');
          return { hash: hash!, date: date!, author: author!, message: message ?? '' };
        });

      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

      const recentCommits = commits.filter(
        (c) => new Date(c.date) > thirtyDaysAgo,
      );

      const authors = new Set(commits.map((c) => c.author));

      return {
        path: filePath,
        commitCount: commits.length,
        authorCount: authors.size,
        firstCommit: commits.length > 0 ? commits[commits.length - 1]!.date : '',
        lastCommit: commits.length > 0 ? commits[0]!.date : '',
        recentCommits: recentCommits.length,
        recentMessages: recentCommits.slice(0, 10).map((c) => c.message),
      };
    });
  }

  // ── Fragile Code ────────────────────────────────────────────────────────

  /**
   * Find files that are frequently changed or fixed (fragile code).
   * These are candidates for refactoring or deeper investigation.
   */
  async findFragileCode(): Promise<FragileFile[]> {
    const tracer = getTracer();

    return tracer.withSpan('dream', 'findFragileCode', async () => {
      const sinceDate = new Date();
      sinceDate.setDate(sinceDate.getDate() - this.config.fragileLookbackDays);
      const since = sinceDate.toISOString().split('T')[0]!;

      // Get files changed with commit messages
      const logOutput = await this.git(
        'log', `--since=${since}`, '--format=%s', '--name-only',
      );

      // Parse output: alternating commit messages and file lists
      const fileChanges = new Map<string, { total: number; fixes: number; messages: string[] }>();
      let currentMessage = '';

      for (const line of logOutput.split('\n')) {
        if (!line.trim()) continue;

        // Lines without path separators are likely commit messages
        if (!line.includes('/') && !line.includes('.')) {
          currentMessage = line;
          continue;
        }

        // This is a file path
        const existing = fileChanges.get(line) ?? { total: 0, fixes: 0, messages: [] };
        existing.total++;
        if (FIX_PATTERNS.some((p) => p.test(currentMessage))) {
          existing.fixes++;
        }
        if (existing.messages.length < 5) {
          existing.messages.push(currentMessage);
        }
        fileChanges.set(line, existing);
      }

      // Score and filter
      const fragile: FragileFile[] = [];

      for (const [path, data] of fileChanges) {
        if (data.total < this.config.fragileThreshold) continue;

        // Skip non-source files
        if (path.includes('node_modules') || path.includes('dist/')) continue;

        const fragilityScore = data.total + data.fixes * 2;
        fragile.push({
          path,
          changeCount: data.total,
          fixCount: data.fixes,
          fragilityScore,
          recentMessages: data.messages,
        });
      }

      // Sort by fragility score descending
      fragile.sort((a, b) => b.fragilityScore - a.fragilityScore);

      tracer.log('dream', 'info', `Found ${fragile.length} fragile files`, {
        lookbackDays: this.config.fragileLookbackDays,
      });

      return fragile.slice(0, this.config.maxResults);
    });
  }

  // ── Abandoned Code ──────────────────────────────────────────────────────

  /**
   * Find files not touched in N months. Candidates for cleanup or removal.
   */
  async findAbandonedCode(): Promise<string[]> {
    const tracer = getTracer();

    return tracer.withSpan('dream', 'findAbandonedCode', async () => {
      const cutoff = new Date();
      cutoff.setMonth(cutoff.getMonth() - this.config.abandonedMonths);
      const cutoffStr = cutoff.toISOString().split('T')[0]!;

      // Get all tracked source files
      const allFiles = await this.git('ls-files', '--', 'src/');
      const sourceFiles = allFiles.split('\n').filter(Boolean);

      const abandoned: string[] = [];

      // Check each file's last commit date
      // Batch in groups to avoid excessive git calls
      for (const file of sourceFiles.slice(0, 200)) {
        try {
          const lastDate = await this.git(
            'log', '-1', '--format=%aI', '--', file,
          );

          if (lastDate.trim() && lastDate.trim() < cutoffStr) {
            abandoned.push(file);
          }
        } catch {
          // File might not be tracked
        }

        if (abandoned.length >= this.config.maxResults) break;
      }

      tracer.log('dream', 'info', `Found ${abandoned.length} abandoned files`, {
        threshold: `${this.config.abandonedMonths} months`,
      });

      return abandoned;
    });
  }

  // ── Narrative ───────────────────────────────────────────────────────────

  /**
   * Build a narrative summary of recent project evolution.
   * Useful for enriching the world model.
   */
  async buildNarrative(days: number = 30): Promise<string> {
    const tracer = getTracer();

    return tracer.withSpan('dream', 'buildNarrative', async () => {
      const sinceDate = new Date();
      sinceDate.setDate(sinceDate.getDate() - days);
      const since = sinceDate.toISOString().split('T')[0]!;

      // Get recent commits
      const logOutput = await this.git(
        'log', `--since=${since}`, '--format=%aI|%aN|%s', '--no-merges',
      );

      const commits = logOutput
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const [date, author, message] = line.split('|');
          return { date: date!, author: author!, message: message ?? '' };
        });

      if (commits.length === 0) {
        return `No commits in the last ${days} days.`;
      }

      // Get stats
      const shortstatOutput = await this.git(
        'diff', '--shortstat', `HEAD~${Math.min(commits.length, 50)}`,
      );

      // Build narrative
      const lines: string[] = [
        `## Project Activity (last ${days} days)`,
        '',
        `**${commits.length}** commits by ${new Set(commits.map((c) => c.author)).size} author(s).`,
        '',
      ];

      if (shortstatOutput.trim()) {
        lines.push(`Changes: ${shortstatOutput.trim()}`);
        lines.push('');
      }

      // Categorize commits
      const fixes = commits.filter((c) => FIX_PATTERNS.some((p) => p.test(c.message)));
      const features = commits.filter((c) => /\bfeat|add|new|implement/i.test(c.message));
      const refactors = commits.filter((c) => /\brefactor|clean|simplif/i.test(c.message));

      if (features.length > 0) {
        lines.push(`**Features:** ${features.length} commits`);
        for (const f of features.slice(0, 5)) {
          lines.push(`- ${f.message}`);
        }
        lines.push('');
      }

      if (fixes.length > 0) {
        lines.push(`**Fixes:** ${fixes.length} commits`);
        for (const f of fixes.slice(0, 5)) {
          lines.push(`- ${f.message}`);
        }
        lines.push('');
      }

      if (refactors.length > 0) {
        lines.push(`**Refactoring:** ${refactors.length} commits`);
        for (const r of refactors.slice(0, 3)) {
          lines.push(`- ${r.message}`);
        }
        lines.push('');
      }

      tracer.log('dream', 'info', `Narrative built: ${commits.length} commits analyzed`);

      return lines.join('\n');
    });
  }

  // ── Git Helper ──────────────────────────────────────────────────────────

  /**
   * Execute a git command in the project root.
   */
  private async git(...args: string[]): Promise<string> {
    try {
      const { stdout } = await execFileAsync('git', args, {
        cwd: this.config.projectRoot,
        timeout: this.config.gitTimeoutMs,
        maxBuffer: 10 * 1024 * 1024, // 10MB
      });
      return stdout;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Return empty string for non-fatal git errors
      if (msg.includes('does not have any commits')) return '';
      throw err;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────────────────────

export function createCodeArchaeologist(
  config?: Partial<ArchaeologyConfig>,
): CodeArchaeologist {
  return new CodeArchaeologist(config);
}
