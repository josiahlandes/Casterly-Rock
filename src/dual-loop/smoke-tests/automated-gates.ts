/**
 * Automated Gates (Phase 1) — Deterministic verification checks.
 *
 * Runs typecheck, lint, tests, static analysis, and file existence checks
 * without involving any LLM. Catches ~80% of real bugs in seconds.
 *
 * If any gate fails, the pipeline short-circuits to revision with the
 * concrete tool output as feedback — no LLM needed to explain the error.
 */

import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { executeCommand } from '../../coding/validation/runner.js';
import { executeValidateProject } from '../../tools/executors/validate-project.js';
import type { NativeToolCall } from '../../tools/schemas/types.js';
import type { FileOperation } from '../task-board-types.js';
import type { GateResult, PhaseResult, ProjectType } from './types.js';

const DEFAULT_GATE_TIMEOUT = 15_000;
const TEST_TIMEOUT = 30_000;

// ─────────────────────────────────────────────────────────────────────────────
// Individual Gates
// ─────────────────────────────────────────────────────────────────────────────

function checkFileExistence(
  projectRoot: string,
  manifest: FileOperation[],
): GateResult {
  const start = Date.now();
  const missing: string[] = [];

  for (const file of manifest) {
    const fullPath = file.path.startsWith('/')
      ? file.path
      : resolve(projectRoot, file.path);
    if (!existsSync(fullPath)) {
      missing.push(file.path);
    }
  }

  if (missing.length > 0) {
    return {
      gate: 'file_existence',
      passed: false,
      output: `Missing files:\n${missing.map((f) => `- ${f}`).join('\n')}`,
      durationMs: Date.now() - start,
    };
  }

  return {
    gate: 'file_existence',
    passed: true,
    output: `All ${manifest.length} manifest files exist`,
    durationMs: Date.now() - start,
  };
}

async function runTypecheck(
  projectDir: string,
  projectRoot: string,
  manifest: FileOperation[],
  projectType: ProjectType,
): Promise<GateResult> {
  // Only run for TypeScript projects or web projects with .ts files
  const hasTsFiles = manifest.some((f) =>
    f.path.endsWith('.ts') || f.path.endsWith('.tsx'),
  );
  if (projectType !== 'typescript' && !hasTsFiles) {
    return { gate: 'typecheck', passed: true, output: '', durationMs: 0, skipped: true };
  }

  // Check if tsconfig.json exists in the project dir
  const projectDirAbs = resolve(projectRoot, projectDir);
  const hasTsConfig = existsSync(join(projectDirAbs, 'tsconfig.json'));
  if (!hasTsConfig) {
    // No tsconfig in the project dir — try root tsconfig
    if (!existsSync(join(projectRoot, 'tsconfig.json'))) {
      return { gate: 'typecheck', passed: true, output: 'No tsconfig.json found', durationMs: 0, skipped: true };
    }
  }

  const cwd = hasTsConfig ? projectDirAbs : projectRoot;
  const result = await executeCommand('npx tsc --noEmit', cwd, DEFAULT_GATE_TIMEOUT);

  const output = (result.stdout + '\n' + result.stderr).trim();
  return {
    gate: 'typecheck',
    passed: result.exitCode === 0,
    output: result.timedOut ? 'Typecheck timed out' : output,
    durationMs: result.durationMs,
  };
}

async function runLintGate(
  projectRoot: string,
): Promise<GateResult> {
  // Only run if the project has a lint script (i.e., Casterly repo)
  if (!existsSync(join(projectRoot, 'scripts', 'lint.mjs'))) {
    return { gate: 'lint', passed: true, output: '', durationMs: 0, skipped: true };
  }

  const result = await executeCommand('node scripts/lint.mjs', projectRoot, DEFAULT_GATE_TIMEOUT);
  const output = (result.stdout + '\n' + result.stderr).trim();

  return {
    gate: 'lint',
    passed: result.exitCode === 0,
    output: result.timedOut ? 'Lint timed out' : output,
    durationMs: result.durationMs,
  };
}

async function runTestsGate(
  projectDir: string,
  projectRoot: string,
  manifest: FileOperation[],
): Promise<GateResult> {
  // Only run if test files exist in the manifest or project dir
  const hasTestFiles = manifest.some((f) =>
    /\.(?:test|spec)\.[jt]sx?$/.test(f.path),
  );

  if (!hasTestFiles) {
    return { gate: 'tests', passed: true, output: '', durationMs: 0, skipped: true };
  }

  const projectDirAbs = resolve(projectRoot, projectDir);
  const result = await executeCommand('npx vitest run', projectDirAbs, TEST_TIMEOUT);
  const output = (result.stdout + '\n' + result.stderr).trim();

  return {
    gate: 'tests',
    passed: result.exitCode === 0,
    output: result.timedOut ? 'Tests timed out' : output,
    durationMs: result.durationMs,
  };
}

async function runValidateProjectGate(
  projectDir: string,
  projectRoot: string,
  projectType: ProjectType,
): Promise<GateResult> {
  // Only for JS/TS projects
  if (projectType !== 'web' && projectType !== 'typescript' && projectType !== 'node-cli') {
    return { gate: 'validate_project', passed: true, output: '', durationMs: 0, skipped: true };
  }

  const start = Date.now();

  const syntheticCall: NativeToolCall = {
    id: `gate-validate-${Date.now()}`,
    name: 'validate_project',
    input: { directory: projectDir },
  };

  const result = await executeValidateProject(syntheticCall, projectRoot);
  const output = result.output ?? result.error ?? '';

  // validate_project returns success=true even with issues; check output for "issue(s) found"
  const hasIssues = /\d+\s+issue\(s\)\s+found/i.test(output);

  return {
    gate: 'validate_project',
    passed: !hasIssues,
    output,
    durationMs: Date.now() - start,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 1 Orchestrator
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build formatted revision feedback from failed gates.
 */
function buildRevisionFeedback(gates: GateResult[]): string {
  const failed = gates.filter((g) => !g.passed && !g.skipped);
  if (failed.length === 0) return '';

  return failed
    .map((g) => `## ${g.gate} (FAILED)\n${g.output}`)
    .join('\n\n');
}

/**
 * Run all automated gates for Phase 1 verification.
 *
 * Gates run in sequence. All gates run to completion (no fail-fast)
 * so the coder gets the full picture of what's broken.
 */
export async function runAutomatedGates(
  projectRoot: string,
  projectDir: string,
  manifest: FileOperation[],
  projectType: ProjectType,
): Promise<PhaseResult> {
  const start = Date.now();
  const gates: GateResult[] = [];

  // 1. File existence (synchronous, always runs)
  gates.push(checkFileExistence(projectRoot, manifest));

  // 2. Typecheck
  gates.push(await runTypecheck(projectDir, projectRoot, manifest, projectType));

  // 3. Lint
  gates.push(await runLintGate(projectRoot));

  // 4. Tests
  gates.push(await runTestsGate(projectDir, projectRoot, manifest));

  // 5. Static analysis
  gates.push(await runValidateProjectGate(projectDir, projectRoot, projectType));

  const allPassed = gates.every((g) => g.passed || g.skipped);

  return {
    phase: 'automated_gates',
    passed: allPassed,
    gates,
    totalDurationMs: Date.now() - start,
    ...(allPassed ? {} : { revisionFeedback: buildRevisionFeedback(gates) }),
  };
}
