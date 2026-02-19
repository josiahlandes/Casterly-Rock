/**
 * Prompt Genetic Algorithm — Evolve the System Prompt (Vision Tier 3)
 *
 * Maintains a population of system prompt variants. Each variant is tested
 * against a benchmark suite during dream cycles. Best-performing prompts
 * "reproduce" — combining elements from the strongest variants. Over
 * generations, the system prompt evolves toward optimal performance.
 *
 * Why this is feasible locally:
 *   - Each variant needs dozens of inference calls per generation
 *   - Cloud would be too expensive; locally it's a low-priority dream goal
 *   - Example: 8 variants × 10 tasks = 80 inferences (trivial locally)
 *
 * What it optimizes for:
 *   - Turns-to-completion (fewer turns = better efficiency)
 *   - Tool call efficiency (fewer unnecessary calls)
 *   - Error rate (lower is better)
 *   - Judgment accuracy (from shadow execution data)
 *
 * Safety: Protected sections (Safety Boundary, Path Guards, Redaction Rules,
 * Security Invariants) are immutable across all variants.
 *
 * Privacy: All prompt evolution is local. No data leaves the machine.
 */

import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { getTracer } from '../debug.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A single prompt variant in the population.
 */
export interface PromptVariant {
  /** Variant index (0 = current active/elite) */
  index: number;

  /** Full prompt content */
  content: string;

  /** Which generation this variant was created in */
  generation: number;

  /** Parent variant indices (for crossover) */
  parents: number[];

  /** Mutations applied to create this variant */
  mutations: string[];

  /** Fitness score (null if not yet evaluated) */
  fitness: number | null;

  /** Individual fitness metrics */
  metrics?: FitnessMetrics;
}

/**
 * Fitness metrics for a prompt variant.
 */
export interface FitnessMetrics {
  /** Average turns to complete benchmark tasks */
  avgTurns: number;

  /** Average tool calls per task */
  avgToolCalls: number;

  /** Error rate across benchmark tasks */
  errorRate: number;

  /** Task completion rate */
  completionRate: number;

  /** Number of benchmark tasks evaluated */
  tasksEvaluated: number;
}

/**
 * Metadata for the evolution population.
 */
export interface EvolutionMetadata {
  /** Current generation number */
  generation: number;

  /** Generation history: best fitness per generation */
  generationHistory: Array<{
    generation: number;
    bestFitness: number;
    avgFitness: number;
    timestamp: string;
  }>;

  /** Index of the current elite variant */
  eliteIndex: number;

  /** When the population was last evolved */
  lastEvolvedAt: string;
}

/**
 * Mutation operator types.
 */
export type MutationType =
  | 'reorder_rules'
  | 'adjust_threshold'
  | 'add_guidance'
  | 'remove_guidance'
  | 'merge_rules'
  | 'split_rule'
  | 'rephrase';

/**
 * Configuration for the prompt genetic algorithm.
 */
export interface PromptEvolutionConfig {
  /** Directory for storing variants */
  variantsPath: string;

  /** Population size */
  populationSize: number;

  /** Mutation rate (0.0-1.0) */
  mutationRate: number;

  /** Crossover rate (0.0-1.0) */
  crossoverRate: number;

  /** Keep current best in the next generation */
  eliteStrategy: boolean;

  /** Protected sections that cannot be mutated */
  protectedPatterns: string[];

