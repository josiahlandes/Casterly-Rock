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
 * Nanochat-inspired enhancements:
 *   - Intensity Dial: single parameter (1-10) derives all dream settings
 *   - Phase Progress: phases report progress 0→1 with interruption recovery
 *   - Autoresearch: propose→implement→measure→keep/revert experiments
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
import { deriveFromIntensity, formatIntensitySummary } from '../autonomous/dream/intensity-dial.js';
import type { IntensityDerivedSettings } from '../autonomous/dream/intensity-dial.js';
import { PhaseProgressManager } from '../autonomous/dream/phase-progress.js';
import type { PhaseExecutionSummary } from '../autonomous/dream/phase-progress.js';
import { AutoresearchEngine } from '../autonomous/dream/autoresearch.js';
import type { AutoresearchCycleResult, ChangeApplier, Hypothesis } from '../autonomous/dream/autoresearch.js';
import { safeWriteFile } from '../persistence/safe-write.js';
import { appendActivity } from '../observability/activity-ledger.js';

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

  /**
   * Intensity dial (1-10). When set, overrides intervalHours,
   * minIdleBeforeDreamSeconds, and dream cycle budgets with
   * auto-derived values. Set to 0 or undefined to use explicit settings.
   */
  intensity?: number;

  /** Whether autoresearch experiments are enabled during dream cycles */
  autoresearchEnabled?: boolean;

  /** Whether progress-based phase tracking is enabled */
  phaseProgressEnabled?: boolean;
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

  /** Total autoresearch experiments run */
  totalAutoresearchExperiments: number;

  /** Total autoresearch experiments accepted */
  totalAutoresearchAccepted: number;

  /** Last phase progress summary */
  lastPhaseProgressSummary: string;
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
  private readonly intensitySettings: IntensityDerivedSettings | null;
  private readonly phaseManager: PhaseProgressManager | null;
  private readonly autoresearch: AutoresearchEngine | null;
  private changeApplier: ChangeApplier | null = null;

  private state: DreamSchedulerState = {
    lastDreamDate: '',
    lastDreamTimestamp: '',
    totalDreamCycles: 0,
    lastOutcomeSummary: '',
    totalAutoresearchExperiments: 0,
    totalAutoresearchAccepted: 0,
    lastPhaseProgressSummary: '',
  };

  private checkTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private dreaming = false;
  private preempted = false;
  private idleSince: number | null = null;

  constructor(
    deps: DreamSchedulerDeps,
    config?: Partial<DreamSchedulerConfig>,
  ) {
    const baseConfig = { ...DEFAULT_CONFIG, ...config };

    // Apply intensity dial if set
    if (baseConfig.intensity && baseConfig.intensity >= 1) {
      this.intensitySettings = deriveFromIntensity(baseConfig.intensity);
      // Override scheduler settings from intensity dial
      baseConfig.intervalHours = this.intensitySettings.scheduler.intervalHours ?? baseConfig.intervalHours;
      baseConfig.minIdleBeforeDreamSeconds = this.intensitySettings.scheduler.minIdleBeforeDreamSeconds ?? baseConfig.minIdleBeforeDreamSeconds;
      // Merge dream config from intensity
      baseConfig.dreamConfig = {
        ...baseConfig.dreamConfig,
        ...this.intensitySettings.dream,
      };
      // challengeBudget and promptPopulationSize are stored on intensitySettings
      // and accessible via getIntensitySettings() for subsystems that need them.
    } else {
      this.intensitySettings = null;
    }

    this.config = baseConfig;
    this.deps = deps;
    this.reflector = new Reflector();
    this.runner = new DreamCycleRunner(this.config.dreamConfig);

    // Initialize phase progress manager
    this.phaseManager = baseConfig.phaseProgressEnabled !== false
      ? new PhaseProgressManager({
          defaultPhaseBudgetMs: this.intensitySettings
            ? this.intensitySettings.phaseBudgetSeconds * 1000
            : 300_000,
        })
      : null;

    // Initialize autoresearch engine
    this.autoresearch = baseConfig.autoresearchEnabled !== false
      ? new AutoresearchEngine({
          ...(this.intensitySettings?.autoresearch ?? {}),
          testCommand: baseConfig.testCommand,
          workingDir: baseConfig.workingDir,
        })
      : null;
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

    // Load phase progress state
    if (this.phaseManager) {
      await this.phaseManager.load();
    }

    // Load autoresearch log
    if (this.autoresearch) {
      await this.autoresearch.loadLog();
    }

    tracer.log('dream', 'info', 'Dream scheduler started', {
      intervalHours: this.config.intervalHours,
      lastDreamDate: this.state.lastDreamDate || 'never',
      totalDreamCycles: this.state.totalDreamCycles,
      intensity: this.intensitySettings?.intensity ?? 'manual',
      phaseProgress: !!this.phaseManager,
      autoresearch: !!this.autoresearch,
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
    if (this.intensitySettings) {
      lines.push(`Intensity: ${this.intensitySettings.intensity}/10`);
    }
    lines.push(`Last dream: ${this.state.lastDreamDate || 'never'}`);
    lines.push(`Total cycles: ${this.state.totalDreamCycles}`);
    if (this.state.totalAutoresearchExperiments > 0) {
      lines.push(`Autoresearch: ${this.state.totalAutoresearchAccepted}/${this.state.totalAutoresearchExperiments} accepted`);
    }
    if (this.dreaming) lines.push('Currently dreaming...');
    if (this.state.lastOutcomeSummary) {
      lines.push(`Last outcome: ${this.state.lastOutcomeSummary}`);
    }
    if (this.phaseManager) {
      const phaseProgress = this.phaseManager.getOverallProgress();
      if (phaseProgress > 0 && phaseProgress < 1) {
        lines.push(`Phase progress: ${(phaseProgress * 100).toFixed(0)}%`);
      }
    }
    return lines.join('\n');
  }

  /**
   * Get the intensity dial settings (null if not using intensity dial).
   */
  getIntensitySettings(): Readonly<IntensityDerivedSettings> | null {
    return this.intensitySettings;
  }

  /**
   * Get the phase progress manager (null if disabled).
   */
  getPhaseManager(): PhaseProgressManager | null {
    return this.phaseManager;
  }

  /**
   * Get the autoresearch engine (null if disabled).
   */
  getAutoresearch(): AutoresearchEngine | null {
    return this.autoresearch;
  }

  /**
   * Set the change applier for autoresearch experiments.
   * Until this is called, autoresearch will generate hypotheses but skip
   * the experiment loop.
   */
  setChangeApplier(applier: ChangeApplier): void {
    this.changeApplier = applier;
  }

  /**
   * Signal preemption — stops the current dream cycle gracefully.
   * Propagates to all subsystems: phase manager, autoresearch, and dream runner.
   */
  preempt(): void {
    this.preempted = true;
    if (this.phaseManager) {
      this.phaseManager.preempt();
    }
  }

  // ── Internal ────────────────────────────────────────────────────────────

  /**
   * Execute a dream cycle, followed by CI health check and autoresearch.
   */
  private async runDreamCycle(): Promise<DreamOutcome> {
    const tracer = getTracer();
    this.dreaming = true;

    tracer.log('dream', 'info', '=== Dream cycle starting (dual-loop) ===');
    this.preempted = false;

    try {
      // Reload issue log from disk to pick up externally filed issues
      await this.deps.issueLog.load();

      const outcome = await this.runner.run(
        this.deps.worldModel,
        this.deps.goalStack,
        this.deps.issueLog,
        this.reflector,
        // All optional subsystems — pass undefined to let the runner skip them gracefully
      );

      // Run CI health check: execute tests and file issues for failures
      if (!this.preempted) {
        await this.runCiHealthCheck();
      }

      // Run autoresearch experiments (propose→implement→measure→keep/revert)
      const autoresearchResult = !this.preempted ? await this.runAutoresearch() : null;
      if (autoresearchResult) {
        this.state.totalAutoresearchExperiments += autoresearchResult.experiments.length;
        this.state.totalAutoresearchAccepted += autoresearchResult.acceptedCount;

        const accepted = autoresearchResult.acceptedCount;
        const reverted = autoresearchResult.experiments.length - accepted;
        await appendActivity({
          timestamp: new Date().toISOString(),
          type: 'autoresearch_experiment',
          summary: `${autoresearchResult.experiments.length} experiment(s): ${accepted} accepted, ${reverted} reverted`,
          durationMs: autoresearchResult.totalDurationMs,
          metrics: {
            experiments: autoresearchResult.experiments.length,
            accepted,
            reverted,
          },
        });
      }

      const now = new Date();
      this.state.lastDreamDate = now.toISOString().split('T')[0] ?? '';
      this.state.lastDreamTimestamp = now.toISOString();
      this.state.totalDreamCycles++;
      this.state.lastOutcomeSummary = formatOutcomeSummary(outcome, autoresearchResult);

      await this.saveState();

      // Write detailed dream cycle outcome to ~/.casterly/dreams/YYYY-MM-DD.json
      const dreamDate = this.state.lastDreamDate;
      const dreamsDir = path.join(process.env['HOME'] || '/tmp', '.casterly', 'dreams');
      const dreamPath = path.join(dreamsDir, `${dreamDate}.json`);
      const dreamDetail = {
        date: dreamDate,
        timestamp: now.toISOString(),
        durationMs: outcome.durationMs,
        phasesCompleted: outcome.phasesCompleted,
        phasesSkipped: outcome.phasesSkipped,
        fragileFilesFound: outcome.fragileFilesFound,
        goalsReorganized: outcome.goalsReorganized,
        selfModelRebuilt: outcome.selfModelRebuilt,
        reflectionsConsolidated: outcome.reflectionsConsolidated,
        abandonedFilesFound: outcome.abandonedFilesFound,
        retrospectiveWritten: outcome.retrospectiveWritten,
        ...(autoresearchResult ? {
          autoresearch: {
            experiments: autoresearchResult.experiments.length,
            accepted: autoresearchResult.acceptedCount,
          },
        } : {}),
      };

      try {
        await safeWriteFile(dreamPath, JSON.stringify(dreamDetail, null, 2));
      } catch (writeErr) {
        tracer.log('dream', 'error', `Failed to write dream detail: ${writeErr instanceof Error ? writeErr.message : String(writeErr)}`);
      }

      // Append to activity ledger
      await appendActivity({
        timestamp: now.toISOString(),
        type: 'dream_cycle',
        summary: this.state.lastOutcomeSummary,
        durationMs: outcome.durationMs,
        metrics: {
          phasesCompleted: outcome.phasesCompleted.length,
          phasesSkipped: outcome.phasesSkipped.length,
          fragileFiles: outcome.fragileFilesFound,
          goalsReorganized: outcome.goalsReorganized,
        },
      }).catch((err) => {
        tracer.log('dream', 'warn', `Activity ledger append failed: ${err instanceof Error ? err.message : String(err)}`);
      });

      tracer.log('dream', 'info', '=== Dream cycle complete ===', {
        phasesCompleted: outcome.phasesCompleted,
        phasesSkipped: outcome.phasesSkipped,
        fragileFiles: outcome.fragileFilesFound,
        goalsReorganized: outcome.goalsReorganized,
        autoresearchExperiments: autoresearchResult?.experiments.length ?? 0,
        autoresearchAccepted: autoresearchResult?.acceptedCount ?? 0,
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
   * Run autoresearch experiments during idle dream time.
   *
   * Generates hypotheses from known issues and failing tests,
   * then runs the propose→implement→measure→keep/revert loop.
   */
  private async runAutoresearch(): Promise<AutoresearchCycleResult | null> {
    if (!this.autoresearch) return null;
    if (!this.config.testCommand) return null;

    const tracer = getTracer();
    tracer.log('dream', 'info', 'Running autoresearch experiments');

    try {
      // Generate hypotheses from known issues
      const hypotheses = this.generateHypotheses();
      if (hypotheses.length === 0) {
        tracer.log('dream', 'info', 'No autoresearch hypotheses — codebase looks healthy');
        return null;
      }

      // Create a test runner that uses the CI loop's test runner
      const testRunner = async (command: string, cwd: string) => {
        return runTests({ command, cwd, timeoutMs: this.autoresearch!.getConfig().testTimeoutMs });
      };

      // Autoresearch requires a real change applier (LLM-driven code modification).
      // Until the DeepLoop's LLM providers are integrated, we skip the experiment
      // loop and only log that hypotheses were generated for future processing.
      if (!this.changeApplier) {
        tracer.log('dream', 'info',
          `Autoresearch: ${hypotheses.length} hypothesis(es) ready but change applier not wired — skipping experiments`);
        return null;
      }

      return await this.autoresearch.runCycle(hypotheses, testRunner, this.changeApplier);
    } catch (err) {
      tracer.log('dream', 'warn', `Autoresearch failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  /**
   * Generate hypotheses from the issue log and test failures.
   */
  private generateHypotheses(): Hypothesis[] {
    const hypotheses: Hypothesis[] = [];

    // From issue log: test failures
    const openIssues = this.deps.issueLog.getOpenIssues();
    for (const issue of openIssues.slice(0, 5)) {
      if (issue.tags?.includes('test-failure')) {
        hypotheses.push({
          id: `hyp-${issue.id}`,
          title: `Fix: ${issue.title}`,
          description: issue.description,
          targetFiles: issue.relatedFiles ?? [],
          expectedOutcome: 'Test passes after fix',
          source: 'test-failure',
        });
      } else if (issue.tags?.includes('fragile')) {
        hypotheses.push({
          id: `hyp-${issue.id}`,
          title: `Refactor: ${issue.title}`,
          description: issue.description,
          targetFiles: issue.relatedFiles ?? [],
          expectedOutcome: 'Reduced fragility score',
          source: 'fragile-code',
        });
      }
    }

    return hypotheses;
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

        // Log to activity ledger
        await appendActivity({
          timestamp: new Date().toISOString(),
          type: 'issue_filed',
          summary: `Filed ${newIssues} issue(s) for ${failingTests.length} failing test(s)`,
          metrics: { newIssues, totalFailing: failingTests.length },
        }).catch(() => { /* best-effort */ });
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
      const dataAny = data as Record<string, unknown>;
      if (typeof dataAny['totalAutoresearchExperiments'] === 'number') {
        this.state.totalAutoresearchExperiments = dataAny['totalAutoresearchExperiments'];
      }
      if (typeof dataAny['totalAutoresearchAccepted'] === 'number') {
        this.state.totalAutoresearchAccepted = dataAny['totalAutoresearchAccepted'];
      }
      if (typeof dataAny['lastPhaseProgressSummary'] === 'string') {
        this.state.lastPhaseProgressSummary = dataAny['lastPhaseProgressSummary'];
      }
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
function formatOutcomeSummary(
  outcome: DreamOutcome,
  autoresearchResult?: AutoresearchCycleResult | null,
): string {
  const parts: string[] = [];
  parts.push(`${outcome.phasesCompleted.length} phases`);
  if (outcome.fragileFilesFound > 0) parts.push(`${outcome.fragileFilesFound} fragile files`);
  if (outcome.goalsReorganized > 0) parts.push(`${outcome.goalsReorganized} goals reorganized`);
  if (outcome.selfModelRebuilt) parts.push('self-model rebuilt');
  if (autoresearchResult && autoresearchResult.experiments.length > 0) {
    parts.push(`autoresearch: ${autoresearchResult.acceptedCount}/${autoresearchResult.experiments.length} accepted`);
  }
  parts.push(`${(outcome.durationMs / 1000).toFixed(0)}s`);
  return parts.join(', ');
}
