import { describe, expect, it } from 'vitest';

import { SessionManager, createSessionManager } from '../src/coding/session-memory/manager.js';

// ═══════════════════════════════════════════════════════════════════════════════
// Construction
// ═══════════════════════════════════════════════════════════════════════════════

describe('SessionManager — construction', () => {
  it('creates with generated session ID', () => {
    const sm = new SessionManager({ rootPath: '/tmp/project' });
    expect(sm.getSessionId()).toBeTruthy();
    expect(sm.getSessionId().length).toBeGreaterThan(10);
  });

  it('creates with ISO timestamp', () => {
    const sm = new SessionManager({ rootPath: '/tmp/project' });
    expect(sm.getStartedAt()).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('accepts existing memory', () => {
    const existing = {
      sessionId: 'existing-session',
      startedAt: '2025-01-01T00:00:00.000Z',
      rootPath: '/tmp',
      taskHistory: [],
      todos: [],
      filesRead: [],
      filesModified: [],
      filesCreated: [],
      filesDeleted: [],
      fileOperations: [],
      decisions: [],
      learnings: [],
    };
    const sm = new SessionManager({ rootPath: '/tmp' }, existing);
    expect(sm.getSessionId()).toBe('existing-session');
  });
});

describe('createSessionManager', () => {
  it('returns a SessionManager instance', () => {
    const sm = createSessionManager({ rootPath: '/tmp/project' });
    expect(sm).toBeInstanceOf(SessionManager);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Task Management
// ═══════════════════════════════════════════════════════════════════════════════

describe('SessionManager — tasks', () => {
  it('sets and gets current task', () => {
    const sm = new SessionManager({ rootPath: '/tmp' });
    sm.setCurrentTask('Implement login page');
    expect(sm.getCurrentTask()).toBe('Implement login page');
  });

  it('records previous task in history when changing', () => {
    const sm = new SessionManager({ rootPath: '/tmp' });
    sm.setCurrentTask('Task A');
    sm.setCurrentTask('Task B');
    expect(sm.getCurrentTask()).toBe('Task B');
    expect(sm.getTaskHistory()).toEqual(['Task A']);
  });

  it('does not add to history when same task is set', () => {
    const sm = new SessionManager({ rootPath: '/tmp' });
    sm.setCurrentTask('Same');
    sm.setCurrentTask('Same');
    expect(sm.getTaskHistory()).toEqual([]);
  });

  it('returns undefined for current task initially', () => {
    const sm = new SessionManager({ rootPath: '/tmp' });
    expect(sm.getCurrentTask()).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Todo Management
// ═══════════════════════════════════════════════════════════════════════════════

describe('SessionManager — todos', () => {
  it('adds a todo with pending status', () => {
    const sm = new SessionManager({ rootPath: '/tmp' });
    const todo = sm.addTodo('Write tests');
    expect(todo.content).toBe('Write tests');
    expect(todo.status).toBe('pending');
    expect(todo.id).toBeTruthy();
    expect(todo.createdAt).toBeTruthy();
  });

  it('adds todo with priority', () => {
    const sm = new SessionManager({ rootPath: '/tmp' });
    const todo = sm.addTodo('Critical fix', { priority: 'high' });
    expect(todo.priority).toBe('high');
  });

  it('adds subtask with parentId', () => {
    const sm = new SessionManager({ rootPath: '/tmp' });
    const parent = sm.addTodo('Parent task');
    const child = sm.addTodo('Subtask', { parentId: parent.id });
    expect(child.parentId).toBe(parent.id);
  });

  it('updates todo status', () => {
    const sm = new SessionManager({ rootPath: '/tmp' });
    const todo = sm.addTodo('In progress task');
    const updated = sm.updateTodoStatus(todo.id, 'in_progress');
    expect(updated).toBe(true);
    expect(sm.getTodos()[0]!.status).toBe('in_progress');
  });

  it('sets completedAt when marking completed', () => {
    const sm = new SessionManager({ rootPath: '/tmp' });
    const todo = sm.addTodo('Done task');
    sm.updateTodoStatus(todo.id, 'completed');
    expect(sm.getTodos()[0]!.completedAt).toBeTruthy();
  });

  it('returns false for non-existent todo update', () => {
    const sm = new SessionManager({ rootPath: '/tmp' });
    expect(sm.updateTodoStatus('nonexistent', 'completed')).toBe(false);
  });

  it('updates todo content', () => {
    const sm = new SessionManager({ rootPath: '/tmp' });
    const todo = sm.addTodo('Original');
    sm.updateTodoContent(todo.id, 'Updated');
    expect(sm.getTodos()[0]!.content).toBe('Updated');
  });

  it('returns false for non-existent todo content update', () => {
    const sm = new SessionManager({ rootPath: '/tmp' });
    expect(sm.updateTodoContent('nonexistent', 'text')).toBe(false);
  });

  it('removes a todo', () => {
    const sm = new SessionManager({ rootPath: '/tmp' });
    const todo = sm.addTodo('To remove');
    expect(sm.removeTodo(todo.id)).toBe(true);
    expect(sm.getTodos()).toHaveLength(0);
  });

  it('returns false for removing non-existent todo', () => {
    const sm = new SessionManager({ rootPath: '/tmp' });
    expect(sm.removeTodo('nonexistent')).toBe(false);
  });

  it('filters todos by status', () => {
    const sm = new SessionManager({ rootPath: '/tmp' });
    const t1 = sm.addTodo('Pending');
    const t2 = sm.addTodo('In progress');
    const t3 = sm.addTodo('Done');
    sm.updateTodoStatus(t2.id, 'in_progress');
    sm.updateTodoStatus(t3.id, 'completed');

    expect(sm.getPendingTodos()).toHaveLength(1);
    expect(sm.getInProgressTodos()).toHaveLength(1);
    expect(sm.getCompletedTodos()).toHaveLength(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// File Tracking
// ═══════════════════════════════════════════════════════════════════════════════

describe('SessionManager — file tracking', () => {
  it('records file reads', () => {
    const sm = new SessionManager({ rootPath: '/tmp' });
    sm.recordFileRead('src/index.ts');
    sm.recordFileRead('src/utils.ts');
    expect(sm.getFilesRead()).toEqual(['src/index.ts', 'src/utils.ts']);
  });

  it('deduplicates file reads', () => {
    const sm = new SessionManager({ rootPath: '/tmp' });
    sm.recordFileRead('src/index.ts');
    sm.recordFileRead('src/index.ts');
    expect(sm.getFilesRead()).toHaveLength(1);
  });

  it('records file modifications', () => {
    const sm = new SessionManager({ rootPath: '/tmp' });
    sm.recordFileModified('src/utils.ts');
    expect(sm.getFilesModified()).toEqual(['src/utils.ts']);
  });

  it('records file creations', () => {
    const sm = new SessionManager({ rootPath: '/tmp' });
    sm.recordFileCreated('src/new-file.ts');
    expect(sm.getFilesCreated()).toEqual(['src/new-file.ts']);
  });

  it('records file deletions', () => {
    const sm = new SessionManager({ rootPath: '/tmp' });
    sm.recordFileDeleted('src/old-file.ts');
    expect(sm.getFilesDeleted()).toEqual(['src/old-file.ts']);
  });

  it('records file moves', () => {
    const sm = new SessionManager({ rootPath: '/tmp' });
    sm.recordFileMoved('src/old.ts', 'src/new.ts');
    const ops = sm.getFileOperations();
    const moveOp = ops.find((o) => o.operation === 'move');
    expect(moveOp).toBeDefined();
    expect(moveOp!.path).toBe('src/new.ts');
    expect(moveOp!.previousPath).toBe('src/old.ts');
  });

  it('records operations with timestamps', () => {
    const sm = new SessionManager({ rootPath: '/tmp' });
    sm.recordFileRead('test.ts');
    const ops = sm.getFileOperations();
    expect(ops[0]!.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('records token count for reads', () => {
    const sm = new SessionManager({ rootPath: '/tmp' });
    sm.recordFileRead('test.ts', 500);
    const ops = sm.getFileOperations();
    expect(ops[0]!.tokens).toBe(500);
  });

  it('trims operations when over maxFileOperations', () => {
    const sm = new SessionManager({ rootPath: '/tmp', maxFileOperations: 3 });
    sm.recordFileRead('a.ts');
    sm.recordFileRead('b.ts');
    sm.recordFileRead('c.ts');
    sm.recordFileRead('d.ts');
    const ops = sm.getFileOperations();
    expect(ops.length).toBeLessThanOrEqual(3);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Decision Logging
// ═══════════════════════════════════════════════════════════════════════════════

describe('SessionManager — decisions', () => {
  it('logs a decision', () => {
    const sm = new SessionManager({ rootPath: '/tmp' });
    const d = sm.logDecision('Choosing ORM', 'Use Prisma', 'Better type safety');
    expect(d.context).toBe('Choosing ORM');
    expect(d.decision).toBe('Use Prisma');
    expect(d.reasoning).toBe('Better type safety');
    expect(d.id).toBeTruthy();
  });

  it('logs decision with related files', () => {
    const sm = new SessionManager({ rootPath: '/tmp' });
    const d = sm.logDecision('Approach', 'Direct merge', 'Simpler', {
      relatedFiles: ['src/db.ts'],
    });
    expect(d.relatedFiles).toEqual(['src/db.ts']);
  });

  it('logs decision with tags', () => {
    const sm = new SessionManager({ rootPath: '/tmp' });
    const d = sm.logDecision('Architecture', 'Monolith', 'Simplicity', {
      tags: ['architecture', 'deployment'],
    });
    expect(d.tags).toEqual(['architecture', 'deployment']);
  });

  it('gets decisions by tag', () => {
    const sm = new SessionManager({ rootPath: '/tmp' });
    sm.logDecision('A', 'a', 'r', { tags: ['design'] });
    sm.logDecision('B', 'b', 'r', { tags: ['perf'] });
    sm.logDecision('C', 'c', 'r', { tags: ['design', 'perf'] });

    const design = sm.getDecisionsByTag('design');
    expect(design.length).toBe(2);
  });

  it('gets recent decisions', () => {
    const sm = new SessionManager({ rootPath: '/tmp' });
    for (let i = 0; i < 10; i++) {
      sm.logDecision(`D${i}`, `d${i}`, `r${i}`);
    }
    const recent = sm.getRecentDecisions(3);
    expect(recent.length).toBe(3);
    expect(recent[0]!.context).toBe('D7');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Learnings
// ═══════════════════════════════════════════════════════════════════════════════

describe('SessionManager — learnings', () => {
  it('adds a learning', () => {
    const sm = new SessionManager({ rootPath: '/tmp' });
    const l = sm.addLearning('Always check null');
    expect(l.content).toBe('Always check null');
    expect(l.id).toBeTruthy();
  });

  it('adds learning with context', () => {
    const sm = new SessionManager({ rootPath: '/tmp' });
    const l = sm.addLearning('Use strict mode', { context: 'TypeScript config' });
    expect(l.context).toBe('TypeScript config');
  });

  it('adds learning with patterns', () => {
    const sm = new SessionManager({ rootPath: '/tmp' });
    const l = sm.addLearning('Error handling', { patterns: ['try-catch'] });
    expect(l.patterns).toEqual(['try-catch']);
  });

  it('gets learnings for a file pattern', () => {
    const sm = new SessionManager({ rootPath: '/tmp' });
    sm.addLearning('TS strict null', { appliesTo: ['src/*.ts'] });
    sm.addLearning('CSS modules', { appliesTo: ['src/*.css'] });
    sm.addLearning('General', {}); // no appliesTo

    const tsLearnings = sm.getLearningsForFile('src/utils.ts');
    expect(tsLearnings.length).toBe(1);
    expect(tsLearnings[0]!.content).toBe('TS strict null');
  });

  it('returns empty for non-matching file', () => {
    const sm = new SessionManager({ rootPath: '/tmp' });
    sm.addLearning('Only JS', { appliesTo: ['*.js'] });
    expect(sm.getLearningsForFile('test.ts')).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// State Management
// ═══════════════════════════════════════════════════════════════════════════════

describe('SessionManager — state', () => {
  it('starts not dirty', () => {
    const sm = new SessionManager({ rootPath: '/tmp' });
    expect(sm.isDirty()).toBe(false);
  });

  it('becomes dirty after modifications', () => {
    const sm = new SessionManager({ rootPath: '/tmp' });
    sm.setCurrentTask('Test');
    expect(sm.isDirty()).toBe(true);
  });

  it('can be marked as saved', () => {
    const sm = new SessionManager({ rootPath: '/tmp' });
    sm.setCurrentTask('Test');
    sm.markSaved();
    expect(sm.isDirty()).toBe(false);
  });

  it('ends session with timestamp', () => {
    const sm = new SessionManager({ rootPath: '/tmp' });
    sm.endSession();
    const memory = sm.getMemory();
    expect(memory.endedAt).toBeTruthy();
    expect(memory.endedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('sets and gets conversation summary', () => {
    const sm = new SessionManager({ rootPath: '/tmp' });
    sm.setConversationSummary('User asked about tests');
    expect(sm.getConversationSummary()).toBe('User asked about tests');
  });

  it('sets and gets metadata', () => {
    const sm = new SessionManager({ rootPath: '/tmp' });
    sm.setMetadata('model', 'gpt-oss:120b');
    expect(sm.getMetadata('model')).toBe('gpt-oss:120b');
  });

  it('returns undefined for unknown metadata', () => {
    const sm = new SessionManager({ rootPath: '/tmp' });
    expect(sm.getMetadata('unknown')).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// getSummary
// ═══════════════════════════════════════════════════════════════════════════════

describe('SessionManager — getSummary', () => {
  it('includes session ID', () => {
    const sm = new SessionManager({ rootPath: '/tmp' });
    const summary = sm.getSummary();
    expect(summary).toContain('Session:');
    expect(summary).toContain(sm.getSessionId());
  });

  it('includes current task when set', () => {
    const sm = new SessionManager({ rootPath: '/tmp' });
    sm.setCurrentTask('Build feature X');
    const summary = sm.getSummary();
    expect(summary).toContain('Current Task: Build feature X');
  });

  it('includes todo counts', () => {
    const sm = new SessionManager({ rootPath: '/tmp' });
    sm.addTodo('Pending');
    const t = sm.addTodo('In progress');
    sm.updateTodoStatus(t.id, 'in_progress');
    const summary = sm.getSummary();
    expect(summary).toContain('1 pending');
    expect(summary).toContain('1 in progress');
  });

  it('includes file counts', () => {
    const sm = new SessionManager({ rootPath: '/tmp' });
    sm.recordFileRead('a.ts');
    sm.recordFileModified('b.ts');
    sm.recordFileCreated('c.ts');
    const summary = sm.getSummary();
    expect(summary).toContain('1 read');
    expect(summary).toContain('1 modified');
    expect(summary).toContain('1 created');
  });

  it('includes decision and learning counts', () => {
    const sm = new SessionManager({ rootPath: '/tmp' });
    sm.logDecision('A', 'B', 'C');
    sm.addLearning('L1');
    const summary = sm.getSummary();
    expect(summary).toContain('Decisions: 1');
    expect(summary).toContain('Learnings: 1');
  });
});
