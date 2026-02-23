/**
 * Core types for the Autonomous Self-Improvement System
 */

// ============================================================================
// OBSERVATIONS
// ============================================================================

type ObservationType =
  | 'error_pattern'
  | 'performance_issue'
  | 'capability_gap'
  | 'resource_concern'
  | 'test_failure'
  | 'code_smell'
  | 'feature_request';

export type Severity = 'low' | 'medium' | 'high' | 'critical';

export interface Observation {
  id: string;
  type: ObservationType;
  severity: Severity;
  frequency: number;
  context: Record<string, unknown>;
  suggestedArea: string;
  timestamp: string;
  source: 'error_logs' | 'performance_metrics' | 'test_results' | 'static_analysis' | 'backlog';
}

// ============================================================================
// HYPOTHESES
// ============================================================================

type HypothesisApproach =
  | 'fix_bug'
  | 'optimize_performance'
  | 'add_tool'
  | 'add_test'
  | 'refactor'
  | 'update_config'
  | 'improve_docs'
  | 'add_feature';

type Complexity = 'trivial' | 'simple' | 'moderate' | 'complex';

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

type IntegrationMode = 'direct' | 'pull_request' | 'approval_required';

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

export type CycleOutcome = 'success' | 'failure' | 'partial' | 'skipped' | 'pending_review';

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
// HANDOFF STATE
// ============================================================================

export interface PendingBranch {
  branch: string;
  hypothesisId: string;
  proposal: string;
  approach: string;
  confidence: number;
  impact: string;
  filesChanged: { path: string; type: string }[];
  validatedAt: string;
  commitHash: string;
}

export interface HandoffState {
  timestamp: string;
  pendingBranches: PendingBranch[];
  lastCycleId: string | null;
  nightSummary: {
    cyclesCompleted: number;
    hypothesesAttempted: number;
    hypothesesValidated: number;
    tokenUsage: { input: number; output: number };
  };
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

  // Approval (for integration_mode: approval_required)
  approvalTimeoutMinutes: number;

  // Backlog
  backlogPath?: string | undefined;

  // Resource limits (Mac Studio - generous defaults)
  maxBranchAgeHours: number;
  maxConcurrentBranches: number;
  sandboxTimeoutSeconds: number;
  sandboxMemoryMb: number;

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

  // Vision tier toggles — controls which self-improvement stores are active
  visionTiers?: VisionTiersConfig | undefined;

  // Communication — proactive user messaging
  communication?: CommunicationConfig | undefined;

  // Dream cycle scheduling — controls automatic dream cycle triggering
  dreamCycles?: DreamCyclesConfig | undefined;
}

// ============================================================================
// VISION TIERS
// ============================================================================

export interface VisionTiersConfig {
  /** Enable Vision Tier 2: prompt-store, shadow-store, tool-synthesizer */
  tier2: boolean;
  /** Enable Vision Tier 3: challenges, prompt-evolution, LoRA training */
  tier3: boolean;
}

// ============================================================================
// DREAM CYCLES
// ============================================================================

export interface DreamCyclesConfig {
  /** Hours between consolidation runs (default: 24) */
  consolidationIntervalHours: number;
  /** Maximum turns for the exploration phase (default: 50) */
  explorationBudgetTurns: number;
  /** Hours between self-model rebuilds (default: 48) */
  selfModelRebuildIntervalHours: number;
  /** Days to look back for code archaeology (default: 90) */
  archaeologyLookbackDays: number;
  /** Days between retrospective writes (default: 7) */
  retrospectiveIntervalDays: number;
}

// ============================================================================
// COMMUNICATION
// ============================================================================

export interface CommunicationConfig {
  /** Whether messaging is enabled */
  enabled: boolean;
  /** Delivery channel */
  deliveryChannel?: 'imessage' | 'console' | undefined;
  /** iMessage recipient (required when channel is imessage) */
  recipient?: string | undefined;
  /** Throttle settings */
  throttle?: {
    maxPerHour: number;
    maxPerDay: number;
    quietHours: boolean;
    quietStart: string;
    quietEnd: string;
  } | undefined;
  /** Test failure notification threshold */
  testFailureMinSeverity?: 'always' | 'unresolvable' | undefined;
  /** Whether to send daily summary notifications */
  dailySummaryEnabled?: boolean | undefined;
}

// ============================================================================
// ANALYSIS CONTEXT
// ============================================================================

export interface AnalysisContext {
  errorLogs: ErrorLogEntry[];
  performanceMetrics: PerformanceMetric[];
  recentReflections: Reflection[];
  codebaseStats: CodebaseStats;
  backlogItems: BacklogItem[];
}

// ============================================================================
// BACKLOG
// ============================================================================

export type BacklogStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

export interface BacklogItem {
  id: string;
  title: string;
  description: string;
  priority: number; // 1 (highest) to 5 (lowest)
  approach: HypothesisApproach;
  affectedAreas: string[];
  acceptanceCriteria: string[];
  status: BacklogStatus;
  completedAt?: string | undefined;
  completedBranch?: string | undefined;
  failureReason?: string | undefined;
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

type ThreatType =
  | 'prompt_injection'
  | 'command_injection'
  | 'script_injection'
  | 'data_exfiltration'
  | 'size_limit'
  | 'encoding_suspicious'
  | 'semantic_threat';

interface ThreatReport {
  type: ThreatType;
  severity: Severity;
  pattern?: string | undefined;
  location?: number | undefined;
  confidence: number;
  description?: string | undefined;
}

interface SecurityScanResult {
  safe: boolean;
  content?: string | undefined;
  threats: ThreatReport[];
  analysisMs: number;
  source: string;
  timestamp: string;
}


interface ResearchFinding {
  source: string;
  title?: string | undefined;
  content: string;
  relevance: number;
}

// ============================================================================
// CODING INTERFACE
// ============================================================================

export type SymbolKind =
  | 'function'
  | 'class'
  | 'interface'
  | 'type'
  | 'const'
  | 'export'
  | 'method'
  | 'property';

interface RepoSymbol {
  name: string;
  kind: SymbolKind;
  signature: string;
  line: number;
  exported: boolean;
}

export interface FileMap {
  path: string;
  symbols: RepoSymbol[];
  references: string[];
  importance: number;
}

export interface RepoMap {
  files: FileMap[];
  totalTokens: number;
  generatedAt: string;
}

export interface RepoMapConfig {
  enabled: boolean;
  tokenBudget: number;
  tokenBudgetMax: number;
  languages: string[];
  includePatterns: string[];
  excludePatterns: string[];
  refreshOnChange: boolean;
}

export interface TokenBudget {
  total: number;
  system: number;
  repoMap: number;
  files: number;
  conversation: number;
  tools: number;
  response: number;
}

export interface SessionMemory {
  sessionId: string;
  startedAt: string;
  currentTask?: string | undefined;
  todos: Array<{ content: string; status: string }>;
  filesRead: string[];
  filesModified: string[];
  filesCreated: string[];
  decisions: SessionDecision[];
  learnings: string[];
}

interface SessionDecision {
  timestamp: string;
  context: string;
  decision: string;
  reasoning: string;
}

export interface EditRequest {
  path: string;
  search: string;
  replace: string;
  replaceAll?: boolean | undefined;
}

export interface EditResult {
  success: boolean;
  matchCount: number;
  preview?: string | undefined;
  error?: string | undefined;
}

interface EditValidationError {
  phase: 'parse' | 'lint' | 'typecheck' | 'test';
  file: string;
  line?: number | undefined;
  message: string;
  severity: 'error' | 'warning';
}

