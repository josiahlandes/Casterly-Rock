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
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Task, TaskArtifact, PlanStep, FileOperation, HandoffSnapshot } from './task-board-types.js';
import { buildHandoffSnapshot, serializeHandoff } from './handoff.js';
import { detectProjectDir, writeProjectMd } from './project-store.js';
import type { DeepTierConfig, CoderTierConfig, ContextTier } from './context-tiers.js';
import { selectDeepTier, selectDeepReviewTier, selectCoderTier, resolveNumCtx, buildProviderOptions, checkContextPressure, buildPressureWarning, compressPrompt } from './context-tiers.js';
import type { ReviewResult } from './task-board-types.js';
import { REVIEW_SYSTEM_PROMPT, REVIEW_FORMAT_SCHEMA, CASCADE_REVIEW_PROMPTS, buildReviewPrompt, parseReviewResponse } from './review-prompt.js';
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
    extended: 131072,
    contextPressureSoftThreshold: 0.70,
    contextPressureWarningThreshold: 0.80,
    contextPressureActionThreshold: 0.85,
  },
  coderTiers: {
    compact: 8192,
    standard: 16384,
    extended: 65536,
    responseBufferTokens: 2000,
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// JSON Extraction (for parsing LLM responses that include <think> blocks)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extract a JSON object from an LLM response that may contain `<think>` blocks,
 * markdown fences, or other surrounding text.
 *
 * Strategy (in order):
 *   1. Strip `<think>...</think>` blocks (qwen3.5 thinking output)
 *   2. Strip markdown ```json ... ``` fences
 *   3. Try JSON.parse on the cleaned text
 *   4. Fallback: extract the first balanced `{...}` block and parse that
 *
 * Returns `{ json, thinking }` where `thinking` is the extracted `<think>`
 * content (if any) for logging/debugging.
 */
export function extractJsonFromResponse(raw: string): {
  json: Record<string, unknown>;
  thinking: string | null;
} {
  // 1. Extract and remove <think> blocks
  let thinking: string | null = null;
  let cleaned = raw;

  const thinkMatch = raw.match(/<think>([\s\S]*?)<\/think>/);
  if (thinkMatch) {
    thinking = thinkMatch[1]!.trim();
    cleaned = raw.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  }

  // 2. Strip markdown fences (```json ... ``` or ``` ... ```)
  cleaned = cleaned.replace(/^```(?:json)?\s*\n?/m, '').replace(/\n?```\s*$/m, '').trim();

  // 3. Try direct parse
  try {
    return { json: JSON.parse(cleaned) as Record<string, unknown>, thinking };
  } catch {
    // continue to fallback
  }

  // 4. Fallback: find the first balanced { ... } block
  const startIdx = cleaned.indexOf('{');
  if (startIdx >= 0) {
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = startIdx; i < cleaned.length; i++) {
      const ch = cleaned[i]!;

      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\' && inString) {
        escaped = true;
        continue;
      }
      if (ch === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;

      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          const block = cleaned.slice(startIdx, i + 1);
          return { json: JSON.parse(block) as Record<string, unknown>, thinking };
        }
      }
    }
  }

  // Nothing worked
  throw new Error(`No valid JSON found in response (length=${raw.length})`);
}

// ─────────────────────────────────────────────────────────────────────────────
// System Prompts
// ─────────────────────────────────────────────────────────────────────────────

