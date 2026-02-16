/**
 * Shared Chat Processing Pipeline
 *
 * Extracted from the iMessage daemon so that any interface (iMessage, terminal REPL,
 * web, etc.) can run messages through the exact same LLM pipeline:
 *   session → context assembly → model enrichment → tool loop → response cleanup
 *
 * The caller is responsible for:
 *   1. Building a ChatInput (resolve sender label, choose channel)
 *   2. Providing pre-built dependencies (provider, skills, sessions, etc.)
 *   3. Delivering the response (sendMessage, print to stdout, HTTP response, etc.)
 */

import { safeLogger } from '../logging/safe-logger.js';
import type { LlmProvider, PreviousAssistantMessage } from '../providers/index.js';
import type { SkillRegistry } from '../skills/index.js';
import {
  createToolRegistry,
  createToolOrchestrator,
  createBashExecutor,
  registerNativeExecutors,
  type ToolResultMessage,
  type NativeToolResult,
} from '../tools/index.js';
import {
  assembleContext,
  createMemoryManager,
  parseMemoryCommands,
  executeMemoryCommands,
  type SessionManager,
} from '../interface/index.js';
import type { Channel } from '../interface/prompt-builder.js';
import { filterToolCalls } from '../imessage/tool-filter.js';
import { isAcknowledgementMessage } from '../imessage/message-utils.js';
import {
  getSchedulerToolSchemas,
  createSchedulerExecutors,
  type JobStore,
} from '../scheduler/index.js';
import type { ApprovalBridge } from '../approval/index.js';
import {
  resolveModelProfile,
  enrichSystemPrompt,
  enrichToolDescriptions,
  applyResponseHints,
  getGenerationOverrides,
} from '../models/index.js';
import type { TaskManager } from '../tasks/index.js';
import type { ModeManager } from '../coding/modes/index.js';
import type { GenerateRequest } from '../providers/base.js';

// ═══════════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════════

export interface ChatInput {
  /** The raw message text */
  text: string;
  /** Sender identifier (phone number, "terminal-user", etc.) */
  sender: string;
  /** Human-readable label: "Katie (+1602...)" or "Developer (terminal)" */
  senderLabel: string;
  /** Channel type — affects system prompt tone and session key */
  channel: Channel;
}

export interface ToolCallRecord {
  name: string;
  iteration: number;
  success: boolean;
  inputPreview: string;
}

export interface ProcessResult {
  /** Final cleaned response text */
  response: string;
  /** Number of tool loop iterations used */
  iterations: number;
  /** Record of every tool call made */
  toolCallsMade: ToolCallRecord[];
  /** Whether the task pipeline handled this message */
  taskPipelineUsed: boolean;
  /** Task classification (if task pipeline was used) */
  taskClass?: string | undefined;
  /** Which model profile was resolved */
  modelProfile: string;
  /** Estimated token count for the assembled context */
  estimatedTokens: number;
}

export interface ProcessDependencies {
  provider: LlmProvider;
  skillRegistry: SkillRegistry;
  sessionManager: SessionManager;
  modeManager?: ModeManager | undefined;
  jobStore?: JobStore | undefined;
  approvalBridge?: ApprovalBridge | undefined;
  taskManager?: TaskManager | undefined;
}

