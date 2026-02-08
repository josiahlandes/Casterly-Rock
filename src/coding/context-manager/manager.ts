/**
 * Context Manager
 *
 * Central manager for the model's context window.
 * Coordinates file tracking, token budgeting, and context assembly.
 */

import * as path from 'path';
import { tokenCounter } from '../token-counter.js';
import { buildRepoMap, formatRepoMap } from '../repo-map/index.js';
import type { RepoMap } from '../repo-map/types.js';
import { FileTracker } from './file-tracker.js';
import { BudgetAllocator } from './budget.js';
import type {
  Context,
  ContextManagerConfig,
  Message,
  ToolResult,
  TokenBudget,
  FilePriority,
  FileContent,
} from './types.js';
import { DEFAULT_CONTEXT_CONFIG } from './types.js';

/**
 * Context manager for a coding session.
 */
export class ContextManager {
  private readonly rootPath: string;
  private readonly config: Required<Omit<ContextManagerConfig, 'rootPath'>>;

  private fileTracker: FileTracker;
  private budgetAllocator: BudgetAllocator;

  private systemPrompt: string = '';
  private repoMap: RepoMap | null = null;
  private repoMapFormatted: string = '';
  private conversation: Message[] = [];
  private toolResults: ToolResult[] = [];

  constructor(config: ContextManagerConfig) {
    this.rootPath = path.isAbsolute(config.rootPath)
      ? config.rootPath
      : path.resolve(config.rootPath);

    this.config = {
      ...DEFAULT_CONTEXT_CONFIG,
      ...config,
    };

    this.fileTracker = new FileTracker(this.rootPath, this.config.filesMax);
    this.budgetAllocator = new BudgetAllocator(this.config);
  }

  // ========== File Management ==========

  /**
   * Add a file to the context.
   */
  async addFile(
    relativePath: string,
    priority: FilePriority = 'medium'
  ): Promise<{ success: boolean; tokens?: number; error?: string }> {
    return this.fileTracker.addFile(relativePath, priority);
  }

  /**
   * Remove a file from context.
   */
  removeFile(relativePath: string): boolean {
    return this.fileTracker.removeFile(relativePath);
  }

  /**
   * Get all active file paths.
   */
  getActiveFiles(): string[] {
    return this.fileTracker.getFilePaths();
  }

  /**
   * Get a specific file's content.
   */
  getFileContent(relativePath: string): FileContent | undefined {
    return this.fileTracker.getFileContent(relativePath);
  }

  /**
   * Check if a file is in context.
   */
  isFileActive(relativePath: string): boolean {
    return this.fileTracker.isTracked(relativePath);
  }

  /**
   * Refresh a file's content after editing.
   */
  async refreshFile(relativePath: string): Promise<{ success: boolean; error?: string }> {
    return this.fileTracker.updateFile(relativePath);
  }

  /**
   * Mark a file as modified (for tracking purposes).
   */
  markFileModified(relativePath: string): void {
    this.fileTracker.markModified(relativePath);
  }

  /**
   * Get list of modified files.
   */
  getModifiedFiles(): string[] {
    return this.fileTracker.getModifiedFiles();
  }

  // ========== System Prompt ==========

  /**
   * Set the system prompt.
   */
  setSystemPrompt(prompt: string): void {
    this.systemPrompt = prompt;
  }

  /**
   * Get the current system prompt.
   */
  getSystemPrompt(): string {
    return this.systemPrompt;
  }

  // ========== Repo Map ==========

  /**
   * Build or rebuild the repo map.
   */
  async buildRepoMap(): Promise<void> {
    const optimalBudget = this.budgetAllocator.getOptimalRepoMapBudget(this.getUsageStats());

    this.repoMap = await buildRepoMap({
      rootPath: this.rootPath,
      tokenBudget: optimalBudget,
    });

    this.repoMapFormatted = formatRepoMap(this.repoMap);
  }

  /**
   * Get the current repo map.
   */
  getRepoMap(): RepoMap | null {
    return this.repoMap;
  }

  /**
   * Get formatted repo map string.
   */
  getFormattedRepoMap(): string {
    return this.repoMapFormatted;
  }

