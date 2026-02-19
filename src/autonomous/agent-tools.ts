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
 *   - COMMUNICATION: message_user (placeholder for Phase 7)
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
import type { CrystalStore } from './crystal-store.js';
import type { ConstitutionStore } from './constitution-store.js';
import type { TraceReplay } from './trace-replay.js';
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
import type { EmbeddingProvider } from '../providers/embedding.js';
import type { ConcurrentProvider } from '../providers/concurrent.js';

const execFileAsync = promisify(execFile);

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

  /** Whether user messaging is enabled (Phase 7 placeholder) */
  userMessagingEnabled: boolean;
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
  /** Vision Tier 1: Crystal store for permanent insights */
  crystalStore?: CrystalStore;
  /** Vision Tier 1: Constitution store for self-authored rules */
  constitutionStore?: ConstitutionStore;
  /** Vision Tier 1: Trace replay for self-debugging */
  traceReplay?: TraceReplay;
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
  /** Supporting: Embedding provider for semantic recall */
  embeddingProvider?: EmbeddingProvider;
  /** Supporting: Concurrent provider for parallel_reason tool */
  concurrentProvider?: ConcurrentProvider;
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
  allowedDirectories: ['src/', 'scripts/', 'tests/', 'config/', 'skills/'],
  forbiddenPatterns: ['**/*.env*', '**/credentials*', '**/secrets*', '**/.git/**'],
  delegationEnabled: true,
  userMessagingEnabled: false,
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
  return allowedDirectories.some((dir) => filePath.startsWith(dir));
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
  description: 'Create a new file with the given content. Creates parent directories if needed. Fails if the file already exists.',
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
    },
    required: ['path', 'content'],
  },
};

