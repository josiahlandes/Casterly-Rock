/**
 * Adapter Manager — Disentangled LoRA Adapter Selection (Vision Tier 3)
 *
 * Manages separate LoRA adapters for reasoning vs. tool-calling to avoid
 * gradient conflicts. Research shows that training a single adapter on both
 * objectives creates interference — improving tool-calling degrades reasoning
 * and vice versa.
 *
 * Solution: maintain two adapter categories per skill domain:
 *   1. Reasoning adapters — loaded during planning/analysis phases
 *   2. Tool-calling adapters — loaded during execution/implementation phases
 *
 * The AdapterManager selects the appropriate adapter based on the current
 * task phase and returns the model identifier to use.
 *
 * See docs/roadmap.md Tier 3, Item 9.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { getTracer } from '../debug.js';
import type { LoraAdapter, LoraTrainer } from './lora-trainer.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The two adapter categories that avoid gradient conflicts.
 */
export type AdapterCategory = 'reasoning' | 'tools';

/**
 * Task phases mapped to adapter categories.
 */
export type TaskPhase =
  | 'triage'       // → reasoning
  | 'planning'     // → reasoning
  | 'execution'    // → tools
  | 'review'       // → reasoning
  | 'revision';    // → tools

/**
 * A disentangled adapter entry linking a LoRA adapter to its category.
 */
export interface DisentangledAdapter {
  /** The underlying LoRA adapter ID from the registry */
  adapterId: string;

  /** Which category this adapter serves */
  category: AdapterCategory;

  /** Skill domain */
  skill: string;

  /** Whether this adapter is currently selected for its category */
  selected: boolean;
}

/**
 * Registry of disentangled adapter assignments.
 */
export interface DisentangledRegistry {
  /** All disentangled adapter entries */
  entries: DisentangledAdapter[];

  /** When the registry was last updated */
  lastUpdated: string;
}

/**
 * Configuration for the adapter manager.
 */
export interface AdapterManagerConfig {
  /** Path to store the disentangled registry */
  registryPath: string;

  /** Enable disentangled adapters (default: true) */
  enabled: boolean;
}

/**
 * Result of adapter selection for a task phase.
 */
export interface AdapterSelection {
  /** The adapter to load, or null if no adapter available */
  adapter: LoraAdapter | null;

  /** Which category was selected */
  category: AdapterCategory;

  /** Why this adapter was selected */
  reason: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: AdapterManagerConfig = {
  registryPath: '~/.casterly/adapters/disentangled.json',
  enabled: true,
};

/**
 * Map task phases to adapter categories.
 */
const PHASE_TO_CATEGORY: Record<TaskPhase, AdapterCategory> = {
  triage: 'reasoning',
  planning: 'reasoning',
  execution: 'tools',
  review: 'reasoning',
  revision: 'tools',
};

// ─────────────────────────────────────────────────────────────────────────────
// Adapter Manager
// ─────────────────────────────────────────────────────────────────────────────

export class AdapterManager {
  private readonly config: AdapterManagerConfig;
  private registry: DisentangledRegistry;
  private dirty = false;

  constructor(config?: Partial<AdapterManagerConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.registry = {
      entries: [],
      lastUpdated: new Date().toISOString(),
    };
  }

  // ── Persistence ─────────────────────────────────────────────────────────

  /**
   * Load the disentangled registry from disk.
   */
  async load(): Promise<void> {
    const resolvedPath = this.resolvePath(this.config.registryPath);

    try {
      const content = await readFile(resolvedPath, 'utf8');
      const parsed = JSON.parse(content) as DisentangledRegistry;
      if (parsed && Array.isArray(parsed.entries)) {
        this.registry = parsed;
      }
    } catch {
      // No existing registry — start fresh
    }
  }

  /**
   * Save the disentangled registry to disk.
   */
  async save(): Promise<void> {
    if (!this.dirty) return;

    const resolvedPath = this.resolvePath(this.config.registryPath);
    await mkdir(dirname(resolvedPath), { recursive: true });
    await writeFile(resolvedPath, JSON.stringify(this.registry, null, 2), 'utf8');
    this.dirty = false;
  }

  // ── Adapter Selection ──────────────────────────────────────────────────

  /**
   * Select the best adapter for a given task phase and skill.
   *
   * If disentangled adapters are enabled, selects the adapter matching
   * the phase's category (reasoning or tools). Falls back to any active
   * adapter for the skill if no disentangled assignment exists.
   */
  selectForPhase(
    phase: TaskPhase,
    skill: string,
    loraTrainer: LoraTrainer,
  ): AdapterSelection {
    const category = PHASE_TO_CATEGORY[phase];

    if (!this.config.enabled) {
      // Disentangled mode disabled — use any active adapter
      const adapter = loraTrainer.getActiveAdapter(skill);
      return {
        adapter: adapter ?? null,
        category,
        reason: adapter
          ? `Disentangled mode disabled, using generic adapter: ${adapter.id}`
          : `No active adapter for skill: ${skill}`,
      };
    }

    // Look for a disentangled adapter matching category + skill
    const entry = this.registry.entries.find(
      (e) => e.category === category && e.skill === skill && e.selected,
    );

    if (entry) {
      const adapter = loraTrainer.getAdapters().find((a) => a.id === entry.adapterId);
      if (adapter && adapter.status === 'active') {
        return {
          adapter,
          category,
          reason: `Disentangled ${category} adapter for ${skill}: ${adapter.id}`,
        };
      }
    }

    // Fallback: use any active adapter for this skill
    const fallback = loraTrainer.getActiveAdapter(skill);
    return {
      adapter: fallback ?? null,
      category,
      reason: fallback
        ? `No disentangled ${category} adapter, falling back to: ${fallback.id}`
        : `No adapter available for ${skill} (${category} phase)`,
    };
  }

