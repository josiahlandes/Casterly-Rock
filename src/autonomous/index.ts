/**
 * Autonomous Self-Improvement System
 *
 * Exports all components for the autonomous improvement loop,
 * persistent identity, and memory management.
 */

// Types
export * from './types.js';

// Provider abstraction
// @deprecated — Legacy 4-phase provider. Use LlmProvider from providers/base.js instead.
// Retained for test/script compatibility; will be removed in a future release.
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

// Controller (daemon-side management)
export { createAutonomousController } from './controller.js';
export type { AutonomousController } from './controller.js';

// Reports
export { formatDailyReport, formatMorningSummary } from './report.js';

// Status reports (iMessage dashboard)
export {
  formatStatusOverview,
  formatGoalsSummary,
  formatIssuesSummary,
  formatHealthReport,
  formatActivityReport,
  formatRelativeTime,
} from './status-report.js';

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

// ── Phase 1: Persistent Identity & Memory ──────────────────────────────────

// Debug and tracing
export { getTracer } from './debug.js';
export type {
  DebugSubsystem,
  DebugLevel,
  TraceSpan,
  DebugConfig,
  DebugListener,
} from './debug.js';

// World model
export { WorldModel } from './world-model.js';
export type {
  HealthSnapshot,
  Concern,
  ActivityEntry,
  WorldModelData,
  WorldModelConfig,
} from './world-model.js';

// Goal stack
export { GoalStack } from './goal-stack.js';
export type {
  Goal,
  GoalSource,
  GoalStatus,
  GoalStackData,
  GoalStackConfig,
  GoalStackSummary,
} from './goal-stack.js';

// Issue log
export { IssueLog } from './issue-log.js';
export type {
  Issue,
  IssueStatus,
  IssuePriority,
  IssueAttempt,
  IssueLogData,
  IssueLogConfig,
  IssueLogSummary,
} from './issue-log.js';

// Identity prompt
export { buildIdentityPrompt, buildMinimalIdentityPrompt } from './identity.js';
export type {
  IdentityConfig,
  SelfModelSummary,
  IdentityPromptResult,
} from './identity.js';

// Journal system
export { Journal, createJournal } from './journal.js';
export type { JournalEntry } from './journal.js';

// Trigger router
export {
  triggerFromMessage,
  triggerFromEvent,
  triggerFromSchedule,
  triggerFromGoal,
  getTriggerPriority,
} from './trigger-router.js';

// State inspector
export {
  takeStateSnapshot,
  computeStateDiff,
  inspectState,
  inspectJournal,
  formatStateDiff,
  runInspector,
} from '../debug/inspector.js';

// User model (from world-model)
export type { UserModel } from './world-model.js';

// Memory configuration
export {
  loadPhase1Config,
  memoryConfigSchema,
  identityConfigSchema,
  debugConfigSchema,
  phase1ConfigSchema,
} from './memory-config.js';
export type {
  MemoryConfig,
  IdentitySchemaConfig,
  DebugSchemaConfig,
  Phase1Config,
} from './memory-config.js';

// ── Phase 2: Agent Loop (ReAct) ─────────────────────────────────────────────

// Agent toolkit
export { buildAgentToolkit } from './agent-tools.js';
export type {
  AgentToolkit,
  AgentToolkitConfig,
  AgentTool,
  AgentState,
} from './agent-tools.js';

// Tool registry (category-based filtering + progressive hydration)
export {
  buildFilteredToolkit,
  buildPresetToolkit,
  hydrateCategories,
  buildCompactManifest,
  TOOL_MAP,
  getCategoryTools,
  TASK_CATEGORY_PRESETS,
} from './tools/registry.js';
export type { CategoryName, ToolCategory, ToolMapEntry } from './tools/index.js';

// Agent loop
export { AgentLoop, createAgentLoop } from './agent-loop.js';
export type {
  AgentTrigger,
  AgentEvent,
  AgentLoopConfig,
  AgentTurn,
  AgentOutcome,
  RuntimeContext,
} from './agent-loop.js';

// ── Phase 3: Event-Driven Awareness ──────────────────────────────────────────

// Event bus
export { EventBus } from './events.js';
export type {
  SystemEvent,
  EventHandler,
  EventBusConfig,
} from './events.js';

// Watchers
export { FileWatcher } from './watchers/index.js';
export type { FileWatcherConfig } from './watchers/index.js';

export { GitWatcher } from './watchers/index.js';
export type { GitWatcherConfig } from './watchers/index.js';

export { IssueWatcher } from './watchers/index.js';
export type { IssueWatcherConfig } from './watchers/index.js';

// ── Phase 4: Tiered Memory ──────────────────────────────────────────────────

// Loop detector
export { LoopDetector, createLoopDetector, buildLoopBreakPrompt } from './loop-detector.js';
export type { LoopDetectorConfig, LoopDetection, CognitiveAssessCallback } from './loop-detector.js';

// Context manager
export { ContextManager, createContextManager } from './context-manager.js';
export type {
  ContextManagerConfig,
  WarmEntry,
  TierUsage,
  WarmTierCompressCallback,
} from './context-manager.js';

