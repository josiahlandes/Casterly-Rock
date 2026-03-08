/**
 * MLX Server Readiness Helper.
 *
 * Waits for a vllm-mlx server to become healthy before traffic is routed
 * through the MLX provider.
 */

import { execFile } from 'node:child_process';
import { resolve } from 'node:path';

export interface MlxReadinessOptions {
  maxAttempts?: number;
  delayMs?: number;
  timeoutMs?: number;
}

export interface EnsureMlxServerOptions extends MlxReadinessOptions {
  projectRoot?: string;
  autoStart?: boolean;
  startWithSpec?: boolean;
  startTimeoutMs?: number;
  /** Extra environment variables to pass to the server start script (e.g., KV cache config). */
  startEnv?: Record<string, string>;
  /** Instance name for multi-instance support (namespaces PID/log files). Default: "default". */
  instance?: string;
}

function normalizePositiveInt(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function probeHealth(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { method: 'GET', signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function stringifyUnknown(value: unknown): string {
  if (value instanceof Error) {
    return value.message;
  }
  return String(value);
}

function runScript(
  file: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  extraEnv?: Record<string, string>,
): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(
      'bash',
      [file, ...args],
      {
        cwd,
        timeout: timeoutMs,
        maxBuffer: 1024 * 1024,
        ...(extraEnv ? { env: { ...process.env, ...extraEnv } } : {}),
      },
      (error, stdout, stderr) => {
        if (error) {
          const output = [stdout, stderr, error.message].filter(Boolean).join('\n');
          rejectPromise(new Error(output));
          return;
        }
        resolvePromise();
      },
    );
  });
}

/**
 * Retry `/health` until MLX server is ready or attempts are exhausted.
 */
export async function waitForMlxServerReady(
  baseUrl: string,
  options?: MlxReadinessOptions,
): Promise<void> {
  const maxAttempts = normalizePositiveInt(options?.maxAttempts, 20);
  const delayMs = normalizePositiveInt(options?.delayMs, 3000);
  const timeoutMs = normalizePositiveInt(options?.timeoutMs, 5000);
  const normalizedBase = baseUrl.replace(/\/$/, '');
  const healthUrl = `${normalizedBase}/health`;

  let lastError = 'unknown error';

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await probeHealth(healthUrl, timeoutMs);
      if (response.ok) {
        return;
      }
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }

    if (attempt < maxAttempts) {
      await sleep(delayMs);
    }
  }

  throw new Error(
    `MLX server not ready at ${healthUrl} after ${maxAttempts} attempts: ${lastError}`,
  );
}

/**
 * Ensure MLX server is reachable. If it is down and autoStart=true, starts
 * scripts/mlx-server.sh (detached service) and waits for readiness.
 */
export async function ensureMlxServerReady(
  baseUrl: string,
  options?: EnsureMlxServerOptions,
): Promise<void> {
  const timeoutMs = normalizePositiveInt(options?.timeoutMs, 5000);
  const maxAttempts = normalizePositiveInt(options?.maxAttempts, 20);
  const delayMs = normalizePositiveInt(options?.delayMs, 3000);
  const startTimeoutMs = normalizePositiveInt(options?.startTimeoutMs, 120000);
  const projectRoot = options?.projectRoot ?? process.cwd();
  const autoStart = options?.autoStart !== false;
  const startWithSpec = options?.startWithSpec === true;
  const startEnv = options?.startEnv;
  const instance = options?.instance;

  try {
    await waitForMlxServerReady(baseUrl, {
      maxAttempts: 1,
      delayMs: 1,
      timeoutMs,
    });
    return;
  } catch (probeError) {
    if (!autoStart) {
      throw probeError;
    }
  }

  const scriptPath = resolve(projectRoot, 'scripts', 'mlx-server.sh');
  const args = ['start', ...(startWithSpec ? ['--spec'] : [])];

  // Merge instance name into start environment so mlx-server.sh uses
  // the correct PID file and log namespace.
  const mergedEnv: Record<string, string> = {
    ...(startEnv ?? {}),
    ...(instance ? { MLX_INSTANCE: instance } : {}),
  };

  try {
    await runScript(scriptPath, args, projectRoot, startTimeoutMs, mergedEnv);
  } catch (startError) {
    const output = stringifyUnknown(startError).toLowerCase();
    // Benign race: another process started the server between our probe/start.
    if (!output.includes('already running')) {
      throw new Error(
        `Failed to start MLX server with ${scriptPath}: ${stringifyUnknown(startError)}`,
      );
    }
  }

  await waitForMlxServerReady(baseUrl, {
    maxAttempts,
    delayMs,
    timeoutMs,
  });
}
