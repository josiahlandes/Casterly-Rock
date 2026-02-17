import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import {
  loadPhase1Config,
  memoryConfigSchema,
  identityConfigSchema,
  debugConfigSchema,
  phase1ConfigSchema,
} from '../src/autonomous/memory-config.js';
import { resetTracer, initTracer } from '../src/autonomous/debug.js';

describe('Memory Config Schema', () => {
  beforeEach(() => {
    resetTracer();
    initTracer({ enabled: false });
  });

  afterEach(() => {
    resetTracer();
  });

  describe('memoryConfigSchema', () => {
    it('accepts valid config', () => {
      const result = memoryConfigSchema.parse({
        world_model_path: '~/.casterly/world-model.yaml',
        goal_stack_path: '~/.casterly/goals.yaml',
        issue_log_path: '~/.casterly/issues.yaml',
        self_model_path: '~/.casterly/self-model.yaml',
        update_on_cycle_end: true,
        update_on_session_end: true,
        max_open_goals: 20,
        max_open_issues: 50,
        stale_days: 7,
        max_activity_entries: 50,
        max_concerns: 30,
      });

      expect(result.world_model_path).toBe('~/.casterly/world-model.yaml');
      expect(result.max_open_goals).toBe(20);
    });

    it('applies defaults for missing fields', () => {
      const result = memoryConfigSchema.parse({});

      expect(result.world_model_path).toBe('~/.casterly/world-model.yaml');
      expect(result.goal_stack_path).toBe('~/.casterly/goals.yaml');
      expect(result.issue_log_path).toBe('~/.casterly/issues.yaml');
      expect(result.update_on_cycle_end).toBe(true);
      expect(result.max_open_goals).toBe(20);
      expect(result.stale_days).toBe(7);
    });

    it('rejects invalid values', () => {
      expect(() =>
        memoryConfigSchema.parse({ max_open_goals: -1 }),
      ).toThrow();

      expect(() =>
        memoryConfigSchema.parse({ world_model_path: '' }),
      ).toThrow();
    });
  });

  describe('identityConfigSchema', () => {
    it('applies defaults', () => {
      const result = identityConfigSchema.parse({});

      expect(result.max_chars).toBe(8000);
      expect(result.include_self_model).toBe(true);
      expect(result.max_goals_in_prompt).toBe(5);
    });

    it('accepts custom values', () => {
      const result = identityConfigSchema.parse({
        max_chars: 4000,
        include_self_model: false,
        max_goals_in_prompt: 3,
      });

      expect(result.max_chars).toBe(4000);
      expect(result.include_self_model).toBe(false);
    });
  });

  describe('debugConfigSchema', () => {
    it('applies defaults', () => {
      const result = debugConfigSchema.parse({});

      expect(result.enabled).toBe(true);
      expect(result.level).toBe('debug');
      expect(result.timestamps).toBe(true);
      expect(result.durations).toBe(true);
      expect(result.log_to_file).toBe(false);
    });

    it('accepts valid log levels', () => {
      for (const level of ['trace', 'debug', 'info', 'warn', 'error'] as const) {
        const result = debugConfigSchema.parse({ level });
        expect(result.level).toBe(level);
      }
    });

    it('rejects invalid log levels', () => {
      expect(() =>
        debugConfigSchema.parse({ level: 'verbose' }),
      ).toThrow();
    });

    it('accepts subsystem overrides', () => {
      const result = debugConfigSchema.parse({
        subsystems: {
          'world-model': true,
          'goal-stack': false,
        },
      });

      expect(result.subsystems['world-model']).toBe(true);
      expect(result.subsystems['goal-stack']).toBe(false);
    });
  });

  describe('phase1ConfigSchema', () => {
    it('applies all defaults when given empty object', () => {
      const result = phase1ConfigSchema.parse({});

      expect(result.memory.world_model_path).toBe('~/.casterly/world-model.yaml');
      expect(result.identity.max_chars).toBe(8000);
      expect(result.debug.enabled).toBe(true);
    });

    it('accepts a fully specified config', () => {
      const result = phase1ConfigSchema.parse({
        memory: {
          world_model_path: '/custom/path/world.yaml',
          goal_stack_path: '/custom/path/goals.yaml',
          issue_log_path: '/custom/path/issues.yaml',
          self_model_path: '/custom/path/self.yaml',
          update_on_cycle_end: false,
          update_on_session_end: false,
          max_open_goals: 10,
          max_open_issues: 25,
          stale_days: 14,
          max_activity_entries: 100,
          max_concerns: 50,
        },
        identity: {
          max_chars: 4000,
          include_self_model: false,
          max_goals_in_prompt: 3,
          max_issues_in_prompt: 3,
          max_activities_in_prompt: 3,
        },
        debug: {
          enabled: false,
          level: 'error',
          timestamps: false,
          durations: false,
          log_to_file: true,
          log_file_path: '/tmp/debug.log',
          subsystems: {},
        },
      });

      expect(result.memory.world_model_path).toBe('/custom/path/world.yaml');
      expect(result.identity.max_chars).toBe(4000);
      expect(result.debug.enabled).toBe(false);
    });
  });

  describe('loadPhase1Config', () => {
    it('returns defaults for null input', () => {
      const result = loadPhase1Config(null);

      expect(result.memory.world_model_path).toBe('~/.casterly/world-model.yaml');
      expect(result.identity.max_chars).toBe(8000);
      expect(result.debug.enabled).toBe(true);
    });

    it('returns defaults for undefined input', () => {
      const result = loadPhase1Config(undefined);

      expect(result.memory.max_open_goals).toBe(20);
    });

    it('validates and returns valid input', () => {
      const result = loadPhase1Config({
        memory: { max_open_goals: 10 },
        debug: { level: 'trace' },
      });

      expect(result.memory.max_open_goals).toBe(10);
      expect(result.debug.level).toBe('trace');
    });

    it('returns defaults for invalid input without throwing', () => {
      // Invalid input should not crash — it logs an error and returns defaults
      const result = loadPhase1Config({
        memory: { max_open_goals: 'not a number' },
      });

      expect(result.memory.max_open_goals).toBe(20); // default
    });
  });
});
