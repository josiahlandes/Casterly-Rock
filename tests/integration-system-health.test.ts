/**
 * Integration Test: System Health & Consistency
 *
 * Validates that the entire Tyrion system is properly wired:
 * - All exports resolve (no broken imports)
 * - Module interfaces are compatible
 * - Configuration types match runtime expectations
 * - Security constraints are enforced
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';

const PROJECT_ROOT = resolve(import.meta.dirname, '..');

// ═══════════════════════════════════════════════════════════════════════════════
// Module export verification — ensures no broken imports
// ═══════════════════════════════════════════════════════════════════════════════

describe('autonomous module exports', () => {
  it('exports all core types', async () => {
    const types = await import('../src/autonomous/types.js');
    // Verify key interfaces exist as type exports (they don't have runtime presence,
    // but the module should load without error)
    expect(types).toBeDefined();
  });

  it('exports provider interface and factory', async () => {
    const provider = await import('../src/autonomous/provider.js');
    expect(provider.createProvider).toBeDefined();
    expect(typeof provider.createProvider).toBe('function');
    expect(provider.BaseAutonomousProvider).toBeDefined();
    expect(provider.PROMPTS).toBeDefined();
    expect(provider.PROMPTS.analyze).toBeTruthy();
    expect(provider.PROMPTS.hypothesize).toBeTruthy();
    expect(provider.PROMPTS.implement).toBeTruthy();
    expect(provider.PROMPTS.reflect).toBeTruthy();
  });

  it('exports loop class and utilities', async () => {
    const loop = await import('../src/autonomous/loop.js');
    expect(loop.AutonomousLoop).toBeDefined();
    expect(loop.AbortError).toBeDefined();
    expect(loop.loadConfig).toBeDefined();
    expect(typeof loop.loadConfig).toBe('function');
  });

  it('exports analyzer', async () => {
    const analyzer = await import('../src/autonomous/analyzer.js');
    expect(analyzer.Analyzer).toBeDefined();
  });

  it('exports validator', async () => {
    const validator = await import('../src/autonomous/validator.js');
    expect(validator.Validator).toBeDefined();
    expect(validator.buildInvariants).toBeDefined();
  });

  it('exports reflector', async () => {
    const reflector = await import('../src/autonomous/reflector.js');
    expect(reflector.Reflector).toBeDefined();
  });

  it('exports git operations', async () => {
    const git = await import('../src/autonomous/git.js');
    expect(git.GitOperations).toBeDefined();
  });

  it('exports controller', async () => {
    const controller = await import('../src/autonomous/controller.js');
    expect(controller.createAutonomousController).toBeDefined();
  });

  it('exports world model (Phase 1)', async () => {
    const wm = await import('../src/autonomous/world-model.js');
    expect(wm.WorldModel).toBeDefined();
  });

  it('exports goal stack (Phase 1)', async () => {
    const gs = await import('../src/autonomous/goal-stack.js');
    expect(gs.GoalStack).toBeDefined();
  });

  it('exports issue log (Phase 1)', async () => {
    const il = await import('../src/autonomous/issue-log.js');
    expect(il.IssueLog).toBeDefined();
  });

  it('exports identity builder (Phase 1)', async () => {
    const identity = await import('../src/autonomous/identity.js');
    expect(identity.buildIdentityPrompt).toBeDefined();
    expect(identity.buildMinimalIdentityPrompt).toBeDefined();
  });

  it('exports debug tracer (Phase 1)', async () => {
    const debug = await import('../src/autonomous/debug.js');
    expect(debug.DebugTracer).toBeDefined();
    expect(debug.getTracer).toBeDefined();
    expect(debug.initTracer).toBeDefined();
  });

  it('exports agent loop (Phase 2)', async () => {
    const agent = await import('../src/autonomous/agent-loop.js');
    expect(agent.AgentLoop).toBeDefined();
    expect(agent.createAgentLoop).toBeDefined();
  });

  it('exports agent tools (Phase 2)', async () => {
    const tools = await import('../src/autonomous/agent-tools.js');
    expect(tools.buildAgentToolkit).toBeDefined();
  });

  it('exports event bus (Phase 3)', async () => {
    const events = await import('../src/autonomous/events.js');
    expect(events.EventBus).toBeDefined();
    expect(events.getEventPriority).toBeDefined();
    expect(events.compareEventPriority).toBeDefined();
  });

  it('exports context manager (Phase 4)', async () => {
    const ctx = await import('../src/autonomous/context-manager.js');
    expect(ctx.ContextManager).toBeDefined();
    expect(ctx.createContextManager).toBeDefined();
  });

  it('exports context store (Phase 4)', async () => {
    const store = await import('../src/autonomous/context-store.js');
    expect(store.ContextStore).toBeDefined();
  });

  it('exports reasoning scaler (Phase 5)', async () => {
    const scaling = await import('../src/autonomous/reasoning/scaling.js');
    expect(scaling.ReasoningScaler).toBeDefined();
    expect(scaling.createReasoningScaler).toBeDefined();
  });

  it('exports adversarial tester (Phase 5)', async () => {
    const adversarial = await import('../src/autonomous/reasoning/adversarial.js');
    expect(adversarial.AdversarialTester).toBeDefined();
    expect(adversarial.createAdversarialTester).toBeDefined();
  });

  it('exports dream cycle runner (Phase 6)', async () => {
    const dream = await import('../src/autonomous/dream/runner.js');
    expect(dream.DreamCycleRunner).toBeDefined();
    expect(dream.createDreamCycleRunner).toBeDefined();
  });

  it('exports self model (Phase 6)', async () => {
    const selfModel = await import('../src/autonomous/dream/self-model.js');
    expect(selfModel.SelfModel).toBeDefined();
    expect(selfModel.createSelfModel).toBeDefined();
  });

  it('exports code archaeologist (Phase 6)', async () => {
    const arch = await import('../src/autonomous/dream/archaeology.js');
    expect(arch.CodeArchaeologist).toBeDefined();
    expect(arch.createCodeArchaeologist).toBeDefined();
  });

  it('exports message policy (Phase 7)', async () => {
    const policy = await import('../src/autonomous/communication/policy.js');
    expect(policy.MessagePolicy).toBeDefined();
    expect(policy.createMessagePolicy).toBeDefined();
  });

  it('exports reports', async () => {
    const report = await import('../src/autonomous/report.js');
    expect(report.formatDailyReport).toBeDefined();
    expect(report.formatMorningSummary).toBeDefined();
  });

  it('exports test parser', async () => {
    const parser = await import('../src/autonomous/test-parser.js');
    expect(parser.parseVitestJson).toBeDefined();
    expect(parser.testFileToSourceModule).toBeDefined();
    expect(parser.failuresToErrorLogEntries).toBeDefined();
    expect(parser.parseCoverageSummary).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Model module exports
// ═══════════════════════════════════════════════════════════════════════════════

describe('model module exports', () => {
  it('exports all model functions', async () => {
    const models = await import('../src/models/index.js');
    expect(models.DEFAULT_PROFILE).toBeDefined();
    expect(models.resolveModelProfile).toBeDefined();
    expect(models.enrichSystemPrompt).toBeDefined();
    expect(models.enrichToolDescriptions).toBeDefined();
    expect(models.applyResponseHints).toBeDefined();
    expect(models.getGenerationOverrides).toBeDefined();
  });

  it('DEFAULT_PROFILE has required shape', async () => {
    const { DEFAULT_PROFILE } = await import('../src/models/index.js');
    expect(DEFAULT_PROFILE.modelId).toBe('default');
    expect(DEFAULT_PROFILE.displayName).toBeTruthy();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Barrel export from autonomous/index.ts
// ═══════════════════════════════════════════════════════════════════════════════

describe('autonomous barrel export (index.ts)', () => {
  it('re-exports all phases from single import', async () => {
    const auto = await import('../src/autonomous/index.js');

    // Core
    expect(auto.AutonomousLoop).toBeDefined();
    expect(auto.AbortError).toBeDefined();
    expect(auto.loadConfig).toBeDefined();
    expect(auto.createProvider).toBeDefined();
    expect(auto.Analyzer).toBeDefined();
    expect(auto.Validator).toBeDefined();
    expect(auto.Reflector).toBeDefined();
    expect(auto.GitOperations).toBeDefined();

    // Phase 1
    expect(auto.WorldModel).toBeDefined();
    expect(auto.GoalStack).toBeDefined();
    expect(auto.IssueLog).toBeDefined();
    expect(auto.buildIdentityPrompt).toBeDefined();

    // Phase 2
    expect(auto.AgentLoop).toBeDefined();
    expect(auto.buildAgentToolkit).toBeDefined();

    // Phase 3
    expect(auto.EventBus).toBeDefined();

    // Phase 4
    expect(auto.ContextManager).toBeDefined();
    expect(auto.ContextStore).toBeDefined();

    // Phase 5
    expect(auto.ReasoningScaler).toBeDefined();
    expect(auto.AdversarialTester).toBeDefined();

    // Phase 6
    expect(auto.DreamCycleRunner).toBeDefined();
    expect(auto.SelfModel).toBeDefined();
    expect(auto.CodeArchaeologist).toBeDefined();

    // Utilities
    expect(auto.createAutonomousController).toBeDefined();
    expect(auto.formatDailyReport).toBeDefined();
    expect(auto.formatMorningSummary).toBeDefined();
    expect(auto.parseVitestJson).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Security constraints
// ═══════════════════════════════════════════════════════════════════════════════

describe('security constraints', () => {
  it('no cloud provider imports in autonomous modules', () => {
    const autoDir = resolve(PROJECT_ROOT, 'src/autonomous');
    const content = readFileSync(resolve(autoDir, 'provider.ts'), 'utf8');
    expect(content).not.toContain("from 'openai'");
    expect(content).not.toContain("from '@anthropic-ai'");
    expect(content).not.toContain('api.openai.com');
  });

  it('provider factory only creates Ollama provider', () => {
    const content = readFileSync(resolve(PROJECT_ROOT, 'src/autonomous/provider.ts'), 'utf8');
    expect(content).toContain('OllamaAutonomousProvider');
    expect(content).not.toContain('OpenAI');
    expect(content).not.toContain('Anthropic');
  });

  it('forbidden patterns include sensitive file types', async () => {
    const { loadConfig } = await import('../src/autonomous/loop.js');
    const config = await loadConfig(resolve(PROJECT_ROOT, 'config/autonomous.yaml'));
    const hasSensitivePatterns = config.forbiddenPatterns.some(
      (p) => p.includes('.env') || p.includes('secret') || p.includes('credential')
    );
    expect(hasSensitivePatterns).toBe(true);
  });

  it('protected paths are defined in CLAUDE.md', () => {
    const claudeMd = readFileSync(resolve(PROJECT_ROOT, 'CLAUDE.md'), 'utf8');
    expect(claudeMd).toContain('protected paths');
    expect(claudeMd).toContain('src/security');
  });

  it('lint script enforces console.log restrictions', () => {
    const lint = readFileSync(resolve(PROJECT_ROOT, 'scripts/lint.mjs'), 'utf8');
    expect(lint).toContain('ALLOWED_CONSOLE_LOG_FILES');
    expect(lint).toContain('console.log');
  });

  it('security scan blocks high-severity vulnerabilities', () => {
    const scan = readFileSync(resolve(PROJECT_ROOT, 'scripts/security-scan.mjs'), 'utf8');
    expect(scan).toContain('npm audit');
    expect(scan).toContain('high');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// PROMPTS template structure
// ═══════════════════════════════════════════════════════════════════════════════

describe('prompt templates', () => {
  it('all prompt templates have required placeholders', async () => {
    const { PROMPTS } = await import('../src/autonomous/provider.js');

    expect(PROMPTS.analyze).toContain('{{errorLogs}}');
    expect(PROMPTS.analyze).toContain('{{performanceMetrics}}');
    expect(PROMPTS.analyze).toContain('{{codebaseStats}}');
    expect(PROMPTS.analyze).toContain('{{backlog}}');

    expect(PROMPTS.hypothesize).toContain('{{observations}}');
    expect(PROMPTS.hypothesize).toContain('confidence');

    expect(PROMPTS.implement).toContain('{{hypothesis}}');
    expect(PROMPTS.implement).toContain('{{fileContents}}');

    expect(PROMPTS.reflect).toContain('{{cycleId}}');
    expect(PROMPTS.reflect).toContain('{{outcome}}');
  });

  it('analyze prompt requests specific observation types', async () => {
    const { PROMPTS } = await import('../src/autonomous/provider.js');
    expect(PROMPTS.analyze).toContain('error_pattern');
    expect(PROMPTS.analyze).toContain('performance_issue');
    expect(PROMPTS.analyze).toContain('test_failure');
    expect(PROMPTS.analyze).toContain('feature_request');
  });

  it('hypothesize prompt requests confidence scores', async () => {
    const { PROMPTS } = await import('../src/autonomous/provider.js');
    expect(PROMPTS.hypothesize).toContain('confidence: 0-1');
  });

  it('implement prompt includes safety instructions', async () => {
    const { PROMPTS } = await import('../src/autonomous/provider.js');
    expect(PROMPTS.implement).toContain('minimal');
    expect(PROMPTS.implement).toContain('existing');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// File structure validation
// ═══════════════════════════════════════════════════════════════════════════════

describe('project structure', () => {
  const requiredDirs = [
    'src/autonomous',
    'src/autonomous/providers',
    'src/autonomous/watchers',
    'src/autonomous/dream',
    'src/autonomous/communication',
    'src/autonomous/reasoning',
    'src/models',
    'config',
    'tests',
    'scripts',
  ];

  for (const dir of requiredDirs) {
    it(`${dir}/ exists`, () => {
      expect(existsSync(resolve(PROJECT_ROOT, dir))).toBe(true);
    });
  }

  const requiredFiles = [
    'src/autonomous/loop.ts',
    'src/autonomous/provider.ts',
    'src/autonomous/analyzer.ts',
    'src/autonomous/validator.ts',
    'src/autonomous/reflector.ts',
    'src/autonomous/git.ts',
    'src/autonomous/types.ts',
    'src/autonomous/index.ts',
    'src/autonomous/world-model.ts',
    'src/autonomous/goal-stack.ts',
    'src/autonomous/issue-log.ts',
    'src/autonomous/identity.ts',
    'src/autonomous/agent-loop.ts',
    'src/autonomous/agent-tools.ts',
    'src/autonomous/events.ts',
    'src/autonomous/context-manager.ts',
    'src/autonomous/context-store.ts',
    'src/autonomous/debug.ts',
    'src/autonomous/controller.ts',
    'src/autonomous/report.ts',
    'src/autonomous/test-parser.ts',
    'src/autonomous/memory-config.ts',
    'src/autonomous/reasoning/scaling.ts',
    'src/autonomous/reasoning/adversarial.ts',
    'src/autonomous/dream/runner.ts',
    'src/autonomous/dream/self-model.ts',
    'src/autonomous/dream/archaeology.ts',
    'src/autonomous/communication/policy.ts',
    'src/models/index.ts',
    'src/models/types.ts',
    'src/models/profiles.ts',
    'src/models/enrichment.ts',
  ];

  for (const file of requiredFiles) {
    it(`${file} exists`, () => {
      expect(existsSync(resolve(PROJECT_ROOT, file))).toBe(true);
    });
  }
});

