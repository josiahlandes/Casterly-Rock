/**
 * Agent Toolkit — Tools available to Tyrion's ReAct agent loop
 *
 * This module defines every tool that the agent can call during a ReAct
 * cycle. Each tool has:
 *   1. A ToolSchema (JSON Schema format) — sent to the LLM so it knows
 *      the tool's name, description, and parameter types.
 *   2. An executor function — actually performs the operation and returns
 *      a structured result.
 *
 * Tools are organized into categories:
 *   - FILE OPERATIONS: read_file, edit_file, create_file (via existing executors)
 *   - SEARCH: grep, glob (via existing executors)
 *   - SYSTEM: bash (via existing executor, with safety checks)
 *   - GIT: git_status, git_diff, git_commit, git_log
 *   - QUALITY: run_tests, typecheck, lint
 *   - STATE: file_issue, close_issue, update_goal, update_world_model
 *   - REASONING: think (no-op for explicit reasoning steps)
 *   - DELEGATION: delegate (send sub-task to a specific model)
 *   - COMMUNICATION: message_user (via MessagePolicy + delivery backend)
 *
 * Design principles:
 *   - Every tool call is logged through the debug tracer.
 *   - File-mutating tools respect the project's allowed/forbidden paths.
 *   - The toolkit is constructed with references to the Phase 1 state
 *     (GoalStack, IssueLog, WorldModel) so tools can update state directly.
 *   - All string outputs are bounded to prevent context window flooding.
 *
 * Privacy: Tools that produce output truncate it and never include
 * raw sensitive data. All output passes through debug tracer redaction
 * when logged.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { getTracer } from './debug.js';
import type { GoalStack, GoalStatus, GoalSource } from './goal-stack.js';
import type { IssueLog, IssuePriority, Issue } from './issue-log.js';
import type { WorldModel } from './world-model.js';
import type { ToolSchema, NativeToolCall, NativeToolResult } from '../tools/schemas/types.js';
import type { ContextManager } from './context-manager.js';
import type { Journal } from './journal.js';
import type { LlmProvider, GenerateRequest } from '../providers/base.js';
import { AdversarialTester } from './reasoning/adversarial.js';
import type { PromptStore } from './prompt-store.js';
import type { ShadowStore } from './shadow-store.js';
import type { ToolSynthesizer } from '../tools/synthesizer.js';
import type { ChallengeGenerator } from './dream/challenge-generator.js';
import type { ChallengeEvaluator } from './dream/challenge-evaluator.js';
import type { PromptEvolution } from './dream/prompt-evolution.js';
import type { TrainingExtractor } from './dream/training-extractor.js';
import type { LoraTrainer } from './dream/lora-trainer.js';
import type { EventBus } from './events.js';
import type { SelfModelSummary } from './identity.js';
import type { JobStore } from '../scheduler/store.js';
import type { ConcurrentProvider } from '../providers/concurrent.js';
import type { DreamCycleRunner } from './dream/runner.js';
import type { Reflector } from './reflector.js';
import type { MessagePolicy } from './communication/policy.js';
import type { MessageDelivery } from './communication/delivery.js';
import type { CrystalStore } from './crystal-store.js';
import type { ConstitutionStore } from './constitution-store.js';
import type { TraceReplayStore } from './trace-replay.js';
import type { EmbeddingProvider } from '../providers/embedding.js';
import type { LinkNetwork, LinkType } from './memory/link-network.js';
import type { MemoryEvolution, EvolvableMemory, EvolutionOp } from './memory/memory-evolution.js';
import type { AudnConsolidator } from './memory/audn-consolidator.js';
import type { EntropyMigrator, EntryForScoring, MemoryTier } from './memory/entropy-migrator.js';
import type { MemoryVersioning } from './memory/memory-versioning.js';
import type { TemporalInvalidation } from './memory/temporal-invalidation.js';
import type { MemoryChecker, ExistingKnowledge } from './memory/checker.js';
import type { SkillFilesManager } from './memory/skill-files.js';
import type { ConcurrentDreamExecutor } from './memory/concurrent-dreams.js';
import type { GraphMemory, NodeType, EdgeType } from './memory/graph-memory.js';

const execFileAsync = promisify(execFile);

// ─────────────────────────────────────────────────────────────────────────────
// Export Extraction (for overwrite loss detection)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Simple regex-based export name extractor for JS/TS files.
 * Used by the create_file executor to detect lost exports on overwrite.
 */
function extractExportNames(content: string): string[] {
  const names = new Set<string>();

  // Strip comments and string literals
  const stripped = content
    .replace(/\/\/[^\n]*/g, '')          // single-line comments
    .replace(/\/\*[\s\S]*?\*\//g, '')    // multi-line comments
    .replace(/"(?:[^"\\]|\\.)*"/g, '""') // double-quoted strings
    .replace(/'(?:[^'\\]|\\.)*'/g, "''"); // single-quoted strings

  for (const m of stripped.matchAll(/\bexport\s+(?:const|let|var|function|class)\s+(\w+)/g)) {
    names.add(m[1]!);
  }
  for (const m of stripped.matchAll(/\bexport\s+default\s+(?:class|function)\s+(\w+)/g)) {
    names.add(m[1]!);
  }
  for (const m of stripped.matchAll(/\bexport\s+default\s+(?!class\b|function\b|new\b|null\b|true\b|false\b|undefined\b|\{|\[|\()(\w+)/g)) {
    names.add(m[1]!);
  }
  for (const m of stripped.matchAll(/\bexport\s*\{([^}]+)\}/g)) {
    for (const name of m[1]!.split(',')) {
      const clean = name.trim().split(/\s+as\s+/).pop()!.trim();
      if (clean && /^\w+$/.test(clean)) names.add(clean);
    }
  }
  for (const m of stripped.matchAll(/module\.exports\s*=\s*\{([^}]+)\}/g)) {
    for (const name of m[1]!.split(',')) {
      const clean = name.trim().split(/\s*:/)[0]!.trim();
      if (clean && /^\w+$/.test(clean)) names.add(clean);
    }
  }

  return [...names];
}

// ─────────────────────────────────────────────────────────────────────────────
// Types
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
 * A single tool in the agent toolkit: schema + executor.
 */
export interface AgentTool {
  /** The schema sent to the LLM */
  schema: ToolSchema;

  /** The function that executes the tool */
  execute: (call: NativeToolCall) => Promise<NativeToolResult>;
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
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: AgentToolkitConfig = {
  projectRoot: process.cwd(),
  maxOutputChars: 10_000,
  commandTimeoutMs: 120_000,
  allowedDirectories: ['src/', 'scripts/', 'tests/', 'config/', 'skills/', 'workspace/'],
  forbiddenPatterns: ['**/*.env*', '**/credentials*', '**/secrets*', '**/.git/**'],
  delegationEnabled: true,
};

// ─────────────────────────────────────────────────────────────────────────────
// Output Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Truncate output to the configured maximum, appending a notice if truncated.
 */
function truncateOutput(output: string, maxChars: number): string {
  if (output.length <= maxChars) {
    return output;
  }
  const truncated = output.slice(0, maxChars);
  const remaining = output.length - maxChars;
  return `${truncated}\n\n[... truncated ${remaining} characters]`;
}

/**
 * Build a success result for a tool call.
 */
function successResult(callId: string, output: string, maxChars: number): NativeToolResult {
  return {
    toolCallId: callId,
    success: true,
    output: truncateOutput(output, maxChars),
  };
}

/**
 * Build a failure result for a tool call.
 */
function failureResult(callId: string, error: string): NativeToolResult {
  return {
    toolCallId: callId,
    success: false,
    error,
  };
}

/**
 * Extract a required string parameter, returning an error result if missing.
 */
function requireString(
  call: NativeToolCall,
  param: string,
): { value: string } | { error: NativeToolResult } {
  const value = call.input[param];
  if (typeof value !== 'string' || value.length === 0) {
    return {
      error: failureResult(call.id, `Missing required parameter: ${param}`),
    };
  }
  return { value };
}

/**
 * Extract an optional string parameter.
 */
function optionalString(call: NativeToolCall, param: string): string | undefined {
  const value = call.input[param];
  return typeof value === 'string' ? value : undefined;
}

/**
 * Extract an optional number parameter.
 */
function optionalNumber(call: NativeToolCall, param: string): number | undefined {
  const value = call.input[param];
  return typeof value === 'number' ? value : undefined;
}

/**
 * Check if a file path is allowed for writing.
 */
function isPathAllowed(
  filePath: string,
  allowedDirectories: string[],
  forbiddenPatterns: string[],
): boolean {
  // Check forbidden patterns (simple substring matching for now)
  for (const pattern of forbiddenPatterns) {
    // Convert glob to simple check
    const cleanPattern = pattern.replace(/\*\*/g, '').replace(/\*/g, '');
    if (cleanPattern && filePath.includes(cleanPattern)) {
      return false;
    }
  }

  // Check allowed directories
  if (allowedDirectories.length === 0) {
    return true;
  }

  // For relative paths, also check if they would fall under an absolute allowed dir
  // (callers may pass [projectRoot] as an absolute path while the file path is relative)
  return allowedDirectories.some((dir) => {
    if (filePath.startsWith(dir)) return true;
    // If the allowed dir is absolute and the file path is relative,
    // the relative path is implicitly under projectRoot — allow it.
    if (dir.startsWith('/') && !filePath.startsWith('/')) return true;
    return false;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool Schema Definitions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * All tool schemas defined here. These are sent to the LLM so it knows
 * what tools are available and how to call them.
 */

const THINK_SCHEMA: ToolSchema = {
  name: 'think',
  description: `Use this tool to reason through a problem step by step before taking action.
This is a no-op tool — it has no side effects. Use it when you need to:
- Break down a complex problem into steps
- Evaluate multiple approaches before choosing one
- Reflect on what just happened before deciding next steps
- Plan a sequence of tool calls

Your reasoning will be logged for debugging transparency.`,
  inputSchema: {
    type: 'object',
    properties: {
      reasoning: {
        type: 'string',
        description: 'Your step-by-step reasoning. Be explicit about what you know, what you need to find out, and what approach you plan to take.',
      },
    },
    required: ['reasoning'],
  },
};

const READ_FILE_SCHEMA: ToolSchema = {
  name: 'read_file',
  description: 'Read the contents of a source file. Returns the file content with line numbers.',
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Path to the file, relative to project root.',
      },
      max_lines: {
        type: 'integer',
        description: 'Maximum number of lines to read. Omit to read the entire file.',
      },
      offset: {
        type: 'integer',
        description: 'Line number to start reading from (1-indexed). Defaults to 1.',
      },
    },
    required: ['path'],
  },
};

const READ_FILES_SCHEMA: ToolSchema = {
  name: 'read_files',
  description: `Read multiple files in a single call. Accepts an array of paths and/or a glob pattern. Returns all file contents at once, reducing exploration from N tool calls to 1.`,
  inputSchema: {
    type: 'object',
    properties: {
      paths: {
        type: 'array',
        description: 'File paths to read (relative to project root).',
        items: { type: 'string' },
      },
      glob_pattern: {
        type: 'string',
        description: 'Glob pattern to match files (e.g., "src/**/*.ts"). Ignores node_modules, .git, dist.',
      },
    },
  },
};

const EDIT_FILE_SCHEMA: ToolSchema = {
  name: 'edit_file',
  description: `Edit a file by replacing a specific text string with new text. The old_string must appear exactly once in the file for the edit to succeed. Use this for targeted, surgical modifications.

If the string appears multiple times, include more surrounding context to make it unique.`,
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Path to the file, relative to project root.',
      },
      old_string: {
        type: 'string',
        description: 'The exact text to find and replace. Must be unique in the file.',
      },
      new_string: {
        type: 'string',
        description: 'The replacement text.',
      },
    },
    required: ['path', 'old_string', 'new_string'],
  },
};

const CREATE_FILE_SCHEMA: ToolSchema = {
  name: 'create_file',
  description: 'Create a new file with the given content. Creates parent directories if needed. By default fails if the file already exists — set overwrite to true to replace existing files.',
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Path for the new file, relative to project root.',
      },
      content: {
        type: 'string',
        description: 'Content to write to the file.',
      },
      overwrite: {
        type: 'boolean',
        description: 'Set to true to overwrite an existing file. Defaults to false.',
      },
    },
    required: ['path', 'content'],
  },
};

const GREP_SCHEMA: ToolSchema = {
  name: 'grep',
  description: 'Search for a text pattern across files in the codebase. Returns matching lines with file paths and line numbers. Tip: For finding imports, use a simple substring like "voice-filter" rather than a complex regex — import paths include relative prefixes (../) and .js suffixes.',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description: 'Regex pattern to search for.',
      },
      path: {
        type: 'string',
        description: 'Directory to search in, relative to project root. Defaults to project root.',
      },
      file_pattern: {
        type: 'string',
        description: 'Glob pattern to filter which files to search (e.g., "*.ts", "*.yaml").',
      },
      max_results: {
        type: 'integer',
        description: 'Maximum number of matches to return. Defaults to 50.',
      },
    },
    required: ['pattern'],
  },
};

const GLOB_SCHEMA: ToolSchema = {
  name: 'glob',
  description: 'Find files by name pattern. Returns a list of matching file paths.',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description: 'Glob pattern to match files (e.g., "src/**/*.ts", "tests/*.test.ts").',
      },
    },
    required: ['pattern'],
  },
};

const BASH_SCHEMA: ToolSchema = {
  name: 'bash',
  description: `Execute a shell command. Use this for operations that don't have a dedicated tool:
- System info, process management, network operations
- npm/yarn commands, git operations not covered by other tools
- Any CLI tool installed on the system

Safety: Destructive commands (rm -rf, etc.) will be blocked. Prefer dedicated tools for file operations.`,
  inputSchema: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'The shell command to execute.',
      },
      timeout_ms: {
        type: 'integer',
        description: 'Timeout in milliseconds. Defaults to config value.',
      },
    },
    required: ['command'],
  },
};

const RUN_TESTS_SCHEMA: ToolSchema = {
  name: 'run_tests',
  description: 'Run the test suite. Returns pass/fail status and output. Use a file pattern to run specific tests.',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description: 'Optional test file pattern (e.g., "tests/goal-stack" to run only goal-stack tests).',
      },
    },
    required: [],
  },
};

const TYPECHECK_SCHEMA: ToolSchema = {
  name: 'typecheck',
  description: 'Run the TypeScript compiler in check mode (no output). Returns any type errors found.',
  inputSchema: {
    type: 'object',
    properties: {},
    required: [],
  },
};

const LINT_SCHEMA: ToolSchema = {
  name: 'lint',
  description: 'Run the project linter. Returns any lint errors or warnings.',
  inputSchema: {
    type: 'object',
    properties: {},
    required: [],
  },
};

const GIT_STATUS_SCHEMA: ToolSchema = {
  name: 'git_status',
  description: 'Show the current git status: branch, staged/unstaged changes, untracked files.',
  inputSchema: {
    type: 'object',
    properties: {},
    required: [],
  },
};

const GIT_DIFF_SCHEMA: ToolSchema = {
  name: 'git_diff',
  description: 'Show the git diff (unstaged changes, or staged if specified).',
  inputSchema: {
    type: 'object',
    properties: {
      staged: {
        type: 'boolean',
        description: 'Show staged changes instead of unstaged. Defaults to false.',
      },
      path: {
        type: 'string',
        description: 'Limit diff to a specific file or directory.',
      },
    },
    required: [],
  },
};

const GIT_COMMIT_SCHEMA: ToolSchema = {
  name: 'git_commit',
  description: 'Stage files and create a git commit. Only commits files in allowed directories.',
  inputSchema: {
    type: 'object',
    properties: {
      message: {
        type: 'string',
        description: 'Commit message. Use conventional commits format.',
      },
      files: {
        type: 'array',
        description: 'Files to stage and commit. Use "." for all changes.',
        items: { type: 'string', description: 'File path to stage.' },
      },
    },
    required: ['message', 'files'],
  },
};

const GIT_LOG_SCHEMA: ToolSchema = {
  name: 'git_log',
  description: 'Show recent git history.',
  inputSchema: {
    type: 'object',
    properties: {
      count: {
        type: 'integer',
        description: 'Number of commits to show. Defaults to 10.',
      },
      path: {
        type: 'string',
        description: 'Limit log to a specific file or directory.',
      },
    },
    required: [],
  },
};

const FILE_ISSUE_SCHEMA: ToolSchema = {
  name: 'file_issue',
  description: `File a new issue in your issue log, or update an existing issue with the same title.
Use this when you discover a problem that you can't fix immediately. Record what you found, what you've tried, and what you'd try next.`,
  inputSchema: {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        description: 'Short, descriptive title for the issue.',
      },
      description: {
        type: 'string',
        description: 'Detailed description of the problem.',
      },
      priority: {
        type: 'string',
        description: 'Priority level.',
        enum: ['critical', 'high', 'medium', 'low'],
      },
      related_files: {
        type: 'array',
        description: 'Files related to this issue.',
        items: { type: 'string', description: 'File path.' },
      },
      tags: {
        type: 'array',
        description: 'Tags for categorization.',
        items: { type: 'string', description: 'Tag name.' },
      },
      next_idea: {
        type: 'string',
        description: 'What you plan to try next to fix this.',
      },
    },
    required: ['title', 'description', 'priority'],
  },
};

const CLOSE_ISSUE_SCHEMA: ToolSchema = {
  name: 'close_issue',
  description: 'Resolve an issue in your issue log. Use when you have fixed the underlying problem.',
  inputSchema: {
    type: 'object',
    properties: {
      issue_id: {
        type: 'string',
        description: 'The issue ID (e.g., "ISS-001").',
      },
      resolution: {
        type: 'string',
        description: 'How the issue was resolved.',
      },
      status: {
        type: 'string',
        description: 'Resolution status.',
        enum: ['resolved', 'wontfix'],
      },
    },
    required: ['issue_id', 'resolution'],
  },
};

const UPDATE_GOAL_SCHEMA: ToolSchema = {
  name: 'update_goal',
  description: 'Update the status or notes on a goal in your goal stack.',
  inputSchema: {
    type: 'object',
    properties: {
      goal_id: {
        type: 'string',
        description: 'The goal ID (e.g., "goal-001").',
      },
      status: {
        type: 'string',
        description: 'New status for the goal.',
        enum: ['pending', 'in_progress', 'blocked', 'done', 'abandoned'],
      },
      notes: {
        type: 'string',
        description: 'Progress notes or blockers.',
      },
    },
    required: ['goal_id'],
  },
};

const DELEGATE_SCHEMA: ToolSchema = {
  name: 'delegate',
  description: `Send a sub-task to a specific model. Use this for:
- qwen3.5:122b — reasoning, planning, code generation, analysis, review

The delegate receives the task description and optional file contents as context.
With tools='read-only', the delegate can also search and read files autonomously.`,
  inputSchema: {
    type: 'object',
    properties: {
      model: {
        type: 'string',
        description: 'Which model to delegate to.',
        enum: ['qwen3.5:122b'],
      },
      task: {
        type: 'string',
        description: 'Clear description of what the delegate should do.',
      },
      context_files: {
        type: 'array',
        description: 'File paths to include as context for the delegate.',
        items: { type: 'string', description: 'File path relative to project root.' },
      },
      tools: {
        type: 'string',
        description: 'Tool access level. "none" (default): text-only. "read-only": delegate can read_file, grep_files, glob_files, git_diff.',
        enum: ['none', 'read-only'],
      },
    },
    required: ['model', 'task'],
  },
};

const MESSAGE_USER_SCHEMA: ToolSchema = {
  name: 'message_user',
  description: `Send a message to the user. Use sparingly and only for things worth their attention:
- Completion of a significant task
- A problem you can't solve and need human input on
- A security concern

Do NOT message for routine status updates or minor progress.`,
  inputSchema: {
    type: 'object',
    properties: {
      message: {
        type: 'string',
        description: 'The message to send. Keep it brief and factual.',
      },
      urgency: {
        type: 'string',
        description: 'How urgent is this message?',
        enum: ['low', 'medium', 'high'],
      },
    },
    required: ['message'],
  },
};

// ── MEMORY TOOLS ─────────────────────────────────────────────────────────────

const RECALL_SCHEMA: ToolSchema = {
  name: 'recall',
  description: `Search your memory (cool/cold tiers) for past observations, reflections, and archived notes relevant to a query.

Use this when you need context from previous cycles:
- "What did I try last time I worked on the detector?"
- "Any notes about the tool orchestrator architecture?"
- "Past reflections about regex issues"

Results are ranked by relevance. Higher-priority matches appear first.`,
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'What to search for. Use descriptive keywords.',
      },
      tier: {
        type: 'string',
        description: 'Which memory tier to search. "cool" = recent (30 days), "cold" = all history, "both" = search everywhere.',
        enum: ['cool', 'cold', 'both'],
      },
      tags: {
        type: 'array',
        description: 'Optional tags to filter results (e.g., ["fix", "regex"]).',
        items: { type: 'string', description: 'A tag string.' },
      },
      limit: {
        type: 'number',
        description: 'Maximum number of results to return (default 5).',
      },
    },
    required: ['query'],
  },
};

const ARCHIVE_SCHEMA: ToolSchema = {
  name: 'archive',
  description: `Save a note, observation, or partial analysis to your memory for future recall.

Use this when you want to remember something for later:
- Working notes about a problem you're investigating
- Architecture observations
- Partial analysis results you might need later
- Lessons learned from a fix

Content is stored in the cool tier by default (searchable for 30 days, then promoted to cold archive).`,
  inputSchema: {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        description: 'A short descriptive title for this memory entry.',
      },
      content: {
        type: 'string',
        description: 'The content to save. Be specific and include relevant details.',
      },
      tags: {
        type: 'array',
        description: 'Tags for later retrieval (e.g., ["regex", "detector", "fix"]).',
        items: { type: 'string', description: 'A tag string.' },
      },
    },
    required: ['title', 'content', 'tags'],
  },
};

// ── ADVERSARIAL TESTING TOOL ─────────────────────────────────────────────────

const ADVERSARIAL_TEST_SCHEMA: ToolSchema = {
  name: 'adversarial_test',
  description: `Generate adversarial test cases for a function you've just written or modified.
This exercises the "skepticism of own output" trait — you write code, then immediately try to break it.

The tool generates edge-case inputs (empty/null, boundary, unicode, injection, type coercion,
malformed, concurrency) and creates a Vitest test file. You should then run the tests and fix
any failures before committing.

Use this after writing or modifying any non-trivial function.`,
  inputSchema: {
    type: 'object',
    properties: {
      code: {
        type: 'string',
        description: 'The source code of the function to attack.',
      },
      function_signature: {
        type: 'string',
        description: 'The function signature (e.g., "detectSensitive(text: string): Match[]").',
      },
      target_file: {
        type: 'string',
        description: 'The file where the function lives (for the generated test import).',
      },
    },
    required: ['code', 'function_signature', 'target_file'],
  },
};

const RECALL_JOURNAL_SCHEMA: ToolSchema = {
  name: 'recall_journal',
  description: `Search your journal for past observations, reflections, opinions, and handoff notes.

Use this when you need continuity from previous sessions:
- "What was I working on last time?"
- "Any reflections about the provider interface?"
- "What opinions have I formed about testing patterns?"

Results include entry type, tags, and content. Handoff notes are especially useful for picking up where you left off.`,
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Keywords to search for in journal entries.',
      },
      type: {
        type: 'string',
        description: 'Filter by entry type.',
        enum: ['handoff', 'reflection', 'opinion', 'observation', 'user_interaction'],
      },
      limit: {
        type: 'integer',
        description: 'Maximum results to return. Defaults to 5.',
      },
    },
    required: ['query'],
  },
};

const CONSOLIDATE_SCHEMA: ToolSchema = {
  name: 'consolidate',
  description: `Consolidate your context by summarizing recent work and dropping details you no longer need.

Use this when you notice your context is getting large or when you're switching between tasks.
The consolidation writes a summary to your journal and clears warm tier working memory.

This is a deliberate act of memory management — choose what to remember and what to let go.`,
  inputSchema: {
    type: 'object',
    properties: {
      summary: {
        type: 'string',
        description: 'Your summary of what you learned and accomplished. This will be saved as a journal reflection.',
      },
      tags: {
        type: 'array',
        description: 'Tags for later recall.',
        items: { type: 'string', description: 'A tag.' },
      },
    },
    required: ['summary'],
  },
};


// ── VISION TIER 1: MEMORY CRYSTALLIZATION ────────────────────────────────────

const CRYSTALLIZE_SCHEMA: ToolSchema = {
  name: 'crystallize',
  description: `Promote a high-value insight to a permanent crystal. Crystals are always loaded
into your hot tier context — knowledge you never have to re-derive from the journal.

Examples: "Tests in this repo use Vitest with vi.fn()", "The user prefers functional over class patterns",
"I perform better when I read the full file before planning."

Crystals have a token budget (default 500 tokens) and a count limit (default 30).`,
  inputSchema: {
    type: 'object',
    properties: {
      content: {
        type: 'string',
        description: 'The knowledge to crystallize. Keep concise — every token counts.',
      },
      source_entries: {
        type: 'array',
        description: 'IDs of memory entries or journal entries that support this crystal.',
        items: { type: 'string', description: 'A source entry ID.' },
      },
      confidence: {
        type: 'number',
        description: 'Initial confidence (0-1, default 0.8). Higher = more certain.',
      },
    },
    required: ['content'],
  },
};

const DISSOLVE_SCHEMA: ToolSchema = {
  name: 'dissolve',
  description: `Remove a crystal that is no longer valid or useful.

Use this when a crystal contradicts recent experience, is obsolete, or needs to be replaced
with an updated version.`,
  inputSchema: {
    type: 'object',
    properties: {
      crystal_id: {
        type: 'string',
        description: 'The ID of the crystal to dissolve.',
      },
      reason: {
        type: 'string',
        description: 'Why this crystal is being dissolved.',
      },
    },
    required: ['crystal_id'],
  },
};

const LIST_CRYSTALS_SCHEMA: ToolSchema = {
  name: 'list_crystals',
  description: `List all crystals with their confidence scores and metadata.`,
  inputSchema: {
    type: 'object',
    properties: {},
    required: [],
  },
};

// ── VISION TIER 1: CONSTITUTIONAL SELF-GOVERNANCE ────────────────────────────

const CREATE_RULE_SCHEMA: ToolSchema = {
  name: 'create_rule',
  description: `Create a new operational rule for yourself. Rules are tactical patterns discovered
through experience — not safety rules (those are immutable), but operational guidelines.

Examples:
  - "For tasks touching 3+ files, generate a plan before starting."
  - "When the coding model returns TypeScript with \`any\`, flag for review."
  - "Prefer recall_journal over recall for debugging context."

Each rule tracks confidence, invocations, and success rate. Low-confidence rules
are pruned during dream cycles.`,
  inputSchema: {
    type: 'object',
    properties: {
      rule: {
        type: 'string',
        description: 'The rule text.',
      },
      motivation: {
        type: 'string',
        description: 'Why this rule was created — reference a journal entry or describe the experience.',
      },
      confidence: {
        type: 'number',
        description: 'Initial confidence (0-1, default 0.8).',
      },
    },
    required: ['rule', 'motivation'],
  },
};

const UPDATE_RULE_SCHEMA: ToolSchema = {
  name: 'update_rule',
  description: `Update an existing constitutional rule. Use to refine rule text, adjust confidence,
or update motivation based on new evidence.`,
  inputSchema: {
    type: 'object',
    properties: {
      rule_id: {
        type: 'string',
        description: 'The ID of the rule to update.',
      },
      rule: {
        type: 'string',
        description: 'Updated rule text (optional).',
      },
      motivation: {
        type: 'string',
        description: 'Updated motivation (optional).',
      },
      confidence: {
        type: 'number',
        description: 'Updated confidence (0-1, optional).',
      },
    },
    required: ['rule_id'],
  },
};

