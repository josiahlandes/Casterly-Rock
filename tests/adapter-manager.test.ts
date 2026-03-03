import { describe, expect, it } from 'vitest';
import {
  AdapterManager,
  createAdapterManager,
  type AdapterCategory,
  type TaskPhase,
} from '../src/autonomous/dream/adapter-manager.js';
import { LoraTrainer } from '../src/autonomous/dream/lora-trainer.js';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeLoraTrainer(): LoraTrainer {
  return new LoraTrainer({
    adaptersPath: '/tmp/test-adapters',
    benchmarksPath: '/tmp/test-benchmarks',
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('AdapterManager', () => {
  // ── Factory ──────────────────────────────────────────────────────────────

  it('factory creates instance', () => {
    const manager = createAdapterManager();
    expect(manager).toBeInstanceOf(AdapterManager);
  });

  // ── Phase to Category Mapping ────────────────────────────────────────────

  describe('getCategoryForPhase', () => {
    it('maps triage to reasoning', () => {
      const manager = createAdapterManager();
      expect(manager.getCategoryForPhase('triage')).toBe('reasoning');
    });

    it('maps planning to reasoning', () => {
      const manager = createAdapterManager();
      expect(manager.getCategoryForPhase('planning')).toBe('reasoning');
    });

    it('maps execution to tools', () => {
      const manager = createAdapterManager();
      expect(manager.getCategoryForPhase('execution')).toBe('tools');
    });

    it('maps review to reasoning', () => {
      const manager = createAdapterManager();
      expect(manager.getCategoryForPhase('review')).toBe('reasoning');
    });

    it('maps revision to tools', () => {
      const manager = createAdapterManager();
      expect(manager.getCategoryForPhase('revision')).toBe('tools');
    });
  });

  // ── Example Classification ──────────────────────────────────────────────

  describe('classifyExample', () => {
    it('classifies tool call content as tools', () => {
      const manager = createAdapterManager();
      expect(manager.classifyExample(
        'Read the config file',
        'Used read_file to check config.yaml',
      )).toBe('tools');
    });

    it('classifies write_file as tools', () => {
      const manager = createAdapterManager();
      expect(manager.classifyExample(
        'Create a new module',
        'Called write_file to create src/parser.ts',
      )).toBe('tools');
    });

    it('classifies pure reasoning as reasoning', () => {
      const manager = createAdapterManager();
      expect(manager.classifyExample(
        'Analyze the architecture',
        'The system uses a dual-loop design with fast and deep loops',
      )).toBe('reasoning');
    });

    it('classifies tool_call patterns as tools', () => {
      const manager = createAdapterManager();
      expect(manager.classifyExample(
        'Execute the plan',
        'Tool call: grep for pattern in source files',
      )).toBe('tools');
    });
  });

  // ── Split by Category ──────────────────────────────────────────────────

  describe('splitByCategory', () => {
    it('splits examples into reasoning and tools', () => {
      const manager = createAdapterManager();
      const examples = [
        { instruction: 'Analyze', completion: 'The architecture is clean' },
        { instruction: 'Fix', completion: 'Used read_file to check the bug' },
        { instruction: 'Plan', completion: 'We should refactor the module' },
        { instruction: 'Execute', completion: 'Called write_file to create output' },
      ];

      const { reasoning, tools } = manager.splitByCategory(examples);

      expect(reasoning).toHaveLength(2);
      expect(tools).toHaveLength(2);
    });

    it('handles all-reasoning input', () => {
      const manager = createAdapterManager();
      const examples = [
        { instruction: 'Think', completion: 'Consider the tradeoffs' },
        { instruction: 'Plan', completion: 'The approach should be incremental' },
      ];

      const { reasoning, tools } = manager.splitByCategory(examples);

      expect(reasoning).toHaveLength(2);
      expect(tools).toHaveLength(0);
    });

    it('handles empty input', () => {
      const manager = createAdapterManager();
      const { reasoning, tools } = manager.splitByCategory([]);
      expect(reasoning).toHaveLength(0);
      expect(tools).toHaveLength(0);
    });
  });

  // ── Adapter Registration ──────────────────────────────────────────────

  describe('registerAdapter', () => {
    it('registers a new adapter', () => {
      const manager = createAdapterManager();
      manager.registerAdapter('adapter-testing-v1', 'reasoning', 'testing');

      const entries = manager.getEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0]!.adapterId).toBe('adapter-testing-v1');
      expect(entries[0]!.category).toBe('reasoning');
      expect(entries[0]!.skill).toBe('testing');
      expect(entries[0]!.selected).toBe(true);
    });

    it('deselects previous adapter for same category+skill', () => {
      const manager = createAdapterManager();
      manager.registerAdapter('adapter-testing-v1', 'reasoning', 'testing');
      manager.registerAdapter('adapter-testing-v2', 'reasoning', 'testing');

      const entries = manager.getEntries();
      expect(entries).toHaveLength(2);

      const v1 = entries.find((e) => e.adapterId === 'adapter-testing-v1')!;
      const v2 = entries.find((e) => e.adapterId === 'adapter-testing-v2')!;
      expect(v1.selected).toBe(false);
      expect(v2.selected).toBe(true);
    });

    it('allows same adapter for different categories', () => {
      const manager = createAdapterManager();
      manager.registerAdapter('adapter-testing-v1', 'reasoning', 'testing');
      manager.registerAdapter('adapter-testing-v2', 'tools', 'testing');

      const reasoning = manager.getEntriesByCategory('reasoning');
      const tools = manager.getEntriesByCategory('tools');
      expect(reasoning).toHaveLength(1);
      expect(tools).toHaveLength(1);
      expect(reasoning[0]!.selected).toBe(true);
      expect(tools[0]!.selected).toBe(true);
    });
  });

  // ── Deregistration ────────────────────────────────────────────────────

  describe('deregisterAdapter', () => {
    it('removes adapter entry', () => {
      const manager = createAdapterManager();
      manager.registerAdapter('adapter-testing-v1', 'reasoning', 'testing');
      expect(manager.getEntries()).toHaveLength(1);

      manager.deregisterAdapter('adapter-testing-v1');
      expect(manager.getEntries()).toHaveLength(0);
    });

    it('handles nonexistent adapter', () => {
      const manager = createAdapterManager();
      manager.deregisterAdapter('nonexistent');
      expect(manager.getEntries()).toHaveLength(0);
    });
  });

  // ── Fully Disentangled Check ──────────────────────────────────────────

  describe('isFullyDisentangled', () => {
    it('returns true when both categories have adapters', () => {
      const manager = createAdapterManager();
      manager.registerAdapter('adapter-testing-r', 'reasoning', 'testing');
      manager.registerAdapter('adapter-testing-t', 'tools', 'testing');
      expect(manager.isFullyDisentangled('testing')).toBe(true);
    });

    it('returns false when only one category exists', () => {
      const manager = createAdapterManager();
      manager.registerAdapter('adapter-testing-r', 'reasoning', 'testing');
      expect(manager.isFullyDisentangled('testing')).toBe(false);
    });

    it('returns false for unknown skill', () => {
      const manager = createAdapterManager();
      expect(manager.isFullyDisentangled('unknown')).toBe(false);
    });
  });

  // ── Adapter Selection ──────────────────────────────────────────────────

  describe('selectForPhase', () => {
    it('selects reasoning adapter for planning phase', () => {
      const manager = createAdapterManager();
      const trainer = makeLoraTrainer();

      // Create and activate a test adapter
      const adapter = trainer.createAdapter('testing', 10);
      trainer.recordEvaluation(adapter.id, 0.5, 0.6);

      // Register as reasoning adapter
      manager.registerAdapter(adapter.id, 'reasoning', 'testing');

      const selection = manager.selectForPhase('planning', 'testing', trainer);
      expect(selection.category).toBe('reasoning');
      expect(selection.adapter).not.toBeNull();
      expect(selection.adapter!.id).toBe(adapter.id);
    });

    it('falls back to any active adapter when disentangled disabled', () => {
      const manager = createAdapterManager({ enabled: false });
      const trainer = makeLoraTrainer();

      const adapter = trainer.createAdapter('testing', 10);
      trainer.recordEvaluation(adapter.id, 0.5, 0.6);

      const selection = manager.selectForPhase('execution', 'testing', trainer);
      expect(selection.adapter).not.toBeNull();
      expect(selection.reason).toContain('Disentangled mode disabled');
    });

    it('returns null when no adapter available', () => {
      const manager = createAdapterManager();
      const trainer = makeLoraTrainer();

      const selection = manager.selectForPhase('planning', 'testing', trainer);
      expect(selection.adapter).toBeNull();
    });
  });

  // ── Summary ──────────────────────────────────────────────────────────

  describe('buildSummary', () => {
    it('includes enabled status', () => {
      const manager = createAdapterManager({ enabled: true });
      expect(manager.buildSummary()).toContain('enabled');
    });

    it('includes disabled status', () => {
      const manager = createAdapterManager({ enabled: false });
      expect(manager.buildSummary()).toContain('disabled');
    });

    it('lists registered adapters by skill', () => {
      const manager = createAdapterManager();
      manager.registerAdapter('adapter-r', 'reasoning', 'testing');
      manager.registerAdapter('adapter-t', 'tools', 'testing');

      const summary = manager.buildSummary();
      expect(summary).toContain('testing');
      expect(summary).toContain('adapter-r');
      expect(summary).toContain('adapter-t');
    });
  });
});
