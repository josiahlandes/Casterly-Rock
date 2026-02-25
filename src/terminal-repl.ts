#!/usr/bin/env node
/**
 * Casterly Terminal REPL
 *
 * Send messages through the exact same pipeline as iMessage,
 * without needing an actual phone. Perfect for testing tools,
 * personality, multi-turn conversations, and debugging.
 *
 * Usage:
 *   npx tsx src/terminal-repl.ts              # Start REPL
 *   npx tsx src/terminal-repl.ts --debug      # Start with debug output
 *   npx tsx src/terminal-repl.ts --no-tools   # Disable tool execution
 *   npm run repl                              # Shortcut
 */

import { parseArgs } from 'node:util';
import * as readline from 'node:readline';

import { loadConfig } from './config/index.js';
import { buildProviders } from './providers/index.js';
import { createSkillRegistry } from './skills/index.js';
import {
  createToolRegistry,
  createToolOrchestrator,
  createBashExecutor,
  registerNativeExecutors,
} from './tools/index.js';
import {
  createSessionManager,
  findWorkspacePath,
} from './interface/index.js';
import {
  createJobStore,
  getSchedulerToolSchemas,
} from './scheduler/index.js';
import {
  createTaskManager,
  createExecutionLog,
} from './tasks/index.js';
import { createModeManager } from './coding/modes/index.js';
import { processChatMessage, type ChatInput, type ProcessDependencies, type ProcessResult } from './pipeline/index.js';
import { wrapError, formatErrorForUser } from './errors/index.js';

// ═══════════════════════════════════════════════════════════════════════════════
// CLI Arguments
// ═══════════════════════════════════════════════════════════════════════════════

const args = parseArgs({
  options: {
    debug: { type: 'boolean', short: 'd', default: false },
    'no-tools': { type: 'boolean', default: false },
    workspace: { type: 'string', short: 'w' },
    'max-iterations': { type: 'string', short: 'm' },
    help: { type: 'boolean', short: 'h', default: false },
  },
  allowPositionals: false,
});

const HELP_TEXT = `
Casterly Terminal REPL — Talk to Tyrion from the terminal

USAGE:
  npx tsx src/terminal-repl.ts [options]

OPTIONS:
  -d, --debug              Show debug output (tool calls, iterations, tokens)
  --no-tools               Disable tool execution
  -w, --workspace <path>   Override workspace path
  -m, --max-iterations <n> Max tool iterations per message (default: 5)
  -h, --help               Show this help

REPL COMMANDS:
  /exit, /quit             Exit the REPL
  /clear                   Reset session (start fresh conversation)
  /debug                   Toggle debug output
  /session                 Show session stats
  /mode <name>             Switch mode (code/architect/ask/review)
  /model                   Show current model info

EXAMPLES:
  npm run repl                                # Start REPL
  npm run repl -- --debug                     # With debug output
  npm run repl -- --no-tools                  # Conversation only
`;

// ═══════════════════════════════════════════════════════════════════════════════
// REPL State
// ═══════════════════════════════════════════════════════════════════════════════

let debugMode = args.values.debug ?? false;

// ═══════════════════════════════════════════════════════════════════════════════
// Output Helpers
// ═══════════════════════════════════════════════════════════════════════════════

function printResponse(result: ProcessResult): void {
  console.log(`\n\x1b[36m${result.response}\x1b[0m`);

  if (debugMode) {
    console.log('\n\x1b[90m--- Debug ---');
    console.log(`Iterations: ${result.iterations}`);
    console.log(`Pipeline: ${result.taskPipelineUsed ? `task (${result.taskClass})` : 'conversation'}`);
    console.log(`Model profile: ${result.modelProfile}`);
    console.log(`Estimated tokens: ${result.estimatedTokens}`);
    if (result.toolCallsMade.length > 0) {
      console.log('Tool calls:');
      for (const tc of result.toolCallsMade) {
        const status = tc.success ? '\x1b[32m✓\x1b[90m' : '\x1b[31m✗\x1b[90m';
        console.log(`  ${status} [${tc.iteration}] ${tc.name}: ${tc.inputPreview.substring(0, 80)}`);
      }
    }
    console.log('---\x1b[0m');
  }
}

