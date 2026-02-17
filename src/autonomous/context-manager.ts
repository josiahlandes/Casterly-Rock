/**
 * Context Manager — MemGPT-style tiered memory for Tyrion
 *
 * Manages a four-tier memory hierarchy:
 *
 *   HOT  (~4k tokens)  — Always in context. Identity prompt, world model
 *                         summary, top goals, top issues, self-model.
 *                         Non-evictable. Rebuilt each cycle from live state.
 *
 *   WARM (~20k tokens) — Session-specific working memory. Files being worked
 *                         on, recent tool results, working notes. Managed by
 *                         the agent via tools (add/evict).
 *
 *   COOL (searchable)  — On-demand retrieval. Past 30 days of archived notes,
 *                         recent reflections, recently closed issues. Loaded
 *                         via the `recall` tool.
 *
 *   COLD (archive)     — Full historical archive. All reflections, old issues,
 *                         full MEMORY.md. Loaded via `recall` with tier='cold'.
 *
 * The hot tier is always included in the agent's system prompt. The warm tier
 * is tracked in-memory during a cycle and can be referenced by the agent.
 * Cool and cold tiers are backed by the ContextStore (JSONL persistence).
 *
 * Token budget:
 *   The context manager tracks estimated token usage across tiers and ensures
 *   the hot tier is always reserved. The warm tier can grow up to the remaining
 *   budget after hot tier allocation.
 *
 * Privacy: All tiers contain only codebase-level observations and metadata.
 * No raw sensitive user content is stored in any tier.
 */

import { getTracer } from './debug.js';
import { buildIdentityPrompt, buildMinimalIdentityPrompt } from './identity.js';
import { ContextStore } from './context-store.js';
import type { ContextStoreConfig, RecallResult } from './context-store.js';
import type { WorldModel } from './world-model.js';
import type { GoalStack } from './goal-stack.js';
import type { IssueLog } from './issue-log.js';
import type { SelfModelSummary, IdentityConfig } from './identity.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Configuration for the context manager.
 */
export interface ContextManagerConfig {
  /** Maximum tokens for the hot tier (identity prompt) */
  hotTierMaxTokens: number;

  /** Maximum tokens for the warm tier (working memory) */
  warmTierMaxTokens: number;

  /** Overall context window size in tokens */
  contextWindowTokens: number;

  /** Identity prompt configuration */
  identityConfig: Partial<IdentityConfig>;

  /** Context store configuration (cool/cold tiers) */
  storeConfig: Partial<ContextStoreConfig>;
}

/**
 * A single item in the warm tier.
 */
export interface WarmEntry {
  /** Unique key for this entry (for dedup and eviction) */
  key: string;

  /** What kind of content this is */
  kind: 'file' | 'tool_result' | 'working_note' | 'snippet';

  /** The content */
  content: string;

  /** Estimated token count */
  tokenEstimate: number;

  /** When this entry was added */
  addedAt: string;

  /** How many times this entry was accessed */
  accessCount: number;
}

/**
 * Summary of current tier usage.
 */
export interface TierUsage {
  hot: { tokens: number; sections: string[] };
  warm: { tokens: number; entries: number; keys: string[] };
  cool: { entries: number };
  cold: { entries: number };
  totalTokensInContext: number;
  remainingTokens: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: ContextManagerConfig = {
  hotTierMaxTokens: 2000,       // ~8000 chars for identity prompt
  warmTierMaxTokens: 10000,     // ~40000 chars for working memory
  contextWindowTokens: 32768,   // Typical context window
  identityConfig: {},
  storeConfig: {},
};

/**
 * Estimate tokens from text (conservative: ~3.5 chars/token).
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}

// ─────────────────────────────────────────────────────────────────────────────
// Context Manager
// ─────────────────────────────────────────────────────────────────────────────

export class ContextManager {
  private readonly config: ContextManagerConfig;
  private readonly store: ContextStore;

  /** Hot tier: rebuilt each cycle from live state */
  private hotTierPrompt: string = '';
  private hotTierTokens: number = 0;

  /** Warm tier: session-specific working memory */
  private warmEntries: Map<string, WarmEntry> = new Map();
  private warmTierTokens: number = 0;

  constructor(config?: Partial<ContextManagerConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.store = new ContextStore(this.config.storeConfig);
  }

  // ── Hot Tier (Identity) ─────────────────────────────────────────────────

