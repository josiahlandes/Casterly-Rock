/**
 * Model Profile Enrichment
 *
 * Pure functions that apply a ModelProfile to system prompts,
 * tool schemas, and responses. No side effects, no mutations.
 */

import type { ToolSchema } from '../tools/schemas/types.js';
import type { ModelProfile } from './types.js';

/**
 * Enrich a system prompt with model-specific hints.
 * Appends the profile's systemPromptHint as a new section.
 *
 * Returns the original prompt unchanged if the profile has no hint.
 */
export function enrichSystemPrompt(
  systemPrompt: string,
  profile: ModelProfile,
): string {
  if (!profile.systemPromptHint) {
    return systemPrompt;
  }

  return `${systemPrompt}\n\n## Model-Specific Instructions\n\n${profile.systemPromptHint}`;
}

/**
 * Enrich tool schemas with model-specific overrides.
 * Returns a new ToolSchema[] — does NOT mutate the originals.
 *
 * For each tool override in the profile:
 * - If `description` is set, replaces the tool's description entirely.
 * - If `descriptionSuffix` is set, appends it to the existing description.
 * - Tools not mentioned in overrides pass through unchanged.
 */
export function enrichToolDescriptions(
  tools: ToolSchema[],
  profile: ModelProfile,
): ToolSchema[] {
  if (!profile.toolOverrides || profile.toolOverrides.length === 0) {
    return tools;
  }

  const overrideMap = new Map(
    profile.toolOverrides.map((o) => [o.toolName, o]),
  );

  return tools.map((tool) => {
    const override = overrideMap.get(tool.name);
    if (!override) {
      return tool;
    }

    let description = tool.description;

    if (override.description !== undefined) {
      description = override.description;
    } else if (override.descriptionSuffix !== undefined) {
      description = `${tool.description}${override.descriptionSuffix}`;
    }

    return {
      ...tool,
      description,
    };
  });
}

/**
 * Apply response parsing hints to clean up model-specific quirks.
 * Returns the cleaned response text.
 *
 * Returns the response unchanged if the profile has no hints.
 */
export function applyResponseHints(
  responseText: string,
  profile: ModelProfile,
): string {
  if (!profile.responseHints || profile.responseHints.length === 0) {
    return responseText;
  }

  let cleaned = responseText;
  for (const hint of profile.responseHints) {
    const regex = new RegExp(hint.pattern, 'g');
    cleaned = cleaned.replace(regex, hint.replacement);
  }

  return cleaned;
}

/**
 * Get generation parameter overrides from a profile.
 * Returns an object with only the fields the profile explicitly sets.
 */
export function getGenerationOverrides(
  profile: ModelProfile,
): Record<string, unknown> {
  if (!profile.generation) {
    return {};
  }

  const overrides: Record<string, unknown> = {};

  if (profile.generation.temperature !== undefined) {
    overrides.temperature = profile.generation.temperature;
  }
  if (profile.generation.numPredict !== undefined) {
    overrides.num_predict = profile.generation.numPredict;
  }
  if (profile.generation.ollamaOptions) {
    Object.assign(overrides, profile.generation.ollamaOptions);
  }

  return overrides;
}
