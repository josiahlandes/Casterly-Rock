/**
 * Context Assembly
 * Combines system prompt, conversation history, and current message into LLM context
 * Handles context window limits and history trimming
 */

import type { Skill } from '../skills/types.js';
import { buildSystemPrompt, type PromptBuilderOptions, type Channel, type PromptMode } from './prompt-builder.js';
import type { Session, ConversationMessage } from './session.js';

export interface ContextConfig {
  /** Maximum tokens for context (rough estimate: 1 token ≈ 4 chars) */
  maxContextTokens: number;
  /** Reserve tokens for the response */
  reserveForResponse: number;
  /** Maximum messages to include from history */
  maxHistoryMessages: number;
}

export interface ContextAssemblyOptions {
  /** The session with conversation history */
  session: Session;
  /** Current user message */
  userMessage: string;
  /** Sender identifier (for group chats) */
  sender?: string | undefined;
  /** Available skills */
  skills: Skill[];
  /** Channel type */
  channel: Channel;
  /** Prompt mode */
  mode?: PromptMode | undefined;
  /** Workspace path for bootstrap files */
  workspacePath?: string | undefined;
  /** Context config overrides */
  contextConfig?: Partial<ContextConfig> | undefined;
}

export interface AssembledContext {
  /** The complete context string to send to LLM */
  context: string;
  /** System prompt portion */
  systemPrompt: string;
  /** History portion */
  history: string;
  /** Current message portion */
  currentMessage: string;
  /** Number of history messages included */
  historyMessagesIncluded: number;
  /** Estimated token count */
  estimatedTokens: number;
}

const DEFAULT_CONTEXT_CONFIG: ContextConfig = {
  maxContextTokens: 3500,      // Stay well under Ollama's 4096 limit
  reserveForResponse: 500,
  maxHistoryMessages: 10,       // Fewer messages = faster responses
};

/**
 * Estimate token count (rough: 1 token ≈ 4 characters)
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Format a conversation message for context
 */
export function formatMessage(message: ConversationMessage, includeTimestamp = false): string {
  const roleLabel = message.role === 'user' ? 'User' : 'Assistant';
  const senderNote = message.sender ? ` (${message.sender})` : '';
  const timestamp = includeTimestamp ? ` [${message.timestamp}]` : '';

  return `${roleLabel}${senderNote}${timestamp}: ${message.content}`;
}

/**
 * Format conversation history for context
 */
export function formatHistory(messages: ConversationMessage[]): string {
  if (messages.length === 0) {
    return '';
  }

  return messages.map((m) => formatMessage(m)).join('\n\n');
}

/**
 * Trim history to fit within token budget
 */
export function trimHistoryToFit(
  messages: ConversationMessage[],
  maxTokens: number,
  maxMessages: number
): ConversationMessage[] {
  // Start with max messages limit
  let trimmed = messages.slice(-maxMessages);

  // Then trim by tokens if needed
  while (trimmed.length > 0) {
    const formatted = formatHistory(trimmed);
    if (estimateTokens(formatted) <= maxTokens) {
      break;
    }
    // Remove oldest message
    trimmed = trimmed.slice(1);
  }

  return trimmed;
}

/**
 * Assemble the complete context for LLM
 */
export function assembleContext(options: ContextAssemblyOptions): AssembledContext {
  const {
    session,
    userMessage,
    sender,
    skills,
    channel,
    mode = 'full',
    workspacePath,
    contextConfig = {},
  } = options;

  const config: ContextConfig = { ...DEFAULT_CONTEXT_CONFIG, ...contextConfig };

  // Build system prompt
  const promptOptions: PromptBuilderOptions = {
    mode,
    skills,
    channel,
    workspacePath,
  };
  const { systemPrompt } = buildSystemPrompt(promptOptions);
  const systemTokens = estimateTokens(systemPrompt);

  // Calculate token budget for history
  const availableForHistory = config.maxContextTokens - config.reserveForResponse - systemTokens;
  const userMessageTokens = estimateTokens(userMessage);
  const historyBudget = Math.max(0, availableForHistory - userMessageTokens - 100); // 100 token buffer

  // Get and trim history
  const fullHistory = session.getHistory(config.maxHistoryMessages);
  const trimmedHistory = trimHistoryToFit(fullHistory, historyBudget, config.maxHistoryMessages);
  const historyFormatted = formatHistory(trimmedHistory);

  // Format current message
  const senderNote = sender ? ` (from ${sender})` : '';
  const currentMessage = `User${senderNote}: ${userMessage}`;

  // Assemble parts
  const parts: string[] = [systemPrompt];

  if (historyFormatted) {
    parts.push('## Conversation History\n\n' + historyFormatted);
  }

  parts.push('## Current Message\n\n' + currentMessage);

  const context = parts.join('\n\n---\n\n');

  return {
    context,
    systemPrompt,
    history: historyFormatted,
    currentMessage,
    historyMessagesIncluded: trimmedHistory.length,
    estimatedTokens: estimateTokens(context),
  };
}

/**
 * Quick helper for iMessage context assembly
 */
export function assembleIMessageContext(
  session: Session,
  userMessage: string,
  skills: Skill[],
  sender?: string,
  workspacePath?: string
): string {
  const result = assembleContext({
    session,
    userMessage,
    sender,
    skills,
    channel: 'imessage',
    workspacePath,
  });
  return result.context;
}
