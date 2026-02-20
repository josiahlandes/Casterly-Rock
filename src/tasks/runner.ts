/**
 * Task Runner — DAG Executor
 *
 * Executes a TaskPlan by walking the dependency graph:
 * 1. Build adjacency map from dependsOn fields
 * 2. Find steps with no dependencies → ready queue
 * 3. Execute ready steps (up to maxConcurrency) using semaphore
 * 4. On completion, check which new steps have all deps satisfied
 * 5. On failure, mark step failed, skip dependents
 * 6. Continue until all steps complete or all remaining are blocked
 *
 * Concurrency is bounded by a semaphore — default 2 for M4 Max
 * to avoid overloading the unified memory with concurrent model calls.
 */

import { safeLogger } from '../logging/safe-logger.js';
import type { ToolOrchestrator } from '../tools/orchestrator.js';
import type { NativeToolResult } from '../tools/schemas/types.js';
import type { TaskPlan, TaskStep, StepOutcome, TaskRunResult } from './types.js';
import { verifyStepOutcome } from './verifier.js';
import { TOOL_REQUIRED_PARAMS } from './tool-params.js';

/**
 * Validate that a step has the minimum required input parameters.
 * Returns null if valid, or an error message if invalid.
 */
function validateStepInput(step: TaskStep): string | null {
  const required = TOOL_REQUIRED_PARAMS[step.tool];
  if (!required || required.length === 0) {
    return null; // unknown tool or no required params
  }

  const missing = required.filter((param) => {
    const val = step.input[param];
    return val === undefined || val === null || val === '';
  });

  if (missing.length > 0) {
    return `Missing required parameters for ${step.tool}: ${missing.join(', ')}`;
  }

  return null;
}

// ─── Semaphore ──────────────────────────────────────────────────────────────

/**
 * Promise-based semaphore for bounding concurrency.
 */
class Semaphore {
  private current = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly max: number) {}

  async acquire(): Promise<void> {
    if (this.current < this.max) {
      this.current++;
      return;
    }

    return new Promise<void>((resolve) => {
      this.queue.push(() => {
        this.current++;
        resolve();
      });
    });
  }

  release(): void {
    this.current--;
    const next = this.queue.shift();
    if (next) {
      next();
    }
  }
}

// ─── Runner Options ─────────────────────────────────────────────────────────

export interface TaskRunnerOptions {
  /** Tool orchestrator for executing tool calls */
  orchestrator: ToolOrchestrator;
  /** Maximum concurrent step executions (default 2 for M4 Max) */
  maxConcurrency?: number | undefined;
  /** Maximum retry attempts per step (default 2) */
  maxRetries?: number | undefined;
  /** Callback when a step completes */
  onStepComplete?: ((stepId: string, outcome: StepOutcome) => void) | undefined;
}

// ─── Step Execution ─────────────────────────────────────────────────────────

/**
 * Execute a single step with retry logic.
 */
async function executeStep(
  step: TaskStep,
  orchestrator: ToolOrchestrator,
  maxRetries: number
): Promise<{ outcome: StepOutcome; toolResult: NativeToolResult }> {
  // Fast-fail: check required params before attempting execution
  const validationError = validateStepInput(step);
  if (validationError) {
    safeLogger.warn('Step input validation failed', {
      stepId: step.id,
      tool: step.tool,
      error: validationError,
    });
    const failOutcome: StepOutcome = {
      stepId: step.id,
      tool: step.tool,
      success: false,
      retries: 0,
      failureReason: validationError,
      durationMs: 0,
    };
    const failResult: NativeToolResult = {
      toolCallId: `${step.id}-validation`,
      success: false,
      error: validationError,
    };
    return { outcome: failOutcome, toolResult: failResult };
  }

  let lastResult: NativeToolResult | null = null;
  let retries = 0;

  const startTime = Date.now();

  while (retries <= maxRetries) {
    const toolCall = {
      id: `${step.id}-attempt-${retries}`,
      name: step.tool,
      input: step.input,
    };

    lastResult = await orchestrator.execute(toolCall);

    if (lastResult.success) {
      const outcome: StepOutcome = {
        stepId: step.id,
        tool: step.tool,
        success: true,
        retries,
        durationMs: Date.now() - startTime,
        output: lastResult.output,
      };
      return { outcome, toolResult: lastResult };
    }

    retries++;

    if (retries <= maxRetries) {
      safeLogger.info('Retrying step', {
        stepId: step.id,
        attempt: retries,
        maxRetries,
        lastError: lastResult.error?.substring(0, 100),
      });
    }
  }

  // All retries exhausted
  const outcome: StepOutcome = {
    stepId: step.id,
    tool: step.tool,
    success: false,
    retries: retries - 1,
    failureReason: lastResult?.error ?? 'Unknown failure',
    durationMs: Date.now() - startTime,
    output: lastResult?.output,
  };

  return { outcome, toolResult: lastResult! };
}

// ─── DAG Runner ─────────────────────────────────────────────────────────────

/**
 * Run a task plan by executing steps according to the dependency graph.
 *
 * Steps with satisfied dependencies are run concurrently (up to maxConcurrency).
 * On failure, dependent steps are skipped. Retries are attempted per step.
 *
 * @param plan - The task plan to execute
 * @param options - Runner configuration
 * @returns Aggregate result with all step outcomes
 */
