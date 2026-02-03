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
 * Route decision tool for the router classifier
 *
 * Used internally by the router to get structured routing decisions.
 */
export const ROUTE_DECISION_TOOL: ToolSchema = {
  name: 'route_decision',
  description: `Declare your routing decision for the user's request.

You MUST call this tool to provide your routing decision. Analyze the request and determine:
- LOCAL: For privacy-sensitive content, simple queries, or when in doubt
- CLOUD: Only for complex reasoning tasks that clearly benefit from advanced capabilities`,

  inputSchema: {
    type: 'object',
    properties: {
      route: {
        type: 'string',
        enum: ['local', 'cloud'],
        description: 'Where to route the request: "local" for privacy/simplicity, "cloud" for complex tasks',
      },
      reason: {
        type: 'string',
        description: 'Brief explanation for your routing decision (1-2 sentences)',
      },
      confidence: {
        type: 'number',
        description: 'Confidence score from 0.0 to 1.0. Use lower scores when uncertain.',
      },
    },
    required: ['route', 'reason', 'confidence'],
  },
};

/**
 * All core tools available by default
 */
export const CORE_TOOLS: ToolSchema[] = [BASH_TOOL];
