import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { Journal, createJournal } from '../src/autonomous/journal.js';
import type { JournalEntry } from '../src/autonomous/journal.js';
import { resetTracer, initTracer } from '../src/autonomous/debug.js';

// ─────────────────────────────────────────────────────────────────────────────
// Test Setup
// ─────────────────────────────────────────────────────────────────────────────

let tempDir: string;
let journalPath: string;

beforeEach(async () => {
  resetTracer();
  initTracer({ enabled: false });
  tempDir = await mkdtemp(join(tmpdir(), 'casterly-journal-test-'));
  journalPath = join(tempDir, 'journal.jsonl');
});

afterEach(async () => {
  resetTracer();
  await rm(tempDir, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeJournal(maxInMemory?: number): Journal {
  return createJournal({
    path: journalPath,
    ...(maxInMemory !== undefined ? { maxInMemory } : {}),
  });
}

async function writeExistingJournal(entries: JournalEntry[]): Promise<void> {
  const content = entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
  await writeFile(journalPath, content, 'utf8');
}

function makeFakeEntry(overrides: Partial<JournalEntry> = {}): JournalEntry {
  return {
    id: `j-test-${Math.random().toString(36).substring(2, 7)}`,
    timestamp: new Date().toISOString(),
    type: 'observation',
    content: 'Test observation entry',
    tags: [],
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// load()
// ═══════════════════════════════════════════════════════════════════════════════

describe('Journal — load()', () => {
  it('handles missing file by creating a fresh empty journal', async () => {
    const journal = makeJournal();
    await journal.load();

    expect(journal.isLoaded()).toBe(true);
    expect(journal.getRecent(10)).toHaveLength(0);
  });

  it('reads existing JSONL file', async () => {
    const entry1 = makeFakeEntry({ content: 'First entry', type: 'handoff' });
    const entry2 = makeFakeEntry({ content: 'Second entry', type: 'reflection' });
    await writeExistingJournal([entry1, entry2]);

    const journal = makeJournal();
    await journal.load();

    expect(journal.isLoaded()).toBe(true);
    const recent = journal.getRecent(10);
    expect(recent).toHaveLength(2);
    expect(recent[0]!.content).toBe('Second entry');
    expect(recent[1]!.content).toBe('First entry');
  });

  it('skips malformed JSON lines gracefully', async () => {
    const goodEntry = makeFakeEntry({ content: 'Good entry' });
    const content = JSON.stringify(goodEntry) + '\n' + '{bad json\n';
    await writeFile(journalPath, content, 'utf8');

    const journal = makeJournal();
    await journal.load();

    expect(journal.isLoaded()).toBe(true);
    expect(journal.getRecent(10)).toHaveLength(1);
    expect(journal.getRecent(10)[0]!.content).toBe('Good entry');
  });

  it('trims entries to maxInMemory on load', async () => {
    const entries = Array.from({ length: 10 }, (_, i) =>
      makeFakeEntry({ content: `Entry ${i}` }),
    );
    await writeExistingJournal(entries);

    const journal = makeJournal(5);
    await journal.load();

    expect(journal.getRecent(100)).toHaveLength(5);
    // Should keep the last 5 entries (newest)
    expect(journal.getRecent(100)[0]!.content).toBe('Entry 9');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// append()
// ═══════════════════════════════════════════════════════════════════════════════

describe('Journal — append()', () => {
  it('creates entry with id and timestamp, writes to disk', async () => {
    const journal = makeJournal();
    await journal.load();

    const entry = await journal.append({
      type: 'observation',
      content: 'The test suite is getting slow.',
      tags: ['performance', 'tests'],
    });

    // Entry should have auto-generated id and timestamp
    expect(entry.id).toMatch(/^j-/);
    expect(entry.timestamp).toBeTruthy();
    expect(entry.type).toBe('observation');
    expect(entry.content).toBe('The test suite is getting slow.');
    expect(entry.tags).toEqual(['performance', 'tests']);

    // Verify it was written to disk
    const raw = await readFile(journalPath, 'utf8');
    const parsed = JSON.parse(raw.trim()) as JournalEntry;
    expect(parsed.id).toBe(entry.id);
    expect(parsed.content).toBe('The test suite is getting slow.');
  });

  it('appends multiple entries to the file', async () => {
    const journal = makeJournal();
    await journal.load();

    await journal.append({ type: 'observation', content: 'First', tags: [] });
    await journal.append({ type: 'reflection', content: 'Second', tags: [] });

    const raw = await readFile(journalPath, 'utf8');
    const lines = raw.trim().split('\n');
    expect(lines).toHaveLength(2);
  });

  it('adds entry to in-memory cache', async () => {
    const journal = makeJournal();
    await journal.load();

    await journal.append({ type: 'handoff', content: 'Done for now', tags: ['cycle-end'] });

    expect(journal.getRecent(10)).toHaveLength(1);
    expect(journal.getRecent(10)[0]!.type).toBe('handoff');
  });

  it('trims in-memory cache when exceeding maxInMemory', async () => {
    const journal = makeJournal(3);
    await journal.load();

    for (let i = 0; i < 5; i++) {
      await journal.append({ type: 'observation', content: `Entry ${i}`, tags: [] });
    }

    const recent = journal.getRecent(100);
    expect(recent).toHaveLength(3);
    // Newest entries should be kept
    expect(recent[0]!.content).toBe('Entry 4');
    expect(recent[1]!.content).toBe('Entry 3');
    expect(recent[2]!.content).toBe('Entry 2');
  });

  it('creates parent directory if it does not exist', async () => {
    const nestedPath = join(tempDir, 'nested', 'dir', 'journal.jsonl');
    const journal = createJournal({ path: nestedPath });
    await journal.load();

    const entry = await journal.append({
      type: 'observation',
      content: 'Nested entry',
      tags: [],
    });

    const raw = await readFile(nestedPath, 'utf8');
    expect(raw).toContain(entry.id);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// getRecent()
// ═══════════════════════════════════════════════════════════════════════════════

describe('Journal — getRecent()', () => {
  it('returns last N entries newest first', async () => {
    const entries = Array.from({ length: 5 }, (_, i) =>
      makeFakeEntry({ content: `Entry ${i}` }),
    );
    await writeExistingJournal(entries);

    const journal = makeJournal();
    await journal.load();

    const recent = journal.getRecent(3);
    expect(recent).toHaveLength(3);
    expect(recent[0]!.content).toBe('Entry 4');
    expect(recent[1]!.content).toBe('Entry 3');
    expect(recent[2]!.content).toBe('Entry 2');
  });

  it('returns all entries when N exceeds total', async () => {
    const entries = [makeFakeEntry({ content: 'Only one' })];
    await writeExistingJournal(entries);

    const journal = makeJournal();
    await journal.load();

    const recent = journal.getRecent(100);
    expect(recent).toHaveLength(1);
    expect(recent[0]!.content).toBe('Only one');
  });

  it('returns empty array when journal is empty', async () => {
    const journal = makeJournal();
    await journal.load();

    expect(journal.getRecent(10)).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// getByType()
// ═══════════════════════════════════════════════════════════════════════════════

describe('Journal — getByType()', () => {
  it('filters entries by type', async () => {
    const entries = [
      makeFakeEntry({ type: 'handoff', content: 'Handoff 1' }),
      makeFakeEntry({ type: 'observation', content: 'Obs 1' }),
      makeFakeEntry({ type: 'handoff', content: 'Handoff 2' }),
      makeFakeEntry({ type: 'reflection', content: 'Reflect 1' }),
    ];
    await writeExistingJournal(entries);

    const journal = makeJournal();
    await journal.load();

    const handoffs = journal.getByType('handoff');
    expect(handoffs).toHaveLength(2);
    expect(handoffs[0]!.content).toBe('Handoff 1');
    expect(handoffs[1]!.content).toBe('Handoff 2');
  });

  it('returns empty array when no entries match', async () => {
    const entries = [makeFakeEntry({ type: 'observation', content: 'Obs' })];
    await writeExistingJournal(entries);

    const journal = makeJournal();
    await journal.load();

    expect(journal.getByType('opinion')).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// search()
// ═══════════════════════════════════════════════════════════════════════════════

describe('Journal — search()', () => {
  it('searches content by case-insensitive substring', async () => {
    const entries = [
      makeFakeEntry({ content: 'The Provider Interface is complex', tags: [] }),
      makeFakeEntry({ content: 'Tests are passing', tags: [] }),
      makeFakeEntry({ content: 'provider module needs work', tags: [] }),
    ];
    await writeExistingJournal(entries);

    const journal = makeJournal();
    await journal.load();

    const results = journal.search('provider');
    expect(results).toHaveLength(2);
    expect(results[0]!.content).toContain('Provider');
    expect(results[1]!.content).toContain('provider');
  });

  it('searches tags', async () => {
    const entries = [
      makeFakeEntry({ content: 'Something', tags: ['refactor', 'provider'] }),
      makeFakeEntry({ content: 'Other thing', tags: ['testing'] }),
    ];
    await writeExistingJournal(entries);

    const journal = makeJournal();
    await journal.load();

    const results = journal.search('refactor');
    expect(results).toHaveLength(1);
    expect(results[0]!.tags).toContain('refactor');
  });

  it('returns empty array when nothing matches', async () => {
    const entries = [makeFakeEntry({ content: 'hello world', tags: ['greet'] })];
    await writeExistingJournal(entries);

    const journal = makeJournal();
    await journal.load();

    expect(journal.search('nonexistent')).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// getHandoffNote()
// ═══════════════════════════════════════════════════════════════════════════════

describe('Journal — getHandoffNote()', () => {
  it('returns most recent handoff entry', async () => {
    const entries = [
      makeFakeEntry({ type: 'handoff', content: 'Old handoff' }),
      makeFakeEntry({ type: 'observation', content: 'Some obs' }),
      makeFakeEntry({ type: 'handoff', content: 'Latest handoff' }),
      makeFakeEntry({ type: 'reflection', content: 'A reflection' }),
    ];
    await writeExistingJournal(entries);

    const journal = makeJournal();
    await journal.load();

    const handoff = journal.getHandoffNote();
    expect(handoff).not.toBeNull();
    expect(handoff!.content).toBe('Latest handoff');
    expect(handoff!.type).toBe('handoff');
  });

  it('returns null when no handoff entries exist', async () => {
    const entries = [
      makeFakeEntry({ type: 'observation', content: 'Just an obs' }),
      makeFakeEntry({ type: 'reflection', content: 'Just a reflection' }),
    ];
    await writeExistingJournal(entries);

    const journal = makeJournal();
    await journal.load();

    expect(journal.getHandoffNote()).toBeNull();
  });

  it('returns null for empty journal', async () => {
    const journal = makeJournal();
    await journal.load();

    expect(journal.getHandoffNote()).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// summarize()
// ═══════════════════════════════════════════════════════════════════════════════

describe('Journal — summarize()', () => {
  it('creates compact summary strings from entries', () => {
    const journal = makeJournal();
    const entries: JournalEntry[] = [
      {
        id: 'j-1',
        timestamp: '2026-02-17T10:30:00.000Z',
        type: 'observation',
        content: 'The detector regex is fragile.',
        tags: ['detector', 'regex'],
      },
      {
        id: 'j-2',
        timestamp: '2026-02-17T11:00:00.000Z',
        type: 'handoff',
        content: 'Done for now. Need to revisit the provider interface.',
        tags: [],
      },
    ];

    const summary = journal.summarize(entries);

    expect(summary).toContain('[2026-02-17]');
    expect(summary).toContain('(observation)');
    expect(summary).toContain('[detector, regex]');
    expect(summary).toContain('The detector regex is fragile.');
    expect(summary).toContain('(handoff)');
    expect(summary).toContain('Done for now');
  });

  it('returns "(no journal entries)" for empty array', () => {
    const journal = makeJournal();
    expect(journal.summarize([])).toBe('(no journal entries)');
  });

  it('truncates long content to 200 characters', () => {
    const journal = makeJournal();
    const longContent = 'A'.repeat(300);
    const entries: JournalEntry[] = [
      {
        id: 'j-long',
        timestamp: '2026-02-17T12:00:00.000Z',
        type: 'reflection',
        content: longContent,
        tags: [],
      },
    ];

    const summary = journal.summarize(entries);
    expect(summary).toContain('...');
    // The summary should contain at most 200 chars of content
    expect(summary).not.toContain(longContent);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// getUserInteractions()
// ═══════════════════════════════════════════════════════════════════════════════

describe('Journal — getUserInteractions()', () => {
  it('filters for user_interaction type', async () => {
    const entries = [
      makeFakeEntry({ type: 'user_interaction', content: 'User asked about refactoring' }),
      makeFakeEntry({ type: 'observation', content: 'Tests look good' }),
      makeFakeEntry({ type: 'user_interaction', content: 'User wants status update' }),
      makeFakeEntry({ type: 'handoff', content: 'Signing off' }),
    ];
    await writeExistingJournal(entries);

    const journal = makeJournal();
    await journal.load();

    const interactions = journal.getUserInteractions();
    expect(interactions).toHaveLength(2);
    expect(interactions[0]!.content).toBe('User asked about refactoring');
    expect(interactions[1]!.content).toBe('User wants status update');
  });

  it('returns empty array when no user interactions exist', async () => {
    const entries = [makeFakeEntry({ type: 'handoff', content: 'Goodbye' })];
    await writeExistingJournal(entries);

    const journal = makeJournal();
    await journal.load();

    expect(journal.getUserInteractions()).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Factory
// ═══════════════════════════════════════════════════════════════════════════════

describe('Journal — createJournal factory', () => {
  it('creates a working Journal instance', async () => {
    const journal = createJournal({ path: journalPath });
    await journal.load();

    const entry = await journal.append({
      type: 'opinion',
      content: 'Factory works great',
      tags: ['meta'],
    });

    expect(entry.id).toMatch(/^j-/);
    expect(journal.getRecent(1)[0]!.content).toBe('Factory works great');
  });
});
