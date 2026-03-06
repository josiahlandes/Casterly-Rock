/**
 * Preflection — Pre-Planning Retrieval Planner
 *
 * Before Tyrion plans or responds, a cheap, fast inference call determines
 * what knowledge sources are relevant and whether confabulation risk is high.
 *
 * This replaces the "spreading activation" concept with something that
 * leverages Tyrion's actual strength: LLM reasoning. One call to the fast
 * model (~200ms on 35b-a3b) produces a retrieval plan that tells the
 * planner what context to load into warm tier.
 *
 * The preflection is:
 *   - Cheap: uses the fast/triage model, not the 122b reasoning model
 *   - Structured: outputs JSON with specific source references
 *   - Confidence-calibrated: explicitly flags confabulation risk
 *   - Fail-safe: on timeout/error, returns "retrieve everything relevant"
 */

import type { KnowledgeSource } from './knowledge-manifest.js';
import type { LlmProvider, GenerateRequest } from '../providers/base.js';
import { getTracer } from '../autonomous/debug.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The output of a preflection — what to retrieve and how confident we are.
 */
export interface PreflectionResult {
  /** Knowledge sources to retrieve before responding */
  retrieve: string[];

  /** Overall confidence that we can answer well (0-1) */
  confidence: number;

  /** Whether this question is about Tyrion himself */
  isSelfReferential: boolean;

  /** Risk of confabulation if we skip retrieval */
  confabulationRisk: 'low' | 'medium' | 'high';

  /** Brief reasoning for the retrieval plan */
  reasoning: string;

  /** Duration of the preflection call in ms */
  durationMs: number;
}

