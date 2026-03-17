/**
 * Web Smoke Test (Phase 2) — Headless browser verification for HTML/JS projects.
 *
 * Reuses the existing `executeBrowserTest` executor to launch headless Chromium,
 * serve the project via HTTP, and collect console errors, DOM snapshot, and
 * canvas status. Gracefully degrades if Playwright is not installed.
 */

import { executeBrowserTest } from '../../tools/executors/browser-test.js';
import type { NativeToolCall } from '../../tools/schemas/types.js';
import type { GateResult } from './types.js';

/**
 * Run the headless browser smoke test against a web project directory.
 *
 * @param projectRoot - Absolute path to the repository root
 * @param projectDir - Relative path to the project directory (e.g. "projects/neon-invaders")
 */
export async function runWebSmokeTest(
  projectRoot: string,
  projectDir: string,
): Promise<GateResult> {
  const start = Date.now();

  const syntheticCall: NativeToolCall = {
    id: `smoke-web-${Date.now()}`,
    name: 'browser_test',
    input: {
      directory: projectDir,
      wait_ms: 3000,
    },
  };

  const result = await executeBrowserTest(syntheticCall, projectRoot);
  const output = result.output ?? result.error ?? '';
  const durationMs = Date.now() - start;

  // Playwright not installed — skip gracefully
  if (
    result.error?.includes('Playwright') ||
    result.error?.includes('playwright')
  ) {
    return {
      gate: 'browser_test',
      passed: true,
      output: 'Playwright not installed — skipping browser smoke test',
      durationMs,
      skipped: true,
    };
  }

  // Check for issues in browser test output
  const hasIssues =
    !result.success || /ISSUES FOUND/i.test(output);

  return {
    gate: 'browser_test',
    passed: !hasIssues,
    output,
    durationMs,
  };
}
