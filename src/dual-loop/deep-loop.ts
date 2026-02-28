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

import type { LlmProvider, GenerateRequest, PreviousAssistantMessage } from '../providers/base.js';
import type { ConcurrentProvider } from '../providers/concurrent.js';
import type { EventBus } from '../autonomous/events.js';
import type { GoalStack } from '../autonomous/goal-stack.js';
import type { AgentToolkit } from '../autonomous/tools/types.js';
import type { ToolResultMessage } from '../tools/schemas/types.js';
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
  /** Maximum ReAct turns per task (total budget across all steps) */
  maxTurnsPerTask: number;
  /** Maximum ReAct turns per individual plan step */
  maxTurnsPerStep: number;
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
  maxTurnsPerStep: 15,
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
- For features: read context → implement → test.
- For research/query tasks (e.g., "find all X", "what does Y do", "list Z"):
  Use a SINGLE step. The executor has tools (grep, read_file, glob) and works
  best when it can freely search and read in one continuous loop rather than
  being forced through rigid sub-steps. Single-step plans preserve context
  across all tool calls.`;

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
  private readonly toolkit: AgentToolkit | null;
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
    toolkit?: AgentToolkit,
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.provider = provider;
    this.concurrentProvider = concurrentProvider;
    this.taskBoard = taskBoard;
    this.eventBus = eventBus;
    this.toolkit = toolkit ?? null;
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
    // Initialize from existing artifacts (supports parked task resume)
    const artifacts: TaskArtifact[] = [...(task.artifacts ?? [])];
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
            artifacts,
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
        // Collect completed step outputs for context continuity
        const priorSteps = steps.slice(0, i).filter((s) => s.status === 'done' && s.output);
        const result = await this.executeStep(task, step, priorSteps, steps.length);
        step.status = 'done';
        step.output = result.output;

        if (result.artifact) {
          artifacts.push(result.artifact);
        }

        stepsCompleted++;
        this.taskBoard.update(task.id, {
          planSteps: steps,
          artifacts,
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
   * Prior step outputs are included in the prompt so each step builds on
   * what previous steps discovered — solving the step isolation problem.
   */
  private async executeStep(
    task: Task,
    step: PlanStep,
    priorSteps: PlanStep[] = [],
    totalSteps: number = 1,
  ): Promise<{ output: string; artifact?: TaskArtifact }> {
    // Build prior step context — most recent step gets full output,
    // older steps get truncated to keep the prompt manageable.
    let priorContext = '';
    if (priorSteps.length > 0) {
      const sections = priorSteps.map((s, idx) => {
        const isRecent = idx >= priorSteps.length - 2; // last 2 steps get full output
        const output = isRecent
          ? s.output!
          : s.output!.slice(0, 500) + (s.output!.length > 500 ? '\n...(truncated)' : '');
        return `### Step ${idx + 1}: ${s.description}\n${output}`;
      });
      priorContext = `## Previous Step Results\n${sections.join('\n\n')}`;
    }

    const prompt = [
      `## Task: ${task.originalMessage ?? '(no message)'}`,
      `## Plan: ${task.plan ?? '(no plan)'}`,
      priorContext,
      `## Current Step: ${step.description}`,
      task.triageNotes ? `## Context: ${task.triageNotes}` : '',
    ].filter(Boolean).join('\n\n');

    // Single-step tasks get the full task budget; multi-step get per-step cap
    const maxTurns = totalSteps <= 1
      ? this.config.maxTurnsPerTask
      : this.config.maxTurnsPerStep;
    const response = await this.dispatchToCoder(prompt, '', maxTurns);

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
      }, true); // useTools — revisions need file access

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
   *
   * Uses think:false to prevent reasoning chains from leaking into
   * the user-facing text. No tools needed — this is pure text generation.
   */
  private async generateSummary(task: Task, artifacts: TaskArtifact[]): Promise<string> {
    try {
      // Include actual step outputs so the summary contains the data the user asked for
      const steps = task.planSteps ?? [];
      const stepResults = steps
        .filter((s) => s.output)
        .map((s, i) => `Step ${i + 1}: ${s.output!.slice(0, 500)}`)
        .join('\n');

      const prompt = [
        `Summarize what was done for this task for the user.`,
        ` Include the key results or data the user asked for in your summary.`,
        `\n\n## Original Request\n${task.originalMessage ?? '(unknown)'}`,
        `\n## Plan\n${task.plan ?? '(no plan)'}`,
        stepResults ? `\n## Step Results\n${stepResults}` : '',
      ].join('');

      const response = await this.callWithTier('compact', {
        prompt,
        systemPrompt: 'Write a concise summary of the completed work that includes the actual results or data the user requested. Keep it under 150 words. Plain text only, no markdown.',
        temperature: 0.3,
        maxTokens: 512,
        providerOptions: { think: false }, // Prevent thinking chain from leaking
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
   * When a toolkit is available, runs a ReAct loop so the model can
   * read files, run commands, and write code via tools.
   */
  async dispatchToCoder(prompt: string, fileContents: string, maxTurns?: number): Promise<string> {
    const totalChars = prompt.length + fileContents.length;
    const tier = selectCoderTier(totalChars, this.config.coderTiers);
    const providerOptions = buildProviderOptions(this.config.coderTiers, tier);

    const request: GenerateRequest = {
      prompt: fileContents ? `${prompt}\n\n---\n\n${fileContents}` : prompt,
      systemPrompt: this.toolkit
        ? `You are a code implementation assistant with access to tools (read_file, grep, glob, bash, etc.).

Rules:
- Use tools to read files, search code, run commands, and complete the task.
- Tool results are returned to you directly — analyze them and use the data.
- Focus on source files (src/), not build artifacts (dist/) or test output.
- When you have the answer, state it clearly with the specific data found.
- Be precise and minimal. Do not describe the tool output format — extract the actual information.
- When using grep, always set file_pattern (e.g., "*.ts") to filter results. Use simple substring patterns, not complex regex.
- If grep doesn't find what you need after 2 tries, switch to read_file on specific files instead.
- Do NOT repeat the same tool call with the same arguments — try a different approach.`
        : 'You are a code implementation assistant. Write the code changes requested. Be precise and minimal.',
      temperature: 0.1,
      maxTokens: 4096,
      providerOptions,
    };

    if (this.toolkit) {
      return this.executeWithTools(request, maxTurns ?? this.config.maxTurnsPerStep);
    }

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

  // ── Tool Execution ──────────────────────────────────────────────────────

  /**
   * Execute an LLM request with a ReAct tool loop.
   *
   * Calls the model, executes any tool calls, feeds results back, and
   * repeats until the model stops calling tools (or maxTurns is reached).
   * Falls back to a plain no-tools call when no toolkit is configured.
   */
  private async executeWithTools(
    request: GenerateRequest,
    maxTurns: number = 20,
  ): Promise<string> {
    if (!this.toolkit) {
      const response = await this.provider.generateWithTools(request, []);
      return response.text;
    }

    const tracer = getTracer();
    const tools = this.toolkit.schemas;
    let lastText = '';

    // Accumulate full conversation history so each turn sees ALL prior
    // tool results, not just the last batch. This is critical for multi-turn
    // research tasks where the model needs to synthesize data from earlier reads.
    const conversationHistory: PreviousAssistantMessage[] = [];
    const allToolResults: ToolResultMessage[] = [];

    // Budget warning threshold
    const warnAtTurn = Math.max(1, maxTurns - 2);

    for (let turn = 0; turn < maxTurns; turn++) {
      // When approaching the turn limit, inject a budget warning.
      const effectiveRequest: GenerateRequest = {
        ...(turn === warnAtTurn
          ? {
              ...request,
              prompt: `${request.prompt}\n\n[BUDGET WARNING] You have ${maxTurns - turn} tool turns remaining. Review what you've gathered so far. If you have enough information to answer, provide your final answer now without using more tools. If critical data is still missing, use your remaining turns wisely on the most important calls.`,
            }
          : request),
        // Thread full conversation history so the model sees ALL prior turns
        ...(conversationHistory.length > 0
          ? { previousAssistantMessages: conversationHistory }
          : {}),
      };

      const response = await this.provider.generateWithTools(
        effectiveRequest,
        tools,
        allToolResults.length > 0 ? allToolResults : undefined,
      );

      lastText = response.text;

      if (!response.toolCalls || response.toolCalls.length === 0) {
        break;
      }

      tracer.log('deep-loop', 'debug', `Tool turn ${turn + 1}: ${response.toolCalls.length} call(s)`, {
        tools: response.toolCalls.map((c) => c.name),
      });

      // Record this assistant turn in conversation history
      conversationHistory.push({
        text: response.text,
        toolCalls: response.toolCalls.map((tc) => ({
          id: tc.id,
          name: tc.name,
          arguments: JSON.stringify(tc.input),
        })),
      });

      // Execute tools and accumulate ALL results
      for (const call of response.toolCalls) {
        const result = await this.toolkit.execute(call);
        allToolResults.push({
          callId: call.id,
          result: result.output ?? result.error ?? '(no output)',
          isError: !result.success,
        });
      }
    }

    if (allToolResults.length > 0 && conversationHistory.length >= maxTurns) {
      tracer.log('deep-loop', 'warn', `Tool loop hit maxTurns (${maxTurns}) — forcing wrap-up`);

      // Give the model one final turn to synthesize what it found,
      // with full conversation history so it can reference all prior results.
      try {
        const wrapUpResponse = await this.provider.generateWithTools(
          {
            ...request,
            prompt: `${request.prompt}\n\n[TURN LIMIT REACHED] You have used all your tool turns. Based on everything you've gathered from the tools above, provide your final answer now. Summarize what you found. If the task is incomplete, state clearly what was found and what remains unknown.`,
            ...(conversationHistory.length > 0
              ? { previousAssistantMessages: conversationHistory }
              : {}),
          },
          [], // no tools — must produce text
          allToolResults,
        );
        return wrapUpResponse.text;
      } catch {
        // Fall back to whatever text we have
      }
    }

    return lastText;
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  /**
   * Make an LLM call with the appropriate context tier.
   *
   * When useTools is true and a toolkit is available, runs a full ReAct
   * tool loop. Otherwise makes a single no-tools call.
   */
  private async callWithTier(
    tier: ContextTier,
    request: Omit<GenerateRequest, 'providerOptions'> & { providerOptions?: Record<string, unknown> },
    useTools: boolean = false,
  ): Promise<string> {
    const tracer = getTracer();
    const numCtx = resolveNumCtx(this.config.tiers, tier);
    const estimatedPromptTokens = Math.ceil((request.prompt.length + (request.systemPrompt?.length ?? 0)) / 3.5);
    const pressure = estimatedPromptTokens / numCtx;

    if (pressure >= this.config.tiers.contextPressureWarningThreshold) {
      tracer.log('deep-loop', 'warn', 'Context pressure threshold reached', {
        tier,
        estimatedPromptTokens,
        numCtx,
        pressure,
        threshold: this.config.tiers.contextPressureWarningThreshold,
      });
    }

    const fullRequest: GenerateRequest = {
      ...request,
      providerOptions: { num_ctx: numCtx, ...request.providerOptions },
    };

    if (useTools && this.toolkit) {
      return this.executeWithTools(fullRequest);
    }

    const response = await this.provider.generateWithTools(fullRequest, []);
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
  toolkit?: AgentToolkit,
): DeepLoop {
  return new DeepLoop(provider, concurrentProvider, taskBoard, eventBus, config, toolkit);
}
