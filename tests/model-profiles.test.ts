import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

import {
  DEFAULT_PROFILE,
  resolveModelProfile,
  getBuiltInProfile,
  enrichSystemPrompt,
  enrichToolDescriptions,
  applyResponseHints,
  getGenerationOverrides,
  type ModelProfile,
} from '../src/models/index.js';
import type { ToolSchema } from '../src/tools/schemas/types.js';

// ─── Test Fixtures ──────────────────────────────────────────────────────────

const SAMPLE_TOOLS: ToolSchema[] = [
  {
    name: 'bash',
    description: 'Execute a shell command',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The command' },
      },
      required: ['command'],
    },
  },
  {
    name: 'read_file',
    description: 'Read a file from the filesystem',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path' },
      },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description: 'Write content to a file',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path' },
        content: { type: 'string', description: 'Content' },
      },
      required: ['path', 'content'],
    },
  },
];

const PROFILE_WITH_OVERRIDES: ModelProfile = {
  modelId: 'test-model:latest',
  displayName: 'Test Model',
  family: 'test',
  systemPromptHint: 'Use tools aggressively.',
  toolOverrides: [
    {
      toolName: 'bash',
      descriptionSuffix: '\nChain commands with &&.',
    },
    {
      toolName: 'read_file',
      description: 'Read any file. Always prefer this over cat.',
    },
  ],
  generation: {
    temperature: 0.5,
    numPredict: 4096,
    ollamaOptions: { num_ctx: 32768 },
  },
  responseHints: [
    {
      pattern: '\\[THINKING\\].*?\\[/THINKING\\]',
      replacement: '',
      reason: 'Strip thinking blocks',
    },
    {
      pattern: '---+',
      replacement: '---',
      reason: 'Normalize horizontal rules',
    },
  ],
};

// ─── resolveModelProfile ────────────────────────────────────────────────────

describe('resolveModelProfile', () => {
  it('returns built-in profile for gpt-oss:120b', () => {
    const profile = resolveModelProfile('gpt-oss:120b');
    expect(profile.modelId).toBe('gpt-oss:120b');
    expect(profile.displayName).toBe('GPT-OSS 120B');
    expect(profile.family).toBe('gpt-oss');
    expect(profile.systemPromptHint).toBeTruthy();
    expect(profile.toolOverrides).toBeDefined();
    expect(profile.generation?.temperature).toBe(0.6);
  });

  it('returns built-in profile for hermes3:70b', () => {
    const profile = resolveModelProfile('hermes3:70b');
    expect(profile.modelId).toBe('hermes3:70b');
    expect(profile.family).toBe('hermes');
    expect(profile.generation?.temperature).toBe(0.7);
  });

  it('returns built-in profile for qwen3-coder-next:latest', () => {
    const profile = resolveModelProfile('qwen3-coder-next:latest');
    expect(profile.modelId).toBe('qwen3-coder-next:latest');
    expect(profile.family).toBe('qwen');
    expect(profile.generation?.temperature).toBe(0.1);
  });

  it('falls back to family match for unknown gpt-oss variant', () => {
    const profile = resolveModelProfile('gpt-oss:240b');
    expect(profile.modelId).toBe('gpt-oss:240b');
    expect(profile.family).toBe('gpt-oss');
    expect(profile.systemPromptHint).toBeTruthy();
    expect(profile.generation?.temperature).toBe(0.6);
  });

  it('returns default profile for completely unknown model', () => {
    const profile = resolveModelProfile('totally-unknown-model:7b');
    expect(profile.modelId).toBe('totally-unknown-model:7b');
    expect(profile.displayName).toBe('Default Profile');
    expect(profile.systemPromptHint).toBeUndefined();
    expect(profile.toolOverrides).toBeUndefined();
    expect(profile.generation).toBeUndefined();
  });

  it('loads custom profile from YAML', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'model-profiles-'));
    const yamlPath = join(tmpDir, 'profiles.yaml');
    writeFileSync(yamlPath, `
profiles:
  - modelId: "custom-model:8b"
    displayName: "Custom 8B"
    family: "custom"
    systemPromptHint: "Be concise."
    generation:
      temperature: 0.3
`);

    try {
      const profile = resolveModelProfile('custom-model:8b', yamlPath);
      expect(profile.modelId).toBe('custom-model:8b');
      expect(profile.displayName).toBe('Custom 8B');
      expect(profile.systemPromptHint).toBe('Be concise.');
      expect(profile.generation?.temperature).toBe(0.3);
    } finally {
      rmSync(tmpDir, { recursive: true });
    }
  });

  it('YAML profiles override built-in profiles', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'model-profiles-'));
    const yamlPath = join(tmpDir, 'profiles.yaml');
    writeFileSync(yamlPath, `
profiles:
  - modelId: "gpt-oss:120b"
    displayName: "Custom GPT-OSS"
    family: "gpt-oss"
    systemPromptHint: "Custom hint."
    generation:
      temperature: 0.9
`);

    try {
      const profile = resolveModelProfile('gpt-oss:120b', yamlPath);
      expect(profile.displayName).toBe('Custom GPT-OSS');
      expect(profile.systemPromptHint).toBe('Custom hint.');
      expect(profile.generation?.temperature).toBe(0.9);
    } finally {
      rmSync(tmpDir, { recursive: true });
    }
  });

  it('returns default when YAML is missing', () => {
    const profile = resolveModelProfile('unknown:latest', '/nonexistent/path.yaml');
    expect(profile.modelId).toBe('unknown:latest');
    expect(profile.displayName).toBe('Default Profile');
  });
});

