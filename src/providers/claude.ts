import type { GenerateRequest, GenerateResponse, LlmProvider } from './base.js';
import { ProviderError, BillingError } from './base.js';

export interface ClaudeProviderOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  timeoutMs?: number;
}

interface ClaudeErrorResponse {
  type: 'error';
  error: {
    type: string;
    message: string;
  };
}

interface ClaudeMessageResponse {
  content?: Array<{ type: string; text?: string }>;
  error?: { message?: string };
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

  async generate(request: GenerateRequest): Promise<GenerateResponse> {
    if (!this.apiKey) {
      throw new ProviderError('Claude provider requires an API key');
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(`${this.baseUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: request.maxTokens ?? 512,
          temperature: request.temperature ?? 0.2,
          system: request.systemPrompt,
          messages: [
            {
              role: 'user',
              content: request.prompt
            }
          ]
        }),
        signal: controller.signal
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
        } catch (parseError) {
          if (parseError instanceof BillingError) {
            throw parseError;
          }
          // Ignore JSON parse errors, fall through to generic error
        }
        throw new ProviderError(`Claude request failed with status ${response.status}`);
      }

      const data = (await response.json()) as ClaudeMessageResponse;
      const text = data.content?.map((block) => block.text ?? '').join('') ?? '';

      return {
        text,
        providerId: this.id,
        model: this.model
      };
    } catch (error) {
      if (error instanceof ProviderError) {
        throw error;
      }

      throw new ProviderError('Claude provider failed', error);
    } finally {
      clearTimeout(timeout);
    }
  }
}
