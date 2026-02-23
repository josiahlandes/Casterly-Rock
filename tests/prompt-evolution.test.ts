import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  PromptEvolution,
  createPromptEvolution,
} from '../src/autonomous/dream/prompt-evolution.js';
import type { FitnessMetrics } from '../src/autonomous/dream/prompt-evolution.js';
import { resetTracer, initTracer } from '../src/autonomous/debug.js';

// ─────────────────────────────────────────────────────────────────────────────
// Setup
// ─────────────────────────────────────────────────────────────────────────────

let tempDir: string;

beforeEach(async () => {
  resetTracer();
  initTracer({ enabled: false });
  tempDir = await mkdtemp(join(tmpdir(), 'casterly-prompt-evo-'));
});

afterEach(async () => {
  resetTracer();
  await rm(tempDir, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const BASE_PROMPT = [
  '## Workflow Guidance',
  'Plan before you code.',
  'Skip planning for simple single-file edits.',
  '',
  '## Safety Boundary',
  'NEVER expose secrets.',
  'Redaction Rules: always mask API keys.',
  '',
  '## Coding Style',
  'Prefer small functions.',
  'Use descriptive names.',
  '',
  '## Testing',
  'Write tests before code.',
  'Cover edge cases.',
].join('\n');

function makeMetrics(overrides?: Partial<FitnessMetrics>): FitnessMetrics {
  return {
    avgTurns: 5,
    avgToolCalls: 10,
    errorRate: 0.1,
    completionRate: 0.9,
    tasksEvaluated: 10,
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('PromptEvolution — Population Initialization', () => {
  it('initializes a population from a base prompt', () => {
    const evo = new PromptEvolution({
      variantsPath: join(tempDir, 'variants'),
      populationSize: 4,
      protectedPatterns: ['Safety Boundary', 'NEVER'],
    });

    evo.initializePopulation(BASE_PROMPT);

    expect(evo.isInitialized()).toBe(true);
    expect(evo.getPopulationSize()).toBe(4);
  });

  it('population size matches config', () => {
    const evo = new PromptEvolution({
      variantsPath: join(tempDir, 'variants'),
      populationSize: 6,
    });

    evo.initializePopulation(BASE_PROMPT);

    expect(evo.getPopulationSize()).toBe(6);
    expect(evo.getPopulation().length).toBe(6);
  });

  it('variant 0 (elite) contains the base prompt unchanged', () => {
    const evo = new PromptEvolution({
      variantsPath: join(tempDir, 'variants'),
      populationSize: 4,
    });

    evo.initializePopulation(BASE_PROMPT);

    const elite = evo.getVariant(0);
    expect(elite).toBeDefined();
    expect(elite!.content).toBe(BASE_PROMPT);
    expect(elite!.mutations).toHaveLength(0);
    expect(elite!.generation).toBe(0);
  });

  it('non-elite variants are mutations of the base prompt', () => {
    const evo = new PromptEvolution({
      variantsPath: join(tempDir, 'variants'),
      populationSize: 4,
    });

    evo.initializePopulation(BASE_PROMPT);

    const variant1 = evo.getVariant(1);
    expect(variant1).toBeDefined();
    expect(variant1!.parents).toContain(0);
    expect(variant1!.mutations.length).toBeGreaterThan(0);
  });
});

describe('PromptEvolution — Mutation', () => {
  it('produces modified content from a base prompt', () => {
    const evo = new PromptEvolution({
      variantsPath: join(tempDir, 'variants'),
      protectedPatterns: ['Safety Boundary', 'NEVER'],
    });

    // Run mutation many times to get at least one change
    let foundDifference = false;
    for (let i = 0; i < 20; i++) {
      const result = evo.mutate(BASE_PROMPT);
      if (result.content !== BASE_PROMPT) {
        foundDifference = true;
        break;
      }
    }
    expect(foundDifference).toBe(true);
  });

  it('protected sections survive mutation', () => {
    const evo = new PromptEvolution({
      variantsPath: join(tempDir, 'variants'),
      protectedPatterns: ['Safety Boundary', 'NEVER', 'Redaction Rules'],
    });

    for (let i = 0; i < 30; i++) {
      const result = evo.mutate(BASE_PROMPT);
      // Protected content must always be present
      expect(result.content).toContain('Safety Boundary');
      expect(result.content).toContain('NEVER');
    }
  });
});

describe('PromptEvolution — Crossover', () => {
  it('combines two parent prompts', () => {
    const evo = new PromptEvolution({
      variantsPath: join(tempDir, 'variants'),
      protectedPatterns: ['Safety Boundary', 'NEVER'],
    });

    const parent1 = BASE_PROMPT;
    const parent2 = BASE_PROMPT.replace('Plan before you code.', 'Always start with a plan.');

    const child = evo.crossover(parent1, parent2);

    expect(child).toBeTruthy();
    expect(child.length).toBeGreaterThan(0);
    // Should contain content from at least one parent
    const hasFromP1 = child.includes('Plan before you code.') || child.includes('Prefer small functions.');
    const hasFromP2 = child.includes('Always start with a plan.') || child.includes('Prefer small functions.');
    expect(hasFromP1 || hasFromP2).toBe(true);
  });

  it('protected sections survive crossover', () => {
    const evo = new PromptEvolution({
      variantsPath: join(tempDir, 'variants'),
      protectedPatterns: ['Safety Boundary', 'NEVER', 'Redaction Rules'],
    });

    const parent1 = BASE_PROMPT;
    const parent2 = BASE_PROMPT.replace('Prefer small functions.', 'Prefer large classes.');

    for (let i = 0; i < 20; i++) {
      const child = evo.crossover(parent1, parent2);
      expect(child).toContain('Safety Boundary');
      expect(child).toContain('NEVER');
    }
  });
});

describe('PromptEvolution — Fitness Recording', () => {
  it('records fitness metrics for a variant', () => {
    const evo = new PromptEvolution({
      variantsPath: join(tempDir, 'variants'),
      populationSize: 4,
    });

    evo.initializePopulation(BASE_PROMPT);
    evo.recordFitness(0, makeMetrics({ completionRate: 0.95 }));

    const variant = evo.getVariant(0);
    expect(variant!.fitness).not.toBeNull();
    expect(variant!.metrics).toBeDefined();
    expect(variant!.metrics!.completionRate).toBe(0.95);
  });

  it('computes composite fitness from metrics', () => {
    const evo = new PromptEvolution({
      variantsPath: join(tempDir, 'variants'),
      populationSize: 3,
    });

    evo.initializePopulation(BASE_PROMPT);

    // High-performance variant
    evo.recordFitness(0, makeMetrics({
      avgTurns: 3,
      avgToolCalls: 5,
      errorRate: 0.05,
      completionRate: 0.95,
    }));

    // Low-performance variant
    evo.recordFitness(1, makeMetrics({
      avgTurns: 15,
      avgToolCalls: 25,
      errorRate: 0.5,
      completionRate: 0.4,
    }));

    const v0 = evo.getVariant(0);
    const v1 = evo.getVariant(1);

    expect(v0!.fitness).toBeGreaterThan(v1!.fitness!);
  });
});

describe('PromptEvolution — Evolution', () => {
  it('evolves to the next generation when all variants are evaluated', () => {
    const evo = new PromptEvolution({
      variantsPath: join(tempDir, 'variants'),
      populationSize: 4,
      eliteStrategy: true,
      mutationRate: 0.5,
      crossoverRate: 0.5,
    });

    evo.initializePopulation(BASE_PROMPT);

    // Record fitness for all variants
    for (let i = 0; i < 4; i++) {
      evo.recordFitness(i, makeMetrics({
        completionRate: 0.5 + i * 0.1,
        avgTurns: 10 - i,
      }));
    }

    expect(evo.getMetadata().generation).toBe(0);
    evo.evolve();

    expect(evo.getMetadata().generation).toBe(1);
    expect(evo.getPopulationSize()).toBe(4);
  });

  it('elite strategy preserves best variant content', () => {
    const evo = new PromptEvolution({
      variantsPath: join(tempDir, 'variants'),
      populationSize: 4,
      eliteStrategy: true,
    });

    evo.initializePopulation(BASE_PROMPT);

    // Make variant 0 the best
    evo.recordFitness(0, makeMetrics({ completionRate: 0.99 }));
    evo.recordFitness(1, makeMetrics({ completionRate: 0.5 }));
    evo.recordFitness(2, makeMetrics({ completionRate: 0.3 }));
    evo.recordFitness(3, makeMetrics({ completionRate: 0.2 }));

    const bestContent = evo.getVariant(0)!.content;
    evo.evolve();

    // Elite (variant 0) should preserve the best content
    const elite = evo.getElite();
    expect(elite).toBeDefined();
    expect(elite!.content).toBe(bestContent);
  });

  it('does not evolve if too few variants are evaluated', () => {
    const evo = new PromptEvolution({
      variantsPath: join(tempDir, 'variants'),
      populationSize: 4,
    });

    evo.initializePopulation(BASE_PROMPT);
    evo.recordFitness(0, makeMetrics());
    // Only 1 variant evaluated — need at least 2

    evo.evolve();
    // Should remain at generation 0
    expect(evo.getMetadata().generation).toBe(0);
  });

  it('records generation history during evolution', () => {
    const evo = new PromptEvolution({
      variantsPath: join(tempDir, 'variants'),
      populationSize: 3,
    });

    evo.initializePopulation(BASE_PROMPT);

    for (let i = 0; i < 3; i++) {
      evo.recordFitness(i, makeMetrics({ completionRate: 0.6 + i * 0.1 }));
    }

    evo.evolve();

    const meta = evo.getMetadata();
    expect(meta.generationHistory.length).toBe(1);
    expect(meta.generationHistory[0]!.generation).toBe(0);
    expect(meta.generationHistory[0]!.bestFitness).toBeGreaterThan(0);
  });
});

describe('PromptEvolution — Persistence', () => {
  it('saves and reloads population with metadata', async () => {
    const variantsPath = join(tempDir, 'variants');

    const evo = new PromptEvolution({
      variantsPath,
      populationSize: 3,
    });

    evo.initializePopulation(BASE_PROMPT);
    evo.recordFitness(0, makeMetrics({ completionRate: 0.9 }));
    await evo.save();

    // Verify files exist on disk
    const files = await readdir(variantsPath);
    expect(files).toContain('metadata.json');
    expect(files).toContain('variant-0.md');
    expect(files).toContain('variant-0.json');

    // Reload
    const evo2 = new PromptEvolution({
      variantsPath,
      populationSize: 3,
    });
    await evo2.load();

    expect(evo2.getPopulationSize()).toBe(3);
    expect(evo2.getMetadata().generation).toBe(0);

    // Content should be preserved
    const elite = evo2.getVariant(0);
    expect(elite).toBeDefined();
    expect(elite!.content).toBe(BASE_PROMPT);
  });
});

describe('PromptEvolution — Summary', () => {
  it('builds a summary text with generation info', () => {
    const evo = new PromptEvolution({
      variantsPath: join(tempDir, 'variants'),
      populationSize: 3,
    });

    evo.initializePopulation(BASE_PROMPT);
    evo.recordFitness(0, makeMetrics({ completionRate: 0.85 }));

    const summary = evo.buildSummaryText();

    expect(summary).toContain('Prompt Evolution');
    expect(summary).toContain('Generation 0');
    expect(summary).toContain('3 variants');
    expect(summary).toContain('Best fitness');
  });

  it('includes recent generation history when available', () => {
    const evo = new PromptEvolution({
      variantsPath: join(tempDir, 'variants'),
      populationSize: 3,
    });

    evo.initializePopulation(BASE_PROMPT);

    // Evolve twice to get generation history
    for (let gen = 0; gen < 2; gen++) {
      for (let i = 0; i < 3; i++) {
        const v = evo.getVariant(i) ?? evo.getPopulation()[i];
        if (v) {
          evo.recordFitness(v.index, makeMetrics({ completionRate: 0.6 + gen * 0.1 }));
        }
      }
      evo.evolve();
    }

    const summary = evo.buildSummaryText();
    expect(summary).toContain('Recent generations');
    expect(summary).toContain('Gen 0');
  });
});

describe('PromptEvolution — Factory', () => {
  it('createPromptEvolution returns a PromptEvolution', () => {
    const evo = createPromptEvolution({
      variantsPath: join(tempDir, 'test-variants'),
    });
    expect(evo).toBeInstanceOf(PromptEvolution);
  });
});
