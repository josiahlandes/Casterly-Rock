import { describe, expect, it, beforeEach, vi } from 'vitest';
import { createDualLoopController } from '../src/dual-loop/dual-loop-controller.js';
import type { DualLoopControllerOptions } from '../src/dual-loop/dual-loop-controller.js';
import type { LlmProvider, GenerateRequest, GenerateWithToolsResponse } from '../src/providers/base.js';
import type { ToolSchema, ToolResultMessage } from '../src/tools/schemas/types.js';
import { ConcurrentProvider } from '../src/providers/concurrent.js';
import { EventBus } from '../src/autonomous/events.js';
import { GoalStack } from '../src/autonomous/goal-stack.js';
import { VoiceFilter } from '../src/imessage/voice-filter.js';
import { initTracer, resetTracer } from '../src/autonomous/debug.js';

// ─────────────────────────────────────────────────────────────────────────────
// Mocks
// ─────────────────────────────────────────────────────────────────────────────

function makeMockProvider(model: string): LlmProvider {
  return {
    id: 'test',
    kind: 'local',
    model,
    async generateWithTools(
      _request: GenerateRequest,
      _tools: ToolSchema[],
      _previousResults?: ToolResultMessage[],
    ): Promise<GenerateWithToolsResponse> {
      return {
        text: '{"classification":"simple","confidence":0.9,"triageNotes":"","directResponse":"Hello!"}',
        toolCalls: [],
        providerId: 'test',
        model,
        stopReason: 'end_turn',
      };
    },
  };
}

function makeMockVoiceFilter(): VoiceFilter {
  return new VoiceFilter({ enabled: false }); // Passthrough
}

