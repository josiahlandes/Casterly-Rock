/**
 * AUDN Consolidation Cycle — Memory Consolidation (Mem0)
 *
 * For each incoming memory, decides one of four actions:
 *   - Add: Store as new memory (no overlap with existing)
 *   - Update: Merge into an existing memory (partial overlap)
 *   - Delete: Remove an existing memory (contradicted or superseded)
 *   - Nothing: Discard the incoming memory (already known, low value)
 *
 * The AUDN cycle runs during dream phases and processes pending
 * memory candidates that accumulated during active cycles.
 *
 * Storage: ~/.casterly/memory/audn-queue.json (pending candidates)
 *
 * Part of Advanced Memory: AUDN Consolidation Cycle (Mem0).
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { getTracer } from '../debug.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type AudnDecision = 'add' | 'update' | 'delete' | 'nothing';

/**
 * A candidate memory awaiting AUDN evaluation.
 */
export interface MemoryCandidate {
  /** Unique ID */
  id: string;

  /** Content of the candidate memory */
  content: string;

  /** Source subsystem (crystal, journal, constitution, etc.) */
  source: string;

  /** ISO timestamp when this candidate was queued */
  queuedAt: string;

  /** Tags for categorization */
  tags: string[];
}

/**
 * Result of an AUDN evaluation for a single candidate.
 */
export interface AudnEvaluation {
  /** The candidate that was evaluated */
  candidateId: string;

  /** The decision made */
  decision: AudnDecision;

  /** ID of the existing memory that was updated or deleted (if applicable) */
  targetId?: string;

  /** Similarity score with the closest existing memory */
  similarity: number;

  /** Reason for the decision */
  reason: string;
}

/**
 * Summary of a full AUDN consolidation run.
 */
export interface ConsolidationReport {
  /** Total candidates processed */
  processed: number;

  /** Count per decision type */
  added: number;
  updated: number;
  deleted: number;
  skipped: number;

  /** Individual evaluations */
  evaluations: AudnEvaluation[];

  /** ISO timestamp */
  timestamp: string;

  /** Duration in ms */
  durationMs: number;
}

export interface AudnConfig {
  /** Path to the queue file */
  queuePath: string;

  /** Maximum candidates in queue before forced consolidation */
  maxQueueSize: number;

  /** Similarity threshold for "update" (0-1) */
  updateThreshold: number;

