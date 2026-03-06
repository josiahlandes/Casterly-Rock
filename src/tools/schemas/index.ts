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
  READ_DOCUMENT_TOOL,
  CORE_TOOLS,
} from './core.js';

// Coding tools
export {
  EDIT_FILE_TOOL,
  GLOB_FILES_TOOL,
  GREP_FILES_TOOL,
  VALIDATE_FILES_TOOL,
  CODING_TOOLS,
} from './coding.js';

// Messaging tools
export {
  SEND_MESSAGE_TOOL,
  MESSAGING_TOOLS,
} from './messaging.js';

// Productivity tools
export {
  CALENDAR_READ_TOOL,
  REMINDER_CREATE_TOOL,
  HTTP_GET_TOOL,
  PRODUCTIVITY_TOOLS,
} from './productivity.js';

// Argument repair
export type { RepairResult } from './repair.js';
export { repairToolArgs, repairToolCallInput } from './repair.js';

// Registry
export type { ToolRegistry, AnthropicTool, OllamaTool } from './registry.js';
export { createToolRegistry } from './registry.js';
