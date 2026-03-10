/**
 * SWE-CI Types
 *
 * Type definitions for the Continuous Integration Loop system,
 * inspired by the SWE-CI paper (arXiv:2603.03823).
 *
 * The CI loop iteratively cycles through:
 *   run_tests → architect (analyze gaps) → programmer (modify code) → run_tests
 *
 * This enables long-term codebase maintainability evaluation and
 * regression-aware code modification.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Test Results
// ─────────────────────────────────────────────────────────────────────────────

/** Status of an individual test case */
export type TestStatus = 'passed' | 'failed' | 'error' | 'skipped';

/** A single test case result */
export interface TestCase {
  /** Fully qualified test name (e.g., 'suite > nested > test name') */
  name: string;

  /** Test status */
  status: TestStatus;

  /** Error message if failed/error */
  errorMessage?: string;

  /** Duration in milliseconds */
  durationMs?: number;
}

/** Aggregate results from a test run */
export interface TestRunResult {
  /** All individual test results */
  tests: TestCase[];

  /** Total test count */
  total: number;

  /** Count by status */
  passed: number;
  failed: number;
  errored: number;
  skipped: number;

  /** Whether the test command itself exited successfully */
  exitCode: number;

  /** Raw output from the test runner */
  rawOutput: string;

  /** Timestamp of this test run */
  timestamp: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Regression Tracking
// ─────────────────────────────────────────────────────────────────────────────

/** Classification of a test's change between iterations */
export type TestDelta =
  | 'fixed'       // was failing, now passing
  | 'regressed'   // was passing, now failing
  | 'stable-pass' // was passing, still passing
  | 'stable-fail' // was failing, still failing
  | 'new'         // test did not exist in previous run
  | 'removed';    // test no longer exists

/** Detailed diff for a single test between two runs */
export interface TestDiff {
  /** Test name */
  name: string;

  /** How this test changed */
  delta: TestDelta;

  /** Previous status (undefined for new tests) */
  previousStatus?: TestStatus;

  /** Current status (undefined for removed tests) */
  currentStatus?: TestStatus;

  /** Error message if currently failing */
  errorMessage?: string;
}

/** Summary of changes between two test runs */
export interface RegressionReport {
  /** Individual test diffs */
  diffs: TestDiff[];

  /** Count of tests that regressed (were passing, now failing) */
  regressionCount: number;

  /** Count of tests that were fixed (were failing, now passing) */
  fixedCount: number;

  /** Count of tests stable-passing */
  stablePassCount: number;

  /** Count of tests stable-failing */
  stableFailCount: number;

  /** Count of new tests */
  newCount: number;

  /** Count of removed tests */
  removedCount: number;

  /** Whether any regressions were introduced */
  hasRegressions: boolean;

  /** Names of regressed tests */
  regressedTests: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Architect Requirements
// ─────────────────────────────────────────────────────────────────────────────

/** Priority level for a requirement */
export type RequirementPriority = 'critical' | 'high' | 'medium' | 'low';

/** A single requirement produced by the Architect */
export interface Requirement {
  /** Unique identifier within the iteration */
  id: string;

  /** Short title describing the requirement */
  title: string;

  /** Detailed description of what needs to change */
  description: string;

  /** Priority level */
  priority: RequirementPriority;

  /** Source files that likely need modification */
  targetFiles: string[];

  /** Test names that this requirement addresses */
  relatedTests: string[];

  /** Tests that must NOT regress when implementing this requirement */
  protectedTests: string[];
}

/** Output of the Architect's 3-step analysis */
export interface ArchitectAnalysis {
  /** Step 1: Summary of all failing tests and root causes */
  summary: string;

  /** Step 2: Concrete code locations attributed to failures */
  locations: CodeLocation[];

  /** Step 3: Designed requirements (max 5 per iteration) */
  requirements: Requirement[];

  /** Tests currently passing that must be protected */
  passingTestsToProtect: string[];

  /** Total failing tests analyzed */
  failingTestCount: number;
}

/** A code location identified by the Architect */
export interface CodeLocation {
  /** File path */
  filePath: string;

  /** Line range (approximate) */
  startLine?: number;
  endLine?: number;

  /** Description of the deficiency at this location */
  deficiency: string;

  /** Related test names */
  relatedTests: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Programmer Output
// ─────────────────────────────────────────────────────────────────────────────

/** A code modification made by the Programmer */
export interface CodeModification {
  /** File path that was modified */
  filePath: string;

  /** Description of the change */
  description: string;

  /** The requirement this modification addresses */
  requirementId: string;

  /** Whether the modification was successful */
  success: boolean;

