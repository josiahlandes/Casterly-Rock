/**
 * Autonomous Self-Improvement System
 *
 * Exports all components for the autonomous improvement loop,
 * persistent identity, and memory management.
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

// ── Phase 1: Persistent Identity & Memory ──────────────────────────────────

// Debug and tracing
export { DebugTracer, getTracer, initTracer, resetTracer } from './debug.js';
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

// Agent loop
export { AgentLoop, createAgentLoop } from './agent-loop.js';
export type {
  AgentTrigger,
  AgentEvent,
  AgentLoopConfig,
  AgentTurn,
  AgentOutcome,
} from './agent-loop.js';

// ── Phase 3: Event-Driven Awareness ──────────────────────────────────────────

// Event bus
export { EventBus, getEventPriority, compareEventPriority } from './events.js';
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

// Context manager
export { ContextManager, createContextManager } from './context-manager.js';
export type {
  ContextManagerConfig,
  WarmEntry,
  TierUsage,
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
export { ReasoningScaler, createReasoningScaler } from './reasoning/scaling.js';
export type {
  Difficulty,
  ReasoningScalerConfig,
  ProblemContext,
  ScaledSolution,
} from './reasoning/scaling.js';

// Adversarial tester
export { AdversarialTester, createAdversarialTester } from './reasoning/adversarial.js';
export type {
  TestCase as AdversarialTestCase,
  AttackCategory,
  AttackResult,
  AdversarialReport,
  AdversarialTesterConfig,
} from './reasoning/adversarial.js';

// ── Phase 6: Dream Cycles ────────────────────────────────────────────────────

// Self-model
export { SelfModel, createSelfModel } from './dream/self-model.js';
export type {
  SkillAssessment,
  SelfModelData,
  SelfModelConfig,
} from './dream/self-model.js';

// Code archaeology
export { CodeArchaeologist, createCodeArchaeologist } from './dream/archaeology.js';
export type {
  FileHistory,
  FragileFile,
  ArchaeologyConfig,
} from './dream/archaeology.js';

// Dream cycle runner
export { DreamCycleRunner, createDreamCycleRunner } from './dream/runner.js';
export type {
  DreamCycleConfig,
  DreamOutcome,
} from './dream/runner.js';

// ── Phase 7: Communication ───────────────────────────────────────────────────

// Message policy
export { MessagePolicy, createMessagePolicy } from './communication/policy.js';
export type {
  NotifiableEvent,
  DailySummaryStats,
  ThrottleConfig,
  MessagePolicyConfig,
  PolicyDecision,
} from './communication/policy.js';
