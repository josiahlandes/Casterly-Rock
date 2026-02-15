/**
 * Send Message Executor
 *
 * Sends iMessages to specified recipients via AppleScript.
 * Used when the LLM needs to message someone other than the current sender.
 */

import { safeLogger } from '../../logging/safe-logger.js';
import { sendMessage } from '../../imessage/sender.js';
import type { NativeToolCall, NativeToolResult, NativeToolExecutor } from '../schemas/types.js';

interface SendMessageInput {
  recipient: string;
  text: string;
}

/** Basic validation for phone/email recipient format */
function isValidRecipient(recipient: string): boolean {
  // Phone number: starts with + and has digits
  if (/^\+\d{7,15}$/.test(recipient.replace(/[\s\-()]/g, ''))) {
    return true;
  }
  // Email: basic format check
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient)) {
    return true;
  }
  return false;
}

export function createSendMessageExecutor(): NativeToolExecutor {
  return {
    toolName: 'send_message',

    async execute(call: NativeToolCall): Promise<NativeToolResult> {
      const { recipient, text } = call.input as unknown as SendMessageInput;

      if (typeof recipient !== 'string' || recipient.trim() === '') {
        return {
          toolCallId: call.id,
          success: false,
          error: 'Invalid input: recipient must be a non-empty string (phone number or email)',
        };
      }

      if (typeof text !== 'string' || text.trim() === '') {
        return {
          toolCallId: call.id,
          success: false,
          error: 'Invalid input: text must be a non-empty string',
        };
      }

      if (!isValidRecipient(recipient)) {
        return {
          toolCallId: call.id,
          success: false,
          error: `Invalid recipient format: "${recipient}". Must be a phone number (+15551234567) or email.`,
        };
      }

      // Cap message length to prevent abuse
      if (text.length > 5000) {
        return {
          toolCallId: call.id,
          success: false,
          error: 'Message too long. Maximum 5000 characters.',
        };
      }

      try {
        const result = sendMessage(recipient, text);

        if (result.success) {
          safeLogger.info('send_message executed', {
            recipient: recipient.substring(0, 4) + '***',
            textLength: text.length,
          });

          return {
            toolCallId: call.id,
            success: true,
            output: JSON.stringify({
              sent: true,
              recipient: recipient.substring(0, 4) + '***',
              textLength: text.length,
            }),
          };
        }

        return {
          toolCallId: call.id,
          success: false,
          error: result.error ?? 'Failed to send message',
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          toolCallId: call.id,
          success: false,
          error: `Send failed: ${message}`,
        };
      }
    },
  };
}
