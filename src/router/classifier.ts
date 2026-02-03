import type { LlmProvider } from '../providers/base.js';
import { safeLogger } from '../logging/safe-logger.js';
import { ROUTE_DECISION_TOOL } from '../tools/schemas/core.js';
import type { SensitiveCategory } from './patterns.js';

export type RouteTarget = 'local' | 'cloud';

export interface RouteDecision {
  route: RouteTarget;
  reason: string;
  confidence: number;
  sensitiveCategories: SensitiveCategory[];
}

export interface RouteClassifierContext {
  defaultRoute: RouteTarget;
  confidenceThreshold: number;
  alwaysLocalCategories: SensitiveCategory[];
}

export interface RouteClassifierDependencies {
  localProvider: LlmProvider;
}

/**
 * System prompt for the router - instructs model to use the route_decision tool
 */
export const ROUTER_PROMPT = `You are a privacy-aware router. Analyze the user's request and call the route_decision tool with your decision.

ROUTE TO LOCAL (default - use for most messages):
- Greetings: "hi", "hello", "hey", "what's up", "good morning", etc.
- Simple questions and short messages
- Personal calendar, schedule, appointments
- Financial data (bank, budget, transactions, SSN)
- Voice memos, personal notes, journals
- Health/medical information
- Passwords, credentials, API keys, tokens
- Private documents, contracts
- Personal relationships, contacts
- Location data, addresses
- Anything the user wouldn't want a company to see
- Casual conversation and chitchat

ROUTE TO CLOUD (ONLY for complex tasks that explicitly need it):
- Coding tasks: writing, debugging, reviewing, explaining CODE (not just mentioning "code")
- Complex multi-step reasoning or analysis
- Technical explanations or detailed tutorials
- Long-form creative writing
- In-depth research on public topics

DEFAULT TO LOCAL. Only route to cloud if the message CLEARLY requires advanced capabilities.

You MUST call the route_decision tool with your decision.`;

function isValidRouteTarget(value: unknown): value is RouteTarget {
  return value === 'local' || value === 'cloud';
}

function isValidConfidence(value: unknown): value is number {
  return typeof value === 'number' && value >= 0 && value <= 1 && !Number.isNaN(value);
}

function createFallbackDecision(
  context: RouteClassifierContext,
  sensitiveCategories: SensitiveCategory[],
  reason: string
): RouteDecision {
  return {
    route: context.defaultRoute,
    reason,
    confidence: Math.max(0.51, context.confidenceThreshold - 0.1),
    sensitiveCategories,
  };
}

export async function classifyRoute(
  text: string,
  deps: RouteClassifierDependencies,
  context: RouteClassifierContext,
  sensitiveCategories: SensitiveCategory[]
): Promise<RouteDecision> {
  // If sensitive categories match always-local, route locally immediately
  if (sensitiveCategories.some((category) => context.alwaysLocalCategories.includes(category))) {
    return {
      route: 'local',
      reason: 'Matched always-local sensitive category',
      confidence: 1,
      sensitiveCategories,
    };
  }

  // Use local LLM for routing decision via native tool use
  try {
    const result = await deps.localProvider.generateWithTools(
      {
        systemPrompt: ROUTER_PROMPT,
        prompt: text,
        temperature: 0.1,
        maxTokens: 150,
      },
      [ROUTE_DECISION_TOOL]
    );

    // Log the response for debugging
    safeLogger.info('Router LLM response', {
      toolCalls: result.toolCalls.length,
      stopReason: result.stopReason,
    });

    // Check if model called the route_decision tool
    if (result.toolCalls.length === 0) {
      safeLogger.warn('Router: model did not call route_decision tool');
      return createFallbackDecision(
        context,
        sensitiveCategories,
        'Model did not provide routing decision via tool call'
      );
    }

    // Get the first tool call (should be route_decision)
    const toolCall = result.toolCalls[0];
    if (!toolCall) {
      safeLogger.warn('Router: no tool call found in response');
      return createFallbackDecision(
        context,
        sensitiveCategories,
        'No tool call found in response'
      );
    }

    if (toolCall.name !== 'route_decision') {
      safeLogger.warn('Router: model called unexpected tool', { toolName: toolCall.name });
      return createFallbackDecision(
        context,
        sensitiveCategories,
        `Model called unexpected tool: ${toolCall.name}`
      );
    }

    // Extract decision from tool call input
    const input = toolCall.input as {
      route?: unknown;
      reason?: unknown;
      confidence?: unknown;
    };

    // Validate route
    if (!isValidRouteTarget(input.route)) {
      safeLogger.warn('Router: invalid route in tool call', { route: input.route });
      return createFallbackDecision(
        context,
        sensitiveCategories,
        'Invalid route value in tool call'
      );
    }

    // Validate reason
    const reason = typeof input.reason === 'string' && input.reason.trim() !== ''
      ? input.reason
      : 'No reason provided';

    // Validate confidence
    const confidence = isValidConfidence(input.confidence)
      ? input.confidence
      : 0.7; // Default confidence

    // Enforce local bias when confidence is below threshold
    if (input.route === 'cloud' && confidence < context.confidenceThreshold) {
      safeLogger.info('Router: cloud decision below threshold, routing locally', {
        confidence,
        threshold: context.confidenceThreshold,
      });
      return {
        route: 'local',
        reason: `LLM suggested cloud but confidence ${confidence.toFixed(2)} below threshold; routing locally`,
        confidence,
        sensitiveCategories,
      };
    }

    // Log the routing decision with reasoning
    safeLogger.info('Router decision', {
      route: input.route,
      reason,
      confidence,
    });

    return {
      route: input.route,
      reason,
      confidence,
      sensitiveCategories,
    };
  } catch (error) {
    safeLogger.warn('Local LLM call failed for routing; falling back to default route', {
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    return createFallbackDecision(
      context,
      sensitiveCategories,
      'LLM routing failed; fell back to default routing policy'
    );
  }
}
