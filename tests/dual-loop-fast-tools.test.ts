import { describe, expect, it, beforeEach } from 'vitest';
import {
  buildFastToolSchemas,
  buildFastToolkit,
  executeFastTool,
} from '../src/dual-loop/fast-tools.js';
import type { FastTool, FastToolContext } from '../src/dual-loop/fast-tools.js';
import { TaskBoard, createTaskBoard } from '../src/dual-loop/task-board.js';
import { initTracer, resetTracer } from '../src/autonomous/debug.js';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeContext(): FastToolContext {
  return {
    taskBoard: createTaskBoard({ dbPath: '/tmp/test-fast-tools.json' }),
    projectRoot: '/tmp/test-project',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('Fast Tools', () => {
  beforeEach(() => {
    resetTracer();
    initTracer({ level: 'error', subsystems: {} });
  });

  describe('buildFastToolSchemas', () => {
    it('returns 5 tool schemas', () => {
      const schemas = buildFastToolSchemas();
      expect(schemas).toHaveLength(5);
    });

    it('includes expected tool names', () => {
      const names = buildFastToolSchemas().map((s) => s.name);
      expect(names).toContain('task_board_summary');
      expect(names).toContain('create_task');
      expect(names).toContain('read_task');
      expect(names).toContain('read_task_artifacts');
      expect(names).toContain('think');
    });

    it('all schemas have name, description, and inputSchema', () => {
      for (const schema of buildFastToolSchemas()) {
        expect(schema.name).toBeTruthy();
        expect(schema.description).toBeTruthy();
        expect(schema.inputSchema).toBeDefined();
      }
    });
  });

  describe('buildFastToolkit', () => {
    it('returns 5 tools with schemas and executors', () => {
      const tools = buildFastToolkit();
      expect(tools).toHaveLength(5);
      for (const tool of tools) {
        expect(tool.schema).toBeDefined();
        expect(typeof tool.execute).toBe('function');
      }
    });
  });

  describe('executeFastTool', () => {
    let ctx: FastToolContext;
    let tools: FastTool[];

    beforeEach(() => {
      ctx = makeContext();
      tools = buildFastToolkit();
    });

    it('task_board_summary returns empty board summary', async () => {
      const result = await executeFastTool('task_board_summary', {}, tools, ctx);
      expect(result).toBe('(no active tasks)');
    });

    it('create_task creates a task and returns its ID', async () => {
      const result = await executeFastTool('create_task', {
        message: 'Fix the bug',
        sender: 'alice',
        triageNotes: 'Complex task',
        priority: 0,
      }, tools, ctx);

      const parsed = JSON.parse(result) as { created: string };
      expect(parsed.created).toMatch(/^task-/);

      // Verify it's in the board
      const task = ctx.taskBoard.get(parsed.created);
      expect(task).not.toBeNull();
      expect(task!.originalMessage).toBe('Fix the bug');
    });

    it('read_task returns task details', async () => {
      const id = ctx.taskBoard.create({
        origin: 'user',
        priority: 0,
        sender: 'bob',
        originalMessage: 'Add tests',
        classification: 'complex',
        triageNotes: 'Needs test coverage',
      });

      const result = await executeFastTool('read_task', { id }, tools, ctx);
      const parsed = JSON.parse(result) as { id: string; status: string };
      expect(parsed.id).toBe(id);
      expect(parsed.status).toBe('queued');
    });

    it('read_task returns error for unknown ID', async () => {
      const result = await executeFastTool('read_task', { id: 'fake' }, tools, ctx);
      const parsed = JSON.parse(result) as { error: string };
      expect(parsed.error).toContain('not found');
    });

    it('read_task_artifacts returns empty for new task', async () => {
      const id = ctx.taskBoard.create({
        origin: 'user', priority: 0, originalMessage: 'test',
        triageNotes: '',
      });
      const result = await executeFastTool('read_task_artifacts', { id }, tools, ctx);
      const parsed = JSON.parse(result) as { artifacts: unknown[]; message: string };
      expect(parsed.artifacts).toHaveLength(0);
    });

    it('think returns acknowledgment', async () => {
      const result = await executeFastTool('think', {
        thought: 'Let me consider the options...',
      }, tools, ctx);

      const parsed = JSON.parse(result) as { thought_recorded: boolean };
      expect(parsed.thought_recorded).toBe(true);
    });

    it('returns error for unknown tool', async () => {
      const result = await executeFastTool('nonexistent', {}, tools, ctx);
      const parsed = JSON.parse(result) as { error: string };
      expect(parsed.error).toContain('Unknown tool');
    });
  });
});