  /** Maximum number of generation records to keep */
  maxGenerationHistory: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: PromptEvolutionConfig = {
  variantsPath: '~/.casterly/prompt-evolution',
  populationSize: 8,
  mutationRate: 0.3,
  crossoverRate: 0.7,
  eliteStrategy: true,
  protectedPatterns: [
    'Safety Boundary',
    'Path Guards',
    'Redaction Rules',
    'Security Invariants',
    'NEVER',
    'non-negotiable',
  ],
  maxGenerationHistory: 50,
};

/**
 * Fitness weights for computing composite score.
 */
const FITNESS_WEIGHTS = {
  completionRate: 0.4,
  avgTurns: 0.25,
  avgToolCalls: 0.15,
  errorRate: 0.2,
};

/**
 * Available mutation operators.
 */
const MUTATION_OPERATORS: MutationType[] = [
  'reorder_rules',
  'adjust_threshold',
  'add_guidance',
  'remove_guidance',
  'rephrase',
];

// ─────────────────────────────────────────────────────────────────────────────
// Prompt Evolution
// ─────────────────────────────────────────────────────────────────────────────

export class PromptEvolution {
  private readonly config: PromptEvolutionConfig;
  private population: PromptVariant[] = [];
  private metadata: EvolutionMetadata;
  private loaded = false;

  constructor(config?: Partial<PromptEvolutionConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.metadata = {
      generation: 0,
      generationHistory: [],
      eliteIndex: 0,
      lastEvolvedAt: new Date().toISOString(),
    };
  }

  // ── Persistence ─────────────────────────────────────────────────────────

  /**
   * Load population and metadata from disk.
   */
  async load(): Promise<void> {
    const resolvedPath = this.config.variantsPath.replace(/^~/, process.env['HOME'] ?? '~');

    try {
      // Load metadata
      const metaContent = await readFile(join(resolvedPath, 'metadata.json'), 'utf8');
      const parsed = JSON.parse(metaContent) as EvolutionMetadata;
      if (parsed && typeof parsed.generation === 'number') {
        this.metadata = parsed;
      }

      // Load variants
      const files = await readdir(resolvedPath);
      const variantFiles = files.filter((f) => f.startsWith('variant-') && f.endsWith('.md'));

      this.population = [];
      for (const file of variantFiles) {
        const content = await readFile(join(resolvedPath, file), 'utf8');
        const indexMatch = file.match(/variant-(\d+)\.md/);
        if (indexMatch) {
          const index = parseInt(indexMatch[1]!, 10);
          // Look for fitness data in a companion JSON
          let variant: PromptVariant = {
            index,
            content,
            generation: this.metadata.generation,
            parents: [],
            mutations: [],
            fitness: null,
          };

          try {
            const dataContent = await readFile(join(resolvedPath, `variant-${index}.json`), 'utf8');
            const data = JSON.parse(dataContent) as Partial<PromptVariant>;
            variant = { ...variant, ...data, content };
          } catch {
            // No companion data — just content
          }

          this.population.push(variant);
        }
      }

      // Sort by index
      this.population.sort((a, b) => a.index - b.index);
    } catch {
      // No existing population — start fresh
    }

    this.loaded = true;
  }

  /**
   * Save population and metadata to disk.
   */
  async save(): Promise<void> {
    const resolvedPath = this.config.variantsPath.replace(/^~/, process.env['HOME'] ?? '~');
    await mkdir(resolvedPath, { recursive: true });

    // Save metadata
    await writeFile(
      join(resolvedPath, 'metadata.json'),
      JSON.stringify(this.metadata, null, 2),
      'utf8',
    );

    // Save each variant
    for (const variant of this.population) {
      await writeFile(
        join(resolvedPath, `variant-${variant.index}.md`),
        variant.content,
        'utf8',
      );

      // Save companion data (without content to avoid duplication)
      const { content: _, ...data } = variant;
      await writeFile(
        join(resolvedPath, `variant-${variant.index}.json`),
        JSON.stringify(data, null, 2),
        'utf8',
      );
    }

    getTracer().log('dream', 'debug', `Prompt evolution saved: ${this.population.length} variants, gen ${this.metadata.generation}`);
  }

  // ── Population Management ───────────────────────────────────────────────

  /**
   * Initialize population from a base prompt.
   */
  initializePopulation(basePrompt: string): void {
    this.population = [];

    // Variant 0 is always the elite (base prompt)
    this.population.push({
      index: 0,
      content: basePrompt,
      generation: 0,
      parents: [],
      mutations: [],
      fitness: null,
    });

    // Generate initial variants via mutation
    for (let i = 1; i < this.config.populationSize; i++) {
      const mutated = this.mutate(basePrompt);
      this.population.push({
        index: i,
        content: mutated.content,
        generation: 0,
        parents: [0],
        mutations: mutated.mutations,
        fitness: null,
      });
    }

    this.metadata.generation = 0;
    this.metadata.eliteIndex = 0;
  }

