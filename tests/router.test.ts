import { describe, expect, it } from 'vitest';

import type { AppConfig } from '../src/config/schema.js';
import type { LlmProvider, GenerateRequest, GenerateWithToolsResponse } from '../src/providers/base.js';
import { routeRequest } from '../src/router/index.js';
import type { ToolSchema, NativeToolCall } from '../src/tools/index.js';

/**
 * Create a stub provider that returns a route_decision tool call
 */
function stubProvider(
  id: string,
  kind: 'local' | 'cloud',
  routeDecision?: { route: string; reason: string; confidence: number }
): LlmProvider {
  return {
    id,
    kind,
    model: 'stub-model',
    async generateWithTools(
      _req: GenerateRequest,
      _tools: ToolSchema[]
    ): Promise<GenerateWithToolsResponse> {
      // If no route decision provided, return empty tool calls
      if (!routeDecision) {
        return {
          text: 'stub-response',
          toolCalls: [],
          providerId: id,
          model: 'stub-model',
          stopReason: 'end_turn',
        };
      }

      // Return a route_decision tool call
      const toolCall: NativeToolCall = {
        id: 'call-1',
        name: 'route_decision',
        input: {
          route: routeDecision.route,
          reason: routeDecision.reason,
          confidence: routeDecision.confidence,
        },
      };

      return {
        text: '',
        toolCalls: [toolCall],
        providerId: id,
        model: 'stub-model',
        stopReason: 'tool_use',
      };
    },
  };
}

function stubFailingProvider(id: string, kind: 'local' | 'cloud'): LlmProvider {
  return {
    id,
    kind,
    model: 'stub-model',
    async generateWithTools(): Promise<GenerateWithToolsResponse> {
      throw new Error('Provider failed');
    },
  };
}

function makeConfig(overrides?: Partial<AppConfig>): AppConfig {
  const base: AppConfig = {
    local: {
      provider: 'ollama',
      model: 'llama3.1:8b-instruct-q4_K_M',
      baseUrl: 'http://localhost:11434',
      timeoutMs: 30_000,
    },
    cloud: {
      provider: 'claude',
      model: 'claude-sonnet-4-20250514',
      apiKeyEnv: 'ANTHROPIC_API_KEY',
      apiKey: 'test-key',
      timeoutMs: 45_000,
    },
    router: {
      defaultRoute: 'local',
      confidenceThreshold: 0.7,
    },
    sensitivity: {
      alwaysLocal: [
        'calendar',
        'finances',
        'voice_memos',
        'health',
        'credentials',
        'documents',
        'contacts',
      ],
    },
  };

  return {
    ...base,
    ...overrides,
    local: { ...base.local, ...overrides?.local },
    cloud: { ...base.cloud, ...overrides?.cloud },
    router: { ...base.router, ...overrides?.router },
    sensitivity: { ...base.sensitivity, ...overrides?.sensitivity },
  };
}

describe('routeRequest', () => {
  it('forces local routing for sensitive inputs', async () => {
    const config = makeConfig({
      router: { defaultRoute: 'cloud', confidenceThreshold: 0.95 },
    });

    const decision = await routeRequest('My SSN is 123-45-6789', {
      config,
      providers: {
        local: stubProvider('local-stub', 'local'),
        cloud: stubProvider('cloud-stub', 'cloud'),
      },
    });

    expect(decision.route).toBe('local');
    expect(decision.confidence).toBe(1);
    expect(decision.sensitiveCategories.length).toBeGreaterThan(0);
  });

  it('routes to cloud when LLM decides cloud with sufficient confidence', async () => {
    const config = makeConfig();

    const decision = await routeRequest('Please debug this code issue', {
      config,
      providers: {
        local: stubProvider('local-stub', 'local', {
          route: 'cloud',
          reason: 'Coding task requiring advanced reasoning',
          confidence: 0.9,
        }),
        cloud: stubProvider('cloud-stub', 'cloud'),
      },
    });

    expect(decision.route).toBe('cloud');
    expect(decision.confidence).toBeGreaterThanOrEqual(config.router.confidenceThreshold);
  });

  it('falls back to local when cloud provider is missing', async () => {
    const config = makeConfig();

    const decision = await routeRequest('Please debug this code issue', {
      config,
      providers: {
        local: stubProvider('local-stub', 'local', {
          route: 'cloud',
          reason: 'Coding task requiring advanced reasoning',
          confidence: 0.9,
        }),
      },
    });

    expect(decision.route).toBe('local');
    expect(decision.reason.toLowerCase()).toContain('no cloud provider');
  });

  it('falls back to local when classifier confidence is below threshold', async () => {
    const config = makeConfig({
      router: { defaultRoute: 'cloud', confidenceThreshold: 0.9 },
    });

    const decision = await routeRequest('Tell me a short joke', {
      config,
      providers: {
        local: stubProvider('local-stub', 'local', {
          route: 'cloud',
          reason: 'General question',
          confidence: 0.6,
        }),
        cloud: stubProvider('cloud-stub', 'cloud'),
      },
    });

    expect(decision.route).toBe('local');
    expect(decision.reason.toLowerCase()).toContain('below threshold');
  });

  it('routes to cloud when LLM returns high confidence cloud decision', async () => {
    const config = makeConfig({
      router: { defaultRoute: 'local', confidenceThreshold: 0.7 },
    });

    const decision = await routeRequest('Write a red-black tree implementation', {
      config,
      providers: {
        local: stubProvider('local-stub', 'local', {
          route: 'cloud',
          reason: 'Complex coding task requiring advanced reasoning',
          confidence: 0.95,
        }),
        cloud: stubProvider('cloud-stub', 'cloud'),
      },
    });

    expect(decision.route).toBe('cloud');
    expect(decision.confidence).toBe(0.95);
  });

  it('falls back to default route when LLM call fails', async () => {
    const config = makeConfig({
      router: { defaultRoute: 'local', confidenceThreshold: 0.7 },
    });

    const decision = await routeRequest('Hello world', {
      config,
      providers: {
        local: stubFailingProvider('local-stub', 'local'),
        cloud: stubProvider('cloud-stub', 'cloud'),
      },
    });

    expect(decision.route).toBe('local');
    expect(decision.reason.toLowerCase()).toContain('fell back');
  });

  it('falls back to default route when LLM does not call tool', async () => {
    const config = makeConfig({
      router: { defaultRoute: 'local', confidenceThreshold: 0.7 },
    });

    const decision = await routeRequest('Hello world', {
      config,
      providers: {
        local: stubProvider('local-stub', 'local'), // No route decision - empty tool calls
        cloud: stubProvider('cloud-stub', 'cloud'),
      },
    });

    expect(decision.route).toBe('local');
    expect(decision.reason.toLowerCase()).toContain('tool call');
  });

  it('routes to local for simple greetings', async () => {
    const config = makeConfig();

    const decision = await routeRequest('Hello', {
      config,
      providers: {
        local: stubProvider('local-stub', 'local', {
          route: 'local',
          reason: 'Simple greeting',
          confidence: 0.95,
        }),
        cloud: stubProvider('cloud-stub', 'cloud'),
      },
    });

    expect(decision.route).toBe('local');
    expect(decision.confidence).toBe(0.95);
  });
});
