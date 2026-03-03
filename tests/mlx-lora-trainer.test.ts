import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { MlxLoraTrainer, createMlxLoraTrainer } from '../src/autonomous/dream/mlx-lora-trainer.js';
import type { TrainingExample, PreferencePair } from '../src/autonomous/dream/training-extractor.js';
import type { LoraTrainingParams } from '../src/autonomous/dream/lora-trainer.js';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeExample(overrides?: Partial<TrainingExample>): TrainingExample {
  return {
    id: 'train-test-1',
    skill: 'testing',
    instruction: 'Write a test for the parser',
    completion: 'describe("parser", () => { it("parses", () => {}); })',
    outcome: 'success',
    source: 'journal',
    sourceId: 'j-test',
    extractedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makePreferencePair(overrides?: Partial<PreferencePair>): PreferencePair {
  return {
    id: 'pref-test-1',
    skill: 'testing',
    instruction: 'Fix the test suite',
    chosen: 'Good approach: use mocks',
    rejected: 'Bad approach: skip tests',
    chosenSourceId: 'issue-1',
    rejectedSourceId: 'issue-1',
    extractedAt: new Date().toISOString(),
    ...overrides,
  };
}

const DEFAULT_PARAMS: LoraTrainingParams = {
  rank: 16,
  alpha: 32,
  targetModules: ['q_proj', 'v_proj'],
  learningRate: 0.0001,
  epochs: 3,
  batchSize: 8,
  format: 'instruction_completion',
};

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('MlxLoraTrainer', () => {
  // ── Factory ──────────────────────────────────────────────────────────────

  it('factory creates instance', () => {
    const trainer = createMlxLoraTrainer();
    expect(trainer).toBeInstanceOf(MlxLoraTrainer);
  });

  // ── SFT Formatting ───────────────────────────────────────────────────────

  describe('formatForSFT', () => {
    it('converts success examples to prompt/completion pairs', () => {
      const trainer = createMlxLoraTrainer();
      const examples = [
        makeExample({ outcome: 'success' }),
        makeExample({ id: 'train-test-2', outcome: 'success', instruction: 'Fix bug', completion: 'Fixed it' }),
      ];

      const result = trainer.formatForSFT(examples);

      expect(result).toHaveLength(2);
      expect(result[0]!.prompt).toBe('Write a test for the parser');
      expect(result[0]!.completion).toContain('describe');
      expect(result[1]!.prompt).toBe('Fix bug');
    });

    it('filters out failure examples', () => {
      const trainer = createMlxLoraTrainer();
      const examples = [
        makeExample({ outcome: 'success' }),
        makeExample({ id: 'train-fail', outcome: 'failure' }),
      ];

      const result = trainer.formatForSFT(examples);

      expect(result).toHaveLength(1);
    });

    it('handles empty examples', () => {
      const trainer = createMlxLoraTrainer();
      expect(trainer.formatForSFT([])).toHaveLength(0);
    });
  });

  // ── DPO Formatting ──────────────────────────────────────────────────────

  describe('formatForDPO', () => {
    it('converts preference pairs to DPO format', () => {
      const trainer = createMlxLoraTrainer();
      const pairs = [makePreferencePair()];

      const result = trainer.formatForDPO(pairs);

      expect(result).toHaveLength(1);
      expect(result[0]!.prompt).toBe('Fix the test suite');
      expect(result[0]!.chosen).toBe('Good approach: use mocks');
      expect(result[0]!.rejected).toBe('Bad approach: skip tests');
    });

    it('handles empty pairs', () => {
      const trainer = createMlxLoraTrainer();
      expect(trainer.formatForDPO([])).toHaveLength(0);
    });
  });

  // ── Training Data Split ──────────────────────────────────────────────────

  describe('writeTrainValidTestSplit', () => {
    let tempDir: string;

    beforeEach(async () => {
      tempDir = await mkdtemp(join(tmpdir(), 'mlx-lora-test-'));
    });

    afterEach(async () => {
      await rm(tempDir, { recursive: true, force: true });
    });

    it('splits data 80/10/10', async () => {
      const trainer = createMlxLoraTrainer();
      const outputDir = join(tempDir, 'split-100');

      const entries = Array.from({ length: 100 }, (_, i) => ({
        prompt: `Prompt ${i}`,
        completion: `Completion ${i}`,
      }));

      const result = await trainer.writeTrainValidTestSplit(entries, outputDir);

      expect(result.trainCount).toBe(80);
      expect(result.validCount).toBe(10);
      expect(result.testCount).toBe(10);
      expect(result.trainCount + result.validCount + result.testCount).toBe(100);

      // Verify files were actually written with correct line counts
      const trainLines = (await readFile(join(outputDir, 'train.jsonl'), 'utf8')).trim().split('\n');
      const validLines = (await readFile(join(outputDir, 'valid.jsonl'), 'utf8')).trim().split('\n');
      const testLines = (await readFile(join(outputDir, 'test.jsonl'), 'utf8')).trim().split('\n');

      expect(trainLines).toHaveLength(80);
      expect(validLines).toHaveLength(10);
      expect(testLines).toHaveLength(10);

      // Verify JSONL format
      const firstEntry = JSON.parse(trainLines[0]!);
      expect(firstEntry).toHaveProperty('prompt');
      expect(firstEntry).toHaveProperty('completion');
    });

    it('handles small datasets', async () => {
      const trainer = createMlxLoraTrainer();
      const outputDir = join(tempDir, 'split-20');

      const entries = Array.from({ length: 20 }, (_, i) => ({
        prompt: `Prompt ${i}`,
        completion: `Completion ${i}`,
      }));

      const result = await trainer.writeTrainValidTestSplit(entries, outputDir);

      expect(result.trainCount).toBe(16); // floor(20*0.8)
      expect(result.validCount).toBe(2);  // floor(20*0.9) - 16
      expect(result.testCount).toBe(2);   // 20 - 18

      // Verify files exist with correct counts
      const trainLines = (await readFile(join(outputDir, 'train.jsonl'), 'utf8')).trim().split('\n');
      const validLines = (await readFile(join(outputDir, 'valid.jsonl'), 'utf8')).trim().split('\n');
      const testLines = (await readFile(join(outputDir, 'test.jsonl'), 'utf8')).trim().split('\n');

      expect(trainLines).toHaveLength(16);
      expect(validLines).toHaveLength(2);
      expect(testLines).toHaveLength(2);
    });
  });

  // ── Loss Parsing ─────────────────────────────────────────────────────────

  describe('parseFinalLoss (via train output)', () => {
    it('parses loss from mlx-lm stdout format', () => {
      const trainer = createMlxLoraTrainer();
      // Access private method via prototype
      const parseFinalLoss = (trainer as unknown as { parseFinalLoss: (s: string) => number | null }).parseFinalLoss.bind(trainer);

      const output = `
Iter 1: Train loss 3.456, Val loss 3.789
Iter 50: Train loss 1.234, Val loss 1.567
Iter 100: Train loss 0.890, Val loss 1.023
`;
      expect(parseFinalLoss(output)).toBeCloseTo(0.89, 2);
    });

    it('returns null for output without loss', () => {
      const trainer = createMlxLoraTrainer();
      const parseFinalLoss = (trainer as unknown as { parseFinalLoss: (s: string) => number | null }).parseFinalLoss.bind(trainer);

      expect(parseFinalLoss('No loss information here')).toBeNull();
    });
  });

  // ── mlx-lm Availability Check ────────────────────────────────────────────

  describe('checkMlxLmAvailable', () => {
    it('returns false when mlx-lm is not installed', async () => {
      const trainer = createMlxLoraTrainer({ mlxLmBinary: 'nonexistent_binary_xyz' });
      const result = await trainer.checkMlxLmAvailable();
      expect(result).toBe(false);
    });
  });
});
