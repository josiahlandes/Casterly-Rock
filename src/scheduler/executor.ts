/**
 * Scheduler Tool Executors (ISSUE-003)
 *
 * Native tool executors for schedule_reminder, list_reminders, and cancel_reminder.
 * Registered per-message in the daemon with the current recipient captured via closure.
 *
 * Follows the pattern from src/tools/executors/read-file.ts.
 */

import { safeLogger } from '../logging/safe-logger.js';
import type { NativeToolCall, NativeToolResult, NativeToolExecutor } from '../tools/schemas/types.js';
import type { JobStore } from './store.js';
import type { CreateJobInput } from './types.js';
import { createScheduledJob } from './trigger.js';

// ─── schedule_reminder ──────────────────────────────────────────────────────

function createScheduleReminderExecutor(
  jobStore: JobStore,
  recipient: string
): NativeToolExecutor {
  return {
    toolName: 'schedule_reminder',

    async execute(call: NativeToolCall): Promise<NativeToolResult> {
      const input = call.input as unknown as CreateJobInput;

      if (!input.message || typeof input.message !== 'string' || input.message.trim() === '') {
        return {
          toolCallId: call.id,
          success: false,
          error: 'message is required and must be a non-empty string',
        };
      }

      const result = createScheduledJob(input, recipient);

      if (!result.success || !result.job) {
        return {
          toolCallId: call.id,
          success: false,
          error: result.error ?? 'Failed to create scheduled job',
        };
      }

      jobStore.add(result.job);

      const summary = result.job.triggerType === 'one_shot'
        ? `Reminder scheduled for ${new Date(result.job.fireAt!).toLocaleString()}`
        : `Recurring job scheduled: ${result.job.cronExpression}`;

      safeLogger.info('Scheduler: reminder created', {
        id: result.job.id,
        type: result.job.triggerType,
        description: result.job.description,
      });

      return {
        toolCallId: call.id,
        success: true,
        output: JSON.stringify({
          id: result.job.id,
          type: result.job.triggerType,
          label: result.job.label,
          summary,
        }),
      };
    },
  };
}

// ─── list_reminders ─────────────────────────────────────────────────────────

function createListRemindersExecutor(
  jobStore: JobStore,
  recipient: string
): NativeToolExecutor {
  return {
    toolName: 'list_reminders',

    async execute(call: NativeToolCall): Promise<NativeToolResult> {
      const allJobs = jobStore.getForRecipient(recipient);
      const activeJobs = allJobs.filter((j) => j.status === 'active');

      if (activeJobs.length === 0) {
        return {
          toolCallId: call.id,
          success: true,
          output: 'No active reminders.',
        };
      }

      const lines = activeJobs.map((job) => {
        const label = job.label ? ` (${job.label})` : '';
        if (job.triggerType === 'one_shot') {
          const when = job.fireAt ? new Date(job.fireAt).toLocaleString() : 'unknown';
          return `- [${job.id}]${label}: "${job.description}" → fires at ${when}`;
        }
        const nextFire = job.nextFireTime ? new Date(job.nextFireTime).toLocaleString() : 'unknown';
        return `- [${job.id}]${label}: "${job.description}" → cron: ${job.cronExpression}, next: ${nextFire} (fired ${job.fireCount} times)`;
      });

      return {
        toolCallId: call.id,
        success: true,
        output: `Active reminders (${activeJobs.length}):\n${lines.join('\n')}`,
      };
    },
  };
}

// ─── cancel_reminder ────────────────────────────────────────────────────────

function createCancelReminderExecutor(
  jobStore: JobStore,
  recipient: string
): NativeToolExecutor {
  return {
    toolName: 'cancel_reminder',

    async execute(call: NativeToolCall): Promise<NativeToolResult> {
      const input = call.input as { id?: string; label?: string };

      if (!input.id && !input.label) {
        return {
          toolCallId: call.id,
          success: false,
          error: 'Provide either id or label to cancel a reminder',
        };
      }

      // Cancel by ID
      if (input.id) {
        const success = jobStore.cancel(input.id);
        if (success) {
          return {
            toolCallId: call.id,
            success: true,
            output: `Reminder ${input.id} cancelled.`,
          };
        }
        return {
          toolCallId: call.id,
          success: false,
          error: `No active reminder found with ID: ${input.id}`,
        };
      }

      // Cancel by label (partial match)
      if (input.label) {
        const search = input.label.toLowerCase();
        const activeJobs = jobStore.getForRecipient(recipient)
          .filter((j) => j.status === 'active');

        const match = activeJobs.find((j) =>
          (j.label && j.label.toLowerCase().includes(search)) ||
          j.description.toLowerCase().includes(search)
        );

        if (match) {
          jobStore.cancel(match.id);
          return {
            toolCallId: call.id,
            success: true,
            output: `Reminder "${match.label ?? match.description}" (${match.id}) cancelled.`,
          };
        }

        return {
          toolCallId: call.id,
          success: false,
          error: `No active reminder matching "${input.label}"`,
        };
      }

      return {
        toolCallId: call.id,
        success: false,
        error: 'Unexpected state',
      };
    },
  };
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Create all scheduler tool executors for a given recipient.
 * Register these with the tool orchestrator per-message.
 */
export function createSchedulerExecutors(
  jobStore: JobStore,
  recipient: string
): NativeToolExecutor[] {
  return [
    createScheduleReminderExecutor(jobStore, recipient),
    createListRemindersExecutor(jobStore, recipient),
    createCancelReminderExecutor(jobStore, recipient),
  ];
}
