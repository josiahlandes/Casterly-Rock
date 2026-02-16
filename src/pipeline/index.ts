/**
 * Pipeline Module
 *
 * Shared chat processing pipeline used by all interfaces
 * (iMessage daemon, terminal REPL, etc.)
 */

export {
  processChatMessage,
  type ChatInput,
  type ProcessResult,
  type ProcessDependencies,
  type ProcessOptions,
  type ToolCallRecord,
} from './process.js';
