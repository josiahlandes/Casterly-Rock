import type { GenerateRequest, LlmProvider } from './base.js';
import { ProviderError } from './base.js';
import type {
  ToolSchema,
  ToolResultMessage,
  GenerateWithToolsResponse,
  NativeToolCall,
} from '../tools/schemas/types.js';
import type { OllamaTool } from '../tools/schemas/registry.js';

interface OllamaProviderOptions {
  baseUrl: string;
  model: string;
  timeoutMs?: number;
  /** Default num_ctx for all requests. If not set, Ollama uses its built-in default (2048). */
  numCtx?: number;
  /** keep_alive duration for Ollama. -1 = never unload. Default: -1 */
  keepAlive?: number | string;
  /** Enable/disable thinking for thinking models. Default: undefined (model decides). */
  think?: boolean;
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
 * Ollama tool call format (OpenAI-compatible).
 *
 * NOTE: Despite the OpenAI spec typing `arguments` as a JSON string,
 * Ollama actually returns (and expects) a parsed object. We type it
 * as `unknown` and normalise in parseToolCalls().
 */
interface OllamaToolCall {
  id?: string;
  type: 'function';
  function: {
    name: string;
    arguments: unknown; // object from Ollama, JSON string from OpenAI compat
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
  keep_alive?: number | string;
  /** Enable/disable thinking for thinking models (Qwen3, DeepSeek-R1, etc.) */
  think?: boolean;
  options?: {
    temperature?: number;
    num_predict?: number;
    num_ctx?: number;
    repeat_penalty?: number;
    top_p?: number;
    top_k?: number;
    [key: string]: unknown;
  } | undefined;
}

/**
 * Ollama chat response format
 */
interface OllamaChatResponse {
  message?: {
    role: 'assistant';
    content: string;
    /** Thinking/reasoning content returned by thinking models (e.g. Qwen3, DeepSeek-R1) */
    thinking?: string;
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
 * Parse tool calls from Ollama response.
 *
 * Ollama returns `arguments` as a plain object (not a JSON string),
 * but we also handle the string case for OpenAI-compat providers.
 */
function parseToolCalls(toolCalls: OllamaToolCall[] | undefined): NativeToolCall[] {
  if (!toolCalls || toolCalls.length === 0) {
    return [];
  }

  return toolCalls.map((tc) => {
    let input: Record<string, unknown> = {};
    const args = tc.function.arguments;

    if (typeof args === 'object' && args !== null) {
      // Ollama returns arguments as a parsed object — use directly
      input = args as Record<string, unknown>;
    } else if (typeof args === 'string') {
      // OpenAI-compat: arguments is a JSON string
      try {
        input = JSON.parse(args);
      } catch {
        input = { raw: args };
      }
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
  private readonly numCtx: number | undefined;
  private readonly keepAlive: number | string;
  private readonly think: boolean | undefined;

  constructor(options: OllamaProviderOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.model = options.model;
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.numCtx = options.numCtx;
    this.keepAlive = options.keepAlive ?? -1;
    this.think = options.think;
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

      // User message is always first after system
      messages.push({
        role: 'user',
        content: request.prompt,
      });

      // Thread previous assistant responses and tool results for multi-turn tool use.
      // The API expects: user → assistant (with tool_calls) → tool_result → ...
      if (request.previousAssistantMessages && previousResults) {
        let toolResultIndex = 0;

        for (const assistantMsg of request.previousAssistantMessages) {
          // Add the assistant message with its tool calls.
          // PreviousAssistantMessage stores arguments as a JSON string (provider-agnostic),
          // but Ollama expects arguments as a parsed object — so we parse here.
          messages.push({
            role: 'assistant',
            content: assistantMsg.text,
            tool_calls: assistantMsg.toolCalls.map((tc) => {
              let parsedArgs: unknown;
              try {
                parsedArgs = JSON.parse(tc.arguments);
              } catch {
                parsedArgs = tc.arguments;
              }
              return {
                id: tc.id,
                type: 'function' as const,
                function: {
                  name: tc.name,
                  arguments: parsedArgs,
                },
              };
            }),
          });

          // Add the corresponding tool results
          for (const _tc of assistantMsg.toolCalls) {
            if (toolResultIndex < previousResults.length) {
              const result = previousResults[toolResultIndex]!;
              messages.push({
                role: 'tool',
                content: result.result,
                tool_call_id: result.callId,
              });
              toolResultIndex++;
            }
          }
        }
      } else if (previousResults && previousResults.length > 0) {
        // Fallback: tool results without assistant messages (legacy callers)
        for (const result of previousResults) {
          messages.push({
            role: 'tool',
            content: result.result,
            tool_call_id: result.callId,
          });
        }
      }

      // Support per-request think override via providerOptions.think
      // (extracted here because `think` is a top-level Ollama field, not inside `options`)
      const { think: rawRequestThink, ...otherProviderOptions } =
        (request.providerOptions ?? {}) as Record<string, unknown>;
      const requestThink = typeof rawRequestThink === 'boolean' ? rawRequestThink : undefined;
      const effectiveThink = requestThink !== undefined ? requestThink : this.think;

      const chatRequest: OllamaChatRequest = {
        model: this.model,
        messages,
        tools: tools.length > 0 ? formatToolsForOllama(tools) : undefined,
        stream: false,
        keep_alive: this.keepAlive,
        ...(effectiveThink !== undefined ? { think: effectiveThink } : {}),
        options: {
          temperature: request.temperature ?? 0.7,
          num_predict: request.maxTokens ?? 2048,
          ...(this.numCtx ? { num_ctx: this.numCtx } : {}),
          ...otherProviderOptions,
        },
      };

      // Retry loop: some models (e.g. Qwen) occasionally generate malformed
      // XML tool calls that Ollama's parser rejects with a 400. Retrying with
      // a small temperature bump usually produces valid output.
      const MAX_RETRIES = 3;

      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        // Bump temperature slightly on retries to get different output
        if (attempt > 1) {
          const baseTemp = request.temperature ?? 0.7;
          chatRequest.options = {
            ...chatRequest.options,
            temperature: Math.min(baseTemp + 0.1 * (attempt - 1), 1.0),
          };
        }

        const requestBody = JSON.stringify(chatRequest);
        const response = await fetch(`${this.baseUrl}/api/chat`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: requestBody,
          signal: controller.signal,
        });

        if (!response.ok) {
          const errorText = await response.text().catch(() => 'Unknown error');

          // Retry on 400 with XML parsing errors — the model generated a
          // malformed tool call that Ollama's parser couldn't handle.
          if (response.status === 400 && errorText.includes('XML syntax error') && attempt < MAX_RETRIES) {
            // eslint-disable-next-line no-console
            console.warn(`[ollama] XML tool-call parse error on attempt ${attempt}/${MAX_RETRIES}, retrying...`);
            continue;
          }

          throw new ProviderError(
            `Ollama request failed with status ${response.status}: ${errorText}`
          );
        }

        const data = await response.json() as OllamaChatResponse;

        if (data.error) {
          throw new ProviderError(`Ollama error: ${data.error}`);
        }

        const toolCalls = parseToolCalls(data.message?.tool_calls);
        const stopReason = getStopReason(data);

        // Thinking models (Qwen3, DeepSeek-R1) may put output in `thinking`
        // with an empty `content`. Use thinking as fallback when content is empty.
        const content = data.message?.content ?? '';
        const thinking = data.message?.thinking ?? '';
        const text = content || thinking;

        return {
          text,
          toolCalls,
          providerId: this.id,
          model: this.model,
          stopReason,
        };
      }

      // Should be unreachable (loop always returns or throws), but TypeScript needs it
      throw new ProviderError('Ollama request failed: max retries exhausted');
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
