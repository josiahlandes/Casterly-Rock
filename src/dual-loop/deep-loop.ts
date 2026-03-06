/**
 * Deep Loop — The 122B reasoning and coding engine.
 *
 * Runs continuously, pulling tasks from the TaskBoard and executing them
 * via an iterative tool-calling loop (OpenAI function calling). The DeepLoop:
 *   - Claims queued tasks and plans the approach
 *   - Generates code directly (122B handles both reasoning and coding)
 *   - Addresses review feedback from the FastLoop
 *   - Handles preemption (higher-priority tasks interrupt current work)
 *   - Runs autonomous work from the goal stack during idle periods
 *
 * Context tier is set once per task (not changed mid-tool-loop).
 *
 * See docs/dual-loop-architecture.md Sections 6, 17, and 28.
 */

import type { LlmProvider, GenerateRequest, PreviousAssistantMessage } from '../providers/base.js';
import type { ConcurrentProvider } from '../providers/concurrent.js';
import type { EventBus } from '../autonomous/events.js';
import type { GoalStack } from '../autonomous/goal-stack.js';
import type { AgentToolkit } from '../autonomous/tools/types.js';
import type { ToolResultMessage, ToolSchema } from '../tools/schemas/types.js';
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
import { REVIEW_SYSTEM_PROMPT, REVIEW_FORMAT_SCHEMA, CASCADE_REVIEW_PROMPTS, INTEGRATION_REVIEW_SYSTEM_PROMPT, buildReviewPrompt, parseReviewResponse } from './review-prompt.js';
import { runIdleCheck } from './deep-loop-events.js';
import type { DeepLoopEventConfig } from './deep-loop-events.js';
import { ComputeScaler } from '../autonomous/reasoning/compute-scaler.js';
import type { ComputeBudget } from '../autonomous/reasoning/compute-scaler.js';
import { ReasoningScaler } from '../autonomous/reasoning/scaling.js';
import type { SkillFilesManager, SkillFile } from '../autonomous/memory/skill-files.js';
import {
  extractImportBindings,
  extractMemberAccesses,
  extractAPISurface,
  extractObjectPropertyNames,
  resolveImportPath,
} from '../tools/static-analysis.js';

// State Manager (optional — provides role-scoped views of system state)
import type { StateManager } from '../state/state-manager.js';

// Metacognition — preflection and confabulation guard
import { preflectHeuristic, buildKnowledgeManifest, buildContextualGuard, CONFABULATION_GUARD_PROMPT } from '../metacognition/index.js';
import type { PreflectionResult, KnowledgeSource } from '../metacognition/index.js';

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
  /** Maximum tool-calling turns per task (total budget across all steps) */
  maxTurnsPerTask: number;
  /** Maximum tool-calling turns per individual plan step */
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
  maxTurnsPerTask: 100,
  maxTurnsPerStep: 25,
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

IMPORTANT: Use as FEW steps as possible. The executor runs in a single continuous
loop with up to 100 tool-calling turns. More steps = more context loss between steps.

**1 step** — The DEFAULT for most tasks:
  Research, queries, greenfield projects, bug fixes, features, refactors.
  Single-step plans preserve full context across all tool calls — the executor
  can create files, read them back, verify cross-file APIs, and fix issues
  all in one continuous loop without losing context.

**2 steps** — ONLY when step 2 truly depends on runtime output from step 1:
  Example: "build + run tests" where test results inform fixes.
  Example: "create project + verify it runs in browser".