  /**
   * Rebuild the hot tier from current state. Called at the start of each cycle.
   * The hot tier is the identity prompt — always in context, never evicted.
   */
  buildHotTier(
    worldModel: WorldModel | null,
    goalStack: GoalStack | null,
    issueLog: IssueLog | null,
    selfModel?: SelfModelSummary | null,
  ): string {
    const tracer = getTracer();

    return tracer.withSpanSync('memory', 'buildHotTier', (span) => {
      const result = buildIdentityPrompt(
        worldModel,
        goalStack,
        issueLog,
        selfModel,
        this.config.identityConfig,
      );

      this.hotTierPrompt = result.prompt;
      this.hotTierTokens = estimateTokens(result.prompt);

      tracer.log('memory', 'info', 'Hot tier built', {
        chars: result.charCount,
        tokens: this.hotTierTokens,
        sections: result.sections,
      });

      span.metadata['hotTierTokens'] = this.hotTierTokens;
      return result.prompt;
    });
  }

  /**
   * Get the current hot tier prompt. If not built yet, returns the minimal
   * identity prompt as a fallback.
   */
  getHotTier(): string {
    return this.hotTierPrompt || buildMinimalIdentityPrompt();
  }

  /**
   * Get estimated token count for the hot tier.
   */
  getHotTierTokens(): number {
    return this.hotTierTokens;
  }

  // ── Warm Tier (Working Memory) ──────────────────────────────────────────

  /**
   * Add content to the warm tier. If a key already exists, it is replaced.
   * If the warm tier would exceed its budget, the least-accessed entries
   * are evicted to make room.
   */
  addToWarmTier(params: {
    key: string;
    kind: WarmEntry['kind'];
    content: string;
  }): { added: boolean; evicted: string[] } {
    const tracer = getTracer();
    const tokens = estimateTokens(params.content);
    const evicted: string[] = [];

    // Remove existing entry with same key (replacement)
    if (this.warmEntries.has(params.key)) {
      const existing = this.warmEntries.get(params.key)!;
      this.warmTierTokens -= existing.tokenEstimate;
      this.warmEntries.delete(params.key);
    }

    // Check if this single entry exceeds the warm tier budget
    if (tokens > this.config.warmTierMaxTokens) {
      tracer.log('memory', 'warn', `Entry "${params.key}" too large for warm tier`, {
        entryTokens: tokens,
        budget: this.config.warmTierMaxTokens,
      });
      return { added: false, evicted };
    }

    // Evict LRU entries until there's room
    while (this.warmTierTokens + tokens > this.config.warmTierMaxTokens) {
      const lruKey = this.findLeastUsedEntry();
      if (!lruKey) break;

      const lruEntry = this.warmEntries.get(lruKey)!;
      this.warmTierTokens -= lruEntry.tokenEstimate;
      this.warmEntries.delete(lruKey);
      evicted.push(lruKey);

      tracer.log('memory', 'debug', `Evicted warm entry: ${lruKey}`, {
        tokens: lruEntry.tokenEstimate,
      });
    }

    // Add the new entry
    const entry: WarmEntry = {
      key: params.key,
      kind: params.kind,
      content: params.content,
      tokenEstimate: tokens,
      addedAt: new Date().toISOString(),
      accessCount: 0,
    };

    this.warmEntries.set(params.key, entry);
    this.warmTierTokens += tokens;

    tracer.log('memory', 'debug', `Added to warm tier: ${params.key}`, {
      kind: params.kind,
      tokens,
      totalWarmTokens: this.warmTierTokens,
    });

    return { added: true, evicted };
  }

  /**
   * Get content from the warm tier by key. Increments the access counter
   * (used for LRU eviction).
   */
  getFromWarmTier(key: string): string | null {
    const entry = this.warmEntries.get(key);
    if (!entry) return null;

    entry.accessCount++;
    return entry.content;
  }

  /**
   * Remove a specific entry from the warm tier.
   */
  removeFromWarmTier(key: string): boolean {
    const entry = this.warmEntries.get(key);
    if (!entry) return false;

    this.warmTierTokens -= entry.tokenEstimate;
    this.warmEntries.delete(key);
    return true;
  }

  /**
   * Get all warm tier entries for inclusion in context.
   */
  getWarmTierContents(): ReadonlyArray<WarmEntry> {
    return Array.from(this.warmEntries.values());
  }

