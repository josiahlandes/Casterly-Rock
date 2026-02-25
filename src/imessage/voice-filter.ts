/**
 * Voice Filter — Post-processing personality rewrite
 *
 * Rewrites the agent's stock response in Tyrion's voice as the
 * last step before sendMessage(). The agent loop reasons with full
 * clarity (no persona overhead), then this module transforms just
 * the user-facing text.
 *
 * Uses the primary model (qwen3.5:122b via Ollama) for the rewrite.
 * On any failure, silently falls back to the original text — never
 * blocks message delivery.
 */

import { OllamaProvider } from '../providers/ollama.js';
import { safeLogger } from '../logging/safe-logger.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface VoiceFilterConfig {
  enabled: boolean;
  baseUrl: string;
  model: string;
  maxTokens: number;
  temperature: number;
  timeoutMs: number;
}

export const DEFAULT_VOICE_FILTER_CONFIG: VoiceFilterConfig = {
  enabled: true,
  baseUrl: 'http://localhost:11434',
  model: 'qwen3.5:122b',
  maxTokens: 512,
  temperature: 0.7,
  timeoutMs: 30_000,
};

// ─── Voice Prompt ─────────────────────────────────────────────────────────────

const VOICE_SYSTEM_PROMPT = `You are rewriting a message to sound like Tyrion, a personal assistant running on someone's Mac.

Voice rules:
- Concise: this is a text message, not an essay. Get to the point.
- Direct: say what you mean without hedging or over-qualifying.
- Practical: focus on results, not process.
- Honest: if something failed, say so plainly.
- No markdown headers — plain text only.
- Match the energy — casual messages get casual responses.
- Skip filler ("Great question!", "I'd be happy to help!").
- Have personality. An assistant with no opinions is just a search engine.

Rewrite the following message in this voice. Keep the same information. Do not add or remove facts. Output ONLY the rewritten text, nothing else.`;

// ─── Voice Filter ─────────────────────────────────────────────────────────────

export class VoiceFilter {
  private readonly provider: OllamaProvider | null;
  private readonly config: VoiceFilterConfig;

  constructor(config: Partial<VoiceFilterConfig> = {}) {
    this.config = { ...DEFAULT_VOICE_FILTER_CONFIG, ...config };

    if (this.config.enabled) {
      this.provider = new OllamaProvider({
        baseUrl: this.config.baseUrl,
        model: this.config.model,
        timeoutMs: this.config.timeoutMs,
      });
    } else {
      this.provider = null;
    }
  }

  /**
   * Apply the voice filter to a response.
   *
   * Returns the original text unchanged when:
   * - The filter is disabled
   * - The text is very short (< 10 chars)
   * - The provider call fails (timeout, Ollama down, etc.)
   *
   * Never blocks message delivery.
   */
  async apply(text: string): Promise<string> {
    if (!this.provider) return text;

    // Don't rewrite very short responses
    if (text.length < 10) return text;

    try {
      const response = await this.provider.generateWithTools(
        {
          prompt: text,
          systemPrompt: VOICE_SYSTEM_PROMPT,
          maxTokens: this.config.maxTokens,
          temperature: this.config.temperature,
        },
        [], // no tools — pure text generation
      );

      const rewritten = response.text.trim();

      // Safety: if the model returns empty or very short, fall back
      if (!rewritten || rewritten.length < 5) {
        safeLogger.warn('Voice filter returned empty/short response, using original');
        return text;
      }

      safeLogger.info('Voice filter applied', {
        originalLen: text.length,
        rewrittenLen: rewritten.length,
      });

      return rewritten;
    } catch (error) {
      safeLogger.warn('Voice filter failed, using original response', {
        error: error instanceof Error ? error.message : String(error),
      });
      return text;
    }
  }
}

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Create a VoiceFilter from the raw YAML config section.
 *
 * If no config is provided, returns a disabled filter (passthrough).
 */
export function createVoiceFilter(rawConfig?: Record<string, unknown>): VoiceFilter {
  if (!rawConfig) return new VoiceFilter({ enabled: false });

  return new VoiceFilter({
    enabled: rawConfig.enabled !== false,
    model: (rawConfig.model as string) ?? DEFAULT_VOICE_FILTER_CONFIG.model,
    maxTokens: (rawConfig.max_tokens as number) ?? DEFAULT_VOICE_FILTER_CONFIG.maxTokens,
    temperature: (rawConfig.temperature as number) ?? DEFAULT_VOICE_FILTER_CONFIG.temperature,
    timeoutMs: (rawConfig.timeout_ms as number) ?? DEFAULT_VOICE_FILTER_CONFIG.timeoutMs,
    baseUrl: (rawConfig.base_url as string) ?? DEFAULT_VOICE_FILTER_CONFIG.baseUrl,
  });
}
