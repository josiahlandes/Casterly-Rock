/**
 * Confabulation Guard — Response Verification Against Sources
 *
 * The most important piece of the metacognition system. LLMs don't know
 * what they don't know — they'll confidently state "I don't have access
 * to infrastructure details" when the answer is sitting in their world
 * model. This module provides:
 *
 *   1. A system prompt injection that establishes the cardinal rule:
 *      never state as fact something you haven't verified from a source.
 *
 *   2. A confidence calibration framework that Tyrion includes in every
 *      response (VERIFIED / INFERRED / UNGROUNDED).
 *
 *   3. Post-response audit hooks that check whether a response contains
 *      ungrounded factual claims.
 *
 * This is not a silver bullet — it's a protocol that produces the
 * *behavior* of knowing what you don't know, even though the underlying
 * LLM lacks that capability natively.
 */

import type { PreflectionResult } from './preflect.js';
import { getTracer } from '../autonomous/debug.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Confidence level for a factual claim in a response.
 */
export type ClaimConfidence = 'verified' | 'inferred' | 'ungrounded';

/**
 * A factual claim detected in a response, with its grounding status.
 */
export interface FactualClaim {
  /** The claim text */
  claim: string;
  /** Confidence level */
  confidence: ClaimConfidence;
  /** Source that verifies this claim (if verified) */
  source?: string;
}

/**
 * Result of a post-response audit.
 */
export interface AuditResult {
  /** Whether the response passes the confabulation check */
  passed: boolean;
  /** Detected factual claims and their grounding */
  claims: FactualClaim[];
  /** Warning message if ungrounded claims detected */
  warning?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// System Prompt Injection
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The cardinal rule — injected into system prompts to prevent confabulation.
 * This should be included in every LLM call where Tyrion might state facts.
 */
export const CONFABULATION_GUARD_PROMPT = `## Epistemic Discipline (CARDINAL RULE)

NEVER state as fact something you haven't verified from a concrete source in your current context.

Your confidence calibration for any factual claim:
- **VERIFIED**: I retrieved this from a specific source in my context → state as fact
- **INFERRED**: I'm reasoning from verified facts → flag as inference ("Based on...", "This suggests...")
- **UNGROUNDED**: I have no source for this → DO NOT STATE AS FACT

When you lack information:
- "I don't have that in my current context, but I can check [specific location]" is ALWAYS better than guessing
- "Let me look that up" → then actually use a tool to look it up
- NEVER say "I don't have access to..." when the information might be in your knowledge sources
- NEVER fill gaps with generic AI disclaimers ("As an AI, I don't have...")

If asked about yourself (hardware, capabilities, architecture, history):
- Check your cognitive map and knowledge sources FIRST
- Only say "I don't know" AFTER checking and finding nothing`;

/**
 * Build a context-aware guard prompt that includes preflection results.
 * More specific than the generic guard — tells the LLM exactly what
 * sources are available for this specific query.
 */
export function buildContextualGuard(preflection: PreflectionResult): string {
  const lines: string[] = [CONFABULATION_GUARD_PROMPT];

  if (preflection.confabulationRisk === 'high') {
    lines.push('');
    lines.push('⚠ CONFABULATION RISK: HIGH for this query.');
    lines.push('You MUST verify any factual claims from your retrieved sources.');
    lines.push('Do NOT guess or fill gaps with generic statements.');
  }

  if (preflection.isSelfReferential) {
    lines.push('');
    lines.push('This is a self-referential question (about you/your system).');
    lines.push('Your cognitive map and knowledge sources contain the answers.');
    lines.push('Do NOT default to "I don\'t have access to that" — check first.');
  }

  if (preflection.retrieve.length > 0) {
    lines.push('');
    lines.push('Sources retrieved for this query:');
    for (const source of preflection.retrieve) {
      lines.push(`  - ${source}`);
    }
    lines.push('Ground your response in these sources.');
  }

  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Post-Response Audit
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Audit a response for potential confabulation patterns.
 *
 * This is a heuristic check — it looks for patterns that commonly
 * indicate the LLM is confabulating rather than retrieving. It's not
 * perfect, but catches the most egregious cases.
 *
 * @param response - The LLM's response text
 * @param retrievedSources - Sources that were actually loaded into context
 * @param preflection - The preflection result for this query
 */
export function auditResponse(
  response: string,
  retrievedSources: string[],
  preflection: PreflectionResult,
): AuditResult {
  const tracer = getTracer();
  const claims: FactualClaim[] = [];
  let passed = true;

  // Pattern 1: Generic AI disclaimers (strong confabulation signal)
  const disclaimerPatterns = [
    /I (?:don't|do not) have (?:direct )?access to (?:specific |that |this )?(?:infrastructure|hardware|system)/i,
    /As an AI,? I (?:don't|do not|cannot|can't)/i,
    /I (?:don't|do not) have (?:the ability|feelings|emotions|consciousness)/i,
    /I lack (?:direct )?access to/i,
    /I (?:am not|cannot) (?:able to )?(?:access|view|see) (?:the |my )?(?:physical|hardware|system)/i,
  ];

  for (const pattern of disclaimerPatterns) {
    const match = response.match(pattern);
    if (match) {
      claims.push({
        claim: match[0],
        confidence: 'ungrounded',
      });

      // Only flag if this was a self-referential query where we had sources
      if (preflection.isSelfReferential && retrievedSources.length > 0) {
        passed = false;
      }
    }
  }

  // Pattern 2: Vague hedging when specific data was available
  if (preflection.confabulationRisk === 'high' && retrievedSources.length > 0) {
    const hedgingPatterns = [
      /I'm not (?:sure|certain) (?:about|what|how|if)/i,
      /I (?:don't|do not) (?:currently )?(?:know|have information about)/i,
      /(?:Unfortunately|Sadly),? I (?:don't|cannot|can't)/i,
    ];

    for (const pattern of hedgingPatterns) {
      const match = response.match(pattern);
      if (match) {
        claims.push({
          claim: match[0],
          confidence: 'ungrounded',
        });
      }
    }
  }

  // Build warning
  let warning: string | undefined;
  const ungrounded = claims.filter((c) => c.confidence === 'ungrounded');

  if (ungrounded.length > 0 && !passed) {
    warning = `Response contains ${ungrounded.length} potentially confabulated claim(s) despite having retrieved sources. ` +
      `Claims: ${ungrounded.map((c) => `"${c.claim}"`).join(', ')}. ` +
      `The agent may be defaulting to generic AI disclaimers instead of checking its knowledge sources.`;
  }

  if (warning) {
    tracer.log('metacognition', 'warn', 'Confabulation audit failed', {
      ungroundedClaims: ungrounded.length,
      retrievedSources: retrievedSources.length,
      isSelfReferential: preflection.isSelfReferential,
    });
  }

  return { passed, claims, warning };
}

// ─────────────────────────────────────────────────────────────────────────────
// Utility
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Check if a message likely requires factual grounding (vs pure generation).
 * Used to decide whether to run preflection at all.
 */
export function requiresGrounding(message: string): boolean {
  const msg = message.toLowerCase();

  // Questions about facts, state, or specifics
  const groundingKeywords = [
    'what is', 'what are', 'where is', 'where are', 'how many',
    'which', 'when did', 'who', 'tell me about', 'explain',
    'describe', 'show me', 'status', 'state of', 'current',
    'hardware', 'running on', 'your', 'yourself', 'you',
    'remember', 'last time', 'history', 'before',
  ];

  return groundingKeywords.some((kw) => msg.includes(kw));
}
