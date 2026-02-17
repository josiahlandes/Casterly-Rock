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
import type { ApprovalBridge } from '../approval/index.js';
import type {
  AutonomousConfig,
  CycleMetrics,
  CycleOutcome,
  Hypothesis,
  Implementation,
  Observation,
  PendingBranch,
} from './types.js';

// Phase 2: Agent Loop imports
import { AgentLoop, createAgentLoop } from './agent-loop.js';
import type { AgentTrigger, AgentLoopConfig, AgentOutcome } from './agent-loop.js';
import { buildAgentToolkit } from './agent-tools.js';
import type { AgentToolkit, AgentState } from './agent-tools.js';
import { WorldModel } from './world-model.js';
import { GoalStack } from './goal-stack.js';
import { IssueLog } from './issue-log.js';
import { getTracer } from './debug.js';

// Phase 3: Event-Driven Awareness imports
import { ContextManager, createContextManager } from './context-manager.js';
import type { ContextManagerConfig } from './context-manager.js';
import { EventBus, type SystemEvent } from './events.js';
import type { EventBusConfig } from './events.js';
import { FileWatcher } from './watchers/file-watcher.js';
import { GitWatcher } from './watchers/git-watcher.js';
import { IssueWatcher } from './watchers/issue-watcher.js';
import type { FileWatcherConfig } from './watchers/file-watcher.js';
import type { GitWatcherConfig } from './watchers/git-watcher.js';
import type { IssueWatcherConfig } from './watchers/issue-watcher.js';

// Phase 5: Reasoning scaling
import { ReasoningScaler } from './reasoning/scaling.js';

// Phase 6: Dream cycles and self-model
import { DreamCycleRunner } from './dream/runner.js';
import type { SelfModelSummary } from './identity.js';

// ============================================================================
// CONSTANTS
// ============================================================================

const DEFAULT_CONFIG_PATH = 'config/autonomous.yaml';
const CYCLE_ID_PREFIX = 'cycle';

// ============================================================================
// PHASE 3: EVENTS CONFIGURATION
// ============================================================================

/**
 * Configuration for the event-driven awareness system.
 */
export interface EventsConfig {
  /** Whether the event system is enabled */
  enabled: boolean;

  /** File watcher config overrides */
  fileWatcher: Partial<FileWatcherConfig> & { enabled: boolean };

  /** Git watcher config overrides */
  gitWatcher: Partial<GitWatcherConfig> & { enabled: boolean };

  /** Issue watcher config overrides */
  issueWatcher: Partial<IssueWatcherConfig> & { enabled: boolean };

  /** Minimum seconds between agent cycles (cooldown) */
  cooldownSeconds: number;

  /** Maximum agent turns per day across all cycles */
  dailyBudgetTurns: number;
}

const DEFAULT_EVENTS_CONFIG: EventsConfig = {
  enabled: false,
  fileWatcher: { enabled: true, debounceMs: 500 },
  gitWatcher: { enabled: true, debounceMs: 1000 },
  issueWatcher: { enabled: true, checkIntervalMs: 6 * 60 * 60 * 1000 },
  cooldownSeconds: 30,
  dailyBudgetTurns: 500,
};

// ============================================================================
// AUTONOMOUS LOOP
// ============================================================================

/** Options for wiring the loop into the daemon */
export interface LoopOptions {
  /** Approval bridge for integration_mode: approval_required */
  approvalBridge?: ApprovalBridge | undefined;
  /** iMessage recipient for approval requests (owner's phone or Apple ID) */
  approvalRecipient?: string | undefined;
}

export class AutonomousLoop {
  private readonly config: AutonomousConfig;
  private readonly projectRoot: string;
  private readonly provider: AutonomousProvider;
  private readonly analyzer: Analyzer;
  private readonly git: GitOperations;
  private readonly validator: Validator;
  private readonly reflector: Reflector;
  private readonly approvalBridge?: ApprovalBridge | undefined;
  private readonly approvalRecipient?: string | undefined;

  private cycleCount: number = 0;
  private dailyCycleCount: number = 0;
  private lastResetDate: string = '';
  private running: boolean = false;
  private readonly _pendingBranches: PendingBranch[] = [];