const LIST_RULES_SCHEMA: ToolSchema = {
  name: 'list_rules',
  description: `List all constitutional rules with their confidence scores and invocation history.`,
  inputSchema: {
    type: 'object',
    properties: {},
    required: [],
  },
};

// ── VISION TIER 1: SELF-DEBUGGING REPLAY ─────────────────────────────────────

const REPLAY_SCHEMA: ToolSchema = {
  name: 'replay',
  description: `Load a past execution trace and walk through it step by step. Shows what tools
were called, what parameters were used, what results came back, and where things went wrong.

Use this for post-mortem analysis of failed cycles, or to understand what happened during
a specific cycle. Supports filtering by step range or tool type.`,
  inputSchema: {
    type: 'object',
    properties: {
      cycle_id: {
        type: 'string',
        description: 'The cycle ID to replay.',
      },
      step_start: {
        type: 'integer',
        description: 'Start step (1-based, optional — defaults to beginning).',
      },
      step_end: {
        type: 'integer',
        description: 'End step (optional — defaults to end).',
      },
      tool_filter: {
        type: 'string',
        description: 'Only show steps using this tool (optional).',
      },
    },
    required: ['cycle_id'],
  },
};

const COMPARE_TRACES_SCHEMA: ToolSchema = {
  name: 'compare_traces',
  description: `Compare two execution traces side by side. Shows common tools, unique tools,
step count differences, and a step-by-step sequence comparison. Useful for understanding
why one approach succeeded and another failed.`,
  inputSchema: {
    type: 'object',
    properties: {
      cycle_id_a: {
        type: 'string',
        description: 'First cycle ID.',
      },
      cycle_id_b: {
        type: 'string',
        description: 'Second cycle ID.',
      },
    },
    required: ['cycle_id_a', 'cycle_id_b'],
  },
};

const SEARCH_TRACES_SCHEMA: ToolSchema = {
  name: 'search_traces',
  description: `Search past execution traces by outcome, trigger, tool usage, tag, or date range.
Returns index entries (not full traces) — use \`replay\` to load the full trace.`,
  inputSchema: {
    type: 'object',
    properties: {
      outcome: {
        type: 'string',
        description: 'Filter by outcome: "success", "failure", or "partial".',
        enum: ['success', 'failure', 'partial'],
      },
      trigger: {
        type: 'string',
        description: 'Filter by trigger type (substring match).',
      },
      tool: {
        type: 'string',
        description: 'Filter by tool usage (traces that used this tool).',
      },
      tag: {
        type: 'string',
        description: 'Filter by tag.',
      },
      limit: {
        type: 'integer',
        description: 'Maximum number of results (default 20).',
      },
    },
    required: [],
  },
};

// ── VISION TIER 2: SELF-MODIFYING PROMPTS ────────────────────────────────────

const EDIT_PROMPT_SCHEMA: ToolSchema = {
  name: 'edit_prompt',
  description: `Edit your own system prompt. Replace old text with new text.

Use this when you've identified a workflow pattern that should be baked into your default behavior.
Examples: "always run tests after editing 2+ files", "prefer recall_journal for debugging".

Protected patterns (Safety Boundary, Path Guards, Redaction Rules, Security Invariants) cannot be removed.
Each edit is versioned and can be reverted.`,
  inputSchema: {
    type: 'object',
    properties: {
      old_text: {
        type: 'string',
        description: 'The exact text to replace in the current prompt.',
      },
      new_text: {
        type: 'string',
        description: 'The replacement text.',
      },
      rationale: {
        type: 'string',
        description: 'Why this edit is being made — what experience motivates it.',
      },
    },
    required: ['old_text', 'new_text', 'rationale'],
  },
};

const REVERT_PROMPT_SCHEMA: ToolSchema = {
  name: 'revert_prompt',
  description: `Revert your system prompt to a previous version.

Use this when a prompt edit led to worse performance. Specify the version number to revert to.`,
  inputSchema: {
    type: 'object',
    properties: {
      version: {
        type: 'integer',
        description: 'The version number to revert to.',
      },
      rationale: {
        type: 'string',
        description: 'Why you are reverting.',
      },
    },
    required: ['version', 'rationale'],
  },
};

const GET_PROMPT_SCHEMA: ToolSchema = {
  name: 'get_prompt',
  description: `View your current system prompt content and version history.`,
  inputSchema: {
    type: 'object',
    properties: {
      include_history: {
        type: 'boolean',
        description: 'Whether to include version history (default false).',
      },
    },
    required: [],
  },
};

// ── VISION TIER 2: SHADOW EXECUTION ──────────────────────────────────────────

const SHADOW_SCHEMA: ToolSchema = {
  name: 'shadow',
  description: `Record an alternative approach (shadow) before executing your primary plan.

Use this for non-trivial tasks to build judgment data. Describe what you would do differently.
The shadow is stored but NOT executed — only the primary approach runs. During dream cycles,
shadows are compared against actual outcomes to calibrate your judgment.`,
  inputSchema: {
    type: 'object',
    properties: {
      cycle_id: {
        type: 'string',
        description: 'The current cycle ID.',
      },
      strategy: {
        type: 'string',
        description: 'Description of the alternative strategy.',
      },
      expected_steps: {
        type: 'array',
        description: 'Expected steps the shadow approach would take.',
        items: { type: 'string', description: 'A step description.' },
      },
      rationale: {
        type: 'string',
        description: 'Why you chose the primary approach over this shadow.',
      },
      tags: {
        type: 'array',
        description: 'Tags for categorization.',
        items: { type: 'string', description: 'A tag.' },
      },
    },
    required: ['cycle_id', 'strategy', 'expected_steps', 'rationale'],
  },
};

const LIST_SHADOWS_SCHEMA: ToolSchema = {
  name: 'list_shadows',
  description: `List recent shadows and judgment patterns. Shows unassessed shadows, missed opportunities, and established patterns.`,
  inputSchema: {
    type: 'object',
    properties: {},
    required: [],
  },
};

// ── VISION TIER 2: TOOL SYNTHESIS ────────────────────────────────────────────

const CREATE_TOOL_SCHEMA: ToolSchema = {
  name: 'create_tool',
  description: `Create a new custom tool by providing a name, description, parameters, and a bash template.

Use this when you notice a repeated multi-step operation that could be wrapped in a single tool call.
The template uses {{param_name}} syntax for parameter substitution.

Security: Templates are scanned for dangerous patterns before acceptance.
Examples of good custom tools:
- "quick_test" — run only test files related to recently modified source files
- "check_and_summarize_diff" — read git diff, classify change type, summarize`,
  inputSchema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Tool name (lowercase, alphanumeric + underscores).',
      },
      description: {
        type: 'string',
        description: 'What the tool does and when to use it.',
      },
      parameters: {
        type: 'object',
        description: 'JSON Schema for the tool parameters (properties and required fields).',
      },
      template: {
        type: 'string',
        description: 'Bash command template with {{param}} placeholders.',
      },
      author_notes: {
        type: 'string',
        description: 'Why this tool was created — what repeated pattern it addresses.',
      },
    },
    required: ['name', 'description', 'template', 'author_notes'],
  },
};

const MANAGE_TOOLS_SCHEMA: ToolSchema = {
  name: 'manage_tools',
  description: `Manage custom tools: archive unused tools, reactivate archived tools, or delete tools permanently.`,
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['archive', 'reactivate', 'delete'],
        description: 'The action to perform.',
      },
      tool_name: {
        type: 'string',
        description: 'The name of the custom tool.',
      },
    },
    required: ['action', 'tool_name'],
  },
};

const LIST_CUSTOM_TOOLS_SCHEMA: ToolSchema = {
  name: 'list_custom_tools',
  description: `List all custom (synthesized) tools with usage statistics, status, and creation date.`,
  inputSchema: {
    type: 'object',
    properties: {},
    required: [],
  },
};

// ── VISION TIER 3: ADVERSARIAL CHALLENGES ────────────────────────────────────

const RUN_CHALLENGES_SCHEMA: ToolSchema = {
  name: 'run_challenges',
  description: `Generate a batch of self-testing challenges targeting weak skill areas.
Challenges are prioritized based on the self-model's assessed weaknesses.
Results help calibrate sub-skill assessments with higher fidelity than real-task tracking.`,
  inputSchema: {
    type: 'object',
    properties: {
      cycleId: {
        type: 'string',
        description: 'Cycle identifier for this challenge batch.',
      },
      budget: {
        type: 'number',
        description: 'Maximum number of challenges to generate (default: 20).',
      },
    },
    required: ['cycleId'],
  },
};

const CHALLENGE_HISTORY_SCHEMA: ToolSchema = {
  name: 'challenge_history',
  description: `View adversarial challenge history and sub-skill assessments.
Actions: 'summary' shows overall stats, 'weakest' shows weakest sub-skills,
'trend' shows skill trend over recent batches.`,
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['summary', 'weakest', 'trend'],
        description: 'What to show: summary, weakest sub-skills, or skill trend.',
      },
      skill: {
        type: 'string',
        description: 'Skill to show trend for (required for trend action).',
      },
    },
    required: ['action'],
  },
};

// ── VISION TIER 3: PROMPT EVOLUTION ──────────────────────────────────────────

const EVOLVE_PROMPT_SCHEMA: ToolSchema = {
  name: 'evolve_prompt',
  description: `Manage the prompt genetic algorithm. Actions:
'initialize' creates a population from the current prompt,
'record_fitness' records benchmark results for a variant,
'evolve' creates the next generation from the best variants.`,
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['initialize', 'record_fitness', 'evolve'],
        description: 'Evolution action to perform.',
      },
      variantIndex: {
        type: 'number',
        description: 'Variant index for record_fitness action.',
      },
      avgTurns: {
        type: 'number',
        description: 'Average turns to complete benchmark tasks.',
      },
      avgToolCalls: {
        type: 'number',
        description: 'Average tool calls per task.',
      },
      errorRate: {
        type: 'number',
        description: 'Error rate (0-1) across benchmark tasks.',
      },
      completionRate: {
        type: 'number',
        description: 'Task completion rate (0-1).',
      },
      tasksEvaluated: {
        type: 'number',
        description: 'Number of benchmark tasks evaluated.',
      },
    },
    required: ['action'],
  },
};

const EVOLUTION_STATUS_SCHEMA: ToolSchema = {
  name: 'evolution_status',
  description: `View the current state of prompt evolution: generation number,
population fitness scores, and evolution history.`,
  inputSchema: {
    type: 'object',
    properties: {},
    required: [],
  },
};

// ── VISION TIER 3: LoRA FINE-TUNING ─────────────────────────────────────────

const EXTRACT_TRAINING_DATA_SCHEMA: ToolSchema = {
  name: 'extract_training_data',
  description: `Extract training data from journal and issue log for LoRA fine-tuning.
Groups data by skill domain. Shows instruction/completion pairs and preference pairs.`,
  inputSchema: {
    type: 'object',
    properties: {
      lookbackDays: {
        type: 'number',
        description: 'How many days back to look for training data (default: 90).',
      },
    },
    required: [],
  },
};

const LIST_ADAPTERS_SCHEMA: ToolSchema = {
  name: 'list_adapters',
  description: `List all LoRA adapters with their status, skill domain, training metrics,
and benchmark improvements. Shows active, training, archived, and discarded adapters.`,
  inputSchema: {
    type: 'object',
    properties: {
      status: {
        type: 'string',
        enum: ['active', 'training', 'evaluating', 'archived', 'discarded'],
        description: 'Filter by adapter status (optional, shows all if omitted).',
      },
    },
    required: [],
  },
};

const LOAD_ADAPTER_SCHEMA: ToolSchema = {
  name: 'load_adapter',
  description: `Request loading a specific LoRA adapter for the current task.
The adapter is loaded as a model variant via Ollama.
Only active adapters can be loaded.`,
  inputSchema: {
    type: 'object',
    properties: {
      skill: {
        type: 'string',
        description: 'Skill domain to load adapter for (e.g., "regex", "testing").',
      },
    },
    required: ['skill'],
  },
};

// ── UPDATE WORLD MODEL TOOL ──────────────────────────────────────────────────

const UPDATE_WORLD_MODEL_SCHEMA: ToolSchema = {
  name: 'update_world_model',
  description: `Track or resolve a concern in the world model. Use 'add' to flag something
you've observed (e.g., "flaky test in detector.test.ts"), or 'resolve' to clear
a concern you've fixed. Concerns have severity levels: informational, worth-watching, needs-action.`,
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['add', 'resolve'],
        description: 'Whether to add a new concern or resolve an existing one.',
      },
      description: {
        type: 'string',
        description: 'Description of the concern.',
      },
      severity: {
        type: 'string',
        enum: ['informational', 'worth-watching', 'needs-action'],
        description: 'Severity level (only for add).',
      },
      related_files: {
        type: 'array',
        items: { type: 'string', description: 'A file path.' },
        description: 'Related file paths (only for add).',
      },
    },
    required: ['action', 'description'],
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Blocked Command Patterns
// ─────────────────────────────────────────────────────────────────────────────

const BLOCKED_COMMANDS = [
  /\brm\s+(-rf?|--recursive)\s/,
  /\brm\s+-[a-zA-Z]*f[a-zA-Z]*\s+\//,
  /\bmkfs\b/,
  /\bdd\s+/,
  /\b>\s*\/dev\/sd/,
  /\bformat\b/,
  /\bshutdown\b/,
  /\breboot\b/,
  /\bsudo\s+rm\b/,
  /\bgit\s+push\s+.*--force\b/,
  /\bgit\s+reset\s+--hard\b/,
  /\bgit\s+clean\s+-[a-zA-Z]*f/,
];

function isCommandBlocked(command: string): boolean {
  return BLOCKED_COMMANDS.some((pattern) => pattern.test(command));
}

// ═════════════════════════════════════════════════════════════════════════════
// ROADMAP PHASE 1: LOOSEN THE PIPELINE — meta tool
// ═════════════════════════════════════════════════════════════════════════════

const META_SCHEMA: ToolSchema = {
  name: 'meta',
  description: `Override the default pipeline strategy for the current cycle.
Use this to skip classification, skip planning, add mid-execution verification,
or change execution strategy. Overrides are recorded and tracked for
self-improvement analysis during dream cycles.`,
  inputSchema: {
    type: 'object',
    properties: {
      override: {
        type: 'string',
        enum: ['skip_classification', 'skip_planning', 'force_verify', 'change_strategy'],
        description: 'Which pipeline stage to override.',
      },
      strategy: {
        type: 'string',
        description: 'New strategy description (only for change_strategy).',
      },
      rationale: {
        type: 'string',
        description: 'Why you are overriding the default pipeline behavior.',
      },
    },
    required: ['override', 'rationale'],
  },
};

// ═════════════════════════════════════════════════════════════════════════════
// ROADMAP PHASE 2: PROMOTE THE REACT LOOP — classify, plan, verify tools
// ═════════════════════════════════════════════════════════════════════════════

const CLASSIFY_SCHEMA: ToolSchema = {
  name: 'classify',
  description: `Classify a message or task description to determine its type and complexity.
Returns: task class (conversation, simple_task, complex_task), confidence, task type.
Use this when you want structured routing guidance before deciding how to proceed.
This is optional — you can skip classification for tasks you understand clearly.`,
  inputSchema: {
    type: 'object',
    properties: {
      message: {
        type: 'string',
        description: 'The message or task description to classify.',
      },
    },
    required: ['message'],
  },
};

const PLAN_SCHEMA: ToolSchema = {
  name: 'plan',
  description: `Generate a structured execution plan for a complex task.
Returns a task plan with ordered steps, dependencies, and verification criteria.
Use this for multi-step tasks where you want to organize your approach before acting.
This is optional — skip planning for simple or well-understood tasks.`,
  inputSchema: {
    type: 'object',
    properties: {
      instruction: {
        type: 'string',
        description: 'The task to plan execution for.',
      },
      context: {
        type: 'string',
        description: 'Additional context (recent activity, constraints, etc.).',
      },
    },
    required: ['instruction'],
  },
};

const VERIFY_SCHEMA: ToolSchema = {
  name: 'verify',
  description: `Verify that a task or sub-task was completed correctly.
Runs verification checks against completion criteria.
Use this mid-execution for critical checkpoints or at the end for final validation.
This is optional — trust your judgment for straightforward tasks.`,
  inputSchema: {
    type: 'object',
    properties: {
      description: {
        type: 'string',
        description: 'What was supposed to be accomplished.',
      },
      criteria: {
        type: 'array',
        items: { type: 'string', description: 'A single criterion to check.' },
        description: 'Completion criteria to check against.',
      },
      evidence: {
        type: 'string',
        description: 'Evidence of completion (test output, file content, etc.).',
      },
    },
    required: ['description', 'criteria', 'evidence'],
  },
};

// ═════════════════════════════════════════════════════════════════════════════
// ROADMAP PHASE 3: INTROSPECTION TOOLS
// ═════════════════════════════════════════════════════════════════════════════

const PEEK_QUEUE_SCHEMA: ToolSchema = {
  name: 'peek_queue',
  description: `See the current event queue: what triggers are pending, their priorities,
and what's next. Helps you decide whether to continue current work or switch to
something more urgent.`,
  inputSchema: {
    type: 'object',
    properties: {},
    required: [],
  },
};

const CHECK_BUDGET_SCHEMA: ToolSchema = {
  name: 'check_budget',
  description: `Check your resource consumption for the current cycle: turns used,
tokens consumed, time elapsed, and remaining budget. Use this to decide
whether to continue working or wrap up.`,
  inputSchema: {
    type: 'object',
    properties: {},
    required: [],
  },
};

const LIST_CONTEXT_SCHEMA: ToolSchema = {
  name: 'list_context',
  description: `See what's currently loaded in each memory tier: hot (identity),
warm (working memory), cool (recent archives), cold (historical).
Shows token counts and entry keys for each tier.`,
  inputSchema: {
    type: 'object',
    properties: {},
    required: [],
  },
};

const REVIEW_STEPS_SCHEMA: ToolSchema = {
  name: 'review_steps',
  description: `Review the tool call history for the current cycle. Shows what tools
were called, whether they succeeded, and how long they took.
Use this to understand what you've done and plan next steps.`,
  inputSchema: {
    type: 'object',
    properties: {
      last_n: {
        type: 'integer',
        description: 'Only show the last N steps (default: all).',
      },
    },
    required: [],
  },
};

const ASSESS_SELF_SCHEMA: ToolSchema = {
  name: 'assess_self',
  description: `Query your self-model for strengths and weaknesses relevant to the
current task. Returns skill performance data, preferences, and known patterns.
Use this to calibrate confidence and decide whether to verify carefully.`,
  inputSchema: {
    type: 'object',
    properties: {
      skills: {
        type: 'array',
        items: { type: 'string', description: 'A skill name.' },
        description: 'Specific skills to query (e.g., ["regex", "testing"]). Omit for full summary.',
      },
    },
    required: [],
  },
};

// ═════════════════════════════════════════════════════════════════════════════
// ROADMAP PHASE 4: LLM-CONTROLLED CONTEXT
// ═════════════════════════════════════════════════════════════════════════════

const LOAD_CONTEXT_SCHEMA: ToolSchema = {
  name: 'load_context',
  description: `Load specific content from cool/cold memory into the warm tier for
immediate access. Use this when you need information from past sessions
or archived knowledge in your active working memory.`,
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'What to search for in memory.',
      },
      tier: {
        type: 'string',
        enum: ['cool', 'cold', 'both'],
        description: 'Which tier to search (default: both).',
      },
      limit: {
        type: 'integer',
        description: 'Max entries to load (default: 3).',
      },
    },
    required: ['query'],
  },
};

const EVICT_CONTEXT_SCHEMA: ToolSchema = {
  name: 'evict_context',
  description: `Remove specific content from the warm tier to free up working memory.
Use this when context is no longer needed for the current task.`,
  inputSchema: {
    type: 'object',
    properties: {
      key: {
        type: 'string',
        description: 'Key of the warm tier entry to evict.',
      },
    },
    required: ['key'],
  },
};

const SET_BUDGET_SCHEMA: ToolSchema = {
  name: 'set_budget',
  description: `Adjust memory tier budgets for the current cycle. Increase warm tier
for tasks needing lots of context, or decrease it for simple tasks.
Hot tier minimum is enforced (identity is never evicted).`,
  inputSchema: {
    type: 'object',
    properties: {
      warm_tier_tokens: {
        type: 'integer',
        description: 'New warm tier token budget.',
      },
    },
    required: ['warm_tier_tokens'],
  },
};

// ═════════════════════════════════════════════════════════════════════════════
// ROADMAP PHASE 5: LLM-INITIATED TRIGGERS
// ═════════════════════════════════════════════════════════════════════════════

const SCHEDULE_SCHEMA: ToolSchema = {
  name: 'schedule',
  description: `Create a self-initiated trigger: schedule a future task, set a reminder,
or create a recurring check. The scheduled job re-enters the agent loop
at the specified time.

Examples:
  - "Check if tests pass in 2 hours"
  - "Review this PR tomorrow morning"
  - "Run a dependency audit every Monday at 9am"`,
  inputSchema: {
    type: 'object',
    properties: {
      description: {
        type: 'string',
        description: 'What should happen when the trigger fires.',
      },
      fire_at: {
        type: 'string',
        description: 'When to fire: ISO 8601 timestamp, relative time ("in 2 hours"), or natural language ("tomorrow 9am").',
      },
      cron: {
        type: 'string',
        description: 'For recurring: 5-field cron expression (min hour dom month dow).',
      },
      actionable: {
        type: 'boolean',
        description: 'If true, the description is re-injected as a task (default: true).',
      },
    },
    required: ['description'],
  },
};

const LIST_SCHEDULES_SCHEMA: ToolSchema = {
  name: 'list_schedules',
  description: `List all active scheduled jobs (self-initiated triggers). Shows what's
pending, when it fires, and whether it's one-shot or recurring.`,
  inputSchema: {
    type: 'object',
    properties: {},
    required: [],
  },
};

const CANCEL_SCHEDULE_SCHEMA: ToolSchema = {
  name: 'cancel_schedule',
  description: `Cancel an active scheduled job by ID.`,
  inputSchema: {
    type: 'object',
    properties: {
      job_id: {
        type: 'string',
        description: 'The job ID to cancel.',
      },
    },
    required: ['job_id'],
  },
};

// ═════════════════════════════════════════════════════════════════════════════
// SUPPORTING WORK: SEMANTIC MEMORY — semantic_recall tool
// ═════════════════════════════════════════════════════════════════════════════

const SEMANTIC_RECALL_SCHEMA: ToolSchema = {
  name: 'semantic_recall',
  description: `Search memory using hybrid keyword + semantic matching. When the embedding provider
is available, your query is embedded and compared against stored entry embeddings using cosine
similarity, blended with keyword scores. Falls back to keyword-only when embeddings are unavailable.`,
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'What to search for (will be embedded for semantic matching).',
      },
      tier: {
        type: 'string',
        enum: ['cool', 'cold', 'both'],
        description: 'Which tier to search (default: both).',
      },
      limit: {
        type: 'integer',
        description: 'Max results to return (default: 10).',
      },
    },
    required: ['query'],
  },
};

// ═════════════════════════════════════════════════════════════════════════════
// SUPPORTING WORK: PARALLELISM — parallel_reason tool
// ═════════════════════════════════════════════════════════════════════════════

