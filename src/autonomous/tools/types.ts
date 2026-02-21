/**
 * Tool Registry Types
 *
 * Shared interfaces for the category-based tool system.
 * Each tool category is a self-contained module exporting schemas
 * and an executor factory.
 */

import type { ToolSchema, NativeToolCall, NativeToolResult } from '../../tools/schemas/types.js';
import type { GoalStack } from '../goal-stack.js';
import type { IssueLog } from '../issue-log.js';
import type { WorldModel } from '../world-model.js';
import type { ContextManager } from '../context-manager.js';
import type { Journal } from '../journal.js';
import type { LlmProvider } from '../../providers/base.js';
import type { PromptStore } from '../prompt-store.js';
import type { ShadowStore } from '../shadow-store.js';
import type { ToolSynthesizer } from '../../tools/synthesizer.js';
import type { ChallengeGenerator } from '../dream/challenge-generator.js';
import type { ChallengeEvaluator } from '../dream/challenge-evaluator.js';
import type { PromptEvolution } from '../dream/prompt-evolution.js';
import type { TrainingExtractor } from '../dream/training-extractor.js';
import type { LoraTrainer } from '../dream/lora-trainer.js';
import type { EventBus } from '../events.js';
import type { SelfModelSummary } from '../identity.js';
import type { JobStore } from '../../scheduler/store.js';
import type { ConcurrentProvider } from '../../providers/concurrent.js';
import type { DreamCycleRunner } from '../dream/runner.js';
import type { Reflector } from '../reflector.js';
import type { MessagePolicy } from '../communication/policy.js';
import type { MessageDelivery } from '../communication/delivery.js';
import type { CrystalStore } from '../crystal-store.js';
import type { ConstitutionStore } from '../constitution-store.js';
import type { TraceReplayStore } from '../trace-replay.js';
import type { EmbeddingProvider } from '../../providers/embedding.js';
import type { LinkNetwork } from '../memory/link-network.js';
import type { MemoryEvolution } from '../memory/memory-evolution.js';
import type { AudnConsolidator } from '../memory/audn-consolidator.js';
import type { EntropyMigrator } from '../memory/entropy-migrator.js';
import type { MemoryVersioning } from '../memory/memory-versioning.js';
import type { TemporalInvalidation } from '../memory/temporal-invalidation.js';
import type { MemoryChecker } from '../memory/checker.js';
import type { SkillFilesManager } from '../memory/skill-files.js';
import type { ConcurrentDreamExecutor } from '../memory/concurrent-dreams.js';
import type { GraphMemory } from '../memory/graph-memory.js';

// ─────────────────────────────────────────────────────────────────────────────
// Tool Executor Type
// ─────────────────────────────────────────────────────────────────────────────

export type ToolExecutorFn = (call: NativeToolCall) => Promise<NativeToolResult>;

// ─────────────────────────────────────────────────────────────────────────────
// Agent State
// ─────────────────────────────────────────────────────────────────────────────

/**
 * State references passed to the toolkit so tools can read/write
 * persistent state (goals, issues, world model).
 */
export interface AgentState {
  goalStack: GoalStack;
  issueLog: IssueLog;
  worldModel: WorldModel;
  /** Phase 4: Tiered memory context manager (optional for backwards compat) */
  contextManager?: ContextManager;
  /** Journal for narrative memory (Phase 1) */
  journal?: Journal;
  /** Vision Tier 2: Self-modifying prompt store */
  promptStore?: PromptStore;
  /** Vision Tier 2: Shadow execution store */
  shadowStore?: ShadowStore;
  /** Vision Tier 2: Tool synthesizer */
  toolSynthesizer?: ToolSynthesizer;
  /** Vision Tier 3: Challenge generator for adversarial self-testing */
  challengeGenerator?: ChallengeGenerator;
  /** Vision Tier 3: Challenge evaluator for tracking challenge history */
  challengeEvaluator?: ChallengeEvaluator;
  /** Vision Tier 3: Prompt evolution (genetic algorithm) */
  promptEvolution?: PromptEvolution;
  /** Vision Tier 3: Training data extractor for LoRA fine-tuning */
  trainingExtractor?: TrainingExtractor;
  /** Vision Tier 3: LoRA adapter trainer */
  loraTrainer?: LoraTrainer;

  // ── Roadmap Phase additions ──

  /** Phase 1: Event bus for queue introspection */
  eventBus?: EventBus;
  /** Phase 3: Self-model summary for assess_self tool */
  selfModelSummary?: SelfModelSummary;
  /** Phase 3: Cycle state for introspection (check_budget, review_steps) */
  cycleState?: CycleIntrospection;
  /** Phase 5: Job store for schedule tool */
  jobStore?: JobStore;
  /** Supporting: Concurrent provider for parallel_reason tool */
  concurrentProvider?: ConcurrentProvider;
  /** Supporting: Embedding provider for semantic_recall tool */
  embeddingProvider?: EmbeddingProvider;

  // ── Vision Tier 1: Self-Knowledge ──

