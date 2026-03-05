/**
 * Browser Test Executor
 *
 * Launches a headless browser (via Playwright) to test HTML/JS projects.
 * Collects console errors, DOM snapshot, and canvas status.
 * Graceful fallback if Playwright is not installed.
 */

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { NativeToolCall, NativeToolResult } from '../schemas/types.js';

export const BROWSER_TEST_SCHEMA = {
  name: 'browser_test',
  description:
    'Launch a headless browser to test an HTML/JS project. Serves the directory via HTTP, opens index.html, waits, then collects console errors, DOM snapshot, and canvas status. Requires Playwright.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      directory: {
        type: 'string' as const,
        description: 'Project directory containing index.html (relative to project root)',
      },
      wait_ms: {
        type: 'number' as const,
        description: 'Milliseconds to wait after page load before collecting results (default: 3000)',
      },
    },
    required: ['directory'],
  },
};

export async function executeBrowserTest(
  call: NativeToolCall,
  projectRoot: string,
): Promise<NativeToolResult> {
  const directory = call.input['directory'];
  if (typeof directory !== 'string' || directory.trim() === '') {
    return {
      toolCallId: call.id,
      success: false,
      error: 'Invalid input: directory must be a non-empty string',
    };
  }

  const waitMs = Math.min(Number(call.input['wait_ms'] ?? 3000), 10000);

  const dirPath = resolve(projectRoot, directory);
  const indexPath = join(dirPath, 'index.html');

  if (!existsSync(indexPath)) {
    return {
      toolCallId: call.id,
      success: false,
      error: `No index.html found in ${directory}`,
    };
  }

  // Try to import Playwright (optional dependency)
  let playwright: typeof import('playwright');
  try {
    playwright = await import('playwright');
  } catch {
    return {
      toolCallId: call.id,
      success: false,
      error:
        'Playwright is not installed. Run: npm install --save-dev playwright && npx playwright install chromium',
    };
  }

  // Start a temporary HTTP server for the project directory
  const mimeTypes: Record<string, string> = {
    html: 'text/html',
    js: 'application/javascript',
    mjs: 'application/javascript',
    css: 'text/css',
    json: 'application/json',
    png: 'image/png',
    jpg: 'image/jpeg',
    svg: 'image/svg+xml',
    wasm: 'application/wasm',
    ico: 'image/x-icon',
  };

  const server = createServer((req, res) => {
    const url = req.url === '/' ? '/index.html' : (req.url ?? '/index.html');
    const filePath = join(dirPath, url);

    if (!existsSync(filePath)) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    const ext = filePath.split('.').pop()?.toLowerCase() ?? '';

    readFile(filePath)
      .then((content) => {
        res.writeHead(200, { 'Content-Type': mimeTypes[ext] ?? 'application/octet-stream' });
        res.end(content);
      })
      .catch(() => {
        res.writeHead(500);
        res.end('Error reading file');
      });
  });

  // Listen on a random available port
  await new Promise<void>((resolveListening) => {
    server.listen(0, '127.0.0.1', () => resolveListening());
  });
  const port = (server.address() as AddressInfo).port;

  try {
    const browser = await playwright.chromium.launch({ headless: true });
    const page = await browser.newPage();

    // Collect console messages and page errors
    const consoleMessages: Array<{ type: string; text: string }> = [];
    const pageErrors: string[] = [];

    page.on('console', (msg) => {
      consoleMessages.push({ type: msg.type(), text: msg.text() });
    });

    page.on('pageerror', (err) => {
      pageErrors.push(String(err));
    });

    // Navigate and wait for network idle
    await page.goto(`http://127.0.0.1:${port}/`, {
      waitUntil: 'networkidle',
      timeout: 15000,
    });

    // Additional wait for JS execution
    await page.waitForTimeout(waitMs);

    // Collect DOM snapshot (string expression avoids DOM type errors in Node tsconfig)
    const domSnapshot: {
      title: string;
      bodyText: string;
      scriptCount: number;
      canvasCount: number;
      canvasInfo: Array<{ width: number; height: number }>;
      elementCount: number;
    } = await page.evaluate(`(() => {
      const body = document.body;
      const scripts = document.querySelectorAll('script');
      const canvases = document.querySelectorAll('canvas');
      const canvasInfo = Array.from(canvases).map(c => ({
        width: c.width,
        height: c.height,
      }));
      return {
        title: document.title,
        bodyText: body && body.innerText ? body.innerText.slice(0, 500) : '',
        scriptCount: scripts.length,
        canvasCount: canvases.length,
        canvasInfo: canvasInfo,
        elementCount: document.querySelectorAll('*').length,
      };
    })()`);

    await browser.close();

    // Format results
    const errors = consoleMessages.filter((m) => m.type === 'error');
    const warnings = consoleMessages.filter((m) => m.type === 'warning');

    const lines: string[] = [];
    lines.push(`## Browser Test Results: ${directory}`);
    lines.push('');

    if (pageErrors.length > 0) {
      lines.push(`### Page Errors (${pageErrors.length})`);
      for (const e of pageErrors) {
        lines.push(`  - ${e}`);
      }
      lines.push('');
    }

    if (errors.length > 0) {
      lines.push(`### Console Errors (${errors.length})`);
      for (const e of errors) {
        lines.push(`  - ${e.text}`);
      }
      lines.push('');
    }

    if (warnings.length > 0) {
      lines.push(`### Console Warnings (${warnings.length})`);
      for (const w of warnings) {
        lines.push(`  - ${w.text}`);
      }
      lines.push('');
    }

    lines.push('### DOM Snapshot');
    lines.push(`  Title: ${domSnapshot.title}`);
    lines.push(`  Elements: ${domSnapshot.elementCount}`);
    lines.push(`  Scripts: ${domSnapshot.scriptCount}`);
    lines.push(`  Canvases: ${domSnapshot.canvasCount}`);
    if (domSnapshot.canvasInfo.length > 0) {
      for (const [i, c] of domSnapshot.canvasInfo.entries()) {
        lines.push(`  Canvas ${i}: ${c.width}x${c.height}`);
      }
    }
    lines.push('');

    const hasIssues = pageErrors.length > 0 || errors.length > 0;
    lines.push(
      hasIssues
        ? `### Verdict: ISSUES FOUND (${pageErrors.length} page errors, ${errors.length} console errors)`
        : '### Verdict: NO ERRORS',
    );

    return {
      toolCallId: call.id,
      success: true,
      output: lines.join('\n'),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      toolCallId: call.id,
      success: false,
      error: `Browser test failed: ${message}`,
    };
  } finally {
    server.close();
  }
}
