import type {
  ToolSchema,
  ToolResultMessage,
  GenerateWithToolsResponse,
} from '../tools/schemas/types.js';

export type { GenerateWithToolsResponse } from '../tools/schemas/types.js';

export type ProviderKind = 'local' | 'cloud';

/**
 * Request parameters for LLM generation
 */
export interface GenerateRequest {
  /** The user message / prompt */
  prompt: string;

  /** System prompt for context and instructions */
  systemPrompt?: string;

  /** Maximum tokens to generate */
  maxTokens?: number;

  /** Temperature for response randomness (0.0-1.0) */
  temperature?: number;
}

/**
 * LLM Provider interface
 *
 * All providers must implement generateWithTools() for native tool use.
 */
export interface LlmProvider {
  /** Unique provider identifier */
  id: string;

  /** Whether this is a local or cloud provider */
  kind: ProviderKind;

  /** Model identifier */
  model: string;

  /**
   * Generate a response with tool use support
   *
   * @param request - The generation request (prompt, system prompt, etc.)
   * @param tools - Available tools the model can call
   * @param previousResults - Results from previous tool calls (for multi-turn)
   * @returns Response with text and/or tool calls
   */
  generateWithTools(
    request: GenerateRequest,
    tools: ToolSchema[],
    previousResults?: ToolResultMessage[]
  ): Promise<GenerateWithToolsResponse>;
}

/**
 * Generic provider error
 */
export class ProviderError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'ProviderError';
  }
}

/**
 * Thrown when the cloud provider has billing/credit issues
 * The caller should fall back to local provider
 */
export class BillingError extends ProviderError {
  constructor(message: string) {
    super(message);
    this.name = 'BillingError';
  }
}
