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
 */
export function drainEventsToTasks(
  eventBus: EventBus,
  taskBoard: TaskBoard,
  config: DeepLoopEventConfig = DEFAULT_EVENT_CONFIG,
): number {
  // TODO(pass-2): drain events, convert to tasks
  return 0;
}

/**
 * Describe a SystemEvent in human-readable form for the task's originalMessage.
 */
export function describeEvent(event: SystemEvent): string {
  // TODO(pass-2): format event as task description
  return `Event: ${event.type}`;
}

/**
 * Map a SystemEvent type to a TaskOrigin.
 */
export function eventToOrigin(event: SystemEvent): TaskOrigin {
  // TODO(pass-2): map event types
  return 'event';
}

// ─────────────────────────────────────────────────────────────────────────────
// Goal → Task Conversion
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Check the GoalStack for the next available goal and create a task for it.
 * Returns the task ID if a goal was picked up, or null if no goals available.
 */
export function checkGoalStack(
  goalStack: GoalStack,
  taskBoard: TaskBoard,
  config: DeepLoopEventConfig = DEFAULT_EVENT_CONFIG,
): string | null {
  // TODO(pass-2): get next goal, create task
  return null;
}

/**
 * Convert a Goal to task creation options.
 */
export function goalToTaskDescription(goal: Goal): string {
  // TODO(pass-2): format goal as task description
  return `Goal: ${goal.description}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Combined Idle Check
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Run the full idle check: drain events, then check goals.
 * Called by DeepLoop when there are no queued or revision tasks.
 */
export function runIdleCheck(
  eventBus: EventBus,
  goalStack: GoalStack,
  taskBoard: TaskBoard,
  config: DeepLoopEventConfig = DEFAULT_EVENT_CONFIG,
): IdleCheckResult {
  // TODO(pass-2): implement full idle check
  return {
    tasksCreated: 0,
    eventsProcessed: 0,
    goalStarted: false,
  };
}
