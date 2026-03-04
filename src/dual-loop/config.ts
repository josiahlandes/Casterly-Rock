/**
 * Dual-Loop Runtime Config Parser.
 *
 * Parses the `dual_loop` section from config/autonomous.yaml and maps
 * snake_case YAML keys to the camelCase CoordinatorConfig shape used at runtime.
 */

import type { CoordinatorConfig } from './coordinator.js';
import type { FastLoopConfig } from './fast-loop.js';
import type { DeepLoopConfig } from './deep-loop.js';
import type { TaskBoardConfig } from './task-board-types.js';
import type { ContextTiersConfig } from './context-tiers.js';
import { DEFAULT_CONTEXT_TIERS } from './context-tiers.js';

export interface DualLoopRuntimeConfig {
  enabled: boolean;
  coordinatorConfig?: Partial<CoordinatorConfig> | undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function hasKeys(value: object): boolean {
  return Object.keys(value).length > 0;
}

function readBoolean(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key];
  return typeof value === 'boolean' ? value : undefined;
}

function readNonEmptyString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function readPositiveInt(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === 'number' && Number.isInteger(value) && value > 0
    ? value
    : undefined;
}

function readUnitFraction(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === 'number' && value > 0 && value <= 1
    ? value
    : undefined;
}

function parseFastConfig(raw: Record<string, unknown>): Partial<FastLoopConfig> {
  const fast: Partial<FastLoopConfig> = {};

  const heartbeatMs = readPositiveInt(raw, 'heartbeat_ms');
  if (heartbeatMs !== undefined) fast.heartbeatMs = heartbeatMs;

  const triageTimeoutMs = readPositiveInt(raw, 'triage_timeout_ms');
  if (triageTimeoutMs !== undefined) fast.triageTimeoutMs = triageTimeoutMs;

  const maxConversationTokens = readPositiveInt(raw, 'max_conversation_tokens');
  if (maxConversationTokens !== undefined) fast.maxConversationTokens = maxConversationTokens;

  const messageCoalesceMs = readPositiveInt(raw, 'message_coalesce_ms');
  if (messageCoalesceMs !== undefined) fast.messageCoalesceMs = messageCoalesceMs;

  return fast;
}

function parseDeepConfig(raw: Record<string, unknown>): Partial<DeepLoopConfig> {
  const deep: Partial<DeepLoopConfig> = {};

  const model = readNonEmptyString(raw, 'model');
  if (model !== undefined) deep.model = model;

  const coderModel = readNonEmptyString(raw, 'coder_model');
  if (coderModel !== undefined) deep.coderModel = coderModel;

  const maxTurnsPerTask = readPositiveInt(raw, 'max_turns_per_task');
  if (maxTurnsPerTask !== undefined) deep.maxTurnsPerTask = maxTurnsPerTask;

  const maxTurnsPerStep = readPositiveInt(raw, 'max_turns_per_step');
  if (maxTurnsPerStep !== undefined) deep.maxTurnsPerStep = maxTurnsPerStep;

  const maxRevisionRounds = readPositiveInt(raw, 'max_revision_rounds');
  if (maxRevisionRounds !== undefined) deep.maxRevisionRounds = maxRevisionRounds;

  const preemptCheckIntervalTurns = readPositiveInt(raw, 'preempt_check_interval_turns');
  if (preemptCheckIntervalTurns !== undefined) {
    deep.preemptCheckIntervalTurns = preemptCheckIntervalTurns;
  }

  const idleSleepMs = readPositiveInt(raw, 'idle_sleep_ms');
  if (idleSleepMs !== undefined) deep.idleSleepMs = idleSleepMs;

  return deep;
}

function parseTaskBoardConfig(raw: Record<string, unknown>): Partial<TaskBoardConfig> {
  const taskBoard: Partial<TaskBoardConfig> = {};

  const dbPath = readNonEmptyString(raw, 'path');
  if (dbPath !== undefined) taskBoard.dbPath = dbPath;

  const archiveAfterDays = readPositiveInt(raw, 'archive_after_days');
  if (archiveAfterDays !== undefined) taskBoard.archiveAfterDays = archiveAfterDays;

  const maxActiveTasks = readPositiveInt(raw, 'max_active_tasks');
  if (maxActiveTasks !== undefined) taskBoard.maxActiveTasks = maxActiveTasks;

  return taskBoard;
}

