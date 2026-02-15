import { describe, expect, it } from 'vitest';

import {
  enrichSystemPrompt,
  enrichToolDescriptions,
  applyResponseHints,
  getGenerationOverrides,
} from '../src/models/enrichment.js';
import type { ModelProfile } from '../src/models/types.js';
import { DEFAULT_PROFILE } from '../src/models/types.js';
import type { ToolSchema } from '../src/tools/schemas/types.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeProfile(overrides: Partial<ModelProfile> = {}): ModelProfile {
  return {
    modelId: 'test-model',
    displayName: 'Test Model',
    ...overrides,
  };
}

function makeTool(name: string, description: string): ToolSchema {
  return {
    name,
    description,
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// enrichSystemPrompt
// ═══════════════════════════════════════════════════════════════════════════════

describe('enrichSystemPrompt', () => {
  it('returns prompt unchanged when profile has no hint', () => {
    const result = enrichSystemPrompt('You are Tyrion', DEFAULT_PROFILE);
    expect(result).toBe('You are Tyrion');
  });

  it('returns prompt unchanged when hint is empty string', () => {
    const profile = makeProfile({ systemPromptHint: '' });
    const result = enrichSystemPrompt('You are Tyrion', profile);
    expect(result).toBe('You are Tyrion');
  });

  it('appends model-specific section when hint is present', () => {
    const profile = makeProfile({ systemPromptHint: 'Use Harmony format for tool calls' });
    const result = enrichSystemPrompt('You are Tyrion', profile);
    expect(result).toContain('You are Tyrion');
    expect(result).toContain('## Model-Specific Instructions');
    expect(result).toContain('Use Harmony format for tool calls');
  });

  it('preserves original prompt fully', () => {
    const original = 'Line 1\nLine 2\nLine 3';
    const profile = makeProfile({ systemPromptHint: 'Hint' });
    const result = enrichSystemPrompt(original, profile);
    expect(result.startsWith(original)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// enrichToolDescriptions
// ═══════════════════════════════════════════════════════════════════════════════

describe('enrichToolDescriptions', () => {
  it('returns tools unchanged when no overrides', () => {
    const tools = [makeTool('bash', 'Run shell commands')];
    const result = enrichToolDescriptions(tools, DEFAULT_PROFILE);
    expect(result).toEqual(tools);
  });

  it('returns tools unchanged when overrides array is empty', () => {
    const tools = [makeTool('bash', 'Run shell commands')];
    const profile = makeProfile({ toolOverrides: [] });
    const result = enrichToolDescriptions(tools, profile);
    expect(result).toEqual(tools);
  });

  it('replaces description entirely with override', () => {
    const tools = [makeTool('bash', 'Old description')];
    const profile = makeProfile({
      toolOverrides: [{ toolName: 'bash', description: 'New description' }],
    });
    const result = enrichToolDescriptions(tools, profile);
    expect(result[0]!.description).toBe('New description');
  });

  it('appends suffix to description', () => {
    const tools = [makeTool('bash', 'Run shell commands')];
    const profile = makeProfile({
      toolOverrides: [{ toolName: 'bash', descriptionSuffix: ' (prefer JSON output)' }],
    });
    const result = enrichToolDescriptions(tools, profile);
    expect(result[0]!.description).toBe('Run shell commands (prefer JSON output)');
  });

  it('full description takes precedence over suffix', () => {
    const tools = [makeTool('bash', 'Original')];
    const profile = makeProfile({
      toolOverrides: [{ toolName: 'bash', description: 'Replaced', descriptionSuffix: ' suffix' }],
    });
    const result = enrichToolDescriptions(tools, profile);
    expect(result[0]!.description).toBe('Replaced');
  });

  it('passes through tools without overrides', () => {
    const tools = [
      makeTool('bash', 'Run commands'),
      makeTool('read_file', 'Read a file'),
    ];
    const profile = makeProfile({
      toolOverrides: [{ toolName: 'bash', description: 'Replaced' }],
    });
    const result = enrichToolDescriptions(tools, profile);
    expect(result[0]!.description).toBe('Replaced');
    expect(result[1]!.description).toBe('Read a file');
  });

  it('does not mutate original tools', () => {
    const original = makeTool('bash', 'Original');
    const tools = [original];
    const profile = makeProfile({
      toolOverrides: [{ toolName: 'bash', description: 'Changed' }],
    });
    enrichToolDescriptions(tools, profile);
    expect(original.description).toBe('Original');
  });

  it('handles multiple overrides', () => {
    const tools = [
      makeTool('bash', 'Shell'),
      makeTool('read_file', 'Read'),
      makeTool('write_file', 'Write'),
    ];
    const profile = makeProfile({
      toolOverrides: [
        { toolName: 'bash', description: 'New Shell' },
        { toolName: 'write_file', descriptionSuffix: ' (caution)' },
      ],
    });
    const result = enrichToolDescriptions(tools, profile);
    expect(result[0]!.description).toBe('New Shell');
    expect(result[1]!.description).toBe('Read');
    expect(result[2]!.description).toBe('Write (caution)');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// applyResponseHints
// ═══════════════════════════════════════════════════════════════════════════════

describe('applyResponseHints', () => {
  it('returns text unchanged when no hints', () => {
    const result = applyResponseHints('Hello world', DEFAULT_PROFILE);
    expect(result).toBe('Hello world');
  });

  it('returns text unchanged when hints array is empty', () => {
    const profile = makeProfile({ responseHints: [] });
    const result = applyResponseHints('Hello world', profile);
    expect(result).toBe('Hello world');
  });

  it('applies single hint pattern', () => {
    const profile = makeProfile({
      responseHints: [
        { pattern: '<\\|im_end\\|>', replacement: '', reason: 'Strip ChatML tokens' },
      ],
    });
    const result = applyResponseHints('Hello<|im_end|> world', profile);
    expect(result).toBe('Hello world');
  });

  it('applies hints globally', () => {
    const profile = makeProfile({
      responseHints: [
        { pattern: '\\[TOOL\\]', replacement: '', reason: 'Strip tool markers' },
      ],
    });
    const result = applyResponseHints('[TOOL]first[TOOL]second', profile);
    expect(result).toBe('firstsecond');
  });

  it('applies multiple hints in order', () => {
    const profile = makeProfile({
      responseHints: [
        { pattern: 'foo', replacement: 'bar', reason: 'Replace foo' },
        { pattern: 'bar', replacement: 'baz', reason: 'Replace bar' },
      ],
    });
    // First pass: 'foo' → 'bar', so text becomes 'bar world'
    // Second pass: 'bar' → 'baz', so text becomes 'baz world'
    const result = applyResponseHints('foo world', profile);
    expect(result).toBe('baz world');
  });

  it('handles regex patterns', () => {
    const profile = makeProfile({
      responseHints: [
        { pattern: '\\d+', replacement: 'NUM', reason: 'Mask numbers' },
      ],
    });
    const result = applyResponseHints('There are 42 items and 7 more', profile);
    expect(result).toBe('There are NUM items and NUM more');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// getGenerationOverrides
// ═══════════════════════════════════════════════════════════════════════════════

describe('getGenerationOverrides', () => {
  it('returns empty object when no generation config', () => {
    const result = getGenerationOverrides(DEFAULT_PROFILE);
    expect(result).toEqual({});
  });

  it('extracts temperature', () => {
    const profile = makeProfile({ generation: { temperature: 0.7 } });
    const result = getGenerationOverrides(profile);
    expect(result.temperature).toBe(0.7);
  });

  it('extracts numPredict as num_predict', () => {
    const profile = makeProfile({ generation: { numPredict: 4096 } });
    const result = getGenerationOverrides(profile);
    expect(result.num_predict).toBe(4096);
  });

  it('merges ollamaOptions', () => {
    const profile = makeProfile({
      generation: {
        ollamaOptions: { num_ctx: 8192, repeat_penalty: 1.1 },
      },
    });
    const result = getGenerationOverrides(profile);
    expect(result.num_ctx).toBe(8192);
    expect(result.repeat_penalty).toBe(1.1);
  });

  it('combines all fields', () => {
    const profile = makeProfile({
      generation: {
        temperature: 0.5,
        numPredict: 2048,
        ollamaOptions: { num_ctx: 4096 },
      },
    });
    const result = getGenerationOverrides(profile);
    expect(result.temperature).toBe(0.5);
    expect(result.num_predict).toBe(2048);
    expect(result.num_ctx).toBe(4096);
  });

  it('omits undefined fields', () => {
    const profile = makeProfile({ generation: { temperature: 0.3 } });
    const result = getGenerationOverrides(profile);
    expect(result).toEqual({ temperature: 0.3 });
    expect('num_predict' in result).toBe(false);
  });
});
