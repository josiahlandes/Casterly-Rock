/**
 * Task Planner
 *
 * Decomposes a user instruction into a structured TaskPlan with ordered steps,
 * dependency graph, and verification criteria.
 *
 * Uses native tool use (create_plan tool) to force structured output from the LLM.
 * Incorporates operational memory: past execution records inform the planner
 * about tool reliability and effective approaches for similar tasks.
 *
 * Context is focused: instruction + available tools + relevant history.
 * No conversation history — the classifier already determined this is a task.
 */

import { safeLogger } from '../logging/safe-logger.js';
import { PROFILES } from '../interface/context-profiles.js';
import type { LlmProvider } from '../providers/base.js';
import type { ToolSchema, GenerateWithToolsResponse } from '../tools/schemas/types.js';
import type { TaskPlan, TaskStep, Verification, ExecutionRecord } from './types.js';

/**
 * Tool schema that forces the model to output a structured plan.
 * The model MUST call this tool — it's the only tool available during planning.
 */
const PLAN_TOOL: ToolSchema = {
  name: 'create_plan',
  description: `Create a structured execution plan for the user's task. You MUST call this tool with your plan.

Rules for planning:
- Break the task into the smallest reasonable steps
- Each step should use exactly one tool
- Set dependsOn to reference step IDs that must complete first
- Steps with no dependencies can run in parallel
- Include verification for each step so we can confirm it worked
- Use only the tools listed in the available tools section`,

  inputSchema: {
    type: 'object',
    properties: {
      goal: {
        type: 'string',
        description: 'What the user wants to accomplish (one sentence).',
      },
      completionCriteria: {
        type: 'array',
        description: 'Measurable criteria for "done". Each should be verifiable.',
        items: { type: 'string', description: 'A single completion criterion.' },
      },
      steps: {
        type: 'array',
        description: 'Ordered steps to execute. Each step calls one tool.',
        items: {
          type: 'object',
          description: 'A single step in the plan.',
          properties: {
            id: {
              type: 'string',
              description: 'Unique step ID like "step-1", "step-2".',
            },
            description: {
              type: 'string',
              description: 'What this step does (human-readable).',
            },
            tool: {
              type: 'string',
              description: 'Tool name to call for this step.',
            },
            input: {
              type: 'object',
              description: 'Input parameters for the tool call.',
            },
            dependsOn: {
              type: 'array',
              description: 'Step IDs that must complete before this step.',
              items: { type: 'string', description: 'A step ID.' },
            },
            verificationType: {
              type: 'string',
              description: 'How to verify this step succeeded.',
              enum: ['exit_code', 'file_exists', 'output_contains', 'schema', 'llm_judge', 'none'],
            },
            verificationValue: {
              type: 'string',
              description: 'Value for verification: expected exit code, file path, substring, schema JSON, or judge prompt.',
            },
          },
          required: ['id', 'description', 'tool', 'dependsOn'],
        },
      },
    },
    required: ['goal', 'completionCriteria', 'steps'],
  },
};

/**
 * System prompt for the planner.
 */
function buildPlannerSystemPrompt(
  availableTools: ToolSchema[],
  executionHistory: ExecutionRecord[]
): string {
  const parts: string[] = [];

  parts.push(`You are a task planner. Your ONLY job is to decompose the user's instruction into a structured execution plan by calling the create_plan tool.

Rules:
- Break the task into small, concrete steps
- Each step calls exactly one tool from the available tools list
- Set dependsOn correctly — steps without dependencies can run in parallel
- Include tool input parameters when you can determine them from the instruction
- Choose appropriate verification for each step
- You MUST call the create_plan tool. Do not respond with text.`);

  // List available tools
  const toolDescriptions = availableTools
    .map((t) => `- ${t.name}: ${t.description.split('\n')[0]}`)
    .join('\n');
  parts.push(`\nAvailable tools:\n${toolDescriptions}`);

  // Include relevant execution history for learning
  if (executionHistory.length > 0) {
    const historyLines: string[] = [];
    for (const record of executionHistory.slice(-5)) {
      const status = record.overallSuccess ? 'succeeded' : 'failed';
      const failedSteps = record.stepResults
        .filter((s) => !s.success)
        .map((s) => `${s.tool}: ${s.failureReason ?? 'unknown'}`)
        .join(', ');

      let line = `- "${record.taskType}" task ${status} (${record.durationMs}ms)`;
      if (failedSteps) {
        line += ` — failures: ${failedSteps}`;
      }
      historyLines.push(line);
    }
    parts.push(`\nRecent task execution history (learn from past outcomes):\n${historyLines.join('\n')}`);
  }

  return parts.join('\n');
}

/**
 * Parse a verification from the model's raw output.
 */
