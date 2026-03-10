/**
 * CI Loop Module
 *
 * SWE-CI implementation for Casterly: an iterative Continuous Integration
 * loop that evaluates and improves long-term codebase maintainability.
 *
 * Architecture (from arXiv:2603.03823):
 *   run_tests → Architect (analyze) → Programmer (modify) → run_tests → ...
 *
 * Key components:
 *   - CiLoop: Main orchestrator
 *   - Architect: Analyzes test failures (Summarize → Locate → Design)
 *   - Programmer: Implements requirements from the Architect
 *   - RegressionGuard: Detects regressions between iterations
 *   - Metrics: EvoScore and Normalized Change computation
 *   - TestRunner: Executes tests and parses results
 */

// Types
export type {
  TestStatus,
  TestCase,
  TestRunResult,
  TestDelta,
  TestDiff,
  RegressionReport,
  RequirementPriority,
  Requirement,
  ArchitectAnalysis,
  CodeLocation,
  CodeModification,
  ProgrammerResult,
  IterationStatus,
  CiIteration,
  NormalizedChange,
  EvoScoreResult,
  CiLoopConfig,
  CiLoopResult,
} from './types.js';

export { DEFAULT_CI_LOOP_CONFIG } from './types.js';

// CI Loop
export { runCiLoop } from './ci-loop.js';
export type { CiLoopOptions } from './ci-loop.js';

// Architect
export { runArchitect, parseArchitectOutput, ARCHITECT_TOOLS } from './architect.js';
export type { ArchitectConfig } from './architect.js';

// Programmer
export { runProgrammer, parseProgrammerOutput, PROGRAMMER_TOOLS } from './programmer.js';
export type { ProgrammerConfig } from './programmer.js';

// Regression Guard
export {
  compareTestRuns,
  formatRegressionReport,
  getPassingTests,
  getFailingTests,
} from './regression-guard.js';

// Metrics
export {
  computeNormalizedChange,
  computeEvoScore,
  computeZeroRegressionRate,
  computeFullEvoScore,
  formatEvoScoreReport,
} from './metrics.js';

// Test Runner
export { runTests, parseTestOutput, parseGenericOutput } from './test-runner.js';
export type { TestRunnerOptions } from './test-runner.js';
