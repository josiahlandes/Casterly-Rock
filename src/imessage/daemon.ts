import { join } from 'node:path';
import { loadConfig } from '../config/index.js';
import { safeLogger } from '../logging/safe-logger.js';
import { buildProviders, BillingError, type LlmProvider } from '../providers/index.js';
import { routeRequest } from '../router/index.js';
import {
  createSkillRegistry,
  parseToolCalls,
  executeToolCalls,
  type SkillRegistry,
  type ToolCall,
  type ToolResult,
} from '../skills/index.js';
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
  type MemoryManager,
  type UserProfile,
  type UsersConfig,
} from '../interface/index.js';
import { getMessagesSince, getLatestMessageRowId, type Message } from './reader.js';
import { sendMessage, checkMessagesAvailable } from './sender.js';
import { filterMessageSendToolCalls } from './tool-filter.js';
import { isAcknowledgementMessage } from './message-utils.js';

export interface DaemonConfig {
  pollIntervalMs: number;
  allowedSenders?: string[] | undefined; // If set, only respond to these phone numbers/emails (overrides users.json)
  enableTools?: boolean | undefined;     // Whether to execute tool calls (default: true)
  maxToolIterations?: number | undefined; // Max tool call iterations per message (default: 5)
  workspacePath?: string | undefined;    // Default workspace path (overridden by per-user workspaces)
  sessionScope?: 'main' | 'per-peer' | undefined; // Session isolation mode
  useMultiUser?: boolean | undefined;    // Whether to use multi-user mode from users.json (default: true)
}

/**
 * Process an incoming message through Casterly and send a response
 */
