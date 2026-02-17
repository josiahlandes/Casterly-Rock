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
  ScoringProfile,
} from './types.js';

export {
  V1_SCORING_PROFILE,
  V2_SCORING_PROFILE,
} from './types.js';

// v1 suite
export {
  BENCHMARK_SUITE_ID,
  BENCHMARK_SUITE,
  getBenchmarkCasesByCategory,
  getBenchmarkCasesByDifficulty,
} from './suite.js';

// v2 agent suite
export {
  AGENT_BENCHMARK_SUITE_ID,
  AGENT_BENCHMARK_SUITE,
  getAgentBenchmarkCasesByCategory,
  getAgentBenchmarkCasesByDifficulty,
} from './agent-suite.js';

// v2 tool schemas
export {
  AGENT_TOOL_SCHEMAS,
  getAgentToolNames,
  type BenchmarkToolSchema,
} from './agent-suite-tools.js';

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
  scoreToolSelection,
  scoreReasoning,
  scoreDelegation,
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
