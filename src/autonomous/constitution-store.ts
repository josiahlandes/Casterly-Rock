/**
 * Constitution Store — Constitutional Self-Governance (Vision Tier 1)
 *
 * Stores operational rules the LLM has authored about its own behavior.
 * These are NOT safety rules (those are immutable in the safety boundary),
 * but tactical rules discovered through experience.
 *
 * Rule lifecycle:
 *   - Creation: The LLM observes a pattern and creates a rule via create_rule.
 *   - Strengthening: Following a rule that leads to success increases confidence.
 *   - Decay: Violating a rule and succeeding anyway decreases confidence.
 *   - Pruning: Rules below min_confidence are pruned during dream cycles.
 *   - Evolution: Rules can be refined via update_rule.
 *
 * Storage: ~/.casterly/constitution.yaml (YAML persistence)
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
 * A constitutional rule — a tactical operational rule authored by the LLM.
 */
export interface ConstitutionalRule {
  /** Unique identifier */
  id: string;

  /** The rule text */
  rule: string;

  /** ISO timestamp when the rule was added */
  added: string;

  /** Journal reference or explanation for why this rule exists */
  motivation: string;

  /** Confidence score (0-1). Decays on contradiction, grows on success. */
  confidence: number;

  /** Number of times this rule was invoked (relevant to a cycle) */
  invocations: number;

  /** Number of times following this rule led to success */
  successes: number;
}

/**
 * Configuration for the constitution store.
 */
export interface ConstitutionStoreConfig {
  /** Path to constitution store file */
  path: string;

  /** Maximum number of rules */
  maxRules: number;

  /** Token budget for constitution in the hot tier */
  budgetTokens: number;

  /** Minimum confidence to keep a rule during pruning */
  minConfidence: number;
}

/**
 * Result of a create/update/delete rule operation.
 */
export interface RuleResult {
  /** Whether the operation succeeded */
  success: boolean;

  /** The rule ID if successful */
  ruleId?: string;

  /** Error message if the operation failed */
  error?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: ConstitutionStoreConfig = {
  path: '~/.casterly/constitution.yaml',
  maxRules: 50,
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

function generateRuleId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).substring(2, 6);
  return `rule-${ts}-${rand}`;
}

