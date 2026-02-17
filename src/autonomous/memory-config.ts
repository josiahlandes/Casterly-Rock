/**
 * Memory Configuration Schema — Validates the memory/identity config section
 *
 * This module defines and validates the configuration for Tyrion's persistent
 * memory system (world model, goal stack, issue log, self-model). It's
 * separate from the main app config schema to keep concerns isolated and
 * to avoid modifying the protected config/schema.ts unless necessary.
 *
 * The config can be loaded from config/autonomous.yaml (under the 'memory'
 * key) or provided programmatically.
 */

import { z } from 'zod';
import { getTracer } from './debug.js';

// ─────────────────────────────────────────────────────────────────────────────
// Schema Definition
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Schema for the 'memory' section of autonomous.yaml.
 */
export const memoryConfigSchema = z.object({
  /** Path to the world model YAML file */
  world_model_path: z.string().min(1).default('~/.casterly/world-model.yaml'),

  /** Path to the goal stack YAML file */
  goal_stack_path: z.string().min(1).default('~/.casterly/goals.yaml'),

  /** Path to the issue log YAML file */
  issue_log_path: z.string().min(1).default('~/.casterly/issues.yaml'),

  /** Path to the self-model YAML file (Phase 6) */
  self_model_path: z.string().min(1).default('~/.casterly/self-model.yaml'),

  /** Whether to update persistent state at the end of each cycle */
  update_on_cycle_end: z.boolean().default(true),

  /** Whether to update persistent state at the end of each interactive session */
  update_on_session_end: z.boolean().default(true),

  /** Maximum number of open goals allowed */
  max_open_goals: z.number().int().positive().default(20),

  /** Maximum number of open issues allowed */
  max_open_issues: z.number().int().positive().default(50),

  /** Days without activity before a goal or issue is flagged as stale */
  stale_days: z.number().int().positive().default(7),

  /** Maximum number of recent activities to track in the world model */
  max_activity_entries: z.number().int().positive().default(50),

  /** Maximum number of concerns to track in the world model */
  max_concerns: z.number().int().positive().default(30),
});

/**
 * Schema for the 'identity' section of autonomous.yaml.
 */
export const identityConfigSchema = z.object({
  /** Approximate maximum character count for the identity prompt */
  max_chars: z.number().int().positive().default(8000),

  /** Whether to include the self-model section in the identity prompt */
  include_self_model: z.boolean().default(true),

  /** Maximum number of goals to show in the identity prompt */
  max_goals_in_prompt: z.number().int().positive().default(5),

  /** Maximum number of issues to show in the identity prompt */
  max_issues_in_prompt: z.number().int().positive().default(5),

  /** Maximum number of recent activities to show in the identity prompt */
  max_activities_in_prompt: z.number().int().positive().default(5),
});

/**
 * Schema for the 'debug' section of autonomous.yaml.
 */
export const debugConfigSchema = z.object({
  /** Master switch for debug output */
  enabled: z.boolean().default(true),

  /** Minimum debug level: trace, debug, info, warn, error */
  level: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('debug'),

  /** Whether to include timestamps in debug output */
  timestamps: z.boolean().default(true),

  /** Whether to include span durations in debug output */
  durations: z.boolean().default(true),

  /** Whether to write debug output to a file */
  log_to_file: z.boolean().default(false),

  /** Path to write debug log file */
  log_file_path: z.string().default('~/.casterly/autonomous/debug.log'),

  /** Per-subsystem enable/disable overrides */
  subsystems: z.record(z.string(), z.boolean()).default({}),
});

/**
 * Combined schema for the full Phase 1 configuration additions.
 * These sections live under the top-level keys in autonomous.yaml.
 */
export const phase1ConfigSchema = z.object({
  memory: memoryConfigSchema.optional().transform((v) => memoryConfigSchema.parse(v ?? {})),
  identity: identityConfigSchema.optional().transform((v) => identityConfigSchema.parse(v ?? {})),
  debug: debugConfigSchema.optional().transform((v) => debugConfigSchema.parse(v ?? {})),
});

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type MemoryConfig = z.infer<typeof memoryConfigSchema>;
export type IdentitySchemaConfig = z.infer<typeof identityConfigSchema>;
export type DebugSchemaConfig = z.infer<typeof debugConfigSchema>;
export type Phase1Config = z.infer<typeof phase1ConfigSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Loading
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse and validate the Phase 1 config from a raw YAML-parsed object.
 * Returns validated config with defaults filled in.
 *
 * If validation fails, logs the errors and returns defaults.
 */
export function loadPhase1Config(raw: unknown): Phase1Config {
  const tracer = getTracer();
  return tracer.withSpanSync('world-model', 'loadPhase1Config', (span) => {
    try {
      const result = phase1ConfigSchema.parse(raw ?? {});
      tracer.log('world-model', 'info', 'Phase 1 config loaded and validated', {
        memoryPath: result.memory.world_model_path,
        goalPath: result.memory.goal_stack_path,
        issuePath: result.memory.issue_log_path,
        debugEnabled: result.debug.enabled,
        debugLevel: result.debug.level,
      });
      return result;
    } catch (err) {
      tracer.log('world-model', 'error', 'Phase 1 config validation failed, using defaults', {
        error: err instanceof Error ? err.message : String(err),
      });
      span.status = 'failure';
      span.error = err instanceof Error ? err.message : String(err);
      return phase1ConfigSchema.parse({});
    }
  });
}
