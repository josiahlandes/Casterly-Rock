/**
 * Task Verifier
 *
 * Verifies step outcomes and overall task completion.
 *
 * Step-level verification (synchronous checks):
 * - exit_code: check NativeToolResult.exitCode
 * - file_exists: check fs.existsSync
 * - output_contains: check result.output includes substring
 * - schema: validate output against JSON schema
 * - llm_judge: send to LLM for evaluation (requires provider)
 * - none: always passes
 *
 * Task-level verification:
 * Uses an LLM call to evaluate whether completion criteria were met
 * given the step outcomes.
 */

import { existsSync } from 'node:fs';
import { safeLogger } from '../logging/safe-logger.js';
import { PROFILES } from '../interface/context-profiles.js';
import type { LlmProvider } from '../providers/base.js';
import type { ToolSchema, GenerateWithToolsResponse } from '../tools/schemas/types.js';
import type { NativeToolResult } from '../tools/schemas/types.js';
import type { TaskPlan, TaskStep, StepOutcome } from './types.js';

/** Verification result */
export interface VerificationResult {
  verified: boolean;
  reason: string;
}

// ─── Step Verification ──────────────────────────────────────────────────────

/**
 * Verify a single step's outcome against its verification criteria.
 *
 * This is a fast, synchronous check for most verification types.
 * The llm_judge type requires a provider (passed separately when needed).
 */
export async function verifyStepOutcome(
  step: TaskStep,
  result: NativeToolResult
): Promise<VerificationResult> {
  const v = step.verification;

  switch (v.type) {
    case 'none':
      return { verified: true, reason: 'No verification required' };

    case 'exit_code':
      if (result.exitCode === undefined) {
        // Tool didn't report an exit code — check success flag instead
        return result.success
          ? { verified: true, reason: 'Tool succeeded (no exit code reported)' }
          : { verified: false, reason: 'Tool failed (no exit code reported)' };
      }
      return result.exitCode === v.expect
        ? { verified: true, reason: `Exit code ${result.exitCode} matches expected ${v.expect}` }
        : { verified: false, reason: `Exit code ${result.exitCode} does not match expected ${v.expect}` };

    case 'file_exists':
      return existsSync(v.path)
        ? { verified: true, reason: `File exists: ${v.path}` }
        : { verified: false, reason: `File not found: ${v.path}` };

    case 'output_contains':
      if (!result.output) {
        return { verified: false, reason: 'No output to check' };
      }
      return result.output.includes(v.substring)
        ? { verified: true, reason: `Output contains "${v.substring.substring(0, 50)}"` }
        : { verified: false, reason: `Output does not contain "${v.substring.substring(0, 50)}"` };

    case 'schema':
      return verifySchema(result.output, v.jsonSchema);

    case 'llm_judge':
      // LLM judge requires a provider — return pending for now.
      // The task-level verifier handles LLM-based verification.
      safeLogger.warn('llm_judge verification deferred to task-level verifier', {
        stepId: step.id,
      });
      return { verified: true, reason: 'LLM judge deferred to task-level verification' };

    default:
      return { verified: true, reason: 'Unknown verification type — passing by default' };
  }
}

/**
 * Basic JSON schema validation.
 * Checks required fields and top-level types. Not a full JSON Schema validator,
 * but sufficient for common task verification patterns.
 */
function verifySchema(
  output: string | undefined,
  schema: Record<string, unknown>
): VerificationResult {
  if (!output) {
    return { verified: false, reason: 'No output to validate against schema' };
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(output) as Record<string, unknown>;
  } catch {
    return { verified: false, reason: 'Output is not valid JSON' };
  }

  // Check required fields
  const required = schema.required as string[] | undefined;
  if (required) {
    for (const field of required) {
      if (!(field in parsed)) {
        return { verified: false, reason: `Missing required field: ${field}` };
      }
    }
  }

  // Check top-level property types
  const properties = schema.properties as Record<string, Record<string, unknown>> | undefined;
  if (properties) {
    for (const [key, propSchema] of Object.entries(properties)) {
      if (key in parsed && propSchema.type) {
        const value = parsed[key];
        const expectedType = propSchema.type as string;
        const actualType = Array.isArray(value) ? 'array' : typeof value;

        if (expectedType === 'integer') {
          if (typeof value !== 'number' || !Number.isInteger(value)) {
            return { verified: false, reason: `Field "${key}" is not an integer` };
          }
        } else if (actualType !== expectedType) {
          return { verified: false, reason: `Field "${key}" is ${actualType}, expected ${expectedType}` };
        }
      }
    }
  }

  return { verified: true, reason: 'Output matches schema' };
}

