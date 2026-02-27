/**
 * Fast Loop — The 27B user-facing agent.
 *
 * Runs on a ~2-second heartbeat, handling:
 *   - User message triage and acknowledgment
 *   - Direct answers for simple questions
 *   - Code review of DeepLoop's output
 *   - Status reporting from the TaskBoard
 *   - Voice filter application before delivery
 *   - Response delivery to user
 *
 * The FastLoop makes independent LLM calls (no persistent conversation
 * across heartbeats). Each operation selects its own context tier for
 * optimal KV cache usage.
 *
 * See docs/dual-loop-architecture.md Sections 5 and 28.
 */

import type { LlmProvider, GenerateRequest } from '../providers/base.js';
import type { EventBus, SystemEvent } from '../autonomous/events.js';
import type { TaskBoard } from './task-board.js';
import type { Task } from './task-board-types.js';
import type { FastTierConfig, ContextTier } from './context-tiers.js';
import { selectFastTier, selectReviewTier, resolveNumCtx } from './context-tiers.js';
import { countDiffLines } from './review-prompt.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Configuration for the FastLoop.
 */
export interface FastLoopConfig {
  /** Heartbeat interval in milliseconds */
  heartbeatMs: number;
  /** Maximum time for a single triage call */
  triageTimeoutMs: number;
  /** Maximum tokens in the rolling user conversation window */
  maxConversationTokens: number;
  /** Whether code review is enabled */
  reviewEnabled: boolean;
  /** Coalesce window for batching rapid user messages */
  messageCoalesceMs: number;
  /** Context tier configuration */
  tiers: FastTierConfig;
}

/**
 * Per-sender conversation context (in-memory, lost on restart).
 */
interface ConversationContext {
  sender: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string; timestamp: string }>;
  totalTokenEstimate: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Default Configuration
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: FastLoopConfig = {
  heartbeatMs: 2000,
  triageTimeoutMs: 10_000,
  maxConversationTokens: 10_000,
  reviewEnabled: true,
  messageCoalesceMs: 3000,
  tiers: {
    compact: 4096,
    standard: 12288,
    extended: 24576,
    reviewLargeThresholdLines: 150,
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// FastLoop
// ─────────────────────────────────────────────────────────────────────────────

export class FastLoop {
  private readonly config: FastLoopConfig;
  private readonly provider: LlmProvider;
  private readonly taskBoard: TaskBoard;
  private readonly eventBus: EventBus;
  private readonly conversations: Map<string, ConversationContext> = new Map();
  private running: boolean = false;

  constructor(
    provider: LlmProvider,
    taskBoard: TaskBoard,
    eventBus: EventBus,
    config?: Partial<FastLoopConfig>,
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.provider = provider;
    this.taskBoard = taskBoard;
    this.eventBus = eventBus;
  }

  // ── Main Event Loop ─────────────────────────────────────────────────────

  /**
   * Start the heartbeat loop. Runs until stop() is called.
   */
  async run(): Promise<void> {
    this.running = true;

    while (this.running) {
      // TODO(pass-3): Priority-ordered work check:
      // 1. User messages (highest priority)
      // 2. Tasks needing review
      // 3. Completed tasks with responses ready
      // 4. Heartbeat sleep

      await this.sleep(this.config.heartbeatMs);
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

  // ── User Message Handling ───────────────────────────────────────────────

  /**
   * Handle an incoming user message: triage, acknowledge, and create task or answer directly.
   */
  async handleUserMessage(message: string, sender: string): Promise<void> {
    void message; void sender;
    // TODO(pass-3): Triage → direct answer or task creation
  }

  // ── Code Review ─────────────────────────────────────────────────────────

  /**
   * Review a task's artifacts and write the review result to the TaskBoard.
   */
  async reviewTask(task: Task): Promise<void> {
    void task;
    // TODO(pass-3): Read artifacts, select review tier, call LLM, write result
  }

  // ── Response Delivery ───────────────────────────────────────────────────

  /**
   * Deliver a completed task's userFacing response (with optional voice filter).
   */
  async deliverResponse(task: Task): Promise<void> {
    void task;
    // TODO(pass-3): Voice filter → delivery
  }

  // ── Status Reporting ────────────────────────────────────────────────────

  /**
   * Build a status summary from the TaskBoard for the user.
   */
  async buildStatusReport(): Promise<string> {
    // TODO(pass-3): Read task board, summarize
    return '';
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  /**
   * Make an LLM call with the appropriate context tier.
   */
  private async callWithTier(
    tier: ContextTier,
    request: Omit<GenerateRequest, 'providerOptions'>,
  ): Promise<string> {
    const numCtx = resolveNumCtx(this.config.tiers, tier);
    const response = await this.provider.generateWithTools(
      { ...request, providerOptions: { num_ctx: numCtx } },
      [],
    );
    return response.text;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────────────────────

export function createFastLoop(
  provider: LlmProvider,
  taskBoard: TaskBoard,
  eventBus: EventBus,
  config?: Partial<FastLoopConfig>,
): FastLoop {
  return new FastLoop(provider, taskBoard, eventBus, config);
}
