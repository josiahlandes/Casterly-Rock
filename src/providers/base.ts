export type ProviderKind = 'local' | 'cloud';

export interface GenerateRequest {
  prompt: string;
  systemPrompt?: string;
  maxTokens?: number;
  temperature?: number;
}

export interface GenerateResponse {
  text: string;
  providerId: string;
  model: string;
}

export interface LlmProvider {
  id: string;
  kind: ProviderKind;
  model: string;
  generate(request: GenerateRequest): Promise<GenerateResponse>;
}

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
