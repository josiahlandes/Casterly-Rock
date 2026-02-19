/**
 * Constitution Store — Tyrion's self-authored operational rules
 *
 * The constitution stores tactical rules Tyrion has authored about his own
 * behavior, discovered through experience. Not safety rules (those are
 * immutable in the safety boundary), but operational rules with evidence.
 *
 * Rules are versioned, timestamped, linked to the journal entries that
 * motivated them, and have confidence scores that decay or strengthen
 * based on outcomes.
 *
 * Example rules:
 *   - "For tasks touching 3+ files, generate a plan before starting."
 *   - "When the coding model returns TypeScript with `any`, flag for review."
 *   - "Prefer recall_journal over recall for debugging-related context."
 *
 * Rule lifecycle:
 *   - Creation: Observed pattern (usually a failure) → create_rule tool.
 *   - Strengthening: Following rule leads to success → confidence increases.
 *   - Decay: Violating rule and succeeding → confidence decreases.
 *   - Pruning: Below threshold → removed during dream cycles.
 *   - Evolution: Rules can be refined based on more experience.
 *
 * Storage: ~/.casterly/constitution.yaml
 *
 * Part of Vision Tier 1: Constitutional Self-Governance.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { getTracer } from './debug.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A single constitutional rule.
 */
export interface ConstitutionalRule {
  /** Unique identifier */
  id: string;

  /** The rule text — a concise, actionable directive */
  rule: string;

  /** When this rule was created */
  added: string;

  /** Journal entry reference that motivated this rule */
  motivation: string;

  /** Confidence score (0-1). Increases with success, decays on violation+success. */
  confidence: number;

  /** How many times this rule was relevant (evaluated) */
  invocations: number;

  /** How many times following this rule led to success */
  successes: number;

  /** Tags for categorization */
  tags: string[];
}

/**
 * Configuration for the constitution store.
 */
export interface ConstitutionStoreConfig {
  /** Path to the constitution YAML file */
  path: string;

  /** Maximum number of rules allowed */
  maxRules: number;

  /** Token budget for constitution in the hot tier */
  constitutionBudgetTokens: number;

  /** Minimum confidence to keep a rule during pruning */
  minConfidence: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: ConstitutionStoreConfig = {
  path: '~/.casterly/constitution.yaml',
  maxRules: 50,
  constitutionBudgetTokens: 500,
  minConfidence: 0.3,
};

function resolvePath(filePath: string): string {
  if (filePath.startsWith('~')) {
    const home = process.env['HOME'] ?? process.env['USERPROFILE'] ?? '/tmp';
    return filePath.replace('~', home);
  }
  return filePath;
}

function generateRuleId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).substring(2, 6);
  return `rule-${ts}-${rand}`;
}

