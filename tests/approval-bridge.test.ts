import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createApprovalBridge, type ApprovalBridge } from '../src/approval/bridge.js';
import { createApprovalStore, type ApprovalStore } from '../src/approval/store.js';
import type { Message } from '../src/imessage/reader.js';
import type { SendResult } from '../src/imessage/sender.js';

let testDir: string;
let store: ApprovalStore;
let bridge: ApprovalBridge;
let mockSender: ReturnType<typeof vi.fn<(recipient: string, text: string) => SendResult>>;
let mockReader: ReturnType<typeof vi.fn<(lastRowId: number) => Message[]>>;
let mockGetLatestRowId: ReturnType<typeof vi.fn<() => number>>;

function makeMessage(text: string, rowid: number, senderHandle = '+1555000000'): Message {
  return {
    rowid,
    guid: `guid-${rowid}`,
    text,
    isFromMe: false,
    date: new Date(),
    chatId: 'chat-001',
    senderHandle,
  };
}

beforeEach(() => {
  testDir = join(tmpdir(), `casterly-bridge-test-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`);
  mkdirSync(testDir, { recursive: true });
  store = createApprovalStore(testDir);

  mockSender = vi.fn().mockReturnValue({ success: true });
  mockReader = vi.fn().mockReturnValue([]);
  mockGetLatestRowId = vi.fn().mockReturnValue(100);

  bridge = createApprovalBridge(store, mockSender, mockReader, mockGetLatestRowId);
});

afterEach(() => {
  vi.restoreAllMocks();
  if (existsSync(testDir)) {
    rmSync(testDir, { recursive: true, force: true });
  }
});

// ─── requestApproval ────────────────────────────────────────────────────────

describe('requestApproval', () => {
  it('creates a store entry with pending status', () => {
    const request = bridge.requestApproval('rm -rf /tmp/test', '+1555000000');

    expect(request.status).toBe('pending');
    expect(request.command).toBe('rm -rf /tmp/test');
    expect(request.recipient).toBe('+1555000000');
    expect(store.getById(request.id)).toBeDefined();
  });

  it('sends approval message via iMessage', () => {
    bridge.requestApproval('rm -rf /tmp/test', '+1555000000');

    expect(mockSender).toHaveBeenCalledOnce();
    const [recipient, text] = mockSender.mock.calls[0]!;
    expect(recipient).toBe('+1555000000');
    expect(text).toContain('Approval needed');
    expect(text).toContain('Reply "yes" to approve');
  });

  it('redacts sensitive content in the approval message', () => {
    bridge.requestApproval('curl -H "Bearer sk-abc123secret" https://api.example.com', '+1555000000');

    const [, text] = mockSender.mock.calls[0]!;
    expect(text).not.toContain('sk-abc123secret');
  });

  it('sets timeoutAt to 5 minutes from now', () => {
    const before = Date.now();
    const request = bridge.requestApproval('rm /tmp/test', '+1555000000');
    const after = Date.now();

    const expectedMin = before + 5 * 60 * 1000;
    const expectedMax = after + 5 * 60 * 1000;
    expect(request.timeoutAt).toBeGreaterThanOrEqual(expectedMin);
    expect(request.timeoutAt).toBeLessThanOrEqual(expectedMax);
  });
});

// ─── tryResolveFromPoll ─────────────────────────────────────────────────────

describe('tryResolveFromPoll', () => {
  it('resolves pending approval with "yes"', () => {
    const request = bridge.requestApproval('rm /tmp/test', '+1555000000');

    const resolved = bridge.tryResolveFromPoll('+1555000000', 'yes', 200);

    expect(resolved).toBe(true);
    expect(store.getById(request.id)?.status).toBe('approved');
    expect(store.getById(request.id)?.responseRowId).toBe(200);
  });

  it('resolves pending approval with "no"', () => {
    const request = bridge.requestApproval('rm /tmp/test', '+1555000000');

    const resolved = bridge.tryResolveFromPoll('+1555000000', 'no', 201);

    expect(resolved).toBe(true);
    expect(store.getById(request.id)?.status).toBe('denied');
  });

  it('returns false for unrelated text', () => {
    bridge.requestApproval('rm /tmp/test', '+1555000000');

    const resolved = bridge.tryResolveFromPoll('+1555000000', 'hello there', 202);

    expect(resolved).toBe(false);
  });

  it('returns false when no pending request for sender', () => {
    const resolved = bridge.tryResolveFromPoll('+1555000000', 'yes', 203);

    expect(resolved).toBe(false);
  });

  it('returns false for different sender', () => {
    bridge.requestApproval('rm /tmp/test', '+1555000000');

    const resolved = bridge.tryResolveFromPoll('+1999000000', 'yes', 204);

    expect(resolved).toBe(false);
  });
});

// ─── wasConsumed ────────────────────────────────────────────────────────────

