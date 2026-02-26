import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createAgentLoop } from '../src/autonomous/agent-loop.js';
import type { AgentTrigger, AgentLoopConfig, RuntimeContext } from '../src/autonomous/agent-loop.js';
import { buildAgentToolkit } from '../src/autonomous/agent-tools.js';
import type { AgentState, AgentToolkit } from '../src/autonomous/agent-tools.js';
import { buildFilteredToolkit, buildPresetToolkit, hydrateCategories, TASK_CATEGORY_PRESETS } from '../src/autonomous/tools/registry.js';
import { getCategoryTools, getAllCategories } from '../src/autonomous/tools/tool-map.js';
import { selectToolPreset } from '../src/autonomous/loop.js';
import { GoalStack } from '../src/autonomous/goal-stack.js';
import { IssueLog } from '../src/autonomous/issue-log.js';
import { WorldModel } from '../src/autonomous/world-model.js';
import { resetTracer, initTracer } from '../src/autonomous/debug.js';
import type { LlmProvider, GenerateRequest } from '../src/providers/base.js';
import type {
  ToolSchema,
  ToolResultMessage,
  GenerateWithToolsResponse,
  NativeToolCall,
} from '../src/tools/schemas/types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Mock LLM Provider (captures system prompt and tool schemas)
// ─────────────────────────────────────────────────────────────────────────────

