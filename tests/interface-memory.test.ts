import { describe, expect, it, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  getMemoryPath,
  getDailyLogPath,
  ensureMemoryDirs,
  readLongTermMemory,
  writeLongTermMemory,
  readDailyLog,
  appendToDailyLog,
  getTodayDate,
  formatMemorySection,
  parseMemoryCommands,
  executeMemoryCommands,
  createMemoryManager,
  type MemoryState,
} from '../src/interface/memory.js';

// ─── Temp dir helpers ────────────────────────────────────────────────────────

const TEST_BASE = join(tmpdir(), `casterly-memory-test-${Date.now()}`);

afterEach(() => {
  if (existsSync(TEST_BASE)) {
    rmSync(TEST_BASE, { recursive: true, force: true });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// Path helpers
// ═══════════════════════════════════════════════════════════════════════════════

describe('path helpers', () => {
  it('getMemoryPath returns MEMORY.md path', () => {
    expect(getMemoryPath('/workspace')).toBe('/workspace/MEMORY.md');
  });

  it('getDailyLogPath returns dated markdown path', () => {
    expect(getDailyLogPath('/workspace', '2024-01-15')).toBe('/workspace/memory/2024-01-15.md');
  });

  it('getTodayDate returns YYYY-MM-DD format', () => {
    const today = getTodayDate();
    expect(today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ensureMemoryDirs
// ═══════════════════════════════════════════════════════════════════════════════

describe('ensureMemoryDirs', () => {
  it('creates memory subdirectory', () => {
    mkdirSync(TEST_BASE, { recursive: true });
    ensureMemoryDirs(TEST_BASE);
    expect(existsSync(join(TEST_BASE, 'memory'))).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Long-term memory
// ═══════════════════════════════════════════════════════════════════════════════

describe('readLongTermMemory', () => {
  it('returns empty string when file does not exist', () => {
    expect(readLongTermMemory('/nonexistent')).toBe('');
  });

  it('reads existing memory file', () => {
    mkdirSync(TEST_BASE, { recursive: true });
    writeFileSync(join(TEST_BASE, 'MEMORY.md'), 'User likes coffee\n');
    expect(readLongTermMemory(TEST_BASE)).toBe('User likes coffee');
  });
});

describe('writeLongTermMemory', () => {
  it('writes memory file and creates dirs', () => {
    mkdirSync(TEST_BASE, { recursive: true });
    writeLongTermMemory(TEST_BASE, 'New memory content');

    const content = readFileSync(join(TEST_BASE, 'MEMORY.md'), 'utf-8');
    expect(content.trim()).toBe('New memory content');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Daily logs
// ═══════════════════════════════════════════════════════════════════════════════

describe('readDailyLog', () => {
  it('returns empty string when file does not exist', () => {
    expect(readDailyLog('/nonexistent', '2024-01-15')).toBe('');
  });

  it('reads existing daily log', () => {
    const memoryDir = join(TEST_BASE, 'memory');
    mkdirSync(memoryDir, { recursive: true });
    writeFileSync(join(memoryDir, '2024-01-15.md'), '# Notes\n- Something\n');
    expect(readDailyLog(TEST_BASE, '2024-01-15')).toBe('# Notes\n- Something');
  });
});

describe('appendToDailyLog', () => {
  it('creates new daily log with header', () => {
    mkdirSync(TEST_BASE, { recursive: true });
    appendToDailyLog(TEST_BASE, 'First note');

    const today = getTodayDate();
    const logPath = getDailyLogPath(TEST_BASE, today);
    expect(existsSync(logPath)).toBe(true);

    const content = readFileSync(logPath, 'utf-8');
    expect(content).toContain(`# Notes for ${today}`);
    expect(content).toContain('First note');
  });

  it('appends with category prefix', () => {
    mkdirSync(TEST_BASE, { recursive: true });
    appendToDailyLog(TEST_BASE, 'Important meeting', 'calendar');

    const today = getTodayDate();
    const logPath = getDailyLogPath(TEST_BASE, today);
    const content = readFileSync(logPath, 'utf-8');
    expect(content).toContain('[calendar]');
    expect(content).toContain('Important meeting');
  });

  it('appends multiple entries', () => {
    mkdirSync(TEST_BASE, { recursive: true });
    appendToDailyLog(TEST_BASE, 'Note 1');
    appendToDailyLog(TEST_BASE, 'Note 2');

    const today = getTodayDate();
    const logPath = getDailyLogPath(TEST_BASE, today);
    const content = readFileSync(logPath, 'utf-8');
    expect(content).toContain('Note 1');
    expect(content).toContain('Note 2');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// formatMemorySection
// ═══════════════════════════════════════════════════════════════════════════════

describe('formatMemorySection', () => {
  it('returns empty string when no memory content', () => {
    const state: MemoryState = {
      longTerm: '',
      todayLog: '',
      recentLogs: [],
    };
    expect(formatMemorySection(state)).toBe('');
  });

  it('formats long-term memory section', () => {
    const state: MemoryState = {
      longTerm: 'User likes coffee',
      todayLog: '',
      recentLogs: [],
    };
    const formatted = formatMemorySection(state);
    expect(formatted).toContain('# Memory');
    expect(formatted).toContain('MEMORY.md');
    expect(formatted).toContain('User likes coffee');
  });

  it('formats recent daily logs', () => {
    const state: MemoryState = {
      longTerm: '',
      todayLog: '',
      recentLogs: [
        { date: '2024-01-15', content: 'Meeting at 3pm' },
        { date: '2024-01-14', content: 'Finished project' },
      ],
    };
    const formatted = formatMemorySection(state);
    expect(formatted).toContain('Recent Notes');
    expect(formatted).toContain('2024-01-15');
    expect(formatted).toContain('Meeting at 3pm');
    expect(formatted).toContain('2024-01-14');
  });

  it('formats both long-term and recent logs', () => {
    const state: MemoryState = {
      longTerm: 'User facts',
      todayLog: '',
      recentLogs: [{ date: '2024-01-15', content: 'Notes' }],
    };
    const formatted = formatMemorySection(state);
    expect(formatted).toContain('MEMORY.md');
    expect(formatted).toContain('Recent Notes');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// parseMemoryCommands
// ═══════════════════════════════════════════════════════════════════════════════

describe('parseMemoryCommands', () => {
  it('parses [NOTE] command', () => {
    const commands = parseMemoryCommands('[NOTE] User prefers dark mode');
    expect(commands).toHaveLength(1);
    expect(commands[0]!.type).toBe('note');
    expect(commands[0]!.content).toBe('User prefers dark mode');
  });

  it('parses [REMEMBER] command', () => {
    const commands = parseMemoryCommands('[REMEMBER] User birthday is Jan 15');
    expect(commands).toHaveLength(1);
    expect(commands[0]!.type).toBe('note');
    expect(commands[0]!.content).toBe('User birthday is Jan 15');
  });

  it('parses [NOTE] with category', () => {
    const commands = parseMemoryCommands('[NOTE][preferences] Likes dark mode');
    expect(commands).toHaveLength(1);
    expect(commands[0]!.type).toBe('note');
    expect(commands[0]!.category).toBe('preferences');
    expect(commands[0]!.content).toBe('Likes dark mode');
  });

  it('parses [MEMORY] command as memory type', () => {
    const commands = parseMemoryCommands('[MEMORY] Long-term fact about user');
    expect(commands).toHaveLength(1);
    expect(commands[0]!.type).toBe('memory');
    expect(commands[0]!.content).toBe('Long-term fact about user');
  });

  it('parses multiple commands', () => {
    const text = '[NOTE] First note [REMEMBER] Second note [MEMORY] Third fact';
    const commands = parseMemoryCommands(text);
    expect(commands.length).toBeGreaterThanOrEqual(2);
  });

  it('returns empty array for text without commands', () => {
    const commands = parseMemoryCommands('Just a normal response');
    expect(commands).toEqual([]);
  });

  it('is case-insensitive', () => {
    const commands = parseMemoryCommands('[note] lowercase note');
    expect(commands).toHaveLength(1);
    expect(commands[0]!.type).toBe('note');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// executeMemoryCommands
// ═══════════════════════════════════════════════════════════════════════════════

describe('executeMemoryCommands', () => {
  it('executes note commands', () => {
    mkdirSync(TEST_BASE, { recursive: true });
    const manager = createMemoryManager({ workspacePath: TEST_BASE });

    executeMemoryCommands(
      [{ type: 'note', content: 'Test note', category: 'test' }],
      manager
    );

    const today = getTodayDate();
    const logPath = getDailyLogPath(TEST_BASE, today);
    expect(existsSync(logPath)).toBe(true);
    const content = readFileSync(logPath, 'utf-8');
    expect(content).toContain('Test note');
  });

  it('executes memory commands by appending to long-term', () => {
    mkdirSync(TEST_BASE, { recursive: true });
    const manager = createMemoryManager({ workspacePath: TEST_BASE });

    // Write initial memory
    writeLongTermMemory(TEST_BASE, 'Existing fact');

    executeMemoryCommands(
      [{ type: 'memory', content: 'New fact' }],
      manager
    );

    const memory = readLongTermMemory(TEST_BASE);
    expect(memory).toContain('Existing fact');
    expect(memory).toContain('New fact');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// createMemoryManager
// ═══════════════════════════════════════════════════════════════════════════════

describe('createMemoryManager', () => {
  it('loads empty state for new workspace', () => {
    mkdirSync(TEST_BASE, { recursive: true });
    const manager = createMemoryManager({ workspacePath: TEST_BASE });

    const state = manager.load();
    expect(state.longTerm).toBe('');
    expect(state.todayLog).toBe('');
  });

  it('appendNote writes to daily log', () => {
    mkdirSync(TEST_BASE, { recursive: true });
    const manager = createMemoryManager({ workspacePath: TEST_BASE });

    manager.appendNote('Test note');

    const today = getTodayDate();
    const content = readDailyLog(TEST_BASE, today);
    expect(content).toContain('Test note');
  });

  it('updateLongTerm writes to MEMORY.md', () => {
    mkdirSync(TEST_BASE, { recursive: true });
    const manager = createMemoryManager({ workspacePath: TEST_BASE });

    manager.updateLongTerm('Important fact');

    expect(readLongTermMemory(TEST_BASE)).toBe('Important fact');
  });

  it('getPromptSection returns formatted memory', () => {
    mkdirSync(TEST_BASE, { recursive: true });
    const manager = createMemoryManager({ workspacePath: TEST_BASE });

    manager.updateLongTerm('User prefers concise responses');
    const section = manager.getPromptSection();

    expect(section).toContain('User prefers concise responses');
    expect(section).toContain('# Memory');
  });

  it('exposes workspacePath', () => {
    const manager = createMemoryManager({ workspacePath: TEST_BASE });
    expect(manager.workspacePath).toBe(TEST_BASE);
  });
});
