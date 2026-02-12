/**
 * Task Classifier
 *
 * Determines whether an incoming message is:
 * - conversation: no action needed, respond directly
 * - simple_task: single tool call, skip decomposition
 * - complex_task: multi-step plan needed
 *
 * Uses native tool use (classify_message tool) to force structured output
 * from the LLM, following the same pattern as route_decision.
 *
 * Context is kept minimal for fast classification on local models:
 * just the current message and last 2-3 exchanges (ISSUE-006 pattern).
 */

import { safeLogger } from '../logging/safe-logger.js';
import type { LlmProvider } from '../providers/base.js';
import type { ToolSchema, GenerateWithToolsResponse } from '../tools/schemas/types.js';
import type { ClassificationResult, TaskClass } from './types.js';

/**
 * Tool schema that forces the model to output a structured classification.
 * The model MUST call this tool to respond — it's the only tool available.
 */
const CLASSIFY_TOOL: ToolSchema = {
  name: 'classify_message',
  description: `Classify the user message. You MUST call this tool with your classification.

Categories:
- conversation: The user is chatting, asking a question you can answer from knowledge, or making small talk. No tools or actions needed.
- simple_task: The user wants something done that requires a single tool call (check calendar, read a file, get the time, etc.).
- complex_task: The user wants something done that requires multiple steps, planning, or coordination (organize files, summarize and email, multi-step workflows).`,

  inputSchema: {
    type: 'object',
    properties: {
      taskClass: {
        type: 'string',
        description: 'The classification of the message.',
        enum: ['conversation', 'simple_task', 'complex_task'],
      },
      confidence: {
        type: 'number',
        description: 'Confidence in the classification, from 0.0 to 1.0.',
      },
      reason: {
        type: 'string',
        description: 'Brief explanation for the classification (one sentence).',
      },
      taskType: {
        type: 'string',
        description: 'If this is a task, what category? e.g. calendar, file_operation, coding, reminder, system_info, communication',
      },
    },
    required: ['taskClass', 'confidence', 'reason'],
  },
};

/**
 * System prompt for the classifier — kept short for fast inference.
 */
const CLASSIFIER_SYSTEM_PROMPT = `You are a message classifier. Your ONLY job is to classify the user's message by calling the classify_message tool.

Rules:
- If the user is chatting, greeting, asking factual questions, or making conversation → "conversation"
- If the user wants one simple action (check something, read something, get info) → "simple_task"
- If the user wants multiple things done, or something requiring planning → "complex_task"
- When in doubt between conversation and simple_task, prefer "conversation"
- When in doubt between simple_task and complex_task, prefer "simple_task"

You MUST call the classify_message tool. Do not respond with text.`;

/**
 * Build a minimal context string for classification.
 * Only includes the current message and a few recent exchanges.
 */
function buildClassifierContext(
  message: string,
  recentHistory: string[]
): string {
  const parts: string[] = [];

  if (recentHistory.length > 0) {
    // Include last 3 exchanges max
    const recent = recentHistory.slice(-3);
    parts.push('Recent conversation:\n' + recent.join('\n'));
  }

  parts.push(`Current message: ${message}`);

  return parts.join('\n\n');
}

/**
 * Parse the classification from the model's tool call response.
 */
function parseClassification(response: GenerateWithToolsResponse): ClassificationResult | null {
  if (response.toolCalls.length === 0) {
    return null;
  }

  const call = response.toolCalls[0];
  if (!call || call.name !== 'classify_message') {
    return null;
  }

  const input = call.input;
  const taskClass = input.taskClass as string | undefined;
  const confidence = input.confidence as number | undefined;
  const reason = input.reason as string | undefined;
  const taskType = input.taskType as string | undefined;

  if (!taskClass || !['conversation', 'simple_task', 'complex_task'].includes(taskClass)) {
    return null;
  }

  return {
    taskClass: taskClass as TaskClass,
    confidence: typeof confidence === 'number' ? Math.max(0, Math.min(1, confidence)) : 0.5,
    reason: typeof reason === 'string' ? reason : 'No reason provided',
    taskType: typeof taskType === 'string' ? taskType : undefined,
  };
}

/**
 * Classify an incoming message as conversation, simple task, or complex task.
 *
 * Uses a focused LLM call with the classify_message tool as the only
 * available tool, forcing structured output.
 *
 * @param message - The user's message to classify
 * @param recentHistory - Last 2-3 formatted conversation exchanges for context
 * @param provider - LLM provider to use for classification
 * @returns Classification result with task class, confidence, and reason
 */
export async function classifyMessage(
  message: string,
  recentHistory: string[],
  provider: LlmProvider
): Promise<ClassificationResult> {
  const context = buildClassifierContext(message, recentHistory);

  try {
    const response = await provider.generateWithTools(
      {
        prompt: context,
        systemPrompt: CLASSIFIER_SYSTEM_PROMPT,
        maxTokens: 256,    // classification should be tiny
        temperature: 0.1,  // low temp for consistent classification
      },
      [CLASSIFY_TOOL]
    );

    const classification = parseClassification(response);

    if (classification) {
      safeLogger.info('Message classified', {
        taskClass: classification.taskClass,
        confidence: classification.confidence,
        taskType: classification.taskType ?? 'none',
        reason: classification.reason.substring(0, 100),
      });
      return classification;
    }

    // Model didn't call the tool — default to conversation
    safeLogger.warn('Classifier did not call classify_message tool, defaulting to conversation');
    return {
      taskClass: 'conversation',
      confidence: 0.3,
      reason: 'Classifier fallback: model did not produce structured classification',
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    safeLogger.error('Classification failed', { error: errorMessage });

    // On error, default to conversation (safest — no tools called)
    return {
      taskClass: 'conversation',
      confidence: 0.1,
      reason: `Classification error: ${errorMessage}`,
    };
  }
}
