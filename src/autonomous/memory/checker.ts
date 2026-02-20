/**
 * Checker Pattern — Memory Validation Guard (SAGE)
 *
 * Before storing or acting on a memory, the checker runs a series of
 * validation checks:
 *
 *   1. Consistency: Does this contradict existing knowledge?
 *   2. Relevance: Is this worth storing? (entropy/uniqueness check)
 *   3. Duplicate: Is this already known?
 *   4. Freshness: Is this information still timely?
 *   5. Safety: Does this contain sensitive data that shouldn't be stored?
 *
 * Each check returns a pass/fail with an explanation, and the checker
 * produces a composite verdict. The caller decides whether to proceed.
 *
 * Part of Advanced Memory: Checker Pattern (SAGE).
 */

import { getTracer } from '../debug.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type CheckName = 'consistency' | 'relevance' | 'duplicate' | 'freshness' | 'safety';

export type Verdict = 'pass' | 'fail' | 'warn';

/**
 * Result of a single check.
 */
export interface CheckResult {
  check: CheckName;
  verdict: Verdict;
  explanation: string;
  score: number; // 0-1, higher = better
}

/**
 * Composite result of all checks for a memory candidate.
 */
export interface CheckerVerdict {
  /** Overall pass/fail */
  approved: boolean;

  /** Individual check results */
  checks: CheckResult[];

  /** Composite score (0-1) */
  compositeScore: number;

  /** Summary explanation */
  summary: string;
}

/**
 * Existing knowledge for the checker to compare against.
 */
export interface ExistingKnowledge {
  id: string;
  content: string;
  category?: string;
}

export interface CheckerConfig {
  /** Minimum composite score to approve (0-1) */
  approvalThreshold: number;

  /** Whether to enable each check */
  enabledChecks: Record<CheckName, boolean>;

  /** Patterns that indicate sensitive data (should not be stored) */
  sensitivePatterns: RegExp[];

  /** Minimum entropy for relevance check */
  minEntropy: number;

  /** Similarity threshold for duplicate detection */
  duplicateThreshold: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: CheckerConfig = {
  approvalThreshold: 0.5,
  enabledChecks: {
    consistency: true,
    relevance: true,
    duplicate: true,
    freshness: true,
    safety: true,
  },
  sensitivePatterns: [
    /\b(?:password|passwd|secret|token|api[_-]?key)\s*[:=]/i,
    /\b\d{3}-\d{2}-\d{4}\b/, // SSN
    /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/, // email
    /\b(?:sk|pk)[-_][a-zA-Z0-9]{20,}\b/, // API keys
  ],
  minEntropy: 2.0,
  duplicateThreshold: 0.8,
};

// ─────────────────────────────────────────────────────────────────────────────
// Checker
// ─────────────────────────────────────────────────────────────────────────────

export class MemoryChecker {
  private readonly config: CheckerConfig;

  constructor(config?: Partial<CheckerConfig>) {
    this.config = {
      ...DEFAULT_CONFIG,
      ...config,
      enabledChecks: { ...DEFAULT_CONFIG.enabledChecks, ...config?.enabledChecks },
      sensitivePatterns: config?.sensitivePatterns ?? DEFAULT_CONFIG.sensitivePatterns,
    };
  }

  /**
   * Run all enabled checks on a memory candidate.
   */
  check(
    candidate: { content: string; category?: string },
    existingKnowledge: ExistingKnowledge[],
  ): CheckerVerdict {
    const tracer = getTracer();
    const checks: CheckResult[] = [];

    if (this.config.enabledChecks.consistency) {
      checks.push(this.checkConsistency(candidate.content, existingKnowledge));
    }

    if (this.config.enabledChecks.relevance) {
      checks.push(this.checkRelevance(candidate.content));
    }

    if (this.config.enabledChecks.duplicate) {
      checks.push(this.checkDuplicate(candidate.content, existingKnowledge));
    }

    if (this.config.enabledChecks.freshness) {
      checks.push(this.checkFreshness(candidate.content));
    }

    if (this.config.enabledChecks.safety) {
      checks.push(this.checkSafety(candidate.content));
    }

    // Compute composite score
    const compositeScore = checks.length > 0
      ? checks.reduce((sum, c) => sum + c.score, 0) / checks.length
      : 1.0;

    // Any hard failure = rejected
    const hasFail = checks.some((c) => c.verdict === 'fail');
    const approved = !hasFail && compositeScore >= this.config.approvalThreshold;

    // Build summary
    const failedChecks = checks.filter((c) => c.verdict === 'fail');
    const warnChecks = checks.filter((c) => c.verdict === 'warn');

    let summary: string;
    if (approved) {
      summary = warnChecks.length > 0
        ? `Approved with ${warnChecks.length} warning(s): ${warnChecks.map((c) => c.check).join(', ')}`
        : 'All checks passed';
    } else {
      summary = `Rejected: ${failedChecks.map((c) => `${c.check} (${c.explanation})`).join('; ')}`;
    }

    const verdict: CheckerVerdict = {
      approved,
      checks,
      compositeScore,
      summary,
    };

    tracer.log('memory', 'debug', `Checker verdict: ${approved ? 'approved' : 'rejected'}`, {
      score: compositeScore.toFixed(2),
      checks: checks.map((c) => `${c.check}:${c.verdict}`).join(','),
    });

    return verdict;
  }

