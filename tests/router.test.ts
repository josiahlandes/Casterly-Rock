import { describe, expect, it } from 'vitest';

import type { AppConfig } from '../src/config/schema.js';
import type { LlmProvider, GenerateRequest } from '../src/providers/base.js';
import { routeRequest } from '../src/router/index.js';
import {
  extractJson,
  parseRouteResponse,
  type RouteClassifierContext
} from '../src/router/classifier.js';

function stubProvider(
  id: string,
  kind: 'local' | 'cloud',
  responseText?: string | ((req: GenerateRequest) => string)
): LlmProvider {
  return {
    id,
    kind,
    model: 'stub-model',
    async generate(req: GenerateRequest) {
      const text =
        typeof responseText === 'function'
          ? responseText(req)
          : responseText ?? 'stub-response';
      return {
        text,
        providerId: id,
        model: 'stub-model'
      };
    }
  };
}

function stubFailingProvider(id: string, kind: 'local' | 'cloud'): LlmProvider {
  return {
    id,
    kind,
    model: 'stub-model',
    async generate() {
      throw new Error('Provider failed');
    }
  };
}

function makeConfig(overrides?: Partial<AppConfig>): AppConfig {
  const base: AppConfig = {
    local: {
      provider: 'ollama',
      model: 'llama3.1:8b-instruct-q4_K_M',
      baseUrl: 'http://localhost:11434',
      timeoutMs: 30_000
    },
    cloud: {
      provider: 'claude',
      model: 'claude-sonnet-4-20250514',
      apiKeyEnv: 'ANTHROPIC_API_KEY',
      apiKey: 'test-key',
      timeoutMs: 45_000
    },
    router: {
      defaultRoute: 'local',
      confidenceThreshold: 0.7
    },
    sensitivity: {
      alwaysLocal: [
        'calendar',
        'finances',
        'voice_memos',
        'health',
        'credentials',
        'documents',
        'contacts'
      ]
    }
  };

  return {
    ...base,
    ...overrides,
    local: { ...base.local, ...overrides?.local },
    cloud: { ...base.cloud, ...overrides?.cloud },
    router: { ...base.router, ...overrides?.router },
    sensitivity: { ...base.sensitivity, ...overrides?.sensitivity }
  };
}