function makeOptions(): DualLoopControllerOptions {
  const fastProvider = makeMockProvider('qwen3.5:35b-a3b');
  const deepProvider = makeMockProvider('qwen3.5:122b');

  return {
    fastProvider,
    deepProvider,
    concurrentProvider: new ConcurrentProvider(
      new Map([
        ['qwen3.5:122b', deepProvider],
        ['qwen3.5:35b-a3b', fastProvider],
      ]),
    ),
    eventBus: new EventBus({ maxQueueSize: 100, logEvents: false }),
    goalStack: new GoalStack(),
    voiceFilter: makeMockVoiceFilter(),
    sendMessageFn: vi.fn(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('DualLoopController', () => {
  beforeEach(() => {
    resetTracer();
    initTracer({ level: 'error', subsystems: {} });
  });

  describe('creation', () => {
    it('creates a controller that satisfies AutonomousController', () => {
      const controller = createDualLoopController(makeOptions());
      expect(controller).toBeDefined();
      expect(typeof controller.start).toBe('function');
      expect(typeof controller.stop).toBe('function');
      expect(typeof controller.interrupt).toBe('function');
      expect(typeof controller.tick).toBe('function');
      expect(typeof controller.getStatus).toBe('function');
      expect(typeof controller.getStatusReport).toBe('function');
      expect(typeof controller.getDailyReport).toBe('function');
      expect(typeof controller.getMorningSummary).toBe('function');
      expect(typeof controller.writeHandoff).toBe('function');
      expect(typeof controller.getHandoff).toBe('function');
      expect(typeof controller.runTriggeredCycle).toBe('function');
    });

    it('starts disabled and not busy', () => {
      const controller = createDualLoopController(makeOptions());
      expect(controller.enabled).toBe(false);
      expect(controller.busy).toBe(false);
    });
  });

  describe('getStatus', () => {
    it('returns initial status', () => {
      const controller = createDualLoopController(makeOptions());
      const status = controller.getStatus();

      expect(status.enabled).toBe(false);
      expect(status.busy).toBe(false);
      expect(status.totalCycles).toBe(0);
      expect(status.successfulCycles).toBe(0);
      expect(status.lastCycleAt).toBeNull();
      expect(status.nextCycleIn).toBe('disabled');
    });
  });

  describe('runTriggeredCycle', () => {
    it('returns a synthetic outcome for user triggers', async () => {
      const controller = createDualLoopController(makeOptions());
      const outcome = await controller.runTriggeredCycle({
        type: 'user',
        message: 'Fix the bug',
        sender: 'alice',
      });

      expect(outcome.success).toBe(true);
      expect(outcome.stopReason).toBe('completed');
      // User trigger summary is empty — real response delivered async via FastLoop
      expect(outcome.summary).toBe('');
      expect(outcome.trigger.type).toBe('user');
    });

    it('increments cycle counters', async () => {
      const controller = createDualLoopController(makeOptions());
      await controller.runTriggeredCycle({
        type: 'user',
        message: 'Hello',
        sender: 'bob',
      });

      const status = controller.getStatus();
      expect(status.totalCycles).toBe(1);
      expect(status.successfulCycles).toBe(1);
      expect(status.lastCycleAt).not.toBeNull();
    });

    it('handles event triggers', async () => {
      const controller = createDualLoopController(makeOptions());
      const outcome = await controller.runTriggeredCycle({
        type: 'event',
        event: {
          kind: 'test_failed',
          description: 'Test failed',
          timestamp: new Date().toISOString(),
        },
      });

      expect(outcome.success).toBe(true);
      expect(outcome.summary).toContain('coordinator');
    });

    it('handles scheduled triggers', async () => {
      const controller = createDualLoopController(makeOptions());
      const outcome = await controller.runTriggeredCycle({ type: 'scheduled' });

      expect(outcome.success).toBe(true);
      expect(outcome.totalTurns).toBe(0);
    });
  });

  describe('getStatusReport', () => {
    it('returns status info for status command', async () => {
      const controller = createDualLoopController(makeOptions());
      const report = await controller.getStatusReport('status');
      expect(report).toContain('Dual-loop');
      expect(report).toContain('FastLoop');
      expect(report).toContain('DeepLoop');
    });

    it('returns health info for health command', async () => {
      const controller = createDualLoopController(makeOptions());
      const report = await controller.getStatusReport('health');
      expect(report).toContain('Coordinator');
    });

    it('returns activity info for activity command', async () => {
      const controller = createDualLoopController(makeOptions());
      const report = await controller.getStatusReport('activity');
      expect(report).toContain('no active tasks');
    });

    it('returns help for unknown commands', async () => {
      const controller = createDualLoopController(makeOptions());
      const report = await controller.getStatusReport('xyz');
      expect(report).toContain('commands');
    });
  });

  describe('getDailyReport', () => {
    it('returns a report string', async () => {
      const controller = createDualLoopController(makeOptions());
      const report = await controller.getDailyReport();
      expect(report).toContain('Daily Report');
    });
  });

  describe('getMorningSummary', () => {
    it('returns a summary string', async () => {
      const controller = createDualLoopController(makeOptions());
      const summary = await controller.getMorningSummary();
      expect(summary).toContain('Good morning! Here is your overnight report:');
      expect(summary).toContain('FastLoop:');
      expect(summary).toContain('DeepLoop:');
      expect(summary).toContain('Tasks:');
    });
  });

  describe('getHandoff', () => {
    it('returns null or a valid HandoffState', async () => {
      const controller = createDualLoopController(makeOptions());
      const handoff = await controller.getHandoff();
      // If no handoff file exists, returns null.
      // If a real handoff file exists on disk (e.g. from daemon runs), returns a valid object.
      if (handoff === null) {
        expect(handoff).toBeNull();
      } else {
        expect(handoff).toHaveProperty('timestamp');
        expect(handoff).toHaveProperty('pendingBranches');
        expect(handoff).toHaveProperty('nightSummary');
      }
    });
  });

  describe('tick', () => {
    it('is a no-op (does not throw)', async () => {
      const controller = createDualLoopController(makeOptions());
      await expect(controller.tick()).resolves.toBeUndefined();
    });
  });

  describe('interrupt', () => {
    it('does not throw when not busy', async () => {
      const controller = createDualLoopController(makeOptions());
      await expect(controller.interrupt()).resolves.toBeUndefined();
    });
  });
});
