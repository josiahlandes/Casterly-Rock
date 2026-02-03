/**
 * Memory System
 * Persistent memory storage using markdown files
 * Compatible with OpenClaw's memory model:
 * - MEMORY.md: Long-term curated facts and preferences
 * - memory/YYYY-MM-DD.md: Daily append-only notes
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

export interface MemoryConfig {
  /** Base workspace path */
  workspacePath: string;
  /** Maximum size of MEMORY.md in characters */
  maxMemorySize: number;
  /** Maximum size of daily log in characters */
  maxDailyLogSize: number;
  /** Number of recent daily logs to include in context */
  recentDaysToInclude: number;
}

export interface MemoryEntry {
  /** Timestamp when the entry was written */
  timestamp: string;
  /** The content of the entry */
  content: string;
  /** Optional category/tag */
  category?: string | undefined;
}

export interface MemoryState {
  /** Long-term memory content */
  longTerm: string;
  /** Today's daily log */
  todayLog: string;
  /** Recent daily logs (for context) */
  recentLogs: Array<{ date: string; content: string }>;
}

const DEFAULT_MEMORY_CONFIG: MemoryConfig = {
  workspacePath: join(homedir(), '.casterly', 'workspace'),
  maxMemorySize: 50000,      // ~12k tokens
  maxDailyLogSize: 20000,    // ~5k tokens
  recentDaysToInclude: 3,
};

/**
 * Get today's date in YYYY-MM-DD format
 */
export function getTodayDate(): string {
  return new Date().toISOString().split('T')[0] ?? '';
}

/**
 * Get the path to the long-term memory file
 */
export function getMemoryPath(workspacePath: string): string {
  return join(workspacePath, 'MEMORY.md');
}

/**
 * Get the path to a daily log file
 */
export function getDailyLogPath(workspacePath: string, date: string): string {
  return join(workspacePath, 'memory', `${date}.md`);
}

/**
 * Ensure memory directories exist
 */
export function ensureMemoryDirs(workspacePath: string): void {
  const memoryDir = join(workspacePath, 'memory');
  if (!existsSync(memoryDir)) {
    mkdirSync(memoryDir, { recursive: true });
  }
}

/**
 * Read the long-term memory file
 */
export function readLongTermMemory(workspacePath: string): string {
  const path = getMemoryPath(workspacePath);
  if (!existsSync(path)) {
    return '';
  }
  try {
    return readFileSync(path, 'utf-8').trim();
  } catch {
    return '';
  }
}

/**
 * Write to the long-term memory file (replaces content)
 */
export function writeLongTermMemory(workspacePath: string, content: string): void {
  ensureMemoryDirs(workspacePath);
  const path = getMemoryPath(workspacePath);
  writeFileSync(path, content.trim() + '\n');
}

/**
 * Read a daily log file
 */
export function readDailyLog(workspacePath: string, date: string): string {
  const path = getDailyLogPath(workspacePath, date);
  if (!existsSync(path)) {
    return '';
  }
  try {
    return readFileSync(path, 'utf-8').trim();
  } catch {
    return '';
  }
}

/**
 * Append to today's daily log
 */
export function appendToDailyLog(
  workspacePath: string,
  content: string,
  category?: string
): void {
  ensureMemoryDirs(workspacePath);
  const date = getTodayDate();
  const path = getDailyLogPath(workspacePath, date);

  const timestamp = new Date().toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
  });

  const categoryPrefix = category ? `[${category}] ` : '';
  const entry = `- ${timestamp}: ${categoryPrefix}${content}\n`;

  // Create file with header if it doesn't exist
  if (!existsSync(path)) {
    const header = `# Notes for ${date}\n\n`;
    writeFileSync(path, header);
  }

  appendFileSync(path, entry);
}

/**
 * Get recent daily logs for context
 */
export function getRecentDailyLogs(
  workspacePath: string,
  days: number = 3
): Array<{ date: string; content: string }> {
  const logs: Array<{ date: string; content: string }> = [];
  const today = new Date();

  for (let i = 0; i < days; i++) {
    const date = new Date(today);
    date.setDate(date.getDate() - i);
    const dateStr = date.toISOString().split('T')[0] ?? '';

    const content = readDailyLog(workspacePath, dateStr);
    if (content) {
      logs.push({ date: dateStr, content });
    }
  }

  return logs;
}