function parseVerification(type?: string, value?: string): Verification {
  if (!type || type === 'none') {
    return { type: 'none' };
  }

  switch (type) {
    case 'exit_code':
      return { type: 'exit_code', expect: parseInt(value ?? '0', 10) || 0 };
    case 'file_exists':
      return { type: 'file_exists', path: value ?? '' };
    case 'output_contains':
      return { type: 'output_contains', substring: value ?? '' };
    case 'schema':
      try {
        return { type: 'schema', jsonSchema: JSON.parse(value ?? '{}') as Record<string, unknown> };
      } catch {
        return { type: 'none' };
      }
    case 'llm_judge':
      return { type: 'llm_judge', prompt: value ?? 'Did this step succeed?' };
    default:
      return { type: 'none' };
  }
}

/**
 * Parse the plan from the model's tool call response.
 */
function parsePlan(response: GenerateWithToolsResponse): TaskPlan | null {
  if (response.toolCalls.length === 0) {
    return null;
  }

  const call = response.toolCalls[0];
  if (!call || call.name !== 'create_plan') {
    return null;
  }

  const input = call.input;
  const goal = input.goal as string | undefined;
  const completionCriteria = input.completionCriteria as string[] | undefined;
  const rawSteps = input.steps as Array<Record<string, unknown>> | undefined;

  if (!goal || !completionCriteria || !rawSteps || rawSteps.length === 0) {
    return null;
  }

  const steps: TaskStep[] = rawSteps.map((raw, index) => ({
    id: (raw.id as string) ?? `step-${index + 1}`,
    description: (raw.description as string) ?? `Step ${index + 1}`,
    tool: (raw.tool as string) ?? 'bash',
    input: (raw.input as Record<string, unknown>) ?? {},
    dependsOn: (raw.dependsOn as string[]) ?? [],
    verification: parseVerification(
      raw.verificationType as string | undefined,
      raw.verificationValue as string | undefined
    ),
  }));

  // Validate dependency references
  const stepIds = new Set(steps.map((s) => s.id));
  for (const step of steps) {
    step.dependsOn = step.dependsOn.filter((dep) => stepIds.has(dep));
  }

  return {
    goal,
    completionCriteria: completionCriteria.filter((c) => typeof c === 'string'),
    steps,
  };
}

/**
 * Create a structured task plan from a user instruction.
 *
 * Uses a focused LLM call with the create_plan tool as the only
 * available tool, forcing structured output.
 *
 * @param instruction - The user's instruction to plan for
 * @param availableTools - Tools the plan can use
 * @param executionHistory - Recent execution records for learning
 * @param provider - LLM provider to use for planning
 * @returns Structured task plan with steps, dependencies, and verification
 */
export async function createTaskPlan(
  instruction: string,
  availableTools: ToolSchema[],
  executionHistory: ExecutionRecord[],
  provider: LlmProvider
): Promise<TaskPlan> {
  const systemPrompt = buildPlannerSystemPrompt(availableTools, executionHistory);

  try {
    const response = await provider.generateWithTools(
      {
        prompt: `Create a plan for this task:\n\n${instruction}`,
        systemPrompt,
        maxTokens: PROFILES.planner.generation.maxTokens,
        temperature: PROFILES.planner.generation.temperature,
      },
      [PLAN_TOOL]
    );

    const plan = parsePlan(response);

    if (plan) {
      safeLogger.info('Task plan created', {
        goal: plan.goal.substring(0, 100),
        steps: plan.steps.length,
        criteria: plan.completionCriteria.length,
        tools: [...new Set(plan.steps.map((s) => s.tool))].join(', '),
      });
      return plan;
    }

    // Model didn't call the tool — create a minimal single-step plan
    safeLogger.warn('Planner did not call create_plan tool, creating fallback plan');
    return {
      goal: instruction.substring(0, 200),
      completionCriteria: ['Task completed successfully'],
      steps: [
        {
          id: 'step-1',
          description: instruction.substring(0, 200),
          tool: 'bash',
          input: { command: 'echo "Plan generation failed — manual intervention needed"' },
          dependsOn: [],
          verification: { type: 'none' },
        },
      ],
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    safeLogger.error('Planning failed', { error: errorMessage });

    // Return a minimal error plan
    return {
      goal: instruction.substring(0, 200),
      completionCriteria: ['Task completed successfully'],
      steps: [
        {
          id: 'step-1',
          description: `Planning error: ${errorMessage}`,
          tool: 'bash',
          input: { command: `echo "Planning failed: ${errorMessage.replace(/"/g, '\\"')}"` },
          dependsOn: [],
          verification: { type: 'none' },
        },
      ],
    };
  }
}
