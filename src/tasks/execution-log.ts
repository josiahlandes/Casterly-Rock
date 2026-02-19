/**
 * Execution Log — Operational Memory
 *
 * Append-only log of task execution records.
 * Used by the task planner to learn from past executions:
 * - Which tools failed and why
 * - Which approaches worked for similar tasks
 * - How long different task types take
 *
 * Storage: JSONL format (one JSON object per line) at ~/.casterly/execution-log/log.jsonl
 * Bounded: max 500 records or 30 days, whichever is smaller.
 *
 * Privacy: callers MUST redact sensitive content before calling append().
 * This module stores whatever it receives — redaction is the caller's responsibility.
 */

import { existsSync, mkdirSync, readFileSync, appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { safeLogger } from '../logging/safe-logger.js';
import type { ExecutionRecord } from './types.js';

/** Maximum records to keep */
const MAX_RECORDS = 500;

/** Maximum age in milliseconds (30 days) */
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** Default storage path */
const DEFAULT_STORAGE_PATH = join(homedir(), '.casterly', 'execution-log');

/** Tool reliability stats */
export interface ToolReliability {
  toolName: string;
  successRate: number;
  totalCalls: number;
  totalFailures: number;
  commonFailureReasons: string[];
}

/**
 * Execution log interface
 */
export interface ExecutionLog {
  /** Append a record after task completion */
  append(record: ExecutionRecord): void;

  /** Query records by task type */
  queryByType(taskType: string, limit?: number): ExecutionRecord[];

  /** Query records by tool name (any step used this tool) */
  queryByTool(toolName: string, limit?: number): ExecutionRecord[];

  /** Get the most recent records */
  getRecent(limit?: number): ExecutionRecord[];

  /** Get reliability stats for a tool */
  getToolReliability(toolName: string): ToolReliability;

  /** Get all unique task types seen */
  getTaskTypes(): string[];

  /** Get total record count */
  count(): number;

  /** Remove records older than 30 days or beyond 500 count */
  compact(): number;
}

/**
 * Load records from JSONL file
 */
function loadRecords(filePath: string): ExecutionRecord[] {
  if (!existsSync(filePath)) {
    return [];
  }

  try {
    const content = readFileSync(filePath, 'utf-8').trim();
    if (!content) {
      return [];
    }

    const records: ExecutionRecord[] = [];
    const lines = content.split('\n');

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        records.push(JSON.parse(trimmed) as ExecutionRecord);
      } catch {
        safeLogger.warn('Skipping malformed execution log line');
      }
    }

    return records;
  } catch (error) {
    safeLogger.error('Failed to load execution log', {
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

/**
 * Write all records to file (used during compaction)
 */
function writeAllRecords(filePath: string, records: ExecutionRecord[]): void {
  const content = records.map((r) => JSON.stringify(r)).join('\n');
  writeFileSync(filePath, content ? content + '\n' : '', 'utf-8');
}

/**
 * Create an execution log instance
 */
export function createExecutionLog(storagePath?: string): ExecutionLog {
  const baseDir = storagePath ?? DEFAULT_STORAGE_PATH;
  const filePath = join(baseDir, 'log.jsonl');

  // Ensure directory exists
  if (!existsSync(baseDir)) {
    mkdirSync(baseDir, { recursive: true });
  }

  // Load existing records into memory
  let records = loadRecords(filePath);

  // Compact on creation
  const now = Date.now();
  const cutoff = now - MAX_AGE_MS;
  const beforeCount = records.length;
  records = records.filter((r) => r.timestamp >= cutoff);
  if (records.length > MAX_RECORDS) {
    records = records.slice(-MAX_RECORDS);
  }
  if (records.length !== beforeCount) {
    writeAllRecords(filePath, records);
    safeLogger.info('Execution log compacted on load', {
      before: beforeCount,
      after: records.length,
    });
  }

  return {
    append(record: ExecutionRecord): void {
      records.push(record);

      // Append to file (async-safe: appendFileSync is atomic enough for single-process)
      try {
        appendFileSync(filePath, JSON.stringify(record) + '\n', 'utf-8');
      } catch (error) {
        safeLogger.error('Failed to append to execution log', {
          error: error instanceof Error ? error.message : String(error),
        });
      }

      safeLogger.info('Execution record appended', {
        taskType: record.taskType,
        success: record.overallSuccess,
        steps: record.stepResults.length,
        durationMs: record.durationMs,
      });
    },

    queryByType(taskType: string, limit = 10): ExecutionRecord[] {
      return records
        .filter((r) => r.taskType === taskType)
        .slice(-limit);
    },

    queryByTool(toolName: string, limit = 10): ExecutionRecord[] {
      return records
        .filter((r) => r.stepResults.some((s) => s.tool === toolName))
        .slice(-limit);
    },

    getRecent(limit = 10): ExecutionRecord[] {
      return records.slice(-limit);
    },

    getToolReliability(toolName: string): ToolReliability {
      const toolSteps = records.flatMap((r) =>
        r.stepResults.filter((s) => s.tool === toolName)
      );

      const total = toolSteps.length;
      const failures = toolSteps.filter((s) => !s.success);
      const successes = total - failures.length;

      // Collect common failure reasons
      const reasonCounts = new Map<string, number>();
      for (const step of failures) {
        const reason = step.failureReason ?? 'unknown';
        reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);
      }

      const commonFailureReasons = Array.from(reasonCounts.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([reason]) => reason);

      return {
        toolName,
        successRate: total > 0 ? successes / total : 1,
        totalCalls: total,
        totalFailures: failures.length,
        commonFailureReasons,
      };
    },

    getTaskTypes(): string[] {
      const types = new Set(records.map((r) => r.taskType));
      return Array.from(types);
    },

    count(): number {
      return records.length;
    },

    compact(): number {
      const now = Date.now();
      const cutoff = now - MAX_AGE_MS;
      const beforeCount = records.length;

      records = records.filter((r) => r.timestamp >= cutoff);
      if (records.length > MAX_RECORDS) {
        records = records.slice(-MAX_RECORDS);
      }

      if (records.length !== beforeCount) {
        writeAllRecords(filePath, records);
      }

      const removed = beforeCount - records.length;
      if (removed > 0) {
        safeLogger.info('Execution log compacted', {
          removed,
          remaining: records.length,
        });
      }

      return removed;
    },
  };
}
