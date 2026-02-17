/**
 * Journal System — Tyrion's narrative memory
 *
 * The journal is an append-only log of natural-language entries that capture
 * what Tyrion was working on, what he noticed, what he thinks, and what he'd
 * tell his future self. It replaces structured goal-stack data as the primary
 * source of continuity.
 *
 * Entry types:
 *   - handoff: Written at the end of every cycle. "What I'd tell myself next time."
 *   - reflection: Observations about patterns, approaches, lessons learned.
 *   - opinion: "I think the provider interface is over-complicated." Emerges over time.
 *   - observation: "The detector regex is fragile." Things noticed in passing.
 *   - user_interaction: Notes about a conversation with the user.
 *
 * Storage: ~/.casterly/journal.jsonl — append-only, one JSON object per line.
 *
 * Privacy: Journal entries contain Tyrion's own reasoning, not raw user data.
 * Summaries derived from interactions are stored, never verbatim user content.
 *
 * Part of Phase 1: Journal System.
 */

import { readFile, appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { getTracer } from './debug.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A single journal entry.
 */
export interface JournalEntry {
  /** Unique identifier */
  id: string;

  /** ISO timestamp when this entry was created */
  timestamp: string;

  /** Entry type — determines how it's used in context */
  type: 'handoff' | 'reflection' | 'opinion' | 'observation' | 'user_interaction';

  /** Natural language content — the thinking */
  content: string;

  /** Tags for recall: ['provider-interface', 'refactor', 'stuck'] */
  tags: string[];

  /** Which cycle produced this entry */
  cycleId?: string;

  /** What started the cycle that produced this entry */
  triggerType?: string;
}

/**
 * Configuration for the journal.
 */
export interface JournalConfig {
  /** Path to the journal JSONL file */
  path: string;

  /** Maximum entries to keep in memory (older entries are on disk only) */
  maxInMemory: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: JournalConfig = {
  path: '~/.casterly/journal.jsonl',
  maxInMemory: 200,
};

function resolvePath(filePath: string): string {
  if (filePath.startsWith('~')) {
    const home = process.env['HOME'] ?? process.env['USERPROFILE'] ?? '/tmp';
    return filePath.replace('~', home);
  }
  return filePath;
}

function generateId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).substring(2, 7);
  return `j-${ts}-${rand}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Journal Class
// ─────────────────────────────────────────────────────────────────────────────

export class Journal {
  private readonly config: JournalConfig;
  private entries: JournalEntry[] = [];
  private loaded: boolean = false;

  constructor(config?: Partial<JournalConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Load journal entries from disk.
   */
  async load(): Promise<void> {
    const tracer = getTracer();
    const resolvedPath = resolvePath(this.config.path);

    try {
      const content = await readFile(resolvedPath, 'utf8');
      const lines = content.trim().split('\n').filter(Boolean);

      this.entries = [];
      for (const line of lines) {
        try {
          const entry = JSON.parse(line) as JournalEntry;
          this.entries.push(entry);
        } catch {
          // Skip malformed lines
        }
      }

      // Keep only recent entries in memory
      if (this.entries.length > this.config.maxInMemory) {
        this.entries = this.entries.slice(-this.config.maxInMemory);
      }

      this.loaded = true;
      tracer.log('agent-loop', 'debug', `Journal loaded: ${this.entries.length} entries`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        this.entries = [];
        this.loaded = true;
        tracer.log('agent-loop', 'debug', 'No existing journal found, starting fresh');
      } else {
        tracer.log('agent-loop', 'error', 'Failed to load journal', {
          error: err instanceof Error ? err.message : String(err),
        });
        this.entries = [];
        this.loaded = true;
      }
    }
  }

  /**
   * Append an entry to the journal. Writes immediately to disk (append-only).
   */
  async append(
    entry: Omit<JournalEntry, 'id' | 'timestamp'>,
  ): Promise<JournalEntry> {
    const tracer = getTracer();
    const resolvedPath = resolvePath(this.config.path);

    const fullEntry: JournalEntry = {
      ...entry,
      id: generateId(),
      timestamp: new Date().toISOString(),
    };

    // Write to disk
    await mkdir(dirname(resolvedPath), { recursive: true });
    await appendFile(resolvedPath, JSON.stringify(fullEntry) + '\n', 'utf8');

    // Add to in-memory cache
    this.entries.push(fullEntry);
    if (this.entries.length > this.config.maxInMemory) {
      this.entries.shift();
    }

    tracer.log('agent-loop', 'debug', `Journal entry appended: [${fullEntry.type}] ${fullEntry.id}`, {
      tags: fullEntry.tags,
      cycleId: fullEntry.cycleId,
    });

    return fullEntry;
  }

  /**
   * Get the N most recent entries (newest first in returned array).
   */
  getRecent(n: number): JournalEntry[] {
    return this.entries.slice(-n).reverse();
  }

  /**
   * Get entries filtered by type.
   */
  getByType(type: JournalEntry['type']): JournalEntry[] {
    return this.entries.filter((e) => e.type === type);
  }

  /**
   * Search entries by keyword (case-insensitive substring match on content and tags).
   */
  search(query: string): JournalEntry[] {
    const lower = query.toLowerCase();
    return this.entries.filter((e) =>
      e.content.toLowerCase().includes(lower) ||
      e.tags.some((t) => t.toLowerCase().includes(lower)),
    );
  }

  /**
   * Get the most recent handoff note. This is loaded at the start of
   * every cycle to give Tyrion "waking up and remembering."
   */
  getHandoffNote(): JournalEntry | null {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      if (this.entries[i]!.type === 'handoff') {
        return this.entries[i]!;
      }
    }
    return null;
  }

  /**
   * Summarize a set of entries into a compact string for context inclusion.
   */
  summarize(entries: JournalEntry[]): string {
    if (entries.length === 0) {
      return '(no journal entries)';
    }

    return entries
      .map((e) => {
        const dateStr = e.timestamp.split('T')[0];
        const tags = e.tags.length > 0 ? ` [${e.tags.join(', ')}]` : '';
        return `[${dateStr}] (${e.type})${tags}: ${e.content.slice(0, 200)}${e.content.length > 200 ? '...' : ''}`;
      })
      .join('\n');
  }

  /**
   * Get entries related to user interactions for building the user model.
   */
  getUserInteractions(): JournalEntry[] {
    return this.getByType('user_interaction');
  }

  /**
   * Get all entries (for consolidation/dream cycles).
   */
  getAllEntries(): ReadonlyArray<JournalEntry> {
    return this.entries;
  }

  /**
   * Check if the journal has been loaded.
   */
  isLoaded(): boolean {
    return this.loaded;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────────────────────

export function createJournal(config?: Partial<JournalConfig>): Journal {
  return new Journal(config);
}
