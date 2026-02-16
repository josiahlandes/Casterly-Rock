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
  type ToolResultMessage,
  type NativeToolResult,
} from '../tools/index.js';
import {
  createSessionManager,
  assembleContext,
  findWorkspacePath,
  createMemoryManager,
  parseMemoryCommands,
  executeMemoryCommands,
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
import { filterToolCalls } from './tool-filter.js';
import { isAcknowledgementMessage } from './message-utils.js';
import { guardInboundMessage } from './input-guard.js';
import {
  createJobStore,
  getSchedulerToolSchemas,
  createSchedulerExecutors,
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
  resolveModelProfile,
  enrichSystemPrompt,
  enrichToolDescriptions,
  applyResponseHints,
  getGenerationOverrides,
} from '../models/index.js';
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

  // Create memory manager for this user's workspace
  const memoryManager = createMemoryManager({ workspacePath });

  safeLogger.info('Processing incoming message', {
    from: sender.substring(0, 4) + '***',
    chatId: message.chatId.substring(0, 8) + '***',
  });

  safeLogger.info('User message', {
    message: message.text.substring(0, 100) + (message.text.length > 100 ? '...' : ''),
    length: message.text.length,
  });

  // Get or create session for this sender
  const session = sessionManager.getSession('imessage', sender);

  // Resolve sender to a human-readable label so the model knows who is talking
  const contact = findContactByPhone(sender);
  const senderLabel = contact ? `${contact.name} (${sender})` : sender;

  // Add user message to session
  session.addMessage({
    role: 'user',
    content: message.text,
    sender: senderLabel,
  });

  if (isAcknowledgementMessage(message.text)) {
    const reply = "You're welcome!";
    session.addMessage({
      role: 'assistant',
      content: reply,
    });

    const result = sendMessage(sender, reply);
    if (result.success) {
      safeLogger.info('Acknowledgement sent');
    } else {
      safeLogger.error('Failed to send acknowledgement', { error: result.error });
    }
    return;
  }

  // Get available skills for context
  const skills = skillRegistry.getAvailable();

  // Assemble context using the interface layer
  const assembled = assembleContext({
    session,
    userMessage: message.text,
    sender: senderLabel,
    skills,
    channel: 'imessage',
    workspacePath,
  });

  safeLogger.info('Context assembled', {
    estimatedTokens: assembled.estimatedTokens,
    historyMessages: assembled.historyMessagesIncluded,
  });

  // Set up native tool use
  const toolRegistry = createToolRegistry();
  const orchestrator = createToolOrchestrator();
  orchestrator.registerExecutor(createBashExecutor(
    approvalBridge
      ? {
          approvalCallback: async (command: string) => {
            const request = approvalBridge.requestApproval(command, sender);
            return approvalBridge.waitForApproval(request.id);
          },
        }
      : { autoApprove: true }
  ));
  registerNativeExecutors(orchestrator);

  // Register scheduler tools if job store is available
  if (jobStore) {
    for (const tool of getSchedulerToolSchemas()) {
      toolRegistry.register(tool);
    }
    for (const executor of createSchedulerExecutors(jobStore, sender)) {
      orchestrator.registerExecutor(executor);
    }
  }

  // ─── Mode Detection ─────────────────────────────────────────────────
  // Auto-detect mode from user input (code, architect, ask, review).
  // Mode influences: system prompt, tool availability, preferred model.
  let modeSystemPrompt = '';
  if (modeManager) {
    const detection = modeManager.autoDetectAndSwitch(message.text);
    if (detection) {
      const currentMode = modeManager.getCurrentMode();
      modeSystemPrompt = currentMode.systemPrompt;
      safeLogger.info('Mode detected', {
        mode: currentMode.name,
        confidence: detection.confidence,
        reason: detection.reason,
        preferredModel: modeManager.getPreferredModel(),
      });
    }
  }

  // Resolve model profile for per-model tuning
  const modelProfile = resolveModelProfile(provider.model);
  const baseSystemPrompt = modeSystemPrompt
    ? `${assembled.systemPrompt}\n\n## Active Mode\n\n${modeSystemPrompt}`
    : assembled.systemPrompt;
  const enrichedSystemPrompt = enrichSystemPrompt(baseSystemPrompt, modelProfile);
  const rawTools = enableTools ? toolRegistry.getTools() : [];
  // Filter tools by current mode's allowed/forbidden lists
  const modeFilteredTools = modeManager
    ? rawTools.filter((t) => modeManager.isToolAllowed(t.name))
    : rawTools;
  const enrichedTools = enrichToolDescriptions(modeFilteredTools, modelProfile);
  const genOverrides = getGenerationOverrides(modelProfile);

  // ─── Task Pipeline Gate ───────────────────────────────────────────────
  // Classify the message first. Tasks get the structured pipeline
  // (classify → plan → execute → verify → log). Conversation falls
  // through to the flat tool loop below.
  if (taskManager && enableTools) {
    try {
      const recentHistory = session.getHistory(6).map((m) => {
        const text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
        return `${m.role}: ${text.substring(0, 200)}`;
      });

      const handleResult = await taskManager.handle(message.text, recentHistory, provider);

      if (handleResult.classification.taskClass !== 'conversation') {
        safeLogger.info('Task pipeline handled message', {
          taskClass: handleResult.classification.taskClass,
          confidence: handleResult.classification.confidence,
          taskType: handleResult.classification.taskType ?? 'none',
          hasResult: !!handleResult.taskResult,
        });

        // Apply model-specific response cleanup
        let taskResponse = applyResponseHints(handleResult.response, modelProfile);

        // Clean up the response (same as conversation path)
        taskResponse = taskResponse
          .replace(/```bash[\s\S]*?```/g, '')
          .replace(/```sh[\s\S]*?```/g, '')
          .replace(/\n{3,}/g, '\n\n')
          .trim();

        session.addMessage({
          role: 'assistant',
          content: taskResponse || 'Done!',
        });

        const result = sendMessage(sender, taskResponse || 'Done!');
        if (result.success) {
          safeLogger.info('Task response sent successfully');
        } else {
          safeLogger.error('Failed to send task response', { error: result.error });
        }
        return;
      }

      // Classification: conversation — fall through to flat tool loop
      safeLogger.info('Task classifier: conversation, using flat tool loop', {
        confidence: handleResult.classification.confidence,
      });
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      safeLogger.warn('Task pipeline error, falling back to flat tool loop', { error: errorMsg });
      // Fall through to the existing flat loop on any pipeline error
    }
  }

  let iteration = 0;
  let finalResponse = '';
  let previousResults: ToolResultMessage[] = [];

  // Deduplication: prevent the LLM from calling the same state-changing tool
  // with identical parameters multiple times in one conversation turn.
  const completedToolCalls = new Set<string>();
  const STATE_CHANGING_TOOLS = new Set([
    'schedule_reminder', 'cancel_reminder', 'write_file', 'send_message', 'reminder_create',
  ]);

  try {
    // Debug: dump full prompt on first iteration
    safeLogger.info('DEBUG: Prompt sizes', {
      systemChars: enrichedSystemPrompt.length,
      systemTokens: Math.ceil(enrichedSystemPrompt.length / 4),
      contextChars: assembled.context.length,
      contextTokens: Math.ceil(assembled.context.length / 4),
      historyMessages: assembled.historyMessagesIncluded ?? 0,
      toolCount: enrichedTools.length,
      toolNames: enrichedTools.map((t) => t.name),
    });
    // Log system prompt in 4K chunks so nothing is hidden
    for (let i = 0; i < enrichedSystemPrompt.length; i += 4000) {
      const chunk = enrichedSystemPrompt.substring(i, i + 4000);
      safeLogger.info(`DEBUG: System prompt [${i}-${Math.min(i + 4000, enrichedSystemPrompt.length)}]`, { text: chunk });
    }
    // Log context prompt in 4K chunks
    for (let i = 0; i < assembled.context.length; i += 4000) {
      const chunk = assembled.context.substring(i, i + 4000);
      safeLogger.info(`DEBUG: Context prompt [${i}-${Math.min(i + 4000, assembled.context.length)}]`, { text: chunk });
    }

    // Native tool execution loop (conversation path + fallback)
    while (iteration < maxToolIterations) {
      iteration++;

      const response = await provider.generateWithTools(
        {
          prompt: assembled.context,
          systemPrompt: enrichedSystemPrompt,
          maxTokens: (genOverrides.num_predict as number | undefined) ?? 2048,
          temperature: (genOverrides.temperature as number | undefined) ?? 0.7,
        },
        enrichedTools,
        previousResults.length > 0 ? previousResults : undefined
      );

      safeLogger.info('LLM response', {
        provider: response.providerId,
        model: response.model,
        textLength: response.text.length,
        toolCalls: response.toolCalls.length,
        stopReason: response.stopReason,
        iteration,
      });

      // If no tool calls, we're done
      if (response.toolCalls.length === 0) {
        finalResponse = response.text;
        break;
      }

      // Filter tool calls (block message-sending commands)
      const { allowed: filteredCalls, blocked: blockedCalls } = filterToolCalls(response.toolCalls);

      if (blockedCalls.length > 0) {
        safeLogger.warn('Blocked tool calls for iMessage channel', {
          blocked: blockedCalls.length,
        });
      }

      // Dedup: split filtered calls into new vs duplicate
      const newCalls: typeof filteredCalls = [];
      const dupCalls: typeof filteredCalls = [];

      for (const call of filteredCalls) {
        if (STATE_CHANGING_TOOLS.has(call.name)) {
          const key = `${call.name}:${JSON.stringify(call.input)}`;
          if (completedToolCalls.has(key)) {
            dupCalls.push(call);
            continue;
          }
        }
        newCalls.push(call);
      }

      if (dupCalls.length > 0) {
        safeLogger.warn('Blocked duplicate tool calls', {
          duplicates: dupCalls.length,
          tools: dupCalls.map((c) => c.name),
        });
      }

      // Log tool calls
      for (const call of newCalls) {
        safeLogger.info('Tool call', {
          name: call.name,
          id: call.id,
          input: JSON.stringify(call.input).substring(0, 200),
          iteration,
        });
      }

      // Execute allowed, non-duplicate tool calls
      const results: NativeToolResult[] = [];

      if (newCalls.length > 0) {
        const executedResults = await orchestrator.executeAll(newCalls);
        results.push(...executedResults);

        // Track successful state-changing calls for dedup
        for (let i = 0; i < newCalls.length; i++) {
          const call = newCalls[i]!;
          const result = executedResults[i];
          if (result?.success && STATE_CHANGING_TOOLS.has(call.name)) {
            const key = `${call.name}:${JSON.stringify(call.input)}`;
            completedToolCalls.add(key);
          }
        }
      }

      // Add duplicate calls with dedup error results
      for (const dupCall of dupCalls) {
        results.push({
          toolCallId: dupCall.id,
          success: false,
          error: 'Already completed — this action was already performed successfully. Compose your final text response to the user.',
        });
      }

      // Add blocked calls with error results
      for (const blockedCall of blockedCalls) {
        results.push({
          toolCallId: blockedCall.id,
          success: false,
          error:
            'Tool call blocked (message sending is handled by Casterly; reply with the final message text only).',
        });
      }

      // Log results
      for (const result of results) {
        safeLogger.info('Tool result', {
          toolCallId: result.toolCallId,
          success: result.success,
          outputLength: result.output?.length ?? 0,
          error: result.error?.substring(0, 100),
        });
      }

      // Set up for next iteration
      previousResults = results.map((r) => ({
        callId: r.toolCallId,
        result: r.success ? (r.output ?? 'Success') : `Error: ${r.error}`,
        isError: !r.success,
      }));

      // Include any text from response
      if (response.text) {
        finalResponse += response.text + '\n';
      }
    }

    if (iteration >= maxToolIterations) {
      safeLogger.warn('Max tool iterations reached', { maxToolIterations });
      finalResponse += '\n\n(Reached maximum tool execution limit)';
    }

    // Apply model-specific response cleanup
    finalResponse = applyResponseHints(finalResponse, modelProfile);

    // Process memory commands from the response
    const memoryCommands = parseMemoryCommands(finalResponse);
    if (memoryCommands.length > 0) {
      safeLogger.info('Processing memory commands', { count: memoryCommands.length });
      executeMemoryCommands(memoryCommands, memoryManager);
    }

    // Clean up the response
    const cleanedResponse = finalResponse
      .replace(/```bash[\s\S]*?```/g, '')
      .replace(/```sh[\s\S]*?```/g, '')
      .replace(/\[(?:REMEMBER|NOTE|MEMORY)\](?:\[[^\]]*\])?\s*[^\[]*/gi, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    safeLogger.info('Final response', {
      response: cleanedResponse.substring(0, 200) + (cleanedResponse.length > 200 ? '...' : ''),
      length: cleanedResponse.length,
      iterations: iteration,
    });

    // Fall back to an honest message if response was empty after cleanup
    const finalMessage = cleanedResponse || 'Tried to handle that but came up empty. Mind asking again?';

    // Add assistant response to session
    session.addMessage({
      role: 'assistant',
      content: finalMessage,
    });

    // Send the response
    const result = sendMessage(sender, finalMessage);

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