describe('routeRequest', () => {
  it('forces local routing for sensitive inputs', async () => {
    const config = makeConfig({
      router: { defaultRoute: 'cloud', confidenceThreshold: 0.95 }
    });

    const decision = await routeRequest('My SSN is 123-45-6789', {
      config,
      providers: {
        local: stubProvider('local-stub', 'local'),
        cloud: stubProvider('cloud-stub', 'cloud')
      }
    });

    expect(decision.route).toBe('local');
    expect(decision.confidence).toBe(1);
    expect(decision.sensitiveCategories.length).toBeGreaterThan(0);
  });

  it('routes to cloud when LLM decides cloud with sufficient confidence', async () => {
    const config = makeConfig();

    const llmResponse = JSON.stringify({
      route: 'cloud',
      reason: 'Coding task requiring advanced reasoning',
      confidence: 0.9
    });

    const decision = await routeRequest('Please debug this code issue', {
      config,
      providers: {
        local: stubProvider('local-stub', 'local', llmResponse),
        cloud: stubProvider('cloud-stub', 'cloud')
      }
    });

    expect(decision.route).toBe('cloud');
    expect(decision.confidence).toBeGreaterThanOrEqual(config.router.confidenceThreshold);
  });

  it('falls back to local when cloud provider is missing', async () => {
    const config = makeConfig();

    const llmResponse = JSON.stringify({
      route: 'cloud',
      reason: 'Coding task requiring advanced reasoning',
      confidence: 0.9
    });

    const decision = await routeRequest('Please debug this code issue', {
      config,
      providers: {
        local: stubProvider('local-stub', 'local', llmResponse)
      }
    });

    expect(decision.route).toBe('local');
    expect(decision.reason.toLowerCase()).toContain('no cloud provider');
  });

  it('falls back to local when classifier confidence is below threshold', async () => {
    const config = makeConfig({
      router: { defaultRoute: 'cloud', confidenceThreshold: 0.9 }
    });

    const llmResponse = JSON.stringify({
      route: 'cloud',
      reason: 'General question',
      confidence: 0.6
    });

    const decision = await routeRequest('Tell me a short joke', {
      config,
      providers: {
        local: stubProvider('local-stub', 'local', llmResponse),
        cloud: stubProvider('cloud-stub', 'cloud')
      }
    });

    expect(decision.route).toBe('local');
    expect(decision.reason.toLowerCase()).toContain('below threshold');
  });

  it('routes to cloud when LLM returns high confidence cloud decision', async () => {
    const config = makeConfig({
      router: { defaultRoute: 'local', confidenceThreshold: 0.7 }
    });

    const llmResponse = JSON.stringify({
      route: 'cloud',
      reason: 'Complex coding task requiring advanced reasoning',
      confidence: 0.95
    });

    const decision = await routeRequest('Write a red-black tree implementation', {
      config,
      providers: {
        local: stubProvider('local-stub', 'local', llmResponse),
        cloud: stubProvider('cloud-stub', 'cloud')
      }
    });

    expect(decision.route).toBe('cloud');
    expect(decision.confidence).toBe(0.95);
  });

  it('falls back to default route when LLM call fails', async () => {
    const config = makeConfig({
      router: { defaultRoute: 'local', confidenceThreshold: 0.7 }
    });

    const decision = await routeRequest('Hello world', {
      config,
      providers: {
        local: stubFailingProvider('local-stub', 'local'),
        cloud: stubProvider('cloud-stub', 'cloud')
      }
    });

    expect(decision.route).toBe('local');
    expect(decision.reason.toLowerCase()).toContain('fell back');
  });

  it('falls back to default route when LLM returns invalid JSON', async () => {
    const config = makeConfig({
      router: { defaultRoute: 'local', confidenceThreshold: 0.7 }
    });

    const decision = await routeRequest('Hello world', {
      config,
      providers: {
        local: stubProvider('local-stub', 'local', 'Not valid JSON at all'),
        cloud: stubProvider('cloud-stub', 'cloud')
      }
    });

    expect(decision.route).toBe('local');
    expect(decision.reason.toLowerCase()).toContain('invalid');
  });
});

describe('extractJson', () => {
  it('extracts plain JSON object', () => {
    const input = '{"route": "local", "reason": "test", "confidence": 0.8}';
    expect(extractJson(input)).toBe(input);
  });

  it('extracts JSON from markdown code block', () => {
    const input = '```json\n{"route": "cloud", "reason": "coding", "confidence": 0.9}\n```';
    const result = extractJson(input);
    expect(result).toBe('{"route": "cloud", "reason": "coding", "confidence": 0.9}');
  });

  it('extracts JSON from code block without language specifier', () => {
    const input = '```\n{"route": "local", "reason": "private", "confidence": 0.95}\n```';
    const result = extractJson(input);
    expect(result).toBe('{"route": "local", "reason": "private", "confidence": 0.95}');
  });

  it('extracts JSON with preamble text', () => {
    const input = 'Here is my analysis:\n{"route": "cloud", "reason": "general", "confidence": 0.7}';
    const result = extractJson(input);
    expect(result).toBe('{"route": "cloud", "reason": "general", "confidence": 0.7}');
  });

  it('returns null for text without JSON', () => {
    const input = 'This is just plain text without any JSON';
    expect(extractJson(input)).toBeNull();
  });

  it('handles JSON with whitespace', () => {
    const input = '  {\n  "route": "local",\n  "reason": "test",\n  "confidence": 0.5\n}  ';
    const result = extractJson(input);
    expect(result).toContain('"route"');
    expect(result).toContain('"local"');
  });
});

