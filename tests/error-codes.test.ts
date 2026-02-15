import { describe, expect, it } from 'vitest';

import {
  ERROR_CODES,
  CasterlyError,
  createError,
  wrapError,
  formatErrorForUser,
  isRecoverable,
  shouldRetry,
  getErrorDefinition,
  listErrorsByCategory,
} from '../src/errors/codes.js';

// ═══════════════════════════════════════════════════════════════════════════════
// ERROR_CODES constant
// ═══════════════════════════════════════════════════════════════════════════════

describe('ERROR_CODES', () => {
  it('defines provider error codes (E1xx)', () => {
    expect(ERROR_CODES.E100).toBeDefined();
    expect(ERROR_CODES.E100!.category).toBe('Provider');
    expect(ERROR_CODES.E101).toBeDefined();
    expect(ERROR_CODES.E102).toBeDefined();
    expect(ERROR_CODES.E103).toBeDefined();
    expect(ERROR_CODES.E104).toBeDefined();
  });

  it('defines tool error codes (E3xx)', () => {
    expect(ERROR_CODES.E300).toBeDefined();
    expect(ERROR_CODES.E300!.category).toBe('Tools');
    expect(ERROR_CODES.E301).toBeDefined();
    expect(ERROR_CODES.E302).toBeDefined();
  });

  it('defines config error codes (E4xx)', () => {
    expect(ERROR_CODES.E400).toBeDefined();
    expect(ERROR_CODES.E400!.category).toBe('Config');
  });

  it('defines network error codes (E5xx)', () => {
    expect(ERROR_CODES.E500).toBeDefined();
    expect(ERROR_CODES.E500!.category).toBe('Network');
  });

  it('defines security error codes (E6xx)', () => {
    expect(ERROR_CODES.E600).toBeDefined();
    expect(ERROR_CODES.E600!.category).toBe('Security');
  });

  it('defines session error codes (E7xx)', () => {
    expect(ERROR_CODES.E700).toBeDefined();
    expect(ERROR_CODES.E700!.category).toBe('Session');
  });

  it('defines memory error codes (E8xx)', () => {
    expect(ERROR_CODES.E800).toBeDefined();
    expect(ERROR_CODES.E800!.category).toBe('Memory');
  });

  it('defines skill error codes (E9xx)', () => {
    expect(ERROR_CODES.E900).toBeDefined();
    expect(ERROR_CODES.E900!.category).toBe('Skills');
  });

  it('all definitions have required fields', () => {
    for (const [key, def] of Object.entries(ERROR_CODES)) {
      expect(def.code).toBe(key);
      expect(def.category).toBeTruthy();
      expect(def.message).toBeTruthy();
      expect(def.suggestion).toBeTruthy();
      expect(['warning', 'error', 'critical']).toContain(def.severity);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// CasterlyError class
// ═══════════════════════════════════════════════════════════════════════════════

describe('CasterlyError', () => {
  it('creates error from known code', () => {
    const err = new CasterlyError('E100');
    expect(err.code).toBe('E100');
    expect(err.category).toBe('Provider');
    expect(err.message).toBe('No providers available');
    expect(err.suggestion).toContain('Ollama');
    expect(err.severity).toBe('critical');
    expect(err.name).toBe('CasterlyError');
    expect(err.timestamp).toBeTruthy();
  });

  it('creates error from unknown code', () => {
    const err = new CasterlyError('E999');
    expect(err.code).toBe('E999');
    expect(err.category).toBe('Unknown');
    expect(err.message).toBe('An unexpected error occurred');
    expect(err.severity).toBe('error');
  });

  it('attaches details', () => {
    const err = new CasterlyError('E100', { model: 'gpt-oss:120b' });
    expect(err.details).toEqual({ model: 'gpt-oss:120b' });
  });

  it('preserves original error stack', () => {
    const original = new Error('Connection failed');
    const err = new CasterlyError('E500', undefined, original);
    expect(err.stack).toContain('Caused by:');
    expect(err.stack).toContain('Connection failed');
  });

  it('toUserMessage formats correctly', () => {
    const err = new CasterlyError('E101');
    const msg = err.toUserMessage();
    expect(msg).toContain('[E101]');
    expect(msg).toContain('Ollama service not running');
    expect(msg).toContain('→');
    expect(msg).toContain('Start Ollama');
  });

  it('toShortMessage formats for iMessage', () => {
    const err = new CasterlyError('E101');
    const msg = err.toShortMessage();
    expect(msg).toContain('Error E101:');
    expect(msg).toContain('Start Ollama');
  });

  it('toLogMessage includes timestamp and severity', () => {
    const err = new CasterlyError('E102', { model: 'missing-model' });
    const log = err.toLogMessage();
    expect(log).toContain('E102');
    expect(log).toContain('Provider');
    expect(log).toContain('Severity:');
    expect(log).toContain('Details:');
    expect(log).toContain('missing-model');
  });

  it('toLogMessage omits details when absent', () => {
    const err = new CasterlyError('E100');
    const log = err.toLogMessage();
    expect(log).not.toContain('Details:');
  });

  it('toJSON returns structured data', () => {
    const err = new CasterlyError('E100', { key: 'value' });
    const json = err.toJSON();
    expect(json.code).toBe('E100');
    expect(json.category).toBe('Provider');
    expect(json.message).toBe('No providers available');
    expect(json.suggestion).toBeTruthy();
    expect(json.severity).toBe('critical');
    expect(json.details).toEqual({ key: 'value' });
    expect(json.timestamp).toBeTruthy();
  });

  it('is instanceof Error', () => {
    const err = new CasterlyError('E100');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(CasterlyError);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// createError
// ═══════════════════════════════════════════════════════════════════════════════

describe('createError', () => {
  it('creates CasterlyError from code', () => {
    const err = createError('E300');
    expect(err).toBeInstanceOf(CasterlyError);
    expect(err.code).toBe('E300');
    expect(err.category).toBe('Tools');
  });

  it('passes through details and original error', () => {
    const original = new Error('underlying');
    const err = createError('E300', { tool: 'bash' }, original);
    expect(err.details).toEqual({ tool: 'bash' });
    expect(err.stack).toContain('Caused by:');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// wrapError
// ═══════════════════════════════════════════════════════════════════════════════

describe('wrapError', () => {
  it('passes through existing CasterlyError', () => {
    const original = new CasterlyError('E100');
    const wrapped = wrapError(original);
    expect(wrapped).toBe(original);
  });

  it('detects ECONNREFUSED → E500', () => {
    const err = wrapError(new Error('connect ECONNREFUSED 127.0.0.1:11434'));
    expect(err.code).toBe('E500');
  });

  it('detects connection refused → E500', () => {
    const err = wrapError(new Error('Connection refused'));
    expect(err.code).toBe('E500');
  });

  it('detects timeout → E501', () => {
    const err = wrapError(new Error('request timed out after 30s'));
    expect(err.code).toBe('E501');
  });

  it('detects DNS failure → E502', () => {
    const err = wrapError(new Error('getaddrinfo ENOTFOUND localhost'));
    expect(err.code).toBe('E502');
  });

  it('detects model not found → E102', () => {
    const err = wrapError(new Error('model "llama3:70b" not found'));
    expect(err.code).toBe('E102');
  });

  it('detects out of memory → E104', () => {
    const err = wrapError(new Error('out of memory: cannot allocate'));
    expect(err.code).toBe('E104');
  });

  it('detects OOM abbreviation → E104', () => {
    const err = wrapError(new Error('OOM killed'));
    expect(err.code).toBe('E104');
  });

  it('falls back to default code for unknown errors', () => {
    const err = wrapError(new Error('something weird'));
    expect(err.code).toBe('E121');
  });

  it('uses custom fallback code', () => {
    const err = wrapError(new Error('something'), 'E300');
    expect(err.code).toBe('E300');
  });

  it('wraps non-Error values', () => {
    const err = wrapError('string error');
    expect(err).toBeInstanceOf(CasterlyError);
    expect(err.details).toEqual({ originalMessage: 'string error' });
  });

  it('wraps number values', () => {
    const err = wrapError(42);
    expect(err).toBeInstanceOf(CasterlyError);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// formatErrorForUser
// ═══════════════════════════════════════════════════════════════════════════════

describe('formatErrorForUser', () => {
  const err = new CasterlyError('E101');

  it('formats for imessage (short)', () => {
    const msg = formatErrorForUser(err, 'imessage');
    expect(msg).toContain('Error E101:');
  });

  it('formats for cli (full)', () => {
    const msg = formatErrorForUser(err, 'cli');
    expect(msg).toContain('[E101]');
    expect(msg).toContain('→');
  });

  it('formats for http (JSON)', () => {
    const msg = formatErrorForUser(err, 'http');
    const parsed = JSON.parse(msg);
    expect(parsed.code).toBe('E101');
    expect(parsed.category).toBe('Provider');
  });

  it('defaults to cli format', () => {
    const msg = formatErrorForUser(err);
    expect(msg).toContain('[E101]');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// isRecoverable / shouldRetry
// ═══════════════════════════════════════════════════════════════════════════════

describe('isRecoverable', () => {
  it('returns true for warning severity', () => {
    expect(isRecoverable(new CasterlyError('E103'))).toBe(true); // timeout = warning
  });

  it('returns false for error severity', () => {
    expect(isRecoverable(new CasterlyError('E101'))).toBe(false); // not running = error
  });

  it('returns false for critical severity', () => {
    expect(isRecoverable(new CasterlyError('E100'))).toBe(false); // no providers = critical
  });
});

describe('shouldRetry', () => {
  it('returns true for retryable codes', () => {
    expect(shouldRetry(new CasterlyError('E103'))).toBe(true); // Ollama timeout
    expect(shouldRetry(new CasterlyError('E302'))).toBe(true); // Tool timeout
    expect(shouldRetry(new CasterlyError('E501'))).toBe(true); // Connection timeout
  });

  it('returns false for non-retryable codes', () => {
    expect(shouldRetry(new CasterlyError('E100'))).toBe(false);
    expect(shouldRetry(new CasterlyError('E301'))).toBe(false);
    expect(shouldRetry(new CasterlyError('E600'))).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// getErrorDefinition / listErrorsByCategory
// ═══════════════════════════════════════════════════════════════════════════════

describe('getErrorDefinition', () => {
  it('returns definition for known code', () => {
    const def = getErrorDefinition('E100');
    expect(def).toBeDefined();
    expect(def!.code).toBe('E100');
    expect(def!.category).toBe('Provider');
  });

  it('returns undefined for unknown code', () => {
    expect(getErrorDefinition('E999')).toBeUndefined();
  });
});

describe('listErrorsByCategory', () => {
  it('lists all errors when no category', () => {
    const errors = listErrorsByCategory();
    expect(errors.length).toBe(Object.keys(ERROR_CODES).length);
  });

  it('filters by category', () => {
    const providerErrors = listErrorsByCategory('Provider');
    expect(providerErrors.length).toBeGreaterThan(0);
    for (const err of providerErrors) {
      expect(err.category).toBe('Provider');
    }
  });

  it('is case-insensitive', () => {
    const a = listErrorsByCategory('provider');
    const b = listErrorsByCategory('Provider');
    expect(a.length).toBe(b.length);
  });

  it('returns empty for unknown category', () => {
    expect(listErrorsByCategory('Nonexistent')).toEqual([]);
  });
});
