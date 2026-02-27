/**
 * Deep Loop — The 122B reasoning engine.
 *
 * Runs continuously, pulling tasks from the TaskBoard and executing them
 * via the existing AgentLoop (ReAct pattern). The DeepLoop:
 *   - Claims queued tasks and plans the approach
 *   - Dispatches code generation to the Coder model
 *   - Addresses review feedback from the FastLoop
 *   - Handles preemption (higher-priority tasks interrupt current work)
 *   - Runs autonomous work from the goal stack during idle periods
 *
 * Context tier is set once per task (not changed mid-ReAct-loop).
 *
 * See docs/dual-loop-architecture.md Sections 6, 17, and 28.
 */

import type { LlmProvider, GenerateRequest } from '../providers/base.js';
import type { ConcurrentProvider } from '../providers/concurrent.js';
import type { EventBus, SystemEvent } from '../autonomous/events.js';
import type { AgentLoopConfig, AgentTrigger, AgentOutcome } from '../autonomous/agent-loop.js';
import type { TaskBoard } from './task-board.js';
import type { Task } from './task-board-types.js';
import type { DeepTierConfig, CoderTierConfig, ContextTier } from './context-tiers.js';
import { selectDeepTier, selectCoderTier, resolveNumCtx, buildProviderOptions } from './context-tiers.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Configuration for the DeepLoop.
 */
export interface DeepLoopConfig {
  /** Model ID for the reasoning model (122B) */
  model: string;
  /** Model ID for the coder model */
  coderModel: string;
  /** Maximum ReAct turns per task */
  maxTurnsPerTask: number;
  /** Maximum review→revision cycles before failing */
  maxRevisionRounds: number;
  /** Check the TaskBoard for preemption every N turns */
  preemptCheckIntervalTurns: number;
  /** Sleep duration when idle (no tasks) */
  idleSleepMs: number;
  /** Context tier configs */
  tiers: DeepTierConfig;
  coderTiers: CoderTierConfig;
}

// ─────────────────────────────────────────────────────────────────────────────
// Default Configuration
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: DeepLoopConfig = {
  model: 'qwen3.5:122b',
  coderModel: 'qwen3-coder-next:latest',
  maxTurnsPerTask: 50,
  maxRevisionRounds: 3,
  preemptCheckIntervalTurns: 5,
  idleSleepMs: 10_000,
  tiers: {
    compact: 8192,
    standard: 24576,
    extended: 40960,
    contextPressureWarningThreshold: 0.80,
  },
  coderTiers: {
    compact: 8192,
    standard: 16384,
    extended: 32768,
    responseBufferTokens: 2000,
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// DeepLoop
// ─────────────────────────────────────────────────────────────────────────────

export class DeepLoop {
  private readonly config: DeepLoopConfig;
  private readonly provider: LlmProvider;
  private readonly concurrentProvider: ConcurrentProvider;
  private readonly taskBoard: TaskBoard;
  private readonly eventBus: EventBus;
  private running: boolean = false;
  private currentTask: Task | null = null;

  constructor(
    provider: LlmProvider,
    concurrentProvider: ConcurrentProvider,
    taskBoard: TaskBoard,
    eventBus: EventBus,
    config?: Partial<DeepLoopConfig>,
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.provider = provider;
    this.concurrentProvider = concurrentProvider;
    this.taskBoard = taskBoard;
    this.eventBus = eventBus;
  }

  // ── Main Work Loop ──────────────────────────────────────────────────────

  /**
   * Start the work loop. Runs until stop() is called.
   * Unlike FastLoop, this doesn't heartbeat — it works at its natural
   * pace, spending 10-60 seconds per turn.
   */
  async run(): Promise<void> {
    this.running = true;

    while (this.running) {
      // TODO(pass-3): Priority-ordered work check:
      // 1. Queued tasks (user-requested, highest priority)
      // 2. Revision requests (FastLoop flagged issues)
      // 3. System events
      // 4. Goal stack (autonomous improvement)
      // 5. Idle sleep

      await this.sleep(this.config.idleSleepMs);
    }
  }

  /**
   * Stop the loop gracefully.
   */
  stop(): void {
    this.running = false;
  }

  /** Whether the loop is currently running */
  isRunning(): boolean {
    return this.running;
  }

  /** Get the task currently being worked on */
  getCurrentTask(): Task | null {
    return this.currentTask;
  }

  // ── Plan and Execute ────────────────────────────────────────────────────

  /**
   * Plan and execute a task using the AgentLoop (ReAct pattern).
   * Selects the context tier once at the start.
   */
  async planAndExecute(task: Task): Promise<AgentOutcome | null> {
    this.currentTask = task;
    const tier = selectDeepTier(task);
    const numCtx = resolveNumCtx(this.config.tiers, tier);

    void numCtx;
    // TODO(pass-3):
    // 1. Create AgentLoop with providerOptions: { num_ctx: numCtx }
    // 2. Hook onBeforeTurn for preemption checking
    // 3. Run the ReAct loop
    // 4. Handle outcome: update TaskBoard
    // 5. Set status to 'reviewing' on success

    this.currentTask = null;
    return null;
  }

  // ── Coder Dispatch ──────────────────────────────────────────────────────

  /**
   * Dispatch a plan step to the Coder model for implementation.
   * Selects the Coder context tier based on measured prompt size.
   */
  async dispatchToCoder(prompt: string, fileContents: string): Promise<string> {
    const totalChars = prompt.length + fileContents.length;
    const tier = selectCoderTier(totalChars, this.config.coderTiers);
    const providerOptions = buildProviderOptions(this.config.coderTiers, tier);

    const request: GenerateRequest = {
      prompt: `${prompt}\n\n---\n\n${fileContents}`,
      systemPrompt: 'You are a code implementation assistant. Write the code changes requested. Be precise and minimal.',
      temperature: 0.1,
      maxTokens: 4096,
      providerOptions,
    };

    const response = await this.concurrentProvider.generate(
      this.config.coderModel,
      request,
    );

    return response.text;
  }

  // ── Revision Handling ───────────────────────────────────────────────────

  /**
   * Address review feedback from the FastLoop.
   */
  async addressRevision(task: Task): Promise<void> {
    void task;
    // TODO(pass-3): Read reviewFeedback, fix issues, resubmit for review
  }

  // ── Preemption ──────────────────────────────────────────────────────────

  /**
   * Check the TaskBoard for higher-priority work. Called every N turns.
   */
  private checkForPreemption(currentPriority: number): Task | null {
    return this.taskBoard.getHigherPriorityTask(currentPriority);
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────────────────────

export function createDeepLoop(
  provider: LlmProvider,
  concurrentProvider: ConcurrentProvider,
  taskBoard: TaskBoard,
  eventBus: EventBus,
  config?: Partial<DeepLoopConfig>,
): DeepLoop {
  return new DeepLoop(provider, concurrentProvider, taskBoard, eventBus, config);
}
