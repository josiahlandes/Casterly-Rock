/**
 * LoRA Trainer — Local Fine-Tuning Orchestrator (Vision Tier 3)
 *
 * Manages LoRA adapter lifecycle: creation, evaluation, activation,
 * and retirement. Each adapter targets a specific skill domain.
 *
 * Flow:
 *   1. Training extractor provides domain-specific training data
 *   2. LoRA trainer creates an adapter via local training tools
 *   3. Adapter is evaluated against benchmark tasks
 *   4. If performance improves, adapter is activated
 *   5. If not, adapter is discarded
 *
 * Architecture:
 *   - Adapters are small (tens of MB) and domain-specific
 *   - Multiple adapters coexist alongside the base model
 *   - Ollama loads adapters as model variants
 *   - The agent requests the relevant adapter when encountering
 *     a task in that domain
 *
 * Privacy: All training is local. Training data comes only from
 * the journal and issue log (Tyrion's own reasoning).
 */

import { readFile, writeFile, mkdir, readdir, unlink } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { getTracer } from '../debug.js';
import type { TrainingDataset } from './training-extractor.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A LoRA adapter entry in the registry.
 */
export interface LoraAdapter {
  /** Unique identifier */
  id: string;

  /** Skill domain this adapter targets */
  skill: string;

  /** File name of the adapter */
  fileName: string;

  /** Status of the adapter */
  status: 'training' | 'evaluating' | 'active' | 'archived' | 'discarded';

  /** When the adapter was created */
  createdAt: string;

  /** When the adapter was last used */
  lastUsed: string;

  /** Number of training examples used */
  trainingExamples: number;

  /** Benchmark score before training (baseline) */
  baselineScore: number | null;

  /** Benchmark score after training */
  adapterScore: number | null;

  /** Improvement over baseline (adapter - baseline) */
  improvement: number | null;

  /** Number of times this adapter has been loaded */
  loadCount: number;

  /** Training configuration used */
  trainingConfig: LoraTrainingParams;

  /** Version number (incremented on retrain) */
  version: number;

  /** Notes about why this adapter was created/retired */
  notes: string;
}

/**
 * LoRA training parameters.
 */
export interface LoraTrainingParams {
  /** Rank for LoRA decomposition */
  rank: number;

  /** Alpha scaling factor */
  alpha: number;

  /** Target modules */
  targetModules: string[];

  /** Learning rate */
  learningRate: number;

  /** Number of epochs */
  epochs: number;

  /** Batch size */
  batchSize: number;

  /** Training data format */
  format: 'instruction_completion' | 'preference_dpo';
}

/**
 * The adapter registry stored on disk.
 */
export interface AdapterRegistry {
  /** All registered adapters */
  adapters: LoraAdapter[];

  /** When the registry was last updated */
  lastUpdated: string;

  /** Total training jobs completed */
  totalTrainingJobs: number;

  /** Total adapters discarded (didn't improve) */
  totalDiscarded: number;
}

/**
 * A benchmark task for evaluating adapters.
 */
export interface BenchmarkTask {
  /** Unique identifier */
  id: string;

  /** Skill domain */
  skill: string;

  /** Task description/instruction */
  instruction: string;

  /** Expected output criteria */
  expectedCriteria: string;

  /** Maximum score for this task */
  maxScore: number;
}

/**
 * Result of evaluating an adapter against benchmarks.
 */
export interface AdapterEvaluation {
  /** Adapter ID */
  adapterId: string;

  /** Benchmark scores */
  scores: Array<{
    taskId: string;
    score: number;
    maxScore: number;
  }>;

  /** Aggregate score (0-1) */
  aggregateScore: number;

  /** When evaluated */
  evaluatedAt: string;
}

/**
 * Configuration for the LoRA trainer.
 */
export interface LoraTrainerConfig {
  /** Directory for adapter files */
  adaptersPath: string;

  /** Directory for benchmark tasks */
  benchmarksPath: string;

  /** Maximum adapters to maintain */
  maxAdapters: number;

  /** Minimum improvement threshold to keep adapter */
  minImprovementThreshold: number;

  /** Default training parameters */
  defaultTrainingParams: LoraTrainingParams;

  /** Number of benchmark tasks per evaluation */
  evalSampleSize: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: LoraTrainerConfig = {
  adaptersPath: '~/.casterly/adapters',
  benchmarksPath: '~/.casterly/benchmarks',
  maxAdapters: 20,
  minImprovementThreshold: 0.05,
  defaultTrainingParams: {
    rank: 8,
    alpha: 16,
    targetModules: ['q_proj', 'v_proj'],
    learningRate: 0.0001,
    epochs: 3,
    batchSize: 8,
    format: 'instruction_completion',
  },
  evalSampleSize: 10,
};

// ─────────────────────────────────────────────────────────────────────────────
// LoRA Trainer
// ─────────────────────────────────────────────────────────────────────────────

export class LoraTrainer {
  private readonly config: LoraTrainerConfig;
  private registry: AdapterRegistry;
  private benchmarks: Map<string, BenchmarkTask[]> = new Map();
  private loaded = false;
  private dirty = false;

