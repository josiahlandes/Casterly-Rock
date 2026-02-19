/**
 * Provider Registry
 *
 * Mac Studio Edition - Local Ollama Only
 * No cloud providers, all inference runs locally.
 *
 * When a codingModel is configured (config/default.yaml), the registry
 * creates a second Ollama provider for coding tasks. The `forTask()`
 * helper selects the right provider based on task type or coding mode.
 */

import type { AppConfig } from '../config/schema.js';
import type { LlmProvider } from './base.js';
import { OllamaProvider } from './ollama.js';

export { BillingError } from './base.js';
export type { LlmProvider, PreviousAssistantMessage } from './base.js';

// Phase 5: Concurrent provider
export { ConcurrentProvider, createConcurrentProvider } from './concurrent.js';
export type {
  ConcurrentProviderConfig,
  NamedResult,
  BestOfNResult,
} from './concurrent.js';

export interface ProviderRegistry {
  /** Primary model — reasoning, planning, conversation */
  local: LlmProvider;

  /** Coding model — code generation, review, file operations (may equal local) */
  coding: LlmProvider;

  /**
   * Select the right provider for a task type.
   * Routes coding/file_operation tasks to the coding model,
   * everything else to the primary model.
   */
  forTask(taskType?: string): LlmProvider;

  /**
   * Get a provider by name. Supports 'local', 'coding', and model names.
   * Falls back to the local provider if the name isn't recognized.
   */
  get(name: string): LlmProvider;
}

/**
 * @deprecated Task-type routing is superseded by the delegate agent tool.
 * The LLM decides which model handles a subtask at runtime. The static
 * lookup table is retained for backward compatibility but forTask() now
 * always returns the local provider. See docs/vision.md.
 */
const CODING_TASK_TYPES = new Set([
  'coding', 'file_operation', 'code', 'review', 'implement', 'validate',
]);

export function buildProviders(config: AppConfig): ProviderRegistry {
  const localOptions = {
    baseUrl: config.local.baseUrl,
    model: config.local.model,
    ...(config.local.timeoutMs ? { timeoutMs: config.local.timeoutMs } : {}),
  };
  const local = new OllamaProvider(localOptions);

  // Create a separate coding provider when codingModel is set and differs
  const codingModel = config.local.codingModel;
  const coding = (codingModel && codingModel !== config.local.model)
    ? new OllamaProvider({
        baseUrl: config.local.baseUrl,
        model: codingModel,
        ...(config.local.timeoutMs ? { timeoutMs: config.local.timeoutMs } : {}),
      })
    : local;

  return {
    local,
    coding,
    /**
     * @deprecated Model selection is now the LLM's decision via the
     * delegate tool. forTask() returns the local provider for all tasks.
     * The coding provider is still available via get('coding').
     */
    forTask(_taskType?: string): LlmProvider {
      return local;
    },
    /**
     * Get a provider by name. Supports 'local', 'coding', and model names.
     * Falls back to the local provider if the name isn't recognized.
     */
    get(name: string): LlmProvider {
      if (name === 'coding' && this.coding) {
        return this.coding;
      }
      if (name === 'local' || name === 'default') {
        return this.local;
      }
      // Try matching by model name
      if (this.coding && name.includes('coder')) {
        return this.coding;
      }
      return this.local;
    },
  };
}
