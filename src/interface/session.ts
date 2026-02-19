/**
 * Session Management
 * Handles conversation state, history persistence, and session isolation
 * Compatible with OpenClaw's session model
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

export type SessionScope = 'main' | 'per-peer' | 'per-channel';

/**
 * Content block types for rich message content
 * Supports text, tool use, and tool results
 */
type TextBlock = {
  type: 'text';
  text: string;
};

type ToolUseBlock = {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
};

type ToolResultBlock = {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
  is_error?: boolean | undefined;
};

type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;

/**
 * Message content can be either a simple string or an array of content blocks
 */
type MessageContent = string | ContentBlock[];

export interface SessionConfig {
  /** How to isolate sessions */
  scope: SessionScope;
  /** Base directory for session storage */
  basePath: string;
  /** Maximum messages to keep in memory */
  maxHistoryMessages: number;
  /** Reset session daily at this hour (0-23, or null to disable) */
  dailyResetHour: number | null;
}

export interface ConversationMessage {
  role: 'user' | 'assistant' | 'system';
  /** Message content - string for simple text, array of blocks for rich content */
  content: MessageContent;
  timestamp: string;
  /** For user messages, the sender identifier */
  sender?: string | undefined;
}

/**
 * Extract text content from a message
 * Handles both string content and content block arrays
 */
export function getMessageText(message: ConversationMessage): string {
  if (typeof message.content === 'string') {
    return message.content;
  }

  return message.content
    .filter((block): block is TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('');
}

export interface SessionState {
  /** Unique session key */
  key: string;
  /** Channel type */
  channel: string;
  /** When the session was created */
  createdAt: string;
  /** When the session was last active */
  lastActiveAt: string;
  /** Conversation history (in-memory, trimmed) */
  messages: ConversationMessage[];
  /** Total messages ever in this session */
  totalMessages: number;
}

export interface Session {
  /** Session state */
  state: SessionState;
  /** Add a message to the session */
  addMessage(message: Omit<ConversationMessage, 'timestamp'>): void;
  /** Get recent messages for context */
  getHistory(maxMessages?: number): ConversationMessage[];
  /** Clear the session (reset) */
  clear(): void;
  /** Save session to disk */
  save(): void;
  /** Check if session should reset based on time */
  shouldReset(config: SessionConfig): boolean;
}

const DEFAULT_SESSION_CONFIG: SessionConfig = {
  scope: 'main',
  basePath: join(homedir(), '.casterly', 'sessions'),
  maxHistoryMessages: 50,
  dailyResetHour: 4, // 4 AM
};

/**
 * Generate a session key based on scope and identifiers
 */
export function generateSessionKey(
  channel: string,
  scope: SessionScope,
  peerId?: string,
  channelId?: string
): string {
  switch (scope) {
    case 'main':
      return `${channel}:main`;
    case 'per-peer':
      return `${channel}:peer:${peerId || 'unknown'}`;
    case 'per-channel':
      return `${channel}:channel:${channelId || 'unknown'}`;
    default:
      return `${channel}:main`;
  }
}

/**
 * Get the file path for a session
 */
export function getSessionFilePath(basePath: string, key: string): string {
  // Sanitize key for filesystem
  const safeKey = key.replace(/[^a-zA-Z0-9_:-]/g, '_');
  return join(basePath, `${safeKey}.jsonl`);
}

/**
 * Load session state from disk
 */
export function loadSessionState(filePath: string, key: string, channel: string): SessionState {
  const now = new Date().toISOString();

  const defaultState: SessionState = {
    key,
    channel,
    createdAt: now,
    lastActiveAt: now,
    messages: [],
    totalMessages: 0,
  };

  if (!existsSync(filePath)) {
    return defaultState;
  }

  try {
    const content = readFileSync(filePath, 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);

    if (lines.length === 0) {
      return defaultState;
    }

    // First line is metadata
    const firstLine = lines[0];
    if (!firstLine) {
      return defaultState;
    }
    const metadata = JSON.parse(firstLine) as Partial<SessionState>;

    // Remaining lines are messages
    const messages: ConversationMessage[] = [];
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue;
      try {
        const msg = JSON.parse(line) as ConversationMessage;
        messages.push(msg);
      } catch {
        // Skip malformed lines
      }
    }

    return {
      key: metadata.key || key,
      channel: metadata.channel || channel,
      createdAt: metadata.createdAt || now,
      lastActiveAt: now,
      messages,
      totalMessages: metadata.totalMessages || messages.length,
    };
  } catch {
    return defaultState;
  }
}

/**
 * Save session state to disk
 */
