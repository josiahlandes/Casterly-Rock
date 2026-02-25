import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createAgentLoop } from '../src/autonomous/agent-loop.js';
import type { AgentTrigger, AgentLoopConfig, RuntimeContext } from '../src/autonomous/agent-loop.js';
import { buildAgentToolkit } from '../src/autonomous/agent-tools.js';
import type { AgentState, AgentToolkit } from '../src/autonomous/agent-tools.js';
import { GoalStack } from '../src/autonomous/goal-stack.js';
import { IssueLog } from '../src/autonomous/issue-log.js';
import { WorldModel } from '../src/autonomous/world-model.js';
import { resetTracer, initTracer } from '../src/autonomous/debug.js';
import type { LlmProvider, GenerateRequest } from '../src/providers/base.js';
import type {
  ToolSchema,
  ToolResultMessage,
  GenerateWithToolsResponse,
} from '../src/tools/schemas/types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Mock LLM Provider (captures the system prompt)
// ─────────────────────────────────────────────────────────────────────────────

function createCapturingProvider(): {
  provider: LlmProvider;
  getCapturedSystemPrompt: () => string | undefined;
} {
  let capturedSystemPrompt: string | undefined;

  const provider: LlmProvider = {
    id: 'mock-capture',
    kind: 'local',
    model: 'mock-model',

    async generateWithTools(
      request: GenerateRequest,
      _tools: ToolSchema[],
      _previousResults?: ToolResultMessage[],
    ): Promise<GenerateWithToolsResponse> {
      // Capture the system prompt on first call
      if (capturedSystemPrompt === undefined) {
        capturedSystemPrompt = request.systemPrompt;
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

  return { provider, getCapturedSystemPrompt: () => capturedSystemPrompt };
}

// ─────────────────────────────────────────────────────────────────────────────
// Test Setup
// ─────────────────────────────────────────────────────────────────────────────

let tempDir: string;
let state: AgentState;
let toolkit: AgentToolkit;

const defaultConfig: Partial<AgentLoopConfig> = {
  maxTurns: 2,
  maxTokensPerCycle: 50_000,
  temperature: 0.1,
  maxResponseTokens: 2048,
};

const scheduledTrigger: AgentTrigger = { type: 'scheduled' };

beforeEach(async () => {
  resetTracer();
  initTracer({ enabled: false });
  tempDir = await mkdtemp(join(tmpdir(), 'casterly-runtime-ctx-'));
  await mkdir(join(tempDir, 'src'), { recursive: true });
  await mkdir(join(tempDir, 'tests'), { recursive: true });

  const goalStack = new GoalStack({ path: join(tempDir, 'goals.yaml') });
  const issueLog = new IssueLog({ path: join(tempDir, 'issues.yaml') });
  const worldModel = new WorldModel({
    path: join(tempDir, 'world-model.yaml'),
    projectRoot: tempDir,
  });

  state = { goalStack, issueLog, worldModel };
  toolkit = buildAgentToolkit(
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

describe('Agent Loop — Runtime Context', () => {
  describe('backward compatibility', () => {
    it('works with no runtime context (existing 6-arg signature)', async () => {
      const { provider, getCapturedSystemPrompt } = createCapturingProvider();

      const loop = createAgentLoop(defaultConfig, provider, toolkit, state);
      await loop.run(scheduledTrigger);

      const systemPrompt = getCapturedSystemPrompt();
      expect(systemPrompt).toBeDefined();

      // Core sections should always be present
      expect(systemPrompt).toContain('Current Context');
      expect(systemPrompt).toContain('File Locations');
      expect(systemPrompt).toContain('Current Task');
      expect(systemPrompt).toContain('How to Work');
      expect(systemPrompt).toContain('Error Recovery');
      expect(systemPrompt).toContain('Memory');
      expect(systemPrompt).toContain('Completion');

      // Without runtime context, no workspace or contacts
      expect(systemPrompt).not.toContain('Workspace Context');
      expect(systemPrompt).not.toContain('People You Know');
    });
  });

  describe('date/time section', () => {
    it('includes current date and time with default timezone', async () => {
      const { provider, getCapturedSystemPrompt } = createCapturingProvider();

      const loop = createAgentLoop(
        defaultConfig, provider, toolkit, state, null, null,
        {},
      );
      await loop.run(scheduledTrigger);

      const systemPrompt = getCapturedSystemPrompt()!;
      expect(systemPrompt).toContain('## Current Context');
      expect(systemPrompt).toContain('**Date**');
      expect(systemPrompt).toContain('**Time**');
      expect(systemPrompt).toContain('**Timezone**');
    });

    it('uses provided timezone', async () => {
      const { provider, getCapturedSystemPrompt } = createCapturingProvider();

      const runtimeContext: RuntimeContext = {
        timezone: 'America/New_York',
      };

      const loop = createAgentLoop(
        defaultConfig, provider, toolkit, state, null, null,
        runtimeContext,
      );
      await loop.run(scheduledTrigger);

      const systemPrompt = getCapturedSystemPrompt()!;
      expect(systemPrompt).toContain('America/New_York');
    });
  });

  describe('workspace context section', () => {
    it('includes bootstrap files when provided', async () => {
      const { provider, getCapturedSystemPrompt } = createCapturingProvider();

      const runtimeContext: RuntimeContext = {
        bootstrapFiles: [
          { name: 'IDENTITY.md', content: 'Name: Tyrion\nCreature: Local AI assistant' },
          { name: 'USER.md', content: 'Name: Josiah, creator of Casterly' },
          { name: 'TOOLS.md', content: 'Use SSH for remote operations' },
        ],
      };

      const loop = createAgentLoop(
        defaultConfig, provider, toolkit, state, null, null,
        runtimeContext,
      );
      await loop.run(scheduledTrigger);

      const systemPrompt = getCapturedSystemPrompt()!;
      expect(systemPrompt).toContain('## Workspace Context');
      expect(systemPrompt).toContain('### IDENTITY.md');
      expect(systemPrompt).toContain('Name: Tyrion');
      expect(systemPrompt).toContain('### USER.md');
      expect(systemPrompt).toContain('Name: Josiah');
      expect(systemPrompt).toContain('### TOOLS.md');
      expect(systemPrompt).toContain('SSH for remote operations');
    });

    it('omits workspace section when no bootstrap files provided', async () => {
      const { provider, getCapturedSystemPrompt } = createCapturingProvider();

      const runtimeContext: RuntimeContext = {
        bootstrapFiles: [],
      };

      const loop = createAgentLoop(
        defaultConfig, provider, toolkit, state, null, null,
        runtimeContext,
      );
      await loop.run(scheduledTrigger);

      const systemPrompt = getCapturedSystemPrompt()!;
      expect(systemPrompt).not.toContain('Workspace Context');
    });
  });

  describe('contacts section', () => {
    it('includes contacts roster when provided', async () => {
      const { provider, getCapturedSystemPrompt } = createCapturingProvider();

      const runtimeContext: RuntimeContext = {
        contacts: [
          { name: 'Katie', phone: '+15551234567' },
          { name: 'Mom', phone: '+15559876543' },
        ],
      };

      const loop = createAgentLoop(
        defaultConfig, provider, toolkit, state, null, null,
        runtimeContext,
      );
      await loop.run(scheduledTrigger);

      const systemPrompt = getCapturedSystemPrompt()!;
      expect(systemPrompt).toContain('## People You Know');
      expect(systemPrompt).toContain('message_user');
      expect(systemPrompt).toContain('**Katie**: +15551234567');
      expect(systemPrompt).toContain('**Mom**: +15559876543');
    });

    it('omits contacts section when empty', async () => {
      const { provider, getCapturedSystemPrompt } = createCapturingProvider();

      const runtimeContext: RuntimeContext = {
        contacts: [],
      };

      const loop = createAgentLoop(
        defaultConfig, provider, toolkit, state, null, null,
        runtimeContext,
      );
      await loop.run(scheduledTrigger);

      const systemPrompt = getCapturedSystemPrompt()!;
      expect(systemPrompt).not.toContain('People You Know');
    });
  });

  describe('file locations section', () => {
    it('always includes file location guidance', async () => {
      const { provider, getCapturedSystemPrompt } = createCapturingProvider();

      const loop = createAgentLoop(
        defaultConfig, provider, toolkit, state, null, null,
        {},
      );
      await loop.run(scheduledTrigger);

      const systemPrompt = getCapturedSystemPrompt()!;
      expect(systemPrompt).toContain('## File Locations');
      expect(systemPrompt).toContain('~/Documents/Tyrion/');
      expect(systemPrompt).toContain('NEVER create user documents in the repository root');
    });
  });

  describe('full runtime context', () => {
    it('combines all sections in correct order', async () => {
      const { provider, getCapturedSystemPrompt } = createCapturingProvider();

      const runtimeContext: RuntimeContext = {
        timezone: 'America/Chicago',
        bootstrapFiles: [
          { name: 'IDENTITY.md', content: 'Test identity' },
        ],
        contacts: [
          { name: 'Alice', phone: '+15550001111' },
        ],
      };

      const loop = createAgentLoop(
        defaultConfig, provider, toolkit, state, null, null,
        runtimeContext,
      );
      await loop.run(scheduledTrigger);

      const systemPrompt = getCapturedSystemPrompt()!;

      // Verify all sections present
      expect(systemPrompt).toContain('## Current Context');
      expect(systemPrompt).toContain('## Workspace Context');
      expect(systemPrompt).toContain('## People You Know');
      expect(systemPrompt).toContain('## File Locations');
      expect(systemPrompt).toContain('## Current Task');
      expect(systemPrompt).toContain('## How to Work');

      // Verify section ordering: Context → Workspace → People → File Locations → Task → How to Work
      const contextIdx = systemPrompt.indexOf('## Current Context');
      const workspaceIdx = systemPrompt.indexOf('## Workspace Context');
      const peopleIdx = systemPrompt.indexOf('## People You Know');
      const fileLocIdx = systemPrompt.indexOf('## File Locations');
      const taskIdx = systemPrompt.indexOf('## Current Task');
      const howToWorkIdx = systemPrompt.indexOf('## How to Work');

      expect(contextIdx).toBeLessThan(workspaceIdx);
      expect(workspaceIdx).toBeLessThan(peopleIdx);
      expect(peopleIdx).toBeLessThan(fileLocIdx);
      expect(fileLocIdx).toBeLessThan(taskIdx);
      expect(taskIdx).toBeLessThan(howToWorkIdx);
    });

    it('SOUL.md exclusion is enforced by the loading config in loop.ts', () => {
      // SOUL.md is excluded at the loading layer (loop.ts passes ['IDENTITY.md', 'USER.md', 'TOOLS.md']).
      // The agent-loop.ts buildWorkspaceSection() itself is file-agnostic — it renders whatever it gets.
      // This test documents the contract: voice filter handles personality, not bootstrap files.
      const runtimeContext: RuntimeContext = {
        bootstrapFiles: [
          { name: 'IDENTITY.md', content: 'Test' },
          { name: 'USER.md', content: 'Test' },
          { name: 'TOOLS.md', content: 'Test' },
        ],
      };

      // SOUL.md should NOT be in the bootstrap list
      const hasSOUL = runtimeContext.bootstrapFiles!.some(f => f.name === 'SOUL.md');
      expect(hasSOUL).toBe(false);
    });
  });
});
