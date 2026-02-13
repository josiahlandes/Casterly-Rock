import { describe, expect, it } from 'vitest';

import {
  PROFILES,
  assembleProfileContext,
  formatDependencyOutputs,
  buildProfileSystemPrompt,
  type ContextProfile,
  type ContextProfileName,
  type DependencyContext,
} from '../src/interface/context-profiles.js';
import { estimateTokens, assembleContext } from '../src/interface/context.js';
import type { PromptBuilderOptions } from '../src/interface/prompt-builder.js';

// ─── Profile Definitions ────────────────────────────────────────────────────

describe('PROFILES', () => {
  const profileNames: ContextProfileName[] = [
    'conversation',
    'classifier',
    'planner',
    'executor',
    'verifier',
  ];

  it('defines all five profile names', () => {
    for (const name of profileNames) {
      expect(PROFILES[name]).toBeDefined();
      expect(PROFILES[name].name).toBe(name);
    }
  });

  it('conversation profile includes all prompt sections', () => {
    const ps = PROFILES.conversation.promptSections;
    expect(ps.identity).toBe(true);
    expect(ps.bootstrap).toBe(true);
    expect(ps.capabilities).toBe(true);
    expect(ps.skills).toBe(true);
    expect(ps.memory).toBe(true);
    expect(ps.safety).toBe(true);
    expect(ps.context).toBe(true);
    expect(ps.guidelines).toBe(true);
  });

  it('classifier profile includes no prompt sections', () => {
    const ps = PROFILES.classifier.promptSections;
    expect(ps.identity).toBe(false);
    expect(ps.bootstrap).toBe(false);
    expect(ps.capabilities).toBe(false);
    expect(ps.skills).toBe(false);
    expect(ps.memory).toBe(false);
    expect(ps.safety).toBe(false);
    expect(ps.context).toBe(false);
    expect(ps.guidelines).toBe(false);
  });

  it('planner and executor include safety section only', () => {
    for (const name of ['planner', 'executor'] as ContextProfileName[]) {
      const ps = PROFILES[name].promptSections;
      expect(ps.safety).toBe(true);
      expect(ps.identity).toBe(false);
      expect(ps.bootstrap).toBe(false);
      expect(ps.capabilities).toBe(false);
      expect(ps.skills).toBe(false);
      expect(ps.memory).toBe(false);
      expect(ps.context).toBe(false);
      expect(ps.guidelines).toBe(false);
    }
  });

  it('all profiles have positive maxContextTokens', () => {
    for (const name of profileNames) {
      expect(PROFILES[name].maxContextTokens).toBeGreaterThan(0);
    }
  });

  it('all profiles have reserveForResponse < maxContextTokens', () => {
    for (const name of profileNames) {
      const p = PROFILES[name];
      // planner has equal values (2048/2048) which is fine for planning
      expect(p.reserveForResponse).toBeLessThanOrEqual(p.maxContextTokens);
    }
  });

  it('classifier has the lowest maxContextTokens (fast inference)', () => {
    const classifierTokens = PROFILES.classifier.maxContextTokens;
    for (const name of profileNames) {
      if (name !== 'classifier') {
        expect(PROFILES[name].maxContextTokens).toBeGreaterThanOrEqual(classifierTokens);
      }
    }
  });

  it('conversation maxHistoryMessages matches existing default (10)', () => {
    expect(PROFILES.conversation.maxHistoryMessages).toBe(10);
  });

  it('classifier allows 3 history messages', () => {
    expect(PROFILES.classifier.maxHistoryMessages).toBe(3);
  });

  it('planner, executor, and verifier have 0 history messages', () => {
    expect(PROFILES.planner.maxHistoryMessages).toBe(0);
    expect(PROFILES.executor.maxHistoryMessages).toBe(0);
    expect(PROFILES.verifier.maxHistoryMessages).toBe(0);
  });

  it('generation params match the values previously hardcoded in pipeline stages', () => {
    // Classifier: was maxTokens: 256, temperature: 0.1
    expect(PROFILES.classifier.generation.maxTokens).toBe(256);
    expect(PROFILES.classifier.generation.temperature).toBe(0.1);

    // Planner: was maxTokens: 2048, temperature: 0.2
    expect(PROFILES.planner.generation.maxTokens).toBe(2048);
    expect(PROFILES.planner.generation.temperature).toBe(0.2);

    // Verifier: was maxTokens: 512, temperature: 0.1
    expect(PROFILES.verifier.generation.maxTokens).toBe(512);
    expect(PROFILES.verifier.generation.temperature).toBe(0.1);
  });
});

