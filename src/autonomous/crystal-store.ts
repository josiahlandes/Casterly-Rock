/**
 * Crystal Store — Permanent, always-available knowledge
 *
 * Crystals are high-value learned insights that have been promoted from
 * the warm/cool memory tiers to permanent, always-loaded context. They
 * represent stable facts, patterns, and preferences that Tyrion doesn't
 * have to re-derive from the journal each time.
 *
 * Examples of crystals:
 *   - "The user prefers functional patterns over class hierarchies."
 *   - "Tests in this repo use Vitest with the vi.fn() mock pattern."
 *   - "I perform better on refactoring tasks when I read the full file first."
 *
 * Crystal lifecycle:
 *   - Formation: During dream cycles, high-recall entries are promoted.
 *   - Validation: Candidates are tested against recent experience.
 *   - Invalidation: Contradicted crystals are flagged for review.
 *   - Budget: Crystals share the hot tier token budget (max_crystals limit).
 *
 * Storage: ~/.casterly/crystals.yaml
 *
 * Part of Vision Tier 1: Memory Crystallization.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { getTracer } from './debug.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A single crystal — a permanently available insight.
 */
export interface Crystal {
  /** Unique identifier */
  id: string;

  /** The insight itself — a concise, actionable statement */
  content: string;

  /** IDs of the source memory entries that motivated this crystal */
  sourceEntries: string[];

  /** When this crystal was first formed */
  formedDate: string;

  /** When this crystal was last validated against recent experience */
  lastValidated: string;

  /** How many times this crystal has been recalled or referenced */
  recallCount: number;

  /** Confidence score (0-1). Starts high, decays if contradicted. */
  confidence: number;
}

/**
 * Configuration for the crystal store.
 */
export interface CrystalStoreConfig {
  /** Path to the crystals YAML file */
  path: string;

  /** Maximum number of crystals allowed */
  maxCrystals: number;

  /** Token budget for crystals in the hot tier */
  crystalsBudgetTokens: number;

  /** Minimum confidence to keep a crystal during pruning */
  minConfidence: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: CrystalStoreConfig = {
  path: '~/.casterly/crystals.yaml',
  maxCrystals: 30,
  crystalsBudgetTokens: 500,
  minConfidence: 0.3,
};

function resolvePath(filePath: string): string {
  if (filePath.startsWith('~')) {
    const home = process.env['HOME'] ?? process.env['USERPROFILE'] ?? '/tmp';
    return filePath.replace('~', home);
  }
  return filePath;
}

function generateCrystalId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).substring(2, 6);
  return `crys-${ts}-${rand}`;
}