/**
 * Rough token estimate (~4 chars per token).
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// ─────────────────────────────────────────────────────────────────────────────
// Simple YAML serializer/deserializer for ConstitutionalRule[]
// ─────────────────────────────────────────────────────────────────────────────

function serializeRules(rules: ConstitutionalRule[]): string {
  if (rules.length === 0) return '# Casterly Constitution\nrules: []\n';

  const lines: string[] = ['# Casterly Constitution', 'rules:'];

  for (const r of rules) {
    lines.push(`  - id: ${JSON.stringify(r.id)}`);
    lines.push(`    rule: ${JSON.stringify(r.rule)}`);
    lines.push(`    added: ${JSON.stringify(r.added)}`);
    lines.push(`    motivation: ${JSON.stringify(r.motivation)}`);
    lines.push(`    confidence: ${r.confidence}`);
    lines.push(`    invocations: ${r.invocations}`);
    lines.push(`    successes: ${r.successes}`);
  }

  return lines.join('\n') + '\n';
}

function deserializeRules(yaml: string): ConstitutionalRule[] {
  const rules: ConstitutionalRule[] = [];
  const lines = yaml.split('\n');
  let current: Partial<ConstitutionalRule> | null = null;

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed.startsWith('- id:')) {
      if (current && current.id) {
        rules.push(current as ConstitutionalRule);
      }
      current = {
        id: parseYamlValue(trimmed.replace('- id:', '').trim()),
        invocations: 0,
        successes: 0,
        confidence: 1.0,
      };
    } else if (current) {
      if (trimmed.startsWith('rule:')) {
        current.rule = parseYamlValue(trimmed.replace('rule:', '').trim());
      } else if (trimmed.startsWith('added:')) {
        current.added = parseYamlValue(trimmed.replace('added:', '').trim());
      } else if (trimmed.startsWith('motivation:')) {
        current.motivation = parseYamlValue(trimmed.replace('motivation:', '').trim());
      } else if (trimmed.startsWith('confidence:')) {
        current.confidence = parseFloat(trimmed.replace('confidence:', '').trim()) || 0;
      } else if (trimmed.startsWith('invocations:')) {
        current.invocations = parseInt(trimmed.replace('invocations:', '').trim(), 10) || 0;
      } else if (trimmed.startsWith('successes:')) {
        current.successes = parseInt(trimmed.replace('successes:', '').trim(), 10) || 0;
      }
    }
  }

  if (current && current.id) {
    rules.push(current as ConstitutionalRule);
  }

  return rules;
}

function parseYamlValue(raw: string): string {
  if (raw.startsWith('"') && raw.endsWith('"')) {
    try {
      return JSON.parse(raw) as string;
    } catch {
      return raw.slice(1, -1);
    }
  }
  return raw;
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
   * Load constitution from disk.
   */
  async load(): Promise<void> {
    const tracer = getTracer();
    const resolvedPath = resolvePath(this.config.path);

    try {
      const content = await readFile(resolvedPath, 'utf8');
      this.rules = deserializeRules(content);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        tracer.log('memory', 'warn', 'Failed to load constitution store', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      this.rules = [];
    }

    this.loaded = true;
    tracer.log('memory', 'debug', `Constitution store loaded: ${this.rules.length} rules`);
  }

  /**
   * Save constitution to disk.
   */
  async save(): Promise<void> {
    const tracer = getTracer();
    const resolvedPath = resolvePath(this.config.path);

    await mkdir(dirname(resolvedPath), { recursive: true });
    await writeFile(resolvedPath, serializeRules(this.rules), 'utf8');

    tracer.log('memory', 'debug', `Constitution store saved: ${this.rules.length} rules`);
  }

  // ── Rule Operations ────────────────────────────────────────────────────

  /**
   * Create a new constitutional rule.
   */
  createRule(params: {
    rule: string;
    motivation: string;
    confidence?: number;
  }): RuleResult {
    const tracer = getTracer();

    // Enforce max rules
    if (this.rules.length >= this.config.maxRules) {
      return {
        success: false,
        error: `Maximum rule limit reached (${this.config.maxRules}). Remove a rule first or wait for dream cycle pruning.`,
      };
    }

    // Check token budget
    const currentTokens = this.estimateTotalTokens();
    const newTokens = estimateTokens(params.rule);
    if (currentTokens + newTokens > this.config.budgetTokens) {
      return {
        success: false,
        error: `Token budget exceeded. Current: ${currentTokens}/${this.config.budgetTokens}. New rule needs ~${newTokens} tokens.`,
      };
    }

    // Check for duplicate rule text
    const duplicate = this.rules.find(
      (r) => r.rule.toLowerCase() === params.rule.toLowerCase(),
    );
    if (duplicate) {
      return {
        success: false,
        error: `Duplicate rule: "${duplicate.id}" already has this rule text.`,
      };
    }

    const rule: ConstitutionalRule = {
      id: generateRuleId(),
      rule: params.rule,
      added: new Date().toISOString(),
      motivation: params.motivation,
      confidence: params.confidence ?? 0.8,
      invocations: 0,
      successes: 0,
    };

    this.rules.push(rule);

    tracer.log('memory', 'info', `Rule created: ${rule.id}`, {
      rule: params.rule.slice(0, 80),
    });

    return {
      success: true,
      ruleId: rule.id,
    };
  }

  /**
   * Update an existing rule's text or motivation.
   */
  updateRule(
    ruleId: string,
    updates: { rule?: string; motivation?: string; confidence?: number },
  ): RuleResult {
    const tracer = getTracer();

    const existing = this.rules.find((r) => r.id === ruleId);
    if (!existing) {
      return {
        success: false,
        error: `Rule not found: ${ruleId}`,
      };
    }

    // Check token budget if rule text is changing
    if (updates.rule !== undefined) {
      const currentTokens = this.estimateTotalTokens() - estimateTokens(existing.rule);
      const newTokens = estimateTokens(updates.rule);
      if (currentTokens + newTokens > this.config.budgetTokens) {
        return {
          success: false,
          error: `Token budget would be exceeded. New rule needs ~${newTokens} tokens.`,
        };
      }
      existing.rule = updates.rule;
    }

    if (updates.motivation !== undefined) {
      existing.motivation = updates.motivation;
    }

    if (updates.confidence !== undefined) {
      existing.confidence = Math.max(0, Math.min(1, updates.confidence));
    }

    tracer.log('memory', 'info', `Rule updated: ${ruleId}`, {
      rule: existing.rule.slice(0, 80),
    });

    return {
      success: true,
      ruleId,
    };
  }

  /**
   * Remove a rule by ID.
   */
  removeRule(ruleId: string): RuleResult {
    const tracer = getTracer();

    const index = this.rules.findIndex((r) => r.id === ruleId);
    if (index < 0) {
      return {
        success: false,
        error: `Rule not found: ${ruleId}`,
      };
    }

    const removed = this.rules.splice(index, 1)[0]!;

    tracer.log('memory', 'info', `Rule removed: ${ruleId}`, {
      rule: removed.rule.slice(0, 80),
    });

    return {
      success: true,
      ruleId,
    };
  }

  /**
   * Record that a rule was invoked (relevant to a cycle) and whether it succeeded.
   */
  recordOutcome(ruleId: string, success: boolean): boolean {
    const rule = this.rules.find((r) => r.id === ruleId);
    if (!rule) return false;

    rule.invocations++;
    if (success) {
      rule.successes++;
      rule.confidence = Math.min(1.0, rule.confidence + 0.05);
    } else {
      rule.confidence = Math.max(0, rule.confidence - 0.1);
    }

    return true;
  }

  // ── Pruning ─────────────────────────────────────────────────────────────

  /**
   * Prune rules below the minimum confidence threshold.
   * Only prunes rules with at least 3 invocations (enough data).
   * Returns the IDs of pruned rules.
   */
  pruneByConfidence(): string[] {
    const pruned: string[] = [];
    const tracer = getTracer();

    this.rules = this.rules.filter((r) => {
      if (r.invocations >= 3 && r.confidence < this.config.minConfidence) {
        pruned.push(r.id);
        return false;
      }
      return true;
    });

    if (pruned.length > 0) {
      tracer.log('memory', 'info', `Pruned ${pruned.length} low-confidence rules`, {
        ids: pruned,
      });
    }

    return pruned;
  }

  // ── Query ────────────────────────────────────────────────────────────────

  /**
   * Get all rules, sorted by confidence (highest first).
   */
  getAll(): ReadonlyArray<ConstitutionalRule> {
    return [...this.rules].sort((a, b) => b.confidence - a.confidence);
  }

  /**
   * Get a specific rule by ID.
   */
  getById(id: string): ConstitutionalRule | undefined {
    return this.rules.find((r) => r.id === id);
  }

  /**
   * Get the number of rules.
   */
  count(): number {
    return this.rules.length;
  }

  /**
   * Estimate total tokens used by all rules.
   */
  estimateTotalTokens(): number {
    return this.rules.reduce((sum, r) => sum + estimateTokens(r.rule), 0);
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
    if (this.rules.length === 0) return '';

    const sorted = this.getAll();
    const lines: string[] = ['## Constitution (operational rules)', ''];

    for (const r of sorted) {
      const pct = Math.round(r.confidence * 100);
      lines.push(`- ${r.rule} (${pct}% confidence)`);
    }

    return lines.join('\n');
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
