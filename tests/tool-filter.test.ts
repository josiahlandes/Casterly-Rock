import { describe, expect, it } from 'vitest';

import { filterToolCalls } from '../src/imessage/tool-filter.js';
import type { NativeToolCall } from '../src/tools/index.js';

describe('filterToolCalls', () => {
  it('blocks osascript Messages send commands', () => {
    const calls: NativeToolCall[] = [
      { id: 'call-1', name: 'bash', input: { command: `osascript -e 'tell application "Messages" to send "hi" to buddy "+1555"'` } },
      { id: 'call-2', name: 'bash', input: { command: 'echo "safe"' } },
    ];

    const result = filterToolCalls(calls);

    expect(result.blocked).toHaveLength(1);
    expect(result.allowed).toHaveLength(1);
    expect(result.allowed[0]?.input.command).toContain('echo');
  });

  it('blocks imsg send commands', () => {
    const calls: NativeToolCall[] = [
      { id: 'call-1', name: 'bash', input: { command: 'imsg send +15551234567 "hello"' } },
    ];

    const result = filterToolCalls(calls);

    expect(result.blocked).toHaveLength(1);
    expect(result.allowed).toHaveLength(0);
  });

  it('blocks memo and grizzly note commands', () => {
    const calls: NativeToolCall[] = [
      { id: 'call-1', name: 'bash', input: { command: 'memo notes -a "Title"' } },
      { id: 'call-2', name: 'bash', input: { command: 'grizzly create --title "Note"' } },
      { id: 'call-3', name: 'bash', input: { command: 'date' } },
    ];

    const result = filterToolCalls(calls);

    expect(result.blocked).toHaveLength(2);
    expect(result.allowed).toHaveLength(1);
    expect(result.allowed[0]?.input.command).toBe('date');
  });

  it('allows non-messaging tool calls', () => {
    const calls: NativeToolCall[] = [
      { id: 'call-1', name: 'bash', input: { command: 'osascript -e \'tell application "Calendar" to get calendars\'' } },
      { id: 'call-2', name: 'bash', input: { command: 'date' } },
    ];

    const result = filterToolCalls(calls);

    expect(result.blocked).toHaveLength(0);
    expect(result.allowed).toHaveLength(2);
  });

  it('allows non-bash tool calls through', () => {
    const calls: NativeToolCall[] = [
      { id: 'call-1', name: 'other_tool', input: { command: 'memo notes -a "Title"' } },
    ];

    const result = filterToolCalls(calls);

    expect(result.blocked).toHaveLength(0);
    expect(result.allowed).toHaveLength(1);
  });
});
