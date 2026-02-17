/**
 * Provider Registry
 *
 * Mac Studio Edition - Local Ollama Only
 * No cloud providers, all inference runs locally.
 */

import type { AppConfig } from '../config/schema.js';
import type { LlmProvider } from './base.js';
import { OllamaProvider } from './ollama.js';

export { BillingError } from './base.js';
export type { LlmProvider } from './base.js';

// Phase 5: Concurrent provider
export { ConcurrentProvider, createConcurrentProvider } from './concurrent.js';
export type {
  ConcurrentProviderConfig,
  NamedResult,
  BestOfNResult,
} from './concurrent.js';

export interface ProviderRegistry {
  local: LlmProvider;
}

export function buildProviders(config: AppConfig): ProviderRegistry {
  const localOptions = {
    baseUrl: config.local.baseUrl,
    model: config.local.model,
    ...(config.local.timeoutMs ? { timeoutMs: config.local.timeoutMs } : {}),
  };
  const local = new OllamaProvider(localOptions);

  return { local };
}