  constructor(config?: Partial<LoraTrainerConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.registry = {
      adapters: [],
      lastUpdated: new Date().toISOString(),
      totalTrainingJobs: 0,
      totalDiscarded: 0,
    };
  }

  // ── Persistence ─────────────────────────────────────────────────────────

  /**
   * Load the adapter registry and benchmarks from disk.
   */
  async load(): Promise<void> {
    const resolvedPath = this.config.adaptersPath.replace(/^~/, process.env['HOME'] ?? '~');

    try {
      const content = await readFile(join(resolvedPath, 'registry.json'), 'utf8');
      const parsed = JSON.parse(content) as AdapterRegistry;
      if (parsed && Array.isArray(parsed.adapters)) {
        this.registry = parsed;
      }
    } catch {
      // No existing registry
    }

    // Load benchmarks
    await this.loadBenchmarks();

    this.loaded = true;
  }

  /**
   * Save the adapter registry to disk.
   */
  async save(): Promise<void> {
    if (!this.dirty) return;

    const resolvedPath = this.config.adaptersPath.replace(/^~/, process.env['HOME'] ?? '~');
    await mkdir(resolvedPath, { recursive: true });
    await writeFile(
      join(resolvedPath, 'registry.json'),
      JSON.stringify(this.registry, null, 2),
      'utf8',
    );

    this.dirty = false;
    getTracer().log('dream', 'debug', `Adapter registry saved: ${this.registry.adapters.length} adapters`);
  }

  // ── Adapter Lifecycle ───────────────────────────────────────────────────

  /**
   * Create a new adapter entry for a skill domain.
   * This records the intent to train — actual training requires
   * external tools (unsloth, llama.cpp, etc.).
   */
  createAdapter(
    skill: string,
    trainingExamples: number,
    params?: Partial<LoraTrainingParams>,
    notes?: string,
  ): LoraAdapter {
    const tracer = getTracer();

    // Check capacity
    const activeAdapters = this.registry.adapters.filter(
      (a) => a.status === 'active' || a.status === 'training' || a.status === 'evaluating',
    );

    if (activeAdapters.length >= this.config.maxAdapters) {
      throw new Error(`Adapter limit reached (${this.config.maxAdapters}). Archive or discard existing adapters first.`);
    }

    // Check for existing adapter for this skill
    const existing = this.registry.adapters.find(
      (a) => a.skill === skill && (a.status === 'active' || a.status === 'training'),
    );

    const version = existing ? existing.version + 1 : 1;
    const id = `adapter-${skill}-v${version}`;

    const adapter: LoraAdapter = {
      id,
      skill,
      fileName: `${skill}-v${version}.lora`,
      status: 'training',
      createdAt: new Date().toISOString(),
      lastUsed: new Date().toISOString(),
      trainingExamples,
      baselineScore: null,
      adapterScore: null,
      improvement: null,
      loadCount: 0,
      trainingConfig: { ...this.config.defaultTrainingParams, ...params },
      version,
      notes: notes ?? `Training adapter for ${skill} with ${trainingExamples} examples`,
    };

    // If there's an existing active adapter, archive it
    if (existing && existing.status === 'active') {
      existing.status = 'archived';
      existing.notes += ` | Archived: superseded by v${version}`;
    }

    this.registry.adapters.push(adapter);
    this.registry.totalTrainingJobs++;
    this.registry.lastUpdated = new Date().toISOString();
    this.dirty = true;

    tracer.log('dream', 'info', `Created adapter ${id} for skill ${skill} (${trainingExamples} examples)`);
    return adapter;
  }

  /**
   * Record evaluation results for an adapter.
   */
  recordEvaluation(
    adapterId: string,
    baselineScore: number,
    adapterScore: number,
  ): { accepted: boolean; improvement: number } {
    const tracer = getTracer();
    const adapter = this.registry.adapters.find((a) => a.id === adapterId);
    if (!adapter) {
      throw new Error(`Adapter not found: ${adapterId}`);
    }

    adapter.baselineScore = baselineScore;
    adapter.adapterScore = adapterScore;
    adapter.improvement = adapterScore - baselineScore;
    adapter.status = 'evaluating';

    const accepted = adapter.improvement >= this.config.minImprovementThreshold;

    if (accepted) {
      adapter.status = 'active';
      adapter.notes += ` | Accepted: +${(adapter.improvement * 100).toFixed(1)}% improvement`;
      tracer.log('dream', 'info', `Adapter ${adapterId} accepted: +${(adapter.improvement * 100).toFixed(1)}%`);
    } else {
      adapter.status = 'discarded';
      adapter.notes += ` | Discarded: only +${(adapter.improvement * 100).toFixed(1)}% (threshold: ${(this.config.minImprovementThreshold * 100).toFixed(1)}%)`;
      this.registry.totalDiscarded++;
      tracer.log('dream', 'info', `Adapter ${adapterId} discarded: insufficient improvement`);
    }

    this.registry.lastUpdated = new Date().toISOString();
    this.dirty = true;

    return { accepted, improvement: adapter.improvement };
  }

