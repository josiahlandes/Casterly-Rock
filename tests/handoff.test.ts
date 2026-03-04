import { describe, expect, it } from 'vitest';
import {
  buildHandoffSnapshot,
  serializeHandoff,
  parseHandoff,
} from '../src/dual-loop/handoff.js';
import type { PlanStep, TaskArtifact, FileOperation } from '../src/dual-loop/task-board-types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeSteps(): PlanStep[] {
  return [
    { description: 'Create player module', status: 'done', output: 'Created player.ts with Player class' },
    { description: 'Create enemy grid', status: 'done', output: 'Created enemy-grid.ts with 5x4 formation' },
    { description: 'Add collision detection', status: 'pending' },
    { description: 'Wire up game loop', status: 'pending' },
  ];
}

function makeArtifacts(): TaskArtifact[] {
  return [
    { type: 'file_created', path: 'src/player.ts', content: 'export class Player {}', timestamp: '2026-03-04T10:00:00Z' },
    { type: 'test_result', path: 'tests/player.test.ts', content: '3 passed, 1 failed', timestamp: '2026-03-04T10:01:00Z' },
  ];
}

function makeManifest(): FileOperation[] {
  return [
    { path: 'src/player.ts', action: 'created', lines: 45, exports: ['Player', 'PlayerConfig'] },
    { path: 'src/enemy-grid.ts', action: 'created', lines: 80 },
    { path: 'src/index.ts', action: 'modified', lines: 12 },
  ];
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('Handoff', () => {
  describe('buildHandoffSnapshot', () => {
    it('builds snapshot from task state', () => {
      const snapshot = buildHandoffSnapshot({
        steps: makeSteps(),
        artifacts: makeArtifacts(),
        manifest: makeManifest(),
        decisions: [{ decision: 'Use ECS pattern', rationale: 'Better for collision detection' }],
        blockers: ['Missing sprite assets'],
        keyLearnings: ['Canvas API requires requestAnimationFrame for smooth rendering'],
      });

      expect(snapshot.stepsCompleted).toBe(2);
      expect(snapshot.totalSteps).toBe(4);
      expect(snapshot.filesModified).toHaveLength(3);
      expect(snapshot.filesModified[0]).toEqual({
        path: 'src/player.ts',
        operation: 'created',
        summary: 'Exports: Player, PlayerConfig',
      });
      expect(snapshot.filesModified[2]).toEqual({
        path: 'src/index.ts',
        operation: 'modified',
        summary: '12 lines',
      });
      expect(snapshot.decisionsMade).toHaveLength(1);
      expect(snapshot.blockersEncountered).toEqual(['Missing sprite assets']);
      expect(snapshot.nextSteps).toEqual(['Add collision detection', 'Wire up game loop']);
      expect(snapshot.keyLearnings).toHaveLength(1);
      expect(snapshot.testResults).toHaveLength(1);
      expect(snapshot.testResults[0]!.passed).toBe(3);
      expect(snapshot.testResults[0]!.failed).toBe(1);
    });

    it('handles empty state', () => {
      const snapshot = buildHandoffSnapshot({
        steps: [],
        artifacts: [],
        manifest: [],
      });

      expect(snapshot.stepsCompleted).toBe(0);
      expect(snapshot.totalSteps).toBe(0);
      expect(snapshot.filesModified).toHaveLength(0);
      expect(snapshot.nextSteps).toHaveLength(0);
    });
  });

  describe('serializeHandoff / parseHandoff roundtrip', () => {
    it('roundtrips a full snapshot', () => {
      const original = buildHandoffSnapshot({
        steps: makeSteps(),
        artifacts: makeArtifacts(),
        manifest: makeManifest(),
        decisions: [{ decision: 'Use ECS pattern', rationale: 'Better for collision detection' }],
        blockers: ['Missing sprite assets'],
        keyLearnings: ['Canvas API requires requestAnimationFrame'],
      });

      const xml = serializeHandoff(original);
      const parsed = parseHandoff(xml);

      expect(parsed).not.toBeNull();
      expect(parsed!.stepsCompleted).toBe(original.stepsCompleted);
      expect(parsed!.totalSteps).toBe(original.totalSteps);
      expect(parsed!.filesModified).toEqual(original.filesModified);
      expect(parsed!.decisionsMade).toEqual(original.decisionsMade);
      expect(parsed!.blockersEncountered).toEqual(original.blockersEncountered);
      expect(parsed!.nextSteps).toEqual(original.nextSteps);
      expect(parsed!.keyLearnings).toEqual(original.keyLearnings);
      expect(parsed!.testResults).toEqual(original.testResults);
    });

    it('roundtrips an empty snapshot', () => {
      const original = buildHandoffSnapshot({ steps: [], artifacts: [], manifest: [] });
      const xml = serializeHandoff(original);
      const parsed = parseHandoff(xml);

      expect(parsed).not.toBeNull();
      expect(parsed!.stepsCompleted).toBe(0);
      expect(parsed!.filesModified).toHaveLength(0);
    });

    it('handles XML special characters', () => {
      const original = buildHandoffSnapshot({
        steps: [],
        artifacts: [],
        manifest: [{ path: 'src/a&b<c>.ts', action: 'created', lines: 10 }],
        decisions: [{ decision: 'Use "generic" <T> types', rationale: 'Better type safety & inference' }],
      });

      const xml = serializeHandoff(original);
      expect(xml).toContain('&amp;');
      expect(xml).toContain('&lt;');

      const parsed = parseHandoff(xml);
      expect(parsed).not.toBeNull();
      expect(parsed!.filesModified[0]!.path).toBe('src/a&b<c>.ts');
      expect(parsed!.decisionsMade[0]!.decision).toBe('Use "generic" <T> types');
      expect(parsed!.decisionsMade[0]!.rationale).toBe('Better type safety & inference');
    });
  });

  describe('parseHandoff', () => {
    it('returns null for non-snapshot XML', () => {
      expect(parseHandoff('not xml at all')).toBeNull();
      expect(parseHandoff('<other_tag>content</other_tag>')).toBeNull();
    });

    it('parses snapshot embedded in other text', () => {
      const xml = serializeHandoff(buildHandoffSnapshot({
        steps: makeSteps(),
        artifacts: [],
        manifest: [],
      }));
      const wrapped = `Some preamble text\n\n${xml}\n\nSome trailing text`;
      const parsed = parseHandoff(wrapped);

      expect(parsed).not.toBeNull();
      expect(parsed!.stepsCompleted).toBe(2);
      expect(parsed!.nextSteps).toHaveLength(2);
    });
  });

  describe('serializeHandoff', () => {
    it('produces valid XML structure', () => {
      const snapshot = buildHandoffSnapshot({
        steps: makeSteps(),
        artifacts: makeArtifacts(),
        manifest: makeManifest(),
        decisions: [{ decision: 'Use ECS', rationale: 'Scalable' }],
        blockers: ['Blocked on assets'],
        keyLearnings: ['Learned X'],
      });

      const xml = serializeHandoff(snapshot);

      expect(xml).toMatch(/^<state_snapshot>/);
      expect(xml).toMatch(/<\/state_snapshot>$/);
      expect(xml).toContain('<progress completed="2" total="4" />');
      expect(xml).toContain('<files_modified>');
      expect(xml).toContain('<decisions>');
      expect(xml).toContain('<blockers>');
      expect(xml).toContain('<next_steps>');
      expect(xml).toContain('<key_learnings>');
      expect(xml).toContain('<test_results>');
    });

    it('omits empty sections', () => {
      const snapshot = buildHandoffSnapshot({ steps: [], artifacts: [], manifest: [] });
      const xml = serializeHandoff(snapshot);

      expect(xml).not.toContain('<files_modified>');
      expect(xml).not.toContain('<decisions>');
      expect(xml).not.toContain('<blockers>');
      expect(xml).not.toContain('<next_steps>');
      expect(xml).not.toContain('<key_learnings>');
      expect(xml).not.toContain('<test_results>');
    });
  });
});
