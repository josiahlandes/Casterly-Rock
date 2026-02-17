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
export { AutonomousLoop, main } from './loop.js';

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
