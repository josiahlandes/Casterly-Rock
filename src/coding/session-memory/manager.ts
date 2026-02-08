/**
 * Session Manager
 *
 * Manages session state, tracking todos, decisions, file operations,
 * and learnings throughout a coding session.
 */

import * as crypto from 'crypto';
import type {
  SessionMemory,
  SessionMemoryConfig,
  Todo,
  TodoStatus,
  TodoPriority,
  Decision,
  Learning,
  FileOperation,
} from './types.js';
import { DEFAULT_SESSION_CONFIG } from './types.js';

/**
 * Generate a unique ID.
 */
function generateId(): string {
  return crypto.randomBytes(8).toString('hex');
}

/**
 * Generate a session ID based on date and random suffix.
 */
function generateSessionId(): string {
  const date = new Date().toISOString().split('T')[0];
  const suffix = crypto.randomBytes(4).toString('hex');
  return `${date}-${suffix}`;
}

/**
 * Session manager for tracking state during a coding session.
 */
export class SessionManager {
  private memory: SessionMemory;
  private config: Required<Omit<SessionMemoryConfig, 'rootPath'>>;
  private dirty: boolean = false;

  constructor(config: SessionMemoryConfig, existingMemory?: SessionMemory) {
    this.config = {
      ...DEFAULT_SESSION_CONFIG,
      ...config,
    };

    if (existingMemory) {
      this.memory = existingMemory;
    } else {
      this.memory = {
        sessionId: generateSessionId(),
        startedAt: new Date().toISOString(),
        rootPath: config.rootPath,
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
    }
  }

  // ========== Session Info ==========

  /**
   * Get session ID.
   */
  getSessionId(): string {
    return this.memory.sessionId;
  }

  /**
   * Get when session started.
   */
  getStartedAt(): string {
    return this.memory.startedAt;
  }

  /**
   * End the session.
   */
  endSession(): void {
    this.memory.endedAt = new Date().toISOString();
    this.dirty = true;
  }

  /**
   * Get the full session memory state.
   */
  getMemory(): SessionMemory {
    return { ...this.memory };
  }

  // ========== Task Management ==========

  /**
   * Set the current task.
   */
  setCurrentTask(task: string): void {
    if (this.memory.currentTask && this.memory.currentTask !== task) {
      this.memory.taskHistory.push(this.memory.currentTask);
    }
    this.memory.currentTask = task;
    this.dirty = true;
  }

  /**
   * Get the current task.
   */
  getCurrentTask(): string | undefined {
    return this.memory.currentTask;
  }

  /**
   * Get task history.
   */
  getTaskHistory(): string[] {
    return [...this.memory.taskHistory];
  }

  // ========== Todo Management ==========

  /**
   * Add a todo.
   */
  addTodo(content: string, options: { priority?: TodoPriority; parentId?: string } = {}): Todo {
    const todo: Todo = {
      id: generateId(),
      content,
      status: 'pending',
      createdAt: new Date().toISOString(),
      ...(options.priority ? { priority: options.priority } : {}),
      ...(options.parentId ? { parentId: options.parentId } : {}),
    };
    this.memory.todos.push(todo);
    this.dirty = true;
    return todo;
  }

  /**
   * Update a todo's status.
   */
  updateTodoStatus(todoId: string, status: TodoStatus): boolean {
    const todo = this.memory.todos.find((t) => t.id === todoId);
    if (!todo) return false;

    todo.status = status;
    if (status === 'completed') {
      todo.completedAt = new Date().toISOString();
    }
    this.dirty = true;
    return true;
  }

  /**
   * Update a todo's content.
   */
  updateTodoContent(todoId: string, content: string): boolean {
    const todo = this.memory.todos.find((t) => t.id === todoId);
    if (!todo) return false;

    todo.content = content;
    this.dirty = true;
    return true;
  }

  /**
   * Remove a todo.
   */
  removeTodo(todoId: string): boolean {
    const index = this.memory.todos.findIndex((t) => t.id === todoId);
    if (index === -1) return false;

    this.memory.todos.splice(index, 1);
    this.dirty = true;
    return true;
  }

  /**
   * Get all todos.
   */
  getTodos(): Todo[] {
    return [...this.memory.todos];
  }

  /**
   * Get todos by status.
   */
  getTodosByStatus(status: TodoStatus): Todo[] {
    return this.memory.todos.filter((t) => t.status === status);
  }

  /**
   * Get pending todos.
   */
  getPendingTodos(): Todo[] {
    return this.getTodosByStatus('pending');
  }

  /**
   * Get in-progress todos.
   */
  getInProgressTodos(): Todo[] {
    return this.getTodosByStatus('in_progress');
  }

  /**
   * Get completed todos.
   */
  getCompletedTodos(): Todo[] {
    return this.getTodosByStatus('completed');
  }

  // ========== File Tracking ==========

  /**
   * Record a file read.
   */
  recordFileRead(path: string, tokens?: number): void {
    if (!this.memory.filesRead.includes(path)) {
      this.memory.filesRead.push(path);
    }
    this.addFileOperation({
      path,
      operation: 'read',
      timestamp: new Date().toISOString(),
      ...(tokens !== undefined ? { tokens } : {}),
    });
    this.dirty = true;
  }

  /**
   * Record a file modification.
   */
  recordFileModified(path: string): void {
    if (!this.memory.filesModified.includes(path)) {
      this.memory.filesModified.push(path);
    }
    this.addFileOperation({
      path,
      operation: 'modify',
      timestamp: new Date().toISOString(),
    });
    this.dirty = true;
  }

  /**
   * Record a file creation.
   */
  recordFileCreated(path: string): void {
    if (!this.memory.filesCreated.includes(path)) {
      this.memory.filesCreated.push(path);
    }
    this.addFileOperation({
      path,
      operation: 'create',
      timestamp: new Date().toISOString(),
    });
    this.dirty = true;
  }

  /**
   * Record a file deletion.
   */
  recordFileDeleted(path: string): void {
    if (!this.memory.filesDeleted.includes(path)) {
      this.memory.filesDeleted.push(path);
    }
    this.addFileOperation({
      path,
      operation: 'delete',
      timestamp: new Date().toISOString(),
    });
    this.dirty = true;
  }

  /**
   * Record a file move.
   */
  recordFileMoved(oldPath: string, newPath: string): void {
    this.addFileOperation({
      path: newPath,
      operation: 'move',
      timestamp: new Date().toISOString(),
      previousPath: oldPath,
    });
    this.dirty = true;
  }

  /**
   * Add a file operation to the log.
   */
  private addFileOperation(operation: FileOperation): void {
    this.memory.fileOperations.push(operation);

    // Trim if over limit
    if (this.memory.fileOperations.length > this.config.maxFileOperations) {
      this.memory.fileOperations = this.memory.fileOperations.slice(-this.config.maxFileOperations);
    }
  }

  /**
   * Get files read.
   */
  getFilesRead(): string[] {
    return [...this.memory.filesRead];
  }

  /**
   * Get files modified.
   */
  getFilesModified(): string[] {
    return [...this.memory.filesModified];
  }

  /**
   * Get files created.
   */
  getFilesCreated(): string[] {
    return [...this.memory.filesCreated];
  }

  /**
   * Get files deleted.
   */
  getFilesDeleted(): string[] {
    return [...this.memory.filesDeleted];
  }

  /**
   * Get file operations log.
   */
  getFileOperations(): FileOperation[] {
    return [...this.memory.fileOperations];
  }

  // ========== Decision Logging ==========

  /**
   * Log a decision.
   */
  logDecision(
    context: string,
    decision: string,
    reasoning: string,
    options: { relatedFiles?: string[]; tags?: string[] } = {}
  ): Decision {
    const record: Decision = {
      id: generateId(),
      timestamp: new Date().toISOString(),
      context,
      decision,
      reasoning,
      ...(options.relatedFiles ? { relatedFiles: options.relatedFiles } : {}),
      ...(options.tags ? { tags: options.tags } : {}),
    };
    this.memory.decisions.push(record);
    this.dirty = true;
    return record;
  }

  /**
   * Get all decisions.
   */
  getDecisions(): Decision[] {
    return [...this.memory.decisions];
  }

  /**
   * Get decisions by tag.
   */
  getDecisionsByTag(tag: string): Decision[] {
    return this.memory.decisions.filter((d) => d.tags?.includes(tag));
  }

  /**
   * Get recent decisions.
   */
  getRecentDecisions(count: number = 5): Decision[] {
    return this.memory.decisions.slice(-count);
  }

  // ========== Learnings ==========

  /**
   * Add a learning.
   */
  addLearning(
    content: string,
    options: { context?: string; patterns?: string[]; appliesTo?: string[] } = {}
  ): Learning {
    const learning: Learning = {
      id: generateId(),
      timestamp: new Date().toISOString(),
      content,
      ...(options.context ? { context: options.context } : {}),
      ...(options.patterns ? { patterns: options.patterns } : {}),
      ...(options.appliesTo ? { appliesTo: options.appliesTo } : {}),
    };
    this.memory.learnings.push(learning);
    this.dirty = true;
    return learning;
  }

  /**
   * Get all learnings.
   */
  getLearnings(): Learning[] {
    return [...this.memory.learnings];
  }

  /**
   * Get learnings applicable to a file pattern.
   */
  getLearningsForFile(filePath: string): Learning[] {
    return this.memory.learnings.filter((l) => {
      if (!l.appliesTo) return false;
      return l.appliesTo.some((pattern) => {
        // Simple glob matching
        const regex = new RegExp(
          '^' + pattern.replace(/\*/g, '.*').replace(/\?/g, '.') + '$'
        );
        return regex.test(filePath);
      });
    });
  }

  // ========== Conversation Summary ==========

  /**
   * Set conversation summary (for context compression).
   */
  setConversationSummary(summary: string): void {
    this.memory.conversationSummary = summary;
    this.dirty = true;
  }

  /**
   * Get conversation summary.
   */
  getConversationSummary(): string | undefined {
    return this.memory.conversationSummary;
  }

  // ========== Metadata ==========

  /**
   * Set metadata value.
   */
  setMetadata(key: string, value: unknown): void {
    if (!this.memory.metadata) {
      this.memory.metadata = {};
    }
    this.memory.metadata[key] = value;
    this.dirty = true;
  }

  /**
   * Get metadata value.
   */
  getMetadata(key: string): unknown {
    return this.memory.metadata?.[key];
  }

  // ========== State Management ==========

  /**
   * Check if there are unsaved changes.
   */
  isDirty(): boolean {
    return this.dirty;
  }

  /**
   * Mark as saved.
   */
  markSaved(): void {
    this.dirty = false;
  }

  /**
   * Get a summary of the session.
   */
  getSummary(): string {
    const lines: string[] = [];

    lines.push(`Session: ${this.memory.sessionId}`);
    lines.push(`Started: ${this.memory.startedAt}`);

    if (this.memory.currentTask) {
      lines.push(`Current Task: ${this.memory.currentTask}`);
    }

    const pendingCount = this.getPendingTodos().length;
    const inProgressCount = this.getInProgressTodos().length;
    const completedCount = this.getCompletedTodos().length;

    lines.push(
      `Todos: ${pendingCount} pending, ${inProgressCount} in progress, ${completedCount} completed`
    );

    lines.push(`Files: ${this.memory.filesRead.length} read, ${this.memory.filesModified.length} modified, ${this.memory.filesCreated.length} created`);

    lines.push(`Decisions: ${this.memory.decisions.length}`);
    lines.push(`Learnings: ${this.memory.learnings.length}`);

    return lines.join('\n');
  }
}

/**
 * Create a new session manager.
 */
export function createSessionManager(
  config: SessionMemoryConfig,
  existingMemory?: SessionMemory
): SessionManager {
  return new SessionManager(config, existingMemory);
}
