/**
 * Testable Runner
 *
 * Mac Studio Edition - Local Ollama Only
 *
 * A wrapper around the core Casterly processing pipeline that
 * captures trace events for testing and debugging purposes.
 */

import { loadConfig } from '../config/index.js';
import { buildProviders, type LlmProvider } from '../providers/index.js';
import { createSkillRegistry, type SkillRegistry } from '../skills/index.js';
import {
  createToolRegistry,
  createToolOrchestrator,
  createBashExecutor,
  type ToolResultMessage,
  type NativeToolResult,
} from '../tools/index.js';
import {
  createSessionManager,
  assembleContext,
  findWorkspacePath,
  type SessionManager,
} from '../interface/index.js';
import type { TraceCollector } from './trace.js';

export interface TestableRunnerOptions {
  /** Enable tool execution (default: true) */
  enableTools?: boolean;
  /** Max tool iterations (default: 5) */
  maxToolIterations?: number;
  /** Workspace path for context assembly */
  workspacePath?: string;
  /** Auto-approve bash commands (default: true for testing) */
  autoApproveBash?: boolean;
}

export interface TestableRunnerDependencies {
  config?: ReturnType<typeof loadConfig>;
  providers?: ReturnType<typeof buildProviders>;
  skillRegistry?: SkillRegistry;
  sessionManager?: SessionManager;
}

/**
 * Create a testable runner with trace collection
 */
export function createTestableRunner(
  options: TestableRunnerOptions = {},
  deps: TestableRunnerDependencies = {}
) {
  const {
    enableTools = true,
    maxToolIterations = 200,
    workspacePath = findWorkspacePath() || process.cwd(),
    autoApproveBash = true,
  } = options;

  // Use provided dependencies or create defaults
  const config = deps.config ?? loadConfig();
  const providers = deps.providers ?? buildProviders(config);
  const skillRegistry = deps.skillRegistry ?? createSkillRegistry();
  const sessionManager = deps.sessionManager ?? createSessionManager({ scope: 'main' });

  return {
    /**
     * Process a single request with trace collection
     */
    async processRequest(input: string, trace: TraceCollector): Promise<string> {
      trace.addEvent('request_start', { input: input.substring(0, 200) });

      // Get or create session
      const session = sessionManager.getSession('test', 'test-user');

      // Add user message to session
      session.addMessage({
        role: 'user',
        content: input,
        sender: 'test-user',
      });

      // ─────────────────────────────────────────────────────────────────
      // PROVIDER SELECTION (Local Only)
      // ─────────────────────────────────────────────────────────────────
      trace.addEvent('provider_selected', {
        provider: 'local',
        model: config.local.model,
      });

      const provider = providers.local;

      // ─────────────────────────────────────────────────────────────────
      // CONTEXT ASSEMBLY PHASE
      // ─────────────────────────────────────────────────────────────────
      const contextEventId = trace.startTimedEvent('context_assembly');

      const skills = skillRegistry.getAvailable();
      const assembled = assembleContext({
        session,
        userMessage: input,
        sender: 'test-user',
        skills,
        channel: 'cli',
        workspacePath,
      });

      trace.endTimedEvent(contextEventId, {
        estimatedTokens: assembled.estimatedTokens,
        historyMessages: assembled.historyMessagesIncluded,
        skillsIncluded: skills.length,
      });

      // ─────────────────────────────────────────────────────────────────
      // LLM INFERENCE WITH TOOLS PHASE
      // ─────────────────────────────────────────────────────────────────
      const toolRegistry = createToolRegistry();
      const orchestrator = createToolOrchestrator();
      orchestrator.registerExecutor(createBashExecutor({ autoApprove: autoApproveBash }));

      let iteration = 0;
      let finalResponse = '';
      const currentProvider: LlmProvider = provider;
      let previousResults: ToolResultMessage[] = [];

      // Native tool execution loop
      while (iteration < maxToolIterations) {
        iteration++;
        trace.addEvent('tool_loop_iteration', { iteration });

        const llmEventId = trace.startTimedEvent('llm_request', {
          provider: currentProvider.id,
          iteration,
        });

        const response = await currentProvider.generateWithTools(
          {
            prompt: assembled.context,
            systemPrompt: assembled.systemPrompt,
            maxTokens: 2048,
            temperature: 0.7,
          },
          enableTools ? toolRegistry.getTools() : [],
          previousResults.length > 0 ? previousResults : undefined
        );

        trace.endTimedEvent(llmEventId);
        trace.addEvent('llm_response', {
          providerId: response.providerId,
          model: response.model,
          textLength: response.text.length,
          toolCalls: response.toolCalls.length,
          stopReason: response.stopReason,
        });

        // If no tool calls, we're done
        if (response.toolCalls.length === 0) {
          finalResponse = response.text;
          break;
        }

        // Record tool calls received
        for (const call of response.toolCalls) {
          trace.addEvent('tool_call_received', {
            toolName: call.name,
            toolId: call.id,
            input: JSON.stringify(call.input).substring(0, 500),
          });
        }

        // Execute tool calls
        const results: NativeToolResult[] = [];

        if (response.toolCalls.length > 0) {
          for (const call of response.toolCalls) {
            const execEventId = trace.startTimedEvent('tool_execution_start', {
              toolName: call.name,
              toolId: call.id,
            });

            const [result] = await orchestrator.executeAll([call]);

            trace.endTimedEvent(execEventId);
            trace.addEvent('tool_execution_result', {
              toolCallId: call.id,
              success: result?.success ?? false,
              outputLength: result?.output?.length ?? 0,
              error: result?.error?.substring(0, 200),
            });

            if (result) {
              results.push(result);
            }
          }
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
        trace.addEvent('error', {
          type: 'max_iterations',
          iterations: iteration,
        });
        finalResponse += '\n\n(Reached maximum tool execution limit)';
      }

      // ─────────────────────────────────────────────────────────────────
      // RESPONSE COMPLETE
      // ─────────────────────────────────────────────────────────────────
      const cleanedResponse = finalResponse
        .replace(/```bash[\s\S]*?```/g, '')
        .replace(/```sh[\s\S]*?```/g, '')
        .replace(/\[(?:REMEMBER|NOTE|MEMORY)\](?:\[[^\]]*\])?\s*[^\[]*/gi, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();

      trace.setFinalResponse(cleanedResponse || 'Done!');
      trace.addEvent('response_complete', {
        iterations: iteration,
        responseLength: cleanedResponse.length,
      });

      // Add assistant response to session
      session.addMessage({
        role: 'assistant',
        content: cleanedResponse || 'Done!',
      });

      return cleanedResponse || 'Done!';
    },

    /**
     * Get the skill registry for inspection
     */
    getSkillRegistry(): SkillRegistry {
      return skillRegistry;
    },

    /**
     * Get provider info
     */
    getProviderInfo() {
      return {
        local: providers.local.id,
      };
    },
  };
}

export type TestableRunner = ReturnType<typeof createTestableRunner>;
