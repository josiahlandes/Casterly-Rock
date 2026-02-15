import { describe, expect, it } from 'vitest';

import {
  normalizePhoneNumber,
  findUserByPhone,
  getAllowedPhoneNumbers,
  type UserProfile,
  type UsersConfig,
} from '../src/interface/users.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeUser(overrides: Partial<UserProfile> = {}): UserProfile {
  return {
    id: 'test-user',
    name: 'Test User',
    phoneNumbers: ['+15555555555'],
    workspacePath: '/tmp/casterly-test-user',
    enabled: true,
    ...overrides,
  };
}

function makeConfig(users: UserProfile[]): UsersConfig {
  return { users };
}

// ═══════════════════════════════════════════════════════════════════════════════
// normalizePhoneNumber
// ═══════════════════════════════════════════════════════════════════════════════

describe('normalizePhoneNumber', () => {
  it('removes spaces', () => {
    expect(normalizePhoneNumber('+1 555 555 5555')).toBe('+15555555555');
  });

  it('removes dashes', () => {
    expect(normalizePhoneNumber('555-555-5555')).toBe('5555555555');
  });

  it('removes parentheses', () => {
    expect(normalizePhoneNumber('(555) 555-5555')).toBe('5555555555');
  });

  it('removes dots', () => {
    expect(normalizePhoneNumber('555.555.5555')).toBe('5555555555');
  });

  it('converts to lowercase', () => {
    // normalizePhoneNumber also removes dots (per regex), so email-like inputs lose dots
    expect(normalizePhoneNumber('User@Example.COM')).toBe('user@examplecom');
    // Typical phone usage:
    expect(normalizePhoneNumber('+1 (555) 123-4567')).toBe('+15551234567');
  });

  it('handles already clean numbers', () => {
    expect(normalizePhoneNumber('+15555555555')).toBe('+15555555555');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// findUserByPhone
// ═══════════════════════════════════════════════════════════════════════════════

describe('findUserByPhone', () => {
  it('finds user by exact match', () => {
    const config = makeConfig([
      makeUser({ id: 'josiah', phoneNumbers: ['+15555555555'] }),
    ]);

    const user = findUserByPhone('+15555555555', config);
    expect(user?.id).toBe('josiah');
  });

  it('finds user with normalized comparison', () => {
    const config = makeConfig([
      makeUser({ id: 'josiah', phoneNumbers: ['+15555555555'] }),
    ]);

    // Different format but same number
    const user = findUserByPhone('+1 (555) 555-5555', config);
    expect(user?.id).toBe('josiah');
  });

  it('supports partial matching (incoming has country code, stored does not)', () => {
    const config = makeConfig([
      makeUser({ id: 'josiah', phoneNumbers: ['5555555555'] }),
    ]);

    const user = findUserByPhone('+15555555555', config);
    expect(user?.id).toBe('josiah');
  });

  it('supports partial matching (stored has country code, incoming does not)', () => {
    const config = makeConfig([
      makeUser({ id: 'josiah', phoneNumbers: ['+15555555555'] }),
    ]);

    const user = findUserByPhone('5555555555', config);
    expect(user?.id).toBe('josiah');
  });

  it('returns undefined when no match', () => {
    const config = makeConfig([
      makeUser({ id: 'josiah', phoneNumbers: ['+15555555555'] }),
    ]);

    const user = findUserByPhone('+19999999999', config);
    expect(user).toBeUndefined();
  });

  it('skips disabled users', () => {
    const config = makeConfig([
      makeUser({ id: 'josiah', phoneNumbers: ['+15555555555'], enabled: false }),
    ]);

    const user = findUserByPhone('+15555555555', config);
    expect(user).toBeUndefined();
  });

  it('returns first matching user when multiple users exist', () => {
    const config = makeConfig([
      makeUser({ id: 'josiah', phoneNumbers: ['+15555555555'] }),
      makeUser({ id: 'other', phoneNumbers: ['+19999999999'] }),
    ]);

    const user = findUserByPhone('+19999999999', config);
    expect(user?.id).toBe('other');
  });

  it('matches against multiple phone numbers per user', () => {
    const config = makeConfig([
      makeUser({
        id: 'josiah',
        phoneNumbers: ['+15555555555', '+15555555556'],
      }),
    ]);

    const user = findUserByPhone('+15555555556', config);
    expect(user?.id).toBe('josiah');
  });

  it('returns undefined for empty config', () => {
    const config = makeConfig([]);
    const user = findUserByPhone('+15555555555', config);
    expect(user).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// getAllowedPhoneNumbers
// ═══════════════════════════════════════════════════════════════════════════════

describe('getAllowedPhoneNumbers', () => {
  it('returns all phone numbers from enabled users', () => {
    const config = makeConfig([
      makeUser({ id: 'josiah', phoneNumbers: ['+15555555555'] }),
      makeUser({ id: 'other', phoneNumbers: ['+19999999999', '+18888888888'] }),
    ]);

    const phones = getAllowedPhoneNumbers(config);
    expect(phones).toContain('+15555555555');
    expect(phones).toContain('+19999999999');
    expect(phones).toContain('+18888888888');
    expect(phones).toHaveLength(3);
  });

  it('excludes disabled users', () => {
    const config = makeConfig([
      makeUser({ id: 'josiah', phoneNumbers: ['+15555555555'], enabled: true }),
      makeUser({ id: 'other', phoneNumbers: ['+19999999999'], enabled: false }),
    ]);

    const phones = getAllowedPhoneNumbers(config);
    expect(phones).toContain('+15555555555');
    expect(phones).not.toContain('+19999999999');
  });

  it('returns empty array for no users', () => {
    expect(getAllowedPhoneNumbers(makeConfig([]))).toEqual([]);
  });
});
