/**
 * Analyzer Module for Autonomous Self-Improvement
 *
 * Gathers context from error logs, performance metrics, test results,
 * and codebase statistics to feed into the improvement cycle.
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as yaml from 'yaml';
import type {
  AnalysisContext,
  BacklogItem,
  BacklogStatus,
  CodebaseStats,
  ErrorLogEntry,
  PerformanceMetric,
  Reflection,
} from './types.js';
import {
  parseVitestJson,
  failuresToErrorLogEntries,
  parseCoverageSummary,
} from './test-parser.js';

const execAsync = promisify(exec);

// ============================================================================
// ANALYZER
// ============================================================================

export class Analyzer {
  private readonly projectRoot: string;
  private readonly logsDir: string;
  private readonly reflectionsDir: string;
  private readonly backlogPath: string;

  constructor(projectRoot: string, options?: { logsDir?: string; reflectionsDir?: string; backlogPath?: string }) {
    this.projectRoot = projectRoot;
    this.logsDir = options?.logsDir || path.join(projectRoot, 'logs');
    this.reflectionsDir =
      options?.reflectionsDir ||
      path.join(process.env['HOME'] || '~', '.casterly', 'autonomous', 'reflections');
    this.backlogPath = options?.backlogPath
      ? (path.isAbsolute(options.backlogPath) ? options.backlogPath : path.join(projectRoot, options.backlogPath))
      : path.join(projectRoot, 'config', 'backlog.yaml');
  }

  /**
   * Gather all context needed for analysis phase.
   */
  async gatherContext(): Promise<AnalysisContext> {
    const [errorLogs, performanceMetrics, recentReflections, codebaseStats, backlogItems] = await Promise.all([
      this.parseErrorLogs(),
      this.gatherPerformanceMetrics(),
      this.loadRecentReflections(),
      this.gatherCodebaseStats(),
      this.loadBacklog(),
    ]);

    return {
      errorLogs,
      performanceMetrics,
      recentReflections,
      codebaseStats,
      backlogItems,
    };
  }

  // --------------------------------------------------------------------------
  // ERROR LOG PARSING
  // --------------------------------------------------------------------------

  /**
   * Parse error logs from various sources.
   */
  async parseErrorLogs(): Promise<ErrorLogEntry[]> {
    const entries: ErrorLogEntry[] = [];

    // Try to read daemon logs
    try {
      const daemonLogs = await this.parseDaemonLogs();
      entries.push(...daemonLogs);
    } catch {
      // Logs may not exist yet
    }

    // Try to read test failure logs
    try {
      const testLogs = await this.parseTestLogs();
      entries.push(...testLogs);
    } catch {
      // Test logs may not exist
    }

    // Aggregate by error code
    const aggregated = this.aggregateErrors(entries);

    // Sort by frequency (most common first)
    return aggregated.sort((a, b) => b.frequency - a.frequency);
  }

  private async parseDaemonLogs(): Promise<ErrorLogEntry[]> {
    const entries: ErrorLogEntry[] = [];

    // Use local date (not UTC) to match how the daemon writes logs
    const now = new Date();
    const localYear = now.getFullYear();
    const localMonth = String(now.getMonth() + 1).padStart(2, '0');
    const localDay = String(now.getDate()).padStart(2, '0');
    const today = `${localYear}${localMonth}${localDay}`;

    // Also check yesterday's log (in case of timezone edge cases)
    const yesterday = new Date(now.getTime() - 86_400_000);
    const yYear = yesterday.getFullYear();
    const yMonth = String(yesterday.getMonth() + 1).padStart(2, '0');
    const yDay = String(yesterday.getDate()).padStart(2, '0');
    const yesterdayStr = `${yYear}${yMonth}${yDay}`;

    const logFiles = [
      path.join(this.logsDir, `daemon-${today}.log`),
      path.join(this.logsDir, `daemon-${yesterdayStr}.log`),
    ];

    // Pattern: [ERROR] E1001: Provider timeout
    const errorPattern = /\[ERROR\]\s*([A-Z]\d+):\s*(.+)/;

    for (const logFile of logFiles) {
      try {
        const content = await fs.readFile(logFile, 'utf-8');
        const lines = content.split('\n');

        for (const line of lines) {
          const match = line.match(errorPattern);
          if (match && match[1] && match[2]) {
            entries.push({
              timestamp: new Date().toISOString(),
              code: match[1],
              message: match[2],
              frequency: 1,
              lastOccurrence: new Date().toISOString(),
            });
          }
        }
      } catch {
        // File doesn't exist, that's fine
      }
    }

    return entries;
  }

  private async parseTestLogs(): Promise<ErrorLogEntry[]> {
    try {
      // Check for package.json first — avoids hanging in non-project dirs
      await fs.access(path.join(this.projectRoot, 'package.json'));

      // Run tests with JSON reporter for structured output
      const { stdout } = await execAsync(
        'npx vitest run --reporter=json 2>/dev/null || true',
        { cwd: this.projectRoot, timeout: 120000 }
      );

      const parsed = parseVitestJson(stdout);

      if (parsed.failures.length > 0) {
        return failuresToErrorLogEntries(parsed.failures);
      }
    } catch {
      // Test run failed or not a valid project directory
    }

    return [];
  }

  private aggregateErrors(entries: ErrorLogEntry[]): ErrorLogEntry[] {
    const map = new Map<string, ErrorLogEntry>();

    for (const entry of entries) {
      const key = `${entry.code}:${entry.message}`;
      const existing = map.get(key);

      if (existing) {
        existing.frequency += entry.frequency;
        if (entry.timestamp > existing.lastOccurrence) {
          existing.lastOccurrence = entry.timestamp;
        }
      } else {
        map.set(key, { ...entry });
      }
    }

    return Array.from(map.values());
  }

  // --------------------------------------------------------------------------
  // PERFORMANCE METRICS
  // --------------------------------------------------------------------------

  /**
   * Gather performance metrics from logs or monitoring.
   */
  async gatherPerformanceMetrics(): Promise<PerformanceMetric[]> {
    const metrics: PerformanceMetric[] = [];

    // For now, we'll create placeholder metrics
    // In production, this would read from actual monitoring
    try {
      const metricsFile = path.join(this.logsDir, 'metrics.json');
      const content = await fs.readFile(metricsFile, 'utf-8');
      const data = JSON.parse(content) as PerformanceMetric[];
      metrics.push(...data);
    } catch {
      // No metrics file, return defaults
      metrics.push({
        name: 'response_time',
        p50: 0,
        p95: 0,
        p99: 0,
        samples: 0,
        trend: 'stable',
      });
    }

    return metrics;
  }

  // --------------------------------------------------------------------------
  // REFLECTIONS
  // --------------------------------------------------------------------------

  /**
   * Load recent reflections for context.
   */
  async loadRecentReflections(limit: number = 10): Promise<Reflection[]> {
    const reflections: Reflection[] = [];

    try {
      await fs.mkdir(this.reflectionsDir, { recursive: true });
      const files = await fs.readdir(this.reflectionsDir);

      // Sort by name (timestamp-based) descending
      const sortedFiles = files
        .filter((f) => f.endsWith('.json'))
        .sort()
        .reverse()
        .slice(0, limit);

      for (const file of sortedFiles) {
        try {
          const content = await fs.readFile(path.join(this.reflectionsDir, file), 'utf-8');
          const reflection = JSON.parse(content) as Reflection;
          reflections.push(reflection);
        } catch {
          // Skip invalid files
        }
      }
    } catch {
      // Directory doesn't exist yet
    }

    return reflections;
  }

  // --------------------------------------------------------------------------
  // CODEBASE STATS
  // --------------------------------------------------------------------------

  /**
   * Gather statistics about the codebase.
   */
  async gatherCodebaseStats(): Promise<CodebaseStats> {
    const stats: CodebaseStats = {
      totalFiles: 0,
      totalLines: 0,
      testCoverage: undefined,
      lintErrors: 0,
      typeErrors: 0,
      lastCommit: '',
    };

    // Count files and lines
    try {
      const { stdout: filesOutput } = await execAsync(
        'find src -name "*.ts" -type f | wc -l',
        { cwd: this.projectRoot }
      );
      stats.totalFiles = parseInt(filesOutput.trim(), 10) || 0;

      const { stdout: linesOutput } = await execAsync(
        'find src -name "*.ts" -type f -exec wc -l {} + | tail -1 | awk \'{print $1}\'',
        { cwd: this.projectRoot }
      );
      stats.totalLines = parseInt(linesOutput.trim(), 10) || 0;
    } catch {
      // Commands failed
    }

    // Get lint errors count
    try {
      const { stdout: lintOutput } = await execAsync('npm run lint 2>&1 || true', {
        cwd: this.projectRoot,
        timeout: 30000,
      });
      const lintMatch = lintOutput.match(/(\d+) error/);
      stats.lintErrors = lintMatch && lintMatch[1] ? parseInt(lintMatch[1], 10) : 0;
    } catch {
      // Lint failed
    }

    // Get type errors count
    try {
      const { stdout: typeOutput } = await execAsync('npm run typecheck 2>&1 || true', {
        cwd: this.projectRoot,
        timeout: 30000,
      });
      const typeMatch = typeOutput.match(/Found (\d+) error/);
      stats.typeErrors = typeMatch && typeMatch[1] ? parseInt(typeMatch[1], 10) : 0;
    } catch {
      // Typecheck failed
    }

    // Get last commit
    try {
      const { stdout: commitOutput } = await execAsync('git log -1 --format="%H"', {
        cwd: this.projectRoot,
      });
      stats.lastCommit = commitOutput.trim();
    } catch {
      // Git command failed
    }

    // Read coverage data if available
    try {
      const coveragePath = path.join(this.projectRoot, 'coverage', 'coverage-summary.json');
      const coverageJson = await fs.readFile(coveragePath, 'utf-8');
      const coverage = parseCoverageSummary(coverageJson);
      if (coverage.totalStatements > 0) {
        stats.testCoverage = coverage.percentage;
      }
    } catch {
      // No coverage data available
    }

    return stats;
  }

  // --------------------------------------------------------------------------
  // BACKLOG
  // --------------------------------------------------------------------------

  /**
   * Load pending backlog items, sorted by priority (1 = highest).
   */
  async loadBacklog(): Promise<BacklogItem[]> {
    try {
      const content = await fs.readFile(this.backlogPath, 'utf-8');
      const parsed = yaml.parse(content) as { backlog?: BacklogItem[] } | null;
      const items = parsed?.backlog ?? [];

      return items
        .filter((item) => item.status === 'pending')
        .sort((a, b) => a.priority - b.priority);
    } catch {
      // File doesn't exist or is invalid — that's fine
      return [];
    }
  }

  /**
   * Update the status of a backlog item in the YAML file.
   */
  async updateBacklogStatus(
    itemId: string,
    status: BacklogStatus,
    metadata?: { branch?: string; reason?: string },
  ): Promise<void> {
    try {
      const content = await fs.readFile(this.backlogPath, 'utf-8');
      const parsed = yaml.parse(content) as { backlog?: BacklogItem[] } | null;
      const items = parsed?.backlog ?? [];

      const item = items.find((i) => i.id === itemId);
      if (!item) return;

      item.status = status;
      if (status === 'completed') {
        item.completedAt = new Date().toISOString();
        item.completedBranch = metadata?.branch;
      }
      if (status === 'failed') {
        item.failureReason = metadata?.reason;
      }

      const output = yaml.stringify({ backlog: items });
      await fs.writeFile(this.backlogPath, output, 'utf-8');
    } catch {
      // Best-effort update — file may not exist
    }
  }

  // --------------------------------------------------------------------------
  // FILE LISTING
  // --------------------------------------------------------------------------

  /**
   * List files in the codebase for context.
   */
  async listFiles(patterns: string[] = ['src/**/*.ts']): Promise<string[]> {
    const files: string[] = [];

    for (const pattern of patterns) {
      try {
        const { stdout } = await execAsync(`find ${pattern.replace('**/', '')} -name "*.ts" -type f`, {
          cwd: this.projectRoot,
        });
        const found = stdout.trim().split('\n').filter(Boolean);
        files.push(...found);
      } catch {
        // Pattern didn't match
      }
    }

    return [...new Set(files)].sort();
  }

  /**
   * Read file contents.
   */
  async readFile(filePath: string): Promise<string | null> {
    try {
      const fullPath = path.isAbsolute(filePath) ? filePath : path.join(this.projectRoot, filePath);
      return await fs.readFile(fullPath, 'utf-8');
    } catch {
      return null;
    }
  }

  /**
   * Read multiple files into a Map.
   */
  async readFiles(filePaths: string[]): Promise<Map<string, string>> {
    const contents = new Map<string, string>();

    await Promise.all(
      filePaths.map(async (filePath) => {
        const content = await this.readFile(filePath);
        if (content !== null) {
          contents.set(filePath, content);
        }
      })
    );

    return contents;
  }
}
