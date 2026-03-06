/**
 * MLX Provider — Apple Silicon-native inference via vllm-mlx.
 *
 * vllm-mlx exposes an OpenAI-compatible API server running on Apple's MLX
 * framework, which is purpose-built for unified memory architecture.
 * Achieves 50-87% faster inference than Ollama's llama.cpp backend
 * for large dense models on Apple Silicon.
 *
 * The provider implements the standard LlmProvider interface, translating
 * between Casterly's GenerateRequest format and OpenAI's chat completions API.
 *
 * Setup: See scripts/mlx-server.sh for server launch.
 * See docs/roadmap.md Tier 2, Item 5.
 */

import type { GenerateRequest, LlmProvider } from './base.js';
import { ProviderError } from './base.js';
import type {
  ToolSchema,
  ToolResultMessage,
  GenerateWithToolsResponse,
  NativeToolCall,
} from '../tools/schemas/types.js';
import { repairToolArgs } from '../tools/schemas/repair.js';
import type { MlxKvCacheConfig } from './mlx-kv-cache.js';
import { defaultKvCacheConfig, resolveKvBits, summarizeKvCacheConfig } from './mlx-kv-cache.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface MlxProviderOptions {
  /** Base URL for the vllm-mlx server (default: http://localhost:8000) */
  baseUrl: string;
  /** Model name as registered in vllm-mlx */
  model: string;
  /** Request timeout in milliseconds (default: 600_000 = 10 min) */
  timeoutMs?: number;
  /** KV cache quantization configuration (Tier 4, Item 12). */
  kvCache?: MlxKvCacheConfig;
}

/**
 * OpenAI-compatible chat message format.
 */
interface OpenAIChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
}

/**
 * OpenAI tool call format.
 * Unlike Ollama, arguments is always a JSON string.
 */
interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string; // JSON string
  };
}

/**
 * OpenAI-compatible tool definition.
 */
interface OpenAITool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/**
 * OpenAI chat completion request.
 */
interface OpenAIChatRequest {
  model: string;
  messages: OpenAIChatMessage[];
  tools?: OpenAITool[];
  tool_choice?: 'auto' | 'none';
  temperature?: number;
  max_tokens?: number;
  truncate_prompt_tokens?: number;
  stream: false;
}

/**
 * OpenAI chat completion response.
 */
