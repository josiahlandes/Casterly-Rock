/**
 * Shadow Store — Alternative approach recording (Vision Tier 2)
 *
 * For non-trivial tasks, the LLM generates an alternative approach
 * (the "shadow") before executing its primary plan. Only the primary
 * plan is executed. After the cycle, the shadow is stored alongside
 * the outcome for later analysis.
 *
 * During dream cycles, shadows are compared against actual outcomes:
 *   - When the primary succeeded: was the shadow also viable?
 *   - When the primary failed: would the shadow have worked?
 *
 * Over time, this builds a dataset of judgment patterns — which
 * types of problems call for which types of approaches. This
 * calibrates the LLM's judgment without requiring real failures.
 *
 * Storage: Shadows are stored as entries in the journal (type: 'shadow')
 * and indexed in ~/.casterly/shadow-analysis.json for cross-cycle analysis.
 *
 * Part of Vision Tier 2: Shadow Execution.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { getTracer } from './debug.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A shadow — an alternative approach that was NOT executed.
 */
export interface Shadow {
  /** Unique identifier */
  id: string;

  /** The cycle this shadow belongs to */
  cycleId: string;

  /** ISO timestamp */
  timestamp: string;

  /** Description of the alternative strategy */
  strategy: string;

  /** Expected steps the shadow approach would take */
  expectedSteps: string[];

  /** Why the primary approach was chosen over this one */
  rationale: string;

  /** Outcome of the primary approach (filled after cycle ends) */
  primaryOutcome?: 'success' | 'failure' | 'partial';

  /** Post-hoc assessment during dream cycle: would the shadow have worked? */
  shadowAssessment?: 'likely_better' | 'likely_similar' | 'likely_worse' | 'unknown';

  /** Tags for categorization */
  tags: string[];
}

/**
 * A judgment pattern extracted from shadow analysis.
 */
export interface JudgmentPattern {
  /** Unique identifier */
  id: string;

  /** The pattern description */
  pattern: string;

  /** How many shadow comparisons support this pattern */
  supportCount: number;

  /** How many comparisons contradict this pattern */
  contradictCount: number;

  /** Confidence in this pattern (0-1) */
  confidence: number;

  /** When this pattern was first observed */
  firstSeen: string;

  /** When this pattern was last updated */
  lastUpdated: string;

  /** Example cycle IDs */
  exampleCycleIds: string[];
}

/**
 * Shadow analysis data — persisted between dream cycles.
 */
export interface ShadowAnalysis {
  /** All shadows with their assessments */
  shadows: Shadow[];

  /** Extracted judgment patterns */
  patterns: JudgmentPattern[];

  /** Last analysis timestamp */
  lastAnalyzed: string;
}

/**
 * Configuration for the shadow store.
 */
export interface ShadowStoreConfig {
  /** Path to shadow analysis store */
  analysisPath: string;

  /** Maximum shadows to retain */
  maxShadows: number;

  /** Minimum scenarios needed to form a judgment pattern */
  minScenariosForPattern: number;

  /** Days to retain assessed shadows */
  retentionDays: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: ShadowStoreConfig = {
  analysisPath: '~/.casterly/shadow-analysis.json',
  maxShadows: 200,
  minScenariosForPattern: 5,
  retentionDays: 90,
};

function resolvePath(filePath: string): string {
  if (filePath.startsWith('~')) {
    const home = process.env['HOME'] ?? process.env['USERPROFILE'] ?? '/tmp';
    return filePath.replace('~', home);
  }
  return filePath;
}

function generateShadowId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).substring(2, 6);
  return `shadow-${ts}-${rand}`;
}

