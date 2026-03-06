/**
 * Schedule Configuration Types
 *
 * Defines the schema for daily schedule configuration with customizable parameters.
 */

// ─── Activity Types ─────────────────────────────────────────────────────────

export type ActivityType = 'work' | 'personal' | 'meal' | 'break' | 'free_time';

export interface Activity {
  /** Unique identifier for the activity */
  id: string;
  /** Type of activity */
  type: ActivityType;
  /** Display name */
  name: string;
  /** Duration in minutes */
  durationMinutes: number;
  /** Optional description */
  description?: string;
  /** Whether this is a required activity */
  required: boolean;
}

// ─── Schedule Configuration ─────────────────────────────────────────────────

export interface ScheduleConfig {
  /** Target date for the schedule (ISO date string, e.g., "2026-03-05") */
  targetDate: string;
  /** Total work hours required */
  workHours: number;
  /** Sister call duration in minutes */
  sisterCallDurationMinutes: number;
  /** Katie's expected arrival time (24h format, e.g., "18:30") */
  katieArrivalTime: string;
  /** Evening activity categories to include */
  eveningCategories: string[];
  /** Start time for work (24h format, e.g., "08:00") */
  workStartTime: string;
}

// ─── Schedule Output ────────────────────────────────────────────────────────

export interface TimeBlock {
  /** Start time in 24h format */
  startTime: string;
  /** End time in 24h format */
  endTime: string;
  /** Activity being performed */
  activity: Activity;
}

export interface GeneratedSchedule {
  /** Target date */
  targetDate: string;
  /** Summary of the day */
  overview: {
    totalWorkHours: number;
    personalActivities: string[];
    eveningCategories: string[];
  };
  /** Time-blocked schedule */
  timeBlocks: TimeBlock[];
  /** Evening activity suggestions by category */
  eveningSuggestions: Record<string, string[]>;
}

// ─── Default Configuration ──────────────────────────────────────────────────

export const DEFAULT_SCHEDULE_CONFIG: ScheduleConfig = {
  targetDate: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().split('T')[0]!,
  workHours: 8,
  sisterCallDurationMinutes: 30,
  katieArrivalTime: "18:30",
  eveningCategories: ["relaxing", "self_care", "productive", "social"],
  workStartTime: "08:00",
};