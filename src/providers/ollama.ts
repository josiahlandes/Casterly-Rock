import type { GenerateRequest, GenerateResponse, LlmProvider } from './base.js';
import { ProviderError } from './base.js';

export interface OllamaProviderOptions {
  baseUrl: string;
  model: string;
  timeoutMs?: number;
}

interface OllamaGenerateResponse {
  response?: string;
  error?: string;
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
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  async generate(request: GenerateRequest): Promise<GenerateResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(`${this.baseUrl}/api/generate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: this.model,
          prompt: request.prompt,
          system: request.systemPrompt,
          stream: false,
          options: {
            temperature: request.temperature,
            num_predict: request.maxTokens
          }
        }),
        signal: controller.signal
      });

      if (!response.ok) {
        throw new ProviderError(`Ollama request failed with status ${response.status}`);
      }

      const data = (await response.json()) as OllamaGenerateResponse;

      if (data.error) {
        throw new ProviderError(`Ollama error: ${data.error}`);
      }

      return {
        text: data.response ?? '',
        providerId: this.id,
        model: this.model
      };
    } catch (error) {
      if (error instanceof ProviderError) {
        throw error;
      }

      throw new ProviderError('Ollama provider failed', error);
    } finally {
      clearTimeout(timeout);
    }
  }
}
