import { describe, expect, it, vi } from 'vitest';

import { verifyStepOutcome, verifyTaskOutcome } from '../src/tasks/verifier.js';
import type { TaskStep, TaskPlan, StepOutcome } from '../src/tasks/types.js';
import type { NativeToolResult, GenerateWithToolsResponse } from '../src/tools/schemas/types.js';
import type { LlmProvider } from '../src/providers/base.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeStep(overrides: Partial<TaskStep> = {}): TaskStep {
  return {
    id: 'step-1',
    description: 'Test step',
    tool: 'bash',
    input: { command: 'echo hello' },
    dependsOn: [],
    verification: { type: 'none' },
    ...overrides,
  };
}

function makeToolResult(overrides: Partial<NativeToolResult> = {}): NativeToolResult {
  return {
    toolCallId: 'call-1',
    success: true,
    output: 'hello',
    ...overrides,
  };
}

function makeMockProvider(response: GenerateWithToolsResponse): LlmProvider {
  return {
    id: 'test-provider',
    kind: 'local',
    model: 'test-model',
    generateWithTools: vi.fn().mockResolvedValue(response),
  };
}

function makePlan(overrides: Partial<TaskPlan> = {}): TaskPlan {
  return {
    goal: 'Test task',
    completionCriteria: ['Step completes successfully'],
    steps: [makeStep()],
    ...overrides,
  };
}