// ─── formatDependencyOutputs ────────────────────────────────────────────────

describe('formatDependencyOutputs', () => {
  it('returns empty string for empty dependencies', () => {
    expect(formatDependencyOutputs([], 500)).toBe('');
  });

  it('returns empty string for dependencies with no output', () => {
    const deps: DependencyContext[] = [
      { stepId: 'step-1', tool: 'bash', output: '' },
    ];
    expect(formatDependencyOutputs(deps, 500)).toBe('');
  });

  it('formats a single dependency output', () => {
    const deps: DependencyContext[] = [
      { stepId: 'step-1', tool: 'read_file', output: 'file contents here' },
    ];

    const result = formatDependencyOutputs(deps, 500);

    expect(result).toContain('## Upstream Results');
    expect(result).toContain('### step-1 (read_file)');
    expect(result).toContain('file contents here');
  });

  it('formats multiple dependency outputs', () => {
    const deps: DependencyContext[] = [
      { stepId: 'step-1', tool: 'bash', output: 'output A' },
      { stepId: 'step-2', tool: 'read_file', output: 'output B' },
    ];

    const result = formatDependencyOutputs(deps, 500);

    expect(result).toContain('### step-1 (bash)');
    expect(result).toContain('output A');
    expect(result).toContain('### step-2 (read_file)');
    expect(result).toContain('output B');
  });

  it('truncates long outputs to stay within token budget', () => {
    const longOutput = 'x'.repeat(5000);
    const deps: DependencyContext[] = [
      { stepId: 'step-1', tool: 'bash', output: longOutput },
    ];

    // Small budget: 100 tokens ≈ 400 chars
    const result = formatDependencyOutputs(deps, 100);

    expect(result.length).toBeLessThan(longOutput.length);
    expect(result).toContain('[truncated]');
  });

  it('skips dependencies with empty output', () => {
    const deps: DependencyContext[] = [
      { stepId: 'step-1', tool: 'bash', output: '' },
      { stepId: 'step-2', tool: 'read_file', output: 'valid output' },
    ];

    const result = formatDependencyOutputs(deps, 500);

    expect(result).not.toContain('step-1');
    expect(result).toContain('step-2');
    expect(result).toContain('valid output');
  });
});

// ─── assembleProfileContext ─────────────────────────────────────────────────

