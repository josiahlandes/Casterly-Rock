/**
 * Tool Registry
 *
 * Manages tool schemas and provides format conversion for different providers.
 */

import type { ToolSchema, ToolInputSchema } from './types.js';
import { CORE_TOOLS } from './core.js';

/**
 * Tool registry interface
 */
export interface ToolRegistry {
  /** Register a new tool */
  register(tool: ToolSchema): void;

  /** Get all registered tools */
  getTools(): ToolSchema[];

  /** Get a tool by name */
  getTool(name: string): ToolSchema | undefined;

  /** Format tools for Anthropic Claude API */
  formatForAnthropic(): AnthropicTool[];

  /** Format tools for Ollama API (OpenAI-compatible) */
  formatForOllama(): OllamaTool[];
}

/**
 * Anthropic tool format
 */
export interface AnthropicTool {
  name: string;
  description: string;
  input_schema: ToolInputSchema;
}

/**
 * Ollama/OpenAI tool format
 */
export interface OllamaTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: ToolInputSchema;
  };
}

/**
 * Create a new tool registry
 *
 * @param includeCoreToos - Whether to include core tools (default: true)
 */
export function createToolRegistry(includeCoreTools = true): ToolRegistry {
  const tools = new Map<string, ToolSchema>();

  // Register core tools by default
  if (includeCoreTools) {
    for (const tool of CORE_TOOLS) {
      tools.set(tool.name, tool);
    }
  }

  return {
    register(tool: ToolSchema): void {
      tools.set(tool.name, tool);
    },

    getTools(): ToolSchema[] {
      return Array.from(tools.values());
    },

    getTool(name: string): ToolSchema | undefined {
      return tools.get(name);
    },

    formatForAnthropic(): AnthropicTool[] {
      return Array.from(tools.values()).map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.inputSchema,
      }));
    },

    formatForOllama(): OllamaTool[] {
      return Array.from(tools.values()).map((tool) => ({
        type: 'function' as const,
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema,
        },
      }));
    },
  };
}
