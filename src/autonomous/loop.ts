/**
 * Autonomous Self-Improvement Loop
 *
 * Main daemon that runs the continuous improvement cycle:
 * analyze → hypothesize → implement → validate → integrate → reflect
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as yaml from 'yaml';

import { createProvider, type AutonomousProvider } from './provider.js';
import { Analyzer } from './analyzer.js';
import { GitOperations } from './git.js';
import { Validator, buildInvariants } from './validator.js';
import { Reflector, type MemoryEntry } from './reflector.js';
import type {
  AutonomousConfig,
  CycleMetrics,
  CycleOutcome,
  Hypothesis,
  Implementation,
  Observation,
} from './types.js';

// ============================================================================
// CONSTANTS
// ============================================================================

const DEFAULT_CONFIG_PATH = 'config/autonomous.yaml';
const CYCLE_ID_PREFIX = 'cycle';

// ============================================================================
// AUTONOMOUS LOOP
// ============================================================================

export class AutonomousLoop {
  private readonly config: AutonomousConfig;
  private readonly projectRoot: string;
  private readonly provider: AutonomousProvider;
  private readonly analyzer: Analyzer;
  private readonly git: GitOperations;
  private readonly validator: Validator;
  private readonly reflector: Reflector;

  private cycleCount: number = 0;
  private dailyCycleCount: number = 0;
  private lastResetDate: string = '';
  private running: boolean = false;

  constructor(
    config: AutonomousConfig,
    projectRoot: string,
    provider: AutonomousProvider
  ) {
    this.config = config;
    this.projectRoot = projectRoot;
    this.provider = provider;

    this.analyzer = new Analyzer(projectRoot);
    this.git = new GitOperations(projectRoot, config.git);
    this.validator = new Validator(projectRoot, {
      invariants: buildInvariants(config),
    });
    this.reflector = new Reflector({ projectRoot });
  }

  /**
   * Start the autonomous improvement loop.
   */
  async start(): Promise<void> {
    if (this.running) {
      throw new Error('Loop is already running');
    }

    this.running = true;
    this.log('Starting autonomous improvement loop');
    this.log(`Provider: ${this.provider.name}, Model: ${this.provider.model}`);
    this.log(`Cycle interval: ${this.config.cycleIntervalMinutes} minutes`);
    this.log(`Max cycles per day: ${this.config.maxCyclesPerDay}`);

    while (this.running) {
      try {
        // Check if we should run
        if (!this.shouldRunCycle()) {
          await this.sleep(60_000); // Check again in 1 minute
          continue;
        }

        // Run a cycle
        await this.runCycle();

        // Sleep until next cycle
        await this.sleep(this.config.cycleIntervalMinutes * 60_000);
      } catch (error) {
        this.log(`Error in loop: ${error instanceof Error ? error.message : String(error)}`, 'ERROR');
        // Continue running despite errors
        await this.sleep(60_000);
      }
    }

    this.log('Autonomous improvement loop stopped');
  }

  /**
   * Stop the loop gracefully.
   */
  stop(): void {
    this.log('Stopping autonomous improvement loop...');
    this.running = false;
  }

  /**
   * Check if we should run a cycle right now.
   */
  private shouldRunCycle(): boolean {
    // Reset daily count if needed
    const todayParts = new Date().toISOString().split('T');
    const today = todayParts[0] ?? '';
    if (today !== this.lastResetDate) {
      this.dailyCycleCount = 0;
      this.lastResetDate = today;
    }

    // Check daily limit
    if (this.dailyCycleCount >= this.config.maxCyclesPerDay) {
      this.log('Daily cycle limit reached', 'INFO');
      return false;
    }

    // Check quiet hours
    if (this.config.quietHours?.enabled) {
      const now = new Date();
      const hours = now.getHours();
      const minutes = now.getMinutes();
      const currentTime = hours * 60 + minutes;

      const startParts = this.config.quietHours.start.split(':').map(Number);
      const endParts = this.config.quietHours.end.split(':').map(Number);
      const startHour = startParts[0] ?? 0;
      const startMin = startParts[1] ?? 0;
      const endHour = endParts[0] ?? 0;
      const endMin = endParts[1] ?? 0;
      const startTime = startHour * 60 + startMin;
      const endTime = endHour * 60 + endMin;

      if (currentTime >= startTime && currentTime < endTime) {
        return false; // In quiet hours
      }
    }

    // Check budget (API phase)
    if (this.config.budget) {
      // TODO: Implement budget checking
    }

    return true;
  }

  /**
   * Run a single improvement cycle.
   */
  async runCycle(): Promise<void> {
    this.cycleCount++;
    this.dailyCycleCount++;

    const cycleId = this.generateCycleId();
    const startTime = new Date();

    this.log(`=== Starting cycle ${cycleId} ===`, 'CYCLE');

    // Reset token usage for this cycle
    this.provider.resetTokenUsage();

    const metrics: CycleMetrics = {
      cycleId,
      startTime: startTime.toISOString(),
      observationsFound: 0,
      hypothesesGenerated: 0,
      hypothesesAttempted: 0,
      hypothesesSucceeded: 0,
      tokensUsed: { input: 0, output: 0 },
    };

    try {
      // 1. ANALYZE
      this.log('Phase 1: Analyzing codebase...', 'INFO');
      await this.git.fetchLatest();
      await this.git.checkoutBase();

      const context = await this.analyzer.gatherContext();
      const analyzeResult = await this.provider.analyze(context);

      metrics.observationsFound = analyzeResult.observations.length;
      this.log(`Found ${analyzeResult.observations.length} observations`, 'INFO');

      if (analyzeResult.observations.length === 0) {
        this.log('No observations found, skipping cycle', 'INFO');
        return;
      }

      // 2. HYPOTHESIZE
      this.log('Phase 2: Generating hypotheses...', 'INFO');
      const hypothesizeResult = await this.provider.hypothesize(analyzeResult.observations);

      metrics.hypothesesGenerated = hypothesizeResult.hypotheses.length;
      this.log(`Generated ${hypothesizeResult.hypotheses.length} hypotheses`, 'INFO');

      // Filter hypotheses by confidence threshold
      const viableHypotheses = hypothesizeResult.hypotheses.filter(
        (h) => h.confidence >= this.config.attemptThreshold
      );

      if (viableHypotheses.length === 0) {
        this.log('No viable hypotheses (all below confidence threshold)', 'INFO');
        return;
      }

      // 3. ATTEMPT HYPOTHESES
      const maxAttempts = Math.min(viableHypotheses.length, this.config.maxAttemptsPerCycle);

      for (let i = 0; i < maxAttempts; i++) {
        const hypothesis = viableHypotheses[i];
        if (!hypothesis) continue;

        metrics.hypothesesAttempted++;

        this.log(`Attempting hypothesis ${i + 1}/${maxAttempts}: ${hypothesis.proposal}`, 'INFO');

        const success = await this.attemptHypothesis(cycleId, hypothesis, context);

        if (success) {
          metrics.hypothesesSucceeded++;
          this.log(`Hypothesis succeeded!`, 'SUCCESS');
        } else {
          this.log(`Hypothesis failed`, 'FAILURE');
        }
      }

      // 4. UPDATE METRICS
      const endTime = new Date();
      metrics.endTime = endTime.toISOString();
      metrics.durationMs = endTime.getTime() - startTime.getTime();
      metrics.tokensUsed = this.provider.getTokenUsage();

      if ('estimateCostUsd' in this.provider) {
        metrics.estimatedCostUsd = (this.provider as { estimateCostUsd: () => number }).estimateCostUsd();
      }

      await this.reflector.logMetrics(metrics);

      this.log(
        `=== Cycle ${cycleId} complete: ${metrics.hypothesesSucceeded}/${metrics.hypothesesAttempted} succeeded ===`,
        'CYCLE'
      );
    } catch (error) {
      this.log(`Cycle ${cycleId} failed: ${error instanceof Error ? error.message : String(error)}`, 'ERROR');

      // Make sure we're back on main
      try {
        await this.git.checkoutBase();
      } catch {
        // Ignore
      }
    }
  }

  /**
   * Attempt a single hypothesis.
   */
  private async attemptHypothesis(
    cycleId: string,
    hypothesis: Hypothesis,
    analysisContext: Awaited<ReturnType<Analyzer['gatherContext']>>
  ): Promise<boolean> {
    let branch: string | null = null;
    let implementation: Implementation | undefined;
    let outcome: CycleOutcome = 'failure';

    try {
      // Create branch
      branch = await this.git.createBranch(hypothesis.id);
      this.log(`Created branch: ${branch}`, 'INFO');

      // Load files needed for implementation
      const fileContents = await this.analyzer.readFiles(hypothesis.affectedFiles);
      const availableFiles = await this.analyzer.listFiles();

      // Implement
      this.log('Implementing changes...', 'INFO');
      const implementResult = await this.provider.implement(hypothesis, {
        fileContents,
        availableFiles,
      });

      if (implementResult.changes.length === 0) {
        this.log('No changes generated', 'WARN');
        await this.git.revert(branch);
        return false;
      }

      // Apply changes
      await this.git.applyChanges(implementResult.changes);

      // Commit
      const commitHash = await this.git.commit(implementResult.commitMessage);
      this.log(`Committed: ${commitHash.substring(0, 8)}`, 'INFO');

      implementation = {
        hypothesisId: hypothesis.id,
        branch,
        commitHash,
        changes: implementResult.changes,
        description: implementResult.description,
        timestamp: new Date().toISOString(),
      };

      // Push
      await this.git.push(branch);
      this.log(`Pushed to ${this.config.git.remote}/${branch}`, 'INFO');

      // Validate
      this.log('Validating changes...', 'INFO');
      const validation = await this.validator.validate();

      if (!validation.passed) {
        this.log(`Validation failed: ${validation.errors.join(', ')}`, 'WARN');
        await this.git.revert(branch);
        outcome = 'failure';

        // Reflect on failure
        await this.reflectAndSave(cycleId, hypothesis, implementation, validation.errors, outcome, false);
        return false;
      }

      this.log('Validation passed!', 'INFO');

      // Integrate
      this.log('Integrating changes...', 'INFO');
      const integrationResult = await this.git.integrate(branch);

      if (!integrationResult.success) {
        this.log(`Integration failed: ${integrationResult.error}`, 'WARN');
        await this.git.revert(branch);
        outcome = 'failure';

        await this.reflectAndSave(
          cycleId,
          hypothesis,
          implementation,
          [integrationResult.error || 'Integration failed'],
          outcome,
          false
        );
        return false;
      }

      outcome = 'success';
      this.log(
        `Integrated via ${integrationResult.mode}${integrationResult.pullRequestUrl ? `: ${integrationResult.pullRequestUrl}` : ''}`,
        'INFO'
      );

      // Reflect on success
      await this.reflectAndSave(cycleId, hypothesis, implementation, [], outcome, true);

      // Add to MEMORY.md if significant
      if (hypothesis.expectedImpact === 'high' || hypothesis.confidence >= 0.9) {
        await this.reflector.appendToMemory({
          cycleId,
          title: hypothesis.proposal,
          content: `**Approach**: ${hypothesis.approach}\n**Files changed**: ${hypothesis.affectedFiles.join(', ')}\n\n${implementation.description}`,
        });
      }

      return true;
    } catch (error) {
      this.log(`Error attempting hypothesis: ${error instanceof Error ? error.message : String(error)}`, 'ERROR');

      if (branch) {
        try {
          await this.git.revert(branch);
        } catch {
          // Ignore revert errors
        }
      }

      outcome = 'failure';
      await this.reflectAndSave(
        cycleId,
        hypothesis,
        implementation,
        [error instanceof Error ? error.message : String(error)],
        outcome,
        false
      );

      return false;
    }
  }

  /**
   * Reflect on a hypothesis attempt and save the reflection.
   */
  private async reflectAndSave(
    cycleId: string,
    hypothesis: Hypothesis,
    implementation: Implementation | undefined,
    errors: string[],
    outcome: CycleOutcome,
    integrated: boolean
  ): Promise<void> {
    try {
      const reflectResult = await this.provider.reflect({
        cycleId,
        observation: hypothesis.observation,
        hypothesis,
        implementation,
        validationPassed: outcome === 'success',
        validationErrors: errors,
        integrated,
        outcome,
      });

      await this.reflector.saveReflection(reflectResult.reflection);
    } catch (error) {
      this.log(`Failed to save reflection: ${error instanceof Error ? error.message : String(error)}`, 'WARN');
    }
  }

  // --------------------------------------------------------------------------
  // HELPERS
  // --------------------------------------------------------------------------

  private generateCycleId(): string {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    return `${CYCLE_ID_PREFIX}-${timestamp}-${this.cycleCount}`;
  }

  private log(message: string, level: string = 'INFO'): void {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] [${level}] ${message}`);
  }

  private async sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// ============================================================================
// MAIN ENTRY POINT
// ============================================================================

async function loadConfig(configPath: string): Promise<AutonomousConfig> {
  const content = await fs.readFile(configPath, 'utf-8');
  const raw = yaml.parse(content);

  // Convert from YAML structure to config object
  return {
    enabled: raw.autonomous?.enabled ?? false,
    provider: 'ollama',
    model: raw.autonomous?.model ?? 'qwen3-coder-next:latest',
    cycleIntervalMinutes: raw.autonomous?.cycle_interval_minutes ?? 60,
    maxCyclesPerDay: raw.autonomous?.max_cycles_per_day ?? 12,
    quietHours: raw.autonomous?.quiet_hours
      ? {
          start: raw.autonomous.quiet_hours.start,
          end: raw.autonomous.quiet_hours.end,
          enabled: raw.autonomous.quiet_hours.enabled ?? false,
        }
      : undefined,
    maxAttemptsPerCycle: raw.autonomous?.max_attempts_per_cycle ?? 3,
    maxFilesPerChange: raw.autonomous?.max_files_per_change ?? 5,
    allowedDirectories: raw.autonomous?.allowed_directories ?? ['src/', 'scripts/', 'tests/'],
    forbiddenPatterns: raw.autonomous?.forbidden_patterns ?? ['**/*.env*', '**/secrets*'],
    autoIntegrateThreshold: raw.autonomous?.auto_integrate_threshold ?? 0.9,
    attemptThreshold: raw.autonomous?.attempt_threshold ?? 0.5,
    maxBranchAgeHours: raw.autonomous?.max_branch_age_hours ?? 24,
    maxConcurrentBranches: raw.autonomous?.max_concurrent_branches ?? 3,
    sandboxTimeoutSeconds: raw.autonomous?.sandbox_timeout_seconds ?? 300,
    sandboxMemoryMb: raw.autonomous?.sandbox_memory_mb ?? 2048,
    budget: raw.autonomous?.budget
      ? {
          dailyLimitUsd: raw.autonomous.budget.daily_limit_usd ?? 10,
          monthlyLimitUsd: raw.autonomous.budget.monthly_limit_usd ?? 200,
          alertThreshold: raw.autonomous.budget.alert_threshold ?? 0.8,
        }
      : undefined,
    git: {
      remote: raw.git?.remote ?? 'origin',
      baseBranch: raw.git?.base_branch ?? 'main',
      branchPrefix: raw.git?.branch_prefix ?? 'auto/',
      integrationMode: raw.git?.integration_mode ?? 'direct',
      pullRequest: raw.git?.pull_request
        ? {
            autoMerge: raw.git.pull_request.auto_merge ?? true,
            requireCi: raw.git.pull_request.require_ci ?? true,
            labels: raw.git.pull_request.labels ?? ['autonomous'],
            reviewers: raw.git.pull_request.reviewers ?? [],
            draft: raw.git.pull_request.draft ?? false,
          }
        : undefined,
      cleanup: {
        deleteMergedBranches: raw.git?.cleanup?.delete_merged_branches ?? true,
        deleteFailedBranches: raw.git?.cleanup?.delete_failed_branches ?? true,
        maxStaleBranchAgeHours: raw.git?.cleanup?.max_stale_branch_age_hours ?? 48,
      },
    },
  };
}

export async function main(): Promise<void> {
  const projectRoot = process.cwd();
  const configPath = path.join(projectRoot, DEFAULT_CONFIG_PATH);

  console.log('Loading configuration...');
  const config = await loadConfig(configPath);

  if (!config.enabled) {
    console.log('Autonomous improvement is disabled in config. Set enabled: true to start.');
    process.exit(0);
  }

  console.log('Creating provider...');
  const provider = await createProvider(config);

  console.log('Starting autonomous loop...');
  const loop = new AutonomousLoop(config, projectRoot, provider);

  // Handle shutdown signals
  process.on('SIGINT', () => {
    console.log('\nReceived SIGINT, stopping...');
    loop.stop();
  });

  process.on('SIGTERM', () => {
    console.log('\nReceived SIGTERM, stopping...');
    loop.stop();
  });

  await loop.start();
}

// Run if executed directly
if (process.argv[1]?.endsWith('loop.ts') || process.argv[1]?.endsWith('loop.js')) {
  main().catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}
