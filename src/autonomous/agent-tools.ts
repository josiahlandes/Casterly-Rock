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

  return executors;
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
};
