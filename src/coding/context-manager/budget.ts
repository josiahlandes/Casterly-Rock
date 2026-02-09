/**
 * Token Budget Allocator
 *
 * Manages token budget allocation across different context sections.
 * Dynamically adjusts allocations based on actual usage.
 */

import type { TokenBudget, ContextManagerConfig } from './types.js';
import { DEFAULT_CONTEXT_CONFIG } from './types.js';

/**
 * Current usage statistics.
 */
export interface UsageStats {
  system: number;
  repoMap: number;
  files: number;
  conversation: number;
  tools: number;
}

/**
 * Budget allocation result.
 */
export interface AllocationResult {
  /** Allocated budget for each section */
  budget: TokenBudget;
  /** Warnings about tight budgets */
  warnings: string[];
  /** Whether allocation is valid */
  valid: boolean;
}

/**
 * Token budget allocator.
 */
export class BudgetAllocator {
  private config: Required<Omit<ContextManagerConfig, 'rootPath'>>;

  constructor(config: Partial<Omit<ContextManagerConfig, 'rootPath'>> = {}) {
    this.config = {
      ...DEFAULT_CONTEXT_CONFIG,
      ...config,
    };
  }

  /**
   * Get the total context window size.
   */
  getContextWindow(): number {
    return this.config.contextWindow;
  }

  /**
   * Get the current budget allocation.
   */
  getAllocation(usage: UsageStats): AllocationResult {
    const warnings: string[] = [];
    const { contextWindow, systemReserve, responseReserve } = this.config;

    // Fixed reserves
    const fixedReserve = systemReserve + responseReserve;
    const availableForContent = contextWindow - fixedReserve;

    // Calculate actual usage
    const totalUsed = usage.system + usage.repoMap + usage.files + usage.conversation + usage.tools;

    // Build the budget
    const budget: TokenBudget = {
      total: contextWindow,
      system: Math.max(usage.system, systemReserve),
      repoMap: usage.repoMap,
      files: usage.files,
      conversation: usage.conversation,
      tools: usage.tools,
      response: responseReserve,
    };

    // Check for overages
    const usedExcludingResponse = totalUsed;
    const availableForResponse = contextWindow - usedExcludingResponse;

    if (availableForResponse < responseReserve) {
      warnings.push(
        `Response budget reduced: ${availableForResponse} tokens (wanted ${responseReserve})`
      );
      budget.response = Math.max(0, availableForResponse);
    }

    // Warn if sections exceed their maximums
    if (usage.repoMap > this.config.repoMapMax) {
      warnings.push(`Repo map exceeds budget: ${usage.repoMap} > ${this.config.repoMapMax}`);
    }
    if (usage.files > this.config.filesMax) {
      warnings.push(`Files exceed budget: ${usage.files} > ${this.config.filesMax}`);
    }
    if (usage.conversation > this.config.conversationMax) {
      warnings.push(
        `Conversation exceeds budget: ${usage.conversation} > ${this.config.conversationMax}`
      );
    }
    if (usage.tools > this.config.toolsMax) {
      warnings.push(`Tools exceed budget: ${usage.tools} > ${this.config.toolsMax}`);
    }

    // Check total validity
    const valid = totalUsed + budget.response <= contextWindow;

    return { budget, warnings, valid };
  }

  /**
   * Get remaining tokens for a specific section.
   */
  getRemainingForSection(
    section: 'repoMap' | 'files' | 'conversation' | 'tools',
    usage: UsageStats
  ): number {
    const maxForSection = this.config[`${section}Max` as keyof typeof this.config] as number;
    const currentUsage = usage[section];
    return Math.max(0, maxForSection - currentUsage);
  }

  /**
   * Get total remaining tokens (excluding response reserve).
   */
  getTotalRemaining(usage: UsageStats): number {
    const totalUsed = usage.system + usage.repoMap + usage.files + usage.conversation + usage.tools;
    return Math.max(0, this.config.contextWindow - this.config.responseReserve - totalUsed);
  }

  /**
   * Check if we can fit additional tokens.
   */
  canFit(additionalTokens: number, usage: UsageStats): boolean {
    return this.getTotalRemaining(usage) >= additionalTokens;
  }

