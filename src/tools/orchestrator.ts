/**
 * Tool Orchestrator
 *
 * Manages multiple tool executors and coordinates tool call execution.
 */

import { safeLogger } from '../logging/safe-logger.js';
import type { NativeToolCall, NativeToolResult, NativeToolExecutor } from './schemas/types.js';

/**
 * Tool orchestrator interface
 */
export interface ToolOrchestrator {
  /** Register a tool executor */
  registerExecutor(executor: NativeToolExecutor): void;

  /** Check if an executor exists for a tool */
  canExecute(toolName: string): boolean;

  /** Execute a single tool call */
  execute(call: NativeToolCall): Promise<NativeToolResult>;

  /** Execute multiple tool calls in sequence */
  executeAll(calls: NativeToolCall[]): Promise<NativeToolResult[]>;

  /** Get list of registered tool names */
  getRegisteredTools(): string[];
}

/**
 * Create a tool orchestrator
 */
export function createToolOrchestrator(): ToolOrchestrator {
  const executors = new Map<string, NativeToolExecutor>();

  return {
    registerExecutor(executor: NativeToolExecutor): void {
      executors.set(executor.toolName, executor);
      safeLogger.info('Registered tool executor', { toolName: executor.toolName });
    },

    canExecute(toolName: string): boolean {
      return executors.has(toolName);
    },

    async execute(call: NativeToolCall): Promise<NativeToolResult> {
      const executor = executors.get(call.name);

      if (!executor) {
        safeLogger.warn('No executor for tool', { toolName: call.name });
        return {
          toolCallId: call.id,
          success: false,
          error: `Unknown tool: ${call.name}`,
        };
      }

      try {
        safeLogger.info('Executing tool call', {
          toolName: call.name,
          toolCallId: call.id,
          inputKeys: Object.keys(call.input),
        });

        const result = await executor.execute(call);

        safeLogger.info('Tool call completed', {
          toolCallId: call.id,
          success: result.success,
          outputLength: result.output?.length ?? 0,
          hasError: !!result.error,
        });

        return result;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        safeLogger.error('Tool execution error', {
          toolName: call.name,
          toolCallId: call.id,
          error: errorMessage,
        });

        return {
          toolCallId: call.id,
          success: false,
          error: `Execution error: ${errorMessage}`,
        };
      }
    },

    async executeAll(calls: NativeToolCall[]): Promise<NativeToolResult[]> {
      const results: NativeToolResult[] = [];

      for (const call of calls) {
        const result = await this.execute(call);
        results.push(result);

        // Continue even on failure - let the LLM decide how to handle
      }

      return results;
    },

    getRegisteredTools(): string[] {
      return Array.from(executors.keys());
    },
  };
}