  /**
   * Record fitness metrics for a variant.
   */
  recordFitness(variantIndex: number, metrics: FitnessMetrics): void {
    const variant = this.population.find((v) => v.index === variantIndex);
    if (!variant) return;

    variant.metrics = metrics;
    variant.fitness = this.computeFitness(metrics);
  }

  /**
   * Evolve the population to the next generation.
   * Selects the best variants, applies crossover and mutation.
   */
  evolve(): void {
    const tracer = getTracer();

    // Only evolve if all variants have fitness scores
    const evaluated = this.population.filter((v) => v.fitness !== null);
    if (evaluated.length < 2) {
      tracer.log('dream', 'warn', 'Not enough evaluated variants to evolve');
      return;
    }

    // Sort by fitness (highest first)
    const ranked = [...evaluated].sort((a, b) => (b.fitness ?? 0) - (a.fitness ?? 0));

    // Record generation stats
    const fitnessValues = ranked.map((v) => v.fitness ?? 0);
    this.metadata.generationHistory.push({
      generation: this.metadata.generation,
      bestFitness: fitnessValues[0] ?? 0,
      avgFitness: fitnessValues.reduce((a, b) => a + b, 0) / fitnessValues.length,
      timestamp: new Date().toISOString(),
    });

    // Prune old history
    if (this.metadata.generationHistory.length > this.config.maxGenerationHistory) {
      this.metadata.generationHistory = this.metadata.generationHistory.slice(
        -this.config.maxGenerationHistory,
      );
    }

    // Select parents (top half)
    const parentCount = Math.max(2, Math.ceil(ranked.length / 2));
    const parents = ranked.slice(0, parentCount);

    // Build new generation
    const nextGen: PromptVariant[] = [];
    const nextGeneration = this.metadata.generation + 1;

    // Elite strategy: keep the best variant unchanged
    if (this.config.eliteStrategy && parents[0]) {
      nextGen.push({
        index: 0,
        content: parents[0].content,
        generation: nextGeneration,
        parents: [parents[0].index],
        mutations: [],
        fitness: null, // Will be re-evaluated
      });
      this.metadata.eliteIndex = 0;
    }

    // Generate remaining variants via crossover + mutation
    while (nextGen.length < this.config.populationSize) {
      const index = nextGen.length;

      if (parents.length >= 2 && Math.random() < this.config.crossoverRate) {
        // Crossover
        const p1 = parents[Math.floor(Math.random() * parents.length)]!;
        let p2 = parents[Math.floor(Math.random() * parents.length)]!;
        // Ensure different parents
        if (p2.index === p1.index && parents.length > 1) {
          p2 = parents.find((p) => p.index !== p1.index) ?? p2;
        }

        const crossed = this.crossover(p1.content, p2.content);

        // Optionally mutate the crossover result
        if (Math.random() < this.config.mutationRate) {
          const mutated = this.mutate(crossed);
          nextGen.push({
            index,
            content: mutated.content,
            generation: nextGeneration,
            parents: [p1.index, p2.index],
            mutations: mutated.mutations,
            fitness: null,
          });
        } else {
          nextGen.push({
            index,
            content: crossed,
            generation: nextGeneration,
            parents: [p1.index, p2.index],
            mutations: ['crossover'],
            fitness: null,
          });
        }
      } else {
        // Mutation only
        const parent = parents[Math.floor(Math.random() * parents.length)]!;
        const mutated = this.mutate(parent.content);
        nextGen.push({
          index,
          content: mutated.content,
          generation: nextGeneration,
          parents: [parent.index],
          mutations: mutated.mutations,
          fitness: null,
        });
      }
    }

    this.population = nextGen;
    this.metadata.generation = nextGeneration;
    this.metadata.lastEvolvedAt = new Date().toISOString();

    tracer.log('dream', 'info', `Evolved to generation ${nextGeneration}: ${nextGen.length} variants`);
  }

