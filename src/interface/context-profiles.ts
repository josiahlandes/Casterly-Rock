/**
 * Context Profiles (ISSUE-006)
 *
 * Scoped context profiles for each pipeline stage.
 * Each profile declares what the stage needs: token budget,
 * which prompt sections to include, how much history, and
 * LLM generation parameters.
 *
 * This is additive — the existing assembleContext() remains
 * unchanged as the conversation fallback path. Profiles formalize
 * the token budgets that pipeline stages already use inline.
 */

import { estimateTokens } from './context.js';
import { buildSystemPrompt, type PromptBuilderOptions } from './prompt-builder.js';
import { safeLogger } from '../logging/safe-logger.js';

// ─── Types ──────────────────────────────────────────────────────────────────

/** The five profile names, matching pipeline stages + conversation fallback */
export type ContextProfileName =
  | 'conversation'
  | 'classifier'
  | 'planner'
  | 'executor'
  | 'verifier';

/** Which sections of the system prompt to include */
export interface PromptSections {
  identity: boolean;
  bootstrap: boolean;
  capabilities: boolean;
  skills: boolean;
  memory: boolean;
  safety: boolean;
  context: boolean;
  guidelines: boolean;
}

/** LLM generation parameters bundled with the profile */
export interface GenerationParams {
  maxTokens: number;
  temperature: number;
}

/** A context profile definition */
export interface ContextProfile {
  /** Profile name for logging and debugging */
  name: ContextProfileName;
  /** Maximum total tokens for the assembled context (prompt + history) */
  maxContextTokens: number;
  /** Tokens reserved for the LLM response */
  reserveForResponse: number;
  /** Maximum history messages to include (0 = no history) */
  maxHistoryMessages: number;
  /** Which system prompt sections to include */
  promptSections: PromptSections;
  /** LLM generation parameters for this stage */
  generation: GenerationParams;
  /** Custom system prompt override (bypasses prompt-builder entirely) */
  systemPromptOverride?: string | undefined;
}

/** Dependency output from an upstream step (for executor profile) */
export interface DependencyContext {
  /** Step ID this output came from */
  stepId: string;
  /** Tool that produced this output */
  tool: string;
  /** The output content (may be truncated) */
  output: string;
}

/** Options for assembling context with a profile */
export interface ProfileContextOptions {
  /** The profile to use */
  profile: ContextProfile;
  /** The primary prompt/message for this stage */
  prompt: string;
  /** Additional context lines (tool lists, criteria, etc.) */
  additionalContext?: string[] | undefined;
  /** Dependency outputs from upstream steps (executor profile) */
  dependencies?: DependencyContext[] | undefined;
  /** Conversation history (only used if profile.maxHistoryMessages > 0) */
  history?: string[] | undefined;
}

/** Result of profile-based context assembly */
export interface ProfileAssembledContext {
  /** The system prompt for the LLM call */
  systemPrompt: string;
  /** The user prompt for the LLM call */
  prompt: string;
  /** Estimated total tokens */
  estimatedTokens: number;
  /** The generation params from the profile */
  generation: GenerationParams;
  /** Profile name used (for logging) */
  profileName: ContextProfileName;
}

// ─── Profile Definitions ────────────────────────────────────────────────────

/** All prompt sections enabled */
const ALL_SECTIONS: PromptSections = {
  identity: true,
  bootstrap: true,
  capabilities: true,
  skills: true,
  memory: true,
  safety: true,
  context: true,
  guidelines: true,
};

/** No prompt sections enabled */
const NO_SECTIONS: PromptSections = {
  identity: false,
  bootstrap: false,
  capabilities: false,
  skills: false,
  memory: false,
  safety: false,
  context: false,
  guidelines: false,
};

/** Only safety section enabled */
const SAFETY_ONLY: PromptSections = {
  ...NO_SECTIONS,
  safety: true,
};

/**
 * Pre-defined context profiles.
 * Centralizes token budgets and prompt requirements for each pipeline stage.
 */
export const PROFILES: Record<ContextProfileName, ContextProfile> = {
  conversation: {
    name: 'conversation',
    maxContextTokens: 3500,
    reserveForResponse: 500,
    maxHistoryMessages: 10,
    promptSections: ALL_SECTIONS,
    generation: { maxTokens: 2048, temperature: 0.7 },
  },

  classifier: {
    name: 'classifier',
    maxContextTokens: 1024,
    reserveForResponse: 256,
    maxHistoryMessages: 3,
    promptSections: NO_SECTIONS,
    generation: { maxTokens: 256, temperature: 0.1 },
  },

  planner: {
    name: 'planner',
    maxContextTokens: 2048,
    reserveForResponse: 2048,
    maxHistoryMessages: 0,
    promptSections: SAFETY_ONLY,
    generation: { maxTokens: 2048, temperature: 0.2 },
  },

  executor: {
    name: 'executor',
    maxContextTokens: 1536,
    reserveForResponse: 512,
    maxHistoryMessages: 0,
    promptSections: SAFETY_ONLY,
    generation: { maxTokens: 512, temperature: 0.1 },
  },

  verifier: {
    name: 'verifier',
    maxContextTokens: 1536,
    reserveForResponse: 512,
    maxHistoryMessages: 0,
    promptSections: NO_SECTIONS,
    generation: { maxTokens: 512, temperature: 0.1 },
  },
};

