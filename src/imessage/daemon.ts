/**
 * iMessage Daemon
 *
 * Mac Studio Edition - Local Ollama Only
 */

import { join } from 'node:path';
import { loadConfig } from '../config/index.js';
import { safeLogger } from '../logging/safe-logger.js';
import { buildProviders, type LlmProvider } from '../providers/index.js';
import { createSkillRegistry, type SkillRegistry } from '../skills/index.js';
import {
  createToolRegistry,
  createToolOrchestrator,
  createBashExecutor,
  registerNativeExecutors,
} from '../tools/index.js';
import {
  createSessionManager,
  findWorkspacePath,
  loadAddressBook,
  addContact,
  removeContact,
  getAllowedPhones,
  isAdmin,
  findContactByPhone,
  type SessionManager,
  type AddressBook,
} from '../interface/index.js';
import { wrapError, formatErrorForUser } from '../errors/index.js';
import { getMessagesSince, getLatestMessageRowId, type Message } from './reader.js';
import { sendMessage, checkMessagesAvailable } from './sender.js';
import { guardInboundMessage } from './input-guard.js';
import {
  createJobStore,
  getSchedulerToolSchemas,
  checkDueJobs,
  parseCronExpression,
  getNextFireTime,
  type JobStore,
  type ActionableHandler,
} from '../scheduler/index.js';
import {
  createApprovalStore,
  createApprovalBridge,
  type ApprovalBridge,
} from '../approval/index.js';
import {
  createTaskManager,
  createExecutionLog,
  type TaskManager,
  type ExecutionLog,
} from '../tasks/index.js';
import {
  AutonomousLoop,
  loadConfig as loadAutonomousConfig,
  createProvider as createAutonomousProvider,
  createAutonomousController,
  type AutonomousController,
} from '../autonomous/index.js';
import {
  createModeManager,
  type ModeManager,
} from '../coding/modes/index.js';
import { processChatMessage, type ChatInput } from '../pipeline/index.js';

export interface DaemonConfig {
  pollIntervalMs: number;
  enableTools?: boolean | undefined;
  maxToolIterations?: number | undefined;
  workspacePath?: string | undefined;
  sessionScope?: 'main' | 'per-peer' | undefined;
}

/**
 * Process an incoming message through Casterly and send a response
 */
async function processMessage(
  message: Message,
  provider: LlmProvider,
  skillRegistry: SkillRegistry,
  sessionManager: SessionManager,
  options: {
    enableTools: boolean;
    maxToolIterations: number;
    workspacePath: string;
    jobStore?: JobStore | undefined;
    approvalBridge?: ApprovalBridge | undefined;
    taskManager?: TaskManager | undefined;
    autonomousController?: AutonomousController | undefined;
    modeManager?: ModeManager | undefined;
  }
): Promise<void> {
  const sender = message.senderHandle || message.chatId;
  const { enableTools, maxToolIterations, workspacePath, jobStore, approvalBridge, taskManager, autonomousController, modeManager } = options;

  // ─── Autonomous commands (bypass LLM entirely) ─────────────────────
  const autonomousReply = handleAutonomousCommand(message.text, autonomousController);
  if (autonomousReply !== null) {
    const sender = message.senderHandle || message.chatId;
    const result = sendMessage(sender, autonomousReply);
    if (result.success) {
      safeLogger.info('Autonomous command handled', { command: message.text.substring(0, 30) });
    } else {
      safeLogger.error('Failed to send autonomous command reply', { error: result.error });
    }
    return;
  }

  // Build ChatInput for the shared pipeline
  const contact = findContactByPhone(sender);
  const senderLabel = contact ? `${contact.name} (${sender})` : sender;
  const chatInput: ChatInput = {
    text: message.text,
    sender,
    senderLabel,
    channel: 'imessage',
  };

  try {
    const pipelineResult = await processChatMessage(chatInput, {
      provider,
      skillRegistry,
      sessionManager,
      modeManager,
      jobStore,
      approvalBridge,
      taskManager,
    }, {
      enableTools,
      maxToolIterations,
      workspacePath,
    });

    const result = sendMessage(sender, pipelineResult.response);
    if (result.success) {
      safeLogger.info('Response sent successfully');
    } else {
      safeLogger.error('Failed to send response', { error: result.error });
    }
  } catch (error) {
    const casterlyError = wrapError(error);

    safeLogger.error('Failed to generate response', {
      code: casterlyError.code,
      category: casterlyError.category,
      message: casterlyError.message,
      details: casterlyError.details,
    });

    const errorMessage = formatErrorForUser(casterlyError, 'imessage');
    const result = sendMessage(sender, errorMessage);
    if (!result.success) {
      safeLogger.error('Failed to send error message', { error: result.error });
    }
  }
}