  // ── Genetic Operators ───────────────────────────────────────────────────

  /**
   * Apply a random mutation to a prompt.
   */
  mutate(prompt: string): { content: string; mutations: string[] } {
    const sections = this.splitIntoSections(prompt);
    const mutableSections = sections.filter((s) => !this.isProtected(s));

    if (mutableSections.length === 0) {
      return { content: prompt, mutations: ['no_mutable_sections'] };
    }

    const operator = MUTATION_OPERATORS[Math.floor(Math.random() * MUTATION_OPERATORS.length)]!;
    const mutations: string[] = [operator];

    switch (operator) {
      case 'reorder_rules': {
        // Shuffle the order of mutable sections
        const protectedSections = sections.filter((s) => this.isProtected(s));
        const shuffled = [...mutableSections].sort(() => Math.random() - 0.5);
        const reordered = [...protectedSections, ...shuffled];
        return { content: reordered.join('\n\n'), mutations };
      }

      case 'adjust_threshold': {
        // Find a numeric threshold and adjust it slightly
        let modified = prompt;
        const thresholdMatch = modified.match(/(\d+)%/);
        if (thresholdMatch) {
          const val = parseInt(thresholdMatch[1]!, 10);
          const delta = Math.random() > 0.5 ? 5 : -5;
          const newVal = Math.max(10, Math.min(95, val + delta));
          modified = modified.replace(`${val}%`, `${newVal}%`);
        }
        return { content: modified, mutations };
      }

      case 'add_guidance': {
        // Add a new guidance line to a random mutable section
        const target = mutableSections[Math.floor(Math.random() * mutableSections.length)]!;
        const guidance = `- Consider alternative approaches before committing to the first solution.`;
        const enhanced = target + '\n' + guidance;
        return { content: prompt.replace(target, enhanced), mutations };
      }

      case 'remove_guidance': {
        // Remove a non-protected line from a mutable section
        const target = mutableSections[Math.floor(Math.random() * mutableSections.length)]!;
        const lines = target.split('\n').filter((l) => l.trim().length > 0);
        if (lines.length > 2) {
          // Remove a random non-first line
          const removeIdx = 1 + Math.floor(Math.random() * (lines.length - 1));
          lines.splice(removeIdx, 1);
          return { content: prompt.replace(target, lines.join('\n')), mutations };
        }
        return { content: prompt, mutations: ['remove_skipped_too_short'] };
      }

      case 'rephrase': {
        // Simple rephrasing: swap "should" with "must" or vice versa
        let modified = prompt;
        if (modified.includes(' should ') && !this.containsProtected(modified, ' should ')) {
          modified = modified.replace(/ should /, ' must ');
        } else if (modified.includes(' must ') && !this.containsProtected(modified, ' must ')) {
          modified = modified.replace(/ must /, ' should ');
        }
        return { content: modified, mutations };
      }

      default:
        return { content: prompt, mutations: ['unknown_operator'] };
    }
  }

  /**
   * Crossover two prompts by combining sections.
   */
  crossover(prompt1: string, prompt2: string): string {
    const sections1 = this.splitIntoSections(prompt1);
    const sections2 = this.splitIntoSections(prompt2);

    const result: string[] = [];

    // For each section position, pick from either parent
    const maxSections = Math.max(sections1.length, sections2.length);
    for (let i = 0; i < maxSections; i++) {
      const s1 = sections1[i];
      const s2 = sections2[i];

      if (s1 && this.isProtected(s1)) {
        // Always keep protected sections from parent 1
        result.push(s1);
      } else if (s2 && this.isProtected(s2)) {
        // Always keep protected sections from parent 2
        result.push(s2);
      } else if (s1 && s2) {
        // Random selection
        result.push(Math.random() > 0.5 ? s1 : s2);
      } else {
        result.push(s1 ?? s2 ?? '');
      }
    }

    return result.filter((s) => s.length > 0).join('\n\n');
  }

