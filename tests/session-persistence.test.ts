import { describe, expect, it, afterEach } from 'vitest';
import { existsSync, rmSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  saveSession,
  loadSession,
  listSessions,
  deleteSession,
  getMostRecentSession,
  cleanupOldSessions,
} from '../src/coding/session-memory/persistence.js';
import type { SessionMemory, SessionMemoryConfig } from '../src/coding/session-memory/types.js';

// ─── Temp dir helpers ────────────────────────────────────────────────────────

const TEST_BASE = join(tmpdir(), `casterly-persist-test-${Date.now()}`);

afterEach(() => {
  if (existsSync(TEST_BASE)) {
    rmSync(TEST_BASE, { recursive: true, force: true });
  }
});

function makeConfig(overrides: Partial<SessionMemoryConfig> = {}): SessionMemoryConfig {
  return {
    rootPath: TEST_BASE,
    sessionDir: join(TEST_BASE, 'sessions'),
    ...overrides,
  };
}

function makeMemory(overrides: Partial<SessionMemory> = {}): SessionMemory {
  return {
    sessionId: 'test-session-001',
    startedAt: '2025-01-15T10:00:00.000Z',
    rootPath: TEST_BASE,
    taskHistory: [],
    todos: [],
    filesRead: [],
    filesModified: [],
    filesCreated: [],
    filesDeleted: [],
    fileOperations: [],
    decisions: [],
    learnings: [],
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// saveSession
// ═══════════════════════════════════════════════════════════════════════════════

describe('saveSession', () => {
  it('saves session as YAML file', async () => {
    mkdirSync(TEST_BASE, { recursive: true });
    const config = makeConfig();
    const memory = makeMemory();

    const result = await saveSession(memory, config);
    expect(result.success).toBe(true);
    expect(result.path).toBeTruthy();
    expect(result.path!.endsWith('.yaml')).toBe(true);
    expect(existsSync(result.path!)).toBe(true);
  });

  it('saves session with all fields populated', async () => {
    mkdirSync(TEST_BASE, { recursive: true });
    const config = makeConfig();
    const memory = makeMemory({
      currentTask: 'Build tests',
      endedAt: '2025-01-15T12:00:00.000Z',
      todos: [
        { id: 't1', content: 'Write test', status: 'completed', createdAt: '2025-01-15T10:00:00.000Z', completedAt: '2025-01-15T11:00:00.000Z', priority: 'high' },
      ],
      filesRead: ['src/index.ts'],
      filesModified: ['src/utils.ts'],
      decisions: [
        { id: 'd1', timestamp: '2025-01-15T10:30:00.000Z', context: 'ORM', decision: 'Prisma', reasoning: 'Types', tags: ['arch'] },
      ],
      learnings: [
        { id: 'l1', timestamp: '2025-01-15T10:45:00.000Z', content: 'Use strict mode', patterns: ['tsconfig'] },
      ],
      conversationSummary: 'Session about tests',
      metadata: { model: 'gpt-oss:120b' },
    });

    const result = await saveSession(memory, config);
    expect(result.success).toBe(true);

    // Verify YAML content
    const content = readFileSync(result.path!, 'utf-8');
    expect(content).toContain('session_id: test-session-001');
    expect(content).toContain('current_task: Build tests');
    expect(content).toContain('Write test');
    expect(content).toContain('Prisma');
    expect(content).toContain('Use strict mode');
  });

  it('creates directory if it does not exist', async () => {
    // Don't create TEST_BASE — saveSession should handle it
    const config = makeConfig();
    const memory = makeMemory();

    const result = await saveSession(memory, config);
    expect(result.success).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// loadSession
// ═══════════════════════════════════════════════════════════════════════════════

describe('loadSession', () => {
  it('loads a saved session', async () => {
    mkdirSync(TEST_BASE, { recursive: true });
    const config = makeConfig();
    const memory = makeMemory({ currentTask: 'Test loading' });

    await saveSession(memory, config);
    const result = await loadSession('test-session-001', config);

    expect(result.success).toBe(true);
    expect(result.memory).toBeDefined();
    expect(result.memory!.sessionId).toBe('test-session-001');
    expect(result.memory!.currentTask).toBe('Test loading');
  });

  it('returns error for non-existent session', async () => {
    mkdirSync(TEST_BASE, { recursive: true });
    const config = makeConfig();

    const result = await loadSession('nonexistent', config);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Session not found');
  });

  it('round-trips todos correctly', async () => {
    mkdirSync(TEST_BASE, { recursive: true });
    const config = makeConfig();
    const memory = makeMemory({
      todos: [
        { id: 't1', content: 'Task A', status: 'pending', createdAt: '2025-01-15T10:00:00.000Z', priority: 'high' },
        { id: 't2', content: 'Task B', status: 'completed', createdAt: '2025-01-15T10:00:00.000Z', completedAt: '2025-01-15T11:00:00.000Z' },
      ],
    });

    await saveSession(memory, config);
    const result = await loadSession('test-session-001', config);

    expect(result.memory!.todos.length).toBe(2);
    expect(result.memory!.todos[0]!.priority).toBe('high');
    expect(result.memory!.todos[1]!.completedAt).toBe('2025-01-15T11:00:00.000Z');
  });

  it('round-trips decisions with tags', async () => {
    mkdirSync(TEST_BASE, { recursive: true });
    const config = makeConfig();
    const memory = makeMemory({
      decisions: [
        { id: 'd1', timestamp: '2025-01-15T10:00:00.000Z', context: 'C', decision: 'D', reasoning: 'R', tags: ['a', 'b'], relatedFiles: ['f.ts'] },
      ],
    });

    await saveSession(memory, config);
    const result = await loadSession('test-session-001', config);

    expect(result.memory!.decisions[0]!.tags).toEqual(['a', 'b']);
    expect(result.memory!.decisions[0]!.relatedFiles).toEqual(['f.ts']);
  });

  it('round-trips learnings with appliesTo', async () => {
    mkdirSync(TEST_BASE, { recursive: true });
    const config = makeConfig();
    const memory = makeMemory({
      learnings: [
        { id: 'l1', timestamp: '2025-01-15T10:00:00.000Z', content: 'L', context: 'ctx', patterns: ['p1'], appliesTo: ['*.ts'] },
      ],
    });

    await saveSession(memory, config);
    const result = await loadSession('test-session-001', config);

    expect(result.memory!.learnings[0]!.appliesTo).toEqual(['*.ts']);
    expect(result.memory!.learnings[0]!.patterns).toEqual(['p1']);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// listSessions
// ═══════════════════════════════════════════════════════════════════════════════

describe('listSessions', () => {
  it('returns empty list when no sessions exist', async () => {
    const config = makeConfig();
    const result = await listSessions(config);
    expect(result.success).toBe(true);
    expect(result.sessions).toEqual([]);
  });

  it('lists saved sessions', async () => {
    mkdirSync(TEST_BASE, { recursive: true });
    const config = makeConfig();

    await saveSession(makeMemory({ sessionId: 'session-a' }), config);
    await saveSession(makeMemory({ sessionId: 'session-b' }), config);

    const result = await listSessions(config);
    expect(result.success).toBe(true);
    expect(result.sessions!.length).toBe(2);
  });

  it('includes session metadata', async () => {
    mkdirSync(TEST_BASE, { recursive: true });
    const config = makeConfig();

    await saveSession(makeMemory({
      sessionId: 'meta-test',
      currentTask: 'Building feature',
      todos: [
        { id: 't1', content: 'A', status: 'pending', createdAt: '2025-01-15T10:00:00.000Z' },
        { id: 't2', content: 'B', status: 'pending', createdAt: '2025-01-15T10:00:00.000Z' },
      ],
    }), config);

    const result = await listSessions(config);
    const session = result.sessions![0]!;
    expect(session.sessionId).toBe('meta-test');
    expect(session.currentTask).toBe('Building feature');
    expect(session.todoCount).toBe(2);
    expect(session.modifiedAt).toBeTruthy();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// deleteSession
// ═══════════════════════════════════════════════════════════════════════════════

describe('deleteSession', () => {
  it('deletes an existing session', async () => {
    mkdirSync(TEST_BASE, { recursive: true });
    const config = makeConfig();

    await saveSession(makeMemory({ sessionId: 'to-delete' }), config);
    const result = await deleteSession('to-delete', config);
    expect(result.success).toBe(true);

    const loadResult = await loadSession('to-delete', config);
    expect(loadResult.success).toBe(false);
  });

  it('succeeds for non-existent session (idempotent)', async () => {
    mkdirSync(TEST_BASE, { recursive: true });
    const config = makeConfig();

    const result = await deleteSession('nonexistent', config);
    expect(result.success).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// getMostRecentSession
// ═══════════════════════════════════════════════════════════════════════════════

describe('getMostRecentSession', () => {
  it('returns error when no sessions exist', async () => {
    const config = makeConfig();
    const result = await getMostRecentSession(config);
    expect(result.success).toBe(false);
    expect(result.error).toContain('No sessions found');
  });

  it('loads the most recently modified session', async () => {
    mkdirSync(TEST_BASE, { recursive: true });
    const config = makeConfig();

    await saveSession(makeMemory({ sessionId: 'old-session', currentTask: 'Old task' }), config);
    // Small delay to ensure different mtime
    await new Promise((resolve) => setTimeout(resolve, 50));
    await saveSession(makeMemory({ sessionId: 'new-session', currentTask: 'New task' }), config);

    const result = await getMostRecentSession(config);
    expect(result.success).toBe(true);
    expect(result.memory!.sessionId).toBe('new-session');
    expect(result.memory!.currentTask).toBe('New task');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// cleanupOldSessions
// ═══════════════════════════════════════════════════════════════════════════════

describe('cleanupOldSessions', () => {
  it('returns 0 when fewer sessions than keep count', async () => {
    mkdirSync(TEST_BASE, { recursive: true });
    const config = makeConfig();

    await saveSession(makeMemory({ sessionId: 's1' }), config);
    await saveSession(makeMemory({ sessionId: 's2' }), config);

    const result = await cleanupOldSessions(config, 10);
    expect(result.success).toBe(true);
    expect(result.deleted).toBe(0);
  });

  it('deletes oldest sessions beyond keep count', async () => {
    mkdirSync(TEST_BASE, { recursive: true });
    const config = makeConfig();

    for (let i = 0; i < 5; i++) {
      await saveSession(makeMemory({ sessionId: `s${i}` }), config);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    const result = await cleanupOldSessions(config, 2);
    expect(result.success).toBe(true);
    expect(result.deleted).toBe(3);

    // Verify only 2 remain
    const listResult = await listSessions(config);
    expect(listResult.sessions!.length).toBe(2);
  });
});