export interface ProcessOptions {
  enableTools: boolean;
  maxToolIterations: number;
  workspacePath: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Core Pipeline
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Process a chat message through the full Casterly LLM pipeline.
 *
 * This is the shared core used by both the iMessage daemon and the terminal REPL.
 * It performs: session management, context assembly, tool registry setup, model profile
 * enrichment, task pipeline gate, flat tool loop (with proper multi-turn threading),
 * response cleanup, and memory command execution.
 */
export async function processChatMessage(
  input: ChatInput,
  deps: ProcessDependencies,
  options: ProcessOptions,
): Promise<ProcessResult> {
  const { provider, skillRegistry, sessionManager, modeManager, jobStore, approvalBridge, taskManager } = deps;
  const { enableTools, maxToolIterations, workspacePath } = options;
  const toolCallsMade: ToolCallRecord[] = [];

  // Create memory manager for this workspace
  const memoryManager = createMemoryManager({ workspacePath });

  safeLogger.info('Processing incoming message', {
    from: input.sender.substring(0, 4) + '***',
    channel: input.channel,
  });

  safeLogger.info('User message', {
    message: input.text.substring(0, 100) + (input.text.length > 100 ? '...' : ''),
    length: input.text.length,
  });

  // Get or create session
  const session = sessionManager.getSession(input.channel, input.sender);

  // Add user message to session
  session.addMessage({
    role: 'user',
    content: input.text,
    sender: input.senderLabel,
  });

  // ─── Acknowledgement shortcut ─────────────────────────────────────────
  if (isAcknowledgementMessage(input.text)) {
    const reply = "You're welcome!";
    session.addMessage({ role: 'assistant', content: reply });
    safeLogger.info('Acknowledgement sent');
    return {
      response: reply,
      iterations: 0,
      toolCallsMade: [],
      taskPipelineUsed: false,
      modelProfile: 'none',
      estimatedTokens: 0,
    };
  }

  // ─── Context Assembly ─────────────────────────────────────────────────
  const skills = skillRegistry.getAvailable();
  const assembled = assembleContext({
    session,
    userMessage: input.text,
    sender: input.senderLabel,
    skills,
    channel: input.channel,
    workspacePath,
  });

  safeLogger.info('Context assembled', {
    estimatedTokens: assembled.estimatedTokens,
    historyMessages: assembled.historyMessagesIncluded,
  });

  // ─── Tool Registry & Orchestrator ─────────────────────────────────────
  const toolRegistry = createToolRegistry();
  const orchestrator = createToolOrchestrator();
  orchestrator.registerExecutor(createBashExecutor(
    approvalBridge
      ? {
          approvalCallback: async (command: string) => {
            const request = approvalBridge.requestApproval(command, input.sender);
            return approvalBridge.waitForApproval(request.id);
          },
        }
      : { autoApprove: true },
  ));
  registerNativeExecutors(orchestrator);

  // Register scheduler tools if job store is available
  if (jobStore) {
    for (const tool of getSchedulerToolSchemas()) {
      toolRegistry.register(tool);
    }
    for (const executor of createSchedulerExecutors(jobStore, input.sender)) {
      orchestrator.registerExecutor(executor);
    }
  }

  // ─── Mode Detection ───────────────────────────────────────────────────
  let modeSystemPrompt = '';
  if (modeManager) {
    const detection = modeManager.autoDetectAndSwitch(input.text);
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

  // ─── Model Profile Enrichment ─────────────────────────────────────────
  const modelProfile = resolveModelProfile(provider.model);
  const baseSystemPrompt = modeSystemPrompt
    ? `${assembled.systemPrompt}\n\n## Active Mode\n\n${modeSystemPrompt}`
    : assembled.systemPrompt;
  const enrichedSystemPrompt = enrichSystemPrompt(baseSystemPrompt, modelProfile);
  const rawTools = enableTools ? toolRegistry.getTools() : [];
  const modeFilteredTools = modeManager
    ? rawTools.filter((t) => modeManager.isToolAllowed(t.name))
    : rawTools;
  const enrichedTools = enrichToolDescriptions(modeFilteredTools, modelProfile);
  const genOverrides = getGenerationOverrides(modelProfile);

  // ─── Task Pipeline Gate ───────────────────────────────────────────────
  if (taskManager && enableTools) {
    try {
      const recentHistory = session.getHistory(6).map((m) => {
        const text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
        return `${m.role}: ${text.substring(0, 200)}`;
      });

      const handleResult = await taskManager.handle(input.text, recentHistory, provider);

      if (handleResult.classification.taskClass !== 'conversation') {
        safeLogger.info('Task pipeline handled message', {
          taskClass: handleResult.classification.taskClass,
          confidence: handleResult.classification.confidence,
          taskType: handleResult.classification.taskType ?? 'none',
          hasResult: !!handleResult.taskResult,
        });

        // Pass the raw task output through the LLM with the personality
        // system prompt so the user gets a natural, in-character response
        // instead of robotic "Done. [goal]. Results: [data]" text.
        let taskResponse: string;
        try {
          const personalityPrompt = [
            `The user asked: "${input.text}"`,
            '',
            'Here are the results from running the task:',
            handleResult.response,
            '',
            'Using the task results above, write a short, natural reply to the user.',
            'Include the key data they asked for.',
            'If any steps FAILED or had ISSUES, be honest about what did not work.',
            'Do NOT claim something succeeded if the results say it failed.',
            'Do NOT mention that a "task" was run — just answer them directly.',
            'Do NOT call any tools — respond with text only.',
          ].join('\n');

          const personalityPass = await provider.generateWithTools(
            {
              prompt: personalityPrompt,
              systemPrompt: enrichedSystemPrompt,
              maxTokens: 1024,
              temperature: 0.7,
            },
            [], // no tools — text generation only
          );

          // Use text from the personality pass; if model produced tool calls
          // instead of text (hallucination), fall back to raw task response
          taskResponse = personalityPass.text.trim() || handleResult.response;
        } catch (passError) {
          const passMsg = passError instanceof Error ? passError.message : String(passError);
          safeLogger.warn('Personality pass failed, using raw task response', { error: passMsg });
          taskResponse = handleResult.response;
        }

        taskResponse = applyResponseHints(taskResponse, modelProfile);
        taskResponse = taskResponse
          .replace(/```bash[\s\S]*?```/g, '')
          .replace(/```sh[\s\S]*?```/g, '')
          .replace(/\n{3,}/g, '\n\n')
          .trim();

        const finalTaskResponse = taskResponse || 'Done!';
        session.addMessage({ role: 'assistant', content: finalTaskResponse });

        return {
          response: finalTaskResponse,
          iterations: 0,
          toolCallsMade: [],
          taskPipelineUsed: true,
          taskClass: handleResult.classification.taskClass,
          modelProfile: modelProfile.modelId,
          estimatedTokens: assembled.estimatedTokens,
        };
      }

      safeLogger.info('Task classifier: conversation, using flat tool loop', {
        confidence: handleResult.classification.confidence,
      });
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      safeLogger.warn('Task pipeline error, falling back to flat tool loop', { error: errorMsg });
    }
  }

  // ─── Flat Tool Loop ───────────────────────────────────────────────────
  let iteration = 0;
  let finalResponse = '';
  let previousResults: ToolResultMessage[] = [];
  const previousAssistantMessages: PreviousAssistantMessage[] = [];

  const { temperature: genTemp, num_predict: genNumPredict, ...providerSpecificOptions } = genOverrides as Record<string, unknown>;

  // Dedup: prevent LLM from repeating any tool call with identical params.
  // Without this, the model tends to loop on read-only tools (bash, read_file)
  // re-executing the same command every iteration instead of generating a response.
  const completedToolCalls = new Set<string>();

  while (iteration < maxToolIterations) {
    iteration++;

    const generateRequest: GenerateRequest = {
      prompt: assembled.context,
      systemPrompt: enrichedSystemPrompt,
      maxTokens: (genNumPredict as number | undefined) ?? 2048,
      temperature: (genTemp as number | undefined) ?? 0.7,
    };
    if (Object.keys(providerSpecificOptions).length > 0) {
      generateRequest.providerOptions = providerSpecificOptions;
    }
    if (previousAssistantMessages.length > 0) {
      generateRequest.previousAssistantMessages = previousAssistantMessages;
    }

    const response = await provider.generateWithTools(
      generateRequest,
      enrichedTools,
      previousResults.length > 0 ? previousResults : undefined,
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
      safeLogger.warn('Blocked tool calls', { blocked: blockedCalls.length });
    }

    // Dedup: split filtered calls into new vs duplicate
    const newCalls: typeof filteredCalls = [];
    const dupCalls: typeof filteredCalls = [];

    for (const call of filteredCalls) {
      const key = `${call.name}:${JSON.stringify(call.input)}`;
      if (completedToolCalls.has(key)) {
        dupCalls.push(call);
        continue;
      }
      newCalls.push(call);
    }

    if (dupCalls.length > 0) {
      safeLogger.warn('Blocked duplicate tool calls', {
        duplicates: dupCalls.length,
        tools: dupCalls.map((c) => c.name),
      });

      // If ALL calls in this iteration are duplicates, the model is looping.
      // Use whatever text it generated (if any) and break.
      if (newCalls.length === 0 && blockedCalls.length === 0) {
        safeLogger.warn('All tool calls are duplicates — forcing response', { iteration });
        finalResponse = response.text || '(I already gathered the information — let me summarize.)';
        break;
      }
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

      // Track all successful calls for dedup (prevents infinite loops)
      for (let i = 0; i < newCalls.length; i++) {
        const call = newCalls[i]!;
        const result = executedResults[i];
        if (result?.success) {
          const key = `${call.name}:${JSON.stringify(call.input)}`;
          completedToolCalls.add(key);
        }
      }
    }

    // Record tool calls for debug output
    for (const call of newCalls) {
      const matchingResult = results.find((r) => r.toolCallId === call.id);
      toolCallsMade.push({
        name: call.name,
        iteration,
        success: matchingResult?.success ?? false,
        inputPreview: JSON.stringify(call.input).substring(0, 200),
      });
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
        error: 'Tool call blocked (message sending is handled by Casterly; reply with the final message text only).',
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

    // Store assistant response for proper threading in next iteration
    previousAssistantMessages.push({
      text: response.text,
      toolCalls: response.toolCalls.map((tc) => ({
        id: tc.id,
        name: tc.name,
        arguments: JSON.stringify(tc.input),
      })),
    });

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

  // ─── Response Cleanup ─────────────────────────────────────────────────
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

  const finalMessage = cleanedResponse || 'Tried to handle that but came up empty. Mind asking again?';

  // Add assistant response to session
  session.addMessage({
    role: 'assistant',
    content: finalMessage,
  });

  return {
    response: finalMessage,
    iterations: iteration,
    toolCallsMade,
    taskPipelineUsed: false,
    modelProfile: modelProfile.modelId,
    estimatedTokens: assembled.estimatedTokens,
  };
}
