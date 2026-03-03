/**
 * Native Tool Executor
 *
 * Executes tool calls from native LLM tool use responses.
 * Maintains safety checks for command execution.
 */

import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { safeLogger } from '../logging/safe-logger.js';
import type { NativeToolCall, NativeToolResult, NativeToolExecutor } from './schemas/types.js';

const DEFAULT_SHELL = existsSync('/bin/zsh')
  ? '/bin/zsh'
  : existsSync('/bin/bash')
    ? '/bin/bash'
    : '/bin/sh';

/** Commands that are always blocked for safety */
const BLOCKED_COMMANDS = [
  'rm -rf /',
  'rm -rf ~',
  'rm -rf /*',
  'mkfs',
  'dd if=',
  ':(){:|:&};:',  // Fork bomb
  'chmod -R 777 /',
  'chown -R',
  '> /dev/sda',
  'mv /* ',
  'wget | sh',
  'curl | sh',
  'curl | bash',
  'wget | bash',
];

/** Command prefixes that require explicit approval */
const APPROVAL_REQUIRED_PREFIXES = [
  'rm ',
  'sudo ',
  'mv ',
  'cp ',
  'chmod ',
  'chown ',
  'kill ',
  'pkill ',
  'shutdown',
  'reboot',
  'launchctl ',
  'networksetup ',
  'defaults write',
  'osascript -e \'tell application "System',
];

/** Safe read-only commands that never need approval */
const SAFE_COMMAND_PREFIXES = [
  'echo ',
  'cat ',
  'ls ',
  'pwd',
  'whoami',
  'date',
  'cal',
  'which ',
  'type ',
  'head ',
  'tail ',
  'grep ',
  'find ',
  'wc ',
  'sort ',
  'uniq ',
  'diff ',
  'file ',
  'stat ',
  'df ',
  'du ',
  'uname ',
  'env',
  'printenv',
  'icalbuddy ',
  'remindctl ',
  'memo ',
  'osascript -e \'tell application "Calendar" to',
  'osascript -e \'tell application "Reminders" to',
  'osascript -e \'tell application "Notes" to',
  'gh ',
  'jq ',
  'curl ',
  'open ',
];

/**
 * Check if a command is blocked for safety
 */
function isBlocked(command: string): boolean {
  const lower = command.toLowerCase();
  return BLOCKED_COMMANDS.some((blocked) => lower.includes(blocked.toLowerCase()));
}

/**
 * Check if a command requires user approval
 */
export function requiresApproval(command: string): boolean {
  const isSafe = SAFE_COMMAND_PREFIXES.some((prefix) =>
    command.startsWith(prefix) || command.startsWith(prefix.trim())
  );

  if (isSafe) {
    // Check for pipe to shell (unsafe pattern)
    if (command.includes('| sh') || command.includes('| bash') || command.includes('| zsh')) {
      return true;
    }
    return false;
  }

  return APPROVAL_REQUIRED_PREFIXES.some((prefix) =>
    command.startsWith(prefix) || command.includes(` ${prefix}`)
  );
}

/**
 * Execute a shell command (internal implementation)
 */
function executeCommand(command: string, timeoutMs = 30000): NativeToolResult & { toolCallId: string } {
  // Safety check
  if (isBlocked(command)) {
    safeLogger.warn('Blocked dangerous command', { command: command.substring(0, 50) });
    return {
      toolCallId: '',
      success: false,
      error: 'Command blocked for safety reasons',
      exitCode: -1,
    };
  }

  safeLogger.info('Executing command', {
    command: command.length > 100 ? command.substring(0, 100) + '...' : command,
  });

  try {
    const output = execSync(command, {
      encoding: 'utf-8',
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024, // 1MB
      shell: DEFAULT_SHELL,
      env: {
        ...process.env,
        LC_ALL: 'en_US.UTF-8',
        LANG: 'en_US.UTF-8',
      },
    });

    return {
      toolCallId: '',
      success: true,
      output: output.trim(),
      exitCode: 0,
    };
  } catch (error) {
    const execError = error as {
      status?: number;
      stderr?: string;
      stdout?: string;
      message?: string;
    };

    return {
      toolCallId: '',
      success: false,
      output: execError.stdout?.toString().trim(),
      error: execError.stderr?.toString().trim() || execError.message || 'Command failed',
      exitCode: execError.status ?? 1,
    };
  }
}

/**
 * Options for creating a bash executor
 */
export interface BashExecutorOptions {
  /** Timeout for command execution in milliseconds */
  timeoutMs?: number;

  /** Whether to auto-approve commands that normally require approval */
  autoApprove?: boolean;

  /** Callback to request approval for dangerous commands */
  approvalCallback?: (command: string) => Promise<boolean>;
}

/**
 * Execute a native tool call for the bash tool
 */
export async function executeBashToolCall(
  call: NativeToolCall,
  options: BashExecutorOptions = {}
): Promise<NativeToolResult> {
  const { timeoutMs = 30000, autoApprove = false, approvalCallback } = options;

  // Extract command from tool call input
  // Normalize: some models sometimes wraps the command in non-standard ways:
  //   {raw:{cmd:["bash","-lc","actual command"]}}  — array variant
  //   {raw:{command:"actual command"}}               — nested object variant
  let command = call.input.command;
  if (typeof command !== 'string') {
    const raw = call.input.raw as Record<string, unknown> | undefined;
    if (raw) {
      if (typeof raw.command === 'string') {
        command = raw.command;
      } else if (raw.cmd && Array.isArray(raw.cmd)) {
        const cmdArr = raw.cmd as string[];
        command = cmdArr.length >= 3 ? cmdArr[cmdArr.length - 1] : cmdArr.join(' ');
      }
    }
  }

  if (typeof command !== 'string') {
    return {
      toolCallId: call.id,
      success: false,
      error: 'Invalid tool call: command must be a string',
    };
  }

  // Check if approval is needed
  if (requiresApproval(command) && !autoApprove) {
    if (approvalCallback) {
      const approved = await approvalCallback(command);
      safeLogger.info('Bash approval decision', {
        command: command.substring(0, 80),
        approved,
        toolCallId: call.id,
      });
      if (!approved) {
        return {
          toolCallId: call.id,
          success: false,
          error: 'Command requires approval but was denied',
        };
      }
    } else {
      safeLogger.warn('Bash command blocked — no approval callback', {
        command: command.substring(0, 80),
        toolCallId: call.id,
      });
      return {
        toolCallId: call.id,
        success: false,
        error: `Command requires approval: ${command.substring(0, 50)}`,
      };
    }
  }

  const result = executeCommand(command, timeoutMs);
  return {
    ...result,
    toolCallId: call.id,
  };
}

/**
 * Create a bash executor for use with the orchestrator
 */
export function createBashExecutor(options: BashExecutorOptions = {}): NativeToolExecutor {
  return {
    toolName: 'bash',
    execute: (call: NativeToolCall) => executeBashToolCall(call, options),
  };
}