  /** Vision Tier 1: Crystal store for memory crystallization */
  crystalStore?: CrystalStore;
  /** Vision Tier 1: Constitution store for operational rules */
  constitutionStore?: ConstitutionStore;
  /** Vision Tier 1: Trace replay store for self-debugging */
  traceReplayStore?: TraceReplayStore;

  // ── Reconciliation: Dream cycle phases as tools ──

  /** Dream cycle runner for phase-level tools */
  dreamCycleRunner?: DreamCycleRunner;
  /** Reflector for consolidation and retrospective phases */
  reflector?: Reflector;

  // ── Communication ──

  /** Message policy for throttling and filtering outbound messages */
  messagePolicy?: MessagePolicy;
  /** Message delivery backend (iMessage, console outbox) */
  messageDelivery?: MessageDelivery;

  // ── Advanced Memory (A-MEM) ──

  /** Zettelkasten bidirectional link network */
  linkNetwork?: LinkNetwork;
  /** Memory evolution engine (strengthen, weaken, merge, split, etc.) */
  memoryEvolution?: MemoryEvolution;
  /** AUDN consolidation cycle (Add/Update/Delete/Nothing) */
  audnConsolidator?: AudnConsolidator;
  /** Entropy-based tier migration (SAGE) */
  entropyMigrator?: EntropyMigrator;
  /** Git-backed memory versioning (Letta) */
  memoryVersioning?: MemoryVersioning;
  /** Temporal invalidation (Mem0) — TTL-based memory expiry */
  temporalInvalidation?: TemporalInvalidation;
  /** Memory checker (SAGE) — pre-storage validation guard */
  memoryChecker?: MemoryChecker;
  /** Skill files manager (Letta) — persistent procedural memory */
  skillFilesManager?: SkillFilesManager;
  /** Concurrent dream executor (Letta) — parallel dream phase execution */
  concurrentDreamExecutor?: ConcurrentDreamExecutor;
  /** Graph relational memory (Mem0) — entity-relationship knowledge graph */
  graphMemory?: GraphMemory;
}

/**
 * Live cycle state exposed to introspection tools.
 * The agent loop updates this each turn so tools can report
 * budget and step history.
 */
export interface CycleIntrospection {
  /** Cycle ID */
  cycleId: string;
  /** Turn number (1-indexed) */
  currentTurn: number;
  /** Max turns configured */
  maxTurns: number;
  /** Estimated tokens consumed so far */
  tokensUsed: number;
  /** Max tokens budget */
  maxTokens: number;
  /** Cycle start time (ISO) */
  startedAt: string;
  /** History of tool calls in this cycle */
  stepHistory: Array<{
    turn: number;
    tool: string;
    success: boolean;
    durationMs: number;
  }>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Toolkit Configuration
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Configuration for the agent toolkit.
 */
export interface AgentToolkitConfig {
  /** Root directory of the project (for running commands) */
  projectRoot: string;
  /** Maximum output size in characters for any single tool result */
  maxOutputChars: number;
  /** Timeout for shell commands in milliseconds */
  commandTimeoutMs: number;
  /** Directories allowed for file modifications */
  allowedDirectories: string[];
  /** Glob patterns that should never be modified */
  forbiddenPatterns: string[];
  /** Whether delegation to other models is enabled */
  delegationEnabled: boolean;
}

/**
 * The result of building the toolkit — ready to use in the agent loop.
 */
export interface AgentToolkit {
  /** All tool schemas (for sending to the LLM) */
  schemas: ToolSchema[];
  /** Execute a tool call by name */
  execute: (call: NativeToolCall) => Promise<NativeToolResult>;
  /** Get the list of available tool names */
  toolNames: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool Category Interface
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Context bundle passed to each category's executor builder.
 * Contains all the dependencies executors need to close over.
 */
export interface ExecutorContext {
  config: AgentToolkitConfig;
  state: AgentState;
  delegateProvider?: LlmProvider;
}

/**
 * A self-contained tool category: schemas + executor factory.
 *
 * Each category module exports one of these. The registry assembles
 * them into the full toolkit. Small models can load just the
 * categories they need.
 */
export interface ToolCategory {
  /** Human-readable category name (e.g. "core", "git", "vision-t1") */
  name: string;

  /** Tool schemas in this category (sent to the LLM) */
  schemas: ToolSchema[];

  /**
   * Build executors for this category.
   * Returns a map of tool name → executor function.
   */
  buildExecutors: (ctx: ExecutorContext) => Map<string, ToolExecutorFn>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Category Names (for dynamic loading / filtering)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * All recognized tool category names.
 * Used by the registry for filtering and the tool map for routing.
 */
export type CategoryName =
  | 'core'
  | 'quality'
  | 'git'
  | 'state'
  | 'reasoning'
  | 'memory'
  | 'communication'
  | 'introspection'
  | 'scheduling'
  | 'vision-t1'
  | 'vision-t2'
  | 'vision-t3'
  | 'dream'
  | 'advanced-memory';
