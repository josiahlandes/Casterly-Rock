import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  LoraTrainer,
  createLoraTrainer,
} from '../src/autonomous/dream/lora-trainer.js';
import type {
  BenchmarkTask,
} from '../src/autonomous/dream/lora-trainer.js';
import {
  TrainingExtractor,
  createTrainingExtractor,
} from '../src/autonomous/dream/training-extractor.js';
import type { TrainingDataset as ExtractorDataset } from '../src/autonomous/dream/training-extractor.js';
import { resetTracer, initTracer } from '../src/autonomous/debug.js';

// ─────────────────────────────────────────────────────────────────────────────
// Setup
// ─────────────────────────────────────────────────────────────────────────────

let tempDir: string;

beforeEach(async () => {
  resetTracer();
  initTracer({ enabled: false });
  tempDir = await mkdtemp(join(tmpdir(), 'casterly-lora-'));
});

afterEach(async () => {
  resetTracer();
  await rm(tempDir, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// Helpers — mock Journal and IssueLog for TrainingExtractor
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a minimal mock journal with entries.
 */
function mockJournal(entries: Array<{
  id: string;
  type: 'reflection' | 'handoff' | 'observation' | 'opinion' | 'user_interaction';
  content: string;
  tags: string[];
  timestamp?: string;
}>) {
  return {
    getAllEntries: () => entries.map((e) => ({
      id: e.id,
      timestamp: e.timestamp ?? new Date().toISOString(),
      type: e.type,
      content: e.content,
      tags: e.tags,
    })),
  };
}

/**
 * Create a minimal mock issue log with issues.
 */
function mockIssueLog(issues: Array<{
  id: string;
  title: string;
  description: string;
  tags: string[];
  status: 'open' | 'resolved';
  attempts: Array<{
    approach: string;
    outcome: 'success' | 'failure' | 'partial';
    details: string;
  }>;
  lastUpdated?: string;
}>) {
  return {
    getData: () => ({
      version: 1,
      nextId: issues.length + 1,
      issues: issues.map((iss) => ({
        id: iss.id,
        title: iss.title,
        description: iss.description,
        status: iss.status,
        priority: 'medium' as const,
        firstSeen: new Date().toISOString(),
        lastUpdated: iss.lastUpdated ?? new Date().toISOString(),
        relatedFiles: [],
        tags: iss.tags,
        attempts: iss.attempts.map((a) => ({
          timestamp: new Date().toISOString(),
          approach: a.approach,
          outcome: a.outcome,
          details: a.details,
          filesModified: [],
        })),
        nextIdea: '',
        discoveredBy: 'autonomous' as const,
        resolution: '',
      })),
    }),
  };
}

function makeDataset(skills: Record<string, number>): ExtractorDataset {
  const examplesBySkill: Record<string, Array<{
    id: string; skill: string; instruction: string; completion: string;
    outcome: 'success' | 'failure'; source: 'journal'; sourceId: string; extractedAt: string;
  }>> = {};

  for (const [skill, count] of Object.entries(skills)) {
    examplesBySkill[skill] = [];
    for (let i = 0; i < count; i++) {
      examplesBySkill[skill]!.push({
        id: `ex-${skill}-${i}`,
        skill,
        instruction: `Do something with ${skill}`,
        completion: `Here is how to do ${skill} thing ${i}`,
        outcome: 'success',
        source: 'journal',
        sourceId: `j-${i}`,
        extractedAt: new Date().toISOString(),
      });
    }
  }

  let totalExamples = 0;
  for (const list of Object.values(examplesBySkill)) {
    totalExamples += list.length;
  }

  return {
    extractedAt: new Date().toISOString(),
    lookbackDays: 90,
    examplesBySkill,
    preferencesBySkill: {},
    totalExamples,
    totalPreferences: 0,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// TrainingExtractor Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('TrainingExtractor — Extraction from Journal', () => {
  it('extracts training examples from journal reflection entries', async () => {
    const extractor = new TrainingExtractor({
      outputPath: join(tempDir, 'training-data.json'),
      lookbackDays: 365,
      minContentLength: 10,
    });

    const journal = mockJournal([
      {
        id: 'j-1',
        type: 'reflection',
        content: 'The regex pattern for matching URLs needed lookaheads. Got it working after fixing the character class.',
        tags: ['regex', 'fix'],
      },
      {
        id: 'j-2',
        type: 'handoff',
        content: 'Session focused on testing the security module. All edge cases handled correctly.',
        tags: ['testing', 'security'],
      },
      {
        id: 'j-3',
        type: 'observation',
        content: 'This observation should not be extracted as a training example.',
        tags: ['misc'],
      },
    ]);

    const issueLog = mockIssueLog([]);
    const dataset = await extractor.extract(journal as any, issueLog as any);

    // Only reflection and handoff entries should be extracted
    expect(dataset.totalExamples).toBeGreaterThanOrEqual(2);
    // Check skill classification worked
    const skills = Object.keys(dataset.examplesBySkill);
    expect(skills.length).toBeGreaterThan(0);
  });

  it('respects minimum content length', async () => {
    const extractor = new TrainingExtractor({
      outputPath: join(tempDir, 'training-data.json'),
      lookbackDays: 365,
      minContentLength: 100,
    });

    const journal = mockJournal([
      { id: 'j-short', type: 'reflection', content: 'Too short.', tags: ['regex'] },
    ]);

    const issueLog = mockIssueLog([]);
    const dataset = await extractor.extract(journal as any, issueLog as any);

    expect(dataset.totalExamples).toBe(0);
  });
});

describe('TrainingExtractor — Extraction from Issue Log', () => {
  it('extracts training examples from issue attempts', async () => {
    const extractor = new TrainingExtractor({
      outputPath: join(tempDir, 'training-data.json'),
      lookbackDays: 365,
      minContentLength: 10,
    });

    const journal = mockJournal([]);
    const issueLog = mockIssueLog([
      {
        id: 'ISS-001',
        title: 'Regex pattern fails on Unicode input',
        description: 'The detector regex does not handle Unicode characters correctly.',
        tags: ['regex', 'bug'],
        status: 'resolved',
        attempts: [
          {
            approach: 'Added the Unicode flag (u) to the regex pattern and adjusted character classes.',
            outcome: 'success',
            details: 'All Unicode test cases now pass.',
          },
        ],
      },
    ]);

    const dataset = await extractor.extract(journal as any, issueLog as any);

    expect(dataset.totalExamples).toBeGreaterThanOrEqual(1);
    expect(dataset.examplesBySkill['regex']).toBeDefined();
  });
});

describe('TrainingExtractor — Preference Pairs', () => {
  it('builds preference pairs from successful vs failed attempts', async () => {
    const extractor = new TrainingExtractor({
      outputPath: join(tempDir, 'training-data.json'),
      lookbackDays: 365,
      minContentLength: 10,
    });

    const journal = mockJournal([]);
    const issueLog = mockIssueLog([
      {
        id: 'ISS-002',
        title: 'Performance issue in parsing module',
        description: 'The parsing module takes too long to process large CSV files.',
        tags: ['performance', 'parsing'],
        status: 'resolved',
        attempts: [
          {
            approach: 'Tried splitting the file into chunks and processing in parallel using streams.',
            outcome: 'failure',
            details: 'Memory usage too high, OOM on large files.',
          },
          {
            approach: 'Used a streaming line-by-line parser with backpressure support.',
            outcome: 'success',
            details: 'Handles 10GB files within 512MB memory.',
          },
        ],
      },
    ]);

    const dataset = await extractor.extract(journal as any, issueLog as any);

    expect(dataset.totalPreferences).toBeGreaterThanOrEqual(1);
    // At least one preference pair from the performance/parsing domain
    const prefSkills = Object.keys(dataset.preferencesBySkill);
    expect(prefSkills.length).toBeGreaterThan(0);

    // Verify chosen is the success, rejected is the failure
    for (const pairs of Object.values(dataset.preferencesBySkill)) {
      for (const pair of pairs) {
        expect(pair.chosen).toContain('streaming line-by-line');
        expect(pair.rejected).toContain('splitting the file');
      }
    }
  });
});

describe('TrainingExtractor — Skill Classification', () => {
  it('classifies text into skill domains based on keywords', async () => {
    const extractor = new TrainingExtractor({
      outputPath: join(tempDir, 'training-data.json'),
      lookbackDays: 365,
      minContentLength: 10,
    });

    const journal = mockJournal([
      { id: 'j-regex', type: 'reflection', content: 'Worked on regex patterns for URL validation today.', tags: [] },
      { id: 'j-security', type: 'reflection', content: 'Reviewed code for security vulnerabilities in auth module.', tags: [] },
      { id: 'j-general', type: 'reflection', content: 'Made some general improvements to the codebase structure and organization.', tags: [] },
    ]);

    const issueLog = mockIssueLog([]);
    const dataset = await extractor.extract(journal as any, issueLog as any);

    const skills = Object.keys(dataset.examplesBySkill);
    expect(skills).toContain('regex');
    expect(skills).toContain('security');
    // The third entry should fall under 'general' since it has no keywords
    expect(skills).toContain('general');
  });
});

describe('TrainingExtractor — Dataset Summarization', () => {
  it('produces a readable summary of the dataset', async () => {
    const extractor = new TrainingExtractor({
      outputPath: join(tempDir, 'training-data.json'),
      lookbackDays: 365,
      minContentLength: 10,
    });

    const journal = mockJournal([
      { id: 'j-1', type: 'reflection', content: 'Worked on regex pattern matching with lookaheads and backreferences.', tags: ['regex'] },
      { id: 'j-2', type: 'reflection', content: 'Reviewed test coverage. Failed some edge cases. Tests need work.', tags: ['testing'] },
    ]);

    const issueLog = mockIssueLog([]);
    const dataset = await extractor.extract(journal as any, issueLog as any);
    const summary = extractor.summarizeDataset(dataset);

    expect(summary).toContain('Training Dataset Summary');
    expect(summary).toContain('Total examples:');
    expect(summary).toContain('Examples by skill:');
  });
});

describe('TrainingExtractor — Persistence', () => {
  it('saves and loads a dataset', async () => {
    const outputPath = join(tempDir, 'training-data.json');
    const extractor = new TrainingExtractor({ outputPath });

    const dataset = makeDataset({ regex: 3, testing: 2 });
    await extractor.saveDataset(dataset);

    const loaded = await extractor.loadDataset();
    expect(loaded).not.toBeNull();
    expect(loaded!.totalExamples).toBe(5);
    expect(Object.keys(loaded!.examplesBySkill)).toContain('regex');
    expect(Object.keys(loaded!.examplesBySkill)).toContain('testing');
  });

  it('returns null when no saved dataset exists', async () => {
    const extractor = new TrainingExtractor({
      outputPath: join(tempDir, 'nonexistent.json'),
    });

    const loaded = await extractor.loadDataset();
    expect(loaded).toBeNull();
  });
});

describe('TrainingExtractor — Factory', () => {
  it('createTrainingExtractor returns a TrainingExtractor', () => {
    const ext = createTrainingExtractor({
      outputPath: join(tempDir, 'test.json'),
    });
    expect(ext).toBeInstanceOf(TrainingExtractor);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// LoraTrainer Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('LoraTrainer — Adapter Creation', () => {
  let trainer: LoraTrainer;

  beforeEach(() => {
    trainer = new LoraTrainer({
      adaptersPath: join(tempDir, 'adapters'),
      benchmarksPath: join(tempDir, 'benchmarks'),
      maxAdapters: 5,
      minImprovementThreshold: 0.05,
    });
  });

  it('creates a new adapter for a skill', () => {
    const adapter = trainer.createAdapter('regex', 50);

    expect(adapter.id).toBe('adapter-regex-v1');
    expect(adapter.skill).toBe('regex');
    expect(adapter.status).toBe('training');
    expect(adapter.trainingExamples).toBe(50);
    expect(adapter.version).toBe(1);
    expect(adapter.loadCount).toBe(0);
  });

  it('increments version when creating adapter for same skill', () => {
    const a1 = trainer.createAdapter('regex', 50);
    // Manually set first adapter to active so the second one triggers versioning
    a1.status = 'active';

    const a2 = trainer.createAdapter('regex', 75);

    expect(a2.version).toBe(2);
    expect(a2.id).toBe('adapter-regex-v2');
    // First adapter should be archived
    expect(a1.status).toBe('archived');
  });

  it('throws when adapter capacity is reached', () => {
    for (let i = 0; i < 5; i++) {
      trainer.createAdapter(`skill-${i}`, 10);
    }

    expect(() => trainer.createAdapter('extra-skill', 10)).toThrow('Adapter limit reached');
  });
});

describe('LoraTrainer — Evaluation', () => {
  let trainer: LoraTrainer;

  beforeEach(() => {
    trainer = new LoraTrainer({
      adaptersPath: join(tempDir, 'adapters'),
      benchmarksPath: join(tempDir, 'benchmarks'),
      minImprovementThreshold: 0.05,
    });
  });

  it('accepts an adapter that exceeds the improvement threshold', () => {
    trainer.createAdapter('regex', 50);

    const result = trainer.recordEvaluation('adapter-regex-v1', 0.6, 0.72);

    expect(result.accepted).toBe(true);
    expect(result.improvement).toBeCloseTo(0.12, 2);

    const adapter = trainer.getActiveAdapter('regex');
    expect(adapter).toBeDefined();
    expect(adapter!.status).toBe('active');
  });

  it('rejects an adapter below the improvement threshold', () => {
    trainer.createAdapter('regex', 50);

    const result = trainer.recordEvaluation('adapter-regex-v1', 0.6, 0.63);

    expect(result.accepted).toBe(false);
    expect(result.improvement).toBeCloseTo(0.03, 2);

    const adapters = trainer.getAdapters('discarded');
    expect(adapters).toHaveLength(1);
  });

  it('throws for unknown adapter ID', () => {
    expect(() => trainer.recordEvaluation('nonexistent', 0.5, 0.6)).toThrow('not found');
  });
});

describe('LoraTrainer — Load Recording', () => {
  it('records load count and updates lastUsed', () => {
    const trainer = new LoraTrainer({
      adaptersPath: join(tempDir, 'adapters'),
      benchmarksPath: join(tempDir, 'benchmarks'),
    });

    trainer.createAdapter('regex', 50);
    trainer.recordEvaluation('adapter-regex-v1', 0.5, 0.7);

    const before = trainer.getActiveAdapter('regex')!.lastUsed;

    trainer.recordLoad('adapter-regex-v1');
    trainer.recordLoad('adapter-regex-v1');
    trainer.recordLoad('adapter-regex-v1');

    const adapter = trainer.getActiveAdapter('regex');
    expect(adapter!.loadCount).toBe(3);
    expect(adapter!.lastUsed).not.toBe('');
  });
});

describe('LoraTrainer — Archiving and Discarding', () => {
  let trainer: LoraTrainer;

  beforeEach(() => {
    trainer = new LoraTrainer({
      adaptersPath: join(tempDir, 'adapters'),
      benchmarksPath: join(tempDir, 'benchmarks'),
    });
  });

  it('archives an active adapter', () => {
    trainer.createAdapter('regex', 50);
    trainer.recordEvaluation('adapter-regex-v1', 0.5, 0.7);

    expect(trainer.getActiveAdapter('regex')).toBeDefined();

    trainer.archiveAdapter('adapter-regex-v1');

    expect(trainer.getActiveAdapter('regex')).toBeUndefined();
    expect(trainer.getAdapters('archived')).toHaveLength(1);
  });

  it('discards an adapter (removes from registry)', () => {
    trainer.createAdapter('regex', 50);

    expect(trainer.getAdapters().length).toBe(1);

    trainer.discardAdapter('adapter-regex-v1');

    expect(trainer.getAdapters().length).toBe(0);
    expect(trainer.getRegistry().totalDiscarded).toBe(1);
  });
});

describe('LoraTrainer — Trainable Skills', () => {
  it('identifies skills with enough data but no active adapter', () => {
    const trainer = new LoraTrainer({
      adaptersPath: join(tempDir, 'adapters'),
      benchmarksPath: join(tempDir, 'benchmarks'),
    });

    const dataset = makeDataset({ regex: 15, testing: 8, security: 20 });

    const trainable = trainer.getTrainableSkills(dataset, 10);

    expect(trainable).toContain('regex');
    expect(trainable).toContain('security');
    expect(trainable).not.toContain('testing'); // Only 8 examples, below threshold of 10
  });

  it('excludes skills that already have an active adapter', () => {
    const trainer = new LoraTrainer({
      adaptersPath: join(tempDir, 'adapters'),
      benchmarksPath: join(tempDir, 'benchmarks'),
    });

    // Create and activate a regex adapter
    trainer.createAdapter('regex', 50);
    trainer.recordEvaluation('adapter-regex-v1', 0.5, 0.7);

    const dataset = makeDataset({ regex: 15, security: 20 });
    const trainable = trainer.getTrainableSkills(dataset, 10);

    expect(trainable).not.toContain('regex');
    expect(trainable).toContain('security');
  });
});

describe('LoraTrainer — Benchmark Tasks', () => {
  it('adds and retrieves benchmark tasks by skill', () => {
    const trainer = new LoraTrainer({
      adaptersPath: join(tempDir, 'adapters'),
      benchmarksPath: join(tempDir, 'benchmarks'),
    });

    const task: BenchmarkTask = {
      id: 'bm-1',
      skill: 'regex',
      instruction: 'Write a regex to match email addresses.',
      expectedCriteria: 'Matches valid emails, rejects invalid.',
      maxScore: 10,
    };

    trainer.addBenchmarkTask(task);

    const tasks = trainer.getBenchmarkTasks('regex');
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.id).toBe('bm-1');
  });

  it('returns all benchmark tasks across skills', () => {
    const trainer = new LoraTrainer({
      adaptersPath: join(tempDir, 'adapters'),
      benchmarksPath: join(tempDir, 'benchmarks'),
    });

    trainer.addBenchmarkTask({ id: 'bm-1', skill: 'regex', instruction: 'A', expectedCriteria: 'B', maxScore: 10 });
    trainer.addBenchmarkTask({ id: 'bm-2', skill: 'security', instruction: 'C', expectedCriteria: 'D', maxScore: 10 });

    const all = trainer.getAllBenchmarkTasks();
    expect(all).toHaveLength(2);
  });
});

describe('LoraTrainer — Summary Text', () => {
  it('builds a summary of adapter status', () => {
    const trainer = new LoraTrainer({
      adaptersPath: join(tempDir, 'adapters'),
      benchmarksPath: join(tempDir, 'benchmarks'),
    });

    trainer.createAdapter('regex', 50);
    trainer.recordEvaluation('adapter-regex-v1', 0.5, 0.7);

    trainer.createAdapter('testing', 30);

    const summary = trainer.buildSummaryText();

    expect(summary).toContain('LoRA Adapters:');
    expect(summary).toContain('Active: 1');
    expect(summary).toContain('Training: 1');
    expect(summary).toContain('regex');
  });
});

describe('LoraTrainer — Persistence', () => {
  it('saves and reloads the adapter registry', async () => {
    const adaptersPath = join(tempDir, 'adapters');
    const benchmarksPath = join(tempDir, 'benchmarks');

    const trainer = new LoraTrainer({ adaptersPath, benchmarksPath });

    trainer.createAdapter('regex', 50);
    trainer.recordEvaluation('adapter-regex-v1', 0.5, 0.7);
    await trainer.save();

    const trainer2 = new LoraTrainer({ adaptersPath, benchmarksPath });
    await trainer2.load();

    const adapters = trainer2.getAdapters();
    expect(adapters).toHaveLength(1);
    expect(adapters[0]!.id).toBe('adapter-regex-v1');
    expect(adapters[0]!.status).toBe('active');
  });

  it('loads benchmark tasks from disk', async () => {
    const adaptersPath = join(tempDir, 'adapters');
    const benchmarksPath = join(tempDir, 'benchmarks');

    // Write benchmark file
    await mkdir(benchmarksPath, { recursive: true });
    await writeFile(
      join(benchmarksPath, 'regex.json'),
      JSON.stringify([
        { id: 'bm-disk-1', skill: 'regex', instruction: 'Match URLs', expectedCriteria: 'Passes', maxScore: 10 },
      ]),
      'utf8',
    );

    const trainer = new LoraTrainer({ adaptersPath, benchmarksPath });
    await trainer.load();

    const tasks = trainer.getBenchmarkTasks('regex');
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.id).toBe('bm-disk-1');
  });
});

describe('LoraTrainer — Factory', () => {
  it('createLoraTrainer returns a LoraTrainer', () => {
    const trainer = createLoraTrainer({
      adaptersPath: join(tempDir, 'test-adapters'),
      benchmarksPath: join(tempDir, 'test-benchmarks'),
    });
    expect(trainer).toBeInstanceOf(LoraTrainer);
  });
});
