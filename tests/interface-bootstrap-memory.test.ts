import { describe, expect, it, afterEach } from 'vitest';
import { existsSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  BOOTSTRAP_FILES,
  getDefaultWorkspacePath,
  getWorkspacePaths,
  loadBootstrapFile,
  loadBootstrapFiles,
  formatBootstrapSection,
} from '../src/interface/bootstrap.js';
import {
  getMemoryPath,
  getDailyLogPath,
  ensureMemoryDirs,
  readLongTermMemory,
  writeLongTermMemory,
  readDailyLog,
  appendToDailyLog,
  getRecentDailyLogs,
  formatMemorySection,
  createMemoryManager,
  parseMemoryCommands,
  executeMemoryCommands,
} from '../src/interface/memory.js';

// ─── Temp dir helpers ────────────────────────────────────────────────────────

const TEST_BASE = join(tmpdir(), `casterly-bootstrap-test-${Date.now()}`);

afterEach(() => {
  if (existsSync(TEST_BASE)) {
    rmSync(TEST_BASE, { recursive: true, force: true });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// Bootstrap — constants
// ═══════════════════════════════════════════════════════════════════════════════

describe('BOOTSTRAP_FILES', () => {
  it('contains standard files in order', () => {
    expect(BOOTSTRAP_FILES).toContain('IDENTITY.md');
    expect(BOOTSTRAP_FILES).toContain('SOUL.md');
    expect(BOOTSTRAP_FILES).toContain('TOOLS.md');
    expect(BOOTSTRAP_FILES).toContain('USER.md');
    expect(BOOTSTRAP_FILES.length).toBe(4);
  });
});

describe('getDefaultWorkspacePath', () => {
  it('returns a path ending with .casterly/workspace', () => {
    const path = getDefaultWorkspacePath();
    expect(path).toContain('.casterly');
    expect(path).toContain('workspace');
  });
});

describe('getWorkspacePaths', () => {
  it('returns multiple paths', () => {
    const paths = getWorkspacePaths();
    expect(paths.length).toBeGreaterThanOrEqual(3);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Bootstrap — loadBootstrapFile
// ═══════════════════════════════════════════════════════════════════════════════

describe('loadBootstrapFile', () => {
  it('returns undefined for non-existent file', () => {
    expect(loadBootstrapFile('/tmp/nonexistent-bootstrap.md')).toBeUndefined();
  });

  it('returns undefined for empty file', () => {
    mkdirSync(TEST_BASE, { recursive: true });
    const path = join(TEST_BASE, 'empty.md');
    writeFileSync(path, '   \n  \n  ');
    expect(loadBootstrapFile(path)).toBeUndefined();
  });

  it('loads file content', () => {
    mkdirSync(TEST_BASE, { recursive: true });
    const path = join(TEST_BASE, 'TEST.md');
    writeFileSync(path, '# Test\n\nHello world');

    const result = loadBootstrapFile(path);
    expect(result).toBeDefined();
    expect(result!.name).toBe('TEST.md');
    expect(result!.content).toContain('Hello world');
    expect(result!.truncated).toBe(false);
  });

  it('truncates oversized files', () => {
    mkdirSync(TEST_BASE, { recursive: true });
    const path = join(TEST_BASE, 'BIG.md');
    writeFileSync(path, 'x'.repeat(1000));

    const result = loadBootstrapFile(path, 100);
    expect(result).toBeDefined();
    expect(result!.truncated).toBe(true);
    expect(result!.content).toContain('[... truncated ...]');
    expect(result!.originalSize).toBe(1000);
  });

  it('records original size', () => {
    mkdirSync(TEST_BASE, { recursive: true });
    const path = join(TEST_BASE, 'SIZE.md');
    writeFileSync(path, 'Hello!');

    const result = loadBootstrapFile(path);
    expect(result!.originalSize).toBe(6);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Bootstrap — loadBootstrapFiles
// ═══════════════════════════════════════════════════════════════════════════════

describe('loadBootstrapFiles', () => {
  it('returns empty files array for non-existent workspace', () => {
    const result = loadBootstrapFiles({ workspacePath: '/tmp/nonexistent-workspace' });
    expect(result.files).toEqual([]);
    expect(result.combined).toBe('');
  });

  it('loads files from workspace', () => {
    mkdirSync(TEST_BASE, { recursive: true });
    writeFileSync(join(TEST_BASE, 'IDENTITY.md'), '# Tyrion\n\nA helpful assistant');
    writeFileSync(join(TEST_BASE, 'SOUL.md'), '# Soul\n\nBe kind');

    const result = loadBootstrapFiles({
      workspacePath: TEST_BASE,
      files: ['IDENTITY.md', 'SOUL.md'],
    });
    expect(result.files.length).toBe(2);
    expect(result.combined).toContain('Tyrion');
    expect(result.combined).toContain('Be kind');
  });

  it('skips missing files', () => {
    mkdirSync(TEST_BASE, { recursive: true });
    writeFileSync(join(TEST_BASE, 'IDENTITY.md'), '# Identity');

    const result = loadBootstrapFiles({
      workspacePath: TEST_BASE,
      files: ['IDENTITY.md', 'NONEXISTENT.md'],
    });
    expect(result.files.length).toBe(1);
  });

  it('combines files with separators', () => {
    mkdirSync(TEST_BASE, { recursive: true });
    writeFileSync(join(TEST_BASE, 'A.md'), 'Content A');
    writeFileSync(join(TEST_BASE, 'B.md'), 'Content B');

    const result = loadBootstrapFiles({
      workspacePath: TEST_BASE,
      files: ['A.md', 'B.md'],
    });
    expect(result.combined).toContain('---');
    expect(result.combined).toContain('## A.md');
    expect(result.combined).toContain('## B.md');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Bootstrap — formatBootstrapSection
// ═══════════════════════════════════════════════════════════════════════════════

describe('formatBootstrapSection', () => {
  it('returns empty string for no files', () => {
    expect(formatBootstrapSection({ files: [], combined: '', workspacePath: '' })).toBe('');
  });

  it('includes project context header', () => {
    const result = formatBootstrapSection({
      files: [{ name: 'TEST.md', content: 'test', truncated: false, originalSize: 4 }],
      combined: '## TEST.md\n\ntest',
      workspacePath: TEST_BASE,
    });
    expect(result).toContain('# Project Context');
    expect(result).toContain('test');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Memory — path helpers
// ═══════════════════════════════════════════════════════════════════════════════

describe('getMemoryPath', () => {
  it('returns MEMORY.md inside workspace', () => {
    expect(getMemoryPath('/ws')).toBe('/ws/MEMORY.md');
  });
});

describe('getDailyLogPath', () => {
  it('returns dated path inside memory directory', () => {
    expect(getDailyLogPath('/ws', '2025-01-15')).toBe('/ws/memory/2025-01-15.md');
  });
});

describe('ensureMemoryDirs', () => {
  it('creates memory subdirectory', () => {
    ensureMemoryDirs(TEST_BASE);
    expect(existsSync(join(TEST_BASE, 'memory'))).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Memory — read/write long-term
// ═══════════════════════════════════════════════════════════════════════════════

describe('readLongTermMemory', () => {
  it('returns empty string for non-existent file', () => {
    expect(readLongTermMemory('/tmp/nonexistent-workspace')).toBe('');
  });

  it('reads existing memory file', () => {
    mkdirSync(TEST_BASE, { recursive: true });
    writeFileSync(join(TEST_BASE, 'MEMORY.md'), 'Important fact\n');

    expect(readLongTermMemory(TEST_BASE)).toBe('Important fact');
  });
});

describe('writeLongTermMemory', () => {
  it('writes memory file', () => {
    writeLongTermMemory(TEST_BASE, 'New memory');
    expect(readLongTermMemory(TEST_BASE)).toBe('New memory');
  });

  it('overwrites existing content', () => {
    writeLongTermMemory(TEST_BASE, 'First');
    writeLongTermMemory(TEST_BASE, 'Second');
    expect(readLongTermMemory(TEST_BASE)).toBe('Second');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Memory — daily logs
// ═══════════════════════════════════════════════════════════════════════════════

describe('readDailyLog', () => {
  it('returns empty string for non-existent log', () => {
    expect(readDailyLog(TEST_BASE, '2025-01-15')).toBe('');
  });

  it('reads existing daily log', () => {
    ensureMemoryDirs(TEST_BASE);
    const logPath = getDailyLogPath(TEST_BASE, '2025-01-15');
    writeFileSync(logPath, '# Notes for 2025-01-15\n\n- 10:00 AM: Did something\n');

    const content = readDailyLog(TEST_BASE, '2025-01-15');
    expect(content).toContain('Notes for 2025-01-15');
    expect(content).toContain('Did something');
  });
});

describe('appendToDailyLog', () => {
  it('creates log file with header on first append', () => {
    appendToDailyLog(TEST_BASE, 'First note');
    const today = new Date().toISOString().split('T')[0] ?? '';
    const content = readDailyLog(TEST_BASE, today);
    expect(content).toContain('Notes for');
    expect(content).toContain('First note');
  });

  it('includes category prefix when provided', () => {
    appendToDailyLog(TEST_BASE, 'Categorized note', 'coding');
    const today = new Date().toISOString().split('T')[0] ?? '';
    const content = readDailyLog(TEST_BASE, today);
    expect(content).toContain('[coding]');
    expect(content).toContain('Categorized note');
  });

  it('appends to existing log', () => {
    appendToDailyLog(TEST_BASE, 'First');
    appendToDailyLog(TEST_BASE, 'Second');
    const today = new Date().toISOString().split('T')[0] ?? '';
    const content = readDailyLog(TEST_BASE, today);
    expect(content).toContain('First');
    expect(content).toContain('Second');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Memory — formatMemorySection
// ═══════════════════════════════════════════════════════════════════════════════

describe('formatMemorySection', () => {
  it('returns empty string for empty state', () => {
    expect(formatMemorySection({ longTerm: '', todayLog: '', recentLogs: [] })).toBe('');
  });

  it('includes long-term memory when present', () => {
    const result = formatMemorySection({
      longTerm: 'Important fact',
      todayLog: '',
      recentLogs: [],
    });
    expect(result).toContain('# Memory');
    expect(result).toContain('Long-Term Memory');
    expect(result).toContain('Important fact');
  });

  it('includes recent logs when present', () => {
    const result = formatMemorySection({
      longTerm: '',
      todayLog: '',
      recentLogs: [{ date: '2025-01-15', content: 'Day notes' }],
    });
    expect(result).toContain('Recent Notes');
    expect(result).toContain('2025-01-15');
    expect(result).toContain('Day notes');
  });

  it('includes both sections', () => {
    const result = formatMemorySection({
      longTerm: 'Long term',
      todayLog: 'Today log',
      recentLogs: [{ date: '2025-01-15', content: 'Recent' }],
    });
    expect(result).toContain('Long-Term Memory');
    expect(result).toContain('Recent Notes');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Memory — createMemoryManager
// ═══════════════════════════════════════════════════════════════════════════════

describe('createMemoryManager', () => {
  it('creates a manager with workspace path', () => {
    const manager = createMemoryManager({ workspacePath: TEST_BASE });
    expect(manager.workspacePath).toBe(TEST_BASE);
  });

  it('updateLongTerm writes and load reads', () => {
    const manager = createMemoryManager({ workspacePath: TEST_BASE });
    manager.updateLongTerm('Manager memory');

    const state = manager.load();
    expect(state.longTerm).toBe('Manager memory');
  });

  it('appendNote writes to daily log', () => {
    const manager = createMemoryManager({ workspacePath: TEST_BASE });
    manager.appendNote('Manager note', 'test');

    const state = manager.load();
    expect(state.todayLog).toContain('Manager note');
    expect(state.todayLog).toContain('[test]');
  });

  it('getPromptSection returns formatted section', () => {
    const manager = createMemoryManager({ workspacePath: TEST_BASE });
    manager.updateLongTerm('Some memory');

    const section = manager.getPromptSection();
    expect(section).toContain('# Memory');
    expect(section).toContain('Some memory');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Memory — parseMemoryCommands
// ═══════════════════════════════════════════════════════════════════════════════

describe('parseMemoryCommands', () => {
  it('returns empty for no commands', () => {
    expect(parseMemoryCommands('Just normal text')).toEqual([]);
  });

  it('parses [NOTE] command', () => {
    const cmds = parseMemoryCommands('[NOTE] User prefers dark mode');
    expect(cmds.length).toBe(1);
    expect(cmds[0]!.type).toBe('note');
    expect(cmds[0]!.content).toContain('User prefers dark mode');
  });

  it('parses [REMEMBER] command', () => {
    const cmds = parseMemoryCommands('[REMEMBER] Important detail');
    expect(cmds.length).toBe(1);
    expect(cmds[0]!.type).toBe('note');
    expect(cmds[0]!.content).toContain('Important detail');
  });

  it('parses [MEMORY] command', () => {
    const cmds = parseMemoryCommands('[MEMORY] Updated knowledge');
    expect(cmds.length).toBe(1);
    expect(cmds[0]!.type).toBe('memory');
    expect(cmds[0]!.content).toContain('Updated knowledge');
  });

  it('parses [NOTE] with category', () => {
    const cmds = parseMemoryCommands('[NOTE][coding] Prefer TypeScript');
    expect(cmds.length).toBe(1);
    expect(cmds[0]!.category).toBe('coding');
    expect(cmds[0]!.content).toContain('Prefer TypeScript');
  });

  it('parses multiple commands', () => {
    const text = '[NOTE] First thing [REMEMBER] Second thing';
    const cmds = parseMemoryCommands(text);
    expect(cmds.length).toBe(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Memory — executeMemoryCommands
// ═══════════════════════════════════════════════════════════════════════════════

describe('executeMemoryCommands', () => {
  it('executes note commands', () => {
    const manager = createMemoryManager({ workspacePath: TEST_BASE });
    const commands = [{ type: 'note' as const, content: 'Test note' }];

    executeMemoryCommands(commands, manager);

    const state = manager.load();
    expect(state.todayLog).toContain('Test note');
  });

  it('executes memory commands by appending', () => {
    const manager = createMemoryManager({ workspacePath: TEST_BASE });
    manager.updateLongTerm('Existing');

    const commands = [{ type: 'memory' as const, content: 'New fact' }];
    executeMemoryCommands(commands, manager);

    const state = manager.load();
    expect(state.longTerm).toContain('Existing');
    expect(state.longTerm).toContain('New fact');
  });
});
