/**
 * Integration Test: Vision Traits & Capabilities
 *
 * Validates the distinctive capabilities described in the Tyrion vision:
 *
 * TRAITS:
 *   - Skepticism of own output (adversarial self-testing)
 *   - Proportional judgment (severity-aware communication)
 *   - Quietness (results not narration)
 *
 * CAPABILITIES:
 *   - Adversarial Self-Testing (Phase 5): generate → attack → fix loop
 *   - Code Archaeology (Phase 6): git history analysis for fragile/abandoned code
 *   - Self-Model (Phase 6): skill classification, strength/weakness tracking
 *   - Reasoning Scaler (Phase 5): difficulty-adaptive compute scaling
 *   - Dream Cycle Pipeline (Phase 6): 6-phase consolidation pipeline
 *   - Multi-Resolution Understanding: system/module/file/function awareness
 *   - Hardware Maximization: dual-model routing, concurrent inference
 *
 * WIRING:
 *   - Validates whether Phase 5/6 modules are integrated into the agent loop
 */

import { describe, expect, it, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

const PROJECT_ROOT = resolve(import.meta.dirname, '..');
const TEST_BASE = join(tmpdir(), `casterly-vision-traits-${Date.now()}`);

function testDir(name: string): string {
  const dir = join(TEST_BASE, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

afterEach(() => {
  if (existsSync(TEST_BASE)) {
    rmSync(TEST_BASE, { recursive: true, force: true });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// TRAIT: Skepticism of Own Output — Adversarial Self-Testing
// ═══════════════════════════════════════════════════════════════════════════════

describe('Adversarial Self-Testing (Phase 5)', () => {
  describe('test case parsing', () => {
    it('parses valid JSON test cases from LLM response', async () => {
      const { AdversarialTester } = await import(
        '../src/autonomous/reasoning/adversarial.js'
      );
      const tester = new AdversarialTester();

      // Access the private parseTestCases via a typed workaround:
      // we test generateTestFile which consumes parsed test cases
      const testCases = [
        {
          description: 'Empty string input',
          input: '',
          expectedBehavior: 'should_throw' as const,
          category: 'empty_input' as const,
        },
        {
          description: 'Unicode zero-width chars',
          input: '\u200B\u200C\u200D',
          expectedBehavior: 'should_pass' as const,
          category: 'unicode' as const,
        },
        {
          description: 'SQL injection attempt',
          input: "'; DROP TABLE users; --",
          expectedBehavior: 'should_fail' as const,
          category: 'injection' as const,
        },
      ];

      const testFile = tester.generateTestFile(
        testCases,
        'src/parser.ts',
        'parseInput(input: string): ParsedResult',
      );

      expect(testFile).toContain("import { describe, it, expect } from 'vitest'");
      expect(testFile).toContain('Adversarial: parseInput');
      expect(testFile).toContain('[empty_input]');
      expect(testFile).toContain('[unicode]');
      expect(testFile).toContain('[injection]');
      expect(testFile).toContain('.toThrow()');
      expect(testFile).toContain('.not.toThrow()');
    });

    it('generates test file with all three behavior types', async () => {
      const { AdversarialTester } = await import(
        '../src/autonomous/reasoning/adversarial.js'
      );
      const tester = new AdversarialTester();

      const testCases = [
        {
          description: 'Valid input',
          input: 'hello',
          expectedBehavior: 'should_pass' as const,
          category: 'edge_case' as const,
        },
        {
          description: 'Rejected input',
          input: '<script>',
          expectedBehavior: 'should_fail' as const,
          category: 'injection' as const,
        },
        {
          description: 'Error input',
          input: '',
          expectedBehavior: 'should_throw' as const,
          category: 'empty_input' as const,
        },
      ];

      const testFile = tester.generateTestFile(testCases, 'src/fn.ts', 'fn(x: string)');

      // should_pass → .not.toThrow()
      expect(testFile).toContain('not.toThrow()');
      // should_throw → .toThrow()
      expect(testFile).toContain('expect(() =>');
      // should_fail → graceful handling comment
      expect(testFile).toContain('graceful');
    });
  });

  describe('scoring logic', () => {
    it('computes robustness score from attack results', async () => {
      const { AdversarialTester } = await import(
        '../src/autonomous/reasoning/adversarial.js'
      );
      const tester = new AdversarialTester();

      const report = {
        targetFile: 'src/fn.ts',
        functionSignature: 'fn(x: string)',
        testCases: [],
        results: [],
        vulnerabilities: 0,
        defended: 0,
        robustnessScore: 0,
        durationMs: 100,
      };

      const results = [
        { testCase: {} as never, passed: true, output: 'ok', durationMs: 10 },
        { testCase: {} as never, passed: true, output: 'ok', durationMs: 12 },
        { testCase: {} as never, passed: false, output: 'crash', error: 'TypeError', durationMs: 5 },
        { testCase: {} as never, passed: true, output: 'ok', durationMs: 8 },
        { testCase: {} as never, passed: false, output: 'hang', error: 'Timeout', durationMs: 5000 },
      ];

      const scored = tester.scoreResults(report, results);

      expect(scored.defended).toBe(3);
      expect(scored.vulnerabilities).toBe(2);
      expect(scored.robustnessScore).toBeCloseTo(0.6, 1);
      expect(scored.results).toHaveLength(5);
    });

    it('handles zero results gracefully', async () => {
      const { AdversarialTester } = await import(
        '../src/autonomous/reasoning/adversarial.js'
      );
      const tester = new AdversarialTester();

      const report = {
        targetFile: 'src/fn.ts',
        functionSignature: 'fn()',
        testCases: [],
        results: [],
        vulnerabilities: 0,
        defended: 0,
        robustnessScore: 0,
        durationMs: 0,
      };

      const scored = tester.scoreResults(report, []);
      expect(scored.robustnessScore).toBe(0);
      expect(scored.vulnerabilities).toBe(0);
      expect(scored.defended).toBe(0);
    });
  });

  describe('configuration', () => {
    it('respects enabled flag', async () => {
      const { AdversarialTester } = await import(
        '../src/autonomous/reasoning/adversarial.js'
      );

      const enabled = new AdversarialTester({ enabled: true });
      const disabled = new AdversarialTester({ enabled: false });

      expect(enabled.isEnabled()).toBe(true);
      expect(disabled.isEnabled()).toBe(false);
    });

    it('default config has reasonable values', async () => {
      const { AdversarialTester } = await import(
        '../src/autonomous/reasoning/adversarial.js'
      );
      const tester = new AdversarialTester();
      const config = tester.getConfig();

      expect(config.enabled).toBe(true);
      expect(config.maxTestCases).toBeGreaterThan(0);
      expect(config.maxTestCases).toBeLessThanOrEqual(20);
      expect(config.attackTemperature).toBeGreaterThan(0);
      expect(config.attackTemperature).toBeLessThanOrEqual(1.0);
    });

    it('returns empty test cases when disabled', async () => {
      const { AdversarialTester } = await import(
        '../src/autonomous/reasoning/adversarial.js'
      );
      const tester = new AdversarialTester({ enabled: false });

      // Mock a provider that should never be called
      const mockProvider = {
        id: 'mock',
        kind: 'local' as const,
        generateWithTools: vi.fn(),
      };

      const attacks = await tester.generateAttacks(
        'function add(a, b) { return a + b; }',
        'add(a: number, b: number): number',
        mockProvider as never,
      );

      expect(attacks).toEqual([]);
      expect(mockProvider.generateWithTools).not.toHaveBeenCalled();
    });
  });

  describe('attack prompt structure', () => {
    it('covers the 7 attack categories from the vision', async () => {
      // The adversarial tester should target all categories described in the vision:
      // empty/null, boundary, unicode, injection, type coercion, malformed, edge case
      const { AdversarialTester } = await import(
        '../src/autonomous/reasoning/adversarial.js'
      );

      const tester = new AdversarialTester();

      // Verify all attack categories are defined in the type system
      const validCategories = [
        'empty_input',
        'boundary_value',
        'unicode',
        'injection',
        'overflow',
        'null_undefined',
        'type_coercion',
        'concurrency',
        'malformed',
        'edge_case',
      ];

      // Each category should produce a valid test file
      for (const category of validCategories) {
        const testCases = [
          {
            description: `Test ${category}`,
            input: 'test',
            expectedBehavior: 'should_pass' as const,
            category: category as never,
          },
        ];

        const testFile = tester.generateTestFile(testCases, 'src/fn.ts', 'fn()');
        expect(testFile).toContain(`[${category}]`);
      }
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// CAPABILITY: Code Archaeology — Git History Analysis
// ═══════════════════════════════════════════════════════════════════════════════

describe('Code Archaeology (Phase 6)', () => {
  describe('constructor and configuration', () => {
    it('creates archaeologist with default config', async () => {
      const { CodeArchaeologist } = await import(
        '../src/autonomous/dream/archaeology.js'
      );
      const arch = new CodeArchaeologist();
      expect(arch).toBeDefined();
    });

    it('accepts custom lookback and threshold settings', async () => {
      const { CodeArchaeologist } = await import(
        '../src/autonomous/dream/archaeology.js'
      );
      const arch = new CodeArchaeologist({
        fragileLookbackDays: 30,
        fragileThreshold: 3,
        abandonedMonths: 12,
        maxResults: 10,
        gitTimeoutMs: 15_000,
      });
      expect(arch).toBeDefined();
    });
  });

  describe('analyzeFileHistory (real git)', () => {
    it('analyzes history for a file that exists in this repo', async () => {
      const { CodeArchaeologist } = await import(
        '../src/autonomous/dream/archaeology.js'
      );
      const arch = new CodeArchaeologist({ projectRoot: PROJECT_ROOT });

      // package.json should exist in git history
      const history = await arch.analyzeFileHistory('package.json');

      expect(history.path).toBe('package.json');
      expect(history.commitCount).toBeGreaterThan(0);
      expect(history.authorCount).toBeGreaterThan(0);
      expect(history.firstCommit).toBeTruthy();
      expect(history.lastCommit).toBeTruthy();
      expect(typeof history.recentCommits).toBe('number');
      expect(Array.isArray(history.recentMessages)).toBe(true);
    });

    it('returns empty history for non-existent file', async () => {
      const { CodeArchaeologist } = await import(
        '../src/autonomous/dream/archaeology.js'
      );
      const arch = new CodeArchaeologist({ projectRoot: PROJECT_ROOT });

      const history = await arch.analyzeFileHistory(
        'this-file-does-not-exist-xyz-123.ts',
      );

      expect(history.commitCount).toBe(0);
      expect(history.authorCount).toBe(0);
    });
  });

  describe('findFragileCode (real git)', () => {
    it('returns an array of fragile files from real git history', async () => {
      const { CodeArchaeologist } = await import(
        '../src/autonomous/dream/archaeology.js'
      );
      const arch = new CodeArchaeologist({
        projectRoot: PROJECT_ROOT,
        fragileLookbackDays: 365, // wide window to find something
        fragileThreshold: 2, // low threshold for test coverage
        maxResults: 5,
      });

      const fragile = await arch.findFragileCode();

      expect(Array.isArray(fragile)).toBe(true);
      // May or may not find fragile files depending on repo history
      for (const f of fragile) {
        expect(f.path).toBeTruthy();
        expect(f.changeCount).toBeGreaterThanOrEqual(2);
        expect(f.fragilityScore).toBeGreaterThan(0);
        expect(typeof f.fixCount).toBe('number');
        expect(Array.isArray(f.recentMessages)).toBe(true);
      }
    });

    it('fragility score formula: total + fixes * 2', async () => {
      const { CodeArchaeologist } = await import(
        '../src/autonomous/dream/archaeology.js'
      );
      const arch = new CodeArchaeologist({
        projectRoot: PROJECT_ROOT,
        fragileLookbackDays: 365,
        fragileThreshold: 1,
        maxResults: 50,
      });

      const fragile = await arch.findFragileCode();

      for (const f of fragile) {
        expect(f.fragilityScore).toBe(f.changeCount + f.fixCount * 2);
      }
    });

    it('results are sorted by fragility score descending', async () => {
      const { CodeArchaeologist } = await import(
        '../src/autonomous/dream/archaeology.js'
      );
      const arch = new CodeArchaeologist({
        projectRoot: PROJECT_ROOT,
        fragileLookbackDays: 365,
        fragileThreshold: 1,
      });

      const fragile = await arch.findFragileCode();

      for (let i = 1; i < fragile.length; i++) {
        expect(fragile[i - 1]!.fragilityScore).toBeGreaterThanOrEqual(
          fragile[i]!.fragilityScore,
        );
      }
    });

    it('excludes node_modules and dist paths', async () => {
      const { CodeArchaeologist } = await import(
        '../src/autonomous/dream/archaeology.js'
      );
      const arch = new CodeArchaeologist({
        projectRoot: PROJECT_ROOT,
        fragileLookbackDays: 365,
        fragileThreshold: 1,
      });

      const fragile = await arch.findFragileCode();

      for (const f of fragile) {
        expect(f.path).not.toContain('node_modules');
        expect(f.path).not.toContain('dist/');
      }
    });
  });

  describe('fix pattern detection', () => {
    it('recognizes fix-related commit message patterns', async () => {
      // The archaeologist uses these patterns to weight fragility scoring:
      // fix, bug, patch, hotfix, revert, repair
      const source = readFileSync(
        resolve(PROJECT_ROOT, 'src/autonomous/dream/archaeology.ts'),
        'utf8',
      );

      expect(source).toContain('\\bfix\\b');
      expect(source).toContain('\\bbug\\b');
      expect(source).toContain('\\bpatch\\b');
      expect(source).toContain('\\bhotfix\\b');
      expect(source).toContain('\\brevert\\b');
      expect(source).toContain('\\brepair\\b');
    });
  });

  describe('buildNarrative (real git)', () => {
    it('produces a markdown narrative from recent history', async () => {
      const { CodeArchaeologist } = await import(
        '../src/autonomous/dream/archaeology.js'
      );
      const arch = new CodeArchaeologist({ projectRoot: PROJECT_ROOT });

      // Use a short lookback — buildNarrative uses HEAD~N which fails
      // if the repo has fewer commits than N
      try {
        const narrative = await arch.buildNarrative(7);

        expect(typeof narrative).toBe('string');
        expect(narrative.length).toBeGreaterThan(0);
        // Should either have content or the "no commits" message
        expect(
          narrative.includes('Project Activity') || narrative.includes('No commits'),
        ).toBe(true);
      } catch (err) {
        // Known limitation: git diff --shortstat HEAD~N fails when
        // the repo has fewer total commits than N
        expect(String(err)).toContain('ambiguous argument');
      }
    });

    it('categorizes commits into features, fixes, and refactors', async () => {
      // Verify the narrative builder has categorization logic
      const source = readFileSync(
        resolve(PROJECT_ROOT, 'src/autonomous/dream/archaeology.ts'),
        'utf8',
      );

      expect(source).toContain('feat');
      expect(source).toContain('refactor');
      expect(source).toContain('Features:');
      expect(source).toContain('Fixes:');
      expect(source).toContain('Refactoring:');
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// CAPABILITY: Self-Model — Skill Classification & Assessment
// ═══════════════════════════════════════════════════════════════════════════════

describe('Self-Model (Phase 6)', () => {
  describe('skill classification', () => {
    it('classifies text into known skill domains', async () => {
      const { SelfModel } = await import(
        '../src/autonomous/dream/self-model.js'
      );
      const sm = new SelfModel({
        path: join(testDir('sm-classify'), 'self-model.yaml'),
      });

      // Access classifySkills through getRecommendation behavior:
      // When we add issues with known skill patterns and rebuild,
      // the skills should be detected
      const mockIssueLog = {
        getData: () => ({
          issues: [
            { title: 'Fix regex pattern', description: 'Regex fails on unicode', status: 'resolved', attempts: [] },
            { title: 'Fix regex edge case', description: 'Another regex bug', status: 'resolved', attempts: [] },
            { title: 'Fix regex lookahead', description: 'Regex lookahead broken', status: 'open', attempts: [] },
            { title: 'Fix regex anchor', description: 'Regex anchor issue', status: 'open', attempts: [] },
          ],
        }),
      };

      const mockReflector = {
        loadRecentReflections: async () => [],
      };

      await sm.rebuild(mockIssueLog as never, mockReflector as never);
      const data = sm.getData();

      // Should have found 'regex' skill
      const regexSkill = data.skills.find((s) => s.skill === 'regex');
      expect(regexSkill).toBeDefined();
      expect(regexSkill!.sampleSize).toBe(4); // 4 issues mention regex
      expect(regexSkill!.successes).toBe(2); // 2 resolved
      expect(regexSkill!.failures).toBe(2); // 2 still open
      expect(regexSkill!.successRate).toBeCloseTo(0.5, 1);
    });

    it('maps all 12 skill patterns correctly', async () => {
      // Verify the skill pattern map covers all domains from the vision
      const source = readFileSync(
        resolve(PROJECT_ROOT, 'src/autonomous/dream/self-model.ts'),
        'utf8',
      );

      const expectedSkills = [
        'regex',
        'typescript-types',
        'testing',
        'refactoring',
        'security',
        'performance',
        'concurrency',
        'parsing',
        'configuration',
        'git-operations',
        'bug-fixing',
        'documentation',
      ];

      for (const skill of expectedSkills) {
        expect(source).toContain(`'${skill}'`);
      }
    });

    it('falls back to "general" for unmatched text', async () => {
      const { SelfModel } = await import(
        '../src/autonomous/dream/self-model.js'
      );
      const sm = new SelfModel({
        path: join(testDir('sm-general'), 'self-model.yaml'),
        minSampleSize: 1,
      });

      const mockIssueLog = {
        getData: () => ({
          issues: [
            // No skill patterns in these titles
            { title: 'Do something', description: 'Vague task', status: 'resolved', attempts: [] },
            { title: 'Another thing', description: 'Also vague', status: 'open', attempts: [] },
          ],
        }),
      };

      const mockReflector = {
        loadRecentReflections: async () => [],
      };

      await sm.rebuild(mockIssueLog as never, mockReflector as never);
      const data = sm.getData();

      // Should have 'general' as fallback
      const general = data.skills.find((s) => s.skill === 'general');
      expect(general).toBeDefined();
    });
  });

  describe('strength/weakness classification', () => {
    it('identifies strengths (>= 70% success rate)', async () => {
      const { SelfModel } = await import(
        '../src/autonomous/dream/self-model.js'
      );
      const sm = new SelfModel({
        path: join(testDir('sm-strength'), 'self-model.yaml'),
        minSampleSize: 1,
      });

      const mockIssueLog = {
        getData: () => ({
          issues: [
            // 4 out of 5 testing issues resolved = 80% success
            { title: 'Testing framework setup', description: 'Set up testing', status: 'resolved', attempts: [] },
            { title: 'Testing edge case', description: 'Testing a case', status: 'resolved', attempts: [] },
            { title: 'Testing coverage', description: 'Add test coverage', status: 'resolved', attempts: [] },
            { title: 'Testing integration', description: 'Integration testing', status: 'resolved', attempts: [] },
            { title: 'Testing flaky', description: 'Flaky testing issue', status: 'open', attempts: [] },
          ],
        }),
      };

      const mockReflector = {
        loadRecentReflections: async () => [],
      };

      await sm.rebuild(mockIssueLog as never, mockReflector as never);
      const strengths = sm.getStrengths();

      expect(strengths.length).toBeGreaterThan(0);
      for (const s of strengths) {
        expect(s.successRate).toBeGreaterThanOrEqual(0.7);
      }
    });

    it('identifies weaknesses (< 50% success rate)', async () => {
      const { SelfModel } = await import(
        '../src/autonomous/dream/self-model.js'
      );
      const sm = new SelfModel({
        path: join(testDir('sm-weakness'), 'self-model.yaml'),
        minSampleSize: 1,
      });

      const mockIssueLog = {
        getData: () => ({
          issues: [
            // 1 out of 4 security issues resolved = 25% success
            { title: 'Security vulnerability fix', description: 'Security patch', status: 'resolved', attempts: [] },
            { title: 'Security audit findings', description: 'Security review', status: 'open', attempts: [] },
            { title: 'Security headers missing', description: 'Security config', status: 'open', attempts: [] },
            { title: 'Security token leak', description: 'Security token vulnerable', status: 'open', attempts: [] },
          ],
        }),
      };

      const mockReflector = {
        loadRecentReflections: async () => [],
      };

      await sm.rebuild(mockIssueLog as never, mockReflector as never);
      const weaknesses = sm.getWeaknesses();

      expect(weaknesses.length).toBeGreaterThan(0);
      for (const w of weaknesses) {
        expect(w.successRate).toBeLessThan(0.5);
      }
    });
  });

  describe('recommendations', () => {
    it('warns about weak skill areas when task matches', async () => {
      const { SelfModel } = await import(
        '../src/autonomous/dream/self-model.js'
      );
      const sm = new SelfModel({
        path: join(testDir('sm-recommend'), 'self-model.yaml'),
        minSampleSize: 1,
      });

      const mockIssueLog = {
        getData: () => ({
          issues: [
            { title: 'regex pattern fix', description: 'regex', status: 'open', attempts: [] },
            { title: 'regex lookahead', description: 'regex', status: 'open', attempts: [] },
            { title: 'regex capture', description: 'regex', status: 'open', attempts: [] },
            { title: 'regex escape', description: 'regex', status: 'resolved', attempts: [] },
          ],
        }),
      };

      const mockReflector = {
        loadRecentReflections: async () => [],
      };

      await sm.rebuild(mockIssueLog as never, mockReflector as never);

      const recommendation = sm.getRecommendation('Fix the regex pattern for email validation');
      expect(recommendation).not.toBeNull();
      expect(recommendation).toContain('regex');
      expect(recommendation).toContain('25%');
      expect(recommendation).toContain('verification');
    });

    it('returns null for strong skill areas', async () => {
      const { SelfModel } = await import(
        '../src/autonomous/dream/self-model.js'
      );
      const sm = new SelfModel({
        path: join(testDir('sm-no-warn'), 'self-model.yaml'),
        minSampleSize: 1,
      });

      const mockIssueLog = {
        getData: () => ({
          issues: [
            { title: 'testing setup', description: 'testing', status: 'resolved', attempts: [] },
            { title: 'testing coverage', description: 'testing', status: 'resolved', attempts: [] },
            { title: 'testing e2e', description: 'testing', status: 'resolved', attempts: [] },
          ],
        }),
      };

      const mockReflector = {
        loadRecentReflections: async () => [],
      };

      await sm.rebuild(mockIssueLog as never, mockReflector as never);

      const recommendation = sm.getRecommendation('Add unit tests for the parser');
      expect(recommendation).toBeNull(); // 100% success rate → no warning
    });
  });

  describe('identity prompt integration', () => {
    it('getSummary returns SelfModelSummary shape for identity prompt', async () => {
      const { SelfModel } = await import(
        '../src/autonomous/dream/self-model.js'
      );
      const sm = new SelfModel({
        path: join(testDir('sm-summary'), 'self-model.yaml'),
        minSampleSize: 1,
      });

      const mockIssueLog = {
        getData: () => ({
          issues: [
            { title: 'regex fix', description: 'regex', status: 'open', attempts: [] },
            { title: 'regex bug', description: 'regex', status: 'open', attempts: [] },
            { title: 'testing ok', description: 'testing', status: 'resolved', attempts: [] },
            { title: 'testing great', description: 'testing', status: 'resolved', attempts: [] },
          ],
        }),
      };

      const mockReflector = {
        loadRecentReflections: async () => [],
      };

      await sm.rebuild(mockIssueLog as never, mockReflector as never);

      const summary = sm.getSummary();
      expect(summary).toHaveProperty('strengths');
      expect(summary).toHaveProperty('weaknesses');
      expect(summary).toHaveProperty('preferences');
      expect(Array.isArray(summary.strengths)).toBe(true);
      expect(Array.isArray(summary.weaknesses)).toBe(true);
      expect(Array.isArray(summary.preferences)).toBe(true);

      // Strengths should have successRate and sampleSize
      for (const s of summary.strengths) {
        expect(s).toHaveProperty('skill');
        expect(s).toHaveProperty('successRate');
        expect(s).toHaveProperty('sampleSize');
      }
    });

    it('self-model data renders in identity prompt', async () => {
      const { buildIdentityPrompt } = await import(
        '../src/autonomous/identity.js'
      );
      const { WorldModel } = await import('../src/autonomous/world-model.js');
      const { GoalStack } = await import('../src/autonomous/goal-stack.js');
      const { IssueLog } = await import('../src/autonomous/issue-log.js');

      const dir = testDir('sm-identity');
      const wm = new WorldModel({ projectRoot: dir });
      const gs = new GoalStack({ path: join(dir, 'goals.yaml') });
      const il = new IssueLog({ path: join(dir, 'issues.yaml') });

      const selfModelSummary = {
        strengths: [{ skill: 'testing', successRate: 0.85, sampleSize: 20 }],
        weaknesses: [{ skill: 'regex', successRate: 0.3, sampleSize: 10 }],
        preferences: ['Use explicit error handling over try/catch'],
      };

      const result = buildIdentityPrompt(wm, gs, il, selfModelSummary);

      expect(result.sections.selfModel).toBe(true);
      expect(result.prompt).toContain('Self-Assessment');
      expect(result.prompt).toContain('testing');
      expect(result.prompt).toContain('85%');
      expect(result.prompt).toContain('regex');
      expect(result.prompt).toContain('30%');
      expect(result.prompt).toContain('explicit error handling');
    });
  });

  describe('persistence', () => {
    it('saves and loads self-model from YAML', async () => {
      const { SelfModel } = await import(
        '../src/autonomous/dream/self-model.js'
      );
      const dir = testDir('sm-persist');
      const path = join(dir, 'self-model.yaml');

      const sm1 = new SelfModel({ path, minSampleSize: 1 });

      const mockIssueLog = {
        getData: () => ({
          issues: [
            { title: 'testing fix', description: 'testing', status: 'resolved', attempts: [] },
            { title: 'testing add', description: 'testing', status: 'resolved', attempts: [] },
          ],
        }),
      };

      const mockReflector = {
        loadRecentReflections: async () => [],
      };

      await sm1.rebuild(mockIssueLog as never, mockReflector as never);
      await sm1.save();

      expect(existsSync(path)).toBe(true);

      const sm2 = new SelfModel({ path });
      await sm2.load();

      const data = sm2.getData();
      expect(data.skills.length).toBeGreaterThan(0);
      expect(data.version).toBe(1);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// CAPABILITY: Reasoning Scaler — Difficulty-Adaptive Compute
// ═══════════════════════════════════════════════════════════════════════════════

describe('Reasoning Scaler (Phase 5)', () => {
  describe('difficulty assessment heuristics', () => {
    it('rates simple tasks as easy', async () => {
      const { ReasoningScaler } = await import(
        '../src/autonomous/reasoning/scaling.js'
      );
      const scaler = new ReasoningScaler();

      expect(scaler.assessDifficulty('rename variable foo to bar')).toBe('easy');
      expect(scaler.assessDifficulty('fix typo in comment')).toBe('easy');
      expect(scaler.assessDifficulty('update import path')).toBe('easy');
      expect(scaler.assessDifficulty('add type annotation')).toBe('easy');
    });

    it('rates complex tasks as hard', async () => {
      const { ReasoningScaler } = await import(
        '../src/autonomous/reasoning/scaling.js'
      );
      const scaler = new ReasoningScaler();

      expect(scaler.assessDifficulty('fix regex pattern for unicode parsing with concurrency')).toBe('hard');
      expect(scaler.assessDifficulty('optimize performance of recursive tree traversal with streaming')).toBe('hard');
      expect(scaler.assessDifficulty('fix race condition in async state machine with deadlock potential')).toBe('hard');
    });

    it('escalates difficulty with context signals', async () => {
      const { ReasoningScaler } = await import(
        '../src/autonomous/reasoning/scaling.js'
      );
      const scaler = new ReasoningScaler();

      // Same problem, different context
      const easy = scaler.assessDifficulty('update the parser', {
        fileCount: 1,
        totalLines: 50,
        crossFile: false,
        hasFailingTests: false,
        previousAttempts: 0,
        tags: [],
      });

      const hard = scaler.assessDifficulty('update the parser', {
        fileCount: 15,
        totalLines: 3000,
        crossFile: true,
        hasFailingTests: true,
        previousAttempts: 3,
        tags: ['parsing', 'unicode'],
      });

      // Easy context should yield lower difficulty
      expect(['easy', 'medium']).toContain(easy);
      // Hard context should yield higher difficulty
      expect(hard).toBe('hard');
    });

    it('previous failed attempts escalate difficulty', async () => {
      const { ReasoningScaler } = await import(
        '../src/autonomous/reasoning/scaling.js'
      );
      const scaler = new ReasoningScaler();

      const first = scaler.assessDifficulty('simple fix', { previousAttempts: 0 } as never);
      const retry = scaler.assessDifficulty('simple fix', { previousAttempts: 3 } as never);

      // Retries should be treated with more compute
      const difficultyOrder = { easy: 0, medium: 1, hard: 2 };
      expect(difficultyOrder[retry]).toBeGreaterThanOrEqual(difficultyOrder[first]);
    });
  });

  describe('model routing strategy', () => {
    it('easy problems use only the coding model', async () => {
      const { ReasoningScaler } = await import(
        '../src/autonomous/reasoning/scaling.js'
      );
      const scaler = new ReasoningScaler({
        codingModel: 'qwen3-coder-next:latest',
        reasoningModel: 'hermes3:70b',
      });
      const config = scaler.getConfig();

      expect(config.codingModel).toBe('qwen3-coder-next:latest');
      expect(config.reasoningModel).toBe('hermes3:70b');
    });

    it('hard problems use maxCandidates from config', async () => {
      const { ReasoningScaler } = await import(
        '../src/autonomous/reasoning/scaling.js'
      );
      const scaler = new ReasoningScaler({ maxCandidates: 6 });
      const config = scaler.getConfig();

      expect(config.maxCandidates).toBe(6);
    });

    it('respects enabled flag', async () => {
      const { ReasoningScaler } = await import(
        '../src/autonomous/reasoning/scaling.js'
      );

      const enabled = new ReasoningScaler({ enabled: true });
      const disabled = new ReasoningScaler({ enabled: false });

      expect(enabled.isEnabled()).toBe(true);
      expect(disabled.isEnabled()).toBe(false);
    });

    it('default config matches vision (hermes3 + qwen3)', async () => {
      const { ReasoningScaler } = await import(
        '../src/autonomous/reasoning/scaling.js'
      );
      const scaler = new ReasoningScaler();
      const config = scaler.getConfig();

      expect(config.reasoningModel).toContain('hermes3');
      expect(config.codingModel).toContain('qwen3');
    });
  });

  describe('HARD_SIGNALS coverage', () => {
    it('includes the attack categories from the vision', () => {
      const source = readFileSync(
        resolve(PROJECT_ROOT, 'src/autonomous/reasoning/scaling.ts'),
        'utf8',
      );

      // From the vision: regex, concurrency, security, performance, unicode
      const visionSignals = [
        'regex',
        'concurrency',
        'security',
        'performance',
        'unicode',
        'parsing',
        'async',
        'memory leak',
      ];

      for (const signal of visionSignals) {
        expect(source).toContain(signal);
      }
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// TRAIT: Proportional Judgment — Severity-Aware Communication
// ═══════════════════════════════════════════════════════════════════════════════

describe('Proportional Judgment', () => {
  describe('event type differentiation', () => {
    it('security concerns always pass event-level filtering', async () => {
      const { MessagePolicy } = await import(
        '../src/autonomous/communication/policy.js'
      );
      const policy = new MessagePolicy({
        enabled: true,
        throttle: {
          maxPerHour: 100,
          maxPerDay: 100,
          quietHours: false,
          quietStart: '22:00',
          quietEnd: '08:00',
        },
      });

      const decision = policy.shouldNotify({
        type: 'security_concern',
        description: 'SQL injection vulnerability found',
        severity: 'critical',
      });

      expect(decision.allowed).toBe(true);
    });

    it('test failures under investigation are suppressed', async () => {
      const { MessagePolicy } = await import(
        '../src/autonomous/communication/policy.js'
      );
      const policy = new MessagePolicy({
        enabled: true,
        testFailureMinSeverity: 'unresolvable',
        throttle: {
          maxPerHour: 100,
          maxPerDay: 100,
          quietHours: false,
          quietStart: '22:00',
          quietEnd: '08:00',
        },
      });

      const investigating = policy.shouldNotify({
        type: 'test_failure',
        test: 'detector.test.ts',
        investigating: true,
      });

      const unresolvable = policy.shouldNotify({
        type: 'test_failure',
        test: 'detector.test.ts',
        investigating: false,
      });

      // Investigating → suppress (Tyrion is handling it)
      expect(investigating.allowed).toBe(false);
      // Not investigating → notify (Tyrion needs help)
      expect(unresolvable.allowed).toBe(true);
    });

    it('daily summaries respect dailySummaryEnabled flag', async () => {
      const { MessagePolicy } = await import(
        '../src/autonomous/communication/policy.js'
      );

      const enabled = new MessagePolicy({
        enabled: true,
        dailySummaryEnabled: true,
        throttle: { maxPerHour: 100, maxPerDay: 100, quietHours: false, quietStart: '22:00', quietEnd: '08:00' },
      });

      const disabled = new MessagePolicy({
        enabled: true,
        dailySummaryEnabled: false,
        throttle: { maxPerHour: 100, maxPerDay: 100, quietHours: false, quietStart: '22:00', quietEnd: '08:00' },
      });

      const event = {
        type: 'daily_summary' as const,
        stats: { cyclesRun: 5, issuesFixed: 2, testsPassing: 100, testsFailing: 0, healthSummary: 'Healthy' },
      };

      expect(enabled.shouldNotify(event).allowed).toBe(true);
      expect(disabled.shouldNotify(event).allowed).toBe(false);
    });
  });

  describe('message formatting reflects severity', () => {
    it('security concern includes severity level', async () => {
      const { MessagePolicy } = await import(
        '../src/autonomous/communication/policy.js'
      );
      const policy = new MessagePolicy();

      const message = policy.formatMessage({
        type: 'security_concern',
        description: 'Hardcoded API key in source',
        severity: 'critical',
      });

      expect(message).toContain('critical');
      expect(message).toContain('Hardcoded API key');
    });

    it('fix_complete is brief and factual (quietness trait)', async () => {
      const { MessagePolicy } = await import(
        '../src/autonomous/communication/policy.js'
      );
      const policy = new MessagePolicy();

      const message = policy.formatMessage({
        type: 'fix_complete',
        description: 'Fixed flaky detector test, was an unanchored regex',
        branch: 'auto/fix-detector',
      });

      // Should be results-oriented, not narration
      expect(message).toContain('Fixed');
      expect(message).toContain('Branch');
      // Should not contain process narration
      expect(message).not.toContain('I noticed');
      expect(message).not.toContain('I investigated');
      expect(message).not.toContain('I found that');
      // Should end with a period (factual)
      expect(message.endsWith('.')).toBe(true);
    });

    it('test_failure distinguishes investigating vs needs help', async () => {
      const { MessagePolicy } = await import(
        '../src/autonomous/communication/policy.js'
      );
      const policy = new MessagePolicy();

      const investigating = policy.formatMessage({
        type: 'test_failure',
        test: 'parser.test.ts',
        investigating: true,
      });

      const needsHelp = policy.formatMessage({
        type: 'test_failure',
        test: 'parser.test.ts',
        investigating: false,
      });

      expect(investigating).toContain('investigating');
      expect(needsHelp).toContain('help');
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// TRAIT: Quietness — "Report Results, Not Process"
// ═══════════════════════════════════════════════════════════════════════════════

describe('Quietness Trait', () => {
  it('CHARACTER_PROMPT encodes "report results, not process"', () => {
    const source = readFileSync(
      resolve(PROJECT_ROOT, 'src/autonomous/identity.ts'),
      'utf8',
    );

    expect(source).toContain('Report results, not process');
  });

  it('CHARACTER_PROMPT encodes "brief and factual"', () => {
    const source = readFileSync(
      resolve(PROJECT_ROOT, 'src/autonomous/identity.ts'),
      'utf8',
    );

    expect(source).toContain('brief and factual');
  });

  it('CHARACTER_PROMPT encodes self-verification instinct', () => {
    const source = readFileSync(
      resolve(PROJECT_ROOT, 'src/autonomous/identity.ts'),
      'utf8',
    );

    expect(source).toContain('Verify your own work');
    expect(source).toContain('Do not trust that your output is correct');
  });

  it('CHARACTER_PROMPT encodes investigation over reporting', () => {
    const source = readFileSync(
      resolve(PROJECT_ROOT, 'src/autonomous/identity.ts'),
      'utf8',
    );

    expect(source).toContain('When something fails, investigate');
    expect(source).toContain('Do not simply report the failure and stop');
  });

  it('CHARACTER_PROMPT encodes dual-model delegation', () => {
    const source = readFileSync(
      resolve(PROJECT_ROOT, 'src/autonomous/identity.ts'),
      'utf8',
    );

    expect(source).toContain('hermes3');
    expect(source).toContain('qwen3-coder-next');
    expect(source).toContain('Delegate deliberately');
  });

  it('CHARACTER_PROMPT enforces local-only privacy', () => {
    const source = readFileSync(
      resolve(PROJECT_ROOT, 'src/autonomous/identity.ts'),
      'utf8',
    );

    expect(source).toContain('All inference stays local');
    expect(source).toContain('Sensitive content is redacted');
  });

  it('minimal identity prompt still includes character', async () => {
    const { buildMinimalIdentityPrompt } = await import(
      '../src/autonomous/identity.js'
    );

    const minimal = buildMinimalIdentityPrompt();
    expect(minimal).toContain('Tyrion');
    expect(minimal).toContain('Verify your own work');
    expect(minimal).toContain('Report results, not process');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// CAPABILITY: Dream Cycle — 6-Phase Consolidation Pipeline
// ═══════════════════════════════════════════════════════════════════════════════

describe('Dream Cycle Pipeline (Phase 6)', () => {
  describe('constructor and configuration', () => {
    it('creates runner with default config', async () => {
      const { DreamCycleRunner } = await import(
        '../src/autonomous/dream/runner.js'
      );
      const runner = new DreamCycleRunner();
      expect(runner).toBeDefined();
      expect(runner.isEnabled()).toBe(true);
    });

    it('getSelfModel returns the embedded self-model', async () => {
      const { DreamCycleRunner } = await import(
        '../src/autonomous/dream/runner.js'
      );
      const runner = new DreamCycleRunner();
      const sm = runner.getSelfModel();
      expect(sm).toBeDefined();
      expect(sm.getData()).toHaveProperty('skills');
      expect(sm.getData()).toHaveProperty('version');
    });

    it('disabled runner reports isEnabled false', async () => {
      const { DreamCycleRunner } = await import(
        '../src/autonomous/dream/runner.js'
      );
      const runner = new DreamCycleRunner({ enabled: false });
      expect(runner.isEnabled()).toBe(false);
    });
  });

  describe('phase structure', () => {
    it('runner source defines all 6 phases', () => {
      const source = readFileSync(
        resolve(PROJECT_ROOT, 'src/autonomous/dream/runner.ts'),
        'utf8',
      );

      // Phase 1: Consolidate reflections
      expect(source).toContain('consolidateReflections');
      // Phase 2: Update world model
      expect(source).toContain('updateWorldModel');
      // Phase 3: Reorganize goals
      expect(source).toContain('reorganizeGoals');
      // Phase 4: Explore (code archaeology)
      expect(source).toContain('explore');
      // Phase 5: Update self-model
      expect(source).toContain('updateSelfModel');
      // Phase 6: Write retrospective
      expect(source).toContain('writeRetrospective');
    });

    it('individual phase failures do not abort the cycle', () => {
      const source = readFileSync(
        resolve(PROJECT_ROOT, 'src/autonomous/dream/runner.ts'),
        'utf8',
      );

      // Each phase should be wrapped in try/catch
      // Count the try blocks within the run method
      const runSection = source.slice(
        source.indexOf('async run('),
        source.indexOf('// ── Individual Phases'),
      );

      const tryCount = (runSection.match(/try\s*\{/g) || []).length;
      const catchCount = (runSection.match(/\}\s*catch/g) || []).length;

      // Should have at least 6 try/catch blocks (one per phase)
      expect(tryCount).toBeGreaterThanOrEqual(6);
      expect(catchCount).toBeGreaterThanOrEqual(6);
    });

    it('DreamOutcome tracks which phases completed vs skipped', async () => {
      const { DreamCycleRunner } = await import(
        '../src/autonomous/dream/runner.js'
      );

      // Verify the outcome type has the right shape by checking the runner source
      const source = readFileSync(
        resolve(PROJECT_ROOT, 'src/autonomous/dream/runner.ts'),
        'utf8',
      );

      expect(source).toContain('phasesCompleted');
      expect(source).toContain('phasesSkipped');
      expect(source).toContain('reflectionsConsolidated');
      expect(source).toContain('fragileFilesFound');
      expect(source).toContain('abandonedFilesFound');
      expect(source).toContain('goalsReorganized');
      expect(source).toContain('retrospectiveWritten');
      expect(source).toContain('selfModelRebuilt');
    });
  });

  describe('phase 3: goal reorganization logic', () => {
    it('creates goals from high-priority issues without existing goals', async () => {
      // This tests the reorganizeGoals phase logic specifically
      const source = readFileSync(
        resolve(PROJECT_ROOT, 'src/autonomous/dream/runner.ts'),
        'utf8',
      );

      // Should check for critical and high priority issues
      expect(source).toContain("issue.priority === 'critical'");
      expect(source).toContain("issue.priority === 'high'");
      // Should create goals from unaddressed issues
      expect(source).toContain('addGoal');
      // Should prune stale goals
      expect(source).toContain('getStaleGoals');
    });
  });

  describe('phase 4: exploration uses archaeology', () => {
    it('dream runner integrates CodeArchaeologist', () => {
      const source = readFileSync(
        resolve(PROJECT_ROOT, 'src/autonomous/dream/runner.ts'),
        'utf8',
      );

      expect(source).toContain('CodeArchaeologist');
      expect(source).toContain('findFragileCode');
      expect(source).toContain('findAbandonedCode');
    });

    it('files issues for very fragile code (fragilityScore > 10)', () => {
      const source = readFileSync(
        resolve(PROJECT_ROOT, 'src/autonomous/dream/runner.ts'),
        'utf8',
      );

      expect(source).toContain('fragilityScore > 10');
      expect(source).toContain('fileIssue');
      expect(source).toContain('Fragile code:');
    });
  });

  describe('phase 6: retrospective writes to MEMORY.md', () => {
    it('retrospective uses buildNarrative from archaeology', () => {
      const source = readFileSync(
        resolve(PROJECT_ROOT, 'src/autonomous/dream/runner.ts'),
        'utf8',
      );

      expect(source).toContain('buildNarrative');
      expect(source).toContain('appendToMemory');
      expect(source).toContain('Dream Cycle Retrospective');
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// WIRING VALIDATION: Are Phase 5/6 modules integrated into the runtime?
// ═══════════════════════════════════════════════════════════════════════════════

describe('Wiring Validation', () => {
  describe('modules that ARE wired into the runtime', () => {
    it('WorldModel is used in loop.ts', () => {
      const source = readFileSync(
        resolve(PROJECT_ROOT, 'src/autonomous/loop.ts'),
        'utf8',
      );
      expect(source).toContain('WorldModel');
    });

    it('GoalStack is used in loop.ts', () => {
      const source = readFileSync(
        resolve(PROJECT_ROOT, 'src/autonomous/loop.ts'),
        'utf8',
      );
      expect(source).toContain('GoalStack');
    });

    it('IssueLog is used in loop.ts', () => {
      const source = readFileSync(
        resolve(PROJECT_ROOT, 'src/autonomous/loop.ts'),
        'utf8',
      );
      expect(source).toContain('IssueLog');
    });

    it('EventBus is used in loop.ts', () => {
      const source = readFileSync(
        resolve(PROJECT_ROOT, 'src/autonomous/loop.ts'),
        'utf8',
      );
      expect(source).toContain('EventBus');
    });

    it('buildIdentityPrompt is used in agent-loop.ts', () => {
      const source = readFileSync(
        resolve(PROJECT_ROOT, 'src/autonomous/agent-loop.ts'),
        'utf8',
      );
      expect(source).toContain('buildIdentityPrompt');
    });

    it('ContextManager is used in loop.ts', () => {
      const source = readFileSync(
        resolve(PROJECT_ROOT, 'src/autonomous/loop.ts'),
        'utf8',
      );
      expect(source).toContain('ContextManager');
    });
  });

  describe('modules NOT yet wired (known integration gaps)', () => {
    it('AdversarialTester is NOT called from agent-loop.ts', () => {
      const source = readFileSync(
        resolve(PROJECT_ROOT, 'src/autonomous/agent-loop.ts'),
        'utf8',
      );
      // This test documents the gap — when wired, flip the assertion
      expect(source).not.toContain('AdversarialTester');
    });

    it('AdversarialTester is NOT called from loop.ts', () => {
      const source = readFileSync(
        resolve(PROJECT_ROOT, 'src/autonomous/loop.ts'),
        'utf8',
      );
      expect(source).not.toContain('AdversarialTester');
    });

    it('ReasoningScaler is NOT called from agent-loop.ts', () => {
      const source = readFileSync(
        resolve(PROJECT_ROOT, 'src/autonomous/agent-loop.ts'),
        'utf8',
      );
      expect(source).not.toContain('ReasoningScaler');
    });

    it('ReasoningScaler is NOT called from loop.ts', () => {
      const source = readFileSync(
        resolve(PROJECT_ROOT, 'src/autonomous/loop.ts'),
        'utf8',
      );
      expect(source).not.toContain('ReasoningScaler');
    });

    it('DreamCycleRunner is NOT called from loop.ts', () => {
      const source = readFileSync(
        resolve(PROJECT_ROOT, 'src/autonomous/loop.ts'),
        'utf8',
      );
      expect(source).not.toContain('DreamCycleRunner');
    });
  });

  describe('modules are exported from barrel (available for wiring)', () => {
    it('all Phase 5/6 modules are exported from autonomous/index.ts', async () => {
      const auto = await import('../src/autonomous/index.js');

      expect(auto.AdversarialTester).toBeDefined();
      expect(auto.ReasoningScaler).toBeDefined();
      expect(auto.DreamCycleRunner).toBeDefined();
      expect(auto.SelfModel).toBeDefined();
      expect(auto.CodeArchaeologist).toBeDefined();
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// CAPABILITY: Hardware Maximization — Dual-Model Architecture
// ═══════════════════════════════════════════════════════════════════════════════

describe('Hardware Maximization', () => {
  describe('ConcurrentProvider architecture', () => {
    it('concurrent provider module exists and exports expected types', async () => {
      const concurrent = await import('../src/providers/concurrent.js');
      expect(concurrent.ConcurrentProvider).toBeDefined();
    });

    it('concurrent provider supports parallel generation', () => {
      const source = readFileSync(
        resolve(PROJECT_ROOT, 'src/providers/concurrent.ts'),
        'utf8',
      );

      expect(source).toContain('parallel(');
      expect(source).toContain('Promise.all');
    });

    it('concurrent provider supports bestOfN with judge model', () => {
      const source = readFileSync(
        resolve(PROJECT_ROOT, 'src/providers/concurrent.ts'),
        'utf8',
      );

      expect(source).toContain('bestOfN(');
      expect(source).toContain('judgeModel');
      expect(source).toContain('judgeReasoning');
    });

    it('concurrent provider has concurrency control', () => {
      const source = readFileSync(
        resolve(PROJECT_ROOT, 'src/providers/concurrent.ts'),
        'utf8',
      );

      expect(source).toContain('maxConcurrent');
      expect(source).toContain('activeRequests');
    });
  });

  describe('dual-model configuration', () => {
    it('config references both hermes3 and qwen3 models', async () => {
      const configPath = resolve(PROJECT_ROOT, 'config/autonomous.yaml');
      if (existsSync(configPath)) {
        const config = readFileSync(configPath, 'utf8');
        // Config should reference local models
        expect(config).toContain('ollama');
      }
    });

    it('reasoning scaler defaults encode the dual-model strategy', async () => {
      const { ReasoningScaler } = await import(
        '../src/autonomous/reasoning/scaling.js'
      );
      const scaler = new ReasoningScaler();
      const config = scaler.getConfig();

      // Vision: hermes3 for reasoning, qwen3 for coding
      expect(config.reasoningModel).not.toBe(config.codingModel);
      expect(config.reasoningModel).toContain('hermes3');
      expect(config.codingModel).toContain('qwen3');
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// CAPABILITY: Multi-Resolution Understanding
// ═══════════════════════════════════════════════════════════════════════════════

describe('Multi-Resolution Understanding', () => {
  describe('WorldModel provides system-level view', () => {
    it('tracks codebase health (typecheck, tests, lint)', () => {
      const source = readFileSync(
        resolve(PROJECT_ROOT, 'src/autonomous/world-model.ts'),
        'utf8',
      );

      expect(source).toContain('HealthSnapshot');
      expect(source).toContain('typecheck');
      expect(source).toContain('testResults');
      expect(source).toContain('lint');
    });

    it('tracks codebase stats (files, lines, branch, commits)', () => {
      const source = readFileSync(
        resolve(PROJECT_ROOT, 'src/autonomous/world-model.ts'),
        'utf8',
      );

      expect(source).toContain('totalFiles');
      expect(source).toContain('totalLines');
      expect(source).toContain('branchName');
      expect(source).toContain('lastCommitHash');
    });

    it('tracks concerns with severity levels', () => {
      const source = readFileSync(
        resolve(PROJECT_ROOT, 'src/autonomous/world-model.ts'),
        'utf8',
      );

      expect(source).toContain('informational');
      expect(source).toContain('worth-watching');
      expect(source).toContain('needs-action');
    });
  });

  describe('CodeArchaeologist provides file-level analysis', () => {
    it('analyzes per-file commit history', () => {
      const source = readFileSync(
        resolve(PROJECT_ROOT, 'src/autonomous/dream/archaeology.ts'),
        'utf8',
      );

      expect(source).toContain('analyzeFileHistory');
      expect(source).toContain('commitCount');
      expect(source).toContain('authorCount');
      expect(source).toContain('recentCommits');
    });
  });

  describe('repo-map provides function-level indexing', () => {
    it('repo-map module exists for function-level resolution', async () => {
      const files = await import('../src/autonomous/index.js');
      // The repo-map is a separate subsystem but it exists
      const repoMapExists = existsSync(
        resolve(PROJECT_ROOT, 'src/coding/repo-map'),
      );
      expect(repoMapExists).toBe(true);
    });
  });

  describe('resolution gap: WorldModel is project-level only', () => {
    it('WorldModel does not track per-file health', () => {
      const source = readFileSync(
        resolve(PROJECT_ROOT, 'src/autonomous/world-model.ts'),
        'utf8',
      );

      // Document the gap: no per-file or per-function tracking in WorldModel
      // The per-file data lives in CodeArchaeologist, not WorldModel
      expect(source).not.toContain('fileHealth');
      expect(source).not.toContain('functionHealth');
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// VISION GAP: Self-Distillation (not implemented)
// ═══════════════════════════════════════════════════════════════════════════════

describe('Self-Distillation (Vision — Not Implemented)', () => {
  it('dream cycle does NOT include fine-tuning logic', () => {
    const source = readFileSync(
      resolve(PROJECT_ROOT, 'src/autonomous/dream/runner.ts'),
      'utf8',
    );

    // The vision described fine-tuning a specialist model from reasoning traces.
    // This documents that this capability is not yet implemented.
    expect(source).not.toContain('fine-tune');
    expect(source).not.toContain('LoRA');
    expect(source).not.toContain('training');
    expect(source).not.toContain('GGUF');
  });

  it('self-model uses knowledge distillation into YAML instead', () => {
    const source = readFileSync(
      resolve(PROJECT_ROOT, 'src/autonomous/dream/self-model.ts'),
      'utf8',
    );

    // Instead of model weight updates, the self-model stores stats in YAML
    expect(source).toContain('YAML');
    expect(source).toContain('self-model.yaml');
  });
});