function printError(error: unknown): void {
  const casterlyError = wrapError(error);
  const userMessage = formatErrorForUser(casterlyError, 'cli');
  console.log(`\n\x1b[31m${userMessage}\x1b[0m`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// REPL Command Handlers
// ═══════════════════════════════════════════════════════════════════════════════

function handleSlashCommand(
  input: string,
  deps: {
    sessionManager: ReturnType<typeof createSessionManager>;
    modeManager: ReturnType<typeof createModeManager>;
    config: ReturnType<typeof loadConfig>;
  },
): boolean {
  const parts = input.split(/\s+/);
  const cmd = parts[0]!.toLowerCase();

  if (cmd === '/exit' || cmd === '/quit') {
    console.log('\nGoodbye!');
    process.exit(0);
  }

  if (cmd === '/clear') {
    const session = deps.sessionManager.getSession('cli', 'terminal-user');
    session.clear();
    console.log('\x1b[33mSession cleared.\x1b[0m');
    return true;
  }

  if (cmd === '/debug') {
    debugMode = !debugMode;
    console.log(`\x1b[33mDebug mode: ${debugMode ? 'ON' : 'OFF'}\x1b[0m`);
    return true;
  }

  if (cmd === '/session') {
    const session = deps.sessionManager.getSession('cli', 'terminal-user');
    const history = session.getHistory(1000);
    console.log(`\x1b[33mSession: ${history.length} messages\x1b[0m`);
    return true;
  }

  if (cmd === '/mode') {
    const modeName = parts[1];
    if (!modeName) {
      const current = deps.modeManager.getCurrentMode();
      console.log(`\x1b[33mCurrent mode: ${current.name}\x1b[0m`);
      console.log('\x1b[33mAvailable: code, architect, ask, review\x1b[0m');
      return true;
    }
    deps.modeManager.autoDetectAndSwitch(`/${modeName}`);
    const current = deps.modeManager.getCurrentMode();
    console.log(`\x1b[33mSwitched to: ${current.name}\x1b[0m`);
    return true;
  }

  if (cmd === '/model') {
    console.log(`\x1b[33mModel: ${deps.config.local.model}\x1b[0m`);
    console.log(`\x1b[33mBase URL: ${deps.config.local.baseUrl}\x1b[0m`);
    return true;
  }

  console.log(`\x1b[31mUnknown command: ${cmd}\x1b[0m`);
  console.log('\x1b[33mAvailable: /exit, /clear, /debug, /session, /mode, /model\x1b[0m');
  return true;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════════════════════════════

async function main(): Promise<void> {
  if (args.values.help) {
    console.log(HELP_TEXT);
    process.exit(0);
  }

  const enableTools = !(args.values['no-tools'] ?? false);
  const maxToolIterations = args.values['max-iterations']
    ? parseInt(args.values['max-iterations'], 10)
    : 200;
  const workspaceOverride = args.values.workspace;

  // ─── Initialize (mirrors startDaemon) ─────────────────────────────────
  console.log('\x1b[90mInitializing Casterly pipeline...\x1b[0m');

  const config = loadConfig();
  const providers = buildProviders(config);
  const skillRegistry = createSkillRegistry();
  const sessionManager = createSessionManager({ scope: 'main' });
  const workspacePath = workspaceOverride || findWorkspacePath() || process.cwd();
  const modeManager = createModeManager({ autoDetect: false });
  const jobStore = createJobStore();
  const executionLog = createExecutionLog();

  // Task manager (same setup as daemon)
  const startupToolRegistry = createToolRegistry();
  const startupOrchestrator = createToolOrchestrator();
  startupOrchestrator.registerExecutor(createBashExecutor({ autoApprove: true }));
  registerNativeExecutors(startupOrchestrator);
  for (const tool of getSchedulerToolSchemas()) {
    startupToolRegistry.register(tool);
  }

  const taskManager = createTaskManager({
    orchestrator: startupOrchestrator,
    executionLog,
    availableTools: startupToolRegistry.getTools(),
  });

  // Build shared dependencies
  const deps: ProcessDependencies = {
    provider: providers.local,
    skillRegistry,
    sessionManager,
    modeManager,
    jobStore,
    taskManager,
    providers,
    // No approvalBridge — auto-approve at terminal
  };

  const processOptions = {
    enableTools,
    maxToolIterations,
    workspacePath,
  };

  const availableSkills = skillRegistry.getAvailable();

  const modelInfo = config.local.codingModel && config.local.codingModel !== config.local.model
    ? `${config.local.model} (primary) / ${config.local.codingModel} (coding)`
    : config.local.model;
  console.log(`\x1b[90mModel: ${modelInfo}\x1b[0m`);
  console.log(`\x1b[90mSkills: ${availableSkills.length} loaded\x1b[0m`);
  console.log(`\x1b[90mTools: ${enableTools ? 'enabled' : 'disabled'}\x1b[0m`);
  console.log(`\x1b[90mDebug: ${debugMode ? 'on' : 'off'}\x1b[0m`);
  console.log(`\x1b[90mWorkspace: ${workspacePath}\x1b[0m`);

  console.log('\n\x1b[1mCasterly Terminal REPL\x1b[0m');
  console.log('\x1b[90mType a message to talk to Tyrion. Use /help for commands.\x1b[0m\n');

  // ─── REPL Loop ────────────────────────────────────────────────────────
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  // Track whether we're processing a message (prevents premature exit on pipe close)
  let processing = false;
  let stdinClosed = false;

  // Handle stdin close gracefully (e.g. when piping input)
  rl.on('close', () => {
    stdinClosed = true;
    if (!processing) {
      console.log('\n\x1b[90mSession ended.\x1b[0m');
      process.exit(0);
    }
  });

  const prompt = (): void => {
    if (stdinClosed) {
      console.log('\n\x1b[90mSession ended.\x1b[0m');
      process.exit(0);
      return;
    }

    rl.question('\x1b[1mtyrion>\x1b[0m ', async (rawInput) => {
      const input = rawInput.trim();

      if (!input) {
        prompt();
        return;
      }

      // Handle slash commands
      if (input.startsWith('/')) {
        if (input === '/help') {
          console.log(HELP_TEXT);
          prompt();
          return;
        }
        handleSlashCommand(input, { sessionManager, modeManager, config });
        prompt();
        return;
      }

      // Process message through the shared pipeline
      const chatInput: ChatInput = {
        text: input,
        sender: 'terminal-user',
        senderLabel: 'Developer (terminal)',
        channel: 'cli',
      };

      processing = true;
      try {
        const result = await processChatMessage(chatInput, deps, processOptions);
        printResponse(result);
      } catch (error) {
        printError(error);
      }
      processing = false;

      console.log('');

      if (stdinClosed) {
        console.log('\x1b[90mSession ended.\x1b[0m');
        process.exit(0);
        return;
      }
      prompt();
    });
  };

  prompt();
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