export async function runTaskPlan(
  plan: TaskPlan,
  options: TaskRunnerOptions
): Promise<TaskRunResult> {
  const {
    orchestrator,
    maxConcurrency = 2,
    maxRetries = 2,
    onStepComplete,
  } = options;

  const startTime = Date.now();
  const semaphore = new Semaphore(maxConcurrency);

  // Build state tracking
  const outcomes = new Map<string, StepOutcome>();
  const completed = new Set<string>();
  const failed = new Set<string>();
  const skipped = new Set<string>();

  // Build reverse dependency map: step → steps that depend on it
  const dependents = new Map<string, string[]>();
  for (const step of plan.steps) {
    for (const dep of step.dependsOn) {
      const existing = dependents.get(dep) ?? [];
      existing.push(step.id);
      dependents.set(dep, existing);
    }
  }

  // Step lookup
  const stepMap = new Map(plan.steps.map((s) => [s.id, s]));

  /**
   * Check if a step is ready to run (all dependencies satisfied).
   */
  function isReady(step: TaskStep): boolean {
    return step.dependsOn.every((dep) => completed.has(dep));
  }

  /**
   * Check if a step should be skipped (any dependency failed).
   */
  function shouldSkip(step: TaskStep): boolean {
    return step.dependsOn.some((dep) => failed.has(dep) || skipped.has(dep));
  }

  /**
   * Execute a step and process its result.
   */
  async function processStep(step: TaskStep): Promise<void> {
    await semaphore.acquire();

    try {
      safeLogger.info('Executing step', {
        stepId: step.id,
        tool: step.tool,
        description: step.description.substring(0, 80),
      });

      const { outcome, toolResult } = await executeStep(step, orchestrator, maxRetries);

      // Verify the step if it succeeded and has verification
      if (outcome.success && step.verification.type !== 'none') {
        const verification = await verifyStepOutcome(step, toolResult);
        if (!verification.verified) {
          outcome.success = false;
          outcome.failureReason = `Verification failed: ${verification.reason}`;
          safeLogger.warn('Step verification failed', {
            stepId: step.id,
            reason: verification.reason,
          });
        }
      }

      outcomes.set(step.id, outcome);

      if (outcome.success) {
        completed.add(step.id);
      } else {
        failed.add(step.id);
      }

      if (onStepComplete) {
        onStepComplete(step.id, outcome);
      }

      safeLogger.info('Step completed', {
        stepId: step.id,
        success: outcome.success,
        retries: outcome.retries,
        durationMs: outcome.durationMs,
      });
    } finally {
      semaphore.release();
    }
  }

  // ─── Main execution loop ────────────────────────────────────────────────

  // Find initial ready steps (no dependencies)
  const pending = new Set(plan.steps.map((s) => s.id));

  while (pending.size > 0) {
    const batch: TaskStep[] = [];

    for (const stepId of pending) {
      const step = stepMap.get(stepId);
      if (!step) continue;

      if (shouldSkip(step)) {
        // Skip this step — a dependency failed
        pending.delete(stepId);
        skipped.add(stepId);
        outcomes.set(stepId, {
          stepId: step.id,
          tool: step.tool,
          success: false,
          retries: 0,
          failureReason: 'Skipped: dependency failed',
          durationMs: 0,
        });

        if (onStepComplete) {
          onStepComplete(stepId, outcomes.get(stepId)!);
        }

        safeLogger.info('Step skipped (dependency failed)', { stepId });
        continue;
      }

      if (isReady(step)) {
        batch.push(step);
      }
    }

    if (batch.length === 0) {
      // No steps are ready — either all done or deadlocked
      if (pending.size > 0) {
        safeLogger.warn('Task runner deadlocked — remaining steps have unsatisfied dependencies', {
          remaining: Array.from(pending),
        });

        // Mark remaining as skipped
        for (const stepId of pending) {
          const step = stepMap.get(stepId);
          if (step) {
            skipped.add(stepId);
            outcomes.set(stepId, {
              stepId: step.id,
              tool: step.tool,
              success: false,
              retries: 0,
              failureReason: 'Skipped: unresolvable dependency',
              durationMs: 0,
            });
          }
        }
      }
      break;
    }

    // Remove batch from pending
    for (const step of batch) {
      pending.delete(step.id);
    }

    // Execute batch concurrently (semaphore handles the limit)
    await Promise.all(batch.map(processStep));
  }

  // ─── Aggregate results ────────────────────────────────────────────────

  const stepOutcomes = plan.steps.map(
    (s) => outcomes.get(s.id) ?? {
      stepId: s.id,
      tool: s.tool,
      success: false,
      retries: 0,
      failureReason: 'Never executed',
      durationMs: 0,
    }
  );

  const overallSuccess = stepOutcomes.every((o) => o.success);
  const durationMs = Date.now() - startTime;

  safeLogger.info('Task plan execution complete', {
    totalSteps: plan.steps.length,
    succeeded: completed.size,
    failed: failed.size,
    skipped: skipped.size,
    overallSuccess,
    durationMs,
  });

  return {
    plan,
    stepOutcomes,
    overallSuccess,
    durationMs,
  };
}