export function saveSessionState(filePath: string, state: SessionState): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  // Write metadata as first line
  const metadata = {
    key: state.key,
    channel: state.channel,
    createdAt: state.createdAt,
    lastActiveAt: state.lastActiveAt,
    totalMessages: state.totalMessages,
  };

  const lines = [
    JSON.stringify(metadata),
    ...state.messages.map((m) => JSON.stringify(m)),
  ];

  writeFileSync(filePath, lines.join('\n') + '\n');
}

/**
 * Append a message to session file (for incremental saves)
 */
export function appendMessageToSession(filePath: string, message: ConversationMessage): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  appendFileSync(filePath, JSON.stringify(message) + '\n');
}

/**
 * Check if a session should reset based on daily reset hour
 */
export function shouldSessionReset(
  lastActiveAt: string,
  dailyResetHour: number | null
): boolean {
  if (dailyResetHour === null) {
    return false;
  }

  const lastActive = new Date(lastActiveAt);
  const now = new Date();

  // Check if we've crossed the reset hour since last active
  const resetToday = new Date(now);
  resetToday.setHours(dailyResetHour, 0, 0, 0);

  const resetYesterday = new Date(resetToday);
  resetYesterday.setDate(resetYesterday.getDate() - 1);

  // If last active was before today's reset time and now is after, reset
  if (lastActive < resetToday && now >= resetToday) {
    return true;
  }

  // If last active was before yesterday's reset and now is after yesterday's reset
  // (handles case where multiple days have passed)
  if (lastActive < resetYesterday) {
    return true;
  }

  return false;
}

/**
 * Create a session manager
 */
export function createSession(
  channel: string,
  config: Partial<SessionConfig> = {},
  peerId?: string,
  channelId?: string
): Session {
  const fullConfig: SessionConfig = { ...DEFAULT_SESSION_CONFIG, ...config };
  const key = generateSessionKey(channel, fullConfig.scope, peerId, channelId);
  const filePath = getSessionFilePath(fullConfig.basePath, key);

  let state = loadSessionState(filePath, key, channel);

  // Check for daily reset
  if (shouldSessionReset(state.lastActiveAt, fullConfig.dailyResetHour)) {
    state = {
      key,
      channel,
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
      messages: [],
      totalMessages: 0,
    };
  }

  const session: Session = {
    state,

    addMessage(message: Omit<ConversationMessage, 'timestamp'>) {
      const fullMessage: ConversationMessage = {
        ...message,
        timestamp: new Date().toISOString(),
      };

      state.messages.push(fullMessage);
      state.totalMessages++;
      state.lastActiveAt = fullMessage.timestamp;

      // Trim history if needed
      if (state.messages.length > fullConfig.maxHistoryMessages) {
        const excess = state.messages.length - fullConfig.maxHistoryMessages;
        state.messages.splice(0, excess);
      }

      // Append to file for durability
      appendMessageToSession(filePath, fullMessage);
    },

    getHistory(maxMessages?: number): ConversationMessage[] {
      const limit = maxMessages ?? fullConfig.maxHistoryMessages;
      return state.messages.slice(-limit);
    },

    clear() {
      state.messages = [];
      state.createdAt = new Date().toISOString();
      state.lastActiveAt = state.createdAt;
      // Don't reset totalMessages - keep for stats
      this.save();
    },

    save() {
      saveSessionState(filePath, state);
    },

    shouldReset(cfg: SessionConfig): boolean {
      return shouldSessionReset(state.lastActiveAt, cfg.dailyResetHour);
    },
  };

  return session;
}

/**
 * Session manager for handling multiple sessions
 */
export interface SessionManager {
  /** Get or create a session */
  getSession(channel: string, peerId?: string, channelId?: string): Session;
  /** Clear all sessions */
  clearAll(): void;
}

export function createSessionManager(config: Partial<SessionConfig> = {}): SessionManager {
  const sessions = new Map<string, Session>();
  const fullConfig: SessionConfig = { ...DEFAULT_SESSION_CONFIG, ...config };

  return {
    getSession(channel: string, peerId?: string, channelId?: string): Session {
      const key = generateSessionKey(channel, fullConfig.scope, peerId, channelId);

      let session = sessions.get(key);
      if (!session) {
        session = createSession(channel, fullConfig, peerId, channelId);
        sessions.set(key, session);
      }

      // Check for reset
      if (session.shouldReset(fullConfig)) {
        session.clear();
      }

      return session;
    },

    clearAll() {
      for (const session of sessions.values()) {
        session.clear();
      }
      sessions.clear();
    },
  };
}
