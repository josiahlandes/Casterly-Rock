/**
 * Due Job Checker (ISSUE-003)
 *
 * Called inside the daemon's poll cycle to fire any due scheduled jobs.
 *
 * Two execution paths:
 * - Static reminders (actionable=false): send the message verbatim via messageSender
 * - Actionable tasks (actionable=true): inject the message as a synthetic user
 *   message through the full LLM pipeline via actionableHandler
 *
 * Errors per-job are logged and skipped — never crashes the poll cycle.
 */

import { safeLogger } from '../logging/safe-logger.js';
import { parseCronExpression, getNextFireTime } from './cron.js';
import type { JobStore } from './store.js';
import type { ScheduledJob } from './types.js';

/** The sendMessage function signature from src/imessage/sender.ts */
export type MessageSender = (recipient: string, text: string) => { success: boolean; error?: string };

/**
 * Handler for actionable jobs — processes the message through the LLM pipeline.
 * The daemon provides this by wrapping processMessage().
 *
 * @param recipient - The phone number / handle to send the result to
 * @param instruction - The task instruction to execute (e.g. "check the weather")
 * @param jobId - The job ID for logging/tracing
 */
export type ActionableHandler = (recipient: string, instruction: string, jobId: string) => Promise<void>;

/**
 * Check for and fire any due scheduled jobs.
 *
 * Called from the daemon's poll() function after processing user messages.
 * Runs inside the isPolling guard, so it never races with message processing.
 *
 * @param jobStore - The job store to check
 * @param messageSender - Function to send static iMessage reminders
 * @param actionableHandler - Optional handler for actionable jobs (LLM pipeline)
 * @returns Number of jobs fired
 */
export async function checkDueJobs(
  jobStore: JobStore,
  messageSender: MessageSender,
  actionableHandler?: ActionableHandler,
): Promise<number> {
  const now = Date.now();
  const dueJobs = jobStore.getDueJobs(now);

  if (dueJobs.length === 0) {
    return 0;
  }

  let firedCount = 0;

  for (const job of dueJobs) {
    try {
      // ── Actionable jobs: route through LLM pipeline ──────────────
      if (job.actionable && actionableHandler) {
        safeLogger.info('Scheduled job firing (actionable)', {
          jobId: job.id,
          type: job.triggerType,
          description: job.description,
        });

        await actionableHandler(job.recipient, job.message, job.id);

        // Update job state (same as static path)
        updateJobAfterFire(jobStore, job, now);
        firedCount++;

        safeLogger.info('Scheduled job completed (actionable)', {
          jobId: job.id,
          fireCount: job.fireCount + 1,
        });
        continue;
      }

      // ── Static reminders: send message verbatim ──────────────────
      const result = messageSender(job.recipient, job.message);

      if (!result.success) {
        safeLogger.error('Scheduled job: message send failed', {
          jobId: job.id,
          error: result.error,
        });
        // Don't update the job — it will retry on the next poll cycle
        continue;
      }

      updateJobAfterFire(jobStore, job, now);
      firedCount++;

      safeLogger.info('Scheduled job fired', {
        jobId: job.id,
        type: job.triggerType,
        actionable: false,
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

/**
 * Update a job's state after successful fire.
 * One-shot: mark as 'fired'. Cron: advance nextFireTime.
 */
function updateJobAfterFire(jobStore: JobStore, job: ScheduledJob, now: number): void {
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
}