  /** Exposed for daemon-controlled mode (controller.ts) */
  get reflectorInstance(): Reflector { return this.reflector; }
  get configInstance(): AutonomousConfig { return this.config; }
  get gitInstance(): GitOperations { return this.git; }
  get pendingBranchList(): PendingBranch[] { return [...this._pendingBranches]; }
  get dreamCycleRunnerInstance(): DreamCycleRunner { return this.dreamCycleRunner; }
  get reasoningScalerInstance(): ReasoningScaler { return this.reasoningScaler; }

  // Phase 2: Agent loop state
  private worldModel: WorldModel;
  private goalStack: GoalStack;
  private issueLog: IssueLog;
  private agentToolkit: AgentToolkit | null = null;
  private activeAgentLoop: AgentLoop | null = null;
  private agentConfig: Partial<AgentLoopConfig>;
  private useAgentLoop: boolean = false;

  // Phase 4: Tiered memory
  private contextManager: ContextManager;

  // Phase 5: Reasoning scaling
  private reasoningScaler: ReasoningScaler;

  // Phase 6: Dream cycles and self-model
  private dreamCycleRunner: DreamCycleRunner;
  private lastDreamCycleDate: string = '';
  private selfModelSummary: SelfModelSummary | null = null;

  // Phase 3: Event-driven awareness
  private eventBus: EventBus;
  private fileWatcher: FileWatcher | null = null;
  private gitWatcher: GitWatcher | null = null;
  private issueWatcher: IssueWatcher | null = null;
  private lastCycleEndMs: number = 0;
  private dailyTurnCount: number = 0;
  private eventsConfig: EventsConfig;

  constructor(
    config: AutonomousConfig,
    projectRoot: string,
    provider: AutonomousProvider,
    options?: LoopOptions,
    agentConfig?: Partial<AgentLoopConfig> & { enabled?: boolean },
    eventsConfig?: Partial<EventsConfig>,
  ) {
    this.config = config;
    this.projectRoot = projectRoot;
    this.provider = provider;
    this.approvalBridge = options?.approvalBridge;
    this.approvalRecipient = options?.approvalRecipient;

    this.analyzer = new Analyzer(projectRoot, config.backlogPath ? {
      backlogPath: config.backlogPath,
    } : undefined);
    this.git = new GitOperations(projectRoot, config.git);
    this.validator = new Validator(projectRoot, {
      invariants: buildInvariants(config),
    });
    this.reflector = new Reflector({ projectRoot });

    // Phase 2: Initialize persistent state
    this.worldModel = new WorldModel({ projectRoot });
    this.goalStack = new GoalStack();
    this.issueLog = new IssueLog();
    this.agentConfig = agentConfig ?? {};
    this.useAgentLoop = agentConfig?.enabled ?? false;

    // Phase 3: Initialize event system
    this.eventsConfig = { ...DEFAULT_EVENTS_CONFIG, ...eventsConfig };
    this.eventBus = new EventBus({
      maxQueueSize: 100,
      logEvents: true,
    });

    // Phase 4: Initialize tiered memory
    this.contextManager = createContextManager();

    // Phase 5: Initialize reasoning scaler
    const scalerOpts: Partial<{ codingModel: string; reasoningModel: string }> = {};
    if (agentConfig?.codingModel) scalerOpts.codingModel = agentConfig.codingModel;
    if (agentConfig?.reasoningModel) scalerOpts.reasoningModel = agentConfig.reasoningModel;
    this.reasoningScaler = new ReasoningScaler(scalerOpts);

    // Phase 6: Initialize dream cycle runner
    this.dreamCycleRunner = new DreamCycleRunner({
      projectRoot,
    });
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
          // During quiet hours, run dream cycle once per night
          await this.runDreamCycleIfDue();
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

    return true;
  }

