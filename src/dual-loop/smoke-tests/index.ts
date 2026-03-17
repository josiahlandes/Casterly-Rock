/**
 * Smoke Tests — 3-phase verification pipeline for DeepLoop code review.
 *
 * Phase 1 (automated gates): src/dual-loop/smoke-tests/automated-gates.ts
 * Phase 2 (smoke tests): dispatched by project type from this file
 * Phase 3 (intent review): handled in deep-loop.ts selfReview()
 */

import type { FileOperation } from '../task-board-types.js';
import type { GateResult, PhaseResult, ProjectType } from './types.js';
import { runWebSmokeTest } from './smoke-web.js';
import { runNodeCliSmokeTest } from './smoke-node-cli.js';
import { runPythonSmokeTest } from './smoke-python.js';

// Re-exports
export { detectProjectType } from './detect-project-type.js';
export { runAutomatedGates } from './automated-gates.js';
export type { ProjectType, GateResult, PhaseResult } from './types.js';

/**
 * Run Phase 2 smoke tests based on the detected project type.
 *
 * For project types without a runtime smoke test (typescript, generic),
 * returns a passing result — Phase 1 already covers static checks.
 */
export async function runSmokeTests(
  projectRoot: string,
  projectDir: string,
  projectType: ProjectType,
  manifest: FileOperation[],
): Promise<PhaseResult> {
  const start = Date.now();
  const gates: GateResult[] = [];

  switch (projectType) {
    case 'web':
      gates.push(await runWebSmokeTest(projectRoot, projectDir));
      break;

    case 'node-cli':
      gates.push(await runNodeCliSmokeTest(projectRoot, projectDir));
      break;

    case 'python':
      gates.push(await runPythonSmokeTest(projectRoot, projectDir, manifest));
      break;

    case 'typescript':
    case 'generic':
      // No runtime smoke test — Phase 1 already covers static checks
      break;
  }

  const allPassed = gates.every((g) => g.passed || g.skipped);
  const failedGates = gates.filter((g) => !g.passed && !g.skipped);

  return {
    phase: 'smoke_tests',
    passed: allPassed,
    gates,
    totalDurationMs: Date.now() - start,
    ...(failedGates.length > 0
      ? {
          revisionFeedback: failedGates
            .map((g) => `## ${g.gate} (FAILED)\n${g.output}`)
            .join('\n\n'),
        }
      : {}),
  };
}