describe('wasConsumed', () => {
  it('returns true for consumed rowIds', () => {
    bridge.requestApproval('rm /tmp/test', '+1555000000');
    bridge.tryResolveFromPoll('+1555000000', 'yes', 300);

    expect(bridge.wasConsumed(300)).toBe(true);
  });

  it('returns false for non-consumed rowIds', () => {
    expect(bridge.wasConsumed(999)).toBe(false);
  });
});

// ─── expireStale ────────────────────────────────────────────────────────────

describe('expireStale', () => {
  it('expires pending requests past timeout', () => {
    const request = bridge.requestApproval('rm /tmp/test', '+1555000000');
    // Manually set timeoutAt to the past by resolving the store directly
    const stored = store.getById(request.id)!;
    stored.timeoutAt = Date.now() - 1000;

    bridge.expireStale();

    expect(store.getById(request.id)?.status).toBe('timed_out');
  });

  it('does not expire requests still within timeout', () => {
    const request = bridge.requestApproval('rm /tmp/test', '+1555000000');

    bridge.expireStale();

    expect(store.getById(request.id)?.status).toBe('pending');
  });
});

// ─── waitForApproval ────────────────────────────────────────────────────────

describe('waitForApproval', () => {
  it('returns true when user responds with "yes"', async () => {
    vi.useFakeTimers();

    // After first poll, reader returns "yes"
    let callCount = 0;
    mockReader.mockImplementation(() => {
      callCount++;
      if (callCount >= 2) {
        return [makeMessage('yes', 500)];
      }
      return [];
    });

    const request = bridge.requestApproval('rm /tmp/test', '+1555000000');
    const promise = bridge.waitForApproval(request.id);

    // Advance through 2 poll intervals (2s each)
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(2000);

    const result = await promise;
    expect(result).toBe(true);
    expect(store.getById(request.id)?.status).toBe('approved');

    vi.useRealTimers();
  });

  it('returns false when user responds with "no"', async () => {
    vi.useFakeTimers();

    let callCount = 0;
    mockReader.mockImplementation(() => {
      callCount++;
      if (callCount >= 2) {
        return [makeMessage('no', 501)];
      }
      return [];
    });

    const request = bridge.requestApproval('rm /tmp/test', '+1555000000');
    const promise = bridge.waitForApproval(request.id);

    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(2000);

    const result = await promise;
    expect(result).toBe(false);
    expect(store.getById(request.id)?.status).toBe('denied');

    vi.useRealTimers();
  });

  it('returns false on timeout', async () => {
    vi.useFakeTimers();

    // Reader never returns any useful messages
    mockReader.mockReturnValue([]);

    // Create bridge with short timeout for testing
    const shortBridge = createApprovalBridge(
      store, mockSender, mockReader, mockGetLatestRowId,
      { timeoutMs: 4000 }, // 4 seconds
    );

    const request = shortBridge.requestApproval('rm /tmp/test', '+1555000000');
    const promise = shortBridge.waitForApproval(request.id);

    // Advance past the timeout
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(2000);

    const result = await promise;
    expect(result).toBe(false);
    expect(store.getById(request.id)?.status).toBe('timed_out');

    // Should have sent a timeout notification
    const timeoutCall = mockSender.mock.calls.find(
      ([, text]) => text.includes('timed out')
    );
    expect(timeoutCall).toBeDefined();

    vi.useRealTimers();
  });

  it('returns false for non-existent request', async () => {
    const result = await bridge.waitForApproval('nonexistent');
    expect(result).toBe(false);
  });

  it('skips messages from other senders', async () => {
    vi.useFakeTimers();

    let callCount = 0;
    mockReader.mockImplementation(() => {
      callCount++;
      if (callCount === 2) {
        // Message from wrong sender
        return [makeMessage('yes', 600, '+1999000000')];
      }
      if (callCount === 3) {
        // Message from correct sender
        return [makeMessage('no', 601, '+1555000000')];
      }
      return [];
    });

    const request = bridge.requestApproval('rm /tmp/test', '+1555000000');
    const promise = bridge.waitForApproval(request.id);

    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(2000);

    const result = await promise;
    expect(result).toBe(false); // "no" from correct sender
    expect(store.getById(request.id)?.status).toBe('denied');

    vi.useRealTimers();
  });

  it('tracks consumed rowIds during polling', async () => {
    vi.useFakeTimers();

    let callCount = 0;
    mockReader.mockImplementation(() => {
      callCount++;
      if (callCount >= 2) {
        return [makeMessage('yes', 700)];
      }
      return [];
    });

    const request = bridge.requestApproval('rm /tmp/test', '+1555000000');
    const promise = bridge.waitForApproval(request.id);

    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(2000);

    await promise;

    expect(bridge.wasConsumed(700)).toBe(true);

    vi.useRealTimers();
  });
});