  /**
   * Run a single improvement cycle.
   *
   * When called from the daemon controller, pass an AbortSignal so the
   * cycle can be interrupted between phases if a user message arrives.
   */
  async runCycle(signal?: AbortSignal): Promise<void> {
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
      this.checkAborted(signal, cycleId);
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
      this.checkAborted(signal, cycleId);
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

      // Priority sort: backlog P1-P2 items first, then by confidence * impact
      const impactScore: Record<string, number> = { low: 1, medium: 2, high: 3 };
      viableHypotheses.sort((a, b) => {
        const aIsBacklogHighPri =
          a.observation.source === 'backlog' &&
          ((a.observation.context['priority'] as number) ?? 5) <= 2;
        const bIsBacklogHighPri =
          b.observation.source === 'backlog' &&
          ((b.observation.context['priority'] as number) ?? 5) <= 2;

        if (aIsBacklogHighPri && !bIsBacklogHighPri) return -1;
        if (!aIsBacklogHighPri && bIsBacklogHighPri) return 1;

        return (
          b.confidence * (impactScore[b.expectedImpact] ?? 1) -
          a.confidence * (impactScore[a.expectedImpact] ?? 1)
        );
      });

      // 3. ATTEMPT HYPOTHESES
      const maxAttempts = Math.min(viableHypotheses.length, this.config.maxAttemptsPerCycle);

      for (let i = 0; i < maxAttempts; i++) {
        this.checkAborted(signal, cycleId);

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
      // Re-throw AbortError so the controller can handle it cleanly
      if (error instanceof AbortError) {
        throw error;
      }

      this.log(`Cycle ${cycleId} failed: ${error instanceof Error ? error.message : String(error)}`, 'ERROR');

      // Make sure we're back on main
      try {
        await this.git.checkoutBase();
      } catch {
        // Ignore
      }
    }
  }

  // ── Phase 2: Agent Loop Cycle ─────────────────────────────────────────────

  /**
   * Load persistent state from disk. Called at the start of the loop
   * and before each agent cycle.
   */
  async loadState(): Promise<void> {
    const tracer = getTracer();
    tracer.log('agent-loop', 'debug', 'Loading persistent state');
    await Promise.all([
      this.worldModel.load(),
      this.goalStack.load(),
      this.issueLog.load(),
    ]);
  }

  /**
   * Save persistent state to disk. Called after each agent cycle.
   */
  async saveState(): Promise<void> {
    const tracer = getTracer();
    tracer.log('agent-loop', 'debug', 'Saving persistent state');
    await Promise.all([
      this.worldModel.save(),
      this.goalStack.save(),
      this.issueLog.save(),
    ]);
  }

  /**
   * Determine the trigger for an agent cycle. Checks:
   *   1. Is there a goal in progress? Continue it.
   *   2. Is there a pending goal? Start it.
   *   3. Default to scheduled.
   */
  private determineTrigger(): AgentTrigger {
    const nextGoal = this.goalStack.getNextGoal();
    if (nextGoal) {
      return { type: 'goal', goal: nextGoal };
    }
    return { type: 'scheduled' };
  }

  /**
   * Abort the currently running agent cycle. Used when a user message
   * arrives and should preempt autonomous work.
   */
  abortAgentCycle(): void {
    if (this.activeAgentLoop) {
      this.activeAgentLoop.abort();
    }
  }

  /**
   * Get references to the persistent state (for external access).
   */
  getState(): { worldModel: WorldModel; goalStack: GoalStack; issueLog: IssueLog } {
    return {
      worldModel: this.worldModel,
      goalStack: this.goalStack,
      issueLog: this.issueLog,
    };
  }

  /**
   * Check if the abort signal has fired and throw if so.
   */
  private checkAborted(signal: AbortSignal | undefined, cycleId: string): void {
    if (signal?.aborted) {
      this.log(`Cycle ${cycleId} aborted by controller`, 'WARN');
      throw new AbortError(cycleId);
    }
  }

  /**
   * Get the event bus (for external event emission).
   */
  getEventBus(): EventBus {
    return this.eventBus;
  }

  // ── Phase 3: Event-Driven Awareness ───────────────────────────────────

