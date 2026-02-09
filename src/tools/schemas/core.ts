/**
 * Core Tool Schemas
 *
 * These are the built-in tools available to the LLM.
 */

import type { ToolSchema } from './types.js';

/**
 * Bash command execution tool
 *
 * Allows the LLM to execute shell commands on the local system.
 */
export const BASH_TOOL: ToolSchema = {
  name: 'bash',
  description: `Execute a shell command on the local system.

Use this tool to:
- Read files and directories (ls, cat, head, tail)
- Search for content (grep, find)
- Get system information (date, whoami, pwd)
- Run installed CLI tools (git, npm, brew, etc.)
- Create, modify, or delete files

Safety notes:
- Destructive commands (rm, mv with overwrite) will be blocked or require approval
- Never execute commands you don't understand
- Prefer read-only commands when possible`,

  inputSchema: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'The shell command to execute. Use standard bash syntax.',
      },
    },
    required: ['command'],
  },
};

/**
 * All core tools available by default
 */
export const CORE_TOOLS: ToolSchema[] = [BASH_TOOL];
