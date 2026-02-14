/**
 * Model Profiles
 *
 * Loads model profiles from config/model-profiles.yaml
 * and provides built-in profiles for known models.
 * Falls back to DEFAULT_PROFILE for unknown models.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import YAML from 'yaml';
import { safeLogger } from '../logging/safe-logger.js';
import type { ModelProfile, ToolDescriptionOverride, ResponseParsingHint, ModelGenerationParams } from './types.js';
import { DEFAULT_PROFILE } from './types.js';

// ─── Built-in Profiles ──────────────────────────────────────────────────────

/**
 * gpt-oss profile (family: gpt-oss).
 *
 * Optimized for OpenAI Harmony-format models:
 * - Concise tool descriptions (trained on OpenAI function calling)
 * - System prompt hint to use tools directly
 * - Slightly lower temperature for tool calling consistency
 */
const GPT_OSS_120B: ModelProfile = {
  modelId: 'gpt-oss:120b',
  displayName: 'GPT-OSS 120B',
  family: 'gpt-oss',
  systemPromptHint: [
    'When a task requires system interaction, use the available tools directly.',
    'Do not describe what you would do — execute it.',
    'Prefer a single comprehensive command over multiple small ones when safe to do so.',
    'Always report tool results concisely.',
    '',
    'Tool routing rules:',
    '- To read a text file: use the read_file tool. Never use bash with cat/head/tail.',
    '- To write a file: use the write_file tool. Never use bash with echo/heredoc/tee.',
    '- To list directory contents: use the list_files tool. Never use bash with ls/find.',
    '- To search file contents: use the search_files tool. Never use bash with grep/rg/ack.',
    '- To read PDF/DOCX/XLSX/CSV: use the read_document tool. Never use bash with pdftotext/csvtool.',
    '- For everything else (system info, CLI tools, process management, network): use bash.',
  ].join('\n'),
  toolOverrides: [
    {
      toolName: 'bash',
      descriptionSuffix: [
        '',
        '',
        'Use when: system info (date, whoami, uname), CLI tools (git, npm, brew, icalbuddy, curl), process management (ps, kill), network operations, or any task without a dedicated tool.',
        'Do NOT use when: reading files (use read_file), writing files (use write_file), listing directories (use list_files), searching file contents (use search_files), or reading documents (use read_document).',
        '',
        'You may chain commands with && or use subshells when it reduces round-trips.',
        'Example: mkdir -p /tmp/test && echo "done" > /tmp/test/status.txt',
      ].join('\n'),
    },
    {
      toolName: 'read_file',
      descriptionSuffix: [
        '',
        '',
        'Use when: reading any plain text file (.txt, .md, .ts, .js, .json, .yaml, .log, config files, source code).',
        'Do NOT use when: reading binary documents like PDF, DOCX, XLSX, CSV (use read_document instead).',
        'Always prefer this over bash cat/head/tail.',
      ].join('\n'),
    },
    {
      toolName: 'write_file',
      descriptionSuffix: [
        '',
        '',
        'Use when: creating or updating any text file.',
        'Do NOT use when: you need to append to a shell history or pipe output (use bash instead).',
        'Always prefer this over bash echo/heredoc/tee.',
      ].join('\n'),
    },
    {
      toolName: 'list_files',
      descriptionSuffix: [
        '',
        '',
        'Use when: listing directory contents, finding files by glob pattern, checking if files exist.',
        'Do NOT use when: searching inside file contents for a text pattern (use search_files instead).',
        'Always prefer this over bash ls/find.',
      ].join('\n'),
    },
    {
      toolName: 'search_files',
      descriptionSuffix: [
        '',
        '',
        'Use when: searching for text patterns inside files, finding where a function/variable is defined or used.',
        'Do NOT use when: just listing files in a directory (use list_files) or reading a known file (use read_file).',
        'Always prefer this over bash grep/rg/ack.',
      ].join('\n'),
    },
    {
      toolName: 'read_document',
      descriptionSuffix: [
        '',
        '',
        'Use when: reading PDF, DOCX, XLSX, XLS, or CSV files.',
        'Do NOT use when: reading plain text files like .txt, .md, .json, .ts (use read_file instead).',
      ].join('\n'),
    },
  ],
  generation: {
    temperature: 0.6,
    numPredict: 2048,
  },
  responseHints: [
    {
      pattern: '```tool_call\\n[\\s\\S]*?```',
      replacement: '',
      reason: 'gpt-oss sometimes wraps tool calls in markdown code blocks',
    },
  ],
};

/**
 * hermes3:70b profile (family: hermes).
 * Baseline — no overrides.
 */
const HERMES3_70B: ModelProfile = {
  modelId: 'hermes3:70b',
  displayName: 'Hermes 3 70B',
  family: 'hermes',
  generation: {
    temperature: 0.7,
    numPredict: 2048,
  },
};