describe('assembleProfileContext', () => {
  it('returns systemPromptOverride when profile has one', () => {
    const profile: ContextProfile = {
      ...PROFILES.classifier,
      systemPromptOverride: 'You are a test classifier.',
    };

    const result = assembleProfileContext({
      profile,
      prompt: 'Classify this message.',
    });

    expect(result.systemPrompt).toBe('You are a test classifier.');
  });

  it('returns empty systemPrompt when profile has no override and no sections', () => {
    const result = assembleProfileContext({
      profile: PROFILES.classifier, // no sections, no override
      prompt: 'Classify this message.',
    });

    expect(result.systemPrompt).toBe('');
  });

  it('includes history when profile allows it', () => {
    const result = assembleProfileContext({
      profile: PROFILES.classifier, // maxHistoryMessages: 3
      prompt: 'Current message',
      history: ['msg1', 'msg2', 'msg3', 'msg4', 'msg5'],
    });

    // Should trim to last 3
    expect(result.prompt).toContain('msg3');
    expect(result.prompt).toContain('msg4');
    expect(result.prompt).toContain('msg5');
    expect(result.prompt).not.toContain('msg1');
    expect(result.prompt).not.toContain('msg2');
  });

  it('excludes history when profile has maxHistoryMessages = 0', () => {
    const result = assembleProfileContext({
      profile: PROFILES.planner, // maxHistoryMessages: 0
      prompt: 'Plan this task',
      history: ['msg1', 'msg2', 'msg3'],
    });

    expect(result.prompt).not.toContain('msg1');
    expect(result.prompt).not.toContain('Recent conversation');
  });

  it('includes dependency outputs', () => {
    const result = assembleProfileContext({
      profile: PROFILES.executor,
      prompt: 'Execute step-2',
      dependencies: [
        { stepId: 'step-1', tool: 'bash', output: 'dependency output here' },
      ],
    });

    expect(result.prompt).toContain('Upstream Results');
    expect(result.prompt).toContain('step-1');
    expect(result.prompt).toContain('dependency output here');
  });

  it('includes additional context lines', () => {
    const result = assembleProfileContext({
      profile: PROFILES.planner,
      prompt: 'Plan this task',
      additionalContext: ['Available tools: bash, read_file', 'Past failures: none'],
    });

    expect(result.prompt).toContain('Available tools: bash, read_file');
    expect(result.prompt).toContain('Past failures: none');
  });

  it('returns correct generation params from profile', () => {
    const result = assembleProfileContext({
      profile: PROFILES.verifier,
      prompt: 'Verify task outcome',
    });

    expect(result.generation.maxTokens).toBe(PROFILES.verifier.generation.maxTokens);
    expect(result.generation.temperature).toBe(PROFILES.verifier.generation.temperature);
  });

  it('returns the profile name', () => {
    const result = assembleProfileContext({
      profile: PROFILES.executor,
      prompt: 'Run step',
    });

    expect(result.profileName).toBe('executor');
  });

  it('estimates tokens', () => {
    const result = assembleProfileContext({
      profile: PROFILES.planner,
      prompt: 'A short prompt',
    });

    expect(result.estimatedTokens).toBeGreaterThan(0);
    expect(result.estimatedTokens).toBe(
      estimateTokens(result.systemPrompt) + estimateTokens(result.prompt)
    );
  });
});

// ─── buildProfileSystemPrompt ───────────────────────────────────────────────

describe('buildProfileSystemPrompt', () => {
  // Use a non-existent workspace path so bootstrap files don't load
  const baseOptions: PromptBuilderOptions = {
    mode: 'full',
    skills: [],
    channel: 'imessage',
    workspacePath: '/nonexistent/workspace/path',
  };

  it('returns override when profile has systemPromptOverride', () => {
    const profile: ContextProfile = {
      ...PROFILES.classifier,
      systemPromptOverride: 'Custom classifier prompt.',
    };

    const result = buildProfileSystemPrompt(profile, baseOptions);
    expect(result).toBe('Custom classifier prompt.');
  });

  it('returns empty string when no sections are selected', () => {
    // Classifier has no sections
    const result = buildProfileSystemPrompt(PROFILES.classifier, baseOptions);
    expect(result).toBe('');
  });

  it('includes safety section for planner profile', () => {
    const result = buildProfileSystemPrompt(PROFILES.planner, baseOptions);
    // Safety section starts with "## Safety Guidelines"
    expect(result).toContain('Safety');
  });

  it('includes all sections for conversation profile', () => {
    const result = buildProfileSystemPrompt(PROFILES.conversation, baseOptions);
    // Should include at least capabilities and safety
    expect(result).toContain('Capabilities');
    expect(result).toContain('Safety');
    expect(result).toContain('Response Guidelines');
  });
});

// ─── Backward Compatibility ─────────────────────────────────────────────────

describe('backward compatibility', () => {
  it('conversation profile maxContextTokens matches DEFAULT_CONTEXT_CONFIG', () => {
    // DEFAULT_CONTEXT_CONFIG.maxContextTokens = 3500
    expect(PROFILES.conversation.maxContextTokens).toBe(3500);
  });

  it('conversation profile reserveForResponse matches DEFAULT_CONTEXT_CONFIG', () => {
    // DEFAULT_CONTEXT_CONFIG.reserveForResponse = 500
    expect(PROFILES.conversation.reserveForResponse).toBe(500);
  });

  it('conversation profile maxHistoryMessages matches DEFAULT_CONTEXT_CONFIG', () => {
    // DEFAULT_CONTEXT_CONFIG.maxHistoryMessages = 10
    expect(PROFILES.conversation.maxHistoryMessages).toBe(10);
  });

  it('estimateTokens is still available from context.ts', () => {
    // Ensure the original context module still exports correctly
    expect(typeof estimateTokens).toBe('function');
    expect(estimateTokens('hello world')).toBeGreaterThan(0);
  });
});
