/**
 * Scheduler Module (ISSUE-003)
 *
 * Proactive scheduling for reminders, recurring tasks, and follow-ups.
 * Phase 1: one-shot timers and cron jobs.
 */

// Types
export type {
  TriggerType,
  JobStatus,
  JobSource,
  ScheduledJob,
  CreateJobInput,
  CreateJobResult,
  JobStoreData,
} from './types.js';

// Cron evaluator
export {
  type CronParts,
  parseCronExpression,
  isValidCronExpression,
  getNextFireTime,
} from './cron.js';

// Trigger / time parsing
export {
  generateJobId,
  redactJobDescription,
  parseTimeSpec,
  createScheduledJob,
} from './trigger.js';

// Job store
export {
  type JobStore,
  createJobStore,
} from './store.js';

// Tool schemas
export {
  SCHEDULE_REMINDER_TOOL,
  LIST_REMINDERS_TOOL,
  CANCEL_REMINDER_TOOL,
  getSchedulerToolSchemas,
} from './tools.js';

// Tool executors
export {
  createSchedulerExecutors,
} from './executor.js';

// Due job checker
export {
  type MessageSender,
  type ActionableHandler,
  checkDueJobs,
} from './checker.js';
