/**
 * Benchmark Module Exports (ISSUE-008)
 */

export type {
  BenchmarkDifficulty,
  BenchmarkCategory,
  BenchmarkCase,
  CaseResult,
  AggregateScore,
  BenchmarkRun,
  BenchmarkStoreData,
} from './types.js';

export {
  BENCHMARK_SUITE_ID,
  BENCHMARK_SUITE,
  getBenchmarkCasesByCategory,
  getBenchmarkCasesByDifficulty,
} from './suite.js';

export {
  ollamaBenchmarkChat,
  extractMetrics,
  type OllamaChatMessage,
  type OllamaBenchmarkResponse,
  type PerformanceMetrics,
} from './metrics.js';

export {
  scoreCase,
  aggregateScores,
  countChecks,
  normalizeEvalRate,
} from './scorer.js';

export {
  createBenchmarkStore,
  type BenchmarkStore,
} from './store.js';

export {
  compareRuns,
  headToHead,
  type ModelRanking,
  type Comparison,
} from './compare.js';

export {
  formatRunSummary,
  formatComparison,
  formatRunAsJson,
} from './report.js';
