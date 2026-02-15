import { describe, expect, it } from 'vitest';

import {
  PROFILES,
  formatDependencyOutputs,
  assembleProfileContext,
  type ContextProfile,
  type DependencyContext,
  type ContextProfileName,
} from '../src/interface/context-profiles.js';

// ═══════════════════════════════════════════════════════════════════════════════
// PROFILES constant
// ═══════════════════════════════════════════════════════════════════════════════

describe('PROFILES', () => {
  it('defines all 5 profiles', () => {
    const names: ContextProfileName[] = ['conversation', 'classifier', 'planner', 'executor', 'verifier'];
    for (const name of names) {
      expect(PROFILES[name]).toBeDefined();
      expect(PROFILES[name].name).toBe(name);
    }
  });

  it('conversation profile has all sections enabled', () => {
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

  it('classifier profile has no sections enabled', () => {
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

  it('planner profile has only safety enabled', () => {
    const ps = PROFILES.planner.promptSections;
    expect(ps.safety).toBe(true);
    expect(ps.identity).toBe(false);
    expect(ps.bootstrap).toBe(false);
    expect(ps.skills).toBe(false);
    expect(ps.memory).toBe(false);
  });

  it('conversation has highest maxHistoryMessages', () => {
    expect(PROFILES.conversation.maxHistoryMessages).toBeGreaterThan(PROFILES.classifier.maxHistoryMessages);
    expect(PROFILES.classifier.maxHistoryMessages).toBe(3);
    expect(PROFILES.planner.maxHistoryMessages).toBe(0);
    expect(PROFILES.executor.maxHistoryMessages).toBe(0);
    expect(PROFILES.verifier.maxHistoryMessages).toBe(0);
  });

  it('all profiles have generation parameters', () => {
    for (const profile of Object.values(PROFILES)) {
      expect(profile.generation.maxTokens).toBeGreaterThan(0);
      expect(profile.generation.temperature).toBeGreaterThanOrEqual(0);
      expect(profile.generation.temperature).toBeLessThanOrEqual(1);
    }
  });

  it('classifier has lowest temperature', () => {
    expect(PROFILES.classifier.generation.temperature).toBeLessThanOrEqual(0.1);
  });

  it('conversation has highest temperature', () => {
    expect(PROFILES.conversation.generation.temperature).toBeGreaterThan(PROFILES.classifier.generation.temperature);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// formatDependencyOutputs
// ═══════════════════════════════════════════════════════════════════════════════

describe('formatDependencyOutputs', () => {
  it('returns empty string for empty array', () => {
    expect(formatDependencyOutputs([], 500)).toBe('');
  });

  it('returns empty string when all outputs are empty', () => {
    const deps: DependencyContext[] = [
      { stepId: 'step-1', tool: 'bash', output: '' },
    ];
    expect(formatDependencyOutputs(deps, 500)).toBe('');
  });

  it('formats single dependency', () => {
    const deps: DependencyContext[] = [
      { stepId: 'step-1', tool: 'bash', output: 'hello world' },
    ];
    const result = formatDependencyOutputs(deps, 500);
    expect(result).toContain('## Upstream Results');
    expect(result).toContain('step-1 (bash)');
    expect(result).toContain('hello world');
  });

  it('formats multiple dependencies', () => {
    const deps: DependencyContext[] = [
      { stepId: 'step-1', tool: 'bash', output: 'first output' },
      { stepId: 'step-2', tool: 'read_file', output: 'file content' },
    ];
    const result = formatDependencyOutputs(deps, 500);
    expect(result).toContain('step-1 (bash)');
    expect(result).toContain('step-2 (read_file)');
    expect(result).toContain('first output');
    expect(result).toContain('file content');
  });

  it('truncates long outputs', () => {
    const deps: DependencyContext[] = [
      { stepId: 'step-1', tool: 'bash', output: 'x'.repeat(10000) },
    ];
    const result = formatDependencyOutputs(deps, 100);
    expect(result).toContain('[truncated]');
    expect(result.length).toBeLessThan(10000);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// assembleProfileContext
// ═══════════════════════════════════════════════════════════════════════════════

describe('assembleProfileContext', () => {
  it('assembles context with just a prompt', () => {
    const result = assembleProfileContext({
      profile: PROFILES.classifier,
      prompt: 'Classify this message',
    });

    expect(result.prompt).toContain('Classify this message');
    expect(result.profileName).toBe('classifier');
    expect(result.generation).toEqual(PROFILES.classifier.generation);
    expect(result.estimatedTokens).toBeGreaterThan(0);
  });

  it('includes history when profile allows it', () => {
    const result = assembleProfileContext({
      profile: PROFILES.classifier, // maxHistoryMessages: 3
      prompt: 'Current message',
      history: ['User: Hello', 'Assistant: Hi', 'User: How are you?', 'Assistant: Good!'],
    });

    // Should trim to last 3
    expect(result.prompt).toContain('Recent conversation:');
    expect(result.prompt).toContain('How are you?');
    expect(result.prompt).toContain('Good!');
  });

  it('excludes history when profile disallows it', () => {
    const result = assembleProfileContext({
      profile: PROFILES.planner, // maxHistoryMessages: 0
      prompt: 'Plan this task',
      history: ['User: Hello', 'Assistant: Hi'],
    });

    expect(result.prompt).not.toContain('Recent conversation:');
    expect(result.prompt).not.toContain('Hello');
  });

  it('includes dependency outputs', () => {
    const deps: DependencyContext[] = [
      { stepId: 'step-1', tool: 'bash', output: 'file list here' },
    ];

    const result = assembleProfileContext({
      profile: PROFILES.executor,
      prompt: 'Execute this step',
      dependencies: deps,
    });

    expect(result.prompt).toContain('Upstream Results');
    expect(result.prompt).toContain('file list here');
  });

  it('includes additional context', () => {
    const result = assembleProfileContext({
      profile: PROFILES.planner,
      prompt: 'Create a plan',
      additionalContext: ['Available tools: bash, read_file', 'Max steps: 5'],
    });

    expect(result.prompt).toContain('Available tools: bash, read_file');
    expect(result.prompt).toContain('Max steps: 5');
  });

  it('uses systemPromptOverride when provided', () => {
    const customProfile: ContextProfile = {
      ...PROFILES.classifier,
      systemPromptOverride: 'Custom system prompt',
    };

    const result = assembleProfileContext({
      profile: customProfile,
      prompt: 'Test',
    });

    expect(result.systemPrompt).toBe('Custom system prompt');
  });

  it('returns empty system prompt for no override and no sections', () => {
    const result = assembleProfileContext({
      profile: PROFILES.classifier, // no sections, no override
      prompt: 'Test',
    });

    expect(result.systemPrompt).toBe('');
  });
});
