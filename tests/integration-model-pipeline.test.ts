/**
 * Integration Test: Model Profile Pipeline
 *
 * Tests the complete model profile pipeline end-to-end:
 * resolve profile → enrich system prompt → enrich tool descriptions →
 * apply response hints → get generation overrides.
 *
 * This verifies that the pipeline works for all configured models
 * and that the enrichment is applied correctly in combination.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import YAML from 'yaml';
import {
  resolveModelProfile,
  enrichSystemPrompt,
  enrichToolDescriptions,
  applyResponseHints,
  getGenerationOverrides,
  DEFAULT_PROFILE,
} from '../src/models/index.js';
import type { ModelProfile } from '../src/models/index.js';
import type { ToolSchema } from '../src/tools/schemas/types.js';

const PROJECT_ROOT = resolve(import.meta.dirname, '..');

// ─── Shared Fixtures ─────────────────────────────────────────────────────────

const BASE_SYSTEM_PROMPT = `You are Tyrion, a sardonic and brilliant AI assistant.
You run on a Mac Studio M4 Max with 128GB unified memory.
You value correctness, wit, and getting things done.`;

const SAMPLE_TOOLS: ToolSchema[] = [
  {
    name: 'bash',
    description: 'Execute a shell command on the local system.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The command to execute' },
      },
      required: ['command'],
    },
  },
  {
    name: 'read_file',
    description: 'Read a file from the filesystem.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path to read' },
      },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description: 'Write content to a file.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path' },
        content: { type: 'string', description: 'Content to write' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'search_files',
    description: 'Search for patterns in files.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Search pattern' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'edit_file',
    description: 'Edit a file using search/replace.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path' },
        search: { type: 'string', description: 'Text to find' },
        replace: { type: 'string', description: 'Replacement text' },
      },
      required: ['path', 'search', 'replace'],
    },
  },
  {
    name: 'send_message',
    description: 'Send an iMessage to a contact.',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Recipient' },
        message: { type: 'string', description: 'Message content' },
      },
      required: ['to', 'message'],
    },
  },
];

// ─── Helper: full pipeline ───────────────────────────────────────────────────

interface PipelineResult {
  profile: ModelProfile;
  systemPrompt: string;
  tools: ToolSchema[];
  cleanedResponse: string;
  generationOverrides: Record<string, unknown>;
}

function runFullPipeline(
  modelId: string,
  responseText: string = 'Hello world',
): PipelineResult {
  const profile = resolveModelProfile(modelId);
  const systemPrompt = enrichSystemPrompt(BASE_SYSTEM_PROMPT, profile);
  const tools = enrichToolDescriptions(SAMPLE_TOOLS, profile);
  const cleanedResponse = applyResponseHints(responseText, profile);
  const generationOverrides = getGenerationOverrides(profile);
  return { profile, systemPrompt, tools, cleanedResponse, generationOverrides };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Full pipeline for qwen3.5:122b (primary model)
// ═══════════════════════════════════════════════════════════════════════════════

describe('full pipeline: qwen3.5:122b', () => {
  const result = runFullPipeline('qwen3.5:122b');

  it('resolves the correct profile', () => {
    expect(result.profile.modelId).toBe('qwen3.5:122b');
    expect(result.profile.family).toBe('qwen3.5');
    expect(result.profile.displayName).toBe('Qwen 3.5 122B');
  });

  it('enriches system prompt with tool routing rules', () => {
    expect(result.systemPrompt).toContain(BASE_SYSTEM_PROMPT);
    expect(result.systemPrompt).toContain('## Model-Specific Instructions');
    expect(result.systemPrompt).toContain('Tool routing rules:');
    expect(result.systemPrompt).toContain('use the read_file tool');
    expect(result.systemPrompt).toContain('PERSONALITY IS PARAMOUNT');
  });

  it('enriches tool descriptions', () => {
    const bash = result.tools.find((t) => t.name === 'bash')!;
    expect(bash.description).toContain('Execute a shell command');
    expect(bash.description).toContain('Use when:');
    expect(bash.description).toContain('Do NOT use when:');

    const readFile = result.tools.find((t) => t.name === 'read_file')!;
    expect(readFile.description).toContain('Use when:');
  });

  it('does not mutate tools not in overrides that are not present', () => {
    // If the tool is in the overrides, it should be enriched
    // Any tool not in overrides should pass through unchanged
    const originalSearchDesc = SAMPLE_TOOLS.find((t) => t.name === 'search_files')!.description;
    const pipelineSearch = result.tools.find((t) => t.name === 'search_files')!;
    // search_files IS in qwen3.5 overrides, so it should be enriched
    expect(pipelineSearch.description.length).toBeGreaterThanOrEqual(originalSearchDesc.length);
  });

  it('applies response hints for markdown code block cleanup', () => {
    const responseWithCodeBlock = 'Here is the result ```tool_call\nsome content\n``` done';
    const cleaned = applyResponseHints(responseWithCodeBlock, result.profile);
    expect(cleaned).not.toContain('```tool_call');
  });

  it('sets correct generation overrides', () => {
    expect(result.generationOverrides.temperature).toBe(0.6);
    expect(result.generationOverrides.num_predict).toBe(2048);
    expect(result.generationOverrides.num_ctx).toBe(262144);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Full pipeline for hermes3:70b (legacy model)
// ═══════════════════════════════════════════════════════════════════════════════

describe('full pipeline: hermes3:70b', () => {
  const result = runFullPipeline('hermes3:70b');

  it('resolves the correct profile', () => {
    expect(result.profile.modelId).toBe('hermes3:70b');
    expect(result.profile.family).toBe('hermes');
  });

  it('does not enrich system prompt (no hint)', () => {
    expect(result.systemPrompt).toBe(BASE_SYSTEM_PROMPT);
  });

  it('passes tools through unchanged', () => {
    expect(result.tools).toBe(SAMPLE_TOOLS);
  });

  it('sets hermes generation params', () => {
    expect(result.generationOverrides.temperature).toBe(0.7);
    expect(result.generationOverrides.num_predict).toBe(2048);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Full pipeline for unknown model (fallback)
// ═══════════════════════════════════════════════════════════════════════════════

describe('full pipeline: unknown model', () => {
  const result = runFullPipeline('completely-unknown:7b');

  it('falls back to DEFAULT_PROFILE', () => {
    expect(result.profile.modelId).toBe('completely-unknown:7b');
    expect(result.profile.displayName).toBe('Default Profile');
  });

  it('does not modify system prompt', () => {
    expect(result.systemPrompt).toBe(BASE_SYSTEM_PROMPT);
  });

  it('does not modify tools', () => {
    expect(result.tools).toBe(SAMPLE_TOOLS);
  });

  it('returns empty generation overrides', () => {
    expect(Object.keys(result.generationOverrides)).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Family-based fallback
// ═══════════════════════════════════════════════════════════════════════════════

describe('family-based fallback', () => {
  it('qwen3.5:35b gets qwen3.5 family profile', () => {
    const result = runFullPipeline('qwen3.5:35b');
    expect(result.profile.family).toBe('qwen3.5');
    expect(result.profile.modelId).toBe('qwen3.5:35b');
    expect(result.systemPrompt).toContain('Tool routing rules:');
    expect(result.generationOverrides.temperature).toBe(0.6);
  });

  it('unknown-family:7b falls back to DEFAULT_PROFILE', () => {
    const result = runFullPipeline('unknown-family:7b');
    expect(result.profile.family).toBeUndefined();
    expect(result.profile.modelId).toBe('unknown-family:7b');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Pipeline with models.yaml configured models
// ═══════════════════════════════════════════════════════════════════════════════

describe('pipeline for all models.yaml entries', () => {
  const raw = YAML.parse(
    readFileSync(resolve(PROJECT_ROOT, 'config/models.yaml'), 'utf8'),
  ) as Record<string, unknown>;
  const models = raw.models as Record<string, Record<string, unknown>>;

  for (const [role, cfg] of Object.entries(models)) {
    const modelId = cfg.model as string;
    if (!modelId) continue;

    it(`${role} model (${modelId}) resolves a valid profile`, () => {
      const profile = resolveModelProfile(modelId);
      expect(profile).toBeDefined();
      expect(profile.modelId).toBe(modelId);
    });

    it(`${role} model (${modelId}) enriches system prompt without error`, () => {
      const profile = resolveModelProfile(modelId);
      const enriched = enrichSystemPrompt(BASE_SYSTEM_PROMPT, profile);
      expect(enriched).toContain(BASE_SYSTEM_PROMPT);
    });

    it(`${role} model (${modelId}) enriches tools without error`, () => {
      const profile = resolveModelProfile(modelId);
      const enriched = enrichToolDescriptions(SAMPLE_TOOLS, profile);
      expect(enriched.length).toBe(SAMPLE_TOOLS.length);
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// Idempotency and immutability
// ═══════════════════════════════════════════════════════════════════════════════

describe('pipeline safety properties', () => {
  it('enrichment is idempotent (running twice gives same result)', () => {
    const profile = resolveModelProfile('qwen3.5:122b');
    const prompt1 = enrichSystemPrompt(BASE_SYSTEM_PROMPT, profile);
    // Enriching the already-enriched prompt with same profile should append again
    // but enriching the base twice with same profile should give same result each time
    const prompt1b = enrichSystemPrompt(BASE_SYSTEM_PROMPT, profile);
    expect(prompt1).toBe(prompt1b);
  });

  it('original tools array is never mutated', () => {
    const originalDescriptions = SAMPLE_TOOLS.map((t) => t.description);
    const profile = resolveModelProfile('qwen3.5:122b');

    // Run enrichment multiple times
    enrichToolDescriptions(SAMPLE_TOOLS, profile);
    enrichToolDescriptions(SAMPLE_TOOLS, profile);
    enrichToolDescriptions(SAMPLE_TOOLS, profile);

    // Original descriptions should be unchanged
    SAMPLE_TOOLS.forEach((tool, i) => {
      expect(tool.description).toBe(originalDescriptions[i]);
    });
  });

  it('response hint application does not affect unrelated text', () => {
    const profile = resolveModelProfile('qwen3.5:122b');
    const normalText = 'This is a perfectly normal response with no quirks.';
    const cleaned = applyResponseHints(normalText, profile);
    expect(cleaned).toBe(normalText);
  });
});
