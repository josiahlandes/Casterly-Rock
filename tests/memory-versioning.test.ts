import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { MemoryVersioning, createMemoryVersioning } from '../src/autonomous/memory/memory-versioning.js';
import { resetTracer, initTracer } from '../src/autonomous/debug.js';

let tempDir: string;

beforeEach(async () => {
  resetTracer();
  initTracer({ enabled: false });
  tempDir = await mkdtemp(join(tmpdir(), 'casterly-versioning-test-'));
});

afterEach(async () => {
  resetTracer();
  await rm(tempDir, { recursive: true, force: true });
});

function makeVersioning(): MemoryVersioning {
  return createMemoryVersioning({
    basePath: join(tempDir, 'versions'),
    monitoredPaths: {},
  });
}

describe('MemoryVersioning', () => {
  describe('createSnapshotFromData', () => {
    it('creates a snapshot from provided data', () => {
      const v = makeVersioning();
      const snap = v.createSnapshotFromData({
        trigger: 'test',
        message: 'Test snapshot',
        data: { crystals: 'crystal data', goals: 'goal data' },
      });

      expect(snap.id).toMatch(/^snap-/);
      expect(snap.trigger).toBe('test');
      expect(snap.data['crystals']).toBe('crystal data');
      expect(v.count()).toBe(1);
    });

    it('trims old snapshots at capacity', () => {
      const v = createMemoryVersioning({
        basePath: join(tempDir, 'versions'),
        maxSnapshots: 2,
        monitoredPaths: {},
      });

      v.createSnapshotFromData({ trigger: 'a', message: 'first', data: { x: '1' } });
      v.createSnapshotFromData({ trigger: 'b', message: 'second', data: { x: '2' } });
      v.createSnapshotFromData({ trigger: 'c', message: 'third', data: { x: '3' } });

      expect(v.count()).toBe(2);
    });
  });

  describe('diff', () => {
    it('diffs two snapshots', () => {
      const v = makeVersioning();
      const snap1 = v.createSnapshotFromData({
        trigger: 'test',
        message: 'First',
        data: { crystals: 'line1\nline2\n' },
      });
      const snap2 = v.createSnapshotFromData({
        trigger: 'test',
        message: 'Second',
        data: { crystals: 'line1\nline3\n' },
      });

      const diff = v.diff(snap2.id, snap1.id);
      expect(diff).not.toBeNull();
      expect(diff!.subsystemsChanged).toContain('crystals');
      expect(diff!.diffs).toHaveLength(1);
    });

    it('detects added subsystems', () => {
      const v = makeVersioning();
      const snap1 = v.createSnapshotFromData({
        trigger: 'test',
        message: 'First',
        data: { crystals: 'data' },
      });
      const snap2 = v.createSnapshotFromData({
        trigger: 'test',
        message: 'Second',
        data: { crystals: 'data', goals: 'new goals' },
      });

      const diff = v.diff(snap2.id, snap1.id);
      expect(diff!.subsystemsAdded).toContain('goals');
    });

    it('returns null for unknown snapshot', () => {
      const v = makeVersioning();
      expect(v.diff('nonexistent')).toBeNull();
    });
  });

  describe('persistence', () => {
    it('saves and loads snapshots', async () => {
      const v1 = makeVersioning();
      v1.createSnapshotFromData({ trigger: 'test', message: 'snap', data: { a: 'b' } });
      await v1.save();

      const v2 = makeVersioning();
      await v2.load();
      expect(v2.count()).toBe(1);
      expect(v2.getLatest()!.data['a']).toBe('b');
    });
  });

  describe('listSnapshots', () => {
    it('lists snapshots newest first', () => {
      const v = makeVersioning();
      v.createSnapshotFromData({ trigger: 'a', message: 'first', data: {} });
      v.createSnapshotFromData({ trigger: 'b', message: 'second', data: {} });

      const list = v.listSnapshots();
      expect(list).toHaveLength(2);
      expect(list[0]!.message).toBe('second');
    });
  });
});
