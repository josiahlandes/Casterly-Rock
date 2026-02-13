/**
 * Job Store (ISSUE-003)
 *
 * Persistent store for scheduled jobs.
 * Single JSON file at ~/.casterly/scheduler/jobs.json.
 * In-memory cache with full rewrite on mutation.
 *
 * Follows the factory pattern from src/tasks/execution-log.ts.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { safeLogger } from '../logging/safe-logger.js';
import type { ScheduledJob, JobStoreData } from './types.js';

/** Default storage path */
const DEFAULT_STORAGE_PATH = join(homedir(), '.casterly', 'scheduler');

/** Max age for fired one-shot jobs before compaction (7 days) */
const FIRED_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Max age for cancelled jobs before compaction (1 day) */
const CANCELLED_MAX_AGE_MS = 1 * 24 * 60 * 60 * 1000;

// ─── Interface ──────────────────────────────────────────────────────────────

export interface JobStore {
  /** Get all active jobs */
  getActive(): ScheduledJob[];
  /** Get all jobs for a recipient */
  getForRecipient(recipient: string): ScheduledJob[];
  /** Get a job by ID */
  getById(id: string): ScheduledJob | undefined;
  /** Add a new job */
  add(job: ScheduledJob): void;
  /** Update an existing job (by ID) */
  update(job: ScheduledJob): void;
  /** Cancel a job by ID. Returns true if found and cancelled. */
  cancel(id: string): boolean;
  /** Get jobs that are due to fire (fireAt/nextFireTime <= now) */
  getDueJobs(now: number): ScheduledJob[];
  /** Remove old fired/cancelled jobs */
  compact(): number;
  /** Total count of all jobs */
  count(): number;
}

// ─── Persistence ────────────────────────────────────────────────────────────

function loadJobs(filePath: string): ScheduledJob[] {
  if (!existsSync(filePath)) {
    return [];
  }

  try {
    const content = readFileSync(filePath, 'utf-8').trim();
    if (!content) return [];

    const data = JSON.parse(content) as JobStoreData;
    if (data.version !== 1 || !Array.isArray(data.jobs)) {
      safeLogger.warn('Job store has unexpected format, starting fresh');
      return [];
    }

    return data.jobs;
  } catch (error) {
    safeLogger.error('Failed to load job store', {
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

function saveJobs(filePath: string, jobs: ScheduledJob[]): void {
  const data: JobStoreData = { version: 1, jobs };
  try {
    writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
  } catch (error) {
    safeLogger.error('Failed to save job store', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

// ─── Factory ────────────────────────────────────────────────────────────────

/**
 * Create a job store instance.
 */
export function createJobStore(storagePath?: string): JobStore {
  const baseDir = storagePath ?? DEFAULT_STORAGE_PATH;
  const filePath = join(baseDir, 'jobs.json');

  // Ensure directory exists
  if (!existsSync(baseDir)) {
    mkdirSync(baseDir, { recursive: true });
  }

  // Load existing jobs
  let jobs = loadJobs(filePath);

  // Compact on creation
  const now = Date.now();
  const beforeCount = jobs.length;
  jobs = jobs.filter((job) => {
    if (job.status === 'fired' && job.triggerType === 'one_shot') {
      return (job.lastFiredAt ?? job.createdAt) > now - FIRED_MAX_AGE_MS;
    }
    if (job.status === 'cancelled') {
      return job.createdAt > now - CANCELLED_MAX_AGE_MS;
    }
    return true;
  });

  if (jobs.length !== beforeCount) {
    saveJobs(filePath, jobs);
    safeLogger.info('Job store compacted on load', {
      before: beforeCount,
      after: jobs.length,
    });
  }

  return {
    getActive(): ScheduledJob[] {
      return jobs.filter((j) => j.status === 'active');
    },

    getForRecipient(recipient: string): ScheduledJob[] {
      return jobs.filter((j) => j.recipient === recipient);
    },

    getById(id: string): ScheduledJob | undefined {
      return jobs.find((j) => j.id === id);
    },

    add(job: ScheduledJob): void {
      jobs.push(job);
      saveJobs(filePath, jobs);
      safeLogger.info('Job added', {
        id: job.id,
        type: job.triggerType,
        description: job.description,
      });
    },

    update(job: ScheduledJob): void {
      const index = jobs.findIndex((j) => j.id === job.id);
      if (index >= 0) {
        jobs[index] = job;
        saveJobs(filePath, jobs);
      }
    },

    cancel(id: string): boolean {
      const job = jobs.find((j) => j.id === id);
      if (!job || job.status !== 'active') {
        return false;
      }

      job.status = 'cancelled';
      saveJobs(filePath, jobs);
      safeLogger.info('Job cancelled', { id, description: job.description });
      return true;
    },

    getDueJobs(now: number): ScheduledJob[] {
      return jobs.filter((job) => {
        if (job.status !== 'active') return false;

        if (job.triggerType === 'one_shot' && job.fireAt !== undefined) {
          return job.fireAt <= now;
        }

        if (job.triggerType === 'cron' && job.nextFireTime !== undefined) {
          return job.nextFireTime <= now;
        }

        return false;
      });
    },

    compact(): number {
      const now = Date.now();
      const beforeCount = jobs.length;

      jobs = jobs.filter((job) => {
        if (job.status === 'fired' && job.triggerType === 'one_shot') {
          return (job.lastFiredAt ?? job.createdAt) > now - FIRED_MAX_AGE_MS;
        }
        if (job.status === 'cancelled') {
          return job.createdAt > now - CANCELLED_MAX_AGE_MS;
        }
        return true;
      });

      const removed = beforeCount - jobs.length;
      if (removed > 0) {
        saveJobs(filePath, jobs);
        safeLogger.info('Job store compacted', { removed, remaining: jobs.length });
      }

      return removed;
    },

    count(): number {
      return jobs.length;
    },
  };
}
