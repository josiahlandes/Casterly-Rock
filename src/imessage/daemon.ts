/**
 * iMessage Daemon
 *
 * Mac Studio Edition - Local Ollama Only
 */

import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import * as yaml from 'yaml';
import { safeLogger } from '../logging/safe-logger.js';
import { createVoiceFilter, type VoiceFilter } from './voice-filter.js';
import {
  findWorkspacePath,
  loadAddressBook,
  addContact,
  removeContact,
  getAllowedPhones,
  isAdmin,
  findContactByPhone,
  type AddressBook,
} from '../interface/index.js';
import { wrapError, formatErrorForUser } from '../errors/index.js';
import { getMessagesSince, getLatestMessageRowId, type Message } from './reader.js';
import { sendMessage, checkMessagesAvailable } from './sender.js';
import { guardInboundMessage } from './input-guard.js';
import {
  createJobStore,
  checkDueJobs,
  parseCronExpression,
  getNextFireTime,
  type ActionableHandler,
} from '../scheduler/index.js';
import {
  createApprovalStore,
  createApprovalBridge,
} from '../approval/index.js';
import {
  AutonomousLoop,
  loadConfig as loadAutonomousConfig,
  createProvider as createAutonomousProvider,
  createAutonomousController,
  triggerFromMessage,
  type AutonomousController,
} from '../autonomous/index.js';

export interface DaemonConfig {
  pollIntervalMs: number;
  workspacePath?: string | undefined;
}

/**
 * Process an incoming message through the agent loop and send a response.
 * The agent loop is the sole execution path — no legacy fallback.
 */
async function processMessage(
  message: Message,
  autonomousController: AutonomousController,
  voiceFilter: VoiceFilter,
): Promise<void> {
  const sender = message.senderHandle || message.chatId;

  // Status dashboard — instant reply, no agent loop needed
  const statusReply = handleStatusCommand(message.text, autonomousController);
  if (statusReply !== null) {
    sendMessage(sender, statusReply);
    return;
  }

  // Legacy "autonomous status" — also instant reply
  if (/^autonomous\s+status$/i.test(message.text.trim())) {
    const autonomousReply = handleAutonomousCommand(message.text, autonomousController);
    if (autonomousReply !== null) {
      sendMessage(sender, autonomousReply);
      return;
    }
  }

  const contact = findContactByPhone(sender);
  const senderLabel = contact ? `${contact.name} (${sender})` : sender;

  try {
    const trigger = triggerFromMessage(message.text, senderLabel);
    const outcome = await autonomousController.runTriggeredCycle(trigger);

    // When summary is empty the response is being delivered
    // asynchronously (e.g. dual-loop FastLoop via deliverFn).
    const response = outcome.summary;
    if (response) {
      const voiced = await voiceFilter.apply(response);
      const result = sendMessage(sender, voiced);
      if (result.success) {
        safeLogger.info('Agent loop response sent', {
          turns: outcome.totalTurns,
          stopReason: outcome.stopReason,
        });
      } else {
        safeLogger.error('Failed to send agent loop response', { error: result.error });
      }
    } else {
      safeLogger.info('Agent cycle completed (response delivered async)', {
        stopReason: outcome.stopReason,
      });
    }
  } catch (error) {
    const casterlyError = wrapError(error);
    safeLogger.error('Agent loop failed', {
      code: casterlyError.code,
      message: casterlyError.message,
    });
    const errorMessage = formatErrorForUser(casterlyError, 'imessage');
    sendMessage(sender, errorMessage);
  }
}

// ─── Status Command Patterns ─────────────────────────────────────────────────

const STATUS_COMMANDS_RE = /^(status|goals|issues|health|activity)$/i;

// ─── Autonomous Command Patterns ─────────────────────────────────────────────

const AUTONOMOUS_STATUS_RE = /^autonomous\s+status$/i;

/**
 * Handle the autonomous status command.
 * Start/stop commands are removed — the loop is always active.
 * There is no "autonomous mode" toggle. See docs/vision.md.
 */
