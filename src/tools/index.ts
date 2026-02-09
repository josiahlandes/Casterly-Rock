/**
 * Tools Module
 *
 * Provides native tool execution for LLM tool use.
 */

// Types and schemas
export type {
  ToolSchema,
  NativeToolCall,
  NativeToolResult,
  ToolResultMessage,
  GenerateWithToolsResponse,
  NativeToolExecutor,
} from './schemas/index.js';

export {
  BASH_TOOL,
  ROUTE_DECISION_TOOL,
  CORE_TOOLS,
  createToolRegistry,
} from './schemas/index.js';

export type { ToolRegistry } from './schemas/index.js';

// Executor
export {
  createBashExecutor,
  executeBashToolCall,
  requiresApproval,
} from './executor.js';

export type { BashExecutorOptions } from './executor.js';

// Orchestrator
export { createToolOrchestrator } from './orchestrator.js';

export type { ToolOrchestrator } from './orchestrator.js';
