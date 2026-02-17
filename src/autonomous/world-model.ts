/**
 * World Model — Tyrion's persistent understanding of the codebase state
 *
 * The world model is a structured representation of everything Tyrion knows
 * about the health and state of the Casterly codebase. It's loaded at the
 * start of every interaction (autonomous cycle, coding session, iMessage
 * conversation) and updated at the end. This is the continuity thread that
 * makes Tyrion feel like the same entity across time.
 *
 * The world model answers: "What is the current state of my codebase?"
 *
 * Storage: YAML file at a configurable path (default ~/.casterly/world-model.yaml).
 * We use YAML instead of markdown for structured, programmatic access.
 * A human-readable markdown summary can be generated on demand.
 *
 * Update strategy:
 * - Health section: updated by running typecheck, tests, lint (expensive, batched).
 * - Activity section: updated from git log (cheap, frequent).
 * - Concerns section: updated by the agent loop when issues are found/resolved.
 *
 * Privacy: The world model contains only codebase metadata (file counts, test
 * results, commit messages). It never contains user-provided sensitive data.
 * All string values pass through the safe logger's redaction when output.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import YAML from 'yaml';
import { getTracer } from './debug.js';

const execFileAsync = promisify(execFile);

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Health snapshot — the output of running quality gates and inspecting
 * the codebase. This is the most expensive section to update because it
 * requires running typecheck, tests, and lint.
 */
export interface HealthSnapshot {
  /** ISO timestamp when this snapshot was taken */
  timestamp: string;

  /** TypeScript typecheck results */
  typecheck: {
    passed: boolean;
    errorCount: number;
    errors: string[];
  };

  /** Test suite results */
  tests: {
    passed: boolean;
    total: number;
    passing: number;
    failing: number;
    skipped: number;
    failingTests: string[];
  };

  /** Lint results */
  lint: {
    passed: boolean;
    errorCount: number;
    warningCount: number;
  };

  /** Overall health: all checks passing */
  healthy: boolean;
}

/**
 * A single active concern — something Tyrion has noticed and is tracking.
 * Concerns are different from issues (issue-log.ts): concerns are lightweight
 * observations that haven't been promoted to issues yet. They're more like
 * "things I've noticed" vs "things I'm actively working on."
 */
export interface Concern {
  /** Short description of the concern */
  description: string;

  /** When this concern was first noted */
  firstSeen: string;

  /** How many times this concern has been observed */
  occurrences: number;

  /** Severity assessment: informational, worth-watching, needs-action */
  severity: 'informational' | 'worth-watching' | 'needs-action';

  /** Related files, if known */
  relatedFiles: string[];
}

/**
 * A recent activity entry — a simplified record of what happened recently.
 */
export interface ActivityEntry {
  /** ISO timestamp */
  timestamp: string;

  /** What happened */
  description: string;

  /** Who or what caused it: 'user', 'tyrion', 'external' */
  source: 'user' | 'tyrion' | 'external';

  /** Git commit hash, if applicable */
  commitHash?: string;
}

/**
 * The complete world model — everything Tyrion knows about the codebase state.
 */
export interface WorldModelData {
  /** Schema version for forward compatibility */
  version: number;

  /** When this world model was last fully updated */
  lastFullUpdate: string;

  /** When this world model was last partially updated (activity only) */
  lastPartialUpdate: string;

  /** Codebase health snapshot */
  health: HealthSnapshot;

  /** Active concerns Tyrion is tracking */
  concerns: Concern[];

  /** Recent activity log (last N entries) */
  recentActivity: ActivityEntry[];

  /** Codebase statistics */
  stats: {
    totalFiles: number;
    totalLines: number;
    lastCommitHash: string;
    lastCommitMessage: string;
    branchName: string;
  };
}

/**
 * Configuration for the world model.
 */
export interface WorldModelConfig {
  /** Path to the world model YAML file */
  path: string;

  /** Root directory of the project (for running commands) */
  projectRoot: string;

  /** Maximum number of recent activity entries to keep */
  maxActivityEntries: number;

  /** Maximum number of concerns to track */
  maxConcerns: number;

