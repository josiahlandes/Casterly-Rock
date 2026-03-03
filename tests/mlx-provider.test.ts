import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { MlxProvider } from '../src/providers/mlx.js';
import type { GenerateRequest } from '../src/providers/base.js';
import type { ToolSchema } from '../src/tools/schemas/types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Minimal tool schema for testing */
function makeTool(name: string): ToolSchema {
  return {
    name,
    description: `Test tool: ${name}`,
    inputSchema: {
      type: 'object',
      properties: {
        input: { type: 'string', description: 'test input' },
      },
      required: ['input'],
    },
  };
}

/** Minimal generate request */
function makeRequest(overrides?: Partial<GenerateRequest>): GenerateRequest {
  return {
    prompt: 'Hello, world!',
    ...overrides,
  };
}

/** Build a mock OpenAI response */
function mockOpenAIResponse(options: {
  content?: string | null;
  toolCalls?: Array<{
    id: string;
    name: string;
    arguments: string;
  }>;
  finishReason?: string;
}): Response {
  const choice: Record<string, unknown> = {
    message: {
      role: 'assistant',
      content: options.content !== undefined ? options.content : 'Response text',
      ...(options.toolCalls
        ? {
            tool_calls: options.toolCalls.map((tc) => ({
              id: tc.id,
              type: 'function',
              function: { name: tc.name, arguments: tc.arguments },
            })),
          }
        : {}),
    },
    finish_reason: options.finishReason ?? 'stop',
  };

  return new Response(JSON.stringify({ choices: [choice] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('MlxProvider', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Provider Identity ──────────────────────────────────────────────────

  it('has correct provider identity', () => {
    const provider = new MlxProvider({
      baseUrl: 'http://localhost:8000',
      model: 'test-model',
    });
    expect(provider.id).toBe('mlx');
    expect(provider.kind).toBe('local');
    expect(provider.model).toBe('test-model');
  });

  // ── Basic Generation ───────────────────────────────────────────────────

  it('sends request to OpenAI-compatible endpoint', async () => {
    fetchSpy.mockResolvedValueOnce(mockOpenAIResponse({ content: 'Hello!' }));

    const provider = new MlxProvider({
      baseUrl: 'http://localhost:8000',
      model: 'qwen3.5-122b',
    });

    const result = await provider.generateWithTools(makeRequest(), []);

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, options] = fetchSpy.mock.calls[0]!;
    expect(url).toBe('http://localhost:8000/v1/chat/completions');
    expect((options as RequestInit).method).toBe('POST');

    const body = JSON.parse((options as RequestInit).body as string);
    expect(body.model).toBe('qwen3.5-122b');
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].role).toBe('user');
    expect(body.stream).toBe(false);
  });

  it('returns text content from response', async () => {
    fetchSpy.mockResolvedValueOnce(mockOpenAIResponse({ content: 'The answer is 42.' }));

    const provider = new MlxProvider({ baseUrl: 'http://localhost:8000', model: 'test' });
    const result = await provider.generateWithTools(makeRequest(), []);

    expect(result.text).toBe('The answer is 42.');
    expect(result.toolCalls).toHaveLength(0);
    expect(result.providerId).toBe('mlx');
    expect(result.model).toBe('test');
    expect(result.stopReason).toBe('end_turn');
  });

  it('handles null content', async () => {
    fetchSpy.mockResolvedValueOnce(mockOpenAIResponse({ content: null }));

    const provider = new MlxProvider({ baseUrl: 'http://localhost:8000', model: 'test' });
    const result = await provider.generateWithTools(makeRequest(), []);

    expect(result.text).toBe('');
  });

  // ── System Prompt ──────────────────────────────────────────────────────

  it('includes system prompt in messages', async () => {
    fetchSpy.mockResolvedValueOnce(mockOpenAIResponse({ content: 'OK' }));

    const provider = new MlxProvider({ baseUrl: 'http://localhost:8000', model: 'test' });
    await provider.generateWithTools(
      makeRequest({ systemPrompt: 'You are a helpful assistant.' }),
      [],
    );

    const body = JSON.parse((fetchSpy.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0].role).toBe('system');
    expect(body.messages[0].content).toBe('You are a helpful assistant.');
    expect(body.messages[1].role).toBe('user');
  });

  // ── Tool Calling ───────────────────────────────────────────────────────

  it('formats tools for OpenAI API', async () => {
    fetchSpy.mockResolvedValueOnce(mockOpenAIResponse({ content: 'OK' }));

    const provider = new MlxProvider({ baseUrl: 'http://localhost:8000', model: 'test' });
    await provider.generateWithTools(makeRequest(), [makeTool('read_file'), makeTool('write_file')]);

    const body = JSON.parse((fetchSpy.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.tools).toHaveLength(2);
    expect(body.tools[0].type).toBe('function');
    expect(body.tools[0].function.name).toBe('read_file');
    expect(body.tool_choice).toBe('auto');
  });

  it('omits tools and tool_choice when no tools provided', async () => {
    fetchSpy.mockResolvedValueOnce(mockOpenAIResponse({ content: 'OK' }));

    const provider = new MlxProvider({ baseUrl: 'http://localhost:8000', model: 'test' });
    await provider.generateWithTools(makeRequest(), []);

    const body = JSON.parse((fetchSpy.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.tools).toBeUndefined();
    expect(body.tool_choice).toBeUndefined();
  });

  it('parses tool calls from JSON string arguments', async () => {
    fetchSpy.mockResolvedValueOnce(
      mockOpenAIResponse({
        content: null,
        toolCalls: [
          { id: 'call_1', name: 'read_file', arguments: '{"path": "/src/main.ts"}' },
        ],
        finishReason: 'tool_calls',
      }),
    );

    const provider = new MlxProvider({ baseUrl: 'http://localhost:8000', model: 'test' });
    const result = await provider.generateWithTools(makeRequest(), [makeTool('read_file')]);

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]!.id).toBe('call_1');
    expect(result.toolCalls[0]!.name).toBe('read_file');
    expect(result.toolCalls[0]!.input).toEqual({ path: '/src/main.ts' });
    expect(result.stopReason).toBe('tool_use');
  });

  it('handles multiple tool calls', async () => {
    fetchSpy.mockResolvedValueOnce(
      mockOpenAIResponse({
        content: null,
        toolCalls: [
          { id: 'call_1', name: 'read_file', arguments: '{"path": "a.ts"}' },
          { id: 'call_2', name: 'read_file', arguments: '{"path": "b.ts"}' },
        ],
      }),
    );

    const provider = new MlxProvider({ baseUrl: 'http://localhost:8000', model: 'test' });
    const result = await provider.generateWithTools(makeRequest(), [makeTool('read_file')]);

    expect(result.toolCalls).toHaveLength(2);
    expect(result.toolCalls[0]!.id).toBe('call_1');
    expect(result.toolCalls[1]!.id).toBe('call_2');
  });

  it('generates tool call ID when missing', async () => {
    const response = new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  type: 'function',
                  function: { name: 'test', arguments: '{}' },
                  // No id field
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      }),
      { status: 200 },
    );
    fetchSpy.mockResolvedValueOnce(response);

    const provider = new MlxProvider({ baseUrl: 'http://localhost:8000', model: 'test' });
    const result = await provider.generateWithTools(makeRequest(), [makeTool('test')]);

    expect(result.toolCalls[0]!.id).toMatch(/^call_/);
  });

  it('handles tool calls with object arguments (compat servers)', async () => {
    // Some OpenAI-compat servers return parsed objects instead of JSON strings
    const response = new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call_obj',
                  type: 'function',
                  function: { name: 'test', arguments: { key: 'value' } },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      }),
      { status: 200 },
    );
    fetchSpy.mockResolvedValueOnce(response);

    const provider = new MlxProvider({ baseUrl: 'http://localhost:8000', model: 'test' });
    const result = await provider.generateWithTools(makeRequest(), [makeTool('test')]);

    expect(result.toolCalls[0]!.input).toEqual({ key: 'value' });
  });

  // ── Stop Reasons ───────────────────────────────────────────────────────

  it('detects max_tokens stop reason', async () => {
    fetchSpy.mockResolvedValueOnce(
      mockOpenAIResponse({ content: 'Partial output...', finishReason: 'length' }),
    );

    const provider = new MlxProvider({ baseUrl: 'http://localhost:8000', model: 'test' });
    const result = await provider.generateWithTools(makeRequest(), []);

    expect(result.stopReason).toBe('max_tokens');
  });

  // ── Multi-turn Tool Use ────────────────────────────────────────────────

  it('threads previous assistant messages and tool results', async () => {
    fetchSpy.mockResolvedValueOnce(mockOpenAIResponse({ content: 'Done.' }));

    const provider = new MlxProvider({ baseUrl: 'http://localhost:8000', model: 'test' });
    await provider.generateWithTools(
      makeRequest({
        previousAssistantMessages: [
          {
            text: 'Let me read that file.',
            toolCalls: [
              { id: 'call_1', name: 'read_file', arguments: '{"path": "main.ts"}' },
            ],
          },
        ],
      }),
      [makeTool('read_file')],
      [{ callId: 'call_1', result: 'file contents here' }],
    );

    const body = JSON.parse((fetchSpy.mock.calls[0]![1] as RequestInit).body as string);
    // user + assistant + tool = 3 messages
    expect(body.messages).toHaveLength(3);
    expect(body.messages[1].role).toBe('assistant');
    expect(body.messages[1].tool_calls[0].function.arguments).toBe('{"path": "main.ts"}');
    expect(body.messages[2].role).toBe('tool');
    expect(body.messages[2].content).toBe('file contents here');
  });

  // ── Error Handling ─────────────────────────────────────────────────────

  it('throws ProviderError on HTTP error', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response('Internal Server Error', { status: 500 }),
    );

    const provider = new MlxProvider({ baseUrl: 'http://localhost:8000', model: 'test' });
    await expect(provider.generateWithTools(makeRequest(), [])).rejects.toThrow(
      'MLX request failed with status 500',
    );
  });

  it('throws ProviderError on API error response', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { message: 'Model not found' } }), { status: 200 }),
    );

    const provider = new MlxProvider({ baseUrl: 'http://localhost:8000', model: 'test' });
    await expect(provider.generateWithTools(makeRequest(), [])).rejects.toThrow(
      'MLX error: Model not found',
    );
  });

  it('throws ProviderError on empty response', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ choices: [] }), { status: 200 }),
    );

    const provider = new MlxProvider({ baseUrl: 'http://localhost:8000', model: 'test' });
    await expect(provider.generateWithTools(makeRequest(), [])).rejects.toThrow(
      'MLX returned empty response',
    );
  });

  it('throws ProviderError on timeout', async () => {
    fetchSpy.mockImplementationOnce(
      () => new Promise((_resolve, reject) => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        reject(err);
      }),
    );

    const provider = new MlxProvider({
      baseUrl: 'http://localhost:8000',
      model: 'test',
      timeoutMs: 100,
    });
    await expect(provider.generateWithTools(makeRequest(), [])).rejects.toThrow(
      'MLX request timed out',
    );
  });

  // ── URL Handling ───────────────────────────────────────────────────────

  it('strips trailing slash from base URL', async () => {
    fetchSpy.mockResolvedValueOnce(mockOpenAIResponse({ content: 'OK' }));

    const provider = new MlxProvider({
      baseUrl: 'http://localhost:8000/',
      model: 'test',
    });
    await provider.generateWithTools(makeRequest(), []);

    const url = fetchSpy.mock.calls[0]![0];
    expect(url).toBe('http://localhost:8000/v1/chat/completions');
  });

  // ── Request Parameters ─────────────────────────────────────────────────

  it('passes temperature and maxTokens', async () => {
    fetchSpy.mockResolvedValueOnce(mockOpenAIResponse({ content: 'OK' }));

    const provider = new MlxProvider({ baseUrl: 'http://localhost:8000', model: 'test' });
    await provider.generateWithTools(
      makeRequest({ temperature: 0.1, maxTokens: 4096 }),
      [],
    );

    const body = JSON.parse((fetchSpy.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.temperature).toBe(0.1);
    expect(body.max_tokens).toBe(4096);
  });

  it('uses default temperature and maxTokens', async () => {
    fetchSpy.mockResolvedValueOnce(mockOpenAIResponse({ content: 'OK' }));

    const provider = new MlxProvider({ baseUrl: 'http://localhost:8000', model: 'test' });
    await provider.generateWithTools(makeRequest(), []);

    const body = JSON.parse((fetchSpy.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.temperature).toBe(0.7);
    expect(body.max_tokens).toBe(2048);
  });
});
