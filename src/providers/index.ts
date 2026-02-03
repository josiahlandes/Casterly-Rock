import type { AppConfig } from '../config/schema.js';
import type { LlmProvider } from './base.js';
import { ClaudeProvider } from './claude.js';
import { OllamaProvider } from './ollama.js';

export { BillingError } from './base.js';
export type { LlmProvider } from './base.js';

export interface ProviderRegistry {
  local: LlmProvider;
  cloud?: LlmProvider;
}

export function buildProviders(config: AppConfig): ProviderRegistry {
  const localOptions = {
    baseUrl: config.local.baseUrl,
    model: config.local.model,
    ...(config.local.timeoutMs ? { timeoutMs: config.local.timeoutMs } : {})
  };
  const local = new OllamaProvider(localOptions);

  if (!config.cloud.apiKey) {
    return { local };
  }

  const cloudOptions = {
    apiKey: config.cloud.apiKey,
    model: config.cloud.model,
    ...(config.cloud.baseUrl ? { baseUrl: config.cloud.baseUrl } : {}),
    ...(config.cloud.timeoutMs ? { timeoutMs: config.cloud.timeoutMs } : {})
  };
  const cloud = new ClaudeProvider(cloudOptions);

  return { local, cloud };
}
