/**
 * Benchmark Metrics (ISSUE-008)
 *
 * Own Ollama API client for benchmark use.
 * Captures performance fields (eval_count, eval_duration, etc.)
 * that the protected OllamaProvider discards.
 *
 * Does NOT depend on src/providers/ollama.ts.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export interface OllamaChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: OllamaToolCall[];
  tool_call_id?: string;
}

interface OllamaToolCall {
  id?: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface OllamaBenchmarkResponse {
  message?: {
    role: string;
    content: string;
    tool_calls?: OllamaToolCall[];
  };
  done: boolean;
  done_reason?: string;
  error?: string;
  /** Tokens generated */
  eval_count?: number;
  /** Nanoseconds for generation */
  eval_duration?: number;
  /** Tokens in prompt */
  prompt_eval_count?: number;
  /** Nanoseconds for prompt evaluation (proxy for TTFT) */
  prompt_eval_duration?: number;
  /** Nanoseconds total */
  total_duration?: number;
}

export interface PerformanceMetrics {
  tokensInput: number;
  tokensOutput: number;
  /** Time to first token in ms */
  ttftMs: number;
  /** Total completion time in ms */
  totalMs: number;
  /** Tokens per second (output tokens / generation time) */
  evalRate: number;
}

// ─── Ollama Client ───────────────────────────────────────────────────────────

/**
 * Send a chat request to Ollama and capture the full response including
 * performance metrics. Uses stream: false for benchmarking consistency.
 */
export async function ollamaBenchmarkChat(
  baseUrl: string,
  model: string,
  messages: OllamaChatMessage[],
  tools?: unknown[],
  timeoutMs = 120_000,
): Promise<OllamaBenchmarkResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const body: Record<string, unknown> = {
      model,
      messages,
      stream: false,
      options: {
        temperature: 0,
        num_predict: 2048,
      },
    };

    if (tools && tools.length > 0) {
      body.tools = tools;
    }

    const response = await fetch(`${baseUrl.replace(/\/$/, '')}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'Unknown error');
      throw new Error(`Ollama request failed (${response.status}): ${errorText}`);
    }

    return (await response.json()) as OllamaBenchmarkResponse;
  } finally {
    clearTimeout(timeout);
  }
}

// ─── Metrics Extraction ──────────────────────────────────────────────────────

const NS_TO_MS = 1_000_000;

/**
 * Extract performance metrics from an Ollama response.
 * Durations are converted from nanoseconds to milliseconds.
 */
export function extractMetrics(response: OllamaBenchmarkResponse): PerformanceMetrics {
  const tokensInput = response.prompt_eval_count ?? 0;
  const tokensOutput = response.eval_count ?? 0;
  const ttftMs = response.prompt_eval_duration
    ? response.prompt_eval_duration / NS_TO_MS
    : 0;
  const totalMs = response.total_duration
    ? response.total_duration / NS_TO_MS
    : 0;

  // eval_duration is in nanoseconds
  const evalDurationSec = response.eval_duration
    ? response.eval_duration / 1_000_000_000
    : 0;
  const evalRate = evalDurationSec > 0 ? tokensOutput / evalDurationSec : 0;

  return {
    tokensInput,
    tokensOutput,
    ttftMs,
    totalMs,
    evalRate,
  };
}