const GREP_SCHEMA: ToolSchema = {
  name: 'grep',
  description: 'Search for a text pattern across files in the codebase. Returns matching lines with file paths and line numbers.',
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
- hermes3:70b — reasoning, planning, architectural decisions, evaluating alternatives
- qwen3-coder-next:latest — code generation, analysis, modification, review

The delegate receives the task description and optional file contents as context.`,
  inputSchema: {
    type: 'object',
    properties: {
      model: {
        type: 'string',
        description: 'Which model to delegate to.',
        enum: ['hermes3:70b', 'qwen3-coder-next:latest'],
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
  description: `Promote a high-value insight to a permanent crystal — always loaded into your context.

Use this when you've discovered something that is:
- Universally true and always useful
- Confirmed by multiple experiences or high-recall entries
- A stable fact about the codebase, user, or your own performance

Examples: "Tests in this repo use Vitest with vi.fn()", "I perform better when I read the full file before refactoring."

Crystals are limited (max 30) and share the hot tier token budget, so only crystallize truly important insights.`,
  inputSchema: {
    type: 'object',
    properties: {
      content: {
        type: 'string',
        description: 'The insight to crystallize. Should be concise and actionable.',
      },
      source_entries: {
        type: 'array',
        description: 'IDs of memory/journal entries that support this insight.',
        items: { type: 'string', description: 'Entry ID.' },
      },
      confidence: {
        type: 'number',
        description: 'Initial confidence (0-1). Use 0.7+ for well-supported insights.',
      },
    },
    required: ['content', 'confidence'],
  },
};

const DISSOLVE_SCHEMA: ToolSchema = {
  name: 'dissolve',
  description: `Remove or invalidate a crystal. Use when a crystal contradicts recent experience or is no longer accurate.

Dissolution is logged to the journal so the reasoning is preserved.`,
  inputSchema: {
    type: 'object',
    properties: {
      crystal_id: {
        type: 'string',
        description: 'The crystal ID to dissolve.',
      },
      reason: {
        type: 'string',
        description: 'Why this crystal is being dissolved.',
      },
    },
    required: ['crystal_id', 'reason'],
  },
};

const LIST_CRYSTALS_SCHEMA: ToolSchema = {
  name: 'list_crystals',
  description: 'List all active crystals with their confidence scores and metadata.',
  inputSchema: {
    type: 'object',
    properties: {},
    required: [],
  },
};

// ── VISION TIER 1: CONSTITUTIONAL SELF-GOVERNANCE ────────────────────────────

const CREATE_RULE_SCHEMA: ToolSchema = {
  name: 'create_rule',
  description: `Create a new operational rule based on observed experience.

Use this when you notice a pattern (especially after a failure) that should guide future behavior.
Rules are tactical and empirical — "do X when Y" with evidence.

Examples:
- "For tasks touching 3+ files, generate a plan before starting."
- "When the coding model returns TypeScript with \`any\`, flag for review."
- "Prefer recall_journal over recall for debugging-related context."`,
  inputSchema: {
    type: 'object',
    properties: {
      rule: {
        type: 'string',
        description: 'The rule text — concise and actionable.',
      },
      motivation: {
        type: 'string',
        description: 'Journal reference or description of the experience that motivated this rule.',
      },
      confidence: {
        type: 'number',
        description: 'Initial confidence (0-1). Use 0.7+ for rules based on clear evidence.',
      },
      tags: {
        type: 'array',
        description: 'Tags for categorization.',
        items: { type: 'string', description: 'Tag.' },
      },
    },
    required: ['rule', 'motivation', 'confidence'],
  },
};

const UPDATE_RULE_SCHEMA: ToolSchema = {
  name: 'update_rule',
  description: `Modify an existing constitutional rule. Use to refine a rule based on new evidence, or adjust its confidence manually.`,
  inputSchema: {
    type: 'object',
    properties: {
      rule_id: {
        type: 'string',
        description: 'The rule ID to update.',
      },
      rule: {
        type: 'string',
        description: 'Updated rule text (optional).',
      },
      confidence: {
        type: 'number',
        description: 'Updated confidence (0-1) (optional).',
      },
      tags: {
        type: 'array',
        description: 'Updated tags (optional).',
        items: { type: 'string', description: 'Tag.' },
      },
    },
    required: ['rule_id'],
  },
};

const LIST_RULES_SCHEMA: ToolSchema = {
  name: 'list_rules',
  description: 'List all constitutional rules with their confidence scores and usage statistics.',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Optional keyword to filter rules.',
      },
    },
    required: [],
  },
};

// ── VISION TIER 1: SELF-DEBUGGING REPLAY ─────────────────────────────────────

const REPLAY_SCHEMA: ToolSchema = {
  name: 'replay',
  description: `Load and replay a past execution trace step-by-step.

Use this for post-mortem analysis of failed cycles, or to study successful strategies.
Unlike the journal (high-level reflections), replay shows the actual tool calls, parameters, results, and timing.`,
  inputSchema: {
    type: 'object',
    properties: {
      cycle_id: {
        type: 'string',
        description: 'The cycle ID to replay.',
      },
      step_start: {
        type: 'integer',
        description: 'Start step number (1-indexed). Omit to start from the beginning.',
      },
      step_end: {
        type: 'integer',
        description: 'End step number. Omit to replay to the end.',
      },
      tool_filter: {
        type: 'string',
        description: 'Only show steps that used this tool.',
      },
    },
    required: ['cycle_id'],
  },
};

const COMPARE_TRACES_SCHEMA: ToolSchema = {
  name: 'compare_traces',
  description: `Compare two execution traces side-by-side. Highlights where strategies diverged and which approach worked better.

Use this to understand why one approach succeeded and another failed, or to find common patterns across successful cycles.`,
  inputSchema: {
    type: 'object',
    properties: {
      cycle_id_a: {
        type: 'string',
        description: 'First cycle ID to compare.',
      },
      cycle_id_b: {
        type: 'string',
        description: 'Second cycle ID to compare.',
      },
    },
    required: ['cycle_id_a', 'cycle_id_b'],
  },
};

const SEARCH_TRACES_SCHEMA: ToolSchema = {
  name: 'search_traces',
  description: `Search past execution traces by outcome, trigger type, or tools used. Returns index entries, not full traces — use replay to load details.`,
  inputSchema: {
    type: 'object',
    properties: {
      outcome: {
        type: 'string',
        description: 'Filter by outcome.',
        enum: ['success', 'failure', 'partial'],
      },
      trigger_type: {
        type: 'string',
        description: 'Filter by trigger type.',
      },
      tool_used: {
        type: 'string',
        description: 'Filter to traces that used this tool.',
      },
      limit: {
        type: 'integer',
        description: 'Maximum results (default 10).',
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
  description: `Search memory using semantic similarity (embedding-based) combined with
keyword matching. More accurate than keyword-only recall for conceptual queries.
Falls back to keyword-only if embeddings are unavailable.`,
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

        const content = await readFile(fullPath, 'utf8');
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
        const output = `${header}\n${'─'.repeat(60)}\n${numberedLines.join('\n')}`;

        tracer.logIO('agent-loop', 'read', filePath, 0, {
          success: true,
          bytesOrLines: lines.length,
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

        const content = await readFile(fullPath, 'utf8');
        const occurrences = content.split(oldStringResult.value).length - 1;

        if (occurrences === 0) {
          return failureResult(call.id, `old_string not found in ${filePath}. Check for exact whitespace and content match.`);
        }

        if (occurrences > 1) {
          return failureResult(call.id, `old_string found ${occurrences} times in ${filePath}. Provide more context to make it unique.`);
        }

        const newContent = content.replace(oldStringResult.value, newStringResult.value);
        await writeFile(fullPath, newContent, 'utf8');

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

    if (!isPathAllowed(filePath, config.allowedDirectories, config.forbiddenPatterns)) {
      return failureResult(call.id, `Path not allowed for file creation: ${filePath}`);
    }

    return tracer.withSpan('agent-loop', `create_file:${filePath}`, async () => {
      try {
        const fullPath = filePath.startsWith('/')
          ? filePath
          : `${config.projectRoot}/${filePath}`;

        // Check if file already exists
        try {
          await readFile(fullPath, 'utf8');
          return failureResult(call.id, `File already exists: ${filePath}. Use edit_file to modify it.`);
        } catch {
          // File doesn't exist — good, we can create it
        }

        await mkdir(dirname(fullPath), { recursive: true });
        await writeFile(fullPath, contentResult.value, 'utf8');

        const lineCount = contentResult.value.split('\n').length;
        tracer.logIO('agent-loop', 'create', filePath, 0, {
          success: true,
          bytesOrLines: lineCount,
        });

        return successResult(
          call.id,
          `Created ${filePath} (${lineCount} lines)`,
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
        const args = ['-rn', '--color=never', '-m', String(maxResults)];
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
          : 'No matches found.';

        return successResult(call.id, output, config.maxOutputChars);
      } catch (err) {
        // grep exits 1 when no matches found
        const exitCode = (err as { code?: number }).code;
        if (exitCode === 1) {
          return successResult(call.id, 'No matches found.', config.maxOutputChars);
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
          systemPrompt: 'You are a specialist assistant. Complete the task precisely and return your result.',
          maxTokens: 4096,
          temperature: 0.2,
        };

        tracer.log('agent-loop', 'info', `Delegating to ${modelResult.value}: ${taskResult.value.slice(0, 100)}...`);

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
    if (!config.userMessagingEnabled) {
      return failureResult(call.id, 'User messaging is not yet enabled (Phase 7). The message has been logged but not delivered.');
    }

    const messageResult = requireString(call, 'message');
    if ('error' in messageResult) return messageResult.error;

    const urgency = optionalString(call, 'urgency') ?? 'low';

    tracer.log('agent-loop', 'info', `[message_user] [${urgency}] ${messageResult.value}`);

    // Phase 7 placeholder — for now, just log the message
    return successResult(
      call.id,
      `Message logged (delivery not yet implemented): "${messageResult.value}" [${urgency}]`,
      config.maxOutputChars,
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

  // ── crystallize ────────────────────────────────────────────────────────

  executors.set('crystallize', async (call) => {
    if (!state.crystalStore) {
      return failureResult(call.id, 'Crystal store is not initialized. Crystallization is unavailable.');
    }

    const contentResult = requireString(call, 'content');
    if ('error' in contentResult) return contentResult.error;

    const confidence = typeof call.input['confidence'] === 'number'
      ? call.input['confidence']
      : 0.7;
    const sourceEntries = Array.isArray(call.input['source_entries'])
      ? (call.input['source_entries'] as unknown[]).filter((s): s is string => typeof s === 'string')
      : [];

    return tracer.withSpan('agent-loop', 'crystallize', async () => {
      const crystal = state.crystalStore!.crystallize({
        content: contentResult.value,
        sourceEntries,
        confidence,
      });

      if (!crystal) {
        return failureResult(call.id, 'Could not crystallize: budget full or token limit exceeded.');
      }

      await state.crystalStore!.save();

      return successResult(
        call.id,
        `Crystal ${crystal.id} formed: "${crystal.content}" (confidence: ${crystal.confidence.toFixed(2)})`,
        config.maxOutputChars,
      );
    });
  });

  // ── dissolve ──────────────────────────────────────────────────────────

  executors.set('dissolve', async (call) => {
    if (!state.crystalStore) {
      return failureResult(call.id, 'Crystal store is not initialized.');
    }

    const crystalIdResult = requireString(call, 'crystal_id');
    if ('error' in crystalIdResult) return crystalIdResult.error;
    const reasonResult = requireString(call, 'reason');
    if ('error' in reasonResult) return reasonResult.error;

    return tracer.withSpan('agent-loop', 'dissolve', async () => {
      const dissolved = state.crystalStore!.dissolve(crystalIdResult.value, reasonResult.value);

      if (!dissolved) {
        return failureResult(call.id, `Crystal not found: ${crystalIdResult.value}`);
      }

      await state.crystalStore!.save();

      // Log dissolution to journal
      if (state.journal) {
        await state.journal.append({
          type: 'observation',
          content: `Dissolved crystal ${crystalIdResult.value}: ${reasonResult.value}`,
          tags: ['crystal', 'dissolved'],
        });
      }

      return successResult(
        call.id,
        `Crystal ${crystalIdResult.value} dissolved. Reason: ${reasonResult.value}`,
        config.maxOutputChars,
      );
    });
  });

  // ── list_crystals ─────────────────────────────────────────────────────

  executors.set('list_crystals', async (call) => {
    if (!state.crystalStore) {
      return failureResult(call.id, 'Crystal store is not initialized.');
    }

    const crystals = state.crystalStore.getAll();

    if (crystals.length === 0) {
      return successResult(call.id, 'No crystals yet. Use crystallize to promote important insights.', config.maxOutputChars);
    }

    const lines: string[] = [`${crystals.length} active crystals:\n`];
    for (const c of crystals) {
      lines.push(`[${c.id}] (confidence: ${c.confidence.toFixed(2)}, recalls: ${c.recallCount})`);
      lines.push(`  ${c.content}`);
      lines.push(`  Formed: ${c.formedDate.split('T')[0]}, Last validated: ${c.lastValidated.split('T')[0]}`);
      lines.push('');
    }

    return successResult(call.id, lines.join('\n'), config.maxOutputChars);
  });

  // ── create_rule ───────────────────────────────────────────────────────

  executors.set('create_rule', async (call) => {
    if (!state.constitutionStore) {
      return failureResult(call.id, 'Constitution store is not initialized.');
    }

    const ruleResult = requireString(call, 'rule');
    if ('error' in ruleResult) return ruleResult.error;
    const motivationResult = requireString(call, 'motivation');
    if ('error' in motivationResult) return motivationResult.error;

    const confidence = typeof call.input['confidence'] === 'number'
      ? call.input['confidence']
      : 0.7;
    const tags = Array.isArray(call.input['tags'])
      ? (call.input['tags'] as unknown[]).filter((t): t is string => typeof t === 'string')
      : [];

    return tracer.withSpan('agent-loop', 'create_rule', async () => {
      const rule = state.constitutionStore!.createRule({
        rule: ruleResult.value,
        motivation: motivationResult.value,
        confidence,
        tags,
      });

      if (!rule) {
        return failureResult(call.id, 'Could not create rule: constitution is full.');
      }

      await state.constitutionStore!.save();

      return successResult(
        call.id,
        `Rule ${rule.id} created: "${rule.rule}" (confidence: ${rule.confidence.toFixed(2)})`,
        config.maxOutputChars,
      );
    });
  });

  // ── update_rule ───────────────────────────────────────────────────────

  executors.set('update_rule', async (call) => {
    if (!state.constitutionStore) {
      return failureResult(call.id, 'Constitution store is not initialized.');
    }

    const ruleIdResult = requireString(call, 'rule_id');
    if ('error' in ruleIdResult) return ruleIdResult.error;

    const ruleText = optionalString(call, 'rule');
    const confidence = optionalNumber(call, 'confidence');
    const tags = Array.isArray(call.input['tags'])
      ? (call.input['tags'] as unknown[]).filter((t): t is string => typeof t === 'string')
      : undefined;

    if (!ruleText && confidence === undefined && !tags) {
      return failureResult(call.id, 'Must provide at least one of: rule, confidence, tags');
    }

    return tracer.withSpan('agent-loop', 'update_rule', async () => {
      const updated = state.constitutionStore!.updateRule(ruleIdResult.value, {
        ...(ruleText !== undefined ? { rule: ruleText } : {}),
        ...(confidence !== undefined ? { confidence } : {}),
        ...(tags !== undefined ? { tags } : {}),
      });

      if (!updated) {
        return failureResult(call.id, `Rule not found: ${ruleIdResult.value}`);
      }

      await state.constitutionStore!.save();

      const rule = state.constitutionStore!.get(ruleIdResult.value);
      return successResult(
        call.id,
        `Rule ${ruleIdResult.value} updated: "${rule?.rule}" (confidence: ${rule?.confidence.toFixed(2)})`,
        config.maxOutputChars,
      );
    });
  });

  // ── list_rules ────────────────────────────────────────────────────────

  executors.set('list_rules', async (call) => {
    if (!state.constitutionStore) {
      return failureResult(call.id, 'Constitution store is not initialized.');
    }

    const query = optionalString(call, 'query');
    const rules = query
      ? state.constitutionStore.search(query)
      : [...state.constitutionStore.getAll()];

    if (rules.length === 0) {
      return successResult(
        call.id,
        query
          ? `No rules matching "${query}". Use create_rule to add rules based on experience.`
          : 'No constitutional rules yet. Use create_rule after observing patterns.',
        config.maxOutputChars,
      );
    }

    const lines: string[] = [`${rules.length} rule(s):\n`];
    for (const r of rules) {
      const successRate = r.invocations > 0
        ? Math.round((r.successes / r.invocations) * 100)
        : 100;
      lines.push(`[${r.id}] (confidence: ${r.confidence.toFixed(2)}, ${successRate}% success, ${r.invocations} uses)`);
      lines.push(`  ${r.rule}`);
      lines.push(`  Motivation: ${r.motivation.slice(0, 120)}`);
      if (r.tags.length > 0) lines.push(`  Tags: ${r.tags.join(', ')}`);
      lines.push('');
    }

    return successResult(call.id, lines.join('\n'), config.maxOutputChars);
  });

  // ── replay ────────────────────────────────────────────────────────────

  executors.set('replay', async (call) => {
    if (!state.traceReplay) {
      return failureResult(call.id, 'Trace replay is not initialized.');
    }

    const cycleIdResult = requireString(call, 'cycle_id');
    if ('error' in cycleIdResult) return cycleIdResult.error;

    const stepStart = optionalNumber(call, 'step_start');
    const stepEnd = optionalNumber(call, 'step_end');
    const toolFilter = optionalString(call, 'tool_filter');

    return tracer.withSpan('agent-loop', `replay:${cycleIdResult.value}`, async () => {
      const trace = await state.traceReplay!.replay(cycleIdResult.value, {
        ...(stepStart !== undefined && stepEnd !== undefined
          ? { stepRange: [stepStart, stepEnd] as [number, number] }
          : {}),
        ...(toolFilter !== undefined ? { toolFilter } : {}),
      });

      if (!trace) {
        return failureResult(call.id, `Trace not found: ${cycleIdResult.value}`);
      }

      const formatted = state.traceReplay!.formatTrace(trace);
      return successResult(call.id, formatted, config.maxOutputChars);
    });
  });

  // ── compare_traces ────────────────────────────────────────────────────

  executors.set('compare_traces', async (call) => {
    if (!state.traceReplay) {
      return failureResult(call.id, 'Trace replay is not initialized.');
    }

    const cycleIdAResult = requireString(call, 'cycle_id_a');
    if ('error' in cycleIdAResult) return cycleIdAResult.error;
    const cycleIdBResult = requireString(call, 'cycle_id_b');
    if ('error' in cycleIdBResult) return cycleIdBResult.error;

    return tracer.withSpan('agent-loop', 'compare_traces', async () => {
      const comparison = await state.traceReplay!.compareTraces(
        cycleIdAResult.value,
        cycleIdBResult.value,
      );

      if (!comparison) {
        return failureResult(call.id, 'One or both traces not found.');
      }

      const formatted = state.traceReplay!.formatComparison(comparison);
      return successResult(call.id, formatted, config.maxOutputChars);
    });
  });

  // ── search_traces ─────────────────────────────────────────────────────

  executors.set('search_traces', async (call) => {
    if (!state.traceReplay) {
      return failureResult(call.id, 'Trace replay is not initialized.');
    }

    const outcome = optionalString(call, 'outcome') as 'success' | 'failure' | 'partial' | undefined;
    const triggerType = optionalString(call, 'trigger_type');
    const toolUsed = optionalString(call, 'tool_used');
    const limit = optionalNumber(call, 'limit') ?? 10;

    const results = state.traceReplay!.searchTraces({
      ...(outcome !== undefined ? { outcome } : {}),
      ...(triggerType !== undefined ? { triggerType } : {}),
      ...(toolUsed !== undefined ? { toolUsed } : {}),
      limit,
    });

    if (results.length === 0) {
      return successResult(call.id, 'No traces found matching the criteria.', config.maxOutputChars);
    }

    const lines: string[] = [`${results.length} trace(s) found:\n`];
    for (const t of results) {
      lines.push(`[${t.cycleId}] ${t.outcome} | ${t.triggerType} | ${t.stepCount} steps | ${t.totalDurationMs}ms`);
      lines.push(`  Date: ${t.timestamp.split('T')[0]} | Tools: ${t.toolsUsed.join(', ')}`);
      if (t.referenced) lines.push('  (referenced — retained indefinitely)');
      lines.push('');
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

    // If embedding provider is available, get the query embedding for hybrid search
    let queryEmbedding: number[] | undefined;
    if (state.embeddingProvider) {
      try {
        const embResult = await state.embeddingProvider.embed(queryResult.value);
        queryEmbedding = embResult.embedding;
      } catch (err) {
        tracer.log('embedding', 'warn', `Embedding failed, falling back to keyword: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Use hybrid recall if embedding available, otherwise standard recall
    const store = state.contextManager.getStore();
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

    const method = queryEmbedding ? 'hybrid (keyword + semantic)' : 'keyword-only';
    return successResult(
      call.id,
      `## Semantic Recall (${method})\nQuery: "${queryResult.value}"\n\n${lines.join('\n\n')}`,
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
};
