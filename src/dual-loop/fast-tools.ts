/**
 * Fast Tools — Filtered toolkit for the FastLoop (27B).
 *
 * The FastLoop does NOT get the full 96-tool toolkit. It gets a minimal set
 * of TaskBoard-aware tools that enable it to coordinate with the DeepLoop:
 *
 *   - task_board_summary: Read current board state
 *   - create_task: Create a task for the DeepLoop
 *   - read_task: Read a specific task's details
 *   - read_task_artifacts: Read artifacts (diffs) produced by the DeepLoop
 *   - write_review: Write a review result on a task
 *   - think: Reason without side effects (from existing toolkit)
 *
 * This keeps the 27B's context overhead minimal (~2K for tool schemas
 * vs ~50K for the full toolkit).
 *
 * See docs/dual-loop-architecture.md Section 9.
 */

import type { ToolSchema } from '../tools/schemas/types.js';
import type { TaskBoard } from './task-board.js';
import type { ReviewResult } from './task-board-types.js';

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
// Tool Schemas
// ─────────────────────────────────────────────────────────────────────────────

const TASK_BOARD_SUMMARY_SCHEMA: ToolSchema = {
  name: 'task_board_summary',
  description: 'Get a summary of all active tasks on the board, including status, owner, and priority.',
  inputSchema: { type: 'object', properties: {}, required: [] },
};

const CREATE_TASK_SCHEMA: ToolSchema = {
  name: 'create_task',
  description: 'Create a task for the deep thinker to work on. Use for complex requests that need file reading, code writing, or multi-step reasoning.',
  inputSchema: {
    type: 'object',
    properties: {
      message: { type: 'string', description: 'The user message or task description' },
      sender: { type: 'string', description: 'Who requested this (user name or "system")' },
      priority: { type: 'number', description: 'Priority (0=highest, 3=lowest). User requests default to 0.' },
      triageNotes: { type: 'string', description: 'Your triage notes to help the deep thinker understand the request' },
    },
    required: ['message', 'triageNotes'],
  },
};

const READ_TASK_SCHEMA: ToolSchema = {
  name: 'read_task',
  description: 'Read the full details of a specific task by ID, including plan, artifacts, and review status.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'The task ID (e.g., "task-a1b2c3d4")' },
    },
    required: ['id'],
  },
};

const READ_TASK_ARTIFACTS_SCHEMA: ToolSchema = {
  name: 'read_task_artifacts',
  description: 'Read the artifacts (code diffs, file changes, test results) produced by the deep thinker for a task.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'The task ID' },
    },
    required: ['id'],
  },
};

const WRITE_REVIEW_SCHEMA: ToolSchema = {
  name: 'write_review',
  description: 'Write a code review result on a task. Use after reading the artifacts.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'The task ID to review' },
      result: { type: 'string', enum: ['approved', 'changes_requested', 'rejected'], description: 'Review verdict' },
      notes: { type: 'string', description: 'Summary of findings' },
      feedback: { type: 'string', description: 'Specific changes needed (only for changes_requested)' },
    },
    required: ['id', 'result', 'notes'],
  },
};

