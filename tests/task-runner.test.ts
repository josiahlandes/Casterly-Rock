import { describe, expect, it, vi } from 'vitest';

import { runTaskPlan } from '../src/tasks/runner.js';
import type { TaskPlan, TaskStep } from '../src/tasks/types.js';
import type { ToolOrchestrator } from '../src/tools/orchestrator.js';
import type { NativeToolCall, NativeToolResult } from '../src/tools/schemas/types.js';

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

function makePlan(steps: TaskStep[]): TaskPlan {
  return {
    goal: 'Test plan',
    completionCriteria: ['All steps complete'],
    steps,
  };
}

function makeMockOrchestrator(
  handler?: (call: NativeToolCall) => Promise<NativeToolResult>
): ToolOrchestrator {
  const defaultHandler = async (call: NativeToolCall): Promise<NativeToolResult> => ({
    toolCallId: call.id,
    success: true,
    output: 'ok',
  });

  return {
    registerExecutor: vi.fn(),
    canExecute: vi.fn().mockReturnValue(true),
    execute: vi.fn().mockImplementation(handler ?? defaultHandler),
    executeAll: vi.fn(),
    getRegisteredTools: vi.fn().mockReturnValue(['bash']),
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// runTaskPlan
// ═══════════════════════════════════════════════════════════════════════════════

describe('runTaskPlan', () => {
  // ── Single step ────────────────────────────────────────────────────────

  it('executes a single step successfully', async () => {
    const orchestrator = makeMockOrchestrator();
    const plan = makePlan([makeStep()]);

    const result = await runTaskPlan(plan, { orchestrator });

    expect(result.overallSuccess).toBe(true);
    expect(result.stepOutcomes).toHaveLength(1);
    expect(result.stepOutcomes[0]!.success).toBe(true);
    expect(result.stepOutcomes[0]!.stepId).toBe('step-1');
    expect(result.stepOutcomes[0]!.tool).toBe('bash');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  // ── Multiple independent steps ─────────────────────────────────────────

  it('executes multiple independent steps', async () => {
    const orchestrator = makeMockOrchestrator();
    const plan = makePlan([
      makeStep({ id: 'step-1' }),
      makeStep({ id: 'step-2' }),
      makeStep({ id: 'step-3' }),
    ]);

    const result = await runTaskPlan(plan, { orchestrator });

    expect(result.overallSuccess).toBe(true);
    expect(result.stepOutcomes).toHaveLength(3);
    expect(result.stepOutcomes.every((o) => o.success)).toBe(true);
  });

  // ── Sequential dependencies ────────────────────────────────────────────

  it('respects dependency ordering', async () => {
    const executionOrder: string[] = [];
    const orchestrator = makeMockOrchestrator(async (call: NativeToolCall) => {
      executionOrder.push(call.id.split('-attempt')[0]!);
      return { toolCallId: call.id, success: true, output: 'ok' };
    });

    const plan = makePlan([
      makeStep({ id: 'step-1', dependsOn: [] }),
      makeStep({ id: 'step-2', dependsOn: ['step-1'] }),
      makeStep({ id: 'step-3', dependsOn: ['step-2'] }),
    ]);

    const result = await runTaskPlan(plan, { orchestrator, maxConcurrency: 1 });

    expect(result.overallSuccess).toBe(true);
    expect(executionOrder).toEqual(['step-1', 'step-2', 'step-3']);
  });

  // ── Failed step skips dependents ───────────────────────────────────────

  it('skips dependent steps when a dependency fails', async () => {
    const orchestrator = makeMockOrchestrator(async (call: NativeToolCall) => {
      const stepId = call.id.split('-attempt')[0]!;
      if (stepId === 'step-1') {
        return { toolCallId: call.id, success: false, error: 'Failed' };
      }
      return { toolCallId: call.id, success: true, output: 'ok' };
    });

    const plan = makePlan([
      makeStep({ id: 'step-1', dependsOn: [] }),
      makeStep({ id: 'step-2', dependsOn: ['step-1'] }),
      makeStep({ id: 'step-3', dependsOn: ['step-1'] }),
    ]);

    const result = await runTaskPlan(plan, { orchestrator, maxRetries: 0 });

    expect(result.overallSuccess).toBe(false);
    expect(result.stepOutcomes[0]!.success).toBe(false);
    expect(result.stepOutcomes[1]!.success).toBe(false);
    expect(result.stepOutcomes[1]!.failureReason).toContain('dependency failed');
    expect(result.stepOutcomes[2]!.success).toBe(false);
    expect(result.stepOutcomes[2]!.failureReason).toContain('dependency failed');
  });

  it('skips transitive dependents on failure', async () => {
    const orchestrator = makeMockOrchestrator(async (call: NativeToolCall) => {
      const stepId = call.id.split('-attempt')[0]!;
      if (stepId === 'step-1') {
        return { toolCallId: call.id, success: false, error: 'Failed' };
      }
      return { toolCallId: call.id, success: true, output: 'ok' };
    });

    const plan = makePlan([
      makeStep({ id: 'step-1', dependsOn: [] }),
      makeStep({ id: 'step-2', dependsOn: ['step-1'] }),
      makeStep({ id: 'step-3', dependsOn: ['step-2'] }),
    ]);

    const result = await runTaskPlan(plan, { orchestrator, maxRetries: 0 });

    expect(result.overallSuccess).toBe(false);
    // step-1 failed, step-2 and step-3 should be skipped
    expect(result.stepOutcomes[0]!.success).toBe(false);
    expect(result.stepOutcomes[1]!.failureReason).toContain('dependency failed');
    expect(result.stepOutcomes[2]!.failureReason).toContain('dependency failed');
  });

  // ── Independent steps still run when one fails ─────────────────────────

  it('still runs independent steps when one branch fails', async () => {
    const orchestrator = makeMockOrchestrator(async (call: NativeToolCall) => {
      const stepId = call.id.split('-attempt')[0]!;
      if (stepId === 'step-1') {
        return { toolCallId: call.id, success: false, error: 'Failed' };
      }
      return { toolCallId: call.id, success: true, output: 'ok' };
    });

    const plan = makePlan([
      makeStep({ id: 'step-1', dependsOn: [] }),
      makeStep({ id: 'step-2', dependsOn: [] }), // independent of step-1
      makeStep({ id: 'step-3', dependsOn: ['step-1'] }), // depends on step-1
    ]);

    const result = await runTaskPlan(plan, { orchestrator, maxRetries: 0 });

    expect(result.overallSuccess).toBe(false);
    expect(result.stepOutcomes[0]!.success).toBe(false); // step-1 failed
    expect(result.stepOutcomes[1]!.success).toBe(true);  // step-2 independent
    expect(result.stepOutcomes[2]!.success).toBe(false); // step-3 skipped
  });

  // ── Retry logic ────────────────────────────────────────────────────────

  it('retries failed steps up to maxRetries', async () => {
    let callCount = 0;
    const orchestrator = makeMockOrchestrator(async (call: NativeToolCall) => {
      callCount++;
      if (callCount < 3) {
        return { toolCallId: call.id, success: false, error: `Attempt ${callCount}` };
      }
      return { toolCallId: call.id, success: true, output: 'ok' };
    });

    const plan = makePlan([makeStep()]);

    const result = await runTaskPlan(plan, { orchestrator, maxRetries: 2 });

    expect(result.overallSuccess).toBe(true);
    expect(result.stepOutcomes[0]!.retries).toBe(2);
    expect(callCount).toBe(3); // original + 2 retries
  });

  it('fails after exhausting retries', async () => {
    const orchestrator = makeMockOrchestrator(async (call: NativeToolCall) => ({
      toolCallId: call.id,
      success: false,
      error: 'Always fails',
    }));

    const plan = makePlan([makeStep()]);

    const result = await runTaskPlan(plan, { orchestrator, maxRetries: 2 });

    expect(result.overallSuccess).toBe(false);
    expect(result.stepOutcomes[0]!.success).toBe(false);
    expect(result.stepOutcomes[0]!.retries).toBe(2);
    expect(result.stepOutcomes[0]!.failureReason).toBe('Always fails');
  });

  // ── Verification integration ───────────────────────────────────────────

  it('fails step when verification fails despite tool success', async () => {
    const orchestrator = makeMockOrchestrator(async (call: NativeToolCall) => ({
      toolCallId: call.id,
      success: true,
      output: 'wrong output',
    }));

    const plan = makePlan([
      makeStep({
        verification: { type: 'output_contains', substring: 'expected' },
      }),
    ]);

    const result = await runTaskPlan(plan, { orchestrator, maxRetries: 0 });

    expect(result.overallSuccess).toBe(false);
    expect(result.stepOutcomes[0]!.success).toBe(false);
    expect(result.stepOutcomes[0]!.failureReason).toContain('Verification failed');
  });

  it('passes step when verification succeeds', async () => {
    const orchestrator = makeMockOrchestrator(async (call: NativeToolCall) => ({
      toolCallId: call.id,
      success: true,
      output: 'expected output here',
    }));

    const plan = makePlan([
      makeStep({
        verification: { type: 'output_contains', substring: 'expected' },
      }),
    ]);

    const result = await runTaskPlan(plan, { orchestrator, maxRetries: 0 });

    expect(result.overallSuccess).toBe(true);
  });

  // ── Concurrency ────────────────────────────────────────────────────────

  it('limits concurrency with semaphore', async () => {
    let currentConcurrent = 0;
    let maxConcurrent = 0;

    const orchestrator = makeMockOrchestrator(async (call: NativeToolCall) => {
      currentConcurrent++;
      maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
      // Small delay to allow overlap
      await new Promise((r) => setTimeout(r, 20));
      currentConcurrent--;
      return { toolCallId: call.id, success: true, output: 'ok' };
    });

    const plan = makePlan([
      makeStep({ id: 'step-1' }),
      makeStep({ id: 'step-2' }),
      makeStep({ id: 'step-3' }),
      makeStep({ id: 'step-4' }),
    ]);

    await runTaskPlan(plan, { orchestrator, maxConcurrency: 2 });

    expect(maxConcurrent).toBeLessThanOrEqual(2);
  });

  // ── Deadlock detection ─────────────────────────────────────────────────

  it('handles deadlock when remaining steps have unsatisfied deps', async () => {
    // step-2 depends on step-1, step-1 depends on step-2 → circular
    // This shouldn't happen in practice, but the runner should handle it
    const orchestrator = makeMockOrchestrator();

    const plan = makePlan([
      makeStep({ id: 'step-1', dependsOn: ['step-2'] }),
      makeStep({ id: 'step-2', dependsOn: ['step-1'] }),
    ]);

    const result = await runTaskPlan(plan, { orchestrator });

    expect(result.overallSuccess).toBe(false);
    // Both steps should be marked as failed due to unresolvable dependency
    expect(result.stepOutcomes[0]!.success).toBe(false);
    expect(result.stepOutcomes[0]!.failureReason).toContain('unresolvable');
    expect(result.stepOutcomes[1]!.success).toBe(false);
  });

  // ── Callback ───────────────────────────────────────────────────────────

  it('calls onStepComplete callback for each step', async () => {
    const orchestrator = makeMockOrchestrator();
    const completedSteps: string[] = [];

    const plan = makePlan([
      makeStep({ id: 'step-1' }),
      makeStep({ id: 'step-2' }),
    ]);

    await runTaskPlan(plan, {
      orchestrator,
      onStepComplete: (stepId) => {
        completedSteps.push(stepId);
      },
    });

    expect(completedSteps).toContain('step-1');
    expect(completedSteps).toContain('step-2');
  });

  it('calls onStepComplete for skipped steps', async () => {
    const orchestrator = makeMockOrchestrator(async (call: NativeToolCall) => {
      const stepId = call.id.split('-attempt')[0]!;
      if (stepId === 'step-1') {
        return { toolCallId: call.id, success: false, error: 'Failed' };
      }
      return { toolCallId: call.id, success: true, output: 'ok' };
    });

    const completedSteps: string[] = [];

    const plan = makePlan([
      makeStep({ id: 'step-1', dependsOn: [] }),
      makeStep({ id: 'step-2', dependsOn: ['step-1'] }),
    ]);

    await runTaskPlan(plan, {
      orchestrator,
      maxRetries: 0,
      onStepComplete: (stepId) => {
        completedSteps.push(stepId);
      },
    });

    expect(completedSteps).toContain('step-1');
    expect(completedSteps).toContain('step-2');
  });

  // ── Duration tracking ──────────────────────────────────────────────────

  it('tracks duration for individual steps', async () => {
    const orchestrator = makeMockOrchestrator(async (call: NativeToolCall) => {
      await new Promise((r) => setTimeout(r, 10));
      return { toolCallId: call.id, success: true, output: 'ok' };
    });

    const plan = makePlan([makeStep()]);

    const result = await runTaskPlan(plan, { orchestrator });

    expect(result.stepOutcomes[0]!.durationMs).toBeGreaterThanOrEqual(10);
  });

  it('tracks total duration', async () => {
    const orchestrator = makeMockOrchestrator(async (call: NativeToolCall) => {
      await new Promise((r) => setTimeout(r, 10));
      return { toolCallId: call.id, success: true, output: 'ok' };
    });

    const plan = makePlan([makeStep()]);

    const result = await runTaskPlan(plan, { orchestrator });

    expect(result.durationMs).toBeGreaterThanOrEqual(10);
  });

  // ── Empty plan ─────────────────────────────────────────────────────────

  it('handles empty plan', async () => {
    const orchestrator = makeMockOrchestrator();
    const plan = makePlan([]);

    const result = await runTaskPlan(plan, { orchestrator });

    expect(result.overallSuccess).toBe(true);
    expect(result.stepOutcomes).toHaveLength(0);
  });

  // ── Diamond dependency graph ───────────────────────────────────────────

  it('handles diamond dependency pattern (A → B,C → D)', async () => {
    const executionOrder: string[] = [];
    const orchestrator = makeMockOrchestrator(async (call: NativeToolCall) => {
      const stepId = call.id.split('-attempt')[0]!;
      executionOrder.push(stepId);
      return { toolCallId: call.id, success: true, output: 'ok' };
    });

    const plan = makePlan([
      makeStep({ id: 'A', dependsOn: [] }),
      makeStep({ id: 'B', dependsOn: ['A'] }),
      makeStep({ id: 'C', dependsOn: ['A'] }),
      makeStep({ id: 'D', dependsOn: ['B', 'C'] }),
    ]);

    const result = await runTaskPlan(plan, { orchestrator, maxConcurrency: 2 });

    expect(result.overallSuccess).toBe(true);
    // A must come first
    expect(executionOrder[0]!).toBe('A');
    // D must come last
    expect(executionOrder[executionOrder.length - 1]).toBe('D');
    // B and C can be in any order
    expect(executionOrder.slice(1, 3).sort()).toEqual(['B', 'C']);
  });

  // ── Output capture ─────────────────────────────────────────────────────

  it('captures step output', async () => {
    const orchestrator = makeMockOrchestrator(async (call: NativeToolCall) => ({
      toolCallId: call.id,
      success: true,
      output: 'step output data',
    }));

    const plan = makePlan([makeStep()]);

    const result = await runTaskPlan(plan, { orchestrator });

    expect(result.stepOutcomes[0]!.output).toBe('step output data');
  });

  // ── Plan reference preserved ───────────────────────────────────────────

  it('includes the original plan in the result', async () => {
    const orchestrator = makeMockOrchestrator();
    const plan = makePlan([makeStep()]);

    const result = await runTaskPlan(plan, { orchestrator });

    expect(result.plan).toBe(plan);
  });
});
