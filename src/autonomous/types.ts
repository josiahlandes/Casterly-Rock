/**
 * Core types for the Autonomous Self-Improvement System
 */

// ============================================================================
// OBSERVATIONS
// ============================================================================

export type ObservationType =
  | 'error_pattern'
  | 'performance_issue'
  | 'capability_gap'
  | 'resource_concern'
  | 'test_failure'
  | 'code_smell';

export type Severity = 'low' | 'medium' | 'high' | 'critical';

export interface Observation {
  id: string;
  type: ObservationType;
  severity: Severity;
  frequency: number;
  context: Record<string, unknown>;
  suggestedArea: string;
  timestamp: string;
  source: 'error_logs' | 'performance_metrics' | 'test_results' | 'static_analysis';
}

// ============================================================================
// HYPOTHESES
// ============================================================================

export type HypothesisApproach =
  | 'fix_bug'
  | 'optimize_performance'
  | 'add_tool'
  | 'add_test'
  | 'refactor'
  | 'update_config'
  | 'improve_docs';

export type Complexity = 'trivial' | 'simple' | 'moderate' | 'complex';

export interface Hypothesis {
  id: string;
  observation: Observation;
  proposal: string;
  approach: HypothesisApproach;
  expectedImpact: 'low' | 'medium' | 'high';
  confidence: number; // 0-1
  affectedFiles: string[];
  estimatedComplexity: Complexity;
  previousAttempts: number;
  reasoning: string;
}

// ============================================================================
// IMPLEMENTATION
// ============================================================================

export interface FileChange {
  path: string;
  type: 'create' | 'modify' | 'delete';
  diff?: string | undefined;
  linesAdded?: number | undefined;
  linesRemoved?: number | undefined;
}

export interface Implementation {
  hypothesisId: string;
  branch: string;
  commitHash?: string | undefined;
  changes: FileChange[];
  description: string;
  timestamp: string;
}

// ============================================================================
// VALIDATION
// ============================================================================

export interface ValidationResult {
  passed: boolean;
  invariantsHold: boolean;
  testsPassed: boolean;
  testsRun: number;
  testsFailed: number;
  errors: string[];
  warnings: string[];
  metrics: {
    testDurationMs: number;
    coverageDelta?: number | undefined;
    lintErrors?: number | undefined;
    typeErrors?: number | undefined;
  };
}

// ============================================================================
// INTEGRATION
// ============================================================================

export type IntegrationMode = 'direct' | 'pull_request';

export interface IntegrationResult {
  success: boolean;
  mode: IntegrationMode;
  branch: string;
  mergeCommit?: string | undefined;
  pullRequestUrl?: string | undefined;
  pullRequestNumber?: number | undefined;
  error?: string | undefined;
}

// ============================================================================
// REFLECTION
// ============================================================================

export type CycleOutcome = 'success' | 'failure' | 'partial' | 'skipped';

export interface Reflection {
  cycleId: string;
  timestamp: string;
  observation: Observation;
  hypothesis: Hypothesis;
  implementation?: Implementation | undefined;
  validation?: ValidationResult | undefined;
  integration?: IntegrationResult | undefined;
  outcome: CycleOutcome;
  learnings: string;
  tokensUsed?: { input: number; output: number } | undefined;
  durationMs: number;
}

// ============================================================================
// CYCLE
// ============================================================================

export interface CycleMetrics {
  cycleId: string;
  startTime: string;
  endTime?: string | undefined;
  durationMs?: number | undefined;
  observationsFound: number;
  hypothesesGenerated: number;
  hypothesesAttempted: number;
  hypothesesSucceeded: number;
  tokensUsed: {
    input: number;
    output: number;
  };
  estimatedCostUsd?: number | undefined;
}

// ============================================================================
// CONFIGURATION
// ============================================================================

export interface AutonomousConfig {
  enabled: boolean;
  provider: 'ollama';
  model: string;

  // Timing
  cycleIntervalMinutes: number;
  maxCyclesPerDay: number;
  quietHours?: {
    start: string;
    end: string;
    enabled: boolean;
  } | undefined;

