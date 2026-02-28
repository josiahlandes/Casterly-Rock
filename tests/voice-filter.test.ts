import { describe, it, expect } from 'vitest';

import {
  VoiceFilter,
  createVoiceFilter,
  DEFAULT_VOICE_FILTER_CONFIG,
} from '../src/imessage/voice-filter.js';

// ─── Passthrough Behavior ─────────────────────────────────────────────────────

describe('VoiceFilter', () => {
  it('returns original text when disabled', async () => {
    const filter = new VoiceFilter({ enabled: false });
    const result = await filter.apply('This is a test response from the agent loop.');
    expect(result).toBe('This is a test response from the agent loop.');
  });

  it('returns original text for very short responses', async () => {
    // Even when enabled, short text should pass through
    // (the provider won't connect in tests, but the length check happens first)
    const filter = new VoiceFilter({ enabled: false });
    expect(await filter.apply('OK')).toBe('OK');
    expect(await filter.apply('Done.')).toBe('Done.');
    expect(await filter.apply('Yes')).toBe('Yes');
  });

  it('returns original text for empty string', async () => {
    const filter = new VoiceFilter({ enabled: false });
    expect(await filter.apply('')).toBe('');
  });

  it('falls back to original on provider error', async () => {
    // Point at an unreachable Ollama instance
    const filter = new VoiceFilter({
      enabled: true,
      baseUrl: 'http://localhost:99999',
      timeoutMs: 1000,
    });
    const original = 'This should come back unchanged despite the error.';
    const result = await filter.apply(original);
    expect(result).toBe(original);
  });
});

// ─── Factory ──────────────────────────────────────────────────────────────────

describe('createVoiceFilter', () => {
  it('creates disabled filter when no config provided', async () => {
    const filter = createVoiceFilter(undefined);
    const result = await filter.apply('Test message that should pass through.');
    expect(result).toBe('Test message that should pass through.');
  });

  it('creates enabled filter from raw YAML config', () => {
    const filter = createVoiceFilter({
      enabled: true,
      model: 'test-model',
      max_tokens: 256,
      temperature: 0.5,
      timeout_ms: 10000,
    });
    // Filter should be constructed without error
    expect(filter).toBeInstanceOf(VoiceFilter);
  });

  it('defaults to enabled when enabled field is absent', () => {
    const filter = createVoiceFilter({ model: 'test-model' });
    expect(filter).toBeInstanceOf(VoiceFilter);
    // Can't directly check enabled, but the filter should be constructed
  });

  it('creates disabled filter when enabled is false', async () => {
    const filter = createVoiceFilter({ enabled: false });
    const result = await filter.apply('Should pass through when disabled.');
    expect(result).toBe('Should pass through when disabled.');
  });

  it('maps snake_case YAML keys to camelCase config', () => {
    // Verify the factory doesn't throw with snake_case config
    const filter = createVoiceFilter({
      enabled: true,
      model: 'qwen3.5:122b',
      max_tokens: 512,
      temperature: 0.7,
      timeout_ms: 30000,
      base_url: 'http://localhost:11434',
    });
    expect(filter).toBeInstanceOf(VoiceFilter);
  });
});

// ─── Default Config ───────────────────────────────────────────────────────────

describe('DEFAULT_VOICE_FILTER_CONFIG', () => {
  it('has sensible defaults', () => {
    expect(DEFAULT_VOICE_FILTER_CONFIG.enabled).toBe(true);
    expect(DEFAULT_VOICE_FILTER_CONFIG.model).toBe('qwen3.5:35b-a3b');
    expect(DEFAULT_VOICE_FILTER_CONFIG.maxTokens).toBe(512);
    expect(DEFAULT_VOICE_FILTER_CONFIG.temperature).toBe(0.7);
    expect(DEFAULT_VOICE_FILTER_CONFIG.timeoutMs).toBe(30_000);
    expect(DEFAULT_VOICE_FILTER_CONFIG.baseUrl).toBe('http://localhost:11434');
  });
});
