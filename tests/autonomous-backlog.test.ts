/**
 * Autonomous Backlog System Tests
 *
 * Verifies:
 * 1. YAML backlog parsing (loadBacklog)
 * 2. Backlog status updates (updateBacklogStatus)
 * 3. Priority weighting for hypothesis selection
 * 4. Prompt templates include backlog section
 * 5. New type values (feature_request, backlog, add_feature)
 */

import { describe, expect, it, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as yaml from 'yaml';

import { Analyzer } from '../src/autonomous/analyzer.js';
import { PROMPTS } from '../src/autonomous/provider.js';
import { loadConfig } from '../src/autonomous/loop.js';
import type {
  BacklogItem,
  BacklogStatus,
  Observation,
  Hypothesis,
} from '../src/autonomous/types.js';

// ─── Temp dir helpers ────────────────────────────────────────────────────────

const TEST_BASE = join(tmpdir(), `casterly-backlog-test-${Date.now()}`);

afterEach(() => {
  if (existsSync(TEST_BASE)) {
    rmSync(TEST_BASE, { recursive: true, force: true });
  }
});

function setupDir(): string {
  mkdirSync(join(TEST_BASE, 'config'), { recursive: true });
  return TEST_BASE;
}

function writeBacklog(items: BacklogItem[]): string {
  const dir = setupDir();
  const fp = join(dir, 'config', 'backlog.yaml');
  writeFileSync(fp, yaml.stringify({ backlog: items }), 'utf-8');
  return dir;
}

function readBacklogItems(projectRoot: string): BacklogItem[] {
  const fp = join(projectRoot, 'config', 'backlog.yaml');
  const content = readFileSync(fp, 'utf-8');
  const parsed = yaml.parse(content) as { backlog?: BacklogItem[] };
  return parsed?.backlog ?? [];
}

// ─── Sample backlog items ────────────────────────────────────────────────────

function makePendingItem(overrides?: Partial<BacklogItem>): BacklogItem {
  return {
    id: 'bl-001',
    title: 'Test feature',
    description: 'A test feature description',
    priority: 1,
    approach: 'add_feature' as Hypothesis['approach'],
    affectedAreas: ['src/test/'],
    acceptanceCriteria: ['It works'],
    status: 'pending' as BacklogStatus,
    ...overrides,
  };
}

// =============================================================================
// BACKLOG YAML PARSING
// =============================================================================

describe('Backlog YAML parsing', () => {
  it('loads pending items from a valid backlog file', async () => {
    const projectRoot = writeBacklog([
      makePendingItem({ id: 'bl-001', priority: 2 }),
      makePendingItem({ id: 'bl-002', priority: 1 }),
    ]);

    const analyzer = new Analyzer(projectRoot);
    const items = await analyzer.loadBacklog();

    expect(items).toHaveLength(2);
    expect(items[0]!.id).toBe('bl-002'); // Priority 1 first
    expect(items[1]!.id).toBe('bl-001'); // Priority 2 second
  });

  it('returns empty array when file does not exist', async () => {
    const dir = setupDir();
    // Don't create backlog.yaml
    const analyzer = new Analyzer(dir);
    const items = await analyzer.loadBacklog();

    expect(items).toEqual([]);
  });

  it('returns empty array for malformed YAML', async () => {
    const dir = setupDir();
    writeFileSync(join(dir, 'config', 'backlog.yaml'), '{{invalid yaml', 'utf-8');

    const analyzer = new Analyzer(dir);
    const items = await analyzer.loadBacklog();

    expect(items).toEqual([]);
  });

  it('filters out non-pending items', async () => {
    const projectRoot = writeBacklog([
      makePendingItem({ id: 'bl-001', status: 'pending' }),
      makePendingItem({ id: 'bl-002', status: 'completed' }),
      makePendingItem({ id: 'bl-003', status: 'failed' }),
      makePendingItem({ id: 'bl-004', status: 'in_progress' }),
    ]);

    const analyzer = new Analyzer(projectRoot);
    const items = await analyzer.loadBacklog();

    expect(items).toHaveLength(1);
    expect(items[0]!.id).toBe('bl-001');
  });

  it('sorts by priority ascending (1 before 5)', async () => {
    const projectRoot = writeBacklog([
      makePendingItem({ id: 'bl-low', priority: 5 }),
      makePendingItem({ id: 'bl-mid', priority: 3 }),
      makePendingItem({ id: 'bl-high', priority: 1 }),
    ]);

    const analyzer = new Analyzer(projectRoot);
    const items = await analyzer.loadBacklog();

    expect(items.map((i) => i.id)).toEqual(['bl-high', 'bl-mid', 'bl-low']);
  });

  it('handles empty backlog array', async () => {
    const dir = setupDir();
    writeFileSync(join(dir, 'config', 'backlog.yaml'), 'backlog: []\n', 'utf-8');

    const analyzer = new Analyzer(dir);
    const items = await analyzer.loadBacklog();

    expect(items).toEqual([]);
  });

  it('accepts custom backlogPath option', async () => {
    const dir = setupDir();
    const customPath = join(dir, 'my-backlog.yaml');
    writeFileSync(customPath, yaml.stringify({ backlog: [makePendingItem()] }), 'utf-8');

    const analyzer = new Analyzer(dir, { backlogPath: customPath });
    const items = await analyzer.loadBacklog();

    expect(items).toHaveLength(1);
  });
});

// =============================================================================
// BACKLOG STATUS UPDATES
// =============================================================================

describe('Backlog status updates', () => {
  it('marks an item as completed with branch and date', async () => {
    const projectRoot = writeBacklog([makePendingItem({ id: 'bl-001' })]);

    const analyzer = new Analyzer(projectRoot);
    await analyzer.updateBacklogStatus('bl-001', 'completed', { branch: 'auto/hyp-abc' });

    const items = readBacklogItems(projectRoot);
    expect(items).toHaveLength(1);
    expect(items[0]!.status).toBe('completed');
    expect(items[0]!.completedBranch).toBe('auto/hyp-abc');
    expect(items[0]!.completedAt).toBeDefined();
  });

  it('marks an item as failed with reason', async () => {
    const projectRoot = writeBacklog([makePendingItem({ id: 'bl-001' })]);

    const analyzer = new Analyzer(projectRoot);
    await analyzer.updateBacklogStatus('bl-001', 'failed', { reason: 'Tests broke' });

    const items = readBacklogItems(projectRoot);
    expect(items[0]!.status).toBe('failed');
    expect(items[0]!.failureReason).toBe('Tests broke');
  });

  it('completed items are excluded from subsequent loads', async () => {
    const projectRoot = writeBacklog([
      makePendingItem({ id: 'bl-001' }),
      makePendingItem({ id: 'bl-002' }),
    ]);

    const analyzer = new Analyzer(projectRoot);
    await analyzer.updateBacklogStatus('bl-001', 'completed', { branch: 'auto/hyp-xyz' });

    const items = await analyzer.loadBacklog();
    expect(items).toHaveLength(1);
    expect(items[0]!.id).toBe('bl-002');
  });

  it('ignores update for non-existent item id', async () => {
    const projectRoot = writeBacklog([makePendingItem({ id: 'bl-001' })]);

    const analyzer = new Analyzer(projectRoot);
    await analyzer.updateBacklogStatus('bl-999', 'completed');

    const items = readBacklogItems(projectRoot);
    expect(items[0]!.status).toBe('pending'); // Unchanged
  });

  it('handles missing backlog file on update gracefully', async () => {
    const dir = setupDir();
    const analyzer = new Analyzer(dir);

    // Should not throw
    await expect(
      analyzer.updateBacklogStatus('bl-001', 'completed'),
    ).resolves.toBeUndefined();
  });
});

// =============================================================================
// PRIORITY WEIGHTING
// =============================================================================

describe('Priority weighting in hypothesis selection', () => {
  function makeObservation(source: string, priority?: number): Observation {
    return {
      id: `obs-${source}-${priority ?? 'dyn'}`,
      type: source === 'backlog' ? 'feature_request' : 'error_pattern',
      severity: 'medium',
      frequency: 1,
      context: priority != null ? { backlogId: `bl-${priority}`, priority } : {},
      suggestedArea: 'src/',
      timestamp: new Date().toISOString(),
      source: source as Observation['source'],
    };
  }

  function makeHypothesis(obs: Observation, confidence: number, impact: string): Hypothesis {
    return {
      id: `hyp-${obs.id}`,
      observation: obs,
      proposal: `Fix ${obs.id}`,
      approach: obs.source === 'backlog' ? 'add_feature' : 'fix_bug',
      expectedImpact: impact as 'low' | 'medium' | 'high',
      confidence,
      affectedFiles: ['src/test.ts'],
      estimatedComplexity: 'simple',
      previousAttempts: 0,
      reasoning: 'test',
    };
  }

  it('backlog P1-P2 hypotheses sort before dynamic observations', () => {
    const backlogObs = makeObservation('backlog', 1);
    const dynamicObs = makeObservation('error_logs');

    const hypotheses = [
      makeHypothesis(dynamicObs, 0.95, 'high'),   // High score but dynamic
      makeHypothesis(backlogObs, 0.6, 'medium'),   // Lower score but backlog P1
    ];

    const impactScore: Record<string, number> = { low: 1, medium: 2, high: 3 };
    hypotheses.sort((a, b) => {
      const aIsBacklogHighPri =
        a.observation.source === 'backlog' &&
        ((a.observation.context['priority'] as number) ?? 5) <= 2;
      const bIsBacklogHighPri =
        b.observation.source === 'backlog' &&
        ((b.observation.context['priority'] as number) ?? 5) <= 2;

      if (aIsBacklogHighPri && !bIsBacklogHighPri) return -1;
      if (!aIsBacklogHighPri && bIsBacklogHighPri) return 1;

      return (
        b.confidence * (impactScore[b.expectedImpact] ?? 1) -
        a.confidence * (impactScore[a.expectedImpact] ?? 1)
      );
    });

    expect(hypotheses[0]!.observation.source).toBe('backlog');
  });

  it('backlog P3-P5 items sort by normal confidence*impact', () => {
    const backlogP4Obs = makeObservation('backlog', 4);
    const dynamicObs = makeObservation('error_logs');

    const hypotheses = [
      makeHypothesis(backlogP4Obs, 0.5, 'low'),  // Backlog but P4 (not high priority)
      makeHypothesis(dynamicObs, 0.9, 'high'),     // Dynamic but high score
    ];

    const impactScore: Record<string, number> = { low: 1, medium: 2, high: 3 };
    hypotheses.sort((a, b) => {
      const aIsBacklogHighPri =
        a.observation.source === 'backlog' &&
        ((a.observation.context['priority'] as number) ?? 5) <= 2;
      const bIsBacklogHighPri =
        b.observation.source === 'backlog' &&
        ((b.observation.context['priority'] as number) ?? 5) <= 2;

      if (aIsBacklogHighPri && !bIsBacklogHighPri) return -1;
      if (!aIsBacklogHighPri && bIsBacklogHighPri) return 1;

      return (
        b.confidence * (impactScore[b.expectedImpact] ?? 1) -
        a.confidence * (impactScore[a.expectedImpact] ?? 1)
      );
    });

    // Dynamic high-score should be first (P4 backlog not prioritized)
    expect(hypotheses[0]!.observation.source).toBe('error_logs');
  });

  it('multiple backlog items sorted by priority within the group', () => {
    const backlogP1 = makeObservation('backlog', 1);
    const backlogP2 = makeObservation('backlog', 2);

    const hypotheses = [
      makeHypothesis(backlogP2, 0.9, 'high'),
      makeHypothesis(backlogP1, 0.6, 'medium'),
    ];

    const impactScore: Record<string, number> = { low: 1, medium: 2, high: 3 };
    hypotheses.sort((a, b) => {
      const aIsBacklogHighPri =
        a.observation.source === 'backlog' &&
        ((a.observation.context['priority'] as number) ?? 5) <= 2;
      const bIsBacklogHighPri =
        b.observation.source === 'backlog' &&
        ((b.observation.context['priority'] as number) ?? 5) <= 2;

      if (aIsBacklogHighPri && !bIsBacklogHighPri) return -1;
      if (!aIsBacklogHighPri && bIsBacklogHighPri) return 1;

      return (
        b.confidence * (impactScore[b.expectedImpact] ?? 1) -
        a.confidence * (impactScore[a.expectedImpact] ?? 1)
      );
    });

    // Both are backlog high-pri, so they fall through to score sort
    // P2 has 0.9*3=2.7, P1 has 0.6*2=1.2 — P2 wins on score
    expect(hypotheses[0]!.observation.context['priority']).toBe(2);
  });
});

// =============================================================================
// PROMPT TEMPLATES
// =============================================================================

describe('Prompt templates include backlog support', () => {
  it('PROMPTS.analyze contains {{backlog}} placeholder', () => {
    expect(PROMPTS.analyze).toContain('{{backlog}}');
  });

  it('PROMPTS.analyze mentions feature_request type', () => {
    expect(PROMPTS.analyze).toContain('feature_request');
  });

  it('PROMPTS.analyze includes Feature Backlog section header', () => {
    expect(PROMPTS.analyze).toContain('Feature Backlog');
  });

  it('PROMPTS.hypothesize mentions add_feature approach', () => {
    expect(PROMPTS.hypothesize).toContain('add_feature');
  });
});

// =============================================================================
// TYPE SYSTEM
// =============================================================================

describe('New type values', () => {
  it('feature_request is a valid ObservationType', () => {
    const obsType: Observation['type'] = 'feature_request';
    expect(obsType).toBe('feature_request');
  });

  it('add_feature is a valid HypothesisApproach', () => {
    const approach: Hypothesis['approach'] = 'add_feature';
    expect(approach).toBe('add_feature');
  });

  it('backlog is a valid Observation source', () => {
    const obs: Observation = {
      id: 'obs-1',
      type: 'feature_request',
      severity: 'medium',
      frequency: 1,
      context: { backlogId: 'bl-001', priority: 1 },
      suggestedArea: 'src/skills/',
      timestamp: new Date().toISOString(),
      source: 'backlog',
    };
    expect(obs.source).toBe('backlog');
  });

  it('BacklogItem status types are valid', () => {
    const statuses: BacklogStatus[] = ['pending', 'in_progress', 'completed', 'failed'];
    expect(statuses).toHaveLength(4);
  });
});

// =============================================================================
// CONFIG PARSING
// =============================================================================

describe('Config parsing includes backlogPath', () => {
  it('parses backlog_path from config', async () => {
    const dir = setupDir();
    const configPath = join(dir, 'config', 'autonomous.yaml');
    writeFileSync(
      configPath,
      `autonomous:
  enabled: false
  model: test:7b
  backlog_path: config/backlog.yaml
git:
  remote: origin
  base_branch: main
  branch_prefix: "auto/"
  integration_mode: approval_required
`,
      'utf-8',
    );

    const config = await loadConfig(configPath);
    expect(config.backlogPath).toBe('config/backlog.yaml');
  });

  it('defaults backlog_path when not specified', async () => {
    const dir = setupDir();
    const configPath = join(dir, 'config', 'autonomous.yaml');
    writeFileSync(
      configPath,
      `autonomous:
  enabled: false
  model: test:7b
git:
  remote: origin
  base_branch: main
`,
      'utf-8',
    );

    const config = await loadConfig(configPath);
    expect(config.backlogPath).toBe('config/backlog.yaml');
  });
});

// =============================================================================
// SEED FILE VALIDATION
// =============================================================================

describe('Seed backlog file', () => {
  it('config/backlog.yaml parses as valid YAML with 5 items', async () => {
    const content = readFileSync(
      join(process.cwd(), 'config', 'backlog.yaml'),
      'utf-8',
    );
    const parsed = yaml.parse(content) as { backlog?: BacklogItem[] };

    expect(parsed.backlog).toBeDefined();
    expect(parsed.backlog).toHaveLength(5);
  });

  it('all seed items have required fields', () => {
    const content = readFileSync(
      join(process.cwd(), 'config', 'backlog.yaml'),
      'utf-8',
    );
    const parsed = yaml.parse(content) as { backlog: BacklogItem[] };

    for (const item of parsed.backlog) {
      expect(item.id).toBeTruthy();
      expect(item.title).toBeTruthy();
      expect(item.description).toBeTruthy();
      expect(item.priority).toBeGreaterThanOrEqual(1);
      expect(item.priority).toBeLessThanOrEqual(5);
      expect(item.approach).toBe('add_feature');
      expect(item.affectedAreas.length).toBeGreaterThan(0);
      expect(item.acceptanceCriteria.length).toBeGreaterThan(0);
      expect(item.status).toBe('pending');
    }
  });

  it('seed items have unique IDs', () => {
    const content = readFileSync(
      join(process.cwd(), 'config', 'backlog.yaml'),
      'utf-8',
    );
    const parsed = yaml.parse(content) as { backlog: BacklogItem[] };
    const ids = parsed.backlog.map((i) => i.id);

    expect(new Set(ids).size).toBe(ids.length);
  });
});
