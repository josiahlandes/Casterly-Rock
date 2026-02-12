/**
 * Tool Schemas Module
 *
 * Exports all types, core tools, and registry for native tool use.
 */

// Types
export type {
  JsonSchemaType,
  ToolProperty,
  ToolInputSchema,
  ToolSchema,
  NativeToolCall,
  NativeToolResult,
  ToolResultMessage,
  GenerateWithToolsResponse,
  ToolExecutor,
  NativeToolExecutor,
} from './types.js';

// Core tools
export {
  BASH_TOOL,
  READ_FILE_TOOL,
  WRITE_FILE_TOOL,
  LIST_FILES_TOOL,
  SEARCH_FILES_TOOL,
  CORE_TOOLS,
} from './core.js';

// Registry
export type { ToolRegistry, AnthropicTool, OllamaTool } from './registry.js';
export { createToolRegistry } from './registry.js';
