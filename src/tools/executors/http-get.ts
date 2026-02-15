/**
 * HTTP GET Executor
 *
 * Makes HTTP GET requests using Node's built-in fetch API.
 * Returns response body, status, headers. Supports JSON and text responses.
 *
 * Safety: Only GET (read-only). Blocks local/internal IPs and file:// URLs.
 */

import { safeLogger } from '../../logging/safe-logger.js';
import type { NativeToolCall, NativeToolResult, NativeToolExecutor } from '../schemas/types.js';

// ─── Types ──────────────────────────────────────────────────────────────────

interface HttpGetInput {
  url: string;
  headers?: Record<string, string>;
  timeout?: number;
  maxSize?: number;
}

// ─── Constants ──────────────────────────────────────────────────────────────

/** Default timeout: 30 seconds */
const DEFAULT_TIMEOUT_MS = 30_000;

/** Max response body size: 2MB */
const DEFAULT_MAX_SIZE = 2 * 1024 * 1024;

/** Absolute max response body: 10MB */
const ABSOLUTE_MAX_SIZE = 10 * 1024 * 1024;

/** Blocked URL patterns (private/internal networks) */
const BLOCKED_HOSTS = [
  /^localhost$/i,
  /^127\.\d+\.\d+\.\d+$/,
  /^10\.\d+\.\d+\.\d+$/,
  /^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/,
  /^192\.168\.\d+\.\d+$/,
  /^0\.0\.0\.0$/,
  /^\[::1\]$/,
  /^169\.254\.\d+\.\d+$/,     // Link-local
  /^metadata\.google\.internal$/i,
  /^instance-data$/i,
];

/** Blocked URL schemes */
const BLOCKED_SCHEMES = ['file:', 'ftp:', 'data:', 'javascript:'];

// ─── Helpers ────────────────────────────────────────────────────────────────

function isBlockedUrl(urlStr: string): string | undefined {
  // Check schemes first
  const lowerUrl = urlStr.toLowerCase();
  for (const scheme of BLOCKED_SCHEMES) {
    if (lowerUrl.startsWith(scheme)) {
      return `Blocked URL scheme: ${scheme}`;
    }
  }

  let parsed: URL;
  try {
    parsed = new URL(urlStr);
  } catch {
    return `Invalid URL: ${urlStr}`;
  }

  // Must be http or https
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return `Only http and https URLs are supported, got: ${parsed.protocol}`;
  }

  // Check hostname against blocklist
  const hostname = parsed.hostname;
  for (const pattern of BLOCKED_HOSTS) {
    if (pattern.test(hostname)) {
      return `Blocked host (internal/private network): ${hostname}`;
    }
  }

  return undefined;
}

// ─── Executor ───────────────────────────────────────────────────────────────

export function createHttpGetExecutor(): NativeToolExecutor {
  return {
    toolName: 'http_get',

    async execute(call: NativeToolCall): Promise<NativeToolResult> {
      const input = call.input as unknown as HttpGetInput;

      // Validate URL
      if (typeof input.url !== 'string' || input.url.trim() === '') {
        return {
          toolCallId: call.id,
          success: false,
          error: 'Invalid input: url must be a non-empty string',
        };
      }

      // Security: block internal/private URLs
      const blockReason = isBlockedUrl(input.url);
      if (blockReason) {
        return {
          toolCallId: call.id,
          success: false,
          error: blockReason,
        };
      }

      // Validate custom headers (disallow sensitive ones)
      const headers: Record<string, string> = {};
      if (input.headers) {
        for (const [key, value] of Object.entries(input.headers)) {
          const lowerKey = key.toLowerCase();
          if (lowerKey === 'cookie' || lowerKey === 'authorization') {
            return {
              toolCallId: call.id,
              success: false,
              error: `Cannot set ${key} header — sensitive headers are not allowed for safety.`,
            };
          }
          headers[key] = String(value);
        }
      }

      const timeoutMs = Math.min(Math.max(input.timeout ?? DEFAULT_TIMEOUT_MS, 1000), 60_000);
      const maxSize = Math.min(Math.max(input.maxSize ?? DEFAULT_MAX_SIZE, 1024), ABSOLUTE_MAX_SIZE);

      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);

        const response = await fetch(input.url, {
          method: 'GET',
          headers,
          signal: controller.signal,
          redirect: 'follow',
        });

        clearTimeout(timer);

        // Check content-length before reading body
        const contentLength = response.headers.get('content-length');
        if (contentLength && parseInt(contentLength, 10) > maxSize) {
          return {
            toolCallId: call.id,
            success: false,
            error: `Response too large: ${contentLength} bytes (max ${maxSize}).`,
          };
        }

        // Read body with size limit
        const reader = response.body?.getReader();
        if (!reader) {
          return {
            toolCallId: call.id,
            success: true,
            output: JSON.stringify({
              status: response.status,
              statusText: response.statusText,
              headers: Object.fromEntries(response.headers.entries()),
              body: '',
              truncated: false,
            }),
          };
        }

        const chunks: Uint8Array[] = [];
        let totalBytes = 0;
        let truncated = false;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          totalBytes += value.byteLength;
          if (totalBytes > maxSize) {
            truncated = true;
            // Keep what we have, stop reading
            const excess = totalBytes - maxSize;
            chunks.push(value.slice(0, value.byteLength - excess));
            reader.cancel();
            break;
          }
          chunks.push(value);
        }

        // Combine chunks into body text
        const decoder = new TextDecoder('utf-8', { fatal: false });
        const bodyParts = chunks.map((chunk) => decoder.decode(chunk, { stream: true }));
        bodyParts.push(decoder.decode());
        const body = bodyParts.join('');

        // Try parsing as JSON if content-type suggests it
        const contentType = response.headers.get('content-type') ?? '';
        let parsedBody: unknown = body;
        if (contentType.includes('application/json')) {
          try {
            parsedBody = JSON.parse(body);
          } catch {
            // Keep as string
          }
        }

        safeLogger.info('http_get executed', {
          url: input.url.substring(0, 100),
          status: response.status,
          bodySize: totalBytes,
          truncated,
        });

        return {
          toolCallId: call.id,
          success: true,
          output: JSON.stringify({
            status: response.status,
            statusText: response.statusText,
            contentType,
            bodySize: totalBytes,
            truncated,
            body: parsedBody,
          }),
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        if (message.includes('abort') || message.includes('AbortError')) {
          return {
            toolCallId: call.id,
            success: false,
            error: `Request timed out after ${timeoutMs}ms`,
          };
        }

        return {
          toolCallId: call.id,
          success: false,
          error: `HTTP GET failed: ${message.substring(0, 300)}`,
        };
      }
    },
  };
}