  // ── Individual Checks ─────────────────────────────────────────────────────

  private checkConsistency(content: string, existing: ExistingKnowledge[]): CheckResult {
    const contentLower = content.toLowerCase();
    const negationWords = ['not', 'never', 'no longer', 'incorrect', 'wrong', 'instead'];

    for (const entry of existing) {
      const similarity = jaccardSimilarity(content, entry.content);

      // If similar but contains negation — potential contradiction
      if (similarity > 0.3) {
        const hasNegation = negationWords.some((w) => contentLower.includes(w));
        const entryHasNegation = negationWords.some((w) => entry.content.toLowerCase().includes(w));

        if (hasNegation !== entryHasNegation) {
          return {
            check: 'consistency',
            verdict: 'warn',
            explanation: `May contradict existing knowledge (${entry.id})`,
            score: 0.4,
          };
        }
      }
    }

    return {
      check: 'consistency',
      verdict: 'pass',
      explanation: 'No contradictions detected',
      score: 1.0,
    };
  }

  private checkRelevance(content: string): CheckResult {
    // Check if content is too short to be useful (before entropy)
    const wordCount = content.split(/\s+/).filter(Boolean).length;
    if (wordCount < 3) {
      return {
        check: 'relevance',
        verdict: 'fail',
        explanation: 'Content too short to be meaningful',
        score: 0.1,
      };
    }

    const entropy = simpleEntropy(content);

    if (entropy < this.config.minEntropy) {
      return {
        check: 'relevance',
        verdict: 'warn',
        explanation: `Low information density (entropy: ${entropy.toFixed(1)})`,
        score: 0.3,
      };
    }

    return {
      check: 'relevance',
      verdict: 'pass',
      explanation: `Sufficient information density (entropy: ${entropy.toFixed(1)})`,
      score: Math.min(1.0, entropy / 5.0),
    };
  }

  private checkDuplicate(content: string, existing: ExistingKnowledge[]): CheckResult {
    let maxSimilarity = 0;
    let closestId = '';

    for (const entry of existing) {
      const sim = jaccardSimilarity(content, entry.content);
      if (sim > maxSimilarity) {
        maxSimilarity = sim;
        closestId = entry.id;
      }
    }

    if (maxSimilarity >= this.config.duplicateThreshold) {
      return {
        check: 'duplicate',
        verdict: 'fail',
        explanation: `Duplicate of existing memory ${closestId} (${(maxSimilarity * 100).toFixed(0)}% similar)`,
        score: 0,
      };
    }

    if (maxSimilarity >= this.config.duplicateThreshold * 0.7) {
      return {
        check: 'duplicate',
        verdict: 'warn',
        explanation: `Near-duplicate of ${closestId} (${(maxSimilarity * 100).toFixed(0)}% similar)`,
        score: 0.5,
      };
    }

    return {
      check: 'duplicate',
      verdict: 'pass',
      explanation: 'No duplicates found',
      score: 1.0,
    };
  }

  private checkFreshness(content: string): CheckResult {
    // Check for stale date references
    const datePattern = /\b(20[12]\d[-/]\d{1,2}[-/]\d{1,2})\b/;
    const match = content.match(datePattern);

    if (match) {
      const refDate = new Date(match[1]!.replace(/\//g, '-'));
      const daysSince = (Date.now() - refDate.getTime()) / (1000 * 60 * 60 * 24);

      if (daysSince > 365) {
        return {
          check: 'freshness',
          verdict: 'warn',
          explanation: `References date ${match[1]} (over a year old)`,
          score: 0.3,
        };
      }
    }

    return {
      check: 'freshness',
      verdict: 'pass',
      explanation: 'Content appears timely',
      score: 1.0,
    };
  }

  private checkSafety(content: string): CheckResult {
    for (const pattern of this.config.sensitivePatterns) {
      if (pattern.test(content)) {
        return {
          check: 'safety',
          verdict: 'fail',
          explanation: 'Contains potentially sensitive data',
          score: 0,
        };
      }
    }

    return {
      check: 'safety',
      verdict: 'pass',
      explanation: 'No sensitive data detected',
      score: 1.0,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Utility Functions
// ─────────────────────────────────────────────────────────────────────────────

function simpleEntropy(text: string): number {
  const words = text.toLowerCase().replace(/[^\w\s]/g, '').split(/\s+/).filter(Boolean);
  if (words.length === 0) return 0;

  const freq = new Map<string, number>();
  for (const word of words) {
    freq.set(word, (freq.get(word) ?? 0) + 1);
  }

  let entropy = 0;
  for (const count of freq.values()) {
    const p = count / words.length;
    if (p > 0) entropy -= p * Math.log2(p);
  }

  return entropy;
}

function jaccardSimilarity(a: string, b: string): number {
  const setA = new Set(a.toLowerCase().split(/\s+/).filter((w) => w.length >= 3));
  const setB = new Set(b.toLowerCase().split(/\s+/).filter((w) => w.length >= 3));

  if (setA.size === 0 && setB.size === 0) return 1.0;
  if (setA.size === 0 || setB.size === 0) return 0;

  let intersection = 0;
  for (const word of setA) {
    if (setB.has(word)) intersection++;
  }

  return intersection / (setA.size + setB.size - intersection);
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────────────────────

export function createMemoryChecker(
  config?: Partial<CheckerConfig>,
): MemoryChecker {
  return new MemoryChecker(config);
}
