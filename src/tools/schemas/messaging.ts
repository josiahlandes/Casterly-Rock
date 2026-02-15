/**
 * Messaging Tool Schemas
 *
 * Tool definitions for the send_message tool.
 * Allows the LLM to send iMessages to specified recipients.
 */

import type { ToolSchema } from './types.js';

/**
 * Send an iMessage to a specific person
 */
export const SEND_MESSAGE_TOOL: ToolSchema = {
  name: 'send_message',
  description: `Send an iMessage to a specific person (not the current sender).

Use when the user asks you to text, message, or send something to another person.
Do NOT use this to reply to the current sender — your reply is sent automatically.
Do NOT use bash with osascript or AppleScript — always use this tool.

Requires a phone number or email as the recipient.`,

  inputSchema: {
    type: 'object',
    properties: {
      recipient: {
        type: 'string',
        description: 'Phone number (e.g. "+15551234567") or email of the recipient.',
      },
      text: {
        type: 'string',
        description: 'The message text to send.',
      },
    },
    required: ['recipient', 'text'],
  },
};

/**
 * All messaging tool schemas
 */
export const MESSAGING_TOOLS: ToolSchema[] = [
  SEND_MESSAGE_TOOL,
];
