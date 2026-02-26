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
import type { LlmProvider, PreviousAssistantMessage, ProviderRegistry } from '../providers/index.js';
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
import { sanitizeToolOutput } from '../security/tool-output-sanitizer.js';
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
import type { TaskManager, ClassificationResult } from '../tasks/index.js';
import type { ModeManager } from '../coding/modes/index.js';
import type { GenerateRequest } from '../providers/base.js';
import { createHash } from 'node:crypto';

// ═══════════════════════════════════════════════════════════════════════════════
// Classification Cache
// ═══════════════════════════════════════════════════════════════════════════════

const CLASSIFICATION_CACHE_SIZE = 32;

/**
 * Simple LRU cache for classification results.
 * Avoids redundant LLM calls for repeated or similar messages.
 * Keyed on a SHA-256 hash of (message text + recent history summary).
 */
const classificationCache = new Map<string, { result: ClassificationResult; ts: number }>();

function classificationCacheKey(text: string, history: string[]): string {
  const raw = text + '\x00' + history.join('\x00');
  return createHash('sha256').update(raw).digest('hex').slice(0, 16);
}

function getCachedClassification(key: string): ClassificationResult | null {
  const entry = classificationCache.get(key);
  if (!entry) return null;
  // Expire after 5 minutes (context may have changed)
  if (Date.now() - entry.ts > 5 * 60 * 1000) {
    classificationCache.delete(key);
    return null;
  }
  // LRU: move to end
  classificationCache.delete(key);
  classificationCache.set(key, entry);
  return entry.result;
}

