/**
 * Model Profile Types
 *
 * Config-driven per-model settings for tool calling optimization,
 * system prompt hints, and generation parameters.
 */

/**
 * Tool description override for a specific model.
 */
export interface ToolDescriptionOverride {
  /** Tool name to override */
  toolName: string;
  /** Replace the description entirely */
  description?: string | undefined;
  /** Append this text to the existing description */
  descriptionSuffix?: string | undefined;
}

/**
 * Response parsing hint for cleaning up model-specific quirks.
 */
export interface ResponseParsingHint {
  /** Regex pattern to match in the response */
  pattern: string;
  /** Replacement string (empty string to strip) */
  replacement: string;
  /** Human-readable description of what this cleans up */
  reason: string;
}

/**
 * Generation parameters that override defaults.
 * Only set fields override.
 */
export interface ModelGenerationParams {
  temperature?: number | undefined;
  numPredict?: number | undefined;
  /** Ollama-specific options (num_ctx, repeat_penalty, etc.) */
  ollamaOptions?: Record<string, unknown> | undefined;
}

/**
 * A model profile defines per-model tuning.
 *
 * Loaded from config/model-profiles.yaml or constructed programmatically.
 * Applied as a layer on top of the existing tool/prompt pipeline.
 */
export interface ModelProfile {
  /** Model identifier (e.g., 'qwen3.5:122b') */
  modelId: string;
  /** Human-readable display name */
  displayName: string;
  /** Text appended to the system prompt when this model is active */
  systemPromptHint?: string | undefined;
  /** Per-tool description overrides or enrichments */
  toolOverrides?: ToolDescriptionOverride[] | undefined;
  /** Generation parameter overrides */
  generation?: ModelGenerationParams | undefined;
  /** Response parsing hints for known model quirks */
  responseHints?: ResponseParsingHint[] | undefined;
  /** Model family tag for grouping (e.g., 'qwen3.5', 'hermes', 'qwen') */
  family?: string | undefined;
  /** Free-form metadata (set by scraper, benchmark results, etc.) */
  metadata?: Record<string, unknown> | undefined;
}

/**
 * The default profile used for unknown models.
 * Applies no overrides — passes everything through unchanged.
 */
export const DEFAULT_PROFILE: ModelProfile = {
  modelId: 'default',
  displayName: 'Default Profile',
};
