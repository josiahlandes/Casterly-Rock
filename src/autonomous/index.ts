/**
 * Autonomous Self-Improvement System
 *
 * Exports all components for the autonomous improvement loop.
 */

// Types
export * from './types.js';

// Provider abstraction
export { createProvider, BaseAutonomousProvider, PROMPTS } from './provider.js';
export type {
  AutonomousProvider,
  AnalyzeResult,
  HypothesizeResult,
  ImplementContext,
  ImplementResult,
  ReflectContext,
  ReflectResult,
  TokenUsage,
} from './provider.js';

// Core modules
export { Analyzer } from './analyzer.js';
export { GitOperations } from './git.js';
export { Validator, buildInvariants } from './validator.js';
export { Reflector } from './reflector.js';
export type { AggregateStats, MemoryEntry } from './reflector.js';

// Main loop
export { AutonomousLoop, AbortError, loadConfig, main } from './loop.js';
export type { LoopOptions } from './loop.js';

// Controller (daemon-side management)
export { createAutonomousController, isInWorkWindow } from './controller.js';
export type { AutonomousController, AutonomousStatus, ControllerOptions } from './controller.js';

// Reports
export { formatDailyReport, formatMorningSummary } from './report.js';

// Test & coverage parser
export {
  parseVitestJson,
  testFileToSourceModule,
  failuresToErrorLogEntries,
  failuresToObservations,
  parseCoverageSummary,
  computeCoverageDelta,
} from './test-parser.js';
export type {
  ParsedTestResults,
  TestSummary,
  TestFailure,
  FileTestResult,
  CoverageSummary,
  CoverageMetric,
  FileCoverage,
} from './test-parser.js';
