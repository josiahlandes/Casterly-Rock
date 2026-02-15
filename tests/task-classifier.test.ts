import { describe, expect, it, vi } from 'vitest';

import { classifyMessage } from '../src/tasks/classifier.js';
import type { LlmProvider } from '../src/providers/base.js';
import type { GenerateWithToolsResponse } from '../src/tools/schemas/types.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeMockProvider(response: GenerateWithToolsResponse): LlmProvider {
  return {
    id: 'test-provider',
    kind: 'local',
    model: 'test-model',
    generateWithTools: vi.fn().mockResolvedValue(response),
  };
}

function makeToolCallResponse(input: Record<string, unknown>): GenerateWithToolsResponse {
  return {
    text: '',
    toolCalls: [
      {
        id: 'call-1',
        name: 'classify_message',
        input,
      },
    ],
    providerId: 'test-provider',
    model: 'test-model',
    stopReason: 'tool_use',
  };
}

function makeNoToolCallResponse(): GenerateWithToolsResponse {
  return {
    text: 'I think this is a conversation.',
    toolCalls: [],
    providerId: 'test-provider',
    model: 'test-model',
    stopReason: 'end_turn',
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// classifyMessage
// ═══════════════════════════════════════════════════════════════════════════════

describe('classifyMessage', () => {
  // ── Successful classification ──────────────────────────────────────────

  it('returns conversation classification when model calls tool with conversation', async () => {
    const provider = makeMockProvider(
      makeToolCallResponse({
        taskClass: 'conversation',
        confidence: 0.95,
        reason: 'User is chatting',
      })
    );

    const result = await classifyMessage('Hello, how are you?', [], provider);

    expect(result.taskClass).toBe('conversation');
    expect(result.confidence).toBe(0.95);
    expect(result.reason).toBe('User is chatting');
    expect(result.taskType).toBeUndefined();
  });

  it('returns simple_task classification', async () => {
    const provider = makeMockProvider(
      makeToolCallResponse({
        taskClass: 'simple_task',
        confidence: 0.85,
        reason: 'User wants to check calendar',
        taskType: 'calendar',
      })
    );

    const result = await classifyMessage('Check my calendar', [], provider);

    expect(result.taskClass).toBe('simple_task');
    expect(result.confidence).toBe(0.85);
    expect(result.taskType).toBe('calendar');
  });

  it('returns complex_task classification', async () => {
    const provider = makeMockProvider(
      makeToolCallResponse({
        taskClass: 'complex_task',
        confidence: 0.9,
        reason: 'Multi-step task requiring planning',
        taskType: 'file_operation',
      })
    );

    const result = await classifyMessage(
      'Organize my downloads folder and zip old files',
      [],
      provider
    );

    expect(result.taskClass).toBe('complex_task');
    expect(result.confidence).toBe(0.9);
    expect(result.taskType).toBe('file_operation');
  });

  // ── Confidence clamping ────────────────────────────────────────────────

  it('clamps confidence above 1 to 1', async () => {
    const provider = makeMockProvider(
      makeToolCallResponse({
        taskClass: 'conversation',
        confidence: 5.0,
        reason: 'Very confident',
      })
    );

    const result = await classifyMessage('Hello', [], provider);
    expect(result.confidence).toBe(1);
  });

  it('clamps confidence below 0 to 0', async () => {
    const provider = makeMockProvider(
      makeToolCallResponse({
        taskClass: 'simple_task',
        confidence: -0.5,
        reason: 'Low confidence',
      })
    );

    const result = await classifyMessage('Do something', [], provider);
    expect(result.confidence).toBe(0);
  });

  it('defaults confidence to 0.5 when not a number', async () => {
    const provider = makeMockProvider(
      makeToolCallResponse({
        taskClass: 'conversation',
        reason: 'No confidence provided',
      })
    );

    const result = await classifyMessage('Hello', [], provider);
    expect(result.confidence).toBe(0.5);
  });

  // ── Default values ─────────────────────────────────────────────────────

  it('defaults reason to "No reason provided" when missing', async () => {
    const provider = makeMockProvider(
      makeToolCallResponse({
        taskClass: 'conversation',
        confidence: 0.8,
      })
    );

    const result = await classifyMessage('Hello', [], provider);
    expect(result.reason).toBe('No reason provided');
  });

  it('taskType is undefined when not provided', async () => {
    const provider = makeMockProvider(
      makeToolCallResponse({
        taskClass: 'simple_task',
        confidence: 0.7,
        reason: 'Some task',
      })
    );

    const result = await classifyMessage('Do something', [], provider);
    expect(result.taskType).toBeUndefined();
  });

  // ── No tool call fallback ──────────────────────────────────────────────

  it('falls back to conversation with 0.3 confidence when model does not call tool', async () => {
    const provider = makeMockProvider(makeNoToolCallResponse());

    const result = await classifyMessage('Hello', [], provider);

    expect(result.taskClass).toBe('conversation');
    expect(result.confidence).toBe(0.3);
    expect(result.reason).toContain('fallback');
  });

  // ── Wrong tool name fallback ───────────────────────────────────────────

  it('falls back to conversation when model calls a different tool', async () => {
    const provider = makeMockProvider({
      text: '',
      toolCalls: [
        {
          id: 'call-1',
          name: 'wrong_tool',
          input: { taskClass: 'simple_task' },
        },
      ],
      providerId: 'test-provider',
      model: 'test-model',
      stopReason: 'tool_use',
    });

    const result = await classifyMessage('Do something', [], provider);

    expect(result.taskClass).toBe('conversation');
    expect(result.confidence).toBe(0.3);
  });

  // ── Invalid taskClass fallback ─────────────────────────────────────────

  it('falls back to conversation when taskClass is invalid', async () => {
    const provider = makeMockProvider(
      makeToolCallResponse({
        taskClass: 'invalid_class',
        confidence: 0.9,
        reason: 'Bad classification',
      })
    );

    const result = await classifyMessage('Test', [], provider);

    expect(result.taskClass).toBe('conversation');
    expect(result.confidence).toBe(0.3);
  });

  it('falls back to conversation when taskClass is missing', async () => {
    const provider = makeMockProvider(
      makeToolCallResponse({
        confidence: 0.9,
        reason: 'No class',
      })
    );

    const result = await classifyMessage('Test', [], provider);

    expect(result.taskClass).toBe('conversation');
    expect(result.confidence).toBe(0.3);
  });

  // ── Error fallback ─────────────────────────────────────────────────────

  it('falls back to conversation with 0.1 confidence on provider error', async () => {
    const provider: LlmProvider = {
      id: 'test-provider',
      kind: 'local',
      model: 'test-model',
      generateWithTools: vi.fn().mockRejectedValue(new Error('Connection refused')),
    };

    const result = await classifyMessage('Hello', [], provider);

    expect(result.taskClass).toBe('conversation');
    expect(result.confidence).toBe(0.1);
    expect(result.reason).toContain('Connection refused');
  });

  it('handles non-Error exceptions', async () => {
    const provider: LlmProvider = {
      id: 'test-provider',
      kind: 'local',
      model: 'test-model',
      generateWithTools: vi.fn().mockRejectedValue('string error'),
    };

    const result = await classifyMessage('Hello', [], provider);

    expect(result.taskClass).toBe('conversation');
    expect(result.confidence).toBe(0.1);
    expect(result.reason).toContain('string error');
  });

  // ── Context building ───────────────────────────────────────────────────

  it('passes recent history to the provider in the prompt', async () => {
    const provider = makeMockProvider(
      makeToolCallResponse({
        taskClass: 'conversation',
        confidence: 0.8,
        reason: 'Chat context',
      })
    );

    await classifyMessage(
      'What about tomorrow?',
      ['User: What is the weather?', 'Assistant: It is sunny.'],
      provider
    );

    const call = vi.mocked(provider.generateWithTools).mock.calls[0]!;
    const prompt = call[0].prompt;

    expect(prompt).toContain('Recent conversation:');
    expect(prompt).toContain('What is the weather?');
    expect(prompt).toContain('It is sunny.');
    expect(prompt).toContain('What about tomorrow?');
  });

  it('limits recent history to last 3 entries', async () => {
    const provider = makeMockProvider(
      makeToolCallResponse({
        taskClass: 'conversation',
        confidence: 0.8,
        reason: 'Chat',
      })
    );

    const history = [
      'Exchange 1',
      'Exchange 2',
      'Exchange 3',
      'Exchange 4',
      'Exchange 5',
    ];

    await classifyMessage('Current message', history, provider);

    const call = vi.mocked(provider.generateWithTools).mock.calls[0]!;
    const prompt = call[0].prompt;

    // Should only include last 3
    expect(prompt).not.toContain('Exchange 1');
    expect(prompt).not.toContain('Exchange 2');
    expect(prompt).toContain('Exchange 3');
    expect(prompt).toContain('Exchange 4');
    expect(prompt).toContain('Exchange 5');
  });

  it('handles empty history', async () => {
    const provider = makeMockProvider(
      makeToolCallResponse({
        taskClass: 'conversation',
        confidence: 0.9,
        reason: 'No history',
      })
    );

    await classifyMessage('Hello', [], provider);

    const call = vi.mocked(provider.generateWithTools).mock.calls[0]!;
    const prompt = call[0].prompt;

    expect(prompt).not.toContain('Recent conversation:');
    expect(prompt).toContain('Current message: Hello');
  });

  // ── Provider call parameters ───────────────────────────────────────────

  it('passes correct tools and parameters to provider', async () => {
    const provider = makeMockProvider(
      makeToolCallResponse({
        taskClass: 'conversation',
        confidence: 0.9,
        reason: 'Test',
      })
    );

    await classifyMessage('Hello', [], provider);

    expect(provider.generateWithTools).toHaveBeenCalledTimes(1);

    const call = vi.mocked(provider.generateWithTools).mock.calls[0]!;
    const tools = call[1];

    // Should pass exactly the classify_message tool
    expect(tools).toHaveLength(1);
    expect(tools[0]!.name).toBe('classify_message');
    expect(tools[0]!.inputSchema.required).toContain('taskClass');
    expect(tools[0]!.inputSchema.required).toContain('confidence');
    expect(tools[0]!.inputSchema.required).toContain('reason');
  });
});