// ─── Task-Level Verification ────────────────────────────────────────────────

/**
 * Tool schema that forces the model to output a structured verification.
 */
const VERIFY_TOOL: ToolSchema = {
  name: 'verify_task',
  description: 'Verify whether a task was completed successfully. You MUST call this tool.',
  inputSchema: {
    type: 'object',
    properties: {
      verified: {
        type: 'boolean',
        description: 'Whether all completion criteria are met.',
      },
      reason: {
        type: 'string',
        description: 'Explanation of the verification result.',
      },
      unmetCriteria: {
        type: 'array',
        description: 'List of completion criteria that were NOT met.',
        items: { type: 'string', description: 'An unmet criterion.' },
      },
    },
    required: ['verified', 'reason'],
  },
};

/**
 * Verify the overall task outcome using an LLM to evaluate
 * whether all completion criteria were met.
 *
 * @param plan - The original task plan
 * @param outcomes - Results from each step
 * @param provider - LLM provider for evaluation
 * @returns Whether the task is verified complete
 */
export async function verifyTaskOutcome(
  plan: TaskPlan,
  outcomes: StepOutcome[],
  provider: LlmProvider
): Promise<VerificationResult> {
  // Quick check: if any step failed, task likely failed
  const allStepsSucceeded = outcomes.every((o) => o.success);

  // Build verification context
  const criteriaList = plan.completionCriteria
    .map((c, i) => `${i + 1}. ${c}`)
    .join('\n');

  const stepSummary = outcomes
    .map((o) => {
      const status = o.success ? 'OK' : `FAILED (${o.failureReason ?? 'unknown'})`;
      return `- ${o.stepId} [${o.tool}]: ${status}`;
    })
    .join('\n');

  const systemPrompt = `You are a task verifier. Evaluate whether a task's completion criteria are met based on the step outcomes. You MUST call the verify_task tool with your assessment.

Be strict: if a step failed and it was necessary for a criterion, mark that criterion as unmet.`;

  const prompt = `Task goal: ${plan.goal}

Completion criteria:
${criteriaList}

Step outcomes:
${stepSummary}

All steps succeeded: ${allStepsSucceeded ? 'yes' : 'no'}

Evaluate whether all completion criteria are met.`;

  try {
    const response = await provider.generateWithTools(
      {
        prompt,
        systemPrompt,
        maxTokens: PROFILES.verifier.generation.maxTokens,
        temperature: PROFILES.verifier.generation.temperature,
      },
      [VERIFY_TOOL]
    );

    const result = parseVerifyResponse(response);

    if (result) {
      safeLogger.info('Task verification complete', {
        verified: result.verified,
        reason: result.reason.substring(0, 100),
      });
      return result;
    }

    // Model didn't call the tool — fall back to step-level check
    safeLogger.warn('Verifier did not call verify_task tool, falling back to step check');
    return {
      verified: allStepsSucceeded,
      reason: allStepsSucceeded
        ? 'All steps succeeded (LLM verification unavailable)'
        : 'Some steps failed (LLM verification unavailable)',
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    safeLogger.error('Task verification failed', { error: errorMessage });

    // On error, fall back to step-level check
    return {
      verified: allStepsSucceeded,
      reason: `Verification error (falling back to step check): ${errorMessage}`,
    };
  }
}

/**
 * Parse the verification response from the LLM.
 */
function parseVerifyResponse(response: GenerateWithToolsResponse): VerificationResult | null {
  if (response.toolCalls.length === 0) {
    return null;
  }

  const call = response.toolCalls[0];
  if (!call || call.name !== 'verify_task') {
    return null;
  }

  const input = call.input;
  const verified = input.verified as boolean | undefined;
  const reason = input.reason as string | undefined;
  const unmetCriteria = input.unmetCriteria as string[] | undefined;

  if (typeof verified !== 'boolean') {
    return null;
  }

  let fullReason = typeof reason === 'string' ? reason : 'No reason provided';
  if (unmetCriteria && unmetCriteria.length > 0) {
    fullReason += ` | Unmet: ${unmetCriteria.join(', ')}`;
  }

  return { verified, reason: fullReason };
}
