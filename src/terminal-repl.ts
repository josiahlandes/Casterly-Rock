#!/usr/bin/env node
/**
 * Casterly Terminal REPL
 *
 * Uses the exact same dual-loop architecture as the iMessage daemon:
 * FastLoop (35B-A3B) for triage + DeepLoop (122B) for reasoning/coding.
 * Responses are delivered asynchronously via the terminal.
 *
 * Usage:
 *   npx tsx src/terminal-repl.ts              # Start REPL (dual-loop)
 *   npx tsx src/terminal-repl.ts --debug      # Start with debug output
 *   npx tsx src/terminal-repl.ts --no-dual-loop  # Fall back to standard pipeline
 *   npm run repl                              # Shortcut
 */

import { parseArgs } from 'node:util';
import * as readline from 'node:readline';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import yaml from 'yaml';

import { loadConfig } from './config/index.js';
import { buildProviders } from './providers/index.js';
import { OllamaProvider } from './providers/ollama.js';
import { MlxProvider } from './providers/mlx.js';
import { ensureMlxServerReady } from './providers/mlx-health.js';
import { ConcurrentProvider } from './providers/concurrent.js';
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
import { createDualLoopController, parseDualLoopRuntimeConfig } from './dual-loop/index.js';
import { EventBus } from './autonomous/events.js';
import { GoalStack } from './autonomous/goal-stack.js';
import { createVoiceFilter } from './imessage/voice-filter.js';
import { triggerFromMessage } from './autonomous/trigger-router.js';
import type { AutonomousController } from './autonomous/controller.js';
import { buildAgentToolkit } from './autonomous/agent-tools.js';
import { buildFilteredToolkit } from './autonomous/tools/registry.js';
import { IssueLog } from './autonomous/issue-log.js';
import { WorldModel } from './autonomous/world-model.js';

// ═══════════════════════════════════════════════════════════════════════════════
// CLI Arguments
// ═══════════════════════════════════════════════════════════════════════════════