  /**
   * Start all watchers and the event-driven loop.
   * Call this instead of (or alongside) start() when event mode is enabled.
   */
  async startEventDriven(): Promise<void> {
    const tracer = getTracer();

    if (!this.eventsConfig.enabled) {
      tracer.log('events', 'info', 'Event-driven mode is disabled');
      return;
    }

    tracer.log('events', 'info', 'Starting event-driven mode');

    // Load persistent state first
    await this.loadState();

    // Start watchers
    await this.startWatchers();

    // Wire up the event bus to trigger agent cycles
    this.eventBus.onAny((event) => {
      this.handleEvent(event).catch((err) => {
        tracer.log('events', 'error', 'Event handler error', {
          eventType: event.type,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    });

    tracer.log('events', 'info', 'Event-driven mode started');
  }

  /**
   * Stop all watchers and the event-driven loop.
   */
  stopEventDriven(): void {
    const tracer = getTracer();
    this.stopWatchers();
    this.eventBus.reset();
    tracer.log('events', 'info', 'Event-driven mode stopped');
  }

  /**
   * Start individual watchers based on config.
   */
  private async startWatchers(): Promise<void> {
    const tracer = getTracer();

    if (this.eventsConfig.fileWatcher.enabled) {
      this.fileWatcher = new FileWatcher(this.eventBus, {
        projectRoot: this.projectRoot,
        ...this.eventsConfig.fileWatcher,
      });
      await this.fileWatcher.start();
    }

    if (this.eventsConfig.gitWatcher.enabled) {
      this.gitWatcher = new GitWatcher(this.eventBus, {
        projectRoot: this.projectRoot,
        ...this.eventsConfig.gitWatcher,
      });
      await this.gitWatcher.start();
    }

    if (this.eventsConfig.issueWatcher.enabled) {
      this.issueWatcher = new IssueWatcher(this.eventBus, this.issueLog, {
        ...this.eventsConfig.issueWatcher,
      });
      this.issueWatcher.start();
    }

    tracer.log('events', 'info', 'Watchers started', {
      fileWatcher: this.fileWatcher?.isRunning() ?? false,
      gitWatcher: this.gitWatcher?.isRunning() ?? false,
      issueWatcher: this.issueWatcher?.isRunning() ?? false,
    });
  }

  /**
   * Stop all watchers.
   */
  private stopWatchers(): void {
    this.fileWatcher?.stop();
    this.fileWatcher = null;
    this.gitWatcher?.stop();
    this.gitWatcher = null;
    this.issueWatcher?.stop();
    this.issueWatcher = null;
  }

  /**
   * Handle an incoming event. Decides whether to trigger an agent cycle
   * based on cooldown, budget, and whether a cycle is already running.
   */
  private async handleEvent(event: SystemEvent): Promise<void> {
    const tracer = getTracer();

    // Check if agent loop is enabled
    if (!this.useAgentLoop) {
      tracer.log('events', 'debug', `Event ${event.type} ignored (agent loop disabled)`);
      return;
    }

    // Check if a cycle is already running
    if (this.activeAgentLoop !== null) {
      // User messages abort the current cycle
      if (event.type === 'user_message') {
        tracer.log('events', 'info', 'User message received — aborting current cycle');
        this.abortAgentCycle();
      } else {
        tracer.log('events', 'debug', `Event ${event.type} queued (cycle in progress)`);
      }
      return;
    }

    // Check cooldown
    const nowMs = Date.now();
    const cooldownMs = this.eventsConfig.cooldownSeconds * 1000;
    if (nowMs - this.lastCycleEndMs < cooldownMs) {
      tracer.log('events', 'debug', `Event ${event.type} deferred (cooldown active)`);
      return;
    }

    // Check daily turn budget
    if (this.dailyTurnCount >= this.eventsConfig.dailyBudgetTurns) {
      tracer.log('events', 'warn', `Daily turn budget exhausted (${this.dailyTurnCount}/${this.eventsConfig.dailyBudgetTurns})`);
      return;
    }

    // Build trigger from event
    const trigger = this.buildTriggerFromEvent(event);

    tracer.log('events', 'info', `Triggering agent cycle from ${event.type}`);

    // Run the agent cycle
    const outcome = await this.runAgentCycle(trigger);

    // Update budgets
    this.lastCycleEndMs = Date.now();
    this.dailyTurnCount += outcome.totalTurns;
  }

  /**
   * Convert a SystemEvent into an AgentTrigger for the agent loop.
   */
  private buildTriggerFromEvent(event: SystemEvent): AgentTrigger {
    switch (event.type) {
      case 'user_message':
        return { type: 'user', message: event.message, sender: event.sender };

      case 'test_failed':
      case 'build_error':
      case 'file_changed':
      case 'git_push':
      case 'issue_stale':
        return {
          type: 'event',
          event: {
            kind: event.type,
            description: this.describeEvent(event),
            timestamp: event.timestamp,
          },
        };

      case 'scheduled':
        return { type: 'scheduled' };
    }
  }

  /**
   * Generate a human-readable description of an event.
   */
  private describeEvent(event: SystemEvent): string {
    switch (event.type) {
      case 'file_changed':
        return `${event.paths.length} files ${event.changeKind}: ${event.paths.slice(0, 3).join(', ')}${event.paths.length > 3 ? '...' : ''}`;
      case 'test_failed':
        return `Test failed: ${event.testName}`;
      case 'git_push':
        return `Push to ${event.branch}: ${event.commits.length} commits`;
      case 'build_error':
        return `Build error: ${event.error.slice(0, 100)}`;
      case 'issue_stale':
        return `Issue ${event.issueId} stale for ${event.daysSinceActivity} days`;
      case 'user_message':
        return `Message from ${event.sender}`;
      case 'scheduled':
        return event.reason;
    }
  }

  /**
   * Run a single improvement cycle using the ReAct agent loop.
   * Loads state, determines trigger, builds toolkit, runs the loop,
   * saves state, and logs the outcome. If no trigger is provided,
   * auto-detects from goal stack (Phase 2 behavior).
   */
  async runAgentCycle(trigger?: AgentTrigger): Promise<AgentOutcome> {
    const tracer = getTracer();
    return tracer.withSpan('agent-loop', 'runAgentCycle', async () => {
      this.cycleCount++;
      this.dailyCycleCount++;

      const cycleId = this.generateCycleId();
      tracer.log('agent-loop', 'info', `=== Agent cycle ${cycleId} ===`);

      // 1. Load state
      await this.loadState();

      // 2. Update world model (quick refresh)
      await this.worldModel.updateActivity();

      // 3. Determine trigger (use provided or auto-detect)
      const effectiveTrigger = trigger ?? this.determineTrigger();

      tracer.log('agent-loop', 'info', `Trigger: ${effectiveTrigger.type}`, {
        ...(effectiveTrigger.type === 'goal'
          ? { goalId: effectiveTrigger.goal.id, description: effectiveTrigger.goal.description }
          : {}),
        ...(effectiveTrigger.type === 'event'
          ? { eventKind: effectiveTrigger.event.kind }
          : {}),
      });

      // 4. Build toolkit (with Phase 4 context manager)
      const agentState: AgentState = {
        worldModel: this.worldModel,
        goalStack: this.goalStack,
        issueLog: this.issueLog,
        contextManager: this.contextManager,
      };

      this.agentToolkit = buildAgentToolkit(
        {
          projectRoot: this.projectRoot,
          allowedDirectories: this.config.allowedDirectories,
          forbiddenPatterns: this.config.forbiddenPatterns,
        },
        agentState,
      );

      // 4b. Phase 5: Assess difficulty and scale compute
      const triggerDescription = effectiveTrigger.type === 'goal'
        ? effectiveTrigger.goal.description
        : effectiveTrigger.type === 'event'
          ? effectiveTrigger.event.description
          : 'scheduled cycle';

      const difficulty = this.reasoningScaler.assessDifficulty(triggerDescription, {
        fileCount: this.worldModel.getStats()?.totalFiles ?? 0,
        totalLines: this.worldModel.getStats()?.totalLines ?? 0,
        crossFile: effectiveTrigger.type === 'goal'
          ? (effectiveTrigger.goal.notes ?? '').includes('cross-file')
          : false,
        hasFailingTests: (this.worldModel.getHealth()?.tests?.failing ?? 0) > 0,
        previousAttempts: effectiveTrigger.type === 'goal'
          ? effectiveTrigger.goal.attempts
          : 0,
        tags: [],
      });

      // Scale max turns by difficulty
      const difficultyTurnMultiplier = { easy: 0.5, medium: 1.0, hard: 1.5 };
      const scaledMaxTurns = Math.round(
        (this.agentConfig.maxTurns ?? 20) * difficultyTurnMultiplier[difficulty]
      );

      tracer.log('agent-loop', 'info', `Difficulty: ${difficulty} → maxTurns: ${scaledMaxTurns}`);

      // 5. Build and run agent loop (with self-model from Phase 6)
      const llmProvider = this.provider as unknown as import('../providers/base.js').LlmProvider;

      this.activeAgentLoop = createAgentLoop(
        { ...this.agentConfig, maxTurns: scaledMaxTurns },
        llmProvider,
        this.agentToolkit,
        agentState,
        this.selfModelSummary,
      );

      const outcome = await this.activeAgentLoop.run(effectiveTrigger);
      this.activeAgentLoop = null;

      // 6. Record activity
      this.worldModel.addActivity({
        description: `Agent cycle ${cycleId}: ${outcome.stopReason} (${outcome.totalTurns} turns)`,
        source: 'tyrion',
      });

      // 7. Save state
      await this.saveState();

      // 8. Log outcome
      tracer.log('agent-loop', 'info', `=== Agent cycle ${cycleId} complete ===`, {
        success: outcome.success,
        stopReason: outcome.stopReason,
        totalTurns: outcome.totalTurns,
        durationMs: outcome.durationMs,
        filesModified: outcome.filesModified.length,
        issuesFiled: outcome.issuesFiled.length,
      });

      return outcome;
    });
  }

  /**
   * Attempt a single hypothesis.
   * @deprecated Use runAgentCycle() instead. Retained for fallback.
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

        // Mark backlog item as failed if applicable
        if (hypothesis.observation.source === 'backlog' && hypothesis.observation.context['backlogId']) {
          await this.analyzer.updateBacklogStatus(
            hypothesis.observation.context['backlogId'] as string,
            'failed',
            { reason: validation.errors.join('; ') },
          );
        }
        return false;
      }

      this.log('Validation passed!', 'INFO');

      // Pending review (for integration_mode: approval_required)
      // Branch stays alive for owner to review at their leisure.
      // No blocking wait, no timeout, no auto-revert.
      if (this.config.git.integrationMode === 'approval_required') {
        outcome = 'pending_review';
        this.log(`Branch ${branch} validated and pushed — awaiting owner review`, 'INFO');

        // Record pending branch for handoff
        this._pendingBranches.push({
          branch,
          hypothesisId: hypothesis.id,
          proposal: hypothesis.proposal,
          approach: hypothesis.approach,
          confidence: hypothesis.confidence,
          impact: hypothesis.expectedImpact,
          filesChanged: implementation.changes.map((c) => ({ path: c.path, type: c.type })),
          validatedAt: new Date().toISOString(),
          commitHash: implementation.commitHash ?? '',
        });

        // Reflect on pending_review
        await this.reflectAndSave(cycleId, hypothesis, implementation, [], outcome, false);

        // Mark backlog item as completed if applicable
        if (hypothesis.observation.source === 'backlog' && hypothesis.observation.context['backlogId']) {
          await this.analyzer.updateBacklogStatus(
            hypothesis.observation.context['backlogId'] as string,
            'completed',
            { branch },
          );
        }

        // Return to base branch for next hypothesis
        await this.git.checkoutBase();
        return true; // Counted as success (validation passed)
      }

      // Integrate (for direct or pull_request modes)
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

      // Mark backlog item as completed if applicable
      if (hypothesis.observation.source === 'backlog' && hypothesis.observation.context['backlogId']) {
        await this.analyzer.updateBacklogStatus(
          hypothesis.observation.context['backlogId'] as string,
          'completed',
          { branch: branch ?? undefined },
        );
      }

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
   * Request owner approval via iMessage before merging.
   * Returns true if approved, false if denied or timed out.
   *
   * If no approval bridge is configured, logs a warning and returns false
   * (safety: never auto-merge when approval_required but bridge is missing).
   */
  private async requestApproval(
    hypothesis: Hypothesis,
    implementation: Implementation,
    branch: string,
  ): Promise<boolean> {
    if (!this.approvalBridge || !this.approvalRecipient) {
      this.log(
        'integration_mode is approval_required but no approval bridge or recipient configured — denying by default',
        'WARN'
      );
      return false;
    }

    // Build human-readable summary
    const filesChanged = implementation.changes
      .map((c) => `  - ${c.path} (${c.type})`)
      .join('\n');

    const summary = [
      'Autonomous improvement ready for review:',
      '',
      `Hypothesis: ${hypothesis.proposal}`,
      `Approach: ${hypothesis.approach}`,
      `Confidence: ${hypothesis.confidence.toFixed(2)} | Impact: ${hypothesis.expectedImpact}`,
      `Branch: ${branch}`,
      '',
      'Files changed:',
      filesChanged,
      '',
      'Validation: All quality gates passed',
      '',
      `Reply "yes" to merge to main, or "no" to discard.`,
      `(Auto-denied in ${this.config.approvalTimeoutMinutes} minutes)`,
    ].join('\n');

    this.log('Sending approval request to owner...', 'INFO');

    // Use the approval bridge to request + wait
    const request = this.approvalBridge.requestApproval(summary, this.approvalRecipient);
    const approved = await this.approvalBridge.waitForApproval(request.id);

    return approved;
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
        validationPassed: outcome === 'success' || outcome === 'pending_review',
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

  // ── Phase 6: Dream Cycle ──────────────────────────────────────────────

  /**
   * Run a dream cycle during quiet hours, once per night.
   * Dream cycles consolidate reflections, update the world model,
   * explore code archaeology, rebuild the self-model, and write
   * retrospectives.
   */
  private async runDreamCycleIfDue(): Promise<void> {
    const today = new Date().toISOString().split('T')[0] ?? '';

    // Only run once per calendar day
    if (this.lastDreamCycleDate === today) return;

    // Only during quiet hours
    if (this.shouldRunCycle()) return;

    const tracer = getTracer();
    tracer.log('dream', 'info', 'Dream cycle starting (quiet hours)');

    try {
      const outcome = await this.dreamCycleRunner.run(
        this.worldModel,
        this.goalStack,
        this.issueLog,
        this.reflector,
        this.contextManager,
      );

      this.lastDreamCycleDate = today;

      // Cache the self-model summary for agent loop cycles
      const sm = this.dreamCycleRunner.getSelfModel();
      this.selfModelSummary = sm.getSummary();

      tracer.log('dream', 'info', `Dream cycle complete`, {
        phasesCompleted: outcome.phasesCompleted,
        phasesSkipped: outcome.phasesSkipped,
        fragileFilesFound: outcome.fragileFilesFound,
        abandonedFilesFound: outcome.abandonedFilesFound,
      });
    } catch (error) {
      tracer.log('dream', 'error', `Dream cycle failed: ${error instanceof Error ? error.message : String(error)}`);
      // Don't block the loop on dream cycle failure
    }
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
// ABORT ERROR
// ============================================================================

/**
 * Thrown when a cycle is aborted via AbortSignal (daemon interrupt).
 */
export class AbortError extends Error {
  readonly cycleId: string;

  constructor(cycleId: string) {
    super(`Cycle ${cycleId} aborted`);
    this.name = 'AbortError';
    this.cycleId = cycleId;
  }
}

// ============================================================================
// MAIN ENTRY POINT
// ============================================================================

export async function loadConfig(configPath: string): Promise<AutonomousConfig> {
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
    approvalTimeoutMinutes: raw.git?.approval_timeout_minutes ?? 10,
    backlogPath: raw.autonomous?.backlog_path ?? 'config/backlog.yaml',
    maxBranchAgeHours: raw.autonomous?.max_branch_age_hours ?? 24,
    maxConcurrentBranches: raw.autonomous?.max_concurrent_branches ?? 3,
    sandboxTimeoutSeconds: raw.autonomous?.sandbox_timeout_seconds ?? 300,
    sandboxMemoryMb: raw.autonomous?.sandbox_memory_mb ?? 8192, // Mac Studio has plenty
    git: {
      remote: raw.git?.remote ?? 'origin',
      baseBranch: raw.git?.base_branch ?? 'main',
      branchPrefix: raw.git?.branch_prefix ?? 'auto/',
      integrationMode: raw.git?.integration_mode ?? 'approval_required',
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
