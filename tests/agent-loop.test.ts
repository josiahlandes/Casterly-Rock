import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { AgentLoop, createAgentLoop } from '../src/autonomous/agent-loop.js';
import type { AgentTrigger, AgentLoopConfig, AgentOutcome } from '../src/autonomous/agent-loop.js';
import { buildAgentToolkit } from '../src/autonomous/agent-tools.js';
import type { AgentState, AgentToolkit } from '../src/autonomous/agent-tools.js';
import { GoalStack } from '../src/autonomous/goal-stack.js';
import { IssueLog } from '../src/autonomous/issue-log.js';
import { WorldModel } from '../src/autonomous/world-model.js';
import { resetTracer, initTracer } from '../src/autonomous/debug.js';
import type { LlmProvider, GenerateRequest } from '../src/providers/base.js';
import type {
  ToolSchema,
  NativeToolCall,
  ToolResultMessage,
  GenerateWithToolsResponse,
} from '../src/tools/schemas/types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Mock LLM Provider
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A mock LLM provider that returns pre-configured responses.
 * Responses are consumed in order: each call to generateWithTools()
 * pops the next response from the queue.
 */
function createMockProvider(responses: GenerateWithToolsResponse[]): LlmProvider {
  let callIndex = 0;

  return {
    id: 'mock-provider',
    kind: 'local',
    model: 'mock-model',

    async generateWithTools(
      _request: GenerateRequest,
      _tools: ToolSchema[],
      _previousResults?: ToolResultMessage[],
    ): Promise<GenerateWithToolsResponse> {
      if (callIndex >= responses.length) {
        // If we run out of responses, return a "done" response
        return {
          text: 'No more mock responses. Stopping.',
          toolCalls: [],
          providerId: 'mock-provider',
          model: 'mock-model',
          stopReason: 'end_turn',
        };
      }

      const response = responses[callIndex]!;
      callIndex++;
      return response;
    },
  };
}

/**
 * Build a mock response with no tool calls (agent is "done").
 */
function doneResponse(text: string): GenerateWithToolsResponse {
  return {
    text,
    toolCalls: [],
    providerId: 'mock-provider',
    model: 'mock-model',
    stopReason: 'end_turn',
  };
}

/**
 * Build a mock response with tool calls.
 */
