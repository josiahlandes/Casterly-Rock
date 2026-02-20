import { describe, expect, it } from 'vitest';

import {
  matchSensitiveCategories,
  SENSITIVE_PATTERNS,
  type SensitiveCategory,
} from '../src/security/patterns.js';

import {
  detectSensitiveContent,
} from '../src/security/detector.js';

// ═══════════════════════════════════════════════════════════════════════════════
// matchSensitiveCategories (patterns.ts)
// ═══════════════════════════════════════════════════════════════════════════════

describe('matchSensitiveCategories', () => {
  // ── Calendar ─────────────────────────────────────────────────────────

  it('detects "my calendar" as calendar', () => {
    expect(matchSensitiveCategories('Check my calendar for tomorrow')).toContain('calendar');
  });

  it('detects "schedule" as calendar', () => {
    expect(matchSensitiveCategories('What is on my schedule today?')).toContain('calendar');
  });

  it('detects "appointment" as calendar', () => {
    expect(matchSensitiveCategories('I have an appointment at 3pm')).toContain('calendar');
  });

  // ── Finances ─────────────────────────────────────────────────────────

  it('detects SSN-like patterns as finances', () => {
    expect(matchSensitiveCategories('My SSN is 123-45-6789')).toContain('finances');
  });

  it('detects "credit card" as finances', () => {
    expect(matchSensitiveCategories('Enter your credit card details')).toContain('finances');
  });

  it('detects "bank account" as finances', () => {
    expect(matchSensitiveCategories('My bank account number is 12345')).toContain('finances');
  });

  it('detects "routing number" as finances', () => {
    expect(matchSensitiveCategories('The routing number is 021000021')).toContain('finances');
  });

  it('detects "transaction" as finances', () => {
    expect(matchSensitiveCategories('Show me the transaction history')).toContain('finances');
  });

  // ── Voice Memos ──────────────────────────────────────────────────────

  it('detects "voice memo" as voice_memos', () => {
    expect(matchSensitiveCategories('Play my voice memo from yesterday')).toContain('voice_memos');
  });

  it('detects "journal" as voice_memos', () => {
    expect(matchSensitiveCategories('Read my journal entry')).toContain('voice_memos');
  });

  it('detects "private note" as voice_memos', () => {
    expect(matchSensitiveCategories('This is a private note')).toContain('voice_memos');
  });

  it('detects "personal note" as voice_memos', () => {
    expect(matchSensitiveCategories('Check my personal note')).toContain('voice_memos');
  });

  // ── Health ───────────────────────────────────────────────────────────

  it('detects "diagnosis" as health', () => {
    expect(matchSensitiveCategories('What was my diagnosis?')).toContain('health');
  });

  it('detects "prescription" as health', () => {
    expect(matchSensitiveCategories('Refill my prescription')).toContain('health');
  });

  it('detects "medical" as health', () => {
    expect(matchSensitiveCategories('Check my medical records')).toContain('health');
  });

  it('detects "health record" as health', () => {
    expect(matchSensitiveCategories('Access my health record')).toContain('health');
  });

  // ── Credentials ──────────────────────────────────────────────────────

  it('detects "password" as credentials', () => {
    expect(matchSensitiveCategories('What is my password for GitHub?')).toContain('credentials');
  });

  it('detects "api_key" as credentials', () => {
    expect(matchSensitiveCategories('Set api_key to xyz')).toContain('credentials');
  });

  it('detects "api-key" as credentials', () => {
    expect(matchSensitiveCategories('My api-key is abc123')).toContain('credentials');
  });

  it('detects bearer tokens as credentials', () => {
    expect(matchSensitiveCategories('Authorization: bearer eyJhbGciOiJIUzI1NiJ9')).toContain('credentials');
  });

  // ── Documents ────────────────────────────────────────────────────────

  it('detects "contract" as documents', () => {
    expect(matchSensitiveCategories('Review the contract')).toContain('documents');
  });

  it('detects "confidential" as documents', () => {
    expect(matchSensitiveCategories('This is confidential information')).toContain('documents');
  });

  it('detects "nda" as documents', () => {
    expect(matchSensitiveCategories('I signed an NDA')).toContain('documents');
  });

  // ── Contacts ─────────────────────────────────────────────────────────

  it('detects "my contact" as contacts', () => {
    expect(matchSensitiveCategories('Find my contact for John')).toContain('contacts');
  });

  it('detects "phone number" as contacts', () => {
    expect(matchSensitiveCategories('What is their phone number?')).toContain('contacts');
  });

  it('detects "address book" as contacts', () => {
    expect(matchSensitiveCategories('Search my address book')).toContain('contacts');
  });

  // ── Edge cases ───────────────────────────────────────────────────────

  it('returns empty array for benign text', () => {
    expect(matchSensitiveCategories('What is the weather like today?')).toEqual([]);
  });

  it('returns empty array for empty string', () => {
    expect(matchSensitiveCategories('')).toEqual([]);
  });

  it('detects multiple categories in one text', () => {
    const result = matchSensitiveCategories(
      'Check my calendar and show my bank account transaction history'
    );
    expect(result).toContain('calendar');
    expect(result).toContain('finances');
  });

  it('is case-insensitive for keyword patterns', () => {
    expect(matchSensitiveCategories('My PASSWORD is secret')).toContain('credentials');
    expect(matchSensitiveCategories('CREDIT CARD number')).toContain('finances');
  });

  it('covers all categories defined in SENSITIVE_PATTERNS', () => {
    const allCategories = Object.keys(SENSITIVE_PATTERNS) as SensitiveCategory[];
    // Ensure every category has at least one pattern
    for (const category of allCategories) {
      expect(SENSITIVE_PATTERNS[category].length).toBeGreaterThan(0);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// detectSensitiveContent (detector.ts)
// ═══════════════════════════════════════════════════════════════════════════════

describe('detectSensitiveContent', () => {
  const defaultOptions: { alwaysLocalCategories: SensitiveCategory[] } = {
    alwaysLocalCategories: ['credentials', 'health', 'finances'],
  };

  // ── Basic detection ──────────────────────────────────────────────────

  it('detects sensitive content and returns isSensitive=true', () => {
    const result = detectSensitiveContent('My password is hunter2', defaultOptions);
    expect(result.isSensitive).toBe(true);
    expect(result.categories).toContain('credentials');
  });

  it('returns isSensitive=false for benign text', () => {
    const result = detectSensitiveContent('Hello, how are you?', defaultOptions);
    expect(result.isSensitive).toBe(false);
    expect(result.categories).toEqual([]);
    expect(result.reasons).toEqual([]);
  });

  // ── Always-local categorization ──────────────────────────────────────

  it('adds always-local reason when category is in alwaysLocalCategories', () => {
    const result = detectSensitiveContent('My SSN is 123-45-6789', defaultOptions);
    expect(result.isSensitive).toBe(true);
    expect(result.categories).toContain('finances');
    expect(result.reasons.length).toBeGreaterThan(0);
    expect(result.reasons[0]).toContain('always-local');
  });

  it('adds pattern-match reason for non-always-local categories', () => {
    const options: { alwaysLocalCategories: SensitiveCategory[] } = {
      alwaysLocalCategories: [], // Nothing is always-local
    };
    const result = detectSensitiveContent('Check my calendar', options);
    expect(result.isSensitive).toBe(true);
    expect(result.categories).toContain('calendar');
    expect(result.reasons[0]).toContain('sensitive patterns');
  });

  it('handles mixed always-local and non-always-local categories', () => {
    // "password" is credentials (always-local), "calendar" is not always-local
    const options: { alwaysLocalCategories: SensitiveCategory[] } = {
      alwaysLocalCategories: ['credentials'],
    };
    const result = detectSensitiveContent(
      'My password is secret and check my calendar',
      options
    );
    expect(result.isSensitive).toBe(true);
    expect(result.categories).toContain('credentials');
    expect(result.categories).toContain('calendar');
    // Should have the always-local reason for credentials
    expect(result.reasons.some((r) => r.includes('always-local'))).toBe(true);
  });

  // ── Options variations ───────────────────────────────────────────────

  it('works with empty alwaysLocalCategories', () => {
    const options: { alwaysLocalCategories: SensitiveCategory[] } = {
      alwaysLocalCategories: [],
    };
    const result = detectSensitiveContent('My diagnosis was positive', options);
    expect(result.isSensitive).toBe(true);
    expect(result.categories).toContain('health');
    // With no always-local categories, reason should be "sensitive patterns"
    expect(result.reasons[0]).toContain('sensitive patterns');
  });

  it('works with all categories as always-local', () => {
    const allCategories: SensitiveCategory[] = [
      'calendar', 'finances', 'voice_memos', 'health', 'credentials', 'documents', 'contacts', 'location',
    ];
    const options: { alwaysLocalCategories: SensitiveCategory[] } = {
      alwaysLocalCategories: allCategories,
    };
    const result = detectSensitiveContent('Check my schedule', options);
    expect(result.isSensitive).toBe(true);
    expect(result.reasons[0]).toContain('always-local');
  });

  // ── Multiple categories ──────────────────────────────────────────────

  it('returns all matched categories', () => {
    const result = detectSensitiveContent(
      'Show me my bank account transaction and my health record',
      defaultOptions
    );
    expect(result.categories).toContain('finances');
    expect(result.categories).toContain('health');
    expect(result.categories.length).toBeGreaterThanOrEqual(2);
  });

  // ── Empty / edge inputs ──────────────────────────────────────────────

  it('handles empty string', () => {
    const result = detectSensitiveContent('', defaultOptions);
    expect(result.isSensitive).toBe(false);
    expect(result.categories).toEqual([]);
  });

  it('handles very long text without crashing', () => {
    const longText = 'Hello world '.repeat(10000);
    const result = detectSensitiveContent(longText, defaultOptions);
    expect(result.isSensitive).toBe(false);
  });

  it('handles text with only whitespace', () => {
    const result = detectSensitiveContent('   \n\t  ', defaultOptions);
    expect(result.isSensitive).toBe(false);
  });
});