**3+ steps** — Almost never needed. Only for tasks that have genuine
  sequential dependencies where each phase produces output the next phase
  consumes. If you can do it in 1 step, do it in 1 step.

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
  /** Test-time compute scaler — allocates compute budgets per task difficulty */
  private readonly computeScaler: ComputeScaler;
  /** Heuristic difficulty assessor */
  private readonly reasoningScaler: ReasoningScaler;
  /** Active compute budget for the current task (set at start of processTask) */
  private activeBudget: ComputeBudget | null = null;
  /** Tracks turn count for current task (for calibration recording) */
  private taskTurnCount: number = 0;
  /** Skill files manager for skill-assisted planning and post-task learning */
  private skillFilesManager: SkillFilesManager | null = null;
  /** Optional StateManager — provides role-scoped views of system state */
  private stateManager: StateManager | null = null;

  constructor(
    provider: LlmProvider,
    concurrentProvider: ConcurrentProvider,
    taskBoard: TaskBoard,
    eventBus: EventBus,
    config?: Partial<DeepLoopConfig>,
    toolkit?: AgentToolkit,
    stateManager?: StateManager,
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.provider = provider;
    this.concurrentProvider = concurrentProvider;
    this.taskBoard = taskBoard;
    this.eventBus = eventBus;
    this.toolkit = toolkit ?? null;
    this.stateManager = stateManager ?? null;
    this.computeScaler = new ComputeScaler();
    this.reasoningScaler = new ReasoningScaler({
      codingModel: this.config.coderModel,
      reasoningModel: this.config.model,
    });

    // If stateManager is provided, pull goalStack and skillFilesManager from it
    if (stateManager) {
      this.goalStack = stateManager.goalStack;
      this.skillFilesManager = stateManager.skillFiles;
    }
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
   *
   * @deprecated Pass a StateManager to the constructor instead.
   */
  setGoalStack(goalStack: GoalStack, config?: DeepLoopEventConfig): void {
    this.goalStack = goalStack;
    this.eventConfig = config;
  }

  /**
   * Set the SkillFilesManager for skill-assisted planning and post-task learning.
   * When set, the planner injects relevant learned skills as prior art,
   * and successful tasks trigger skill learning.
   *
   * @deprecated Pass a StateManager to the constructor instead.
   */
  setSkillFilesManager(manager: SkillFilesManager): void {
    this.skillFilesManager = manager;
  }

  /**
   * Set the StateManager after construction. Useful when the StateManager
   * is created after the DeepLoop.
   */
  setStateManager(sm: StateManager): void {
    this.stateManager = sm;
    this.goalStack = sm.goalStack;
    this.skillFilesManager = sm.skillFiles;
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

    // Assess difficulty and allocate compute budget (test-time compute scaling)
    const taskDescription = task.originalMessage ?? task.triageNotes ?? '';
    const heuristicDifficulty = this.reasoningScaler.assessDifficulty(taskDescription);
    this.activeBudget = this.computeScaler.allocateBudget(heuristicDifficulty);
    this.taskTurnCount = 0;

    tracer.log('deep-loop', 'info', `Compute budget: ${this.activeBudget.difficulty}`, {
      maxTurns: this.activeBudget.maxTurns,
      verificationDepth: this.activeBudget.verificationDepth,
      maxRetries: this.activeBudget.maxRetries,
      parallelCandidates: this.activeBudget.parallelCandidates,
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

      // Verification cascade: compute budget determines depth, with heuristic override
      // for high-stakes multi-file tasks.
      const fileCount = outcome.workspaceManifest?.length ?? 0;
      const stepCount = planned?.planSteps?.length ?? 0;
      const isHighStakes = fileCount >= 3 || stepCount >= 3;
      const budgetVerification = this.activeBudget?.verificationDepth ?? 1;
      const verificationPasses = Math.max(budgetVerification, isHighStakes ? 2 : 1);

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

      // Skip self-review for information-only tasks (no file modifications).
      // The code review prompt expects diffs, which don't exist for read-only tasks.
      const hasFileChanges = (outcome.workspaceManifest?.length ?? 0) > 0;
      const reviewResult = hasFileChanges
        ? await this.selfReview(this.taskBoard.get(task.id)!)
        : { approved: true, reviewResult: 'approved' as ReviewResult, reviewNotes: 'Skipped — information-only task (no file changes)' };

      if (reviewResult.approved) {
        this.taskBoard.update(task.id, {
          status: 'done',
          owner: null,
          reviewResult: reviewResult.reviewResult,
          reviewNotes: reviewResult.reviewNotes,
          resolvedAt: new Date().toISOString(),
        });
        tracer.log('deep-loop', 'info', `Task ${task.id} self-review approved, marking done`);

        // Post-task skill learning: capture multi-step patterns as reusable skills
        this.tryLearnSkillFromTask(task, planned);
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
      // Record outcome for calibration (test-time compute scaling)
      if (this.activeBudget) {
        const finalTask = this.taskBoard.get(task.id);
        const succeeded = finalTask?.status === 'done';
        const revisions = this.revisionCounts.get(task.id) ?? 0;
        this.computeScaler.recordOutcome(
          this.activeBudget.difficulty,
          this.taskTurnCount,
          revisions,
          succeeded,
          (task.originalMessage ?? task.triageNotes ?? '').slice(0, 100),
        );
      }
      this.activeBudget = null;
      this.taskTurnCount = 0;
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

    // ── Metacognition: Preflection ──────────────────────────────────────
    // Run a heuristic preflection to determine what knowledge sources are
    // relevant and whether confabulation risk is high. This is instant
    // (no LLM call) and informs what context to inject into the prompt.
    let preflection: PreflectionResult | null = null;
    let metacognitionContext = '';
    if (this.stateManager) {
      const cogMap = this.stateManager.cognitiveMap;
      const manifest = buildKnowledgeManifest({
        cognitiveMap: cogMap,
        worldModel: this.stateManager.worldModel,
        goalStack: this.stateManager.goalStack,
        issueLog: this.stateManager.issueLog,
        journal: this.stateManager.journal,
        hasCrystals: false, // TODO: wire crystal store check
        hasConstitution: false, // TODO: wire constitution store check
        hasSelfModel: true,
        hasSkillFiles: this.skillFilesManager !== null,
        hasGraphMemory: this.stateManager.graphMemory !== null,
      });

      const taskMessage = task.originalMessage ?? task.triageNotes ?? '';
      preflection = preflectHeuristic(taskMessage, manifest.sources);

      tracer.log('deep-loop', 'debug', 'Preflection result', {
        confidence: preflection.confidence,
        confabulationRisk: preflection.confabulationRisk,
        isSelfReferential: preflection.isSelfReferential,
        retrieveCount: preflection.retrieve.length,
      });

      // If self-referential or high confabulation risk, inject cognitive map context
      if (preflection.isSelfReferential || preflection.confabulationRisk === 'high') {
        const cogSummary = cogMap.buildSummary();
        if (cogSummary) {
          metacognitionContext += `\n## My Environment\n\n${cogSummary}`;
        }
        metacognitionContext += `\n\n## Knowledge Sources\n\n${manifest.prompt}`;
      }
    }

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

    // Search learned skills for prior art to inject into the planning prompt
    let skillContext = '';
    if (this.skillFilesManager) {
      const taskDescription = task.originalMessage ?? task.triageNotes ?? '';
      const matchingSkills = this.skillFilesManager.search(taskDescription);
      // Only inject proficient/expert skills — novice/competent skills aren't reliable enough
      const reliableSkills = matchingSkills.filter(
        (s) => s.mastery === 'proficient' || s.mastery === 'expert',
      );
      if (reliableSkills.length > 0) {
        const skillLines = reliableSkills.slice(0, 3).map((s) => {
          const steps = s.steps.map((step, i) => `  ${i + 1}. ${step}`).join('\n');
          return `### ${s.name} (${s.mastery}, ${s.useCount} uses, ${Math.round((s.successCount / Math.max(s.useCount, 1)) * 100)}% success)\n${s.description}\n**Steps:**\n${steps}`;
        });
        skillContext = `\n## Prior Art (Learned Skills)\n\nThese skills have been used successfully before for similar tasks. Use them as suggested approaches — adapt as needed, don't follow blindly.\n\n${skillLines.join('\n\n')}`;
        tracer.log('deep-loop', 'info', `Injected ${reliableSkills.length} skills as prior art`);
      }
    }

    // If a StateManager is available, inject a concise planner context summary
    // (~500-1500 tokens) covering world model health, active goals, and recent journal entries.
    let plannerContext = '';
    if (this.stateManager) {
      const view = this.stateManager.plannerView();
      const parts: string[] = [];

      // World model summary (~200 tokens)
      const worldSummary = view.worldModel.getSummary();
      if (worldSummary) {
        parts.push(`**World Model:** ${worldSummary.slice(0, 600)}`);
      }

      // Active goals (~200 tokens)
      const goalSummary = view.goalStack.getSummaryText();
      if (goalSummary) {
        parts.push(`**Active Goals:**\n${goalSummary.slice(0, 500)}`);
      }

      // Recent journal entries (~200 tokens)
      const recentEntries = view.journal.getRecent(3);
      if (recentEntries.length > 0) {
        const journalLines = recentEntries.map(
          (e) => `- [${e.type}] ${e.content.slice(0, 120)}`,
        );
        parts.push(`**Recent Journal:**\n${journalLines.join('\n')}`);
      }

      if (parts.length > 0) {
        plannerContext = `\n## System Context\n\n${parts.join('\n\n')}`;
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
      skillContext,
      plannerContext,
      metacognitionContext,
    ].join('');

    // Build system prompt — append confabulation guard when preflection flags risk
    const systemPrompt = preflection && preflection.confabulationRisk !== 'low'
      ? PLANNING_SYSTEM_PROMPT + '\n\n' + buildContextualGuard(preflection)
      : PLANNING_SYSTEM_PROMPT;

    let rawResponse: string | null = null;

    try {
      // Thinking is left ON — planning benefits from chain-of-thought reasoning.
      // We extract the <think> block separately and parse only the JSON output.
      rawResponse = await this.callWithTier(tier, {
        prompt,
        systemPrompt,
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

    // Compute budget determines turn limits — falls back to config defaults
    const budgetMaxTask = this.activeBudget?.maxTurns ?? this.config.maxTurnsPerTask;
    const budgetMaxStep = totalSteps <= 1
      ? budgetMaxTask
      : Math.min(this.config.maxTurnsPerStep, budgetMaxTask);

    // Single-step tasks get the full task budget; multi-step get per-step cap
    let maxTurns = totalSteps <= 1 ? budgetMaxTask : budgetMaxStep;

    // Review/verify/test/fix steps get double the turn budget so the model
    // has room to read dependencies, cross-check APIs, and apply fixes.
    if (/\b(test|verify|review|validate|integration|fix)\b/i.test(step.description)) {
      maxTurns = Math.min(maxTurns * 2, budgetMaxTask);
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
      const manifestLines = (task.workspaceManifest ?? []).map(
        (f) => `- ${f.path} (${f.action}${f.lines !== undefined ? `, ${f.lines} lines` : ''})`,
      );
      const prompt = [
        `## Original Request\n\n${task.originalMessage ?? '(no message)'}`,
        `## Plan\n\n${task.plan ?? '(no plan)'}`,
        manifestLines.length > 0
          ? `## Workspace Manifest\n\nFiles created/modified during implementation:\n${manifestLines.join('\n')}\n\nIMPORTANT: Use these exact paths when reading or editing files.`
          : '',
        `## Review Feedback\n\n${task.reviewFeedback ?? task.reviewNotes ?? '(no feedback)'}`,
        task.artifacts?.length
          ? `## Previous Artifacts\n\n${task.artifacts.map((a) => a.content ?? '').join('\n---\n')}`
          : '',
      ].filter(Boolean).join('\n\n');

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
   * Single structured-output generate call per cascade pass (NOT an
   * iterative tool loop). The model reviews its own output for correctness and security.
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
    passName?: string;
  }> {
    const tracer = getTracer();
    const plan = task.plan ?? '(no plan)';
    const artifacts = task.artifacts ?? [];
    const totalPasses = task.verificationPasses ?? 1;
    let currentPass = task.currentVerificationPass ?? 0;

    // Integration review for multi-file tasks (runs before structured passes)
    const isMultiFile = (task.workspaceManifest?.length ?? 0) >= 2;
    if (isMultiFile && this.toolkit) {
      const outcome = await this.integrationReview(task);
      if (outcome.result !== 'approved') {
        return {
          approved: false,
          reviewResult: 'changes_requested',
          reviewNotes: outcome.issues.join('\n'),
          reviewFeedback: outcome.issues.join('\n'),
          passName: 'integration',
        };
      }
    }

    // Build reviewer context from StateManager if available (~200-400 tokens)
    let reviewerContext = '';
    if (this.stateManager) {
      const view = this.stateManager.reviewerView();
      const parts: string[] = [];

      const issueSummary = view.issueLog.getSummaryText();
      if (issueSummary) {
        parts.push(`Known Issues: ${issueSummary.slice(0, 300)}`);
      }

      const goalSummary = view.goalStack.getSummaryText();
      if (goalSummary) {
        parts.push(`Active Goals: ${goalSummary.slice(0, 200)}`);
      }

      if (parts.length > 0) {
        reviewerContext = `\n\n## Reviewer Context\n\n${parts.join('\n')}`;
      }
    }

    while (currentPass < totalPasses) {
      const systemPrompt = currentPass === 0
        ? REVIEW_SYSTEM_PROMPT
        : CASCADE_REVIEW_PROMPTS[currentPass - 1] ?? REVIEW_SYSTEM_PROMPT;

      const baseReviewPrompt = buildReviewPrompt({ plan, artifacts });
      const reviewPrompt = reviewerContext
        ? baseReviewPrompt + reviewerContext
        : baseReviewPrompt;

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

  // ── Integration Review ──────────────────────────────────────────────────

  /**
   * Integration review — uses an iterative tool-calling loop with read-only
   * tools to verify cross-module wiring for multi-file tasks.
   *
   * Filters the toolkit to read-only tools (read_file, grep, glob,
   * validate_project) and runs the INTEGRATION_REVIEW_SYSTEM_PROMPT.
   * If a StateManager is available, injects reviewer context (known issues,
   * active goals) into the prompt.
   *
   * Returns { result: 'approved' | 'changes_requested', issues: string[] }.
   */
  private async integrationReview(task: Task): Promise<{
    result: 'approved' | 'changes_requested';
    issues: string[];
  }> {
    const tracer = getTracer();
    tracer.log('deep-loop', 'info', `Integration review for ${task.id}`);

    if (!this.toolkit) {
      return { result: 'approved', issues: [] };
    }

    // Filter toolkit to read-only tools
    const readOnlyNames = new Set(['read_file', 'grep', 'glob', 'validate_project']);
    const readOnlyToolSchemas = this.toolkit.schemas.filter(
      (s) => readOnlyNames.has(s.name),
    );

    // Build prompt with workspace manifest
    const manifestLines = (task.workspaceManifest ?? []).map(
      (f) => `- ${f.path} (${f.action}${f.lines !== undefined ? `, ${f.lines} lines` : ''})`,
    );

    const promptParts: string[] = [
      `## Task\n\n${task.originalMessage ?? task.plan ?? '(no description)'}`,
      `\n## Workspace Manifest\n\n${manifestLines.length > 0 ? manifestLines.join('\n') : '(no files)'}`,
    ];

    // Inject reviewer context from StateManager if available
    if (this.stateManager) {
      const view = this.stateManager.reviewerView();
      const contextParts: string[] = [];

      const issueSummary = view.issueLog.getSummaryText();
      if (issueSummary) {
        contextParts.push(`Known Issues: ${issueSummary.slice(0, 300)}`);
      }

      const goalSummary = view.goalStack.getSummaryText();
      if (goalSummary) {
        contextParts.push(`Active Goals: ${goalSummary.slice(0, 200)}`);
      }

      if (contextParts.length > 0) {
        promptParts.push(`\n## Reviewer Context\n\n${contextParts.join('\n')}`);
      }
    }

    const request: GenerateRequest = {
      prompt: promptParts.join('\n'),
      systemPrompt: INTEGRATION_REVIEW_SYSTEM_PROMPT,
      temperature: 0.1,
      maxTokens: 2048,
    };

    try {
      const responseText = await this.executeWithTools(request, 15, readOnlyToolSchemas);

      // Parse the last model message as JSON
      try {
        const { json } = extractJsonFromResponse(responseText);
        const result = json['result'] === 'approved' ? 'approved' as const : 'changes_requested' as const;
        const issues = Array.isArray(json['issues'])
          ? (json['issues'] as unknown[]).map(String)
          : [];

        tracer.log('deep-loop', 'info', `Integration review result: ${result}`, {
          issueCount: issues.length,
        });

        return { result, issues };
      } catch {
        // Fallback: infer result from natural language when JSON parsing fails.
        // This handles cases where the model ran out of tool turns and the
        // wrap-up response is prose instead of JSON.
        tracer.log('deep-loop', 'warn', 'Integration review JSON parse failed, inferring from text');
        const lower = responseText.toLowerCase();

        // Strong rejection signals
        const rejectionPatterns = [
          /\bmissing\s+(import|export|method|function|module)/,
          /\bundefined\s+(method|function|variable|property)/,
          /\bnot\s+(exported|defined|found|wired|connected)/,
          /\bcross-module\s+(wiring|issue|bug|error)/,
          /\bchanges[_\s]requested\b/,
          /\bfail(s|ed|ing)?\b.*\b(import|export|call|wir)/,
        ];
        const hasRejection = rejectionPatterns.some(p => p.test(lower));

        // Strong approval signals
        const approvalPatterns = [
          /\ball\s+(imports|exports|modules|files)\s+(are\s+)?(correct|valid|properly|match)/,
          /\bno\s+(issues?|problems?|errors?|mismatches?)\s+(found|detected|identified)/,
          /\bapproved\b/,
          /\beverything\s+(looks?|checks?|is)\s+(good|correct|fine|ok)/,
        ];
        const hasApproval = approvalPatterns.some(p => p.test(lower));

        if (hasRejection && !hasApproval) {
          // Extract issue-like sentences from the response
          const issues = responseText
            .split(/[.\n]/)
            .filter(s => /missing|undefined|not (exported|defined|found)|mismatch|error|bug|fail/i.test(s))
            .map(s => s.trim())
            .filter(s => s.length > 10 && s.length < 300)
            .slice(0, 5);
          return {
            result: 'changes_requested',
            issues: issues.length > 0 ? issues : ['Review identified issues (parsed from prose)'],
          };
        }

        if (hasApproval && !hasRejection) {
          tracer.log('deep-loop', 'info', 'Integration review inferred: approved (from prose)');
          return { result: 'approved', issues: [] };
        }

        // Ambiguous — default to approved if validate_project passed and
        // no explicit issues found in the text
        tracer.log('deep-loop', 'info', 'Integration review ambiguous, defaulting to approved');
        return { result: 'approved', issues: [] };
      }
    } catch (error) {
      tracer.log('deep-loop', 'warn', `Integration review failed: ${error instanceof Error ? error.message : String(error)}`);
      return {
        result: 'changes_requested',
        issues: [`Integration review error: ${error instanceof Error ? error.message : String(error)}`],
      };
    }
  }

  // ── Coder Dispatch ──────────────────────────────────────────────────────

  /**
   * Dispatch a plan step to the Coder model for implementation.
   * When a toolkit is available, runs an iterative tool-calling loop so
   * the model can read files, run commands, and write code via tools.
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
      temperature: 0.3,
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
   * Execute an LLM request with an iterative tool-calling loop.
   *
   * Uses OpenAI-style function calling: the model returns tool_calls,
   * we execute them, feed results back, and repeat until the model
   * stops calling tools (or maxTurns is reached). Includes loop
   * detection to catch pathological repeated calls.
   *
   * Falls back to a plain no-tools call when no toolkit is configured.
   *
   * @param toolOverride - When provided, these tool schemas are sent to the
   *   model instead of the full toolkit schemas. The executor still uses the
   *   full toolkit to dispatch calls, so only the model's visible tool set is
   *   restricted (e.g., read-only tools for integration review).
   */
  private async executeWithTools(
    request: GenerateRequest,
    maxTurns: number = 20,
    toolOverride?: ToolSchema[],
  ): Promise<string> {
    if (!this.toolkit) {
      const response = await this.provider.generateWithTools(request, []);
      return response.text;
    }

    const tracer = getTracer();
    // Use toolOverride for the schemas sent to the model if provided,
    // but always use the full toolkit for actual execution dispatch.
    const tools = toolOverride ?? this.toolkit.schemas;
    let lastText = '';

    // Accumulate full conversation history so each turn sees ALL prior
    // tool results, not just the last batch. This is critical for multi-turn
    // research tasks where the model needs to synthesize data from earlier reads.
    const conversationHistory: PreviousAssistantMessage[] = [];
    const allToolResults: ToolResultMessage[] = [];

    // Budget warning threshold
    const warnAtTurn = Math.max(1, maxTurns - 2);

    // ── Loop detection ─────────────────────────────────────────────────
    // Track tool call signatures to detect pathological loops where the
    // model repeats the same call. Threshold: 5 identical calls.
    // For file-access tools, normalize to just the path so that
    // read_file(path, offset=0) and read_file(path, offset=10) count
    // as the same call — prevents loops where the model re-reads the
    // same file with slightly different params.
    const TOOL_CALL_LOOP_THRESHOLD = 5;
    const FILE_ACCESS_TOOLS = new Set(['read_file', 'read_files', 'grep', 'glob']);
    const toolCallCounts = new Map<string, number>();

    function getToolSignature(name: string, input: Record<string, unknown>): string {
      if (FILE_ACCESS_TOOLS.has(name)) {
        // Normalize to tool:path — ignore offset, max_lines, force_full, etc.
        const path = input['path'] ?? input['pattern'] ?? '';
        return `${name}:${String(path)}`;
      }
      return `${name}:${JSON.stringify(input)}`;
    }

    for (let turn = 0; turn < maxTurns; turn++) {
      this.taskTurnCount++;
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

      // ── Loop detection: check for repeated tool calls ────
      let loopDetected = false;
      for (const tc of response.toolCalls) {
        const sig = getToolSignature(tc.name, tc.input as Record<string, unknown>);
        const count = (toolCallCounts.get(sig) ?? 0) + 1;
        toolCallCounts.set(sig, count);
        if (count >= TOOL_CALL_LOOP_THRESHOLD) {
          loopDetected = true;
        }
      }

      if (loopDetected) {
        tracer.log('deep-loop', 'warn',
          `Tool call loop detected at turn ${turn + 1} — same call repeated ${TOOL_CALL_LOOP_THRESHOLD}+ times. Breaking loop.`,
        );
        // Record the turn but inject a loop-break nudge instead of continuing
        conversationHistory.push({
          text: response.text,
          toolCalls: response.toolCalls.map((tc) => ({
            id: tc.id,
            name: tc.name,
            arguments: JSON.stringify(tc.input),
          })),
        });
        allToolResults.push({
          callId: `loop-break-${turn}`,
          result: '[SYSTEM] Loop detected: you have repeated the same tool call 5+ times. Stop calling this tool and try a different approach, or provide your final answer.',
          isError: true,
        });
        continue;
      }

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
   * When useTools is true and a toolkit is available, runs a full
   * tool-calling loop. Otherwise makes a single no-tools call.
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
   * Try to learn a reusable skill from a successfully completed multi-step task.
   * Only learns when:
   *   - SkillFilesManager is available
   *   - Task had 2+ plan steps (single-step tasks aren't interesting patterns)
   *   - No existing skill already matches this task closely
   */
  private tryLearnSkillFromTask(task: Task, planned: Task | null): void {
    if (!this.skillFilesManager || !planned?.planSteps) return;

    const steps = planned.planSteps;
    if (steps.length < 2) return; // Single-step tasks aren't learnable patterns

    const tracer = getTracer();
    const taskDescription = task.originalMessage ?? task.triageNotes ?? '';

    // Check if an existing skill already covers this pattern
    const existingSkills = this.skillFilesManager.search(taskDescription);
    const alreadyCovered = existingSkills.some(
      (s) => s.mastery === 'proficient' || s.mastery === 'expert',
    );

    if (alreadyCovered) {
      // Record use of matching skill instead of creating a new one
      const bestMatch = existingSkills[0];
      if (bestMatch) {
        this.skillFilesManager.recordUse(bestMatch.id, true);
        tracer.log('deep-loop', 'info', `Recorded successful use of skill: ${bestMatch.name}`);
      }
      return;
    }

    // Extract a skill name from the task description
    const name = taskDescription
      .slice(0, 60)
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      || `task-pattern-${Date.now().toString(36)}`;

    const skillSteps = steps
      .filter((s) => s.status === 'done')
      .map((s) => s.description);

    if (skillSteps.length < 2) return;

    const result = this.skillFilesManager.learn({
      name,
      description: taskDescription.slice(0, 200),
      steps: skillSteps,
      tags: ['auto-learned', 'deep-loop'],
    });

    if (result.success) {
      tracer.log('deep-loop', 'info', `Learned new skill: ${name} (${result.skillId})`);
    }
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
      const fullPath = resolveImportPath(filePath, target);
      if (!knownPaths.has(fullPath) && !knownBaseNames.has(baseName)) {
        warnings.push(`imports '${target}' but no matching file exists in the workspace`);
      }
    }

    return warnings;
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
        const resolvedSource = resolveImportPath(filePath, binding.source);

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
// Cross-File API Validation Helpers (re-exported from static-analysis module)
// ─────────────────────────────────────────────────────────────────────────────

export {
  extractImportBindings,
  extractMemberAccesses,
  extractAPISurface,
  extractObjectPropertyNames,
  resolveImportPath,
  type ImportBinding,
} from '../tools/static-analysis.js';

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
