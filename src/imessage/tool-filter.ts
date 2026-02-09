import type { NativeToolCall } from '../tools/index.js';

export interface ToolFilterResult {
  allowed: NativeToolCall[];
  blocked: NativeToolCall[];
}

/**
 * Check if a command would send an iMessage
 */
function isMessageSendCommand(command: string): boolean {
  const lower = command.toLowerCase();

  if (lower.includes('tell application "messages"')) {
    return true;
  }

  if (lower.includes('tell application \\"messages\\"')) {
    return true;
  }

  if (lower.includes('imessage-send')) {
    return true;
  }

  if (/\bimsg\b/.test(lower) && /\bsend\b/.test(lower)) {
    return true;
  }

  return false;
}

/**
 * Check if a command uses the notes CLI
 */
function isNotesCliCommand(command: string): boolean {
  const lower = command.trim().toLowerCase();
  return lower.startsWith('memo ') || lower.startsWith('grizzly ');
}

/**
 * Filter tool calls to block message-sending commands in iMessage context
 */
export function filterToolCalls(calls: NativeToolCall[]): ToolFilterResult {
  const allowed: NativeToolCall[] = [];
  const blocked: NativeToolCall[] = [];

  for (const call of calls) {
    // Only filter bash tool calls
    if (call.name === 'bash') {
      const command = call.input.command;
      if (typeof command === 'string' && (isMessageSendCommand(command) || isNotesCliCommand(command))) {
        blocked.push(call);
        continue;
      }
    }

    allowed.push(call);
  }

  return { allowed, blocked };
}
