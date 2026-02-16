/**
 * Address Book — Contacts management for Tyrion
 *
 * Single source of truth for who can message Tyrion and who Tyrion can message.
 * Admin (Josiah) manages contacts via iMessage commands.
 * All contacts share Tyrion's single workspace and identity.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { normalizePhoneNumber } from './users.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface Contact {
  name: string;
  phone: string;
  addedAt: number;
}

export interface AddressBook {
  admin: string;
  contacts: Contact[];
}

// ─── Paths ───────────────────────────────────────────────────────────────────

export function getContactsConfigPath(): string {
  return join(homedir(), '.casterly', 'contacts.json');
}

// ─── Load / Save ─────────────────────────────────────────────────────────────

export function loadAddressBook(): AddressBook {
  const configPath = getContactsConfigPath();

  if (!existsSync(configPath)) {
    return { admin: '', contacts: [] };
  }

  try {
    const content = readFileSync(configPath, 'utf-8');
    return JSON.parse(content) as AddressBook;
  } catch {
    return { admin: '', contacts: [] };
  }
}

export function saveAddressBook(book: AddressBook): void {
  const configPath = getContactsConfigPath();
  const dir = join(homedir(), '.casterly');

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  writeFileSync(configPath, JSON.stringify(book, null, 2) + '\n');
}

// ─── Contact Operations ──────────────────────────────────────────────────────

export function addContact(name: string, phone: string): Contact {
  const book = loadAddressBook();
  const normalized = normalizePhoneNumber(phone);

  // Check for duplicate phone
  const existing = book.contacts.find((c) => {
    const existingNorm = normalizePhoneNumber(c.phone);
    return existingNorm.includes(normalized) || normalized.includes(existingNorm);
  });

  if (existing) {
    throw new Error(`Phone number '${phone}' is already assigned to ${existing.name}`);
  }

  const contact: Contact = {
    name,
    phone,
    addedAt: Date.now(),
  };

  book.contacts.push(contact);
  saveAddressBook(book);

  return contact;
}

export function removeContact(name: string): boolean {
  const book = loadAddressBook();
  const lower = name.toLowerCase();
  const index = book.contacts.findIndex((c) => c.name.toLowerCase() === lower);

  if (index === -1) {
    return false;
  }

  book.contacts.splice(index, 1);
  saveAddressBook(book);

  return true;
}

export function findContactByPhone(phone: string, book?: AddressBook): Contact | undefined {
  const addressBook = book ?? loadAddressBook();
  const normalized = normalizePhoneNumber(phone);

  for (const contact of addressBook.contacts) {
    const contactNorm = normalizePhoneNumber(contact.phone);
    if (normalized.includes(contactNorm) || contactNorm.includes(normalized)) {
      return contact;
    }
  }

  return undefined;
}

// ─── Allowlist / Admin ───────────────────────────────────────────────────────

export function getAllowedPhones(book?: AddressBook): string[] {
  const addressBook = book ?? loadAddressBook();
  const phones: string[] = [];

  if (addressBook.admin) {
    phones.push(addressBook.admin);
  }

  for (const contact of addressBook.contacts) {
    phones.push(contact.phone);
  }

  return phones;
}

export function isAdmin(phone: string, book?: AddressBook): boolean {
  const addressBook = book ?? loadAddressBook();

  if (!addressBook.admin) {
    return false;
  }

  const normalizedPhone = normalizePhoneNumber(phone);
  const normalizedAdmin = normalizePhoneNumber(addressBook.admin);

  return normalizedPhone.includes(normalizedAdmin) || normalizedAdmin.includes(normalizedPhone);
}
