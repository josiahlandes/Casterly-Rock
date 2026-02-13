/**
 * Approval Bridge (ISSUE-004)
 *
 * Connects the approval store with iMessage I/O.
 * Sends approval requests via iMessage and polls for responses.
 * Runs its own independent SQLite polling loop during waitForApproval.
 */

import { safeLogger } from '../logging/safe-logger.js';
import { redactSensitiveText } from '../security/redactor.js';
import type { Message } from '../imessage/reader.js';
import type { SendResult } from '../imessage/sender.js';
import type { ApprovalRequest } from './types.js';
import { DEFAULT_APPROVAL_CONFIG } from './types.js';
import type { ApprovalStore } from './store.js';
import { parseApprovalResponse } from './matcher.js';

/** Polling interval for approval responses (ms) */
const POLL_INTERVAL_MS = 2000;

// ─── Interface ──────────────────────────────────────────────────────────────

export interface ApprovalBridge {
  /** Send an approval request via iMessage and register it in the store */
  requestApproval(command: string, recipient: string): ApprovalRequest;
  /** Block until the approval is resolved (approved/denied/timed_out) */
  waitForApproval(requestId: string): Promise<boolean>;
  /** Check if a message from the poll loop is an approval response */
  tryResolveFromPoll(senderHandle: string, messageText: string, rowId: number): boolean;
  /** Check if a rowId was consumed by approval polling */
  wasConsumed(rowId: number): boolean;
  /** Expire stale pending requests */
  expireStale(): void;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function generateApprovalId(): string {
  return `approval-${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 8)}`;
}

function formatApprovalMessage(redactedCommand: string): string {
  const truncated = redactedCommand.length > 120
    ? redactedCommand.substring(0, 120) + '...'
    : redactedCommand;

  return [
    'Approval needed:',
    `Command: ${truncated}`,
    '',
    'Reply "yes" to approve or "no" to deny.',
    '(Auto-denied in 5 minutes)',
  ].join('\n');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Factory ────────────────────────────────────────────────────────────────

export function createApprovalBridge(
  store: ApprovalStore,
  messageSender: (recipient: string, text: string) => SendResult,
  messageReader: (lastRowId: number) => Message[],
  getLatestRowId: () => number,
  config = DEFAULT_APPROVAL_CONFIG,
): ApprovalBridge {
  /** Track rowIds consumed during approval polling */
  const consumedRowIds = new Set<number>();

  return {
    requestApproval(command: string, recipient: string): ApprovalRequest {
      const now = Date.now();
      const redactedCommand = redactSensitiveText(command);

      const request: ApprovalRequest = {
        id: generateApprovalId(),
        command,
        redactedCommand,
        recipient,
        status: 'pending',
        createdAt: now,
        timeoutAt: now + config.timeoutMs,
      };

      store.add(request);

      // Send the approval prompt via iMessage
      const messageText = formatApprovalMessage(redactedCommand);
      const sendResult = messageSender(recipient, messageText);

      if (!sendResult.success) {
        safeLogger.error('Failed to send approval request', {
          id: request.id,
          error: sendResult.error,
        });
      }

      safeLogger.info('Approval request sent', {
        id: request.id,
        command: redactedCommand.substring(0, 50),
      });

      return request;
    },

    async waitForApproval(requestId: string): Promise<boolean> {
      const request = store.getById(requestId);
      if (!request || request.status !== 'pending') {
        return false;
      }

      // Snapshot the current latest rowId as our polling start
      let pollRowId = getLatestRowId();

      while (Date.now() < request.timeoutAt) {
        await sleep(POLL_INTERVAL_MS);

        // Check if already resolved (e.g. by tryResolveFromPoll)
        const current = store.getById(requestId);
        if (!current || current.status !== 'pending') {
          return current?.status === 'approved';
        }

        try {
          const messages = messageReader(pollRowId);

          for (const msg of messages) {
            // Track the rowId so the main poll loop can skip it
            if (msg.rowid > pollRowId) {
              pollRowId = msg.rowid;
            }

            // Only consider messages from the same sender
            const msgSender = msg.senderHandle || msg.chatId;
            if (msgSender !== request.recipient) {
              continue;
            }

            consumedRowIds.add(msg.rowid);

            const answer = parseApprovalResponse(msg.text);

            if (answer === 'approve') {
              store.resolve(requestId, 'approved', msg.rowid);
              safeLogger.info('Approval granted', { id: requestId });
              return true;
            }

            if (answer === 'deny') {
              store.resolve(requestId, 'denied', msg.rowid);
              safeLogger.info('Approval denied', { id: requestId });
              return false;
            }

            // not_an_answer — skip, continue polling
          }
        } catch (error) {
          safeLogger.error('Error polling for approval response', {
            id: requestId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      // Timeout reached
      store.resolve(requestId, 'timed_out');
      safeLogger.info('Approval timed out', { id: requestId });

      // Notify the user
      messageSender(request.recipient, 'Approval timed out — command was denied.');

      return false;
    },

    tryResolveFromPoll(senderHandle: string, messageText: string, rowId: number): boolean {
      const pending = store.getPending(senderHandle);
      if (!pending) {
        return false;
      }

      const answer = parseApprovalResponse(messageText);
      if (answer === 'not_an_answer') {
        return false;
      }

      const status = answer === 'approve' ? 'approved' : 'denied';
      store.resolve(pending.id, status, rowId);
      consumedRowIds.add(rowId);

      safeLogger.info('Approval resolved from poll', {
        id: pending.id,
        status,
      });

      return true;
    },

    wasConsumed(rowId: number): boolean {
      return consumedRowIds.has(rowId);
    },

    expireStale(): void {
      const now = Date.now();
      for (const request of store.getAll()) {
        if (request.status === 'pending' && request.timeoutAt <= now) {
          store.resolve(request.id, 'timed_out');
          safeLogger.info('Stale approval expired', { id: request.id });
        }
      }
    },
  };
}
