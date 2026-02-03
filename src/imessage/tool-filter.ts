import type { ToolCall } from '../skills/types.js';

export interface ToolFilterResult {
  allowed: ToolCall[];
  blocked: ToolCall[];
}

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

function isNotesCliCommand(command: string): boolean {
  const lower = command.trim().toLowerCase();
  return lower.startsWith('memo ') || lower.startsWith('grizzly ');
}

export function filterMessageSendToolCalls(calls: ToolCall[]): ToolFilterResult {
  const allowed: ToolCall[] = [];
  const blocked: ToolCall[] = [];

  for (const call of calls) {
    if (call.tool === 'exec' && (isMessageSendCommand(call.args) || isNotesCliCommand(call.args))) {
      blocked.push(call);
      continue;
    }

    allowed.push(call);
  }

  return { allowed, blocked };
}
