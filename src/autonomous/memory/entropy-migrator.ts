/**
 * Entropy-Based Tier Migration — Information-Theoretic Memory Management (SAGE)
 *
 * Uses Shannon entropy to measure the information density of memory entries.
 * High-entropy entries (rich, diverse content) migrate toward hotter tiers.
 * Low-entropy entries (repetitive, stale) migrate toward colder tiers.
 *
 * Entropy is computed over word frequency distributions. Combined with
 * access frequency and recency, this produces a migration score that
 * determines whether an entry should be promoted or demoted.
 *
 * Part of Advanced Memory: Entropy-Based Tier Migration (SAGE).
 */

import { getTracer } from '../debug.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type MemoryTier = 'hot' | 'warm' | 'cool' | 'cold';

/**
 * A scored memory entry with migration recommendation.
 */
export interface MigrationCandidate {
  /** Entry ID */
  id: string;

  /** Current tier */
  currentTier: MemoryTier;

  /** Recommended tier */
  recommendedTier: MemoryTier;

  /** Shannon entropy of content (bits) */
  entropy: number;

  /** Composite migration score (0-1, higher = hotter) */
  migrationScore: number;

  /** Whether migration is recommended */
  shouldMigrate: boolean;

  /** Direction of recommended migration */
  direction: 'promote' | 'demote' | 'stay';
}

/**
 * Input for entropy scoring — a memory entry with metadata.
 */
export interface EntryForScoring {
  id: string;
  content: string;
  currentTier: MemoryTier;
  accessCount: number;
  lastAccessedAt: string;
  createdAt: string;
}

export interface EntropyMigratorConfig {
  /** Weight for entropy component in migration score */
  entropyWeight: number;

  /** Weight for access frequency component */
  accessWeight: number;

  /** Weight for recency component */
  recencyWeight: number;

  /** Minimum score to be in hot tier */
  hotThreshold: number;

  /** Minimum score to be in warm tier */
  warmThreshold: number;

  /** Minimum score to be in cool tier (below this = cold) */
  coolThreshold: number;
}

/**
 * Report of a migration cycle.
 */
export interface MigrationReport {
  /** Total entries evaluated */
  evaluated: number;

  /** Entries recommended for promotion */
  promotions: number;

  /** Entries recommended for demotion */
  demotions: number;

  /** Entries staying in place */
  stable: number;

  /** Individual candidates */
  candidates: MigrationCandidate[];

  /** Timestamp */
  timestamp: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: EntropyMigratorConfig = {
  entropyWeight: 0.4,
  accessWeight: 0.35,
  recencyWeight: 0.25,
  hotThreshold: 0.8,
  warmThreshold: 0.5,
  coolThreshold: 0.25,
};

const TIER_ORDER: MemoryTier[] = ['cold', 'cool', 'warm', 'hot'];

// ─────────────────────────────────────────────────────────────────────────────
// Shannon Entropy
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Calculate Shannon entropy (bits) of a text based on word frequency.
 * Higher entropy = more diverse/informative content.
 */
export function calculateEntropy(text: string): number {
  const words = text.toLowerCase().replace(/[^\w\s]/g, '').split(/\s+/).filter(Boolean);
  if (words.length === 0) return 0;

  const freq = new Map<string, number>();
  for (const word of words) {
    freq.set(word, (freq.get(word) ?? 0) + 1);
  }

  const total = words.length;
  let entropy = 0;

  for (const count of freq.values()) {
    const p = count / total;
    if (p > 0) {
      entropy -= p * Math.log2(p);
    }
  }

  return entropy;
}

/**
 * Normalize entropy to 0-1 range using a reference maximum.
 * Maximum entropy for N unique words is log2(N).
 */
function normalizeEntropy(entropy: number, wordCount: number): number {
  if (wordCount <= 1) return 0;
  const maxEntropy = Math.log2(wordCount);
  return maxEntropy === 0 ? 0 : Math.min(1, entropy / maxEntropy);
}

// ─────────────────────────────────────────────────────────────────────────────
// Entropy Migrator
// ─────────────────────────────────────────────────────────────────────────────

export class EntropyMigrator {
  private readonly config: EntropyMigratorConfig;