/**
 * Estimate tokens from text (conservative: ~3.5 chars/token).
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}

// ─────────────────────────────────────────────────────────────────────────────
// Crystal Store
// ─────────────────────────────────────────────────────────────────────────────

export class CrystalStore {
  private readonly config: CrystalStoreConfig;
  private crystals: Crystal[] = [];
  private loaded: boolean = false;

  constructor(config?: Partial<CrystalStoreConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // ── Persistence ──────────────────────────────────────────────────────────

  /**
   * Load crystals from disk.
   */
  async load(): Promise<void> {
    const tracer = getTracer();
    const resolvedPath = resolvePath(this.config.path);

    try {
      const content = await readFile(resolvedPath, 'utf8');
      const parsed = JSON.parse(content) as Crystal[];

      if (Array.isArray(parsed)) {
        this.crystals = parsed;
      } else {
        this.crystals = [];
      }

      this.loaded = true;
      tracer.log('memory', 'debug', `Crystal store loaded: ${this.crystals.length} crystals`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        this.crystals = [];
        this.loaded = true;
        tracer.log('memory', 'debug', 'No existing crystals found, starting fresh');
      } else {
        tracer.log('memory', 'warn', 'Failed to load crystals', {
          error: err instanceof Error ? err.message : String(err),
        });
        this.crystals = [];
        this.loaded = true;
      }
    }
  }

  /**
   * Save crystals to disk.
   */
  async save(): Promise<void> {
    const tracer = getTracer();
    const resolvedPath = resolvePath(this.config.path);

    await mkdir(dirname(resolvedPath), { recursive: true });
    await writeFile(resolvedPath, JSON.stringify(this.crystals, null, 2), 'utf8');

    tracer.log('memory', 'debug', `Crystal store saved: ${this.crystals.length} crystals`);
  }

  // ── Crystal Operations ───────────────────────────────────────────────────

  /**
   * Add a new crystal. Returns the crystal ID, or null if the budget
   * is exceeded and no low-confidence crystal can be evicted.
   */
  crystallize(params: {
    content: string;
    sourceEntries: string[];
    confidence: number;
  }): Crystal | null {
    const tracer = getTracer();

    // Check for duplicates (similar content)
    const existingDuplicate = this.crystals.find(
      (c) => c.content.toLowerCase() === params.content.toLowerCase(),
    );
    if (existingDuplicate) {
      tracer.log('memory', 'debug', `Crystal already exists: ${existingDuplicate.id}`);
      // Strengthen existing crystal
      existingDuplicate.confidence = Math.min(1.0, existingDuplicate.confidence + 0.05);
      existingDuplicate.lastValidated = new Date().toISOString();
      existingDuplicate.recallCount++;
      return existingDuplicate;
    }

    // Check budget
    if (this.crystals.length >= this.config.maxCrystals) {
      // Try to evict the lowest-confidence crystal
      const lowestConfidence = this.crystals.reduce((min, c) =>
        c.confidence < min.confidence ? c : min,
      );

      if (lowestConfidence.confidence < params.confidence) {
        this.crystals = this.crystals.filter((c) => c.id !== lowestConfidence.id);
        tracer.log('memory', 'info', `Evicted low-confidence crystal: ${lowestConfidence.id} (${lowestConfidence.confidence.toFixed(2)})`);
      } else {
        tracer.log('memory', 'warn', 'Crystal budget full, cannot add new crystal');
        return null;
      }
    }

    // Check token budget
    const currentTokens = this.estimateTotalTokens();
    const newTokens = estimateTokens(params.content);
    if (currentTokens + newTokens > this.config.crystalsBudgetTokens) {
      tracer.log('memory', 'warn', 'Crystal token budget exceeded', {
        current: currentTokens,
        new: newTokens,
        budget: this.config.crystalsBudgetTokens,
      });
      return null;
    }

    const crystal: Crystal = {
      id: generateCrystalId(),
      content: params.content,
      sourceEntries: params.sourceEntries,
      formedDate: new Date().toISOString(),
      lastValidated: new Date().toISOString(),
      recallCount: 0,
      confidence: Math.max(0, Math.min(1, params.confidence)),
    };

    this.crystals.push(crystal);

    tracer.log('memory', 'info', `New crystal formed: ${crystal.id}`, {
      confidence: crystal.confidence,
      content: crystal.content.slice(0, 80),
    });

    return crystal;
  }

  /**
   * Dissolve (remove) a crystal. Returns true if found and removed.
   */
  dissolve(crystalId: string, reason: string): boolean {
    const tracer = getTracer();
    const index = this.crystals.findIndex((c) => c.id === crystalId);

    if (index === -1) {
      return false;
    }

    const dissolved = this.crystals[index]!;
    this.crystals.splice(index, 1);

    tracer.log('memory', 'info', `Crystal dissolved: ${crystalId}`, {
      content: dissolved.content.slice(0, 80),
      reason,
    });

    return true;
  }

  /**
   * Update a crystal's content or confidence.
   */
  update(crystalId: string, updates: {
    content?: string;
    confidence?: number;
  }): boolean {
    const crystal = this.crystals.find((c) => c.id === crystalId);
    if (!crystal) return false;

    if (updates.content !== undefined) {
      crystal.content = updates.content;
    }
    if (updates.confidence !== undefined) {
      crystal.confidence = Math.max(0, Math.min(1, updates.confidence));
    }
    crystal.lastValidated = new Date().toISOString();

    return true;
  }

  /**
   * Validate a crystal — mark it as recently confirmed.
   */
  validate(crystalId: string): boolean {
    const crystal = this.crystals.find((c) => c.id === crystalId);
    if (!crystal) return false;

    crystal.lastValidated = new Date().toISOString();
    crystal.confidence = Math.min(1.0, crystal.confidence + 0.02);
    return true;
  }

  /**
   * Weaken a crystal — reduce confidence when it contradicts experience.
   */
  weaken(crystalId: string, amount: number = 0.1): boolean {
    const crystal = this.crystals.find((c) => c.id === crystalId);
    if (!crystal) return false;

    crystal.confidence = Math.max(0, crystal.confidence - amount);
    return true;
  }

  /**
   * Prune crystals below the minimum confidence threshold.
   * Returns the IDs of pruned crystals.
   */
  prune(): string[] {
    const tracer = getTracer();
    const pruned: string[] = [];

    this.crystals = this.crystals.filter((c) => {
      if (c.confidence < this.config.minConfidence) {
        pruned.push(c.id);
        tracer.log('memory', 'info', `Pruned crystal: ${c.id} (confidence: ${c.confidence.toFixed(2)})`);
        return false;
      }
      return true;
    });

    return pruned;
  }

  // ── Query ────────────────────────────────────────────────────────────────

  /**
   * Get all crystals, sorted by confidence descending.
   */
  getAll(): ReadonlyArray<Crystal> {
    return [...this.crystals].sort((a, b) => b.confidence - a.confidence);
  }

  /**
   * Get a crystal by ID.
   */
  get(crystalId: string): Crystal | undefined {
    return this.crystals.find((c) => c.id === crystalId);
  }

  /**
   * Get the number of crystals.
   */
  count(): number {
    return this.crystals.length;
  }

  /**
   * Check if the store has been loaded.
   */
  isLoaded(): boolean {
    return this.loaded;
  }

  // ── Hot Tier Integration ─────────────────────────────────────────────────

  /**
   * Build a text representation of all crystals for inclusion in the
   * identity prompt (hot tier). Respects the token budget.
   */
  buildCrystalsPrompt(): string {
    if (this.crystals.length === 0) return '';

    const sorted = this.getAll();
    const lines: string[] = [];
    let tokenCount = 0;

    for (const crystal of sorted) {
      const line = `- ${crystal.content} (confidence: ${crystal.confidence.toFixed(2)})`;
      const lineTokens = estimateTokens(line);

      if (tokenCount + lineTokens > this.config.crystalsBudgetTokens) {
        break;
      }

      lines.push(line);
      tokenCount += lineTokens;
    }

    if (lines.length === 0) return '';

    return lines.join('\n');
  }

  /**
   * Estimate total tokens across all crystals.
   */
  estimateTotalTokens(): number {
    return this.crystals.reduce(
      (sum, c) => sum + estimateTokens(c.content),
      0,
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────────────────────

export function createCrystalStore(
  config?: Partial<CrystalStoreConfig>,
): CrystalStore {
  return new CrystalStore(config);
}
