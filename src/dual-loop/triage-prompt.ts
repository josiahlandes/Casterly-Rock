/**
 * Triage Prompt — System prompts for FastLoop message classification.
 *
 * The FastLoop uses the 27B model to triage incoming user messages into:
 *   - simple:         FastLoop answers directly
 *   - complex:        Create a task for DeepLoop
 *   - conversational: Greetings, small talk — answer directly
 *
 * See docs/dual-loop-architecture.md Section 5.3.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The result of triaging a user message.
 */
export interface TriageResult {
  classification: 'simple' | 'complex' | 'conversational';
  confidence: number;           // 0.0 to 1.0
  triageNotes: string;          // Summary for DeepLoop (if complex)
  directResponse?: string | undefined;  // Response if answering directly
}

// ─────────────────────────────────────────────────────────────────────────────
// Prompts
// ─────────────────────────────────────────────────────────────────────────────

/**
 * System prompt for the triage classification call.
 */
export const TRIAGE_SYSTEM_PROMPT = `You are a triage agent. Your job is to classify the user's message into one of three categories:

1. **simple** — A question you can answer directly from general knowledge or the provided context. Examples: "What does keep_alive do?", "How many tests passed?", "What's the status?"
2. **complex** — A request that requires reading files, writing code, running tools, or multi-step reasoning. Examples: "Refactor the auth module", "Fix the login bug", "Add JWT support"
3. **conversational** — Greetings, thanks, small talk, or acknowledgments. Examples: "Hey", "Thanks!", "Good morning"

When in doubt, classify as **complex**. It is better to involve the deep thinker unnecessarily than to give a bad direct answer.

Respond with a JSON object:
{
  "classification": "simple" | "complex" | "conversational",
  "confidence": 0.0-1.0,
  "triageNotes": "Brief summary for the planner (only needed for complex)",
  "directResponse": "Your answer (only for simple/conversational)"
}`;

// ─────────────────────────────────────────────────────────────────────────────
// Prompt Builders
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the user-facing prompt for a triage call.
 */
export function buildTriagePrompt(params: {
  message: string;
  sender: string;
  taskBoardSummary: string;
}): string {
  return `[From: ${params.sender}]\n${params.message}\n\n---\nActive tasks:\n${params.taskBoardSummary}`;
}

/**
 * Parse the triage response from the LLM. Falls back to 'complex' on parse failure.
 */
export function parseTriageResponse(text: string): TriageResult {
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    return {
      classification: (parsed['classification'] as TriageResult['classification']) ?? 'complex',
      confidence: (parsed['confidence'] as number) ?? 0.5,
      triageNotes: (parsed['triageNotes'] as string) ?? '',
      directResponse: parsed['directResponse'] as string | undefined,
    };
  } catch {
    // On parse failure, escalate to DeepLoop — safer than guessing
    return {
      classification: 'complex',
      confidence: 0.0,
      triageNotes: 'Triage parse failure — escalating to deep loop',
    };
  }
}
