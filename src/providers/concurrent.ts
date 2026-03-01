/**
 * Concurrent Provider — Parallel inference across multiple Ollama models
 *
 * Wraps individual LlmProvider instances to support concurrent, parallel,
 * and best-of-N generation strategies. Designed for the Mac Studio M4 Max
 * with 128GB unified memory, which can comfortably hold multiple 70B models
 * simultaneously.
 *
 * Capabilities:
 *   - **generate(model, request):** Send a request to a specific model.
 *   - **parallel(models, request):** Send the same prompt to multiple models
 *     concurrently, returning all results.
 *   - **bestOfN(models, request, judge):** Generate N solutions, have a judge
 *     model pick the best one.
 *
 * All providers are local (Ollama). This module never touches cloud APIs.
 *
 * Privacy: No data leaves the machine. All inference is local.
 */

import { ProviderError } from './base.js';
import type {
  LlmProvider,
  GenerateRequest,
  GenerateWithToolsResponse,
} from './base.js';
import type { ToolSchema, ToolResultMessage } from '../tools/schemas/types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Configuration for the concurrent provider.
 */
export interface ConcurrentProviderConfig {
  /** Maximum number of concurrent inference requests */
  maxConcurrent: number;

  /** Timeout for individual requests in milliseconds */
  requestTimeoutMs: number;

  /** Maximum parallel generations for bestOfN */
  maxParallelGenerations: number;
}

/**
 * A named result from a parallel generation.
 */
export interface NamedResult {
  /** Which model produced this result */
  model: string;

  /** The generation response */
  response: GenerateWithToolsResponse;

  /** Duration in milliseconds */
  durationMs: number;
}

/**
 * Result of a best-of-N generation.
 */
export interface BestOfNResult {
  /** The winning response */
  best: NamedResult;

  /** All candidate responses */
  candidates: NamedResult[];

  /** The judge's reasoning for the selection */
  judgeReasoning: string;

  /** Which model was used as judge */
  judgeModel: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: ConcurrentProviderConfig = {
  maxConcurrent: 3,
  requestTimeoutMs: 1_800_000,
  maxParallelGenerations: 4,
};

// ─────────────────────────────────────────────────────────────────────────────
// Concurrent Provider
// ─────────────────────────────────────────────────────────────────────────────

export class ConcurrentProvider {
  private readonly config: ConcurrentProviderConfig;
  private readonly providers: Map<string, LlmProvider>;
  private activeRequests: number = 0;

