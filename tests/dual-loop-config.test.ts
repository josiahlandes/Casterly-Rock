import { describe, expect, it } from 'vitest';
import { parseDualLoopRuntimeConfig } from '../src/dual-loop/config.js';
import { DEFAULT_CONTEXT_TIERS } from '../src/dual-loop/context-tiers.js';

describe('parseDualLoopRuntimeConfig', () => {
  it('returns disabled when dual_loop section is missing', () => {
    const parsed = parseDualLoopRuntimeConfig({
      autonomous: { provider: 'ollama' },
    });

    expect(parsed).toEqual({ enabled: false });
  });

  it('maps snake_case dual_loop fields into CoordinatorConfig shape', () => {
    const parsed = parseDualLoopRuntimeConfig({
      dual_loop: {
        enabled: true,
        fast: {
          heartbeat_ms: 1500,
        },
        deep: {
          model: 'mlx-community/Qwen3.5-122B-A10B-4bit',
          coder_model: 'mlx-community/Qwen3-Coder-30B-A3B-Instruct-4bit',
          max_turns_per_task: 60,
          max_turns_per_step: 20,
          max_revision_rounds: 4,
          preempt_check_interval_turns: 6,
          idle_sleep_ms: 9000,
        },
        task_board: {
          path: '~/.casterly/custom-taskboard.json',
          archive_after_days: 10,
          max_active_tasks: 20,
        },
        context_tiers: {
          fast: {
            standard: 16384,
            review_large_threshold_lines: 220,
          },
          deep: {
            extended: 196608,
            context_pressure_soft_threshold: 0.65,
          },
          coder: {
            response_buffer_tokens: 3500,
          },
        },
        max_restart_attempts: 5,
        restart_delay_ms: 7000,
        save_interval_ms: 45000,
        archive_interval_ms: 7200000,
      },
    });

    expect(parsed.enabled).toBe(true);
    expect(parsed.coordinatorConfig?.fast).toEqual({
      heartbeatMs: 1500,
    });
    expect(parsed.coordinatorConfig?.deep).toEqual({
      model: 'mlx-community/Qwen3.5-122B-A10B-4bit',
      coderModel: 'mlx-community/Qwen3-Coder-30B-A3B-Instruct-4bit',
      maxTurnsPerTask: 60,
      maxTurnsPerStep: 20,
      maxRevisionRounds: 4,
      preemptCheckIntervalTurns: 6,
      idleSleepMs: 9000,
    });
    expect(parsed.coordinatorConfig?.taskBoard).toEqual({
      dbPath: '~/.casterly/custom-taskboard.json',
      archiveAfterDays: 10,
      maxActiveTasks: 20,
    });
    expect(parsed.coordinatorConfig?.maxRestartAttempts).toBe(5);
    expect(parsed.coordinatorConfig?.restartDelayMs).toBe(7000);
    expect(parsed.coordinatorConfig?.saveIntervalMs).toBe(45000);
    expect(parsed.coordinatorConfig?.archiveIntervalMs).toBe(7200000);

    expect(parsed.coordinatorConfig?.contextTiers).toEqual({
      fast: {
        ...DEFAULT_CONTEXT_TIERS.fast,
        standard: 16384,
        reviewLargeThresholdLines: 220,
      },
      deep: {
        ...DEFAULT_CONTEXT_TIERS.deep,
        extended: 196608,
        contextPressureSoftThreshold: 0.65,
      },
      coder: {
        ...DEFAULT_CONTEXT_TIERS.coder,
        responseBufferTokens: 3500,
      },
    });
  });

  it('ignores invalid field values and keeps defaults for partial tier overrides', () => {
    const parsed = parseDualLoopRuntimeConfig({
      dual_loop: {
        enabled: true,
        fast: {
          heartbeat_ms: -1,
          triage_timeout_ms: '10000',
        },
        context_tiers: {
          deep: {
            standard: 40000,
            context_pressure_soft_threshold: 1.5,
          },
        },
      },
    });

    expect(parsed.enabled).toBe(true);
    expect(parsed.coordinatorConfig?.fast).toBeUndefined();
    expect(parsed.coordinatorConfig?.contextTiers?.deep).toEqual({
      ...DEFAULT_CONTEXT_TIERS.deep,
      standard: 40000,
    });
  });
});
