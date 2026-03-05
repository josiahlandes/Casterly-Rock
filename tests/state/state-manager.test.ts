import { describe, it, expect, vi, beforeEach } from 'vitest';
import { StateManager } from '../../src/state/state-manager.js';
import {
  createAllStores,
  loadableStores,
  savableStores,
} from '../../src/state/store-registry.js';
import type { AllStores } from '../../src/state/store-registry.js';

// ─────────────────────────────────────────────────────────────────────────────
// Factory Helpers
// ─────────────────────────────────────────────────────────────────────────────

describe('Store Registry', () => {
  describe('createAllStores', () => {
    it('returns an object with all expected core store keys', () => {
      const stores = createAllStores();

      // Core stores
      expect(stores.worldModel).toBeDefined();
      expect(stores.goalStack).toBeDefined();
      expect(stores.issueLog).toBeDefined();
      expect(stores.journal).toBeDefined();
      expect(stores.contextManager).toBeDefined();
      expect(stores.eventBus).toBeDefined();

      // Advanced Memory stores
      expect(stores.linkNetwork).toBeDefined();
      expect(stores.memoryEvolution).toBeDefined();
      expect(stores.audnConsolidator).toBeDefined();
      expect(stores.entropyMigrator).toBeDefined();
      expect(stores.memoryVersioning).toBeDefined();
      expect(stores.temporalInvalidation).toBeDefined();
      expect(stores.memoryChecker).toBeDefined();
      expect(stores.skillFilesManager).toBeDefined();
      expect(stores.concurrentDreamExecutor).toBeDefined();
      expect(stores.graphMemory).toBeDefined();

      // Vision tiers start as null
      expect(stores.promptStore).toBeNull();
      expect(stores.shadowStore).toBeNull();
      expect(stores.toolSynthesizer).toBeNull();
      expect(stores.challengeGenerator).toBeNull();
    });
  });

  describe('loadableStores', () => {
    it('returns descriptors with name and load function', () => {
      const stores = createAllStores();
      const loadable = loadableStores(stores);

      expect(loadable.length).toBeGreaterThan(0);
      for (const op of loadable) {
        expect(typeof op.name).toBe('string');
        expect(op.name.length).toBeGreaterThan(0);
        expect(typeof op.load).toBe('function');
      }
    });

    it('includes core loadable stores', () => {
      const stores = createAllStores();
      const loadable = loadableStores(stores);
      const names = loadable.map((op) => op.name);

      expect(names).toContain('worldModel');
      expect(names).toContain('goalStack');
      expect(names).toContain('issueLog');
      expect(names).toContain('journal');
      expect(names).toContain('linkNetwork');
      expect(names).toContain('graphMemory');
    });
  });

  describe('savableStores', () => {
    it('returns descriptors with name and save function', () => {
      const stores = createAllStores();
      const savable = savableStores(stores);

      expect(savable.length).toBeGreaterThan(0);
      for (const op of savable) {
        expect(typeof op.name).toBe('string');
        expect(op.name.length).toBeGreaterThan(0);
        expect(typeof op.save).toBe('function');
      }
    });

    it('includes core savable stores but not journal', () => {
      const stores = createAllStores();
      const savable = savableStores(stores);
      const names = savable.map((op) => op.name);

      expect(names).toContain('worldModel');
      expect(names).toContain('goalStack');
      expect(names).toContain('issueLog');
      // Journal is append-only, no bulk save
      expect(names).not.toContain('journal');
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// StateManager
// ─────────────────────────────────────────────────────────────────────────────

describe('StateManager', () => {
  let sm: StateManager;

  beforeEach(() => {
    sm = new StateManager('/tmp/test-project');
  });

  it('constructor creates stores', () => {
    const stores = sm.getStores();
    expect(stores).toBeDefined();
    expect(stores.worldModel).toBeDefined();
    expect(stores.goalStack).toBeDefined();
    expect(stores.issueLog).toBeDefined();
  });

  // ── Role-Scoped Views ────────────────────────────────────────────────────

  describe('plannerView', () => {
    it('returns worldModel, goalStack, issueLog, skillFiles, and memory stores', () => {
      const view = sm.plannerView();

      expect(view.worldModel).toBeDefined();
      expect(view.goalStack).toBeDefined();
      expect(view.issueLog).toBeDefined();
      expect(view.skillFiles).toBeDefined();
      expect(view.journal).toBeDefined();
      expect(view.contextManager).toBeDefined();
      expect(view.linkNetwork).toBeDefined();
      expect(view.memoryEvolution).toBeDefined();
      expect(view.graphMemory).toBeDefined();
    });
  });

  describe('coderView', () => {
    it('returns ONLY projectDir and toolkit', () => {
      const view = sm.coderView();

      expect(view.projectDir).toBe('/tmp/test-project');
      expect('toolkit' in view).toBe(true);
      // Toolkit is undefined when not provided to constructor
      expect(view.toolkit).toBeUndefined();

      // Verify no extra keys snuck in
      const keys = Object.keys(view);
      expect(keys).toHaveLength(2);
      expect(keys).toContain('projectDir');
      expect(keys).toContain('toolkit');
    });
  });

  describe('reviewerView', () => {
    it('returns worldModel, goalStack, issueLog', () => {
      const view = sm.reviewerView();

      expect(view.worldModel).toBeDefined();
      expect(view.goalStack).toBeDefined();
      expect(view.issueLog).toBeDefined();

      // Verify no extra keys
      const keys = Object.keys(view);
      expect(keys).toHaveLength(3);
      expect(keys).toContain('worldModel');
      expect(keys).toContain('goalStack');
      expect(keys).toContain('issueLog');
    });
  });

  // ── Lifecycle ────────────────────────────────────────────────────────────

  describe('load', () => {
    it('calls load on loadable stores', async () => {
      const stores = sm.getStores();
      const loadable = loadableStores(stores);

      // Spy on each loadable store's load method
      const spies = loadable.map((op) => vi.spyOn(op, 'load').mockResolvedValue(undefined));

      // Note: StateManager.load() creates its own loadable descriptors internally,
      // so we need to spy on the actual store objects instead
      const worldModelLoadSpy = vi.spyOn(stores.worldModel, 'load').mockResolvedValue(undefined);
      const goalStackLoadSpy = vi.spyOn(stores.goalStack, 'load').mockResolvedValue(undefined);
      const issueLogLoadSpy = vi.spyOn(stores.issueLog, 'load').mockResolvedValue(undefined);

      await sm.load();

      expect(worldModelLoadSpy).toHaveBeenCalled();
      expect(goalStackLoadSpy).toHaveBeenCalled();
      expect(issueLogLoadSpy).toHaveBeenCalled();

      // Restore spies
      worldModelLoadSpy.mockRestore();
      goalStackLoadSpy.mockRestore();
      issueLogLoadSpy.mockRestore();
      for (const spy of spies) spy.mockRestore();
    });
  });

  describe('save', () => {
    it('calls save on savable stores', async () => {
      const stores = sm.getStores();

      const worldModelSaveSpy = vi.spyOn(stores.worldModel, 'save').mockResolvedValue(undefined);
      const goalStackSaveSpy = vi.spyOn(stores.goalStack, 'save').mockResolvedValue(undefined);
      const issueLogSaveSpy = vi.spyOn(stores.issueLog, 'save').mockResolvedValue(undefined);

      await sm.save();

      expect(worldModelSaveSpy).toHaveBeenCalled();
      expect(goalStackSaveSpy).toHaveBeenCalled();
      expect(issueLogSaveSpy).toHaveBeenCalled();

      worldModelSaveSpy.mockRestore();
      goalStackSaveSpy.mockRestore();
      issueLogSaveSpy.mockRestore();
    });
  });

  // ── Convenience ──────────────────────────────────────────────────────────

  describe('getProjectDir', () => {
    it('returns the project dir passed to constructor', () => {
      expect(sm.getProjectDir()).toBe('/tmp/test-project');
    });
  });
});