  /** Similarity threshold for "nothing" (0-1, above this = already known) */
  nothingThreshold: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: AudnConfig = {
  queuePath: '~/.casterly/memory/audn-queue.json',
  maxQueueSize: 100,
  updateThreshold: 0.4,
  nothingThreshold: 0.85,
};

function resolvePath(filePath: string): string {
  if (filePath.startsWith('~')) {
    const home = process.env['HOME'] ?? process.env['USERPROFILE'] ?? '/tmp';
    return filePath.replace('~', home);
  }
  return filePath;
}

function generateCandidateId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).substring(2, 6);
  return `audn-${ts}-${rand}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Text Similarity
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Simple Jaccard similarity on word bigrams. Sufficient for deciding
 * overlap without requiring an embedding model.
 */
function bigramSimilarity(a: string, b: string): number {
  const bigramsA = toBigrams(a.toLowerCase());
  const bigramsB = toBigrams(b.toLowerCase());

  if (bigramsA.size === 0 && bigramsB.size === 0) return 1.0;
  if (bigramsA.size === 0 || bigramsB.size === 0) return 0.0;

  let intersection = 0;
  for (const bg of bigramsA) {
    if (bigramsB.has(bg)) intersection++;
  }

  const union = bigramsA.size + bigramsB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function toBigrams(text: string): Set<string> {
  const words = text.replace(/[^\w\s]/g, '').split(/\s+/).filter(Boolean);
  const bigrams = new Set<string>();
  for (let i = 0; i < words.length - 1; i++) {
    bigrams.add(`${words[i]} ${words[i + 1]}`);
  }
  // Also add individual words as unigrams for short texts
  for (const w of words) {
    if (w.length >= 3) bigrams.add(w);
  }
  return bigrams;
}

// ─────────────────────────────────────────────────────────────────────────────
// AUDN Consolidator
// ─────────────────────────────────────────────────────────────────────────────

export class AudnConsolidator {
  private readonly config: AudnConfig;
  private queue: MemoryCandidate[] = [];
  private loaded: boolean = false;

  constructor(config?: Partial<AudnConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // ── Persistence ──────────────────────────────────────────────────────────

  async load(): Promise<void> {
    const tracer = getTracer();
    const resolvedPath = resolvePath(this.config.queuePath);

    try {
      const content = await readFile(resolvedPath, 'utf8');
      const data = JSON.parse(content) as { queue: MemoryCandidate[] };
      this.queue = data.queue ?? [];
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        tracer.log('memory', 'warn', 'Failed to load AUDN queue', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      this.queue = [];
    }

    this.loaded = true;
    tracer.log('memory', 'debug', `AUDN queue loaded: ${this.queue.length} candidates`);
  }

  async save(): Promise<void> {
    const tracer = getTracer();
    const resolvedPath = resolvePath(this.config.queuePath);

    await mkdir(dirname(resolvedPath), { recursive: true });
    await writeFile(
      resolvedPath,
      JSON.stringify({ queue: this.queue }, null, 2),
      'utf8',
    );

    tracer.log('memory', 'debug', `AUDN queue saved: ${this.queue.length} candidates`);
  }

  // ── Queue Management ──────────────────────────────────────────────────────

  /**
   * Enqueue a new memory candidate for AUDN evaluation.
   */
  enqueue(params: {
    content: string;
    source: string;
    tags?: string[];
  }): string {
    const candidate: MemoryCandidate = {
      id: generateCandidateId(),
      content: params.content,
      source: params.source,
      queuedAt: new Date().toISOString(),
      tags: params.tags ?? [],
    };

    this.queue.push(candidate);

    // Trim queue if over limit (drop oldest)
    if (this.queue.length > this.config.maxQueueSize) {
      this.queue = this.queue.slice(-this.config.maxQueueSize);
    }

    return candidate.id;
  }

  /**
   * Get the number of pending candidates.
   */
  queueSize(): number {
    return this.queue.length;
  }

  // ── Consolidation ─────────────────────────────────────────────────────────

  /**
   * Run the AUDN consolidation cycle. Evaluates each queued candidate
   * against the provided existing memories and returns a report.
   *
   * @param existingMemories - The current known memories (content strings keyed by ID)
   */
  consolidate(existingMemories: Map<string, string>): ConsolidationReport {
    const tracer = getTracer();
    const startMs = Date.now();

    const report: ConsolidationReport = {
      processed: 0,
      added: 0,
      updated: 0,
      deleted: 0,
      skipped: 0,
      evaluations: [],
      timestamp: new Date().toISOString(),
      durationMs: 0,
    };

    for (const candidate of this.queue) {
      const evaluation = this.evaluate(candidate, existingMemories);
      report.evaluations.push(evaluation);
      report.processed++;

      switch (evaluation.decision) {
        case 'add': report.added++; break;
        case 'update': report.updated++; break;
        case 'delete': report.deleted++; break;
        case 'nothing': report.skipped++; break;
      }
    }

    // Clear the queue after processing
    this.queue = [];

    report.durationMs = Date.now() - startMs;

    tracer.log('memory', 'info', `AUDN consolidation complete`, {
      processed: report.processed,
      added: report.added,
      updated: report.updated,
      deleted: report.deleted,
      skipped: report.skipped,
    });

    return report;
  }

  /**
   * Evaluate a single candidate against existing memories.
   */
  private evaluate(
    candidate: MemoryCandidate,
    existingMemories: Map<string, string>,
  ): AudnEvaluation {
    let bestSimilarity = 0;
    let bestMatchId = '';

    for (const [id, content] of existingMemories) {
      const sim = bigramSimilarity(candidate.content, content);
      if (sim > bestSimilarity) {
        bestSimilarity = sim;
        bestMatchId = id;
      }
    }

    // Decision logic
    if (bestSimilarity >= this.config.nothingThreshold) {
      return {
        candidateId: candidate.id,
        decision: 'nothing',
        targetId: bestMatchId,
        similarity: bestSimilarity,
        reason: `Already known (${(bestSimilarity * 100).toFixed(0)}% similar to ${bestMatchId})`,
      };
    }

    if (bestSimilarity >= this.config.updateThreshold) {
      // Check if the candidate is a contradiction or an extension
      const isContradiction = this.detectContradiction(
        candidate.content,
        existingMemories.get(bestMatchId) ?? '',
      );

      if (isContradiction) {
        return {
          candidateId: candidate.id,
          decision: 'delete',
          targetId: bestMatchId,
          similarity: bestSimilarity,
          reason: `Contradicts existing memory ${bestMatchId} — superseding`,
        };
      }

      return {
        candidateId: candidate.id,
        decision: 'update',
        targetId: bestMatchId,
        similarity: bestSimilarity,
        reason: `Partial overlap (${(bestSimilarity * 100).toFixed(0)}%) with ${bestMatchId} — merging`,
      };
    }

    return {
      candidateId: candidate.id,
      decision: 'add',
      similarity: bestSimilarity,
      reason: `No significant overlap (best match ${(bestSimilarity * 100).toFixed(0)}%) — adding as new`,
    };
  }

  /**
   * Simple contradiction detection via negation keywords.
   */
  private detectContradiction(candidate: string, existing: string): boolean {
    const negationPatterns = [
      /\bnot\b/i, /\bnever\b/i, /\bno longer\b/i,
      /\binstead\b/i, /\brather than\b/i, /\bactually\b/i,
      /\bcontrary\b/i, /\bincorrect\b/i, /\bwrong\b/i,
    ];

    const candidateLower = candidate.toLowerCase();
    const existingLower = existing.toLowerCase();

    // If candidate uses negation words and shares significant vocabulary
    // with existing, it's likely a contradiction
    const hasNegation = negationPatterns.some((p) => p.test(candidateLower));
    const sharedWords = this.getSharedWords(candidateLower, existingLower);

    return hasNegation && sharedWords >= 3;
  }

  private getSharedWords(a: string, b: string): number {
    const wordsA = new Set(a.split(/\s+/).filter((w) => w.length >= 3));
    const wordsB = new Set(b.split(/\s+/).filter((w) => w.length >= 3));
    let shared = 0;
    for (const w of wordsA) {
      if (wordsB.has(w)) shared++;
    }
    return shared;
  }

  // ── Query ──────────────────────────────────────────────────────────────────

  isLoaded(): boolean {
    return this.loaded;
  }

  getQueue(): ReadonlyArray<MemoryCandidate> {
    return this.queue;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────────────────────

export function createAudnConsolidator(
  config?: Partial<AudnConfig>,
): AudnConsolidator {
  return new AudnConsolidator(config);
}
