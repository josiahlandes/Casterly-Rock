/**
 * Tool Helpers — Shared utility functions for tool executors.
 *
 * Extracted from agent-tools.ts so every category module can
 * import them without pulling in the entire monolith.
 */

import type { NativeToolCall, NativeToolResult } from '../../tools/schemas/types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Output Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Truncate output to the configured maximum, appending a notice if truncated.
 */
export function truncateOutput(output: string, maxChars: number): string {
  if (output.length <= maxChars) {
    return output;
  }
  const truncated = output.slice(0, maxChars);
  const remaining = output.length - maxChars;
  return `${truncated}\n\n[... truncated ${remaining} characters]`;
}

/**
 * Build a success result for a tool call.
 */
export function successResult(callId: string, output: string, maxChars: number): NativeToolResult {
  return {
    toolCallId: callId,
    success: true,
    output: truncateOutput(output, maxChars),
  };
}

/**
 * Build a failure result for a tool call.
 */
export function failureResult(callId: string, error: string): NativeToolResult {
  return {
    toolCallId: callId,
    success: false,
    error,
  };
}

/**
 * Extract a required string parameter, returning an error result if missing.
 */
export function requireString(
  call: NativeToolCall,
  param: string,
): { value: string } | { error: NativeToolResult } {
  const value = call.input[param];
  if (typeof value !== 'string' || value.length === 0) {
    return {
      error: failureResult(call.id, `Missing required parameter: ${param}`),
    };
  }
  return { value };
}

/**
 * Extract an optional string parameter.
 */
export function optionalString(call: NativeToolCall, param: string): string | undefined {
  const value = call.input[param];
  return typeof value === 'string' ? value : undefined;
}

/**
 * Extract an optional number parameter.
 */
export function optionalNumber(call: NativeToolCall, param: string): number | undefined {
  const value = call.input[param];
  return typeof value === 'number' ? value : undefined;
}

/**
 * Check if a file path is allowed for writing.
 */
export function isPathAllowed(
  filePath: string,
  allowedDirectories: string[],
  forbiddenPatterns: string[],
): boolean {
  // Check forbidden patterns (simple substring matching for now)
  for (const pattern of forbiddenPatterns) {
    // Convert glob to simple check
    const cleanPattern = pattern.replace(/\*\*/g, '').replace(/\*/g, '');
    if (cleanPattern && filePath.includes(cleanPattern)) {
      return false;
    }
  }

  // Check allowed directories
  if (allowedDirectories.length === 0) {
    return true;
  }
  return allowedDirectories.some((dir) => filePath.startsWith(dir));
}

// ─────────────────────────────────────────────────────────────────────────────
// Blocked Command Patterns
// ─────────────────────────────────────────────────────────────────────────────

const BLOCKED_COMMANDS = [
  /\brm\s+(-rf?|--recursive)\s/,
  /\brm\s+-[a-zA-Z]*f[a-zA-Z]*\s+\//,
  /\bmkfs\b/,
  /\bdd\s+/,
  /\b>\s*\/dev\/sd/,
  /\bformat\b/,
  /\bshutdown\b/,
  /\breboot\b/,
  /\bsudo\s+rm\b/,
  /\bgit\s+push\s+.*--force\b/,
  /\bgit\s+reset\s+--hard\b/,
  /\bgit\s+clean\s+-[a-zA-Z]*f/,
];

export function isCommandBlocked(command: string): boolean {
  return BLOCKED_COMMANDS.some((pattern) => pattern.test(command));
}