  // Scope
  maxAttemptsPerCycle: number;
  maxFilesPerChange: number;
  allowedDirectories: string[];
  forbiddenPatterns: string[];

  // Thresholds
  autoIntegrateThreshold: number;
  attemptThreshold: number;

  // Resource limits
  maxBranchAgeHours: number;
  maxConcurrentBranches: number;
  sandboxTimeoutSeconds: number;
  sandboxMemoryMb: number;

  // Budget (API phase)
  budget?: {
    dailyLimitUsd: number;
    monthlyLimitUsd: number;
    alertThreshold: number;
  } | undefined;

  // Git
  git: {
    remote: string;
    baseBranch: string;
    branchPrefix: string;
    integrationMode: IntegrationMode;
    pullRequest?: {
      autoMerge: boolean;
      requireCi: boolean;
      labels: string[];
      reviewers: string[];
      draft: boolean;
    } | undefined;
    cleanup: {
      deleteMergedBranches: boolean;
      deleteFailedBranches: boolean;
      maxStaleBranchAgeHours: number;
    };
  };

}

// ============================================================================
// ANALYSIS CONTEXT
// ============================================================================

export interface AnalysisContext {
  errorLogs: ErrorLogEntry[];
  performanceMetrics: PerformanceMetric[];
  recentReflections: Reflection[];
  codebaseStats: CodebaseStats;
}

export interface ErrorLogEntry {
  timestamp: string;
  code: string;
  message: string;
  stack?: string | undefined;
  frequency: number;
  lastOccurrence: string;
}

export interface PerformanceMetric {
  name: string;
  p50: number;
  p95: number;
  p99: number;
  samples: number;
  trend: 'improving' | 'stable' | 'degrading';
}

export interface CodebaseStats {
  totalFiles: number;
  totalLines: number;
  testCoverage?: number | undefined;
  lintErrors: number;
  typeErrors: number;
  lastCommit: string;
}

// ============================================================================
// INVARIANTS
// ============================================================================

export interface Invariant {
  name: string;
  check: string;
  description: string;
  threshold?: string | undefined;
  invert?: boolean | undefined;
}

export interface InvariantCheckResult {
  name: string;
  passed: boolean;
  output?: string | undefined;
  error?: string | undefined;
  durationMs: number;
}

// ============================================================================
// SECURITY AGENT
// ============================================================================

export type ThreatType =
  | 'prompt_injection'
  | 'command_injection'
  | 'script_injection'
  | 'data_exfiltration'
  | 'size_limit'
  | 'encoding_suspicious'
  | 'semantic_threat';

export interface ThreatReport {
  type: ThreatType;
  severity: Severity;
  pattern?: string | undefined;
  location?: number | undefined;
  confidence: number;
  description?: string | undefined;
}

export interface SecurityScanResult {
  safe: boolean;
  content?: string | undefined;
  threats: ThreatReport[];
  analysisMs: number;
  source: string;
  timestamp: string;
}

export interface SecurityAgentConfig {
  enabled: boolean;

  // Static pattern checking
  patterns: {
    promptInjection: boolean;
    commandInjection: boolean;
    scriptInjection: boolean;
    dataExfiltration: boolean;
  };

  // Content limits
  limits: {
    maxContentLength: number;
    maxNestingDepth: number;
    maxEncodedRatio: number;
    minReadableRatio: number;
  };

  // LLM-based semantic analysis
  semanticAnalysis: {
    enabled: boolean;
    model: string;
    confidenceThreshold: number;
  };

  // Response behavior
  onThreat: {
    action: 'block' | 'sanitize' | 'warn';
    log: boolean;
    alert: boolean;
  };

  // Trusted sources that bypass checks
  trustedDomains: string[];
}

// ============================================================================
// RESEARCH AGENT
// ============================================================================

export interface ResearchRequest {
  query: string;
  context?: string | undefined;
  maxResults?: number | undefined;
}

export interface ResearchResult {
  query: string;
  findings: ResearchFinding[];
  securityScan: SecurityScanResult;
  timestamp: string;
  durationMs: number;
}

export interface ResearchFinding {
  source: string;
  title?: string | undefined;
  content: string;
  relevance: number;
}