function setCachedClassification(key: string, result: ClassificationResult): void {
  // Evict oldest entry if at capacity
  if (classificationCache.size >= CLASSIFICATION_CACHE_SIZE) {
    const oldest = classificationCache.keys().next().value;
    if (oldest !== undefined) classificationCache.delete(oldest);
  }
  classificationCache.set(key, { result, ts: Date.now() });
}

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
  /** Full provider registry for task-based model routing */
  providers?: ProviderRegistry | undefined;
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
  const { skillRegistry, sessionManager, modeManager, jobStore, approvalBridge, taskManager } = deps;
  const { enableTools, maxToolIterations, workspacePath } = options;

  // Start with the default provider; may be swapped after classification
  let provider = deps.provider;
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

      // Route to coding model when a coding mode is active
      if (deps.providers) {
        const codingProvider = deps.providers.coding;
        if (codingProvider.model !== provider.model) {
          safeLogger.info('Model routing: coding mode active, switching provider', {
            mode: currentMode.name,
            from: provider.model,
            to: codingProvider.model,
          });
          provider = codingProvider;
        }
      }

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
  // Task types that should use the flat tool loop instead of the static
  // plan→run pipeline. Coding/file tasks need interactive read-then-edit
  // flow — the planner can't populate edit_file parameters at planning time.
  const FLAT_LOOP_TASK_TYPES = new Set(['coding', 'file_operation']);

  if (taskManager && enableTools) {
    try {
      const recentHistory = session.getHistory(6).map((m) => {
        const text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
        return `${m.role}: ${text.substring(0, 200)}`;
      });

      // Classify first to decide routing — cached to avoid redundant LLM calls
      const cacheKey = classificationCacheKey(input.text, recentHistory);
      let classification = getCachedClassification(cacheKey);
      if (!classification) {
        const { classifyMessage } = await import('../tasks/classifier.js');
        classification = await classifyMessage(input.text, recentHistory, provider);
        setCachedClassification(cacheKey, classification);
      } else {
        safeLogger.info('Classification cache hit', {
          taskClass: classification.taskClass,
          confidence: classification.confidence,
        });
      }

      const taskType = classification.taskType ?? '';
      const shouldUseFlat = FLAT_LOOP_TASK_TYPES.has(taskType);

      // Route to the correct model based on task type
      if (deps.providers && taskType) {
        const routedProvider = deps.providers.forTask(taskType);
        if (routedProvider.model !== provider.model) {
          safeLogger.info('Model routing: switching provider for task type', {
            taskType,
            from: provider.model,
            to: routedProvider.model,
          });
          provider = routedProvider;
        }
      }

      // ─── Clarification gate ───────────────────────────────────────
      // If the classifier detected missing key details, ask the user
      // for clarification instead of proceeding with an incomplete task.
      if (classification.needsClarification && classification.clarificationQuestions?.length) {
        safeLogger.info('Task classifier: needs clarification, generating follow-up questions', {
          taskClass: classification.taskClass,
          questionCount: classification.clarificationQuestions.length,
        });

        const questions = classification.clarificationQuestions;
        const clarificationPrompt = [
          `The user asked: "${input.text}"`,
          '',
          'Before you can give a great answer, you need a few more details. Ask these follow-up questions naturally:',
          ...questions.map((q, i) => `${i + 1}. ${q}`),
          '',
          'Write a short, friendly reply that asks these questions conversationally.',
          'Do NOT attempt the task yet — just ask for the missing info.',
          'Do NOT call any tools — respond with text only.',
        ].join('\n');

        try {
          const clarificationPass = await provider.generateWithTools(
            {
              prompt: clarificationPrompt,
              systemPrompt: enrichedSystemPrompt,
              maxTokens: 512,
              temperature: 0.7,
            },
            [], // no tools — text only
          );

          const clarificationResponse = applyResponseHints(
            clarificationPass.text.trim() || questions.join('\n'),
            modelProfile,
          );

          session.addMessage({ role: 'assistant', content: clarificationResponse });

          return {
            response: clarificationResponse,
            iterations: 0,
            toolCallsMade: [],
            taskPipelineUsed: false,
            taskClass: classification.taskClass,
            modelProfile: modelProfile.modelId,
            estimatedTokens: assembled.estimatedTokens,
          };
        } catch (clarifyError) {
          const clarifyMsg = clarifyError instanceof Error ? clarifyError.message : String(clarifyError);
          safeLogger.warn('Clarification pass failed, continuing with task pipeline', { error: clarifyMsg });
          // Fall through to normal handling
        }
      }

      if (classification.taskClass === 'conversation') {
        safeLogger.info('Task classifier: conversation, using flat tool loop', {
          confidence: classification.confidence,
        });
        // Fall through to flat tool loop
      } else if (shouldUseFlat) {
        safeLogger.info('Coding/file task — routing to flat tool loop for interactive handling', {
          taskClass: classification.taskClass,
          taskType,
          confidence: classification.confidence,
        });
        // Fall through to flat tool loop
      } else {
        // Non-coding task — use the full plan→execute pipeline
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

        safeLogger.info('Task classifier (via handle): conversation, using flat tool loop', {
          confidence: handleResult.classification.confidence,
        });
      }
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
  let allDupLastIteration = false;

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
      // Give it one more chance: send back error messages telling it to respond.
      // If it loops again on the next iteration, then hard-break.
      if (newCalls.length === 0 && blockedCalls.length === 0) {
        if (allDupLastIteration) {
          // Two consecutive all-dup iterations — hard break
          safeLogger.warn('Consecutive all-duplicate iterations — forcing response', { iteration });
          finalResponse = response.text || '';
          break;
        }
        allDupLastIteration = true;
        safeLogger.warn('All tool calls are duplicates — nudging model to respond', { iteration });
      } else {
        allDupLastIteration = false;
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
        error: 'STOP: This exact tool call was already completed successfully. Do NOT call any more tools. Write your final text response to the user NOW.',
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

    // Set up for next iteration — sanitize tool outputs before they re-enter the LLM context
    previousResults = results.map((r) => {
      if (!r.success) {
        return {
          callId: r.toolCallId,
          result: `Error: ${r.error}`,
          isError: true,
        };
      }

      // Find the tool name for this result so we can apply appropriate sanitization
      const matchingCall = [...newCalls, ...dupCalls, ...blockedCalls]
        .find((c) => c.id === r.toolCallId);
      const toolName = matchingCall?.name ?? 'unknown';
      const rawOutput = r.output ?? 'Success';

      // Sanitize: fences web content, strips injection patterns, flags suspicious output
      const sanitized = sanitizeToolOutput(toolName, rawOutput);

      return {
        callId: r.toolCallId,
        result: sanitized.output,
        isError: false,
      };
    });

    // Include any text from response
    if (response.text) {
      finalResponse += response.text + '\n';
    }
  }

  if (iteration >= maxToolIterations) {
    safeLogger.warn('Max tool iterations reached', { maxToolIterations });
  }

  // ─── Summary Pass ────────────────────────────────────────────────────
  // If the model completed tool calls but never generated text, synthesize
  // a response from the tool history. Common with local models that don't
  // reliably transition from tool-calling to text generation.
  if (!finalResponse.trim() && toolCallsMade.length > 0) {
    try {
      const toolSummary = toolCallsMade
        .map((tc) => `- ${tc.name}: ${tc.success ? 'success' : 'failed'} — ${tc.inputPreview.substring(0, 100)}`)
        .join('\n');

      const summaryPrompt = [
        `The user asked: "${input.text}"`,
        '',
        'You used these tools to handle the request:',
        toolSummary,
        '',
        'Write a short, natural reply summarizing what you did.',
        'Do NOT call any tools — respond with text only.',
      ].join('\n');

      const summaryPass = await provider.generateWithTools(
        {
          prompt: summaryPrompt,
          systemPrompt: enrichedSystemPrompt,
          maxTokens: 512,
          temperature: 0.7,
        },
        [], // no tools — text only
      );

      finalResponse = summaryPass.text.trim();
      safeLogger.info('Summary pass generated response', {
        length: finalResponse.length,
        toolCallsCompleted: toolCallsMade.length,
      });
    } catch (summaryError) {
      const msg = summaryError instanceof Error ? summaryError.message : String(summaryError);
      safeLogger.warn('Summary pass failed', { error: msg });
    }
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
