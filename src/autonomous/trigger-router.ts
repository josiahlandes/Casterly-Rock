/**
 * Trigger Router — Normalize all input sources into AgentTrigger
 *
 * Every interaction — user message, scheduled cycle, file change event,
 * goal from the stack — enters through the trigger router and gets
 * normalized into a single AgentTrigger type that the unified agent
 * loop understands.
 *
 * The daemon, CLI, event bus, and scheduler all use these functions
 * to create triggers. The agent loop doesn't need to know where the
 * input came from.
 *
 * Part of Phase 2: Unify the Loop.
 */

import type { AgentTrigger, AgentEvent } from './agent-loop.js';
import type { Goal } from './goal-stack.js';
import type { SystemEvent } from './events.js';
import { getTracer } from './debug.js';

// ─────────────────────────────────────────────────────────────────────────────
// Trigger Builders
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a trigger from an iMessage or CLI user message.
 */
export function triggerFromMessage(message: string, sender: string): AgentTrigger {
  const tracer = getTracer();
  tracer.log('agent-loop', 'debug', `Trigger: user message from ${sender}`, {
    messageLength: message.length,
  });
  return { type: 'user', message, sender };
}

/**
 * Create a trigger from a system event (file watcher, git hook, etc.).
 */
export function triggerFromEvent(event: SystemEvent): AgentTrigger {
  const tracer = getTracer();
  const agentEvent: AgentEvent = {
    kind: event.type,
    description: describeSystemEvent(event),
    timestamp: event.timestamp,
    metadata: extractEventMetadata(event),
  };

  tracer.log('agent-loop', 'debug', `Trigger: event ${event.type}`, {
    description: agentEvent.description,
  });

  return { type: 'event', event: agentEvent };
}

/**
 * Create a trigger from a scheduled job (cron, interval).
 */
export function triggerFromSchedule(): AgentTrigger {
  const tracer = getTracer();
  tracer.log('agent-loop', 'debug', 'Trigger: scheduled cycle');
  return { type: 'scheduled' };
}

/**
 * Create a trigger from a goal in the goal stack.
 */
export function triggerFromGoal(goal: Goal): AgentTrigger {
  const tracer = getTracer();
  tracer.log('agent-loop', 'debug', `Trigger: goal ${goal.id}`, {
    description: goal.description,
    priority: goal.priority,
    attempts: goal.attempts,
  });
  return { type: 'goal', goal };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generate a human-readable description of a system event.
 */
function describeSystemEvent(event: SystemEvent): string {
  switch (event.type) {
    case 'file_changed':
      return `${event.paths.length} files ${event.changeKind}: ${event.paths.slice(0, 3).join(', ')}${event.paths.length > 3 ? '...' : ''}`;
    case 'test_failed':
      return `Test failed: ${event.testName}`;
    case 'git_push':
      return `Push to ${event.branch}: ${event.commits.length} commits`;
    case 'build_error':
      return `Build error: ${event.error.slice(0, 100)}`;
    case 'issue_stale':
      return `Issue ${event.issueId} stale for ${event.daysSinceActivity} days`;
    case 'user_message':
      return `Message from ${event.sender}`;
    case 'scheduled':
      return event.reason;
  }
}

/**
 * Extract metadata from a system event for the AgentEvent.
 */
function extractEventMetadata(event: SystemEvent): Record<string, unknown> {
  switch (event.type) {
    case 'file_changed':
      return { paths: event.paths, changeKind: event.changeKind };
    case 'test_failed':
      return { testName: event.testName };
    case 'git_push':
      return { branch: event.branch, commits: event.commits.length };
    case 'build_error':
      return { error: event.error.slice(0, 200) };
    case 'issue_stale':
      return { issueId: event.issueId, daysSinceActivity: event.daysSinceActivity };
    case 'user_message':
      return { sender: event.sender };
    case 'scheduled':
      return { reason: event.reason };
  }
}

/**
 * Determine trigger priority. User messages are highest priority
 * and should preempt autonomous work.
 */
export function getTriggerPriority(trigger: AgentTrigger): number {
  switch (trigger.type) {
    case 'user': return 0;     // Highest — always preempt
    case 'event': return 1;    // High — respond to events
    case 'goal': return 2;     // Medium — continue work
    case 'scheduled': return 3; // Low — background improvement
  }
}
