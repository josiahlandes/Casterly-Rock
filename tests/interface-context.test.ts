import { describe, expect, it, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  estimateTokens,
  formatMessage,
  formatHistory,
  trimHistoryToFit,
  assembleContext,
} from '../src/interface/context.js';
import type { ConversationMessage, Session, SessionState } from '../src/interface/session.js';
import {
  getMessageText,
  isSimpleContent,
  createTextMessage,
  createBlockMessage,
  generateSessionKey,
  getSessionFilePath,
  loadSessionState,
  saveSessionState,
  appendMessageToSession,
  shouldSessionReset,
} from '../src/interface/session.js';
import type { ContentBlock } from '../src/interface/session.js';

// ─── Temp dir helpers ────────────────────────────────────────────────────────

const TEST_BASE = join(tmpdir(), `casterly-context-test-${Date.now()}`);

afterEach(() => {
  if (existsSync(TEST_BASE)) {
    rmSync(TEST_BASE, { recursive: true, force: true });
  }
});

// ─── Message helpers ─────────────────────────────────────────────────────────

function makeMsg(
  role: 'user' | 'assistant',
  text: string,
  sender?: string,
): ConversationMessage {
  return {
    role,
    content: text,
    timestamp: '2024-01-01T00:00:00Z',
    sender,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// estimateTokens
// ═══════════════════════════════════════════════════════════════════════════════

describe('estimateTokens', () => {
  it('estimates tokens as length / 4', () => {
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcdefgh')).toBe(2);
  });

  it('rounds up', () => {
    expect(estimateTokens('abcde')).toBe(2); // 5/4 = 1.25 → 2
  });

  it('returns 0 for empty string', () => {
    expect(estimateTokens('')).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// getMessageText
// ═══════════════════════════════════════════════════════════════════════════════

describe('getMessageText', () => {
  it('returns string content directly', () => {
    const msg = makeMsg('user', 'Hello world');
    expect(getMessageText(msg)).toBe('Hello world');
  });

  it('extracts text from content blocks', () => {
    const msg: ConversationMessage = {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Part one ' },
        { type: 'text', text: 'Part two' },
      ],
      timestamp: '2024-01-01T00:00:00Z',
    };
    expect(getMessageText(msg)).toBe('Part one Part two');
  });

  it('ignores non-text blocks', () => {
    const msg: ConversationMessage = {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Hello' },
        { type: 'tool_use', id: 't1', name: 'bash', input: { cmd: 'ls' } },
        { type: 'text', text: ' World' },
      ],
      timestamp: '2024-01-01T00:00:00Z',
    };
    expect(getMessageText(msg)).toBe('Hello World');
  });

  it('returns empty string for empty blocks', () => {
    const msg: ConversationMessage = {
      role: 'assistant',
      content: [],
      timestamp: '2024-01-01T00:00:00Z',
    };
    expect(getMessageText(msg)).toBe('');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// isSimpleContent
// ═══════════════════════════════════════════════════════════════════════════════

describe('isSimpleContent', () => {
  it('returns true for string', () => {
    expect(isSimpleContent('hello')).toBe(true);
  });

  it('returns false for content blocks array', () => {
    expect(isSimpleContent([{ type: 'text', text: 'x' }])).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// createTextMessage / createBlockMessage
// ═══════════════════════════════════════════════════════════════════════════════

describe('createTextMessage', () => {
  it('creates a user text message', () => {
    const msg = createTextMessage('user', 'Hi');
    expect(msg.role).toBe('user');
    expect(msg.content).toBe('Hi');
    expect(msg.sender).toBeUndefined();
  });

  it('includes sender when provided', () => {
    const msg = createTextMessage('user', 'Hi', 'John');
    expect(msg.sender).toBe('John');
  });

  it('creates assistant message', () => {
    const msg = createTextMessage('assistant', 'Hello!');
    expect(msg.role).toBe('assistant');
    expect(msg.content).toBe('Hello!');
  });
});

describe('createBlockMessage', () => {
  it('creates a message with content blocks', () => {
    const blocks: ContentBlock[] = [
      { type: 'text', text: 'Result' },
      { type: 'tool_result', tool_use_id: 't1', content: 'output' },
    ];
    const msg = createBlockMessage('assistant', blocks);
    expect(msg.role).toBe('assistant');
    expect(Array.isArray(msg.content)).toBe(true);
    expect((msg.content as ContentBlock[]).length).toBe(2);
  });

  it('includes sender when provided', () => {
    const msg = createBlockMessage('user', [{ type: 'text', text: 'Hi' }], 'Katie');
    expect(msg.sender).toBe('Katie');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// formatMessage
// ═══════════════════════════════════════════════════════════════════════════════

describe('formatMessage', () => {
  it('formats user message', () => {
    const msg = makeMsg('user', 'Hello');
    expect(formatMessage(msg)).toBe('User: Hello');
  });

  it('formats assistant message', () => {
    const msg = makeMsg('assistant', 'Hi there');
    expect(formatMessage(msg)).toBe('Assistant: Hi there');
  });

  it('includes sender when present', () => {
    const msg = makeMsg('user', 'Hello', 'josiah');
    expect(formatMessage(msg)).toBe('User (josiah): Hello');
  });

  it('includes timestamp when requested', () => {
    const msg = makeMsg('user', 'Hello');
    const formatted = formatMessage(msg, true);
    expect(formatted).toContain('[2024-01-01T00:00:00Z]');
  });

  it('excludes timestamp by default', () => {
    const msg = makeMsg('user', 'Hello');
    const formatted = formatMessage(msg);
    expect(formatted).not.toContain('2024-01-01');
  });

  it('extracts text from content blocks', () => {
    const msg: ConversationMessage = {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Here is the result: ' },
        { type: 'tool_use', id: 'tool-1', name: 'bash', input: {} },
        { type: 'text', text: 'done' },
      ],
      timestamp: '2024-01-01T00:00:00Z',
    };
    const formatted = formatMessage(msg);
    expect(formatted).toBe('Assistant: Here is the result: done');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// formatHistory
// ═══════════════════════════════════════════════════════════════════════════════

describe('formatHistory', () => {
  it('returns empty string for empty array', () => {
    expect(formatHistory([])).toBe('');
  });

  it('formats multiple messages with double newlines', () => {
    const messages = [
      makeMsg('user', 'Hello'),
      makeMsg('assistant', 'Hi there'),
    ];
    const formatted = formatHistory(messages);
    expect(formatted).toBe('User: Hello\n\nAssistant: Hi there');
  });

  it('handles single message', () => {
    const messages = [makeMsg('user', 'Only one')];
    const formatted = formatHistory(messages);
    expect(formatted).toBe('User: Only one');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// trimHistoryToFit
// ═══════════════════════════════════════════════════════════════════════════════

describe('trimHistoryToFit', () => {
  it('returns all messages when within limits', () => {
    const messages = [
      makeMsg('user', 'Hi'),
      makeMsg('assistant', 'Hello'),
    ];
    const trimmed = trimHistoryToFit(messages, 1000, 10);
    expect(trimmed).toHaveLength(2);
  });

  it('trims to maxMessages first', () => {
    const messages = Array.from({ length: 20 }, (_, i) =>
      makeMsg('user', `Message ${i}`),
    );
    const trimmed = trimHistoryToFit(messages, 10000, 5);
    expect(trimmed).toHaveLength(5);
    // Should keep the last 5
    expect(trimmed[0]!.content).toBe('Message 15');
  });

  it('trims further by token budget', () => {
    const messages = Array.from({ length: 10 }, (_, i) =>
      makeMsg('user', `Message ${i}`),
    );
    // Very tight budget — should keep only a few
    const trimmed = trimHistoryToFit(messages, 10, 10);
    expect(trimmed.length).toBeLessThan(10);
  });

  it('returns empty array when budget is 0', () => {
    const messages = [makeMsg('user', 'Hello')];
    const trimmed = trimHistoryToFit(messages, 0, 10);
    expect(trimmed).toEqual([]);
  });

  it('handles empty messages', () => {
    const trimmed = trimHistoryToFit([], 1000, 10);
    expect(trimmed).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// generateSessionKey
// ═══════════════════════════════════════════════════════════════════════════════

describe('generateSessionKey', () => {
  it('generates main key', () => {
    expect(generateSessionKey('imessage', 'main')).toBe('imessage:main');
  });

  it('generates per-peer key', () => {
    expect(generateSessionKey('imessage', 'per-peer', 'john')).toBe('imessage:peer:john');
  });

  it('generates per-channel key', () => {
    expect(generateSessionKey('cli', 'per-channel', undefined, 'terminal-1')).toBe('cli:channel:terminal-1');
  });

  it('uses unknown for missing peer', () => {
    expect(generateSessionKey('imessage', 'per-peer')).toBe('imessage:peer:unknown');
  });

  it('uses unknown for missing channel', () => {
    expect(generateSessionKey('cli', 'per-channel')).toBe('cli:channel:unknown');
  });

  it('defaults to main for unknown scope', () => {
    // TypeScript wouldn't normally allow this, but test the default branch
    expect(generateSessionKey('cli', 'unknown' as never)).toBe('cli:main');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// getSessionFilePath
// ═══════════════════════════════════════════════════════════════════════════════

describe('getSessionFilePath', () => {
  it('joins base path with key and .jsonl extension', () => {
    const path = getSessionFilePath('/tmp/sessions', 'imessage:main');
    expect(path).toBe('/tmp/sessions/imessage:main.jsonl');
  });

  it('sanitizes special characters', () => {
    const path = getSessionFilePath('/tmp/sessions', 'im/message:peer@john');
    // / and @ should be replaced with _
    expect(path).toContain('im_message:peer_john.jsonl');
  });

  it('keeps allowed characters', () => {
    const path = getSessionFilePath('/tmp/sessions', 'cli:main');
    expect(path).toContain('cli:main.jsonl');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// loadSessionState
// ═══════════════════════════════════════════════════════════════════════════════

describe('loadSessionState', () => {
  it('returns default state for non-existent file', () => {
    const state = loadSessionState('/tmp/nonexistent-session-file-xyz.jsonl', 'test-key', 'test-channel');
    expect(state.key).toBe('test-key');
    expect(state.channel).toBe('test-channel');
    expect(state.messages).toEqual([]);
    expect(state.totalMessages).toBe(0);
  });

  it('loads saved state from JSONL', () => {
    mkdirSync(TEST_BASE, { recursive: true });
    const filePath = join(TEST_BASE, 'test-session.jsonl');

    const metadata = {
      key: 'my-key',
      channel: 'cli',
      createdAt: '2025-01-01T00:00:00.000Z',
      lastActiveAt: '2025-01-01T01:00:00.000Z',
      totalMessages: 2,
    };
    const msg1 = { role: 'user', content: 'Hello', timestamp: '2025-01-01T00:30:00.000Z' };
    const msg2 = { role: 'assistant', content: 'Hi there', timestamp: '2025-01-01T00:31:00.000Z' };

    writeFileSync(filePath, [
      JSON.stringify(metadata),
      JSON.stringify(msg1),
      JSON.stringify(msg2),
    ].join('\n') + '\n');

    const state = loadSessionState(filePath, 'fallback-key', 'fallback-channel');
    expect(state.key).toBe('my-key');
    expect(state.channel).toBe('cli');
    expect(state.messages.length).toBe(2);
    expect(state.totalMessages).toBe(2);
  });

  it('handles empty file', () => {
    mkdirSync(TEST_BASE, { recursive: true });
    const filePath = join(TEST_BASE, 'empty-session.jsonl');
    writeFileSync(filePath, '');

    const state = loadSessionState(filePath, 'key', 'chan');
    expect(state.messages).toEqual([]);
  });

  it('skips malformed message lines', () => {
    mkdirSync(TEST_BASE, { recursive: true });
    const filePath = join(TEST_BASE, 'malformed.jsonl');

    const metadata = { key: 'k', channel: 'c', createdAt: '2025-01-01', lastActiveAt: '2025-01-01', totalMessages: 1 };
    writeFileSync(filePath, [
      JSON.stringify(metadata),
      'not valid json',
      JSON.stringify({ role: 'user', content: 'Valid', timestamp: '2025-01-01' }),
    ].join('\n') + '\n');

    const state = loadSessionState(filePath, 'k', 'c');
    expect(state.messages.length).toBe(1);
    expect(getMessageText(state.messages[0]!)).toBe('Valid');
  });

  it('uses fallback key and channel when metadata is missing', () => {
    mkdirSync(TEST_BASE, { recursive: true });
    const filePath = join(TEST_BASE, 'minimal.jsonl');

    // Metadata with no key/channel
    writeFileSync(filePath, JSON.stringify({}) + '\n');

    const state = loadSessionState(filePath, 'fallback', 'fb-chan');
    expect(state.key).toBe('fallback');
    expect(state.channel).toBe('fb-chan');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// saveSessionState
// ═══════════════════════════════════════════════════════════════════════════════

describe('saveSessionState', () => {
  it('creates file and directory', () => {
    const dir = join(TEST_BASE, 'nested', 'dir');
    const filePath = join(dir, 'session.jsonl');

    saveSessionState(filePath, {
      key: 'test',
      channel: 'cli',
      createdAt: '2025-01-01',
      lastActiveAt: '2025-01-01',
      messages: [{ role: 'user', content: 'Hello', timestamp: '2025-01-01' }],
      totalMessages: 1,
    });

    expect(existsSync(filePath)).toBe(true);
  });

  it('round-trips with loadSessionState', () => {
    mkdirSync(TEST_BASE, { recursive: true });
    const filePath = join(TEST_BASE, 'roundtrip.jsonl');

    const original = {
      key: 'rk',
      channel: 'cli',
      createdAt: '2025-01-01T00:00:00.000Z',
      lastActiveAt: '2025-01-01T01:00:00.000Z',
      messages: [
        { role: 'user' as const, content: 'Hey', timestamp: '2025-01-01T00:30:00.000Z' },
        { role: 'assistant' as const, content: 'Hello!', timestamp: '2025-01-01T00:31:00.000Z' },
      ],
      totalMessages: 2,
    };

    saveSessionState(filePath, original);
    const loaded = loadSessionState(filePath, 'fallback', 'fallback');

    expect(loaded.key).toBe('rk');
    expect(loaded.messages.length).toBe(2);
    expect(getMessageText(loaded.messages[0]!)).toBe('Hey');
    expect(getMessageText(loaded.messages[1]!)).toBe('Hello!');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// appendMessageToSession
// ═══════════════════════════════════════════════════════════════════════════════

describe('appendMessageToSession', () => {
  it('appends a message to an existing file', () => {
    mkdirSync(TEST_BASE, { recursive: true });
    const filePath = join(TEST_BASE, 'append-test.jsonl');

    const metadata = { key: 'k', channel: 'c' };
    writeFileSync(filePath, JSON.stringify(metadata) + '\n');

    const msg: ConversationMessage = { role: 'user', content: 'Appended', timestamp: '2025-01-01' };
    appendMessageToSession(filePath, msg);

    const state = loadSessionState(filePath, 'k', 'c');
    expect(state.messages.length).toBe(1);
    expect(getMessageText(state.messages[0]!)).toBe('Appended');
  });

  it('creates directory if needed', () => {
    const dir = join(TEST_BASE, 'new-dir');
    const filePath = join(dir, 'append.jsonl');

    const msg: ConversationMessage = { role: 'user', content: 'Hello', timestamp: '2025-01-01' };
    appendMessageToSession(filePath, msg);

    expect(existsSync(filePath)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// shouldSessionReset
// ═══════════════════════════════════════════════════════════════════════════════

describe('shouldSessionReset', () => {
  it('returns false when dailyResetHour is null', () => {
    expect(shouldSessionReset('2025-01-01T00:00:00.000Z', null)).toBe(false);
  });

  it('returns true when multiple days have passed', () => {
    const twoDaysAgo = new Date();
    twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);
    expect(shouldSessionReset(twoDaysAgo.toISOString(), 4)).toBe(true);
  });

  it('returns false for session active just now', () => {
    const now = new Date().toISOString();
    expect(shouldSessionReset(now, 4)).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// assembleContext — system prompt NOT duplicated in context string
// ═══════════════════════════════════════════════════════════════════════════════

function makeMockSession(messages: ConversationMessage[] = []): Session {
  const state: SessionState = {
    key: 'test',
    channel: 'imessage',
    createdAt: new Date().toISOString(),
    lastActiveAt: new Date().toISOString(),
    messages,
    totalMessages: messages.length,
  };
  return {
    state,
    addMessage: () => {},
    getHistory: (max?: number) => messages.slice(-(max ?? messages.length)),
    clear: () => {},
    save: () => {},
    shouldReset: () => false,
  };
}

describe('assembleContext', () => {
  it('does not duplicate system prompt in context string', () => {
    const session = makeMockSession([
      makeMsg('user', 'Hello'),
      makeMsg('assistant', 'Hi there'),
    ]);
    const result = assembleContext({
      session,
      userMessage: 'What is the weather?',
      skills: [],
      channel: 'imessage',
    });

    // systemPrompt should contain bootstrap/personality content
    expect(result.systemPrompt.length).toBeGreaterThan(0);

    // context should NOT contain the system prompt — only history + current message
    expect(result.context).not.toContain('# Project Context');
    expect(result.context).not.toContain('IDENTITY.md');
    expect(result.context).toContain('## Current Message');
    expect(result.context).toContain('What is the weather?');
  });

  it('includes conversation history in context', () => {
    const session = makeMockSession([
      makeMsg('user', 'First message'),
      makeMsg('assistant', 'First reply'),
    ]);
    const result = assembleContext({
      session,
      userMessage: 'Second message',
      skills: [],
      channel: 'imessage',
    });

    expect(result.context).toContain('## Conversation History');
    expect(result.context).toContain('First message');
    expect(result.context).toContain('First reply');
    expect(result.context).toContain('## Current Message');
    expect(result.context).toContain('Second message');
  });

  it('returns system prompt separately', () => {
    const session = makeMockSession();
    const result = assembleContext({
      session,
      userMessage: 'Test',
      skills: [],
      channel: 'imessage',
    });

    // System prompt should have identity content
    expect(result.systemPrompt).toContain('Casterly Rock');
    // Context should NOT have the system prompt
    expect(result.context).not.toContain('Casterly Rock');
  });
});
