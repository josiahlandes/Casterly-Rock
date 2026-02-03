import type { GenerateRequest, LlmProvider } from './base.js';
import { ProviderError, BillingError } from './base.js';
import type {
  ToolSchema,
  ToolResultMessage,
  GenerateWithToolsResponse,
  NativeToolCall,
} from '../tools/schemas/types.js';

export interface ClaudeProviderOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  timeoutMs?: number;
}

/**
 * Claude tool definition format
 */
interface ClaudeToolDefinition {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, unknown>;
    required: string[];
  };
}

/**
 * Claude content block types
 */
interface ClaudeTextBlock {
  type: 'text';
  text: string;
}

interface ClaudeToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

interface ClaudeToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
  is_error?: boolean | undefined;
}

type ClaudeContentBlock = ClaudeTextBlock | ClaudeToolUseBlock | ClaudeToolResultBlock;

/**
 * Claude message format
 */
interface ClaudeMessage {
  role: 'user' | 'assistant';
  content: string | ClaudeContentBlock[];
}

/**
 * Claude API request format
 */
interface ClaudeMessagesRequest {
  model: string;
  max_tokens: number;
  system?: string | undefined;
  messages: ClaudeMessage[];
  tools?: ClaudeToolDefinition[] | undefined;
  temperature?: number | undefined;
}

/**
 * Claude API response format
 */
interface ClaudeMessagesResponse {
  id: string;
  type: 'message';
  role: 'assistant';
  content: ClaudeContentBlock[];
  stop_reason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence';
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
}

/**
 * Claude error response format
 */
interface ClaudeErrorResponse {
  type: 'error';
  error: {
    type: string;
    message: string;
  };
}

/**
 * Convert our ToolSchema to Claude's tool format
 */
function formatToolsForClaude(tools: ToolSchema[]): ClaudeToolDefinition[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
  }));
}

/**
 * Parse tool calls from Claude response content
 */
function parseToolCalls(content: ClaudeContentBlock[]): NativeToolCall[] {
  return content
    .filter((block): block is ClaudeToolUseBlock => block.type === 'tool_use')
    .map((block) => ({
      id: block.id,
      name: block.name,
      input: block.input,
    }));
}

/**
 * Extract text from Claude response content
 */
function extractText(content: ClaudeContentBlock[]): string {
  return content
    .filter((block): block is ClaudeTextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('');
}

/**
 * Map Claude stop reason to our format
 */
function mapStopReason(
  stopReason: ClaudeMessagesResponse['stop_reason']
): GenerateWithToolsResponse['stopReason'] {
  switch (stopReason) {
    case 'tool_use':
      return 'tool_use';
    case 'max_tokens':
      return 'max_tokens';
    case 'stop_sequence':
      return 'stop_sequence';
    case 'end_turn':
    default:
      return 'end_turn';
  }
}

export class ClaudeProvider implements LlmProvider {
  readonly id = 'claude';
  readonly kind = 'cloud' as const;
  readonly model: string;

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(options: ClaudeProviderOptions) {
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.baseUrl = options.baseUrl ?? 'https://api.anthropic.com';
    this.timeoutMs = options.timeoutMs ?? 45_000;
  }

  async generateWithTools(
    request: GenerateRequest,
    tools: ToolSchema[],
    previousResults?: ToolResultMessage[]
  ): Promise<GenerateWithToolsResponse> {
    if (!this.apiKey) {
      throw new ProviderError('Claude provider requires an API key');
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      // Build messages array
      const messages: ClaudeMessage[] = [];

      // Add user message with the prompt
      messages.push({
        role: 'user',
        content: request.prompt,
      });

      // If we have previous tool results, add them as a conversation
      if (previousResults && previousResults.length > 0) {
        // Add assistant message with tool_use blocks (simulated)
        // In a real multi-turn, we'd have the actual tool_use blocks
        // For now, we add tool results directly

        // Add tool results as user message with tool_result blocks
        const toolResultBlocks: ClaudeToolResultBlock[] = previousResults.map((result) => ({
          type: 'tool_result' as const,
          tool_use_id: result.callId,
          content: result.result,
          is_error: result.isError,
        }));

        messages.push({
          role: 'user',
          content: toolResultBlocks,
        });
      }

      const requestBody: ClaudeMessagesRequest = {
        model: this.model,
        max_tokens: request.maxTokens ?? 2048,
        system: request.systemPrompt,
        messages,
        tools: tools.length > 0 ? formatToolsForClaude(tools) : undefined,
        temperature: request.temperature ?? 0.7,
      };

      const response = await fetch(`${this.baseUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });

      if (!response.ok) {
        // Try to parse error response for billing/credit issues
        try {
          const errorData = (await response.json()) as ClaudeErrorResponse;
          if (errorData.error?.message?.includes('credit balance')) {
            throw new BillingError('Anthropic API credits exhausted');
          }
          if (errorData.error?.message?.includes('rate limit')) {
            throw new BillingError('Anthropic API rate limited');
          }
          throw new ProviderError(
            `Claude request failed: ${errorData.error?.message ?? response.status}`
          );
        } catch (parseError) {
          if (parseError instanceof ProviderError || parseError instanceof BillingError) {
            throw parseError;
          }
          throw new ProviderError(`Claude request failed with status ${response.status}`);
        }
      }

      const data = (await response.json()) as ClaudeMessagesResponse;

      const text = extractText(data.content);
      const toolCalls = parseToolCalls(data.content);
      const stopReason = mapStopReason(data.stop_reason);

      return {
        text,
        toolCalls,
        providerId: this.id,
        model: this.model,
        stopReason,
      };
    } catch (error) {
      if (error instanceof ProviderError || error instanceof BillingError) {
        throw error;
      }

      if (error instanceof Error && error.name === 'AbortError') {
        throw new ProviderError(`Claude request timed out after ${this.timeoutMs}ms`);
      }

      throw new ProviderError('Claude provider failed', error);
    } finally {
      clearTimeout(timeout);
    }
  }
}
