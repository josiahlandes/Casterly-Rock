import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface Message {
  rowid: number;
  guid: string;
  text: string;
  isFromMe: boolean;
  date: Date;
  chatId: string;
  senderHandle: string;
}

export interface Chat {
  rowid: number;
  chatIdentifier: string;
  displayName: string | null;
}

const CHAT_DB_PATH = join(homedir(), 'Library', 'Messages', 'chat.db');

function runSqlite(query: string): string {
  if (!existsSync(CHAT_DB_PATH)) {
    throw new Error(`Messages database not found at ${CHAT_DB_PATH}`);
  }

  try {
    const result = execSync(`sqlite3 -json "${CHAT_DB_PATH}" "${query.replace(/"/g, '\\"')}"`, {
      encoding: 'utf-8',
      maxBuffer: 10 * 1024 * 1024,
    });
    return result.trim();
  } catch (error) {
    throw new Error(`SQLite query failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Convert Apple's CoreData timestamp (nanoseconds since 2001-01-01) to JS Date
 */
function appleTimestampToDate(timestamp: number): Date {
  // Apple uses nanoseconds since 2001-01-01 00:00:00 UTC
  const appleEpoch = new Date('2001-01-01T00:00:00Z').getTime();
  // Convert from nanoseconds to milliseconds
  const ms = timestamp / 1_000_000;
  return new Date(appleEpoch + ms);
}

/**
 * Get all chats (conversations)
 */
export function getChats(): Chat[] {
  const json = runSqlite(`
    SELECT ROWID as rowid, chat_identifier as chatIdentifier, display_name as displayName
    FROM chat
    ORDER BY ROWID DESC
  `);

  if (!json) return [];

  try {
    return JSON.parse(json) as Chat[];
  } catch {
    return [];
  }
}

/**
 * Get recent messages, optionally filtered by chat
 */
export function getRecentMessages(limit = 50, chatIdentifier?: string): Message[] {
  let query = `
    SELECT
      m.ROWID as rowid,
      m.guid,
      m.text,
      m.is_from_me as isFromMe,
      m.date,
      c.chat_identifier as chatId,
      COALESCE(h.id, '') as senderHandle
    FROM message m
    LEFT JOIN chat_message_join cmj ON m.ROWID = cmj.message_id
    LEFT JOIN chat c ON cmj.chat_id = c.ROWID
    LEFT JOIN handle h ON m.handle_id = h.ROWID
    WHERE m.text IS NOT NULL AND m.text != ''
  `;

  if (chatIdentifier) {
    query += ` AND c.chat_identifier = '${chatIdentifier.replace(/'/g, "''")}'`;
  }

  query += ` ORDER BY m.date DESC LIMIT ${limit}`;

  const json = runSqlite(query);

  if (!json) return [];

  try {
    const rows = JSON.parse(json) as Array<{
      rowid: number;
      guid: string;
      text: string;
      isFromMe: number;
      date: number;
      chatId: string;
      senderHandle: string;
    }>;

    return rows.map((row) => ({
      rowid: row.rowid,
      guid: row.guid,
      text: row.text,
      isFromMe: row.isFromMe === 1,
      date: appleTimestampToDate(row.date),
      chatId: row.chatId,
      senderHandle: row.senderHandle,
    }));
  } catch {
    return [];
  }
}

/**
 * Get messages newer than a specific rowid (for polling)
 */
export function getMessagesSince(lastRowId: number): Message[] {
  const query = `
    SELECT
      m.ROWID as rowid,
      m.guid,
      m.text,
      m.is_from_me as isFromMe,
      m.date,
      c.chat_identifier as chatId,
      COALESCE(h.id, '') as senderHandle
    FROM message m
    LEFT JOIN chat_message_join cmj ON m.ROWID = cmj.message_id
    LEFT JOIN chat c ON cmj.chat_id = c.ROWID
    LEFT JOIN handle h ON m.handle_id = h.ROWID
    WHERE m.ROWID > ${lastRowId}
      AND m.text IS NOT NULL
      AND m.text != ''
      AND m.is_from_me = 0
    ORDER BY m.ROWID ASC
  `;

  const json = runSqlite(query);

  if (!json) return [];

  try {
    const rows = JSON.parse(json) as Array<{
      rowid: number;
      guid: string;
      text: string;
      isFromMe: number;
      date: number;
      chatId: string;
      senderHandle: string;
    }>;

    return rows.map((row) => ({
      rowid: row.rowid,
      guid: row.guid,
      text: row.text,
      isFromMe: row.isFromMe === 1,
      date: appleTimestampToDate(row.date),
      chatId: row.chatId,
      senderHandle: row.senderHandle,
    }));
  } catch {
    return [];
  }
}

/**
 * Get the highest message rowid (for initializing poll position)
 */
export function getLatestMessageRowId(): number {
  const result = runSqlite('SELECT MAX(ROWID) as maxId FROM message');

  if (!result) return 0;

  try {
    const rows = JSON.parse(result) as Array<{ maxId: number | null }>;
    return rows[0]?.maxId ?? 0;
  } catch {
    return 0;
  }
}
