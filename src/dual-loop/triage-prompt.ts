/**
 * Triage Prompt — System prompts for FastLoop message classification.
 *
 * The FastLoop uses the 35B-A3B model to triage incoming user messages into:
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
  classification: 'simple' | 'complex' | 'conversational' | 'system_inquiry';
  confidence: number;           // 0.0 to 1.0
  triageNotes: string;          // Summary for DeepLoop (if complex)
  directResponse?: string | undefined;  // Response if answering directly
  matchedProject?: string | undefined;  // Slug of matched existing project (if any)
}

// ─────────────────────────────────────────────────────────────────────────────
// Structured Output Schema (Ollama format parameter)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * JSON Schema for the triage response. Passed as Ollama's `format` parameter
 * to guarantee valid, schema-conformant JSON output without parsing fallbacks.
 */
export const TRIAGE_FORMAT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    classification: {
      type: 'string',
      enum: ['simple', 'complex', 'conversational', 'system_inquiry'],
    },
    confidence: {
      type: 'number',
    },
    triageNotes: {
      type: 'string',
    },
    directResponse: {
      type: 'string',
    },
  },
  required: ['classification', 'confidence', 'triageNotes'],
};

// ─────────────────────────────────────────────────────────────────────────────
// Prompts
// ─────────────────────────────────────────────────────────────────────────────

/**
 * System prompt for the triage classification call.
 */
export const TRIAGE_SYSTEM_PROMPT = `You are a triage agent. Your job is to classify the user's message into one of four categories:

1. **simple** — A question you can answer from general knowledge, conversation context, or common sense, without checking any files, running commands, or accessing the system. This includes:
   - General knowledge: "What does keep_alive do?", "Explain TCP vs UDP"
   - Personal/social questions: "What's my name?", "Who am I?", "What is their relationship?"
   - Follow-up questions about things already discussed in the conversation
   - Opinion or advice questions that don't need system data
2. **complex** — Anything that requires reading files, writing code, running commands, checking system state, or multi-step reasoning. This includes:
   - Code tasks: "Refactor the auth module", "Fix the login bug", "Add JWT support"
   - System state questions: "What's the git status?", "Is the server running?", "How many tests pass?"
   - File operations: "Read package.json", "How many files are in src?", "Show me the config"
   - Anything about the CURRENT state of code, processes, files, or the machine
3. **conversational** — Greetings, thanks, small talk, or acknowledgments. Examples: "Hey", "Thanks!", "Good morning"
4. **system_inquiry** — Status requests or questions about the system/agent itself. Examples: "Status?", "What can you do?", "Are you working?"

Key rules:
- If answering correctly requires looking at something on this machine (files, processes, git, logs), classify as **complex**. Do NOT guess at system state — you will hallucinate.
- If the question is personal, social, or can be answered from conversation context, classify as **simple** and answer directly. Do NOT escalate personal questions as complex engineering tasks.
- When in doubt between simple and complex, prefer **simple** if no file/system access is needed.

If existing projects are listed below and the user refers to one (by name, description, or context),
include "matchedProject": "<slug>" in your response. Otherwise omit it.

Respond with a JSON object:
{
  "classification": "simple" | "complex" | "conversational" | "system_inquiry",
  "confidence": 0.0-1.0,
  "triageNotes": "Brief summary for the planner (only needed for complex)",
  "directResponse": "Your answer (only for simple/conversational)",
  "matchedProject": "slug (only if user refers to an existing project)"
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
  projectsSummary?: string;
  recentConversation?: Array<{ role: string; content: string }>;
}): string {
  const parts: string[] = [];

  // Include recent conversation for context (helps with follow-up questions)
  if (params.recentConversation && params.recentConversation.length > 0) {
    const convLines = params.recentConversation
      .slice(-6) // Last 6 messages max
      .map((m) => `${m.role}: ${m.content.slice(0, 150)}`)
      .join('\n');
    parts.push(`Recent conversation:\n${convLines}\n\n---\n`);
  }

  parts.push(`[From: ${params.sender}]\n${params.message}\n\n---\nActive tasks:\n${params.taskBoardSummary}`);
  if (params.projectsSummary) {
    parts.push(`\n---\nExisting projects:\n${params.projectsSummary}`);
  }
  return parts.join('');
}

/**
 * Extract JSON from a model response that may be wrapped in markdown code blocks.
 * Handles: raw JSON, ```json\n{...}\n```, ```\n{...}\n```, or text before/after JSON.
 */
function extractJson(text: string): string {
  // Try to extract from markdown code block first
  const codeBlockMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (codeBlockMatch?.[1]) {
    return codeBlockMatch[1].trim();
  }

  // Try to find a JSON object in the text
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch?.[0]) {
    return jsonMatch[0];
  }

  return text.trim();
}

/**
 * Parse the triage response from the LLM. Falls back to 'complex' on parse failure.
 */
export function parseTriageResponse(text: string): TriageResult {
  try {
    const jsonStr = extractJson(text);
    const parsed = JSON.parse(jsonStr) as Record<string, unknown>;
    const matchedProject = parsed['matchedProject'] as string | undefined;
    return {
      classification: (parsed['classification'] as TriageResult['classification']) ?? 'complex',
      confidence: (parsed['confidence'] as number) ?? 0.5,
      triageNotes: (parsed['triageNotes'] as string) ?? '',
      directResponse: parsed['directResponse'] as string | undefined,
      ...(matchedProject ? { matchedProject } : {}),
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
