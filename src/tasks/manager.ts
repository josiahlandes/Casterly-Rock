/**
 * Task Manager — Top-Level Orchestrator
 *
 * Ties together the full task management pipeline:
 * classifier → planner → runner → verifier → operational memory
 *
 * Replaces the flat tool loop in daemon.ts with structured task handling:
 * 1. Classify message (conversation / simple_task / complex_task)
 * 2. For tasks: plan → execute → verify → log
 * 3. Return a response to the user
 *
 * This module is the single entry point for the daemon to handle
 * any user message that requires action.
 */

import { safeLogger } from '../logging/safe-logger.js';
import type { LlmProvider } from '../providers/base.js';
import type { ToolSchema } from '../tools/schemas/types.js';
import type { ToolOrchestrator } from '../tools/orchestrator.js';
import type { ExecutionLog } from './execution-log.js';
import type { ClassificationResult, ExecutionRecord, StepOutcome, TaskRunResult } from './types.js';
import { classifyMessage } from './classifier.js';
import { createTaskPlan } from './planner.js';
import { runTaskPlan } from './runner.js';
import { verifyTaskOutcome } from './verifier.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface TaskManagerOptions {
  /** Tool orchestrator with registered executors */
  orchestrator: ToolOrchestrator;
  /** Execution log for operational memory */
  executionLog: ExecutionLog;
  /** Available tool schemas (passed to planner) */
  availableTools: ToolSchema[];
  /** Maximum concurrent steps in the DAG runner (default 2) */
  maxConcurrency?: number | undefined;
  /** Maximum retries per step (default 2) */
  maxRetries?: number | undefined;
  /** Callback when a step completes */
  onStepComplete?: ((stepId: string, outcome: StepOutcome) => void) | undefined;
}

export interface TaskHandleResult {
  /** The classification of the original message */
  classification: ClassificationResult;
  /** The response text to send to the user */
  response: string;
  /** Execution result if a task was run */
  taskResult?: TaskRunResult | undefined;
}

// ─── Manager ────────────────────────────────────────────────────────────────

export interface TaskManager {
  /**
   * Handle a user message through the full pipeline.
   *
   * For conversation: returns null (caller should use normal LLM response)
   * For tasks: classify → plan → execute → verify → log → return response
   */
  handle(
    message: string,
    recentHistory: string[],
    provider: LlmProvider
  ): Promise<TaskHandleResult>;
}

/**
 * Create a task manager instance.
 */
export function createTaskManager(options: TaskManagerOptions): TaskManager {
  const {
    orchestrator,
    executionLog,
    availableTools,
    maxConcurrency = 2,
    maxRetries = 2,
    onStepComplete,
  } = options;

  return {
    async handle(
      message: string,
      recentHistory: string[],
      provider: LlmProvider
    ): Promise<TaskHandleResult> {
      // ─── Step 1: Classify ───────────────────────────────────────────

      const classification = await classifyMessage(message, recentHistory, provider);

      safeLogger.info('Task manager: message classified', {
        taskClass: classification.taskClass,
        confidence: classification.confidence,
        taskType: classification.taskType ?? 'none',
      });

      // Conversation — return early, let caller handle normal response
      if (classification.taskClass === 'conversation') {
        return {
          classification,
          response: '',  // empty signals caller should use normal LLM response
        };
      }

      // ─── Step 2: Plan ─────────────────────────────────────────────

      // Get relevant execution history for the planner
      const taskType = classification.taskType ?? 'general';
      const relevantHistory = executionLog.queryByType(taskType, 5);

      const plan = await createTaskPlan(
        message,
        availableTools,
        relevantHistory,
        provider
      );

      safeLogger.info('Task manager: plan created', {
        goal: plan.goal.substring(0, 80),
        steps: plan.steps.length,
      });

      // ─── Step 3: Execute ──────────────────────────────────────────

      const startTime = Date.now();

      const taskResult = await runTaskPlan(plan, {
        orchestrator,
        maxConcurrency,
        maxRetries,
        onStepComplete,
      });

      safeLogger.info('Task manager: execution complete', {
        overallSuccess: taskResult.overallSuccess,
        durationMs: taskResult.durationMs,
        stepsCompleted: taskResult.stepOutcomes.filter((o) => o.success).length,
        totalSteps: taskResult.stepOutcomes.length,
      });

      // ─── Step 4: Verify ───────────────────────────────────────────

      let verified = taskResult.overallSuccess;
      let verificationReason = '';

      if (taskResult.overallSuccess) {
        try {
          const verificationResult = await verifyTaskOutcome(
            plan,
            taskResult.stepOutcomes,
            provider
          );
          verified = verificationResult.verified;
          verificationReason = verificationResult.reason;
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          safeLogger.error('Task verification error (continuing with step-level result)', {
            error: errorMessage,
          });
          verificationReason = 'Verification error — using step-level results';
        }
      } else {
        verificationReason = 'Some steps failed';
      }

      safeLogger.info('Task manager: verification complete', {
        verified,
        reason: verificationReason.substring(0, 100),
      });

      // ─── Step 5: Log to operational memory ────────────────────────

      const totalRetries = taskResult.stepOutcomes.reduce(
        (sum, o) => sum + o.retries,
        0
      );

      const record: ExecutionRecord = {
        id: `exec-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`,
        timestamp: Date.now(),
        taskType,
        originalInstruction: redactInstruction(message),
        plan,
        stepResults: taskResult.stepOutcomes,
        overallSuccess: verified,
        durationMs: Date.now() - startTime,
        retries: totalRetries,
        notes: verified ? undefined : verificationReason,
      };

      executionLog.append(record);

      // ─── Step 6: Build response ───────────────────────────────────

      const response = buildResponse(taskResult, verified, verificationReason);

      return {
        classification,
        response,
        taskResult,
      };
    },
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Redact the user's instruction for operational memory.
 * Keeps the structure but removes potentially sensitive content.
 */
function redactInstruction(message: string): string {
  // Keep first 100 chars as a summary, replace the rest
  if (message.length <= 100) {
    return message;
  }
  return message.substring(0, 100) + '... [truncated]';
}

/**
 * Build a human-readable response from the task execution results.
 */
function buildResponse(
  result: TaskRunResult,
  verified: boolean,
  verificationReason: string
): string {
  const parts: string[] = [];

  if (verified) {
    parts.push(`Done. ${result.plan.goal}`);
  } else {
    parts.push(`I ran into some issues with: ${result.plan.goal}`);
  }

  // Summarize step results
  const succeeded = result.stepOutcomes.filter((o) => o.success).length;
  const total = result.stepOutcomes.length;

  if (total > 1) {
    parts.push(`\n${succeeded}/${total} steps completed successfully.`);
  }

  // Report failures
  const failures = result.stepOutcomes.filter((o) => !o.success);
  if (failures.length > 0) {
    const failureSummary = failures
      .map((f) => `- ${f.stepId}: ${f.failureReason ?? 'unknown error'}`)
      .join('\n');
    parts.push(`\nIssues:\n${failureSummary}`);
  }

  // Include relevant output from successful steps
  const outputs = result.stepOutcomes
    .filter((o) => o.success && o.output)
    .map((o) => {
      const output = o.output ?? '';
      // Truncate long outputs
      return output.length > 500 ? output.substring(0, 500) + '...' : output;
    });

  if (outputs.length > 0 && outputs.length <= 3) {
    parts.push(`\nResults:\n${outputs.join('\n')}`);
  }

  return parts.join('');
}
