import { describe, expect, it, vi } from 'vitest';

import { createTaskManager } from '../src/tasks/manager.js';
import type { LlmProvider } from '../src/providers/base.js';
import type { ToolOrchestrator } from '../src/tools/orchestrator.js';
import type { ExecutionLog } from '../src/tasks/execution-log.js';
import type {
  GenerateWithToolsResponse,
  NativeToolCall,
  NativeToolResult,
  ToolSchema,
} from '../src/tools/schemas/types.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Build a mock LlmProvider that responds differently to each tool call.
 * The classifier, planner, and verifier each expect different tool names.
 */
function makeMockProvider(overrides: {
  classifyAs?: 'conversation' | 'simple_task' | 'complex_task';
  planGoal?: string;
  planSteps?: Array<Record<string, unknown>>;
  verifyResult?: boolean;
  throwOnCall?: number;
} = {}): LlmProvider {
  const {
    classifyAs = 'simple_task',
    planGoal = 'Test goal',
    planSteps = [
      {
        id: 'step-1',
        description: 'Run command',
        tool: 'bash',
        input: { command: 'echo hello' },
        dependsOn: [],
        verificationType: 'none',
      },
    ],
    verifyResult = true,
    throwOnCall,
  } = overrides;

  let callIndex = 0;

  return {
    id: 'test-provider',
    kind: 'local',
    model: 'test-model',
    generateWithTools: vi.fn().mockImplementation(
      async (_request: unknown, tools: ToolSchema[]): Promise<GenerateWithToolsResponse> => {
        callIndex++;

        if (throwOnCall && callIndex === throwOnCall) {
          throw new Error('Provider error');
        }

        const toolName = tools[0]?.name;

        if (toolName === 'classify_message') {
          return {
            text: '',
            toolCalls: [
              {
                id: 'classify-call',
                name: 'classify_message',
                input: {
                  taskClass: classifyAs,
                  confidence: 0.9,
                  reason: `Classified as ${classifyAs}`,
                  taskType: 'general',
                },
              },
            ],
            providerId: 'test-provider',
            model: 'test-model',
            stopReason: 'tool_use',
          };
        }

        if (toolName === 'create_plan') {
          return {
            text: '',
            toolCalls: [
              {
                id: 'plan-call',
                name: 'create_plan',
                input: {
                  goal: planGoal,
                  completionCriteria: ['Task done'],
                  steps: planSteps,
                },
              },
            ],
            providerId: 'test-provider',
            model: 'test-model',
            stopReason: 'tool_use',
          };
        }

        if (toolName === 'verify_task') {
          return {
            text: '',
            toolCalls: [
              {
                id: 'verify-call',
                name: 'verify_task',
                input: {
                  verified: verifyResult,
                  reason: verifyResult ? 'All criteria met' : 'Criteria not met',
                },
              },
            ],
            providerId: 'test-provider',
            model: 'test-model',
            stopReason: 'tool_use',
          };
        }

        // Fallback
        return {
          text: 'Unknown tool',
          toolCalls: [],
          providerId: 'test-provider',
          model: 'test-model',
          stopReason: 'end_turn',
        };
      }
    ),
  };
}

function makeMockOrchestrator(
  handler?: (call: NativeToolCall) => Promise<NativeToolResult>
): ToolOrchestrator {
  const defaultHandler = async (call: NativeToolCall): Promise<NativeToolResult> => ({
    toolCallId: call.id,
    success: true,
    output: 'done',
  });

  return {
    registerExecutor: vi.fn(),
    canExecute: vi.fn().mockReturnValue(true),
    execute: vi.fn().mockImplementation(handler ?? defaultHandler),
    executeAll: vi.fn(),
    getRegisteredTools: vi.fn().mockReturnValue(['bash']),
  };
}

function makeMockExecutionLog(): ExecutionLog {
  const records: unknown[] = [];
  return {
    append: vi.fn().mockImplementation((record) => records.push(record)),
    queryByType: vi.fn().mockReturnValue([]),
    queryByTool: vi.fn().mockReturnValue([]),
    getRecent: vi.fn().mockReturnValue([]),
    getToolReliability: vi.fn().mockReturnValue({
      toolName: 'bash',
      successRate: 1,
      totalCalls: 0,
      totalFailures: 0,
      commonFailureReasons: [],
    }),
    getTaskTypes: vi.fn().mockReturnValue([]),
    count: vi.fn().mockReturnValue(0),
    compact: vi.fn().mockReturnValue(0),
  };
}