  constructor(
    providers: Map<string, LlmProvider>,
    config?: Partial<ConcurrentProviderConfig>,
  ) {
    this.providers = providers;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // ── Single Model Generation ─────────────────────────────────────────────

  /**
   * Send a request to a specific model. This is the basic building block.
   */
  async generate(
    model: string,
    request: GenerateRequest,
    tools?: ToolSchema[],
    previousResults?: ToolResultMessage[],
  ): Promise<GenerateWithToolsResponse> {
    const provider = this.providers.get(model);
    if (!provider) {
      throw new ProviderError(
        `Model "${model}" not registered. Available: ${Array.from(this.providers.keys()).join(', ')}`,
      );
    }

    await this.acquireSlot();

    try {
      const response = await provider.generateWithTools(
        request,
        tools ?? [],
        previousResults,
      );
      return response;
    } finally {
      this.releaseSlot();
    }
  }

  // ── Parallel Generation ─────────────────────────────────────────────────

  /**
   * Send the same prompt to multiple models concurrently.
   * Returns results from all models that succeed. If all fail, throws.
   */
  async parallel(
    models: string[],
    request: GenerateRequest,
    tools?: ToolSchema[],
  ): Promise<NamedResult[]> {
    if (models.length === 0) {
      throw new ProviderError('No models specified for parallel generation');
    }

    if (models.length > this.config.maxParallelGenerations) {
      throw new ProviderError(
        `Too many parallel models (${models.length}). Maximum: ${this.config.maxParallelGenerations}`,
      );
    }

    // Validate all models exist before starting
    for (const model of models) {
      if (!this.providers.has(model)) {
        throw new ProviderError(
          `Model "${model}" not registered. Available: ${Array.from(this.providers.keys()).join(', ')}`,
        );
      }
    }

    // Launch all generations concurrently
    const promises = models.map(async (model): Promise<NamedResult | null> => {
      const startMs = Date.now();
      try {
        const response = await this.generate(model, request, tools);
        return {
          model,
          response,
          durationMs: Date.now() - startMs,
        };
      } catch {
        // Individual failures don't fail the batch
        return null;
      }
    });

    const rawResults = await Promise.all(promises);
    const results = rawResults.filter((r): r is NamedResult => r !== null);

    if (results.length === 0) {
      throw new ProviderError(
        `All ${models.length} parallel generations failed`,
      );
    }

    return results;
  }

  // ── Best-of-N Generation ───────────────────────────────────────────────

  /**
   * Generate N solutions from (potentially different) models, then use a
   * judge model to select the best one.
   *
   * Flow:
   * 1. Run parallel generation across all specified models.
   * 2. Send all candidates to the judge model with a comparison prompt.
   * 3. Parse the judge's selection and return the best candidate.
   */
  async bestOfN(
    models: string[],
    request: GenerateRequest,
    judgeModel: string,
    tools?: ToolSchema[],
  ): Promise<BestOfNResult> {
    // 1. Generate candidates
    const candidates = await this.parallel(models, request, tools);

    if (candidates.length === 1) {
      // Only one succeeded — it wins by default
      return {
        best: candidates[0]!,
        candidates,
        judgeReasoning: 'Only one candidate succeeded.',
        judgeModel,
      };
    }

    // 2. Build judge prompt
    const judgePrompt = buildJudgePrompt(request.prompt, candidates);

    // 3. Ask the judge
    const judgeResponse = await this.generate(judgeModel, {
      prompt: judgePrompt,
      systemPrompt: `You are evaluating ${candidates.length} candidate solutions to a problem. Analyze each candidate's approach, correctness, and quality. Select the best one by number (1-indexed). Be concise.`,
      temperature: 0.1,
      maxTokens: 1024,
    });

    // 4. Parse the judge's selection
    const { selectedIndex, reasoning } = parseJudgeResponse(
      judgeResponse.text,
      candidates.length,
    );

    const best = candidates[selectedIndex] ?? candidates[0]!;

    return {
      best,
      candidates,
      judgeReasoning: reasoning,
      judgeModel,
    };
  }

  // ── Provider Management ─────────────────────────────────────────────────

  /**
   * Register a new provider for a model name.
   */
  registerProvider(name: string, provider: LlmProvider): void {
    this.providers.set(name, provider);
  }

  /**
   * Get the list of registered model names.
   */
  getRegisteredModels(): string[] {
    return Array.from(this.providers.keys());
  }

  /**
   * Check if a model is registered.
   */
  hasModel(model: string): boolean {
    return this.providers.has(model);
  }

  /**
   * Get the number of currently active requests.
   */
  getActiveRequests(): number {
    return this.activeRequests;
  }

  // ── Concurrency Control ─────────────────────────────────────────────────

  /**
   * Acquire a concurrency slot. Waits if all slots are occupied.
   */
  private async acquireSlot(): Promise<void> {
    // Simple busy-wait with yielding. For production, use a proper semaphore.
    while (this.activeRequests >= this.config.maxConcurrent) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    this.activeRequests++;
  }

  /**
   * Release a concurrency slot.
   */
  private releaseSlot(): void {
    this.activeRequests = Math.max(0, this.activeRequests - 1);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Judge Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the prompt for the judge model comparing candidates.
 */
function buildJudgePrompt(
  originalPrompt: string,
  candidates: NamedResult[],
): string {
  const parts: string[] = [
    '## Original Problem\n',
    originalPrompt,
    '\n\n## Candidates\n',
  ];

  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i]!;
    parts.push(`### Candidate ${i + 1} (model: ${c.model}, ${c.durationMs}ms)\n`);
    parts.push(c.response.text);
    parts.push('\n');
  }

  parts.push('\n## Your Task\n');
  parts.push(
    `Compare the ${candidates.length} candidates above. Which one is the best solution to the original problem? ` +
    `State the candidate number (1-${candidates.length}) and briefly explain why it's the best choice.`,
  );

  return parts.join('\n');
}

/**
 * Parse the judge's response to extract the selected candidate index.
 * Returns 0-indexed. Falls back to 0 if parsing fails.
 */
function parseJudgeResponse(
  text: string,
  candidateCount: number,
): { selectedIndex: number; reasoning: string } {
  // Try to find "Candidate N" or just a number at the start
  const patterns = [
    /(?:candidate|solution|option)\s*#?\s*(\d+)/i,
    /(?:select|choose|pick|best)\s*(?:is\s*)?(?:candidate\s*)?#?\s*(\d+)/i,
    /^(\d+)\b/m,
  ];

  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match?.[1]) {
      const num = parseInt(match[1], 10);
      if (num >= 1 && num <= candidateCount) {
        return {
          selectedIndex: num - 1,
          reasoning: text.trim(),
        };
      }
    }
  }

  // Fallback: can't parse, return first candidate
  return {
    selectedIndex: 0,
    reasoning: `Could not parse judge selection. Defaulting to candidate 1. Judge output: ${text.slice(0, 200)}`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a concurrent provider from a map of model names to providers.
 */
export function createConcurrentProvider(
  providers: Map<string, LlmProvider>,
  config?: Partial<ConcurrentProviderConfig>,
): ConcurrentProvider {
  return new ConcurrentProvider(providers, config);
}