const PLANNING_SYSTEM_PROMPT = `You are a software engineering planner. Given a user request and optional triage notes, create a concrete execution plan.

You MUST respond with ONLY a valid JSON object (no additional text outside the JSON):
{
  "plan": "High-level description of the approach",
  "steps": [
    { "description": "Step 1: ...", "status": "pending", "context": "Only the spec sections relevant to this step" },
    { "description": "Step 2: ...", "status": "pending", "context": "Only the spec sections relevant to this step" }
  ]
}

## Step Context (CRITICAL)

For each step, include a "context" field containing ONLY the parts of the user request that are relevant to that step. Do NOT repeat the full specification in every step. The coder executing each step will ONLY see the step's context, not the full request. This prevents the coder from running ahead and implementing future steps.

Example: If the user asks for a game with a player, enemies, and particles:
- Step 1 context: "Create project structure. index.html with canvas element, config.js with screen dimensions and colors."
- Step 2 context: "Create player.js. Player class with x/y position, speed=5, draw() method on canvas, moveLeft/moveRight responding to arrow keys."
- Step 3 context: "Create enemies.js. Enemy grid 5x4, each enemy 30x30px, move horizontally and drop when hitting edges."

## Step Sizing Guidelines

Choose the right number of steps for the task complexity:

**1 step** — Research, queries, simple lookups:
  "Find all usages of X", "What does Y do?", "List files matching Z".
  The executor has tools (grep, read_file, glob) and works best when it can
  freely search in one continuous loop. Single-step plans preserve context
  across all tool calls.

**2-5 steps** — Bug fixes, small features, refactors:
  - Bug fixes: diagnose → fix → test.
  - Features: read context → implement → test.
  - Refactors: analyze → transform → verify.

**5-12 steps** — Multi-file projects (games, apps, full features):
  When creating multiple files, give each logical module its OWN step.
  This is critical: each step has a turn budget, and cramming too many
  files into one step risks timeout or incomplete output.

  Example for a multi-file web project:
  Step 1: Create project structure and configuration (index.html, config.js)
  Step 2: Implement core module A (player.js, input.js)
  Step 3: Implement core module B (enemies.js, collision.js)
  Step 4: Implement supporting systems (particles.js, audio.js, hud.js)
  Step 5: Implement entry point that wires modules together (main.js)
  Step 6: Test and verify the project runs correctly

## Directory Structure

Before writing steps, choose ONE consistent directory structure and state it in the plan field.
- **Code projects** (games, apps, tools, websites): ALWAYS place all files under \`projects/<slug>/\`
  where <slug> is a short kebab-case name (e.g., \`projects/neon-invaders/\`, \`projects/todo-app/\`).
- All files of the same type (e.g., JavaScript modules) should go in the SAME directory unless the spec explicitly requires otherwise.
- Do NOT split files between root and a subdirectory (e.g., config.js at root AND js/config.js is WRONG).
- The FIRST step should establish the directory structure and create foundational/config files.
- Use explicit relative paths in step descriptions (e.g., "Create projects/neon-invaders/player.js" not "Create player module").

## Rules

- Each step should produce tangible, testable output.
- Order steps by dependency: foundational modules first, entry point last.
- The entry point / main file that imports everything should ALWAYS be its own step, done LAST.
- Include a test/verify step at the end.
- Every file that will exist must appear in at least one step description with its FULL relative path.
- Do not create steps that only "plan" or "outline" — every step must DO something.`;

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
  /** File operations tracked during the current executeWithTools call */
  private stepFileOps: FileOperation[] = [];
  /** Rich export summaries keyed by file path — survives across steps within a task */
  private exportSummaries: Map<string, string> = new Map();
  /** Reference to the full workspace manifest for import validation across steps */
  private currentManifest: FileOperation[] = [];

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

      // Write or update PROJECT.md for the project (non-fatal)
      const projectDir = task.projectDir
        ?? (outcome.workspaceManifest ? detectProjectDir(outcome.workspaceManifest) : null);
      if (projectDir && outcome.workspaceManifest && outcome.workspaceManifest.length > 0) {
        try {
          const planned = this.taskBoard.get(task.id);
          await writeProjectMd({
            projectRoot: process.cwd(),
            projectDir,
            isUpdate: !!task.projectDir,  // Pre-set from triage = continuing existing project
            ...(task.originalMessage ? { originalMessage: task.originalMessage } : {}),
            ...(planned?.plan ? { plan: planned.plan } : {}),
            ...(planned?.planSteps ? { planSteps: planned.planSteps } : {}),
            manifest: outcome.workspaceManifest,
            ...(outcome.userFacing ? { userFacing: outcome.userFacing } : {}),
            taskId: task.id,
          });
          tracer.log('deep-loop', 'info', `PROJECT.md written for ${projectDir}`);
        } catch (err) {
          tracer.log('deep-loop', 'warn', `Failed to write PROJECT.md for ${projectDir}`, {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // Verification cascade: multi-file tasks get 2 review passes (correctness + security).
      // Single-file or simple tasks get the standard single review pass.
      const fileCount = outcome.workspaceManifest?.length ?? 0;
      const stepCount = planned?.planSteps?.length ?? 0;
      const isHighStakes = fileCount >= 3 || stepCount >= 3;
      const verificationPasses = isHighStakes ? 2 : 1;

      // Update task with implementation results before self-review
      this.taskBoard.update(task.id, {
        status: 'reviewing',
        owner: 'deep', // Keep ownership during self-review
        userFacing: outcome.userFacing,
        implementationNotes: outcome.notes,
        ...(outcome.workspaceManifest && outcome.workspaceManifest.length > 0
          ? { workspaceManifest: outcome.workspaceManifest }
          : {}),
        ...(projectDir ? { projectDir } : {}),
        ...(verificationPasses > 1 ? { verificationPasses, currentVerificationPass: 0 } : {}),
      });

      tracer.log('deep-loop', 'info', `Task ${task.id} entering self-review`, {
        stepsCompleted: outcome.stepsCompleted,
        artifactCount: outcome.artifacts.length,
        verificationPasses,
      });

      // Self-review: DeepLoop reviews its own output with the 122B model
      const reviewResult = await this.selfReview(this.taskBoard.get(task.id)!);

      if (reviewResult.approved) {
        this.taskBoard.update(task.id, {
          status: 'done',
          owner: null,
          reviewResult: reviewResult.reviewResult,
          reviewNotes: reviewResult.reviewNotes,
          resolvedAt: new Date().toISOString(),
        });
        tracer.log('deep-loop', 'info', `Task ${task.id} self-review approved, marking done`);
      } else {
        this.taskBoard.update(task.id, {
          status: 'revision',
          owner: null,
          reviewResult: reviewResult.reviewResult,
          reviewNotes: reviewResult.reviewNotes,
          reviewFeedback: reviewResult.reviewFeedback,
          currentVerificationPass: 0,
        });
        tracer.log('deep-loop', 'info', `Task ${task.id} self-review requests changes, routing to revision`);
      }
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

    // If continuing an existing project, inject its PROJECT.md as context
    let existingProjectContext = '';
    if (task.projectDir) {
      try {
        const content = await readFile(join(process.cwd(), task.projectDir, 'PROJECT.md'), 'utf8');
        existingProjectContext = `\n## Existing Project\n\n${content.slice(0, 3000)}`;
        tracer.log('deep-loop', 'debug', `Injected PROJECT.md context for ${task.projectDir}`);
      } catch {
        // New project or missing file — no context to inject
      }
    }

    const prompt = [
      `## User Request\n\n${task.originalMessage ?? '(no message)'}`,
      task.triageNotes ? `\n## Triage Notes\n\n${task.triageNotes}` : '',
      task.parkedState?.handoff
        ? `\n## Previous Progress (Structured)\n\n${serializeHandoff(task.parkedState.handoff)}`
        : task.parkedState?.contextSnapshot
          ? `\n## Previous Progress\n\n${task.parkedState.contextSnapshot}`
          : '',
      existingProjectContext,
    ].join('');

    let rawResponse: string | null = null;

    try {
      // Thinking is left ON — planning benefits from chain-of-thought reasoning.
      // We extract the <think> block separately and parse only the JSON output.
      rawResponse = await this.callWithTier(tier, {
        prompt,
        systemPrompt: PLANNING_SYSTEM_PROMPT,
        temperature: 0.2,
        maxTokens: 4096,
      });

      // Extract JSON from response (strips <think> blocks, markdown fences)
      const { json: parsed, thinking } = extractJsonFromResponse(rawResponse);

      // Log thinking for plan introspection / debugging
      if (thinking) {
        tracer.log('deep-loop', 'debug', `Plan thinking for ${task.id}`, {
          thinking: thinking.slice(0, 1000),
        });
      }

      const plan = String(parsed['plan'] ?? '');
      const rawSteps = (parsed['steps'] as Array<Record<string, unknown>>) ?? [];

      const steps: PlanStep[] = rawSteps.map((s) => ({
        description: String(s['description'] ?? ''),
        status: 'pending' as const,
      }));

      tracer.log('deep-loop', 'info', `Plan created for ${task.id}: ${steps.length} steps`);
      return { plan, steps };
    } catch (error) {
      // Log the raw response so we can diagnose why parsing failed
      tracer.log('deep-loop', 'warn', `Plan parsing failed for ${task.id}, creating single-step plan`, {
        error: error instanceof Error ? error.message : String(error),
        ...(rawResponse ? { rawResponseHead: rawResponse.slice(0, 500) } : {}),
      });
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
    workspaceManifest?: FileOperation[];
    userFacing?: string;
    notes?: string;
    error?: string;
  }> {
    const tracer = getTracer();
    const steps = task.planSteps ?? [];
    // Initialize from existing artifacts (supports parked task resume)
    const artifacts: TaskArtifact[] = [...(task.artifacts ?? [])];
    let stepsCompleted = 0;

    // Workspace manifest: tracks files created/modified across ALL steps.
    // This gives each step awareness of what earlier steps produced,
    // preventing naming inconsistencies and import mismatches.
    const workspaceManifest: FileOperation[] = [];
    this.exportSummaries.clear();

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
          const handoff = buildHandoffSnapshot({
            steps,
            artifacts,
            manifest: task.workspaceManifest ?? [],
          });

          this.taskBoard.parkTask(task.id, {
            parkedAtTurn: i,
            reason: `Preempted by higher-priority task ${preemptor.id}`,
            contextSnapshot: serializeHandoff(handoff),
            handoff,
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

      // Reset per-step file operation tracking
      this.stepFileOps = [];
      this.currentManifest = workspaceManifest;

      try {
        // Collect completed step outputs for context continuity
        const priorSteps = steps.slice(0, i).filter((s) => s.status === 'done' && s.output);
        const result = await this.executeStep(task, step, priorSteps, steps.length, workspaceManifest, steps, i);

        // Merge file operations tracked during this step into the manifest
        for (const op of this.stepFileOps) {
          const existing = workspaceManifest.find((f) => f.path === op.path);
          if (existing) {
            if (op.lines !== undefined) existing.lines = op.lines;
            if (op.exports) existing.exports = op.exports; // Update exports on overwrite
          } else {
            workspaceManifest.push(op);
          }
        }

        if (workspaceManifest.length > 0) {
          const collisions = this.detectBaseNameCollisions(workspaceManifest);
          tracer.log('deep-loop', 'debug', `Workspace manifest: ${workspaceManifest.length} files tracked`, {
            files: workspaceManifest.map((f) => f.path),
            ...(collisions.length > 0 ? { collisions } : {}),
          });
          if (collisions.length > 0) {
            tracer.log('deep-loop', 'warn', `Basename collisions detected after step ${i + 1}`, {
              collisions,
            });
          }
        }

        // Detect files mentioned in the step description but not created
        const missingFromStep = this.detectMissingStepFiles(step.description, this.stepFileOps);
        if (missingFromStep.length > 0) {
          tracer.log('deep-loop', 'warn', `Step ${i + 1} may have missed files`, { missing: missingFromStep });
        }

        step.status = 'done';
        step.output = result.output;

        // Append missing-file warnings to step output so next step sees them
        if (missingFromStep.length > 0) {
          step.output += `\n⚠ FILES NOT CREATED: ${missingFromStep.join(', ')} — mentioned in step description but not found in workspace.`;
        }

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
        const errMsg = error instanceof Error ? error.message : String(error);
        const errStack = error instanceof Error ? error.stack?.split('\n').slice(0, 3).join(' ') : undefined;
        const errCause = error instanceof Error && 'cause' in error && error.cause instanceof Error
          ? error.cause.message : undefined;
        step.output = errCause ? `${errMsg} (cause: ${errCause})` : errMsg;
        this.taskBoard.update(task.id, { planSteps: steps });

        tracer.log('deep-loop', 'error', `Step ${i + 1} failed: ${step.output}`, {
          ...(errStack ? { stack: errStack } : {}),
          ...(errCause ? { cause: errCause } : {}),
        });
        return {
          success: false,
          preempted: false,
          stepsCompleted,
          artifacts,
          error: `Step ${i + 1} failed: ${step.output}`,
        };
      }
    }

    // ── Cross-file API validation ──────────────────────────────────────
    // After all plan steps complete, programmatically check that every
    // method/property call on imported objects actually exists in the
    // source module. If mismatches are found, inject a targeted fix step.
    if (workspaceManifest.length >= 2) {
      const maxFixRounds = 2;
      for (let fixRound = 0; fixRound < maxFixRounds; fixRound++) {
        const apiIssues = await this.crossValidateAPIs(workspaceManifest);
        if (apiIssues.length === 0) {
          tracer.log('deep-loop', 'info', `API validation passed${fixRound > 0 ? ` (after ${fixRound} fix round(s))` : ''}`);
          break;
        }

        tracer.log('deep-loop', 'warn', `API validation found ${apiIssues.length} issues (fix round ${fixRound + 1})`, {
          issues: apiIssues.slice(0, 15),
        });

        // Inject a fix step with the specific issues listed
        const issueList = apiIssues.slice(0, 20).join('\n');
        const fixStep: PlanStep = {
          description: `Validate and fix cross-file API mismatches:\n${issueList}`,
          status: 'in_progress',
        };
        steps.push(fixStep);
        this.taskBoard.update(task.id, { planSteps: steps });

        // Reset per-step tracking
        this.stepFileOps = [];
        this.currentManifest = workspaceManifest;

        try {
          const priorSteps = steps.slice(0, steps.length - 1).filter((s) => s.status === 'done' && s.output);
          const result = await this.executeStep(
            task, fixStep, priorSteps, steps.length, workspaceManifest, steps, steps.length - 1,
          );

          // Merge file operations from the fix step
          for (const op of this.stepFileOps) {
            const existing = workspaceManifest.find((f) => f.path === op.path);
            if (existing) {
              if (op.lines !== undefined) existing.lines = op.lines;
              if (op.exports) existing.exports = op.exports;
            } else {
              workspaceManifest.push(op);
            }
          }

          fixStep.status = 'done';
          fixStep.output = result.output;
          if (result.artifact) artifacts.push(result.artifact);
          stepsCompleted++;
          this.taskBoard.update(task.id, { planSteps: steps, artifacts });
        } catch (error) {
          fixStep.status = 'failed';
          fixStep.output = error instanceof Error ? error.message : String(error);
          this.taskBoard.update(task.id, { planSteps: steps });
          tracer.log('deep-loop', 'error', `API fix step failed (round ${fixRound + 1})`, {
            error: fixStep.output,
          });
          break; // Don't retry on failure
        }
      }
    }

    // All steps done — generate user-facing summary
    const userFacing = await this.generateSummary(task, artifacts);

    return {
      success: true,
      preempted: false,
      stepsCompleted,
      artifacts,
      ...(workspaceManifest.length > 0 ? { workspaceManifest } : {}),
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
    manifest: FileOperation[] = [],
    allSteps: PlanStep[] = [],
    stepIndex: number = 0,
  ): Promise<{ output: string; artifact?: TaskArtifact }> {
    // Build structured handoff from prior steps
    let priorContext = '';
    if (priorSteps.length > 0) {
      const sections = priorSteps.map((s, idx) => {
        const isRecent = idx >= priorSteps.length - 1; // last 1 step gets full output
        const output = isRecent
          ? s.output!
          : s.output!.slice(0, 300) + (s.output!.length > 300 ? '\n...(truncated)' : '');
        return `### Step ${idx + 1}: ${s.description}\n${output}`;
      });
      priorContext = `## Previous Step Results\n${sections.join('\n\n')}`;
    }

    // Build "upcoming steps" summary so the model knows what's coming
    let upcomingContext = '';
    const remainingSteps = allSteps.slice(stepIndex + 1).filter((s) => s.status === 'pending');
    if (remainingSteps.length > 0) {
      const upcoming = remainingSteps.map((s, idx) => `${stepIndex + 2 + idx}. ${s.description}`);
      upcomingContext = `## Upcoming Steps\n${upcoming.join('\n')}\nDo NOT implement these yet — but be aware of future needs when designing APIs and exports.`;
    }

    // Inject workspace manifest so the model knows what files exist
    const manifestContext = this.formatWorkspaceManifest(manifest);

    // Use step-scoped context when available (from planner), otherwise fall
    // back to the full task message. Step-scoped context prevents the coder
    // from running ahead — it only sees spec sections relevant to this step.
    const taskContext = step.context
      ? `## Task Overview: ${(task.plan ?? task.originalMessage ?? '(no message)').slice(0, 150)}\n\n## Step Context\n${step.context}`
      : `## Task: ${task.originalMessage ?? '(no message)'}\n\n## Plan: ${task.plan ?? '(no plan)'}`;

    const prompt = [
      taskContext,
      manifestContext,
      priorContext,
      `## Current Step (${stepIndex + 1}/${allSteps.length}): ${step.description}`,
      upcomingContext,
      task.triageNotes ? `## Context: ${task.triageNotes}` : '',
      `## Instructions\nComplete ALL work described in the current step before stopping. Create every file mentioned, write complete implementations (not stubs), and verify imports match existing files in the workspace manifest. If files already exist from a prior step, read them and verify cross-file API compatibility: every method/property call on an imported object must exist in that module's source code. Fix mismatches using edit_file.`,
    ].filter(Boolean).join('\n\n');

    // Single-step tasks get the full task budget; multi-step get per-step cap
    let maxTurns = totalSteps <= 1
      ? this.config.maxTurnsPerTask
      : this.config.maxTurnsPerStep;

    // Review/verify/test/fix steps get double the turn budget so the model
    // has room to read dependencies, cross-check APIs, and apply fixes.
    if (/\b(test|verify|review|validate|integration|fix)\b/i.test(step.description)) {
      maxTurns = Math.min(maxTurns * 2, this.config.maxTurnsPerTask);
    }
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
        maxTokens: 8192,
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

      // Self-review the revised output. Keep ownership during review.
      this.taskBoard.update(task.id, {
        status: 'reviewing',
        owner: 'deep',
        artifacts: [...existingArtifacts, artifact],
        userFacing,
        reviewResult: undefined,
        reviewNotes: undefined,
        reviewFeedback: undefined,
        ...(task.verificationPasses ? { currentVerificationPass: 0 } : {}),
      });

      const reviewResult = await this.selfReview(this.taskBoard.get(task.id)!);

      if (reviewResult.approved) {
        this.taskBoard.update(task.id, {
          status: 'done',
          owner: null,
          reviewResult: reviewResult.reviewResult,
          reviewNotes: reviewResult.reviewNotes,
          resolvedAt: new Date().toISOString(),
        });
        tracer.log('deep-loop', 'info', `Revision for ${task.id} self-review approved, marking done`);
      } else {
        this.taskBoard.update(task.id, {
          status: 'revision',
          owner: null,
          reviewResult: reviewResult.reviewResult,
          reviewNotes: reviewResult.reviewNotes,
          reviewFeedback: reviewResult.reviewFeedback,
          currentVerificationPass: 0,
        });
        tracer.log('deep-loop', 'info', `Revision for ${task.id} self-review requests further changes`);
      }
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

  // ── Self-Review ─────────────────────────────────────────────────────────

  /**
   * Self-review the task's artifacts using the 122B model.
   *
   * Single structured-output generate call per cascade pass (NOT a ReAct
   * tool loop). The model reviews its own output for correctness and security.
   *
   * For high-stakes tasks, runs multiple passes:
   *   Pass 0: Correctness review (REVIEW_SYSTEM_PROMPT)
   *   Pass 1: Security review (CASCADE_REVIEW_PROMPTS[0])
   */
  private async selfReview(task: Task): Promise<{
    approved: boolean;
    reviewResult: ReviewResult;
    reviewNotes: string;
    reviewFeedback?: string;
  }> {
    const tracer = getTracer();
    const plan = task.plan ?? '(no plan)';
    const artifacts = task.artifacts ?? [];
    const totalPasses = task.verificationPasses ?? 1;
    let currentPass = task.currentVerificationPass ?? 0;

    while (currentPass < totalPasses) {
      const systemPrompt = currentPass === 0
        ? REVIEW_SYSTEM_PROMPT
        : CASCADE_REVIEW_PROMPTS[currentPass - 1] ?? REVIEW_SYSTEM_PROMPT;

      const reviewPrompt = buildReviewPrompt({ plan, artifacts });

      // Select tier based on measured content size
      const tier = selectDeepReviewTier(
        reviewPrompt.length,
        systemPrompt.length,
        this.config.tiers,
        1024,
      );

      tracer.log('deep-loop', 'info',
        `Self-review pass ${currentPass + 1}/${totalPasses} for ${task.id}`, {
          tier,
          promptChars: reviewPrompt.length,
        });

      const response = await this.callWithTier(tier, {
        prompt: reviewPrompt,
        systemPrompt,
        temperature: 0.1,
        maxTokens: 1024,
        providerOptions: { format: REVIEW_FORMAT_SCHEMA, think: false },
      });

      const outcome = parseReviewResponse(response);

      // Write intermediate review state to TaskBoard for visibility
      this.taskBoard.update(task.id, {
        reviewResult: outcome.result,
        reviewNotes: outcome.notes,
        reviewFeedback: outcome.feedback,
        currentVerificationPass: currentPass,
      });

      if (outcome.result !== 'approved') {
        tracer.log('deep-loop', 'info',
          `Self-review pass ${currentPass + 1} found issues for ${task.id}: ${outcome.result}`, {
            notes: outcome.notes?.slice(0, 200),
          });
        return {
          approved: false,
          reviewResult: outcome.result,
          reviewNotes: outcome.notes,
          ...(outcome.feedback ? { reviewFeedback: outcome.feedback } : {}),
        };
      }

      tracer.log('deep-loop', 'info',
        `Self-review pass ${currentPass + 1}/${totalPasses} approved for ${task.id}`);
      currentPass++;
    }

    return {
      approved: true,
      reviewResult: 'approved',
      reviewNotes: `All ${totalPasses} review pass(es) approved`,
    };
  }

  // ── Coder Dispatch ──────────────────────────────────────────────────────

  /**
   * Dispatch a plan step to the Coder model for implementation.
   * When a toolkit is available, runs a ReAct loop so the model can
   * read files, run commands, and write code via tools.
   */
  async dispatchToCoder(prompt: string, fileContents: string, maxTurns?: number): Promise<string> {
    const totalChars = prompt.length + fileContents.length;
    const baseTier = selectCoderTier(totalChars, this.config.coderTiers);
    // Force extended tier when multi-turn tool loops are expected — the initial
    // prompt size underestimates actual context usage after 10+ tool turns of
    // accumulated conversation history, read_file results, and create_file contents.
    const tier = (maxTurns ?? this.config.maxTurnsPerStep) > 5 ? 'extended' as const : baseTier;
    const providerOptions = buildProviderOptions(this.config.coderTiers, tier);

    const request: GenerateRequest = {
      prompt: fileContents ? `${prompt}\n\n---\n\n${fileContents}` : prompt,
      systemPrompt: this.toolkit
        ? `You are a code implementation assistant with access to tools (create_file, edit_file, read_file, grep, glob, bash).

CRITICAL RULES:
- You MUST use create_file or edit_file tools to write code. Writing code in your text response does NOT create files on disk. The ONLY way to create or modify files is through tool calls.
- Use create_file for new files. If the file already exists, pass overwrite: true to replace it. Use edit_file for small modifications to existing files.
- File paths must be FULL relative paths from the project root (e.g., "projects/neon-invaders/js/config.js", NOT "js/config.js").
- NEVER output a complete file as text. Always use create_file with the content.

IMPORT/EXPORT RULES:
- The Workspace Manifest shows export types: [default] = use \`import Name from './file.js'\`, [named] = use \`import { Name } from './file.js'\`.
- Before writing a file that imports from another, use read_file on the dependency to verify its exact exports and constructor parameters.
- NEVER guess an import path or export name — check the manifest or read the file first.
- When the manifest shows constructor params like \`class Player(x, y)\`, use EXACTLY those parameters when constructing.
- After writing or editing a file, verify every obj.method() call on an imported object actually exists as a method in that module. If unsure, use read_file to check.
- Config property names must EXACTLY match the config file. Read config before using any config.PROP access.
- When a step says "verify" or "test", systematically: (1) read each file, (2) for each import, read the dependency, (3) confirm every method/property call exists in the source, (4) fix mismatches with edit_file.

Other rules:
- Tool results are returned to you directly — analyze them and use the data.
- Be precise and minimal. Do not describe tool output — extract the actual information.
- When using grep, set file_pattern (e.g., "*.ts"). Use simple substring patterns, not complex regex.
- If grep doesn't find what you need after 2 tries, switch to read_file on specific files.
- Do NOT repeat the same tool call with the same arguments — try a different approach.
- When a Workspace Manifest is provided, use the EXACT file paths listed.
- Maintain consistent naming conventions (camelCase, PascalCase, kebab-case) with files already created.`
        : 'You are a code implementation assistant. Write the code changes requested. Be precise and minimal.',
      temperature: 0.1,
      maxTokens: 8192,
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
        // Detect code-in-text: the model output code fences instead of calling
        // create_file. Two detection modes:
        //   1. Never used file tools AND output any code fences
        //   2. Output 2+ substantial code blocks (10+ lines each) — even if file
        //      tools were used in earlier turns, the model is dumping file contents
        const hasCodeFences = (lastText.match(/```/g) ?? []).length >= 2;
        const usedCreateFile = conversationHistory.some((h) =>
          h.toolCalls?.some((tc) => tc.name === 'create_file' || tc.name === 'edit_file'),
        );
        const neverUsedTools = hasCodeFences && !usedCreateFile;

        // Count substantial code blocks (10+ lines) — these are likely complete files
        const codeBlocks = lastText.match(/```[\s\S]*?```/g) ?? [];
        const substantialBlocks = codeBlocks.filter((b) => b.split('\n').length >= 10);
        const dumpedFiles = substantialBlocks.length >= 1;

        if ((neverUsedTools || dumpedFiles) && turn < maxTurns - 1) {
          tracer.log('deep-loop', 'warn',
            `Code-in-text detected — ${neverUsedTools ? 'no file tool calls yet' : `${substantialBlocks.length} substantial code blocks dumped as text`}`,
          );
          // Record this text-only turn in history so the model sees what it wrote
          conversationHistory.push({ text: response.text, toolCalls: [] });
          // Inject a correction as a synthetic tool result
          allToolResults.push({
            callId: `nudge-${turn}`,
            result: '[SYSTEM] You wrote code in your text response, but that does NOT create files on disk. You MUST call create_file for each file. Re-read your text above and call create_file with the correct path and content for each file you intended to create.',
            isError: true,
          });
          continue; // Don't break — let the model retry with tools
        }
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
        let resultText = result.output ?? result.error ?? '(no output)';

        // Track file operations for the workspace manifest + validate imports
        const importWarnings = await this.trackFileOperation(call.name, call.input, result.output, result.success);
        if (importWarnings.length > 0) {
          resultText += `\n⚠ IMPORT WARNINGS: This file ${importWarnings.join('; ')}. Check the Workspace Manifest for available files and create missing dependencies first.`;
        }

        allToolResults.push({
          callId: call.id,
          result: resultText,
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

    // ── Context Pressure Management ─────────────────────────────────────
    const pressureResult = checkContextPressure(
      request.prompt.length,
      request.systemPrompt?.length ?? 0,
      numCtx,
      this.config.tiers,
    );

    let effectivePrompt = request.prompt;

    // Action threshold (0.85): compress the prompt to free context space
    if (pressureResult.actionExceeded) {
      tracer.log('deep-loop', 'warn', 'Context pressure ACTION threshold reached — compressing prompt', {
        tier,
        pressure: pressureResult.pressure,
        estimatedTokens: pressureResult.estimatedTokens,
        numCtx,
      });

      const targetTokens = Math.floor(numCtx * this.config.tiers.contextPressureSoftThreshold);
      const { compressed, applied } = compressPrompt(effectivePrompt, targetTokens);
      if (applied) {
        effectivePrompt = compressed;
        tracer.log('deep-loop', 'info', 'Prompt compressed due to context pressure');
      }
    }

    // Soft threshold (0.70): inject a budget warning so the model self-manages
    if (pressureResult.softExceeded) {
      const warning = buildPressureWarning(pressureResult);
      effectivePrompt = effectivePrompt + warning;

      tracer.log('deep-loop', 'info', 'Context pressure soft threshold — budget warning injected', {
        tier,
        pressure: pressureResult.pressure,
        estimatedTokens: pressureResult.estimatedTokens,
        numCtx,
      });
    }

    // Warning threshold (0.80): log for dream cycle analysis
    if (pressureResult.warningExceeded) {
      tracer.log('deep-loop', 'warn', 'Context pressure warning threshold reached', {
        tier,
        estimatedPromptTokens: pressureResult.estimatedTokens,
        numCtx,
        pressure: pressureResult.pressure,
        threshold: this.config.tiers.contextPressureWarningThreshold,
      });
    }

    const fullRequest: GenerateRequest = {
      ...request,
      prompt: effectivePrompt,
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

  /**
   * Extract constructor parameter names for a class from source content.
   * Returns comma-separated param names, or null if no constructor found.
   */
  private extractConstructorParams(content: string, className: string): string | null {
    const classStart = content.indexOf(`class ${className}`);
    if (classStart < 0) return null;

    const afterClass = content.slice(classStart);
    const constructorMatch = afterClass.match(/constructor\s*\(([^)]*)\)/);
    if (!constructorMatch?.[1]) return null;

    const params = constructorMatch[1]
      .split(',')
      .map((p) => p.trim().split(/[\s=:]/)[0]!.trim())
      .filter(Boolean);

    return params.length > 0 ? params.join(', ') : null;
  }

  /**
   * Extract exported symbol names from JavaScript/TypeScript file content.
   * Uses regex matching — no AST parser needed.
   * Returns { names, summary } where summary shows [default]/[named] tags
   * and constructor params for classes.
   */
  private extractExports(content: string): { names: string[]; summary: string } {
    const allNames = new Set<string>();
    const defaultParts: string[] = [];
    const namedParts: string[] = [];

    // Strip comments and string literals to avoid false positives
    const stripped = content
      .replace(/\/\/[^\n]*/g, '')          // single-line comments
      .replace(/\/\*[\s\S]*?\*\//g, '')    // multi-line comments
      .replace(/"(?:[^"\\]|\\.)*"/g, '""') // double-quoted strings
      .replace(/'(?:[^'\\]|\\.)*'/g, "''"); // single-quoted strings

    // Named exports: export const/let/var/function NAME (not default)
    for (const m of stripped.matchAll(/\bexport\s+(?:const|let|var|function)\s+(\w+)/g)) {
      allNames.add(m[1]!);
      namedParts.push(m[1]!);
    }

    // Named export class: export class NAME (not default)
    for (const m of stripped.matchAll(/\bexport\s+class\s+(\w+)/g)) {
      // Verify this is not "export default class" by checking preceding text
      const before = stripped.slice(Math.max(0, m.index! - 15), m.index!);
      if (before.includes('default')) continue;
      allNames.add(m[1]!);
      const params = this.extractConstructorParams(stripped, m[1]!);
      namedParts.push(params ? `class ${m[1]!}(${params})` : `class ${m[1]!}`);
    }

    // Export default class NAME
    for (const m of stripped.matchAll(/\bexport\s+default\s+class\s+(\w+)/g)) {
      allNames.add(m[1]!);
      const params = this.extractConstructorParams(stripped, m[1]!);
      defaultParts.push(params ? `class ${m[1]!}(${params})` : `class ${m[1]!}`);
    }

    // Export default function NAME
    for (const m of stripped.matchAll(/\bexport\s+default\s+function\s+(\w+)/g)) {
      allNames.add(m[1]!);
      defaultParts.push(m[1]!);
    }

    // Bare export default: export default NAME (not class/function/new/null/etc.)
    for (const m of stripped.matchAll(/\bexport\s+default\s+(?!class\b|function\b|new\b|null\b|true\b|false\b|undefined\b|\{|\[|\()(\w+)/g)) {
      if (!allNames.has(m[1]!)) {
        allNames.add(m[1]!);
        defaultParts.push(m[1]!);
      }
    }

    // Re-exports / named export list: export { A, B, C }
    for (const m of stripped.matchAll(/\bexport\s*\{([^}]+)\}/g)) {
      for (const name of m[1]!.split(',')) {
        const clean = name.trim().split(/\s+as\s+/).pop()!.trim();
        if (clean && /^\w+$/.test(clean)) {
          allNames.add(clean);
          namedParts.push(clean);
        }
      }
    }

    // CommonJS: module.exports = { A, B, C }
    for (const m of stripped.matchAll(/module\.exports\s*=\s*\{([^}]+)\}/g)) {
      for (const name of m[1]!.split(',')) {
        const clean = name.trim().split(/\s*:/)[0]!.trim();
        if (clean && /^\w+$/.test(clean)) {
          allNames.add(clean);
          namedParts.push(clean);
        }
      }
    }

    // Build summary with [default]/[named] tags
    const parts: string[] = [];
    if (defaultParts.length > 0) {
      parts.push(`[default] ${defaultParts.join(', ')}`);
    }
    if (namedParts.length > 0) {
      parts.push(`[named] ${namedParts.join(', ')}`);
    }

    return {
      names: [...allNames].slice(0, 20), // Cap at 20 to avoid prompt bloat
      summary: parts.join(' | ') || '[no exports]',
    };
  }

  /**
   * Track file operations from create_file / edit_file tool calls.
   * Called during executeWithTools to build the workspace manifest.
   * Returns import validation warnings (if any) for injection into tool results.
   */
  private async trackFileOperation(
    callName: string,
    callInput: Record<string, unknown>,
    resultOutput: string | undefined,
    success: boolean,
  ): Promise<string[]> {
    if (!success) return [];
    if (callName !== 'create_file' && callName !== 'edit_file') return [];

    const path = String(callInput['path'] ?? '');
    if (!path) return [];

    const action: 'created' | 'modified' = callName === 'create_file' ? 'created' : 'modified';
    const linesMatch = resultOutput?.match(/\((\d+) lines?\)/);
    const lines = linesMatch ? parseInt(linesMatch[1]!, 10) : undefined;

    // Extract exports from file content
    let exports: string[] | undefined;
    let fileContent: string | undefined;
    if (callName === 'create_file' && typeof callInput['content'] === 'string') {
      fileContent = callInput['content'];
    } else if (callName === 'edit_file') {
      // For edit_file, re-read the file from disk to get current exports
      try {
        const fullPath = path.startsWith('/') ? path : join(process.cwd(), path);
        fileContent = await readFile(fullPath, 'utf8');
      } catch {
        // File read failed — skip export extraction
      }
    }
    if (fileContent) {
      const extracted = this.extractExports(fileContent);
      if (extracted.names.length > 0) {
        exports = extracted.names;
        this.exportSummaries.set(path, extracted.summary);
      }
    }

    // Deduplicate: if the same path was already tracked, update
    const existing = this.stepFileOps.find((f) => f.path === path);
    if (existing) {
      // Keep original action (created stays created even if later modified)
      if (lines !== undefined) existing.lines = lines;
      if (exports) existing.exports = exports; // Update exports on overwrite
    } else {
      this.stepFileOps.push({
        path,
        action,
        ...(lines !== undefined ? { lines } : {}),
        ...(exports ? { exports } : {}),
      });
    }

    // Validate imports against the workspace manifest + current step's files
    if (fileContent && callName === 'create_file') {
      const allKnown = [...this.currentManifest, ...this.stepFileOps];
      return this.validateImportsAgainstManifest(path, fileContent, allKnown);
    }

    return [];
  }

  /**
   * Format the workspace manifest for injection into step prompts.
   * Returns empty string if no files have been tracked.
   */
  private formatWorkspaceManifest(manifest: FileOperation[]): string {
    if (manifest.length === 0) return '';

    const entries = manifest.map((f) => {
      const base = `- ${f.path} (${f.action}${f.lines !== undefined ? `, ${f.lines} lines` : ''})`;
      // Prefer rich summary (with [default]/[named] tags) over flat name list
      const summary = this.exportSummaries.get(f.path);
      if (summary) {
        return `${base} → ${summary}`;
      }
      if (f.exports && f.exports.length > 0) {
        return `${base} → exports: ${f.exports.join(', ')}`;
      }
      return base;
    });

    const collisionWarnings = this.detectBaseNameCollisions(manifest);

    return [
      `## Workspace Manifest`,
      `Files created/modified in previous steps:`,
      ...entries,
      ``,
      ...collisionWarnings,
      ...(collisionWarnings.length > 0 ? [''] : []),
      `IMPORTANT: Use these EXACT file paths when importing or referencing files.`,
      `IMPORT GUIDE: [default] → import Name from './file.js' | [named] → import { Name } from './file.js'`,
      `Use read_file to check a file's exports or constructor params before importing from it.`,
      `Maintain consistent naming conventions (case, separators) with existing files.`,
    ].join('\n');
  }

  /**
   * Detect basename collisions in the workspace manifest.
   * Returns warnings for each basename that appears at multiple paths
   * (e.g., "config.js" at both "/" and "js/").
   */
  private detectBaseNameCollisions(manifest: FileOperation[]): string[] {
    const byBaseName = new Map<string, string[]>();

    for (const file of manifest) {
      const parts = file.path.split('/');
      const baseName = parts[parts.length - 1] ?? file.path;
      const existing = byBaseName.get(baseName);
      if (existing) {
        existing.push(file.path);
      } else {
        byBaseName.set(baseName, [file.path]);
      }
    }

    const warnings: string[] = [];

    // Exact basename collisions
    for (const [baseName, paths] of byBaseName) {
      if (paths.length > 1) {
        warnings.push(
          `WARNING: Basename collision — "${baseName}" exists at multiple paths: ${paths.join(', ')}. Use only ONE location.`,
        );
      }
    }

    // Singular/plural near-misses (e.g., particle.js vs particles.js)
    const baseNames = [...byBaseName.keys()];
    for (let i = 0; i < baseNames.length; i++) {
      for (let j = i + 1; j < baseNames.length; j++) {
        const a = baseNames[i]!;
        const b = baseNames[j]!;
        const aNoExt = a.replace(/\.\w+$/, '');
        const bNoExt = b.replace(/\.\w+$/, '');
        if (
          aNoExt + 's' === bNoExt ||
          bNoExt + 's' === aNoExt
        ) {
          const pathsA = byBaseName.get(a)!;
          const pathsB = byBaseName.get(b)!;
          warnings.push(
            `WARNING: Naming conflict — "${a}" (${pathsA.join(', ')}) and "${b}" (${pathsB.join(', ')}) are singular/plural variants. Use ONLY the one already in the manifest. Delete the other.`,
          );
        }
      }
    }

    return warnings;
  }

  /**
   * Detect files mentioned in a step description that weren't actually created.
   * Extracts filenames like "config.js", "Player.js" from natural language
   * and checks them against the step's file operations.
   */
  private detectMissingStepFiles(
    stepDescription: string,
    stepOps: FileOperation[],
  ): string[] {
    // Extract plausible filenames from the step description (e.g., "config.js", "Player.ts")
    const mentionedFiles = stepDescription.match(/\b[\w-]+\.\w{1,4}\b/g) ?? [];
    if (mentionedFiles.length === 0) return [];

    // Filter to code-file extensions only
    const codeExtensions = new Set(['js', 'ts', 'jsx', 'tsx', 'mjs', 'cjs', 'css', 'html']);
    const expectedFiles = mentionedFiles.filter((f) => {
      const ext = f.split('.').pop()?.toLowerCase() ?? '';
      return codeExtensions.has(ext);
    });

    if (expectedFiles.length === 0) return [];

    // Check which mentioned files were NOT in this step's file operations
    const createdBaseNames = new Set(
      stepOps.map((op) => {
        const parts = op.path.split('/');
        return parts[parts.length - 1] ?? '';
      }),
    );

    return expectedFiles.filter((f) => !createdBaseNames.has(f));
  }

  /**
   * Extract import targets from file content.
   * Returns the relative paths/module names that this file imports from.
   */
  private extractImportTargets(content: string): string[] {
    const targets: string[] = [];

    // Strip comments and string literals (same as extractExports preprocessing)
    const stripped = content
      .replace(/\/\/[^\n]*/g, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/"(?:[^"\\]|\\.)*"/g, (match) => match) // keep string content for import detection
      .replace(/'(?:[^'\\]|\\.)*'/g, (match) => match);

    // ES module imports: import ... from './path.js' or import ... from "./path.js"
    for (const m of stripped.matchAll(/\bimport\s+[\s\S]*?\s+from\s+['"]([^'"]+)['"]/g)) {
      targets.push(m[1]!);
    }

    // Dynamic imports: import('./path.js')
    for (const m of stripped.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      targets.push(m[1]!);
    }

    // CommonJS require: require('./path.js')
    for (const m of stripped.matchAll(/\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      targets.push(m[1]!);
    }

    // Only keep relative imports (start with . or /)
    return targets.filter((t) => t.startsWith('.') || t.startsWith('/'));
  }

  /**
   * Validate that all import targets in a newly created file exist in the manifest.
   * Returns warnings for imports referencing non-existent files.
   */
  private validateImportsAgainstManifest(
    filePath: string,
    content: string,
    manifest: FileOperation[],
  ): string[] {
    const importTargets = this.extractImportTargets(content);
    if (importTargets.length === 0) return [];

    // Build a set of all known file basenames and full paths from the manifest
    const knownPaths = new Set(manifest.map((f) => f.path));
    const knownBaseNames = new Set(
      manifest.map((f) => {
        const parts = f.path.split('/');
        return parts[parts.length - 1] ?? '';
      }),
    );

    const warnings: string[] = [];
    for (const target of importTargets) {
      // Extract the basename from the import path (e.g., './bullets.js' → 'bullets.js')
      const parts = target.split('/');
      const baseName = parts[parts.length - 1] ?? '';
      if (!baseName) continue;

      // Check if the import target exists in the manifest (by basename or full path)
      const fullPath = this.resolveImportPath(filePath, target);
      if (!knownPaths.has(fullPath) && !knownBaseNames.has(baseName)) {
        warnings.push(`imports '${target}' but no matching file exists in the workspace`);
      }
    }

    return warnings;
  }

  /**
   * Resolve a relative import path against the importing file's directory.
   * E.g., resolveImportPath('projects/game/js/main.js', './config.js')
   *       → 'projects/game/js/config.js'
   */
  private resolveImportPath(fromFile: string, importTarget: string): string {
    const fromParts = fromFile.split('/');
    fromParts.pop(); // remove filename, keep directory
    const targetParts = importTarget.split('/');

    const resolved = [...fromParts];
    for (const part of targetParts) {
      if (part === '.') continue;
      if (part === '..') {
        resolved.pop();
      } else {
        resolved.push(part);
      }
    }
    return resolved.join('/');
  }

  /**
   * Cross-validate APIs across all files in the workspace manifest.
   * Reads files from disk, extracts import bindings and member accesses,
   * then checks that every member access exists in the source module's API surface.
   * Returns specific issue strings for any mismatches found.
   */
  private async crossValidateAPIs(manifest: FileOperation[]): Promise<string[]> {
    const issues: string[] = [];

    // 1. Read all files from disk
    const fileContents = new Map<string, string>();
    for (const file of manifest) {
      try {
        const fullPath = file.path.startsWith('/')
          ? file.path
          : join(process.cwd(), file.path);
        const content = await readFile(fullPath, 'utf8');
        fileContents.set(file.path, content);
      } catch {
        // File missing or unreadable — skip (tracked elsewhere)
      }
    }

    // 2. For each file, extract import bindings and validate member accesses
    for (const [filePath, content] of fileContents) {
      const bindings = extractImportBindings(content);

      for (const binding of bindings) {
        // 3. Resolve the source path
        const resolvedSource = this.resolveImportPath(filePath, binding.source);

        // Find source content (try exact path, then basename match)
        let sourceContent = fileContents.get(resolvedSource);
        if (!sourceContent) {
          const targetBaseName = resolvedSource.split('/').pop() ?? '';
          for (const [p, c] of fileContents) {
            if (p.endsWith(`/${targetBaseName}`) || p === targetBaseName) {
              sourceContent = c;
              break;
            }
          }
        }
        if (!sourceContent) continue; // External or missing

        // 4. Extract member accesses on this binding
        const memberAccesses = extractMemberAccesses(content, binding.localName);
        if (memberAccesses.length === 0) continue;

        // 5. Build the available API surface
        const apiSurface = extractAPISurface(sourceContent);

        // 6. For named imports, also check object property names
        const objProps = extractObjectPropertyNames(sourceContent, binding.localName);
        const allAvailable = new Set(apiSurface);
        for (const prop of objProps) {
          allAvailable.add(prop);
        }

        // 7. Cross-reference: find missing members
        const missing = memberAccesses.filter((m) => !allAvailable.has(m));
        if (missing.length > 0) {
          const sourceBaseName = resolvedSource.split('/').pop() ?? resolvedSource;
          const fileBaseName = filePath.split('/').pop() ?? filePath;
          const availableList = [...allAvailable].sort().slice(0, 20).join(', ');
          for (const m of missing) {
            issues.push(
              `${fileBaseName}: calls ${binding.localName}.${m}() but '${m}' not found in ${sourceBaseName} (available: ${availableList})`,
            );
          }
        }
      }
    }

    return issues;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Cross-File API Validation Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Binding entry: a local variable name mapped to the source file it was imported from. */
export interface ImportBinding {
  localName: string;
  source: string;
  isDefault: boolean;
}

/**
 * Parse import statements and map each local binding name to the source file path.
 * Only returns relative imports (starting with . or /).
 */
export function extractImportBindings(content: string): ImportBinding[] {
  const bindings: ImportBinding[] = [];

  // Strip comments to avoid false positives
  const stripped = content
    .replace(/\/\/[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');

  // Combined default + named: import Foo, { A, B } from './bar.js'
  for (const m of stripped.matchAll(
    /\bimport\s+(\w+)\s*,\s*\{([^}]+)\}\s*from\s+['"]([^'"]+)['"]/g,
  )) {
    const source = m[3]!;
    bindings.push({ localName: m[1]!, source, isDefault: true });
    for (const name of m[2]!.split(',')) {
      const trimmed = name.trim();
      if (!trimmed) continue;
      const parts = trimmed.split(/\s+as\s+/);
      const local = (parts.length > 1 ? parts[1] : parts[0])!.trim();
      if (local) bindings.push({ localName: local, source, isDefault: false });
    }
  }

  // Default import: import Foo from './bar.js'
  // Must NOT match combined imports (already handled above)
  for (const m of stripped.matchAll(
    /\bimport\s+(\w+)\s+from\s+['"]([^'"]+)['"]/g,
  )) {
    // Skip if this was already captured as a combined import
    const alreadyCaptured = bindings.some(
      (b) => b.localName === m[1]! && b.source === m[2]!,
    );
    if (!alreadyCaptured) {
      bindings.push({ localName: m[1]!, source: m[2]!, isDefault: true });
    }
  }

  // Named imports: import { A, B as C } from './config.js'
  // Must NOT match combined imports
  for (const m of stripped.matchAll(
    /\bimport\s*\{([^}]+)\}\s*from\s+['"]([^'"]+)['"]/g,
  )) {
    const source = m[2]!;
    // Skip if already captured from combined
    const existingForSource = bindings.filter((b) => b.source === source && !b.isDefault);
    if (existingForSource.length > 0) continue;

    for (const name of m[1]!.split(',')) {
      const trimmed = name.trim();
      if (!trimmed) continue;
      const parts = trimmed.split(/\s+as\s+/);
      const local = (parts.length > 1 ? parts[1] : parts[0])!.trim();
      if (local) bindings.push({ localName: local, source, isDefault: false });
    }
  }

  // Namespace import: import * as Foo from './bar.js'
  for (const m of stripped.matchAll(
    /\bimport\s*\*\s*as\s+(\w+)\s+from\s+['"]([^'"]+)['"]/g,
  )) {
    bindings.push({ localName: m[1]!, source: m[2]!, isDefault: false });
  }

  // Only keep relative imports
  return bindings.filter((b) => b.source.startsWith('.') || b.source.startsWith('/'));
}

/**
 * Find all `identifier.memberName` patterns in file content.
 * Returns deduplicated member names.
 */
export function extractMemberAccesses(content: string, identifier: string): string[] {
  const members = new Set<string>();

  // Strip comments
  const stripped = content
    .replace(/\/\/[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');

  const escaped = identifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`\\b${escaped}\\.(\\w+)`, 'g');
  for (const m of stripped.matchAll(regex)) {
    members.add(m[1]!);
  }
  return [...members];
}

/** Keywords that look like method definitions but aren't. */
const METHOD_EXCLUDE = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'constructor',
  'return', 'throw', 'new', 'typeof', 'delete', 'void',
]);

/**
 * Extract the publicly-accessible API surface from a module's source code.
 * Returns a set of method/property/function names.
 */
export function extractAPISurface(content: string): Set<string> {
  const api = new Set<string>();

  // Strip comments
  const stripped = content
    .replace(/\/\/[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');

  // Exported functions: export (default )?(async )?function name(
  for (const m of stripped.matchAll(
    /\bexport\s+(?:default\s+)?(?:async\s+)?function\s+(\w+)/g,
  )) {
    api.add(m[1]!);
  }

  // Exported variables: export (const|let|var) name
  for (const m of stripped.matchAll(
    /\bexport\s+(?:const|let|var)\s+(\w+)/g,
  )) {
    api.add(m[1]!);
  }

  // Re-exports: export { A, B }
  for (const m of stripped.matchAll(/\bexport\s*\{([^}]+)\}/g)) {
    for (const name of m[1]!.split(',')) {
      const trimmed = name.trim().split(/\s+as\s+/);
      const exported = (trimmed.length > 1 ? trimmed[1] : trimmed[0])!.trim();
      if (exported) api.add(exported);
    }
  }

  // Class methods — find class bodies and extract method definitions
  // Track brace depth to isolate class body
  const classStarts = [...stripped.matchAll(/\bclass\s+\w+[^{]*\{/g)];
  for (const classMatch of classStarts) {
    const startIdx = classMatch.index! + classMatch[0].length;
    let depth = 1;
    let classEnd = startIdx;
    for (let i = startIdx; i < stripped.length && depth > 0; i++) {
      if (stripped[i] === '{') depth++;
      else if (stripped[i] === '}') {
        depth--;
        if (depth === 0) classEnd = i;
      }
    }

    const classBody = stripped.slice(startIdx, classEnd);

    // Method definitions at class body level (depth 0 within class)
    // Match: methodName( or async methodName(
    for (const m of classBody.matchAll(
      /^\s+(?:async\s+)?(\w+)\s*\(/gm,
    )) {
      const name = m[1]!;
      if (!METHOD_EXCLUDE.has(name)) {
        api.add(name);
      }
    }

    // Getters and setters: get name( / set name(
    for (const m of classBody.matchAll(/^\s+(?:get|set)\s+(\w+)\s*\(/gm)) {
      api.add(m[1]!);
    }
  }

  // Default export of instantiated class: export default new ClassName()
  // The API is the class's methods — already captured above if class is in same file
  for (const m of stripped.matchAll(
    /\bexport\s+default\s+new\s+(\w+)/g,
  )) {
    // Class methods already captured — just note the class name for reference
    api.add(m[1]!);
  }

  return api;
}

/**
 * For config-like modules, extract top-level property keys from an object literal
 * assigned to the given variable name.
 * e.g., `export const ENEMIES = { baseSpeed: 50, rows: 5 }` → ['baseSpeed', 'rows']
 */
export function extractObjectPropertyNames(content: string, varName: string): string[] {
  // Strip comments
  const stripped = content
    .replace(/\/\/[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');

  const escaped = varName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const assignMatch = stripped.match(
    new RegExp(`(?:export\\s+)?(?:const|let|var)\\s+${escaped}\\s*=\\s*\\{`),
  );
  if (!assignMatch) return [];

  const startIdx = assignMatch.index! + assignMatch[0].length - 1; // position of '{'

  // Find balanced closing brace
  let depth = 0;
  let endIdx = startIdx;
  for (let i = startIdx; i < stripped.length; i++) {
    if (stripped[i] === '{') depth++;
    else if (stripped[i] === '}') {
      depth--;
      if (depth === 0) {
        endIdx = i;
        break;
      }
    }
  }

  if (endIdx <= startIdx) return [];

  const body = stripped.slice(startIdx + 1, endIdx);

  // Extract top-level property keys (only lines at depth 0 within this body)
  // We need to track nested braces to only get top-level keys
  const keys: string[] = [];
  let innerDepth = 0;
  for (const line of body.split('\n')) {
    // Extract keys BEFORE counting braces so that `player: {` is captured at depth 0
    // but `width: 40` inside the nested object (depth 1) is skipped
    if (innerDepth === 0) {
      const keyMatch = line.match(/^\s*(\w+)\s*:/);
      if (keyMatch) {
        keys.push(keyMatch[1]!);
      }
    }

    // Count braces on this line for depth tracking (after key extraction)
    for (const ch of line) {
      if (ch === '{' || ch === '[' || ch === '(') innerDepth++;
      else if (ch === '}' || ch === ']' || ch === ')') innerDepth--;
    }
  }

  return keys;
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