/**
 * Estimate tokens from text (conservative: ~3.5 chars/token).
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}

// ─────────────────────────────────────────────────────────────────────────────
// Constitution Store
// ─────────────────────────────────────────────────────────────────────────────

export class ConstitutionStore {
  private readonly config: ConstitutionStoreConfig;
  private rules: ConstitutionalRule[] = [];
  private loaded: boolean = false;

  constructor(config?: Partial<ConstitutionStoreConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // ── Persistence ──────────────────────────────────────────────────────────

  /**
   * Load rules from disk.
   */
  async load(): Promise<void> {
    const tracer = getTracer();
    const resolvedPath = resolvePath(this.config.path);

    try {
      const content = await readFile(resolvedPath, 'utf8');
      const parsed = JSON.parse(content) as ConstitutionalRule[];

      if (Array.isArray(parsed)) {
        this.rules = parsed;
      } else {
        this.rules = [];
      }

      this.loaded = true;
      tracer.log('memory', 'debug', `Constitution loaded: ${this.rules.length} rules`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        this.rules = [];
        this.loaded = true;
        tracer.log('memory', 'debug', 'No existing constitution found, starting fresh');
      } else {
        tracer.log('memory', 'warn', 'Failed to load constitution', {
          error: err instanceof Error ? err.message : String(err),
        });
        this.rules = [];
        this.loaded = true;
      }
    }
  }

  /**
   * Save rules to disk.
   */
  async save(): Promise<void> {
    const tracer = getTracer();
    const resolvedPath = resolvePath(this.config.path);

    await mkdir(dirname(resolvedPath), { recursive: true });
    await writeFile(resolvedPath, JSON.stringify(this.rules, null, 2), 'utf8');

    tracer.log('memory', 'debug', `Constitution saved: ${this.rules.length} rules`);
  }

  // ── Rule Operations ──────────────────────────────────────────────────────

  /**
   * Create a new rule. Returns the rule, or null if the budget is full.
   */
  createRule(params: {
    rule: string;
    motivation: string;
    confidence: number;
    tags?: string[];
  }): ConstitutionalRule | null {
    const tracer = getTracer();

    // Check for duplicates
    const existingDuplicate = this.rules.find(
      (r) => r.rule.toLowerCase() === params.rule.toLowerCase(),
    );
    if (existingDuplicate) {
      tracer.log('memory', 'debug', `Rule already exists: ${existingDuplicate.id}`);
      existingDuplicate.confidence = Math.min(1.0, existingDuplicate.confidence + 0.05);
      return existingDuplicate;
    }

    // Check budget
    if (this.rules.length >= this.config.maxRules) {
      // Try to evict the lowest-confidence rule
      const lowest = this.rules.reduce((min, r) =>
        r.confidence < min.confidence ? r : min,
      );

      if (lowest.confidence < params.confidence) {
        this.rules = this.rules.filter((r) => r.id !== lowest.id);
        tracer.log('memory', 'info', `Evicted low-confidence rule: ${lowest.id}`);
      } else {
        tracer.log('memory', 'warn', 'Constitution full, cannot add new rule');
        return null;
      }
    }

    const rule: ConstitutionalRule = {
      id: generateRuleId(),
      rule: params.rule,
      added: new Date().toISOString(),
      motivation: params.motivation,
      confidence: Math.max(0, Math.min(1, params.confidence)),
      invocations: 0,
      successes: 0,
      tags: params.tags ?? [],
    };

    this.rules.push(rule);

    tracer.log('memory', 'info', `New rule created: ${rule.id}`, {
      confidence: rule.confidence,
      rule: rule.rule.slice(0, 80),
    });

    return rule;
  }

  /**
   * Update a rule's text, confidence, or tags.
   */
  updateRule(ruleId: string, updates: {
    rule?: string;
    confidence?: number;
    tags?: string[];
  }): boolean {
    const rule = this.rules.find((r) => r.id === ruleId);
    if (!rule) return false;

    if (updates.rule !== undefined) {
      rule.rule = updates.rule;
    }
    if (updates.confidence !== undefined) {
      rule.confidence = Math.max(0, Math.min(1, updates.confidence));
    }
    if (updates.tags !== undefined) {
      rule.tags = updates.tags;
    }

    return true;
  }

  /**
   * Record that a rule was followed and the outcome was positive.
   */
  recordSuccess(ruleId: string): boolean {
    const rule = this.rules.find((r) => r.id === ruleId);
    if (!rule) return false;

    rule.invocations++;
    rule.successes++;
    // Strengthen confidence
    rule.confidence = Math.min(1.0, rule.confidence + 0.03);

    return true;
  }

  /**
   * Record that a rule was followed but the outcome was negative.
   */
  recordFailure(ruleId: string): boolean {
    const rule = this.rules.find((r) => r.id === ruleId);
    if (!rule) return false;

    rule.invocations++;
    // Slight decay
    rule.confidence = Math.max(0, rule.confidence - 0.02);

    return true;
  }

  /**
   * Record that a rule was violated (not followed) but succeeded anyway.
   * This weakens the rule since it may not be necessary.
   */
  recordViolationSuccess(ruleId: string): boolean {
    const rule = this.rules.find((r) => r.id === ruleId);
    if (!rule) return false;

    rule.invocations++;
    // Stronger decay — rule may not be needed
    rule.confidence = Math.max(0, rule.confidence - 0.05);

    return true;
  }

  /**
   * Delete a rule by ID.
   */
  deleteRule(ruleId: string): boolean {
    const index = this.rules.findIndex((r) => r.id === ruleId);
    if (index === -1) return false;

    this.rules.splice(index, 1);
    return true;
  }

  /**
   * Prune rules below the minimum confidence threshold.
   * Returns the IDs of pruned rules.
   */
  prune(): string[] {
    const tracer = getTracer();
    const pruned: string[] = [];

    this.rules = this.rules.filter((r) => {
      if (r.confidence < this.config.minConfidence) {
        pruned.push(r.id);
        tracer.log('memory', 'info', `Pruned rule: ${r.id} (confidence: ${r.confidence.toFixed(2)})`);
        return false;
      }
      return true;
    });

    return pruned;
  }

  // ── Query ────────────────────────────────────────────────────────────────

  /**
   * Get all rules, sorted by confidence descending.
   */
  getAll(): ReadonlyArray<ConstitutionalRule> {
    return [...this.rules].sort((a, b) => b.confidence - a.confidence);
  }

  /**
   * Get a rule by ID.
   */
  get(ruleId: string): ConstitutionalRule | undefined {
    return this.rules.find((r) => r.id === ruleId);
  }

  /**
   * Search rules by keyword (content + tags).
   */
  search(query: string): ConstitutionalRule[] {
    const lower = query.toLowerCase();
    return this.rules.filter(
      (r) =>
        r.rule.toLowerCase().includes(lower) ||
        r.tags.some((t) => t.toLowerCase().includes(lower)),
    );
  }

  /**
   * Get the number of rules.
   */
  count(): number {
    return this.rules.length;
  }

  /**
   * Check if the store has been loaded.
   */
  isLoaded(): boolean {
    return this.loaded;
  }

  // ── Hot Tier Integration ─────────────────────────────────────────────────

  /**
   * Build a text representation of all rules for inclusion in the
   * identity prompt (hot tier). Respects the token budget.
   */
  buildConstitutionPrompt(): string {
    if (this.rules.length === 0) return '';

    const sorted = this.getAll();
    const lines: string[] = [];
    let tokenCount = 0;

    for (const rule of sorted) {
      const successRate = rule.invocations > 0
        ? Math.round((rule.successes / rule.invocations) * 100)
        : 100;
      const line = `- ${rule.rule} (confidence: ${rule.confidence.toFixed(2)}, ${successRate}% success over ${rule.invocations} uses)`;
      const lineTokens = estimateTokens(line);

      if (tokenCount + lineTokens > this.config.constitutionBudgetTokens) {
        break;
      }

      lines.push(line);
      tokenCount += lineTokens;
    }

    if (lines.length === 0) return '';

    return lines.join('\n');
  }

  /**
   * Estimate total tokens across all rules.
   */
  estimateTotalTokens(): number {
    return this.rules.reduce(
      (sum, r) => sum + estimateTokens(r.rule),
      0,
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────────────────────

export function createConstitutionStore(
  config?: Partial<ConstitutionStoreConfig>,
): ConstitutionStore {
  return new ConstitutionStore(config);
}
