/**
 * Crystal Store — Memory Crystallization (Vision Tier 1)
 *
 * Promotes high-value learned knowledge to permanent, always-available
 * context. Crystals are cached conclusions the LLM doesn't have to
 * re-derive from the journal.
 *
 * Examples of crystals:
 *   - "The user prefers functional patterns over class hierarchies."
 *   - "Tests in this repo use Vitest with the vi.fn() mock pattern."
 *   - "I perform better on refactoring tasks when I read the full file before planning."
 *
 * Crystal lifecycle:
 *   - Formation: During dream cycles, high-recall warm/cool entries get promoted.
 *   - Validation: Candidate crystals are tested against recent experience.
 *   - Invalidation: Contradicted crystals are flagged for review.
 *   - Budget: max_crystals (default 30), token budget (default 500).
 *
 * Storage: ~/.casterly/crystals.yaml (YAML persistence)
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
 * A crystal — a permanent, high-value knowledge entry.
 */
export interface Crystal {
  /** Unique identifier */
  id: string;

  /** The crystallized knowledge */
  content: string;

  /** IDs of source memory entries that motivated this crystal */
  sourceEntries: string[];

  /** ISO timestamp when the crystal was formed */
  formedDate: string;

  /** ISO timestamp when the crystal was last validated */
  lastValidated: string;

  /** How many times this crystal has been recalled or referenced */
  recallCount: number;

  /** Confidence score (0-1). Decays on contradiction, grows on validation. */
  confidence: number;
}

/**
 * Configuration for the crystal store.
 */
export interface CrystalStoreConfig {
  /** Path to crystal store file */
  path: string;

  /** Maximum number of crystals */
  maxCrystals: number;

  /** Token budget for crystals in the hot tier */
  budgetTokens: number;

  /** Minimum confidence to keep a crystal during pruning */
  minConfidence: number;
}

/**
 * Result of a crystallize or dissolve operation.
 */
export interface CrystalResult {
  /** Whether the operation succeeded */
  success: boolean;

  /** The crystal ID if successful */
  crystalId?: string;

  /** Error message if the operation failed */
  error?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: CrystalStoreConfig = {
  path: '~/.casterly/crystals.yaml',
  maxCrystals: 30,
  budgetTokens: 500,
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
  return `crystal-${ts}-${rand}`;
}

/**
 * Rough token estimate (~4 chars per token).
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// ─────────────────────────────────────────────────────────────────────────────
// Simple YAML serializer/deserializer for Crystal[]
// ─────────────────────────────────────────────────────────────────────────────

function serializeCrystals(crystals: Crystal[]): string {
  if (crystals.length === 0) return '# Casterly Crystal Store\ncrystals: []\n';

  const lines: string[] = ['# Casterly Crystal Store', 'crystals:'];

  for (const c of crystals) {
    lines.push(`  - id: ${JSON.stringify(c.id)}`);
    lines.push(`    content: ${JSON.stringify(c.content)}`);
    lines.push(`    source_entries: ${JSON.stringify(c.sourceEntries)}`);
    lines.push(`    formed_date: ${JSON.stringify(c.formedDate)}`);
    lines.push(`    last_validated: ${JSON.stringify(c.lastValidated)}`);
    lines.push(`    recall_count: ${c.recallCount}`);
    lines.push(`    confidence: ${c.confidence}`);
  }

  return lines.join('\n') + '\n';
}

function deserializeCrystals(yaml: string): Crystal[] {
  const crystals: Crystal[] = [];

  // Simple line-by-line parser for our known format
  const lines = yaml.split('\n');
  let current: Partial<Crystal> | null = null;

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed.startsWith('- id:')) {
      if (current && current.id) {
        crystals.push(current as Crystal);
      }
      current = {
        id: parseYamlValue(trimmed.replace('- id:', '').trim()),
        sourceEntries: [],
        recallCount: 0,
        confidence: 1.0,
      };
    } else if (current) {
      if (trimmed.startsWith('content:')) {
        current.content = parseYamlValue(trimmed.replace('content:', '').trim());
      } else if (trimmed.startsWith('source_entries:')) {
        current.sourceEntries = parseYamlArray(trimmed.replace('source_entries:', '').trim());
      } else if (trimmed.startsWith('formed_date:')) {
        current.formedDate = parseYamlValue(trimmed.replace('formed_date:', '').trim());
      } else if (trimmed.startsWith('last_validated:')) {
        current.lastValidated = parseYamlValue(trimmed.replace('last_validated:', '').trim());
      } else if (trimmed.startsWith('recall_count:')) {
        current.recallCount = parseInt(trimmed.replace('recall_count:', '').trim(), 10) || 0;
      } else if (trimmed.startsWith('confidence:')) {
        current.confidence = parseFloat(trimmed.replace('confidence:', '').trim()) || 0;
      }
    }
  }

  if (current && current.id) {
    crystals.push(current as Crystal);
  }

  return crystals;
}

function parseYamlValue(raw: string): string {
  // Handle JSON-quoted strings
  if (raw.startsWith('"') && raw.endsWith('"')) {
    try {
      return JSON.parse(raw) as string;
    } catch {
      return raw.slice(1, -1);
    }
  }
  return raw;
}

function parseYamlArray(raw: string): string[] {
  // Handle JSON arrays
  if (raw.startsWith('[')) {
    try {
      return JSON.parse(raw) as string[];
    } catch {
      return [];
    }
  }
  return [];
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
      this.crystals = deserializeCrystals(content);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        tracer.log('memory', 'warn', 'Failed to load crystal store', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      this.crystals = [];
    }

    this.loaded = true;
    tracer.log('memory', 'debug', `Crystal store loaded: ${this.crystals.length} crystals`);
  }

  /**
   * Save crystals to disk.
   */
  async save(): Promise<void> {
    const tracer = getTracer();
    const resolvedPath = resolvePath(this.config.path);

    await mkdir(dirname(resolvedPath), { recursive: true });
    await writeFile(resolvedPath, serializeCrystals(this.crystals), 'utf8');

    tracer.log('memory', 'debug', `Crystal store saved: ${this.crystals.length} crystals`);
  }