describe('parseRouteResponse', () => {
  const defaultContext: RouteClassifierContext = {
    defaultRoute: 'local',
    confidenceThreshold: 0.7,
    alwaysLocalCategories: []
  };

  it('parses valid JSON response', () => {
    const response = '{"route": "cloud", "reason": "coding task", "confidence": 0.85}';
    const result = parseRouteResponse(response, defaultContext);

    expect(result).not.toBeNull();
    expect(result?.route).toBe('cloud');
    expect(result?.reason).toBe('coding task');
    expect(result?.confidence).toBe(0.85);
  });

  it('returns null for missing route field', () => {
    const response = '{"reason": "test", "confidence": 0.8}';
    const result = parseRouteResponse(response, defaultContext);
    expect(result).toBeNull();
  });

  it('returns null for invalid route value', () => {
    const response = '{"route": "invalid", "reason": "test", "confidence": 0.8}';
    const result = parseRouteResponse(response, defaultContext);
    expect(result).toBeNull();
  });

  it('returns null for missing reason field', () => {
    const response = '{"route": "local", "confidence": 0.8}';
    const result = parseRouteResponse(response, defaultContext);
    expect(result).toBeNull();
  });

  it('returns null for empty reason', () => {
    const response = '{"route": "local", "reason": "", "confidence": 0.8}';
    const result = parseRouteResponse(response, defaultContext);
    expect(result).toBeNull();
  });

  it('returns null for missing confidence field', () => {
    const response = '{"route": "local", "reason": "test"}';
    const result = parseRouteResponse(response, defaultContext);
    expect(result).toBeNull();
  });

  it('returns null for confidence out of range (negative)', () => {
    const response = '{"route": "local", "reason": "test", "confidence": -0.5}';
    const result = parseRouteResponse(response, defaultContext);
    expect(result).toBeNull();
  });

  it('returns null for confidence out of range (over 1)', () => {
    const response = '{"route": "local", "reason": "test", "confidence": 1.5}';
    const result = parseRouteResponse(response, defaultContext);
    expect(result).toBeNull();
  });

  it('returns null for non-numeric confidence', () => {
    const response = '{"route": "local", "reason": "test", "confidence": "high"}';
    const result = parseRouteResponse(response, defaultContext);
    expect(result).toBeNull();
  });

  it('enforces local bias when cloud confidence is below threshold', () => {
    const response = '{"route": "cloud", "reason": "maybe cloud", "confidence": 0.5}';
    const result = parseRouteResponse(response, defaultContext);

    expect(result).not.toBeNull();
    expect(result?.route).toBe('local');
    expect(result?.reason).toContain('below threshold');
    expect(result?.confidence).toBe(0.5);
  });

  it('allows cloud route when confidence meets threshold', () => {
    const response = '{"route": "cloud", "reason": "definitely cloud", "confidence": 0.7}';
    const result = parseRouteResponse(response, defaultContext);

    expect(result).not.toBeNull();
    expect(result?.route).toBe('cloud');
    expect(result?.reason).toBe('definitely cloud');
  });

  it('allows local route regardless of confidence', () => {
    const response = '{"route": "local", "reason": "private data", "confidence": 0.3}';
    const result = parseRouteResponse(response, defaultContext);

    expect(result).not.toBeNull();
    expect(result?.route).toBe('local');
    expect(result?.confidence).toBe(0.3);
  });

  it('parses JSON from markdown code block', () => {
    const response = '```json\n{"route": "local", "reason": "test", "confidence": 0.9}\n```';
    const result = parseRouteResponse(response, defaultContext);

    expect(result).not.toBeNull();
    expect(result?.route).toBe('local');
  });

  it('returns null for malformed JSON', () => {
    const response = '{route: local, reason: test}';
    const result = parseRouteResponse(response, defaultContext);
    expect(result).toBeNull();
  });
});