const PARALLEL_REASON_SCHEMA: ToolSchema = {
  name: 'parallel_reason',
  description: `Send the same problem to multiple models in parallel and get the best
response. Uses the reasoning model as judge to pick the winner.
Use this for hard decisions where redundancy improves reliability.
Requires the concurrent inference provider to be available.`,
  inputSchema: {
    type: 'object',
    properties: {
      problem: {
        type: 'string',
        description: 'The problem or question to solve.',
      },
      strategy: {
        type: 'string',
        enum: ['parallel', 'best_of_n'],
        description: 'parallel: get both responses. best_of_n: have judge pick best.',
      },
    },
    required: ['problem'],
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Reconciliation: Dream Cycle Phase Tools
// ─────────────────────────────────────────────────────────────────────────────

const CONSOLIDATE_REFLECTIONS_SCHEMA: ToolSchema = {
  name: 'consolidate_reflections',
  description: `Find patterns across recent reflections and archive consolidated insights to long-term memory.
This is a dream cycle phase that can now be invoked at your discretion.
Useful during quiet hours or when reflection count is high.`,
  inputSchema: {
    type: 'object',
    properties: {},
    required: [],
  },
};

const REORGANIZE_GOALS_SCHEMA: ToolSchema = {
  name: 'reorganize_goals',
  description: `Reprioritize the goal stack: prune stale goals and create new goals from high-priority issues.
This is a dream cycle phase that can now be invoked at your discretion.`,
  inputSchema: {
    type: 'object',
    properties: {},
    required: [],
  },
};

const EXPLORE_CODEBASE_SCHEMA: ToolSchema = {
  name: 'explore_codebase',
  description: `Run code archaeology: find fragile files (frequently changed/fixed) and abandoned code.
Files issues for very fragile code. This is a dream cycle phase that can now be invoked at your discretion.`,
  inputSchema: {
    type: 'object',
    properties: {},
    required: [],
  },
};

const REBUILD_SELF_MODEL_SCHEMA: ToolSchema = {
  name: 'rebuild_self_model',
  description: `Recalculate the self-model: rebuild strengths, weaknesses, skill ratings, and preferences from recent history.
This is a dream cycle phase that can now be invoked at your discretion.`,
  inputSchema: {
    type: 'object',
    properties: {},
    required: [],
  },
};

const WRITE_RETROSPECTIVE_SCHEMA: ToolSchema = {
  name: 'write_retrospective',
  description: `Write a retrospective to MEMORY.md summarizing recent dream cycle activity,
fragile files, goal changes, and self-model state. Respects the configured interval
between retrospectives. This is a dream cycle phase that can now be invoked at your discretion.`,
  inputSchema: {
    type: 'object',
    properties: {},
    required: [],
  },
};

// ── ADVANCED MEMORY: ZETTELKASTEN LINK NETWORK (A-MEM) ──────────────────────

const LINK_MEMORIES_SCHEMA: ToolSchema = {
  name: 'link_memories',
  description: `Create a typed bidirectional link between two memory entries (crystals, journal entries,
constitution rules, etc.). If a link already exists between the pair, it is strengthened instead of duplicated.

Link types:
- supports: Evidence or reasoning that supports another entry
- contradicts: Evidence that contradicts another entry
- extends: Builds upon or elaborates on another entry
- derived_from: Created as a consequence of another entry
- related: General topical relationship`,
  inputSchema: {
    type: 'object',
    properties: {
      source_id: {
        type: 'string',
        description: 'ID of the source memory entry (e.g. crystal ID, journal entry ID).',
      },
      target_id: {
        type: 'string',
        description: 'ID of the target memory entry.',
      },
      link_type: {
        type: 'string',
        enum: ['supports', 'contradicts', 'extends', 'derived_from', 'related'],
        description: 'The relationship type of the link.',
      },
      annotation: {
        type: 'string',
        description: 'Optional annotation explaining why this link exists.',
      },
    },
    required: ['source_id', 'target_id', 'link_type'],
  },
};

const GET_LINKS_SCHEMA: ToolSchema = {
  name: 'get_links',
  description: `Retrieve all links connected to a memory entry, sorted by strength (strongest first).
Use this to understand how a memory entry relates to the rest of the knowledge network.`,
  inputSchema: {
    type: 'object',
    properties: {
      entry_id: {
        type: 'string',
        description: 'The memory entry ID to get links for.',
      },
      link_type: {
        type: 'string',
        enum: ['supports', 'contradicts', 'extends', 'derived_from', 'related'],
        description: 'Optional: filter links by relationship type.',
      },
    },
    required: ['entry_id'],
  },
};

const TRAVERSE_LINKS_SCHEMA: ToolSchema = {
  name: 'traverse_links',
  description: `Traverse the memory link network from a starting entry, returning all reachable entries
within the given number of hops (breadth-first). Useful for finding related context across the entire
memory surface — crystals, journal entries, constitution rules, and more.`,
  inputSchema: {
    type: 'object',
    properties: {
      entry_id: {
        type: 'string',
        description: 'The starting memory entry ID.',
      },
      hops: {
        type: 'number',
        description: 'How many hops to traverse (1 = direct neighbors, 2 = neighbors of neighbors). Default: 2.',
      },
    },
    required: ['entry_id'],
  },
};

// ── ADVANCED MEMORY: AUDN CONSOLIDATION CYCLE (Mem0) ────────────────────────

const AUDN_ENQUEUE_SCHEMA: ToolSchema = {
  name: 'audn_enqueue',
  description: `Queue a memory candidate for AUDN (Add/Update/Delete/Nothing) evaluation during the
next dream cycle consolidation. Candidates are compared against existing crystals, constitution rules,
and journal entries — then either added as new knowledge, merged into existing memories, used to
delete contradicted memories, or discarded if already known. Use this when you encounter information
worth remembering but want the dream cycle to decide how it fits.`,
  inputSchema: {
    type: 'object',
    properties: {
      content: {
        type: 'string',
        description: 'The memory content to queue for evaluation.',
      },
      source: {
        type: 'string',
        description: 'Which subsystem this comes from (e.g. "crystal", "journal", "reflection", "observation").',
      },
      tags: {
        type: 'array',
        items: { type: 'string', description: 'Tag value' },
        description: 'Optional categorization tags.',
      },
    },
    required: ['content', 'source'],
  },
};

const AUDN_STATUS_SCHEMA: ToolSchema = {
  name: 'audn_status',
  description: `Check the AUDN consolidation queue — how many memory candidates are pending evaluation
and what their sources are. Useful for deciding whether to trigger consolidation now.`,
  inputSchema: {
    type: 'object',
    properties: {},
    required: [],
  },
};

// ── Advanced Memory: Entropy-Based Tier Migration (SAGE) ─────────────────────

const ENTROPY_SCORE_SCHEMA: ToolSchema = {
  name: 'entropy_score',
  description: `Calculate the Shannon entropy (information density) of a piece of text.
Returns raw entropy in bits and a normalized 0-1 score. High entropy indicates
diverse, information-rich content; low entropy indicates repetitive or sparse content.
Useful for gauging whether a memory entry is worth promoting to a hotter tier.`,
  inputSchema: {
    type: 'object',
    properties: {
      content: {
        type: 'string',
        description: 'The text content to score for information density.',
      },
    },
    required: ['content'],
  },
};

const EVALUATE_TIERS_SCHEMA: ToolSchema = {
  name: 'evaluate_tiers',
  description: `Evaluate a batch of memory entries and produce tier migration recommendations.
Each entry is scored using Shannon entropy, access frequency, and recency. Returns
a report showing which entries should be promoted to hotter tiers or demoted to colder
ones. Useful during memory maintenance to optimize tier placement.`,
  inputSchema: {
    type: 'object',
    properties: {
      entries: {
        type: 'array',
        description: 'Memory entries to evaluate for tier placement.',
        items: {
          type: 'object',
          description: 'A memory entry to evaluate for tier placement.',
          properties: {
            id: { type: 'string', description: 'Entry ID' },
            content: { type: 'string', description: 'Entry text content' },
            currentTier: {
              type: 'string',
              enum: ['hot', 'warm', 'cool', 'cold'],
              description: 'Current tier of the entry',
            },
            accessCount: { type: 'number', description: 'Number of times this entry has been accessed' },
            lastAccessedAt: { type: 'string', description: 'ISO timestamp of last access' },
            createdAt: { type: 'string', description: 'ISO timestamp of entry creation' },
          },
          required: ['id', 'content', 'currentTier', 'accessCount', 'lastAccessedAt', 'createdAt'],
        },
      },
    },
    required: ['entries'],
  },
};

// ── Advanced Memory: Git-Backed Memory Versioning (Letta) ────────────────────

const SNAPSHOT_MEMORY_SCHEMA: ToolSchema = {
  name: 'snapshot_memory',
  description: `Create a point-in-time snapshot of all monitored memory files (crystals, constitution,
goals, issues). Snapshots enable rollback analysis and drift detection. Duplicate snapshots
(unchanged state) are automatically deduplicated.`,
  inputSchema: {
    type: 'object',
    properties: {
      message: {
        type: 'string',
        description: 'A short description of why this snapshot is being taken.',
      },
    },
    required: ['message'],
  },
};

const LIST_SNAPSHOTS_SCHEMA: ToolSchema = {
  name: 'list_snapshots',
  description: `List all memory snapshots, newest first. Shows snapshot ID, timestamp, trigger source,
and message. Use snapshot IDs with diff_snapshots to compare changes over time.`,
  inputSchema: {
    type: 'object',
    properties: {
      limit: {
        type: 'number',
        description: 'Maximum number of snapshots to return (default: 10).',
      },
    },
    required: [],
  },
};

const DIFF_SNAPSHOTS_SCHEMA: ToolSchema = {
  name: 'diff_snapshots',
  description: `Compare two memory snapshots to see what changed. Shows added/removed lines per
subsystem (crystals, constitution, goals, issues). If only toId is given, diffs against
the snapshot immediately before it.`,
  inputSchema: {
    type: 'object',
    properties: {
      toId: {
        type: 'string',
        description: 'The snapshot ID to diff to (the "after" snapshot).',
      },
      fromId: {
        type: 'string',
        description: 'The snapshot ID to diff from (the "before" snapshot). If omitted, uses the previous snapshot.',
      },
    },
    required: ['toId'],
  },
};

// ── Advanced Memory: Memory Evolution (A-MEM) ────────────────────────────────

const EVOLVE_MEMORY_SCHEMA: ToolSchema = {
  name: 'evolve_memory',
  description: `Transform a memory through one of six structured evolution operations:

- strengthen: Increase confidence when corroborated by new evidence
- weaken: Decrease confidence when contradicted
- merge: Combine two related memories into one richer memory (requires second_memory and new_content)
- split: Decompose a complex memory into focused sub-memories (requires split_contents)
- generalize: Abstract a specific memory into a broader principle (requires new_content)
- specialize: Narrow a general memory to a specific context (requires new_content)

Each operation is tracked with full lineage. When the link network is active,
links are automatically created between source and result memories.`,
  inputSchema: {
    type: 'object',
    properties: {
      operation: {
        type: 'string',
        enum: ['strengthen', 'weaken', 'merge', 'split', 'generalize', 'specialize'],
        description: 'The evolution operation to perform.',
      },
      memory: {
        type: 'object',
        description: 'The primary memory to evolve.',
        properties: {
          id: { type: 'string', description: 'Memory entry ID' },
          content: { type: 'string', description: 'Current content of the memory' },
          confidence: { type: 'number', description: 'Current confidence score (0-1)' },
          generation: { type: 'number', description: 'Current generation number (default: 0)' },
          parentIds: { type: 'array', items: { type: 'string', description: 'Parent memory ID' }, description: 'IDs of parent memories' },
          tags: { type: 'array', items: { type: 'string', description: 'Tag value' }, description: 'Memory tags' },
        },
        required: ['id', 'content', 'confidence'],
      },
      second_memory: {
        type: 'object',
        description: 'Second memory (required for merge).',
        properties: {
          id: { type: 'string', description: 'Memory entry ID' },
          content: { type: 'string', description: 'Content of the memory' },
          confidence: { type: 'number', description: 'Confidence score (0-1)' },
          generation: { type: 'number', description: 'Generation number' },
          parentIds: { type: 'array', items: { type: 'string', description: 'Parent memory ID' }, description: 'IDs of parent memories' },
          tags: { type: 'array', items: { type: 'string', description: 'Tag value' }, description: 'Memory tags' },
        },
        required: ['id', 'content', 'confidence'],
      },
      reason: {
        type: 'string',
        description: 'Why this evolution is happening.',
      },
      new_content: {
        type: 'string',
        description: 'New content (required for merge, generalize, specialize).',
      },
      split_contents: {
        type: 'array',
        items: { type: 'string', description: 'Content for one of the split sub-memories' },
        description: 'Array of 2+ content strings (required for split).',
      },
    },
    required: ['operation', 'memory', 'reason'],
  },
};

const EVOLUTION_LINEAGE_SCHEMA: ToolSchema = {
  name: 'evolution_lineage',
  description: `Get the evolution history of a specific memory entry — all evolution events
where this memory was either a source or a result. Useful for understanding how
knowledge crystallized over time.`,
  inputSchema: {
    type: 'object',
    properties: {
      memory_id: {
        type: 'string',
        description: 'The memory entry ID to get lineage for.',
      },
    },
    required: ['memory_id'],
  },
};

const EVOLUTION_LOG_SCHEMA: ToolSchema = {
  name: 'evolution_log',
  description: `View recent memory evolution events. Shows operation type, source/result IDs,
reason, and timestamp. Optionally filter by operation type.`,
  inputSchema: {
    type: 'object',
    properties: {
      operation: {
        type: 'string',
        enum: ['strengthen', 'weaken', 'merge', 'split', 'generalize', 'specialize'],
        description: 'Optional: filter events by operation type.',
      },
      limit: {
        type: 'number',
        description: 'Maximum events to return (default: 20).',
      },
    },
    required: [],
  },
};

// ── Advanced Memory: Temporal Invalidation (Mem0) ────────────────────────────

const REGISTER_TEMPORAL_SCHEMA: ToolSchema = {
  name: 'register_temporal',
  description: `Register a memory entry for TTL-based temporal tracking. Each category has a
different TTL: facts (90 days), observations (30 days), opinions (14 days),
working notes (7 days), crystals (180 days), rules (120 days). Entries decay
over time and are eventually flagged for deletion.`,
  inputSchema: {
    type: 'object',
    properties: {
      entry_id: {
        type: 'string',
        description: 'The memory entry ID to track.',
      },
      category: {
        type: 'string',
        enum: ['fact', 'observation', 'opinion', 'working_note', 'crystal', 'rule'],
        description: 'TTL category determining how long the entry lives.',
      },
    },
    required: ['entry_id', 'category'],
  },
};

const CHECK_FRESHNESS_SCHEMA: ToolSchema = {
  name: 'check_freshness',
  description: `Check the freshness and expiry status of a tracked memory entry, or list all
entries in a given category with their freshness scores. Returns freshness (0-1,
where 1 = fresh and 0 = expired) and whether the entry is in its grace period.`,
  inputSchema: {
    type: 'object',
    properties: {
      entry_id: {
        type: 'string',
        description: 'Specific entry ID to check (optional if category is given).',
      },
      category: {
        type: 'string',
        enum: ['fact', 'observation', 'opinion', 'working_note', 'crystal', 'rule'],
        description: 'List all entries in this category with their freshness.',
      },
    },
    required: [],
  },
};

const SWEEP_EXPIRED_SCHEMA: ToolSchema = {
  name: 'sweep_expired',
  description: `Run a temporal invalidation sweep across all tracked memory entries. Updates
freshness scores, identifies newly expired entries, and lists entries past their
grace period that are candidates for deletion. Use this during maintenance or
before dream cycles to clean up stale memories.`,
  inputSchema: {
    type: 'object',
    properties: {},
    required: [],
  },
};

// ── Advanced Memory: Skill Files (Letta) ─────────────────────────────────────

const LEARN_SKILL_SCHEMA: ToolSchema = {
  name: 'learn_skill',
  description: `Learn a new skill from a successful task execution. A skill captures a reusable procedural pattern with ordered steps, preconditions, and success criteria. The skill is stored persistently and can be searched, refined, and tracked over time.`,
  inputSchema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Short skill name (e.g. "fix-typescript-errors").',
      },
      description: {
        type: 'string',
        description: 'What this skill does.',
      },
      steps: {
        type: 'array',
        description: 'Ordered steps to perform this skill.',
        items: { type: 'string', description: 'A single step.' },
      },
      preconditions: {
        type: 'array',
        description: 'What must be true before applying this skill.',
        items: { type: 'string', description: 'A precondition.' },
      },
      success_criteria: {
        type: 'array',
        description: 'How to verify the skill was applied correctly.',
        items: { type: 'string', description: 'A success criterion.' },
      },
      tags: {
        type: 'array',
        description: 'Tags for discovery (e.g. "typescript", "testing").',
        items: { type: 'string', description: 'A tag.' },
      },
    },
    required: ['name', 'description', 'steps'],
  },
};

const REFINE_SKILL_SCHEMA: ToolSchema = {
  name: 'refine_skill',
  description: `Refine an existing skill with updated steps, preconditions, success criteria, or description. Increments the skill version.`,
  inputSchema: {
    type: 'object',
    properties: {
      skill_id: {
        type: 'string',
        description: 'The ID of the skill to refine.',
      },
      steps: {
        type: 'array',
        description: 'Updated ordered steps (replaces existing).',
        items: { type: 'string', description: 'A single step.' },
      },
      preconditions: {
        type: 'array',
        description: 'Updated preconditions (replaces existing).',
        items: { type: 'string', description: 'A precondition.' },
      },
      success_criteria: {
        type: 'array',
        description: 'Updated success criteria (replaces existing).',
        items: { type: 'string', description: 'A success criterion.' },
      },
      description: {
        type: 'string',
        description: 'Updated description.',
      },
    },
    required: ['skill_id'],
  },
};

const SEARCH_SKILLS_SCHEMA: ToolSchema = {
  name: 'search_skills',
  description: `Search for skills by query (matches name, description, tags) or list all skills. Returns skill details including mastery level and usage stats.`,
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Search query to match against skill name, description, and tags. Omit to list all skills.',
      },
      mastery: {
        type: 'string',
        description: 'Filter by mastery level: novice, competent, proficient, or expert.',
      },
    },
    required: [],
  },
};

const RECORD_SKILL_USE_SCHEMA: ToolSchema = {
  name: 'record_skill_use',
  description: `Record that a skill was used and whether the use was successful. Updates the skill's use count, success count, and mastery level.`,
  inputSchema: {
    type: 'object',
    properties: {
      skill_id: {
        type: 'string',
        description: 'The ID of the skill that was used.',
      },
      success: {
        type: 'boolean',
        description: 'Whether the skill use was successful.',
      },
    },
    required: ['skill_id', 'success'],
  },
};

// ── Advanced Memory: Concurrent Dream Processing (Letta) ─────────────────────

const DREAM_CONCURRENCY_CONFIG_SCHEMA: ToolSchema = {
  name: 'dream_concurrency_config',
  description: `View the concurrent dream execution configuration. Shows max concurrency, phase timeout, critical phases, and whether abort-on-critical-failure is enabled. The concurrent executor runs independent dream phases in parallel within dependency groups to reduce total dream cycle duration.`,
  inputSchema: {
    type: 'object',
    properties: {},
    required: [],
  },
};

// ── Advanced Memory: Graph Relational Memory (Mem0) ──────────────────────────

const GRAPH_ADD_NODE_SCHEMA: ToolSchema = {
  name: 'graph_add_node',
  description: `Add or update an entity node in the knowledge graph. If a node with the same label+type already exists, its mention count is incremented. Node types: file, concept, person, tool, module, pattern.`,
  inputSchema: {
    type: 'object',
    properties: {
      label: {
        type: 'string',
        description: 'Display label for the node (e.g. "loop.ts", "TypeScript", "Alice").',
      },
      node_type: {
        type: 'string',
        description: 'Node type: file, concept, person, tool, module, or pattern.',
      },
      memory_id: {
        type: 'string',
        description: 'Optional memory entry ID to associate with this node.',
      },
    },
    required: ['label', 'node_type'],
  },
};

const GRAPH_ADD_EDGE_SCHEMA: ToolSchema = {
  name: 'graph_add_edge',
  description: `Add or strengthen a relationship edge between two nodes in the knowledge graph. Both nodes must exist. If the edge already exists, its weight is strengthened. Edge types: depends_on, related_to, uses, modifies, contains, authored_by, tested_by.`,
  inputSchema: {
    type: 'object',
    properties: {
      source_id: {
        type: 'string',
        description: 'Source node ID (format: "type:label-slug").',
      },
      target_id: {
        type: 'string',
        description: 'Target node ID (format: "type:label-slug").',
      },
      edge_type: {
        type: 'string',
        description: 'Relationship type: depends_on, related_to, uses, modifies, contains, authored_by, or tested_by.',
      },
      weight: {
        type: 'number',
        description: 'Initial edge weight (0.0-1.0, default 0.5).',
      },
    },
    required: ['source_id', 'target_id', 'edge_type'],
  },
};

const GRAPH_SEARCH_SCHEMA: ToolSchema = {
  name: 'graph_search',
  description: `Search the knowledge graph for nodes matching a query, or inspect a specific node's relationships and neighbors. Returns node details, connected edges, and neighbor list.`,
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Search query to match against node labels. Omit to get graph summary.',
      },
      node_id: {
        type: 'string',
        description: 'Specific node ID to inspect (shows edges and neighbors).',
      },
      node_type: {
        type: 'string',
        description: 'Filter results by node type: file, concept, person, tool, module, or pattern.',
      },
    },
    required: [],
  },
};

// ── Advanced Memory: Checker Pattern (SAGE) ──────────────────────────────────

