/**
 * Deep Loop Event & Goal Handling — Extends DeepLoop's idle branch.
 *
 * When the DeepLoop has no queued tasks or revisions, it checks for:
 *   1. System events from the EventBus (file changes, test failures, etc.)
 *   2. Goals from the GoalStack (autonomous improvement work)
 *
 * Events are converted to tasks on the TaskBoard so they flow through
 * the same plan→execute→review pipeline as user requests. Goals are
 * similarly converted, but at lower priority.
 *
 * This module provides the conversion logic. The DeepLoop calls these
 * functions from its run() loop's idle branch.
 *
 * See docs/dual-loop-architecture.md Sections 6.2 and 8.1.
 */

import type { EventBus, SystemEvent } from '../autonomous/events.js';
import type { GoalStack, Goal } from '../autonomous/goal-stack.js';
import type { TaskBoard } from './task-board.js';
import type { TaskOrigin } from './task-board-types.js';
import { getTracer } from '../autonomous/debug.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Configuration for event/goal handling.
 */
export interface DeepLoopEventConfig {
  /** Maximum events to process per idle check */
  maxEventsPerCheck: number;
  /** Priority for event-generated tasks (higher number = lower priority) */
  eventTaskPriority: number;
  /** Priority for goal-generated tasks */
  goalTaskPriority: number;
}

/**
 * Result of checking for idle work.
 */
export interface IdleCheckResult {
  tasksCreated: number;
  eventsProcessed: number;
  goalStarted: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Defaults
// ─────────────────────────────────────────────────────────────────────────────

export const DEFAULT_EVENT_CONFIG: DeepLoopEventConfig = {
  maxEventsPerCheck: 5,
  eventTaskPriority: 1,
  goalTaskPriority: 2,
};

// ─────────────────────────────────────────────────────────────────────────────
// Event → Task Conversion
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Drain events from the EventBus and create tasks for each.
 * Returns the number of tasks created.
 *
 * User message events are skipped — those are handled by the FastLoop
 * directly. Scheduled events are also skipped (they are handled by the
 * coordinator's tick cycle).
 */
export function drainEventsToTasks(
  eventBus: EventBus,
  taskBoard: TaskBoard,
  config: DeepLoopEventConfig = DEFAULT_EVENT_CONFIG,
): number {
  const tracer = getTracer();
  const events = eventBus.drain(config.maxEventsPerCheck);

  if (events.length === 0) return 0;

  let created = 0;

  for (let i = 0; i < events.length; i++) {
    const event = events[i]!;

    // Skip events the dual-loop handles elsewhere
    if (event.type === 'user_message' || event.type === 'scheduled') {
      continue;
    }

    const description = describeEvent(event);
    taskBoard.create({
      origin: eventToOrigin(event),
      priority: config.eventTaskPriority,
      originalMessage: description,
      triageNotes: `Auto-created from ${event.type} event. ${description}`,
      classification: 'complex',
    });
    created++;

    tracer.log('deep-loop', 'debug', `Event → task: ${event.type}`, {
      description,
    });
  }

  if (created > 0) {
    tracer.log('deep-loop', 'info', `Created ${created} tasks from ${events.length} events`);
  }

  return created;
}

/**
 * Describe a SystemEvent in human-readable form for the task's originalMessage.
 */
export function describeEvent(event: SystemEvent): string {
  switch (event.type) {
    case 'file_changed':
      return `${event.paths.length} files ${event.changeKind}: ${event.paths.slice(0, 3).join(', ')}${event.paths.length > 3 ? '...' : ''}`;
    case 'test_failed':
      return `Test failure: ${event.testName}`;
    case 'git_push':
      return `Push to ${event.branch}: ${event.commits.length} commits`;
    case 'build_error':
      return `Build error: ${event.error.slice(0, 200)}`;
    case 'issue_stale':
      return `Issue ${event.issueId} stale for ${event.daysSinceActivity} days`;
    case 'user_message':
      return `Message from ${event.sender}`;
    case 'scheduled':
      return event.reason;
  }
}

/**
 * Map a SystemEvent type to a TaskOrigin.
 */
export function eventToOrigin(event: SystemEvent): TaskOrigin {
  switch (event.type) {
    case 'user_message':
      return 'user';
    case 'scheduled':
      return 'scheduled';
    default:
      return 'event';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Goal → Task Conversion
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Check the GoalStack for the next available goal and create a task for it.
 * Returns the task ID if a goal was picked up, or null if no goals available.
 *
 * Only creates a task if there are no existing queued goal-origin tasks
 * on the board (prevents piling up goal tasks when DeepLoop is already busy).
 */
export function checkGoalStack(
  goalStack: GoalStack | null,
  taskBoard: TaskBoard,
  config: DeepLoopEventConfig = DEFAULT_EVENT_CONFIG,
): string | null {
  if (!goalStack) return null;
  const tracer = getTracer();

  // Don't pile up goal tasks if one is already queued
  const active = taskBoard.getActive();
  const hasGoalTask = active.some((t) => t.origin === 'goal');
  if (hasGoalTask) return null;

  const goal = goalStack.getNextGoal();
  if (!goal) return null;

  const description = goalToTaskDescription(goal);
  const taskId = taskBoard.create({
    origin: 'goal',
    priority: config.goalTaskPriority,
    originalMessage: description,
    triageNotes: `Goal ${goal.id}: ${goal.description}. Attempts: ${goal.attempts}. Notes: ${goal.notes}`,
    classification: 'complex',
  });

  // Mark the goal as in-progress in the stack
  goalStack.recordAttempt(goal.id, 'Picked up by dual-loop DeepLoop');

  tracer.log('deep-loop', 'info', `Goal → task: ${goal.id}`, {
    goalDescription: goal.description,
    taskId,
  });

  return taskId;
}

/**
 * Convert a Goal to a human-readable task description.
 */
export function goalToTaskDescription(goal: Goal): string {
  const parts = [`Goal: ${goal.description}`];
  if (goal.relatedFiles.length > 0) {
    parts.push(`Related files: ${goal.relatedFiles.join(', ')}`);
  }
  if (goal.tags.length > 0) {
    parts.push(`Tags: ${goal.tags.join(', ')}`);
  }
  return parts.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Combined Idle Check
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Run the full idle check: drain events first, then check goals.
 * Events take priority over goals because they represent external
 * changes that may need immediate attention.
 *
 * Called by DeepLoop when there are no queued or revision tasks.
 */
export function runIdleCheck(
  eventBus: EventBus,
  goalStack: GoalStack | null,
  taskBoard: TaskBoard,
  config?: DeepLoopEventConfig,
): IdleCheckResult {
  const effectiveConfig = config ?? DEFAULT_EVENT_CONFIG;
  // 1. Drain events — these represent external changes
  const eventsCreated = drainEventsToTasks(eventBus, taskBoard, effectiveConfig);

  // 2. If events generated tasks, don't also start a goal (let events process first)
  if (eventsCreated > 0) {
    return {
      tasksCreated: eventsCreated,
      eventsProcessed: eventsCreated,
      goalStarted: false,
    };
  }

  // 3. No events — check the goal stack
  const goalTaskId = checkGoalStack(goalStack, taskBoard, effectiveConfig);

  return {
    tasksCreated: goalTaskId ? 1 : 0,
    eventsProcessed: 0,
    goalStarted: goalTaskId !== null,
  };
}
