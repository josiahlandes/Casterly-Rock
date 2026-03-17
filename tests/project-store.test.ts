import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  writeProjectState,
  readProjectState,
  type ProjectState,
} from '../src/dual-loop/project-store.js';
import type { FileOperation, PlanStep } from '../src/dual-loop/task-board-types.js';

describe('ProjectState persistence', () => {
  let tempDir: string;
  const projectDir = 'projects/test-project';

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'project-store-test-'));
    await mkdir(join(tempDir, projectDir), { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const sampleManifest: FileOperation[] = [
    { path: 'projects/test-project/index.ts', action: 'created', lines: 120, exports: ['main', 'Config'] },
    { path: 'projects/test-project/utils.ts', action: 'created', lines: 45 },
  ];

  const sampleSteps: PlanStep[] = [
    { description: 'Create main entry point', status: 'done' },
    { description: 'Add utility functions', status: 'done' },
  ];

  const sampleState: ProjectState = {
    updatedAt: '2026-03-16T12:00:00.000Z',
    lastTaskId: 'task-abc123',
    manifest: sampleManifest,
    plan: 'Build a TypeScript CLI tool with two modules.',
    planSteps: sampleSteps,
    lastDeliveredSummary: 'Created a CLI tool with main entry and utilities.',
    lastRequest: 'Build me a CLI tool',
  };

  it('round-trips a full ProjectState through write and read', async () => {
    await writeProjectState(tempDir, projectDir, sampleState);
    const loaded = await readProjectState(tempDir, projectDir);

    expect(loaded).not.toBeNull();
    expect(loaded!.updatedAt).toBe(sampleState.updatedAt);
    expect(loaded!.lastTaskId).toBe(sampleState.lastTaskId);
    expect(loaded!.manifest).toEqual(sampleManifest);
    expect(loaded!.plan).toBe(sampleState.plan);
    expect(loaded!.planSteps).toEqual(sampleSteps);
    expect(loaded!.lastDeliveredSummary).toBe(sampleState.lastDeliveredSummary);
    expect(loaded!.lastRequest).toBe(sampleState.lastRequest);
  });

  it('returns null when PROJECT_STATE.json does not exist', async () => {
    const loaded = await readProjectState(tempDir, projectDir);
    expect(loaded).toBeNull();
  });

  it('returns null for a non-existent project directory', async () => {
    const loaded = await readProjectState(tempDir, 'projects/nonexistent');
    expect(loaded).toBeNull();
  });

  it('handles minimal state (only required fields)', async () => {
    const minimal: ProjectState = {
      updatedAt: '2026-03-16T12:00:00.000Z',
      lastTaskId: 'task-minimal',
      manifest: [],
    };

    await writeProjectState(tempDir, projectDir, minimal);
    const loaded = await readProjectState(tempDir, projectDir);

    expect(loaded).not.toBeNull();
    expect(loaded!.lastTaskId).toBe('task-minimal');
    expect(loaded!.manifest).toEqual([]);
    expect(loaded!.plan).toBeUndefined();
    expect(loaded!.planSteps).toBeUndefined();
    expect(loaded!.lastDeliveredSummary).toBeUndefined();
    expect(loaded!.lastRequest).toBeUndefined();
  });

  it('overwrites previous state on subsequent writes', async () => {
    await writeProjectState(tempDir, projectDir, sampleState);

    const updatedState: ProjectState = {
      updatedAt: '2026-03-17T08:00:00.000Z',
      lastTaskId: 'task-def456',
      manifest: [
        ...sampleManifest,
        { path: 'projects/test-project/new-file.ts', action: 'created', lines: 30 },
      ],
      lastDeliveredSummary: 'Added new-file.ts with additional features.',
    };

    await writeProjectState(tempDir, projectDir, updatedState);
    const loaded = await readProjectState(tempDir, projectDir);

    expect(loaded!.lastTaskId).toBe('task-def456');
    expect(loaded!.manifest).toHaveLength(3);
    expect(loaded!.plan).toBeUndefined();
  });
});