  // ── Queries ─────────────────────────────────────────────────────────────

  /**
   * Get the current population.
   */
  getPopulation(): readonly PromptVariant[] {
    return this.population;
  }

  /**
   * Get a specific variant.
   */
  getVariant(index: number): PromptVariant | undefined {
    return this.population.find((v) => v.index === index);
  }

  /**
   * Get the elite (best-performing) variant.
   */
  getElite(): PromptVariant | undefined {
    return this.population.find((v) => v.index === this.metadata.eliteIndex);
  }

  /**
   * Get the evolution metadata.
   */
  getMetadata(): Readonly<EvolutionMetadata> {
    return this.metadata;
  }

  /**
   * Get the population size.
   */
  getPopulationSize(): number {
    return this.population.length;
  }

  /**
   * Check if the population has been initialized.
   */
  isInitialized(): boolean {
    return this.population.length > 0;
  }

  /**
   * Build a summary of evolution progress.
   */
  buildSummaryText(): string {
    const lines: string[] = [
      `Prompt Evolution: Generation ${this.metadata.generation}`,
      `Population: ${this.population.length} variants`,
    ];

    const evaluated = this.population.filter((v) => v.fitness !== null);
    if (evaluated.length > 0) {
      const best = evaluated.sort((a, b) => (b.fitness ?? 0) - (a.fitness ?? 0))[0];
      lines.push(`Best fitness: ${best?.fitness?.toFixed(3)} (variant ${best?.index})`);
    }

    if (this.metadata.generationHistory.length > 1) {
      const recent = this.metadata.generationHistory.slice(-3);
      lines.push('Recent generations:');
      for (const gen of recent) {
        lines.push(`  Gen ${gen.generation}: best=${gen.bestFitness.toFixed(3)}, avg=${gen.avgFitness.toFixed(3)}`);
      }
    }

    return lines.join('\n');
  }

  // ── Private Helpers ─────────────────────────────────────────────────────

  /**
   * Compute composite fitness from metrics.
   */
  private computeFitness(metrics: FitnessMetrics): number {
    // Normalize: higher is better for all
    const turnScore = Math.max(0, 1 - metrics.avgTurns / 20); // 0 turns = 1.0, 20+ = 0.0
    const toolScore = Math.max(0, 1 - metrics.avgToolCalls / 30); // 0 calls = 1.0, 30+ = 0.0
    const errorScore = 1 - metrics.errorRate; // 0% errors = 1.0
    const completionScore = metrics.completionRate; // 100% = 1.0

    return (
      completionScore * FITNESS_WEIGHTS.completionRate +
      turnScore * FITNESS_WEIGHTS.avgTurns +
      toolScore * FITNESS_WEIGHTS.avgToolCalls +
      errorScore * FITNESS_WEIGHTS.errorRate
    );
  }

  /**
   * Split a prompt into sections by markdown headers.
   */
  private splitIntoSections(prompt: string): string[] {
    const sections = prompt.split(/(?=^## )/m);
    return sections.filter((s) => s.trim().length > 0);
  }

  /**
   * Check if a section contains protected content.
   */
  private isProtected(section: string): boolean {
    return this.config.protectedPatterns.some((pattern) => section.includes(pattern));
  }

  /**
   * Check if a specific text position is within a protected section.
   */
  private containsProtected(text: string, needle: string): boolean {
    const idx = text.indexOf(needle);
    if (idx === -1) return false;

    // Check if any protected pattern is near this position
    for (const pattern of this.config.protectedPatterns) {
      const patIdx = text.indexOf(pattern);
      if (patIdx !== -1 && Math.abs(patIdx - idx) < 200) {
        return true;
      }
    }
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────────────────────

export function createPromptEvolution(
  config?: Partial<PromptEvolutionConfig>,
): PromptEvolution {
  return new PromptEvolution(config);
}
