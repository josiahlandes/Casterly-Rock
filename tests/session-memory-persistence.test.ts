import { describe, expect, it, afterEach } from 'vitest';
import { existsSync, rmSync, mkdirSync, readFileSync } from 'node:fs';
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

const TEST_BASE = join(tmpdir(), `casterly-session-persist-test-${Date.now()}`);

afterEach(() => {
  if (existsSync(TEST_BASE)) {
    rmSync(TEST_BASE, { recursive: true, force: true });
  }
});

function makeConfig(overrides: Partial<SessionMemoryConfig> = {}): SessionMemoryConfig {
  return {
    rootPath: TEST_BASE,
    sessionDir: join(TEST_BASE, '.casterly/sessions'),
    ...overrides,
  };
}

function makeMemory(overrides: Partial<SessionMemory> = {}): SessionMemory {
  return {
    sessionId: 'test-2025-01-01-abcd1234',
    startedAt: '2025-01-01T00:00:00.000Z',
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
  it('saves session to disk', async () => {
    mkdirSync(TEST_BASE, { recursive: true });
    const config = makeConfig();
    const memory = makeMemory();

    const result = await saveSession(memory, config);
    expect(result.success).toBe(true);
    expect(result.path).toBeTruthy();
    expect(existsSync(result.path!)).toBe(true);
  });

  it('creates directory if it does not exist', async () => {
    // TEST_BASE does not exist yet
    const config = makeConfig();
    const memory = makeMemory();

    const result = await saveSession(memory, config);
    expect(result.success).toBe(true);
  });

  it('writes valid YAML content', async () => {
    mkdirSync(TEST_BASE, { recursive: true });
    const config = makeConfig();
    const memory = makeMemory({ currentTask: 'Write tests' });

    const result = await saveSession(memory, config);
    const content = readFileSync(result.path!, 'utf-8');
    expect(content).toContain('session_id:');
    expect(content).toContain('started_at:');
    expect(content).toContain('current_task:');
  });

  it('saves todos with snake_case fields', async () => {
    mkdirSync(TEST_BASE, { recursive: true });
    const config = makeConfig();
    const memory = makeMemory({
      todos: [
        {
          id: 't1',
          content: 'Test todo',
          status: 'pending',
          createdAt: '2025-01-01T00:00:00.000Z',
          priority: 'high',
        },
      ],
    });

    const result = await saveSession(memory, config);
    const content = readFileSync(result.path!, 'utf-8');
    expect(content).toContain('created_at:');
    expect(content).toContain('Test todo');
  });

  it('saves decisions', async () => {
    mkdirSync(TEST_BASE, { recursive: true });
    const config = makeConfig();
    const memory = makeMemory({
      decisions: [
        {
          id: 'd1',
          timestamp: '2025-01-01T00:00:00.000Z',
          context: 'Setup',
          decision: 'Use vitest',
          reasoning: 'ES module support',
          tags: ['testing'],
        },
      ],
    });

    const result = await saveSession(memory, config);
    const content = readFileSync(result.path!, 'utf-8');
    expect(content).toContain('Use vitest');
    expect(content).toContain('testing');
  });

  it('saves learnings with applies_to', async () => {
    mkdirSync(TEST_BASE, { recursive: true });
    const config = makeConfig();
    const memory = makeMemory({
      learnings: [
        {
          id: 'l1',
          timestamp: '2025-01-01T00:00:00.000Z',
          content: 'Always add .js extension',
          appliesTo: ['*.ts'],
        },
      ],
    });

    const result = await saveSession(memory, config);
    const content = readFileSync(result.path!, 'utf-8');
    expect(content).toContain('applies_to:');
    expect(content).toContain('Always add .js extension');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// loadSession
// ═══════════════════════════════════════════════════════════════════════════════

describe('loadSession', () => {
  it('loads a previously saved session', async () => {
    mkdirSync(TEST_BASE, { recursive: true });
    const config = makeConfig();
    const memory = makeMemory({ currentTask: 'Build feature' });

    await saveSession(memory, config);
    const result = await loadSession('test-2025-01-01-abcd1234', config);

    expect(result.success).toBe(true);
    expect(result.memory).toBeDefined();
    expect(result.memory!.sessionId).toBe('test-2025-01-01-abcd1234');
    expect(result.memory!.currentTask).toBe('Build feature');
  });

  it('round-trips todos correctly', async () => {
    mkdirSync(TEST_BASE, { recursive: true });
    const config = makeConfig();
    const memory = makeMemory({
      todos: [
        {
          id: 't1',
          content: 'Fix bug',
          status: 'completed',
          createdAt: '2025-01-01T00:00:00.000Z',
          completedAt: '2025-01-01T01:00:00.000Z',
          priority: 'high',
          parentId: 'parent-1',
        },
      ],
    });

    await saveSession(memory, config);
    const result = await loadSession('test-2025-01-01-abcd1234', config);

    const todo = result.memory!.todos[0]!;
    expect(todo.content).toBe('Fix bug');
    expect(todo.status).toBe('completed');
    expect(todo.completedAt).toBe('2025-01-01T01:00:00.000Z');
    expect(todo.priority).toBe('high');
    expect(todo.parentId).toBe('parent-1');
  });

  it('round-trips decisions correctly', async () => {
    mkdirSync(TEST_BASE, { recursive: true });
    const config = makeConfig();
    const memory = makeMemory({
      decisions: [
        {
          id: 'd1',
          timestamp: '2025-01-01T00:00:00.000Z',
          context: 'Architecture',
          decision: 'Use factory pattern',
          reasoning: 'Testability',
          relatedFiles: ['/src/store.ts'],
          tags: ['architecture'],
        },
      ],
    });

    await saveSession(memory, config);
    const result = await loadSession('test-2025-01-01-abcd1234', config);

    const dec = result.memory!.decisions[0]!;
    expect(dec.decision).toBe('Use factory pattern');
    expect(dec.relatedFiles).toEqual(['/src/store.ts']);
    expect(dec.tags).toEqual(['architecture']);
  });

  it('round-trips learnings correctly', async () => {
    mkdirSync(TEST_BASE, { recursive: true });
    const config = makeConfig();
    const memory = makeMemory({
      learnings: [
        {
          id: 'l1',
          timestamp: '2025-01-01T00:00:00.000Z',
          content: 'Use .js imports',
          context: 'ES module setup',
          patterns: ['import * from'],
          appliesTo: ['*.ts'],
        },
      ],
    });

    await saveSession(memory, config);
    const result = await loadSession('test-2025-01-01-abcd1234', config);

    const learning = result.memory!.learnings[0]!;
    expect(learning.content).toBe('Use .js imports');
    expect(learning.context).toBe('ES module setup');
    expect(learning.patterns).toEqual(['import * from']);
    expect(learning.appliesTo).toEqual(['*.ts']);
  });

  it('returns error for nonexistent session', async () => {
    mkdirSync(TEST_BASE, { recursive: true });
    const config = makeConfig();

    const result = await loadSession('nonexistent', config);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Session not found');
  });

  it('fileOperations are empty after load (not persisted)', async () => {
    mkdirSync(TEST_BASE, { recursive: true });
    const config = makeConfig();
    const memory = makeMemory();

    await saveSession(memory, config);
    const result = await loadSession('test-2025-01-01-abcd1234', config);
    expect(result.memory!.fileOperations).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// listSessions
// ═══════════════════════════════════════════════════════════════════════════════

describe('listSessions', () => {
  it('lists saved sessions', async () => {
    mkdirSync(TEST_BASE, { recursive: true });
    const config = makeConfig();

    await saveSession(makeMemory({ sessionId: 'sess-a' }), config);
    await saveSession(makeMemory({ sessionId: 'sess-b' }), config);

    const result = await listSessions(config);
    expect(result.success).toBe(true);
    expect(result.sessions).toHaveLength(2);
  });

  it('includes session info', async () => {
    mkdirSync(TEST_BASE, { recursive: true });
    const config = makeConfig();

    await saveSession(
      makeMemory({
        sessionId: 'sess-info',
        currentTask: 'Debug',
        todos: [{ id: 't1', content: 'A', status: 'pending', createdAt: '2025-01-01T00:00:00.000Z' }],
      }),
      config
    );

    const result = await listSessions(config);
    const info = result.sessions!.find((s) => s.sessionId === 'sess-info');
    expect(info).toBeDefined();
    expect(info!.currentTask).toBe('Debug');
    expect(info!.todoCount).toBe(1);
    expect(info!.modifiedAt).toBeTruthy();
  });

  it('returns empty array for nonexistent directory', async () => {
    const config = makeConfig({
      sessionDir: join(TEST_BASE, 'nonexistent-sessions-dir'),
    });

    const result = await listSessions(config);
    expect(result.success).toBe(true);
    expect(result.sessions).toEqual([]);
  });

  it('sorts by modification time descending', async () => {
    mkdirSync(TEST_BASE, { recursive: true });
    const config = makeConfig();

    await saveSession(makeMemory({ sessionId: 'older' }), config);
    // Small delay to ensure different mtime
    await new Promise((r) => setTimeout(r, 50));
    await saveSession(makeMemory({ sessionId: 'newer' }), config);

    const result = await listSessions(config);
    expect(result.sessions![0]!.sessionId).toBe('newer');
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

    const load = await loadSession('to-delete', config);
    expect(load.success).toBe(false);
  });

  it('succeeds for nonexistent session (already deleted)', async () => {
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
  it('loads the most recently modified session', async () => {
    mkdirSync(TEST_BASE, { recursive: true });
    const config = makeConfig();

    await saveSession(makeMemory({ sessionId: 'old-session' }), config);
    await new Promise((r) => setTimeout(r, 50));
    await saveSession(makeMemory({ sessionId: 'new-session' }), config);

    const result = await getMostRecentSession(config);
    expect(result.success).toBe(true);
    expect(result.memory!.sessionId).toBe('new-session');
  });

  it('returns error when no sessions exist', async () => {
    mkdirSync(TEST_BASE, { recursive: true });
    const config = makeConfig();

    const result = await getMostRecentSession(config);
    expect(result.success).toBe(false);
    expect(result.error).toContain('No sessions found');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// cleanupOldSessions
// ═══════════════════════════════════════════════════════════════════════════════

describe('cleanupOldSessions', () => {
  it('deletes sessions beyond keepCount', async () => {
    mkdirSync(TEST_BASE, { recursive: true });
    const config = makeConfig();

    for (let i = 0; i < 5; i++) {
      await saveSession(makeMemory({ sessionId: `sess-${i}` }), config);
      await new Promise((r) => setTimeout(r, 20));
    }

    const result = await cleanupOldSessions(config, 2);
    expect(result.success).toBe(true);
    expect(result.deleted).toBe(3);

    const remaining = await listSessions(config);
    expect(remaining.sessions).toHaveLength(2);
  });

  it('does nothing when fewer than keepCount sessions', async () => {
    mkdirSync(TEST_BASE, { recursive: true });
    const config = makeConfig();

    await saveSession(makeMemory({ sessionId: 'only-one' }), config);

    const result = await cleanupOldSessions(config, 10);
    expect(result.success).toBe(true);
    expect(result.deleted).toBe(0);
  });

  it('handles empty session directory', async () => {
    mkdirSync(TEST_BASE, { recursive: true });
    const config = makeConfig();

    const result = await cleanupOldSessions(config, 5);
    expect(result.success).toBe(true);
    expect(result.deleted).toBe(0);
  });
});
