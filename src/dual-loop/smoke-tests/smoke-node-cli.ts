/**
 * Node CLI Smoke Test (Phase 2) — Verifies that a Node.js CLI tool runs
 * without crashing by executing its entry point with --help.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { executeCommand } from '../../coding/validation/runner.js';
import type { GateResult } from './types.js';

const CLI_TIMEOUT = 10_000;

/**
 * Detect the CLI entry point from package.json or common conventions.
 */
function detectEntryPoint(projectDirAbs: string): string | null {
  const pkgPath = join(projectDirAbs, 'package.json');

  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as Record<string, unknown>;

      // package.json "bin" field
      if (typeof pkg['bin'] === 'string') {
        return pkg['bin'] as string;
      }
      if (typeof pkg['bin'] === 'object' && pkg['bin'] !== null) {
        const bins = Object.values(pkg['bin'] as Record<string, string>);
        if (bins.length > 0) return bins[0]!;
      }

      // package.json "main" field
      if (typeof pkg['main'] === 'string') {
        return pkg['main'] as string;
      }
    } catch {
      // Ignore malformed package.json
    }
  }

  // Common convention fallbacks
  for (const name of ['index.js', 'cli.js', 'main.js', 'index.mjs']) {
    if (existsSync(join(projectDirAbs, name))) {
      return name;
    }
  }

  return null;
}

/**
 * Run a Node CLI smoke test by executing the entry point with --help.
 */
export async function runNodeCliSmokeTest(
  projectRoot: string,
  projectDir: string,
): Promise<GateResult> {
  const projectDirAbs = resolve(projectRoot, projectDir);
  const entryPoint = detectEntryPoint(projectDirAbs);

  if (!entryPoint) {
    return {
      gate: 'node_cli',
      passed: true,
      output: 'No entry point found — skipping',
      durationMs: 0,
      skipped: true,
    };
  }

  const result = await executeCommand(
    `node ${entryPoint} --help`,
    projectDirAbs,
    CLI_TIMEOUT,
  );

  const output = (result.stdout + '\n' + result.stderr).trim();

  // Exit code 0 or 1 is acceptable (some CLIs return 1 for --help)
  const passed = !result.timedOut && result.exitCode <= 1;

  return {
    gate: 'node_cli',
    passed,
    output: result.timedOut ? 'CLI execution timed out' : output,
    durationMs: result.durationMs,
  };
}