function toolCallResponse(
  text: string,
  toolCalls: NativeToolCall[],
): GenerateWithToolsResponse {
  return {
    text,
    toolCalls,
    providerId: 'mock-provider',
    model: 'mock-model',
    stopReason: 'tool_use',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Test Setup
// ─────────────────────────────────────────────────────────────────────────────

let tempDir: string;
let state: AgentState;
let toolkit: AgentToolkit;

function buildTestToolkit(): AgentToolkit {
  return buildAgentToolkit(
    {
      projectRoot: tempDir,
      maxOutputChars: 5000,
      commandTimeoutMs: 10_000,
      allowedDirectories: ['src/', 'tests/'],
      forbiddenPatterns: ['**/*.env*'],
      delegationEnabled: false,
    },
    state,
  );
}

const defaultConfig: Partial<AgentLoopConfig> = {
  maxTurns: 5,
  maxTokensPerCycle: 50_000,
  temperature: 0.1,
  maxResponseTokens: 2048,
};

beforeEach(async () => {
  resetTracer();
  initTracer({ enabled: false });
  tempDir = await mkdtemp(join(tmpdir(), 'casterly-agent-loop-'));
  await mkdir(join(tempDir, 'src'), { recursive: true });
  await mkdir(join(tempDir, 'tests'), { recursive: true });

  const goalStack = new GoalStack({ path: join(tempDir, 'goals.yaml') });
  const issueLog = new IssueLog({ path: join(tempDir, 'issues.yaml') });
  const worldModel = new WorldModel({ path: join(tempDir, 'world-model.yaml'), projectRoot: tempDir });

  state = { goalStack, issueLog, worldModel };
  toolkit = buildTestToolkit();
});

afterEach(async () => {
  resetTracer();
  await rm(tempDir, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('AgentLoop — Basic Lifecycle', () => {
  it('completes immediately when LLM returns no tool calls', async () => {
    const provider = createMockProvider([
      doneResponse('Nothing to do. Codebase looks healthy.'),
    ]);

    const loop = createAgentLoop(defaultConfig, provider, toolkit, state);
    const trigger: AgentTrigger = { type: 'scheduled' };
    const outcome = await loop.run(trigger);

    expect(outcome.success).toBe(true);
    expect(outcome.stopReason).toBe('completed');
    expect(outcome.totalTurns).toBe(1);
    expect(outcome.summary).toContain('Nothing to do');
    expect(outcome.trigger.type).toBe('scheduled');
    expect(outcome.startedAt).toBeTruthy();
    expect(outcome.endedAt).toBeTruthy();
    expect(outcome.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('executes tool calls and continues looping', async () => {
    const provider = createMockProvider([
      // Turn 1: call think tool
      toolCallResponse('Let me think about this.', [
        { id: 'tc-1', name: 'think', input: { reasoning: 'I should check the codebase.' } },
      ]),
      // Turn 2: done
      doneResponse('All done. Reviewed the approach.'),
    ]);

    const loop = createAgentLoop(defaultConfig, provider, toolkit, state);
    const outcome = await loop.run({ type: 'scheduled' });

    expect(outcome.success).toBe(true);
    expect(outcome.stopReason).toBe('completed');
    expect(outcome.totalTurns).toBe(2);
    expect(outcome.turns[0]!.toolCalls).toHaveLength(1);
    expect(outcome.turns[0]!.toolCalls[0]!.name).toBe('think');
    expect(outcome.turns[1]!.toolCalls).toHaveLength(0);
  });

  it('handles multi-tool turns', async () => {
    const provider = createMockProvider([
      // Turn 1: call two tools
      toolCallResponse('Checking status and reading a file.', [
        { id: 'tc-1', name: 'think', input: { reasoning: 'Planning step.' } },
        { id: 'tc-2', name: 'think', input: { reasoning: 'Second thought.' } },
      ]),
      // Turn 2: done
      doneResponse('Completed analysis.'),
    ]);

    const loop = createAgentLoop(defaultConfig, provider, toolkit, state);
    const outcome = await loop.run({ type: 'scheduled' });

    expect(outcome.totalTurns).toBe(2);
    expect(outcome.turns[0]!.toolCalls).toHaveLength(2);
    expect(outcome.turns[0]!.toolResults).toHaveLength(2);
  });
});

describe('AgentLoop — Budget Controls', () => {
  it('stops at max turns', async () => {
    // Return tool calls for every response — never a "done" response
    const infiniteToolCalls = Array.from({ length: 10 }, (_, i) =>
      toolCallResponse(`Turn ${i + 1}`, [
        { id: `tc-${i}`, name: 'think', input: { reasoning: `Thought ${i + 1}` } },
      ]),
    );

    const provider = createMockProvider(infiniteToolCalls);
    const loop = createAgentLoop({ ...defaultConfig, maxTurns: 3 }, provider, toolkit, state);
    const outcome = await loop.run({ type: 'scheduled' });

    expect(outcome.success).toBe(false);
    expect(outcome.stopReason).toBe('max_turns');
    expect(outcome.totalTurns).toBe(3);
  });

  it('stops when token budget is exceeded', async () => {
    // Set a very low token budget
    const lowTokenConfig: Partial<AgentLoopConfig> = {
      ...defaultConfig,
      maxTokensPerCycle: 100, // Very low — will be exceeded after the first prompt
    };

    const provider = createMockProvider([
      toolCallResponse('First action', [
        { id: 'tc-1', name: 'think', input: { reasoning: 'Some reasoning' } },
      ]),
      doneResponse('Done'),
    ]);

    const loop = createAgentLoop(lowTokenConfig, provider, toolkit, state);
    const outcome = await loop.run({ type: 'scheduled' });

    // Should stop because token budget was exceeded before turn 2
    expect(outcome.stopReason).toBe('max_tokens');
  });
});

describe('AgentLoop — Abort', () => {
  it('can be aborted externally', async () => {
    const provider = createMockProvider([
      toolCallResponse('Working...', [
        { id: 'tc-1', name: 'think', input: { reasoning: 'Starting work' } },
      ]),
      // This response should never be reached
      doneResponse('Should not reach this'),
    ]);

    const loop = createAgentLoop(defaultConfig, provider, toolkit, state);

    // Abort before running (simulates immediate abort)
    loop.abort();

    const outcome = await loop.run({ type: 'scheduled' });

    expect(outcome.success).toBe(false);
    expect(outcome.stopReason).toBe('aborted');
    expect(outcome.totalTurns).toBe(0);
  });

  it('reports isAborted correctly', () => {
    const provider = createMockProvider([]);
    const loop = createAgentLoop(defaultConfig, provider, toolkit, state);

    expect(loop.isAborted()).toBe(false);
    loop.abort();
    expect(loop.isAborted()).toBe(true);
  });
});

describe('AgentLoop — Trigger Types', () => {
  it('handles scheduled trigger', async () => {
    const provider = createMockProvider([doneResponse('Scheduled check complete.')]);
    const loop = createAgentLoop(defaultConfig, provider, toolkit, state);
    const outcome = await loop.run({ type: 'scheduled' });

    expect(outcome.trigger.type).toBe('scheduled');
    expect(outcome.success).toBe(true);
  });

  it('handles event trigger', async () => {
    const provider = createMockProvider([doneResponse('Event handled.')]);
    const loop = createAgentLoop(defaultConfig, provider, toolkit, state);
    const outcome = await loop.run({
      type: 'event',
      event: {
        kind: 'test_failed',
        description: 'Test detector.test.ts failed',
        timestamp: new Date().toISOString(),
      },
    });

    expect(outcome.trigger.type).toBe('event');
    expect(outcome.success).toBe(true);
  });

  it('handles user trigger', async () => {
    const provider = createMockProvider([doneResponse('User request completed.')]);
    const loop = createAgentLoop(defaultConfig, provider, toolkit, state);
    const outcome = await loop.run({
      type: 'user',
      message: 'Please refactor the tool system',
      sender: 'Josiah',
    });

    expect(outcome.trigger.type).toBe('user');
    expect(outcome.success).toBe(true);
  });

  it('handles goal trigger', async () => {
    state.goalStack.addGoal({
      source: 'user',
      description: 'Refactor tool system',
    });
    const goal = state.goalStack.getGoal('goal-001')!;

    const provider = createMockProvider([doneResponse('Goal work in progress.')]);
    const loop = createAgentLoop(defaultConfig, provider, toolkit, state);
    const outcome = await loop.run({ type: 'goal', goal });

    expect(outcome.trigger.type).toBe('goal');
    expect(outcome.success).toBe(true);
  });
});

describe('AgentLoop — Error Handling', () => {
  it('handles LLM provider errors gracefully', async () => {
    const failingProvider: LlmProvider = {
      id: 'failing-provider',
      kind: 'local',
      model: 'fail-model',
      async generateWithTools(): Promise<GenerateWithToolsResponse> {
        throw new Error('Ollama connection refused');
      },
    };

    const loop = createAgentLoop(defaultConfig, failingProvider, toolkit, state);
    const outcome = await loop.run({ type: 'scheduled' });

    expect(outcome.success).toBe(false);
    expect(outcome.stopReason).toBe('error');
    expect(outcome.error).toContain('Ollama connection refused');
    expect(outcome.totalTurns).toBe(1);
  });
});

describe('AgentLoop — State Tracking', () => {
  it('tracks files modified', async () => {
    const provider = createMockProvider([
      toolCallResponse('Creating a file', [
        {
          id: 'tc-1',
          name: 'create_file',
          input: { path: 'src/new-module.ts', content: 'export const x = 1;\n' },
        },
      ]),
      doneResponse('File created.'),
    ]);

    const loop = createAgentLoop(defaultConfig, provider, toolkit, state);
    const outcome = await loop.run({ type: 'scheduled' });

    expect(outcome.filesModified).toContain('src/new-module.ts');
  });

  it('tracks issues filed', async () => {
    const provider = createMockProvider([
      toolCallResponse('Filing an issue', [
        {
          id: 'tc-1',
          name: 'file_issue',
          input: {
            title: 'Test problem',
            description: 'Something is wrong',
            priority: 'medium',
          },
        },
      ]),
      doneResponse('Issue filed.'),
    ]);

    const loop = createAgentLoop(defaultConfig, provider, toolkit, state);
    const outcome = await loop.run({ type: 'scheduled' });

    expect(outcome.issuesFiled).toContain('ISS-001');
  });

  it('tracks goals updated', async () => {
    state.goalStack.addGoal({
      source: 'user',
      description: 'Test goal',
    });

    const provider = createMockProvider([
      toolCallResponse('Updating goal', [
        {
          id: 'tc-1',
          name: 'update_goal',
          input: { goal_id: 'goal-001', status: 'in_progress', notes: 'Working on it' },
        },
      ]),
      doneResponse('Goal updated.'),
    ]);

    const loop = createAgentLoop(defaultConfig, provider, toolkit, state);
    const outcome = await loop.run({ type: 'scheduled' });

    expect(outcome.goalsUpdated).toContain('goal-001');
  });
});

describe('AgentLoop — Turn History', () => {
  it('records complete turn history', async () => {
    const provider = createMockProvider([
      toolCallResponse('First turn reasoning', [
        { id: 'tc-1', name: 'think', input: { reasoning: 'Let me plan.' } },
      ]),
      toolCallResponse('Second turn reasoning', [
        { id: 'tc-2', name: 'think', input: { reasoning: 'Now execute.' } },
      ]),
      doneResponse('All done.'),
    ]);

    const loop = createAgentLoop(defaultConfig, provider, toolkit, state);
    const outcome = await loop.run({ type: 'scheduled' });

    expect(outcome.turns).toHaveLength(3);

    // Turn 1: has tool call
    expect(outcome.turns[0]!.turnNumber).toBe(1);
    expect(outcome.turns[0]!.reasoning).toBe('First turn reasoning');
    expect(outcome.turns[0]!.toolCalls).toHaveLength(1);
    expect(outcome.turns[0]!.toolResults).toHaveLength(1);
    expect(outcome.turns[0]!.durationMs).toBeGreaterThanOrEqual(0);
    expect(outcome.turns[0]!.timestamp).toBeTruthy();

    // Turn 2: has tool call
    expect(outcome.turns[1]!.turnNumber).toBe(2);
    expect(outcome.turns[1]!.reasoning).toBe('Second turn reasoning');
    expect(outcome.turns[1]!.toolCalls).toHaveLength(1);

    // Turn 3: done (no tool calls)
    expect(outcome.turns[2]!.turnNumber).toBe(3);
    expect(outcome.turns[2]!.reasoning).toBe('All done.');
    expect(outcome.turns[2]!.toolCalls).toHaveLength(0);
  });
});

describe('AgentLoop — Factory', () => {
  it('createAgentLoop creates a working loop', async () => {
    const provider = createMockProvider([doneResponse('Factory test.')]);
    const loop = createAgentLoop(defaultConfig, provider, toolkit, state);

    expect(loop).toBeInstanceOf(AgentLoop);

    const outcome = await loop.run({ type: 'scheduled' });
    expect(outcome.success).toBe(true);
  });
});
