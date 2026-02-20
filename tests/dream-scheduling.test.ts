import { describe, expect, it, afterEach, vi, beforeEach } from 'vitest';
import { existsSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';

import { loadConfig } from '../src/autonomous/loop.js';

// ─── Temp dir helpers ────────────────────────────────────────────────────────

const TEST_BASE = join(tmpdir(), `casterly-dream-test-${Date.now()}`);

afterEach(() => {
  if (existsSync(TEST_BASE)) {
    rmSync(TEST_BASE, { recursive: true, force: true });
  }
});

function writeYaml(name: string, content: string): string {
  mkdirSync(TEST_BASE, { recursive: true });
  const fp = join(TEST_BASE, name);
  writeFileSync(fp, content, 'utf-8');
  return fp;
}

// ═══════════════════════════════════════════════════════════════════════════════
// loadConfig — dream_cycles parsing
// ═══════════════════════════════════════════════════════════════════════════════

describe('loadConfig — dream_cycles parsing', () => {
  it('parses all dream_cycles fields', async () => {
    const fp = writeYaml('full-dream.yaml', `
autonomous:
  enabled: true
dream_cycles:
  consolidation_interval_hours: 8
  exploration_budget_turns: 200
  self_model_rebuild_interval_hours: 96
  archaeology_lookback_days: 180
  retrospective_interval_days: 3
`);
    const config = await loadConfig(fp);
    expect(config.dreamCycles).toEqual({
      consolidationIntervalHours: 8,
      explorationBudgetTurns: 200,
      selfModelRebuildIntervalHours: 96,
      archaeologyLookbackDays: 180,
      retrospectiveIntervalDays: 3,
    });
  });

  it('uses default values for missing dream_cycles fields', async () => {
    const fp = writeYaml('partial-dream.yaml', `
autonomous:
  enabled: true
dream_cycles:
  consolidation_interval_hours: 36
`);
    const config = await loadConfig(fp);
    expect(config.dreamCycles).toBeDefined();
    expect(config.dreamCycles!.consolidationIntervalHours).toBe(36);
    // Remaining fields use defaults
    expect(config.dreamCycles!.explorationBudgetTurns).toBe(50);
    expect(config.dreamCycles!.selfModelRebuildIntervalHours).toBe(48);
    expect(config.dreamCycles!.archaeologyLookbackDays).toBe(90);
    expect(config.dreamCycles!.retrospectiveIntervalDays).toBe(7);
  });

  it('dreamCycles is undefined when dream_cycles section is missing', async () => {
    const fp = writeYaml('no-dream-section.yaml', `
autonomous:
  enabled: true
  model: test-model
`);
    const config = await loadConfig(fp);
    expect(config.dreamCycles).toBeUndefined();
  });

  it('dreamCycles coexists with other config sections', async () => {
    const fp = writeYaml('coexist.yaml', `
autonomous:
  enabled: true
  model: qwen3-coder-next:latest
  cycle_interval_minutes: 45
dream_cycles:
  consolidation_interval_hours: 12
communication:
  enabled: true
  delivery_channel: console
self_improvement:
  prompts:
    max_versions: 10
`);
    const config = await loadConfig(fp);
    expect(config.dreamCycles).toBeDefined();
    expect(config.dreamCycles!.consolidationIntervalHours).toBe(12);
    expect(config.communication).toBeDefined();
    expect(config.visionTiers?.tier2).toBe(true);
    expect(config.cycleIntervalMinutes).toBe(45);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// DreamCyclesConfig type shape
// ═══════════════════════════════════════════════════════════════════════════════

describe('DreamCyclesConfig type shape', () => {
  it('contains all expected numeric fields', async () => {
    const fp = writeYaml('type-check.yaml', `
autonomous:
  enabled: true
dream_cycles:
  consolidation_interval_hours: 1
  exploration_budget_turns: 2
  self_model_rebuild_interval_hours: 3
  archaeology_lookback_days: 4
  retrospective_interval_days: 5
`);
    const config = await loadConfig(fp);
    const dc = config.dreamCycles!;
    expect(typeof dc.consolidationIntervalHours).toBe('number');
    expect(typeof dc.explorationBudgetTurns).toBe('number');
    expect(typeof dc.selfModelRebuildIntervalHours).toBe('number');
    expect(typeof dc.archaeologyLookbackDays).toBe('number');
    expect(typeof dc.retrospectiveIntervalDays).toBe('number');
  });

  it('dream_cycles with empty object uses all defaults', async () => {
    const fp = writeYaml('empty-dream.yaml', `
autonomous:
  enabled: true
dream_cycles: {}
`);
    const config = await loadConfig(fp);
    // yaml.parse converts `dream_cycles: {}` to an empty object, which is truthy
    expect(config.dreamCycles).toBeDefined();
    expect(config.dreamCycles!.consolidationIntervalHours).toBe(24);
    expect(config.dreamCycles!.explorationBudgetTurns).toBe(50);
    expect(config.dreamCycles!.selfModelRebuildIntervalHours).toBe(48);
    expect(config.dreamCycles!.archaeologyLookbackDays).toBe(90);
    expect(config.dreamCycles!.retrospectiveIntervalDays).toBe(7);
  });
});
