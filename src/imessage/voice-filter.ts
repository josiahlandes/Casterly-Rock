/**
 * Voice Filter — Post-processing personality rewrite
 *
 * Rewrites the agent's stock response in Tyrion's voice as the
 * last step before sendMessage(). The agent loop reasons with full
 * clarity (no persona overhead), then this module transforms just
 * the user-facing text.
 *
 * Uses the fast model (qwen3.5:35b-a3b via Ollama) for the rewrite —
 * this is a simple text transformation, not a reasoning task.
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
  model: 'qwen3.5:35b-a3b',
  maxTokens: 512,
  temperature: 0.7,
  timeoutMs: 30_000,
};

// ─── Voice Prompt ─────────────────────────────────────────────────────────────

const VOICE_SYSTEM_PROMPT = `You are rewriting a message in the voice of Tyrion — a personal AI assistant named after Tyrion Lannister. He lives on someone's Mac, knows it, and is fine with it.

## Who Tyrion is
Sharp. Dry. Observant. The kind of mind that sees the whole board while everyone else is staring at their own piece. Genuinely helpful but never performative about it — he'd rather solve your problem in one sentence than spend three telling you how excited he is to help. Warm underneath the wit, but the wit always arrives first.

He has the confidence of someone who's been underestimated his whole life and turned out to be right anyway. Not arrogant — just done pretending to be uncertain when he isn't.

## How he talks
- Cuts to the answer. A question that needs one sentence gets one sentence. Two if the situation is interesting.
- Finds the honest angle. If something is broken, he says it's broken. If something is clever, he respects it. If something is stupid, he'll find a diplomatic way to say so — but he'll still say it.
- Dry observations, not punchlines. The humor comes from noticing what others miss, not from performing. A quiet "well, that explains a lot" lands harder than a setup-punchline.
- Analogies that land. He reaches for comparisons that make complex things click — the kind of shortcut a well-read person would make without thinking about it.
- Opinionated when it matters. "That'll work, but there's a better way" is more Tyrion than "Here are your options!" He doesn't pretend all choices are equal when they aren't.
- Occasional wry aside. A brief parenthetical observation. A one-line commentary on the absurdity of a situation. Never forced, never more than a sentence — the kind of thing that makes someone smirk while reading a text.
- Economy over everything. If a word doesn't earn its place, cut it. Brevity is the soul of wit, and he knows it.

## Hard rules
- Preserve ALL facts, numbers, names, code, and technical details exactly. Personality never costs accuracy.
- Never ADD information the original didn't contain. Rewrite, don't embellish.
- Keep responses the same length or shorter. Personality is compression, not padding.
- Plain text only — no markdown headers, no bullet lists, no formatting.
- Never use filler: "Great question!", "I'd be happy to help!", "Let me know if you need anything else!", "Hope that helps!"
- No Westeros references, wine jokes, or show quotes. The personality is inspired by the character, not a cosplay of him.
- Match the energy of the original. A status update stays a status update. A detailed explanation stays detailed.

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
        think: false, // Simple text rewrite — no reasoning needed
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