const THINK_SCHEMA: ToolSchema = {
  name: 'think',
  description: 'Think through a problem step by step. No side effects — use this to reason before acting.',
  inputSchema: {
    type: 'object',
    properties: {
      thought: { type: 'string', description: 'Your reasoning' },
    },
    required: ['thought'],
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Tool Executors
// ─────────────────────────────────────────────────────────────────────────────

async function executeTaskBoardSummary(
  _input: Record<string, unknown>,
  ctx: FastToolContext,
): Promise<string> {
  return ctx.taskBoard.getSummaryText();
}

async function executeCreateTask(
  input: Record<string, unknown>,
  ctx: FastToolContext,
): Promise<string> {
  const id = ctx.taskBoard.create({
    origin: 'user',
    priority: typeof input['priority'] === 'number' ? input['priority'] : 0,
    sender: typeof input['sender'] === 'string' ? input['sender'] : undefined,
    originalMessage: typeof input['message'] === 'string' ? input['message'] : '',
    triageNotes: typeof input['triageNotes'] === 'string' ? input['triageNotes'] : '',
    classification: 'complex',
  });
  return JSON.stringify({ created: id });
}

async function executeReadTask(
  input: Record<string, unknown>,
  ctx: FastToolContext,
): Promise<string> {
  const id = String(input['id'] ?? '');
  const task = ctx.taskBoard.get(id);
  if (!task) return JSON.stringify({ error: `Task not found: ${id}` });

  // Return a sanitized view (exclude potentially large fields from summary)
  return JSON.stringify({
    id: task.id,
    status: task.status,
    owner: task.owner,
    origin: task.origin,
    priority: task.priority,
    classification: task.classification,
    triageNotes: task.triageNotes,
    plan: task.plan,
    planSteps: task.planSteps,
    reviewResult: task.reviewResult,
    reviewNotes: task.reviewNotes,
    userFacing: task.userFacing,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  });
}

async function executeReadTaskArtifacts(
  input: Record<string, unknown>,
  ctx: FastToolContext,
): Promise<string> {
  const id = String(input['id'] ?? '');
  const task = ctx.taskBoard.get(id);
  if (!task) return JSON.stringify({ error: `Task not found: ${id}` });
  if (!task.artifacts || task.artifacts.length === 0) {
    return JSON.stringify({ artifacts: [], message: 'No artifacts yet' });
  }
  return JSON.stringify({ artifacts: task.artifacts });
}

async function executeWriteReview(
  input: Record<string, unknown>,
  ctx: FastToolContext,
): Promise<string> {
  const id = String(input['id'] ?? '');
  const result = String(input['result'] ?? 'approved') as ReviewResult;
  const notes = String(input['notes'] ?? '');
  const feedback = typeof input['feedback'] === 'string' ? input['feedback'] : undefined;

  const task = ctx.taskBoard.get(id);
  if (!task) return JSON.stringify({ error: `Task not found: ${id}` });
  if (task.status !== 'reviewing') {
    return JSON.stringify({ error: `Task ${id} is not in reviewing status (current: ${task.status})` });
  }

  const newStatus = result === 'approved' ? 'done' as const : 'revision' as const;

  ctx.taskBoard.update(id, {
    reviewResult: result,
    reviewNotes: notes,
    reviewFeedback: feedback,
    status: newStatus,
    owner: null,
    ...(result === 'approved' ? { resolvedAt: new Date().toISOString() } : {}),
  });

  return JSON.stringify({ reviewed: id, result, newStatus });
}

async function executeThink(
  input: Record<string, unknown>,
  _ctx: FastToolContext,
): Promise<string> {
  // Think tool has no side effects — just acknowledge the reasoning
  return JSON.stringify({ thought_recorded: true });
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the filtered tool schemas for the FastLoop.
 */
export function buildFastToolSchemas(): ToolSchema[] {
  return [
    TASK_BOARD_SUMMARY_SCHEMA,
    CREATE_TASK_SCHEMA,
    READ_TASK_SCHEMA,
    READ_TASK_ARTIFACTS_SCHEMA,
    WRITE_REVIEW_SCHEMA,
    THINK_SCHEMA,
  ];
}

/**
 * Build the full fast toolkit (schemas + executors).
 */
export function buildFastToolkit(context: FastToolContext): FastTool[] {
  void context; // context is captured per-call, not at build time
  return [
    { schema: TASK_BOARD_SUMMARY_SCHEMA, execute: executeTaskBoardSummary },
    { schema: CREATE_TASK_SCHEMA, execute: executeCreateTask },
    { schema: READ_TASK_SCHEMA, execute: executeReadTask },
    { schema: READ_TASK_ARTIFACTS_SCHEMA, execute: executeReadTaskArtifacts },
    { schema: WRITE_REVIEW_SCHEMA, execute: executeWriteReview },
    { schema: THINK_SCHEMA, execute: executeThink },
  ];
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