async function processMessage(
  message: Message,
  config: ReturnType<typeof loadConfig>,
  providers: ReturnType<typeof buildProviders>,
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

  // Log the user's message for debugging (truncated for privacy)
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

  // Route the request through Casterly
  const decision = await routeRequest(message.text, { config, providers });

  safeLogger.info('Routing decision', {
    route: decision.route,
    reason: decision.reason,
    confidence: decision.confidence,
    sensitiveCategories: decision.sensitiveCategories,
  });

  // Get the appropriate provider
  const provider = decision.route === 'cloud' ? providers.cloud : providers.local;

  if (!provider) {
    safeLogger.warn('No provider available for route', { route: decision.route });
    const result = sendMessage(sender, "Sorry, I'm having trouble connecting right now. Please try again later.");
    if (!result.success) {
      safeLogger.error('Failed to send error message', { error: result.error });
    }
    return;
  }

  // Get available skills
  const skills = skillRegistry.getAvailable();

  // Assemble initial context using the interface layer
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

  // Only include skills section if the message likely needs tools
  // Simple greetings and conversational messages don't need skill documentation
  const lowerMessage = message.text.toLowerCase().trim();
  const isSimpleGreeting = /^(hi|hey|hello|yo|sup|what'?s up|howdy|hiya|good (morning|afternoon|evening)|gm|thanks|thank you|ok|okay|cool|got it|nice|lol|haha)\b/.test(lowerMessage);
  const isShortQuestion = lowerMessage.length < 30 && !lowerMessage.includes('how do') && !lowerMessage.includes('can you');
  const skipSkillsSection = isSimpleGreeting || (isShortQuestion && !lowerMessage.includes('?'));

  // Get relevant skill instructions based on message content
  // This gives full instructions only for skills that match the user's intent
  const relevantInstructions = skipSkillsSection ? '' : skillRegistry.getRelevantSkillInstructions(message.text);
  const skillsOverview = skipSkillsSection ? '' : skillRegistry.getPromptSection();

  // Include relevant instructions if any, otherwise just the overview
  let conversationContext = assembled.context;
  if (relevantInstructions) {
    conversationContext = `${assembled.context}\n\n${relevantInstructions}`;
  } else if (skillsOverview) {
    conversationContext = `${assembled.context}\n\n${skillsOverview}`;
  }

  safeLogger.info('Skills context', {
    includeSkills: !skipSkillsSection,
    relevantSkills: relevantInstructions ? true : false,
    messageLength: message.text.length,
  });

  let iteration = 0;
  let finalResponse = '';
  let currentProvider: LlmProvider = provider;
  let wasReroutedToLocal = false;

  try {
    // Tool execution loop
    while (iteration < maxToolIterations) {
      iteration++;

      let response;
      try {
        response = await currentProvider.generate({ prompt: conversationContext });
      } catch (providerError) {
        // If cloud provider has billing issues, fall back to local
        if (providerError instanceof BillingError && currentProvider.kind === 'cloud' && providers.local) {
          safeLogger.warn('Cloud provider billing error, falling back to local', {
            error: providerError.message,
          });
          currentProvider = providers.local;
          wasReroutedToLocal = true;
          response = await currentProvider.generate({ prompt: conversationContext });
        } else {
          throw providerError;
        }
      }

      safeLogger.info('Generated response', {
        provider: response.providerId,
        model: response.model,
        length: response.text.length,
        iteration,
      });

      // Check for tool calls in the response
      const toolCalls = enableTools ? parseToolCalls(response.text) : [];

      if (toolCalls.length === 0) {
        // No tool calls - this is the final response
        finalResponse = response.text;
        break;
      }

      const { allowed: filteredToolCalls, blocked: blockedToolCalls } =
        filterMessageSendToolCalls(toolCalls);

      if (blockedToolCalls.length > 0) {
        safeLogger.warn('Blocked message-sending tool calls for iMessage channel', {
          blocked: blockedToolCalls.length,
        });
      }

      // Log each tool call with full command for debugging
      for (const toolCall of filteredToolCalls) {
        safeLogger.info('Tool call', {
          tool: toolCall.tool,
          command: toolCall.args.substring(0, 200),
          iteration,
        });
      }

      safeLogger.info('Executing tool calls', {
        count: filteredToolCalls.length,
        blocked: blockedToolCalls.length,
      });

      // Execute the tool calls (auto-approve safe commands)
      const results =
        filteredToolCalls.length > 0
          ? await executeToolCalls(filteredToolCalls, { autoApprove: true })
          : [];

      // Log tool results
      for (let i = 0; i < filteredToolCalls.length; i++) {
        const call = filteredToolCalls[i];
        const result = results[i];
        safeLogger.info('Tool result', {
          command: call?.args.substring(0, 100),
          success: result?.success ?? false,
          outputLength: result?.output?.length ?? 0,
          error: result?.error?.substring(0, 100),
        });
      }

      // Format results for context
      const toolResults: Array<{ call: ToolCall; result: ToolResult }> = [
        ...filteredToolCalls.map((call, index) => ({
          call,
          result: results[index] ?? {
            success: false,
            error: 'Tool call did not return a result',
            exitCode: -1,
          },
        })),
        ...blockedToolCalls.map((call) => ({
          call,
          result: {
            success: false,
            error:
              'Tool call blocked (message sending is handled by Casterly; reply with the final message text only).',
            exitCode: -1,
          },
        })),
      ];

      const resultsText = toolResults
        .map(({ call, result }) => {
          if (result?.success) {
            return `Command: ${call?.args}\nOutput:\n${result.output ?? '(no output)'}`;
          }
          return `Command: ${call?.args}\nError: ${result?.error ?? 'Unknown error'}`;
        })
        .join('\n\n');

      // Add tool results to context and continue
      conversationContext += `\n\nAssistant: ${response.text}\n\nTool Results:\n${resultsText}\n\nBased on the tool results above, provide your response to the user:`;

      // Extract any text before the tool call as partial response
      const textBeforeTools = response.text.split('```')[0]?.trim();
      if (textBeforeTools && textBeforeTools.length > 20) {
        // If there's substantial text before the tool call, include it
        finalResponse = textBeforeTools + '\n\n';
      }
    }

    if (iteration >= maxToolIterations) {
      safeLogger.warn('Max tool iterations reached', { maxToolIterations });
      finalResponse += "\n\n(Reached maximum tool execution limit)";
    }

    // Process memory commands from the response
    const memoryCommands = parseMemoryCommands(finalResponse);
    if (memoryCommands.length > 0) {
      safeLogger.info('Processing memory commands', { count: memoryCommands.length });
      executeMemoryCommands(memoryCommands, memoryManager);
    }

    // Clean up the response - remove any remaining code blocks and memory tags
    let cleanedResponse = finalResponse
      .replace(/```bash[\s\S]*?```/g, '')  // Remove bash blocks
      .replace(/```sh[\s\S]*?```/g, '')    // Remove sh blocks
      .replace(/\[(?:REMEMBER|NOTE|MEMORY)\](?:\[[^\]]*\])?\s*[^\[]*/gi, '')  // Remove memory tags
      .replace(/\n{3,}/g, '\n\n')          // Collapse multiple newlines
      .trim();

    // Add notice if request was rerouted due to billing issues
    if (wasReroutedToLocal) {
      cleanedResponse += '\n\n(Note: This response was processed locally due to cloud API credit limits.)';
    }

    // Log Tyrion's response for debugging
    safeLogger.info('Tyrion response', {
      user: user?.id ?? 'unknown',
      response: cleanedResponse.substring(0, 200) + (cleanedResponse.length > 200 ? '...' : ''),
      length: cleanedResponse.length,
      iterations: iteration,
      wasReroutedToLocal,
    });

    // Add assistant response to session
    session.addMessage({
      role: 'assistant',
      content: cleanedResponse || 'Done!',
    });

    // Send the response
    const result = sendMessage(sender, cleanedResponse || "Done!");

    if (result.success) {
      safeLogger.info('Response sent successfully');
    } else {
      safeLogger.error('Failed to send response', { error: result.error });
    }
  } catch (error) {
    safeLogger.error('Failed to generate response', {
      error: error instanceof Error ? error.message : String(error),
    });

    const result = sendMessage(sender, "Sorry, I encountered an error processing your message.");
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

  // Normalize phone numbers (remove spaces, dashes, etc.)
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
      // Use phone numbers from users.json as allowlist
      allowedSenders = getAllowedPhoneNumbers(usersConfig);
      safeLogger.info('Multi-user mode enabled', {
        users: usersConfig.users.filter(u => u.enabled).map(u => u.id),
        allowedPhones: allowedSenders.length,
      });
    } else {
      safeLogger.warn('Multi-user mode enabled but no users configured in users.json');
    }
  }

  // Find default workspace path (used as fallback)
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

  // Load skills
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
  let isPolling = false; // Prevent concurrent poll execution

  safeLogger.info('Starting from message rowid', { lastRowId });

  // Poll for new messages
  const poll = async () => {
    // Skip if already processing (prevents duplicate message handling)
    if (isPolling) {
      return;
    }
    isPolling = true;

    try {
      const newMessages = getMessagesSince(lastRowId);

      for (const message of newMessages) {
        // Update lastRowId regardless of whether we process
        if (message.rowid > lastRowId) {
          lastRowId = message.rowid;
        }

        // Skip messages from ourselves
        if (message.isFromMe) {
          continue;
        }

        // Check allowlist
        const sender = message.senderHandle || message.chatId;
        if (!isSenderAllowed(sender, allowedSenders)) {
          safeLogger.info('Ignoring message from non-allowed sender', {
            sender: sender.substring(0, 4) + '***',
          });
          continue;
        }

        // Look up user for multi-user mode
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

        // Process the message with user-specific workspace
        await processMessage(message, config, providers, skillRegistry, sessionManager, {
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
