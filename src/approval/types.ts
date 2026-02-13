/**
 * Async Approval Flow Types (ISSUE-004)
 *
 * Type definitions for the iMessage-based approval mechanism
 * that gates destructive command execution.
 */

export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'timed_out';

export interface ApprovalRequest {
  id: string;
  command: string;
  redactedCommand: string;
  recipient: string;
  status: ApprovalStatus;
  createdAt: number;
  resolvedAt?: number;
  timeoutAt: number;
  responseRowId?: number;
}

export interface ApprovalConfig {
  /** Timeout in milliseconds before auto-denying (default: 5 min) */
  timeoutMs: number;
}

export const DEFAULT_APPROVAL_CONFIG: ApprovalConfig = {
  timeoutMs: 5 * 60 * 1000, // 5 minutes
};

export interface ApprovalStoreData {
  version: 1;
  requests: ApprovalRequest[];
}