interface OpenAIChatResponse {
  choices?: Array<{
    message?: {
      role: 'assistant';
      content: string | null;
      tool_calls?: OpenAIToolCall[];
    };
    finish_reason?: 'stop' | 'tool_calls' | 'length';
  }>;
  error?: { message: string };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generate a unique tool call ID.
 */
function generateToolCallId(): string {
  return `call_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * Convert Casterly's ToolSchema to OpenAI tool format.
 */
function formatToolsForOpenAI(tools: ToolSchema[]): OpenAITool[] {
  return tools.map((tool) => ({
    type: 'function' as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema as unknown as Record<string, unknown>,
    },
  }));
}

/**
 * Parse tool calls from OpenAI response.
 * Arguments are typically JSON strings in OpenAI format, but some
 * compatible servers return parsed objects — we handle both.
 */
function parseToolCalls(toolCalls: OpenAIToolCall[] | undefined): NativeToolCall[] {
  if (!toolCalls || toolCalls.length === 0) {
    return [];
  }

  return toolCalls.map((tc) => {
    let input: Record<string, unknown> = {};
    const args: unknown = tc.function.arguments;

    if (typeof args === 'object' && args !== null) {
      // Some OpenAI-compat servers return arguments as a parsed object
      input = args as Record<string, unknown>;
    } else if (typeof args === 'string') {
      // 3-tier parse: strict JSON → auto-repair → heuristic extraction
      const result = repairToolArgs(args);
      input = result.parsed;
    }

    return {
      id: tc.id || generateToolCallId(),
      name: tc.function.name,
      input,
    };
  });
}

/**
 * Map OpenAI finish reason to Casterly's stop reason.
 */
function getStopReason(
  finishReason: string | undefined,
  toolCalls: OpenAIToolCall[] | undefined,
): GenerateWithToolsResponse['stopReason'] {
  if (toolCalls && toolCalls.length > 0) {
    return 'tool_use';
  }
  if (finishReason === 'length') {
    return 'max_tokens';
  }
  return 'end_turn';
}

// ─────────────────────────────────────────────────────────────────────────────
// Provider
// ─────────────────────────────────────────────────────────────────────────────

export class MlxProvider implements LlmProvider {
  readonly id = 'mlx';
  readonly kind = 'local' as const;
  readonly model: string;
  readonly kvCache: MlxKvCacheConfig;

  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(options: MlxProviderOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.model = options.model;
    this.timeoutMs = options.timeoutMs ?? 600_000;
    this.kvCache = options.kvCache ?? defaultKvCacheConfig();
  }

  /**
   * Returns the resolved key/value bit widths, or null if no quantization.
   */
  get kvBits() {
    return resolveKvBits(this.kvCache);
  }

  /**
   * Human-readable summary of KV cache configuration.
   */
  kvCacheSummary(): string {
    return summarizeKvCacheConfig(this.kvCache);
  }

  async generateWithTools(
    request: GenerateRequest,
    tools: ToolSchema[],
    previousResults?: ToolResultMessage[],
  ): Promise<GenerateWithToolsResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      // ── Build messages ──────────────────────────────────────────────
      const messages: OpenAIChatMessage[] = [];

      if (request.systemPrompt) {
        messages.push({ role: 'system', content: request.systemPrompt });
      }

      messages.push({ role: 'user', content: request.prompt });

      // Thread previous assistant responses and tool results for multi-turn.
      // OpenAI format: arguments are already JSON strings in PreviousAssistantMessage.
      if (request.previousAssistantMessages && previousResults) {
        let toolResultIndex = 0;

        for (const assistantMsg of request.previousAssistantMessages) {
          messages.push({
            role: 'assistant',
            content: assistantMsg.text || null,
            tool_calls: assistantMsg.toolCalls.map((tc) => ({
              id: tc.id,
              type: 'function' as const,
              function: {
                name: tc.name,
                arguments: tc.arguments, // Already a JSON string
              },
            })),
          });

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
        for (const result of previousResults) {
          messages.push({
            role: 'tool',
            content: result.result,
            tool_call_id: result.callId,
          });
        }
      }

      // ── Build request ───────────────────────────────────────────────
      // vllm-mlx accepts truncate_prompt_tokens on each request.
      // Map Ollama-style num_ctx into that field so dual-loop context tiers
      // continue to work when DeepLoop runs on MLX.
      const rawProviderOptions = (request.providerOptions ?? {}) as Record<string, unknown>;
      const rawNumCtx = rawProviderOptions['num_ctx'];
      const truncatePromptTokens =
        typeof rawNumCtx === 'number' && Number.isFinite(rawNumCtx) && rawNumCtx > 0
          ? Math.floor(rawNumCtx)
          : undefined;

      const chatRequest: OpenAIChatRequest = {
        model: this.model,
        messages,
        ...(tools.length > 0
          ? { tools: formatToolsForOpenAI(tools), tool_choice: 'auto' as const }
          : {}),
        temperature: request.temperature ?? 0.7,
        max_tokens: request.maxTokens ?? 2048,
        ...(truncatePromptTokens !== undefined
          ? { truncate_prompt_tokens: truncatePromptTokens }
          : {}),
        stream: false,
      };

      // ── Send request ────────────────────────────────────────────────
      const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(chatRequest),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => 'Unknown error');
        throw new ProviderError(
          `MLX request failed with status ${response.status}: ${errorText}`,
        );
      }

      const data = (await response.json()) as OpenAIChatResponse;

      if (data.error) {
        throw new ProviderError(`MLX error: ${data.error.message}`);
      }

      const choice = data.choices?.[0];
      if (!choice?.message) {
        throw new ProviderError('MLX returned empty response (no choices)');
      }

      const toolCalls = parseToolCalls(choice.message.tool_calls);
      const stopReason = getStopReason(choice.finish_reason, choice.message.tool_calls);

      return {
        text: choice.message.content ?? '',
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
        throw new ProviderError(`MLX request timed out after ${this.timeoutMs}ms`);
      }

      throw new ProviderError('MLX provider failed', error);
    } finally {
      clearTimeout(timeout);
    }
  }
}