function makeOutcome(overrides: Partial<StepOutcome> = {}): StepOutcome {
  return {
    stepId: 'step-1',
    tool: 'bash',
    success: true,
    retries: 0,
    durationMs: 100,
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// verifyStepOutcome
// ═══════════════════════════════════════════════════════════════════════════════

describe('verifyStepOutcome', () => {
  // ── type: none ─────────────────────────────────────────────────────────

  it('always passes for verification type "none"', async () => {
    const step = makeStep({ verification: { type: 'none' } });
    const result = await verifyStepOutcome(step, makeToolResult());

    expect(result.verified).toBe(true);
    expect(result.reason).toContain('No verification required');
  });

  // ── type: exit_code ────────────────────────────────────────────────────

  it('passes when exit code matches expected', async () => {
    const step = makeStep({ verification: { type: 'exit_code', expect: 0 } });
    const result = await verifyStepOutcome(step, makeToolResult({ exitCode: 0 }));

    expect(result.verified).toBe(true);
    expect(result.reason).toContain('matches expected');
  });

  it('fails when exit code does not match expected', async () => {
    const step = makeStep({ verification: { type: 'exit_code', expect: 0 } });
    const result = await verifyStepOutcome(step, makeToolResult({ exitCode: 1 }));

    expect(result.verified).toBe(false);
    expect(result.reason).toContain('does not match');
  });

  it('falls back to success flag when exit code is undefined (success)', async () => {
    const step = makeStep({ verification: { type: 'exit_code', expect: 0 } });
    const result = await verifyStepOutcome(
      step,
      makeToolResult({ exitCode: undefined, success: true })
    );

    expect(result.verified).toBe(true);
    expect(result.reason).toContain('no exit code reported');
  });

  it('falls back to success flag when exit code is undefined (failure)', async () => {
    const step = makeStep({ verification: { type: 'exit_code', expect: 0 } });
    const result = await verifyStepOutcome(
      step,
      makeToolResult({ exitCode: undefined, success: false })
    );

    expect(result.verified).toBe(false);
    expect(result.reason).toContain('failed');
  });

  // ── type: file_exists ──────────────────────────────────────────────────

  it('passes when file exists', async () => {
    // Use a file we know exists — the test file itself
    const step = makeStep({
      verification: { type: 'file_exists', path: import.meta.filename },
    });
    const result = await verifyStepOutcome(step, makeToolResult());

    expect(result.verified).toBe(true);
    expect(result.reason).toContain('File exists');
  });

  it('fails when file does not exist', async () => {
    const step = makeStep({
      verification: { type: 'file_exists', path: '/tmp/casterly-nonexistent-file-xyz.txt' },
    });
    const result = await verifyStepOutcome(step, makeToolResult());

    expect(result.verified).toBe(false);
    expect(result.reason).toContain('File not found');
  });

  // ── type: output_contains ──────────────────────────────────────────────

  it('passes when output contains substring', async () => {
    const step = makeStep({
      verification: { type: 'output_contains', substring: 'hello' },
    });
    const result = await verifyStepOutcome(
      step,
      makeToolResult({ output: 'hello world' })
    );

    expect(result.verified).toBe(true);
    expect(result.reason).toContain('contains');
  });

  it('fails when output does not contain substring', async () => {
    const step = makeStep({
      verification: { type: 'output_contains', substring: 'goodbye' },
    });
    const result = await verifyStepOutcome(
      step,
      makeToolResult({ output: 'hello world' })
    );

    expect(result.verified).toBe(false);
    expect(result.reason).toContain('does not contain');
  });

  it('fails when output is undefined', async () => {
    const step = makeStep({
      verification: { type: 'output_contains', substring: 'hello' },
    });
    const result = await verifyStepOutcome(
      step,
      makeToolResult({ output: undefined })
    );

    expect(result.verified).toBe(false);
    expect(result.reason).toContain('No output');
  });

  it('truncates long substring in reason message', async () => {
    const longSubstring = 'a'.repeat(100);
    const step = makeStep({
      verification: { type: 'output_contains', substring: longSubstring },
    });
    const result = await verifyStepOutcome(
      step,
      makeToolResult({ output: longSubstring + ' more' })
    );

    expect(result.verified).toBe(true);
    // Reason should truncate the substring to 50 chars
    expect(result.reason.length).toBeLessThan(200);
  });

  // ── type: schema ───────────────────────────────────────────────────────

  it('passes when output matches schema', async () => {
    const step = makeStep({
      verification: {
        type: 'schema',
        jsonSchema: {
          type: 'object',
          required: ['name', 'age'],
          properties: {
            name: { type: 'string' },
            age: { type: 'number' },
          },
        },
      },
    });
    const result = await verifyStepOutcome(
      step,
      makeToolResult({ output: JSON.stringify({ name: 'Alice', age: 30 }) })
    );

    expect(result.verified).toBe(true);
    expect(result.reason).toContain('matches schema');
  });

  it('fails when required field is missing', async () => {
    const step = makeStep({
      verification: {
        type: 'schema',
        jsonSchema: {
          type: 'object',
          required: ['name', 'age'],
          properties: {
            name: { type: 'string' },
            age: { type: 'number' },
          },
        },
      },
    });
    const result = await verifyStepOutcome(
      step,
      makeToolResult({ output: JSON.stringify({ name: 'Alice' }) })
    );

    expect(result.verified).toBe(false);
    expect(result.reason).toContain('Missing required field');
    expect(result.reason).toContain('age');
  });

  it('fails when field type is wrong', async () => {
    const step = makeStep({
      verification: {
        type: 'schema',
        jsonSchema: {
          type: 'object',
          properties: {
            age: { type: 'number' },
          },
        },
      },
    });
    const result = await verifyStepOutcome(
      step,
      makeToolResult({ output: JSON.stringify({ age: 'thirty' }) })
    );

    expect(result.verified).toBe(false);
    expect(result.reason).toContain('age');
    expect(result.reason).toContain('string');
    expect(result.reason).toContain('number');
  });

  it('validates integer type', async () => {
    const step = makeStep({
      verification: {
        type: 'schema',
        jsonSchema: {
          type: 'object',
          properties: {
            count: { type: 'integer' },
          },
        },
      },
    });

    // Integer passes
    const pass = await verifyStepOutcome(
      step,
      makeToolResult({ output: JSON.stringify({ count: 5 }) })
    );
    expect(pass.verified).toBe(true);

    // Float fails
    const fail = await verifyStepOutcome(
      step,
      makeToolResult({ output: JSON.stringify({ count: 5.5 }) })
    );
    expect(fail.verified).toBe(false);
    expect(fail.reason).toContain('integer');
  });

  it('validates array type', async () => {
    const step = makeStep({
      verification: {
        type: 'schema',
        jsonSchema: {
          type: 'object',
          properties: {
            items: { type: 'array' },
          },
        },
      },
    });
    const result = await verifyStepOutcome(
      step,
      makeToolResult({ output: JSON.stringify({ items: [1, 2, 3] }) })
    );

    expect(result.verified).toBe(true);
  });

  it('fails when output is not valid JSON', async () => {
    const step = makeStep({
      verification: {
        type: 'schema',
        jsonSchema: { type: 'object', required: ['x'] },
      },
    });
    const result = await verifyStepOutcome(
      step,
      makeToolResult({ output: 'not json' })
    );

    expect(result.verified).toBe(false);
    expect(result.reason).toContain('not valid JSON');
  });

  it('fails when output is undefined for schema verification', async () => {
    const step = makeStep({
      verification: {
        type: 'schema',
        jsonSchema: { type: 'object' },
      },
    });
    const result = await verifyStepOutcome(
      step,
      makeToolResult({ output: undefined })
    );

    expect(result.verified).toBe(false);
    expect(result.reason).toContain('No output');
  });

  it('passes schema with no required or properties', async () => {
    const step = makeStep({
      verification: {
        type: 'schema',
        jsonSchema: { type: 'object' },
      },
    });
    const result = await verifyStepOutcome(
      step,
      makeToolResult({ output: '{}' })
    );

    expect(result.verified).toBe(true);
  });

  // ── type: llm_judge ────────────────────────────────────────────────────

  it('defers llm_judge to task-level verification', async () => {
    const step = makeStep({
      verification: { type: 'llm_judge', prompt: 'Did it work?' },
    });
    const result = await verifyStepOutcome(step, makeToolResult());

    expect(result.verified).toBe(true);
    expect(result.reason).toContain('deferred');
  });

  // ── Unknown type ───────────────────────────────────────────────────────

  it('passes for unknown verification type', async () => {
    const step = makeStep({
      verification: { type: 'none' },
    });
    // Hack: force an unknown type
    (step.verification as { type: string }).type = 'unknown_type';

    const result = await verifyStepOutcome(step, makeToolResult());

    expect(result.verified).toBe(true);
    expect(result.reason).toContain('Unknown verification type');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// verifyTaskOutcome
// ═══════════════════════════════════════════════════════════════════════════════

describe('verifyTaskOutcome', () => {
  // ── Successful verification ────────────────────────────────────────────

  it('returns verified=true when model verifies success', async () => {
    const provider = makeMockProvider({
      text: '',
      toolCalls: [
        {
          id: 'call-1',
          name: 'verify_task',
          input: {
            verified: true,
            reason: 'All criteria met',
          },
        },
      ],
      providerId: 'test-provider',
      model: 'test-model',
      stopReason: 'tool_use',
    });

    const plan = makePlan();
    const outcomes = [makeOutcome()];

    const result = await verifyTaskOutcome(plan, outcomes, provider);

    expect(result.verified).toBe(true);
    expect(result.reason).toContain('All criteria met');
  });

  it('returns verified=false when model finds unmet criteria', async () => {
    const provider = makeMockProvider({
      text: '',
      toolCalls: [
        {
          id: 'call-1',
          name: 'verify_task',
          input: {
            verified: false,
            reason: 'Not all criteria met',
            unmetCriteria: ['File was not created', 'Output missing'],
          },
        },
      ],
      providerId: 'test-provider',
      model: 'test-model',
      stopReason: 'tool_use',
    });

    const plan = makePlan();
    const outcomes = [makeOutcome()];

    const result = await verifyTaskOutcome(plan, outcomes, provider);

    expect(result.verified).toBe(false);
    expect(result.reason).toContain('Not all criteria met');
    expect(result.reason).toContain('File was not created');
    expect(result.reason).toContain('Output missing');
  });

  // ── No tool call fallback ──────────────────────────────────────────────

  it('falls back to step-level check when model does not call tool (all succeeded)', async () => {
    const provider = makeMockProvider({
      text: 'Everything looks good.',
      toolCalls: [],
      providerId: 'test-provider',
      model: 'test-model',
      stopReason: 'end_turn',
    });

    const plan = makePlan();
    const outcomes = [makeOutcome({ success: true })];

    const result = await verifyTaskOutcome(plan, outcomes, provider);

    expect(result.verified).toBe(true);
    expect(result.reason).toContain('All steps succeeded');
  });

  it('falls back to step-level check when model does not call tool (some failed)', async () => {
    const provider = makeMockProvider({
      text: 'Something went wrong.',
      toolCalls: [],
      providerId: 'test-provider',
      model: 'test-model',
      stopReason: 'end_turn',
    });

    const plan = makePlan();
    const outcomes = [makeOutcome({ success: false })];

    const result = await verifyTaskOutcome(plan, outcomes, provider);

    expect(result.verified).toBe(false);
    expect(result.reason).toContain('steps failed');
  });

  // ── Wrong tool name fallback ───────────────────────────────────────────

  it('falls back when model calls wrong tool', async () => {
    const provider = makeMockProvider({
      text: '',
      toolCalls: [
        {
          id: 'call-1',
          name: 'wrong_tool',
          input: { verified: true },
        },
      ],
      providerId: 'test-provider',
      model: 'test-model',
      stopReason: 'tool_use',
    });

    const plan = makePlan();
    const outcomes = [makeOutcome({ success: true })];

    const result = await verifyTaskOutcome(plan, outcomes, provider);

    expect(result.verified).toBe(true);
    expect(result.reason).toContain('All steps succeeded');
  });

  // ── Invalid response ───────────────────────────────────────────────────

  it('falls back when verified is not a boolean', async () => {
    const provider = makeMockProvider({
      text: '',
      toolCalls: [
        {
          id: 'call-1',
          name: 'verify_task',
          input: { verified: 'yes', reason: 'ok' },
        },
      ],
      providerId: 'test-provider',
      model: 'test-model',
      stopReason: 'tool_use',
    });

    const plan = makePlan();
    const outcomes = [makeOutcome({ success: true })];

    const result = await verifyTaskOutcome(plan, outcomes, provider);

    // Falls back to step-level check
    expect(result.verified).toBe(true);
  });

  // ── Error fallback ─────────────────────────────────────────────────────

  it('falls back to step-level check on provider error (steps succeeded)', async () => {
    const provider: LlmProvider = {
      id: 'test-provider',
      kind: 'local',
      model: 'test-model',
      generateWithTools: vi.fn().mockRejectedValue(new Error('Timeout')),
    };

    const plan = makePlan();
    const outcomes = [makeOutcome({ success: true })];

    const result = await verifyTaskOutcome(plan, outcomes, provider);

    expect(result.verified).toBe(true);
    expect(result.reason).toContain('Timeout');
  });

  it('falls back to step-level check on provider error (steps failed)', async () => {
    const provider: LlmProvider = {
      id: 'test-provider',
      kind: 'local',
      model: 'test-model',
      generateWithTools: vi.fn().mockRejectedValue(new Error('OOM')),
    };

    const plan = makePlan();
    const outcomes = [makeOutcome({ success: false })];

    const result = await verifyTaskOutcome(plan, outcomes, provider);

    expect(result.verified).toBe(false);
    expect(result.reason).toContain('OOM');
  });

  // ── Context building ───────────────────────────────────────────────────

  it('includes plan goal and criteria in prompt', async () => {
    const provider = makeMockProvider({
      text: '',
      toolCalls: [
        {
          id: 'call-1',
          name: 'verify_task',
          input: { verified: true, reason: 'All good' },
        },
      ],
      providerId: 'test-provider',
      model: 'test-model',
      stopReason: 'tool_use',
    });

    const plan = makePlan({
      goal: 'Organize downloads folder',
      completionCriteria: ['Files sorted', 'Old files zipped'],
    });
    const outcomes = [makeOutcome()];

    await verifyTaskOutcome(plan, outcomes, provider);

    const call = vi.mocked(provider.generateWithTools).mock.calls[0]!;
    const prompt = call[0].prompt;

    expect(prompt).toContain('Organize downloads folder');
    expect(prompt).toContain('Files sorted');
    expect(prompt).toContain('Old files zipped');
  });

  it('includes step outcomes in prompt', async () => {
    const provider = makeMockProvider({
      text: '',
      toolCalls: [
        {
          id: 'call-1',
          name: 'verify_task',
          input: { verified: true, reason: 'Good' },
        },
      ],
      providerId: 'test-provider',
      model: 'test-model',
      stopReason: 'tool_use',
    });

    const plan = makePlan();
    const outcomes = [
      makeOutcome({ stepId: 'step-1', tool: 'bash', success: true }),
      makeOutcome({ stepId: 'step-2', tool: 'read_file', success: false, failureReason: 'Not found' }),
    ];

    await verifyTaskOutcome(plan, outcomes, provider);

    const call = vi.mocked(provider.generateWithTools).mock.calls[0]!;
    const prompt = call[0].prompt;

    expect(prompt).toContain('step-1');
    expect(prompt).toContain('OK');
    expect(prompt).toContain('step-2');
    expect(prompt).toContain('FAILED');
    expect(prompt).toContain('Not found');
  });
});