function generatePatternId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).substring(2, 6);
  return `pattern-${ts}-${rand}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Shadow Store
// ─────────────────────────────────────────────────────────────────────────────

export class ShadowStore {
  private readonly config: ShadowStoreConfig;
  private data: ShadowAnalysis = {
    shadows: [],
    patterns: [],
    lastAnalyzed: '',
  };
  private loaded: boolean = false;

  constructor(config?: Partial<ShadowStoreConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // ── Persistence ──────────────────────────────────────────────────────────

  /**
   * Load shadow analysis from disk.
   */
  async load(): Promise<void> {
    const tracer = getTracer();
    const resolvedPath = resolvePath(this.config.analysisPath);

    try {
      const content = await readFile(resolvedPath, 'utf8');
      const parsed = JSON.parse(content) as ShadowAnalysis;

      if (parsed && Array.isArray(parsed.shadows)) {
        this.data = {
          shadows: parsed.shadows,
          patterns: parsed.patterns ?? [],
          lastAnalyzed: parsed.lastAnalyzed ?? '',
        };
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        tracer.log('memory', 'warn', 'Failed to load shadow analysis', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      // Start fresh
    }

    this.loaded = true;
    tracer.log('memory', 'debug', `Shadow store loaded: ${this.data.shadows.length} shadows, ${this.data.patterns.length} patterns`);
  }

  /**
   * Save shadow analysis to disk.
   */
  async save(): Promise<void> {
    const tracer = getTracer();
    const resolvedPath = resolvePath(this.config.analysisPath);

    await mkdir(dirname(resolvedPath), { recursive: true });
    await writeFile(resolvedPath, JSON.stringify(this.data, null, 2), 'utf8');

    tracer.log('memory', 'debug', `Shadow store saved: ${this.data.shadows.length} shadows`);
  }

  // ── Shadow Operations ────────────────────────────────────────────────────

  /**
   * Record a shadow (alternative approach) before executing the primary plan.
   */
  recordShadow(params: {
    cycleId: string;
    strategy: string;
    expectedSteps: string[];
    rationale: string;
    tags?: string[];
  }): Shadow {
    const tracer = getTracer();

    const shadow: Shadow = {
      id: generateShadowId(),
      cycleId: params.cycleId,
      timestamp: new Date().toISOString(),
      strategy: params.strategy,
      expectedSteps: params.expectedSteps,
      rationale: params.rationale,
      tags: params.tags ?? [],
    };

    this.data.shadows.push(shadow);

    // Enforce capacity
    while (this.data.shadows.length > this.config.maxShadows) {
      this.data.shadows.shift();
    }

    tracer.log('memory', 'info', `Shadow recorded: ${shadow.id} for cycle ${params.cycleId}`, {
      strategy: params.strategy.slice(0, 80),
    });

    return shadow;
  }

  /**
   * Record the outcome of the primary approach for a cycle's shadow.
   */
  recordPrimaryOutcome(
    cycleId: string,
    outcome: 'success' | 'failure' | 'partial',
  ): boolean {
    const shadow = this.data.shadows.find((s) => s.cycleId === cycleId);
    if (!shadow) return false;

    shadow.primaryOutcome = outcome;
    return true;
  }

  /**
   * Assess a shadow during dream cycle analysis.
   */
  assessShadow(
    shadowId: string,
    assessment: 'likely_better' | 'likely_similar' | 'likely_worse' | 'unknown',
  ): boolean {
    const shadow = this.data.shadows.find((s) => s.id === shadowId);
    if (!shadow) return false;

    shadow.shadowAssessment = assessment;
    return true;
  }

  // ── Analysis ─────────────────────────────────────────────────────────────

  /**
   * Get shadows that haven't been assessed yet (for dream cycle analysis).
   */
  getUnassessedShadows(): Shadow[] {
    return this.data.shadows.filter(
      (s) => s.primaryOutcome !== undefined && s.shadowAssessment === undefined,
    );
  }

  /**
   * Get shadows for a specific cycle.
   */
  getShadowsForCycle(cycleId: string): Shadow[] {
    return this.data.shadows.filter((s) => s.cycleId === cycleId);
  }

  /**
   * Get failed cycles where the shadow was assessed as likely better.
   * These are the most valuable learning opportunities.
   */
  getMissedOpportunities(): Shadow[] {
    return this.data.shadows.filter(
      (s) =>
        s.primaryOutcome === 'failure' &&
        s.shadowAssessment === 'likely_better',
    );
  }

  /**
   * Add or update a judgment pattern based on shadow analysis.
   */
  addPattern(params: {
    pattern: string;
    exampleCycleId: string;
  }): JudgmentPattern {
    // Check for existing similar pattern
    const existing = this.data.patterns.find(
      (p) => p.pattern.toLowerCase() === params.pattern.toLowerCase(),
    );

    if (existing) {
      existing.supportCount++;
      existing.lastUpdated = new Date().toISOString();
      existing.confidence = existing.supportCount /
        (existing.supportCount + existing.contradictCount);
      if (!existing.exampleCycleIds.includes(params.exampleCycleId)) {
        existing.exampleCycleIds.push(params.exampleCycleId);
        if (existing.exampleCycleIds.length > 10) {
          existing.exampleCycleIds.shift();
        }
      }
      return existing;
    }

    const pattern: JudgmentPattern = {
      id: generatePatternId(),
      pattern: params.pattern,
      supportCount: 1,
      contradictCount: 0,
      confidence: 1.0,
      firstSeen: new Date().toISOString(),
      lastUpdated: new Date().toISOString(),
      exampleCycleIds: [params.exampleCycleId],
    };

    this.data.patterns.push(pattern);
    return pattern;
  }

  /**
   * Record a contradiction against a pattern.
   */
  contradictPattern(patternId: string): boolean {
    const pattern = this.data.patterns.find((p) => p.id === patternId);
    if (!pattern) return false;

    pattern.contradictCount++;
    pattern.lastUpdated = new Date().toISOString();
    pattern.confidence = pattern.supportCount /
      (pattern.supportCount + pattern.contradictCount);
    return true;
  }

  /**
   * Get established patterns (above minimum scenario threshold).
   */
  getEstablishedPatterns(): JudgmentPattern[] {
    return this.data.patterns.filter(
      (p) => (p.supportCount + p.contradictCount) >= this.config.minScenariosForPattern,
    );
  }

  /**
   * Get all patterns sorted by confidence.
   */
  getAllPatterns(): ReadonlyArray<JudgmentPattern> {
    return [...this.data.patterns].sort((a, b) => b.confidence - a.confidence);
  }

  /**
   * Prune old shadows past the retention period.
   * Returns the number of shadows pruned.
   */
  pruneOldShadows(): number {
    const cutoff = Date.now() - this.config.retentionDays * 24 * 60 * 60 * 1000;
    const before = this.data.shadows.length;

    this.data.shadows = this.data.shadows.filter((s) => {
      const ts = new Date(s.timestamp).getTime();
      return ts >= cutoff;
    });

    return before - this.data.shadows.length;
  }

  /**
   * Prune weak patterns (low confidence with enough data).
   */
  pruneWeakPatterns(minConfidence: number = 0.3): string[] {
    const pruned: string[] = [];

    this.data.patterns = this.data.patterns.filter((p) => {
      const hasEnoughData = (p.supportCount + p.contradictCount) >=
        this.config.minScenariosForPattern;
      if (hasEnoughData && p.confidence < minConfidence) {
        pruned.push(p.id);
        return false;
      }
      return true;
    });

    return pruned;
  }

  // ── Query ────────────────────────────────────────────────────────────────

  /**
   * Get all shadows.
   */
  getAllShadows(): ReadonlyArray<Shadow> {
    return this.data.shadows;
  }

  /**
   * Get the count of shadows.
   */
  count(): number {
    return this.data.shadows.length;
  }

  /**
   * Get the count of patterns.
   */
  patternCount(): number {
    return this.data.patterns.length;
  }

  /**
   * Check if loaded.
   */
  isLoaded(): boolean {
    return this.loaded;
  }

  /**
   * Build a summary for dream cycle analysis.
   */
  buildAnalysisSummary(): string {
    const unassessed = this.getUnassessedShadows();
    const missed = this.getMissedOpportunities();
    const established = this.getEstablishedPatterns();

    const lines: string[] = [];

    if (unassessed.length > 0) {
      lines.push(`${unassessed.length} shadows awaiting assessment.`);
    }

    if (missed.length > 0) {
      lines.push(`\n${missed.length} missed opportunities (shadow was likely better):`);
      for (const m of missed.slice(0, 5)) {
        lines.push(`- [${m.cycleId}] ${m.strategy.slice(0, 60)}`);
      }
    }

    if (established.length > 0) {
      lines.push(`\n${established.length} established judgment patterns:`);
      for (const p of established.slice(0, 5)) {
        const rate = Math.round(p.confidence * 100);
        lines.push(`- ${p.pattern} (${rate}% confidence, ${p.supportCount + p.contradictCount} observations)`);
      }
    }

    return lines.length > 0 ? lines.join('\n') : 'No shadow data yet.';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────────────────────

export function createShadowStore(
  config?: Partial<ShadowStoreConfig>,
): ShadowStore {
  return new ShadowStore(config);
}
