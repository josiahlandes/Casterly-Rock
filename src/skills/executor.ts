import { execSync, spawn } from 'node:child_process';
import { safeLogger } from '../logging/safe-logger.js';
import type { ToolCall, ToolResult } from './types.js';

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
  'icalbuddy ',      // Calendar read
  'remindctl ',      // Reminders (read operations)
  'memo ',           // Notes (read operations)
  'osascript -e \'tell application "Calendar" to',
  'osascript -e \'tell application "Reminders" to',
  'osascript -e \'tell application "Notes" to',
  'gh ',             // GitHub CLI
  'jq ',
  'curl ',           // Allow curl for fetching (not piping to sh)
  'open ',           // Open URLs/files
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
  // Check if it's a safe command first
  const isSafe = SAFE_COMMAND_PREFIXES.some((prefix) =>
    command.startsWith(prefix) || command.startsWith(prefix.trim())
  );

  if (isSafe) {
    // But check for pipe to shell (unsafe pattern)
    if (command.includes('| sh') || command.includes('| bash') || command.includes('| zsh')) {
      return true;
    }
    return false;
  }

  // Check if it matches approval-required patterns
  return APPROVAL_REQUIRED_PREFIXES.some((prefix) =>
    command.startsWith(prefix) || command.includes(` ${prefix}`)
  );
}

/**
 * Check if a line looks like a shell command (not output or comments)
 */
function looksLikeCommand(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return false;

  // Common command prefixes
  const commandPrefixes = [
    'curl ', 'wget ', 'echo ', 'cat ', 'ls ', 'cd ', 'mkdir ', 'rm ', 'cp ', 'mv ',
    'grep ', 'find ', 'awk ', 'sed ', 'sort ', 'uniq ', 'head ', 'tail ', 'wc ',
    'git ', 'npm ', 'node ', 'python ', 'pip ', 'brew ', 'apt ', 'yum ',
    'open ', 'osascript ', 'defaults ', 'launchctl ', 'tmux ', 'ssh ', 'scp ',
    'docker ', 'kubectl ', 'terraform ', 'aws ', 'gcloud ', 'az ',
    'jq ', 'gh ', 'icalbuddy ', 'remindctl ', 'memo ', 'date', 'cal', 'pwd', 'whoami',
    'export ', 'source ', 'alias ', 'unset ', 'set ', 'env ', 'printenv',
    'sudo ', 'chmod ', 'chown ', 'chgrp ', 'touch ', 'ln ', 'df ', 'du ', 'ps ',
    'kill ', 'pkill ', 'pgrep ', 'top ', 'htop ', 'lsof ', 'netstat ', 'ifconfig ',
  ];

  // Check if starts with known command or contains shell operators suggesting a command
  const startsWithCommand = commandPrefixes.some(prefix => trimmed.startsWith(prefix));
  const hasShellPipe = trimmed.includes(' | ') && !trimmed.includes(': ');
  const isVariable = /^[A-Z_][A-Z0-9_]*=/.test(trimmed);

  // Likely output patterns to reject
  const outputPatterns = [
    /^[A-Za-z]+:\s+[^\s]/, // "London: ⛅️" pattern
    /^###\s/,              // Markdown headers
    /^-\s+\*\*/,           // Markdown list with bold
    /^This will/i,         // Explanatory text
    /^\d+\.\s/,            // Numbered list
    /^>\s/,                // Blockquote
  ];

  if (outputPatterns.some(pat => pat.test(trimmed))) {
    return false;
  }

  return startsWithCommand || hasShellPipe || isVariable;
}

/**
 * Parse a tool call from LLM output
 * Supports formats:
 *   - ```bash\ncommand\n```
 *   - `command`
 *   - [EXEC] command
 *   - <tool>command</tool>
 */
