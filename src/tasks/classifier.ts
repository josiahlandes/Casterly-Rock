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
import { PROFILES } from '../interface/context-profiles.js';
import type { LlmProvider } from '../providers/base.js';
import type { ToolSchema, GenerateWithToolsResponse } from '../tools/schemas/types.js';
import type { ClassificationResult, TaskClass } from './types.js';
import type { AneProvider, TaskCategory } from '../providers/ane.js';

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
- complex_task: The user wants something done that requires multiple steps, planning, or coordination (organize files, summarize and email, multi-step workflows).

IMPORTANT — Generative tasks (creating schedules, writing plans, drafting text, brainstorming) are "conversation" — they need the LLM to generate text, NOT to call tools. Only classify as a task when actual tool execution is required.`,

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
      needsClarification: {
        type: 'boolean',
        description: 'True if the user\'s request is missing key information needed to complete it well. For example: a scheduling request without time constraints, a vague "organize my stuff" without scope, or a request that depends on unknown preferences.',
      },
      clarificationQuestions: {
        type: 'array',
        items: { type: 'string', description: 'A specific question to ask the user.' },
        description: 'If needsClarification is true, list 1-3 specific follow-up questions that would help complete the request.',
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
- "conversation" — The user is chatting, greeting, asking questions you can answer from knowledge, reflecting, or combining conversation with a request. If the message is primarily conversational with an incidental action, choose this. ALSO use this for generative requests: creating schedules, writing plans, drafting text, brainstorming ideas, giving suggestions — anything where the main output is LLM-generated text rather than tool execution.
- "simple_task" — The user's ENTIRE message is a direct, unambiguous command for a single action: "What time is it?", "Read /tmp/foo.txt", "Check my calendar today". No opinion, no follow-up, no conversational filler.
- "complex_task" — The user explicitly wants multiple distinct actions completed, or a workflow requiring coordination of real tools (file operations, API calls, multi-step system commands).

IMPORTANT: Default to "conversation" unless the message is clearly and purely a task command. Most messages from real users include conversational context — classify those as "conversation" so the assistant can respond naturally while using tools.

Clarification: Set needsClarification to true when the request is missing key details that would significantly change the output — for example, a scheduling request without time constraints or wake/sleep times, a "plan my trip" without dates or budget, or a task where critical preferences are unknown. Include 1-3 specific follow-up questions. Do NOT flag needsClarification for minor details the assistant can reasonably assume.

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
  const needsClarification = input.needsClarification as boolean | undefined;
  const clarificationQuestions = input.clarificationQuestions as string[] | undefined;

  if (!taskClass || !['conversation', 'simple_task', 'complex_task'].includes(taskClass)) {
    return null;
  }

  const result: ClassificationResult = {
    taskClass: taskClass as TaskClass,
    confidence: typeof confidence === 'number' ? Math.max(0, Math.min(1, confidence)) : 0.5,
    reason: typeof reason === 'string' ? reason : 'No reason provided',
    taskType: typeof taskType === 'string' ? taskType : undefined,
  };

  if (needsClarification === true) {
    result.needsClarification = true;
  }

  if (Array.isArray(clarificationQuestions) && clarificationQuestions.length > 0) {
    result.clarificationQuestions = clarificationQuestions.filter(
      (q): q is string => typeof q === 'string' && q.length > 0
    );
  }

  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// ANE Pre-Filter (NPU-accelerated classification)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Map ANE TaskCategory to our TaskClass.
 * ANE categories are more granular — we map them to conversation/task classes.
 */
function mapAneCategory(category: TaskCategory): TaskClass {
  switch (category) {
    case 'conversation':
      return 'conversation';
    case 'coding':
    case 'review':
      return 'complex_task';
    case 'analysis':
    case 'planning':
      return 'complex_task';
    default:
      return 'conversation';
  }
}

/** Shared ANE provider instance — set via setClassifierAneProvider() */
let classifierAne: AneProvider | null = null;

/**
 * Attach an ANE provider to the classifier for NPU-accelerated pre-filtering.
 * When set, high-confidence ANE classifications skip the LLM call entirely.
 */
export function setClassifierAneProvider(ane: AneProvider): void {
  classifierAne = ane;
}

/**
 * ANE confidence threshold for skipping the LLM classifier.
 * Only skip when ANE is very confident to avoid misrouting.
 */
const ANE_SKIP_THRESHOLD = 0.85;

/**
 * Classify an incoming message as conversation, simple task, or complex task.
 *
 * Uses a two-tier strategy:
 *   1. ANE pre-filter (NPU) — if the ANE classifier returns high confidence
 *      (≥0.85), skip the LLM call entirely. This is essentially free compute.
 *   2. LLM classification — focused call with the classify_message tool.
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
  // Try ANE pre-filter first (zero-cost NPU inference)
  if (classifierAne) {
    try {
      const aneResult = await classifierAne.classify(message);
      if (aneResult.source === 'ane' && aneResult.confidence >= ANE_SKIP_THRESHOLD) {
        const taskClass = mapAneCategory(aneResult.category as TaskCategory);
        safeLogger.info('ANE pre-filter classified message', {
          aneCategory: aneResult.category,
          mappedClass: taskClass,
          confidence: aneResult.confidence,
        });
        return {
          taskClass,
          confidence: aneResult.confidence,
          reason: `ANE pre-filter: ${aneResult.category} (confidence ${aneResult.confidence.toFixed(2)})`,
          taskType: aneResult.category,
        };
      }
      // ANE not confident enough or used fallback — proceed to LLM
    } catch {
      // ANE failed, proceed to LLM classification
    }
  }
  const context = buildClassifierContext(message, recentHistory);

  try {
    const response = await provider.generateWithTools(
      {
        prompt: context,
        systemPrompt: CLASSIFIER_SYSTEM_PROMPT,
        maxTokens: PROFILES.classifier.generation.maxTokens,
        temperature: PROFILES.classifier.generation.temperature,
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
