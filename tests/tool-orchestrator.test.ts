import { describe, expect, it } from 'vitest';

import { createToolOrchestrator } from '../src/tools/orchestrator.js';
import type { NativeToolCall, NativeToolResult, NativeToolExecutor } from '../src/tools/schemas/types.js';

// ─── Test helpers ────────────────────────────────────────────────────────────

function makeCall(name: string, id = 'call-1', input: Record<string, unknown> = {}): NativeToolCall {
  return { id, name, input };
}

function makeExecutor(
  toolName: string,
  handler: (call: NativeToolCall) => Promise<NativeToolResult> = async (call) => ({
    toolCallId: call.id,
    success: true,
    output: `Executed ${toolName}`,
  })
): NativeToolExecutor {
  return { toolName, execute: handler };
}

// ═══════════════════════════════════════════════════════════════════════════════
// createToolOrchestrator — initialization
// ═══════════════════════════════════════════════════════════════════════════════

describe('createToolOrchestrator — initialization', () => {
  it('starts with no registered tools', () => {
    const orch = createToolOrchestrator();
    expect(orch.getRegisteredTools()).toEqual([]);
  });

  it('canExecute returns false for unknown tools', () => {
    const orch = createToolOrchestrator();
    expect(orch.canExecute('nonexistent')).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// createToolOrchestrator — registerExecutor
// ═══════════════════════════════════════════════════════════════════════════════

describe('createToolOrchestrator — registerExecutor', () => {
  it('registers a tool executor', () => {
    const orch = createToolOrchestrator();
    orch.registerExecutor(makeExecutor('my_tool'));

    expect(orch.canExecute('my_tool')).toBe(true);
    expect(orch.getRegisteredTools()).toContain('my_tool');
  });

  it('registers multiple executors', () => {
    const orch = createToolOrchestrator();
    orch.registerExecutor(makeExecutor('tool_a'));
    orch.registerExecutor(makeExecutor('tool_b'));
    orch.registerExecutor(makeExecutor('tool_c'));

    expect(orch.getRegisteredTools().length).toBe(3);
    expect(orch.canExecute('tool_a')).toBe(true);
    expect(orch.canExecute('tool_b')).toBe(true);
    expect(orch.canExecute('tool_c')).toBe(true);
  });

  it('overwrites executor for same tool name', () => {
    const orch = createToolOrchestrator();
    orch.registerExecutor(makeExecutor('my_tool', async (call) => ({
      toolCallId: call.id,
      success: true,
      output: 'First',
    })));
    orch.registerExecutor(makeExecutor('my_tool', async (call) => ({
      toolCallId: call.id,
      success: true,
      output: 'Second',
    })));

    expect(orch.getRegisteredTools().length).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// createToolOrchestrator — execute
// ═══════════════════════════════════════════════════════════════════════════════

describe('createToolOrchestrator — execute', () => {
  it('executes a registered tool', async () => {
    const orch = createToolOrchestrator();
    orch.registerExecutor(makeExecutor('echo', async (call) => ({
      toolCallId: call.id,
      success: true,
      output: `Echo: ${call.input.text as string}`,
    })));

    const result = await orch.execute(makeCall('echo', 'c1', { text: 'hello' }));
    expect(result.success).toBe(true);
    expect(result.output).toBe('Echo: hello');
    expect(result.toolCallId).toBe('c1');
  });

  it('returns error for unknown tool', async () => {
    const orch = createToolOrchestrator();

    const result = await orch.execute(makeCall('unknown', 'c1'));
    expect(result.success).toBe(false);
    expect(result.error).toContain('Unknown tool');
    expect(result.error).toContain('unknown');
    expect(result.toolCallId).toBe('c1');
  });

  it('catches executor errors gracefully', async () => {
    const orch = createToolOrchestrator();
    orch.registerExecutor(makeExecutor('failing_tool', async () => {
      throw new Error('Disk full');
    }));

    const result = await orch.execute(makeCall('failing_tool', 'c1'));
    expect(result.success).toBe(false);
    expect(result.error).toContain('Execution error');
    expect(result.error).toContain('Disk full');
    expect(result.toolCallId).toBe('c1');
  });

  it('catches non-Error throws', async () => {
    const orch = createToolOrchestrator();
    orch.registerExecutor(makeExecutor('throws_string', async () => {
      throw 'string error';
    }));

    const result = await orch.execute(makeCall('throws_string', 'c1'));
    expect(result.success).toBe(false);
    expect(result.error).toContain('string error');
  });

  it('passes full NativeToolCall to executor', async () => {
    const orch = createToolOrchestrator();
    let receivedCall: NativeToolCall | null = null;

    orch.registerExecutor(makeExecutor('capture', async (call) => {
      receivedCall = call;
      return { toolCallId: call.id, success: true };
    }));

    await orch.execute(makeCall('capture', 'c42', { key: 'value' }));

    expect(receivedCall).not.toBeNull();
    expect(receivedCall!.id).toBe('c42');
    expect(receivedCall!.name).toBe('capture');
    expect(receivedCall!.input).toEqual({ key: 'value' });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// createToolOrchestrator — executeAll
// ═══════════════════════════════════════════════════════════════════════════════

describe('createToolOrchestrator — executeAll', () => {
  it('executes multiple calls in sequence', async () => {
    const order: string[] = [];
    const orch = createToolOrchestrator();

    orch.registerExecutor(makeExecutor('log', async (call) => {
      order.push(call.id);
      return { toolCallId: call.id, success: true };
    }));

    const results = await orch.executeAll([
      makeCall('log', 'first'),
      makeCall('log', 'second'),
      makeCall('log', 'third'),
    ]);

    expect(results.length).toBe(3);
    expect(order).toEqual(['first', 'second', 'third']);
  });

  it('returns empty array for no calls', async () => {
    const orch = createToolOrchestrator();
    const results = await orch.executeAll([]);
    expect(results).toEqual([]);
  });

  it('continues after failed calls', async () => {
    const orch = createToolOrchestrator();

    orch.registerExecutor(makeExecutor('ok', async (call) => ({
      toolCallId: call.id,
      success: true,
      output: 'ok',
    })));

    const results = await orch.executeAll([
      makeCall('ok', 'c1'),
      makeCall('unknown', 'c2'),  // This will fail (no executor)
      makeCall('ok', 'c3'),
    ]);

    expect(results.length).toBe(3);
    expect(results[0]!.success).toBe(true);
    expect(results[1]!.success).toBe(false);
    expect(results[2]!.success).toBe(true);
  });

  it('preserves result order matching input order', async () => {
    const orch = createToolOrchestrator();

    orch.registerExecutor(makeExecutor('tag', async (call) => ({
      toolCallId: call.id,
      success: true,
      output: `result-${call.id}`,
    })));

    const results = await orch.executeAll([
      makeCall('tag', 'a'),
      makeCall('tag', 'b'),
    ]);

    expect(results[0]!.toolCallId).toBe('a');
    expect(results[0]!.output).toBe('result-a');
    expect(results[1]!.toolCallId).toBe('b');
    expect(results[1]!.output).toBe('result-b');
  });
});
