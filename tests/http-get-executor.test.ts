import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { createHttpGetExecutor } from '../src/tools/executors/http-get.js';
import type { NativeToolCall } from '../src/tools/schemas/types.js';

// Mock safeLogger
vi.mock('../src/logging/safe-logger.js', () => ({
  safeLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

function makeCall(input: Record<string, unknown>): NativeToolCall {
  return { id: 'test-call-1', name: 'http_get', input };
}

/** Create a mock Response with a readable body */
function mockResponse(
  body: string,
  init?: { status?: number; statusText?: string; headers?: Record<string, string> },
): Response {
  const encoder = new TextEncoder();
  const encoded = encoder.encode(body);
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoded);
      controller.close();
    },
  });

  return new Response(stream, {
    status: init?.status ?? 200,
    statusText: init?.statusText ?? 'OK',
    headers: new Headers({
      'content-type': 'text/plain',
      'content-length': String(encoded.byteLength),
      ...init?.headers,
    }),
  });
}

describe('createHttpGetExecutor', () => {
  let executor: ReturnType<typeof createHttpGetExecutor>;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    executor = createHttpGetExecutor();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('has the correct toolName', () => {
    expect(executor.toolName).toBe('http_get');
  });

  // ── Input validation ────────────────────────────────────────────────────

  it('rejects empty URL', async () => {
    const result = await executor.execute(makeCall({ url: '' }));
    expect(result.success).toBe(false);
    expect(result.error).toContain('url must be a non-empty string');
  });

  it('rejects missing URL', async () => {
    const result = await executor.execute(makeCall({}));
    expect(result.success).toBe(false);
    expect(result.error).toContain('url must be a non-empty string');
  });

  // ── Security: blocked URLs ─────────────────────────────────────────────

  it('blocks localhost', async () => {
    const result = await executor.execute(makeCall({ url: 'http://localhost:3000/api' }));
    expect(result.success).toBe(false);
    expect(result.error).toContain('Blocked host');
  });

  it('blocks 127.0.0.1', async () => {
    const result = await executor.execute(makeCall({ url: 'http://127.0.0.1/api' }));
    expect(result.success).toBe(false);
    expect(result.error).toContain('Blocked host');
  });

  it('blocks 10.x.x.x private ranges', async () => {
    const result = await executor.execute(makeCall({ url: 'http://10.0.0.1/internal' }));
    expect(result.success).toBe(false);
    expect(result.error).toContain('Blocked host');
  });

  it('blocks 192.168.x.x private ranges', async () => {
    const result = await executor.execute(makeCall({ url: 'http://192.168.1.1/' }));
    expect(result.success).toBe(false);
    expect(result.error).toContain('Blocked host');
  });

  it('blocks 172.16-31.x.x private ranges', async () => {
    const result = await executor.execute(makeCall({ url: 'http://172.16.0.1/' }));
    expect(result.success).toBe(false);
    expect(result.error).toContain('Blocked host');
  });

  it('blocks file:// URLs', async () => {
    const result = await executor.execute(makeCall({ url: 'file:///etc/passwd' }));
    expect(result.success).toBe(false);
    expect(result.error).toContain('Blocked URL scheme');
  });

  it('blocks ftp:// URLs', async () => {
    const result = await executor.execute(makeCall({ url: 'ftp://example.com/file' }));
    expect(result.success).toBe(false);
    expect(result.error).toContain('Blocked URL scheme');
  });

  it('blocks metadata.google.internal', async () => {
    const result = await executor.execute(makeCall({ url: 'http://metadata.google.internal/' }));
    expect(result.success).toBe(false);
    expect(result.error).toContain('Blocked host');
  });

  it('blocks 0.0.0.0', async () => {
    const result = await executor.execute(makeCall({ url: 'http://0.0.0.0/' }));
    expect(result.success).toBe(false);
    expect(result.error).toContain('Blocked host');
  });

  it('blocks link-local addresses', async () => {
    const result = await executor.execute(makeCall({ url: 'http://169.254.169.254/latest/meta-data' }));
    expect(result.success).toBe(false);
    expect(result.error).toContain('Blocked host');
  });

  it('blocks Cookie header', async () => {
    globalThis.fetch = vi.fn();

    const result = await executor.execute(makeCall({
      url: 'https://example.com',
      headers: { Cookie: 'session=abc123' },
    }));

    expect(result.success).toBe(false);
    expect(result.error).toContain('sensitive headers');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('blocks Authorization header', async () => {
    globalThis.fetch = vi.fn();

    const result = await executor.execute(makeCall({
      url: 'https://example.com',
      headers: { Authorization: 'Bearer token123' },
    }));

    expect(result.success).toBe(false);
    expect(result.error).toContain('sensitive headers');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  // ── Successful requests ────────────────────────────────────────────────

  it('fetches a URL and returns text body', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      mockResponse('Hello, world!'),
    );

    const result = await executor.execute(makeCall({ url: 'https://example.com' }));

    expect(result.success).toBe(true);
    const output = JSON.parse(result.output!);
    expect(output.status).toBe(200);
    expect(output.body).toBe('Hello, world!');
    expect(output.truncated).toBe(false);
  });

  it('auto-parses JSON response body', async () => {
    const jsonBody = JSON.stringify({ key: 'value', count: 42 });
    globalThis.fetch = vi.fn().mockResolvedValue(
      mockResponse(jsonBody, {
        headers: { 'content-type': 'application/json' },
      }),
    );

    const result = await executor.execute(makeCall({ url: 'https://api.example.com/data' }));

    expect(result.success).toBe(true);
    const output = JSON.parse(result.output!);
    expect(output.body).toEqual({ key: 'value', count: 42 });
  });

  it('returns status and headers for error responses', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      mockResponse('Not Found', { status: 404, statusText: 'Not Found' }),
    );

    const result = await executor.execute(makeCall({ url: 'https://example.com/missing' }));

    expect(result.success).toBe(true);
    const output = JSON.parse(result.output!);
    expect(output.status).toBe(404);
    expect(output.statusText).toBe('Not Found');
  });

  it('passes custom headers to fetch', async () => {
    const mockFetch = vi.fn().mockResolvedValue(mockResponse('ok'));
    globalThis.fetch = mockFetch;

    await executor.execute(makeCall({
      url: 'https://api.example.com',
      headers: { 'X-Custom': 'test-value' },
    }));

    const fetchCall = mockFetch.mock.calls[0]!;
    expect(fetchCall[1].headers).toEqual({ 'X-Custom': 'test-value' });
  });

  it('allows public IP addresses', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(mockResponse('ok'));

    const result = await executor.execute(makeCall({ url: 'https://8.8.8.8/' }));
    expect(result.success).toBe(true);
  });

  // ── Content-length check ──────────────────────────────────────────────

  it('rejects responses exceeding maxSize via content-length', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      mockResponse('x', {
        headers: { 'content-length': '999999999' },
      }),
    );

    const result = await executor.execute(makeCall({
      url: 'https://example.com/huge',
      maxSize: 1024,
    }));

    expect(result.success).toBe(false);
    expect(result.error).toContain('Response too large');
  });

  // ── Timeout ───────────────────────────────────────────────────────────

  it('handles fetch timeout (abort)', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new DOMException('The operation was aborted.', 'AbortError'));

    const result = await executor.execute(makeCall({
      url: 'https://slow.example.com',
      timeout: 1000,
    }));

    expect(result.success).toBe(false);
    expect(result.error).toContain('timed out');
  });

  // ── Network errors ────────────────────────────────────────────────────

  it('handles network errors', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('getaddrinfo ENOTFOUND bad.example.com'));

    const result = await executor.execute(makeCall({ url: 'https://bad.example.com' }));

    expect(result.success).toBe(false);
    expect(result.error).toContain('HTTP GET failed');
    expect(result.error).toContain('ENOTFOUND');
  });

  // ── Invalid URL ───────────────────────────────────────────────────────

  it('rejects URLs with invalid format', async () => {
    const result = await executor.execute(makeCall({ url: 'not a url at all' }));
    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid URL');
  });

  // ── Body with no reader ───────────────────────────────────────────────

  it('handles response with null body', async () => {
    const noBodyResponse = new Response(null, { status: 204, statusText: 'No Content' });
    globalThis.fetch = vi.fn().mockResolvedValue(noBodyResponse);

    const result = await executor.execute(makeCall({ url: 'https://example.com/empty' }));

    expect(result.success).toBe(true);
    const output = JSON.parse(result.output!);
    expect(output.status).toBe(204);
    expect(output.body).toBe('');
  });
});
