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
  loadUsersConfig,
  findUserByPhone,
  getAllowedPhoneNumbers,
  type SessionManager,
  type UserProfile,
  type UsersConfig,
} from '../interface/index.js';
import { wrapError, formatErrorForUser } from '../errors/index.js';
import { getMessagesSince, getLatestMessageRowId, type Message } from './reader.js';
import { sendMessage, checkMessagesAvailable } from './sender.js';
import { filterToolCalls } from './tool-filter.js';
import { isAcknowledgementMessage } from './message-utils.js';

export interface DaemonConfig {
  pollIntervalMs: number;
  allowedSenders?: string[] | undefined;
  enableTools?: boolean | undefined;
  maxToolIterations?: number | undefined;
  workspacePath?: string | undefined;
  sessionScope?: 'main' | 'per-peer' | undefined;
  useMultiUser?: boolean | undefined;
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
    user?: UserProfile | undefined;
  }
): Promise<void> {
  const sender = message.senderHandle || message.chatId;
  const { enableTools, maxToolIterations, workspacePath, user } = options;

  // Create memory manager for this user's workspace
  const memoryManager = createMemoryManager({ workspacePath });

  safeLogger.info('Processing incoming message', {
    from: sender.substring(0, 4) + '***',
    chatId: message.chatId.substring(0, 8) + '***',
    user: user?.id ?? 'unknown',
  });

  safeLogger.info('User message', {
    user: user?.id ?? 'unknown',
    message: message.text.substring(0, 100) + (message.text.length > 100 ? '...' : ''),
    length: message.text.length,
  });

  // Get or create session for this sender
  const session = sessionManager.getSession('imessage', sender);

  // Add user message to session
  session.addMessage({
    role: 'user',
    content: message.text,
    sender,
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
    sender,
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
  orchestrator.registerExecutor(createBashExecutor({ autoApprove: true }));
  registerNativeExecutors(orchestrator);

  let iteration = 0;
  let finalResponse = '';
  let previousResults: ToolResultMessage[] = [];

  try {
    // Native tool execution loop
    while (iteration < maxToolIterations) {
      iteration++;

      const response = await provider.generateWithTools(
        {
          prompt: assembled.context,
          systemPrompt: assembled.systemPrompt,
          maxTokens: 2048,
          temperature: 0.7,
        },
        enableTools ? toolRegistry.getTools() : [],
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

      // Log tool calls
      for (const call of filteredCalls) {
        safeLogger.info('Tool call', {
          name: call.name,
          id: call.id,
          input: JSON.stringify(call.input).substring(0, 200),
          iteration,
        });
      }

      // Execute allowed tool calls
      const results: NativeToolResult[] = [];

      if (filteredCalls.length > 0) {
        const executedResults = await orchestrator.executeAll(filteredCalls);
        results.push(...executedResults);
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
      user: user?.id ?? 'unknown',
      response: cleanedResponse.substring(0, 200) + (cleanedResponse.length > 200 ? '...' : ''),
      length: cleanedResponse.length,
      iterations: iteration,
    });

    // Add assistant response to session
    session.addMessage({
      role: 'assistant',
      content: cleanedResponse || 'Done!',
    });

    // Send the response
    const result = sendMessage(sender, cleanedResponse || 'Done!');

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
 * Start the iMessage daemon
 */
export async function startDaemon(daemonConfig: DaemonConfig): Promise<void> {
  const {
    pollIntervalMs,
    allowedSenders: explicitAllowedSenders,
    enableTools = true,
    maxToolIterations = 5,
    workspacePath,
    sessionScope = 'per-peer',
    useMultiUser = true,
  } = daemonConfig;

  // Check if Messages is available
  const messagesCheck = checkMessagesAvailable();
  if (!messagesCheck.available) {
    throw new Error(`iMessage not available: ${messagesCheck.error}`);
  }

  // Load users configuration for multi-user mode
  let usersConfig: UsersConfig | undefined;
  let allowedSenders: string[] | undefined = explicitAllowedSenders;

  if (useMultiUser) {
    usersConfig = loadUsersConfig();

    if (usersConfig.users.length > 0) {
      allowedSenders = getAllowedPhoneNumbers(usersConfig);
      safeLogger.info('Multi-user mode enabled', {
        users: usersConfig.users.filter((u) => u.enabled).map((u) => u.id),
        allowedPhones: allowedSenders.length,
      });
    } else {
      safeLogger.warn('Multi-user mode enabled but no users configured in users.json');
    }
  }

  // Find default workspace path
  const defaultWorkspacePath = workspacePath || findWorkspacePath() || join(process.cwd(), 'workspace');

  safeLogger.info('iMessage daemon starting', {
    pollIntervalMs,
    hasAllowlist: !!allowedSenders && allowedSenders.length > 0,
    enableTools,
    maxToolIterations,
    defaultWorkspacePath,
    sessionScope,
    multiUserMode: useMultiUser && usersConfig && usersConfig.users.length > 0,
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

        let user: UserProfile | undefined;
        let userWorkspacePath = defaultWorkspacePath;

        if (useMultiUser && usersConfig) {
          user = findUserByPhone(sender, usersConfig);
          if (user) {
            userWorkspacePath = user.workspacePath;
            safeLogger.info('Matched user', { userId: user.id, workspace: userWorkspacePath });
          } else {
            safeLogger.warn('No user found for allowed sender', {
              sender: sender.substring(0, 4) + '***',
            });
          }
        }

        await processMessage(message, providers.local, skillRegistry, sessionManager, {
          enableTools,
          maxToolIterations,
          workspacePath: userWorkspacePath,
          user,
        });
      }
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
