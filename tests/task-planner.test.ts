import { describe, expect, it, vi } from 'vitest';

import { createTaskPlan } from '../src/tasks/planner.js';
import type { LlmProvider } from '../src/providers/base.js';
import type { GenerateWithToolsResponse, ToolSchema } from '../src/tools/schemas/types.js';
import type { ExecutionRecord, TaskPlan } from '../src/tasks/types.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeMockProvider(response: GenerateWithToolsResponse): LlmProvider {
  return {
    id: 'test-provider',
    kind: 'local',
    model: 'test-model',
    generateWithTools: vi.fn().mockResolvedValue(response),
  };
}

function makePlanToolCall(input: Record<string, unknown>): GenerateWithToolsResponse {
  return {
    text: '',
    toolCalls: [
      {
        id: 'call-1',
        name: 'create_plan',
        input,
      },
    ],
    providerId: 'test-provider',
    model: 'test-model',
    stopReason: 'tool_use',
  };
}

const SAMPLE_TOOLS: ToolSchema[] = [
  {
    name: 'bash',
    description: 'Execute a bash command',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The command to run' },
      },
      required: ['command'],
    },
  },
  {
    name: 'read_file',
    description: 'Read a file',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path' },
      },
      required: ['path'],
    },
  },
];

function makeExecutionRecord(overrides: Partial<ExecutionRecord> = {}): ExecutionRecord {
  return {
    id: 'exec-1',
    timestamp: Date.now(),
    taskType: 'general',
    originalInstruction: 'Do something',
    plan: {
      goal: 'Test goal',
      completionCriteria: ['Done'],
      steps: [],
    },
    stepResults: [],
    overallSuccess: true,
    durationMs: 1000,
    retries: 0,
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// createTaskPlan
// ═══════════════════════════════════════════════════════════════════════════════

describe('createTaskPlan', () => {
  // ── Successful plan creation ───────────────────────────────────────────

  it('creates a plan from structured model response', async () => {
    const provider = makeMockProvider(
      makePlanToolCall({
        goal: 'List files in downloads',
        completionCriteria: ['Files listed', 'Output displayed'],
        steps: [
          {
            id: 'step-1',
            description: 'List files',
            tool: 'bash',
            input: { command: 'ls ~/Downloads' },
            dependsOn: [],
            verificationType: 'exit_code',
            verificationValue: '0',
          },
        ],
      })
    );

    const plan = await createTaskPlan('List my downloads', SAMPLE_TOOLS, [], provider);

    expect(plan.goal).toBe('List files in downloads');
    expect(plan.completionCriteria).toEqual(['Files listed', 'Output displayed']);
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]!.id).toBe('step-1');
    expect(plan.steps[0]!.tool).toBe('bash');
    expect(plan.steps[0]!.verification).toEqual({ type: 'exit_code', expect: 0 });
  });

  it('creates a multi-step plan with dependencies', async () => {
    const provider = makeMockProvider(
      makePlanToolCall({
        goal: 'Read and summarize a file',
        completionCriteria: ['File read', 'Summary generated'],
        steps: [
          {
            id: 'step-1',
            description: 'Read the file',
            tool: 'read_file',
            input: { path: '/tmp/test.txt' },
            dependsOn: [],
            verificationType: 'output_contains',
            verificationValue: 'content',
          },
          {
            id: 'step-2',
            description: 'Echo summary',
            tool: 'bash',
            input: { command: 'echo "summary"' },
            dependsOn: ['step-1'],
            verificationType: 'none',
          },
        ],
      })
    );

    const plan = await createTaskPlan('Read test.txt and summarize', SAMPLE_TOOLS, [], provider);

    expect(plan.steps).toHaveLength(2);
    expect(plan.steps[0]!.dependsOn).toEqual([]);
    expect(plan.steps[1]!.dependsOn).toEqual(['step-1']);
  });

  // ── Verification types ─────────────────────────────────────────────────

  it('parses exit_code verification', async () => {
    const provider = makeMockProvider(
      makePlanToolCall({
        goal: 'Test',
        completionCriteria: ['Done'],
        steps: [
          {
            id: 'step-1',
            description: 'Run command',
            tool: 'bash',
            dependsOn: [],
            verificationType: 'exit_code',
            verificationValue: '42',
          },
        ],
      })
    );

    const plan = await createTaskPlan('test', SAMPLE_TOOLS, [], provider);
    expect(plan.steps[0]!.verification).toEqual({ type: 'exit_code', expect: 42 });
  });

  it('parses file_exists verification', async () => {
    const provider = makeMockProvider(
      makePlanToolCall({
        goal: 'Test',
        completionCriteria: ['Done'],
        steps: [
          {
            id: 'step-1',
            description: 'Create file',
            tool: 'bash',
            dependsOn: [],
            verificationType: 'file_exists',
            verificationValue: '/tmp/output.txt',
          },
        ],
      })
    );

    const plan = await createTaskPlan('test', SAMPLE_TOOLS, [], provider);
    expect(plan.steps[0]!.verification).toEqual({ type: 'file_exists', path: '/tmp/output.txt' });
  });

  it('parses output_contains verification', async () => {
    const provider = makeMockProvider(
      makePlanToolCall({
        goal: 'Test',
        completionCriteria: ['Done'],
        steps: [
          {
            id: 'step-1',
            description: 'Check output',
            tool: 'bash',
            dependsOn: [],
            verificationType: 'output_contains',
            verificationValue: 'success',
          },
        ],
      })
    );

    const plan = await createTaskPlan('test', SAMPLE_TOOLS, [], provider);
    expect(plan.steps[0]!.verification).toEqual({ type: 'output_contains', substring: 'success' });
  });

  it('parses schema verification', async () => {
    const schema = { type: 'object', required: ['name'] };
    const provider = makeMockProvider(
      makePlanToolCall({
        goal: 'Test',
        completionCriteria: ['Done'],
        steps: [
          {
            id: 'step-1',
            description: 'Validate',
            tool: 'bash',
            dependsOn: [],
            verificationType: 'schema',
            verificationValue: JSON.stringify(schema),
          },
        ],
      })
    );

    const plan = await createTaskPlan('test', SAMPLE_TOOLS, [], provider);
    expect(plan.steps[0]!.verification).toEqual({ type: 'schema', jsonSchema: schema });
  });

  it('falls back to none when schema JSON is invalid', async () => {
    const provider = makeMockProvider(
      makePlanToolCall({
        goal: 'Test',
        completionCriteria: ['Done'],
        steps: [
          {
            id: 'step-1',
            description: 'Validate',
            tool: 'bash',
            dependsOn: [],
            verificationType: 'schema',
            verificationValue: 'not json',
          },
        ],
      })
    );

    const plan = await createTaskPlan('test', SAMPLE_TOOLS, [], provider);
    expect(plan.steps[0]!.verification).toEqual({ type: 'none' });
  });

  it('parses llm_judge verification', async () => {
    const provider = makeMockProvider(
      makePlanToolCall({
        goal: 'Test',
        completionCriteria: ['Done'],
        steps: [
          {
            id: 'step-1',
            description: 'Judge',
            tool: 'bash',
            dependsOn: [],
            verificationType: 'llm_judge',
            verificationValue: 'Was the output correct?',
          },
        ],
      })
    );

    const plan = await createTaskPlan('test', SAMPLE_TOOLS, [], provider);
    expect(plan.steps[0]!.verification).toEqual({
      type: 'llm_judge',
      prompt: 'Was the output correct?',
    });
  });

  it('defaults to none for unknown verification type', async () => {
    const provider = makeMockProvider(
      makePlanToolCall({
        goal: 'Test',
        completionCriteria: ['Done'],
        steps: [
          {
            id: 'step-1',
            description: 'Unknown',
            tool: 'bash',
            dependsOn: [],
            verificationType: 'magical_check',
          },
        ],
      })
    );

    const plan = await createTaskPlan('test', SAMPLE_TOOLS, [], provider);
    expect(plan.steps[0]!.verification).toEqual({ type: 'none' });
  });

  // ── Default values for steps ───────────────────────────────────────────

  it('assigns default id when missing', async () => {
    const provider = makeMockProvider(
      makePlanToolCall({
        goal: 'Test',
        completionCriteria: ['Done'],
        steps: [
          { description: 'Step without id', tool: 'bash', dependsOn: [] },
        ],
      })
    );

    const plan = await createTaskPlan('test', SAMPLE_TOOLS, [], provider);
    expect(plan.steps[0]!.id).toBe('step-1');
  });

  it('assigns default description when missing', async () => {
    const provider = makeMockProvider(
      makePlanToolCall({
        goal: 'Test',
        completionCriteria: ['Done'],
        steps: [
          { id: 'step-1', tool: 'bash', dependsOn: [] },
        ],
      })
    );

    const plan = await createTaskPlan('test', SAMPLE_TOOLS, [], provider);
    expect(plan.steps[0]!.description).toBe('Step 1');
  });

  it('assigns default tool when missing', async () => {
    const provider = makeMockProvider(
      makePlanToolCall({
        goal: 'Test',
        completionCriteria: ['Done'],
        steps: [
          { id: 'step-1', description: 'Do thing', dependsOn: [] },
        ],
      })
    );

    const plan = await createTaskPlan('test', SAMPLE_TOOLS, [], provider);
    expect(plan.steps[0]!.tool).toBe('bash');
  });

  // ── Dependency validation ──────────────────────────────────────────────

  it('filters out invalid dependency references', async () => {
    const provider = makeMockProvider(
      makePlanToolCall({
        goal: 'Test',
        completionCriteria: ['Done'],
        steps: [
          { id: 'step-1', description: 'First', tool: 'bash', dependsOn: [] },
          { id: 'step-2', description: 'Second', tool: 'bash', dependsOn: ['step-1', 'step-nonexistent'] },
        ],
      })
    );

    const plan = await createTaskPlan('test', SAMPLE_TOOLS, [], provider);
    expect(plan.steps[1]!.dependsOn).toEqual(['step-1']);
  });

  // ── No tool call fallback ──────────────────────────────────────────────

  it('creates fallback plan when model does not call tool', async () => {
    const provider = makeMockProvider({
      text: 'I think you should just do this manually.',
      toolCalls: [],
      providerId: 'test-provider',
      model: 'test-model',
      stopReason: 'end_turn',
    });

    const plan = await createTaskPlan('Organize my files', SAMPLE_TOOLS, [], provider);

    expect(plan.goal).toBe('Organize my files');
    expect(plan.completionCriteria).toEqual(['Task completed successfully']);
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]!.tool).toBe('bash');
    expect(plan.steps[0]!.verification).toEqual({ type: 'none' });
  });

  it('truncates long instructions in fallback plan goal', async () => {
    const provider = makeMockProvider({
      text: 'No plan.',
      toolCalls: [],
      providerId: 'test-provider',
      model: 'test-model',
      stopReason: 'end_turn',
    });

    const longInstruction = 'a'.repeat(300);
    const plan = await createTaskPlan(longInstruction, SAMPLE_TOOLS, [], provider);

    expect(plan.goal.length).toBeLessThanOrEqual(200);
  });

  // ── Null fields in response ────────────────────────────────────────────

  it('returns fallback when goal is missing', async () => {
    const provider = makeMockProvider(
      makePlanToolCall({
        completionCriteria: ['Done'],
        steps: [{ id: 'step-1', tool: 'bash', dependsOn: [] }],
      })
    );

    const plan = await createTaskPlan('test', SAMPLE_TOOLS, [], provider);
    // Falls back because goal is missing
    expect(plan.completionCriteria).toEqual(['Task completed successfully']);
  });

  it('returns fallback when steps array is empty', async () => {
    const provider = makeMockProvider(
      makePlanToolCall({
        goal: 'Test',
        completionCriteria: ['Done'],
        steps: [],
      })
    );

    const plan = await createTaskPlan('test', SAMPLE_TOOLS, [], provider);
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]!.tool).toBe('bash');
  });

  // ── Error fallback ─────────────────────────────────────────────────────

  it('creates error plan on provider error', async () => {
    const provider: LlmProvider = {
      id: 'test-provider',
      kind: 'local',
      model: 'test-model',
      generateWithTools: vi.fn().mockRejectedValue(new Error('GPU out of memory')),
    };

    const plan = await createTaskPlan('Do something', SAMPLE_TOOLS, [], provider);

    expect(plan.goal).toBe('Do something');
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]!.description).toContain('GPU out of memory');
  });

  // ── Execution history ──────────────────────────────────────────────────

  it('includes execution history in system prompt', async () => {
    const provider = makeMockProvider(
      makePlanToolCall({
        goal: 'Test',
        completionCriteria: ['Done'],
        steps: [{ id: 'step-1', tool: 'bash', dependsOn: [] }],
      })
    );

    const history = [
      makeExecutionRecord({
        taskType: 'file_operation',
        overallSuccess: true,
        durationMs: 2000,
      }),
      makeExecutionRecord({
        taskType: 'calendar',
        overallSuccess: false,
        stepResults: [
          {
            stepId: 'step-1',
            tool: 'bash',
            success: false,
            retries: 1,
            failureReason: 'Permission denied',
            durationMs: 500,
          },
        ],
      }),
    ];

    await createTaskPlan('Do something', SAMPLE_TOOLS, history, provider);

    const call = vi.mocked(provider.generateWithTools).mock.calls[0]!;
    const systemPrompt = call[0].systemPrompt!;

    expect(systemPrompt).toContain('file_operation');
    expect(systemPrompt).toContain('succeeded');
    expect(systemPrompt).toContain('calendar');
    expect(systemPrompt).toContain('failed');
    expect(systemPrompt).toContain('Permission denied');
  });

  it('includes available tools in system prompt', async () => {
    const provider = makeMockProvider(
      makePlanToolCall({
        goal: 'Test',
        completionCriteria: ['Done'],
        steps: [{ id: 'step-1', tool: 'bash', dependsOn: [] }],
      })
    );

    await createTaskPlan('Do something', SAMPLE_TOOLS, [], provider);

    const call = vi.mocked(provider.generateWithTools).mock.calls[0]!;
    const systemPrompt = call[0].systemPrompt!;

    expect(systemPrompt).toContain('bash');
    expect(systemPrompt).toContain('Execute a bash command');
    expect(systemPrompt).toContain('read_file');
    expect(systemPrompt).toContain('Read a file');
  });

  it('passes correct tools to provider', async () => {
    const provider = makeMockProvider(
      makePlanToolCall({
        goal: 'Test',
        completionCriteria: ['Done'],
        steps: [{ id: 'step-1', tool: 'bash', dependsOn: [] }],
      })
    );

    await createTaskPlan('Do something', SAMPLE_TOOLS, [], provider);

    const call = vi.mocked(provider.generateWithTools).mock.calls[0]!;
    const tools = call[1];

    expect(tools).toHaveLength(1);
    expect(tools[0]!.name).toBe('create_plan');
  });

  // ── Filters non-string completion criteria ─────────────────────────────

  it('filters non-string completion criteria', async () => {
    const provider = makeMockProvider(
      makePlanToolCall({
        goal: 'Test',
        completionCriteria: ['Valid criterion', 123, null, 'Another valid one'],
        steps: [{ id: 'step-1', tool: 'bash', dependsOn: [] }],
      })
    );

    const plan = await createTaskPlan('test', SAMPLE_TOOLS, [], provider);
    expect(plan.completionCriteria).toEqual(['Valid criterion', 'Another valid one']);
  });
});