describe('getBuiltInProfile', () => {
  it('returns profile for known model', () => {
    const profile = getBuiltInProfile('gpt-oss:120b');
    expect(profile).toBeDefined();
    expect(profile?.modelId).toBe('gpt-oss:120b');
  });

  it('returns undefined for unknown model', () => {
    expect(getBuiltInProfile('unknown:latest')).toBeUndefined();
  });
});

// ─── enrichSystemPrompt ─────────────────────────────────────────────────────

describe('enrichSystemPrompt', () => {
  const basePrompt = 'You are Tyrion, a helpful assistant.';

  it('appends hint when profile has one', () => {
    const result = enrichSystemPrompt(basePrompt, PROFILE_WITH_OVERRIDES);
    expect(result).toContain(basePrompt);
    expect(result).toContain('## Model-Specific Instructions');
    expect(result).toContain('Use tools aggressively.');
  });

  it('returns original prompt when no hint', () => {
    const result = enrichSystemPrompt(basePrompt, DEFAULT_PROFILE);
    expect(result).toBe(basePrompt);
  });

  it('returns original prompt when hint is undefined', () => {
    const profile: ModelProfile = {
      modelId: 'test:latest',
      displayName: 'Test',
    };
    const result = enrichSystemPrompt(basePrompt, profile);
    expect(result).toBe(basePrompt);
  });
});

// ─── enrichToolDescriptions ─────────────────────────────────────────────────

describe('enrichToolDescriptions', () => {
  it('applies description suffix to matching tools', () => {
    const result = enrichToolDescriptions(SAMPLE_TOOLS, PROFILE_WITH_OVERRIDES);
    const bash = result.find((t) => t.name === 'bash');
    expect(bash?.description).toBe('Execute a shell command\nChain commands with &&.');
  });

  it('replaces description entirely when override has description', () => {
    const result = enrichToolDescriptions(SAMPLE_TOOLS, PROFILE_WITH_OVERRIDES);
    const readFile = result.find((t) => t.name === 'read_file');
    expect(readFile?.description).toBe('Read any file. Always prefer this over cat.');
  });

  it('passes through tools not mentioned in overrides', () => {
    const result = enrichToolDescriptions(SAMPLE_TOOLS, PROFILE_WITH_OVERRIDES);
    const writeFile = result.find((t) => t.name === 'write_file');
    expect(writeFile?.description).toBe('Write content to a file');
  });

  it('does not mutate original tools array', () => {
    const originalDesc = SAMPLE_TOOLS[0]?.description;
    enrichToolDescriptions(SAMPLE_TOOLS, PROFILE_WITH_OVERRIDES);
    expect(SAMPLE_TOOLS[0]?.description).toBe(originalDesc);
  });

  it('returns tools unchanged when no overrides', () => {
    const result = enrichToolDescriptions(SAMPLE_TOOLS, DEFAULT_PROFILE);
    expect(result).toBe(SAMPLE_TOOLS); // Same reference, not a copy
  });

  it('returns tools unchanged when overrides array is empty', () => {
    const profile: ModelProfile = {
      modelId: 'test:latest',
      displayName: 'Test',
      toolOverrides: [],
    };
    const result = enrichToolDescriptions(SAMPLE_TOOLS, profile);
    expect(result).toBe(SAMPLE_TOOLS);
  });
});

// ─── applyResponseHints ─────────────────────────────────────────────────────

describe('applyResponseHints', () => {
  it('applies regex replacement', () => {
    const input = 'Hello [THINKING]internal reasoning[/THINKING] world';
    const result = applyResponseHints(input, PROFILE_WITH_OVERRIDES);
    expect(result).toBe('Hello  world');
  });

  it('applies multiple hints in order', () => {
    const input = 'Hello --------- world';
    const result = applyResponseHints(input, PROFILE_WITH_OVERRIDES);
    expect(result).toBe('Hello --- world');
  });

  it('returns text unchanged when no hints', () => {
    const input = 'Hello world';
    const result = applyResponseHints(input, DEFAULT_PROFILE);
    expect(result).toBe(input);
  });

  it('handles empty response text', () => {
    const result = applyResponseHints('', PROFILE_WITH_OVERRIDES);
    expect(result).toBe('');
  });
});

// ─── getGenerationOverrides ─────────────────────────────────────────────────

describe('getGenerationOverrides', () => {
  it('extracts temperature and num_predict', () => {
    const overrides = getGenerationOverrides(PROFILE_WITH_OVERRIDES);
    expect(overrides.temperature).toBe(0.5);
    expect(overrides.num_predict).toBe(4096);
  });

  it('merges ollamaOptions', () => {
    const overrides = getGenerationOverrides(PROFILE_WITH_OVERRIDES);
    expect(overrides.num_ctx).toBe(32768);
  });

  it('returns empty object when no generation params', () => {
    const overrides = getGenerationOverrides(DEFAULT_PROFILE);
    expect(Object.keys(overrides)).toHaveLength(0);
  });

  it('only includes explicitly set fields', () => {
    const profile: ModelProfile = {
      modelId: 'test:latest',
      displayName: 'Test',
      generation: {
        temperature: 0.8,
      },
    };
    const overrides = getGenerationOverrides(profile);
    expect(overrides.temperature).toBe(0.8);
    expect(overrides.num_predict).toBeUndefined();
  });
});
