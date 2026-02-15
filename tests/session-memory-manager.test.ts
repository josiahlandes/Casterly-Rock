import { describe, expect, it } from 'vitest';

import { SessionManager, createSessionManager } from '../src/coding/session-memory/manager.js';
import type { SessionMemory } from '../src/coding/session-memory/types.js';

// ─── Test helpers ────────────────────────────────────────────────────────────

const ROOT = '/tmp/test-project';

function makeManager(overrides: Partial<SessionMemory> | undefined = undefined): SessionManager {
  if (overrides) {
    const existing: SessionMemory = {
      sessionId: 'test-session',
      startedAt: '2025-01-01T00:00:00.000Z',
      rootPath: ROOT,
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
    return createSessionManager({ rootPath: ROOT }, existing);
  }
  return createSessionManager({ rootPath: ROOT });
}

// ═══════════════════════════════════════════════════════════════════════════════
// SessionManager — constructor and session info
// ═══════════════════════════════════════════════════════════════════════════════

describe('SessionManager — constructor', () => {
  it('creates new session with generated ID', () => {
    const mgr = makeManager();
    expect(mgr.getSessionId()).toMatch(/^\d{4}-\d{2}-\d{2}-[a-f0-9]{8}$/);
  });

  it('creates new session with ISO start time', () => {
    const before = new Date().toISOString();
    const mgr = makeManager();
    expect(mgr.getStartedAt()).toBeTruthy();
    expect(mgr.getStartedAt() >= before).toBe(true);
  });

  it('uses existing memory when provided', () => {
    const mgr = makeManager({ sessionId: 'existing-123' });
    expect(mgr.getSessionId()).toBe('existing-123');
  });

  it('preserves existing memory fields', () => {
    const mgr = makeManager({
      currentTask: 'Fix the bug',
      taskHistory: ['Setup project'],
    });
    expect(mgr.getCurrentTask()).toBe('Fix the bug');
    expect(mgr.getTaskHistory()).toEqual(['Setup project']);
  });

  it('starts not dirty', () => {
    const mgr = makeManager();
    expect(mgr.isDirty()).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SessionManager — endSession
// ═══════════════════════════════════════════════════════════════════════════════

describe('SessionManager — endSession', () => {
  it('sets endedAt timestamp', () => {
    const mgr = makeManager();
    mgr.endSession();
    const mem = mgr.getMemory();
    expect(mem.endedAt).toBeTruthy();
  });

  it('marks as dirty', () => {
    const mgr = makeManager();
    mgr.endSession();
    expect(mgr.isDirty()).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SessionManager — task management
// ═══════════════════════════════════════════════════════════════════════════════

describe('SessionManager — task management', () => {
  it('setCurrentTask stores the task', () => {
    const mgr = makeManager();
    mgr.setCurrentTask('Write tests');
    expect(mgr.getCurrentTask()).toBe('Write tests');
  });

  it('setCurrentTask moves previous task to history', () => {
    const mgr = makeManager();
    mgr.setCurrentTask('Task A');
    mgr.setCurrentTask('Task B');
    expect(mgr.getTaskHistory()).toEqual(['Task A']);
    expect(mgr.getCurrentTask()).toBe('Task B');
  });

  it('setCurrentTask does not duplicate when same task', () => {
    const mgr = makeManager();
    mgr.setCurrentTask('Task A');
    mgr.setCurrentTask('Task A');
    expect(mgr.getTaskHistory()).toEqual([]);
  });

  it('tracks multiple task transitions', () => {
    const mgr = makeManager();
    mgr.setCurrentTask('Task A');
    mgr.setCurrentTask('Task B');
    mgr.setCurrentTask('Task C');
    expect(mgr.getTaskHistory()).toEqual(['Task A', 'Task B']);
  });

  it('getCurrentTask returns undefined when no task set', () => {
    const mgr = makeManager();
    expect(mgr.getCurrentTask()).toBeUndefined();
  });

  it('setCurrentTask marks as dirty', () => {
    const mgr = makeManager();
    mgr.setCurrentTask('Task');
    expect(mgr.isDirty()).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SessionManager — todo management
// ═══════════════════════════════════════════════════════════════════════════════

describe('SessionManager — todo management', () => {
  it('addTodo returns todo with ID', () => {
    const mgr = makeManager();
    const todo = mgr.addTodo('Fix the bug');
    expect(todo.id).toBeTruthy();
    expect(todo.content).toBe('Fix the bug');
    expect(todo.status).toBe('pending');
  });

  it('addTodo with priority', () => {
    const mgr = makeManager();
    const todo = mgr.addTodo('Urgent fix', { priority: 'high' });
    expect(todo.priority).toBe('high');
  });

  it('addTodo with parentId', () => {
    const mgr = makeManager();
    const parent = mgr.addTodo('Parent task');
    const child = mgr.addTodo('Subtask', { parentId: parent.id });
    expect(child.parentId).toBe(parent.id);
  });

  it('addTodo marks as dirty', () => {
    const mgr = makeManager();
    mgr.addTodo('Test');
    expect(mgr.isDirty()).toBe(true);
  });

  it('getTodos returns all todos', () => {
    const mgr = makeManager();
    mgr.addTodo('A');
    mgr.addTodo('B');
    expect(mgr.getTodos()).toHaveLength(2);
  });

  it('getTodos returns a copy', () => {
    const mgr = makeManager();
    mgr.addTodo('A');
    const todos = mgr.getTodos();
    todos.push({ id: 'fake', content: 'Fake', status: 'pending', createdAt: '' });
    expect(mgr.getTodos()).toHaveLength(1);
  });

  it('updateTodoStatus changes status', () => {
    const mgr = makeManager();
    const todo = mgr.addTodo('Fix the bug');
    const result = mgr.updateTodoStatus(todo.id, 'in_progress');
    expect(result).toBe(true);
    expect(mgr.getTodosByStatus('in_progress')).toHaveLength(1);
  });

  it('updateTodoStatus sets completedAt for completed', () => {
    const mgr = makeManager();
    const todo = mgr.addTodo('Fix it');
    mgr.updateTodoStatus(todo.id, 'completed');
    const completed = mgr.getCompletedTodos();
    expect(completed[0]!.completedAt).toBeTruthy();
  });

  it('updateTodoStatus returns false for unknown ID', () => {
    const mgr = makeManager();
    expect(mgr.updateTodoStatus('nonexistent', 'completed')).toBe(false);
  });

  it('updateTodoContent changes content', () => {
    const mgr = makeManager();
    const todo = mgr.addTodo('Old content');
    const result = mgr.updateTodoContent(todo.id, 'New content');
    expect(result).toBe(true);
    expect(mgr.getTodos()[0]!.content).toBe('New content');
  });

  it('updateTodoContent returns false for unknown ID', () => {
    const mgr = makeManager();
    expect(mgr.updateTodoContent('nonexistent', 'stuff')).toBe(false);
  });

  it('removeTodo removes the todo', () => {
    const mgr = makeManager();
    const todo = mgr.addTodo('Remove me');
    const result = mgr.removeTodo(todo.id);
    expect(result).toBe(true);
    expect(mgr.getTodos()).toHaveLength(0);
  });

  it('removeTodo returns false for unknown ID', () => {
    const mgr = makeManager();
    expect(mgr.removeTodo('nonexistent')).toBe(false);
  });

  it('getTodosByStatus filters correctly', () => {
    const mgr = makeManager();
    const t1 = mgr.addTodo('A');
    mgr.addTodo('B');
    mgr.updateTodoStatus(t1.id, 'in_progress');
    expect(mgr.getTodosByStatus('pending')).toHaveLength(1);
    expect(mgr.getTodosByStatus('in_progress')).toHaveLength(1);
  });

  it('getPendingTodos returns pending', () => {
    const mgr = makeManager();
    mgr.addTodo('Pending');
    expect(mgr.getPendingTodos()).toHaveLength(1);
  });

  it('getInProgressTodos returns in_progress', () => {
    const mgr = makeManager();
    const todo = mgr.addTodo('WIP');
    mgr.updateTodoStatus(todo.id, 'in_progress');
    expect(mgr.getInProgressTodos()).toHaveLength(1);
  });

  it('getCompletedTodos returns completed', () => {
    const mgr = makeManager();
    const todo = mgr.addTodo('Done');
    mgr.updateTodoStatus(todo.id, 'completed');
    expect(mgr.getCompletedTodos()).toHaveLength(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SessionManager — file tracking
// ═══════════════════════════════════════════════════════════════════════════════

describe('SessionManager — file tracking', () => {
  it('recordFileRead adds to filesRead', () => {
    const mgr = makeManager();
    mgr.recordFileRead('/src/index.ts');
    expect(mgr.getFilesRead()).toContain('/src/index.ts');
  });

  it('recordFileRead deduplicates', () => {
    const mgr = makeManager();
    mgr.recordFileRead('/src/index.ts');
    mgr.recordFileRead('/src/index.ts');
    expect(mgr.getFilesRead()).toHaveLength(1);
  });

  it('recordFileRead adds file operation', () => {
    const mgr = makeManager();
    mgr.recordFileRead('/src/index.ts', 500);
    const ops = mgr.getFileOperations();
    expect(ops).toHaveLength(1);
    expect(ops[0]!.operation).toBe('read');
    expect(ops[0]!.tokens).toBe(500);
  });

  it('recordFileModified adds to filesModified', () => {
    const mgr = makeManager();
    mgr.recordFileModified('/src/index.ts');
    expect(mgr.getFilesModified()).toContain('/src/index.ts');
  });

  it('recordFileModified deduplicates', () => {
    const mgr = makeManager();
    mgr.recordFileModified('/src/index.ts');
    mgr.recordFileModified('/src/index.ts');
    expect(mgr.getFilesModified()).toHaveLength(1);
  });

  it('recordFileCreated adds to filesCreated', () => {
    const mgr = makeManager();
    mgr.recordFileCreated('/src/new.ts');
    expect(mgr.getFilesCreated()).toContain('/src/new.ts');
  });

  it('recordFileCreated deduplicates', () => {
    const mgr = makeManager();
    mgr.recordFileCreated('/src/new.ts');
    mgr.recordFileCreated('/src/new.ts');
    expect(mgr.getFilesCreated()).toHaveLength(1);
  });

  it('recordFileDeleted adds to filesDeleted', () => {
    const mgr = makeManager();
    mgr.recordFileDeleted('/src/old.ts');
    expect(mgr.getFilesDeleted()).toContain('/src/old.ts');
  });

  it('recordFileDeleted deduplicates', () => {
    const mgr = makeManager();
    mgr.recordFileDeleted('/src/old.ts');
    mgr.recordFileDeleted('/src/old.ts');
    expect(mgr.getFilesDeleted()).toHaveLength(1);
  });

  it('recordFileMoved adds file operation with previousPath', () => {
    const mgr = makeManager();
    mgr.recordFileMoved('/src/old.ts', '/src/new.ts');
    const ops = mgr.getFileOperations();
    expect(ops).toHaveLength(1);
    expect(ops[0]!.operation).toBe('move');
    expect(ops[0]!.previousPath).toBe('/src/old.ts');
    expect(ops[0]!.path).toBe('/src/new.ts');
  });

  it('file operations are trimmed when exceeding maxFileOperations', () => {
    const mgr = createSessionManager({ rootPath: ROOT, maxFileOperations: 3 });
    mgr.recordFileRead('/a');
    mgr.recordFileRead('/b');
    mgr.recordFileRead('/c');
    mgr.recordFileRead('/d');
    mgr.recordFileRead('/e');
    // Should keep only the last 3
    const ops = mgr.getFileOperations();
    expect(ops).toHaveLength(3);
    expect(ops[0]!.path).toBe('/c');
    expect(ops[2]!.path).toBe('/e');
  });

  it('getters return copies', () => {
    const mgr = makeManager();
    mgr.recordFileRead('/a');
    const read = mgr.getFilesRead();
    read.push('/b');
    expect(mgr.getFilesRead()).toHaveLength(1);
  });

  it('file tracking marks as dirty', () => {
    const mgr = makeManager();
    mgr.recordFileRead('/a');
    expect(mgr.isDirty()).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SessionManager — decision logging
// ═══════════════════════════════════════════════════════════════════════════════

describe('SessionManager — decision logging', () => {
  it('logDecision returns decision with ID', () => {
    const mgr = makeManager();
    const dec = mgr.logDecision('Context', 'Chose A', 'Because faster');
    expect(dec.id).toBeTruthy();
    expect(dec.context).toBe('Context');
    expect(dec.decision).toBe('Chose A');
    expect(dec.reasoning).toBe('Because faster');
  });

  it('logDecision with relatedFiles', () => {
    const mgr = makeManager();
    const dec = mgr.logDecision('Ctx', 'Dec', 'Reason', {
      relatedFiles: ['/src/a.ts'],
    });
    expect(dec.relatedFiles).toEqual(['/src/a.ts']);
  });

  it('logDecision with tags', () => {
    const mgr = makeManager();
    const dec = mgr.logDecision('Ctx', 'Dec', 'Reason', {
      tags: ['architecture', 'performance'],
    });
    expect(dec.tags).toEqual(['architecture', 'performance']);
  });

  it('getDecisions returns all', () => {
    const mgr = makeManager();
    mgr.logDecision('A', 'A', 'A');
    mgr.logDecision('B', 'B', 'B');
    expect(mgr.getDecisions()).toHaveLength(2);
  });

  it('getDecisionsByTag filters by tag', () => {
    const mgr = makeManager();
    mgr.logDecision('A', 'A', 'A', { tags: ['arch'] });
    mgr.logDecision('B', 'B', 'B', { tags: ['perf'] });
    expect(mgr.getDecisionsByTag('arch')).toHaveLength(1);
    expect(mgr.getDecisionsByTag('nonexistent')).toHaveLength(0);
  });

  it('getRecentDecisions returns last N', () => {
    const mgr = makeManager();
    for (let i = 0; i < 10; i++) {
      mgr.logDecision(`D${i}`, `D${i}`, `R${i}`);
    }
    const recent = mgr.getRecentDecisions(3);
    expect(recent).toHaveLength(3);
    expect(recent[0]!.context).toBe('D7');
  });

  it('getRecentDecisions defaults to 5', () => {
    const mgr = makeManager();
    for (let i = 0; i < 10; i++) {
      mgr.logDecision(`D${i}`, `D${i}`, `R${i}`);
    }
    expect(mgr.getRecentDecisions()).toHaveLength(5);
  });

  it('logDecision marks as dirty', () => {
    const mgr = makeManager();
    mgr.logDecision('C', 'D', 'R');
    expect(mgr.isDirty()).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SessionManager — learnings
// ═══════════════════════════════════════════════════════════════════════════════

describe('SessionManager — learnings', () => {
  it('addLearning returns learning with ID', () => {
    const mgr = makeManager();
    const learning = mgr.addLearning('Use vitest for testing');
    expect(learning.id).toBeTruthy();
    expect(learning.content).toBe('Use vitest for testing');
  });

  it('addLearning with context', () => {
    const mgr = makeManager();
    const learning = mgr.addLearning('Tip', { context: 'During debugging' });
    expect(learning.context).toBe('During debugging');
  });

  it('addLearning with patterns', () => {
    const mgr = makeManager();
    const learning = mgr.addLearning('Tip', { patterns: ['factory pattern'] });
    expect(learning.patterns).toEqual(['factory pattern']);
  });

  it('addLearning with appliesTo', () => {
    const mgr = makeManager();
    const learning = mgr.addLearning('Tip', { appliesTo: ['*.test.ts'] });
    expect(learning.appliesTo).toEqual(['*.test.ts']);
  });

  it('getLearnings returns all', () => {
    const mgr = makeManager();
    mgr.addLearning('A');
    mgr.addLearning('B');
    expect(mgr.getLearnings()).toHaveLength(2);
  });

  it('getLearningsForFile matches glob patterns', () => {
    const mgr = makeManager();
    mgr.addLearning('Test learning', { appliesTo: ['*.test.ts'] });
    mgr.addLearning('Source learning', { appliesTo: ['src/*'] });
    mgr.addLearning('No pattern');

    expect(mgr.getLearningsForFile('foo.test.ts')).toHaveLength(1);
    expect(mgr.getLearningsForFile('src/index.ts')).toHaveLength(1);
    expect(mgr.getLearningsForFile('other.ts')).toHaveLength(0);
  });

  it('getLearningsForFile excludes learnings without appliesTo', () => {
    const mgr = makeManager();
    mgr.addLearning('General learning');
    expect(mgr.getLearningsForFile('anything.ts')).toHaveLength(0);
  });

  it('addLearning marks as dirty', () => {
    const mgr = makeManager();
    mgr.addLearning('Tip');
    expect(mgr.isDirty()).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SessionManager — conversation summary
// ═══════════════════════════════════════════════════════════════════════════════

describe('SessionManager — conversation summary', () => {
  it('setConversationSummary stores summary', () => {
    const mgr = makeManager();
    mgr.setConversationSummary('We discussed the bug');
    expect(mgr.getConversationSummary()).toBe('We discussed the bug');
  });

  it('getConversationSummary returns undefined when not set', () => {
    const mgr = makeManager();
    expect(mgr.getConversationSummary()).toBeUndefined();
  });

  it('setConversationSummary marks as dirty', () => {
    const mgr = makeManager();
    mgr.setConversationSummary('Summary');
    expect(mgr.isDirty()).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SessionManager — metadata
// ═══════════════════════════════════════════════════════════════════════════════

describe('SessionManager — metadata', () => {
  it('setMetadata and getMetadata round-trip', () => {
    const mgr = makeManager();
    mgr.setMetadata('key', 'value');
    expect(mgr.getMetadata('key')).toBe('value');
  });

  it('setMetadata creates metadata object if absent', () => {
    const mgr = makeManager();
    mgr.setMetadata('count', 42);
    expect(mgr.getMetadata('count')).toBe(42);
  });

  it('getMetadata returns undefined for unknown key', () => {
    const mgr = makeManager();
    expect(mgr.getMetadata('nonexistent')).toBeUndefined();
  });

  it('setMetadata supports complex values', () => {
    const mgr = makeManager();
    mgr.setMetadata('config', { nested: true, count: 5 });
    expect(mgr.getMetadata('config')).toEqual({ nested: true, count: 5 });
  });

  it('setMetadata marks as dirty', () => {
    const mgr = makeManager();
    mgr.setMetadata('k', 'v');
    expect(mgr.isDirty()).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SessionManager — state management (dirty / markSaved)
// ═══════════════════════════════════════════════════════════════════════════════

describe('SessionManager — state management', () => {
  it('isDirty returns false initially', () => {
    const mgr = makeManager();
    expect(mgr.isDirty()).toBe(false);
  });

  it('markSaved resets dirty flag', () => {
    const mgr = makeManager();
    mgr.addTodo('Test');
    expect(mgr.isDirty()).toBe(true);
    mgr.markSaved();
    expect(mgr.isDirty()).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SessionManager — getMemory
// ═══════════════════════════════════════════════════════════════════════════════

describe('SessionManager — getMemory', () => {
  it('returns a copy of memory', () => {
    const mgr = makeManager();
    const mem = mgr.getMemory();
    mem.sessionId = 'tampered';
    expect(mgr.getSessionId()).not.toBe('tampered');
  });

  it('includes all fields', () => {
    const mgr = makeManager();
    mgr.setCurrentTask('Task A');
    mgr.addTodo('Todo A');
    mgr.recordFileRead('/a');
    mgr.logDecision('C', 'D', 'R');
    mgr.addLearning('L');

    const mem = mgr.getMemory();
    expect(mem.currentTask).toBe('Task A');
    expect(mem.todos).toHaveLength(1);
    expect(mem.filesRead).toHaveLength(1);
    expect(mem.decisions).toHaveLength(1);
    expect(mem.learnings).toHaveLength(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SessionManager — getSummary
// ═══════════════════════════════════════════════════════════════════════════════

describe('SessionManager — getSummary', () => {
  it('includes session ID', () => {
    const mgr = makeManager({ sessionId: 'test-sess-001' });
    expect(mgr.getSummary()).toContain('test-sess-001');
  });

  it('includes current task when set', () => {
    const mgr = makeManager();
    mgr.setCurrentTask('Write tests');
    expect(mgr.getSummary()).toContain('Write tests');
  });

  it('includes todo counts', () => {
    const mgr = makeManager();
    mgr.addTodo('Pending');
    const t = mgr.addTodo('Done');
    mgr.updateTodoStatus(t.id, 'completed');
    const summary = mgr.getSummary();
    expect(summary).toContain('1 pending');
    expect(summary).toContain('1 completed');
  });

  it('includes file counts', () => {
    const mgr = makeManager();
    mgr.recordFileRead('/a');
    mgr.recordFileModified('/b');
    const summary = mgr.getSummary();
    expect(summary).toContain('1 read');
    expect(summary).toContain('1 modified');
  });

  it('includes decision and learning counts', () => {
    const mgr = makeManager();
    mgr.logDecision('C', 'D', 'R');
    mgr.addLearning('L');
    const summary = mgr.getSummary();
    expect(summary).toContain('Decisions: 1');
    expect(summary).toContain('Learnings: 1');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// createSessionManager — factory
// ═══════════════════════════════════════════════════════════════════════════════

describe('createSessionManager', () => {
  it('returns a SessionManager instance', () => {
    const mgr = createSessionManager({ rootPath: ROOT });
    expect(mgr).toBeInstanceOf(SessionManager);
  });

  it('accepts existing memory', () => {
    const existing: SessionMemory = {
      sessionId: 'existing',
      startedAt: '2025-01-01T00:00:00.000Z',
      rootPath: ROOT,
      taskHistory: ['old task'],
      todos: [],
      filesRead: [],
      filesModified: [],
      filesCreated: [],
      filesDeleted: [],
      fileOperations: [],
      decisions: [],
      learnings: [],
    };
    const mgr = createSessionManager({ rootPath: ROOT }, existing);
    expect(mgr.getSessionId()).toBe('existing');
    expect(mgr.getTaskHistory()).toEqual(['old task']);
  });
});