// ─── Assembly Functions ─────────────────────────────────────────────────────

/**
 * Build a system prompt filtered by profile sections.
 * Wraps buildSystemPrompt() but only includes sections the profile requests.
 *
 * If the profile has a systemPromptOverride, returns it directly.
 */
export function buildProfileSystemPrompt(
  profile: ContextProfile,
  promptOptions: PromptBuilderOptions
): string {
  if (profile.systemPromptOverride) {
    return profile.systemPromptOverride;
  }

  // If no sections are requested, return empty
  const ps = profile.promptSections;
  const anySectionEnabled =
    ps.identity || ps.bootstrap || ps.capabilities || ps.skills ||
    ps.memory || ps.safety || ps.context || ps.guidelines;

  if (!anySectionEnabled) {
    return '';
  }

  const built = buildSystemPrompt(promptOptions);

  const sections: string[] = [];
  if (ps.bootstrap && built.sections.bootstrap) sections.push(built.sections.bootstrap);
  if (ps.capabilities && built.sections.capabilities) sections.push(built.sections.capabilities);
  if (ps.skills && built.sections.skills) sections.push(built.sections.skills);
  if (ps.memory && built.sections.memory) sections.push(built.sections.memory);
  if (ps.safety && built.sections.safety) sections.push(built.sections.safety);
  if (ps.context && built.sections.context) sections.push(built.sections.context);
  if (ps.guidelines && built.sections.guidelines) sections.push(built.sections.guidelines);

  return sections.filter(Boolean).join('\n\n');
}

/**
 * Format dependency outputs for injection into executor context.
 * Truncates each output to stay within the token budget.
 */
export function formatDependencyOutputs(
  dependencies: DependencyContext[],
  maxTokens: number
): string {
  if (dependencies.length === 0) {
    return '';
  }

  const validDeps = dependencies.filter((d) => d.output);
  if (validDeps.length === 0) {
    return '';
  }

  // Budget per dependency (leaving room for headers)
  const headerOverhead = 50; // chars for "## Upstream Results\n" + per-dep headers
  const perDepBudget = Math.max(
    100,
    Math.floor(((maxTokens * 4) - headerOverhead) / validDeps.length)
  );

  const parts: string[] = ['## Upstream Results'];

  for (const dep of validDeps) {
    const truncated =
      dep.output.length > perDepBudget
        ? dep.output.substring(0, perDepBudget) + '... [truncated]'
        : dep.output;

    parts.push(`### ${dep.stepId} (${dep.tool})\n${truncated}`);
  }

  return parts.join('\n\n');
}

/**
 * Assemble context for a pipeline stage using its profile.
 *
 * Respects the profile's token budget, prompt section selection,
 * and history depth. For stages with systemPromptOverride,
 * the custom prompt is used directly.
 */
export function assembleProfileContext(
  options: ProfileContextOptions
): ProfileAssembledContext {
  const { profile, prompt, additionalContext, dependencies, history } = options;

  // Build the system prompt based on profile
  let systemPrompt = '';
  if (profile.systemPromptOverride) {
    systemPrompt = profile.systemPromptOverride;
  }
  // If no override and sections are requested, the caller should use
  // buildProfileSystemPrompt() separately and pass it as systemPromptOverride.
  // This keeps assembleProfileContext() independent of PromptBuilderOptions.

  // Build the user prompt
  const promptParts: string[] = [];

  // Add trimmed history if the profile allows it
  if (history && history.length > 0 && profile.maxHistoryMessages > 0) {
    const trimmed = history.slice(-profile.maxHistoryMessages);
    promptParts.push('Recent conversation:\n' + trimmed.join('\n'));
  }

  // Add dependency outputs for executor-style profiles
  if (dependencies && dependencies.length > 0) {
    const depBudget = Math.floor(profile.maxContextTokens * 0.4); // 40% of budget for deps
    const formatted = formatDependencyOutputs(dependencies, depBudget);
    if (formatted) {
      promptParts.push(formatted);
    }
  }

  // Add additional context lines
  if (additionalContext && additionalContext.length > 0) {
    promptParts.push(additionalContext.join('\n'));
  }

  // Add the primary prompt
  promptParts.push(prompt);

  const assembledPrompt = promptParts.join('\n\n');

  // Estimate tokens
  const totalTokens = estimateTokens(systemPrompt) + estimateTokens(assembledPrompt);
  const budget = profile.maxContextTokens - profile.reserveForResponse;

  if (totalTokens > budget) {
    safeLogger.warn('Profile context exceeds token budget', {
      profile: profile.name,
      estimatedTokens: totalTokens,
      budget,
      overflow: totalTokens - budget,
    });
  }

  return {
    systemPrompt,
    prompt: assembledPrompt,
    estimatedTokens: totalTokens,
    generation: profile.generation,
    profileName: profile.name,
  };
}
