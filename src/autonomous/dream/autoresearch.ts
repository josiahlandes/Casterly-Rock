/**
 * Autoresearch Loop — Autonomous Experimentation During Dream Cycles
 *
 * Inspired by Karpathy's Autoresearch framework: AI agents propose
 * hypotheses, implement changes, measure impact, and auto-revert failures.
 *
 * The loop:
 *   1. Propose a hypothesis (what to change and why)
 *   2. Snapshot the current state (git stash or checkpoint)
 *   3. Implement the change
 *   4. Measure: run tests, compute EvoScore
 *   5. Compare: is the new EvoScore better?
 *   6. Keep (commit) or Revert (restore snapshot)
 *   7. Log the experiment for future reference
 *
 * Safety constraints:
 *   - Only modifies allowed directories (from autonomous config)
 *   - Never modifies protected paths
 *   - Always reverts on test regression
 *   - Time-bounded per experiment
 *   - Maximum experiments per cycle (from intensity dial)
 *
 * Privacy: All experiments are local. No data leaves the machine.
 */

import { execSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { getTracer } from '../debug.js';
import type { PhaseContext } from './phase-progress.js';
import type { TestRunResult } from '../../ci-loop/types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** A hypothesis for an autoresearch experiment. */
export interface Hypothesis {
  /** Unique identifier */
  id: string;

  /** What is being tested */
  title: string;

  /** Detailed description of the change */
  description: string;

  /** Files to modify */
  targetFiles: string[];

  /** Expected improvement (human-readable) */
  expectedOutcome: string;

  /** Source of this hypothesis */
  source: HypothesisSource;
}

/** Where a hypothesis originated. */
export type HypothesisSource =
  | 'test-failure'      // Fix a known failing test
  | 'fragile-code'      // Refactor fragile code identified by archaeology
  | 'challenge-weakness' // Address weak sub-skills from challenge evaluator
  | 'code-quality'      // Improve code quality metrics
  | 'issue-log'         // Address an issue from the issue log
  | 'manual';           // User-requested experiment

/** Result of a single experiment. */
export interface ExperimentResult {
  /** The hypothesis tested */
  hypothesis: Hypothesis;

  /** Whether the experiment was accepted (kept) or reverted */
  outcome: 'accepted' | 'reverted' | 'error';

  /** Test results before the experiment */
  preTestResult: TestRunResult | null;

  /** Test results after the experiment */
  postTestResult: TestRunResult | null;

  /** EvoScore-like metric: net test change */
  netTestChange: number;

  /** Whether any regressions occurred */
  hasRegressions: boolean;

  /** Files that were modified */
  modifiedFiles: string[];

  /** Duration in milliseconds */
  durationMs: number;

  /** Error message if the experiment errored */
  error: string | null;

  /** Timestamp */
  timestamp: string;
}

/** Full result of an autoresearch cycle. */
export interface AutoresearchCycleResult {
  /** All experiments in this cycle */
  experiments: ExperimentResult[];

  /** How many experiments were accepted */
  acceptedCount: number;

  /** How many experiments were reverted */
  revertedCount: number;

  /** How many experiments errored */
  errorCount: number;

  /** Total duration in milliseconds */
  totalDurationMs: number;

  /** Timestamp */
  timestamp: string;
}

/** Persistent log of all experiments. */
export interface ExperimentLog {
  /** All experiment results, newest first */
  experiments: ExperimentResult[];

  /** Total experiments run across all cycles */
  totalExperiments: number;

  /** Total accepted experiments */
  totalAccepted: number;

  /** When the log was last updated */
  lastUpdated: string;
}

/** Configuration for the autoresearch system. */
export interface AutoresearchConfig {
  /** Maximum experiments per dream cycle */
  maxExperimentsPerCycle: number;

  /** Timeout per experiment in milliseconds */
  testTimeoutMs: number;

  /** Test command to run */
  testCommand: string;

  /** Working directory */
  workingDir: string;

  /** Directories allowed for modification */
  allowedDirectories: string[];

  /** Patterns that must never be modified */
  forbiddenPatterns: string[];

  /** Path to the experiment log */
  logPath: string;

  /** Maximum log entries to retain */
  maxLogEntries: number;

  /** Whether to use git for snapshot/revert (vs file-level backup) */
  useGitStash: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: AutoresearchConfig = {
  maxExperimentsPerCycle: 3,
  testTimeoutMs: 300_000,
  testCommand: 'npm run test',
  workingDir: process.cwd(),
  allowedDirectories: ['src/', 'tests/'],
  forbiddenPatterns: [
    '**/*.env*',
    '**/credentials*',
    '**/secrets*',
    '**/.git/**',
    'src/security/*',
    'config/*',
  ],
  logPath: path.join(
    process.env['HOME'] || '~',
    '.casterly', 'autoresearch-log.json',
  ),
  maxLogEntries: 200,
  useGitStash: true,
};

// ─────────────────────────────────────────────────────────────────────────────
// Autoresearch Engine
// ─────────────────────────────────────────────────────────────────────────────

export class AutoresearchEngine {
  private readonly config: AutoresearchConfig;
  private log: ExperimentLog;

  constructor(config?: Partial<AutoresearchConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.log = {
      experiments: [],
      totalExperiments: 0,
      totalAccepted: 0,
      lastUpdated: new Date().toISOString(),
    };
  }

  // ── Persistence ─────────────────────────────────────────────────────────

  /** Load experiment log from disk. */
  async loadLog(): Promise<void> {
    try {
      const content = await fs.readFile(this.config.logPath, 'utf-8');
      const data = JSON.parse(content) as ExperimentLog;
      if (data && Array.isArray(data.experiments)) {
        this.log = data;
      }
    } catch {
      // No log yet — start fresh
    }
  }

  /** Save experiment log to disk. */
  async saveLog(): Promise<void> {
    try {
      await fs.mkdir(path.dirname(this.config.logPath), { recursive: true });
      await fs.writeFile(
        this.config.logPath,
        JSON.stringify(this.log, null, 2),
        'utf-8',
      );
    } catch (err) {
      getTracer().log('dream', 'error',
        `Failed to save experiment log: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── Main Execution ─────────────────────────────────────────────────────

  /**
   * Run the autoresearch loop as a dream phase.
   *
   * Accepts hypotheses from external sources (issue log, challenge evaluator,
   * archaeology, etc.) and runs experiments on each.
   */
  async runCycle(
    hypotheses: Hypothesis[],
    runTests: TestRunner,
    applyChange: ChangeApplier,
    ctx?: PhaseContext,
  ): Promise<AutoresearchCycleResult> {
    const tracer = getTracer();
    const startTime = Date.now();
    const experiments: ExperimentResult[] = [];
    const limit = this.config.maxExperimentsPerCycle;

    tracer.log('dream', 'info', `Autoresearch: ${hypotheses.length} hypotheses, limit ${limit}`);

    for (let i = 0; i < Math.min(hypotheses.length, limit); i++) {
      if (ctx?.shouldStop()) break;

      const hypothesis = hypotheses[i]!;
      ctx?.reportProgress(i / limit);

      tracer.log('dream', 'info', `Experiment ${i + 1}/${limit}: ${hypothesis.title}`);
      const result = await this.runExperiment(hypothesis, runTests, applyChange);
      experiments.push(result);

      // Log the result
      this.log.experiments.unshift(result);
      this.log.totalExperiments++;
      if (result.outcome === 'accepted') this.log.totalAccepted++;

      // Prune old log entries, keeping aggregates consistent
      if (this.log.experiments.length > this.config.maxLogEntries) {
        const pruned = this.log.experiments.slice(this.config.maxLogEntries);
        this.log.experiments = this.log.experiments.slice(0, this.config.maxLogEntries);
        // Decrement aggregates by what was pruned so they stay consistent
        for (const entry of pruned) {
          this.log.totalExperiments--;
          if (entry.outcome === 'accepted') this.log.totalAccepted--;
        }
      }

      this.log.lastUpdated = new Date().toISOString();

      tracer.log('dream', 'info', `Experiment result: ${result.outcome}`, {
        netChange: result.netTestChange,
        hasRegressions: result.hasRegressions,
        durationMs: result.durationMs,
      });
    }

    ctx?.reportProgress(1);

    const cycleResult: AutoresearchCycleResult = {
      experiments,
      acceptedCount: experiments.filter(e => e.outcome === 'accepted').length,
      revertedCount: experiments.filter(e => e.outcome === 'reverted').length,
      errorCount: experiments.filter(e => e.outcome === 'error').length,
      totalDurationMs: Date.now() - startTime,
      timestamp: new Date().toISOString(),
    };

    await this.saveLog();
    return cycleResult;
  }

  // ── Single Experiment ──────────────────────────────────────────────────

  /**
   * Run a single experiment:
   *   1. Snapshot state
   *   2. Run pre-tests
   *   3. Apply change
   *   4. Run post-tests
   *   5. Compare — keep or revert
   */
  async runExperiment(
    hypothesis: Hypothesis,
    runTests: TestRunner,
    applyChange: ChangeApplier,
  ): Promise<ExperimentResult> {
    const startTime = Date.now();
    const result: ExperimentResult = {
      hypothesis,
      outcome: 'error',
      preTestResult: null,
      postTestResult: null,
      netTestChange: 0,
      hasRegressions: false,
      modifiedFiles: [],
      durationMs: 0,
      error: null,
      timestamp: new Date().toISOString(),
    };

    const tracer = getTracer();

    try {
      // Validate target files are in allowed directories
      const invalid = this.validateTargetFiles(hypothesis.targetFiles);
      if (invalid.length > 0) {
        result.error = `Forbidden paths: ${invalid.join(', ')}`;
        result.durationMs = Date.now() - startTime;
        return result;
      }

      // Step 1: Snapshot
      this.createSnapshot();

      // Step 2: Pre-tests
      result.preTestResult = await runTests(this.config.testCommand, this.config.workingDir);
      const prePassing = result.preTestResult.passed;

      // Step 3: Apply change
      const applied = await applyChange(hypothesis);
      result.modifiedFiles = applied.modifiedFiles;

      if (!applied.success) {
        result.error = applied.error ?? 'Change application failed';
        this.restoreSnapshot();
        result.outcome = 'reverted';
        result.durationMs = Date.now() - startTime;
        return result;
      }

      // Step 4: Post-tests
      result.postTestResult = await runTests(this.config.testCommand, this.config.workingDir);
      const postPassing = result.postTestResult.passed;
      const postFailing = result.postTestResult.failed + result.postTestResult.errored;

      // Step 5: Compare
      result.netTestChange = postPassing - prePassing;

      // Check for regressions: any test that was passing before is now failing
      const prePassingNames = new Set(
        result.preTestResult.tests
          .filter(t => t.status === 'passed')
          .map(t => t.name),
      );
      const postFailingNames = result.postTestResult.tests
        .filter(t => t.status === 'failed' || t.status === 'error')
        .map(t => t.name);

      result.hasRegressions = postFailingNames.some(name => prePassingNames.has(name));

      // Also detect "new failures" — tests that didn't exist before and are now failing.
      // This catches cases where netTestChange=0 but the test suite composition changed badly.
      const preTestNames = new Set(result.preTestResult.tests.map(t => t.name));
      const newFailures = postFailingNames.filter(name => !preTestNames.has(name));

      // Decision: accept only if:
      //   1. No regressions (previously passing tests still pass)
      //   2. Net test count didn't decrease
      //   3. No new test failures introduced
      const shouldAccept = !result.hasRegressions
        && result.netTestChange >= 0
        && newFailures.length === 0;

      if (shouldAccept) {
        result.outcome = 'accepted';
        this.dropSnapshot();
        tracer.log('dream', 'info', `Experiment accepted: +${result.netTestChange} tests`);
      } else {
        result.outcome = 'reverted';
        this.restoreSnapshot();
        tracer.log('dream', 'info', `Experiment reverted: regression=${result.hasRegressions}, net=${result.netTestChange}, newFailures=${newFailures.length}`);
      }
    } catch (err) {
      result.error = err instanceof Error ? err.message : String(err);
      // Always try to restore on error
      try {
        this.restoreSnapshot();
      } catch {
        tracer.log('dream', 'error', 'Failed to restore snapshot after experiment error');
      }
    }

    result.durationMs = Date.now() - startTime;
    return result;
  }

  // ── Git Snapshot Operations ────────────────────────────────────────────

  /** Whether a valid snapshot currently exists. */
  private snapshotActive = false;

  private createSnapshot(): void {
    if (!this.config.useGitStash) return;
    const tracer = getTracer();

    // Check for uncommitted staged changes that could cause conflicts
    try {
      const status = execSync('git status --porcelain', {
        cwd: this.config.workingDir,
        stdio: 'pipe',
        timeout: 10_000,
      }).toString().trim();

      // If there are existing changes, refuse to run — the tree must be clean
      if (status.length > 0) {
        throw new Error(
          'Working tree is not clean. Autoresearch requires a clean git state to snapshot safely.',
        );
      }
    } catch (err) {
      if (err instanceof Error && err.message.includes('not clean')) throw err;
      throw new Error(`Failed to check git status: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Nothing to stash (clean tree), but we record HEAD so we can hard-reset on restore
    this.snapshotActive = true;
    tracer.log('dream', 'info', 'Autoresearch snapshot: clean tree recorded');
  }

  private restoreSnapshot(): void {
    if (!this.config.useGitStash) return;
    if (!this.snapshotActive) return;

    const tracer = getTracer();
    try {
      // Hard-reset to HEAD to discard any experiment changes.
      // This is safe because createSnapshot() verified the tree was clean.
      execSync('git checkout -- .', {
        cwd: this.config.workingDir,
        stdio: 'pipe',
        timeout: 30_000,
      });
      // Remove any untracked files the experiment may have created
      execSync('git clean -fd', {
        cwd: this.config.workingDir,
        stdio: 'pipe',
        timeout: 30_000,
      });
      this.snapshotActive = false;
      tracer.log('dream', 'info', 'Autoresearch snapshot: restored (git checkout + clean)');
    } catch (err) {
      tracer.log('dream', 'error',
        `Failed to restore snapshot: ${err instanceof Error ? err.message : String(err)}. ` +
        'Working tree may be in a dirty state — manual intervention required.');
      // Do NOT clear snapshotActive so callers know recovery failed
      throw new Error('Snapshot restore failed — working tree may be corrupted');
    }
  }

  private dropSnapshot(): void {
    if (!this.config.useGitStash) return;
    // Experiment was accepted — the current tree state is the desired state.
    this.snapshotActive = false;
  }

  // ── Validation ─────────────────────────────────────────────────────────

  /**
   * Check that target files are within allowed directories and not
   * in forbidden patterns.
   */
  private validateTargetFiles(files: string[]): string[] {
    const invalid: string[] = [];

    for (const file of files) {
      // Normalize: strip leading ./
      const normalized = file.startsWith('./') ? file.slice(2) : file;

      // Check allowed directories
      const inAllowed = this.config.allowedDirectories.some(dir => {
        const normalizedDir = dir.startsWith('./') ? dir.slice(2) : dir;
        return normalized.startsWith(normalizedDir);
      });
      if (!inAllowed) {
        invalid.push(file);
        continue;
      }

      // Check forbidden patterns using path-anchored matching
      const isForbidden = this.config.forbiddenPatterns.some(pattern =>
        matchForbiddenPattern(normalized, pattern),
      );
      if (isForbidden) {
        invalid.push(file);
      }
    }

    return invalid;
  }

  // ── Queries ────────────────────────────────────────────────────────────

  /** Get the experiment log. */
  getLog(): Readonly<ExperimentLog> {
    return this.log;
  }

  /** Get a summary of recent experiments. */
  getSummary(lastN: number = 10): string {
    const recent = this.log.experiments.slice(0, lastN);
    const lines: string[] = [];
    lines.push(`Autoresearch: ${this.log.totalExperiments} total, ${this.log.totalAccepted} accepted`);

    if (recent.length > 0) {
      lines.push('Recent experiments:');
      for (const exp of recent) {
        const icon = exp.outcome === 'accepted' ? '+' : exp.outcome === 'reverted' ? '-' : '!';
        lines.push(`  [${icon}] ${exp.hypothesis.title} (${exp.outcome}, net=${exp.netTestChange})`);
      }
    }

    return lines.join('\n');
  }

  /** Get the config (for testing). */
  getConfig(): Readonly<AutoresearchConfig> {
    return this.config;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Callback Types
// ─────────────────────────────────────────────────────────────────────────────

/** Function that runs the test suite and returns results. */
export type TestRunner = (
  command: string,
  cwd: string,
) => Promise<TestRunResult>;

/** Function that applies a hypothesis's change to the codebase. */
export type ChangeApplier = (
  hypothesis: Hypothesis,
) => Promise<ChangeResult>;

/** Result of applying a change. */
export interface ChangeResult {
  /** Whether the change was applied successfully */
  success: boolean;
  /** Files that were modified */
  modifiedFiles: string[];
  /** Error description if not successful */
  error?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Match a file path against a forbidden pattern.
 * Supports simple glob patterns anchored to path boundaries:
 *   - `dir/*`       → matches files directly inside `dir/`
 *   - `**​/name*`    → matches any path segment containing `name`
 *   - `dir/**`      → matches anything under `dir/`
 *   - Literal paths → exact prefix match
 */
function matchForbiddenPattern(filePath: string, pattern: string): boolean {
  // Handle **/ prefix (match anywhere in path)
  if (pattern.startsWith('**/')) {
    const suffix = pattern.slice(3).replace(/\*/g, '');
    // Match any path segment that starts with the suffix
    const segments = filePath.split('/');
    return segments.some(seg => seg.startsWith(suffix) || seg.includes(suffix));
  }

  // Handle dir/* (single-level match under dir)
  if (pattern.endsWith('/*') && !pattern.endsWith('**/*')) {
    const dir = pattern.slice(0, -2); // strip /*
    const normalizedDir = dir.endsWith('/') ? dir : dir + '/';
    if (!filePath.startsWith(normalizedDir)) return false;
    // Must be a direct child (no further /)
    const rest = filePath.slice(normalizedDir.length);
    return !rest.includes('/');
  }

  // Handle dir/** (recursive match under dir)
  if (pattern.endsWith('/**')) {
    const dir = pattern.slice(0, -3);
    const normalizedDir = dir.endsWith('/') ? dir : dir + '/';
    return filePath.startsWith(normalizedDir);
  }

  // Literal prefix match (anchored to start of path)
  return filePath.startsWith(pattern) || filePath === pattern;
}