export function parseToolCalls(text: string): ToolCall[] {
  const calls: ToolCall[] = [];

  // Match ```bash blocks
  const bashBlockRegex = /```(?:bash|sh|shell|zsh)?\n([\s\S]*?)```/g;
  let match;

  while ((match = bashBlockRegex.exec(text)) !== null) {
    const blockContent = match[1]?.trim();
    if (blockContent) {
      // Split into lines and filter for actual commands
      const lines = blockContent.split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed && looksLikeCommand(trimmed)) {
          calls.push({
            tool: 'exec',
            args: trimmed,
            requiresApproval: requiresApproval(trimmed),
          });
        }
      }
    }
  }

  // Match [EXEC] prefix
  const execPrefixRegex = /\[EXEC\]\s*(.+?)(?:\n|$)/gi;
  while ((match = execPrefixRegex.exec(text)) !== null) {
    const command = match[1]?.trim();
    if (command) {
      calls.push({
        tool: 'exec',
        args: command,
        requiresApproval: requiresApproval(command),
      });
    }
  }

  // Match <exec> tags
  const execTagRegex = /<exec>([\s\S]*?)<\/exec>/gi;
  while ((match = execTagRegex.exec(text)) !== null) {
    const command = match[1]?.trim();
    if (command) {
      calls.push({
        tool: 'exec',
        args: command,
        requiresApproval: requiresApproval(command),
      });
    }
  }

  return calls;
}

/**
 * Execute a shell command
 */
export function executeCommand(command: string, timeoutMs = 30000): ToolResult {
  // Safety check
  if (isBlocked(command)) {
    safeLogger.warn('Blocked dangerous command', { command: command.substring(0, 50) });
    return {
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
      shell: '/bin/zsh',
      env: {
        ...process.env,
        // Ensure consistent locale for parsing
        LC_ALL: 'en_US.UTF-8',
        LANG: 'en_US.UTF-8',
      },
    });

    return {
      success: true,
      output: output.trim(),
      exitCode: 0,
    };
  } catch (error) {
    const execError = error as { status?: number; stderr?: string; stdout?: string; message?: string };

    return {
      success: false,
      output: execError.stdout?.toString().trim(),
      error: execError.stderr?.toString().trim() || execError.message || 'Command failed',
      exitCode: execError.status ?? 1,
    };
  }
}

/**
 * Execute a command in the background (for long-running processes)
 */
export function executeCommandBackground(
  command: string,
  onOutput?: (data: string) => void,
  onError?: (data: string) => void,
  onExit?: (code: number | null) => void
): { pid: number; kill: () => void } {
  const child = spawn(command, {
    shell: '/bin/zsh',
    detached: false,
    env: {
      ...process.env,
      LC_ALL: 'en_US.UTF-8',
      LANG: 'en_US.UTF-8',
    },
  });

  if (child.stdout && onOutput) {
    child.stdout.on('data', (data: Buffer) => onOutput(data.toString()));
  }

  if (child.stderr && onError) {
    child.stderr.on('data', (data: Buffer) => onError(data.toString()));
  }

  if (onExit) {
    child.on('exit', onExit);
  }

  return {
    pid: child.pid ?? -1,
    kill: () => child.kill(),
  };
}

/**
 * Execute multiple tool calls in sequence
 */
export async function executeToolCalls(
  calls: ToolCall[],
  options: {
    requireApprovalCallback?: (call: ToolCall) => Promise<boolean>;
    autoApprove?: boolean;
  } = {}
): Promise<ToolResult[]> {
  const results: ToolResult[] = [];

  for (const call of calls) {
    if (call.tool !== 'exec') {
      results.push({
        success: false,
        error: `Unknown tool: ${call.tool}`,
      });
      continue;
    }

    // Check if approval is needed
    if (call.requiresApproval && !options.autoApprove) {
      if (options.requireApprovalCallback) {
        const approved = await options.requireApprovalCallback(call);
        if (!approved) {
          results.push({
            success: false,
            error: 'Command requires approval but was denied',
          });
          continue;
        }
      } else {
        results.push({
          success: false,
          error: 'Command requires approval but no approval callback provided',
        });
        continue;
      }
    }

    const result = executeCommand(call.args);
    results.push(result);

    // Stop on first failure
    if (!result.success) {
      break;
    }
  }

  return results;
}
