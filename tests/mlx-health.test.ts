import { mkdtempSync, mkdirSync, chmodSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureMlxServerReady, waitForMlxServerReady } from '../src/providers/mlx-health.js';

describe('waitForMlxServerReady', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns when health check passes on first attempt', async () => {
    fetchSpy.mockResolvedValueOnce(new Response('', { status: 200 }));

    await expect(
      waitForMlxServerReady('http://localhost:8000', {
        maxAttempts: 3,
        delayMs: 1,
        timeoutMs: 100,
      }),
    ).resolves.toBeUndefined();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0]?.[0]).toBe('http://localhost:8000/health');
  });

  it('retries on non-ok responses until healthy', async () => {
    fetchSpy
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(new Response('', { status: 200 }));

    await expect(
      waitForMlxServerReady('http://localhost:8000/', {
        maxAttempts: 5,
        delayMs: 1,
        timeoutMs: 100,
      }),
    ).resolves.toBeUndefined();

    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it('retries on thrown errors and fails after max attempts', async () => {
    fetchSpy.mockRejectedValue(new Error('connect ECONNREFUSED'));

    await expect(
      waitForMlxServerReady('http://localhost:8000', {
        maxAttempts: 3,
        delayMs: 1,
        timeoutMs: 100,
      }),
    ).rejects.toThrow('after 3 attempts');

    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });
});

describe('ensureMlxServerReady', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns immediately when server is already healthy', async () => {
    fetchSpy.mockResolvedValueOnce(new Response('', { status: 200 }));

    await expect(
      ensureMlxServerReady('http://localhost:8000', {
        autoStart: true,
        maxAttempts: 3,
        delayMs: 1,
        timeoutMs: 100,
      }),
    ).resolves.toBeUndefined();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('throws if unhealthy and autoStart is disabled', async () => {
    fetchSpy.mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(
      ensureMlxServerReady('http://localhost:8000', {
        autoStart: false,
        maxAttempts: 2,
        delayMs: 1,
        timeoutMs: 100,
      }),
    ).rejects.toThrow('after 1 attempts');
  });

  it('autostarts mlx server script and retries health', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mlx-autostart-'));
    const scriptsDir = join(root, 'scripts');
    mkdirSync(scriptsDir, { recursive: true });
    const scriptPath = join(scriptsDir, 'mlx-server.sh');
    writeFileSync(scriptPath, '#!/bin/bash\nexit 0\n', 'utf8');
    chmodSync(scriptPath, 0o755);

    let calls = 0;
    fetchSpy.mockImplementation(async () => {
      calls++;
      if (calls === 1) {
        throw new Error('ECONNREFUSED');
      }
      return new Response('', { status: 200 });
    });

    await expect(
      ensureMlxServerReady('http://localhost:8000', {
        projectRoot: root,
        autoStart: true,
        maxAttempts: 3,
        delayMs: 1,
        timeoutMs: 100,
        startTimeoutMs: 2000,
      }),
    ).resolves.toBeUndefined();

    expect(calls).toBe(2);
  });

  it('passes --spec when configured for autostart', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mlx-spec-start-'));
    const scriptsDir = join(root, 'scripts');
    mkdirSync(scriptsDir, { recursive: true });
    const argsPath = join(root, 'args.txt');
    const scriptPath = join(scriptsDir, 'mlx-server.sh');
    writeFileSync(
      scriptPath,
      `#!/bin/bash\necho \"$*\" > \"${argsPath}\"\nexit 0\n`,
      'utf8',
    );
    chmodSync(scriptPath, 0o755);

    let calls = 0;
    fetchSpy.mockImplementation(async () => {
      calls++;
      if (calls === 1) {
        throw new Error('ECONNREFUSED');
      }
      return new Response('', { status: 200 });
    });

    await expect(
      ensureMlxServerReady('http://localhost:8000', {
        projectRoot: root,
        autoStart: true,
        startWithSpec: true,
        maxAttempts: 3,
        delayMs: 1,
        timeoutMs: 100,
        startTimeoutMs: 2000,
      }),
    ).resolves.toBeUndefined();

    const args = readFileSync(argsPath, 'utf8').trim();
    expect(args).toBe('start --spec');
  });
});
