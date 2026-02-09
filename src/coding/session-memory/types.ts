/**
 * Session Memory Types
 *
 * Type definitions for session state persistence.
 */

/**
 * A todo item.
 */
export interface Todo {
  /** Unique identifier */
  id: string;
  /** Todo content/description */
  content: string;
  /** Current status */
  status: TodoStatus;
  /** When created */
  createdAt: string;
  /** When completed (if applicable) */
  completedAt?: string;
  /** Priority level */
  priority?: TodoPriority;
  /** Parent todo ID for subtasks */
  parentId?: string;
}

/**
 * Todo status.
 */
export type TodoStatus = 'pending' | 'in_progress' | 'completed' | 'blocked' | 'cancelled';

/**
 * Todo priority.
 */
export type TodoPriority = 'high' | 'medium' | 'low';

/**
 * A decision made during the session.
 */
export interface Decision {
  /** Unique identifier */
  id: string;
  /** When the decision was made */
  timestamp: string;
  /** Context/situation that led to the decision */
  context: string;
  /** The decision that was made */
  decision: string;
  /** Reasoning behind the decision */
  reasoning: string;
  /** Related file paths */
  relatedFiles?: string[];
  /** Tags for categorization */
  tags?: string[];
}

/**
 * A learning from the session (for future reference).
 */
export interface Learning {
  /** Unique identifier */
  id: string;
  /** When learned */
  timestamp: string;
  /** What was learned */
  content: string;
  /** Context in which it was learned */
  context?: string;
  /** Related patterns or code */
  patterns?: string[];
  /** Applicable file patterns */
  appliesTo?: string[];
}

/**
 * File operation record.
 */
export interface FileOperation {
  /** File path */
  path: string;
  /** Operation type */
  operation: 'read' | 'create' | 'modify' | 'delete' | 'move';
  /** When the operation occurred */
  timestamp: string;
  /** Token count (for reads) */
  tokens?: number;
  /** Previous path (for moves) */
  previousPath?: string;
}

/**
 * Complete session memory state.
 */
export interface SessionMemory {
  /** Unique session identifier */
  sessionId: string;
  /** When the session started */
  startedAt: string;
  /** When the session ended (if applicable) */
  endedAt?: string;
  /** Repository root path */
  rootPath: string;

  /** Current high-level task description */
  currentTask?: string;
  /** Task history */
  taskHistory: string[];

  /** Todo list */
  todos: Todo[];

  /** Files read during session */
  filesRead: string[];
  /** Files modified during session */
  filesModified: string[];
  /** Files created during session */
  filesCreated: string[];
  /** Files deleted during session */
  filesDeleted: string[];
  /** Detailed file operations log */
  fileOperations: FileOperation[];

  /** Decisions made during session */
  decisions: Decision[];

  /** Learnings from session */
  learnings: Learning[];

  /** Conversation summary (for context compression) */
  conversationSummary?: string;

  /** Custom metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Session memory configuration.
 */
export interface SessionMemoryConfig {
  /** Root path of the repository */
  rootPath: string;
  /** Directory to store session files */
  sessionDir?: string;
  /** Maximum file operations to keep in log */
  maxFileOperations?: number;
  /** Auto-save interval in milliseconds (0 to disable) */
  autoSaveInterval?: number;
}

/**
 * Default configuration.
 */
export const DEFAULT_SESSION_CONFIG: Required<Omit<SessionMemoryConfig, 'rootPath'>> = {
  sessionDir: '.casterly/sessions',
  maxFileOperations: 1000,
  autoSaveInterval: 30000, // 30 seconds
};

/**
 * Session file format (for YAML serialization).
 */
export interface SessionFile {
  session_id: string;
  started_at: string;
  ended_at?: string;
  root_path: string;
  current_task?: string;
  task_history: string[];
  todos: Array<{
    id: string;
    content: string;
    status: string;
    created_at: string;
    completed_at?: string;
    priority?: string;
    parent_id?: string;
  }>;
  files_read: string[];
  files_modified: string[];
  files_created: string[];
  files_deleted: string[];
  decisions: Array<{
    id: string;
    timestamp: string;
    context: string;
    decision: string;
    reasoning: string;
    related_files?: string[];
    tags?: string[];
  }>;
  learnings: Array<{
    id: string;
    timestamp: string;
    content: string;
    context?: string;
    patterns?: string[];
    applies_to?: string[];
  }>;
  conversation_summary?: string;
  metadata?: Record<string, unknown>;
}
