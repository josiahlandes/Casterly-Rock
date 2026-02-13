/**
 * Due Job Checker (ISSUE-003)
 *
 * Called inside the daemon's poll cycle to fire any due scheduled jobs.
 * Sends messages directly via the provided sendMessage function.
 * Errors per-job are logged and skipped — never crashes the poll cycle.
 */

import { safeLogger } from '../logging/safe-logger.js';
import { parseCronExpression, getNextFireTime } from './cron.js';
import type { JobStore } from './store.js';
import type { ScheduledJob } from './types.js';

/** The sendMessage function signature from src/imessage/sender.ts */
export type MessageSender = (recipient: string, text: string) => { success: boolean; error?: string };

/**
 * Check for and fire any due scheduled jobs.
 *
 * Called from the daemon's poll() function after processing user messages.
 * Runs inside the isPolling guard, so it never races with message processing.
 *
 * @param jobStore - The job store to check
 * @param messageSender - Function to send iMessage
 * @returns Number of jobs fired
 */
export async function checkDueJobs(
  jobStore: JobStore,
  messageSender: MessageSender
): Promise<number> {
  const now = Date.now();
  const dueJobs = jobStore.getDueJobs(now);

  if (dueJobs.length === 0) {
    return 0;
  }

  let firedCount = 0;

  for (const job of dueJobs) {
    try {
      const result = messageSender(job.recipient, job.message);

      if (!result.success) {
        safeLogger.error('Scheduled job: message send failed', {
          jobId: job.id,
          error: result.error,
        });
        // Don't update the job — it will retry on the next poll cycle
        continue;
      }

      // Update job based on type
      if (job.triggerType === 'one_shot') {
        const updated: ScheduledJob = {
          ...job,
          status: 'fired',
          lastFiredAt: now,
          fireCount: job.fireCount + 1,
        };
        jobStore.update(updated);
      } else if (job.triggerType === 'cron' && job.cronExpression) {
        const cron = parseCronExpression(job.cronExpression);
        const nextFireTime = cron
          ? getNextFireTime(cron, new Date(now)).getTime()
          : now + 24 * 60 * 60 * 1000; // fallback: 24h

        const updated: ScheduledJob = {
          ...job,
          lastFiredAt: now,
          fireCount: job.fireCount + 1,
          nextFireTime,
        };
        jobStore.update(updated);
      }

      firedCount++;

      safeLogger.info('Scheduled job fired', {
        jobId: job.id,
        type: job.triggerType,
        description: job.description,
        fireCount: job.fireCount + 1,
      });
    } catch (error) {
      safeLogger.error('Scheduled job: unexpected error', {
        jobId: job.id,
        error: error instanceof Error ? error.message : String(error),
      });
      // Continue to next job — don't let one failure block others
    }
  }

  return firedCount;
}
