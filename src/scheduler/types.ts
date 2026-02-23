/**
 * Scheduler Types (ISSUE-003)
 *
 * Types for the proactive scheduler: one-shot timers and recurring cron jobs.
 * Supports both static reminders (send a message) and actionable tasks
 * (re-enter the LLM pipeline to execute commands at fire time).
 */

// ─── Enums ──────────────────────────────────────────────────────────────────

/** Trigger types supported in Phase 1 */
export type TriggerType = 'one_shot' | 'cron';

/** Job status lifecycle */
export type JobStatus = 'active' | 'fired' | 'cancelled';

/** How the job was created */
export type JobSource = 'user_request' | 'follow_up' | 'system';

// ─── Core Types ─────────────────────────────────────────────────────────────

/**
 * A scheduled job persisted in the job store.
 */
export interface ScheduledJob {
  /** Unique job identifier */
  id: string;
  /** What kind of trigger */
  triggerType: TriggerType;
  /** Current status */
  status: JobStatus;
  /** iMessage recipient (phone number or email) to send the notification to */
  recipient: string;
  /** The message to send when the job fires */
  message: string;
  /** Redacted description for logging (never raw sensitive content) */
  description: string;
  /** For one_shot: the absolute UTC timestamp (ms) to fire at */
  fireAt?: number | undefined;
  /** For cron: the cron expression (5-field: min hour dom month dow) */
  cronExpression?: string | undefined;
  /** For cron: the next computed fire time (UTC ms) */
  nextFireTime?: number | undefined;
  /**
   * IANA timezone for evaluating cron expressions (e.g. "America/New_York").
   * Defaults to UTC if omitted. One-shot jobs use absolute timestamps so
   * timezone only affects cron scheduling.
   */
  timezone?: string | undefined;
  /** When the job was created (UTC ms) */
  createdAt: number;
  /** When the job last fired (UTC ms), if ever */
  lastFiredAt?: number | undefined;
  /** How many times this job has fired */
  fireCount: number;
  /** How the job was created */
  source: JobSource;
  /** Optional label for user-friendly listing */
  label?: string | undefined;
  /**
   * When true, the message is re-injected as a synthetic user message through
   * the full LLM pipeline (classify → plan → execute) instead of being sent
   * verbatim. This lets scheduled jobs perform actions ("check the weather",
   * "summarize my emails") rather than just deliver static text.
   */
  actionable?: boolean | undefined;
}

// ─── Input/Output Types ─────────────────────────────────────────────────────

/**
 * Input for creating a new scheduled job via the tool.
 */
export interface CreateJobInput {
  /** The message to deliver */
  message: string;
  /** Human-readable label */
  label?: string | undefined;
  /** For one-shot: time spec (ISO 8601, "3pm", "in 30 minutes", etc.) */
  fireAt?: string | undefined;
  /** For recurring: 5-field cron expression */
  cronExpression?: string | undefined;
  /** IANA timezone for cron evaluation (e.g. "America/Phoenix"). Defaults to UTC. */
  timezone?: string | undefined;
  /** Source of the job */
  source?: JobSource | undefined;
  /** If true, the message is executed as a task instead of sent verbatim */
  actionable?: boolean | undefined;
}

/**
 * Result of creating a job.
 */
export interface CreateJobResult {
  success: boolean;
  job?: ScheduledJob | undefined;
  error?: string | undefined;
}

// ─── Store Types ────────────────────────────────────────────────────────────

/**
 * The on-disk format of the job store file.
 */
export interface JobStoreData {
  version: 1;
  jobs: ScheduledJob[];
}