  /**
   * Suggest how much to trim from each section to fit within budget.
   */
  suggestTrimming(usage: UsageStats): {
    repoMap?: number;
    files?: number;
    conversation?: number;
    tools?: number;
  } {
    const overage =
      usage.system +
      usage.repoMap +
      usage.files +
      usage.conversation +
      usage.tools +
      this.config.responseReserve -
      this.config.contextWindow;

    if (overage <= 0) {
      return {};
    }

    const suggestions: { repoMap?: number; files?: number; conversation?: number; tools?: number } =
      {};
    let remaining = overage;

    // Trim in order: tools, conversation, repo map, files
    // (Preserving files as highest priority)

    // Trim tools first
    if (remaining > 0 && usage.tools > 0) {
      const trimTools = Math.min(remaining, usage.tools);
      suggestions.tools = usage.tools - trimTools;
      remaining -= trimTools;
    }

    // Trim older conversation
    if (remaining > 0 && usage.conversation > this.config.conversationMax * 0.5) {
      const trimConv = Math.min(remaining, usage.conversation - this.config.conversationMax * 0.5);
      suggestions.conversation = usage.conversation - trimConv;
      remaining -= trimConv;
    }

    // Trim repo map
    if (remaining > 0 && usage.repoMap > this.config.repoMapMax * 0.5) {
      const trimMap = Math.min(remaining, usage.repoMap - this.config.repoMapMax * 0.5);
      suggestions.repoMap = usage.repoMap - trimMap;
      remaining -= trimMap;
    }

    // Trim files as last resort
    if (remaining > 0) {
      suggestions.files = Math.max(0, usage.files - remaining);
    }

    return suggestions;
  }

  /**
   * Get optimal repo map budget based on current file usage.
   *
   * If no files are loaded, expand repo map budget.
   * If many files are loaded, shrink repo map budget.
   */
  getOptimalRepoMapBudget(usage: UsageStats): number {
    const fileUsageRatio = usage.files / this.config.filesMax;

    if (fileUsageRatio < 0.1) {
      // No/few files: expand repo map
      return Math.min(this.config.repoMapMax * 2, 8192);
    } else if (fileUsageRatio > 0.8) {
      // Many files: shrink repo map
      return Math.max(this.config.repoMapMax * 0.5, 1024);
    }

    return this.config.repoMapMax;
  }

  /**
   * Update configuration.
   */
  updateConfig(updates: Partial<Omit<ContextManagerConfig, 'rootPath'>>): void {
    Object.assign(this.config, updates);
  }

  /**
   * Get a summary of the current budget.
   */
  getSummary(usage: UsageStats): string {
    const allocation = this.getAllocation(usage);
    const totalUsed =
      usage.system + usage.repoMap + usage.files + usage.conversation + usage.tools;
    const remaining = this.config.contextWindow - totalUsed - allocation.budget.response;

    const lines = [
      `Context Budget (${this.config.contextWindow.toLocaleString()} total):`,
      `  System:       ${usage.system.toLocaleString().padStart(6)} / ${this.config.systemReserve.toLocaleString()}`,
      `  Repo Map:     ${usage.repoMap.toLocaleString().padStart(6)} / ${this.config.repoMapMax.toLocaleString()}`,
      `  Files:        ${usage.files.toLocaleString().padStart(6)} / ${this.config.filesMax.toLocaleString()}`,
      `  Conversation: ${usage.conversation.toLocaleString().padStart(6)} / ${this.config.conversationMax.toLocaleString()}`,
      `  Tools:        ${usage.tools.toLocaleString().padStart(6)} / ${this.config.toolsMax.toLocaleString()}`,
      `  Response:     ${allocation.budget.response.toLocaleString().padStart(6)} (reserved)`,
      `  Remaining:    ${remaining.toLocaleString().padStart(6)}`,
    ];

    if (allocation.warnings.length > 0) {
      lines.push('', 'Warnings:');
      for (const warning of allocation.warnings) {
        lines.push(`  ⚠ ${warning}`);
      }
    }

    return lines.join('\n');
  }
}
