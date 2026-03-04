import { describe, expect, it, beforeEach, vi } from 'vitest';
import { FastLoop } from '../src/dual-loop/fast-loop.js';
import { createTaskBoard } from '../src/dual-loop/task-board.js';
import { EventBus } from '../src/autonomous/events.js';
import { initTracer, resetTracer } from '../src/autonomous/debug.js';
import type { LlmProvider, GenerateRequest, GenerateWithToolsResponse } from '../src/providers/base.js';
import type { ToolSchema, ToolResultMessage } from '../src/tools/schemas/types.js';

function makeProvider(textOrError: string | Error): LlmProvider {
  return {
    id: 'test',
    kind: 'local',
    model: 'qwen3.5:35b-a3b',
    async generateWithTools(
      _request: GenerateRequest,
      _tools: ToolSchema[],
      _previousResults?: ToolResultMessage[],
    ): Promise<GenerateWithToolsResponse> {
      if (textOrError instanceof Error) throw textOrError;
      return {
        text: textOrError,
        toolCalls: [],
        providerId: 'test',
        model: 'qwen3.5:35b-a3b',
        stopReason: 'end_turn',
      };
    },
  };
}

describe('FastLoop', () => {
  beforeEach(() => {
    resetTracer();
    initTracer({ level: 'error', subsystems: {} });
  });

  it('escalates to complex when triage times out', async () => {
    const hangingProvider: LlmProvider = {
      id: 'test',
      kind: 'local',
      model: 'qwen3.5:35b-a3b',
      async generateWithTools(): Promise<GenerateWithToolsResponse> {
        await new Promise(() => undefined);
        return {
          text: '',
          toolCalls: [],
          providerId: 'test',
          model: 'qwen3.5:35b-a3b',
          stopReason: 'end_turn',
        };
      },
    };

    const board = createTaskBoard({ dbPath: `/tmp/fast-loop-${Date.now()}.json` });
    const loop = new FastLoop(hangingProvider, board, new EventBus({ logEvents: false, maxQueueSize: 10 }), {
      triageTimeoutMs: 10,
      heartbeatMs: 1000,
      messageCoalesceMs: 1,
      maxConversationTokens: 1000,
      tiers: { compact: 4096, standard: 12288, extended: 24576, reviewLargeThresholdLines: 150 },
    });

    await loop.handleUserMessage('Please fix this', 'alice');
    const task = board.getActive()[0]!;
    expect(task.classification).toBe('complex');
    expect(task.triageNotes).toContain('Triage failed');
  });

  it('delivers completed task response', async () => {
    const provider = makeProvider('{}');
    const board = createTaskBoard({ dbPath: `/tmp/fast-loop-${Date.now()}.json` });
    const loop = new FastLoop(provider, board, new EventBus({ logEvents: false, maxQueueSize: 10 }));

    const delivered: string[] = [];
    loop.setDeliverFn(async (_sender, text) => { delivered.push(text); });

    const id = board.create({
      origin: 'user',
      priority: 0,
      sender: 'alice',
      originalMessage: 'Do something',
      classification: 'complex',
      status: 'done',
      userFacing: 'Here is the result',
    });

    await loop.deliverResponse(board.get(id)!);

    expect(delivered).toContain('Here is the result');
  });
});