/**
 * qwen3-coder-next profile (family: qwen).
 * Coding-specialized model. Low temperature for precision.
 */
const QWEN3_CODER: ModelProfile = {
  modelId: 'qwen3-coder-next:latest',
  displayName: 'Qwen3 Coder Next',
  family: 'qwen',
  generation: {
    temperature: 0.1,
    numPredict: 4096,
  },
  systemPromptHint: 'Focus on code correctness and completeness. Use the write_file tool for code output rather than putting code in your text response.',
};

/** All built-in profiles indexed by model ID */
const BUILT_IN_PROFILES = new Map<string, ModelProfile>([
  [GPT_OSS_120B.modelId, GPT_OSS_120B],
  [HERMES3_70B.modelId, HERMES3_70B],
  [QWEN3_CODER.modelId, QWEN3_CODER],
]);

// ─── Config Loading ──────────────────────────────────────────────────────────

interface ProfileYamlEntry {
  modelId: string;
  displayName?: string | undefined;
  family?: string | undefined;
  systemPromptHint?: string | undefined;
  toolOverrides?: ToolDescriptionOverride[] | undefined;
  generation?: ModelGenerationParams | undefined;
  responseHints?: ResponseParsingHint[] | undefined;
  metadata?: Record<string, unknown> | undefined;
}

interface ProfilesYaml {
  profiles: ProfileYamlEntry[];
}

/**
 * Load custom profiles from config/model-profiles.yaml.
 * Returns empty array if file does not exist.
 */
function loadProfilesFromYaml(
  configPath = 'config/model-profiles.yaml',
): ModelProfile[] {
  const absolutePath = resolve(configPath);
  if (!existsSync(absolutePath)) {
    return [];
  }

  try {
    const raw = readFileSync(absolutePath, 'utf8');
    const parsed = YAML.parse(raw) as ProfilesYaml | null;
    if (!parsed?.profiles || !Array.isArray(parsed.profiles)) {
      return [];
    }

    return parsed.profiles.map((entry): ModelProfile => ({
      modelId: entry.modelId,
      displayName: entry.displayName ?? entry.modelId,
      family: entry.family,
      systemPromptHint: entry.systemPromptHint,
      toolOverrides: entry.toolOverrides,
      generation: entry.generation,
      responseHints: entry.responseHints,
      metadata: entry.metadata,
    }));
  } catch (error) {
    safeLogger.warn('Failed to load model profiles from YAML', {
      path: absolutePath,
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

// ─── Profile Resolution ─────────────────────────────────────────────────────

/**
 * Resolve the profile for a given model ID.
 *
 * Priority:
 * 1. Custom YAML profiles (user overrides)
 * 2. Built-in profiles (exact match)
 * 3. Family-based fallback (e.g., 'gpt-oss:240b' matches 'gpt-oss' family)
 * 4. DEFAULT_PROFILE (no-op)
 */
export function resolveModelProfile(
  modelId: string,
  configPath?: string | undefined,
): ModelProfile {
  const customProfiles = loadProfilesFromYaml(configPath);

  // 1. Exact match in custom profiles
  const customMatch = customProfiles.find((p) => p.modelId === modelId);
  if (customMatch) {
    safeLogger.info('Using custom model profile', { modelId, source: 'yaml' });
    return customMatch;
  }

  // 2. Exact match in built-in profiles
  const builtInMatch = BUILT_IN_PROFILES.get(modelId);
  if (builtInMatch) {
    safeLogger.info('Using built-in model profile', { modelId, source: 'built-in' });
    return builtInMatch;
  }

  // 3. Family-based fallback: extract family from modelId
  //    e.g., 'gpt-oss:240b' -> family 'gpt-oss'
  const familyGuess = modelId.split(':')[0];
  if (familyGuess) {
    // Check custom first
    const customFamilyMatch = customProfiles.find((p) => p.family === familyGuess);
    if (customFamilyMatch) {
      safeLogger.info('Using family-matched custom profile', {
        modelId,
        family: familyGuess,
        matchedProfile: customFamilyMatch.modelId,
      });
      return { ...customFamilyMatch, modelId };
    }

    // Check built-in
    for (const profile of BUILT_IN_PROFILES.values()) {
      if (profile.family === familyGuess) {
        safeLogger.info('Using family-matched built-in profile', {
          modelId,
          family: familyGuess,
          matchedProfile: profile.modelId,
        });
        return { ...profile, modelId };
      }
    }
  }

  // 4. Default
  safeLogger.info('Using default model profile', { modelId });
  return { ...DEFAULT_PROFILE, modelId };
}

/**
 * Get a built-in profile by model ID (for testing).
 */
export function getBuiltInProfile(modelId: string): ModelProfile | undefined {
  return BUILT_IN_PROFILES.get(modelId);
}
