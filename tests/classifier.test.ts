import { describe, expect, it } from 'vitest';

/**
 * Task Classifier Tests
 *
 * Tests the exported classifyMessage by mocking the LLM provider.
 * Exercises parseClassification and buildClassifierContext indirectly.
 */

import { classifyMessage } from '../src/tasks/classifier.js';
import type { LlmProvider, GenerateRequest } from '../src/providers/base.js';
import type { GenerateWithToolsResponse, NativeToolCall } from '../src/tools/schemas/types.js';

// ─── Mock helpers ────────────────────────────────────────────────────────────

function mockResp(
  toolCalls: NativeToolCall[],
  text = '',
): GenerateWithToolsResponse {
  return {
    text,
    toolCalls,
    providerId: 'mock',
    model: 'test-model',
    stopReason: toolCalls.length > 0 ? 'tool_use' : 'end_turn',
  };
}

function classifyCall(input: Record<string, unknown>): NativeToolCall {
  return { id: 'tc-1', name: 'classify_message', input };
}

function createMockProvider(response: GenerateWithToolsResponse): LlmProvider {
  return {
    id: 'mock-provider',
    kind: 'local',
    generateWithTools: async () => response,
    generate: async () => ({ text: '' }),
  } as unknown as LlmProvider;
}

function createErrorProvider(error: Error): LlmProvider {
  return {
    id: 'error-provider',
    kind: 'local',
    generateWithTools: async () => { throw error; },
    generate: async () => ({ text: '' }),
  } as unknown as LlmProvider;
}

// ═══════════════════════════════════════════════════════════════════════════════
// classifyMessage — valid classifications
// ═══════════════════════════════════════════════════════════════════════════════

describe('classifyMessage — conversation', () => {
  it('returns conversation classification', async () => {
    const provider = createMockProvider(
      mockResp([classifyCall({ taskClass: 'conversation', confidence: 0.9, reason: 'Just a greeting' })]),
    );

    const result = await classifyMessage('Hello!', [], provider);
    expect(result.taskClass).toBe('conversation');
    expect(result.confidence).toBe(0.9);
    expect(result.reason).toBe('Just a greeting');
  });
});

describe('classifyMessage — simple_task', () => {
  it('returns simple_task classification', async () => {
    const provider = createMockProvider(
      mockResp([classifyCall({ taskClass: 'simple_task', confidence: 0.85, reason: 'Single tool call', taskType: 'calendar' })]),
    );

    const result = await classifyMessage('What time is my next meeting?', [], provider);
    expect(result.taskClass).toBe('simple_task');
    expect(result.confidence).toBe(0.85);
    expect(result.taskType).toBe('calendar');
  });
});

