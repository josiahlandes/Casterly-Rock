import { describe, expect, it } from 'vitest';

import {
  matchSensitiveCategories,
  SENSITIVE_PATTERNS,
  type SensitiveCategory,
} from '../src/security/patterns.js';

// ═══════════════════════════════════════════════════════════════════════════════
// SENSITIVE_PATTERNS — constant structure
// ═══════════════════════════════════════════════════════════════════════════════

describe('SENSITIVE_PATTERNS', () => {
  it('defines all eight categories', () => {
    const expected: SensitiveCategory[] = [
      'calendar',
      'finances',
      'voice_memos',
      'health',
      'credentials',
      'documents',
      'contacts',
      'location',
    ];

    for (const cat of expected) {
      expect(SENSITIVE_PATTERNS[cat]).toBeDefined();
      expect(Array.isArray(SENSITIVE_PATTERNS[cat])).toBe(true);
      expect(SENSITIVE_PATTERNS[cat]!.length).toBeGreaterThan(0);
    }
  });

  it('every pattern is a RegExp', () => {
    for (const [, patterns] of Object.entries(SENSITIVE_PATTERNS)) {
      for (const p of patterns) {
        expect(p).toBeInstanceOf(RegExp);
      }
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// matchSensitiveCategories — individual categories
// ═══════════════════════════════════════════════════════════════════════════════

describe('matchSensitiveCategories — calendar', () => {
  it('matches "my calendar" (case insensitive)', () => {
    expect(matchSensitiveCategories('Check my calendar for today')).toContain('calendar');
  });

  it('matches "schedule"', () => {
    expect(matchSensitiveCategories('What is on my schedule?')).toContain('calendar');
  });

  it('matches "appointment"', () => {
    expect(matchSensitiveCategories('I have an appointment at 3pm')).toContain('calendar');
  });
});

describe('matchSensitiveCategories — finances', () => {
  it('matches SSN-like pattern', () => {
    expect(matchSensitiveCategories('My SSN is 123-45-6789')).toContain('finances');
  });

  it('matches "credit card"', () => {
    expect(matchSensitiveCategories('Enter your credit card details')).toContain('finances');
  });

  it('matches "bank account"', () => {
    expect(matchSensitiveCategories('My bank account number is ...')).toContain('finances');
  });

  it('matches "routing number"', () => {
    expect(matchSensitiveCategories('The routing number is 021000021')).toContain('finances');
  });

  it('matches "transaction"', () => {
    expect(matchSensitiveCategories('Show me recent transactions')).toContain('finances');
  });
});

describe('matchSensitiveCategories — voice_memos', () => {
  it('matches "voice memo"', () => {
    expect(matchSensitiveCategories('Play my latest voice memo')).toContain('voice_memos');
  });

  it('matches "journal"', () => {
    expect(matchSensitiveCategories('Read my journal entry')).toContain('voice_memos');
  });

  it('matches "private note"', () => {
    expect(matchSensitiveCategories('This is a private note')).toContain('voice_memos');
  });

  it('matches "personal note"', () => {
    expect(matchSensitiveCategories('Add a personal note about it')).toContain('voice_memos');
  });
});

describe('matchSensitiveCategories — health', () => {
  it('matches "diagnosis"', () => {
    expect(matchSensitiveCategories('The diagnosis was positive')).toContain('health');
  });

  it('matches "prescription"', () => {
    expect(matchSensitiveCategories('I need a prescription refill')).toContain('health');
  });

  it('matches "medical"', () => {
    expect(matchSensitiveCategories('Fetch my medical records')).toContain('health');
  });

  it('matches "health record"', () => {
    expect(matchSensitiveCategories('Access my health record')).toContain('health');
  });
});

describe('matchSensitiveCategories — credentials', () => {
  it('matches "password"', () => {
    expect(matchSensitiveCategories('My password is secret123')).toContain('credentials');
  });

  it('matches "api_key"', () => {
    expect(matchSensitiveCategories('Set the api_key to ABC')).toContain('credentials');
  });

  it('matches "api-key"', () => {
    expect(matchSensitiveCategories('Use api-key XYZ')).toContain('credentials');
  });

  it('matches "apikey"', () => {
    expect(matchSensitiveCategories('Store the apikey value')).toContain('credentials');
  });

  it('matches bearer token', () => {
    expect(matchSensitiveCategories('Authorization: Bearer eyJhbGciOi...')).toContain('credentials');
  });
});

describe('matchSensitiveCategories — documents', () => {
  it('matches "contract"', () => {
    expect(matchSensitiveCategories('Review the contract terms')).toContain('documents');
  });

  it('matches "confidential"', () => {
    expect(matchSensitiveCategories('This is confidential information')).toContain('documents');
  });

  it('matches "private document"', () => {
    expect(matchSensitiveCategories('Share the private document')).toContain('documents');
  });

  it('matches "nda"', () => {
    expect(matchSensitiveCategories('Sign the NDA before joining')).toContain('documents');
  });
});

describe('matchSensitiveCategories — contacts', () => {
  it('matches "my contact"', () => {
    expect(matchSensitiveCategories('Find my contact for John')).toContain('contacts');
  });

  it('matches "phone number"', () => {
    expect(matchSensitiveCategories('What is their phone number?')).toContain('contacts');
  });

  it('matches "address book"', () => {
    expect(matchSensitiveCategories('Look up the address book')).toContain('contacts');
  });

  it('matches "my friend"', () => {
    expect(matchSensitiveCategories('Text my friend about dinner')).toContain('contacts');
  });
});

describe('matchSensitiveCategories — location', () => {
  it('matches "my location"', () => {
    expect(matchSensitiveCategories('Share my location with them')).toContain('location');
  });

  it('matches "gps"', () => {
    expect(matchSensitiveCategories('Turn on the GPS tracker')).toContain('location');
  });

  it('matches "coordinates"', () => {
    expect(matchSensitiveCategories('What are the coordinates?')).toContain('location');
  });

  it('matches "my address"', () => {
    expect(matchSensitiveCategories('Send it to my address')).toContain('location');
  });

  it('matches "home address"', () => {
    expect(matchSensitiveCategories('My home address is 123 Main St')).toContain('location');
  });

  it('matches "where i live"', () => {
    expect(matchSensitiveCategories('Do you know where I live?')).toContain('location');
  });

  it('matches lat/lon coordinate pair', () => {
    expect(matchSensitiveCategories('Location: 37.7749, -122.4194')).toContain('location');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// matchSensitiveCategories — multiple matches / no matches
// ═══════════════════════════════════════════════════════════════════════════════

describe('matchSensitiveCategories — combined', () => {
  it('returns empty array for non-sensitive text', () => {
    expect(matchSensitiveCategories('Tell me a joke about cats')).toEqual([]);
  });

  it('returns empty array for empty string', () => {
    expect(matchSensitiveCategories('')).toEqual([]);
  });

  it('returns multiple categories when text matches several', () => {
    const result = matchSensitiveCategories(
      'My password is in my health record and I have an appointment'
    );
    expect(result).toContain('credentials');
    expect(result).toContain('health');
    expect(result).toContain('calendar');
    expect(result.length).toBe(3);
  });

  it('does not duplicate categories', () => {
    const result = matchSensitiveCategories('Check my calendar and my schedule for appointments');
    // All three patterns match but the category should appear only once
    const calendarCount = result.filter((c) => c === 'calendar').length;
    expect(calendarCount).toBe(1);
  });

  it('is case insensitive for category patterns', () => {
    expect(matchSensitiveCategories('MY CALENDAR')).toContain('calendar');
    expect(matchSensitiveCategories('CREDIT CARD')).toContain('finances');
    expect(matchSensitiveCategories('PASSWORD')).toContain('credentials');
  });
});