// ─── Autonomous Command Patterns ─────────────────────────────────────────────

const AUTONOMOUS_START_RE = /^start\s+autonomous$/i;
const AUTONOMOUS_STOP_RE = /^stop\s+autonomous$/i;
const AUTONOMOUS_STATUS_RE = /^autonomous\s+status$/i;

/**
 * Try to handle the message as a direct autonomous command.
 * Returns the reply string if handled, or null if not an autonomous command.
 */
function handleAutonomousCommand(
  text: string,
  controller?: AutonomousController,
): string | null {
  const trimmed = text.trim();

  if (AUTONOMOUS_START_RE.test(trimmed)) {
    if (!controller) return 'Autonomous mode is not configured.';
    controller.start();
    return 'Autonomous mode started. I will run self-improvement cycles continuously and only pause for incoming messages.';
  }

  if (AUTONOMOUS_STOP_RE.test(trimmed)) {
    if (!controller) return 'Autonomous mode is not configured.';
    controller.stop();
    return 'Autonomous mode stopped.';
  }

  if (AUTONOMOUS_STATUS_RE.test(trimmed)) {
    if (!controller) return 'Autonomous mode is not configured.';
    const s = controller.getStatus();
    const lines = [
      `Autonomous: ${s.enabled ? 'ENABLED' : 'DISABLED'}`,
      `Status: ${s.busy ? 'running a cycle' : 'idle'}`,
      `Cycles completed: ${s.totalCycles} (${s.successfulCycles} successful)`,
      `Last cycle: ${s.lastCycleAt ?? 'never'}`,
      `Next cycle: ${s.nextCycleIn}`,
    ];
    return lines.join('\n');
  }

  return null;
}

// ─── Admin Command Patterns ──────────────────────────────────────────────────

const ADD_CONTACT_RE = /^add\s+contact\s+(\S+)\s+(\+?\d[\d\s\-().]+)$/i;
const REMOVE_CONTACT_RE = /^remove\s+contact\s+(\S+)$/i;
const LIST_CONTACTS_RE = /^list\s+contacts$/i;

/**
 * Try to handle the message as an admin command for contacts management.
 * Returns the reply string if handled, or null if not an admin command.
 * Only the admin phone can execute these commands.
 */
