/**
 * Dream Cycle Scheduler — Brings dream cycles to the dual-loop architecture.
 *
 * The DreamCycleRunner was built for the AutonomousLoop but was orphaned
 * when the dual-loop became the primary execution path. This scheduler
 * bridges the gap: it runs inside the LoopCoordinator and triggers dream
 * cycles during idle periods on a configurable schedule.
 *
 * Scheduling logic (from the original AutonomousLoop):
 *   - Once per calendar day maximum
 *   - Respects consolidation interval (default 24h between runs)
 *   - Only runs when DeepLoop has no active tasks (idle)
 *   - Individual phase failures don't abort the cycle
 *
 * The scheduler also tracks state to disk so it survives daemon restarts.
 *
 * Privacy: All dream cycle operations are local. No data leaves the machine.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { getTracer } from '../autonomous/debug.js';
import { DreamCycleRunner } from '../autonomous/dream/runner.js';
import type { DreamCycleConfig, DreamOutcome } from '../autonomous/dream/runner.js';
import type { WorldModel } from '../autonomous/world-model.js';
import type { GoalStack } from '../autonomous/goal-stack.js';
import type { IssueLog } from '../autonomous/issue-log.js';
import { Reflector } from '../autonomous/reflector.js';
import { runTests } from '../ci-loop/test-runner.js';
import { getFailingTests } from '../ci-loop/regression-guard.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** Configuration for the dream scheduler */
export interface DreamSchedulerConfig {
  /** Whether dream cycles are enabled */
  enabled: boolean;

  /** Hours between dream cycle runs (default: 24) */
  intervalHours: number;

  /** Minimum idle seconds before triggering a dream cycle (default: 300 = 5 min) */
  minIdleBeforeDreamSeconds: number;

  /** How often to check if a dream cycle is due (ms, default: 60_000 = 1 min) */
  checkIntervalMs: number;

  /** Dream cycle configuration passed to DreamCycleRunner */
  dreamConfig?: Partial<DreamCycleConfig>;

  /** Test command for CI health check (default: 'npm run test'). Set to '' to disable. */
  testCommand: string;

  /** Working directory for test execution */
  workingDir: string;
}

/** Persistent state for the dream scheduler */
interface DreamSchedulerState {
  /** ISO date string of the last dream cycle run (YYYY-MM-DD) */
  lastDreamDate: string;

  /** ISO timestamp of the last dream cycle */
  lastDreamTimestamp: string;

  /** Total dream cycles completed */
  totalDreamCycles: number;

  /** Last dream outcome summary */
  lastOutcomeSummary: string;
}

/** Dependencies the scheduler needs from the dual-loop system */
export interface DreamSchedulerDeps {
  /** World model for codebase health */
  worldModel: WorldModel;

  /** Goal stack for reorganization */
  goalStack: GoalStack;

  /** Issue log for filing fragile-code issues */
  issueLog: IssueLog;

  /** Function to check if DeepLoop is currently idle (no active tasks) */
  isDeepLoopIdle: () => boolean;
}

/** Default configuration */
const DEFAULT_CONFIG: DreamSchedulerConfig = {
  enabled: true,
  intervalHours: 24,
  minIdleBeforeDreamSeconds: 300,
  checkIntervalMs: 60_000,
  testCommand: 'npm run test',
  workingDir: process.cwd(),
};

const STATE_PATH = path.join(
  process.env['HOME'] || '~',
  '.casterly', 'dream-scheduler-state.json',
);

// ─────────────────────────────────────────────────────────────────────────────
// Dream Scheduler
// ─────────────────────────────────────────────────────────────────────────────

export class DreamScheduler {
  private readonly config: DreamSchedulerConfig;
  private readonly runner: DreamCycleRunner;
  private readonly reflector: Reflector;
  private readonly deps: DreamSchedulerDeps;

  private state: DreamSchedulerState = {
    lastDreamDate: '',
    lastDreamTimestamp: '',
    totalDreamCycles: 0,
    lastOutcomeSummary: '',
  };

  private checkTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private dreaming = false;
  private idleSince: number | null = null;