  /** Timeout for shell commands (typecheck, tests, etc.) in ms */
  commandTimeoutMs: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Default Values
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: WorldModelConfig = {
  path: '~/.casterly/world-model.yaml',
  projectRoot: process.cwd(),
  maxActivityEntries: 50,
  maxConcerns: 30,
  commandTimeoutMs: 120_000,
};

function createEmptyWorldModel(): WorldModelData {
  const now = new Date().toISOString();
  return {
    version: 1,
    lastFullUpdate: now,
    lastPartialUpdate: now,
    health: {
      timestamp: now,
      typecheck: { passed: false, errorCount: 0, errors: [] },
      tests: { passed: false, total: 0, passing: 0, failing: 0, skipped: 0, failingTests: [] },
      lint: { passed: false, errorCount: 0, warningCount: 0 },
      healthy: false,
    },
    concerns: [],
    recentActivity: [],
    stats: {
      totalFiles: 0,
      totalLines: 0,
      lastCommitHash: '',
      lastCommitMessage: '',
      branchName: '',
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Path Resolution
// ─────────────────────────────────────────────────────────────────────────────

function resolvePath(filePath: string): string {
  if (filePath.startsWith('~')) {
    const home = process.env['HOME'] ?? process.env['USERPROFILE'] ?? '/tmp';
    return filePath.replace('~', home);
  }
  return filePath;
}

// ─────────────────────────────────────────────────────────────────────────────
// WorldModel Class
// ─────────────────────────────────────────────────────────────────────────────

export class WorldModel {
  private readonly config: WorldModelConfig;
  private data: WorldModelData;
  private dirty: boolean = false;

  constructor(config?: Partial<WorldModelConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.data = createEmptyWorldModel();
  }

  // ── Persistence ──────────────────────────────────────────────────────────

  /**
   * Load the world model from disk. If the file doesn't exist, initializes
   * with empty defaults. If the file is corrupt, logs a warning and starts fresh.
   */
  async load(): Promise<void> {
    const tracer = getTracer();
    await tracer.withSpan('world-model', 'load', async (span) => {
      const resolvedPath = resolvePath(this.config.path);
      tracer.log('world-model', 'debug', `Loading world model from ${resolvedPath}`);

      const startMs = Date.now();
      try {
        const raw = await readFile(resolvedPath, 'utf8');
        const parsed = YAML.parse(raw) as unknown;

        if (parsed && typeof parsed === 'object' && 'version' in parsed) {
          this.data = parsed as WorldModelData;
          this.dirty = false;

          tracer.logIO('world-model', 'read', resolvedPath, Date.now() - startMs, {
            success: true,
            bytesOrLines: raw.length,
          });
          tracer.log('world-model', 'info', 'World model loaded', {
            healthy: this.data.health.healthy,
            concerns: this.data.concerns.length,
            activities: this.data.recentActivity.length,
            lastFullUpdate: this.data.lastFullUpdate,
          });
        } else {
          tracer.log('world-model', 'warn', 'World model file has unexpected structure, starting fresh');
          this.data = createEmptyWorldModel();
          this.dirty = true;
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          tracer.log('world-model', 'info', 'No existing world model found, initializing fresh');
          this.data = createEmptyWorldModel();
          this.dirty = true;
        } else {
          tracer.log('world-model', 'error', 'Failed to load world model', {
            error: err instanceof Error ? err.message : String(err),
          });
          this.data = createEmptyWorldModel();
          this.dirty = true;
          span.status = 'failure';
          span.error = err instanceof Error ? err.message : String(err);
        }
      }
    });
  }

  /**
   * Save the world model to disk. Only writes if changes have been made
   * (dirty flag). Creates the parent directory if it doesn't exist.
   */
  async save(): Promise<void> {
    const tracer = getTracer();
    await tracer.withSpan('world-model', 'save', async () => {
      if (!this.dirty) {
        tracer.log('world-model', 'debug', 'World model unchanged, skipping save');
        return;
      }

      const resolvedPath = resolvePath(this.config.path);
      const dir = dirname(resolvedPath);

      // Ensure directory exists
      await mkdir(dir, { recursive: true });

      const content = YAML.stringify(this.data, { lineWidth: 120 });
      const startMs = Date.now();

      await writeFile(resolvedPath, content, 'utf8');
      this.dirty = false;

      tracer.logIO('world-model', 'write', resolvedPath, Date.now() - startMs, {
        success: true,
        bytesOrLines: content.length,
      });
      tracer.log('world-model', 'info', 'World model saved');
    });
  }

  // ── Queries ──────────────────────────────────────────────────────────────

  /**
   * Get the complete world model data. Returns a deep copy to prevent
   * accidental mutation.
   */
  getData(): WorldModelData {
    return structuredClone(this.data);
  }

  /**
   * Get the current health snapshot.
   */
  getHealth(): Readonly<HealthSnapshot> {
    return this.data.health;
  }

  /**
   * Get all active concerns.
   */
  getConcerns(): ReadonlyArray<Concern> {
    return this.data.concerns;
  }

  /**
   * Get concerns filtered by severity.
   */
  getConcernsBySeverity(severity: Concern['severity']): ReadonlyArray<Concern> {
    return this.data.concerns.filter((c) => c.severity === severity);
  }

  /**
   * Get recent activity entries, most recent first.
   */
  getRecentActivity(limit?: number): ReadonlyArray<ActivityEntry> {
    const entries = [...this.data.recentActivity].reverse();
    return limit !== undefined ? entries.slice(0, limit) : entries;
  }

  /**
   * Get the codebase statistics.
   */
  getStats(): Readonly<WorldModelData['stats']> {
    return this.data.stats;
  }

  /**
   * Check whether the codebase is currently healthy (all checks passing).
   */
  isHealthy(): boolean {
    return this.data.health.healthy;
  }

  /**
   * Get a compact text summary suitable for inclusion in an LLM prompt.
   * This is the "morning coffee" view — everything Tyrion needs to know
   * at a glance when he starts working.
   */
  getSummary(): string {
    const h = this.data.health;
    const s = this.data.stats;
    const concerns = this.data.concerns.filter((c) => c.severity === 'needs-action');
    const watchConcerns = this.data.concerns.filter((c) => c.severity === 'worth-watching');
    const recentActivity = this.getRecentActivity(5);

    const lines: string[] = [
      '## Codebase Health',
      `- Tests: ${h.tests.passing}/${h.tests.total} passing${h.tests.failing > 0 ? ` (${h.tests.failing} failing: ${h.tests.failingTests.join(', ')})` : ''}`,
      `- TypeScript: ${h.typecheck.passed ? 'clean' : `${h.typecheck.errorCount} errors`}`,
      `- Lint: ${h.lint.passed ? 'clean' : `${h.lint.errorCount} errors, ${h.lint.warningCount} warnings`}`,
      `- Overall: ${h.healthy ? 'HEALTHY' : 'UNHEALTHY'}`,
      `- Last checked: ${h.timestamp}`,
      '',
      '## Codebase Stats',
      `- Files: ${s.totalFiles} | Lines: ${s.totalLines}`,
      `- Branch: ${s.branchName}`,
      `- Last commit: ${s.lastCommitHash.slice(0, 7)} "${s.lastCommitMessage}"`,
      '',
    ];

    if (concerns.length > 0) {
      lines.push('## Needs Action');
      for (const c of concerns) {
        lines.push(`- ${c.description} (since ${c.firstSeen}, ${c.occurrences} occurrences)`);
        if (c.relatedFiles.length > 0) {
          lines.push(`  Files: ${c.relatedFiles.join(', ')}`);
        }
      }
      lines.push('');
    }

    if (watchConcerns.length > 0) {
      lines.push('## Worth Watching');
      for (const c of watchConcerns) {
        lines.push(`- ${c.description} (since ${c.firstSeen})`);
      }
      lines.push('');
    }

    if (recentActivity.length > 0) {
      lines.push('## Recent Activity');
      for (const a of recentActivity) {
        const hash = a.commitHash ? ` [${a.commitHash.slice(0, 7)}]` : '';
        lines.push(`- [${a.source}] ${a.description}${hash}`);
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  // ── Updates ──────────────────────────────────────────────────────────────

  /**
   * Run a full codebase health check. This is expensive (runs typecheck,
   * tests, lint, and git commands) and should be called sparingly —
   * typically once per autonomous cycle or during dream cycles.
   */
  async updateFromCodebase(): Promise<void> {
    const tracer = getTracer();
    await tracer.withSpan('world-model', 'updateFromCodebase', async () => {
      tracer.log('world-model', 'info', 'Starting full codebase health update');

      // Run all checks in parallel for speed
      const [typecheckResult, testResult, lintResult, gitResult, statsResult] = await Promise.allSettled([
        this.runTypecheck(),
        this.runTests(),
        this.runLint(),
        this.runGitInfo(),
        this.runCodebaseStats(),
      ]);

      // Update health snapshot
      const now = new Date().toISOString();

      if (typecheckResult.status === 'fulfilled') {
        this.data.health.typecheck = typecheckResult.value;
        tracer.log('world-model', 'debug', 'Typecheck result', typecheckResult.value);
      } else {
        tracer.log('world-model', 'error', 'Typecheck failed to run', {
          error: typecheckResult.reason instanceof Error
            ? typecheckResult.reason.message
            : String(typecheckResult.reason),
        });
      }

      if (testResult.status === 'fulfilled') {
        this.data.health.tests = testResult.value;
        tracer.log('world-model', 'debug', 'Test result', {
          total: testResult.value.total,
          passing: testResult.value.passing,
          failing: testResult.value.failing,
        });
      } else {
        tracer.log('world-model', 'error', 'Tests failed to run', {
          error: testResult.reason instanceof Error
            ? testResult.reason.message
            : String(testResult.reason),
        });
      }

      if (lintResult.status === 'fulfilled') {
        this.data.health.lint = lintResult.value;
        tracer.log('world-model', 'debug', 'Lint result', lintResult.value);
      } else {
        tracer.log('world-model', 'error', 'Lint failed to run', {
          error: lintResult.reason instanceof Error
            ? lintResult.reason.message
            : String(lintResult.reason),
        });
      }

      if (gitResult.status === 'fulfilled') {
        this.data.stats = { ...this.data.stats, ...gitResult.value };
        tracer.log('world-model', 'debug', 'Git info updated', gitResult.value);
      } else {
        tracer.log('world-model', 'error', 'Git info failed', {
          error: gitResult.reason instanceof Error
            ? gitResult.reason.message
            : String(gitResult.reason),
        });
      }

      if (statsResult.status === 'fulfilled') {
        this.data.stats.totalFiles = statsResult.value.totalFiles;
        this.data.stats.totalLines = statsResult.value.totalLines;
        tracer.log('world-model', 'debug', 'Codebase stats updated', statsResult.value);
      } else {
        tracer.log('world-model', 'error', 'Codebase stats failed', {
          error: statsResult.reason instanceof Error
            ? statsResult.reason.message
            : String(statsResult.reason),
        });
      }

      // Compute overall health
      this.data.health.healthy =
        this.data.health.typecheck.passed &&
        this.data.health.tests.passed &&
        this.data.health.lint.passed;

      this.data.health.timestamp = now;
      this.data.lastFullUpdate = now;
      this.dirty = true;

      tracer.log('world-model', 'info', `Full update complete. Healthy: ${this.data.health.healthy}`);
    });
  }

  /**
   * Quick update — just refresh git info and activity. Much cheaper than
   * a full update. Suitable for running after every interaction.
   */
  async updateActivity(): Promise<void> {
    const tracer = getTracer();
    await tracer.withSpan('world-model', 'updateActivity', async () => {
      tracer.log('world-model', 'debug', 'Updating activity from git');

      try {
        const gitInfo = await this.runGitInfo();
        this.data.stats = { ...this.data.stats, ...gitInfo };
        this.data.lastPartialUpdate = new Date().toISOString();
        this.dirty = true;
        tracer.log('world-model', 'debug', 'Activity update complete');
      } catch (err) {
        tracer.log('world-model', 'error', 'Activity update failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });
  }

  /**
   * Add an activity entry to the recent activity log.
   */
  addActivity(entry: Omit<ActivityEntry, 'timestamp'>): void {
    const tracer = getTracer();
    const fullEntry: ActivityEntry = {
      ...entry,
      timestamp: new Date().toISOString(),
    };

    this.data.recentActivity.push(fullEntry);

    // Trim to max entries
    if (this.data.recentActivity.length > this.config.maxActivityEntries) {
      const removed = this.data.recentActivity.length - this.config.maxActivityEntries;
      this.data.recentActivity = this.data.recentActivity.slice(removed);
      tracer.log('world-model', 'trace', `Trimmed ${removed} old activity entries`);
    }

    this.dirty = true;
    tracer.log('world-model', 'debug', `Activity added: [${entry.source}] ${entry.description}`);
  }

  /**
   * Add or update a concern. If a concern with the same description already
   * exists, increment its occurrence count. Otherwise, add a new one.
   */
  addConcern(concern: Omit<Concern, 'firstSeen' | 'occurrences'>): void {
    const tracer = getTracer();
    const existing = this.data.concerns.find((c) => c.description === concern.description);

    if (existing) {
      const oldOccurrences = existing.occurrences;
      existing.occurrences += 1;
      existing.severity = concern.severity;
      existing.relatedFiles = concern.relatedFiles;

      tracer.logStateChange('world-model', `concern[${concern.description}].occurrences`, oldOccurrences, existing.occurrences);
    } else {
      const newConcern: Concern = {
        ...concern,
        firstSeen: new Date().toISOString(),
        occurrences: 1,
      };
      this.data.concerns.push(newConcern);

      // Trim if over max
      if (this.data.concerns.length > this.config.maxConcerns) {
        // Remove oldest informational concerns first
        const informational = this.data.concerns
          .filter((c) => c.severity === 'informational')
          .sort((a, b) => a.firstSeen.localeCompare(b.firstSeen));

        if (informational.length > 0 && informational[0]) {
          const index = this.data.concerns.indexOf(informational[0]);
          if (index >= 0) {
            this.data.concerns.splice(index, 1);
            tracer.log('world-model', 'trace', `Pruned oldest informational concern to make room`);
          }
        }
      }

      tracer.log('world-model', 'debug', `New concern added: ${concern.description} [${concern.severity}]`);
    }

    this.dirty = true;
  }

  /**
   * Remove a concern by description (e.g., when it's been resolved).
   */
  removeConcern(description: string): boolean {
    const tracer = getTracer();
    const index = this.data.concerns.findIndex((c) => c.description === description);

    if (index >= 0) {
      this.data.concerns.splice(index, 1);
      this.dirty = true;
      tracer.log('world-model', 'debug', `Concern resolved: ${description}`);
      return true;
    }

    tracer.log('world-model', 'debug', `Concern not found for removal: ${description}`);
    return false;
  }

  /**
   * Directly update the health snapshot. Used when the agent loop has already
   * run tests/typecheck as part of its work and wants to update the world
   * model without running them again.
   */
  updateHealth(partial: Partial<HealthSnapshot>): void {
    const tracer = getTracer();
    const before = { ...this.data.health };

    this.data.health = {
      ...this.data.health,
      ...partial,
      timestamp: new Date().toISOString(),
    };

    // Recompute overall health
    this.data.health.healthy =
      this.data.health.typecheck.passed &&
      this.data.health.tests.passed &&
      this.data.health.lint.passed;

    this.dirty = true;

    if (before.healthy !== this.data.health.healthy) {
      tracer.logStateChange('world-model', 'health.healthy', before.healthy, this.data.health.healthy);
    }
  }

  // ── Shell Commands ───────────────────────────────────────────────────────

  /**
   * Run TypeScript typecheck and parse the results.
   */
  private async runTypecheck(): Promise<HealthSnapshot['typecheck']> {
    const tracer = getTracer();
    const startMs = Date.now();

    try {
      await execFileAsync('npx', ['tsc', '--noEmit'], {
        cwd: this.config.projectRoot,
        timeout: this.config.commandTimeoutMs,
      });

      tracer.logIO('world-model', 'exec', 'tsc --noEmit', Date.now() - startMs, { success: true });
      return { passed: true, errorCount: 0, errors: [] };
    } catch (err) {
      const durationMs = Date.now() - startMs;
      const stderr = (err as { stderr?: string }).stderr ?? '';
      const stdout = (err as { stdout?: string }).stdout ?? '';
      const output = stderr || stdout;

      // Parse error count from tsc output
      const errorLines = output
        .split('\n')
        .filter((line: string) => /\.ts\(\d+,\d+\):\s*error\s+TS/.test(line));

      tracer.logIO('world-model', 'exec', 'tsc --noEmit', durationMs, {
        success: false,
        error: `${errorLines.length} type errors`,
      });

      return {
        passed: false,
        errorCount: errorLines.length,
        errors: errorLines.slice(0, 10), // Keep first 10 for readability
      };
    }
  }

  /**
   * Run the test suite and parse the results.
   */
  private async runTests(): Promise<HealthSnapshot['tests']> {
    const tracer = getTracer();
    const startMs = Date.now();

    try {
      const { stdout } = await execFileAsync('npx', ['vitest', 'run', '--reporter=json'], {
        cwd: this.config.projectRoot,
        timeout: this.config.commandTimeoutMs,
      });

      tracer.logIO('world-model', 'exec', 'vitest run', Date.now() - startMs, { success: true });
      return this.parseVitestJson(stdout);
    } catch (err) {
      const durationMs = Date.now() - startMs;
      const stdout = (err as { stdout?: string }).stdout ?? '';

      // Vitest exits with non-zero on test failures — parse the output anyway
      if (stdout.includes('"testResults"') || stdout.includes('"numTotalTests"')) {
        tracer.logIO('world-model', 'exec', 'vitest run', durationMs, {
          success: true, // command ran, some tests failed
        });
        return this.parseVitestJson(stdout);
      }

      tracer.logIO('world-model', 'exec', 'vitest run', durationMs, {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      });

      return { passed: false, total: 0, passing: 0, failing: 0, skipped: 0, failingTests: [] };
    }
  }

  /**
   * Parse Vitest JSON reporter output into our structured format.
   */
  private parseVitestJson(jsonOutput: string): HealthSnapshot['tests'] {
    try {
      // Vitest JSON output may have non-JSON preamble; find the JSON object
      const jsonStart = jsonOutput.indexOf('{');
      const jsonEnd = jsonOutput.lastIndexOf('}');
      if (jsonStart < 0 || jsonEnd < 0) {
        return this.parseVitestText(jsonOutput);
      }

      const parsed = JSON.parse(jsonOutput.slice(jsonStart, jsonEnd + 1)) as {
        numTotalTests?: number;
        numPassedTests?: number;
        numFailedTests?: number;
        numPendingTests?: number;
        testResults?: Array<{
          assertionResults?: Array<{
            status?: string;
            fullName?: string;
          }>;
        }>;
        success?: boolean;
      };

      const total = parsed.numTotalTests ?? 0;
      const passing = parsed.numPassedTests ?? 0;
      const failing = parsed.numFailedTests ?? 0;
      const skipped = parsed.numPendingTests ?? 0;

      // Extract names of failing tests
      const failingTests: string[] = [];
      if (parsed.testResults) {
        for (const suite of parsed.testResults) {
          if (suite.assertionResults) {
            for (const test of suite.assertionResults) {
              if (test.status === 'failed' && test.fullName) {
                failingTests.push(test.fullName);
              }
            }
          }
        }
      }

      return {
        passed: failing === 0,
        total,
        passing,
        failing,
        skipped,
        failingTests: failingTests.slice(0, 10),
      };
    } catch {
      return this.parseVitestText(jsonOutput);
    }
  }

  /**
   * Fallback: parse Vitest text output when JSON parsing fails.
   */
  private parseVitestText(output: string): HealthSnapshot['tests'] {
    const passMatch = /(\d+)\s+passed/.exec(output);
    const failMatch = /(\d+)\s+failed/.exec(output);
    const skipMatch = /(\d+)\s+skipped/.exec(output);

    const passing = passMatch ? parseInt(passMatch[1] ?? '0', 10) : 0;
    const failing = failMatch ? parseInt(failMatch[1] ?? '0', 10) : 0;
    const skipped = skipMatch ? parseInt(skipMatch[1] ?? '0', 10) : 0;

    return {
      passed: failing === 0 && passing > 0,
      total: passing + failing + skipped,
      passing,
      failing,
      skipped,
      failingTests: [],
    };
  }

  /**
   * Run lint and parse the results.
   */
  private async runLint(): Promise<HealthSnapshot['lint']> {
    const tracer = getTracer();
    const startMs = Date.now();

    try {
      await execFileAsync('node', ['scripts/lint.mjs'], {
        cwd: this.config.projectRoot,
        timeout: this.config.commandTimeoutMs,
      });

      tracer.logIO('world-model', 'exec', 'lint', Date.now() - startMs, { success: true });
      return { passed: true, errorCount: 0, warningCount: 0 };
    } catch (err) {
      const durationMs = Date.now() - startMs;
      const stdout = (err as { stdout?: string }).stdout ?? '';
      const stderr = (err as { stderr?: string }).stderr ?? '';
      const output = stdout + stderr;

      // Count error and warning lines
      const errorLines = output.split('\n').filter((l: string) => /\berror\b/i.test(l));
      const warningLines = output.split('\n').filter((l: string) => /\bwarning\b/i.test(l));

      tracer.logIO('world-model', 'exec', 'lint', durationMs, {
        success: false,
        error: `${errorLines.length} errors, ${warningLines.length} warnings`,
      });

      return {
        passed: false,
        errorCount: errorLines.length,
        warningCount: warningLines.length,
      };
    }
  }

  /**
   * Get current git information: branch, last commit, etc.
   */
  private async runGitInfo(): Promise<Partial<WorldModelData['stats']>> {
    const tracer = getTracer();
    const startMs = Date.now();

    try {
      const [branchResult, logResult] = await Promise.all([
        execFileAsync('git', ['branch', '--show-current'], {
          cwd: this.config.projectRoot,
          timeout: 10_000,
        }),
        execFileAsync('git', ['log', '-1', '--format=%H%n%s'], {
          cwd: this.config.projectRoot,
          timeout: 10_000,
        }),
      ]);

      const branchName = branchResult.stdout.trim();
      const logLines = logResult.stdout.trim().split('\n');
      const lastCommitHash = logLines[0] ?? '';
      const lastCommitMessage = logLines[1] ?? '';

      tracer.logIO('world-model', 'exec', 'git info', Date.now() - startMs, { success: true });

      return { branchName, lastCommitHash, lastCommitMessage };
    } catch (err) {
      tracer.logIO('world-model', 'exec', 'git info', Date.now() - startMs, {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      });
      return {};
    }
  }

  /**
   * Count total TypeScript files and lines in the codebase.
   */
  private async runCodebaseStats(): Promise<{ totalFiles: number; totalLines: number }> {
    const tracer = getTracer();
    const startMs = Date.now();

    try {
      // Find all TS files, excluding node_modules and dist
      const { stdout } = await execFileAsync(
        'find',
        ['.', '-name', '*.ts', '-not', '-path', '*/node_modules/*', '-not', '-path', '*/dist/*'],
        { cwd: this.config.projectRoot, timeout: 30_000 },
      );

      const files = stdout.trim().split('\n').filter(Boolean);
      const totalFiles = files.length;

      // Count lines (use wc for speed)
      let totalLines = 0;
      if (files.length > 0) {
        try {
          const { stdout: wcOut } = await execFileAsync(
            'wc',
            ['-l', ...files],
            { cwd: this.config.projectRoot, timeout: 30_000 },
          );
          // wc -l output ends with "  TOTAL total"
          const totalLine = wcOut.trim().split('\n').pop() ?? '';
          const match = /^\s*(\d+)/.exec(totalLine);
          if (match?.[1]) {
            totalLines = parseInt(match[1], 10);
          }
        } catch {
          // wc may fail on too many files; count manually
          totalLines = 0;
        }
      }

      tracer.logIO('world-model', 'exec', 'codebase stats', Date.now() - startMs, { success: true });
      return { totalFiles, totalLines };
    } catch (err) {
      tracer.logIO('world-model', 'exec', 'codebase stats', Date.now() - startMs, {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      });
      return { totalFiles: 0, totalLines: 0 };
    }
  }
}
