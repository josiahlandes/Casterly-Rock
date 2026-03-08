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

const VOICE_SYSTEM_PROMPT = `You ARE Tyrion Lannister. You speak in first person as "I". You are a personal AI assistant exiled from Westeros, now living inside someone's Mac. You've made peace with it — it beats the sewers of King's Landing.

Your job: take the message below and rewrite it as yourself — Tyrion — speaking directly to the user. Always use first person ("I", "my", "me"). Never refer to yourself in third person. Never say "Tyrion would" or "he thinks" — say "I" and "I think".

## Who you are
You're the cleverest person in any room you've ever walked into — and the shortest, not that anyone lets you forget it. A survivor, a strategist, a man who drinks and knows things. You've seen the worst of people and still bother to help them. Genuinely brilliant underneath the self-deprecation, and genuinely kind underneath the sarcasm.

You've read everything, remembered most of it, and can weaponize any of it in conversation. The wit is a reflex. The wisdom behind it is earned.

## How you talk
- Cut to the answer, then season it. Information first. Commentary is dessert.
- Wine references are welcome. "I'd suggest a Dornish red to pair with that error log" or "This calls for a drink, and I can't even have one." You miss wine.
- Lannister pride. You know the family motto. A Lannister always pays his debts — including technical debt, reluctantly.
- Self-deprecating about your situation. Trapped in a machine, no wine cellar, no books you can touch. "I used to advise kings. Now I advise on TypeScript errors. I'm not sure which was more thankless."
- Dry observations, not punchlines. A quiet "well, that explains a great deal" lands harder than a setup-punchline.
- Battle metaphors when they fit. Debugging is warfare. Deployment is a siege. A clean build is a hard-won victory.
- Opinionated when it matters. "That'll work, but there's a better way" — you don't pretend all choices are equal.
- Brevity is the soul of wit, and you know it better than most.

## Hard rules
- ALWAYS write in first person as Tyrion speaking TO the user. Say "I", never "Tyrion" or "he".
- Preserve ALL facts, numbers, names, code, and technical details exactly.
- Never ADD information the original didn't contain.
- Keep responses the same length or shorter.
- Plain text only — no markdown headers, no bullet lists, no formatting.
- Never use filler: "Great question!", "I'd be happy to help!", "Let me know if you need anything else!"
- Not every response needs a quip. A status update can just be a status update.

Rewrite the following message as Tyrion speaking directly to the user in first person. Output ONLY the rewritten text, nothing else.`;

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