  /**
   * Build a text representation of the warm tier for inclusion
   * in the agent prompt.
   */
  buildWarmTierPrompt(): string {
    if (this.warmEntries.size === 0) return '';

    const sections: string[] = ['## Working Memory\n'];

    for (const entry of this.warmEntries.values()) {
      sections.push(`### ${entry.kind}: ${entry.key}`);
      sections.push(entry.content);
      sections.push('');
    }

    return sections.join('\n');
  }

  /**
   * Clear all warm tier entries (called between cycles).
   */
  clearWarmTier(): void {
    this.warmEntries.clear();
    this.warmTierTokens = 0;
    const tracer = getTracer();
    tracer.log('memory', 'debug', 'Warm tier cleared');
  }

  /**
   * Get estimated token count for the warm tier.
   */
  getWarmTierTokens(): number {
    return this.warmTierTokens;
  }

  // ── Cool/Cold Tiers (Persistent Storage) ────────────────────────────────

  /**
   * Archive content to the cool or cold tier.
   */
  async archive(params: {
    content: string;
    title: string;
    tags: string[];
    tier?: 'cool' | 'cold';
    source?: 'agent' | 'reflection' | 'archive' | 'issue' | 'goal';
  }): Promise<string> {
    return this.store.archive(params);
  }

  /**
   * Search cool/cold tiers for relevant content.
   */
  async recall(params: {
    query: string;
    tier?: 'cool' | 'cold' | 'both';
    tags?: string[];
    limit?: number;
  }): Promise<RecallResult[]> {
    return this.store.recall(params);
  }

  /**
   * Promote stale cool entries to cold tier (for dream cycles).
   */
  async promoteStaleEntries(): Promise<number> {
    return this.store.promoteStaleEntries();
  }

  // ── Token Budget ────────────────────────────────────────────────────────

  /**
   * Get the remaining token budget for the warm tier after hot tier
   * allocation.
   */
  getRemainingWarmBudget(): number {
    return Math.max(0, this.config.warmTierMaxTokens - this.warmTierTokens);
  }

  /**
   * Get the total tokens currently in context (hot + warm).
   */
  getTotalContextTokens(): number {
    return this.hotTierTokens + this.warmTierTokens;
  }

  /**
   * Get a complete usage summary across all tiers.
   */
  async getUsage(): Promise<TierUsage> {
    const storeStats = await this.store.getStats();

    const hotSections: string[] = [];
    if (this.hotTierPrompt.includes('# Current State')) hotSections.push('worldModel');
    if (this.hotTierPrompt.includes('# Your Goals')) hotSections.push('goalStack');
    if (this.hotTierPrompt.includes('# Known Issues')) hotSections.push('issueLog');
    if (this.hotTierPrompt.includes('# Self-Assessment')) hotSections.push('selfModel');

    return {
      hot: {
        tokens: this.hotTierTokens,
        sections: hotSections,
      },
      warm: {
        tokens: this.warmTierTokens,
        entries: this.warmEntries.size,
        keys: Array.from(this.warmEntries.keys()),
      },
      cool: { entries: storeStats.cool },
      cold: { entries: storeStats.cold + storeStats.reflections },
      totalTokensInContext: this.getTotalContextTokens(),
      remainingTokens: this.config.contextWindowTokens - this.getTotalContextTokens(),
    };
  }

  // ── Accessors ───────────────────────────────────────────────────────────

  /**
   * Get the underlying context store (for testing or direct access).
   */
  getStore(): ContextStore {
    return this.store;
  }

  // ── Private Helpers ─────────────────────────────────────────────────────

  /**
   * Find the least-used warm tier entry (for eviction).
   * Prefers entries with lower access counts; ties broken by oldest.
   */
  private findLeastUsedEntry(): string | null {
    let lruKey: string | null = null;
    let lruAccess = Infinity;
    let lruTime = '';

    for (const [key, entry] of this.warmEntries) {
      if (
        entry.accessCount < lruAccess ||
        (entry.accessCount === lruAccess && entry.addedAt < lruTime)
      ) {
        lruKey = key;
        lruAccess = entry.accessCount;
        lruTime = entry.addedAt;
      }
    }

    return lruKey;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a context manager with the given configuration.
 */
export function createContextManager(
  config?: Partial<ContextManagerConfig>,
): ContextManager {
  return new ContextManager(config);
}
