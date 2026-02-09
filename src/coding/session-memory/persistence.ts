/**
 * Session Persistence
 *
 * Save and load session memory to/from disk using YAML format.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as YAML from 'yaml';
import type { SessionMemory, SessionFile, SessionMemoryConfig, Todo, Decision, Learning } from './types.js';
import { DEFAULT_SESSION_CONFIG } from './types.js';

/**
 * Convert a Todo to file format.
 */
function todoToFile(t: Todo): SessionFile['todos'][0] {
  const result: SessionFile['todos'][0] = {
    id: t.id,
    content: t.content,
    status: t.status,
    created_at: t.createdAt,
  };
  if (t.completedAt) result.completed_at = t.completedAt;
  if (t.priority) result.priority = t.priority;
  if (t.parentId) result.parent_id = t.parentId;
  return result;
}

/**
 * Convert a Decision to file format.
 */
function decisionToFile(d: Decision): SessionFile['decisions'][0] {
  const result: SessionFile['decisions'][0] = {
    id: d.id,
    timestamp: d.timestamp,
    context: d.context,
    decision: d.decision,
    reasoning: d.reasoning,
  };
  if (d.relatedFiles) result.related_files = d.relatedFiles;
  if (d.tags) result.tags = d.tags;
  return result;
}

/**
 * Convert a Learning to file format.
 */
function learningToFile(l: Learning): SessionFile['learnings'][0] {
  const result: SessionFile['learnings'][0] = {
    id: l.id,
    timestamp: l.timestamp,
    content: l.content,
  };
  if (l.context) result.context = l.context;
  if (l.patterns) result.patterns = l.patterns;
  if (l.appliesTo) result.applies_to = l.appliesTo;
  return result;
}

/**
 * Convert SessionMemory to SessionFile (snake_case for YAML).
 */
function memoryToFile(memory: SessionMemory): SessionFile {
  const result: SessionFile = {
    session_id: memory.sessionId,
    started_at: memory.startedAt,
    root_path: memory.rootPath,
    task_history: memory.taskHistory,
    todos: memory.todos.map(todoToFile),
    files_read: memory.filesRead,
    files_modified: memory.filesModified,
    files_created: memory.filesCreated,
    files_deleted: memory.filesDeleted,
    decisions: memory.decisions.map(decisionToFile),
    learnings: memory.learnings.map(learningToFile),
  };

  if (memory.endedAt) result.ended_at = memory.endedAt;
  if (memory.currentTask) result.current_task = memory.currentTask;
  if (memory.conversationSummary) result.conversation_summary = memory.conversationSummary;
  if (memory.metadata) result.metadata = memory.metadata;

  return result;
}

/**
 * Convert file todo to Todo.
 */
function fileTodoToTodo(t: SessionFile['todos'][0]): Todo {
  const result: Todo = {
    id: t.id,
    content: t.content,
    status: t.status as Todo['status'],
    createdAt: t.created_at,
  };
  if (t.completed_at) result.completedAt = t.completed_at;
  if (t.priority === 'high' || t.priority === 'medium' || t.priority === 'low') {
    result.priority = t.priority;
  }
  if (t.parent_id) result.parentId = t.parent_id;
  return result;
}

/**
 * Convert file decision to Decision.
 */
function fileDecisionToDecision(d: SessionFile['decisions'][0]): Decision {
  const result: Decision = {
    id: d.id,
    timestamp: d.timestamp,
    context: d.context,
    decision: d.decision,
    reasoning: d.reasoning,
  };
  if (d.related_files) result.relatedFiles = d.related_files;
  if (d.tags) result.tags = d.tags;
  return result;
}

/**
 * Convert file learning to Learning.
 */
function fileLearningToLearning(l: SessionFile['learnings'][0]): Learning {
  const result: Learning = {
    id: l.id,
    timestamp: l.timestamp,
    content: l.content,
  };
  if (l.context) result.context = l.context;
  if (l.patterns) result.patterns = l.patterns;
  if (l.applies_to) result.appliesTo = l.applies_to;
  return result;
}

/**
 * Convert SessionFile to SessionMemory (camelCase for TypeScript).
 */
function fileToMemory(file: SessionFile): SessionMemory {
  const result: SessionMemory = {
    sessionId: file.session_id,
    startedAt: file.started_at,
    rootPath: file.root_path,
    taskHistory: file.task_history || [],
    todos: (file.todos || []).map(fileTodoToTodo),
    filesRead: file.files_read || [],
    filesModified: file.files_modified || [],
    filesCreated: file.files_created || [],
    filesDeleted: file.files_deleted || [],
    fileOperations: [], // Not persisted in file format
    decisions: (file.decisions || []).map(fileDecisionToDecision),
    learnings: (file.learnings || []).map(fileLearningToLearning),
  };

  if (file.ended_at) result.endedAt = file.ended_at;
  if (file.current_task) result.currentTask = file.current_task;
  if (file.conversation_summary) result.conversationSummary = file.conversation_summary;
  if (file.metadata) result.metadata = file.metadata;

  return result;
}

/**
 * Get the session file path.
 */
function getSessionFilePath(
  sessionId: string,
  rootPath: string,
  sessionDir: string
): string {
  const dir = path.isAbsolute(sessionDir)
    ? sessionDir
    : path.join(rootPath, sessionDir);
  return path.join(dir, `${sessionId}.yaml`);
}

/**
 * Save session memory to disk.
 */
