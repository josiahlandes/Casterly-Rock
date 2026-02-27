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
import type { EventBus } from '../autonomous/events.js';
import { getTracer } from '../autonomous/debug.js';
import type { TaskBoard } from './task-board.js';
import type { Task } from './task-board-types.js';
import type { FastTierConfig, ContextTier } from './context-tiers.js';
import { selectFastTier, selectReviewTier, resolveNumCtx, estimateTokens } from './context-tiers.js';
import {
  TRIAGE_SYSTEM_PROMPT,
  buildTriagePrompt,
  parseTriageResponse,
} from './triage-prompt.js';
import type { TriageResult } from './triage-prompt.js';
import {
  REVIEW_SYSTEM_PROMPT,
  buildReviewPrompt,
  countDiffLines,
  parseReviewResponse,
} from './review-prompt.js';

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

/**
 * A pending user message waiting to be processed.
 */
interface PendingMessage {
  message: string;
  sender: string;
  receivedAt: number;
}

/**
 * Callback to deliver a response to the user (e.g., via iMessage).
 */
export type DeliverFn = (sender: string, text: string) => Promise<void>;

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
  private readonly pendingMessages: PendingMessage[] = [];
  private deliverFn: DeliverFn | null = null;
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

  /**
   * Set the delivery function for sending responses to users.
   */
  setDeliverFn(fn: DeliverFn): void {
    this.deliverFn = fn;
  }

  // ── Main Event Loop ─────────────────────────────────────────────────────

  /**
   * Start the heartbeat loop. Runs until stop() is called.
   *
   * Each heartbeat checks for work in priority order:
   *   1. Pending user messages (coalesced)
   *   2. Tasks needing review
   *   3. Completed tasks with responses to deliver
   *   4. Sleep until next heartbeat
   */
  async run(): Promise<void> {
    const tracer = getTracer();
    this.running = true;
    tracer.log('fast-loop', 'info', 'FastLoop started');

    while (this.running) {
      try {
        // 1. Process any pending user messages (highest priority)
        if (this.pendingMessages.length > 0) {
          await this.processPendingMessages();
          continue; // Re-check immediately — more messages may have arrived
        }

        // 2. Review tasks that DeepLoop has completed
        if (this.config.reviewEnabled) {
          const reviewable = this.taskBoard.getNextReviewable();
          if (reviewable) {
            await this.reviewTask(reviewable);
            continue;
          }
        }

        // 3. Deliver completed task responses
        const deliverable = this.taskBoard.getCompletedWithResponse();
        if (deliverable) {
          await this.deliverResponse(deliverable);
          continue;
        }

        // 4. Nothing to do — sleep until next heartbeat
        await this.sleep(this.config.heartbeatMs);
      } catch (error) {
        tracer.log('fast-loop', 'error', 'FastLoop heartbeat error', {
          error: error instanceof Error ? error.message : String(error),
        });
        // Don't crash the loop on individual errors
        await this.sleep(this.config.heartbeatMs);
      }
    }

    tracer.log('fast-loop', 'info', 'FastLoop stopped');
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
   * Queue a user message for processing. Called externally (e.g., by the
   * iMessage daemon) — the FastLoop will process it on the next heartbeat.
   */
  enqueueMessage(message: string, sender: string): void {
    this.pendingMessages.push({
      message,
      sender,
      receivedAt: Date.now(),
    });
  }

  /**
   * Process all pending messages. Messages from the same sender within
   * the coalesce window are batched into a single triage call.
   */
  private async processPendingMessages(): Promise<void> {
    const tracer = getTracer();
    const now = Date.now();

    // Group messages by sender
    const bySender = new Map<string, PendingMessage[]>();
    for (const msg of this.pendingMessages) {
      const existing = bySender.get(msg.sender) ?? [];
      existing.push(msg);
      bySender.set(msg.sender, existing);
    }
    this.pendingMessages.length = 0;

    for (const [sender, messages] of bySender) {
      // Check if we should wait for more messages (coalesce window)
      const newest = messages[messages.length - 1];
      if (newest && (now - newest.receivedAt) < this.config.messageCoalesceMs) {
        // Put them back — not ready yet
        this.pendingMessages.push(...messages);
        continue;
      }

      // Combine messages from same sender
      const combined = messages.map((m) => m.message).join('\n');
      tracer.log('fast-loop', 'info', `Processing ${messages.length} message(s) from ${sender}`);

      await this.handleUserMessage(combined, sender);
    }
  }

  /**
   * Handle a user message: triage, acknowledge, and either answer directly
   * or create a task for the DeepLoop.
   */
  async handleUserMessage(message: string, sender: string): Promise<void> {
    const tracer = getTracer();

    // Track in conversation context
    this.addToConversation(sender, 'user', message);

    // Triage the message
    const triage = await this.triageMessage(message, sender);
    tracer.log('fast-loop', 'info', `Triage result: ${triage.classification}`, {
      confidence: triage.confidence,
      sender,
    });

    switch (triage.classification) {
      case 'conversational':
      case 'simple': {
        // Answer directly — create a task and mark it done immediately
        const response = triage.directResponse ?? 'I don\'t have a specific answer for that.';
        const id = this.taskBoard.create({
          origin: 'user',
          priority: 0,
          sender,
          originalMessage: message,
          classification: triage.classification,
          triageNotes: triage.triageNotes,
          userFacing: response,
          status: 'answered_directly',
        });

        this.addToConversation(sender, 'assistant', response);
        await this.deliver(sender, response);

        tracer.log('fast-loop', 'info', `Answered directly: ${id}`, {
          classification: triage.classification,
        });
        break;
      }

      case 'complex': {
        // Create a task for DeepLoop and send acknowledgment
        const id = this.taskBoard.create({
          origin: 'user',
          priority: 0,
          sender,
          originalMessage: message,
          classification: 'complex',
          triageNotes: triage.triageNotes,
        });

        const ack = `Got it — working on that now.`;
        this.addToConversation(sender, 'assistant', ack);
        await this.deliver(sender, ack);

        tracer.log('fast-loop', 'info', `Task created for DeepLoop: ${id}`, {
          triageNotes: triage.triageNotes,
        });
        break;
      }
    }
  }

  // ── Triage ──────────────────────────────────────────────────────────────

  /**
   * Triage a user message by calling the 27B model.
   */
  private async triageMessage(message: string, sender: string): Promise<TriageResult> {
    const tracer = getTracer();
    const tier = selectFastTier('triage');

    const boardSummary = this.taskBoard.getSummaryText();
    const userPrompt = buildTriagePrompt({ message, sender, taskBoardSummary: boardSummary });

    try {
      const response = await this.callWithTier(tier, {
        prompt: userPrompt,
        systemPrompt: TRIAGE_SYSTEM_PROMPT,
        temperature: 0.1,
        maxTokens: 512,
      });

      return parseTriageResponse(response);
    } catch (error) {
      tracer.log('fast-loop', 'error', 'Triage call failed, escalating to deep loop', {
        error: error instanceof Error ? error.message : String(error),
      });
      // On failure, always escalate — safer than guessing
      return {
        classification: 'complex',
        confidence: 0.0,
        triageNotes: `Triage failed (${error instanceof Error ? error.message : 'unknown error'}) — escalating`,
      };
    }
  }

  // ── Code Review ─────────────────────────────────────────────────────────

  /**
   * Review a task's artifacts and write the review result to the TaskBoard.
   */
  async reviewTask(task: Task): Promise<void> {
    const tracer = getTracer();

    // Claim the task for review
    const claimed = this.taskBoard.claimNext('fast', ['reviewing']);
    if (!claimed || claimed.id !== task.id) return;

    tracer.log('fast-loop', 'info', `Reviewing task: ${task.id}`);

    const plan = task.plan ?? '(no plan)';
    const artifacts = task.artifacts ?? [];

    // Select context tier based on diff size
    const diffLines = countDiffLines(artifacts);
    const reviewOp = selectReviewTier(diffLines, this.config.tiers);
    const tier = selectFastTier(reviewOp);

    const reviewPrompt = buildReviewPrompt({ plan, artifacts });

    try {
      const response = await this.callWithTier(tier, {
        prompt: reviewPrompt,
        systemPrompt: REVIEW_SYSTEM_PROMPT,
        temperature: 0.1,
        maxTokens: 1024,
      });

      const outcome = parseReviewResponse(response);

      const newStatus = outcome.result === 'approved' ? 'done' as const : 'revision' as const;

      this.taskBoard.update(task.id, {
        reviewResult: outcome.result,
        reviewNotes: outcome.notes,
        reviewFeedback: outcome.feedback,
        status: newStatus,
        owner: null,
        ...(outcome.result === 'approved' ? { resolvedAt: new Date().toISOString() } : {}),
      });

      tracer.log('fast-loop', 'info', `Review complete: ${task.id} → ${outcome.result}`, {
        diffLines,
        tier,
      });
    } catch (error) {
      tracer.log('fast-loop', 'error', `Review failed for ${task.id}, auto-approving`, {
        error: error instanceof Error ? error.message : String(error),
      });

      // On review failure, approve — don't block the pipeline
      this.taskBoard.update(task.id, {
        reviewResult: 'approved',
        reviewNotes: 'Review auto-approved (LLM call failed)',
        status: 'done',
        owner: null,
        resolvedAt: new Date().toISOString(),
      });
    }
  }

  // ── Response Delivery ───────────────────────────────────────────────────

  /**
   * Deliver a completed task's userFacing response.
   */
  async deliverResponse(task: Task): Promise<void> {
    const tracer = getTracer();

    if (!task.userFacing || !task.sender) {
      this.taskBoard.markDelivered(task.id);
      return;
    }

    tracer.log('fast-loop', 'info', `Delivering response for task: ${task.id}`);

    this.addToConversation(task.sender, 'assistant', task.userFacing);
    await this.deliver(task.sender, task.userFacing);
    this.taskBoard.markDelivered(task.id);
  }

  // ── Status Reporting ────────────────────────────────────────────────────

  /**
   * Build a status summary from the TaskBoard for the user.
   */
  async buildStatusReport(): Promise<string> {
    const counts = this.taskBoard.getStatusCounts();
    const active = this.taskBoard.getActive();
    const completedToday = this.taskBoard.getCompletedToday();

    const lines: string[] = [`Active: ${active.length}, Completed today: ${completedToday}`];

    for (const task of active.slice(0, 5)) {
      const ownerTag = task.owner ? ` [${task.owner}]` : '';
      lines.push(`• ${task.id} — ${task.status}${ownerTag}: ${task.originalMessage?.slice(0, 50) ?? '?'}`);
    }

    return lines.join('\n');
  }

  // ── Conversation Management ─────────────────────────────────────────────

  /**
   * Add a message to a sender's conversation history.
   * Trims old messages when the token budget is exceeded.
   */
  private addToConversation(sender: string, role: 'user' | 'assistant', content: string): void {
    let ctx = this.conversations.get(sender);
    if (!ctx) {
      ctx = { sender, messages: [], totalTokenEstimate: 0 };
      this.conversations.set(sender, ctx);
    }

    const tokens = estimateTokens(content);
    ctx.messages.push({ role, content, timestamp: new Date().toISOString() });
    ctx.totalTokenEstimate += tokens;

    // Trim old messages if over budget
    while (ctx.totalTokenEstimate > this.config.maxConversationTokens && ctx.messages.length > 2) {
      const removed = ctx.messages.shift();
      if (removed) {
        ctx.totalTokenEstimate -= estimateTokens(removed.content);
      }
    }
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

  /**
   * Deliver a message via the registered delivery function.
   * Falls back to tracer logging if no deliverFn is set (testing/dev mode).
   */
  private async deliver(sender: string, text: string): Promise<void> {
    if (this.deliverFn) {
      await this.deliverFn(sender, text);
    } else {
      // No delivery function — log the response for debugging/testing
      const tracer = getTracer();
      tracer.log('fast-loop', 'info', `Undelivered response for ${sender}`, {
        textLength: text.length,
      });
    }
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
