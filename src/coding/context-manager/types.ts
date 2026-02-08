/**
 * Context Manager Types
 *
 * Type definitions for the context management system.
 */

import type { TokenBudget } from '../token-counter.js';

// Re-export TokenBudget for convenience
export type { TokenBudget } from '../token-counter.js';

/**
 * Assembled context ready for the model.
 */
export interface Context {
  /** System prompt with rules and persona */
  systemPrompt: string;
  /** Compressed repo map */
  repoMap: string;
  /** Full contents of active files */
  fileContents: Map<string, FileContent>;
  /** Conversation history */
  conversation: Message[];
  /** Tool results from current turn */
  toolResults: ToolResult[];
  /** Current token usage */
  tokenUsage: TokenBudget;
}

/**
 * File content with metadata.
 */
export interface FileContent {
  /** Relative path from repo root */
  path: string;
  /** Full file content */
  content: string;
  /** Token count */
  tokens: number;
  /** When the file was loaded */
  loadedAt: string;
  /** Whether the file has been modified in this session */
  modified: boolean;
}

/**
 * A conversation message.
 */
export interface Message {
  /** Role: user, assistant, or system */
  role: 'user' | 'assistant' | 'system';
  /** Message content */
  content: string;
  /** Token count */
  tokens: number;
  /** Timestamp */
  timestamp: string;
}

/**
 * A tool execution result.
 */
export interface ToolResult {
  /** Tool name */
  tool: string;
  /** Tool arguments */
  args: Record<string, unknown>;
  /** Tool output */
  output: string;
  /** Token count */
  tokens: number;
  /** Whether the tool succeeded */
  success: boolean;
  /** Timestamp */
  timestamp: string;
}

/**
 * Configuration for the context manager.
 */
export interface ContextManagerConfig {
  /** Total context window size (default: 128000) */
  contextWindow?: number;
  /** Tokens reserved for system prompt (default: 2000) */
  systemReserve?: number;
  /** Tokens reserved for response (default: 4000) */
  responseReserve?: number;
  /** Maximum tokens for repo map (default: 4000) */
  repoMapMax?: number;
  /** Maximum tokens for file contents (default: 40000) */
  filesMax?: number;
  /** Maximum tokens for conversation (default: 20000) */
  conversationMax?: number;
  /** Maximum tokens for tool results (default: 10000) */
  toolsMax?: number;
  /** Repository root path */
  rootPath: string;
}

/**
 * Default configuration values.
 */
export const DEFAULT_CONTEXT_CONFIG: Required<Omit<ContextManagerConfig, 'rootPath'>> = {
  contextWindow: 128000,
  systemReserve: 2000,
  responseReserve: 4000,
  repoMapMax: 4000,
  filesMax: 40000,
  conversationMax: 20000,
  toolsMax: 10000,
};

/**
 * Context allocation presets for different scenarios.
 */
export const CONTEXT_PRESETS = {
  /** Default balanced allocation */
  balanced: {
    contextWindow: 128000,
    systemReserve: 2000,
    responseReserve: 4000,
    repoMapMax: 4000,
    filesMax: 40000,
    conversationMax: 20000,
    toolsMax: 10000,
  },
  /** Focus on large file editing */
  fileHeavy: {
    contextWindow: 128000,
    systemReserve: 1500,
    responseReserve: 4000,
    repoMapMax: 2000,
    filesMax: 60000,
    conversationMax: 10000,
    toolsMax: 8000,
  },
  /** Focus on long conversations */
  conversationHeavy: {
    contextWindow: 128000,
    systemReserve: 2000,
    responseReserve: 4000,
    repoMapMax: 2000,
    filesMax: 20000,
    conversationMax: 40000,
    toolsMax: 10000,
  },
  /** Minimal context for quick tasks */
  minimal: {
    contextWindow: 32000,
    systemReserve: 1000,
    responseReserve: 2000,
    repoMapMax: 2000,
    filesMax: 10000,
    conversationMax: 8000,
    toolsMax: 4000,
  },
} as const;

/**
 * Priority levels for files.
 */
export type FilePriority = 'required' | 'high' | 'medium' | 'low';

/**
 * Tracked file with priority and metadata.
 */
export interface TrackedFile {
  /** Relative path */
  path: string;
  /** Priority level */
  priority: FilePriority;
  /** Token count */
  tokens: number;
  /** When added to context */
  addedAt: string;
  /** Last accessed time */
  lastAccessedAt: string;
  /** Number of times accessed */
  accessCount: number;
}