  /**
   * Record that an adapter was loaded for inference.
   */
  recordLoad(adapterId: string): void {
    const adapter = this.registry.adapters.find((a) => a.id === adapterId);
    if (adapter) {
      adapter.loadCount++;
      adapter.lastUsed = new Date().toISOString();
      this.dirty = true;
    }
  }

  /**
   * Archive an adapter (keep on disk but don't load).
   */
  archiveAdapter(adapterId: string): void {
    const adapter = this.registry.adapters.find((a) => a.id === adapterId);
    if (adapter && adapter.status === 'active') {
      adapter.status = 'archived';
      adapter.notes += ' | Manually archived';
      this.registry.lastUpdated = new Date().toISOString();
      this.dirty = true;
    }
  }

  /**
   * Discard an adapter (remove from registry).
   */
  discardAdapter(adapterId: string): void {
    const idx = this.registry.adapters.findIndex((a) => a.id === adapterId);
    if (idx !== -1) {
      this.registry.adapters.splice(idx, 1);
      this.registry.totalDiscarded++;
      this.registry.lastUpdated = new Date().toISOString();
      this.dirty = true;
    }
  }

  // ── Benchmark Management ────────────────────────────────────────────────

  /**
   * Add a benchmark task for a skill domain.
   */
  addBenchmarkTask(task: BenchmarkTask): void {
    const tasks = this.benchmarks.get(task.skill) ?? [];
    tasks.push(task);
    this.benchmarks.set(task.skill, tasks);
  }

  /**
   * Get benchmark tasks for a skill domain.
   */
  getBenchmarkTasks(skill: string): BenchmarkTask[] {
    return this.benchmarks.get(skill) ?? [];
  }

  /**
   * Get all benchmark tasks across all skills.
   */
  getAllBenchmarkTasks(): BenchmarkTask[] {
    const all: BenchmarkTask[] = [];
    for (const tasks of this.benchmarks.values()) {
      all.push(...tasks);
    }
    return all;
  }

  // ── Queries ─────────────────────────────────────────────────────────────

  /**
   * Get all adapters, optionally filtered by status.
   */
  getAdapters(status?: LoraAdapter['status']): LoraAdapter[] {
    if (status) {
      return this.registry.adapters.filter((a) => a.status === status);
    }
    return [...this.registry.adapters];
  }

  /**
   * Get the active adapter for a skill domain.
   */
  getActiveAdapter(skill: string): LoraAdapter | undefined {
    return this.registry.adapters.find(
      (a) => a.skill === skill && a.status === 'active',
    );
  }

  /**
   * Get all active adapters.
   */
  getActiveAdapters(): LoraAdapter[] {
    return this.registry.adapters.filter((a) => a.status === 'active');
  }

  /**
   * Get skills that have sufficient training data but no active adapter.
   */
  getTrainableSkills(dataset: TrainingDataset, minExamples: number = 10): string[] {
    const trainable: string[] = [];

    for (const [skill, examples] of Object.entries(dataset.examplesBySkill)) {
      if (examples.length >= minExamples) {
        const existing = this.getActiveAdapter(skill);
        if (!existing) {
          trainable.push(skill);
        }
      }
    }

    return trainable;
  }

  /**
   * Get the adapter registry data (for testing/inspection).
   */
  getRegistry(): Readonly<AdapterRegistry> {
    return this.registry;
  }

  /**
   * Build a summary of adapter status.
   */
  buildSummaryText(): string {
    const active = this.getActiveAdapters();
    const training = this.getAdapters('training');
    const archived = this.getAdapters('archived');

    const lines: string[] = [
      `LoRA Adapters: ${this.registry.adapters.length} total`,
      `Active: ${active.length}, Training: ${training.length}, Archived: ${archived.length}`,
      `Total training jobs: ${this.registry.totalTrainingJobs}`,
      `Total discarded: ${this.registry.totalDiscarded}`,
    ];

    if (active.length > 0) {
      lines.push('');
      lines.push('Active adapters:');
      for (const a of active) {
        const imp = a.improvement !== null ? `+${(a.improvement * 100).toFixed(1)}%` : 'N/A';
        lines.push(`  ${a.skill} v${a.version}: ${imp} improvement, ${a.loadCount} loads`);
      }
    }

    return lines.join('\n');
  }

  // ── Private Helpers ─────────────────────────────────────────────────────

  /**
   * Load benchmark tasks from disk.
   */
  private async loadBenchmarks(): Promise<void> {
    const resolvedPath = this.config.benchmarksPath.replace(/^~/, process.env['HOME'] ?? '~');

    try {
      const files = await readdir(resolvedPath);
      for (const file of files) {
        if (!file.endsWith('.json')) continue;

        try {
          const content = await readFile(join(resolvedPath, file), 'utf8');
          const tasks = JSON.parse(content) as BenchmarkTask[];
          if (Array.isArray(tasks)) {
            for (const task of tasks) {
              this.addBenchmarkTask(task);
            }
          }
        } catch {
          // Skip invalid benchmark files
        }
      }
    } catch {
      // No benchmarks directory yet
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────────────────────

export function createLoraTrainer(
  config?: Partial<LoraTrainerConfig>,
): LoraTrainer {
  return new LoraTrainer(config);
}