const args = parseArgs({
  options: {
    debug: { type: 'boolean', short: 'd', default: false },
    'no-tools': { type: 'boolean', default: false },
    'no-dual-loop': { type: 'boolean', default: false },
    'prompt-file': { type: 'string', short: 'f' },
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
  --no-tools               Disable tool execution (standard pipeline only)
  --no-dual-loop           Use standard pipeline instead of dual-loop
  -f, --prompt-file <path> Send file contents as a single message, then exit
  -w, --workspace <path>   Override workspace path
  -m, --max-iterations <n> Max tool iterations per message (default: 200)
  -h, --help               Show this help

REPL COMMANDS:
  /exit, /quit             Exit the REPL
  /clear                   Reset session (start fresh conversation)
  /debug                   Toggle debug output
  /session                 Show session stats
  /mode <name>             Switch mode (code/architect/ask/review)
  /model                   Show current model info

EXAMPLES:
  npm run repl                                # Start REPL (dual-loop)
  npm run repl -- --debug                     # With debug output
  npm run repl -- --no-dual-loop              # Standard pipeline
  npm run repl -- --no-dual-loop --no-tools   # Conversation only
`;

// ═══════════════════════════════════════════════════════════════════════════════
// REPL State
// ═══════════════════════════════════════════════════════════════════════════════

let debugMode = args.values.debug ?? false;
let dualLoopActive = false;

function getDeepProviderLabel(): string {
  const mlxModel = process.env['MLX_MODEL'] || 'nightmedia/Qwen3.5-122B-A10B-Text-mxfp4-mlx';
  return `mlx:${mlxModel}`;
}

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;

  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readBooleanEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (!raw) return fallback;

  const normalized = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

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
    controller?: AutonomousController;
  },
): boolean {
  const parts = input.split(/\s+/);
  const cmd = parts[0]!.toLowerCase();

  if (cmd === '/exit' || cmd === '/quit') {
    if (deps.controller) {
      console.log('\x1b[90mStopping dual-loop...\x1b[0m');
      deps.controller.stop();
    }
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
    if (dualLoopActive) {
      console.log('\x1b[33mMode switching is not available in dual-loop mode.\x1b[0m');
      return true;
    }
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
    if (dualLoopActive) {
      const deepLabel = getDeepProviderLabel();
      console.log('\x1b[33mMode: dual-loop\x1b[0m');
      console.log(`\x1b[33mDeep: ${deepLabel} (reasoning + coding)\x1b[0m`);
      console.log('\x1b[33mFast: qwen3.5:35b-a3b (triage + status relay)\x1b[0m');
    } else {
      console.log(`\x1b[33mMode: standard pipeline\x1b[0m`);
      console.log(`\x1b[33mModel: ${deps.config.local.model}\x1b[0m`);
    }
    console.log(`\x1b[33mBase URL: ${deps.config.local.baseUrl}\x1b[0m`);
    return true;
  }

  if (cmd === '/status') {
    if (deps.controller) {
      const report = deps.controller.getStatusReport('status');
      console.log(`\x1b[33m${report}\x1b[0m`);
    } else {
      console.log('\x1b[33mNo dual-loop controller active.\x1b[0m');
    }
    return true;
  }

  console.log(`\x1b[31mUnknown command: ${cmd}\x1b[0m`);
  console.log('\x1b[33mAvailable: /exit, /clear, /debug, /session, /mode, /model, /status\x1b[0m');
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
  const noDualLoop = args.values['no-dual-loop'] ?? false;
  const maxToolIterations = args.values['max-iterations']
    ? parseInt(args.values['max-iterations'], 10)
    : 200;
  const workspaceOverride = args.values.workspace;

  // ─── Initialize ────────────────────────────────────────────────────────
  console.log('\x1b[90mInitializing Casterly...\x1b[0m');

  const config = loadConfig();
  const skillRegistry = createSkillRegistry();
  const sessionManager = createSessionManager({ scope: 'main' });
  const workspacePath = workspaceOverride || findWorkspacePath() || process.cwd();
  const modeManager = createModeManager({ autoDetect: false });

  // ─── Dual-loop or standard pipeline ────────────────────────────────────
  let controller: AutonomousController | undefined;
  let rl: readline.Interface;

  if (!noDualLoop) {
    // ── Dual-loop mode (mirrors daemon setup) ──────────────────────────
    dualLoopActive = true;

    const baseUrl = process.env['OLLAMA_BASE_URL'] || config.local.baseUrl;

    const fastProvider = new OllamaProvider({
      baseUrl,
      model: 'qwen3.5:35b-a3b',
      timeoutMs: 60_000,
      think: false, // Disable thinking for triage/review — we need plain JSON output
    });

    // DeepLoop provider: MLX (Apple Silicon-native, ~2.5x faster than Ollama).
    const mlxBaseUrl = process.env['MLX_BASE_URL'] || 'http://localhost:8000';
    const readyRetries = readPositiveIntEnv('CASTERLY_MLX_READY_RETRIES', 20);
    const retryDelayMs = readPositiveIntEnv('CASTERLY_MLX_RETRY_DELAY_MS', 3000);
    const retryTimeoutMs = readPositiveIntEnv('CASTERLY_MLX_RETRY_TIMEOUT_MS', 5000);
    const autoStart = readBooleanEnv('CASTERLY_MLX_AUTOSTART', true);
    const startWithSpec = readBooleanEnv('CASTERLY_MLX_START_WITH_SPEC', false);

    console.log(`\x1b[90mEnsuring MLX server (${readyRetries} retries, ${retryDelayMs}ms delay)...\x1b[0m`);
    await ensureMlxServerReady(mlxBaseUrl, {
      projectRoot: process.cwd(),
      maxAttempts: readyRetries,
      delayMs: retryDelayMs,
      timeoutMs: retryTimeoutMs,
      autoStart,
      startWithSpec,
    });

    const deepProvider = new MlxProvider({
      baseUrl: mlxBaseUrl,
      model: process.env['MLX_MODEL'] || 'nightmedia/Qwen3.5-122B-A10B-Text-mxfp4-mlx',
      timeoutMs: 1_800_000,
    });

    const concurrentProvider = new ConcurrentProvider(
      new Map<string, import('./providers/base.js').LlmProvider>([
        ['qwen3.5:122b', deepProvider],
        ['qwen3.5:35b-a3b', fastProvider],
      ]),
    );

    const eventBus = new EventBus({ maxQueueSize: 100, logEvents: true });
    const goalStack = new GoalStack();

    const autonomousConfigPath = join(process.cwd(), 'config', 'autonomous.yaml');
    let rawAutonomousYaml: Record<string, unknown> | undefined;
    try {
      rawAutonomousYaml = yaml.parse(await readFile(autonomousConfigPath, 'utf-8')) as Record<string, unknown>;
    } catch {
      rawAutonomousYaml = undefined;
    }

    const dualLoopRuntime = parseDualLoopRuntimeConfig(rawAutonomousYaml);

    // Load voice filter config from autonomous.yaml (same as daemon)
    let voiceFilter = createVoiceFilter(undefined);
    const voiceFilterSection = rawAutonomousYaml?.['voice_filter'];
    if (
      typeof voiceFilterSection === 'object'
      && voiceFilterSection !== null
      && !Array.isArray(voiceFilterSection)
    ) {
      voiceFilter = createVoiceFilter(voiceFilterSection as Record<string, unknown>);
    }

    // Track pending messages for piped-input shutdown
    let pendingMessages = 0;
    let stdinClosed = false;

    // Create readline before deliverFn so we can reference it
    rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    // Track deep-work at startup so piped/prompt-file mode can ignore stale
    // tasks from prior sessions and exit once newly created work is done.
    let baselineDeepWorkCount = 0;

    const getDeepWorkCount = (): number => {
      if (!controller) return 0;
      const report = controller.getStatusReport('status');
      // Parse "Tasks: N active, M queued" from the status line
      const activeMatch = report.match(/(\d+)\s*active/);
      const queuedMatch = report.match(/(\d+)\s*queued/);
      const active = activeMatch ? parseInt(activeMatch[1]!, 10) : 0;
      const queued = queuedMatch ? parseInt(queuedMatch[1]!, 10) : 0;
      return active + queued;
    };

    const hasActiveDeepWork = (): boolean => {
      return getDeepWorkCount() > baselineDeepWorkCount;
    };

    // deliverFn prints to terminal instead of sending iMessage
    const sendMessageFn = (sender: string, text: string): void => {
      // Clear current prompt line, print response, re-show prompt
      readline.clearLine(process.stdout, 0);
      readline.cursorTo(process.stdout, 0);
      console.log(`\x1b[36m${text}\x1b[0m`);

      pendingMessages--;

      // If stdin was piped and closed, exit when no pending fast messages
      // AND no active deep work (queued/planning/implementing tasks)
      if (stdinClosed && pendingMessages <= 0 && !hasActiveDeepWork()) {
        if (controller) controller.stop();
        console.log('\x1b[90mSession ended.\x1b[0m');
        process.exit(0);
      }

      rl.prompt();
    };

    // Build agent toolkit for DeepLoop tool use (read_file, bash, grep, etc.)
    // projectRoot must be the actual source code directory (process.cwd()),
    // NOT workspacePath (~/.casterly/workspace) which is a data/bootstrap dir.
    const projectRoot = process.cwd();
    const agentState = {
      goalStack,
      issueLog: new IssueLog(),
      worldModel: new WorldModel(),
    };
    const fullToolkit = buildAgentToolkit(
      { projectRoot, allowedDirectories: [projectRoot] },
      agentState,
    );
    // coding_complex categories + communication (for message_user / clarification)
    const toolkit = buildFilteredToolkit(fullToolkit, [
      'core', 'quality', 'git', 'state', 'reasoning', 'memory', 'introspection', 'communication',
    ]);

    controller = createDualLoopController({
      fastProvider,
      deepProvider,
      concurrentProvider,
      eventBus,
      goalStack,
      voiceFilter,
      coordinatorConfig: dualLoopRuntime.coordinatorConfig,
      sendMessageFn,
      toolkit,
    });

    controller.start();
    baselineDeepWorkCount = getDeepWorkCount();

    console.log('\x1b[90mMode: dual-loop\x1b[0m');
    console.log(`\x1b[90mDeep: mlx:${deepProvider.model} (reasoning + coding)\x1b[0m`);
    console.log('\x1b[90mFast: qwen3.5:35b-a3b (triage + status relay)\x1b[0m');
    console.log(`\x1b[90mDebug: ${debugMode ? 'on' : 'off'}\x1b[0m`);
    console.log(`\x1b[90mProject: ${projectRoot}\x1b[0m`);

    console.log('\n\x1b[1mCasterly Terminal REPL\x1b[0m');
    console.log('\x1b[90mType a message to talk to Tyrion. Use /help for commands.\x1b[0m\n');

    // ── Prompt-file mode: send file as single message, wait, exit ──
    const promptFilePath = args.values['prompt-file'];
    if (promptFilePath) {
      const { readFileSync } = await import('node:fs');
      const promptContent = readFileSync(promptFilePath, 'utf8').trim();
      console.log(`\x1b[90mSending prompt from ${promptFilePath} (${promptContent.length} chars)...\x1b[0m\n`);

      try {
        const trigger = triggerFromMessage(promptContent, 'Developer (terminal)');
        const outcome = await controller.runTriggeredCycle(trigger);
        if (outcome.summary) {
          console.log(`\x1b[36m${outcome.summary}\x1b[0m`);
        }
      } catch (error) {
        printError(error);
      }

      // Wait for DeepLoop to finish all work
      const pollForCompletion = (): Promise<void> =>
        new Promise((resolve) => {
          let checkCount = 0;
          const check = (): void => {
            checkCount++;
            if (!hasActiveDeepWork()) {
              // Require at least 2 consecutive "no active work" checks
              // to avoid exiting before the task is queued
              if (checkCount >= 2) {
                resolve();
              } else {
                setTimeout(check, 5000);
              }
            } else {
              checkCount = 0; // Reset — work is active
              setTimeout(check, 10000);
            }
          };
          // Give time for triage + task creation + DeepLoop claim
          setTimeout(check, 30000);
        });

      await pollForCompletion();

      // Give deliverFn a moment to print the final response
      await new Promise((resolve) => setTimeout(resolve, 3000));

      console.log('\n\x1b[90mPrompt-file execution complete.\x1b[0m');
      controller.stop();
      rl.close();
      process.exit(0);
    }

    // ── Dual-loop REPL Loop ──────────────────────────────────────────
    rl.setPrompt('\x1b[1mtyrion>\x1b[0m ');

    rl.on('close', () => {
      stdinClosed = true;
      // If no pending fast messages AND no active deep work, exit immediately
      if (pendingMessages <= 0 && !hasActiveDeepWork()) {
        if (controller) controller.stop();
        console.log('\n\x1b[90mSession ended.\x1b[0m');
        process.exit(0);
      }
      // Otherwise, deliverFn will handle shutdown after last deep response
    });

    rl.on('line', async (rawInput: string) => {
      const input = rawInput.trim();

      if (!input) {
        rl.prompt();
        return;
      }

      // Handle slash commands
      if (input.startsWith('/')) {
        if (input === '/help') {
          console.log(HELP_TEXT);
          rl.prompt();
          return;
        }
        handleSlashCommand(input, { sessionManager, modeManager, config, controller: controller! });
        rl.prompt();
        return;
      }

      // Route through dual-loop (mirrors daemon processMessage)
      pendingMessages++;
      try {
        const trigger = triggerFromMessage(input, 'Developer (terminal)');
        const outcome = await controller!.runTriggeredCycle(trigger);

        // If summary is non-empty, print it (standard mode fallback).
        // Otherwise the response arrives async via sendMessageFn.
        if (outcome.summary) {
          console.log(`\x1b[36m${outcome.summary}\x1b[0m`);
        }
      } catch (error) {
        printError(error);
      }

      rl.prompt();
    });

    rl.prompt();

  } else {
    // ── Standard pipeline mode (original behavior) ─────────────────────
    dualLoopActive = false;

    const providers = buildProviders(config);
    const jobStore = createJobStore();
    const executionLog = createExecutionLog();

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

    const deps: ProcessDependencies = {
      provider: providers.local,
      skillRegistry,
      sessionManager,
      modeManager,
      jobStore,
      taskManager,
      providers,
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
    console.log('\x1b[90mMode: standard pipeline\x1b[0m');
    console.log(`\x1b[90mModel: ${modelInfo}\x1b[0m`);
    console.log(`\x1b[90mSkills: ${availableSkills.length} loaded\x1b[0m`);
    console.log(`\x1b[90mTools: ${enableTools ? 'enabled' : 'disabled'}\x1b[0m`);
    console.log(`\x1b[90mDebug: ${debugMode ? 'on' : 'off'}\x1b[0m`);
    console.log(`\x1b[90mWorkspace: ${workspacePath}\x1b[0m`);

    console.log('\n\x1b[1mCasterly Terminal REPL\x1b[0m');
    console.log('\x1b[90mType a message to talk to Tyrion. Use /help for commands.\x1b[0m\n');

    // ── Standard REPL Loop ────────────────────────────────────────────
    rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    let processing = false;
    let stdinClosed = false;

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

        // Process message through the standard pipeline
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
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