function handleAutonomousCommand(
  text: string,
  controller?: AutonomousController,
): string | null {
  const trimmed = text.trim();

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

/**
 * Handle instant status dashboard commands.
 * Returns the reply string if handled, or null if not a status command.
 * Available to all allowed senders (not admin-only).
 */
function handleStatusCommand(
  text: string,
  controller?: AutonomousController,
): string | null {
  const trimmed = text.trim().toLowerCase();
  const match = STATUS_COMMANDS_RE.exec(trimmed);
  if (!match) return null;

  if (!controller) return 'System is not configured.';
  return controller.getStatusReport(match[1]!);
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
    workspacePath,
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
    defaultWorkspacePath,
  });

  // Create scheduler job store
  const jobStore = createJobStore();
  safeLogger.info('Scheduler job store initialized', { activeJobs: jobStore.getActive().length });

  // Create approval bridge for async command approval
  const approvalStore = createApprovalStore();
  const approvalBridge = createApprovalBridge(
    approvalStore, sendMessage, getMessagesSince, getLatestMessageRowId,
  );
  safeLogger.info('Approval bridge initialized');

  // ── Voice filter ────────────────────────────────────────────────────────
  // Parse voice_filter config from autonomous.yaml and create the filter.
  // The filter rewrites agent responses in Tyrion's voice before sending.
  const autonomousConfigPath = join(process.cwd(), 'config', 'autonomous.yaml');
  let voiceFilter: VoiceFilter;

  try {
    const rawYaml = yaml.parse(await readFile(autonomousConfigPath, 'utf-8'));
    voiceFilter = createVoiceFilter(rawYaml.voice_filter as Record<string, unknown> | undefined);
    safeLogger.info('Voice filter initialized', { enabled: rawYaml.voice_filter?.enabled !== false });
  } catch {
    voiceFilter = createVoiceFilter(undefined); // disabled fallback
    safeLogger.warn('Voice filter config not found, disabled');
  }

  // ── Autonomous controller ──────────────────────────────────────────────
  // Attempt to load autonomous config and create the controller.
  // If dual_loop.enabled is true in autonomous.yaml, create a DualLoopController
  // instead of the standard AutonomousController.
  // If the autonomous module is not configured, the controller stays undefined
  // and autonomous commands will respond with "not configured".
  let autonomousController: AutonomousController | undefined;

  // Read raw YAML for the dual_loop.enabled flag
  let dualLoopEnabled = false;
  try {
    const rawAutoYaml = yaml.parse(await readFile(autonomousConfigPath, 'utf-8')) as Record<string, unknown>;
    const dualLoopSection = rawAutoYaml['dual_loop'] as Record<string, unknown> | undefined;
    dualLoopEnabled = dualLoopSection?.['enabled'] === true;
  } catch {
    // If config can't be read, fall through to standard path
  }

  try {
    if (dualLoopEnabled) {
      // ── Dual-loop mode ──────────────────────────────────────────────
      const { createDualLoopController } = await import('../dual-loop/index.js');
      const { OllamaProvider } = await import('../providers/ollama.js');
      const { ConcurrentProvider } = await import('../providers/concurrent.js');
      const { EventBus } = await import('../autonomous/events.js');
      const { GoalStack } = await import('../autonomous/goal-stack.js');

      const baseUrl = process.env['OLLAMA_BASE_URL'] || 'http://localhost:11434';

      const fastProvider = new OllamaProvider({
        baseUrl,
        model: 'qwen3:27b',
        timeoutMs: 30_000,
      });
      const deepProvider = new OllamaProvider({
        baseUrl,
        model: 'qwen3.5:122b',
        timeoutMs: 300_000,
        numCtx: 40_960,
      });
      const coderProvider = new OllamaProvider({
        baseUrl,
        model: 'qwen3-coder-next:latest',
        timeoutMs: 300_000,
      });

      const concurrentProvider = new ConcurrentProvider(
        new Map([
          ['qwen3.5:122b', deepProvider],
          ['qwen3-coder-next:latest', coderProvider],
          ['qwen3:27b', fastProvider],
        ]),
      );

      const eventBus = new EventBus({ maxQueueSize: 100, logEvents: true });
      const goalStack = new GoalStack();

      autonomousController = createDualLoopController({
        fastProvider,
        deepProvider,
        concurrentProvider,
        eventBus,
        goalStack,
        voiceFilter,
        sendMessageFn: sendMessage,
      });

      autonomousController.start();

      safeLogger.info('Dual-loop controller initialized', {
        fastModel: 'qwen3:27b',
        deepModel: 'qwen3.5:122b',
      });
    } else {
      // ── Standard single-loop mode ───────────────────────────────────
      const autonomousConfig = await loadAutonomousConfig(autonomousConfigPath);
      const autonomousProvider = await createAutonomousProvider(autonomousConfig);
      const autonomousLoop = new AutonomousLoop(
        autonomousConfig,
        process.cwd(),
        autonomousProvider,
        {
          approvalBridge,
          approvalRecipient: allowedSenders?.[0],
        },
        autonomousConfig.agentLoop,
      );

      autonomousController = createAutonomousController({
        loop: autonomousLoop,
        cycleIntervalMinutes: autonomousConfig.cycleIntervalMinutes,
      });

      safeLogger.info('Autonomous controller initialized', {
        model: autonomousConfig.model,
        interval: autonomousConfig.cycleIntervalMinutes,
      });
    }

    // Schedule daily 8am morning summary if not already present
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
        message: 'Morning autonomous summary',
        description: 'Morning summary of overnight autonomous work (8am)',
        createdAt: Date.now(),
        fireCount: 0,
        source: 'system',
        label: 'autonomous-morning-summary',
        actionable: true, // Short-circuited in handler — bypasses LLM
      });
      safeLogger.info('Scheduled daily morning summary at 8am');
    }
  } catch (error) {
    safeLogger.warn('Autonomous controller not available', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // ── Actionable job handler ───────────────────────────────────────────────
  // When a scheduled job fires with actionable=true, route through the agent
  // loop so the LLM executes the task (check weather, summarize emails, etc.).
  const actionableHandler: ActionableHandler = async (recipient, instruction, jobId) => {
    // Morning summary: bypass LLM, send directly from controller
    if (jobId === 'daily-autonomous-report' && autonomousController) {
      safeLogger.info('Morning summary: generating from handoff + reflector');
      try {
        const summary = await autonomousController.getMorningSummary();
        const voiced = await voiceFilter.apply(summary);
        const result = sendMessage(recipient, voiced);
        if (!result.success) {
          safeLogger.error('Failed to send morning summary', { error: result.error });
        }
      } catch (error) {
        safeLogger.error('Error generating morning summary', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }

    if (!autonomousController) {
      safeLogger.warn('Actionable job skipped: no autonomous controller', { jobId });
      return;
    }

    safeLogger.info('Actionable job: routing through agent loop', { jobId, recipient: recipient.substring(0, 4) + '***' });

    const syntheticMessage: Message = {
      rowid: -1,
      guid: `scheduled-${jobId}`,
      text: instruction,
      isFromMe: false,
      date: new Date(),
      chatId: recipient,
      senderHandle: recipient,
    };

    await processMessage(syntheticMessage, autonomousController, voiceFilter);
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

        // ─── Status Commands (any allowed sender) ────────────────────
        const pollStatusReply = handleStatusCommand(message.text, autonomousController);
        if (pollStatusReply !== null) {
          sendMessage(sender, pollStatusReply);
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

        // Route through agent loop (sole execution path)
        if (!autonomousController) {
          safeLogger.error('No autonomous controller — cannot process message');
          sendMessage(sender, 'System is starting up. Please try again in a moment.');
          continue;
        }

        await processMessage(message, autonomousController, voiceFilter);
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

  // Handle graceful shutdown — wait for in-flight work to finish
  let shuttingDown = false;

  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;

    safeLogger.info('iMessage daemon shutting down gracefully...');
    clearInterval(intervalId);

    // Wait for any in-flight poll cycle to complete (up to 30s)
    const deadline = Date.now() + 30_000;
    while (isPolling && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 250));
    }

    if (isPolling) {
      safeLogger.warn('Shutdown timeout — in-flight poll cycle did not complete');
    }

    safeLogger.info('iMessage daemon stopped');
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  safeLogger.info('iMessage daemon running. Press Ctrl+C to stop.');

  // Keep the process alive
  await new Promise(() => {});
}
