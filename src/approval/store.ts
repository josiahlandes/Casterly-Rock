/**
 * Approval Store (ISSUE-004)
 *
 * Persistent store for approval requests.
 * Single JSON file at ~/.casterly/approvals/approvals.json.
 * In-memory cache with full rewrite on mutation.
 *
 * Follows the factory pattern from src/scheduler/store.ts.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { safeLogger } from '../logging/safe-logger.js';
import type { ApprovalRequest, ApprovalStoreData } from './types.js';

/** Default storage path */
const DEFAULT_STORAGE_PATH = join(homedir(), '.casterly', 'approvals');

/** Max age for resolved requests before compaction (7 days) */
const RESOLVED_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

// ─── Interface ──────────────────────────────────────────────────────────────

export interface ApprovalStore {
  /** Get the pending approval for a recipient (at most one) */
  getPending(recipient: string): ApprovalRequest | undefined;
  /** Get a request by ID */
  getById(id: string): ApprovalRequest | undefined;
  /** Add a new approval request */
  add(request: ApprovalRequest): void;
  /** Resolve a pending request */
  resolve(id: string, status: 'approved' | 'denied' | 'timed_out', responseRowId?: number): void;
  /** Get all requests */
  getAll(): ApprovalRequest[];
  /** Remove old resolved requests. Returns count removed. */
  compact(): number;
}

// ─── Persistence ────────────────────────────────────────────────────────────

function loadRequests(filePath: string): ApprovalRequest[] {
  if (!existsSync(filePath)) {
    return [];
  }

  try {
    const content = readFileSync(filePath, 'utf-8').trim();
    if (!content) return [];

    const data = JSON.parse(content) as ApprovalStoreData;
    if (data.version !== 1 || !Array.isArray(data.requests)) {
      safeLogger.warn('Approval store has unexpected format, starting fresh');
      return [];
    }

    return data.requests;
  } catch (error) {
    safeLogger.error('Failed to load approval store', {
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

function saveRequests(filePath: string, requests: ApprovalRequest[]): void {
  const data: ApprovalStoreData = { version: 1, requests };
  try {
    writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
  } catch (error) {
    safeLogger.error('Failed to save approval store', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

// ─── Factory ────────────────────────────────────────────────────────────────

export function createApprovalStore(storagePath?: string): ApprovalStore {
  const baseDir = storagePath ?? DEFAULT_STORAGE_PATH;
  const filePath = join(baseDir, 'approvals.json');

  // Ensure directory exists
  if (!existsSync(baseDir)) {
    mkdirSync(baseDir, { recursive: true });
  }

  // Load existing requests
  let requests = loadRequests(filePath);

  // Compact on creation
  const now = Date.now();
  const beforeCount = requests.length;
  requests = requests.filter((r) => {
    if (r.status !== 'pending' && r.resolvedAt) {
      return r.resolvedAt > now - RESOLVED_MAX_AGE_MS;
    }
    return true;
  });

  if (requests.length !== beforeCount) {
    saveRequests(filePath, requests);
  }

  return {
    getPending(recipient: string): ApprovalRequest | undefined {
      return requests.find((r) => r.recipient === recipient && r.status === 'pending');
    },

    getById(id: string): ApprovalRequest | undefined {
      return requests.find((r) => r.id === id);
    },

    add(request: ApprovalRequest): void {
      requests.push(request);
      saveRequests(filePath, requests);
      safeLogger.info('Approval request added', {
        id: request.id,
        recipient: request.recipient.substring(0, 4) + '***',
      });
    },

    resolve(id: string, status: 'approved' | 'denied' | 'timed_out', responseRowId?: number): void {
      const request = requests.find((r) => r.id === id);
      if (!request) return;

      request.status = status;
      request.resolvedAt = Date.now();
      if (responseRowId !== undefined) {
        request.responseRowId = responseRowId;
      }

      saveRequests(filePath, requests);
      safeLogger.info('Approval request resolved', { id, status });
    },

    getAll(): ApprovalRequest[] {
      return [...requests];
    },

    compact(): number {
      const now = Date.now();
      const beforeCount = requests.length;

      requests = requests.filter((r) => {
        if (r.status !== 'pending' && r.resolvedAt) {
          return r.resolvedAt > now - RESOLVED_MAX_AGE_MS;
        }
        return true;
      });

      const removed = beforeCount - requests.length;
      if (removed > 0) {
        saveRequests(filePath, requests);
      }

      return removed;
    },
  };
}
