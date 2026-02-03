import { describe, expect, it } from 'vitest';

import { filterMessageSendToolCalls } from '../src/imessage/tool-filter.js';
import type { ToolCall } from '../src/skills/types.js';

describe('filterMessageSendToolCalls', () => {
  it('blocks osascript Messages send commands', () => {
    const calls: ToolCall[] = [
      { tool: 'exec', args: `osascript -e 'tell application "Messages" to send "hi" to buddy "+1555"'` },
      { tool: 'exec', args: 'echo "safe"' },
    ];

    const result = filterMessageSendToolCalls(calls);

    expect(result.blocked).toHaveLength(1);
    expect(result.allowed).toHaveLength(1);
    expect(result.allowed[0]?.args).toContain('echo');
  });

  it('blocks imsg send commands', () => {
    const calls: ToolCall[] = [
      { tool: 'exec', args: 'imsg send +15551234567 "hello"' },
    ];

    const result = filterMessageSendToolCalls(calls);

    expect(result.blocked).toHaveLength(1);
    expect(result.allowed).toHaveLength(0);
  });

  it('blocks memo and grizzly note commands', () => {
    const calls: ToolCall[] = [
      { tool: 'exec', args: 'memo notes -a "Title"' },
      { tool: 'exec', args: 'grizzly create --title "Note"' },
      { tool: 'exec', args: 'date' },
    ];

    const result = filterMessageSendToolCalls(calls);

    expect(result.blocked).toHaveLength(2);
    expect(result.allowed).toHaveLength(1);
    expect(result.allowed[0]?.args).toBe('date');
  });

  it('allows non-messaging tool calls', () => {
    const calls: ToolCall[] = [
      { tool: 'exec', args: 'osascript -e \'tell application "Calendar" to get calendars\'' },
      { tool: 'exec', args: 'date' },
    ];

    const result = filterMessageSendToolCalls(calls);

    expect(result.blocked).toHaveLength(0);
    expect(result.allowed).toHaveLength(2);
  });
});
