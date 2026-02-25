import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { buildIdentityPrompt, buildMinimalIdentityPrompt } from '../src/autonomous/identity.js';
import type { SelfModelSummary } from '../src/autonomous/identity.js';
import { WorldModel } from '../src/autonomous/world-model.js';
import { GoalStack } from '../src/autonomous/goal-stack.js';
import { IssueLog } from '../src/autonomous/issue-log.js';
import { resetTracer, initTracer } from '../src/autonomous/debug.js';

describe('Identity Prompt', () => {
  let tempDir: string;

  beforeEach(async () => {
    resetTracer();
    initTracer({ enabled: false });
    tempDir = await mkdtemp(join(tmpdir(), 'casterly-test-identity-'));
  });

  afterEach(async () => {
    resetTracer();
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('buildMinimalIdentityPrompt', () => {
    it('returns the character prompt without any state', () => {
      const prompt = buildMinimalIdentityPrompt();

      expect(prompt).toContain('autonomous agent managing the Casterly codebase');
      expect(prompt).toContain('Think before acting');
      expect(prompt).toContain('Verify your own work');
    });
  });

  describe('buildIdentityPrompt', () => {
    it('returns character prompt when all sources are null', () => {
      const result = buildIdentityPrompt(null, null, null);

      expect(result.prompt).toContain('autonomous agent managing the Casterly codebase');
      expect(result.sections.character).toBe(true);
      expect(result.sections.worldModel).toBe(false);
      expect(result.sections.goalStack).toBe(false);
      expect(result.sections.issueLog).toBe(false);
      expect(result.sections.selfModel).toBe(false);
      expect(result.charCount).toBeGreaterThan(0);
      expect(result.generatedAt).toBeTruthy();
    });

    it('includes world model section when provided', async () => {
      const worldModel = new WorldModel({
        path: join(tempDir, 'world-model.yaml'),
        projectRoot: tempDir,
      });
      await worldModel.load();

      const result = buildIdentityPrompt(worldModel, null, null);

      expect(result.sections.worldModel).toBe(true);
      expect(result.prompt).toContain('Codebase Health');
    });

    it('includes goal stack section when provided', async () => {
      const goalStack = new GoalStack({
        path: join(tempDir, 'goals.yaml'),
      });
      await goalStack.load();

      goalStack.addGoal({
        source: 'user',
        description: 'Refactor the orchestrator',
      });

      const result = buildIdentityPrompt(null, goalStack, null);

      expect(result.sections.goalStack).toBe(true);
      expect(result.prompt).toContain('Your Goals');
      expect(result.prompt).toContain('Refactor the orchestrator');
    });

    it('includes issue log section when provided', async () => {
      const issueLog = new IssueLog({
        path: join(tempDir, 'issues.yaml'),
      });
      await issueLog.load();

      issueLog.fileIssue({
        title: 'Flaky detector test',
        description: 'Sometimes fails on CI',
        priority: 'medium',
        discoveredBy: 'test-failure',
      });

      const result = buildIdentityPrompt(null, null, issueLog);

      expect(result.sections.issueLog).toBe(true);
      expect(result.prompt).toContain('Known Issues');
      expect(result.prompt).toContain('Flaky detector test');
    });

    it('includes self-model section when provided', () => {
      const selfModel: SelfModelSummary = {
        strengths: [
          { skill: 'TypeScript type fixes', successRate: 0.9, sampleSize: 16 },
        ],
        weaknesses: [
          { skill: 'Complex regex', successRate: 0.4, sampleSize: 5 },
        ],
        preferences: [
          'Always run tests before committing',
        ],
      };

      const result = buildIdentityPrompt(null, null, null, selfModel);

      expect(result.sections.selfModel).toBe(true);
      expect(result.prompt).toContain('Self-Assessment');
      expect(result.prompt).toContain('TypeScript type fixes');
      expect(result.prompt).toContain('90%');
      expect(result.prompt).toContain('Complex regex');
      expect(result.prompt).toContain('40%');
      expect(result.prompt).toContain('Always run tests');
    });

    it('combines all sections when all sources provided', async () => {
      const worldModel = new WorldModel({
        path: join(tempDir, 'world-model.yaml'),
        projectRoot: tempDir,
      });
      await worldModel.load();

      const goalStack = new GoalStack({ path: join(tempDir, 'goals.yaml') });
      await goalStack.load();
      goalStack.addGoal({ source: 'user', description: 'Test goal' });

      const issueLog = new IssueLog({ path: join(tempDir, 'issues.yaml') });
      await issueLog.load();
      issueLog.fileIssue({
        title: 'Test issue',
        description: 'Test',
        priority: 'low',
        discoveredBy: 'autonomous',
      });

      const selfModel: SelfModelSummary = {
        strengths: [{ skill: 'Testing', successRate: 0.95, sampleSize: 20 }],
        weaknesses: [],
        preferences: [],
      };

      const result = buildIdentityPrompt(worldModel, goalStack, issueLog, selfModel);

      expect(result.sections.character).toBe(true);
      expect(result.sections.worldModel).toBe(true);
      expect(result.sections.goalStack).toBe(true);
      expect(result.sections.issueLog).toBe(true);
      expect(result.sections.selfModel).toBe(true);
    });

    it('respects maxChars budget by dropping sections', async () => {
      const goalStack = new GoalStack({ path: join(tempDir, 'goals.yaml') });
      await goalStack.load();

      // Add many goals to make the section large
      for (let i = 0; i < 20; i++) {
        goalStack.addGoal({
          source: 'self',
          description: `Goal number ${i} with a reasonably long description to take up space`,
        });
      }

      const issueLog = new IssueLog({ path: join(tempDir, 'issues.yaml') });
      await issueLog.load();
      for (let i = 0; i < 20; i++) {
        issueLog.fileIssue({
          title: `Issue ${i} with a long title`,
          description: `Description for issue ${i}`,
          priority: 'low',
          discoveredBy: 'autonomous',
        });
      }

      // Set a very tight budget
      const result = buildIdentityPrompt(null, goalStack, issueLog, null, null, null, {
        maxChars: 2000,
      });

      // Character prompt alone is ~900 chars, so some sections may be dropped
      expect(result.charCount).toBeLessThanOrEqual(2100); // Some tolerance
    });

    it('handles empty self-model gracefully', () => {
      const emptySelfModel: SelfModelSummary = {
        strengths: [],
        weaknesses: [],
        preferences: [],
      };

      const result = buildIdentityPrompt(null, null, null, emptySelfModel);

      expect(result.sections.selfModel).toBe(true);
      expect(result.prompt).toContain('not yet calibrated');
    });
  });
});
