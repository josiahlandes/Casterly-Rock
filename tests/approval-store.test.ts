import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createApprovalStore, type ApprovalStore } from '../src/approval/store.js';
import type { ApprovalRequest } from '../src/approval/types.js';

let testDir: string;
let store: ApprovalStore;

function makeRequest(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    id: `approval-${Math.random().toString(36).substring(2, 8)}`,
    command: 'rm -rf /tmp/test',
    redactedCommand: 'rm -rf /tmp/test',
    recipient: '+1555000000',
    status: 'pending',
    createdAt: Date.now(),
    timeoutAt: Date.now() + 5 * 60 * 1000,
    ...overrides,
  };
}

beforeEach(() => {
  testDir = join(tmpdir(), `casterly-approval-test-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`);
  mkdirSync(testDir, { recursive: true });
  store = createApprovalStore(testDir);
});

afterEach(() => {
  if (existsSync(testDir)) {
    rmSync(testDir, { recursive: true, force: true });
  }
});

// ─── CRUD ───────────────────────────────────────────────────────────────────

describe('ApprovalStore CRUD', () => {
  it('starts empty', () => {
    expect(store.getAll()).toHaveLength(0);
  });

  it('adds and retrieves a request by ID', () => {
    const request = makeRequest();
    store.add(request);

    expect(store.getById(request.id)).toEqual(request);
  });

  it('returns undefined for non-existent ID', () => {
    expect(store.getById('nonexistent')).toBeUndefined();
  });
});

// ─── getPending ─────────────────────────────────────────────────────────────

describe('getPending', () => {
  it('returns pending request for recipient', () => {
    const request = makeRequest();
    store.add(request);

    expect(store.getPending('+1555000000')?.id).toBe(request.id);
  });

  it('returns undefined when no pending for recipient', () => {
    expect(store.getPending('+1555000000')).toBeUndefined();
  });

  it('returns undefined after request is resolved', () => {
    const request = makeRequest();
    store.add(request);
    store.resolve(request.id, 'approved');

    expect(store.getPending('+1555000000')).toBeUndefined();
  });

  it('returns undefined for different recipient', () => {
    const request = makeRequest({ recipient: '+1999000000' });
    store.add(request);

    expect(store.getPending('+1555000000')).toBeUndefined();
  });
});

// ─── resolve ────────────────────────────────────────────────────────────────

describe('resolve', () => {
  it('changes status to approved', () => {
    const request = makeRequest();
    store.add(request);
    store.resolve(request.id, 'approved');

    expect(store.getById(request.id)?.status).toBe('approved');
    expect(store.getById(request.id)?.resolvedAt).toBeDefined();
  });

  it('changes status to denied', () => {
    const request = makeRequest();
    store.add(request);
    store.resolve(request.id, 'denied');

    expect(store.getById(request.id)?.status).toBe('denied');
  });

  it('changes status to timed_out', () => {
    const request = makeRequest();
    store.add(request);
    store.resolve(request.id, 'timed_out');

    expect(store.getById(request.id)?.status).toBe('timed_out');
  });

  it('stores responseRowId when provided', () => {
    const request = makeRequest();
    store.add(request);
    store.resolve(request.id, 'approved', 12345);

    expect(store.getById(request.id)?.responseRowId).toBe(12345);
  });

  it('does nothing for non-existent ID', () => {
    store.resolve('nonexistent', 'approved');
    expect(store.getAll()).toHaveLength(0);
  });
});

// ─── compact ────────────────────────────────────────────────────────────────

describe('compact', () => {
  it('removes resolved requests older than 7 days', () => {
    const oldResolved = makeRequest({
      status: 'approved',
      resolvedAt: Date.now() - 8 * 24 * 60 * 60 * 1000, // 8 days ago
    });
    store.add(oldResolved);

    const removed = store.compact();
    expect(removed).toBe(1);
    expect(store.getAll()).toHaveLength(0);
  });

  it('keeps recent resolved requests', () => {
    const recentResolved = makeRequest({
      status: 'approved',
      resolvedAt: Date.now() - 1000, // just now
    });
    store.add(recentResolved);

    const removed = store.compact();
    expect(removed).toBe(0);
    expect(store.getAll()).toHaveLength(1);
  });

  it('keeps pending requests regardless of age', () => {
    const oldPending = makeRequest({
      status: 'pending',
      createdAt: Date.now() - 30 * 24 * 60 * 60 * 1000,
    });
    store.add(oldPending);

    const removed = store.compact();
    expect(removed).toBe(0);
    expect(store.getAll()).toHaveLength(1);
  });
});

// ─── persistence ────────────────────────────────────────────────────────────

describe('persistence', () => {
  it('persists requests across store instances', () => {
    const request = makeRequest();
    store.add(request);

    const store2 = createApprovalStore(testDir);
    expect(store2.getById(request.id)?.command).toBe(request.command);
  });

  it('handles missing file gracefully', () => {
    const emptyDir = join(tmpdir(), `casterly-empty-approval-${Date.now()}`);
    const emptyStore = createApprovalStore(emptyDir);

    expect(emptyStore.getAll()).toHaveLength(0);

    if (existsSync(emptyDir)) {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });
});