const SAMPLE_TOOLS: ToolSchema[] = [
  {
    name: 'bash',
    description: 'Run bash command',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
];

// ═══════════════════════════════════════════════════════════════════════════════
// createTaskManager
// ═══════════════════════════════════════════════════════════════════════════════

describe('createTaskManager', () => {
  // ── Conversation classification ────────────────────────────────────────

  it('returns empty response for conversation classification', async () => {
    const provider = makeMockProvider({ classifyAs: 'conversation' });
    const orchestrator = makeMockOrchestrator();
    const executionLog = makeMockExecutionLog();

    const manager = createTaskManager({
      orchestrator,
      executionLog,
      availableTools: SAMPLE_TOOLS,
    });

    const result = await manager.handle('Hello there!', [], provider);

    expect(result.classification.taskClass).toBe('conversation');
    expect(result.response).toBe('');
    expect(result.taskResult).toBeUndefined();
    // Should not call planner, runner, or verifier
    expect(orchestrator.execute).not.toHaveBeenCalled();
  });

  // ── Simple task: full pipeline ─────────────────────────────────────────

  it('runs full pipeline for simple_task classification', async () => {
    const provider = makeMockProvider({ classifyAs: 'simple_task' });
    const orchestrator = makeMockOrchestrator();
    const executionLog = makeMockExecutionLog();

    const manager = createTaskManager({
      orchestrator,
      executionLog,
      availableTools: SAMPLE_TOOLS,
    });

    const result = await manager.handle('Check the time', [], provider);

    expect(result.classification.taskClass).toBe('simple_task');
    expect(result.response).toContain('Done');
    expect(result.taskResult).toBeDefined();
    expect(result.taskResult!.overallSuccess).toBe(true);
    // Execution log should have been updated
    expect(executionLog.append).toHaveBeenCalledTimes(1);
  });

  // ── Complex task: full pipeline ────────────────────────────────────────

  it('runs full pipeline for complex_task classification', async () => {
    const provider = makeMockProvider({ classifyAs: 'complex_task' });
    const orchestrator = makeMockOrchestrator();
    const executionLog = makeMockExecutionLog();

    const manager = createTaskManager({
      orchestrator,
      executionLog,
      availableTools: SAMPLE_TOOLS,
    });

    const result = await manager.handle('Organize my downloads', [], provider);

    expect(result.classification.taskClass).toBe('complex_task');
    expect(result.response).toContain('Done');
    expect(result.taskResult!.overallSuccess).toBe(true);
  });

  // ── Failed task ────────────────────────────────────────────────────────

  it('reports failures in response when steps fail', async () => {
    const provider = makeMockProvider({ classifyAs: 'simple_task', verifyResult: false });
    const orchestrator = makeMockOrchestrator(async (call: NativeToolCall) => ({
      toolCallId: call.id,
      success: false,
      error: 'Command not found',
    }));
    const executionLog = makeMockExecutionLog();

    const manager = createTaskManager({
      orchestrator,
      executionLog,
      availableTools: SAMPLE_TOOLS,
      maxRetries: 0,
    });

    const result = await manager.handle('Run nonexistent command', [], provider);

    expect(result.response).toContain('issues');
    expect(result.taskResult!.overallSuccess).toBe(false);
    // Execution log records the failure
    expect(executionLog.append).toHaveBeenCalledTimes(1);
    const record = vi.mocked(executionLog.append).mock.calls[0]![0];
    expect(record.overallSuccess).toBe(false);
  });

  // ── Execution record fields ────────────────────────────────────────────

  it('creates proper execution record with all fields', async () => {
    const provider = makeMockProvider({ classifyAs: 'simple_task' });
    const orchestrator = makeMockOrchestrator();
    const executionLog = makeMockExecutionLog();

    const manager = createTaskManager({
      orchestrator,
      executionLog,
      availableTools: SAMPLE_TOOLS,
    });

    await manager.handle('Check something', [], provider);

    expect(executionLog.append).toHaveBeenCalledTimes(1);
    const record = vi.mocked(executionLog.append).mock.calls[0]![0];

    expect(record.id).toMatch(/^exec-/);
    expect(record.timestamp).toBeGreaterThan(0);
    expect(record.taskType).toBe('general');
    expect(record.originalInstruction).toBeDefined();
    expect(record.plan).toBeDefined();
    expect(record.stepResults).toBeDefined();
    expect(typeof record.overallSuccess).toBe('boolean');
    expect(record.durationMs).toBeGreaterThanOrEqual(0);
    expect(typeof record.retries).toBe('number');
  });

  // ── Instruction redaction ──────────────────────────────────────────────

  it('truncates long instructions in execution record', async () => {
    const provider = makeMockProvider({ classifyAs: 'simple_task' });
    const orchestrator = makeMockOrchestrator();
    const executionLog = makeMockExecutionLog();

    const manager = createTaskManager({
      orchestrator,
      executionLog,
      availableTools: SAMPLE_TOOLS,
    });

    const longMessage = 'a'.repeat(200);
    await manager.handle(longMessage, [], provider);

    const record = vi.mocked(executionLog.append).mock.calls[0]![0];
    expect(record.originalInstruction.length).toBeLessThan(200);
    expect(record.originalInstruction).toContain('[truncated]');
  });

  it('preserves short instructions as-is', async () => {
    const provider = makeMockProvider({ classifyAs: 'simple_task' });
    const orchestrator = makeMockOrchestrator();
    const executionLog = makeMockExecutionLog();

    const manager = createTaskManager({
      orchestrator,
      executionLog,
      availableTools: SAMPLE_TOOLS,
    });

    await manager.handle('Short message', [], provider);

    const record = vi.mocked(executionLog.append).mock.calls[0]![0];
    expect(record.originalInstruction).toBe('Short message');
  });

  // ── Queries execution history for planner ──────────────────────────────

  it('queries execution history for the classified task type', async () => {
    const provider = makeMockProvider({ classifyAs: 'simple_task' });
    const orchestrator = makeMockOrchestrator();
    const executionLog = makeMockExecutionLog();

    const manager = createTaskManager({
      orchestrator,
      executionLog,
      availableTools: SAMPLE_TOOLS,
    });

    await manager.handle('Do something', [], provider);

    expect(executionLog.queryByType).toHaveBeenCalledWith('general', 5);
  });

  // ── Verification skipped on failure ────────────────────────────────────

  it('skips LLM verification when steps failed', async () => {
    const provider = makeMockProvider({ classifyAs: 'simple_task' });
    const orchestrator = makeMockOrchestrator(async (call: NativeToolCall) => ({
      toolCallId: call.id,
      success: false,
      error: 'Failed',
    }));
    const executionLog = makeMockExecutionLog();

    const manager = createTaskManager({
      orchestrator,
      executionLog,
      availableTools: SAMPLE_TOOLS,
      maxRetries: 0,
    });

    await manager.handle('Do failing thing', [], provider);

    // Provider should be called for classify + plan only (not verify)
    // The verifier is skipped when steps fail
    const calls = vi.mocked(provider.generateWithTools).mock.calls;
    const toolNames = calls.map((c) => (c[1] as ToolSchema[])[0]?.name);
    expect(toolNames).not.toContain('verify_task');
  });

  // ── Response building ──────────────────────────────────────────────────

  it('includes step count in response for multi-step plans', async () => {
    const provider = makeMockProvider({
      classifyAs: 'complex_task',
      planSteps: [
        { id: 'step-1', description: 'First', tool: 'bash', dependsOn: [] },
        { id: 'step-2', description: 'Second', tool: 'bash', dependsOn: ['step-1'] },
        { id: 'step-3', description: 'Third', tool: 'bash', dependsOn: ['step-2'] },
      ],
    });
    const orchestrator = makeMockOrchestrator();
    const executionLog = makeMockExecutionLog();

    const manager = createTaskManager({
      orchestrator,
      executionLog,
      availableTools: SAMPLE_TOOLS,
    });

    const result = await manager.handle('Do multi-step thing', [], provider);

    expect(result.response).toContain('3/3');
  });

  it('includes failure details in response', async () => {
    const provider = makeMockProvider({
      classifyAs: 'simple_task',
      planSteps: [
        { id: 'step-1', description: 'Failing step', tool: 'bash', dependsOn: [] },
      ],
    });
    const orchestrator = makeMockOrchestrator(async (call: NativeToolCall) => ({
      toolCallId: call.id,
      success: false,
      error: 'Permission denied',
    }));
    const executionLog = makeMockExecutionLog();

    const manager = createTaskManager({
      orchestrator,
      executionLog,
      availableTools: SAMPLE_TOOLS,
      maxRetries: 0,
    });

    const result = await manager.handle('Run privileged command', [], provider);

    expect(result.response).toContain('issues');
    expect(result.response).toContain('Permission denied');
  });

  // ── onStepComplete callback ────────────────────────────────────────────

  it('passes onStepComplete callback through to runner', async () => {
    const provider = makeMockProvider({ classifyAs: 'simple_task' });
    const orchestrator = makeMockOrchestrator();
    const executionLog = makeMockExecutionLog();
    const completedSteps: string[] = [];

    const manager = createTaskManager({
      orchestrator,
      executionLog,
      availableTools: SAMPLE_TOOLS,
      onStepComplete: (stepId) => completedSteps.push(stepId),
    });

    await manager.handle('Do something', [], provider);

    expect(completedSteps).toContain('step-1');
  });

  // ── Verification error handling ────────────────────────────────────────

  it('continues with step-level result when verification throws', async () => {
    // Override: make the provider throw on the 3rd call (verification)
    const provider = makeMockProvider({
      classifyAs: 'simple_task',
      throwOnCall: 3,
    });
    const orchestrator = makeMockOrchestrator();
    const executionLog = makeMockExecutionLog();

    const manager = createTaskManager({
      orchestrator,
      executionLog,
      availableTools: SAMPLE_TOOLS,
    });

    const result = await manager.handle('Do something', [], provider);

    // Should still produce a result (fallback to step-level success)
    expect(result.response).toBeDefined();
    expect(result.taskResult).toBeDefined();
  });
});