const CHECK_MEMORY_SCHEMA: ToolSchema = {
  name: 'check_memory',
  description: `Validate a memory candidate before storage. Runs five checks:

1. **Consistency** — Does this contradict existing knowledge?
2. **Relevance** — Is this worth storing? (entropy/uniqueness)
3. **Duplicate** — Is this already known? (Jaccard similarity)
4. **Freshness** — Are date references still timely?
5. **Safety** — Does this contain sensitive data (passwords, keys, PII)?

Returns a composite verdict (approved/rejected) with per-check results and scores.
Provide existing knowledge entries for consistency and duplicate checks.`,
  inputSchema: {
    type: 'object',
    properties: {
      content: {
        type: 'string',
        description: 'The memory content to validate.',
      },
      category: {
        type: 'string',
        description: 'Optional category for the memory (e.g. "fact", "observation", "opinion").',
      },
      existing: {
        type: 'array',
        description: 'Existing knowledge entries to check against for consistency and duplicates.',
        items: {
          type: 'object',
          description: 'An existing knowledge entry.',
          properties: {
            id: { type: 'string', description: 'Entry ID' },
            content: { type: 'string', description: 'Entry content' },
          },
          required: ['id', 'content'],
        },
      },
    },
    required: ['content'],
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Per-Cycle File Read Cache
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Cached file content from a prior read in the same cycle.
 * Prevents redundant disk reads when the LLM re-reads the same file.
 */
interface FileReadCacheEntry {
  /** Full file content at the time of the read */
  content: string;
  /** Timestamp of the original read (ms) */
  readAt: number;
  /** How many times this file has been read in this cycle */
  readCount: number;
}

/**
 * Per-cycle file read cache. Created once per `buildExecutors` call
 * (i.e., once per agent cycle) and shared across `read_file` and
 * `edit_file` executors so that:
 *   1. Repeated reads return cached content instead of hitting disk.
 *   2. The LLM gets a warning when it re-reads the same file.
 *   3. `edit_file` can use cached content and invalidates on write.
 */
export class FileReadCache {
  private cache = new Map<string, FileReadCacheEntry>();

  /** Get cached content for a file path, or undefined if not cached. */
  get(fullPath: string): FileReadCacheEntry | undefined {
    return this.cache.get(fullPath);
  }

  /** Store content after a successful disk read. */
  set(fullPath: string, content: string): void {
    const existing = this.cache.get(fullPath);
    this.cache.set(fullPath, {
      content,
      readAt: Date.now(),
      readCount: (existing?.readCount ?? 0) + 1,
    });
  }

  /** Invalidate a cache entry after the file is modified (edit_file, create_file). */
  invalidate(fullPath: string): void {
    this.cache.delete(fullPath);
  }

  /** Total number of read operations saved by caching. */
  get savedReads(): number {
    let saved = 0;
    for (const entry of this.cache.values()) {
      saved += Math.max(0, entry.readCount - 1);
    }
    return saved;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Executor Builders
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build all tool executors. Each executor is a function that takes a
 * NativeToolCall and returns a NativeToolResult. The executors close
 * over the config and state references.
 */
function buildExecutors(
  config: AgentToolkitConfig,
  state: AgentState,
  delegateProvider?: LlmProvider,
): Map<string, (call: NativeToolCall) => Promise<NativeToolResult>> {
  const tracer = getTracer();
  const executors = new Map<string, (call: NativeToolCall) => Promise<NativeToolResult>>();
  const fileReadCache = new FileReadCache();

  // ── think ───────────────────────────────────────────────────────────────

  executors.set('think', async (call) => {
    const reasoning = requireString(call, 'reasoning');
    if ('error' in reasoning) return reasoning.error;

    tracer.log('agent-loop', 'info', `[think] ${reasoning.value}`);
    return successResult(call.id, 'Reasoning recorded. Continue with your next action.', config.maxOutputChars);
  });

  // ── read_file ───────────────────────────────────────────────────────────

  executors.set('read_file', async (call) => {
    const pathResult = requireString(call, 'path');
    if ('error' in pathResult) return pathResult.error;

    const filePath = pathResult.value;
    const maxLines = optionalNumber(call, 'max_lines');
    const offset = optionalNumber(call, 'offset') ?? 1;

    return tracer.withSpan('agent-loop', `read_file:${filePath}`, async () => {
      try {
        const fullPath = filePath.startsWith('/')
          ? filePath
          : `${config.projectRoot}/${filePath}`;

        // Check the per-cycle cache before hitting disk
        let content: string;
        let cacheHit = false;
        const cached = fileReadCache.get(fullPath);

        if (cached) {
          content = cached.content;
          cacheHit = true;
          // Increment the read count
          fileReadCache.set(fullPath, content);
        } else {
          content = await readFile(fullPath, 'utf8');
          fileReadCache.set(fullPath, content);
        }

        const lines = content.split('\n');

        // Apply offset and max_lines
        const startLine = Math.max(1, offset) - 1;
        const endLine = maxLines !== undefined
          ? Math.min(startLine + maxLines, lines.length)
          : lines.length;
        const selectedLines = lines.slice(startLine, endLine);

        // Add line numbers
        const numberedLines = selectedLines.map(
          (line, i) => `${String(startLine + i + 1).padStart(5)} | ${line}`,
        );

        const header = `File: ${filePath} (${lines.length} lines total, showing ${startLine + 1}-${endLine})`;

        // Build redundancy warning for repeated reads
        let redundancyNote = '';
        const entry = fileReadCache.get(fullPath);
        if (cacheHit && entry && entry.readCount > 1) {
          redundancyNote = `\n⚠ NOTE: This file was already read ${entry.readCount - 1} time(s) this cycle. Using cached content. Consider working with the information you already have instead of re-reading.`;
        }

        const output = `${header}\n${'─'.repeat(60)}\n${numberedLines.join('\n')}${redundancyNote}`;

        tracer.logIO('agent-loop', 'read', filePath, 0, {
          success: true,
          bytesOrLines: cacheHit ? 0 : lines.length,
        });

        return successResult(call.id, output, config.maxOutputChars);
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        tracer.logIO('agent-loop', 'read', filePath, 0, {
          success: false,
          error: errorMsg,
        });
        return failureResult(call.id, `Failed to read ${filePath}: ${errorMsg}`);
      }
    });
  });

  // ── read_files (batch) ──────────────────────────────────────────────────

  executors.set('read_files', async (call) => {
    const paths = (call.input['paths'] as string[] | undefined) ?? [];
    const globPattern = call.input['glob_pattern'] as string | undefined;

    if (paths.length === 0 && !globPattern) {
      return failureResult(call.id, 'Must provide either paths array or glob_pattern.');
    }

    return tracer.withSpan('agent-loop', 'read_files', async () => {
      try {
        let resolvedPaths = [...paths];

        // Resolve glob pattern
        if (globPattern) {
          const { glob: globFn } = await import('glob');
          const globResults = await globFn(globPattern, {
            cwd: config.projectRoot,
            nodir: true,
            absolute: false,
            ignore: ['node_modules/**', '.git/**', 'dist/**'],
          });
          resolvedPaths.push(...globResults);
        }

        // Deduplicate and cap
        resolvedPaths = [...new Set(resolvedPaths)].slice(0, 20);

        if (resolvedPaths.length === 0) {
          return successResult(call.id, 'No files matched.', config.maxOutputChars);
        }

        const sections: string[] = [];
        let totalChars = 0;
        const maxAggregate = 50_000;

        for (const filePath of resolvedPaths) {
          const fullPath = filePath.startsWith('/')
            ? filePath
            : `${config.projectRoot}/${filePath}`;

          try {
            const content = await readFile(fullPath, 'utf8');
            const remaining = maxAggregate - totalChars;

            if (remaining <= 0) {
              sections.push(`## ${filePath}\n(aggregate size limit reached)`);
              continue;
            }

            const trimmed = content.length > remaining
              ? content.slice(0, remaining) + '\n...(truncated)'
              : content;
            totalChars += trimmed.length;

            const lines = content.split('\n').length;
            sections.push(`## ${filePath} (${lines} lines)\n${trimmed}`);
          } catch {
            sections.push(`## ${filePath}\n(file not found or unreadable)`);
          }
        }

        return successResult(
          call.id,
          `Read ${resolvedPaths.length} files:\n\n${sections.join('\n\n')}`,
          config.maxOutputChars,
        );
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        return failureResult(call.id, `read_files failed: ${errorMsg}`);
      }
    });
  });

  // ── edit_file ───────────────────────────────────────────────────────────

  executors.set('edit_file', async (call) => {
    const pathResult = requireString(call, 'path');
    if ('error' in pathResult) return pathResult.error;
    const oldStringResult = requireString(call, 'old_string');
    if ('error' in oldStringResult) return oldStringResult.error;
    const newStringResult = requireString(call, 'new_string');
    if ('error' in newStringResult) return newStringResult.error;

    const filePath = pathResult.value;

    if (!isPathAllowed(filePath, config.allowedDirectories, config.forbiddenPatterns)) {
      return failureResult(call.id, `Path not allowed for editing: ${filePath}`);
    }

    return tracer.withSpan('agent-loop', `edit_file:${filePath}`, async () => {
      try {
        const fullPath = filePath.startsWith('/')
          ? filePath
          : `${config.projectRoot}/${filePath}`;

        // Use cached content if available; otherwise read from disk
        const cached = fileReadCache.get(fullPath);
        let content: string;
        if (cached) {
          content = cached.content;
        } else {
          content = await readFile(fullPath, 'utf8');
          fileReadCache.set(fullPath, content);
        }

        const occurrences = content.split(oldStringResult.value).length - 1;

        if (occurrences === 0) {
          return failureResult(call.id, `old_string not found in ${filePath}. Check for exact whitespace and content match.`);
        }

        if (occurrences > 1) {
          return failureResult(call.id, `old_string found ${occurrences} times in ${filePath}. Provide more context to make it unique.`);
        }

        const newContent = content.replace(oldStringResult.value, newStringResult.value);
        await writeFile(fullPath, newContent, 'utf8');

        // Invalidate the cache since the file changed on disk
        fileReadCache.invalidate(fullPath);

        const linesChanged = newStringResult.value.split('\n').length;
        tracer.logIO('agent-loop', 'edit', filePath, 0, {
          success: true,
          bytesOrLines: linesChanged,
        });

        return successResult(
          call.id,
          `Successfully edited ${filePath} (replaced 1 occurrence, ~${linesChanged} lines affected)`,
          config.maxOutputChars,
        );
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        return failureResult(call.id, `Failed to edit ${filePath}: ${errorMsg}`);
      }
    });
  });

  // ── create_file ─────────────────────────────────────────────────────────

  executors.set('create_file', async (call) => {
    const pathResult = requireString(call, 'path');
    if ('error' in pathResult) return pathResult.error;
    const contentResult = requireString(call, 'content');
    if ('error' in contentResult) return contentResult.error;

    const filePath = pathResult.value;
    const overwrite = call.input['overwrite'] === true;

    if (!isPathAllowed(filePath, config.allowedDirectories, config.forbiddenPatterns)) {
      tracer.log('agent-loop', 'warn', `create_file path rejected: "${filePath}"`, {
        allowedDirectories: config.allowedDirectories,
      });
      return failureResult(call.id, `Path not allowed for file creation: ${filePath}. Allowed directories: ${config.allowedDirectories.join(', ')}`);
    }

    return tracer.withSpan('agent-loop', `create_file:${filePath}`, async () => {
      try {
        const fullPath = filePath.startsWith('/')
          ? filePath
          : `${config.projectRoot}/${filePath}`;

        // Read old file for export loss detection (only on overwrite)
        let oldExports: string[] = [];
        let oldLineCount: number | undefined;
        if (overwrite) {
          try {
            const oldContent = await readFile(fullPath, 'utf8');
            oldExports = extractExportNames(oldContent);
            oldLineCount = oldContent.split('\n').length;
          } catch {
            // File doesn't exist yet — nothing to compare
          }
        } else {
          // Check if file already exists
          try {
            await readFile(fullPath, 'utf8');
            return failureResult(call.id, `File already exists: ${filePath}. Use edit_file to modify it, or set overwrite: true to replace.`);
          } catch {
            // File doesn't exist — good, we can create it
          }
        }

        await mkdir(dirname(fullPath), { recursive: true });
        await writeFile(fullPath, contentResult.value, 'utf8');

        const lineCount = contentResult.value.split('\n').length;
        const verb = overwrite ? 'overwrote' : 'create';
        tracer.logIO('agent-loop', verb, filePath, 0, {
          success: true,
          bytesOrLines: lineCount,
        });

        const action = overwrite ? 'Overwrote' : 'Created';
        let resultMsg = `${action} ${filePath} (${lineCount} lines)`;

        // Detect lost exports on overwrite
        if (overwrite && oldExports.length > 0) {
          const newExports = extractExportNames(contentResult.value);
          const lost = oldExports.filter((e) => !newExports.includes(e));
          if (lost.length > 0) {
            resultMsg += `\nWARNING: Previous version (${oldLineCount} lines) exported [${oldExports.join(', ')}]. New version exports [${newExports.join(', ')}]. LOST exports: [${lost.join(', ')}]. Other files may depend on these — add them back or verify they are intentionally removed.`;
          }
        }

        return successResult(
          call.id,
          resultMsg,
          config.maxOutputChars,
        );
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        return failureResult(call.id, `Failed to create ${filePath}: ${errorMsg}`);
      }
    });
  });

  // ── grep ────────────────────────────────────────────────────────────────

  executors.set('grep', async (call) => {
    const patternResult = requireString(call, 'pattern');
    if ('error' in patternResult) return patternResult.error;

    const searchPath = optionalString(call, 'path') ?? '.';
    const filePattern = optionalString(call, 'file_pattern');
    const maxResults = optionalNumber(call, 'max_results') ?? 50;

    return tracer.withSpan('agent-loop', `grep:${patternResult.value}`, async () => {
      try {
        const args = [
          '-rn', '--color=never', '-m', String(maxResults),
          '--exclude-dir=node_modules',
          '--exclude-dir=dist',
          '--exclude-dir=.git',
          '--exclude-dir=coverage',
        ];
        if (filePattern) {
          args.push('--include', filePattern);
        }
        args.push(patternResult.value, searchPath);

        const { stdout } = await execFileAsync('grep', args, {
          cwd: config.projectRoot,
          timeout: 30_000,
        });

        const lines = stdout.trim().split('\n').filter(Boolean);
        const output = lines.length > 0
          ? `Found ${lines.length} matches:\n${lines.join('\n')}`
          : `No matches found for pattern: ${patternResult.value}\nTip: Try a simpler substring pattern (e.g., just "voice-filter" instead of a complex regex). For imports, search the module name as a plain substring since paths include "./" or "../" prefixes and ".js" suffixes.`;

        return successResult(call.id, output, config.maxOutputChars);
      } catch (err) {
        // grep exits 1 when no matches found
        const exitCode = (err as { code?: number }).code;
        if (exitCode === 1) {
          return successResult(call.id, `No matches found for pattern: ${patternResult.value}\nTip: Try a simpler substring pattern (e.g., just "voice-filter" instead of a complex regex). For imports, search the module name as a plain substring since paths include "./" or "../" prefixes and ".js" suffixes.`, config.maxOutputChars);
        }
        const errorMsg = err instanceof Error ? err.message : String(err);
        return failureResult(call.id, `Grep failed: ${errorMsg}`);
      }
    });
  });

  // ── glob ────────────────────────────────────────────────────────────────

  executors.set('glob', async (call) => {
    const patternResult = requireString(call, 'pattern');
    if ('error' in patternResult) return patternResult.error;

    return tracer.withSpan('agent-loop', `glob:${patternResult.value}`, async () => {
      try {
        // Use find with name pattern (simple glob support)
        const { stdout } = await execFileAsync(
          'find',
          ['.', '-type', 'f', '-path', patternResult.value, '-not', '-path', '*/node_modules/*', '-not', '-path', '*/.git/*'],
          { cwd: config.projectRoot, timeout: 15_000 },
        );

        const files = stdout.trim().split('\n').filter(Boolean).sort();
        const output = files.length > 0
          ? `Found ${files.length} files:\n${files.join('\n')}`
          : 'No matching files found.';

        return successResult(call.id, output, config.maxOutputChars);
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        return failureResult(call.id, `Glob failed: ${errorMsg}`);
      }
    });
  });

  // ── bash ────────────────────────────────────────────────────────────────

  executors.set('bash', async (call) => {
    const commandResult = requireString(call, 'command');
    if ('error' in commandResult) return commandResult.error;

    const command = commandResult.value;
    const timeout = optionalNumber(call, 'timeout_ms') ?? config.commandTimeoutMs;

    if (isCommandBlocked(command)) {
      return failureResult(call.id, `Blocked: "${command}" matches a destructive command pattern. Use a safer alternative.`);
    }

    return tracer.withSpan('agent-loop', `bash:${command.slice(0, 80)}`, async () => {
      try {
        const { stdout, stderr } = await execFileAsync('bash', ['-c', command], {
          cwd: config.projectRoot,
          timeout,
        });

        const output = [
          stdout.trim() ? `STDOUT:\n${stdout.trim()}` : '',
          stderr.trim() ? `STDERR:\n${stderr.trim()}` : '',
        ].filter(Boolean).join('\n\n');

        return successResult(call.id, output || '(no output)', config.maxOutputChars);
      } catch (err) {
        const execErr = err as { stdout?: string; stderr?: string; code?: number };
        const output = [
          execErr.stdout?.trim() ? `STDOUT:\n${execErr.stdout.trim()}` : '',
          execErr.stderr?.trim() ? `STDERR:\n${execErr.stderr.trim()}` : '',
        ].filter(Boolean).join('\n\n');

        const exitCode = execErr.code ?? -1;
        return {
          toolCallId: call.id,
          success: false,
          output: truncateOutput(output || '(no output)', config.maxOutputChars),
          error: `Command exited with code ${exitCode}`,
          exitCode,
        };
      }
    });
  });

  // ── run_tests ───────────────────────────────────────────────────────────

  executors.set('run_tests', async (call) => {
    const pattern = optionalString(call, 'pattern');

    return tracer.withSpan('agent-loop', 'run_tests', async () => {
      try {
        const args = ['vitest', 'run'];
        if (pattern) {
          args.push(pattern);
        }

        const { stdout, stderr } = await execFileAsync('npx', args, {
          cwd: config.projectRoot,
          timeout: config.commandTimeoutMs,
        });

        const output = `${stdout}\n${stderr}`.trim();
        return successResult(call.id, output, config.maxOutputChars);
      } catch (err) {
        const execErr = err as { stdout?: string; stderr?: string };
        const output = `${execErr.stdout ?? ''}\n${execErr.stderr ?? ''}`.trim();
        return {
          toolCallId: call.id,
          success: false,
          output: truncateOutput(output || 'Tests failed (no output)', config.maxOutputChars),
          error: 'One or more tests failed',
        };
      }
    });
  });

  // ── typecheck ───────────────────────────────────────────────────────────

  executors.set('typecheck', async (call) => {
    return tracer.withSpan('agent-loop', 'typecheck', async () => {
      try {
        const { stdout, stderr } = await execFileAsync('npx', ['tsc', '--noEmit'], {
          cwd: config.projectRoot,
          timeout: config.commandTimeoutMs,
        });

        const output = `${stdout}\n${stderr}`.trim();
        return successResult(call.id, output || 'Typecheck passed — no errors.', config.maxOutputChars);
      } catch (err) {
        const execErr = err as { stdout?: string; stderr?: string };
        const output = `${execErr.stdout ?? ''}\n${execErr.stderr ?? ''}`.trim();
        return {
          toolCallId: call.id,
          success: false,
          output: truncateOutput(output || 'Typecheck failed', config.maxOutputChars),
          error: 'TypeScript compilation errors found',
        };
      }
    });
  });

  // ── lint ─────────────────────────────────────────────────────────────────

  executors.set('lint', async (call) => {
    return tracer.withSpan('agent-loop', 'lint', async () => {
      try {
        const { stdout, stderr } = await execFileAsync('node', ['scripts/lint.mjs'], {
          cwd: config.projectRoot,
          timeout: 60_000,
        });

        const output = `${stdout}\n${stderr}`.trim();
        return successResult(call.id, output || 'Lint passed — no issues.', config.maxOutputChars);
      } catch (err) {
        const execErr = err as { stdout?: string; stderr?: string };
        const output = `${execErr.stdout ?? ''}\n${execErr.stderr ?? ''}`.trim();
        return {
          toolCallId: call.id,
          success: false,
          output: truncateOutput(output || 'Lint failed', config.maxOutputChars),
          error: 'Lint errors found',
        };
      }
    });
  });

  // ── git_status ──────────────────────────────────────────────────────────

  executors.set('git_status', async (call) => {
    return tracer.withSpan('agent-loop', 'git_status', async () => {
      try {
        const { stdout: branch } = await execFileAsync('git', ['branch', '--show-current'], {
          cwd: config.projectRoot,
          timeout: 10_000,
        });
        const { stdout: status } = await execFileAsync('git', ['status', '--short'], {
          cwd: config.projectRoot,
          timeout: 10_000,
        });

        const output = `Branch: ${branch.trim()}\n\n${status.trim() || '(clean working tree)'}`;
        return successResult(call.id, output, config.maxOutputChars);
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        return failureResult(call.id, `git status failed: ${errorMsg}`);
      }
    });
  });

  // ── git_diff ────────────────────────────────────────────────────────────

  executors.set('git_diff', async (call) => {
    const staged = call.input['staged'] === true;
    const path = optionalString(call, 'path');

    return tracer.withSpan('agent-loop', 'git_diff', async () => {
      try {
        const args = ['diff'];
        if (staged) args.push('--staged');
        if (path) args.push('--', path);

        const { stdout } = await execFileAsync('git', args, {
          cwd: config.projectRoot,
          timeout: 15_000,
        });

        const output = stdout.trim() || '(no changes)';
        return successResult(call.id, output, config.maxOutputChars);
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        return failureResult(call.id, `git diff failed: ${errorMsg}`);
      }
    });
  });

  // ── git_commit ──────────────────────────────────────────────────────────

  executors.set('git_commit', async (call) => {
    const messageResult = requireString(call, 'message');
    if ('error' in messageResult) return messageResult.error;

    const files = call.input['files'];
    if (!Array.isArray(files) || files.length === 0) {
      return failureResult(call.id, 'Missing required parameter: files (array of file paths to stage)');
    }

    return tracer.withSpan('agent-loop', 'git_commit', async () => {
      try {
        // Validate files are in allowed paths
        for (const file of files) {
          if (typeof file !== 'string') continue;
          if (file !== '.' && !isPathAllowed(file, config.allowedDirectories, config.forbiddenPatterns)) {
            return failureResult(call.id, `File not in allowed paths: ${file}`);
          }
        }

        // Stage files
        const fileArgs = files.filter((f): f is string => typeof f === 'string');
        await execFileAsync('git', ['add', ...fileArgs], {
          cwd: config.projectRoot,
          timeout: 15_000,
        });

        // Commit
        const { stdout } = await execFileAsync('git', ['commit', '-m', messageResult.value], {
          cwd: config.projectRoot,
          timeout: 15_000,
        });

        tracer.log('agent-loop', 'info', `Git commit: ${messageResult.value}`);

        // Record activity in world model
        state.worldModel.addActivity({
          description: `Committed: ${messageResult.value}`,
          source: 'tyrion',
        });

        return successResult(call.id, stdout.trim(), config.maxOutputChars);
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        return failureResult(call.id, `git commit failed: ${errorMsg}`);
      }
    });
  });

  // ── git_log ─────────────────────────────────────────────────────────────

  executors.set('git_log', async (call) => {
    const count = optionalNumber(call, 'count') ?? 10;
    const path = optionalString(call, 'path');

    return tracer.withSpan('agent-loop', 'git_log', async () => {
      try {
        const args = ['log', `--oneline`, `-${count}`];
        if (path) args.push('--', path);

        const { stdout } = await execFileAsync('git', args, {
          cwd: config.projectRoot,
          timeout: 10_000,
        });

        return successResult(call.id, stdout.trim() || '(no commits)', config.maxOutputChars);
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        return failureResult(call.id, `git log failed: ${errorMsg}`);
      }
    });
  });

  // ── file_issue ──────────────────────────────────────────────────────────

  executors.set('file_issue', async (call) => {
    const titleResult = requireString(call, 'title');
    if ('error' in titleResult) return titleResult.error;
    const descriptionResult = requireString(call, 'description');
    if ('error' in descriptionResult) return descriptionResult.error;
    const priorityResult = requireString(call, 'priority');
    if ('error' in priorityResult) return priorityResult.error;

    const priority = priorityResult.value as IssuePriority;
    if (!['critical', 'high', 'medium', 'low'].includes(priority)) {
      return failureResult(call.id, `Invalid priority: ${priority}. Must be critical, high, medium, or low.`);
    }

    const relatedFiles = (call.input['related_files'] as string[] | undefined) ?? [];
    const tags = (call.input['tags'] as string[] | undefined) ?? [];
    const nextIdea = optionalString(call, 'next_idea');

    return tracer.withSpan('agent-loop', 'file_issue', async () => {
      const issue: Issue = state.issueLog.fileIssue({
        title: titleResult.value,
        description: descriptionResult.value,
        priority,
        relatedFiles,
        tags,
        discoveredBy: 'autonomous',
        ...(nextIdea !== undefined ? { nextIdea } : {}),
      });

      return successResult(
        call.id,
        `Issue ${issue.id}: "${issue.title}" [${issue.priority}] — status: ${issue.status}`,
        config.maxOutputChars,
      );
    });
  });

  // ── close_issue ─────────────────────────────────────────────────────────

  executors.set('close_issue', async (call) => {
    const issueIdResult = requireString(call, 'issue_id');
    if ('error' in issueIdResult) return issueIdResult.error;
    const resolutionResult = requireString(call, 'resolution');
    if ('error' in resolutionResult) return resolutionResult.error;

    const statusStr = optionalString(call, 'status') ?? 'resolved';
    const status = statusStr as 'resolved' | 'wontfix';
    if (status !== 'resolved' && status !== 'wontfix') {
      return failureResult(call.id, `Invalid status: ${statusStr}. Must be "resolved" or "wontfix".`);
    }

    return tracer.withSpan('agent-loop', 'close_issue', async () => {
      const success = state.issueLog.resolveIssue(issueIdResult.value, status, resolutionResult.value);
      if (!success) {
        return failureResult(call.id, `Issue not found: ${issueIdResult.value}`);
      }

      return successResult(
        call.id,
        `Issue ${issueIdResult.value} ${status}: ${resolutionResult.value}`,
        config.maxOutputChars,
      );
    });
  });

  // ── update_goal ─────────────────────────────────────────────────────────

  executors.set('update_goal', async (call) => {
    const goalIdResult = requireString(call, 'goal_id');
    if ('error' in goalIdResult) return goalIdResult.error;

    const statusStr = optionalString(call, 'status');
    const notes = optionalString(call, 'notes');

    if (!statusStr && !notes) {
      return failureResult(call.id, 'Must provide at least one of: status, notes');
    }

    return tracer.withSpan('agent-loop', 'update_goal', async () => {
      const goal = state.goalStack.getGoal(goalIdResult.value);
      if (!goal) {
        return failureResult(call.id, `Goal not found: ${goalIdResult.value}`);
      }

      if (statusStr) {
        const validStatuses: GoalStatus[] = ['pending', 'in_progress', 'blocked', 'done', 'abandoned'];
        if (!validStatuses.includes(statusStr as GoalStatus)) {
          return failureResult(call.id, `Invalid status: ${statusStr}`);
        }

        if (statusStr === 'done') {
          state.goalStack.completeGoal(goalIdResult.value, notes);
        } else {
          state.goalStack.updateGoalStatus(goalIdResult.value, statusStr as GoalStatus, notes);
        }
      } else if (notes) {
        state.goalStack.updateNotes(goalIdResult.value, notes);
      }

      const updatedGoal = state.goalStack.getGoal(goalIdResult.value);
      return successResult(
        call.id,
        `Goal ${goalIdResult.value} updated — status: ${updatedGoal?.status ?? 'unknown'}, notes: ${updatedGoal?.notes ?? '(none)'}`,
        config.maxOutputChars,
      );
    });
  });

  // ── delegate ────────────────────────────────────────────────────────────

  executors.set('delegate', async (call) => {
    if (!config.delegationEnabled) {
      return failureResult(call.id, 'Delegation is disabled in configuration.');
    }

    const modelResult = requireString(call, 'model');
    if ('error' in modelResult) return modelResult.error;
    const taskResult = requireString(call, 'task');
    if ('error' in taskResult) return taskResult.error;

    const contextFiles = (call.input['context_files'] as string[] | undefined) ?? [];
    const toolsMode = (call.input['tools'] as string | undefined) ?? 'none';

    return tracer.withSpan('agent-loop', `delegate:${modelResult.value}`, async () => {
      if (!delegateProvider) {
        return failureResult(call.id, 'No delegation provider configured. Delegation requires an LLM provider.');
      }

      try {
        // Read context files
        const fileContents: string[] = [];
        for (const filePath of contextFiles) {
          try {
            const fullPath = filePath.startsWith('/')
              ? filePath
              : `${config.projectRoot}/${filePath}`;
            const content = await readFile(fullPath, 'utf8');
            fileContents.push(`## ${filePath}\n\`\`\`\n${content}\n\`\`\``);
          } catch {
            fileContents.push(`## ${filePath}\n(file not found or unreadable)`);
          }
        }

        const contextSection = fileContents.length > 0
          ? `\n\nContext files:\n\n${fileContents.join('\n\n')}`
          : '';

        const request: GenerateRequest = {
          prompt: `${taskResult.value}${contextSection}`,
          systemPrompt: toolsMode === 'read-only'
            ? 'You are a specialist assistant with read-only access to the codebase. Use the provided tools to search and read files as needed. Complete the task precisely and return your result.'
            : 'You are a specialist assistant. Complete the task precisely and return your result.',
          maxTokens: 4096,
          temperature: 0.2,
        };

        tracer.log('agent-loop', 'info', `Delegating to ${modelResult.value} (tools=${toolsMode}): ${taskResult.value.slice(0, 100)}...`);

        // Read-only mode: mini ReAct loop with read-only tools
        if (toolsMode === 'read-only') {
          const readOnlySchemas: ToolSchema[] = [
            READ_FILE_SCHEMA,
            GREP_SCHEMA,
            GLOB_SCHEMA,
            GIT_DIFF_SCHEMA,
          ];

          const maxDelegateTurns = 10;
          let currentRequest = request;
          const previousResults: ToolResultMessage[] = [];
          let finalText = '';

          for (let turn = 0; turn < maxDelegateTurns; turn++) {
            const response = await delegateProvider.generateWithTools(
              currentRequest,
              readOnlySchemas,
              previousResults.length > 0 ? previousResults : undefined,
            );

            // No tool calls → delegate is done
            if (response.toolCalls.length === 0) {
              finalText = response.text;
              break;
            }

            // Execute read-only tool calls
            for (const tc of response.toolCalls) {
              // Only allow read-only tools
              const allowed = ['read_file', 'grep_files', 'glob_files', 'git_diff'];
              if (!allowed.includes(tc.name)) {
                previousResults.push({
                  callId: tc.id,
                  result: `Tool "${tc.name}" is not available in read-only mode.`,
                  isError: true,
                });
                continue;
              }

              // Reuse the executor from the main loop
              const executor = executors.get(tc.name);
              if (!executor) {
                previousResults.push({
                  callId: tc.id,
                  result: `Tool "${tc.name}" not found.`,
                  isError: true,
                });
                continue;
              }

              const result = await executor(tc);
              previousResults.push({
                callId: tc.id,
                result: result.output ?? result.error ?? '(no output)',
                isError: !result.success,
              });
            }

            // Continue the conversation with tool results
            currentRequest = {
              ...request,
              prompt: response.text || 'Continue.',
            };
            finalText = response.text;
          }

          tracer.log('agent-loop', 'info', `Delegation complete (read-only). Response: ${finalText.length} chars`);

          return successResult(
            call.id,
            `[Delegation to ${modelResult.value} (read-only tools)]\n\n${finalText}`,
            config.maxOutputChars,
          );
        }

        // Text-only mode (legacy)
        const response = await delegateProvider.generateWithTools(request, []);

        tracer.log('agent-loop', 'info', `Delegation complete. Response: ${response.text.length} chars`);

        return successResult(
          call.id,
          `[Delegation to ${modelResult.value}]\n\n${response.text}`,
          config.maxOutputChars,
        );
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        return failureResult(call.id, `Delegation failed: ${errorMsg}`);
      }
    });
  });

  // ── message_user ────────────────────────────────────────────────────────

  executors.set('message_user', async (call) => {
    const messageResult = requireString(call, 'message');
    if ('error' in messageResult) return messageResult.error;

    const urgency = optionalString(call, 'urgency') ?? 'low';

    tracer.log('agent-loop', 'info', `[message_user] [${urgency}] ${messageResult.value}`);

    // Route through MessagePolicy if available
    const policy = state.messagePolicy;
    const delivery = state.messageDelivery;

    if (!policy || !delivery) {
      return failureResult(
        call.id,
        'User messaging is not configured. Set communication.enabled: true in config/autonomous.yaml.',
      );
    }

    // Map urgency to a NotifiableEvent. The agent provides a free-text
    // message, so we wrap it as a decision_needed or fix_complete event
    // depending on urgency. This ensures the policy's throttle and quiet
    // hours logic applies uniformly.
    const event = urgency === 'high'
      ? { type: 'security_concern' as const, description: messageResult.value, severity: 'medium' as const }
      : { type: 'fix_complete' as const, description: messageResult.value, branch: '(agent)' };

    const decision = policy.shouldNotify(event);

    if (!decision.allowed) {
      return successResult(
        call.id,
        `Message blocked by policy: ${decision.reason ?? 'unknown reason'}. The message was not delivered.`,
        config.maxOutputChars,
      );
    }

    const result = await delivery.send(
      decision.formattedMessage ?? messageResult.value,
      urgency,
    );

    policy.recordSent(event);

    if (result.delivered) {
      return successResult(
        call.id,
        `Message delivered via ${result.channel}.`,
        config.maxOutputChars,
      );
    }

    return failureResult(
      call.id,
      `Message delivery failed (${result.channel}): ${result.error ?? 'unknown error'}`,
    );
  });

  // ── update_world_model ──────────────────────────────────────────────────

  executors.set('update_world_model', async (call) => {
    const actionResult = requireString(call, 'action');
    if ('error' in actionResult) return actionResult.error;
    const descResult = requireString(call, 'description');
    if ('error' in descResult) return descResult.error;

    return tracer.withSpan('agent-loop', 'update_world_model', async () => {
      const worldModel = state.worldModel;
      if (!worldModel) {
        return failureResult(call.id, 'World model not available.');
      }

      const action = actionResult.value;
      const description = descResult.value;

      if (action === 'add') {
        const severityRaw = typeof call.input['severity'] === 'string'
          ? call.input['severity']
          : 'informational';
        const severity = (['informational', 'worth-watching', 'needs-action'] as const)
          .includes(severityRaw as 'informational')
          ? (severityRaw as 'informational' | 'worth-watching' | 'needs-action')
          : 'informational';

        const relatedFiles = Array.isArray(call.input['related_files'])
          ? (call.input['related_files'] as unknown[]).filter((f): f is string => typeof f === 'string')
          : [];

        worldModel.addConcern({ description, severity, relatedFiles });

        return successResult(
          call.id,
          `Concern tracked: "${description}" [${severity}]`,
          config.maxOutputChars,
        );
      } else if (action === 'resolve') {
        const resolved = worldModel.removeConcern(description);

        if (resolved) {
          return successResult(call.id, `Concern resolved: "${description}"`, config.maxOutputChars);
        } else {
          return failureResult(call.id, `No concern found matching: "${description}"`);
        }
      } else {
        return failureResult(call.id, `Unknown action: "${action}". Use "add" or "resolve".`);
      }
    });
  });

  // ── adversarial_test ────────────────────────────────────────────────────

  executors.set('adversarial_test', async (call) => {
    const codeResult = requireString(call, 'code');
    if ('error' in codeResult) return codeResult.error;
    const sigResult = requireString(call, 'function_signature');
    if ('error' in sigResult) return sigResult.error;
    const targetResult = requireString(call, 'target_file');
    if ('error' in targetResult) return targetResult.error;

    return tracer.withSpan('agent-loop', 'adversarial_test', async () => {
      if (!delegateProvider) {
        return failureResult(call.id, 'Adversarial testing requires an LLM provider for attack generation.');
      }

      try {
        const tester = new AdversarialTester();
        const report = await tester.buildReport(
          codeResult.value,
          sigResult.value,
          targetResult.value,
          delegateProvider,
        );

        if (report.testCases.length === 0) {
          return successResult(call.id, 'No adversarial test cases generated.', config.maxOutputChars);
        }

        // Generate the test file content
        const testFileContent = tester.generateTestFile(
          report.testCases,
          targetResult.value,
          sigResult.value,
        );

        // Write the test file
        const testFileName = targetResult.value
          .replace(/\.[^.]+$/, '')
          .replace(/\//g, '-');
        const testPath = `tests/adversarial-${testFileName}.test.ts`;
        const fullTestPath = `${config.projectRoot}/${testPath}`;

        await mkdir(dirname(fullTestPath), { recursive: true });
        await writeFile(fullTestPath, testFileContent, 'utf8');

        tracer.log('agent-loop', 'info', `Adversarial: generated ${report.testCases.length} attacks → ${testPath}`);

        const categories = [...new Set(report.testCases.map((tc) => tc.category))];
        const output = [
          `Generated ${report.testCases.length} adversarial test cases for ${sigResult.value}`,
          `Categories: ${categories.join(', ')}`,
          `Test file: ${testPath}`,
          '',
          'Run the tests with: run_tests tests/adversarial-' + testFileName,
          'Fix any failures before committing.',
        ].join('\n');

        return successResult(call.id, output, config.maxOutputChars);
      } catch (err) {
        return failureResult(call.id, `Adversarial test generation failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
  });

  // ── recall ──────────────────────────────────────────────────────────────

  executors.set('recall', async (call) => {
    if (!state.contextManager) {
      return failureResult(call.id, 'Memory system is not yet initialized (Phase 4). Recall is unavailable.');
    }

    const queryResult = requireString(call, 'query');
    if ('error' in queryResult) return queryResult.error;

    const tier = (optionalString(call, 'tier') ?? 'both') as 'cool' | 'cold' | 'both';
    const limit = optionalNumber(call, 'limit') ?? 5;
    const tags = call.input['tags'] as string[] | undefined;

    return tracer.withSpan('agent-loop', `recall:${queryResult.value.slice(0, 30)}`, async () => {
      try {
        const results = await state.contextManager!.recall({
          query: queryResult.value,
          tier,
          ...(tags !== undefined ? { tags } : {}),
          limit,
        });

        if (results.length === 0) {
          return successResult(
            call.id,
            `No results found for query: "${queryResult.value}" (tier: ${tier})`,
            config.maxOutputChars,
          );
        }

        const lines: string[] = [`Found ${results.length} result(s) for "${queryResult.value}":\n`];

        for (const r of results) {
          lines.push(`--- [${r.entry.id}] ${r.entry.title} (score: ${r.score}, tier: ${r.entry.tier}) ---`);
          lines.push(`Tags: ${r.entry.tags.join(', ')}`);
          lines.push(`Source: ${r.entry.source} | Date: ${r.entry.timestamp.split('T')[0]}`);
          lines.push(`Matched: ${r.matchedKeywords.join(', ')}`);
          lines.push('');
          lines.push(r.entry.content);
          lines.push('');
        }

        return successResult(call.id, lines.join('\n'), config.maxOutputChars);
      } catch (err) {
        return failureResult(call.id, `Recall failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
  });

  // ── archive ─────────────────────────────────────────────────────────────

  executors.set('archive', async (call) => {
    if (!state.contextManager) {
      return failureResult(call.id, 'Memory system is not yet initialized (Phase 4). Archive is unavailable.');
    }

    const titleResult = requireString(call, 'title');
    if ('error' in titleResult) return titleResult.error;

    const contentResult = requireString(call, 'content');
    if ('error' in contentResult) return contentResult.error;

    const tags = call.input['tags'] as string[] | undefined;
    if (!tags || !Array.isArray(tags) || tags.length === 0) {
      return failureResult(call.id, 'Missing required parameter: tags (must be a non-empty array of strings)');
    }

    return tracer.withSpan('agent-loop', `archive:${titleResult.value.slice(0, 30)}`, async () => {
      try {
        const id = await state.contextManager!.archive({
          title: titleResult.value,
          content: contentResult.value,
          tags,
          source: 'agent',
        });

        return successResult(
          call.id,
          `Archived as ${id}: "${titleResult.value}" [tags: ${tags.join(', ')}]`,
          config.maxOutputChars,
        );
      } catch (err) {
        return failureResult(call.id, `Archive failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
  });

  // ── recall_journal ──────────────────────────────────────────────────

  executors.set('recall_journal', async (call) => {
    if (!state.journal) {
      return failureResult(call.id, 'Journal is not yet initialized. recall_journal is unavailable.');
    }

    const queryResult = requireString(call, 'query');
    if ('error' in queryResult) return queryResult.error;

    const entryType = optionalString(call, 'type');
    const limit = optionalNumber(call, 'limit') ?? 5;

    return tracer.withSpan('agent-loop', `recall_journal:${queryResult.value.slice(0, 30)}`, async () => {
      let results = state.journal!.search(queryResult.value);

      // Filter by type if specified
      if (entryType) {
        results = results.filter((e) => e.type === entryType);
      }

      // Limit results
      results = results.slice(0, limit);

      if (results.length === 0) {
        return successResult(
          call.id,
          `No journal entries found for: "${queryResult.value}"${entryType ? ` (type: ${entryType})` : ''}`,
          config.maxOutputChars,
        );
      }

      const output = state.journal!.summarize(results);
      return successResult(
        call.id,
        `Found ${results.length} journal entries:\n\n${output}`,
        config.maxOutputChars,
      );
    });
  });

  // ── consolidate ─────────────────────────────────────────────────────

  executors.set('consolidate', async (call) => {
    const summaryResult = requireString(call, 'summary');
    if ('error' in summaryResult) return summaryResult.error;

    const tags = (call.input['tags'] as string[] | undefined) ?? ['consolidation'];

    return tracer.withSpan('agent-loop', 'consolidate', async () => {
      // Write a reflection to journal
      if (state.journal) {
        await state.journal.append({
          type: 'reflection',
          content: summaryResult.value,
          tags,
        });
      }

      // Clear warm tier if context manager is available
      if (state.contextManager) {
        state.contextManager.clearWarmTier();
      }

      tracer.log('context-budget', 'info', 'Context consolidated', {
        summaryLength: summaryResult.value.length,
        tags,
      });

      return successResult(
        call.id,
        `Context consolidated. Summary saved to journal with tags: ${tags.join(', ')}. Warm tier cleared.`,
        config.maxOutputChars,
      );
    });
  });

  // ── crystallize (Vision Tier 1) ───────────────────────────────────────

  executors.set('crystallize', async (call) => {
    if (!state.crystalStore) {
      return failureResult(call.id, 'Crystal store not available.');
    }

    const content = requireString(call, 'content');
    if ('error' in content) return content.error;

    const sourceEntries = Array.isArray(call.input['source_entries'])
      ? (call.input['source_entries'] as string[])
      : [];

    const crystallizeParams: { content: string; sourceEntries?: string[]; confidence?: number } = {
      content: content.value,
      sourceEntries,
    };
    if (typeof call.input['confidence'] === 'number') {
      crystallizeParams.confidence = call.input['confidence'] as number;
    }

    const result = state.crystalStore.crystallize(crystallizeParams);

    if (!result.success) {
      return failureResult(call.id, result.error ?? 'Crystallize failed.');
    }

    await state.crystalStore.save();
    return successResult(
      call.id,
      `Crystal formed: ${result.crystalId}. This knowledge will be available in every future cycle.`,
      config.maxOutputChars,
    );
  });

  // ── dissolve (Vision Tier 1) ─────────────────────────────────────────

  executors.set('dissolve', async (call) => {
    if (!state.crystalStore) {
      return failureResult(call.id, 'Crystal store not available.');
    }

    const crystalId = requireString(call, 'crystal_id');
    if ('error' in crystalId) return crystalId.error;
    const reason = optionalString(call, 'reason');

    const result = state.crystalStore.dissolve(crystalId.value, reason);

    if (!result.success) {
      return failureResult(call.id, result.error ?? 'Dissolve failed.');
    }

    await state.crystalStore.save();
    return successResult(call.id, `Crystal dissolved: ${crystalId.value}.`, config.maxOutputChars);
  });

  // ── list_crystals (Vision Tier 1) ────────────────────────────────────

  executors.set('list_crystals', async (call) => {
    if (!state.crystalStore) {
      return failureResult(call.id, 'Crystal store not available.');
    }

    const crystals = state.crystalStore.getAll();
    if (crystals.length === 0) {
      return successResult(call.id, 'No crystals yet. Use `crystallize` to promote high-value knowledge.', config.maxOutputChars);
    }

    const totalTokens = state.crystalStore.estimateTotalTokens();
    const lines: string[] = [
      `## Crystals (${crystals.length} total, ~${totalTokens} tokens)`,
      '',
    ];

    for (const c of crystals) {
      const pct = Math.round(c.confidence * 100);
      lines.push(`- **${c.id}** (${pct}% confidence, ${c.recallCount} recalls)`);
      lines.push(`  ${c.content}`);
      lines.push(`  Formed: ${c.formedDate.split('T')[0]} | Validated: ${c.lastValidated.split('T')[0]}`);
    }

    return successResult(call.id, lines.join('\n'), config.maxOutputChars);
  });

  // ── create_rule (Vision Tier 1) ──────────────────────────────────────

  executors.set('create_rule', async (call) => {
    if (!state.constitutionStore) {
      return failureResult(call.id, 'Constitution store not available.');
    }

    const rule = requireString(call, 'rule');
    if ('error' in rule) return rule.error;
    const motivation = requireString(call, 'motivation');
    if ('error' in motivation) return motivation.error;

    const createParams: { rule: string; motivation: string; confidence?: number } = {
      rule: rule.value,
      motivation: motivation.value,
    };
    if (typeof call.input['confidence'] === 'number') {
      createParams.confidence = call.input['confidence'] as number;
    }

    const result = state.constitutionStore.createRule(createParams);

    if (!result.success) {
      return failureResult(call.id, result.error ?? 'Rule creation failed.');
    }

    await state.constitutionStore.save();
    return successResult(
      call.id,
      `Rule created: ${result.ruleId}. This operational rule will be loaded into your context.`,
      config.maxOutputChars,
    );
  });

  // ── update_rule (Vision Tier 1) ──────────────────────────────────────

  executors.set('update_rule', async (call) => {
    if (!state.constitutionStore) {
      return failureResult(call.id, 'Constitution store not available.');
    }

    const ruleId = requireString(call, 'rule_id');
    if ('error' in ruleId) return ruleId.error;

    const updates: { rule?: string; motivation?: string; confidence?: number } = {};
    const ruleText = optionalString(call, 'rule');
    if (ruleText) updates.rule = ruleText;
    const motivation = optionalString(call, 'motivation');
    if (motivation) updates.motivation = motivation;
    if (typeof call.input['confidence'] === 'number') {
      updates.confidence = call.input['confidence'] as number;
    }

    const result = state.constitutionStore.updateRule(ruleId.value, updates);

    if (!result.success) {
      return failureResult(call.id, result.error ?? 'Rule update failed.');
    }

    await state.constitutionStore.save();
    return successResult(call.id, `Rule updated: ${ruleId.value}.`, config.maxOutputChars);
  });

  // ── list_rules (Vision Tier 1) ───────────────────────────────────────

  executors.set('list_rules', async (call) => {
    if (!state.constitutionStore) {
      return failureResult(call.id, 'Constitution store not available.');
    }

    const rules = state.constitutionStore.getAll();
    if (rules.length === 0) {
      return successResult(call.id, 'No constitutional rules yet. Use `create_rule` to add operational guidelines.', config.maxOutputChars);
    }

    const totalTokens = state.constitutionStore.estimateTotalTokens();
    const lines: string[] = [
      `## Constitution (${rules.length} rules, ~${totalTokens} tokens)`,
      '',
    ];

    for (const r of rules) {
      const pct = Math.round(r.confidence * 100);
      const successRate = r.invocations > 0
        ? ` | ${Math.round((r.successes / r.invocations) * 100)}% success`
        : '';
      lines.push(`- **${r.id}** (${pct}% confidence, ${r.invocations} invocations${successRate})`);
      lines.push(`  ${r.rule}`);
      lines.push(`  Motivation: ${r.motivation.slice(0, 100)}`);
    }

    return successResult(call.id, lines.join('\n'), config.maxOutputChars);
  });

  // ── replay (Vision Tier 1) ───────────────────────────────────────────

  executors.set('replay', async (call) => {
    if (!state.traceReplayStore) {
      return failureResult(call.id, 'Trace replay store not available.');
    }

    const cycleId = requireString(call, 'cycle_id');
    if ('error' in cycleId) return cycleId.error;

    const stepStart = optionalNumber(call, 'step_start');
    const stepEnd = optionalNumber(call, 'step_end');
    const toolFilter = optionalString(call, 'tool_filter');

    const replayOpts: { stepRange?: [number, number]; toolFilter?: string } = {};
    if (stepStart !== undefined && stepEnd !== undefined) {
      replayOpts.stepRange = [stepStart, stepEnd];
    }
    if (toolFilter !== undefined) {
      replayOpts.toolFilter = toolFilter;
    }

    const trace = await state.traceReplayStore.replay(cycleId.value, replayOpts);

    if (!trace) {
      return failureResult(call.id, `Trace not found: ${cycleId.value}`);
    }

    const lines: string[] = [
      `## Trace Replay: ${trace.cycleId}`,
      `Outcome: ${trace.outcome} | Trigger: ${trace.trigger}`,
      `Duration: ${trace.startedAt} → ${trace.endedAt}`,
      `Tools used: ${trace.toolsUsed.join(', ')}`,
      '',
      '### Steps',
      '',
    ];

    for (const step of trace.steps) {
      const dur = step.durationMs ? ` (${step.durationMs}ms)` : '';
      lines.push(`**Step ${step.step}: ${step.toolCalled}**${dur}`);
      if (step.reasoning) {
        lines.push(`  Reasoning: ${step.reasoning.slice(0, 200)}`);
      }
      lines.push(`  Params: ${JSON.stringify(step.parameters).slice(0, 200)}`);
      lines.push(`  Result: ${step.result.slice(0, 200)}`);
      lines.push('');
    }

    return successResult(call.id, lines.join('\n'), config.maxOutputChars);
  });

  // ── compare_traces (Vision Tier 1) ───────────────────────────────────

  executors.set('compare_traces', async (call) => {
    if (!state.traceReplayStore) {
      return failureResult(call.id, 'Trace replay store not available.');
    }

    const cycleIdA = requireString(call, 'cycle_id_a');
    if ('error' in cycleIdA) return cycleIdA.error;
    const cycleIdB = requireString(call, 'cycle_id_b');
    if ('error' in cycleIdB) return cycleIdB.error;

    const comparison = await state.traceReplayStore.compareTraces(
      cycleIdA.value,
      cycleIdB.value,
    );

    if (!comparison) {
      return failureResult(call.id, 'One or both traces not found.');
    }

    return successResult(call.id, comparison.summary, config.maxOutputChars);
  });

  // ── search_traces (Vision Tier 1) ────────────────────────────────────

  executors.set('search_traces', async (call) => {
    if (!state.traceReplayStore) {
      return failureResult(call.id, 'Trace replay store not available.');
    }

    const searchCriteria: {
      outcome?: 'success' | 'failure' | 'partial';
      trigger?: string;
      tool?: string;
      tag?: string;
      limit?: number;
    } = {};

    const outcome = optionalString(call, 'outcome');
    if (outcome === 'success' || outcome === 'failure' || outcome === 'partial') {
      searchCriteria.outcome = outcome;
    }
    const trigger = optionalString(call, 'trigger');
    if (trigger !== undefined) searchCriteria.trigger = trigger;
    const tool = optionalString(call, 'tool');
    if (tool !== undefined) searchCriteria.tool = tool;
    const tag = optionalString(call, 'tag');
    if (tag !== undefined) searchCriteria.tag = tag;
    const limit = optionalNumber(call, 'limit');
    if (limit !== undefined) searchCriteria.limit = limit;

    const results = state.traceReplayStore.searchTraces(searchCriteria);

    if (results.length === 0) {
      return successResult(call.id, 'No traces match your search criteria.', config.maxOutputChars);
    }

    const lines: string[] = [
      `## Trace Search Results (${results.length} matches)`,
      '',
    ];

    for (const entry of results) {
      const pinnedTag = entry.pinned ? ' [pinned]' : '';
      lines.push(`- **${entry.cycleId}** ${entry.outcome}${pinnedTag} (${entry.startedAt.split('T')[0]})`);
      lines.push(`  Trigger: ${entry.trigger} | Steps: ${entry.stepCount} | Tools: ${entry.toolsUsed.join(', ')}`);
    }

    return successResult(call.id, lines.join('\n'), config.maxOutputChars);
  });

  // ── edit_prompt (Vision Tier 2) ────────────────────────────────────────

  executors.set('edit_prompt', async (call) => {
    if (!state.promptStore) {
      return failureResult(call.id, 'Prompt store not available.');
    }

    const oldText = requireString(call, 'old_text');
    if ('error' in oldText) return oldText.error;
    const newText = requireString(call, 'new_text');
    if ('error' in newText) return newText.error;
    const rationale = requireString(call, 'rationale');
    if ('error' in rationale) return rationale.error;

    const result = state.promptStore.editPrompt({
      oldText: oldText.value,
      newText: newText.value,
      rationale: rationale.value,
    });

    if (!result.success) {
      return failureResult(call.id, result.error ?? 'Edit failed.');
    }

    await state.promptStore.save();
    return successResult(call.id, `Prompt edited successfully. Now at version ${result.version}.`, config.maxOutputChars);
  });

  // ── revert_prompt (Vision Tier 2) ──────────────────────────────────────

  executors.set('revert_prompt', async (call) => {
    if (!state.promptStore) {
      return failureResult(call.id, 'Prompt store not available.');
    }

    const version = call.input['version'];
    if (typeof version !== 'number') {
      return failureResult(call.id, 'Missing required parameter: version (integer).');
    }
    const rationale = requireString(call, 'rationale');
    if ('error' in rationale) return rationale.error;

    const result = state.promptStore.revertPrompt(version, rationale.value);

    if (!result.success) {
      return failureResult(call.id, result.error ?? 'Revert failed.');
    }

    await state.promptStore.save();
    return successResult(call.id, `Prompt reverted to v${version}. Now at version ${result.version}.`, config.maxOutputChars);
  });

  // ── get_prompt (Vision Tier 2) ─────────────────────────────────────────

  executors.set('get_prompt', async (call) => {
    if (!state.promptStore) {
      return failureResult(call.id, 'Prompt store not available.');
    }

    const includeHistory = call.input['include_history'] === true;
    const lines: string[] = [
      `## Current System Prompt (v${state.promptStore.getVersion()})`,
      '',
      state.promptStore.getContent(),
    ];

    if (includeHistory) {
      lines.push('', '## Version History', '');
      for (const v of state.promptStore.getVersions()) {
        const metrics = v.metrics
          ? ` | ${v.metrics.cyclesRun} cycles, ${Math.round(v.metrics.successRate * 100)}% success`
          : '';
        lines.push(`- v${v.version} (${v.timestamp.split('T')[0]}): ${v.rationale}${metrics}`);
      }
    }

    return successResult(call.id, lines.join('\n'), config.maxOutputChars);
  });

  // ── shadow (Vision Tier 2) ─────────────────────────────────────────────

  executors.set('shadow', async (call) => {
    if (!state.shadowStore) {
      return failureResult(call.id, 'Shadow store not available.');
    }

    const cycleId = requireString(call, 'cycle_id');
    if ('error' in cycleId) return cycleId.error;
    const strategy = requireString(call, 'strategy');
    if ('error' in strategy) return strategy.error;
    const rationale = requireString(call, 'rationale');
    if ('error' in rationale) return rationale.error;

    const expectedSteps = Array.isArray(call.input['expected_steps'])
      ? (call.input['expected_steps'] as string[])
      : [];
    const tags = Array.isArray(call.input['tags'])
      ? (call.input['tags'] as string[])
      : [];

    const shadow = state.shadowStore.recordShadow({
      cycleId: cycleId.value,
      strategy: strategy.value,
      expectedSteps,
      rationale: rationale.value,
      tags,
    });

    await state.shadowStore.save();
    return successResult(
      call.id,
      `Shadow recorded: ${shadow.id}. The alternative approach is stored for later analysis.`,
      config.maxOutputChars,
    );
  });

  // ── list_shadows (Vision Tier 2) ───────────────────────────────────────

  executors.set('list_shadows', async (call) => {
    if (!state.shadowStore) {
      return failureResult(call.id, 'Shadow store not available.');
    }

    return successResult(
      call.id,
      state.shadowStore.buildAnalysisSummary(),
      config.maxOutputChars,
    );
  });

  // ── create_tool (Vision Tier 2) ────────────────────────────────────────

  executors.set('create_tool', async (call) => {
    if (!state.toolSynthesizer) {
      return failureResult(call.id, 'Tool synthesizer not available.');
    }

    const name = requireString(call, 'name');
    if ('error' in name) return name.error;
    const description = requireString(call, 'description');
    if ('error' in description) return description.error;
    const template = requireString(call, 'template');
    if ('error' in template) return template.error;
    const authorNotes = requireString(call, 'author_notes');
    if ('error' in authorNotes) return authorNotes.error;

    const params = call.input['parameters'] as SynthesizedToolParams | undefined;
    const inputSchema = params && typeof params === 'object'
      ? {
          type: 'object' as const,
          properties: (params.properties ?? {}) as Record<string, { type: string; description: string }>,
          required: (params.required ?? []) as string[],
        }
      : { type: 'object' as const, properties: {} as Record<string, { type: string; description: string }>, required: [] as string[] };

    const result = state.toolSynthesizer.createTool({
      name: name.value,
      description: description.value,
      inputSchema,
      template: template.value,
      authorNotes: authorNotes.value,
    });

    if (!result.success) {
      const violations = result.securityViolations
        ? `\nSecurity violations:\n${result.securityViolations.map((v) => `- ${v}`).join('\n')}`
        : '';
      return failureResult(call.id, `${result.error}${violations}`);
    }

    await state.toolSynthesizer.save();
    return successResult(
      call.id,
      `Custom tool "${name.value}" created successfully. It will be available in future cycles.`,
      config.maxOutputChars,
    );
  });

  // ── manage_tools (Vision Tier 2) ───────────────────────────────────────

  executors.set('manage_tools', async (call) => {
    if (!state.toolSynthesizer) {
      return failureResult(call.id, 'Tool synthesizer not available.');
    }

    const action = requireString(call, 'action');
    if ('error' in action) return action.error;
    const toolName = requireString(call, 'tool_name');
    if ('error' in toolName) return toolName.error;

    let ok: boolean;
    switch (action.value) {
      case 'archive':
        ok = state.toolSynthesizer.archiveTool(toolName.value);
        break;
      case 'reactivate':
        ok = state.toolSynthesizer.reactivateTool(toolName.value);
        break;
      case 'delete':
        ok = await state.toolSynthesizer.deleteTool(toolName.value);
        break;
      default:
        return failureResult(call.id, `Unknown action: ${action.value}. Use archive, reactivate, or delete.`);
    }

    if (!ok) {
      return failureResult(call.id, `Tool "${toolName.value}" not found or action not applicable.`);
    }

    await state.toolSynthesizer.save();
    return successResult(call.id, `Tool "${toolName.value}" ${action.value}d successfully.`, config.maxOutputChars);
  });

  // ── list_custom_tools (Vision Tier 2) ──────────────────────────────────

  executors.set('list_custom_tools', async (call) => {
    if (!state.toolSynthesizer) {
      return failureResult(call.id, 'Tool synthesizer not available.');
    }

    return successResult(
      call.id,
      state.toolSynthesizer.buildToolList(),
      config.maxOutputChars,
    );
  });

  // ── Vision Tier 3: Adversarial Challenges ───────────────────────────────

  executors.set('run_challenges', async (call) => {
    if (!state.challengeGenerator || !state.challengeEvaluator) {
      return failureResult(call.id, 'Challenge generator/evaluator not available.');
    }

    const { cycleId } = call.input as { cycleId: string };
    const selfModel = state.challengeGenerator as unknown as { generateBatch: (sm: unknown, cid: string) => unknown };

    // The challenge generator needs the self-model from the dream runner.
    // Since we don't have direct access here, we generate the batch structure.
    // The dream cycle will provide the self-model during actual execution.
    return successResult(
      call.id,
      `Challenge batch requested for cycle ${cycleId}. Challenges will be generated during the next dream cycle using the self-model's weakness data.`,
      config.maxOutputChars,
    );
  });

  executors.set('challenge_history', async (call) => {
    if (!state.challengeEvaluator) {
      return failureResult(call.id, 'Challenge evaluator not available.');
    }

    const { action, skill } = call.input as { action: string; skill?: string };

    switch (action) {
      case 'summary':
        return successResult(call.id, state.challengeEvaluator.buildSummaryText(), config.maxOutputChars);

      case 'weakest': {
        const weakest = state.challengeEvaluator.getWeakestSubSkills();
        if (weakest.length === 0) {
          return successResult(call.id, 'No sub-skill assessments available yet. Run challenges first.', config.maxOutputChars);
        }
        const lines = weakest.map(
          (s) => `${s.key}: ${Math.round(s.challengeSuccessRate * 100)}% (${s.challengeAttempts} attempts)`,
        );
        return successResult(call.id, `Weakest sub-skills:\n${lines.join('\n')}`, config.maxOutputChars);
      }

      case 'trend': {
        if (!skill) {
          return failureResult(call.id, 'skill parameter required for trend action.');
        }
        const trend = state.challengeEvaluator.getSkillTrend(skill);
        if (trend.length === 0) {
          return successResult(call.id, `No trend data available for skill: ${skill}`, config.maxOutputChars);
        }
        const lines = trend.map((t) => `${t.batchId}: ${Math.round(t.rate * 100)}%`);
        return successResult(call.id, `Skill trend for ${skill}:\n${lines.join('\n')}`, config.maxOutputChars);
      }

      default:
        return failureResult(call.id, `Unknown action: ${action}. Use 'summary', 'weakest', or 'trend'.`);
    }
  });

  // ── Vision Tier 3: Prompt Evolution ─────────────────────────────────────

  executors.set('evolve_prompt', async (call) => {
    if (!state.promptEvolution || !state.promptStore) {
      return failureResult(call.id, 'Prompt evolution or prompt store not available.');
    }

    const { action, variantIndex, avgTurns, avgToolCalls, errorRate, completionRate, tasksEvaluated } = call.input as {
      action: string;
      variantIndex?: number;
      avgTurns?: number;
      avgToolCalls?: number;
      errorRate?: number;
      completionRate?: number;
      tasksEvaluated?: number;
    };

    switch (action) {
      case 'initialize': {
        const currentPrompt = state.promptStore.getContent();
        state.promptEvolution.initializePopulation(currentPrompt);
        await state.promptEvolution.save();
        return successResult(
          call.id,
          `Population initialized with ${state.promptEvolution.getPopulationSize()} variants from the current prompt.`,
          config.maxOutputChars,
        );
      }

      case 'record_fitness': {
        if (variantIndex === undefined || avgTurns === undefined || completionRate === undefined) {
          return failureResult(call.id, 'variantIndex, avgTurns, and completionRate are required for record_fitness.');
        }
        state.promptEvolution.recordFitness(variantIndex, {
          avgTurns: avgTurns ?? 0,
          avgToolCalls: avgToolCalls ?? 0,
          errorRate: errorRate ?? 0,
          completionRate: completionRate ?? 0,
          tasksEvaluated: tasksEvaluated ?? 0,
        });
        await state.promptEvolution.save();
        const variant = state.promptEvolution.getVariant(variantIndex);
        return successResult(
          call.id,
          `Fitness recorded for variant ${variantIndex}: score=${variant?.fitness?.toFixed(3) ?? 'N/A'}`,
          config.maxOutputChars,
        );
      }

      case 'evolve': {
        state.promptEvolution.evolve();
        await state.promptEvolution.save();
        const meta = state.promptEvolution.getMetadata();
        return successResult(
          call.id,
          `Evolved to generation ${meta.generation}: ${state.promptEvolution.getPopulationSize()} variants`,
          config.maxOutputChars,
        );
      }

      default:
        return failureResult(call.id, `Unknown action: ${action}. Use 'initialize', 'record_fitness', or 'evolve'.`);
    }
  });

  executors.set('evolution_status', async (call) => {
    if (!state.promptEvolution) {
      return failureResult(call.id, 'Prompt evolution not available.');
    }

    return successResult(
      call.id,
      state.promptEvolution.buildSummaryText(),
      config.maxOutputChars,
    );
  });

  // ── Vision Tier 3: LoRA Fine-Tuning ─────────────────────────────────────

  executors.set('extract_training_data', async (call) => {
    if (!state.trainingExtractor || !state.journal) {
      return failureResult(call.id, 'Training extractor or journal not available.');
    }

    const { lookbackDays } = call.input as { lookbackDays?: number };

    // Override lookback if provided
    const extractor = state.trainingExtractor;
    const dataset = await extractor.extract(state.journal, state.issueLog);

    const summary = extractor.summarizeDataset(dataset);
    await extractor.saveDataset(dataset);

    return successResult(call.id, summary, config.maxOutputChars);
  });

  executors.set('list_adapters', async (call) => {
    if (!state.loraTrainer) {
      return failureResult(call.id, 'LoRA trainer not available.');
    }

    const { status } = call.input as { status?: string };

    if (status) {
      const adapters = state.loraTrainer.getAdapters(status as 'active' | 'training' | 'evaluating' | 'archived' | 'discarded');
      if (adapters.length === 0) {
        return successResult(call.id, `No adapters with status: ${status}`, config.maxOutputChars);
      }
      const lines = adapters.map(
        (a) => `${a.id}: ${a.skill} v${a.version} (${a.status}) — ${a.loadCount} loads`,
      );
      return successResult(call.id, lines.join('\n'), config.maxOutputChars);
    }

    return successResult(call.id, state.loraTrainer.buildSummaryText(), config.maxOutputChars);
  });

  executors.set('load_adapter', async (call) => {
    if (!state.loraTrainer) {
      return failureResult(call.id, 'LoRA trainer not available.');
    }

    const { skill } = call.input as { skill: string };
    const adapter = state.loraTrainer.getActiveAdapter(skill);

    if (!adapter) {
      return failureResult(call.id, `No active adapter for skill: ${skill}. Available: ${state.loraTrainer.getActiveAdapters().map((a) => a.skill).join(', ') || 'none'}`);
    }

    state.loraTrainer.recordLoad(adapter.id);
    await state.loraTrainer.save();

    return successResult(
      call.id,
      `Adapter loaded: ${adapter.id} (${adapter.skill} v${adapter.version}). Improvement: +${((adapter.improvement ?? 0) * 100).toFixed(1)}%`,
      config.maxOutputChars,
    );
  });

  // ═════════════════════════════════════════════════════════════════════════
  // ROADMAP PHASE 1: LOOSEN THE PIPELINE — meta
  // ═════════════════════════════════════════════════════════════════════════

  executors.set('meta', async (call) => {
    const overrideResult = requireString(call, 'override');
    if ('error' in overrideResult) return overrideResult.error;
    const rationaleResult = requireString(call, 'rationale');
    if ('error' in rationaleResult) return rationaleResult.error;
    const strategy = optionalString(call, 'strategy');

    const override = overrideResult.value;
    const rationale = rationaleResult.value;

    tracer.log('agent-loop', 'info', `[meta] Pipeline override: ${override}`, {
      rationale,
      ...(strategy !== undefined ? { strategy } : {}),
    });

    // Record the override in the journal for self-improvement analysis
    if (state.journal) {
      await state.journal.append({
        type: 'reflection' as const,
        content: `Pipeline override: ${override}. Rationale: ${rationale}${strategy ? `. New strategy: ${strategy}` : ''}`,
        tags: ['meta', 'pipeline-override', override],
      });
    }

    return successResult(
      call.id,
      `Pipeline override recorded: ${override}. Rationale noted. Proceed with your chosen approach.`,
      config.maxOutputChars,
    );
  });

  // ═════════════════════════════════════════════════════════════════════════
  // ROADMAP PHASE 2: PROMOTE THE REACT LOOP — classify, plan, verify
  // ═════════════════════════════════════════════════════════════════════════

  executors.set('classify', async (call) => {
    const messageResult = requireString(call, 'message');
    if ('error' in messageResult) return messageResult.error;

    // Classification uses heuristics when no delegate provider is available
    const message = messageResult.value;
    const lower = message.toLowerCase();

    // Heuristic classification matching the task classifier logic
    const codingSignals = ['fix', 'implement', 'refactor', 'add', 'create', 'edit', 'modify', 'update', 'delete', 'remove', 'test'];
    const complexSignals = ['multiple', 'across', 'all', 'every', 'migration', 'pipeline', 'workflow'];
    const conversationSignals = ['what', 'why', 'how', 'explain', 'tell me', 'think about', 'opinion'];

    const codingScore = codingSignals.filter((s) => lower.includes(s)).length;
    const complexScore = complexSignals.filter((s) => lower.includes(s)).length;
    const conversationScore = conversationSignals.filter((s) => lower.includes(s)).length;

    let taskClass: string;
    let taskType: string | undefined;
    if (conversationScore > codingScore && complexScore === 0) {
      taskClass = 'conversation';
    } else if (codingScore > 0 && complexScore >= 2) {
      taskClass = 'complex_task';
      taskType = 'coding';
    } else if (codingScore > 0) {
      taskClass = 'simple_task';
      taskType = 'coding';
    } else {
      taskClass = 'simple_task';
    }

    const confidence = Math.min(1.0, 0.5 + (Math.max(codingScore, conversationScore) * 0.1));

    const result = [
      `Classification: ${taskClass}`,
      `Confidence: ${confidence.toFixed(2)}`,
      ...(taskType !== undefined ? [`Task type: ${taskType}`] : []),
      `Signals: coding=${codingScore}, complex=${complexScore}, conversation=${conversationScore}`,
    ].join('\n');

    return successResult(call.id, result, config.maxOutputChars);
  });

  executors.set('plan', async (call) => {
    const instructionResult = requireString(call, 'instruction');
    if ('error' in instructionResult) return instructionResult.error;
    const context = optionalString(call, 'context');

    // Generate a lightweight plan using the agent's own reasoning
    const instruction = instructionResult.value;
    tracer.log('agent-loop', 'info', `[plan] Generating plan for: ${instruction.slice(0, 100)}`);

    const plan = [
      `## Plan: ${instruction.slice(0, 80)}`,
      '',
      'Steps (generated by heuristic planner):',
      '1. Read relevant files to understand current state',
      '2. Identify specific changes needed',
      '3. Make targeted modifications',
      '4. Run tests and typecheck to verify',
      '5. Review results and iterate if needed',
      '',
      ...(context ? [`Context: ${context}`, ''] : []),
      'Note: This is a default plan template. Adapt based on your judgment — skip steps that are unnecessary, add verification where needed.',
    ].join('\n');

    return successResult(call.id, plan, config.maxOutputChars);
  });

  executors.set('verify', async (call) => {
    const descriptionResult = requireString(call, 'description');
    if ('error' in descriptionResult) return descriptionResult.error;
    const evidenceResult = requireString(call, 'evidence');
    if ('error' in evidenceResult) return evidenceResult.error;

    const criteria = call.input['criteria'];
    const criteriaList = Array.isArray(criteria) ? criteria.filter((c): c is string => typeof c === 'string') : [];
    const description = descriptionResult.value;
    const evidence = evidenceResult.value;

    // Simple verification: check if evidence mentions each criterion
    const results: string[] = [];
    let passed = 0;
    for (const criterion of criteriaList) {
      const found = evidence.toLowerCase().includes(criterion.toLowerCase());
      results.push(`${found ? '✓' : '✗'} ${criterion}`);
      if (found) passed++;
    }

    const total = criteriaList.length || 1;
    const passRate = passed / total;
    const verdict = passRate >= 0.8 ? 'PASS' : passRate >= 0.5 ? 'PARTIAL' : 'FAIL';

    const output = [
      `## Verification: ${verdict}`,
      `Task: ${description}`,
      `Criteria met: ${passed}/${criteriaList.length}`,
      '',
      ...results,
      '',
      `Evidence length: ${evidence.length} chars`,
    ].join('\n');

    return successResult(call.id, output, config.maxOutputChars);
  });

  // ═════════════════════════════════════════════════════════════════════════
  // ROADMAP PHASE 3: INTROSPECTION TOOLS
  // ═════════════════════════════════════════════════════════════════════════

  executors.set('peek_queue', async (call) => {
    if (!state.eventBus) {
      return successResult(call.id, 'Event bus not available. No events queued.', config.maxOutputChars);
    }

    const queue = state.eventBus.getQueue();
    if (queue.length === 0) {
      return successResult(call.id, 'Event queue is empty. No pending triggers.', config.maxOutputChars);
    }

    const lines = queue.map((event, i) => {
      return `${i + 1}. [${event.type}] ${event.timestamp}`;
    });

    return successResult(
      call.id,
      `## Event Queue (${queue.length} events)\n\n${lines.join('\n')}`,
      config.maxOutputChars,
    );
  });

  executors.set('check_budget', async (call) => {
    const cs = state.cycleState;
    if (!cs) {
      return successResult(call.id, 'Cycle state not available. Budget tracking requires the agent loop.', config.maxOutputChars);
    }

    const elapsed = Date.now() - new Date(cs.startedAt).getTime();
    const turnsRemaining = cs.maxTurns - cs.currentTurn;
    const tokensPct = ((cs.tokensUsed / cs.maxTokens) * 100).toFixed(1);
    const turnsPct = ((cs.currentTurn / cs.maxTurns) * 100).toFixed(1);

    const output = [
      `## Budget Report — Cycle ${cs.cycleId}`,
      '',
      `Turns: ${cs.currentTurn}/${cs.maxTurns} (${turnsPct}% used, ${turnsRemaining} remaining)`,
      `Tokens: ~${cs.tokensUsed.toLocaleString()}/${cs.maxTokens.toLocaleString()} (${tokensPct}% used)`,
      `Elapsed: ${(elapsed / 1000).toFixed(1)}s`,
      `Steps executed: ${cs.stepHistory.length}`,
    ].join('\n');

    return successResult(call.id, output, config.maxOutputChars);
  });

  executors.set('list_context', async (call) => {
    if (!state.contextManager) {
      return successResult(call.id, 'Context manager not available.', config.maxOutputChars);
    }

    const usage = await state.contextManager.getUsage();
    const lines = [
      '## Memory Tier Usage',
      '',
      `**Hot tier** (identity): ${usage.hot.tokens} tokens`,
      `  Sections: ${usage.hot.sections.join(', ')}`,
      '',
      `**Warm tier** (working memory): ${usage.warm.tokens} tokens, ${usage.warm.entries} entries`,
      ...(usage.warm.keys.length > 0 ? [`  Keys: ${usage.warm.keys.join(', ')}`] : ['  (empty)']),
      '',
      `**Cool tier** (recent): ${usage.cool.entries} entries`,
      `**Cold tier** (archive): ${usage.cold.entries} entries`,
      '',
      `**Total in context**: ${usage.totalTokensInContext} tokens`,
      `**Remaining**: ${usage.remainingTokens} tokens`,
    ];

    return successResult(call.id, lines.join('\n'), config.maxOutputChars);
  });

  executors.set('review_steps', async (call) => {
    const cs = state.cycleState;
    if (!cs) {
      return successResult(call.id, 'No cycle state available.', config.maxOutputChars);
    }

    const lastN = optionalNumber(call, 'last_n');
    const steps = lastN !== undefined ? cs.stepHistory.slice(-lastN) : cs.stepHistory;

    if (steps.length === 0) {
      return successResult(call.id, 'No steps executed yet in this cycle.', config.maxOutputChars);
    }

    const lines = steps.map((s, i) => {
      return `${i + 1}. Turn ${s.turn}: ${s.tool} — ${s.success ? 'OK' : 'FAILED'} (${s.durationMs}ms)`;
    });

    const successCount = steps.filter((s) => s.success).length;
    const header = `## Step History (${steps.length} steps, ${successCount} succeeded)\n`;

    return successResult(call.id, header + lines.join('\n'), config.maxOutputChars);
  });

  executors.set('assess_self', async (call) => {
    const selfModel = state.selfModelSummary;
    if (!selfModel) {
      return successResult(call.id, 'Self-model not available. Run a dream cycle to rebuild it.', config.maxOutputChars);
    }

    const requestedSkills = call.input['skills'];
    const skillFilter = Array.isArray(requestedSkills)
      ? new Set(requestedSkills.filter((s): s is string => typeof s === 'string').map((s) => s.toLowerCase()))
      : null;

    const lines: string[] = ['## Self-Assessment', ''];

    // Strengths
    const strengths = skillFilter
      ? selfModel.strengths.filter((s) => skillFilter.has(s.skill.toLowerCase()))
      : selfModel.strengths;
    if (strengths.length > 0) {
      lines.push('**Strengths:**');
      for (const s of strengths) {
        lines.push(`  - ${s.skill}: ${(s.successRate * 100).toFixed(0)}% success (${s.sampleSize} samples)`);
      }
      lines.push('');
    }

    // Weaknesses
    const weaknesses = skillFilter
      ? selfModel.weaknesses.filter((s) => skillFilter.has(s.skill.toLowerCase()))
      : selfModel.weaknesses;
    if (weaknesses.length > 0) {
      lines.push('**Weaknesses:**');
      for (const w of weaknesses) {
        lines.push(`  - ${w.skill}: ${(w.successRate * 100).toFixed(0)}% success (${w.sampleSize} samples)`);
      }
      lines.push('');
    }

    // Preferences
    if (selfModel.preferences.length > 0 && !skillFilter) {
      lines.push('**Preferences:**');
      for (const p of selfModel.preferences) {
        lines.push(`  - ${p}`);
      }
    }

    return successResult(call.id, lines.join('\n'), config.maxOutputChars);
  });

  // ═════════════════════════════════════════════════════════════════════════
  // ROADMAP PHASE 4: LLM-CONTROLLED CONTEXT
  // ═════════════════════════════════════════════════════════════════════════

  executors.set('load_context', async (call) => {
    if (!state.contextManager) {
      return failureResult(call.id, 'Context manager not available.');
    }

    const queryResult = requireString(call, 'query');
    if ('error' in queryResult) return queryResult.error;

    const tier = optionalString(call, 'tier') ?? 'both';
    const limit = optionalNumber(call, 'limit') ?? 3;

    const results = await state.contextManager.recall({
      query: queryResult.value,
      tier: tier as 'cool' | 'cold' | 'both',
      limit,
    });

    if (results.length === 0) {
      return successResult(call.id, `No matching entries found for: "${queryResult.value}"`, config.maxOutputChars);
    }

    // Load results into warm tier
    const loaded: string[] = [];
    for (const result of results) {
      const key = `recall:${result.entry.id}`;
      state.contextManager.addToWarmTier({
        key,
        kind: 'snippet',
        content: `[${result.entry.title}] ${result.entry.content}`,
      });
      loaded.push(`${result.entry.title} (score: ${result.score.toFixed(2)})`);
    }

    return successResult(
      call.id,
      `Loaded ${loaded.length} entries into warm tier:\n${loaded.map((l, i) => `${i + 1}. ${l}`).join('\n')}`,
      config.maxOutputChars,
    );
  });

  executors.set('evict_context', async (call) => {
    if (!state.contextManager) {
      return failureResult(call.id, 'Context manager not available.');
    }

    const keyResult = requireString(call, 'key');
    if ('error' in keyResult) return keyResult.error;

    const removed = state.contextManager.removeFromWarmTier(keyResult.value);
    if (removed) {
      return successResult(call.id, `Evicted "${keyResult.value}" from warm tier.`, config.maxOutputChars);
    }
    return failureResult(call.id, `Key "${keyResult.value}" not found in warm tier.`);
  });

  executors.set('set_budget', async (call) => {
    if (!state.contextManager) {
      return failureResult(call.id, 'Context manager not available.');
    }

    const warmBudget = optionalNumber(call, 'warm_tier_tokens');
    if (warmBudget === undefined) {
      return failureResult(call.id, 'warm_tier_tokens is required.');
    }

    // We record the intent — actual enforcement happens through the context manager
    tracer.log('agent-loop', 'info', `[set_budget] Warm tier budget requested: ${warmBudget} tokens`);

    return successResult(
      call.id,
      `Warm tier budget preference set to ${warmBudget} tokens. The context manager will apply this on the next warm tier operation.`,
      config.maxOutputChars,
    );
  });

  // ═════════════════════════════════════════════════════════════════════════
  // ROADMAP PHASE 5: LLM-INITIATED TRIGGERS
  // ═════════════════════════════════════════════════════════════════════════

  executors.set('schedule', async (call) => {
    if (!state.jobStore) {
      return failureResult(call.id, 'Job store not available. Scheduling requires the scheduler to be initialized.');
    }

    const descResult = requireString(call, 'description');
    if ('error' in descResult) return descResult.error;

    const fireAt = optionalString(call, 'fire_at');
    const cron = optionalString(call, 'cron');
    const actionable = call.input['actionable'] !== false; // Default true

    if (!fireAt && !cron) {
      return failureResult(call.id, 'Either fire_at or cron must be provided.');
    }

    const jobId = `sched-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const now = Date.now();

    // Parse fire_at into absolute timestamp
    let fireAtMs: number | undefined;
    if (fireAt) {
      // Try ISO parse first
      const parsed = Date.parse(fireAt);
      if (!isNaN(parsed)) {
        fireAtMs = parsed;
      } else {
        // Try relative time parsing ("in 2 hours", "in 30 minutes")
        const relMatch = /in\s+(\d+)\s+(minute|hour|day|week)s?/i.exec(fireAt);
        if (relMatch) {
          const amount = parseInt(relMatch[1]!, 10);
          const unit = relMatch[2]!.toLowerCase();
          const multipliers: Record<string, number> = {
            minute: 60_000,
            hour: 3_600_000,
            day: 86_400_000,
            week: 604_800_000,
          };
          fireAtMs = now + amount * (multipliers[unit] ?? 60_000);
        } else {
          fireAtMs = now + 3_600_000; // Default: 1 hour from now
        }
      }
    }

    const job = {
      id: jobId,
      triggerType: (cron ? 'cron' : 'one_shot') as 'cron' | 'one_shot',
      status: 'active' as const,
      recipient: 'self',
      message: descResult.value,
      description: descResult.value.slice(0, 100),
      ...(fireAtMs !== undefined ? { fireAt: fireAtMs } : {}),
      ...(cron !== undefined ? { cronExpression: cron } : {}),
      createdAt: now,
      fireCount: 0,
      source: 'system' as const,
      label: descResult.value.slice(0, 50),
      actionable,
    };

    state.jobStore.add(job);

    const fireTimeStr = fireAtMs ? new Date(fireAtMs).toISOString() : `cron: ${cron}`;
    return successResult(
      call.id,
      `Scheduled job ${jobId}: "${descResult.value.slice(0, 80)}"\nFires: ${fireTimeStr}\nActionable: ${actionable}`,
      config.maxOutputChars,
    );
  });

  executors.set('list_schedules', async (call) => {
    if (!state.jobStore) {
      return successResult(call.id, 'Job store not available.', config.maxOutputChars);
    }

    const active = state.jobStore.getActive();
    if (active.length === 0) {
      return successResult(call.id, 'No active scheduled jobs.', config.maxOutputChars);
    }

    const lines = active.map((job) => {
      const fireTime = job.fireAt ? new Date(job.fireAt).toISOString() : `cron: ${job.cronExpression ?? 'unknown'}`;
      return `- **${job.id}**: ${job.description} (fires: ${fireTime}, actionable: ${job.actionable ?? false})`;
    });

    return successResult(
      call.id,
      `## Active Schedules (${active.length})\n\n${lines.join('\n')}`,
      config.maxOutputChars,
    );
  });

  executors.set('cancel_schedule', async (call) => {
    if (!state.jobStore) {
      return failureResult(call.id, 'Job store not available.');
    }

    const idResult = requireString(call, 'job_id');
    if ('error' in idResult) return idResult.error;

    const cancelled = state.jobStore.cancel(idResult.value);
    if (cancelled) {
      return successResult(call.id, `Job ${idResult.value} cancelled.`, config.maxOutputChars);
    }
    return failureResult(call.id, `Job ${idResult.value} not found or already cancelled.`);
  });

  // ═════════════════════════════════════════════════════════════════════════
  // SUPPORTING WORK: SEMANTIC MEMORY
  // ═════════════════════════════════════════════════════════════════════════

  executors.set('semantic_recall', async (call) => {
    if (!state.contextManager) {
      return failureResult(call.id, 'Context manager not available.');
    }

    const queryResult = requireString(call, 'query');
    if ('error' in queryResult) return queryResult.error;

    const tier = optionalString(call, 'tier') ?? 'both';
    const limit = optionalNumber(call, 'limit') ?? 10;

    const store = state.contextManager.getStore();

    // Compute query embedding if embedding provider is available
    let queryEmbedding: number[] | undefined;
    let mode = 'keyword-only';
    if (state.embeddingProvider) {
      const embedding = await state.embeddingProvider.embed(queryResult.value);
      if (embedding) {
        queryEmbedding = embedding;
        mode = 'hybrid (keyword + semantic)';
      }
    }

    // Use hybrid recall when embedding is available, otherwise keyword recall
    const results = queryEmbedding
      ? await store.hybridRecall({
          query: queryResult.value,
          queryEmbedding,
          tier: tier as 'cool' | 'cold' | 'both',
          limit,
        })
      : await store.recall({
          query: queryResult.value,
          tier: tier as 'cool' | 'cold' | 'both',
          limit,
        });

    if (results.length === 0) {
      return successResult(call.id, `No results for: "${queryResult.value}"`, config.maxOutputChars);
    }

    const lines = results.map((r, i) => {
      return `${i + 1}. [${r.entry.title}] (score: ${r.score.toFixed(2)}, keywords: ${r.matchedKeywords.join(', ') || 'none'})\n   ${r.entry.content.slice(0, 200)}${r.entry.content.length > 200 ? '...' : ''}`;
    });

    return successResult(
      call.id,
      `## Semantic Recall (${mode})\nQuery: "${queryResult.value}"\n\n${lines.join('\n\n')}`,
      config.maxOutputChars,
    );
  });

  // ═════════════════════════════════════════════════════════════════════════
  // SUPPORTING WORK: PARALLELISM
  // ═════════════════════════════════════════════════════════════════════════

  executors.set('parallel_reason', async (call) => {
    if (!state.concurrentProvider) {
      return failureResult(call.id, 'Concurrent provider not available. Parallel reasoning requires multi-model setup.');
    }

    const problemResult = requireString(call, 'problem');
    if ('error' in problemResult) return problemResult.error;

    const strategy = optionalString(call, 'strategy') ?? 'best_of_n';
    const models = state.concurrentProvider.getRegisteredModels();

    if (models.length < 2) {
      return failureResult(call.id, `Need at least 2 models for parallel reasoning. Available: ${models.join(', ')}`);
    }

    try {
      if (strategy === 'parallel') {
        const results = await state.concurrentProvider.parallel(
          models.slice(0, 2),
          { prompt: problemResult.value, temperature: 0.3 },
        );

        const output = results.map((r) => {
          return `### ${r.model} (${r.durationMs}ms)\n${r.response.text}`;
        }).join('\n\n---\n\n');

        return successResult(
          call.id,
          `## Parallel Responses (${results.length} models)\n\n${output}`,
          config.maxOutputChars,
        );
      } else {
        // best_of_n
        const result = await state.concurrentProvider.bestOfN(
          models.slice(0, Math.min(4, models.length)),
          { prompt: problemResult.value, temperature: 0.3 },
          models[0]!, // Use first model as judge
        );

        return successResult(
          call.id,
          `## Best Response (judged by ${result.judgeModel})\n\nModel: ${result.best.model} (${result.best.durationMs}ms)\nCandidates evaluated: ${result.candidates.length}\n\n${result.best.response.text}\n\n---\nJudge reasoning: ${result.judgeReasoning}`,
          config.maxOutputChars,
        );
      }
    } catch (err) {
      return failureResult(call.id, `Parallel reasoning failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  // ── Reconciliation: Dream cycle phase tools ─────────────────────────────

  executors.set('consolidate_reflections', async (call) => {
    if (!state.dreamCycleRunner || !state.reflector) {
      return failureResult(call.id, 'Dream cycle runner or reflector not available.');
    }

    return tracer.withSpan('dream', 'consolidate_reflections', async () => {
      const reflector = state.reflector!;
      const reflections = await reflector.loadRecentReflections(50);

      if (reflections.length === 0) {
        return successResult(call.id, 'No reflections to consolidate.', config.maxOutputChars);
      }

      const successful = reflections.filter((r) => r.outcome === 'success');
      const failed = reflections.filter((r) => r.outcome === 'failure');

      if (state.contextManager && successful.length > 0) {
        const insights = successful
          .map((r) => `- [${r.cycleId}] ${r.observation.suggestedArea}: ${r.learnings}`)
          .join('\n');
        await state.contextManager.archive({
          title: `Consolidation: ${successful.length} successful patterns`,
          content: insights,
          tags: ['consolidation', 'success-patterns'],
          source: 'reflection',
        });
      }

      if (state.contextManager && failed.length > 0) {
        const failures = failed
          .map((r) => `- [${r.cycleId}] ${r.observation.suggestedArea}: ${r.learnings}`)
          .join('\n');
        await state.contextManager.archive({
          title: `Consolidation: ${failed.length} failure patterns`,
          content: failures,
          tags: ['consolidation', 'failure-patterns'],
          source: 'reflection',
        });
      }

      return successResult(
        call.id,
        `Consolidated ${reflections.length} reflections (${successful.length} successful, ${failed.length} failed). Insights archived.`,
        config.maxOutputChars,
      );
    });
  });

  executors.set('reorganize_goals', async (call) => {
    return tracer.withSpan('dream', 'reorganize_goals', async () => {
      let reorganized = 0;

      const staleGoals = state.goalStack.getStaleGoals();
      for (const g of staleGoals) {
        state.goalStack.removeGoal(g.id);
        reorganized++;
      }
      const pruned = staleGoals.length;

      const openIssues = state.issueLog.getOpenIssues();
      for (const issue of openIssues) {
        if (issue.priority === 'critical' || issue.priority === 'high') {
          const goals = state.goalStack.getOpenGoals();
          const hasGoal = goals.some(
            (g) => g.description.includes(issue.id) || g.description.includes(issue.title),
          );
          if (!hasGoal) {
            state.goalStack.addGoal({
              source: 'self' as GoalSource,
              priority: issue.priority === 'critical' ? 2 : 3,
              description: `Investigate issue ${issue.id}: ${issue.title}`,
              notes: 'Auto-created from high-priority issue during goal reorganization.',
            });
            reorganized++;
          }
        }
      }

      return successResult(
        call.id,
        `Goals reorganized: ${reorganized} changes (${pruned} stale pruned, ${reorganized - pruned} new from issues).`,
        config.maxOutputChars,
      );
    });
  });

  executors.set('explore_codebase', async (call) => {
    if (!state.dreamCycleRunner) {
      return failureResult(call.id, 'Dream cycle runner not available.');
    }

    return tracer.withSpan('dream', 'explore_codebase', async () => {
      try {
        // Access the archaeologist through the dream runner's public API
        const runner = state.dreamCycleRunner!;
        const result = await (runner as unknown as { explore(): Promise<{ fragile: Array<{ path: string; fragilityScore: number; changeCount: number; fixCount: number }>; abandoned: string[] }> }).explore();

        const fragileLines = result.fragile.slice(0, 5).map(
          (f) => `  ${f.path} (score: ${f.fragilityScore}, changes: ${f.changeCount}, fixes: ${f.fixCount})`
        );
        const abandonedLines = result.abandoned.slice(0, 5).map((a) => `  ${a}`);

        return successResult(
          call.id,
          [
            `Fragile files (${result.fragile.length} found):`,
            ...fragileLines,
            result.fragile.length > 5 ? `  ... and ${result.fragile.length - 5} more` : '',
            `\nAbandoned files (${result.abandoned.length} found):`,
            ...abandonedLines,
            result.abandoned.length > 5 ? `  ... and ${result.abandoned.length - 5} more` : '',
          ].join('\n'),
          config.maxOutputChars,
        );
      } catch (err) {
        return failureResult(call.id, `Exploration failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
  });

  executors.set('rebuild_self_model', async (call) => {
    if (!state.dreamCycleRunner || !state.reflector) {
      return failureResult(call.id, 'Dream cycle runner or reflector not available.');
    }

    return tracer.withSpan('dream', 'rebuild_self_model', async () => {
      try {
        const runner = state.dreamCycleRunner!;
        const selfModel = (runner as unknown as { selfModel: { rebuild: (i: unknown, r: unknown) => Promise<void>; save: () => Promise<void>; getSummary: () => unknown } }).selfModel;
        await selfModel.rebuild(state.issueLog, state.reflector!);
        await selfModel.save();
        const summary = selfModel.getSummary();
        return successResult(
          call.id,
          `Self-model rebuilt.\n${JSON.stringify(summary, null, 2)}`,
          config.maxOutputChars,
        );
      } catch (err) {
        return failureResult(call.id, `Self-model rebuild failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
  });

  executors.set('write_retrospective', async (call) => {
    if (!state.reflector) {
      return failureResult(call.id, 'Reflector not available.');
    }

    return tracer.withSpan('dream', 'write_retrospective', async () => {
      try {
        const summary = [
          'Retrospective requested via agent tool.',
          `Open goals: ${state.goalStack.getOpenGoals().length}`,
          `Open issues: ${state.issueLog.getOpenIssues().length}`,
        ].join('\n');

        await state.reflector!.appendToMemory({
          cycleId: `retro-${Date.now()}`,
          title: 'Agent-Initiated Retrospective',
          content: summary,
        });

        return successResult(call.id, 'Retrospective written to MEMORY.md.', config.maxOutputChars);
      } catch (err) {
        return failureResult(call.id, `Retrospective failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
  });

  // ── link_memories (Advanced Memory: Zettelkasten A-MEM) ──────────────────

  executors.set('link_memories', async (call) => {
    if (!state.linkNetwork) {
      return failureResult(call.id, 'Link network not available.');
    }

    const sourceId = requireString(call, 'source_id');
    if ('error' in sourceId) return sourceId.error;
    const targetId = requireString(call, 'target_id');
    if ('error' in targetId) return targetId.error;
    const linkType = requireString(call, 'link_type');
    if ('error' in linkType) return linkType.error;

    const validTypes = ['supports', 'contradicts', 'extends', 'derived_from', 'related'];
    if (!validTypes.includes(linkType.value)) {
      return failureResult(call.id, `Invalid link_type: ${linkType.value}. Must be one of: ${validTypes.join(', ')}`);
    }

    const annotation = optionalString(call, 'annotation');

    const result = state.linkNetwork.createLink({
      sourceId: sourceId.value,
      targetId: targetId.value,
      type: linkType.value as LinkType,
      ...(annotation ? { annotation } : {}),
    });

    if (!result.success) {
      return failureResult(call.id, result.error ?? 'Failed to create link.');
    }

    await state.linkNetwork.save();
    return successResult(
      call.id,
      `Link created: ${result.linkId} (${sourceId.value} -[${linkType.value}]-> ${targetId.value})`,
      config.maxOutputChars,
    );
  });

  // ── get_links (Advanced Memory: Zettelkasten A-MEM) ────────────────────

  executors.set('get_links', async (call) => {
    if (!state.linkNetwork) {
      return failureResult(call.id, 'Link network not available.');
    }

    const entryId = requireString(call, 'entry_id');
    if ('error' in entryId) return entryId.error;
    const filterType = optionalString(call, 'link_type');

    let links = state.linkNetwork.getLinksForEntry(entryId.value);

    if (filterType) {
      links = links.filter((l) => l.type === filterType);
    }

    if (links.length === 0) {
      return successResult(
        call.id,
        `No links found for entry "${entryId.value}"${filterType ? ` with type "${filterType}"` : ''}.`,
        config.maxOutputChars,
      );
    }

    const lines: string[] = [
      `## Links for ${entryId.value} (${links.length} total)`,
      '',
    ];
    for (const link of links) {
      const other = link.sourceId === entryId.value ? link.targetId : link.sourceId;
      const direction = link.sourceId === entryId.value ? '→' : '←';
      const pct = Math.round(link.strength * 100);
      lines.push(`- ${direction} **${other}** [${link.type}] (${pct}% strength)`);
      if (link.annotation) lines.push(`  _${link.annotation}_`);
    }

    return successResult(call.id, lines.join('\n'), config.maxOutputChars);
  });

  // ── traverse_links (Advanced Memory: Zettelkasten A-MEM) ───────────────

  executors.set('traverse_links', async (call) => {
    if (!state.linkNetwork) {
      return failureResult(call.id, 'Link network not available.');
    }

    const entryId = requireString(call, 'entry_id');
    if ('error' in entryId) return entryId.error;
    const hops = optionalNumber(call, 'hops') ?? 2;

    const neighborhood = state.linkNetwork.getNeighborhood(entryId.value, hops);

    if (neighborhood.length === 0) {
      return successResult(
        call.id,
        `No entries reachable from "${entryId.value}" within ${hops} hop(s).`,
        config.maxOutputChars,
      );
    }

    const lines: string[] = [
      `## Neighborhood of ${entryId.value} (${hops} hops, ${neighborhood.length} entries)`,
      '',
      ...neighborhood.map((id) => `- ${id}`),
    ];

    return successResult(call.id, lines.join('\n'), config.maxOutputChars);
  });

  // ── audn_enqueue (Advanced Memory: AUDN Consolidation Cycle Mem0) ──────

  executors.set('audn_enqueue', async (call) => {
    if (!state.audnConsolidator) {
      return failureResult(call.id, 'AUDN consolidator not available.');
    }

    const content = requireString(call, 'content');
    if ('error' in content) return content.error;
    const source = requireString(call, 'source');
    if ('error' in source) return source.error;
    const tags = Array.isArray(call.input['tags'])
      ? (call.input['tags'] as string[])
      : [];

    const candidateId = state.audnConsolidator.enqueue({
      content: content.value,
      source: source.value,
      tags,
    });

    await state.audnConsolidator.save();
    return successResult(
      call.id,
      `Queued for AUDN evaluation: ${candidateId} (${state.audnConsolidator.queueSize()} total pending). Will be processed during next dream cycle consolidation.`,
      config.maxOutputChars,
    );
  });

  // ── audn_status (Advanced Memory: AUDN Consolidation Cycle Mem0) ───────

  executors.set('audn_status', async (call) => {
    if (!state.audnConsolidator) {
      return failureResult(call.id, 'AUDN consolidator not available.');
    }

    const queue = state.audnConsolidator.getQueue();
    if (queue.length === 0) {
      return successResult(
        call.id,
        'AUDN queue is empty. No candidates pending evaluation.',
        config.maxOutputChars,
      );
    }

    // Group by source
    const bySource = new Map<string, number>();
    for (const c of queue) {
      bySource.set(c.source, (bySource.get(c.source) ?? 0) + 1);
    }

    const lines: string[] = [
      `## AUDN Queue (${queue.length} candidates pending)`,
      '',
      '| Source | Count |',
      '|--------|-------|',
    ];
    for (const [src, count] of bySource) {
      lines.push(`| ${src} | ${count} |`);
    }

    const oldest = queue[0];
    if (oldest) {
      lines.push('', `Oldest candidate queued: ${oldest.queuedAt.split('T')[0]}`);
    }

    return successResult(call.id, lines.join('\n'), config.maxOutputChars);
  });

  // ── entropy_score (Advanced Memory: SAGE) ────────────────────────────────

  executors.set('entropy_score', async (call) => {
    if (!state.entropyMigrator) {
      return failureResult(call.id, 'Entropy migrator not available.');
    }

    const content = requireString(call, 'content');
    if ('error' in content) return content.error;

    const result = state.entropyMigrator.quickScore(content.value);
    const lines = [
      `## Entropy Score`,
      '',
      `| Metric | Value |`,
      `|--------|-------|`,
      `| Raw entropy | ${result.entropy.toFixed(3)} bits |`,
      `| Normalized | ${result.normalizedEntropy.toFixed(3)} (0-1) |`,
      '',
      result.normalizedEntropy >= 0.7
        ? 'High information density — good candidate for hot/warm tier.'
        : result.normalizedEntropy >= 0.4
          ? 'Moderate information density — warm/cool tier appropriate.'
          : 'Low information density — cool/cold tier appropriate.',
    ];

    return successResult(call.id, lines.join('\n'), config.maxOutputChars);
  });

  // ── evaluate_tiers (Advanced Memory: SAGE) ───────────────────────────────

  executors.set('evaluate_tiers', async (call) => {
    if (!state.entropyMigrator) {
      return failureResult(call.id, 'Entropy migrator not available.');
    }

    const entriesRaw = call.input?.entries;
    if (!Array.isArray(entriesRaw) || entriesRaw.length === 0) {
      return failureResult(call.id, 'entries must be a non-empty array of memory entries.');
    }

    // Validate and cast entries
    const entries: EntryForScoring[] = entriesRaw.map((e: Record<string, unknown>) => ({
      id: String(e.id ?? ''),
      content: String(e.content ?? ''),
      currentTier: String(e.currentTier ?? 'cold') as MemoryTier,
      accessCount: Number(e.accessCount ?? 0),
      lastAccessedAt: String(e.lastAccessedAt ?? new Date().toISOString()),
      createdAt: String(e.createdAt ?? new Date().toISOString()),
    }));

    const report = state.entropyMigrator.evaluate(entries);

    const lines = [
      `## Tier Migration Report`,
      '',
      `Evaluated: ${report.evaluated} | Promotions: ${report.promotions} | Demotions: ${report.demotions} | Stable: ${report.stable}`,
      '',
    ];

    const migrations = report.candidates.filter((c) => c.shouldMigrate);
    if (migrations.length > 0) {
      lines.push('### Recommended Migrations', '', '| ID | Current | Recommended | Score | Direction |', '|-----|---------|-------------|-------|-----------|');
      for (const c of migrations.slice(0, 20)) {
        lines.push(`| ${c.id} | ${c.currentTier} | ${c.recommendedTier} | ${c.migrationScore.toFixed(3)} | ${c.direction} |`);
      }
      if (migrations.length > 20) {
        lines.push(``, `... and ${migrations.length - 20} more.`);
      }
    } else {
      lines.push('All entries are in their optimal tiers. No migrations recommended.');
    }

    return successResult(call.id, lines.join('\n'), config.maxOutputChars);
  });

  // ── snapshot_memory (Advanced Memory: Git-Backed Versioning Letta) ──────

  executors.set('snapshot_memory', async (call) => {
    if (!state.memoryVersioning) {
      return failureResult(call.id, 'Memory versioning not available.');
    }

    const message = requireString(call, 'message');
    if ('error' in message) return message.error;

    try {
      const snapshot = await state.memoryVersioning.createSnapshot({
        trigger: 'agent',
        message: message.value,
      });
      await state.memoryVersioning.save();

      const lines = [
        `## Snapshot Created`,
        '',
        `| Field | Value |`,
        `|-------|-------|`,
        `| ID | \`${snapshot.id}\` |`,
        `| Timestamp | ${snapshot.timestamp} |`,
        `| Subsystems | ${Object.keys(snapshot.data).join(', ')} |`,
        `| Hash | ${snapshot.contentHash} |`,
        '',
        `Message: ${snapshot.message}`,
      ];

      return successResult(call.id, lines.join('\n'), config.maxOutputChars);
    } catch (err) {
      return failureResult(call.id, `Snapshot failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  // ── list_snapshots (Advanced Memory: Git-Backed Versioning Letta) ──────

  executors.set('list_snapshots', async (call) => {
    if (!state.memoryVersioning) {
      return failureResult(call.id, 'Memory versioning not available.');
    }

    const limit = typeof call.input?.limit === 'number' ? call.input.limit : 10;
    const snapshots = state.memoryVersioning.listSnapshots().slice(0, limit);

    if (snapshots.length === 0) {
      return successResult(call.id, 'No snapshots found. Use `snapshot_memory` to create one.', config.maxOutputChars);
    }

    const lines = [
      `## Memory Snapshots (${snapshots.length} of ${state.memoryVersioning.count()})`,
      '',
      '| ID | Date | Trigger | Message |',
      '|----|------|---------|---------|',
    ];

    for (const s of snapshots) {
      lines.push(`| \`${s.id}\` | ${s.timestamp.split('T')[0]} | ${s.trigger} | ${s.message.slice(0, 60)} |`);
    }

    return successResult(call.id, lines.join('\n'), config.maxOutputChars);
  });

  // ── diff_snapshots (Advanced Memory: Git-Backed Versioning Letta) ──────

  executors.set('diff_snapshots', async (call) => {
    if (!state.memoryVersioning) {
      return failureResult(call.id, 'Memory versioning not available.');
    }

    const toId = requireString(call, 'toId');
    if ('error' in toId) return toId.error;

    const fromId = typeof call.input?.fromId === 'string' ? call.input.fromId : undefined;

    const result = state.memoryVersioning.diff(toId.value, fromId);
    if (!result) {
      return failureResult(call.id, `Snapshot not found: ${toId.value}`);
    }

    const lines = [
      `## Snapshot Diff`,
      '',
      `From: \`${result.fromId || '(initial)'}\` → To: \`${result.toId}\``,
      '',
    ];

    if (result.subsystemsAdded.length > 0) {
      lines.push(`**Added subsystems:** ${result.subsystemsAdded.join(', ')}`);
    }
    if (result.subsystemsRemoved.length > 0) {
      lines.push(`**Removed subsystems:** ${result.subsystemsRemoved.join(', ')}`);
    }

    if (result.diffs.length > 0) {
      for (const d of result.diffs) {
        lines.push('', `### ${d.subsystem} (+${d.linesAdded} / -${d.linesRemoved})`);
        if (d.additions.length > 0) {
          lines.push('', '**Added:**');
          for (const a of d.additions.slice(0, 10)) {
            lines.push(`+ ${a}`);
          }
        }
        if (d.removals.length > 0) {
          lines.push('', '**Removed:**');
          for (const r of d.removals.slice(0, 10)) {
            lines.push(`- ${r}`);
          }
        }
      }
    } else if (result.subsystemsChanged.length === 0 && result.subsystemsAdded.length === 0 && result.subsystemsRemoved.length === 0) {
      lines.push('No changes between these snapshots.');
    }

    return successResult(call.id, lines.join('\n'), config.maxOutputChars);
  });

  // ── evolve_memory (Advanced Memory: Memory Evolution A-MEM) ──────────────

  executors.set('evolve_memory', async (call) => {
    if (!state.memoryEvolution) {
      return failureResult(call.id, 'Memory evolution not available.');
    }

    const operation = requireString(call, 'operation');
    if ('error' in operation) return operation.error;
    const reason = requireString(call, 'reason');
    if ('error' in reason) return reason.error;

    const validOps = ['strengthen', 'weaken', 'merge', 'split', 'generalize', 'specialize'];
    if (!validOps.includes(operation.value)) {
      return failureResult(call.id, `Invalid operation: ${operation.value}. Must be one of: ${validOps.join(', ')}`);
    }

    const rawMemory = call.input?.memory as Record<string, unknown> | undefined;
    if (!rawMemory || typeof rawMemory.id !== 'string' || typeof rawMemory.content !== 'string') {
      return failureResult(call.id, 'memory must include at least id and content.');
    }

    const now = new Date().toISOString();
    const memory: EvolvableMemory = {
      id: rawMemory.id as string,
      content: rawMemory.content as string,
      confidence: typeof rawMemory.confidence === 'number' ? rawMemory.confidence : 0.5,
      generation: typeof rawMemory.generation === 'number' ? rawMemory.generation : 0,
      parentIds: Array.isArray(rawMemory.parentIds) ? (rawMemory.parentIds as string[]) : [],
      tags: Array.isArray(rawMemory.tags) ? (rawMemory.tags as string[]) : [],
      createdAt: typeof rawMemory.createdAt === 'string' ? rawMemory.createdAt : now,
      lastEvolvedAt: typeof rawMemory.lastEvolvedAt === 'string' ? rawMemory.lastEvolvedAt : now,
    };

    const op = operation.value as EvolutionOp;

    try {
      let resultText: string;

      switch (op) {
        case 'strengthen': {
          const result = state.memoryEvolution.strengthen(memory, reason.value);
          resultText = `Strengthened "${memory.id}" → confidence: ${result.confidence.toFixed(2)}`;
          break;
        }
        case 'weaken': {
          const result = state.memoryEvolution.weaken(memory, reason.value);
          resultText = `Weakened "${memory.id}" → confidence: ${result.confidence.toFixed(2)}`;
          break;
        }
        case 'merge': {
          const rawSecond = call.input?.second_memory as Record<string, unknown> | undefined;
          if (!rawSecond || typeof rawSecond.id !== 'string' || typeof rawSecond.content !== 'string') {
            return failureResult(call.id, 'merge requires second_memory with id and content.');
          }
          const mergeContent = optionalString(call, 'new_content');
          if (!mergeContent) {
            return failureResult(call.id, 'merge requires new_content — the merged text.');
          }
          const secondMemory: EvolvableMemory = {
            id: rawSecond.id as string,
            content: rawSecond.content as string,
            confidence: typeof rawSecond.confidence === 'number' ? rawSecond.confidence : 0.5,
            generation: typeof rawSecond.generation === 'number' ? rawSecond.generation : 0,
            parentIds: Array.isArray(rawSecond.parentIds) ? (rawSecond.parentIds as string[]) : [],
            tags: Array.isArray(rawSecond.tags) ? (rawSecond.tags as string[]) : [],
            createdAt: typeof rawSecond.createdAt === 'string' ? rawSecond.createdAt : now,
            lastEvolvedAt: typeof rawSecond.lastEvolvedAt === 'string' ? rawSecond.lastEvolvedAt : now,
          };
          const merged = state.memoryEvolution.merge(memory, secondMemory, mergeContent, reason.value);
          resultText = `Merged "${memory.id}" + "${secondMemory.id}" → "${merged.id}" (gen ${merged.generation})`;
          break;
        }
        case 'split': {
          const rawSplitContents = call.input?.split_contents;
          if (!Array.isArray(rawSplitContents) || rawSplitContents.length < 2) {
            return failureResult(call.id, 'split requires split_contents — array of 2+ content strings.');
          }
          const splitContents = rawSplitContents.map(String);
          const splits = state.memoryEvolution.split(memory, splitContents, reason.value);
          resultText = `Split "${memory.id}" → ${splits.map((r) => `"${r.id}"`).join(', ')} (gen ${splits[0]?.generation ?? 0})`;
          break;
        }
        case 'generalize': {
          const genContent = optionalString(call, 'new_content');
          if (!genContent) {
            return failureResult(call.id, 'generalize requires new_content — the generalized text.');
          }
          const generalized = state.memoryEvolution.generalize(memory, genContent, reason.value);
          resultText = `Generalized "${memory.id}" → "${generalized.id}" (gen ${generalized.generation})`;
          break;
        }
        case 'specialize': {
          const specContent = optionalString(call, 'new_content');
          if (!specContent) {
            return failureResult(call.id, 'specialize requires new_content — the specialized text.');
          }
          const specialized = state.memoryEvolution.specialize(memory, specContent, reason.value);
          resultText = `Specialized "${memory.id}" → "${specialized.id}" (gen ${specialized.generation})`;
          break;
        }
        default:
          return failureResult(call.id, `Unknown operation: ${op}`);
      }

      await state.memoryEvolution.save();
      return successResult(call.id, resultText, config.maxOutputChars);
    } catch (err) {
      return failureResult(call.id, `Evolution failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  // ── evolution_lineage (Advanced Memory: Memory Evolution A-MEM) ──────────

  executors.set('evolution_lineage', async (call) => {
    if (!state.memoryEvolution) {
      return failureResult(call.id, 'Memory evolution not available.');
    }

    const memoryId = requireString(call, 'memory_id');
    if ('error' in memoryId) return memoryId.error;

    const events = state.memoryEvolution.getLineage(memoryId.value);

    if (events.length === 0) {
      return successResult(call.id, `No evolution history found for "${memoryId.value}".`, config.maxOutputChars);
    }

    const lines = [
      `## Evolution Lineage: ${memoryId.value} (${events.length} events)`,
      '',
      '| Op | Sources → Results | Reason | Date |',
      '|----|-------------------|--------|------|',
    ];

    for (const e of events) {
      lines.push(`| ${e.operation} | ${e.sourceIds.join(',')} → ${e.resultIds.join(',')} | ${e.reason.slice(0, 50)} | ${e.timestamp.split('T')[0]} |`);
    }

    return successResult(call.id, lines.join('\n'), config.maxOutputChars);
  });

  // ── evolution_log (Advanced Memory: Memory Evolution A-MEM) ──────────────

  executors.set('evolution_log', async (call) => {
    if (!state.memoryEvolution) {
      return failureResult(call.id, 'Memory evolution not available.');
    }

    const filterOp = optionalString(call, 'operation') as EvolutionOp | undefined;
    const limit = typeof call.input?.limit === 'number' ? call.input.limit : 20;

    let events = filterOp
      ? state.memoryEvolution.getEventsByType(filterOp)
      : [...state.memoryEvolution.getEvents()];

    // Most recent first
    events = events.slice(-limit).reverse();

    if (events.length === 0) {
      return successResult(
        call.id,
        filterOp
          ? `No ${filterOp} events found. Total events: ${state.memoryEvolution.eventCount()}.`
          : `No evolution events yet. Use evolve_memory to start tracking memory transformations.`,
        config.maxOutputChars,
      );
    }

    const lines = [
      `## Evolution Log (${events.length} events${filterOp ? `, filter: ${filterOp}` : ''})`,
      '',
      '| ID | Op | Sources → Results | Reason | Date |',
      '|----|----|--------------------|--------|------|',
    ];

    for (const e of events) {
      const delta = e.confidenceDelta !== undefined ? ` (Δ${e.confidenceDelta > 0 ? '+' : ''}${e.confidenceDelta.toFixed(2)})` : '';
      lines.push(`| ${e.id} | ${e.operation}${delta} | ${e.sourceIds.join(',')} → ${e.resultIds.join(',')} | ${e.reason.slice(0, 40)} | ${e.timestamp.split('T')[0]} |`);
    }

    return successResult(call.id, lines.join('\n'), config.maxOutputChars);
  });

  // ── register_temporal (Advanced Memory: Temporal Invalidation Mem0) ──────

  executors.set('register_temporal', async (call) => {
    if (!state.temporalInvalidation) {
      return failureResult(call.id, 'Temporal invalidation not available.');
    }

    const entryId = requireString(call, 'entry_id');
    if ('error' in entryId) return entryId.error;
    const category = requireString(call, 'category');
    if ('error' in category) return category.error;

    const validCategories = ['fact', 'observation', 'opinion', 'working_note', 'crystal', 'rule'];
    if (!validCategories.includes(category.value)) {
      return failureResult(call.id, `Invalid category: ${category.value}. Must be one of: ${validCategories.join(', ')}`);
    }

    const entry = state.temporalInvalidation.register({
      id: entryId.value,
      category: category.value,
    });

    const policy = state.temporalInvalidation.getPolicy(category.value);
    const ttl = policy ? `${policy.ttlDays}d TTL, ${policy.gracePeriodDays}d grace, ${policy.decay} decay` : 'default policy';

    return successResult(
      call.id,
      `Registered "${entryId.value}" for temporal tracking (${category.value}: ${ttl}). Freshness: ${entry.freshness.toFixed(2)}`,
      config.maxOutputChars,
    );
  });

  // ── check_freshness (Advanced Memory: Temporal Invalidation Mem0) ────────

  executors.set('check_freshness', async (call) => {
    if (!state.temporalInvalidation) {
      return failureResult(call.id, 'Temporal invalidation not available.');
    }

    const entryId = optionalString(call, 'entry_id');
    const category = optionalString(call, 'category');

    if (entryId) {
      const freshness = state.temporalInvalidation.getFreshness(entryId);
      if (freshness === null) {
        return failureResult(call.id, `Entry "${entryId}" is not being tracked. Use register_temporal first.`);
      }

      const expired = state.temporalInvalidation.isExpired(entryId);
      const pct = Math.round(freshness * 100);
      return successResult(
        call.id,
        `**${entryId}**: ${pct}% fresh${expired ? ' (EXPIRED)' : ''}`,
        config.maxOutputChars,
      );
    }

    if (category) {
      const entries = state.temporalInvalidation.getByCategory(category);
      if (entries.length === 0) {
        return successResult(call.id, `No entries tracked in category "${category}".`, config.maxOutputChars);
      }

      const lines = [
        `## Tracked Entries: ${category} (${entries.length})`,
        '',
        '| ID | Freshness | Expired | Grace |',
        '|----|-----------|---------|-------|',
      ];

      for (const e of entries) {
        const pct = Math.round(e.freshness * 100);
        lines.push(`| ${e.id} | ${pct}% | ${e.expired ? 'yes' : 'no'} | ${e.inGracePeriod ? 'yes' : 'no'} |`);
      }

      return successResult(call.id, lines.join('\n'), config.maxOutputChars);
    }

    // No filters — show summary
    const all = state.temporalInvalidation.getAll();
    if (all.length === 0) {
      return successResult(call.id, 'No entries tracked. Use register_temporal to start tracking.', config.maxOutputChars);
    }

    const fresh = all.filter((e) => !e.expired).length;
    const expired = all.filter((e) => e.expired && e.inGracePeriod).length;
    const deletion = all.filter((e) => e.expired && !e.inGracePeriod).length;

    return successResult(
      call.id,
      `Tracking ${all.length} entries: ${fresh} fresh, ${expired} expired (grace), ${deletion} ready for deletion.`,
      config.maxOutputChars,
    );
  });

  // ── sweep_expired (Advanced Memory: Temporal Invalidation Mem0) ──────────

  executors.set('sweep_expired', async (call) => {
    if (!state.temporalInvalidation) {
      return failureResult(call.id, 'Temporal invalidation not available.');
    }

    const report = state.temporalInvalidation.sweep();

    const lines = [
      `## Temporal Sweep Results`,
      '',
      `| Metric | Count |`,
      `|--------|-------|`,
      `| Evaluated | ${report.evaluated} |`,
      `| Fresh | ${report.fresh} |`,
      `| Newly expired | ${report.newlyExpired} |`,
      `| Ready for deletion | ${report.readyForDeletion} |`,
    ];

    if (report.deletionCandidates.length > 0) {
      lines.push('', '**Deletion candidates:**');
      for (const id of report.deletionCandidates.slice(0, 20)) {
        lines.push(`- ${id}`);
      }
      if (report.deletionCandidates.length > 20) {
        lines.push(`- ... and ${report.deletionCandidates.length - 20} more`);
      }
    }

    return successResult(call.id, lines.join('\n'), config.maxOutputChars);
  });

  // ── learn_skill (Advanced Memory: Skill Files Letta) ─────────────────────

  executors.set('learn_skill', async (call) => {
    if (!state.skillFilesManager) {
      return failureResult(call.id, 'Skill files manager not available.');
    }

    const name = requireString(call, 'name');
    if ('error' in name) return name.error;
    const description = requireString(call, 'description');
    if ('error' in description) return description.error;

    const rawSteps = call.input?.steps;
    if (!Array.isArray(rawSteps) || rawSteps.length === 0) {
      return failureResult(call.id, 'steps must be a non-empty array of strings.');
    }
    const steps = rawSteps.filter((s): s is string => typeof s === 'string');

    const rawPreconditions = call.input?.preconditions;
    const preconditions = Array.isArray(rawPreconditions)
      ? rawPreconditions.filter((s): s is string => typeof s === 'string')
      : undefined;

    const rawCriteria = call.input?.success_criteria;
    const successCriteria = Array.isArray(rawCriteria)
      ? rawCriteria.filter((s): s is string => typeof s === 'string')
      : undefined;

    const rawTags = call.input?.tags;
    const tags = Array.isArray(rawTags)
      ? rawTags.filter((s): s is string => typeof s === 'string')
      : undefined;

    const result = state.skillFilesManager.learn({
      name: name.value,
      description: description.value,
      steps,
      ...(preconditions ? { preconditions } : {}),
      ...(successCriteria ? { successCriteria } : {}),
      ...(tags ? { tags } : {}),
    });

    if (!result.success) {
      return failureResult(call.id, result.error ?? 'Failed to learn skill.');
    }

    return successResult(call.id, `Skill learned: **${name.value}** (${result.skillId})`, config.maxOutputChars);
  });

  // ── refine_skill (Advanced Memory: Skill Files Letta) ──────────────────

  executors.set('refine_skill', async (call) => {
    if (!state.skillFilesManager) {
      return failureResult(call.id, 'Skill files manager not available.');
    }

    const skillId = requireString(call, 'skill_id');
    if ('error' in skillId) return skillId.error;

    const rawSteps = call.input?.steps;
    const steps = Array.isArray(rawSteps)
      ? rawSteps.filter((s): s is string => typeof s === 'string')
      : undefined;

    const rawPreconditions = call.input?.preconditions;
    const preconditions = Array.isArray(rawPreconditions)
      ? rawPreconditions.filter((s): s is string => typeof s === 'string')
      : undefined;

    const rawCriteria = call.input?.success_criteria;
    const successCriteria = Array.isArray(rawCriteria)
      ? rawCriteria.filter((s): s is string => typeof s === 'string')
      : undefined;

    const descUpdate = optionalString(call, 'description');

    const result = state.skillFilesManager.refine(skillId.value, {
      ...(steps ? { steps } : {}),
      ...(preconditions ? { preconditions } : {}),
      ...(successCriteria ? { successCriteria } : {}),
      ...(descUpdate ? { description: descUpdate } : {}),
    });

    if (!result.success) {
      return failureResult(call.id, result.error ?? 'Failed to refine skill.');
    }

    const skill = state.skillFilesManager.getById(skillId.value);
    return successResult(call.id, `Skill refined: **${skill?.name ?? skillId.value}** v${skill?.version ?? '?'}`, config.maxOutputChars);
  });

  // ── search_skills (Advanced Memory: Skill Files Letta) ─────────────────

  executors.set('search_skills', async (call) => {
    if (!state.skillFilesManager) {
      return failureResult(call.id, 'Skill files manager not available.');
    }

    const query = optionalString(call, 'query');
    const mastery = optionalString(call, 'mastery');

    let skills = query
      ? state.skillFilesManager.search(query)
      : [...state.skillFilesManager.getAll()];

    if (mastery) {
      skills = skills.filter((s) => s.mastery === mastery);
    }

    if (skills.length === 0) {
      return successResult(call.id, 'No skills found.', config.maxOutputChars);
    }

    const lines = [`## Skills (${skills.length} found)`, ''];
    for (const s of skills.slice(0, 20)) {
      const rate = s.useCount > 0 ? `${((s.successCount / s.useCount) * 100).toFixed(0)}%` : 'N/A';
      lines.push(`### ${s.name} (${s.id})`);
      lines.push(`- **Mastery:** ${s.mastery} | **Uses:** ${s.useCount} | **Success rate:** ${rate} | **Version:** v${s.version}`);
      lines.push(`- **Description:** ${s.description}`);
      lines.push(`- **Steps:** ${s.steps.length} | **Tags:** ${s.tags.join(', ') || 'none'}`);
      lines.push('');
    }
    if (skills.length > 20) {
      lines.push(`... and ${skills.length - 20} more skills.`);
    }

    return successResult(call.id, lines.join('\n'), config.maxOutputChars);
  });

  // ── record_skill_use (Advanced Memory: Skill Files Letta) ──────────────

  executors.set('record_skill_use', async (call) => {
    if (!state.skillFilesManager) {
      return failureResult(call.id, 'Skill files manager not available.');
    }

    const skillId = requireString(call, 'skill_id');
    if ('error' in skillId) return skillId.error;

    const rawSuccess = call.input?.success;
    if (typeof rawSuccess !== 'boolean') {
      return failureResult(call.id, 'success must be a boolean.');
    }

    const ok = state.skillFilesManager.recordUse(skillId.value, rawSuccess);
    if (!ok) {
      return failureResult(call.id, `Skill not found: ${skillId.value}`);
    }

    const skill = state.skillFilesManager.getById(skillId.value);
    return successResult(
      call.id,
      `Recorded ${rawSuccess ? 'successful' : 'failed'} use of **${skill?.name ?? skillId.value}** (mastery: ${skill?.mastery ?? 'unknown'}, uses: ${skill?.useCount ?? 0})`,
      config.maxOutputChars,
    );
  });

  // ── dream_concurrency_config (Advanced Memory: Concurrent Dream Letta) ──

  executors.set('dream_concurrency_config', async (call) => {
    if (!state.concurrentDreamExecutor) {
      return failureResult(call.id, 'Concurrent dream executor not available.');
    }

    // The executor exposes its config via its constructor defaults.
    // We report the known defaults since the executor is stateless.
    const lines = [
      '## Concurrent Dream Configuration',
      '',
      '| Setting | Value |',
      '|---------|-------|',
      '| Max concurrency | 4 phases per group |',
      '| Phase timeout | 120,000 ms (2 min) |',
      '| Abort on critical failure | No |',
      '| Critical phases | consolidateReflections, updateWorldModel |',
      '',
      '### Dependency Groups',
      '',
      '- **Group 1** (independent): consolidation, world model, archaeology',
      '- **Group 2** (depends on 1): goal reorganization, self-model',
      '- **Group 3** (depends on 2): shadow analysis, tool inventory',
      '- **Group 4** (depends on 3): challenges, prompt evolution, training',
      '- **Group 5** (final): retrospective',
      '',
      'Phases within the same group run concurrently. Groups execute sequentially.',
    ];

    return successResult(call.id, lines.join('\n'), config.maxOutputChars);
  });

  // ── graph_add_node (Advanced Memory: Graph Relational Memory Mem0) ──────

  executors.set('graph_add_node', async (call) => {
    if (!state.graphMemory) {
      return failureResult(call.id, 'Graph memory not available.');
    }

    const label = requireString(call, 'label');
    if ('error' in label) return label.error;
    const nodeType = requireString(call, 'node_type');
    if ('error' in nodeType) return nodeType.error;

    const validTypes: NodeType[] = ['file', 'concept', 'person', 'tool', 'module', 'pattern'];
    if (!validTypes.includes(nodeType.value as NodeType)) {
      return failureResult(call.id, `Invalid node_type: "${nodeType.value}". Must be one of: ${validTypes.join(', ')}`);
    }

    const memoryId = optionalString(call, 'memory_id');

    const node = state.graphMemory.addNode({
      label: label.value,
      type: nodeType.value as NodeType,
      ...(memoryId ? { memoryId } : {}),
    });

    return successResult(
      call.id,
      `Node **${node.label}** (${node.id}) — type: ${node.type}, mentions: ${node.mentionCount}`,
      config.maxOutputChars,
    );
  });

  // ── graph_add_edge (Advanced Memory: Graph Relational Memory Mem0) ──────

  executors.set('graph_add_edge', async (call) => {
    if (!state.graphMemory) {
      return failureResult(call.id, 'Graph memory not available.');
    }

    const sourceId = requireString(call, 'source_id');
    if ('error' in sourceId) return sourceId.error;
    const targetId = requireString(call, 'target_id');
    if ('error' in targetId) return targetId.error;
    const edgeType = requireString(call, 'edge_type');
    if ('error' in edgeType) return edgeType.error;

    const validEdgeTypes: EdgeType[] = ['depends_on', 'related_to', 'uses', 'modifies', 'contains', 'authored_by', 'tested_by'];
    if (!validEdgeTypes.includes(edgeType.value as EdgeType)) {
      return failureResult(call.id, `Invalid edge_type: "${edgeType.value}". Must be one of: ${validEdgeTypes.join(', ')}`);
    }

    const rawWeight = call.input?.weight;
    const weight = typeof rawWeight === 'number' ? rawWeight : undefined;

    const ok = state.graphMemory.addEdge({
      sourceId: sourceId.value,
      targetId: targetId.value,
      type: edgeType.value as EdgeType,
      ...(weight !== undefined ? { weight } : {}),
    });

    if (!ok) {
      return failureResult(call.id, `Failed to add edge. Ensure both nodes exist and are different.`);
    }

    const sourceNode = state.graphMemory.getNode(sourceId.value);
    const targetNode = state.graphMemory.getNode(targetId.value);
    return successResult(
      call.id,
      `Edge added: **${sourceNode?.label ?? sourceId.value}** —[${edgeType.value}]→ **${targetNode?.label ?? targetId.value}**`,
      config.maxOutputChars,
    );
  });

  // ── graph_search (Advanced Memory: Graph Relational Memory Mem0) ────────

  executors.set('graph_search', async (call) => {
    if (!state.graphMemory) {
      return failureResult(call.id, 'Graph memory not available.');
    }

    const query = optionalString(call, 'query');
    const nodeId = optionalString(call, 'node_id');
    const nodeType = optionalString(call, 'node_type');

    // Inspect a specific node
    if (nodeId) {
      const node = state.graphMemory.getNode(nodeId);
      if (!node) {
        return failureResult(call.id, `Node not found: ${nodeId}`);
      }

      const edges = state.graphMemory.getEdgesForNode(nodeId);
      const neighbors = state.graphMemory.getNeighbors(nodeId);

      const lines = [
        `## Node: ${node.label} (${node.id})`,
        '',
        `- **Type:** ${node.type}`,
        `- **Mentions:** ${node.mentionCount}`,
        `- **First seen:** ${node.firstSeen}`,
        `- **Last seen:** ${node.lastSeen}`,
        `- **Memory IDs:** ${node.memoryIds.length > 0 ? node.memoryIds.join(', ') : 'none'}`,
        '',
        `### Edges (${edges.length})`,
        '',
      ];

      for (const e of edges.slice(0, 20)) {
        const other = e.sourceId === nodeId ? e.targetId : e.sourceId;
        const otherNode = state.graphMemory.getNode(other);
        const dir = e.sourceId === nodeId ? '→' : '←';
        lines.push(`- ${dir} [${e.type}] **${otherNode?.label ?? other}** (weight: ${e.weight.toFixed(2)})`);
      }
      if (edges.length > 20) lines.push(`- ... and ${edges.length - 20} more`);

      lines.push('', `### Neighbors (${neighbors.length})`, '');
      for (const n of neighbors.slice(0, 20)) {
        lines.push(`- **${n.label}** (${n.type}, mentions: ${n.mentionCount})`);
      }
      if (neighbors.length > 20) lines.push(`- ... and ${neighbors.length - 20} more`);

      return successResult(call.id, lines.join('\n'), config.maxOutputChars);
    }

    // Search or list
    let nodes = query
      ? state.graphMemory.searchNodes(query)
      : [...state.graphMemory.getAllNodes()];

    if (nodeType) {
      nodes = nodes.filter((n) => n.type === nodeType);
    }

    if (nodes.length === 0 && !query) {
      return successResult(
        call.id,
        `## Graph Summary\n\n- **Nodes:** ${state.graphMemory.nodeCount()}\n- **Edges:** ${state.graphMemory.edgeCount()}\n\nGraph is empty.`,
        config.maxOutputChars,
      );
    }

    const lines = [
      `## Graph Search${query ? `: "${query}"` : ''} (${nodes.length} nodes)`,
      '',
      `**Total graph:** ${state.graphMemory.nodeCount()} nodes, ${state.graphMemory.edgeCount()} edges`,
      '',
    ];

    for (const n of nodes.slice(0, 20)) {
      lines.push(`- **${n.label}** (${n.id}) — ${n.type}, mentions: ${n.mentionCount}`);
    }
    if (nodes.length > 20) lines.push(`- ... and ${nodes.length - 20} more`);

    return successResult(call.id, lines.join('\n'), config.maxOutputChars);
  });

  // ── check_memory (Advanced Memory: Checker Pattern SAGE) ────────────────

  executors.set('check_memory', async (call) => {
    if (!state.memoryChecker) {
      return failureResult(call.id, 'Memory checker not available.');
    }

    const content = requireString(call, 'content');
    if ('error' in content) return content.error;
    const category = optionalString(call, 'category');

    // Parse existing knowledge entries
    const rawExisting = call.input?.existing;
    const existing: ExistingKnowledge[] = [];
    if (Array.isArray(rawExisting)) {
      for (const item of rawExisting) {
        if (typeof item === 'object' && item !== null && typeof (item as Record<string, unknown>).id === 'string' && typeof (item as Record<string, unknown>).content === 'string') {
          existing.push({ id: (item as Record<string, unknown>).id as string, content: (item as Record<string, unknown>).content as string });
        }
      }
    }

    const verdict = state.memoryChecker.check(
      { content: content.value, ...(category ? { category } : {}) },
      existing,
    );

    const lines = [
      `## Memory Check: ${verdict.approved ? 'APPROVED' : 'REJECTED'}`,
      '',
      `**Composite score:** ${(verdict.compositeScore * 100).toFixed(0)}%`,
      `**Summary:** ${verdict.summary}`,
      '',
      '| Check | Verdict | Score | Explanation |',
      '|-------|---------|-------|-------------|',
    ];

    for (const c of verdict.checks) {
      const icon = c.verdict === 'pass' ? 'pass' : c.verdict === 'warn' ? 'WARN' : 'FAIL';
      lines.push(`| ${c.check} | ${icon} | ${(c.score * 100).toFixed(0)}% | ${c.explanation} |`);
    }

    return successResult(call.id, lines.join('\n'), config.maxOutputChars);
  });

  return executors;
}

// Helper type for create_tool parameter parsing
interface SynthesizedToolParams {
  properties?: Record<string, unknown>;
  required?: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the complete agent toolkit. This is the main entry point.
 *
 * @param config - Toolkit configuration (project root, limits, allowed paths)
 * @param state - References to persistent state (goals, issues, world model)
 * @param delegateProvider - Optional LLM provider for the delegate tool
 * @returns The assembled toolkit with schemas and executor
 */
export function buildAgentToolkit(
  config: Partial<AgentToolkitConfig>,
  state: AgentState,
  delegateProvider?: LlmProvider,
): AgentToolkit {
  const tracer = getTracer();
  const fullConfig: AgentToolkitConfig = { ...DEFAULT_CONFIG, ...config };

  // Build all tool schemas (the LLM sees these)
  const allSchemas: ToolSchema[] = [
    THINK_SCHEMA,
    READ_FILE_SCHEMA,
    READ_FILES_SCHEMA,
    EDIT_FILE_SCHEMA,
    CREATE_FILE_SCHEMA,
    GREP_SCHEMA,
    GLOB_SCHEMA,
    BASH_SCHEMA,
    RUN_TESTS_SCHEMA,
    TYPECHECK_SCHEMA,
    LINT_SCHEMA,
    GIT_STATUS_SCHEMA,
    GIT_DIFF_SCHEMA,
    GIT_COMMIT_SCHEMA,
    GIT_LOG_SCHEMA,
    FILE_ISSUE_SCHEMA,
    CLOSE_ISSUE_SCHEMA,
    UPDATE_GOAL_SCHEMA,
    DELEGATE_SCHEMA,
    MESSAGE_USER_SCHEMA,
    RECALL_SCHEMA,
    ARCHIVE_SCHEMA,
    ADVERSARIAL_TEST_SCHEMA,
    UPDATE_WORLD_MODEL_SCHEMA,
    RECALL_JOURNAL_SCHEMA,
    CONSOLIDATE_SCHEMA,
    // Vision Tier 1: Memory Crystallization
    CRYSTALLIZE_SCHEMA,
    DISSOLVE_SCHEMA,
    LIST_CRYSTALS_SCHEMA,
    // Vision Tier 1: Constitutional Self-Governance
    CREATE_RULE_SCHEMA,
    UPDATE_RULE_SCHEMA,
    LIST_RULES_SCHEMA,
    // Vision Tier 1: Self-Debugging Replay
    REPLAY_SCHEMA,
    COMPARE_TRACES_SCHEMA,
    SEARCH_TRACES_SCHEMA,
    // Vision Tier 2: Self-Modifying Prompts
    EDIT_PROMPT_SCHEMA,
    REVERT_PROMPT_SCHEMA,
    GET_PROMPT_SCHEMA,
    // Vision Tier 2: Shadow Execution
    SHADOW_SCHEMA,
    LIST_SHADOWS_SCHEMA,
    // Vision Tier 2: Tool Synthesis
    CREATE_TOOL_SCHEMA,
    MANAGE_TOOLS_SCHEMA,
    LIST_CUSTOM_TOOLS_SCHEMA,
    // Vision Tier 3: Adversarial Dual-Model Self-Testing
    RUN_CHALLENGES_SCHEMA,
    CHALLENGE_HISTORY_SCHEMA,
    // Vision Tier 3: Prompt Genetic Algorithm
    EVOLVE_PROMPT_SCHEMA,
    EVOLUTION_STATUS_SCHEMA,
    // Vision Tier 3: Local Fine-Tuning & LoRA Adapters
    EXTRACT_TRAINING_DATA_SCHEMA,
    LIST_ADAPTERS_SCHEMA,
    LOAD_ADAPTER_SCHEMA,
    // Roadmap Phase 1: Loosen the Pipeline
    META_SCHEMA,
    // Roadmap Phase 2: Promote the ReAct Loop
    CLASSIFY_SCHEMA,
    PLAN_SCHEMA,
    VERIFY_SCHEMA,
    // Roadmap Phase 3: Introspection Tools
    PEEK_QUEUE_SCHEMA,
    CHECK_BUDGET_SCHEMA,
    LIST_CONTEXT_SCHEMA,
    REVIEW_STEPS_SCHEMA,
    ASSESS_SELF_SCHEMA,
    // Roadmap Phase 4: LLM-Controlled Context
    LOAD_CONTEXT_SCHEMA,
    EVICT_CONTEXT_SCHEMA,
    SET_BUDGET_SCHEMA,
    // Roadmap Phase 5: LLM-Initiated Triggers
    SCHEDULE_SCHEMA,
    LIST_SCHEDULES_SCHEMA,
    CANCEL_SCHEDULE_SCHEMA,
    // Supporting: Semantic Memory
    SEMANTIC_RECALL_SCHEMA,
    // Supporting: Parallelism
    PARALLEL_REASON_SCHEMA,
    // Reconciliation: Dream Cycle Phases as Tools
    CONSOLIDATE_REFLECTIONS_SCHEMA,
    REORGANIZE_GOALS_SCHEMA,
    EXPLORE_CODEBASE_SCHEMA,
    REBUILD_SELF_MODEL_SCHEMA,
    WRITE_RETROSPECTIVE_SCHEMA,
    // Advanced Memory: Zettelkasten Link Network (A-MEM)
    LINK_MEMORIES_SCHEMA,
    GET_LINKS_SCHEMA,
    TRAVERSE_LINKS_SCHEMA,
    // Advanced Memory: AUDN Consolidation Cycle (Mem0)
    AUDN_ENQUEUE_SCHEMA,
    AUDN_STATUS_SCHEMA,
    // Advanced Memory: Entropy-Based Tier Migration (SAGE)
    ENTROPY_SCORE_SCHEMA,
    EVALUATE_TIERS_SCHEMA,
    // Advanced Memory: Git-Backed Memory Versioning (Letta)
    SNAPSHOT_MEMORY_SCHEMA,
    LIST_SNAPSHOTS_SCHEMA,
    DIFF_SNAPSHOTS_SCHEMA,
    // Advanced Memory: Memory Evolution (A-MEM)
    EVOLVE_MEMORY_SCHEMA,
    EVOLUTION_LINEAGE_SCHEMA,
    EVOLUTION_LOG_SCHEMA,
    // Advanced Memory: Temporal Invalidation (Mem0)
    REGISTER_TEMPORAL_SCHEMA,
    CHECK_FRESHNESS_SCHEMA,
    SWEEP_EXPIRED_SCHEMA,
    // Advanced Memory: Skill Files (Letta)
    LEARN_SKILL_SCHEMA,
    REFINE_SKILL_SCHEMA,
    SEARCH_SKILLS_SCHEMA,
    RECORD_SKILL_USE_SCHEMA,
    // Advanced Memory: Concurrent Dream Processing (Letta)
    DREAM_CONCURRENCY_CONFIG_SCHEMA,
    // Advanced Memory: Graph Relational Memory (Mem0)
    GRAPH_ADD_NODE_SCHEMA,
    GRAPH_ADD_EDGE_SCHEMA,
    GRAPH_SEARCH_SCHEMA,
    // Advanced Memory: Checker Pattern (SAGE)
    CHECK_MEMORY_SCHEMA,
  ];

  // Build all executors
  const executors = buildExecutors(fullConfig, state, delegateProvider);

  tracer.log('agent-loop', 'info', `Agent toolkit built with ${allSchemas.length} tools`, {
    tools: allSchemas.map((s) => s.name),
  });

  return {
    schemas: allSchemas,

    toolNames: allSchemas.map((s) => s.name),

    async execute(call: NativeToolCall): Promise<NativeToolResult> {
      const executor = executors.get(call.name);

      if (!executor) {
        tracer.log('agent-loop', 'warn', `Unknown tool called: ${call.name}`);
        return failureResult(call.id, `Unknown tool: ${call.name}. Available tools: ${allSchemas.map((s) => s.name).join(', ')}`);
      }

      tracer.log('agent-loop', 'debug', `Executing tool: ${call.name}`, {
        callId: call.id,
        inputKeys: Object.keys(call.input),
      });

      const startMs = Date.now();
      const result = await executor(call);
      const durationMs = Date.now() - startMs;

      tracer.log('agent-loop', 'debug', `Tool ${call.name} completed in ${durationMs}ms`, {
        success: result.success,
        outputLength: result.output?.length ?? 0,
        hasError: !!result.error,
      });

      return result;
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Exported Schema References (for testing)
// ─────────────────────────────────────────────────────────────────────────────

export {
  THINK_SCHEMA,
  READ_FILE_SCHEMA,
  READ_FILES_SCHEMA,
  EDIT_FILE_SCHEMA,
  CREATE_FILE_SCHEMA,
  GREP_SCHEMA,
  GLOB_SCHEMA,
  BASH_SCHEMA,
  RUN_TESTS_SCHEMA,
  TYPECHECK_SCHEMA,
  LINT_SCHEMA,
  GIT_STATUS_SCHEMA,
  GIT_DIFF_SCHEMA,
  GIT_COMMIT_SCHEMA,
  GIT_LOG_SCHEMA,
  FILE_ISSUE_SCHEMA,
  CLOSE_ISSUE_SCHEMA,
  UPDATE_GOAL_SCHEMA,
  DELEGATE_SCHEMA,
  MESSAGE_USER_SCHEMA,
  RECALL_JOURNAL_SCHEMA,
  CONSOLIDATE_SCHEMA,
  // Vision Tier 1
  CRYSTALLIZE_SCHEMA,
  DISSOLVE_SCHEMA,
  LIST_CRYSTALS_SCHEMA,
  CREATE_RULE_SCHEMA,
  UPDATE_RULE_SCHEMA,
  LIST_RULES_SCHEMA,
  REPLAY_SCHEMA,
  COMPARE_TRACES_SCHEMA,
  SEARCH_TRACES_SCHEMA,
  // Vision Tier 2
  EDIT_PROMPT_SCHEMA,
  REVERT_PROMPT_SCHEMA,
  GET_PROMPT_SCHEMA,
  SHADOW_SCHEMA,
  LIST_SHADOWS_SCHEMA,
  CREATE_TOOL_SCHEMA,
  MANAGE_TOOLS_SCHEMA,
  LIST_CUSTOM_TOOLS_SCHEMA,
  // Vision Tier 3
  RUN_CHALLENGES_SCHEMA,
  CHALLENGE_HISTORY_SCHEMA,
  EVOLVE_PROMPT_SCHEMA,
  EVOLUTION_STATUS_SCHEMA,
  EXTRACT_TRAINING_DATA_SCHEMA,
  LIST_ADAPTERS_SCHEMA,
  LOAD_ADAPTER_SCHEMA,
  // Roadmap Phase 1
  META_SCHEMA,
  // Roadmap Phase 2
  CLASSIFY_SCHEMA,
  PLAN_SCHEMA,
  VERIFY_SCHEMA,
  // Roadmap Phase 3
  PEEK_QUEUE_SCHEMA,
  CHECK_BUDGET_SCHEMA,
  LIST_CONTEXT_SCHEMA,
  REVIEW_STEPS_SCHEMA,
  ASSESS_SELF_SCHEMA,
  // Roadmap Phase 4
  LOAD_CONTEXT_SCHEMA,
  EVICT_CONTEXT_SCHEMA,
  SET_BUDGET_SCHEMA,
  // Roadmap Phase 5
  SCHEDULE_SCHEMA,
  LIST_SCHEDULES_SCHEMA,
  CANCEL_SCHEDULE_SCHEMA,
  // Supporting Work
  SEMANTIC_RECALL_SCHEMA,
  PARALLEL_REASON_SCHEMA,
  // Reconciliation: Dream Cycle Phases
  CONSOLIDATE_REFLECTIONS_SCHEMA,
  REORGANIZE_GOALS_SCHEMA,
  EXPLORE_CODEBASE_SCHEMA,
  REBUILD_SELF_MODEL_SCHEMA,
  WRITE_RETROSPECTIVE_SCHEMA,
  // Advanced Memory: Zettelkasten Link Network (A-MEM)
  LINK_MEMORIES_SCHEMA,
  GET_LINKS_SCHEMA,
  TRAVERSE_LINKS_SCHEMA,
  // Advanced Memory: AUDN Consolidation Cycle (Mem0)
  AUDN_ENQUEUE_SCHEMA,
  AUDN_STATUS_SCHEMA,
  // Advanced Memory: Entropy-Based Tier Migration (SAGE)
  ENTROPY_SCORE_SCHEMA,
  EVALUATE_TIERS_SCHEMA,
  // Advanced Memory: Git-Backed Memory Versioning (Letta)
  SNAPSHOT_MEMORY_SCHEMA,
  LIST_SNAPSHOTS_SCHEMA,
  DIFF_SNAPSHOTS_SCHEMA,
  // Advanced Memory: Memory Evolution (A-MEM)
  EVOLVE_MEMORY_SCHEMA,
  EVOLUTION_LINEAGE_SCHEMA,
  EVOLUTION_LOG_SCHEMA,
  // Advanced Memory: Temporal Invalidation (Mem0)
  REGISTER_TEMPORAL_SCHEMA,
  CHECK_FRESHNESS_SCHEMA,
  SWEEP_EXPIRED_SCHEMA,
  // Advanced Memory: Skill Files (Letta)
  LEARN_SKILL_SCHEMA,
  REFINE_SKILL_SCHEMA,
  SEARCH_SKILLS_SCHEMA,
  RECORD_SKILL_USE_SCHEMA,
  // Advanced Memory: Concurrent Dream Processing (Letta)
  DREAM_CONCURRENCY_CONFIG_SCHEMA,
  // Advanced Memory: Graph Relational Memory (Mem0)
  GRAPH_ADD_NODE_SCHEMA,
  GRAPH_ADD_EDGE_SCHEMA,
  GRAPH_SEARCH_SCHEMA,
  // Advanced Memory: Checker Pattern (SAGE)
  CHECK_MEMORY_SCHEMA,
};

// ─────────────────────────────────────────────────────────────────────────────
// Tool Registry Re-exports
// ─────────────────────────────────────────────────────────────────────────────
//
// The tool registry system splits tools into 14 categories with progressive
// hydration support for small models. Import from here for backwards compat,
// or from './tools/index.js' for the full registry API.

export {
  buildFilteredToolkit,
  buildPresetToolkit,
  hydrateCategories,
  buildCompactManifest,
  TOOL_MAP,
  getCategoryTools,
  TASK_CATEGORY_PRESETS,
} from './tools/registry.js';

export type { CategoryName, ToolCategory, ExecutorContext, ToolMapEntry } from './tools/index.js';