function handleAdminCommand(
  text: string,
  sender: string,
  book: AddressBook,
): string | null {
  const trimmed = text.trim();

  // Check add contact
  const addMatch = ADD_CONTACT_RE.exec(trimmed);
  if (addMatch) {
    if (!isAdmin(sender, book)) return null;
    const name = addMatch[1]!;
    const phone = addMatch[2]!.trim();
    try {
      const contact = addContact(name, phone);
      safeLogger.info('Admin: contact added', { name: contact.name, phone: contact.phone });
      return `Contact added: ${contact.name} (${contact.phone})`;
    } catch (error) {
      return `Failed to add contact: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  // Check remove contact
  const removeMatch = REMOVE_CONTACT_RE.exec(trimmed);
  if (removeMatch) {
    if (!isAdmin(sender, book)) return null;
    const name = removeMatch[1]!;
    const removed = removeContact(name);
    if (removed) {
      safeLogger.info('Admin: contact removed', { name });
      return `Contact removed: ${name}`;
    }
    return `Contact not found: ${name}`;
  }

  // Check list contacts
  if (LIST_CONTACTS_RE.test(trimmed)) {
    if (!isAdmin(sender, book)) return null;
    if (book.contacts.length === 0) {
      return 'No contacts in address book.';
    }
    const lines = book.contacts.map((c) => `- ${c.name}: ${c.phone}`);
    return `Address book (${book.contacts.length}):\n${lines.join('\n')}`;
  }

  return null;
}

/**
 * Check if a sender is allowed (if allowlist is configured)
 */
function isSenderAllowed(sender: string, allowedSenders?: string[]): boolean {
  if (!allowedSenders || allowedSenders.length === 0) {
    return true;
  }

  const normalize = (s: string) => s.replace(/[\s\-\(\)\.]/g, '').toLowerCase();
  const normalizedSender = normalize(sender);

  return allowedSenders.some((allowed) => {
    const normalizedAllowed = normalize(allowed);
    return normalizedSender.includes(normalizedAllowed) || normalizedAllowed.includes(normalizedSender);
  });
}

/**
 * Compute the next fire time for the daily 8am report cron job.
 */
function getNextReportTime(): number {
  const cron = parseCronExpression('0 8 * * *');
  if (!cron) return Date.now() + 24 * 60 * 60 * 1000; // Fallback: 24h from now
  return getNextFireTime(cron, new Date()).getTime();
}

/**
 * Start the iMessage daemon
 */
export async function startDaemon(daemonConfig: DaemonConfig): Promise<void> {
  const {
    pollIntervalMs,
    enableTools = true,
    maxToolIterations = 5,
    workspacePath,
    sessionScope = 'per-peer',
  } = daemonConfig;

  // Check if Messages is available
  const messagesCheck = checkMessagesAvailable();
  if (!messagesCheck.available) {
    throw new Error(`iMessage not available: ${messagesCheck.error}`);
  }

  // Load address book (contacts + admin)
  let addressBook = loadAddressBook();
  let allowedSenders = getAllowedPhones(addressBook);

  safeLogger.info('Address book loaded', {
    admin: addressBook.admin ? addressBook.admin.substring(0, 4) + '***' : 'none',
    contacts: addressBook.contacts.length,
    allowedPhones: allowedSenders.length,
  });

  // Find workspace path (single workspace for all contacts)
  const defaultWorkspacePath = workspacePath || findWorkspacePath() || join(process.cwd(), 'workspace');

  safeLogger.info('iMessage daemon starting', {
    pollIntervalMs,
    hasAllowlist: allowedSenders.length > 0,
    enableTools,
    maxToolIterations,
    defaultWorkspacePath,
    sessionScope,
  });

  // Load Casterly config and providers
  const config = loadConfig();
  const providers = buildProviders(config);

  safeLogger.info('Using local provider (Ollama)', {
    model: config.local.model,
  });

  // Load skills (for context, not for text-parsing)
  const skillRegistry = createSkillRegistry();
  const availableSkills = skillRegistry.getAvailable();
  safeLogger.info('Loaded skills', {
    total: skillRegistry.skills.size,
    available: availableSkills.length,
    names: availableSkills.map((s) => s.id),
  });

  // Create session manager
  const sessionManager = createSessionManager({
    scope: sessionScope,
  });

  safeLogger.info('Session manager initialized', { scope: sessionScope });

  // Per-peer mode managers (code/architect/ask/review)
  const modeManagers = new Map<string, ModeManager>();

  // Create scheduler job store
  const jobStore = createJobStore();
  safeLogger.info('Scheduler job store initialized', { activeJobs: jobStore.getActive().length });

  // Create approval bridge for async command approval
  const approvalStore = createApprovalStore();
  const approvalBridge = createApprovalBridge(
    approvalStore, sendMessage, getMessagesSince, getLatestMessageRowId,
  );
  safeLogger.info('Approval bridge initialized');

  // Create task pipeline (classifier → planner → runner → verifier → manager)
  const executionLog = createExecutionLog();
  // Task manager needs an orchestrator and tool list — we create a shared one for startup.
  // Each processMessage() call creates its own tool registry/orchestrator for per-message state,
  // but the task manager is shared across calls for operational memory continuity.
  const startupToolRegistry = createToolRegistry();
  const startupOrchestrator = createToolOrchestrator();
  startupOrchestrator.registerExecutor(createBashExecutor({ autoApprove: true }));
  registerNativeExecutors(startupOrchestrator);
  if (jobStore) {
    for (const tool of getSchedulerToolSchemas()) {
      startupToolRegistry.register(tool);
    }
  }

  const taskManager = createTaskManager({
    orchestrator: startupOrchestrator,
    executionLog,
    availableTools: startupToolRegistry.getTools(),
  });
  safeLogger.info('Task pipeline initialized', { executionLogRecords: executionLog.count() });

  // ── Autonomous controller ──────────────────────────────────────────────
  // Attempt to load autonomous config and create the controller.
  // If the autonomous module is not configured, the controller stays undefined
  // and autonomous commands will respond with "not configured".
  let autonomousController: AutonomousController | undefined;

  try {
    const autonomousConfigPath = join(process.cwd(), 'config', 'autonomous.yaml');
    const autonomousConfig = await loadAutonomousConfig(autonomousConfigPath);
    const autonomousProvider = await createAutonomousProvider(autonomousConfig);
    const autonomousLoop = new AutonomousLoop(autonomousConfig, process.cwd(), autonomousProvider);

    autonomousController = createAutonomousController({
      loop: autonomousLoop,
      cycleIntervalMinutes: autonomousConfig.cycleIntervalMinutes,
    });

    safeLogger.info('Autonomous controller initialized', {
      model: autonomousConfig.model,
      interval: autonomousConfig.cycleIntervalMinutes,
    });

    // Schedule daily 8am report if not already present
    const reportJobId = 'daily-autonomous-report';
    const existingReport = jobStore.getById(reportJobId);
    if (!existingReport) {
      jobStore.add({
        id: reportJobId,
        triggerType: 'cron',
        status: 'active',
        cronExpression: '0 8 * * *',
        nextFireTime: getNextReportTime(),
        recipient: allowedSenders?.[0] ?? '',
        message: 'Generate and send the daily autonomous progress report',
        description: 'Daily autonomous report (8am)',
        createdAt: Date.now(),
        fireCount: 0,
        source: 'system',
        label: 'autonomous-daily-report',
        actionable: true,
      });
      safeLogger.info('Scheduled daily autonomous report at 8am');
    }
  } catch (error) {
    safeLogger.warn('Autonomous controller not available', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // ── Actionable job handler ───────────────────────────────────────────────
  // When a scheduled job fires with actionable=true, this callback creates
  // a synthetic Message and runs it through the full processMessage() pipeline
  // so the LLM actually executes the task (check weather, summarize emails, etc.)
  // instead of sending a static reminder string.
  const actionableHandler: ActionableHandler = async (recipient, instruction, jobId) => {
    safeLogger.info('Actionable job: creating synthetic message', { jobId, recipient: recipient.substring(0, 4) + '***' });

    // Build a synthetic Message that looks like a user message
    const syntheticMessage: Message = {
      rowid: -1,  // Negative rowid signals synthetic origin
      guid: `scheduled-${jobId}`,
      text: instruction,
      isFromMe: false,
      date: new Date(),
      chatId: recipient,
      senderHandle: recipient,
    };

    // Get or create per-peer mode manager for scheduled jobs
    if (!modeManagers.has(recipient)) {
      modeManagers.set(recipient, createModeManager({ autoDetect: false }));
    }

    await processMessage(syntheticMessage, providers.local, skillRegistry, sessionManager, {
      enableTools,
      maxToolIterations,
      workspacePath: defaultWorkspacePath,
      jobStore,
      approvalBridge,
      taskManager,
      autonomousController,
      modeManager: modeManagers.get(recipient),
    });
  };

  // Get the current latest message ID (don't process old messages)
  let lastRowId = getLatestMessageRowId();
  let isPolling = false;

  safeLogger.info('Starting from message rowid', { lastRowId });

  // Poll for new messages
  const poll = async () => {
    if (isPolling) {
      return;
    }
    isPolling = true;

    try {
      const newMessages = getMessagesSince(lastRowId);

      // Interrupt autonomous cycle if messages arrived and it's running
      if (newMessages.length > 0 && autonomousController?.busy) {
        safeLogger.info('Incoming messages: interrupting autonomous cycle');
        await autonomousController.interrupt();
      }

      for (const message of newMessages) {
        if (message.rowid > lastRowId) {
          lastRowId = message.rowid;
        }

        if (message.isFromMe) {
          continue;
        }

        const sender = message.senderHandle || message.chatId;
        if (!isSenderAllowed(sender, allowedSenders)) {
          safeLogger.info('Ignoring message from non-allowed sender', {
            sender: sender.substring(0, 4) + '***',
          });
          continue;
        }

        // ─── Admin Commands (contacts management) ──────────────────
        const adminReply = handleAdminCommand(message.text, sender, addressBook);
        if (adminReply !== null) {
          // Reload address book after mutations
          addressBook = loadAddressBook();
          allowedSenders = getAllowedPhones(addressBook);
          sendMessage(sender, adminReply);
          continue;
        }

        // ─── Input Guard (physical pre-LLM filtering) ─────────────────
        const guard = guardInboundMessage(message.text, sender);

        if (!guard.allowed) {
          safeLogger.warn('Input guard rejected message', {
            sender: sender.substring(0, 4) + '***',
            reason: guard.reason,
          });
          sendMessage(sender, "I can't process that message.");
          continue;
        }

        // Use sanitized text for all downstream processing
        message.text = guard.sanitized ?? message.text;

        if (guard.warnings && guard.warnings.length > 0) {
          safeLogger.info('Input guard warnings', {
            sender: sender.substring(0, 4) + '***',
            warnings: guard.warnings,
          });
        }

        // Check if this message is an approval response
        if (approvalBridge.tryResolveFromPoll(sender, message.text, message.rowid)) {
          continue;
        }
        if (approvalBridge.wasConsumed(message.rowid)) {
          continue;
        }

        // Get or create per-peer mode manager (auto-detect off — only explicit /code etc.)
        if (!modeManagers.has(sender)) {
          modeManagers.set(sender, createModeManager({ autoDetect: false }));
        }

        await processMessage(message, providers.local, skillRegistry, sessionManager, {
          enableTools,
          maxToolIterations,
          workspacePath: defaultWorkspacePath,
          jobStore,
          approvalBridge,
          taskManager,
          autonomousController,
          modeManager: modeManagers.get(sender),
        });
      }

      // Check for due scheduled jobs after processing messages
      await checkDueJobs(jobStore, sendMessage, actionableHandler);

      // Run the next autonomous cycle if ready
      if (autonomousController) {
        await autonomousController.tick();
      }

      // Expire any stale approval requests
      approvalBridge.expireStale();
    } catch (error) {
      safeLogger.error('Error in poll cycle', {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      isPolling = false;
    }
  };

  // Initial poll
  await poll();

  // Set up interval
  const intervalId = setInterval(poll, pollIntervalMs);

  // Handle shutdown
  const shutdown = () => {
    safeLogger.info('iMessage daemon shutting down');
    clearInterval(intervalId);
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  safeLogger.info('iMessage daemon running. Press Ctrl+C to stop.');

  // Keep the process alive
  await new Promise(() => {});
}
