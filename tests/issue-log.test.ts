import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { IssueLog } from '../src/autonomous/issue-log.js';
import { resetTracer, initTracer } from '../src/autonomous/debug.js';

describe('IssueLog', () => {
  let tempDir: string;
  let issueLog: IssueLog;

  beforeEach(async () => {
    resetTracer();
    initTracer({ enabled: false });
    tempDir = await mkdtemp(join(tmpdir(), 'casterly-test-issues-'));
    issueLog = new IssueLog({
      path: join(tempDir, 'issues.yaml'),
      maxOpenIssues: 10,
      maxTotalIssues: 30,
      staleDays: 7,
    });
  });

  afterEach(async () => {
    resetTracer();
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('persistence', () => {
    it('initializes fresh when no file exists', async () => {
      await issueLog.load();
      const data = issueLog.getData();

      expect(data.version).toBe(1);
      expect(data.nextId).toBe(1);
      expect(data.issues).toHaveLength(0);
    });

    it('round-trips through save and load', async () => {
      await issueLog.load();

      issueLog.fileIssue({
        title: 'Test issue',
        description: 'A test issue',
        priority: 'medium',
        discoveredBy: 'autonomous',
      });

      await issueLog.save();

      const issueLog2 = new IssueLog({
        path: join(tempDir, 'issues.yaml'),
      });
      await issueLog2.load();

      const data = issueLog2.getData();
      expect(data.issues).toHaveLength(1);
      expect(data.issues[0]?.title).toBe('Test issue');
    });
  });

  describe('issue creation', () => {
    beforeEach(async () => {
      await issueLog.load();
    });

    it('creates issues with auto-generated IDs', () => {
      const issue1 = issueLog.fileIssue({
        title: 'First issue',
        description: 'Description 1',
        priority: 'medium',
        discoveredBy: 'autonomous',
      });

      const issue2 = issueLog.fileIssue({
        title: 'Second issue',
        description: 'Description 2',
        priority: 'low',
        discoveredBy: 'test-failure',
      });

      expect(issue1.id).toBe('ISS-001');
      expect(issue2.id).toBe('ISS-002');
    });

    it('stores all provided fields', () => {
      const issue = issueLog.fileIssue({
        title: 'Full issue',
        description: 'Detailed description',
        priority: 'high',
        relatedFiles: ['src/foo.ts', 'src/bar.ts'],
        tags: ['test', 'flaky'],
        discoveredBy: 'test-failure',
        nextIdea: 'Try anchoring the regex',
      });

      expect(issue.title).toBe('Full issue');
      expect(issue.description).toBe('Detailed description');
      expect(issue.priority).toBe('high');
      expect(issue.relatedFiles).toEqual(['src/foo.ts', 'src/bar.ts']);
      expect(issue.tags).toEqual(['test', 'flaky']);
      expect(issue.discoveredBy).toBe('test-failure');
      expect(issue.nextIdea).toBe('Try anchoring the regex');
      expect(issue.status).toBe('open');
      expect(issue.attempts).toHaveLength(0);
      expect(issue.resolution).toBe('');
    });

    it('deduplicates by title — updates existing instead of creating new', () => {
      const first = issueLog.fileIssue({
        title: 'Duplicate issue',
        description: 'First description',
        priority: 'low',
        discoveredBy: 'autonomous',
      });

      const second = issueLog.fileIssue({
        title: 'Duplicate issue',
        description: 'Updated description',
        priority: 'high', // Higher priority
        discoveredBy: 'autonomous',
        relatedFiles: ['new-file.ts'],
      });

      // Should return the same issue, not a new one
      expect(second.id).toBe(first.id);
      expect(issueLog.getData().issues).toHaveLength(1);

      // Priority should be escalated to the higher value
      expect(second.priority).toBe('high');

      // Description should be updated
      expect(second.description).toBe('Updated description');

      // Related files should be merged
      expect(second.relatedFiles).toContain('new-file.ts');
    });

    it('does not deduplicate against resolved issues', () => {
      const first = issueLog.fileIssue({
        title: 'Reoccurring issue',
        description: 'First occurrence',
        priority: 'medium',
        discoveredBy: 'autonomous',
      });

      issueLog.resolveIssue(first.id, 'resolved', 'Fixed');

      const second = issueLog.fileIssue({
        title: 'Reoccurring issue',
        description: 'Second occurrence',
        priority: 'medium',
        discoveredBy: 'autonomous',
      });

      expect(second.id).not.toBe(first.id);
      expect(issueLog.getData().issues).toHaveLength(2);
    });
  });

  describe('issue queries', () => {
    beforeEach(async () => {
      await issueLog.load();
      issueLog.fileIssue({
        title: 'Critical bug',
        description: 'Very bad',
        priority: 'critical',
        relatedFiles: ['src/security/detector.ts'],
        tags: ['security'],
        discoveredBy: 'autonomous',
      });
      issueLog.fileIssue({
        title: 'Flaky test',
        description: 'Sometimes fails',
        priority: 'medium',
        relatedFiles: ['tests/detector.test.ts'],
        tags: ['test', 'flaky'],
        discoveredBy: 'test-failure',
      });
      issueLog.fileIssue({
        title: 'Minor cleanup',
        description: 'Remove dead code',
        priority: 'low',
        tags: ['maintenance'],
        discoveredBy: 'dream-cycle',
      });
    });

    it('getOpenIssues returns issues sorted by priority', () => {
      const open = issueLog.getOpenIssues();

      expect(open).toHaveLength(3);
      expect(open[0]?.priority).toBe('critical');
      expect(open[1]?.priority).toBe('medium');
      expect(open[2]?.priority).toBe('low');
    });

    it('getIssuesByFile finds issues related to a file', () => {
      const issues = issueLog.getIssuesByFile('src/security/detector.ts');

      expect(issues).toHaveLength(1);
      expect(issues[0]?.title).toBe('Critical bug');
    });

    it('getIssuesByTag filters by tag', () => {
      const flaky = issueLog.getIssuesByTag('flaky');

      expect(flaky).toHaveLength(1);
      expect(flaky[0]?.title).toBe('Flaky test');
    });

    it('getIssue returns undefined for unknown ID', () => {
      expect(issueLog.getIssue('ISS-999')).toBeUndefined();
    });
  });

  describe('attempt recording', () => {
    beforeEach(async () => {
      await issueLog.load();
      issueLog.fileIssue({
        title: 'Test issue',
        description: 'Needs fixing',
        priority: 'medium',
        discoveredBy: 'autonomous',
      });
    });

    it('records attempts with full details', () => {
      issueLog.recordAttempt('ISS-001', {
        approach: 'Changed regex quantifier',
        outcome: 'failure',
        details: 'Still fails on Unicode input',
        filesModified: ['src/security/patterns.ts'],
        branch: 'auto/fix-regex',
        commitHash: 'abc123',
      });

      const issue = issueLog.getIssue('ISS-001');
      expect(issue?.attempts).toHaveLength(1);
      expect(issue?.attempts[0]?.approach).toBe('Changed regex quantifier');
      expect(issue?.attempts[0]?.outcome).toBe('failure');
      expect(issue?.attempts[0]?.filesModified).toEqual(['src/security/patterns.ts']);
      expect(issue?.attempts[0]?.branch).toBe('auto/fix-regex');
    });

    it('auto-transitions from open to investigating on first attempt', () => {
      expect(issueLog.getIssue('ISS-001')?.status).toBe('open');

      issueLog.recordAttempt('ISS-001', {
        approach: 'First try',
        outcome: 'failure',
        details: 'Did not work',
        filesModified: [],
      });

      expect(issueLog.getIssue('ISS-001')?.status).toBe('investigating');
    });

    it('accumulates multiple attempts', () => {
      issueLog.recordAttempt('ISS-001', {
        approach: 'Try 1',
        outcome: 'failure',
        details: 'Nope',
        filesModified: [],
      });
      issueLog.recordAttempt('ISS-001', {
        approach: 'Try 2',
        outcome: 'partial',
        details: 'Getting closer',
        filesModified: ['src/foo.ts'],
      });
      issueLog.recordAttempt('ISS-001', {
        approach: 'Try 3',
        outcome: 'success',
        details: 'Fixed!',
        filesModified: ['src/foo.ts'],
      });

      const issue = issueLog.getIssue('ISS-001');
      expect(issue?.attempts).toHaveLength(3);
    });

    it('returns false for unknown issue ID', () => {
      expect(issueLog.recordAttempt('ISS-999', {
        approach: 'test',
        outcome: 'failure',
        details: '',
        filesModified: [],
      })).toBe(false);
    });
  });

  describe('issue resolution', () => {
    beforeEach(async () => {
      await issueLog.load();
      issueLog.fileIssue({
        title: 'Resolvable issue',
        description: 'Can be fixed',
        priority: 'medium',
        discoveredBy: 'autonomous',
      });
    });

    it('resolves issues with resolution notes', () => {
      issueLog.resolveIssue('ISS-001', 'resolved', 'Fixed by anchoring the regex');

      const issue = issueLog.getIssue('ISS-001');
      expect(issue?.status).toBe('resolved');
      expect(issue?.resolution).toBe('Fixed by anchoring the regex');
    });

    it('marks issues as wontfix', () => {
      issueLog.resolveIssue('ISS-001', 'wontfix', 'Not a real problem');

      const issue = issueLog.getIssue('ISS-001');
      expect(issue?.status).toBe('wontfix');
    });

    it('resolved issues are excluded from getOpenIssues', () => {
      issueLog.resolveIssue('ISS-001', 'resolved', 'Done');

      expect(issueLog.getOpenIssues()).toHaveLength(0);
    });

    it('getRecentlyResolved returns resolved issues', () => {
      issueLog.resolveIssue('ISS-001', 'resolved', 'Done');

      const recent = issueLog.getRecentlyResolved();
      expect(recent).toHaveLength(1);
      expect(recent[0]?.id).toBe('ISS-001');
    });
  });

  describe('stale issue detection', () => {
    beforeEach(async () => {
      await issueLog.load();
    });

    it('detects issues with no recent activity', () => {
      const issue = issueLog.fileIssue({
        title: 'Stale issue',
        description: 'Old',
        priority: 'low',
        discoveredBy: 'autonomous',
      });

      // Manually backdate
      const staleDate = new Date();
      staleDate.setDate(staleDate.getDate() - 10);
      issue.lastUpdated = staleDate.toISOString();

      const stale = issueLog.getStaleIssues();
      expect(stale).toHaveLength(1);
    });

    it('does not flag recently updated issues', () => {
      issueLog.fileIssue({
        title: 'Fresh issue',
        description: 'New',
        priority: 'low',
        discoveredBy: 'autonomous',
      });

      expect(issueLog.getStaleIssues()).toHaveLength(0);
    });
  });

  describe('priority management', () => {
    beforeEach(async () => {
      await issueLog.load();
      issueLog.fileIssue({
        title: 'Test issue',
        description: 'Test',
        priority: 'low',
        discoveredBy: 'autonomous',
      });
    });

    it('updatePriority changes issue priority', () => {
      issueLog.updatePriority('ISS-001', 'critical');
      expect(issueLog.getIssue('ISS-001')?.priority).toBe('critical');
    });

    it('returns false for unknown ID', () => {
      expect(issueLog.updatePriority('ISS-999', 'high')).toBe(false);
    });
  });

  describe('goal linking', () => {
    beforeEach(async () => {
      await issueLog.load();
      issueLog.fileIssue({
        title: 'Linked issue',
        description: 'Has a goal',
        priority: 'medium',
        discoveredBy: 'autonomous',
      });
    });

    it('links a goal to an issue', () => {
      issueLog.linkGoal('ISS-001', 'goal-005');
      expect(issueLog.getIssue('ISS-001')?.goalId).toBe('goal-005');
    });
  });

  describe('next idea tracking', () => {
    beforeEach(async () => {
      await issueLog.load();
      issueLog.fileIssue({
        title: 'Tricky bug',
        description: 'Hard to fix',
        priority: 'high',
        discoveredBy: 'autonomous',
      });
    });

    it('updateNextIdea records what to try next', () => {
      issueLog.updateNextIdea('ISS-001', 'Try using a different encoding');
      expect(issueLog.getIssue('ISS-001')?.nextIdea).toBe('Try using a different encoding');
    });
  });

  describe('summary', () => {
    beforeEach(async () => {
      await issueLog.load();
      issueLog.fileIssue({
        title: 'Active investigation',
        description: 'Looking into it',
        priority: 'high',
        discoveredBy: 'autonomous',
      });
      issueLog.recordAttempt('ISS-001', {
        approach: 'First try',
        outcome: 'failure',
        details: 'Did not work',
        filesModified: [],
      });
      issueLog.updateNextIdea('ISS-001', 'Try anchoring regex');

      issueLog.fileIssue({
        title: 'Open bug',
        description: 'Not started',
        priority: 'low',
        discoveredBy: 'autonomous',
      });
    });

    it('getSummary returns structured overview', () => {
      const summary = issueLog.getSummary();

      expect(summary.totalOpen).toBe(2);
      expect(summary.investigating).toHaveLength(1);
      expect(summary.investigating[0]?.title).toBe('Active investigation');
    });

    it('getSummaryText returns readable text', () => {
      const text = issueLog.getSummaryText();

      expect(text).toContain('Issues');
      expect(text).toContain('Active investigation');
      expect(text).toContain('Try anchoring regex');
      expect(text).toContain('Open bug');
    });

    it('getMostAttempted identifies stubborn issues', () => {
      // Add more attempts
      issueLog.recordAttempt('ISS-001', {
        approach: 'Second try',
        outcome: 'failure',
        details: 'Still broken',
        filesModified: [],
      });
      issueLog.recordAttempt('ISS-001', {
        approach: 'Third try',
        outcome: 'failure',
        details: 'Still broken',
        filesModified: [],
      });

      const mostAttempted = issueLog.getMostAttempted();
      expect(mostAttempted).toHaveLength(1);
      expect(mostAttempted[0]?.attempts).toHaveLength(3);
    });
  });
});
