import { describe, expect, it } from 'vitest';

import { appConfigSchema } from '../src/config/schema.js';

// ═══════════════════════════════════════════════════════════════════════════════
// sensitiveCategorySchema (validated through appConfigSchema)
// ═══════════════════════════════════════════════════════════════════════════════

const baseConfig = (alwaysLocal: unknown[]) => ({
  local: {
    provider: 'ollama' as const,
    model: 'test-model',
    baseUrl: 'http://localhost:11434',
  },
  sensitivity: { alwaysLocal },
});

describe('sensitiveCategorySchema', () => {
  it('accepts valid categories', () => {
    const valid = ['calendar', 'finances', 'voice_memos', 'health', 'credentials', 'documents', 'contacts', 'location'];
    const result = appConfigSchema.parse(baseConfig(valid));
    expect(result.sensitivity.alwaysLocal).toEqual(valid);
  });

  it('rejects invalid category', () => {
    expect(() => appConfigSchema.parse(baseConfig(['invalid']))).toThrow();
  });

  it('rejects empty string', () => {
    expect(() => appConfigSchema.parse(baseConfig(['']))).toThrow();
  });

  it('rejects non-string', () => {
    expect(() => appConfigSchema.parse(baseConfig([123]))).toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// appConfigSchema — valid configs
// ═══════════════════════════════════════════════════════════════════════════════

describe('appConfigSchema — valid configs', () => {
  it('accepts minimal valid config', () => {
    const config = {
      local: {
        provider: 'ollama' as const,
        model: 'qwen3.5:122b',
        baseUrl: 'http://localhost:11434',
      },
      sensitivity: {
        alwaysLocal: ['credentials'],
      },
    };
    const result = appConfigSchema.parse(config);
    expect(result.local.model).toBe('qwen3.5:122b');
    expect(result.sensitivity.alwaysLocal).toEqual(['credentials']);
  });

  it('accepts config with optional fields', () => {
    const config = {
      local: {
        provider: 'ollama' as const,
        model: 'qwen3.5:122b',
        baseUrl: 'http://localhost:11434',
        timeoutMs: 60000,
        codingModel: 'qwen3-coder-next:latest',
      },
      sensitivity: {
        alwaysLocal: ['credentials', 'health', 'finances'],
      },
    };
    const result = appConfigSchema.parse(config);
    expect(result.local.timeoutMs).toBe(60000);
    expect(result.local.codingModel).toBe('qwen3-coder-next:latest');
  });

  it('accepts all sensitive categories', () => {
    const config = {
      local: {
        provider: 'ollama' as const,
        model: 'test-model',
        baseUrl: 'https://example.com',
      },
      sensitivity: {
        alwaysLocal: ['calendar', 'finances', 'voice_memos', 'health', 'credentials', 'documents', 'contacts', 'location'],
      },
    };
    const result = appConfigSchema.parse(config);
    expect(result.sensitivity.alwaysLocal.length).toBe(8);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// appConfigSchema — invalid configs
// ═══════════════════════════════════════════════════════════════════════════════

describe('appConfigSchema — invalid configs', () => {
  it('rejects missing local section', () => {
    const config = {
      sensitivity: { alwaysLocal: ['credentials'] },
    };
    expect(() => appConfigSchema.parse(config)).toThrow();
  });

  it('rejects missing sensitivity section', () => {
    const config = {
      local: {
        provider: 'ollama',
        model: 'test',
        baseUrl: 'http://localhost:11434',
      },
    };
    expect(() => appConfigSchema.parse(config)).toThrow();
  });

  it('rejects non-ollama provider', () => {
    const config = {
      local: {
        provider: 'openai',
        model: 'test',
        baseUrl: 'http://localhost:11434',
      },
      sensitivity: { alwaysLocal: ['credentials'] },
    };
    expect(() => appConfigSchema.parse(config)).toThrow();
  });

  it('rejects empty model string', () => {
    const config = {
      local: {
        provider: 'ollama',
        model: '',
        baseUrl: 'http://localhost:11434',
      },
      sensitivity: { alwaysLocal: ['credentials'] },
    };
    expect(() => appConfigSchema.parse(config)).toThrow();
  });

  it('rejects invalid baseUrl', () => {
    const config = {
      local: {
        provider: 'ollama',
        model: 'test',
        baseUrl: 'not-a-url',
      },
      sensitivity: { alwaysLocal: ['credentials'] },
    };
    expect(() => appConfigSchema.parse(config)).toThrow();
  });

  it('rejects empty alwaysLocal array', () => {
    const config = {
      local: {
        provider: 'ollama',
        model: 'test',
        baseUrl: 'http://localhost:11434',
      },
      sensitivity: { alwaysLocal: [] },
    };
    expect(() => appConfigSchema.parse(config)).toThrow();
  });

  it('rejects negative timeoutMs', () => {
    const config = {
      local: {
        provider: 'ollama',
        model: 'test',
        baseUrl: 'http://localhost:11434',
        timeoutMs: -1,
      },
      sensitivity: { alwaysLocal: ['credentials'] },
    };
    expect(() => appConfigSchema.parse(config)).toThrow();
  });

  it('rejects non-integer timeoutMs', () => {
    const config = {
      local: {
        provider: 'ollama',
        model: 'test',
        baseUrl: 'http://localhost:11434',
        timeoutMs: 1.5,
      },
      sensitivity: { alwaysLocal: ['credentials'] },
    };
    expect(() => appConfigSchema.parse(config)).toThrow();
  });

  it('rejects invalid sensitive category in array', () => {
    const config = {
      local: {
        provider: 'ollama',
        model: 'test',
        baseUrl: 'http://localhost:11434',
      },
      sensitivity: { alwaysLocal: ['invalid_category'] },
    };
    expect(() => appConfigSchema.parse(config)).toThrow();
  });

  it('rejects completely empty object', () => {
    expect(() => appConfigSchema.parse({})).toThrow();
  });

  it('rejects null', () => {
    expect(() => appConfigSchema.parse(null)).toThrow();
  });
});
