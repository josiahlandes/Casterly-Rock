/**
 * Deep Loop — The 122B reasoning and coding engine.
 *
 * Runs continuously, pulling tasks from the TaskBoard and executing them
 * via the existing AgentLoop (ReAct pattern). The DeepLoop:
 *   - Claims queued tasks and plans the approach
 *   - Generates code directly (122B handles both reasoning and coding)
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
import type { EventBus } from '../autonomous/events.js';
import type { GoalStack } from '../autonomous/goal-stack.js';
import { getTracer } from '../autonomous/debug.js';
import type { TaskBoard } from './task-board.js';
import type { Task, TaskArtifact, PlanStep } from './task-board-types.js';
import type { DeepTierConfig, CoderTierConfig, ContextTier } from './context-tiers.js';
import { selectDeepTier, selectCoderTier, resolveNumCtx, buildProviderOptions } from './context-tiers.js';
import { runIdleCheck } from './deep-loop-events.js';
import type { DeepLoopEventConfig } from './deep-loop-events.js';

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

/**
 * Result of planning a task.
 */
interface PlanResult {
  plan: string;
  steps: PlanStep[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Default Configuration
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: DeepLoopConfig = {
  model: 'qwen3.5:122b',
  coderModel: 'qwen3.5:122b',
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
// System Prompts
// ─────────────────────────────────────────────────────────────────────────────

const PLANNING_SYSTEM_PROMPT = `You are a software engineering planner. Given a user request and optional triage notes, create a concrete execution plan.

Respond with a JSON object:
{
  "plan": "High-level description of the approach",
  "steps": [
    { "description": "Step 1: ...", "status": "pending" },
    { "description": "Step 2: ...", "status": "pending" }
  ]
}

Guidelines:
- Keep plans concise: 2-5 steps for most tasks.
- Each step should be a single, testable action.
- Include a test/verify step at the end.
- For bug fixes: diagnose → fix → test.
- For features: read context → implement → test.`;

const REVISION_SYSTEM_PROMPT = `You are addressing code review feedback. The reviewer has identified issues that need to be fixed.

Read the review feedback carefully and make the necessary changes. Focus only on what was flagged — don't refactor unrelated code.`;

// ─────────────────────────────────────────────────────────────────────────────
// DeepLoop
// ─────────────────────────────────────────────────────────────────────────────

export class DeepLoop {
  private readonly config: DeepLoopConfig;
  private readonly provider: LlmProvider;
  private readonly concurrentProvider: ConcurrentProvider;
  private readonly taskBoard: TaskBoard;
  private readonly eventBus: EventBus;
  private goalStack: GoalStack | null = null;
  private eventConfig: DeepLoopEventConfig | undefined;
  private running: boolean = false;
  private currentTask: Task | null = null;
  private revisionCounts: Map<string, number> = new Map();

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
   *
   * Unlike FastLoop, this doesn't heartbeat — it works at its natural
   * pace, spending 10-60 seconds per turn.
   *
   * Priority order:
   *   1. Queued user tasks (highest priority first)
   *   2. Tasks needing revision (review feedback)
   *   3. Idle sleep
   */
  async run(): Promise<void> {
    const tracer = getTracer();
    this.running = true;
    tracer.log('deep-loop', 'info', 'DeepLoop started');

    while (this.running) {
      try {
        // 1. Claim the next queued task
        const queued = this.taskBoard.claimNext('deep', ['queued']);
        if (queued) {
          await this.processTask(queued);
          continue;
        }

        // 2. Claim a task needing revision
        const revision = this.taskBoard.claimNext('deep', ['revision']);
        if (revision) {
          await this.processRevision(revision);
          continue;
        }

        // 3. Check for events and goals during idle
        const idleResult = runIdleCheck(
          this.eventBus,
          this.goalStack,
          this.taskBoard,
          this.eventConfig,
        );
        if (idleResult.tasksCreated > 0) {
          continue; // New tasks were created — loop back to claim them
        }

        // 4. Nothing to do — idle
        await this.sleep(this.config.idleSleepMs);
      } catch (error) {
        tracer.log('deep-loop', 'error', 'DeepLoop work cycle error', {
          error: error instanceof Error ? error.message : String(error),
          currentTask: this.currentTask?.id,
        });
        // Release current task on unhandled error
        if (this.currentTask) {
          this.taskBoard.release(this.currentTask.id);
          this.currentTask = null;
        }
        await this.sleep(this.config.idleSleepMs);
      }
    }

    tracer.log('deep-loop', 'info', 'DeepLoop stopped');
  }

  /**
   * Stop the loop gracefully.
   */
  stop(): void {
    this.running = false;
  }

  /**
   * Set the GoalStack for idle-time goal work. Optional — if not set,
   * the DeepLoop only processes events during idle, not goals.
   */
  setGoalStack(goalStack: GoalStack, config?: DeepLoopEventConfig): void {
    this.goalStack = goalStack;
    this.eventConfig = config;
  }

  /** Whether the loop is currently running */
  isRunning(): boolean {
    return this.running;
  }

  /** Get the task currently being worked on */
  getCurrentTask(): Task | null {
    return this.currentTask;
  }

  // ── Task Processing ─────────────────────────────────────────────────────

  /**
   * Process a queued task: plan → execute → submit for review.
   */
  private async processTask(task: Task): Promise<void> {
    const tracer = getTracer();
    this.currentTask = task;

    tracer.log('deep-loop', 'info', `Processing task: ${task.id}`, {
      origin: task.origin,
      priority: task.priority,
      hasParkedState: !!task.parkedState,
    });

    try {
      // Transition to planning
      this.taskBoard.update(task.id, { status: 'planning' });

      // Plan the approach (unless resuming a parked task that already has a plan)
      if (!task.plan || !task.planSteps) {
        const planResult = await this.planTask(task);
        this.taskBoard.update(task.id, {
          plan: planResult.plan,
          planSteps: planResult.steps,
        });
      }

      // Re-read the task to get the updated plan
      const planned = this.taskBoard.get(task.id);
      if (!planned || !planned.planSteps) {
        tracer.log('deep-loop', 'error', `Task ${task.id} has no plan after planning phase`);
        this.failTask(task.id, 'Planning produced no steps');
        return;
      }

      // Transition to implementing
      this.taskBoard.update(task.id, { status: 'implementing' });

      // Execute each plan step
      const outcome = await this.executePlan(planned);

      if (outcome.preempted) {
        tracer.log('deep-loop', 'info', `Task ${task.id} preempted at step ${outcome.stepsCompleted}`);
        return; // Task was parked by executePlan
      }

      if (!outcome.success) {
        this.failTask(task.id, outcome.error ?? 'Execution failed');
        return;
      }

      // Submit for review
      this.taskBoard.update(task.id, {
        status: 'reviewing',
        owner: null,
        userFacing: outcome.userFacing,
        implementationNotes: outcome.notes,
      });

      tracer.log('deep-loop', 'info', `Task ${task.id} submitted for review`, {
        stepsCompleted: outcome.stepsCompleted,
        artifactCount: outcome.artifacts.length,
      });
    } catch (error) {
      tracer.log('deep-loop', 'error', `Task ${task.id} failed`, {
        error: error instanceof Error ? error.message : String(error),
      });
      this.failTask(task.id, error instanceof Error ? error.message : String(error));
    } finally {
      this.currentTask = null;
    }
  }

  // ── Planning ────────────────────────────────────────────────────────────

  /**
   * Plan a task by calling the 122B model.
   */
  private async planTask(task: Task): Promise<PlanResult> {
    const tracer = getTracer();
    const tier = selectDeepTier(task);

    const prompt = [
      `## User Request\n\n${task.originalMessage ?? '(no message)'}`,
      task.triageNotes ? `\n## Triage Notes\n\n${task.triageNotes}` : '',
      task.parkedState?.contextSnapshot ? `\n## Previous Progress\n\n${task.parkedState.contextSnapshot}` : '',
    ].join('');

    try {
      const response = await this.callWithTier(tier, {
        prompt,
        systemPrompt: PLANNING_SYSTEM_PROMPT,
        temperature: 0.2,
        maxTokens: 2048,
      });

      // Parse the plan
      const parsed = JSON.parse(response) as Record<string, unknown>;
      const plan = String(parsed['plan'] ?? '');
      const rawSteps = (parsed['steps'] as Array<Record<string, unknown>>) ?? [];

      const steps: PlanStep[] = rawSteps.map((s) => ({
        description: String(s['description'] ?? ''),
        status: 'pending' as const,
      }));

      tracer.log('deep-loop', 'info', `Plan created for ${task.id}: ${steps.length} steps`);
      return { plan, steps };
    } catch (error) {
      tracer.log('deep-loop', 'warn', `Plan parsing failed for ${task.id}, creating single-step plan`);
      // Fallback: single-step plan
      return {
        plan: task.triageNotes ?? task.originalMessage ?? 'Execute the requested task',
        steps: [{ description: 'Execute the full task', status: 'pending' as const }],
      };
    }
  }

  // ── Execution ───────────────────────────────────────────────────────────

  /**
   * Execute a planned task step by step, dispatching to the Coder for implementation.
   */
  private async executePlan(task: Task): Promise<{
    success: boolean;
    preempted: boolean;
    stepsCompleted: number;
    artifacts: TaskArtifact[];
    userFacing?: string;
    notes?: string;
    error?: string;
  }> {
    const tracer = getTracer();
    const steps = task.planSteps ?? [];
    const artifacts: TaskArtifact[] = [];
    let stepsCompleted = 0;

    // Find the first pending step (supports resuming parked tasks)
    let startIdx = steps.findIndex((s) => s.status === 'pending');
    if (startIdx < 0) startIdx = 0;

    for (let i = startIdx; i < steps.length; i++) {
      const step = steps[i];
      if (!step) continue;

      // Preemption check every N steps
      if (i > 0 && i % this.config.preemptCheckIntervalTurns === 0) {
        const preemptor = this.checkForPreemption(task.priority);
        if (preemptor) {
          // Park this task and let the higher-priority one run
          this.taskBoard.parkTask(task.id, {
            parkedAtTurn: i,
            reason: `Preempted by higher-priority task ${preemptor.id}`,
            contextSnapshot: `Completed ${stepsCompleted} of ${steps.length} steps. Artifacts: ${artifacts.length}`,
          });

          // Save progress
          const updatedSteps = steps.map((s, idx) =>
            idx < i ? { ...s, status: 'done' as const } : s,
          );
          this.taskBoard.update(task.id, {
            planSteps: updatedSteps,
            artifacts: [...(task.artifacts ?? []), ...artifacts],
          });

          return { success: false, preempted: true, stepsCompleted, artifacts };
        }
      }

      // Execute this step
      tracer.log('deep-loop', 'debug', `Executing step ${i + 1}/${steps.length}: ${step.description}`);

      // Mark step in-progress
      step.status = 'in_progress';
      this.taskBoard.update(task.id, { planSteps: steps });

      try {
        const result = await this.executeStep(task, step);
        step.status = 'done';
        step.output = result.output;

        if (result.artifact) {
          artifacts.push(result.artifact);
        }

        stepsCompleted++;
        this.taskBoard.update(task.id, {
          planSteps: steps,
          artifacts: [...(task.artifacts ?? []), ...artifacts],
        });
      } catch (error) {
        step.status = 'failed';
        step.output = error instanceof Error ? error.message : String(error);
        this.taskBoard.update(task.id, { planSteps: steps });

        tracer.log('deep-loop', 'error', `Step ${i + 1} failed: ${step.output}`);
        return {
          success: false,
          preempted: false,
          stepsCompleted,
          artifacts,
          error: `Step ${i + 1} failed: ${step.output}`,
        };
      }
    }

    // All steps done — generate user-facing summary
    const userFacing = await this.generateSummary(task, artifacts);

    return {
      success: true,
      preempted: false,
      stepsCompleted,
      artifacts,
      userFacing,
      notes: `Completed ${stepsCompleted} steps, produced ${artifacts.length} artifacts`,
    };
  }

  /**
   * Execute a single plan step by dispatching to the Coder.
   */
  private async executeStep(
    task: Task,
    step: PlanStep,
  ): Promise<{ output: string; artifact?: TaskArtifact }> {
    const prompt = [
      `## Task: ${task.originalMessage ?? '(no message)'}`,
      `## Plan: ${task.plan ?? '(no plan)'}`,
      `## Current Step: ${step.description}`,
      task.triageNotes ? `## Context: ${task.triageNotes}` : '',
    ].join('\n\n');

    const response = await this.dispatchToCoder(prompt, '');

    // Create an artifact from the response if it contains code
    const hasCode = response.includes('```') || response.includes('diff');
    if (hasCode) {
      return {
        output: response.slice(0, 2000),
        artifact: {
          type: 'file_diff',
          content: response.slice(0, 10_000), // Truncate for storage
          timestamp: new Date().toISOString(),
        },
      };
    }
    return { output: response.slice(0, 2000) };
  }

  // ── Revision Handling ───────────────────────────────────────────────────

  /**
   * Address review feedback from the FastLoop.
   */
  private async processRevision(task: Task): Promise<void> {
    const tracer = getTracer();
    this.currentTask = task;

    try {
      const revisionCount = (this.revisionCounts.get(task.id) ?? 0) + 1;
      this.revisionCounts.set(task.id, revisionCount);

      if (revisionCount > this.config.maxRevisionRounds) {
        tracer.log('deep-loop', 'warn', `Task ${task.id} exceeded max revision rounds (${this.config.maxRevisionRounds})`);
        this.failTask(task.id, `Exceeded ${this.config.maxRevisionRounds} revision rounds`);
        return;
      }

      tracer.log('deep-loop', 'info', `Addressing revision for ${task.id} (round ${revisionCount})`);

      this.taskBoard.update(task.id, { status: 'implementing' });

      const tier = selectDeepTier(task);
      const prompt = [
        `## Original Request\n\n${task.originalMessage ?? '(no message)'}`,
        `## Plan\n\n${task.plan ?? '(no plan)'}`,
        `## Review Feedback\n\n${task.reviewFeedback ?? task.reviewNotes ?? '(no feedback)'}`,
        task.artifacts?.length
          ? `## Previous Artifacts\n\n${task.artifacts.map((a) => a.content ?? '').join('\n---\n')}`
          : '',
      ].join('\n\n');

      const response = await this.callWithTier(tier, {
        prompt,
        systemPrompt: REVISION_SYSTEM_PROMPT,
        temperature: 0.2,
        maxTokens: 4096,
      });

      // Create a new artifact from the revision
      const artifact: TaskArtifact = {
        type: 'file_diff',
        content: response.slice(0, 10_000),
        timestamp: new Date().toISOString(),
      };

      const existingArtifacts = task.artifacts ?? [];

      // Generate updated user-facing summary
      const userFacing = await this.generateSummary(task, [...existingArtifacts, artifact]);

      // Resubmit for review
      this.taskBoard.update(task.id, {
        status: 'reviewing',
        owner: null,
        artifacts: [...existingArtifacts, artifact],
        userFacing,
        reviewResult: undefined,
        reviewNotes: undefined,
        reviewFeedback: undefined,
      });

      tracer.log('deep-loop', 'info', `Revision complete for ${task.id}, resubmitted for review`);
    } catch (error) {
      tracer.log('deep-loop', 'error', `Revision failed for ${task.id}`, {
        error: error instanceof Error ? error.message : String(error),
      });
      this.failTask(task.id, error instanceof Error ? error.message : String(error));
    } finally {
      this.currentTask = null;
    }
  }

  // ── Summary Generation ──────────────────────────────────────────────────

  /**
   * Generate a user-facing summary of the completed work.
   */
  private async generateSummary(task: Task, artifacts: TaskArtifact[]): Promise<string> {
    try {
      const prompt = [
        `Summarize what was done for this task in 2-3 sentences for the user.`,
        `\n## Original Request\n${task.originalMessage ?? '(unknown)'}`,
        `\n## Plan\n${task.plan ?? '(no plan)'}`,
        `\n## Artifacts Created\n${artifacts.length} artifact(s)`,
      ].join('');

      const response = await this.callWithTier('compact', {
        prompt,
        systemPrompt: 'Write a brief, friendly summary of the completed work. Keep it under 100 words.',
        temperature: 0.3,
        maxTokens: 256,
      });

      return response;
    } catch {
      // Fallback summary if generation fails
      return `Done — completed ${task.plan ?? 'your request'}.`;
    }
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
      prompt: fileContents ? `${prompt}\n\n---\n\n${fileContents}` : prompt,
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

  // ── Preemption ──────────────────────────────────────────────────────────

  /**
   * Check the TaskBoard for higher-priority work. Called every N turns.
   */
  private checkForPreemption(currentPriority: number): Task | null {
    return this.taskBoard.getHigherPriorityTask(currentPriority);
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
   * Mark a task as failed and release it.
   */
  private failTask(id: string, reason: string): void {
    this.taskBoard.update(id, {
      status: 'failed',
      owner: null,
      resolution: reason,
      resolvedAt: new Date().toISOString(),
    });
    this.revisionCounts.delete(id);
  }

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
