import { describe, expect, it, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  generateSessionKey,
  getSessionFilePath,
  shouldSessionReset,
  loadSessionState,
  saveSessionState,
  getMessageText,
  createSession,
  createSessionManager,
  type ConversationMessage,
  type SessionState,
} from '../src/interface/session.js';

// ─── Temp dir helpers ────────────────────────────────────────────────────────

const TEST_BASE = join(tmpdir(), `casterly-session-test-${Date.now()}`);

afterEach(() => {
  if (existsSync(TEST_BASE)) {
    rmSync(TEST_BASE, { recursive: true, force: true });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// generateSessionKey
// ═══════════════════════════════════════════════════════════════════════════════

describe('generateSessionKey', () => {
  it('generates main scope key', () => {
    expect(generateSessionKey('imessage', 'main')).toBe('imessage:main');
  });

  it('generates per-peer scope key', () => {
    expect(generateSessionKey('imessage', 'per-peer', 'josiah')).toBe('imessage:peer:josiah');
  });

  it('generates per-channel scope key', () => {
    expect(generateSessionKey('slack', 'per-channel', undefined, 'general')).toBe('slack:channel:general');
  });

  it('defaults to unknown for missing peerId', () => {
    expect(generateSessionKey('imessage', 'per-peer')).toBe('imessage:peer:unknown');
  });

  it('defaults to unknown for missing channelId', () => {
    expect(generateSessionKey('slack', 'per-channel')).toBe('slack:channel:unknown');
  });

  it('falls back to main for unknown scope', () => {
    expect(generateSessionKey('imessage', 'unknown' as 'main')).toBe('imessage:main');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// getSessionFilePath
// ═══════════════════════════════════════════════════════════════════════════════

describe('getSessionFilePath', () => {
  it('returns .jsonl file path', () => {
    const path = getSessionFilePath('/base', 'imessage:main');
    expect(path).toBe('/base/imessage:main.jsonl');
  });

  it('sanitizes special characters in key', () => {
    const path = getSessionFilePath('/base', 'test/bad\\key?*');
    // Extract filename portion (after last path separator)
    const filename = path.split('/').pop() ?? '';
    // The key portion should be sanitized — no special chars except _ and :
    expect(filename).not.toContain('?');
    expect(filename).not.toContain('*');
    expect(filename).toContain('.jsonl');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// shouldSessionReset
// ═══════════════════════════════════════════════════════════════════════════════

describe('shouldSessionReset', () => {
  it('returns false when dailyResetHour is null', () => {
    expect(shouldSessionReset(new Date().toISOString(), null)).toBe(false);
  });

  it('returns true when last active was yesterday before reset hour', () => {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    yesterday.setHours(3, 0, 0, 0); // Before 4 AM reset

    expect(shouldSessionReset(yesterday.toISOString(), 4)).toBe(true);
  });

  it('returns true when multiple days have passed', () => {
    const threeDaysAgo = new Date();
    threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);

    expect(shouldSessionReset(threeDaysAgo.toISOString(), 4)).toBe(true);
  });

  it('returns false when recently active and no reset boundary crossed', () => {
    const fiveMinutesAgo = new Date();
    fiveMinutesAgo.setMinutes(fiveMinutesAgo.getMinutes() - 5);

    expect(shouldSessionReset(fiveMinutesAgo.toISOString(), 4)).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Message content helpers
// ═══════════════════════════════════════════════════════════════════════════════

describe('getMessageText', () => {
  it('returns text from string content', () => {
    const msg: ConversationMessage = {
      role: 'user',
      content: 'Hello world',
      timestamp: new Date().toISOString(),
    };
    expect(getMessageText(msg)).toBe('Hello world');
  });

  it('extracts text from content blocks', () => {
    const blocks = [
      { type: 'text' as const, text: 'Hello ' },
      { type: 'text' as const, text: 'world' },
    ];
    const msg: ConversationMessage = {
      role: 'assistant',
      content: blocks,
      timestamp: new Date().toISOString(),
    };
    expect(getMessageText(msg)).toBe('Hello world');
  });

  it('ignores non-text blocks', () => {
    const blocks = [
      { type: 'text' as const, text: 'Result: ' },
      { type: 'tool_use' as const, id: 'tool-1', name: 'bash', input: {} },
      { type: 'text' as const, text: 'done' },
    ];
    const msg: ConversationMessage = {
      role: 'assistant',
      content: blocks,
      timestamp: new Date().toISOString(),
    };
    expect(getMessageText(msg)).toBe('Result: done');
  });
});


// ═══════════════════════════════════════════════════════════════════════════════
// loadSessionState / saveSessionState
// ═══════════════════════════════════════════════════════════════════════════════

describe('loadSessionState', () => {
  it('returns default state when file does not exist', () => {
    const state = loadSessionState('/nonexistent/path.jsonl', 'test-key', 'imessage');
    expect(state.key).toBe('test-key');
    expect(state.channel).toBe('imessage');
    expect(state.messages).toEqual([]);
    expect(state.totalMessages).toBe(0);
  });

  it('loads state from JSONL file', () => {
    mkdirSync(TEST_BASE, { recursive: true });
    const filePath = join(TEST_BASE, 'test-session.jsonl');

    const metadata = { key: 'test-key', channel: 'imessage', createdAt: '2024-01-01T00:00:00Z', totalMessages: 2 };
    const msg1: ConversationMessage = { role: 'user', content: 'Hello', timestamp: '2024-01-01T00:01:00Z' };
    const msg2: ConversationMessage = { role: 'assistant', content: 'Hi!', timestamp: '2024-01-01T00:01:01Z' };

    const content = [JSON.stringify(metadata), JSON.stringify(msg1), JSON.stringify(msg2)].join('\n') + '\n';
    writeFileSync(filePath, content);

    const state = loadSessionState(filePath, 'test-key', 'imessage');

    expect(state.key).toBe('test-key');
    expect(state.messages).toHaveLength(2);
    expect(state.messages[0]!.content).toBe('Hello');
    expect(state.messages[1]!.content).toBe('Hi!');
    expect(state.totalMessages).toBe(2);
  });
});

describe('saveSessionState', () => {
  it('saves state to JSONL file', () => {
    mkdirSync(TEST_BASE, { recursive: true });
    const filePath = join(TEST_BASE, 'save-test.jsonl');

    const state: SessionState = {
      key: 'test-key',
      channel: 'imessage',
      createdAt: '2024-01-01T00:00:00Z',
      lastActiveAt: '2024-01-01T00:01:00Z',
      messages: [
        { role: 'user', content: 'Hello', timestamp: '2024-01-01T00:01:00Z' },
      ],
      totalMessages: 1,
    };

    saveSessionState(filePath, state);

    expect(existsSync(filePath)).toBe(true);
    const content = readFileSync(filePath, 'utf-8');
    const lines = content.trim().split('\n');
    expect(lines).toHaveLength(2); // metadata + 1 message
  });

  it('creates directories if they do not exist', () => {
    const filePath = join(TEST_BASE, 'nested', 'dir', 'session.jsonl');

    const state: SessionState = {
      key: 'test',
      channel: 'imessage',
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
      messages: [],
      totalMessages: 0,
    };

    saveSessionState(filePath, state);
    expect(existsSync(filePath)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// createSession
// ═══════════════════════════════════════════════════════════════════════════════

describe('createSession', () => {
  it('creates a session with initial state', () => {
    mkdirSync(TEST_BASE, { recursive: true });
    const session = createSession('imessage', {
      basePath: TEST_BASE,
      scope: 'main',
      maxHistoryMessages: 10,
      dailyResetHour: null,
    });

    expect(session.state.key).toBe('imessage:main');
    expect(session.state.channel).toBe('imessage');
    expect(session.state.messages).toEqual([]);
  });

  it('adds messages and trims history', () => {
    mkdirSync(TEST_BASE, { recursive: true });
    const session = createSession('imessage', {
      basePath: TEST_BASE,
      scope: 'main',
      maxHistoryMessages: 3,
      dailyResetHour: null,
    });

    session.addMessage({ role: 'user', content: 'Message 1' });
    session.addMessage({ role: 'assistant', content: 'Reply 1' });
    session.addMessage({ role: 'user', content: 'Message 2' });
    session.addMessage({ role: 'assistant', content: 'Reply 2' });

    // maxHistoryMessages is 3, so oldest should be trimmed
    expect(session.state.messages).toHaveLength(3);
    expect(session.state.totalMessages).toBe(4);
  });

  it('getHistory returns limited messages', () => {
    mkdirSync(TEST_BASE, { recursive: true });
    const session = createSession('imessage', {
      basePath: TEST_BASE,
      scope: 'main',
      maxHistoryMessages: 50,
      dailyResetHour: null,
    });

    for (let i = 0; i < 10; i++) {
      session.addMessage({ role: 'user', content: `Message ${i}` });
    }

    const history = session.getHistory(3);
    expect(history).toHaveLength(3);
    // Should be the last 3 messages
    expect(getMessageText(history[0]!)).toBe('Message 7');
  });

  it('clear resets messages but keeps totalMessages', () => {
    mkdirSync(TEST_BASE, { recursive: true });
    const session = createSession('imessage', {
      basePath: TEST_BASE,
      scope: 'main',
      maxHistoryMessages: 50,
      dailyResetHour: null,
    });

    session.addMessage({ role: 'user', content: 'Hello' });
    session.addMessage({ role: 'assistant', content: 'Hi' });

    expect(session.state.totalMessages).toBe(2);

    session.clear();

    expect(session.state.messages).toEqual([]);
    // totalMessages is preserved for stats
    expect(session.state.totalMessages).toBe(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// createSessionManager
// ═══════════════════════════════════════════════════════════════════════════════

describe('createSessionManager', () => {
  it('gets or creates sessions', () => {
    mkdirSync(TEST_BASE, { recursive: true });
    const manager = createSessionManager({
      basePath: TEST_BASE,
      scope: 'per-peer',
      maxHistoryMessages: 10,
      dailyResetHour: null,
    });

    const session1 = manager.getSession('imessage', 'josiah');
    const session2 = manager.getSession('imessage', 'josiah');

    // Should return the same session
    expect(session1).toBe(session2);
  });

  it('creates separate sessions for different peers', () => {
    mkdirSync(TEST_BASE, { recursive: true });
    const manager = createSessionManager({
      basePath: TEST_BASE,
      scope: 'per-peer',
      maxHistoryMessages: 10,
      dailyResetHour: null,
    });

    const session1 = manager.getSession('imessage', 'josiah');
    const session2 = manager.getSession('imessage', 'other');

    expect(session1).not.toBe(session2);
  });

  it('clearAll clears all sessions', () => {
    mkdirSync(TEST_BASE, { recursive: true });
    const manager = createSessionManager({
      basePath: TEST_BASE,
      scope: 'per-peer',
      maxHistoryMessages: 10,
      dailyResetHour: null,
    });

    const session = manager.getSession('imessage', 'josiah');
    session.addMessage({ role: 'user', content: 'Hello' });

    manager.clearAll();

    // Getting session again creates a new one
    const newSession = manager.getSession('imessage', 'josiah');
    expect(newSession.state.messages).toEqual([]);
  });
});