function parseContextTiers(rawDualLoop: Record<string, unknown>): ContextTiersConfig | undefined {
  const contextTiersRaw = asRecord(rawDualLoop['context_tiers']);
  if (!contextTiersRaw) {
    return undefined;
  }

  const fast = { ...DEFAULT_CONTEXT_TIERS.fast };
  const deep = { ...DEFAULT_CONTEXT_TIERS.deep };
  const coder = { ...DEFAULT_CONTEXT_TIERS.coder };
  let hasOverrides = false;

  const fastRaw = asRecord(contextTiersRaw['fast']);
  if (fastRaw) {
    const compact = readPositiveInt(fastRaw, 'compact');
    if (compact !== undefined) {
      fast.compact = compact;
      hasOverrides = true;
    }

    const standard = readPositiveInt(fastRaw, 'standard');
    if (standard !== undefined) {
      fast.standard = standard;
      hasOverrides = true;
    }

    const extended = readPositiveInt(fastRaw, 'extended');
    if (extended !== undefined) {
      fast.extended = extended;
      hasOverrides = true;
    }

    const reviewLargeThresholdLines = readPositiveInt(fastRaw, 'review_large_threshold_lines');
    if (reviewLargeThresholdLines !== undefined) {
      fast.reviewLargeThresholdLines = reviewLargeThresholdLines;
      hasOverrides = true;
    }
  }

  const deepRaw = asRecord(contextTiersRaw['deep']);
  if (deepRaw) {
    const compact = readPositiveInt(deepRaw, 'compact');
    if (compact !== undefined) {
      deep.compact = compact;
      hasOverrides = true;
    }

    const standard = readPositiveInt(deepRaw, 'standard');
    if (standard !== undefined) {
      deep.standard = standard;
      hasOverrides = true;
    }

    const extended = readPositiveInt(deepRaw, 'extended');
    if (extended !== undefined) {
      deep.extended = extended;
      hasOverrides = true;
    }

    const softThreshold = readUnitFraction(deepRaw, 'context_pressure_soft_threshold');
    if (softThreshold !== undefined) {
      deep.contextPressureSoftThreshold = softThreshold;
      hasOverrides = true;
    }

    const warningThreshold = readUnitFraction(deepRaw, 'context_pressure_warning_threshold');
    if (warningThreshold !== undefined) {
      deep.contextPressureWarningThreshold = warningThreshold;
      hasOverrides = true;
    }

    const actionThreshold = readUnitFraction(deepRaw, 'context_pressure_action_threshold');
    if (actionThreshold !== undefined) {
      deep.contextPressureActionThreshold = actionThreshold;
      hasOverrides = true;
    }
  }

  const coderRaw = asRecord(contextTiersRaw['coder']);
  if (coderRaw) {
    const compact = readPositiveInt(coderRaw, 'compact');
    if (compact !== undefined) {
      coder.compact = compact;
      hasOverrides = true;
    }

    const standard = readPositiveInt(coderRaw, 'standard');
    if (standard !== undefined) {
      coder.standard = standard;
      hasOverrides = true;
    }

    const extended = readPositiveInt(coderRaw, 'extended');
    if (extended !== undefined) {
      coder.extended = extended;
      hasOverrides = true;
    }

    const responseBufferTokens = readPositiveInt(coderRaw, 'response_buffer_tokens');
    if (responseBufferTokens !== undefined) {
      coder.responseBufferTokens = responseBufferTokens;
      hasOverrides = true;
    }
  }

  return hasOverrides ? { fast, deep, coder } : undefined;
}

/**
 * Parse dual-loop runtime config from a YAML object loaded from autonomous.yaml.
 */
export function parseDualLoopRuntimeConfig(rawAutonomousConfig: unknown): DualLoopRuntimeConfig {
  const root = asRecord(rawAutonomousConfig);
  const dualLoopRaw = asRecord(root?.['dual_loop']);

  if (!dualLoopRaw) {
    return { enabled: false };
  }

  const enabled = dualLoopRaw['enabled'] === true;
  const coordinatorConfig: Partial<CoordinatorConfig> = {};

  const fastRaw = asRecord(dualLoopRaw['fast']);
  if (fastRaw) {
    const fast = parseFastConfig(fastRaw);
    if (hasKeys(fast)) coordinatorConfig.fast = fast;
  }

  const deepRaw = asRecord(dualLoopRaw['deep']);
  if (deepRaw) {
    const deep = parseDeepConfig(deepRaw);
    if (hasKeys(deep)) coordinatorConfig.deep = deep;
  }

  const taskBoardRaw = asRecord(dualLoopRaw['task_board']);
  if (taskBoardRaw) {
    const taskBoard = parseTaskBoardConfig(taskBoardRaw);
    if (hasKeys(taskBoard)) coordinatorConfig.taskBoard = taskBoard;
  }

  const contextTiers = parseContextTiers(dualLoopRaw);
  if (contextTiers) {
    coordinatorConfig.contextTiers = contextTiers;
  }

  const maxRestartAttempts = readPositiveInt(dualLoopRaw, 'max_restart_attempts');
  if (maxRestartAttempts !== undefined) {
    coordinatorConfig.maxRestartAttempts = maxRestartAttempts;
  }

  const restartDelayMs = readPositiveInt(dualLoopRaw, 'restart_delay_ms');
  if (restartDelayMs !== undefined) {
    coordinatorConfig.restartDelayMs = restartDelayMs;
  }

  const saveIntervalMs = readPositiveInt(dualLoopRaw, 'save_interval_ms');
  if (saveIntervalMs !== undefined) {
    coordinatorConfig.saveIntervalMs = saveIntervalMs;
  }

  const archiveIntervalMs = readPositiveInt(dualLoopRaw, 'archive_interval_ms');
  if (archiveIntervalMs !== undefined) {
    coordinatorConfig.archiveIntervalMs = archiveIntervalMs;
  }

  return hasKeys(coordinatorConfig)
    ? { enabled, coordinatorConfig }
    : { enabled };
}
