/**
 * Autonomous Self-Improvement Loop
 *
 * Main daemon that runs the continuous improvement cycle:
 * analyze → hypothesize → implement → validate → integrate → reflect
 */

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'yaml';

import { createProvider, type AutonomousProvider } from './provider.js';
import { GitOperations } from './git.js';
import { Reflector } from './reflector.js';
import type { ApprovalBridge } from '../approval/index.js';
import type {
  AutonomousConfig,
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
import { Journal, createJournal } from './journal.js';
import { triggerFromEvent, triggerFromSchedule, triggerFromGoal } from './trigger-router.js';

// Phase 3: Event-Driven Awareness imports
import { ContextManager, createContextManager } from './context-manager.js';
import { EventBus, type SystemEvent } from './events.js';
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

// Communication: MessagePolicy + delivery
import { createMessagePolicy, type MessagePolicy } from './communication/policy.js';
import { createDelivery, type MessageDelivery } from './communication/delivery.js';

// Vision Tier 2: Self-improvement stores
import { createPromptStore, type PromptStore } from './prompt-store.js';
import { createShadowStore, type ShadowStore } from './shadow-store.js';
import { createToolSynthesizer, type ToolSynthesizer } from '../tools/synthesizer.js';

// Vision Tier 3: Advanced self-improvement
import { createChallengeGenerator, type ChallengeGenerator } from './dream/challenge-generator.js';
import { createChallengeEvaluator, type ChallengeEvaluator } from './dream/challenge-evaluator.js';
import { createPromptEvolution, type PromptEvolution } from './dream/prompt-evolution.js';
import { createTrainingExtractor, type TrainingExtractor } from './dream/training-extractor.js';
import { createLoraTrainer, type LoraTrainer } from './dream/lora-trainer.js';

// Advanced Memory: Zettelkasten Link Network (A-MEM)
import { createLinkNetwork, type LinkNetwork } from './memory/link-network.js';
// Advanced Memory: Memory Evolution (A-MEM)
import { createMemoryEvolution, type MemoryEvolution } from './memory/memory-evolution.js';
// Advanced Memory: AUDN Consolidation Cycle (Mem0)
import { createAudnConsolidator, type AudnConsolidator } from './memory/audn-consolidator.js';
// Advanced Memory: Entropy-Based Tier Migration (SAGE)
import { createEntropyMigrator, type EntropyMigrator } from './memory/entropy-migrator.js';
// Advanced Memory: Git-Backed Memory Versioning (Letta)
import { createMemoryVersioning, type MemoryVersioning } from './memory/memory-versioning.js';
// Advanced Memory: Temporal Invalidation (Mem0)
import { createTemporalInvalidation, type TemporalInvalidation } from './memory/temporal-invalidation.js';
// Advanced Memory: Checker Pattern (SAGE)
import { createMemoryChecker, type MemoryChecker } from './memory/checker.js';
// Advanced Memory: Skill Files (Letta)
import { createSkillFilesManager, type SkillFilesManager } from './memory/skill-files.js';
// Advanced Memory: Concurrent Dream Processing (Letta)
import { createConcurrentDreamExecutor, type ConcurrentDreamExecutor } from './memory/concurrent-dreams.js';
// Advanced Memory: Graph Relational Memory (Mem0)
import { createGraphMemory, type GraphMemory } from './memory/graph-memory.js';

// ============================================================================
// CONSTANTS
// ============================================================================

const DEFAULT_CONFIG_PATH = 'config/autonomous.yaml';
const CYCLE_ID_PREFIX = 'cycle';
const DREAM_META_PATH = path.join(os.homedir(), '.casterly', 'dream-meta.json');

// ============================================================================
// PHASE 3: EVENTS CONFIGURATION
// ============================================================================

/**
 * Configuration for the event-driven awareness system.
 */
interface EventsConfig {
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
  private readonly git: GitOperations;
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

  // Phase 4: Tiered memory
  private contextManager: ContextManager;

  // Phase 5: Reasoning scaling
  private reasoningScaler: ReasoningScaler;

  // Phase 6: Dream cycles and self-model
  private dreamCycleRunner: DreamCycleRunner;
  private lastDreamCycleDate: string = '';
  private lastDreamCycleTimestamp: string = '';
  private selfModelSummary: SelfModelSummary | null = null;

  // Journal system (Phase 1)
  private journal: Journal;

  // Phase 3: Event-driven awareness
  private eventBus: EventBus;
  private fileWatcher: FileWatcher | null = null;
  private gitWatcher: GitWatcher | null = null;
  private issueWatcher: IssueWatcher | null = null;
  private lastCycleEndMs: number = 0;
  private dailyTurnCount: number = 0;
  private eventsConfig: EventsConfig;

  // Communication
  private messagePolicy: MessagePolicy | null = null;
  private messageDelivery: MessageDelivery | null = null;

  // Vision Tier 2: Self-improvement stores
  private promptStore: PromptStore | null = null;
  private shadowStore: ShadowStore | null = null;
  private toolSynthesizer: ToolSynthesizer | null = null;

  // Vision Tier 3: Advanced self-improvement
  private challengeGenerator: ChallengeGenerator | null = null;
  private challengeEvaluator: ChallengeEvaluator | null = null;
  private promptEvolution: PromptEvolution | null = null;
  private trainingExtractor: TrainingExtractor | null = null;
  private loraTrainer: LoraTrainer | null = null;

  // Advanced Memory: Zettelkasten Link Network (A-MEM)
  private linkNetwork: LinkNetwork;
  // Advanced Memory: Memory Evolution (A-MEM)
  private memoryEvolution: MemoryEvolution;
  // Advanced Memory: AUDN Consolidation Cycle (Mem0)
  private audnConsolidator: AudnConsolidator;
  // Advanced Memory: Entropy-Based Tier Migration (SAGE)
  private entropyMigrator: EntropyMigrator;
  // Advanced Memory: Git-Backed Memory Versioning (Letta)
  private memoryVersioning: MemoryVersioning;
  // Advanced Memory: Temporal Invalidation (Mem0)
  private temporalInvalidation: TemporalInvalidation;
  // Advanced Memory: Checker Pattern (SAGE)
  private memoryChecker: MemoryChecker;
  // Advanced Memory: Skill Files (Letta)
  private skillFilesManager: SkillFilesManager;
  // Advanced Memory: Concurrent Dream Processing (Letta)
  private concurrentDreamExecutor: ConcurrentDreamExecutor;
  // Advanced Memory: Graph Relational Memory (Mem0)
  private graphMemory: GraphMemory;

  // Roadmap: Optional providers
  private jobStore: import('../scheduler/store.js').JobStore | null = null;
  private concurrentProvider: import('../providers/concurrent.js').ConcurrentProvider | null = null;

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

    this.git = new GitOperations(projectRoot, config.git);
    this.reflector = new Reflector({ projectRoot });

    // Phase 2: Initialize persistent state
    this.worldModel = new WorldModel({ projectRoot });
    this.goalStack = new GoalStack();
    this.issueLog = new IssueLog();
    this.agentConfig = agentConfig ?? {};

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
      ...(config.dreamCycles ? {
        consolidationIntervalHours: config.dreamCycles.consolidationIntervalHours,
        explorationBudgetTurns: config.dreamCycles.explorationBudgetTurns,
        selfModelRebuildIntervalHours: config.dreamCycles.selfModelRebuildIntervalHours,
        archaeologyLookbackDays: config.dreamCycles.archaeologyLookbackDays,
        retrospectiveIntervalDays: config.dreamCycles.retrospectiveIntervalDays,
      } : {}),
    });

    // Phase 1: Initialize journal
    this.journal = createJournal();

    // Communication: MessagePolicy + delivery backend
    // Reads from the `communication` section of autonomous.yaml
    // via the AutonomousConfig (which stores the raw communication block).
    if (config.communication?.enabled) {
      const policyOpts: Record<string, unknown> = { enabled: true };
      if (config.communication.throttle) policyOpts['throttle'] = config.communication.throttle;
      if (config.communication.testFailureMinSeverity) policyOpts['testFailureMinSeverity'] = config.communication.testFailureMinSeverity;
      if (config.communication.dailySummaryEnabled !== undefined) policyOpts['dailySummaryEnabled'] = config.communication.dailySummaryEnabled;
      this.messagePolicy = createMessagePolicy(policyOpts as Parameters<typeof createMessagePolicy>[0]);

      const channel = config.communication.deliveryChannel ?? 'console';
      this.messageDelivery = createDelivery({
        channel,
        recipient: config.communication.recipient,
      });
    }

    // Vision Tier 2: Self-improvement stores
    if (config.visionTiers?.tier2 !== false) {
      this.promptStore = createPromptStore();
      this.shadowStore = createShadowStore();
      this.toolSynthesizer = createToolSynthesizer();
    }

    // Vision Tier 3: Advanced self-improvement
    if (config.visionTiers?.tier3 !== false) {
      this.challengeGenerator = createChallengeGenerator();
      this.challengeEvaluator = createChallengeEvaluator();
      this.promptEvolution = createPromptEvolution();
      this.trainingExtractor = createTrainingExtractor();
      this.loraTrainer = createLoraTrainer();
    }

    // Advanced Memory: Zettelkasten Link Network + Memory Evolution (A-MEM)
    this.linkNetwork = createLinkNetwork();
    this.memoryEvolution = createMemoryEvolution();
    // Couple: evolution operations auto-create links
    this.memoryEvolution.setLinkNetwork(this.linkNetwork);

    // Advanced Memory: AUDN Consolidation Cycle (Mem0)
    this.audnConsolidator = createAudnConsolidator();

    // Advanced Memory: Entropy-Based Tier Migration (SAGE)
    this.entropyMigrator = createEntropyMigrator();

    // Advanced Memory: Git-Backed Memory Versioning (Letta)
    this.memoryVersioning = createMemoryVersioning();

    // Advanced Memory: Temporal Invalidation (Mem0) — stateless, no load/save needed
    this.temporalInvalidation = createTemporalInvalidation();

    // Advanced Memory: Checker Pattern (SAGE) — stateless, no load/save needed
    this.memoryChecker = createMemoryChecker();

    // Advanced Memory: Skill Files (Letta) — stateful, needs load/save
    this.skillFilesManager = createSkillFilesManager();

    // Advanced Memory: Concurrent Dream Processing (Letta) — stateless, no load/save
    this.concurrentDreamExecutor = createConcurrentDreamExecutor();

    // Advanced Memory: Graph Relational Memory (Mem0) — stateful, needs load/save
    this.graphMemory = createGraphMemory();
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

    // Start event-driven awareness (watchers always run)
    await this.startEventDriven();

    while (this.running) {
      try {
        // Check if we should run
        if (!this.shouldRunCycle()) {
          await this.sleep(60_000); // Check again in 1 minute
          continue;
        }

        // Run a cycle via the agent loop (the sole execution path)
        const trigger = this.determineTrigger();
        await this.runAgentCycle(trigger);

        // After each agent cycle, check if a dream cycle is due
        await this.runDreamCycleIfDue();

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

    // Quiet hours are a scheduling preference, not a hard gate.
    // The LLM receives quiet hours info via the system prompt and
    // prefers consolidation work during those times. The system
    // never refuses to run cycles. See docs/vision.md.

    return true;
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
      this.journal.load(),
      this.loadDreamMeta(),
      this.linkNetwork.load(),
      this.memoryEvolution.load(),
      this.audnConsolidator.load(),
      this.memoryVersioning.load(),
      this.skillFilesManager.load(),
      this.graphMemory.load(),
      ...this.visionStoreLoadOps(),
    ]);
  }

  /**
   * Return load() promises for all active vision stores.
   * ChallengeGenerator and TrainingExtractor are stateless — no load needed.
   */
  private visionStoreLoadOps(): Promise<void>[] {
    const ops: Promise<void>[] = [];
    if (this.promptStore) ops.push(this.promptStore.load());
    if (this.shadowStore) ops.push(this.shadowStore.load());
    if (this.toolSynthesizer) ops.push(this.toolSynthesizer.load());
    if (this.challengeEvaluator) ops.push(this.challengeEvaluator.load());
    if (this.promptEvolution) ops.push(this.promptEvolution.load());
    if (this.loraTrainer) ops.push(this.loraTrainer.load());
    return ops;
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
      this.saveDreamMeta(),
      this.linkNetwork.save(),
      this.memoryEvolution.save(),
      this.audnConsolidator.save(),
      this.memoryVersioning.save(),
      this.skillFilesManager.save(),
      this.graphMemory.save(),
      ...this.visionStoreSaveOps(),
    ]);
  }

  /**
   * Return save() promises for all active vision stores.
   * ChallengeGenerator and TrainingExtractor are stateless — no save needed.
   */
  private visionStoreSaveOps(): Promise<void>[] {
    const ops: Promise<void>[] = [];
    if (this.promptStore) ops.push(this.promptStore.save());
    if (this.shadowStore) ops.push(this.shadowStore.save());
    if (this.toolSynthesizer) ops.push(this.toolSynthesizer.save());
    if (this.challengeEvaluator) ops.push(this.challengeEvaluator.save());
    if (this.promptEvolution) ops.push(this.promptEvolution.save());
    if (this.loraTrainer) ops.push(this.loraTrainer.save());
    return ops;
  }

  // ── Dream Meta Persistence ────────────────────────────────────────────────

  /**
   * Load dream cycle metadata (last run timestamp) from disk.
   */
  private async loadDreamMeta(): Promise<void> {
    try {
      const raw = await fs.readFile(DREAM_META_PATH, 'utf-8');
      const meta = JSON.parse(raw) as Record<string, unknown>;
      if (typeof meta['lastDreamCycleDate'] === 'string') {
        this.lastDreamCycleDate = meta['lastDreamCycleDate'];
      }
      if (typeof meta['lastDreamCycleTimestamp'] === 'string') {
        this.lastDreamCycleTimestamp = meta['lastDreamCycleTimestamp'];
      }
    } catch {
      // File doesn't exist yet — first run
    }
  }

  /**
   * Save dream cycle metadata to disk.
   */
  private async saveDreamMeta(): Promise<void> {
    if (!this.lastDreamCycleDate && !this.lastDreamCycleTimestamp) return;
    const meta = {
      lastDreamCycleDate: this.lastDreamCycleDate,
      lastDreamCycleTimestamp: this.lastDreamCycleTimestamp,
    };
    await fs.mkdir(path.dirname(DREAM_META_PATH), { recursive: true });
    await fs.writeFile(DREAM_META_PATH, JSON.stringify(meta, null, 2) + '\n');
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
      return triggerFromGoal(nextGoal);
    }
    return triggerFromSchedule();
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
  getState(): { worldModel: WorldModel; goalStack: GoalStack; issueLog: IssueLog; journal: Journal } {
    return {
      worldModel: this.worldModel,
      goalStack: this.goalStack,
      issueLog: this.issueLog,
      journal: this.journal,
    };
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

    // Watchers always run and emit events. The LLM decides what to
    // do with them. There is no events.enabled toggle.
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

    // The agent loop is always the execution path. Events always
    // flow to the agent loop. There is no disabled state.

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
    if (event.type === 'user_message') {
      return { type: 'user', message: event.message, sender: event.sender };
    }
    return triggerFromEvent(event);
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

      // 4. Build toolkit (with Phase 4 context manager + roadmap state)
      const agentState: AgentState = {
        worldModel: this.worldModel,
        goalStack: this.goalStack,
        issueLog: this.issueLog,
        contextManager: this.contextManager,
        journal: this.journal,
        // Roadmap Phase 1/3: Event bus for peek_queue
        eventBus: this.eventBus,
        // Roadmap Phase 3: Self-model for assess_self
        ...(this.selfModelSummary !== null ? { selfModelSummary: this.selfModelSummary } : {}),
        // Roadmap Phase 5: Job store for schedule/list_schedules/cancel_schedule
        ...(this.jobStore ? { jobStore: this.jobStore } : {}),
        // Supporting: Concurrent provider for parallel_reason
        ...(this.concurrentProvider ? { concurrentProvider: this.concurrentProvider } : {}),
        // Reconciliation: Dream cycle phases as tools
        dreamCycleRunner: this.dreamCycleRunner,
        reflector: this.reflector,
        // Vision Tier 2: Self-improvement stores
        ...(this.promptStore ? { promptStore: this.promptStore } : {}),
        ...(this.shadowStore ? { shadowStore: this.shadowStore } : {}),
        ...(this.toolSynthesizer ? { toolSynthesizer: this.toolSynthesizer } : {}),
        // Vision Tier 3: Advanced self-improvement
        ...(this.challengeGenerator ? { challengeGenerator: this.challengeGenerator } : {}),
        ...(this.challengeEvaluator ? { challengeEvaluator: this.challengeEvaluator } : {}),
        ...(this.promptEvolution ? { promptEvolution: this.promptEvolution } : {}),
        ...(this.trainingExtractor ? { trainingExtractor: this.trainingExtractor } : {}),
        ...(this.loraTrainer ? { loraTrainer: this.loraTrainer } : {}),
        // Communication
        ...(this.messagePolicy ? { messagePolicy: this.messagePolicy } : {}),
        ...(this.messageDelivery ? { messageDelivery: this.messageDelivery } : {}),
        // Advanced Memory: Zettelkasten + Evolution (A-MEM)
        linkNetwork: this.linkNetwork,
        memoryEvolution: this.memoryEvolution,
        // Advanced Memory: AUDN Consolidation Cycle (Mem0)
        audnConsolidator: this.audnConsolidator,
        // Advanced Memory: Entropy-Based Tier Migration (SAGE)
        entropyMigrator: this.entropyMigrator,
        // Advanced Memory: Git-Backed Memory Versioning (Letta)
        memoryVersioning: this.memoryVersioning,
        // Advanced Memory: Temporal Invalidation (Mem0)
        temporalInvalidation: this.temporalInvalidation,
        // Advanced Memory: Checker Pattern (SAGE)
        memoryChecker: this.memoryChecker,
        // Advanced Memory: Skill Files (Letta)
        skillFilesManager: this.skillFilesManager,
        // Advanced Memory: Concurrent Dream Processing (Letta)
        concurrentDreamExecutor: this.concurrentDreamExecutor,
        // Advanced Memory: Graph Relational Memory (Mem0)
        graphMemory: this.graphMemory,
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

      // Difficulty informs candidate generation (bestOfN) but NOT turn limits.
      // Local inference has no cost — every task gets full turns for reflection.
      const scaledMaxTurns = this.agentConfig.maxTurns ?? 200;

      // Token budget: user/goal work gets full budget, background cycles get moderate budget
      const tokenBudget = (effectiveTrigger.type === 'user' || effectiveTrigger.type === 'goal')
        ? (this.agentConfig.maxTokensPerCycle ?? 500_000)
        : (this.agentConfig.maxTokensPerCycleBackground ?? this.agentConfig.maxTokensPerCycle ?? 100_000);

      tracer.log('agent-loop', 'info', `Difficulty: ${difficulty} → maxTurns: ${scaledMaxTurns}, tokenBudget: ${tokenBudget}`);

      // 5. Build and run agent loop (with self-model from Phase 6)
      const llmProvider = this.provider as unknown as import('../providers/base.js').LlmProvider;

      this.activeAgentLoop = createAgentLoop(
        { ...this.agentConfig, maxTurns: scaledMaxTurns, maxTokensPerCycle: tokenBudget, cycleId },
        llmProvider,
        this.agentToolkit,
        agentState,
        this.selfModelSummary,
        this.journal,
      );

      let outcome: AgentOutcome;
      try {
        outcome = await this.activeAgentLoop.run(effectiveTrigger);
      } finally {
        this.activeAgentLoop = null;

        // Always persist state — even if the cycle threw, partial
        // progress (goal attempt counts, issue updates, world model
        // concerns) should not be lost.
        try {
          await this.saveState();
        } catch (saveErr) {
          tracer.log('agent-loop', 'error', 'Failed to save state after cycle', {
            error: saveErr instanceof Error ? saveErr.message : String(saveErr),
          });
        }
      }

      // 6. Record activity
      this.worldModel.addActivity({
        description: `Agent cycle ${cycleId}: ${outcome.stopReason} (${outcome.totalTurns} turns)`,
        source: 'tyrion',
      });

      // 7. Save state (final — includes the activity record above)
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

  // --------------------------------------------------------------------------
  // HELPERS
  // --------------------------------------------------------------------------

  private generateCycleId(): string {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    return `${CYCLE_ID_PREFIX}-${timestamp}-${this.cycleCount}`;
  }

  // ── Phase 6: Dream Cycle ──────────────────────────────────────────────

  /**
   * Check whether a dream cycle is due and run it if so.
   *
   * Scheduling rules:
   * - At most once per calendar day.
   * - At least `consolidationIntervalHours` since the last dream cycle
   *   (default 24h, configurable via `dream_cycles` in autonomous.yaml).
   *
   * Called automatically after every agent cycle in `start()`.
   * Can also be called externally as an escape hatch.
   */
  async runDreamCycleIfDue(): Promise<void> {
    const now = new Date();
    const today = now.toISOString().split('T')[0] ?? '';

    // Only run once per calendar day
    if (this.lastDreamCycleDate === today) return;

    // Respect consolidation interval: skip if not enough time has passed
    // since the last dream cycle timestamp (stored as ISO string).
    if (this.lastDreamCycleTimestamp) {
      const intervalHours = this.config.dreamCycles?.consolidationIntervalHours ?? 24;
      const elapsedMs = now.getTime() - new Date(this.lastDreamCycleTimestamp).getTime();
      if (elapsedMs < intervalHours * 3_600_000) return;
    }

    const tracer = getTracer();
    tracer.log('dream', 'info', 'Dream cycle starting (auto-triggered)');

    try {
      const outcome = await this.dreamCycleRunner.run(
        this.worldModel,
        this.goalStack,
        this.issueLog,
        this.reflector,
        this.contextManager,
        this.promptStore ?? undefined,
        this.shadowStore ?? undefined,
        this.toolSynthesizer ?? undefined,
        this.challengeGenerator ?? undefined,
        this.challengeEvaluator ?? undefined,
        this.promptEvolution ?? undefined,
        this.trainingExtractor ?? undefined,
        this.loraTrainer ?? undefined,
        this.journal,
        this.linkNetwork,
        this.audnConsolidator,
        this.entropyMigrator,
        this.memoryVersioning,
        this.memoryEvolution,
        this.temporalInvalidation,
        this.memoryChecker,
        this.skillFilesManager,
        this.concurrentDreamExecutor,
        this.graphMemory,
      );

      this.lastDreamCycleDate = today;
      this.lastDreamCycleTimestamp = now.toISOString();

      // Cache the self-model summary for agent loop cycles
      const sm = this.dreamCycleRunner.getSelfModel();
      this.selfModelSummary = sm.getSummary();

      // Persist the dream cycle timestamp
      await this.saveState();

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
    enabled: true, // Always active — no master switch (see docs/vision.md)
    provider: 'ollama',
    model: raw.autonomous?.model ?? 'qwen3-coder-next:latest',
    cycleIntervalMinutes: raw.autonomous?.cycle_interval_minutes ?? 60,
    maxCyclesPerDay: raw.autonomous?.max_cycles_per_day ?? 12,
    quietHours: raw.autonomous?.quiet_hours
      ? {
          start: raw.autonomous.quiet_hours.start,
          end: raw.autonomous.quiet_hours.end,
          // Quiet hours are a soft preference, not a hard gate.
          // The enabled field is kept for type compat but always true.
          enabled: true,
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
    visionTiers: {
      tier2: raw.self_improvement !== undefined,
      tier3: raw.advanced_self_improvement !== undefined,
    },
    communication: raw.communication?.enabled
      ? {
          enabled: true,
          deliveryChannel: raw.communication.delivery_channel ?? raw.notifications?.method ?? 'console',
          recipient: raw.communication.recipient ?? raw.notifications?.recipient ?? undefined,
          throttle: raw.communication.throttle
            ? {
                maxPerHour: raw.communication.throttle.max_per_hour ?? 3,
                maxPerDay: raw.communication.throttle.max_per_day ?? 10,
                quietHours: raw.communication.throttle.quiet_hours ?? true,
                quietStart: raw.communication.throttle.quiet_start ?? '22:00',
                quietEnd: raw.communication.throttle.quiet_end ?? '08:00',
              }
            : undefined,
          testFailureMinSeverity: raw.communication.test_failure_min_severity ?? 'unresolvable',
          dailySummaryEnabled: raw.communication.daily_summary_enabled ?? true,
        }
      : undefined,
    dreamCycles: raw.dream_cycles
      ? {
          consolidationIntervalHours: raw.dream_cycles.consolidation_interval_hours ?? 24,
          explorationBudgetTurns: raw.dream_cycles.exploration_budget_turns ?? 50,
          selfModelRebuildIntervalHours: raw.dream_cycles.self_model_rebuild_interval_hours ?? 48,
          archaeologyLookbackDays: raw.dream_cycles.archaeology_lookback_days ?? 90,
          retrospectiveIntervalDays: raw.dream_cycles.retrospective_interval_days ?? 7,
        }
      : undefined,
    agentLoop: raw.agent_loop
      ? {
          maxTurns: raw.agent_loop.max_turns,
          maxTokensPerCycle: raw.agent_loop.max_tokens_per_cycle,
          maxTokensPerCycleBackground: raw.agent_loop.max_tokens_per_cycle_background,
          reasoningModel: raw.agent_loop.reasoning_model,
          codingModel: raw.agent_loop.coding_model,
          thinkToolEnabled: raw.agent_loop.think_tool_enabled,
          delegationEnabled: raw.agent_loop.delegation_enabled,
          userMessagingEnabled: raw.agent_loop.user_messaging_enabled,
          temperature: raw.agent_loop.temperature,
          maxResponseTokens: raw.agent_loop.max_response_tokens,
        }
      : undefined,
  };
}

export async function main(): Promise<void> {
  const projectRoot = process.cwd();
  const configPath = path.join(projectRoot, DEFAULT_CONFIG_PATH);

  console.log('Loading configuration...');
  const config = await loadConfig(configPath);

  // The autonomous loop always starts. There is no master switch.
  // Autonomy is the default state. See docs/vision.md.

  console.log('Creating provider...');
  const provider = await createProvider(config);

  console.log('Starting autonomous loop...');
  const loop = new AutonomousLoop(config, projectRoot, provider, undefined, config.agentLoop);

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