  constructor(config?: Partial<EntropyMigratorConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Evaluate a set of memory entries and produce migration recommendations.
   */
  evaluate(entries: EntryForScoring[]): MigrationReport {
    const tracer = getTracer();
    const candidates: MigrationCandidate[] = [];
    let promotions = 0;
    let demotions = 0;
    let stable = 0;

    // Find max access count for normalization
    const maxAccess = Math.max(1, ...entries.map((e) => e.accessCount));
    const now = Date.now();

    for (const entry of entries) {
      const candidate = this.scoreEntry(entry, maxAccess, now);
      candidates.push(candidate);

      if (candidate.direction === 'promote') promotions++;
      else if (candidate.direction === 'demote') demotions++;
      else stable++;
    }

    const report: MigrationReport = {
      evaluated: entries.length,
      promotions,
      demotions,
      stable,
      candidates,
      timestamp: new Date().toISOString(),
    };

    tracer.log('memory', 'info', `Entropy migration evaluated ${entries.length} entries`, {
      promotions,
      demotions,
      stable,
    });

    return report;
  }

  /**
   * Score a single entry and produce a migration candidate.
   */
  scoreEntry(
    entry: EntryForScoring,
    maxAccess: number,
    nowMs: number,
  ): MigrationCandidate {
    // Entropy component
    const rawEntropy = calculateEntropy(entry.content);
    const wordCount = entry.content.split(/\s+/).filter(Boolean).length;
    const normalizedEntropy = normalizeEntropy(rawEntropy, wordCount);

    // Access frequency component (normalized to 0-1)
    const accessScore = maxAccess > 0 ? entry.accessCount / maxAccess : 0;

    // Recency component (exponential decay over 30 days)
    const lastAccessMs = new Date(entry.lastAccessedAt).getTime();
    const daysSinceAccess = Math.max(0, (nowMs - lastAccessMs) / (1000 * 60 * 60 * 24));
    const recencyScore = Math.exp(-daysSinceAccess / 30);

    // Composite migration score
    const migrationScore =
      this.config.entropyWeight * normalizedEntropy +
      this.config.accessWeight * accessScore +
      this.config.recencyWeight * recencyScore;

    // Determine recommended tier
    let recommendedTier: MemoryTier;
    if (migrationScore >= this.config.hotThreshold) {
      recommendedTier = 'hot';
    } else if (migrationScore >= this.config.warmThreshold) {
      recommendedTier = 'warm';
    } else if (migrationScore >= this.config.coolThreshold) {
      recommendedTier = 'cool';
    } else {
      recommendedTier = 'cold';
    }

    // Determine migration direction
    const currentIdx = TIER_ORDER.indexOf(entry.currentTier);
    const recommendedIdx = TIER_ORDER.indexOf(recommendedTier);
    let direction: 'promote' | 'demote' | 'stay';
    if (recommendedIdx > currentIdx) direction = 'promote';
    else if (recommendedIdx < currentIdx) direction = 'demote';
    else direction = 'stay';

    return {
      id: entry.id,
      currentTier: entry.currentTier,
      recommendedTier,
      entropy: rawEntropy,
      migrationScore,
      shouldMigrate: direction !== 'stay',
      direction,
    };
  }

  /**
   * Get the migration score for a single piece of content (convenience).
   */
  quickScore(content: string): { entropy: number; normalizedEntropy: number } {
    const rawEntropy = calculateEntropy(content);
    const wordCount = content.split(/\s+/).filter(Boolean).length;
    return {
      entropy: rawEntropy,
      normalizedEntropy: normalizeEntropy(rawEntropy, wordCount),
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────────────────────

export function createEntropyMigrator(
  config?: Partial<EntropyMigratorConfig>,
): EntropyMigrator {
  return new EntropyMigrator(config);
}
