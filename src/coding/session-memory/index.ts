/**
 * Session Memory Module
 *
 * Tracks session state including todos, decisions, file operations,
 * and learnings. Persists to disk for continuity across sessions.
 */

export { SessionManager, createSessionManager } from './manager.js';
export {
  saveSession,
  loadSession,
  listSessions,
  deleteSession,
  getMostRecentSession,
  cleanupOldSessions,
} from './persistence.js';
export type { SessionInfo } from './persistence.js';
export * from './types.js';