  /**
   * Get the adapter category for a task phase.
   */
  getCategoryForPhase(phase: TaskPhase): AdapterCategory {
    return PHASE_TO_CATEGORY[phase];
  }

  // ── Adapter Registration ──────────────────────────────────────────────

  /**
   * Register a LoRA adapter as a disentangled adapter for a category.
   */
  registerAdapter(
    adapterId: string,
    category: AdapterCategory,
    skill: string,
  ): void {
    // Deselect any existing adapter for this category + skill
    for (const entry of this.registry.entries) {
      if (entry.category === category && entry.skill === skill) {
        entry.selected = false;
      }
    }

    // Add new entry
    this.registry.entries.push({
      adapterId,
      category,
      skill,
      selected: true,
    });

    this.registry.lastUpdated = new Date().toISOString();
    this.dirty = true;

    getTracer().log('dream', 'info',
      `Registered disentangled adapter: ${adapterId} as ${category} for ${skill}`);
  }

  /**
   * Deregister a disentangled adapter.
   */
  deregisterAdapter(adapterId: string): void {
    const idx = this.registry.entries.findIndex((e) => e.adapterId === adapterId);
    if (idx !== -1) {
      this.registry.entries.splice(idx, 1);
      this.registry.lastUpdated = new Date().toISOString();
      this.dirty = true;
    }
  }

  // ── Training Data Classification ──────────────────────────────────────

  /**
   * Classify a training example as reasoning or tool-calling.
   *
   * Tool-calling examples contain tool invocations, function calls,
   * or structured tool output patterns. Everything else is reasoning.
   */
  classifyExample(instruction: string, completion: string): AdapterCategory {
    const text = (instruction + ' ' + completion).toLowerCase();

    // Tool-calling signals
    const toolSignals = [
      /\btool[_\s]?call/,
      /\bfunction[_\s]?call/,
      /\bread_file\b/,
      /\bwrite_file\b/,
      /\bedit_file\b/,
      /\bgrep\b.*\bpattern\b/,
      /\btool_call_id\b/,
      /\b(?:created|modified|read)\s+file/,
      /\bexecute[_\s]?command\b/,
      /\brun[_\s]?test/,
    ];

    for (const signal of toolSignals) {
      if (signal.test(text)) {
        return 'tools';
      }
    }

    return 'reasoning';
  }

  /**
   * Split training examples into reasoning and tool-calling categories.
   */
  splitByCategory(
    examples: Array<{ instruction: string; completion: string }>,
  ): {
    reasoning: Array<{ instruction: string; completion: string }>;
    tools: Array<{ instruction: string; completion: string }>;
  } {
    const reasoning: Array<{ instruction: string; completion: string }> = [];
    const tools: Array<{ instruction: string; completion: string }> = [];

    for (const example of examples) {
      const category = this.classifyExample(example.instruction, example.completion);
      if (category === 'tools') {
        tools.push(example);
      } else {
        reasoning.push(example);
      }
    }

    return { reasoning, tools };
  }

  // ── Queries ───────────────────────────────────────────────────────────

  /**
   * Get all disentangled adapter entries.
   */
  getEntries(): DisentangledAdapter[] {
    return [...this.registry.entries];
  }

  /**
   * Get entries for a specific category.
   */
  getEntriesByCategory(category: AdapterCategory): DisentangledAdapter[] {
    return this.registry.entries.filter((e) => e.category === category);
  }

  /**
   * Get entries for a specific skill.
   */
  getEntriesBySkill(skill: string): DisentangledAdapter[] {
    return this.registry.entries.filter((e) => e.skill === skill);
  }

  /**
   * Check if a skill has both reasoning and tools adapters.
   */
  isFullyDisentangled(skill: string): boolean {
    const entries = this.getEntriesBySkill(skill);
    const hasReasoning = entries.some((e) => e.category === 'reasoning' && e.selected);
    const hasTools = entries.some((e) => e.category === 'tools' && e.selected);
    return hasReasoning && hasTools;
  }

  /**
   * Build a summary of the disentangled adapter state.
   */
  buildSummary(): string {
    const lines: string[] = [
      `Disentangled Adapters: ${this.config.enabled ? 'enabled' : 'disabled'}`,
      `Total entries: ${this.registry.entries.length}`,
    ];

    const bySkill = new Map<string, DisentangledAdapter[]>();
    for (const entry of this.registry.entries) {
      const list = bySkill.get(entry.skill) ?? [];
      list.push(entry);
      bySkill.set(entry.skill, list);
    }

    if (bySkill.size > 0) {
      lines.push('');
      for (const [skill, entries] of bySkill) {
        const reasoning = entries.find((e) => e.category === 'reasoning' && e.selected);
        const tools = entries.find((e) => e.category === 'tools' && e.selected);
        lines.push(`  ${skill}:`);
        lines.push(`    reasoning: ${reasoning ? reasoning.adapterId : '(none)'}`);
        lines.push(`    tools: ${tools ? tools.adapterId : '(none)'}`);
      }
    }

    return lines.join('\n');
  }

  // ── Private Helpers ──────────────────────────────────────────────────

  private resolvePath(path: string): string {
    return path.replace(/^~/, process.env['HOME'] ?? '~');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────────────────────

export function createAdapterManager(
  config?: Partial<AdapterManagerConfig>,
): AdapterManager {
  return new AdapterManager(config);
}