  // ── Crystal Operations ────────────────────────────────────────────────────

  /**
   * Crystallize a new insight — promote it to permanent context.
   */
  crystallize(params: {
    content: string;
    sourceEntries?: string[];
    confidence?: number;
  }): CrystalResult {
    const tracer = getTracer();

    // Enforce max crystals
    if (this.crystals.length >= this.config.maxCrystals) {
      return {
        success: false,
        error: `Maximum crystal limit reached (${this.config.maxCrystals}). Dissolve a crystal first or wait for dream cycle pruning.`,
      };
    }

    // Check token budget
    const currentTokens = this.estimateTotalTokens();
    const newTokens = estimateTokens(params.content);
    if (currentTokens + newTokens > this.config.budgetTokens) {
      return {
        success: false,
        error: `Token budget exceeded. Current: ${currentTokens}/${this.config.budgetTokens}. New crystal needs ~${newTokens} tokens.`,
      };
    }

    // Check for duplicate content
    const duplicate = this.crystals.find(
      (c) => c.content.toLowerCase() === params.content.toLowerCase(),
    );
    if (duplicate) {
      return {
        success: false,
        error: `Duplicate crystal: "${duplicate.id}" already contains this knowledge.`,
      };
    }

    const now = new Date().toISOString();
    const crystal: Crystal = {
      id: generateCrystalId(),
      content: params.content,
      sourceEntries: params.sourceEntries ?? [],
      formedDate: now,
      lastValidated: now,
      recallCount: 0,
      confidence: params.confidence ?? 0.8,
    };

    this.crystals.push(crystal);

    tracer.log('memory', 'info', `Crystal formed: ${crystal.id}`, {
      content: params.content.slice(0, 80),
    });

    return {
      success: true,
      crystalId: crystal.id,
    };
  }

  /**
   * Dissolve (remove) a crystal by ID.
   */
  dissolve(crystalId: string, reason?: string): CrystalResult {
    const tracer = getTracer();

    const index = this.crystals.findIndex((c) => c.id === crystalId);
    if (index < 0) {
      return {
        success: false,
        error: `Crystal not found: ${crystalId}`,
      };
    }

    const removed = this.crystals.splice(index, 1)[0]!;

    tracer.log('memory', 'info', `Crystal dissolved: ${crystalId}`, {
      content: removed.content.slice(0, 80),
      reason: reason?.slice(0, 80),
    });

    return {
      success: true,
      crystalId,
    };
  }

  /**
   * Validate a crystal — confirm it still holds.
   * Increases confidence and updates lastValidated.
   */
  validate(crystalId: string): boolean {
    const crystal = this.crystals.find((c) => c.id === crystalId);
    if (!crystal) return false;

    crystal.lastValidated = new Date().toISOString();
    crystal.confidence = Math.min(1.0, crystal.confidence + 0.05);
    return true;
  }

  /**
   * Contradict a crystal — evidence suggests it may no longer be true.
   * Decreases confidence.
   */
  contradict(crystalId: string): boolean {
    const crystal = this.crystals.find((c) => c.id === crystalId);
    if (!crystal) return false;

    crystal.confidence = Math.max(0, crystal.confidence - 0.15);
    return true;
  }

  /**
   * Record a recall (reference) for a crystal.
   */
  recordRecall(crystalId: string): boolean {
    const crystal = this.crystals.find((c) => c.id === crystalId);
    if (!crystal) return false;

    crystal.recallCount++;
    return true;
  }

  // ── Pruning ─────────────────────────────────────────────────────────────

  /**
   * Prune crystals below the minimum confidence threshold.
   * Returns the IDs of pruned crystals.
   */
  pruneByConfidence(): string[] {
    const pruned: string[] = [];
    const tracer = getTracer();

    this.crystals = this.crystals.filter((c) => {
      if (c.confidence < this.config.minConfidence) {
        pruned.push(c.id);
        return false;
      }
      return true;
    });

    if (pruned.length > 0) {
      tracer.log('memory', 'info', `Pruned ${pruned.length} low-confidence crystals`, {
        ids: pruned,
      });
    }

    return pruned;
  }

  // ── Query ────────────────────────────────────────────────────────────────

  /**
   * Get all crystals, sorted by confidence (highest first).
   */
  getAll(): ReadonlyArray<Crystal> {
    return [...this.crystals].sort((a, b) => b.confidence - a.confidence);
  }

  /**
   * Get a specific crystal by ID.
   */
  getById(id: string): Crystal | undefined {
    return this.crystals.find((c) => c.id === id);
  }

  /**
   * Get the number of crystals.
   */
  count(): number {
    return this.crystals.length;
  }

  /**
   * Estimate total tokens used by all crystals.
   */
  estimateTotalTokens(): number {
    return this.crystals.reduce((sum, c) => sum + estimateTokens(c.content), 0);
  }

  /**
   * Check if loaded.
   */
  isLoaded(): boolean {
    return this.loaded;
  }

  /**
   * Build a section for inclusion in the identity prompt hot tier.
   */
  buildPromptSection(): string {
    if (this.crystals.length === 0) return '';

    const sorted = this.getAll();
    const lines: string[] = ['## Crystals (permanent knowledge)', ''];

    for (const c of sorted) {
      lines.push(`- ${c.content}`);
    }

    return lines.join('\n');
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