export async function saveSession(
  memory: SessionMemory,
  config: SessionMemoryConfig
): Promise<{ success: boolean; path?: string; error?: string }> {
  const sessionDir = config.sessionDir ?? DEFAULT_SESSION_CONFIG.sessionDir;
  const filePath = getSessionFilePath(memory.sessionId, memory.rootPath, sessionDir);

  try {
    // Ensure directory exists
    await fs.mkdir(path.dirname(filePath), { recursive: true });

    // Convert to file format
    const fileContent = memoryToFile(memory);

    // Serialize to YAML
    const yaml = YAML.stringify(fileContent, {
      indent: 2,
      lineWidth: 0, // No line wrapping
    });

    // Write file
    await fs.writeFile(filePath, yaml, 'utf-8');

    return { success: true, path: filePath };
  } catch (err) {
    return {
      success: false,
      error: `Failed to save session: ${(err as Error).message}`,
    };
  }
}

/**
 * Load session memory from disk.
 */
export async function loadSession(
  sessionId: string,
  config: SessionMemoryConfig
): Promise<{ success: boolean; memory?: SessionMemory; error?: string }> {
  const sessionDir = config.sessionDir ?? DEFAULT_SESSION_CONFIG.sessionDir;
  const filePath = getSessionFilePath(sessionId, config.rootPath, sessionDir);

  try {
    const content = await fs.readFile(filePath, 'utf-8');
    const fileContent = YAML.parse(content) as SessionFile;
    const memory = fileToMemory(fileContent);

    return { success: true, memory };
  } catch (err) {
    const error = err as NodeJS.ErrnoException;
    if (error.code === 'ENOENT') {
      return {
        success: false,
        error: `Session not found: ${sessionId}`,
      };
    }
    return {
      success: false,
      error: `Failed to load session: ${error.message}`,
    };
  }
}

/**
 * Session info for listing.
 */
export interface SessionInfo {
  sessionId: string;
  startedAt: string;
  endedAt?: string;
  currentTask?: string;
  todoCount: number;
  modifiedAt: string;
}

/**
 * List all saved sessions.
 */
export async function listSessions(
  config: SessionMemoryConfig
): Promise<{ success: boolean; sessions?: SessionInfo[]; error?: string }> {
  const sessionDir = config.sessionDir ?? DEFAULT_SESSION_CONFIG.sessionDir;
  const dir = path.isAbsolute(sessionDir)
    ? sessionDir
    : path.join(config.rootPath, sessionDir);

  try {
    const files = await fs.readdir(dir);
    const sessions: SessionInfo[] = [];

    for (const file of files) {
      if (!file.endsWith('.yaml')) continue;

      const sessionId = file.replace('.yaml', '');
      const filePath = path.join(dir, file);

      try {
        const stat = await fs.stat(filePath);
        const content = await fs.readFile(filePath, 'utf-8');
        const parsed = YAML.parse(content) as SessionFile;

        const info: SessionInfo = {
          sessionId,
          startedAt: parsed.started_at,
          todoCount: parsed.todos?.length ?? 0,
          modifiedAt: stat.mtime.toISOString(),
        };
        if (parsed.ended_at) info.endedAt = parsed.ended_at;
        if (parsed.current_task) info.currentTask = parsed.current_task;

        sessions.push(info);
      } catch {
        // Skip files we can't read
        continue;
      }
    }

    // Sort by modification time (most recent first)
    sessions.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));

    return { success: true, sessions };
  } catch (err) {
    const error = err as NodeJS.ErrnoException;
    if (error.code === 'ENOENT') {
      return { success: true, sessions: [] };
    }
    return {
      success: false,
      error: `Failed to list sessions: ${error.message}`,
    };
  }
}

/**
 * Delete a session file.
 */
export async function deleteSession(
  sessionId: string,
  config: SessionMemoryConfig
): Promise<{ success: boolean; error?: string }> {
  const sessionDir = config.sessionDir ?? DEFAULT_SESSION_CONFIG.sessionDir;
  const filePath = getSessionFilePath(sessionId, config.rootPath, sessionDir);

  try {
    await fs.unlink(filePath);
    return { success: true };
  } catch (err) {
    const error = err as NodeJS.ErrnoException;
    if (error.code === 'ENOENT') {
      return { success: true }; // Already deleted
    }
    return {
      success: false,
      error: `Failed to delete session: ${error.message}`,
    };
  }
}

/**
 * Get the most recent session.
 */
export async function getMostRecentSession(
  config: SessionMemoryConfig
): Promise<{ success: boolean; memory?: SessionMemory; error?: string }> {
  const listResult = await listSessions(config);

  if (!listResult.success) {
    const result: { success: boolean; memory?: SessionMemory; error?: string } = {
      success: false,
    };
    if (listResult.error) result.error = listResult.error;
    return result;
  }

  if (!listResult.sessions || listResult.sessions.length === 0) {
    return { success: false, error: 'No sessions found' };
  }

  const mostRecent = listResult.sessions[0];
  if (!mostRecent) {
    return { success: false, error: 'No sessions found' };
  }

  return loadSession(mostRecent.sessionId, config);
}

/**
 * Clean up old sessions, keeping only the most recent N.
 */
export async function cleanupOldSessions(
  config: SessionMemoryConfig,
  keepCount: number = 10
): Promise<{ success: boolean; deleted?: number; error?: string }> {
  const listResult = await listSessions(config);

  if (!listResult.success) {
    const result: { success: boolean; deleted?: number; error?: string } = {
      success: false,
    };
    if (listResult.error) result.error = listResult.error;
    return result;
  }

  const sessions = listResult.sessions ?? [];
  if (sessions.length <= keepCount) {
    return { success: true, deleted: 0 };
  }

  const toDelete = sessions.slice(keepCount);
  let deleted = 0;

  for (const session of toDelete) {
    const result = await deleteSession(session.sessionId, config);
    if (result.success) {
      deleted++;
    }
  }

  return { success: true, deleted };
}