// Context store
export { ContextStore } from './context-store.js';
export type {
  MemoryEntry as ContextMemoryEntry,
  RecallResult,
  ContextStoreConfig,
} from './context-store.js';

// ── Phase 5: Hardware Maximization ──────────────────────────────────────────

// Reasoning scaler
export { ReasoningScaler } from './reasoning/scaling.js';
export type {
  Difficulty,
  ReasoningScalerConfig,
  ProblemContext,
  ScaledSolution,
} from './reasoning/scaling.js';

// Adversarial tester
export { AdversarialTester } from './reasoning/adversarial.js';
export type {
  TestCase as AdversarialTestCase,
  AttackCategory,
  AttackResult,
  AdversarialReport,
  AdversarialTesterConfig,
} from './reasoning/adversarial.js';

// ── Phase 6: Dream Cycles ────────────────────────────────────────────────────

// Self-model
export { SelfModel } from './dream/self-model.js';
export type {
  SkillAssessment,
  SelfModelData,
  SelfModelConfig,
} from './dream/self-model.js';

// Code archaeology
export { CodeArchaeologist } from './dream/archaeology.js';
export type {
  FileHistory,
  FragileFile,
  ArchaeologyConfig,
} from './dream/archaeology.js';

// Dream cycle runner
export { DreamCycleRunner } from './dream/runner.js';
export type {
  DreamCycleConfig,
  DreamOutcome,
} from './dream/runner.js';

// ── Vision Tier 1: Self-Knowledge ─────────────────────────────────────────────

// Crystal store (memory crystallization)
export { CrystalStore, createCrystalStore } from './crystal-store.js';
export type {
  Crystal,
  CrystalStoreConfig,
  CrystalResult,
} from './crystal-store.js';

// Constitution store (self-governance)
export { ConstitutionStore, createConstitutionStore } from './constitution-store.js';
export type {
  ConstitutionalRule,
  ConstitutionStoreConfig,
  RuleResult,
} from './constitution-store.js';

// Trace replay (self-debugging)
export { TraceReplayStore, createTraceReplayStore } from './trace-replay.js';
export type {
  TraceStep,
  ExecutionTrace,
  TraceIndexEntry,
  TraceReplayConfig,
  TraceComparison,
} from './trace-replay.js';

// ── Vision Tier 2: Self-Improvement ──────────────────────────────────────────

// Prompt store (self-modifying prompts)
export { PromptStore } from './prompt-store.js';
export type {
  PromptVersion,
  VersionMetrics,
  EditResult,
  PromptStoreConfig,
} from './prompt-store.js';

// Shadow store (shadow execution)
export { ShadowStore } from './shadow-store.js';
export type {
  Shadow,
  JudgmentPattern,
  ShadowAnalysis,
  ShadowStoreConfig,
} from './shadow-store.js';

// Tool synthesizer (re-exported from tools)
export { ToolSynthesizer } from '../tools/synthesizer.js';
export type {
  SynthesizedTool,
  ToolImplementation,
  CreateToolResult,
  ToolSynthesizerConfig,
} from '../tools/synthesizer.js';

// ── Vision Tier 3: Advanced Self-Improvement ─────────────────────────────────

// Challenge generator (adversarial dual-model self-testing)
export { ChallengeGenerator } from './dream/challenge-generator.js';
export type {
  Challenge,
  ChallengeType,
  ChallengeResult,
  ChallengeBatch,
  ChallengeBatchSummary,
  ChallengeGeneratorConfig,
} from './dream/challenge-generator.js';

// Challenge evaluator (sub-skill tracking)
export { ChallengeEvaluator } from './dream/challenge-evaluator.js';
export type {
  SubSkillAssessment,
  EvaluationHistory,
  EvaluationRecord,
  ChallengeEvaluatorConfig,
} from './dream/challenge-evaluator.js';

// Prompt evolution (genetic algorithm)
export { PromptEvolution } from './dream/prompt-evolution.js';
export type {
  PromptVariant,
  FitnessMetrics,
  EvolutionMetadata,
  MutationType,
  PromptEvolutionConfig,
} from './dream/prompt-evolution.js';

// Training extractor (LoRA data extraction)
export { TrainingExtractor } from './dream/training-extractor.js';
export type {
  TrainingExample,
  PreferencePair,
  TrainingDataset,
  TrainingExtractorConfig,
} from './dream/training-extractor.js';

// LoRA trainer (adapter management)
export { LoraTrainer } from './dream/lora-trainer.js';
export type {
  LoraAdapter,
  LoraTrainingParams,
  AdapterRegistry,
  BenchmarkTask,
  AdapterEvaluation,
  LoraTrainerConfig,
} from './dream/lora-trainer.js';

// ── Phase 7: Communication ───────────────────────────────────────────────────

// Message policy
export type {
  NotifiableEvent,
  DailySummaryStats,
  ThrottleConfig,
  MessagePolicyConfig,
  PolicyDecision,
} from './communication/policy.js';