  constructor(
    deps: DreamSchedulerDeps,
    config?: Partial<DreamSchedulerConfig>,
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.deps = deps;
    this.reflector = new Reflector();
    this.runner = new DreamCycleRunner(this.config.dreamConfig);
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────

  /**
   * Start the dream scheduler. Loads persisted state and begins
   * periodic checks for dream cycle eligibility.
   */
  async start(): Promise<void> {
    if (!this.config.enabled) return;

    const tracer = getTracer();
    this.running = true;

    // Load persisted state
    await this.loadState();
    await this.reflector.initialize();

    tracer.log('dream', 'info', 'Dream scheduler started', {
      intervalHours: this.config.intervalHours,
      lastDreamDate: this.state.lastDreamDate || 'never',
      totalDreamCycles: this.state.totalDreamCycles,
    });

    // Start periodic check
    this.checkTimer = setInterval(() => {
      void this.check().catch((err) => {
        tracer.log('dream', 'error', 'Dream check failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, this.config.checkIntervalMs);
  }

  /**
   * Stop the dream scheduler.
   */
  async stop(): Promise<void> {
    this.running = false;

    if (this.checkTimer) {
      clearInterval(this.checkTimer);
      this.checkTimer = null;
    }

    await this.saveState();

    const tracer = getTracer();
    tracer.log('dream', 'info', 'Dream scheduler stopped');
  }

  /**
   * Check if a dream cycle should run and execute it if conditions are met.
   */
  async check(): Promise<void> {
    if (!this.running || !this.config.enabled || this.dreaming) return;

    const now = new Date();
    const today = now.toISOString().split('T')[0] ?? '';

    // Only run once per calendar day
    if (this.state.lastDreamDate === today) return;

    // Respect interval: skip if not enough time has passed
    if (this.state.lastDreamTimestamp) {
      const elapsedMs = now.getTime() - new Date(this.state.lastDreamTimestamp).getTime();
      if (elapsedMs < this.config.intervalHours * 3_600_000) return;
    }

    // Check if DeepLoop is idle
    const isIdle = this.deps.isDeepLoopIdle();
    if (!isIdle) {
      this.idleSince = null;
      return;
    }

    // Track idle duration — require sustained idle before dreaming
    if (this.idleSince === null) {
      this.idleSince = Date.now();
      return;
    }

    const idleDurationSec = (Date.now() - this.idleSince) / 1000;
    if (idleDurationSec < this.config.minIdleBeforeDreamSeconds) return;

    // All conditions met — run the dream cycle
    await this.runDreamCycle();
  }

  /**
   * Force a dream cycle to run immediately, bypassing scheduling checks.
   * Useful for testing or manual triggering.
   */
  async forceRun(): Promise<DreamOutcome | null> {
    if (this.dreaming) return null;
    return this.runDreamCycle();
  }

  /**
   * Whether a dream cycle is currently executing.
   */
  isDreaming(): boolean {
    return this.dreaming;
  }

  /**
   * Get a summary of the scheduler's state.
   */
  getSummary(): string {
    const lines: string[] = [];
    lines.push(`Dream scheduler: ${this.config.enabled ? 'enabled' : 'disabled'}`);
    lines.push(`Last dream: ${this.state.lastDreamDate || 'never'}`);
    lines.push(`Total cycles: ${this.state.totalDreamCycles}`);
    if (this.dreaming) lines.push('Currently dreaming...');
    if (this.state.lastOutcomeSummary) {
      lines.push(`Last outcome: ${this.state.lastOutcomeSummary}`);
    }
    return lines.join('\n');
  }

  // ── Internal ────────────────────────────────────────────────────────────

  /**
   * Execute a dream cycle, followed by a CI health check.
   */
  private async runDreamCycle(): Promise<DreamOutcome> {
    const tracer = getTracer();
    this.dreaming = true;

    tracer.log('dream', 'info', '=== Dream cycle starting (dual-loop) ===');

    try {
      const outcome = await this.runner.run(
        this.deps.worldModel,
        this.deps.goalStack,
        this.deps.issueLog,
        this.reflector,
        // All optional subsystems — pass undefined to let the runner skip them gracefully
      );

      // Run CI health check: execute tests and file issues for failures
      await this.runCiHealthCheck();

      const now = new Date();
      this.state.lastDreamDate = now.toISOString().split('T')[0] ?? '';
      this.state.lastDreamTimestamp = now.toISOString();
      this.state.totalDreamCycles++;
      this.state.lastOutcomeSummary = formatOutcomeSummary(outcome);

      await this.saveState();

      tracer.log('dream', 'info', '=== Dream cycle complete ===', {
        phasesCompleted: outcome.phasesCompleted,
        phasesSkipped: outcome.phasesSkipped,
        fragileFiles: outcome.fragileFilesFound,
        goalsReorganized: outcome.goalsReorganized,
        duration: `${(outcome.durationMs / 1000).toFixed(1)}s`,
      });

      return outcome;
    } catch (err) {
      tracer.log('dream', 'error', `Dream cycle failed: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    } finally {
      this.dreaming = false;
      this.idleSince = null;
    }
  }

  /**
   * CI Health Check — Run the test suite and file issues for any failures.
   *
   * This is the lightweight integration of the SWE-CI regression guard
   * into the dream cycle. It doesn't run the full Architect→Programmer
   * loop (that requires LLM providers), but it does:
   *   1. Execute the test suite
   *   2. Identify failing tests
   *   3. File issues in the IssueLog for new failures
   *   4. Add a goal to the GoalStack to fix them
   *
   * This ensures Tyrion is aware of test failures and can work on them
   * during idle time via the GoalStack → DeepLoop path.
   */
  private async runCiHealthCheck(): Promise<void> {
    if (!this.config.testCommand) return;

    const tracer = getTracer();
    tracer.log('dream', 'info', 'Running CI health check');

    try {
      const result = await runTests({
        command: this.config.testCommand,
        cwd: this.config.workingDir,
        timeoutMs: 300_000,
      });

      tracer.log('dream', 'info', 'CI health check results', {
        total: result.total,
        passed: result.passed,
        failed: result.failed,
        errored: result.errored,
      });

      // If tests are all passing, nothing to do
      if (result.failed === 0 && result.errored === 0) {
        tracer.log('dream', 'info', 'All tests passing — codebase healthy');
        return;
      }

      // File issues for failing tests (if not already tracked)
      const failingTests = getFailingTests(result);
      let newIssues = 0;

      for (const testName of failingTests.slice(0, 10)) {
        // Check if there's already an issue for this test
        const existing = this.deps.issueLog.getOpenIssues().filter(
          (issue) => issue.title.includes(testName) || issue.description.includes(testName),
        );
        if (existing.length > 0) continue;

        const test = result.tests.find((t) => t.name === testName);
        this.deps.issueLog.fileIssue({
          title: `Test failure: ${testName}`,
          description: `Test "${testName}" is failing.${test?.errorMessage ? ` Error: ${test.errorMessage}` : ''}\nDiscovered during CI health check.`,
          priority: 'medium',
          relatedFiles: [],
          discoveredBy: 'test-failure',
          tags: ['test-failure', 'ci-health'],
        });
        newIssues++;
      }

      // Add a goal to fix failing tests if there are new failures
      if (newIssues > 0) {
        this.deps.goalStack.addGoal({
          source: 'self',
          description: `Fix ${failingTests.length} failing test(s) discovered during CI health check`,
          priority: 2,
          relatedFiles: [],
          tags: ['ci-health', 'test-fix'],
        });

        tracer.log('dream', 'info', `Filed ${newIssues} new issue(s) for failing tests`, {
          totalFailing: failingTests.length,
        });
      }
    } catch (err) {
      tracer.log('dream', 'warn', `CI health check failed: ${err instanceof Error ? err.message : String(err)}`);
      // Don't fail the dream cycle for a health check error
    }
  }

  /**
   * Load persisted state from disk.
   */
  private async loadState(): Promise<void> {
    try {
      const content = await fs.readFile(STATE_PATH, 'utf-8');
      const data = JSON.parse(content) as Partial<DreamSchedulerState>;
      if (data.lastDreamDate) this.state.lastDreamDate = data.lastDreamDate;
      if (data.lastDreamTimestamp) this.state.lastDreamTimestamp = data.lastDreamTimestamp;
      if (data.totalDreamCycles !== undefined) this.state.totalDreamCycles = data.totalDreamCycles;
      if (data.lastOutcomeSummary) this.state.lastOutcomeSummary = data.lastOutcomeSummary;
    } catch {
      // No state file yet — that's fine, start fresh
    }
  }

  /**
   * Save state to disk.
   */
  private async saveState(): Promise<void> {
    try {
      await fs.mkdir(path.dirname(STATE_PATH), { recursive: true });
      await fs.writeFile(STATE_PATH, JSON.stringify(this.state, null, 2), 'utf-8');
    } catch (err) {
      const tracer = getTracer();
      tracer.log('dream', 'error', `Failed to save state: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/**
 * Format a DreamOutcome into a short summary string.
 */
function formatOutcomeSummary(outcome: DreamOutcome): string {
  const parts: string[] = [];
  parts.push(`${outcome.phasesCompleted.length} phases`);
  if (outcome.fragileFilesFound > 0) parts.push(`${outcome.fragileFilesFound} fragile files`);
  if (outcome.goalsReorganized > 0) parts.push(`${outcome.goalsReorganized} goals reorganized`);
  if (outcome.selfModelRebuilt) parts.push('self-model rebuilt');
  parts.push(`${(outcome.durationMs / 1000).toFixed(0)}s`);
  return parts.join(', ');
}