describe('classifyMessage — complex_task', () => {
  it('returns complex_task classification', async () => {
    const provider = createMockProvider(
      mockResp([classifyCall({ taskClass: 'complex_task', confidence: 0.95, reason: 'Multi-step', taskType: 'coding' })]),
    );

    const result = await classifyMessage('Refactor the auth module and add tests', [], provider);
    expect(result.taskClass).toBe('complex_task');
    expect(result.confidence).toBe(0.95);
    expect(result.taskType).toBe('coding');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// classifyMessage — confidence clamping
// ═══════════════════════════════════════════════════════════════════════════════

describe('classifyMessage — confidence clamping', () => {
  it('clamps confidence above 1.0 to 1.0', async () => {
    const provider = createMockProvider(
      mockResp([classifyCall({ taskClass: 'conversation', confidence: 1.5, reason: 'Very sure' })]),
    );

    const result = await classifyMessage('Hi', [], provider);
    expect(result.confidence).toBe(1.0);
  });

  it('clamps confidence below 0.0 to 0.0', async () => {
    const provider = createMockProvider(
      mockResp([classifyCall({ taskClass: 'simple_task', confidence: -0.5, reason: 'Unsure' })]),
    );

    const result = await classifyMessage('Do something', [], provider);
    expect(result.confidence).toBe(0.0);
  });

  it('defaults confidence to 0.5 when not a number', async () => {
    const provider = createMockProvider(
      mockResp([classifyCall({ taskClass: 'conversation', confidence: 'high', reason: 'Non-numeric' })]),
    );

    const result = await classifyMessage('Hello', [], provider);
    expect(result.confidence).toBe(0.5);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// classifyMessage — fallback behavior
// ═══════════════════════════════════════════════════════════════════════════════

describe('classifyMessage — fallbacks', () => {
  it('defaults to conversation when no tool calls', async () => {
    const provider = createMockProvider(
      mockResp([], 'I think this is a conversation'),
    );

    const result = await classifyMessage('Hello', [], provider);
    expect(result.taskClass).toBe('conversation');
    expect(result.confidence).toBe(0.3);
    expect(result.reason).toContain('fallback');
  });

  it('defaults to conversation when wrong tool called', async () => {
    const provider = createMockProvider(
      mockResp([{ id: 'tc-7', name: 'wrong_tool', input: { something: 'else' } }]),
    );

    const result = await classifyMessage('Hello', [], provider);
    expect(result.taskClass).toBe('conversation');
    expect(result.confidence).toBe(0.3);
  });

  it('defaults to conversation when invalid taskClass', async () => {
    const provider = createMockProvider(
      mockResp([classifyCall({ taskClass: 'invalid_class', confidence: 0.9, reason: 'Bad class' })]),
    );

    const result = await classifyMessage('Hello', [], provider);
    expect(result.taskClass).toBe('conversation');
    expect(result.confidence).toBe(0.3);
  });

  it('defaults to conversation on provider error', async () => {
    const provider = createErrorProvider(new Error('Connection refused'));

    const result = await classifyMessage('Hello', [], provider);
    expect(result.taskClass).toBe('conversation');
    expect(result.confidence).toBe(0.1);
    expect(result.reason).toContain('Connection refused');
  });

  it('defaults reason when not a string', async () => {
    const provider = createMockProvider(
      mockResp([classifyCall({ taskClass: 'conversation', confidence: 0.8, reason: 42 })]),
    );

    const result = await classifyMessage('Hello', [], provider);
    expect(result.reason).toBe('No reason provided');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// classifyMessage — with recent history
// ═══════════════════════════════════════════════════════════════════════════════

describe('classifyMessage — with history context', () => {
  it('passes recent history to provider', async () => {
    let capturedPrompt = '';

    const provider = {
      id: 'capture-provider',
      kind: 'local',
      generateWithTools: async (req: GenerateRequest) => {
        capturedPrompt = req.prompt;
        return mockResp([classifyCall({ taskClass: 'conversation', confidence: 0.8, reason: 'Chat' })]);
      },
      generate: async () => ({ text: '' }),
    } as unknown as LlmProvider;

    const history = ['User: Hello', 'Assistant: Hi there!', 'User: How are you?'];
    await classifyMessage('Good, thanks', history, provider);

    expect(capturedPrompt).toContain('Recent conversation:');
    expect(capturedPrompt).toContain('Hello');
    expect(capturedPrompt).toContain('Good, thanks');
  });

  it('limits history to last 3 entries', async () => {
    let capturedPrompt = '';

    const provider = {
      id: 'capture-provider',
      kind: 'local',
      generateWithTools: async (req: GenerateRequest) => {
        capturedPrompt = req.prompt;
        return mockResp([classifyCall({ taskClass: 'conversation', confidence: 0.7, reason: 'Chat' })]);
      },
      generate: async () => ({ text: '' }),
    } as unknown as LlmProvider;

    const history = [
      'Entry 1 (old)',
      'Entry 2 (old)',
      'Entry 3 (recent)',
      'Entry 4 (recent)',
      'Entry 5 (recent)',
    ];
    await classifyMessage('New message', history, provider);

    // Only last 3 should be included
    expect(capturedPrompt).not.toContain('Entry 1');
    expect(capturedPrompt).not.toContain('Entry 2');
    expect(capturedPrompt).toContain('Entry 3');
    expect(capturedPrompt).toContain('Entry 4');
    expect(capturedPrompt).toContain('Entry 5');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// classifyMessage — optional taskType
// ═══════════════════════════════════════════════════════════════════════════════

describe('classifyMessage — taskType', () => {
  it('includes taskType when provided', async () => {
    const provider = createMockProvider(
      mockResp([classifyCall({ taskClass: 'simple_task', confidence: 0.9, reason: 'File op', taskType: 'file_operation' })]),
    );

    const result = await classifyMessage('List files in /tmp', [], provider);
    expect(result.taskType).toBe('file_operation');
  });

  it('omits taskType when not string', async () => {
    const provider = createMockProvider(
      mockResp([classifyCall({ taskClass: 'conversation', confidence: 0.9, reason: 'Chatting', taskType: 123 })]),
    );

    const result = await classifyMessage('Hello', [], provider);
    expect(result.taskType).toBeUndefined();
  });
});
