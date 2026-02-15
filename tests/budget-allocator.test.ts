import { describe, expect, it } from 'vitest';

import {
  BudgetAllocator,
  type UsageStats,
} from '../src/coding/context-manager/budget.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

function emptyUsage(): UsageStats {
  return { system: 0, repoMap: 0, files: 0, conversation: 0, tools: 0 };
}

function makeUsage(overrides: Partial<UsageStats> = {}): UsageStats {
  return { ...emptyUsage(), ...overrides };
}

// ═══════════════════════════════════════════════════════════════════════════════
// BudgetAllocator — basic construction
// ═══════════════════════════════════════════════════════════════════════════════

describe('BudgetAllocator — construction', () => {
  it('uses default config when no overrides', () => {
    const allocator = new BudgetAllocator();
    expect(allocator.getContextWindow()).toBe(128000);
  });

  it('accepts custom config', () => {
    const allocator = new BudgetAllocator({ contextWindow: 32000 });
    expect(allocator.getContextWindow()).toBe(32000);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// getAllocation
// ═══════════════════════════════════════════════════════════════════════════════

describe('BudgetAllocator — getAllocation', () => {
  it('returns valid allocation for empty usage', () => {
    const allocator = new BudgetAllocator();
    const result = allocator.getAllocation(emptyUsage());
    expect(result.valid).toBe(true);
    expect(result.warnings).toHaveLength(0);
    expect(result.budget.total).toBe(128000);
    expect(result.budget.response).toBe(4000); // default responseReserve
  });

  it('returns valid allocation for moderate usage', () => {
    const allocator = new BudgetAllocator();
    const usage = makeUsage({
      system: 1500,
      repoMap: 2000,
      files: 10000,
      conversation: 5000,
      tools: 1000,
    });
    const result = allocator.getAllocation(usage);
    expect(result.valid).toBe(true);
    expect(result.warnings).toHaveLength(0);
  });

  it('warns when sections exceed maximums', () => {
    const allocator = new BudgetAllocator({
      repoMapMax: 4000,
      filesMax: 40000,
    });
    const usage = makeUsage({
      repoMap: 5000, // exceeds 4000
      files: 50000,  // exceeds 40000
    });
    const result = allocator.getAllocation(usage);
    expect(result.warnings.length).toBeGreaterThanOrEqual(2);
    expect(result.warnings.some((w) => w.includes('Repo map'))).toBe(true);
    expect(result.warnings.some((w) => w.includes('Files'))).toBe(true);
  });

  it('warns when response budget is reduced', () => {
    const allocator = new BudgetAllocator({
      contextWindow: 10000,
      responseReserve: 4000,
    });
    const usage = makeUsage({
      system: 3000,
      files: 5000,
      // Total = 8000, only 2000 left for response (wanted 4000)
    });
    const result = allocator.getAllocation(usage);
    expect(result.warnings.some((w) => w.includes('Response budget reduced'))).toBe(true);
    expect(result.budget.response).toBeLessThan(4000);
  });

  it('returns invalid when totally over budget', () => {
    const allocator = new BudgetAllocator({
      contextWindow: 10000,
      responseReserve: 2000,
    });
    const usage = makeUsage({
      system: 5000,
      files: 5000,
      conversation: 5000,
      // Total = 15000, exceeds 10000 context window
    });
    const result = allocator.getAllocation(usage);
    expect(result.valid).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// getRemainingForSection
// ═══════════════════════════════════════════════════════════════════════════════

describe('BudgetAllocator — getRemainingForSection', () => {
  it('returns full max when section is empty', () => {
    const allocator = new BudgetAllocator({ repoMapMax: 4000 });
    const remaining = allocator.getRemainingForSection('repoMap', emptyUsage());
    expect(remaining).toBe(4000);
  });

  it('returns reduced amount when partially used', () => {
    const allocator = new BudgetAllocator({ filesMax: 40000 });
    const usage = makeUsage({ files: 15000 });
    expect(allocator.getRemainingForSection('files', usage)).toBe(25000);
  });

  it('returns 0 when at or over max', () => {
    const allocator = new BudgetAllocator({ conversationMax: 20000 });
    const usage = makeUsage({ conversation: 25000 });
    expect(allocator.getRemainingForSection('conversation', usage)).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// getTotalRemaining / canFit
// ═══════════════════════════════════════════════════════════════════════════════

describe('BudgetAllocator — getTotalRemaining', () => {
  it('returns full available budget for empty usage', () => {
    const allocator = new BudgetAllocator({
      contextWindow: 10000,
      responseReserve: 2000,
    });
    // Available = 10000 - 2000 (response) - 0 (used) = 8000
    expect(allocator.getTotalRemaining(emptyUsage())).toBe(8000);
  });

  it('subtracts usage from total', () => {
    const allocator = new BudgetAllocator({
      contextWindow: 10000,
      responseReserve: 2000,
    });
    const usage = makeUsage({ system: 1000, files: 3000 });
    // Available = 10000 - 2000 - 4000 = 4000
    expect(allocator.getTotalRemaining(usage)).toBe(4000);
  });

  it('returns 0 when over budget', () => {
    const allocator = new BudgetAllocator({
      contextWindow: 5000,
      responseReserve: 2000,
    });
    const usage = makeUsage({ system: 2000, files: 3000 });
    expect(allocator.getTotalRemaining(usage)).toBe(0);
  });
});

describe('BudgetAllocator — canFit', () => {
  it('returns true when tokens fit', () => {
    const allocator = new BudgetAllocator({
      contextWindow: 10000,
      responseReserve: 2000,
    });
    expect(allocator.canFit(5000, emptyUsage())).toBe(true);
  });

  it('returns false when tokens exceed remaining', () => {
    const allocator = new BudgetAllocator({
      contextWindow: 10000,
      responseReserve: 2000,
    });
    expect(allocator.canFit(9000, emptyUsage())).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// suggestTrimming
// ═══════════════════════════════════════════════════════════════════════════════

describe('BudgetAllocator — suggestTrimming', () => {
  it('returns empty when within budget', () => {
    const allocator = new BudgetAllocator({ contextWindow: 100000 });
    const usage = makeUsage({ system: 1000 });
    expect(allocator.suggestTrimming(usage)).toEqual({});
  });

  it('trims tools first', () => {
    const allocator = new BudgetAllocator({
      contextWindow: 10000,
      responseReserve: 2000,
    });
    const usage = makeUsage({
      system: 3000,
      files: 3000,
      tools: 5000,
      // Total = 11000 + 2000 response = 13000 > 10000
    });
    const suggestions = allocator.suggestTrimming(usage);
    expect(suggestions.tools).toBeDefined();
    // Should suggest reducing tools
    expect(suggestions.tools!).toBeLessThan(5000);
  });

  it('trims files as last resort', () => {
    const allocator = new BudgetAllocator({
      contextWindow: 5000,
      responseReserve: 1000,
      conversationMax: 1000,
      repoMapMax: 1000,
    });
    const usage = makeUsage({
      system: 2000,
      files: 5000,
      // tools=0, conversation=0, repoMap=0
      // Total = 7000 + 1000 = 8000 > 5000, overage = 3000
      // After trimming tools (0), conversation (0 but below 50% of max), repoMap (0 but below 50% of max)
      // Must trim files
    });
    const suggestions = allocator.suggestTrimming(usage);
    expect(suggestions.files).toBeDefined();
    expect(suggestions.files!).toBeLessThan(5000);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// getOptimalRepoMapBudget
// ═══════════════════════════════════════════════════════════════════════════════

describe('BudgetAllocator — getOptimalRepoMapBudget', () => {
  it('expands repo map when few files loaded', () => {
    const allocator = new BudgetAllocator({
      repoMapMax: 4000,
      filesMax: 40000,
    });
    // file usage ratio = 0/40000 = 0 → expand
    const budget = allocator.getOptimalRepoMapBudget(makeUsage({ files: 0 }));
    expect(budget).toBeGreaterThan(4000);
    expect(budget).toBeLessThanOrEqual(8192);
  });

  it('shrinks repo map when many files loaded', () => {
    const allocator = new BudgetAllocator({
      repoMapMax: 4000,
      filesMax: 40000,
    });
    // file usage ratio = 36000/40000 = 0.9 → shrink
    const budget = allocator.getOptimalRepoMapBudget(makeUsage({ files: 36000 }));
    expect(budget).toBeLessThan(4000);
    expect(budget).toBeGreaterThanOrEqual(1024);
  });

  it('returns default when moderate file usage', () => {
    const allocator = new BudgetAllocator({
      repoMapMax: 4000,
      filesMax: 40000,
    });
    // file usage ratio = 20000/40000 = 0.5 → default
    const budget = allocator.getOptimalRepoMapBudget(makeUsage({ files: 20000 }));
    expect(budget).toBe(4000);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// updateConfig / getSummary
// ═══════════════════════════════════════════════════════════════════════════════

describe('BudgetAllocator — updateConfig', () => {
  it('updates context window', () => {
    const allocator = new BudgetAllocator();
    expect(allocator.getContextWindow()).toBe(128000);
    allocator.updateConfig({ contextWindow: 32000 });
    expect(allocator.getContextWindow()).toBe(32000);
  });
});

describe('BudgetAllocator — getSummary', () => {
  it('returns formatted summary string', () => {
    const allocator = new BudgetAllocator({ contextWindow: 32000 });
    const usage = makeUsage({ system: 1000, files: 5000 });
    const summary = allocator.getSummary(usage);
    expect(summary).toContain('Context Budget');
    expect(summary).toContain('32,000');
    expect(summary).toContain('System:');
    expect(summary).toContain('Files:');
    expect(summary).toContain('Remaining:');
  });

  it('includes warnings in summary', () => {
    const allocator = new BudgetAllocator({
      contextWindow: 10000,
      repoMapMax: 1000,
    });
    const usage = makeUsage({ repoMap: 5000 });
    const summary = allocator.getSummary(usage);
    expect(summary).toContain('Warnings:');
    expect(summary).toContain('Repo map');
  });
});
