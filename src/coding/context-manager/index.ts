/**
 * Context Manager Module
 *
 * Manages the model's context window, including file tracking,
 * token budgeting, and context assembly.
 */

export { ContextManager, createContextManager } from './manager.js';
export { FileTracker } from './file-tracker.js';
export { BudgetAllocator } from './budget.js';
export type { UsageStats, AllocationResult } from './budget.js';
export { suggestFiles, rankFileRelevance } from './auto-context.js';
export type { SuggestOptions, SuggestedFile } from './auto-context.js';

// Export types from types.ts (excluding TokenBudget which is already exported from token-counter)
export { DEFAULT_CONTEXT_CONFIG, CONTEXT_PRESETS } from './types.js';
export type {
  Context,
  FileContent,
  Message,
  ToolResult,
  ContextManagerConfig,
  FilePriority,
  TrackedFile,
} from './types.js';
