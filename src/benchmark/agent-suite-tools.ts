/**
 * Agent Suite Tool Schemas
 *
 * Lightweight tool schema definitions for v2 agent benchmarks.
 * These are the schemas sent to the model during benchmarking so it
 * can demonstrate correct tool selection from the full agent toolkit.
 *
 * These mirror the schemas in src/autonomous/agent-tools.ts but are
 * decoupled from the agent state (GoalStack, IssueLog, etc.) so
 * benchmarks can run without requiring a full agent setup.
 */

export interface BenchmarkToolSchema {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/**
 * The full agent toolkit exposed to the model during v2 benchmarks.
 * This list should match the tools in src/autonomous/agent-tools.ts.
 */
export const AGENT_TOOL_SCHEMAS: BenchmarkToolSchema[] = [
  {
    type: 'function',
    function: {
      name: 'think',
      description: `Use this tool to reason through a problem step by step before taking action. This is a no-op tool — it has no side effects. Use it when you need to break down a complex problem, evaluate approaches, or plan a sequence of tool calls.`,
      parameters: {
        type: 'object',
        properties: {
          reasoning: { type: 'string', description: 'Your step-by-step reasoning.' },
        },
        required: ['reasoning'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read the contents of a source file. Returns the file content with line numbers.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path to the file, relative to project root.' },
          max_lines: { type: 'integer', description: 'Maximum lines to read.' },
          offset: { type: 'integer', description: 'Line to start from (1-indexed).' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description: 'Edit a file by replacing a specific text string with new text. The old_string must appear exactly once in the file.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path to the file.' },
          old_string: { type: 'string', description: 'Exact text to find and replace.' },
          new_string: { type: 'string', description: 'Replacement text.' },
        },
        required: ['path', 'old_string', 'new_string'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_file',
      description: 'Create a new file with given content. Fails if file exists.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path for the new file.' },
          content: { type: 'string', description: 'Content to write.' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'grep',
      description: 'Search for a text pattern across files in the codebase. Returns matching lines with file paths and line numbers.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Regex pattern to search for.' },
          path: { type: 'string', description: 'Directory to search in.' },
          file_pattern: { type: 'string', description: 'Glob to filter files (e.g., "*.ts").' },
          max_results: { type: 'integer', description: 'Max matches to return.' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'glob',
      description: 'Find files by name pattern. Returns a list of matching file paths.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Glob pattern (e.g., "src/**/*.ts").' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'bash',
      description: 'Execute a shell command. Use this for operations that don\'t have a dedicated tool. Prefer dedicated tools for file ops.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The shell command to execute.' },
          timeout_ms: { type: 'integer', description: 'Timeout in ms.' },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_tests',
      description: 'Run the test suite. Returns pass/fail status and output.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Test file pattern to run specific tests.' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'typecheck',
      description: 'Run the TypeScript compiler in check mode. Returns any type errors.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'lint',
      description: 'Run the project linter. Returns lint errors or warnings.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'git_status',
      description: 'Show current git status: branch, staged/unstaged changes.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'git_diff',
      description: 'Show git diff (unstaged or staged changes).',
      parameters: {
        type: 'object',
        properties: {
          staged: { type: 'boolean', description: 'Show staged changes.' },
          path: { type: 'string', description: 'Limit to specific path.' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'git_commit',
      description: 'Stage files and create a git commit.',
      parameters: {
        type: 'object',
        properties: {
          message: { type: 'string', description: 'Commit message.' },
          files: { type: 'array', items: { type: 'string' }, description: 'Files to stage.' },
        },
        required: ['message', 'files'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'git_log',
      description: 'Show recent git history.',
      parameters: {
        type: 'object',
        properties: {
          count: { type: 'integer', description: 'Number of commits.' },
          path: { type: 'string', description: 'Limit to path.' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'file_issue',
      description: 'File a new issue in your issue log when you discover a problem you can\'t fix immediately.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Short title.' },
          description: { type: 'string', description: 'Detailed description.' },
          priority: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
        },
        required: ['title', 'description', 'priority'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delegate',
      description: `Send a sub-task to a specific model. Use for focused implementation tasks that benefit from a specialized coding model. The delegate receives the task description and optional file contents as context.`,
      parameters: {
        type: 'object',
        properties: {
          model: { type: 'string', description: 'Which model to delegate to.' },
          task: { type: 'string', description: 'What the delegate should do.' },
          context_files: { type: 'array', items: { type: 'string' }, description: 'Files to include.' },
        },
        required: ['model', 'task'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_goal',
      description: 'Update the status or notes on a goal in your goal stack.',
      parameters: {
        type: 'object',
        properties: {
          goal_id: { type: 'string', description: 'Goal ID.' },
          status: { type: 'string', enum: ['pending', 'in_progress', 'blocked', 'done', 'abandoned'] },
          notes: { type: 'string', description: 'Progress notes.' },
        },
        required: ['goal_id'],
      },
    },
  },
];

/**
 * Get the list of agent tool names.
 */
export function getAgentToolNames(): string[] {
  return AGENT_TOOL_SCHEMAS.map((t) => t.function.name);
}
