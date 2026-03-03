/**
 * MLX LoRA Trainer — QLoRA Training on Apple Silicon via mlx-lm
 *
 * Wraps the mlx-lm CLI to perform QLoRA fine-tuning locally on Apple
 * Silicon's unified memory. Training data is converted to JSONL format
 * and passed to mlx-lm's LoRA training pipeline.
 *
 * Memory budget: QLoRA with rank 16 on a 35B model requires ~35GB,
 * fitting within Apple Silicon's unified memory on M-series Macs.
 *
 * See docs/roadmap.md Tier 3, Items 8-10.
 */

import { exec } from 'node:child_process';
import { readFile, writeFile, mkdir, copyFile, access, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { promisify } from 'node:util';
import { getTracer } from '../debug.js';
import type { TrainingExample, PreferencePair } from './training-extractor.js';
import type { LoraTrainingParams } from './lora-trainer.js';

const execAsync = promisify(exec);

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Configuration for MLX LoRA training.
 */
export interface MlxLoraConfig {
  /** Path to store training data and adapters */
  adaptersPath: string;

  /** Base model to fine-tune (HuggingFace path or local) */
  baseModel: string;

  /** Path to mlx-lm binary (default: 'mlx_lm.lora') */
  mlxLmBinary: string;

  /** Maximum training time in seconds (default: 3600 = 1 hour) */
  maxTrainingTimeSec: number;

  /** Minimum examples required to start training (default: 20) */
  minExamplesForTraining: number;

  /** Seed for reproducibility (default: 42) */
  seed: number;
}

/**
 * Result of a training run.
 */
export interface TrainingResult {
  /** Whether training completed successfully */
  success: boolean;

  /** Path to the trained adapter weights */
  adapterPath: string;

  /** Training loss at end of training */
  finalLoss: number | null;

  /** Total training time in seconds */
  durationSec: number;

  /** Number of training examples used */
  examplesUsed: number;

  /** Error message if training failed */
  error?: string;
}

/**
 * A single training entry in mlx-lm JSONL format.
 */
interface MlxTrainingEntry {
  /** The full prompt (instruction) */
  prompt: string;

  /** The expected completion */
  completion: string;
}

/**
 * A DPO training entry for preference-based training.
 */
interface MlxDPOEntry {
  /** The prompt/instruction */
  prompt: string;

  /** The preferred response */
  chosen: string;

  /** The rejected response */
  rejected: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: MlxLoraConfig = {
  adaptersPath: '~/.casterly/adapters',
  baseModel: 'mlx-community/Qwen3.5-3B-A3B-MLX-4bit',
  mlxLmBinary: 'mlx_lm.lora',
  maxTrainingTimeSec: 3600,
  minExamplesForTraining: 20,
  seed: 42,
};

// ─────────────────────────────────────────────────────────────────────────────
// MLX LoRA Trainer
// ─────────────────────────────────────────────────────────────────────────────

export class MlxLoraTrainer {
  private readonly config: MlxLoraConfig;

  constructor(config?: Partial<MlxLoraConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // ── Training Data Formatting ─────────────────────────────────────────────

  /**
   * Convert instruction/completion examples to mlx-lm JSONL format.
   * Filters to success-only examples for supervised fine-tuning.
   */
  formatForSFT(examples: TrainingExample[]): MlxTrainingEntry[] {
    return examples
      .filter((e) => e.outcome === 'success')
      .map((e) => ({
        prompt: e.instruction,
        completion: e.completion,
      }));
  }

  /**
   * Convert preference pairs to DPO JSONL format.
   */
  formatForDPO(pairs: PreferencePair[]): MlxDPOEntry[] {
    return pairs.map((p) => ({
      prompt: p.instruction,
      chosen: p.chosen,
      rejected: p.rejected,
    }));
  }

  /**
   * Write training data to JSONL file.
   */
  async writeTrainingData(
    entries: MlxTrainingEntry[] | MlxDPOEntry[],
    outputPath: string,
  ): Promise<void> {
    const resolvedPath = this.resolvePath(outputPath);
    await mkdir(dirname(resolvedPath), { recursive: true });

    const lines = entries.map((e) => JSON.stringify(e));
    await writeFile(resolvedPath, lines.join('\n') + '\n', 'utf8');
  }

  /**
   * Split training data into train/valid/test sets (80/10/10).
   */
  async writeTrainValidTestSplit(
    entries: MlxTrainingEntry[],
    outputDir: string,
  ): Promise<{ trainCount: number; validCount: number; testCount: number }> {
    const resolvedDir = this.resolvePath(outputDir);
    await mkdir(resolvedDir, { recursive: true });

    // Shuffle deterministically
    const shuffled = [...entries];
    let seed = this.config.seed;
    for (let i = shuffled.length - 1; i > 0; i--) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      const j = seed % (i + 1);
      [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
    }

    const trainEnd = Math.floor(shuffled.length * 0.8);
    const validEnd = Math.floor(shuffled.length * 0.9);

    const train = shuffled.slice(0, trainEnd);
    const valid = shuffled.slice(trainEnd, validEnd);
    const test = shuffled.slice(validEnd);

    await this.writeTrainingData(train, join(resolvedDir, 'train.jsonl'));
    await this.writeTrainingData(valid, join(resolvedDir, 'valid.jsonl'));
    await this.writeTrainingData(test, join(resolvedDir, 'test.jsonl'));

    return {
      trainCount: train.length,
      validCount: valid.length,
      testCount: test.length,
    };
  }

  // ── Training Execution ───────────────────────────────────────────────────

  /**
   * Run QLoRA training via mlx-lm CLI.
   *
   * This invokes the external mlx-lm training pipeline. The adapter
   * weights are saved to the specified output path.
   */
  async train(
    dataDir: string,
    adapterName: string,
    params: LoraTrainingParams,
  ): Promise<TrainingResult> {
    const tracer = getTracer();
    const start = Date.now();

    const resolvedDataDir = this.resolvePath(dataDir);
    const resolvedAdaptersPath = this.resolvePath(this.config.adaptersPath);
    const adapterOutputPath = join(resolvedAdaptersPath, adapterName);

    await mkdir(adapterOutputPath, { recursive: true });

    // Build mlx-lm command
    const cmd = [
      this.config.mlxLmBinary,
      `--model "${this.config.baseModel}"`,
      `--data "${resolvedDataDir}"`,
      `--adapter-path "${adapterOutputPath}"`,
      `--lora-rank ${params.rank}`,
      `--batch-size ${params.batchSize}`,
      `--iters ${params.epochs * 100}`, // mlx-lm uses iterations not epochs
      `--learning-rate ${params.learningRate}`,
      `--seed ${this.config.seed}`,
      '--train',
    ].join(' ');

    tracer.log('dream', 'info', `Starting MLX LoRA training: ${adapterName}`, {
      model: this.config.baseModel,
      dataDir: resolvedDataDir,
      rank: params.rank,
      epochs: params.epochs,
    });

    try {
      const { stdout, stderr } = await execAsync(cmd, {
        timeout: this.config.maxTrainingTimeSec * 1000,
        env: { ...process.env },
      });

      const durationSec = (Date.now() - start) / 1000;
      const finalLoss = this.parseFinalLoss(stdout + '\n' + stderr);

      tracer.log('dream', 'info', `MLX LoRA training complete: ${adapterName}`, {
        durationSec,
        finalLoss,
      });

      return {
        success: true,
        adapterPath: adapterOutputPath,
        finalLoss,
        durationSec,
        examplesUsed: 0, // Will be populated by caller
      };
    } catch (err) {
      const durationSec = (Date.now() - start) / 1000;
      const message = err instanceof Error ? err.message : String(err);

      tracer.log('dream', 'warn', `MLX LoRA training failed: ${adapterName}`, {
        error: message,
        durationSec,
      });

      return {
        success: false,
        adapterPath: adapterOutputPath,
        finalLoss: null,
        durationSec,
        examplesUsed: 0,
        error: message,
      };
    }
  }

  // ── Adapter Management ───────────────────────────────────────────────────

  /**
   * Store the current adapter as the "previous" iteration for SPIN.
   * Copies the adapter directory to a versioned backup.
   */
  async archivePreviousIteration(
    adapterName: string,
    version: number,
  ): Promise<string> {
    const resolvedPath = this.resolvePath(this.config.adaptersPath);
    const currentPath = join(resolvedPath, adapterName);
    const previousPath = join(resolvedPath, `${adapterName}.prev-v${version}`);

    try {
      await access(currentPath);
      await mkdir(previousPath, { recursive: true });

      // Copy adapter files
      const { readdir } = await import('node:fs/promises');
      const files = await readdir(currentPath);
      for (const file of files) {
        await copyFile(join(currentPath, file), join(previousPath, file));
      }

      getTracer().log('dream', 'info', `Archived adapter ${adapterName} v${version} to ${previousPath}`);
      return previousPath;
    } catch (err) {
      throw new Error(`Failed to archive adapter: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Check if mlx-lm is installed and accessible.
   */
  async checkMlxLmAvailable(): Promise<boolean> {
    try {
      await execAsync(`${this.config.mlxLmBinary} --help`, { timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Clean up training data directory.
   */
  async cleanupTrainingData(dataDir: string): Promise<void> {
    const resolvedDir = this.resolvePath(dataDir);
    try {
      await rm(resolvedDir, { recursive: true, force: true });
    } catch {
      // Best effort cleanup
    }
  }

  // ── Private Helpers ────────────────────────────────────────────────────

  /**
   * Parse the final training loss from mlx-lm output.
   */
  private parseFinalLoss(output: string): number | null {
    // mlx-lm outputs lines like: "Iter 100: Train loss 1.234, ..."
    const matches = [...output.matchAll(/Train loss ([\d.]+)/g)];
    if (matches.length === 0) return null;

    const lastMatch = matches[matches.length - 1]!;
    const loss = parseFloat(lastMatch[1]!);
    return isNaN(loss) ? null : loss;
  }

  /**
   * Resolve ~ in paths to the home directory.
   */
  private resolvePath(path: string): string {
    return path.replace(/^~/, process.env['HOME'] ?? '~');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────────────────────

export function createMlxLoraTrainer(
  config?: Partial<MlxLoraConfig>,
): MlxLoraTrainer {
  return new MlxLoraTrainer(config);
}
