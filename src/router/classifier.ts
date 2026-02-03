import type { LlmProvider } from '../providers/base.js';
import { safeLogger } from '../logging/safe-logger.js';
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

export const ROUTER_PROMPT = `You are a privacy-aware router. Analyze this request and decide:

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

Respond with ONLY valid JSON (no markdown, no explanation):
{"route": "local" or "cloud", "reason": "brief explanation", "confidence": 0.0-1.0}`;

interface LlmRouteResponse {
  route: unknown;
  reason: unknown;
  confidence: unknown;
}

function extractJson(text: string): string | null {
  const trimmed = text.trim();

  // Try direct parse first
  if (trimmed.startsWith('{')) {
    const endBrace = trimmed.lastIndexOf('}');
    if (endBrace !== -1) {
      return trimmed.slice(0, endBrace + 1);
    }
  }

  // Try to extract JSON from markdown code blocks
  const codeBlockMatch = /```(?:json)?\s*(\{[\s\S]*?\})\s*```/.exec(trimmed);
  if (codeBlockMatch?.[1]) {
    return codeBlockMatch[1];
  }

  // Try to find JSON object anywhere in the text
  const jsonMatch = /\{[^{}]*"route"[^{}]*\}/.exec(trimmed);
  if (jsonMatch) {
    return jsonMatch[0];
  }

  return null;
}

function isValidRouteTarget(value: unknown): value is RouteTarget {
  return value === 'local' || value === 'cloud';
}

function isValidConfidence(value: unknown): value is number {
  return typeof value === 'number' && value >= 0 && value <= 1 && !Number.isNaN(value);
}

function parseRouteResponse(
  text: string,
  context: RouteClassifierContext
): { route: RouteTarget; reason: string; confidence: number } | null {
  const jsonString = extractJson(text);
  if (!jsonString) {
    safeLogger.warn('Failed to extract JSON from LLM response');
    return null;
  }

  let parsed: LlmRouteResponse;
  try {
    parsed = JSON.parse(jsonString) as LlmRouteResponse;
  } catch {
    safeLogger.warn('Failed to parse JSON from LLM response');
    return null;
  }

  // Validate required fields
  if (!isValidRouteTarget(parsed.route)) {
    safeLogger.warn('Invalid or missing route field in LLM response');
    return null;
  }

  if (typeof parsed.reason !== 'string' || parsed.reason.trim() === '') {
    safeLogger.warn('Invalid or missing reason field in LLM response');
    return null;
  }

  if (!isValidConfidence(parsed.confidence)) {
    safeLogger.warn('Invalid or missing confidence field in LLM response');
    return null;
  }

  // Enforce local bias when confidence is below threshold
  if (parsed.route === 'cloud' && parsed.confidence < context.confidenceThreshold) {
    return {
      route: 'local',
      reason: `LLM suggested cloud but confidence ${parsed.confidence.toFixed(2)} below threshold; routing locally`,
      confidence: parsed.confidence
    };
  }

  return {
    route: parsed.route,
    reason: parsed.reason,
    confidence: parsed.confidence
  };
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
    sensitiveCategories
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
      sensitiveCategories
    };
  }

  // Use local LLM for routing decision
  let llmResponse: string;
  try {
    const result = await deps.localProvider.generate({
      systemPrompt: ROUTER_PROMPT,
      prompt: text,
      temperature: 0.1,
      maxTokens: 150
    });
    llmResponse = result.text;

    // Log the raw LLM routing response for debugging
    safeLogger.info('Router LLM response', {
      rawResponse: llmResponse.substring(0, 200),
    });
  } catch (error) {
    safeLogger.warn('Local LLM call failed for routing; falling back to default route', {
      error: error instanceof Error ? error.message : 'Unknown error'
    });
    return createFallbackDecision(
      context,
      sensitiveCategories,
      'LLM routing failed; fell back to default routing policy'
    );
  }

  // Parse and validate the LLM response
  const parsed = parseRouteResponse(llmResponse, context);
  if (!parsed) {
    safeLogger.warn('Router failed to parse LLM response', {
      rawResponse: llmResponse.substring(0, 200),
    });
    return createFallbackDecision(
      context,
      sensitiveCategories,
      'Invalid LLM response; fell back to default routing policy'
    );
  }

  // Log the routing decision with reasoning
  safeLogger.info('Router decision', {
    route: parsed.route,
    reason: parsed.reason,
    confidence: parsed.confidence,
  });

  return {
    route: parsed.route,
    reason: parsed.reason,
    confidence: parsed.confidence,
    sensitiveCategories
  };
}

// Exported for testing
export { extractJson, parseRouteResponse };