/**
 * Load complete memory state for context
 */
export function loadMemoryState(config?: Partial<MemoryConfig>): MemoryState {
  const fullConfig = { ...DEFAULT_MEMORY_CONFIG, ...config };
  const { workspacePath, recentDaysToInclude } = fullConfig;

  return {
    longTerm: readLongTermMemory(workspacePath),
    todayLog: readDailyLog(workspacePath, getTodayDate()),
    recentLogs: getRecentDailyLogs(workspacePath, recentDaysToInclude),
  };
}

/**
 * Format memory state for injection into system prompt
 */
export function formatMemorySection(state: MemoryState): string {
  const sections: string[] = [];

  // Long-term memory
  if (state.longTerm) {
    sections.push(`## Long-Term Memory (MEMORY.md)

${state.longTerm}`);
  }

  // Recent daily logs
  if (state.recentLogs.length > 0) {
    const logsFormatted = state.recentLogs
      .map((log) => `### ${log.date}\n\n${log.content}`)
      .join('\n\n');

    sections.push(`## Recent Notes

${logsFormatted}`);
  }

  if (sections.length === 0) {
    return '';
  }

  return `# Memory

${sections.join('\n\n')}`;
}

/**
 * Memory manager for easy access
 */
export interface MemoryManager {
  /** Load current memory state */
  load(): MemoryState;
  /** Append a note to today's log */
  appendNote(content: string, category?: string): void;
  /** Update long-term memory */
  updateLongTerm(content: string): void;
  /** Get formatted memory section for prompt */
  getPromptSection(): string;
  /** Get the workspace path */
  workspacePath: string;
}

export function createMemoryManager(config?: Partial<MemoryConfig>): MemoryManager {
  const fullConfig = { ...DEFAULT_MEMORY_CONFIG, ...config };

  return {
    workspacePath: fullConfig.workspacePath,

    load(): MemoryState {
      return loadMemoryState(fullConfig);
    },

    appendNote(content: string, category?: string): void {
      appendToDailyLog(fullConfig.workspacePath, content, category);
    },

    updateLongTerm(content: string): void {
      writeLongTermMemory(fullConfig.workspacePath, content);
    },

    getPromptSection(): string {
      const state = loadMemoryState(fullConfig);
      return formatMemorySection(state);
    },
  };
}

/**
 * Parse memory write commands from model output
 * Supports formats:
 * - [REMEMBER] content here
 * - [NOTE] content here
 * - [MEMORY] content here
 */
export interface MemoryCommand {
  type: 'note' | 'memory';
  content: string;
  category?: string | undefined;
}

export function parseMemoryCommands(text: string): MemoryCommand[] {
  const commands: MemoryCommand[] = [];

  // Match [REMEMBER], [NOTE], [MEMORY] tags
  const notePattern = /\[(?:REMEMBER|NOTE)\](?:\[([^\]]+)\])?\s*(.+?)(?=\[(?:REMEMBER|NOTE|MEMORY)\]|$)/gis;
  const memoryPattern = /\[MEMORY\]\s*([\s\S]+?)(?=\[(?:REMEMBER|NOTE|MEMORY)\]|$)/gi;

  // Parse notes
  let match;
  while ((match = notePattern.exec(text)) !== null) {
    const category = match[1]?.trim();
    const content = match[2]?.trim();
    if (content) {
      commands.push({
        type: 'note',
        content,
        category: category || undefined,
      });
    }
  }

  // Parse memory updates
  while ((match = memoryPattern.exec(text)) !== null) {
    const content = match[1]?.trim();
    if (content) {
      commands.push({
        type: 'memory',
        content,
      });
    }
  }

  return commands;
}

/**
 * Execute memory commands from model output
 */
export function executeMemoryCommands(
  commands: MemoryCommand[],
  manager: MemoryManager
): void {
  for (const cmd of commands) {
    if (cmd.type === 'note') {
      manager.appendNote(cmd.content, cmd.category);
    } else if (cmd.type === 'memory') {
      // For memory updates, append to existing rather than replace
      const existing = readLongTermMemory(manager.workspacePath);
      const updated = existing ? `${existing}\n\n${cmd.content}` : cmd.content;
      manager.updateLongTerm(updated);
    }
  }
}
