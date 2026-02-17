import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { WorldModel } from '../src/autonomous/world-model.js';
import type { UserModel } from '../src/autonomous/world-model.js';
import { resetTracer, initTracer } from '../src/autonomous/debug.js';

// ─────────────────────────────────────────────────────────────────────────────
// Test Setup
// ─────────────────────────────────────────────────────────────────────────────

let tempDir: string;
let worldModel: WorldModel;

beforeEach(async () => {
  resetTracer();
  initTracer({ enabled: false });
  tempDir = await mkdtemp(join(tmpdir(), 'casterly-user-model-test-'));

  worldModel = new WorldModel({
    path: join(tempDir, 'world-model.yaml'),
    projectRoot: tempDir,
  });
});

afterEach(async () => {
  resetTracer();
  await rm(tempDir, { recursive: true, force: true });
});

// ═══════════════════════════════════════════════════════════════════════════════
// getUserModel()
// ═══════════════════════════════════════════════════════════════════════════════

describe('WorldModel — getUserModel()', () => {
  it('returns a UserModel with empty defaults initially (from createEmptyWorldModel)', () => {
    const userModel = worldModel.getUserModel();

    // createEmptyWorldModel initializes userModel with empty defaults
    expect(userModel).toBeDefined();
    expect(userModel!.communicationStyle).toBe('');
    expect(userModel!.priorities).toEqual([]);
    expect(userModel!.recentTopics).toEqual([]);
    expect(userModel!.preferences).toEqual([]);
  });

  it('returns updated UserModel after updateUserModel is called', () => {
    worldModel.updateUserModel({
      communicationStyle: 'technical and concise',
      priorities: ['security', 'performance'],
    });

    const userModel = worldModel.getUserModel();
    expect(userModel).toBeDefined();
    expect(userModel!.communicationStyle).toBe('technical and concise');
    expect(userModel!.priorities).toEqual(['security', 'performance']);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// updateUserModel()
// ═══════════════════════════════════════════════════════════════════════════════

describe('WorldModel — updateUserModel()', () => {
  it('merges updates correctly', () => {
    // First update: set communication style and priorities
    worldModel.updateUserModel({
      communicationStyle: 'casual',
      priorities: ['testing'],
    });

    // Second update: change communication style, keep priorities
    worldModel.updateUserModel({
      communicationStyle: 'formal',
    });

    const userModel = worldModel.getUserModel()!;
    expect(userModel.communicationStyle).toBe('formal');
    // Priorities should remain from the first update
    expect(userModel.priorities).toEqual(['testing']);
  });

  it('deduplicates preferences', () => {
    worldModel.updateUserModel({
      preferences: ['TypeScript over JavaScript', 'dark mode'],
    });

    worldModel.updateUserModel({
      preferences: ['TypeScript over JavaScript', 'vim bindings'],
    });

    const userModel = worldModel.getUserModel()!;
    // Should have 3 unique preferences, no duplicates
    expect(userModel.preferences).toHaveLength(3);
    expect(userModel.preferences).toContain('TypeScript over JavaScript');
    expect(userModel.preferences).toContain('dark mode');
    expect(userModel.preferences).toContain('vim bindings');
  });

  it('limits recentTopics to 10', () => {
    // Add 8 topics
    worldModel.updateUserModel({
      recentTopics: ['topic1', 'topic2', 'topic3', 'topic4', 'topic5', 'topic6', 'topic7', 'topic8'],
    });

    // Add 5 more topics (should push out oldest)
    worldModel.updateUserModel({
      recentTopics: ['topic9', 'topic10', 'topic11', 'topic12', 'topic13'],
    });

    const userModel = worldModel.getUserModel()!;
    expect(userModel.recentTopics).toHaveLength(10);
    // Newest topics should come first
    expect(userModel.recentTopics[0]).toBe('topic9');
    expect(userModel.recentTopics[4]).toBe('topic13');
  });

  it('updates lastUpdated timestamp', () => {
    const beforeUpdate = new Date().toISOString();

    worldModel.updateUserModel({
      communicationStyle: 'brief',
    });

    const userModel = worldModel.getUserModel()!;
    expect(userModel.lastUpdated).toBeTruthy();
    // lastUpdated should be recent (after or equal to beforeUpdate)
    expect(userModel.lastUpdated >= beforeUpdate).toBe(true);
  });

  it('replaces priorities entirely on update', () => {
    worldModel.updateUserModel({
      priorities: ['security', 'privacy'],
    });

    worldModel.updateUserModel({
      priorities: ['performance', 'testing'],
    });

    const userModel = worldModel.getUserModel()!;
    expect(userModel.priorities).toEqual(['performance', 'testing']);
  });

  it('handles empty update gracefully', () => {
    worldModel.updateUserModel({
      communicationStyle: 'verbose',
      priorities: ['documentation'],
    });

    // Empty update should not clear existing values
    worldModel.updateUserModel({});

    const userModel = worldModel.getUserModel()!;
    expect(userModel.communicationStyle).toBe('verbose');
    expect(userModel.priorities).toEqual(['documentation']);
  });

  it('handles multiple preference updates accumulating correctly', () => {
    worldModel.updateUserModel({ preferences: ['pref-a'] });
    worldModel.updateUserModel({ preferences: ['pref-b'] });
    worldModel.updateUserModel({ preferences: ['pref-c'] });

    const userModel = worldModel.getUserModel()!;
    expect(userModel.preferences).toHaveLength(3);
    expect(userModel.preferences).toContain('pref-a');
    expect(userModel.preferences).toContain('pref-b');
    expect(userModel.preferences).toContain('pref-c');
  });

  it('handles recentTopics prepending new topics', () => {
    worldModel.updateUserModel({
      recentTopics: ['old-topic-1', 'old-topic-2'],
    });

    worldModel.updateUserModel({
      recentTopics: ['new-topic-1'],
    });

    const userModel = worldModel.getUserModel()!;
    // New topics should be prepended
    expect(userModel.recentTopics[0]).toBe('new-topic-1');
    expect(userModel.recentTopics).toContain('old-topic-1');
    expect(userModel.recentTopics).toContain('old-topic-2');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Persistence round-trip
// ═══════════════════════════════════════════════════════════════════════════════

describe('WorldModel — UserModel persistence', () => {
  it('survives save and load round-trip', async () => {
    worldModel.updateUserModel({
      communicationStyle: 'technical',
      priorities: ['security', 'performance'],
      recentTopics: ['refactoring', 'testing'],
      preferences: ['TypeScript', 'Vitest'],
    });

    // Force dirty flag by updating; then save
    await worldModel.save();

    // Load in a new instance
    const worldModel2 = new WorldModel({
      path: join(tempDir, 'world-model.yaml'),
      projectRoot: tempDir,
    });
    await worldModel2.load();

    const loaded = worldModel2.getUserModel();
    expect(loaded).toBeDefined();
    expect(loaded!.communicationStyle).toBe('technical');
    expect(loaded!.priorities).toEqual(['security', 'performance']);
    expect(loaded!.recentTopics).toEqual(['refactoring', 'testing']);
    expect(loaded!.preferences).toEqual(['TypeScript', 'Vitest']);
  });
});