  /** Error if the modification failed */
  error?: string;
}

/** Output from the Programmer agent */
export interface ProgrammerResult {
  /** All code modifications made */
  modifications: CodeModification[];

  /** Requirements that were fully addressed */
  addressedRequirements: string[];

  /** Requirements that could not be addressed (with reasons) */
  skippedRequirements: Array<{ id: string; reason: string }>;

  /** Summary of changes */
  summary: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// CI Loop Iteration
// ─────────────────────────────────────────────────────────────────────────────

/** Status of a CI loop iteration */
export type IterationStatus =
  | 'running'
  | 'completed'
  | 'failed'
  | 'max-iterations-reached';

/** A single iteration in the CI loop */
export interface CiIteration {
  /** Iteration number (0-indexed) */
  index: number;

  /** Status of this iteration */
  status: IterationStatus;

  /** Test results at the start of this iteration */
  preTestResult: TestRunResult;

  /** Test results after the Programmer's modifications */
  postTestResult?: TestRunResult;

  /** Regression report comparing pre and post test results */
  regressionReport?: RegressionReport;

  /** Architect's analysis for this iteration */
  architectAnalysis?: ArchitectAnalysis;

  /** Programmer's result for this iteration */
  programmerResult?: ProgrammerResult;

  /** Timestamp when this iteration started */
  startedAt: number;

  /** Timestamp when this iteration completed */
  completedAt?: number;

  /** Duration in milliseconds */
  durationMs?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Metrics
// ─────────────────────────────────────────────────────────────────────────────

/** Normalized Change for a single iteration */
export interface NormalizedChange {
  /** Iteration index */
  iteration: number;

  /** NC value on [-1, 1] scale */
  value: number;

  /** Tests fixed this iteration */
  fixed: number;

  /** Tests regressed this iteration */
  regressed: number;

  /** Net change (fixed - regressed) */
  netChange: number;

  /** Total tests at this iteration */
  totalTests: number;
}

/** EvoScore result for a complete CI loop run */
export interface EvoScoreResult {
  /** Final EvoScore value */
  score: number;

  /** Gamma parameter used */
  gamma: number;

  /** Normalized change per iteration */
  normalizedChanges: NormalizedChange[];

  /** Zero-regression rate (proportion of iterations with no regressions) */
  zeroRegressionRate: number;

  /** Total iterations completed */
  totalIterations: number;

  /** Final test pass rate */
  finalPassRate: number;

  /** Initial test pass rate */
  initialPassRate: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// CI Loop Configuration
// ─────────────────────────────────────────────────────────────────────────────

/** Configuration for the CI loop */
export interface CiLoopConfig {
  /** Maximum number of iterations before stopping */
  maxIterations: number;

  /** Maximum requirements per architect iteration */
  maxRequirementsPerIteration: number;

  /** Gamma parameter for EvoScore (>1 favors long-term, <1 favors short-term) */
  gamma: number;

  /** Stop early if all tests pass */
  stopOnAllPass: boolean;

  /** Stop early if no progress is made for N consecutive iterations */
  stagnationLimit: number;

  /** Command to run tests */
  testCommand: string;

  /** Working directory for test execution */
  workingDir: string;

  /** Maximum turns for the architect agent */
  architectMaxTurns: number;

  /** Maximum turns for the programmer agent */
  programmerMaxTurns: number;

  /** Temperature for the architect agent */
  architectTemperature: number;

  /** Temperature for the programmer agent */
  programmerTemperature: number;
}

/** Default CI loop configuration */
export const DEFAULT_CI_LOOP_CONFIG: CiLoopConfig = {
  maxIterations: 10,
  maxRequirementsPerIteration: 5,
  gamma: 1.0,
  stopOnAllPass: true,
  stagnationLimit: 3,
  testCommand: 'npm test',
  workingDir: '.',
  architectMaxTurns: 15,
  programmerMaxTurns: 20,
  architectTemperature: 0.3,
  programmerTemperature: 0.3,
};

// ─────────────────────────────────────────────────────────────────────────────
// CI Loop Result
// ─────────────────────────────────────────────────────────────────────────────

/** Final result of a complete CI loop run */
export interface CiLoopResult {
  /** All iterations */
  iterations: CiIteration[];

  /** EvoScore metrics */
  evoScore: EvoScoreResult;

  /** Why the loop stopped */
  stopReason: 'all-tests-pass' | 'max-iterations' | 'stagnation' | 'error';

  /** Total duration in milliseconds */
  totalDurationMs: number;

  /** Summary of the entire run */
  summary: string;

  /** Configuration used */
  config: CiLoopConfig;
}
