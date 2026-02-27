/**
 * Fast Tools — Filtered toolkit for the FastLoop (27B).
 *
 * The FastLoop does NOT get the full 96-tool toolkit. It gets a minimal set:
 *   - Core tools: think, read_file, search_code
 *   - TaskBoard tools: read, create, update, claim
 *   - Communication tools: respond_to_user, read_task_artifacts
 *
 * This keeps the 27B's context overhead minimal (~2K for tool schemas
 * vs ~50K for the full toolkit).
 *
 * See docs/dual-loop-architecture.md Section 9.
 */

import type { ToolSchema } from '../tools/schemas/types.js';
import type { TaskBoard } from './task-board.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The FastLoop's tool execution context.
 */
export interface FastToolContext {
  taskBoard: TaskBoard;
  projectRoot: string;
}

/**
 * A single executable fast tool.
 */
export interface FastTool {
  schema: ToolSchema;
  execute: (input: Record<string, unknown>, context: FastToolContext) => Promise<string>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool Definitions (Schemas)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the filtered tool schemas for the FastLoop.
 */
export function buildFastToolSchemas(): ToolSchema[] {
  // TODO(pass-3): Define TaskBoard tool schemas + core tool subset
  return [];
}

/**
 * Build the full fast toolkit (schemas + executors).
 */
export function buildFastToolkit(context: FastToolContext): FastTool[] {
  void context;
  // TODO(pass-3): Wire up tool executors to TaskBoard operations
  return [];
}

/**
 * Execute a tool call by name against the fast toolkit.
 */
export async function executeFastTool(
  name: string,
  input: Record<string, unknown>,
  tools: FastTool[],
  context: FastToolContext,
): Promise<string> {
  const tool = tools.find((t) => t.schema.name === name);
  if (!tool) {
    return JSON.stringify({ error: `Unknown tool: ${name}` });
  }
  return tool.execute(input, context);
}