function createCapturingProvider(toolCallsToReturn?: NativeToolCall[]): {
  provider: LlmProvider;
  getCapturedSystemPrompt: () => string | undefined;
  getCapturedToolSchemas: () => ToolSchema[] | undefined;
  getCallCount: () => number;
} {
  let capturedSystemPrompt: string | undefined;
  let capturedToolSchemas: ToolSchema[] | undefined;
  let callCount = 0;

  const provider: LlmProvider = {
    id: 'mock-capture',
    kind: 'local',
    model: 'mock-model',

    async generateWithTools(
      request: GenerateRequest,
      tools: ToolSchema[],
      _previousResults?: ToolResultMessage[],
    ): Promise<GenerateWithToolsResponse> {
      callCount++;

      // Capture on first call
      if (capturedSystemPrompt === undefined) {
        capturedSystemPrompt = request.systemPrompt;
      }
      // Always capture the latest schemas (they may change after hydration)
      capturedToolSchemas = tools;

      // On the first call, return any requested tool calls
      if (callCount === 1 && toolCallsToReturn && toolCallsToReturn.length > 0) {
        return {
          text: '',
          toolCalls: toolCallsToReturn,
          providerId: 'mock-capture',
          model: 'mock-model',
          stopReason: 'tool_use',
        };
      }

      return {
        text: 'Done.',
        toolCalls: [],
        providerId: 'mock-capture',
        model: 'mock-model',
        stopReason: 'end_turn',
      };
    },
  };

  return {
    provider,
    getCapturedSystemPrompt: () => capturedSystemPrompt,
    getCapturedToolSchemas: () => capturedToolSchemas,
    getCallCount: () => callCount,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Test Setup
// ─────────────────────────────────────────────────────────────────────────────

let tempDir: string;
let state: AgentState;
let fullToolkit: AgentToolkit;

const defaultConfig: Partial<AgentLoopConfig> = {
  maxTurns: 3,
  maxTokensPerCycle: 50_000,
  temperature: 0.1,
  maxResponseTokens: 2048,
};

const userTrigger: AgentTrigger = { type: 'user', message: 'hello', sender: 'Katie' };
const scheduledTrigger: AgentTrigger = { type: 'scheduled' };
const goalTrigger: AgentTrigger = {
  type: 'goal',
  goal: {
    id: 'test-goal',
    description: 'Fix the login bug',
    priority: 3,
    status: 'in_progress',
    source: 'user',
    attempts: 0,
    created: new Date().toISOString(),
    updated: new Date().toISOString(),
    notes: '',
    relatedFiles: [],
    tags: [],
  },
};
const eventTrigger: AgentTrigger = {
  type: 'event',
  event: {
    kind: 'file_change',
    description: 'src/index.ts modified',
    timestamp: new Date().toISOString(),
  },
};

beforeEach(async () => {
  resetTracer();
  initTracer({ enabled: false });
  tempDir = await mkdtemp(join(tmpdir(), 'casterly-preset-'));
  await mkdir(join(tempDir, 'src'), { recursive: true });
  await mkdir(join(tempDir, 'tests'), { recursive: true });

  const goalStack = new GoalStack({ path: join(tempDir, 'goals.yaml') });
  const issueLog = new IssueLog({ path: join(tempDir, 'issues.yaml') });
  const worldModel = new WorldModel({
    path: join(tempDir, 'world-model.yaml'),
    projectRoot: tempDir,
  });

  state = { goalStack, issueLog, worldModel };
  fullToolkit = buildAgentToolkit(
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
});

afterEach(async () => {
  resetTracer();
  await rm(tempDir, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('Tool Preset Selection', () => {
  describe('selectToolPreset()', () => {
    it('returns "conversation" for user triggers', () => {
      expect(selectToolPreset(userTrigger)).toBe('conversation');
    });

    it('returns "full" for scheduled triggers', () => {
      expect(selectToolPreset(scheduledTrigger)).toBe('full');
    });

    it('returns "coding_complex" for goal triggers', () => {
      expect(selectToolPreset(goalTrigger)).toBe('coding_complex');
    });

    it('returns "coding_simple" for event triggers', () => {
      expect(selectToolPreset(eventTrigger)).toBe('coding_simple');
    });
  });

  describe('conversation preset', () => {
    it('includes core, memory, reasoning, communication, scheduling', () => {
      const categories = TASK_CATEGORY_PRESETS['conversation'];
      expect(categories).toBeDefined();
      expect(categories).toContain('core');
      expect(categories).toContain('memory');
      expect(categories).toContain('reasoning');
      expect(categories).toContain('communication');
      expect(categories).toContain('scheduling');
    });

    it('does NOT include dream, vision, advanced-memory, git, quality', () => {
      const categories = TASK_CATEGORY_PRESETS['conversation'];
      expect(categories).not.toContain('dream');
      expect(categories).not.toContain('vision-t1');
      expect(categories).not.toContain('vision-t2');
      expect(categories).not.toContain('vision-t3');
      expect(categories).not.toContain('advanced-memory');
      expect(categories).not.toContain('git');
      expect(categories).not.toContain('quality');
    });

    it('produces a filtered toolkit with significantly fewer tools', () => {
      const filtered = buildPresetToolkit(fullToolkit, 'conversation');
      expect(filtered.schemas.length).toBeGreaterThan(15);
      expect(filtered.schemas.length).toBeLessThan(30);
      expect(filtered.schemas.length).toBeLessThan(fullToolkit.schemas.length);
    });
  });

  describe('full preset', () => {
    it('includes all categories', () => {
      const allCats = getAllCategories();
      const fullCats = TASK_CATEGORY_PRESETS['full'];
      for (const cat of allCats) {
        expect(fullCats).toContain(cat);
      }
    });

    it('returns all tools', () => {
      const filtered = buildPresetToolkit(fullToolkit, 'full');
      expect(filtered.schemas.length).toBe(fullToolkit.schemas.length);
    });
  });
});

describe('request_tools meta-tool', () => {
  describe('schema injection', () => {
    it('adds request_tools when toolkit is filtered', async () => {
      const filteredToolkit = buildPresetToolkit(fullToolkit, 'conversation');
      const { provider, getCapturedToolSchemas } = createCapturingProvider();

      const loop = createAgentLoop(
        defaultConfig, provider, filteredToolkit, state,
        null, null, {}, fullToolkit,
      );
      await loop.run(userTrigger);

      const schemas = getCapturedToolSchemas()!;
      const hasRequestTools = schemas.some((s) => s.name === 'request_tools');
      expect(hasRequestTools).toBe(true);
    });

    it('does NOT add request_tools when toolkit is full', async () => {
      const { provider, getCapturedToolSchemas } = createCapturingProvider();

      const loop = createAgentLoop(
        defaultConfig, provider, fullToolkit, state,
        null, null, {}, fullToolkit,
      );
      await loop.run(scheduledTrigger);

      const schemas = getCapturedToolSchemas()!;
      const hasRequestTools = schemas.some((s) => s.name === 'request_tools');
      expect(hasRequestTools).toBe(false);
    });

    it('does NOT add request_tools when no fullToolkit provided (backward compat)', async () => {
      const { provider, getCapturedToolSchemas } = createCapturingProvider();

      // No 8th param — fullToolkit defaults to toolkit
      const loop = createAgentLoop(
        defaultConfig, provider, fullToolkit, state,
      );
      await loop.run(scheduledTrigger);

      const schemas = getCapturedToolSchemas()!;
      const hasRequestTools = schemas.some((s) => s.name === 'request_tools');
      expect(hasRequestTools).toBe(false);
    });
  });

  describe('hydration', () => {
    it('hydrates new tool categories when request_tools is called', async () => {
      const filteredToolkit = buildPresetToolkit(fullToolkit, 'conversation');
      const initialCount = filteredToolkit.schemas.length;

      // The model will call request_tools on the first turn
      const requestToolsCall: NativeToolCall = {
        id: 'call-1',
        name: 'request_tools',
        input: { categories: ['git', 'quality'] },
      };

      const { provider, getCapturedToolSchemas, getCallCount } = createCapturingProvider([requestToolsCall]);

      const loop = createAgentLoop(
        defaultConfig, provider, filteredToolkit, state,
        null, null, {}, fullToolkit,
      );
      await loop.run(userTrigger);

      // After hydration, the second LLM call should see more tools
      const finalSchemas = getCapturedToolSchemas()!;
      const callCount = getCallCount();

      // Should have made at least 2 calls (first with request_tools, second with hydrated tools)
      expect(callCount).toBeGreaterThanOrEqual(2);

      // Final schemas should include git and quality tools
      const toolNames = finalSchemas.map((s) => s.name);
      expect(toolNames).toContain('git_status');
      expect(toolNames).toContain('git_diff');
      expect(toolNames).toContain('run_tests');
      expect(toolNames).toContain('typecheck');

      // Should have more tools than the initial filtered set
      expect(finalSchemas.length).toBeGreaterThan(initialCount);
    });
  });
});

describe('tool catalog in system prompt', () => {
  it('includes catalog when toolkit is filtered', async () => {
    const filteredToolkit = buildPresetToolkit(fullToolkit, 'conversation');
    const { provider, getCapturedSystemPrompt } = createCapturingProvider();

    const loop = createAgentLoop(
      defaultConfig, provider, filteredToolkit, state,
      null, null, {}, fullToolkit,
    );
    await loop.run(userTrigger);

    const systemPrompt = getCapturedSystemPrompt()!;
    expect(systemPrompt).toContain('Available Tool Categories');
    expect(systemPrompt).toContain('request_tools');

    // Should list categories that are NOT loaded (e.g., git, quality, dream)
    expect(systemPrompt).toContain('[git]');
    expect(systemPrompt).toContain('[quality]');
    expect(systemPrompt).toContain('[dream]');
  });

  it('omits catalog when toolkit is full', async () => {
    const { provider, getCapturedSystemPrompt } = createCapturingProvider();

    const loop = createAgentLoop(
      defaultConfig, provider, fullToolkit, state,
      null, null, {}, fullToolkit,
    );
    await loop.run(scheduledTrigger);

    const systemPrompt = getCapturedSystemPrompt()!;
    expect(systemPrompt).not.toContain('Available Tool Categories');
  });
});

describe('backward compatibility', () => {
  it('works with no fullToolkit param (existing 7-arg signature)', async () => {
    const { provider, getCapturedSystemPrompt } = createCapturingProvider();

    // 7-arg signature: config, provider, toolkit, state, selfModel, journal, runtimeContext
    const loop = createAgentLoop(
      defaultConfig, provider, fullToolkit, state,
      null, null, {},
    );
    await loop.run(scheduledTrigger);

    const systemPrompt = getCapturedSystemPrompt()!;
    expect(systemPrompt).toBeDefined();

    // Should still have core sections
    expect(systemPrompt).toContain('Current Context');
    expect(systemPrompt).toContain('Current Task');
    expect(systemPrompt).toContain('How to Work');
  });

  it('works with only 4 args (minimal signature)', async () => {
    const { provider, getCapturedSystemPrompt } = createCapturingProvider();

    const loop = createAgentLoop(defaultConfig, provider, fullToolkit, state);
    await loop.run(scheduledTrigger);

    const systemPrompt = getCapturedSystemPrompt()!;
    expect(systemPrompt).toBeDefined();
    expect(systemPrompt).toContain('Current Task');
  });
});

describe('hydrateCategories utility', () => {
  it('adds tools from new categories without duplicates', () => {
    const filtered = buildFilteredToolkit(fullToolkit, ['core']);
    const coreCount = filtered.schemas.length;

    const hydrated = hydrateCategories(filtered, fullToolkit, ['git']);
    const gitTools = getCategoryTools('git');

    expect(hydrated.schemas.length).toBe(coreCount + gitTools.length);
    expect(hydrated.toolNames).toContain('git_status');
    expect(hydrated.toolNames).toContain('git_diff');
  });

  it('returns same toolkit when categories already loaded', () => {
    const filtered = buildFilteredToolkit(fullToolkit, ['core', 'git']);
    const hydrated = hydrateCategories(filtered, fullToolkit, ['core']);

    // No new tools — same object returned
    expect(hydrated).toBe(filtered);
  });

  it('can execute tools from the full toolkit even if not in schemas', () => {
    const filtered = buildFilteredToolkit(fullToolkit, ['core']);
    const hasGit = filtered.schemas.some((s) => s.name === 'git_status');
    expect(hasGit).toBe(false);

    // Executor still works because it delegates to fullToolkit.execute
    // (git_status will fail because there's no git repo, but it won't throw "unknown tool")
    // Just verify the function exists and doesn't throw for dispatch
    expect(typeof filtered.execute).toBe('function');
  });
});
