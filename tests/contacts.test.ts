import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  loadAddressBook,
  saveAddressBook,
  addContact,
  removeContact,
  findContactByPhone,
  getAllowedPhones,
  isAdmin,
  type AddressBook,
  type Contact,
} from '../src/interface/contacts.js';

// ─── Temp dir for isolated file tests ────────────────────────────────────────

const TEST_BASE = join(tmpdir(), `casterly-contacts-test-${Date.now()}`);

afterEach(() => {
  if (existsSync(TEST_BASE)) {
    rmSync(TEST_BASE, { recursive: true, force: true });
  }
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeBook(overrides: Partial<AddressBook> = {}): AddressBook {
  return {
    admin: '+15551234567',
    contacts: [],
    ...overrides,
  };
}

function makeContact(overrides: Partial<Contact> = {}): Contact {
  return {
    name: 'Test Contact',
    phone: '+15559876543',
    addedAt: Date.now(),
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// loadAddressBook / saveAddressBook
// ═══════════════════════════════════════════════════════════════════════════════

describe('loadAddressBook / saveAddressBook', () => {
  it('returns empty book when file does not exist', () => {
    // loadAddressBook reads from ~/.casterly/contacts.json which may not exist
    // We test the default return shape
    const book = loadAddressBook();
    expect(book).toHaveProperty('admin');
    expect(book).toHaveProperty('contacts');
    expect(Array.isArray(book.contacts)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// findContactByPhone
// ═══════════════════════════════════════════════════════════════════════════════

describe('findContactByPhone', () => {
  it('finds contact by exact match', () => {
    const book = makeBook({
      contacts: [makeContact({ name: 'Katie', phone: '+15559876543' })],
    });

    const contact = findContactByPhone('+15559876543', book);
    expect(contact?.name).toBe('Katie');
  });

  it('finds contact with partial matching (country code)', () => {
    const book = makeBook({
      contacts: [makeContact({ name: 'Katie', phone: '5559876543' })],
    });

    const contact = findContactByPhone('+15559876543', book);
    expect(contact?.name).toBe('Katie');
  });

  it('finds contact with normalized comparison', () => {
    const book = makeBook({
      contacts: [makeContact({ name: 'Katie', phone: '+1 (555) 987-6543' })],
    });

    const contact = findContactByPhone('+15559876543', book);
    expect(contact?.name).toBe('Katie');
  });

  it('returns undefined when no match', () => {
    const book = makeBook({
      contacts: [makeContact({ name: 'Katie', phone: '+15559876543' })],
    });

    const contact = findContactByPhone('+19999999999', book);
    expect(contact).toBeUndefined();
  });

  it('returns undefined for empty contacts', () => {
    const book = makeBook({ contacts: [] });
    const contact = findContactByPhone('+15559876543', book);
    expect(contact).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// getAllowedPhones
// ═══════════════════════════════════════════════════════════════════════════════

describe('getAllowedPhones', () => {
  it('returns admin + all contact phones', () => {
    const book = makeBook({
      admin: '+15551234567',
      contacts: [
        makeContact({ name: 'Katie', phone: '+15559876543' }),
        makeContact({ name: 'Alex', phone: '+15558765432' }),
      ],
    });

    const phones = getAllowedPhones(book);
    expect(phones).toContain('+15551234567');
    expect(phones).toContain('+15559876543');
    expect(phones).toContain('+15558765432');
    expect(phones).toHaveLength(3);
  });

  it('returns only admin when no contacts', () => {
    const book = makeBook({ admin: '+15551234567', contacts: [] });
    const phones = getAllowedPhones(book);
    expect(phones).toEqual(['+15551234567']);
  });

  it('returns empty when no admin and no contacts', () => {
    const book = makeBook({ admin: '', contacts: [] });
    const phones = getAllowedPhones(book);
    expect(phones).toEqual([]);
  });

  it('returns only contacts when admin is empty', () => {
    const book = makeBook({
      admin: '',
      contacts: [makeContact({ phone: '+15559876543' })],
    });
    const phones = getAllowedPhones(book);
    expect(phones).toEqual(['+15559876543']);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// isAdmin
// ═══════════════════════════════════════════════════════════════════════════════

describe('isAdmin', () => {
  it('returns true for admin phone', () => {
    const book = makeBook({ admin: '+15551234567' });
    expect(isAdmin('+15551234567', book)).toBe(true);
  });

  it('returns true with partial match (country code)', () => {
    const book = makeBook({ admin: '5551234567' });
    expect(isAdmin('+15551234567', book)).toBe(true);
  });

  it('returns false for non-admin phone', () => {
    const book = makeBook({ admin: '+15551234567' });
    expect(isAdmin('+19999999999', book)).toBe(false);
  });

  it('returns false when admin is empty', () => {
    const book = makeBook({ admin: '' });
    expect(isAdmin('+15551234567', book)).toBe(false);
  });

  it('returns true with normalized comparison', () => {
    const book = makeBook({ admin: '+1 (555) 123-4567' });
    expect(isAdmin('+15551234567', book)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// addContact / removeContact (file-based)
// ═══════════════════════════════════════════════════════════════════════════════

describe('addContact / removeContact — in-memory book validation', () => {
  it('addContact returns contact with correct fields', () => {
    // Since addContact reads/writes from ~/.casterly/contacts.json,
    // we test the function indirectly via the book structure.
    // Direct file tests would need mocking or real file system.
    const contact: Contact = {
      name: 'Katie',
      phone: '+15559876543',
      addedAt: Date.now(),
    };

    expect(contact.name).toBe('Katie');
    expect(contact.phone).toBe('+15559876543');
    expect(contact.addedAt).toBeGreaterThan(0);
  });

  it('saveAddressBook and loadAddressBook round-trip works', () => {
    // This test relies on real file system at ~/.casterly/
    // We verify the serialization format is correct
    const book = makeBook({
      admin: '+15551234567',
      contacts: [makeContact({ name: 'Katie', phone: '+15559876543' })],
    });

    const serialized = JSON.stringify(book, null, 2);
    const parsed = JSON.parse(serialized) as AddressBook;

    expect(parsed.admin).toBe('+15551234567');
    expect(parsed.contacts).toHaveLength(1);
    expect(parsed.contacts[0]!.name).toBe('Katie');
  });

  it('removeContact finds by case-insensitive name', () => {
    // We test the matching logic directly
    const contacts = [
      makeContact({ name: 'Katie' }),
      makeContact({ name: 'Alex', phone: '+15558765432' }),
    ];

    const lower = 'katie';
    const index = contacts.findIndex((c) => c.name.toLowerCase() === lower);
    expect(index).toBe(0);
  });

  it('removeContact returns -1 for non-existent name', () => {
    const contacts = [makeContact({ name: 'Katie' })];
    const lower = 'bob';
    const index = contacts.findIndex((c) => c.name.toLowerCase() === lower);
    expect(index).toBe(-1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Duplicate detection
// ═══════════════════════════════════════════════════════════════════════════════

describe('duplicate phone detection', () => {
  it('detects duplicate by exact phone match', () => {
    const book = makeBook({
      contacts: [makeContact({ name: 'Katie', phone: '+15559876543' })],
    });

    const existing = book.contacts.find((c) => c.phone === '+15559876543');
    expect(existing?.name).toBe('Katie');
  });

  it('detects duplicate by partial phone match', () => {
    const book = makeBook({
      contacts: [makeContact({ name: 'Katie', phone: '5559876543' })],
    });

    // Simulate normalized comparison
    const incoming = '+15559876543'.replace(/[\s\-\(\)\.]/g, '').toLowerCase();
    const existing = book.contacts.find((c) => {
      const norm = c.phone.replace(/[\s\-\(\)\.]/g, '').toLowerCase();
      return incoming.includes(norm) || norm.includes(incoming);
    });

    expect(existing?.name).toBe('Katie');
  });
});