  // ========== Conversation ==========

  /**
   * Add a message to the conversation.
   */
  addMessage(role: Message['role'], content: string): Message {
    const message: Message = {
      role,
      content,
      tokens: tokenCounter.count(content),
      timestamp: new Date().toISOString(),
    };
    this.conversation.push(message);
    return message;
  }

  /**
   * Get the conversation history.
   */
  getConversation(): Message[] {
    return [...this.conversation];
  }

  /**
   * Clear conversation history.
   */
  clearConversation(): void {
    this.conversation = [];
  }

  /**
   * Trim conversation to fit budget.
   */
  trimConversation(targetTokens: number): void {
    let totalTokens = this.getConversationTokens();

    while (totalTokens > targetTokens && this.conversation.length > 1) {
      // Remove oldest non-system message
      const idx = this.conversation.findIndex((m) => m.role !== 'system');
      if (idx === -1) break;

      const removed = this.conversation.splice(idx, 1)[0];
      if (removed) {
        totalTokens -= removed.tokens;
      }
    }
  }

  /**
   * Get total tokens used by conversation.
   */
  getConversationTokens(): number {
    return this.conversation.reduce((sum, m) => sum + m.tokens, 0);
  }

  // ========== Tool Results ==========

  /**
   * Add a tool result.
   */
  addToolResult(
    tool: string,
    args: Record<string, unknown>,
    output: string,
    success: boolean
  ): ToolResult {
    const result: ToolResult = {
      tool,
      args,
      output,
      tokens: tokenCounter.count(output),
      success,
      timestamp: new Date().toISOString(),
    };
    this.toolResults.push(result);
    return result;
  }

  /**
   * Get tool results.
   */
  getToolResults(): ToolResult[] {
    return [...this.toolResults];
  }

  /**
   * Clear tool results (typically at start of new turn).
   */
  clearToolResults(): void {
    this.toolResults = [];
  }

  /**
   * Get total tokens used by tool results.
   */
  getToolResultTokens(): number {
    return this.toolResults.reduce((sum, r) => sum + r.tokens, 0);
  }

  // ========== Token Budget ==========

  /**
   * Get current usage statistics.
   */
  getUsageStats() {
    return {
      system: tokenCounter.count(this.systemPrompt),
      repoMap: tokenCounter.count(this.repoMapFormatted),
      files: this.fileTracker.getTotalTokens(),
      conversation: this.getConversationTokens(),
      tools: this.getToolResultTokens(),
    };
  }

  /**
   * Get current token budget allocation.
   */
  getTokenBudget(): TokenBudget {
    return this.budgetAllocator.getAllocation(this.getUsageStats()).budget;
  }

  /**
   * Get remaining tokens for new content.
   */
  getRemainingTokens(): number {
    return this.budgetAllocator.getTotalRemaining(this.getUsageStats());
  }

  /**
   * Check if we can fit additional tokens.
   */
  canFit(additionalTokens: number): boolean {
    return this.budgetAllocator.canFit(additionalTokens, this.getUsageStats());
  }

  /**
   * Get a summary of the current budget.
   */
  getBudgetSummary(): string {
    return this.budgetAllocator.getSummary(this.getUsageStats());
  }

  // ========== Context Building ==========

  /**
   * Build the complete context for the model.
   */
  buildContext(): Context {
    const usage = this.getUsageStats();
    const allocation = this.budgetAllocator.getAllocation(usage);

    return {
      systemPrompt: this.systemPrompt,
      repoMap: this.repoMapFormatted,
      fileContents: this.fileTracker.getAllContents(),
      conversation: this.getConversation(),
      toolResults: this.getToolResults(),
      tokenUsage: allocation.budget,
    };
  }

  /**
   * Get the root path.
   */
  getRootPath(): string {
    return this.rootPath;
  }

  /**
   * Reset all context (for new session).
   */
  reset(): void {
    this.fileTracker.clear();
    this.conversation = [];
    this.toolResults = [];
    this.repoMap = null;
    this.repoMapFormatted = '';
  }
}

/**
 * Create a new context manager.
 */
export function createContextManager(config: ContextManagerConfig): ContextManager {
  return new ContextManager(config);
}
