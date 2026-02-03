import type { GenerateRequest, LlmProvider } from './base.js';
import { ProviderError } from './base.js';
import type {
  ToolSchema,
  ToolResultMessage,
  GenerateWithToolsResponse,
  NativeToolCall,
} from '../tools/schemas/types.js';
import type { OllamaTool } from '../tools/schemas/registry.js';

export interface OllamaProviderOptions {
  baseUrl: string;
  model: string;
  timeoutMs?: number;
}

/**
 * Ollama chat message format
 */
interface OllamaChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: OllamaToolCall[];
  tool_call_id?: string;
}

/**
 * Ollama tool call format (OpenAI-compatible)
 */
interface OllamaToolCall {
  id?: string;
  type: 'function';
  function: {
    name: string;
    arguments: string; // JSON string
  };
}

/**
 * Ollama chat request format
 */
interface OllamaChatRequest {
  model: string;
  messages: OllamaChatMessage[];
  tools?: OllamaTool[] | undefined;
  stream: false;
  options?: {
    temperature?: number;
    num_predict?: number;
  } | undefined;
}

/**
 * Ollama chat response format
 */
interface OllamaChatResponse {
  message?: {
    role: 'assistant';
    content: string;
    tool_calls?: OllamaToolCall[];
  };
  done: boolean;
  done_reason?: 'stop' | 'length' | 'tool_calls';
  error?: string;
}

/**
 * Generate a unique tool call ID
 */
function generateToolCallId(): string {
  return `call_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * Convert our ToolSchema to Ollama's tool format
 */
function formatToolsForOllama(tools: ToolSchema[]): OllamaTool[] {
  return tools.map((tool) => ({
    type: 'function' as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  }));
}

/**
 * Parse tool calls from Ollama response
 */
function parseToolCalls(toolCalls: OllamaToolCall[] | undefined): NativeToolCall[] {
  if (!toolCalls || toolCalls.length === 0) {
    return [];
  }

  return toolCalls.map((tc) => {
    let input: Record<string, unknown> = {};
    try {
      input = JSON.parse(tc.function.arguments);
    } catch {
      // If arguments aren't valid JSON, use as-is
      input = { raw: tc.function.arguments };
    }

    return {
      id: tc.id ?? generateToolCallId(),
      name: tc.function.name,
      input,
    };
  });
}

/**
 * Determine stop reason from Ollama response
 */
function getStopReason(response: OllamaChatResponse): GenerateWithToolsResponse['stopReason'] {
  if (response.message?.tool_calls && response.message.tool_calls.length > 0) {
    return 'tool_use';
  }
  if (response.done_reason === 'length') {
    return 'max_tokens';
  }
  return 'end_turn';
}

export class OllamaProvider implements LlmProvider {
  readonly id = 'ollama';
  readonly kind = 'local' as const;
  readonly model: string;

  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(options: OllamaProviderOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.model = options.model;
    this.timeoutMs = options.timeoutMs ?? 60_000;
  }

  async generateWithTools(
    request: GenerateRequest,
    tools: ToolSchema[],
    previousResults?: ToolResultMessage[]
  ): Promise<GenerateWithToolsResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      // Build messages array
      const messages: OllamaChatMessage[] = [];

      // System message
      if (request.systemPrompt) {
        messages.push({
          role: 'system',
          content: request.systemPrompt,
        });
      }

      // If we have previous tool results, we need to reconstruct the conversation
      if (previousResults && previousResults.length > 0) {
        // The prompt contains the conversation context
        // Add user message
        messages.push({
          role: 'user',
          content: request.prompt,
        });

        // Add tool results as tool messages
        for (const result of previousResults) {
          messages.push({
            role: 'tool',
            content: result.result,
            tool_call_id: result.callId,
          });
        }
      } else {
        // Simple case: just the user message
        messages.push({
          role: 'user',
          content: request.prompt,
        });
      }

      const chatRequest: OllamaChatRequest = {
        model: this.model,
        messages,
        tools: tools.length > 0 ? formatToolsForOllama(tools) : undefined,
        stream: false,
        options: {
          temperature: request.temperature ?? 0.7,
          num_predict: request.maxTokens ?? 2048,
        },
      };

      const response = await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(chatRequest),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => 'Unknown error');
        throw new ProviderError(
          `Ollama request failed with status ${response.status}: ${errorText}`
        );
      }

      const data = (await response.json()) as OllamaChatResponse;

      if (data.error) {
        throw new ProviderError(`Ollama error: ${data.error}`);
      }

      const toolCalls = parseToolCalls(data.message?.tool_calls);
      const stopReason = getStopReason(data);

      return {
        text: data.message?.content ?? '',
        toolCalls,
        providerId: this.id,
        model: this.model,
        stopReason,
      };
    } catch (error) {
      if (error instanceof ProviderError) {
        throw error;
      }

      if (error instanceof Error && error.name === 'AbortError') {
        throw new ProviderError(`Ollama request timed out after ${this.timeoutMs}ms`);
      }

      throw new ProviderError('Ollama provider failed', error);
    } finally {
      clearTimeout(timeout);
    }
  }
}