export interface PreflectConfig {
  /** Timeout for the preflection inference call */
  timeoutMs: number;
  /** Provider options (e.g., num_ctx for Ollama) */
  providerOptions: Record<string, unknown>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: PreflectConfig = {
  timeoutMs: 5_000,
  providerOptions: { num_ctx: 4096 },
};

const PREFLECT_SYSTEM_PROMPT = `You are a metacognitive pre-flight check for an AI agent named Tyrion.

Your ONLY job: given a user message and a list of knowledge sources, decide which sources the agent should consult BEFORE responding.

You must output ONLY valid JSON with this exact schema:
{
  "retrieve": ["source location 1", "source location 2"],
  "confidence": 0.0-1.0,
  "isSelfReferential": true/false,
  "confabulationRisk": "low" | "medium" | "high",
  "reasoning": "brief explanation"
}

Rules:
- "retrieve" must contain location strings from the provided knowledge sources list
- "confidence" is how confident you are the agent can answer WELL with the retrieved sources
- "isSelfReferential" is true if the question is about the agent itself, its hardware, its architecture, how it works, or its capabilities
- "confabulationRisk" is HIGH when: the question asks for specific facts (hardware specs, file locations, past events), and those facts would need to come from a specific source
- "confabulationRisk" is LOW when: the question is about general knowledge, coding help, or tasks where the agent generates rather than recalls
- When in doubt, retrieve MORE sources and flag confabulation risk as HIGH
- Output ONLY the JSON object, nothing else`;

// ─────────────────────────────────────────────────────────────────────────────
// Preflection
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Run a preflection to determine what knowledge to retrieve.
 *
 * @param userMessage - The incoming user message
 * @param sources - Available knowledge sources from the manifest
 * @param provider - The fast LLM provider for inference
 * @param config - Optional configuration overrides
 */
export async function preflect(
  userMessage: string,
  sources: KnowledgeSource[],
  provider: LlmProvider,
  config?: Partial<PreflectConfig>,
): Promise<PreflectionResult> {
  const tracer = getTracer();
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const startMs = Date.now();

  return tracer.withSpan('metacognition', 'preflect', async (span) => {
    // Build the source list for the prompt
    const sourceList = sources
      .filter((s) => s.populated)
      .map((s) => `- ${s.domain} → ${s.location}`)
      .join('\n');

    const userPrompt = `User message: "${userMessage}"

Available knowledge sources:
${sourceList}

Which sources should the agent retrieve before responding? Output JSON only.`;

    try {
      const request: GenerateRequest = {
        prompt: userPrompt,
        systemPrompt: PREFLECT_SYSTEM_PROMPT,
        maxTokens: 512,
        temperature: 0.1,
        providerOptions: cfg.providerOptions,
      };

      const response = await provider.generateWithTools(request, []);
      const durationMs = Date.now() - startMs;
      const text = response.text ?? '';

      // Parse the JSON response
      const result = parsePreflectionResponse(text, sources, durationMs);

      span.metadata['confidence'] = result.confidence;
      span.metadata['confabulationRisk'] = result.confabulationRisk;
      span.metadata['isSelfReferential'] = result.isSelfReferential;
      span.metadata['retrieveCount'] = result.retrieve.length;
      span.metadata['durationMs'] = durationMs;

      tracer.log('metacognition', 'info', 'Preflection complete', {
        confidence: result.confidence,
        confabulationRisk: result.confabulationRisk,
        isSelfReferential: result.isSelfReferential,
        retrieveCount: result.retrieve.length,
        durationMs,
      });

      return result;
    } catch (err) {
      const durationMs = Date.now() - startMs;
      tracer.log('metacognition', 'warn', 'Preflection failed, using safe fallback', {
        error: err instanceof Error ? err.message : String(err),
        durationMs,
      });

      span.status = 'failure';
      span.error = err instanceof Error ? err.message : String(err);

      // Fail safe: flag high confabulation risk and retrieve key sources
      return createSafeFallback(sources, durationMs);
    }
  });
}

/**
 * Quick, synchronous heuristic preflection for when LLM call is too expensive.
 * Uses keyword matching instead of inference. Less accurate but instant.
 */
export function preflectHeuristic(
  userMessage: string,
  sources: KnowledgeSource[],
): PreflectionResult {
  const startMs = Date.now();
  const msg = userMessage.toLowerCase();
  const retrieve: string[] = [];
  let isSelfReferential = false;
  let confabulationRisk: PreflectionResult['confabulationRisk'] = 'low';

  // Self-referential detection
  const selfKeywords = [
    'you', 'your', 'yourself', 'tyrion', 'how do you', 'what are you',
    'hardware', 'running on', 'world model', 'architecture', 'how you work',
    'capabilities', 'what can you', 'feel', 'self',
  ];
  const hasSelfKeyword = selfKeywords.some((kw) => msg.includes(kw));

  if (hasSelfKeyword) {
    isSelfReferential = true;
    confabulationRisk = 'high';

    // Pull in machine/runtime/architecture sources
    for (const s of sources) {
      if (s.populated && (
        s.domain.includes('hardware') ||
        s.domain.includes('Ollama') ||
        s.domain.includes('architecture') ||
        s.domain.includes('strengths') ||
        s.domain.includes('filesystem')
      )) {
        retrieve.push(s.location);
      }
    }
  }

  // Codebase questions
  const codeKeywords = ['test', 'lint', 'typecheck', 'error', 'health', 'branch', 'commit'];
  if (codeKeywords.some((kw) => msg.includes(kw))) {
    for (const s of sources) {
      if (s.populated && (s.domain.includes('health') || s.domain.includes('stats'))) {
        retrieve.push(s.location);
      }
    }
  }

  // Work state questions
  const workKeywords = ['goal', 'issue', 'working on', 'priority', 'task', 'plan'];
  if (workKeywords.some((kw) => msg.includes(kw))) {
    for (const s of sources) {
      if (s.populated && (s.domain.includes('goal') || s.domain.includes('issue'))) {
        retrieve.push(s.location);
      }
    }
  }

  // Memory questions
  const memoryKeywords = ['remember', 'last time', 'before', 'history', 'learned'];
  if (memoryKeywords.some((kw) => msg.includes(kw))) {
    for (const s of sources) {
      if (s.populated && (s.domain.includes('history') || s.domain.includes('journal') || s.domain.includes('insights'))) {
        retrieve.push(s.location);
      }
    }
    confabulationRisk = 'high';
  }

  // Deduplicate
  const uniqueRetrieve = [...new Set(retrieve)];

  return {
    retrieve: uniqueRetrieve,
    confidence: uniqueRetrieve.length > 0 ? 0.6 : 0.3,
    isSelfReferential,
    confabulationRisk,
    reasoning: 'heuristic keyword matching (no LLM call)',
    durationMs: Date.now() - startMs,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function parsePreflectionResponse(
  text: string,
  sources: KnowledgeSource[],
  durationMs: number,
): PreflectionResult {
  // Extract JSON from response (may have markdown wrapping)
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return createSafeFallback(sources, durationMs);
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]) as {
      retrieve?: unknown;
      confidence?: unknown;
      isSelfReferential?: unknown;
      confabulationRisk?: unknown;
      reasoning?: unknown;
    };

    const retrieve = Array.isArray(parsed.retrieve)
      ? (parsed.retrieve as unknown[]).filter((r): r is string => typeof r === 'string')
      : [];

    const confidence = typeof parsed.confidence === 'number'
      ? Math.max(0, Math.min(1, parsed.confidence))
      : 0.5;

    const isSelfReferential = typeof parsed.isSelfReferential === 'boolean'
      ? parsed.isSelfReferential
      : false;

    const confabulationRisk = (
      parsed.confabulationRisk === 'low' ||
      parsed.confabulationRisk === 'medium' ||
      parsed.confabulationRisk === 'high'
    ) ? parsed.confabulationRisk : 'medium';

    const reasoning = typeof parsed.reasoning === 'string'
      ? parsed.reasoning
      : '';

    return {
      retrieve,
      confidence,
      isSelfReferential,
      confabulationRisk,
      reasoning,
      durationMs,
    };
  } catch {
    return createSafeFallback(sources, durationMs);
  }
}

function createSafeFallback(
  sources: KnowledgeSource[],
  durationMs: number,
): PreflectionResult {
  // When we can't determine relevance, retrieve the cheapest high-value sources
  const safeRetrieve = sources
    .filter((s) => s.populated && s.retrievalCostTokens <= 100)
    .map((s) => s.location);

  return {
    retrieve: safeRetrieve,
    confidence: 0.3,
    isSelfReferential: false,
    confabulationRisk: 'high',
    reasoning: 'preflection failed — using safe fallback with broad retrieval',
    durationMs,
  };
}
