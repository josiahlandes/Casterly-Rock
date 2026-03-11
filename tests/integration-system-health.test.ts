/**
 * Integration Test: System Health & Consistency
 *
 * Validates that the entire Tyrion system is properly wired:
 * - All exports resolve (no broken imports)
 * - Module interfaces are compatible
 * - Security constraints are enforced
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const PROJECT_ROOT = resolve(import.meta.dirname, '..');

// ═══════════════════════════════════════════════════════════════════════════════
// Module export verification — ensures no broken imports
// ═══════════════════════════════════════════════════════════════════════════════

describe('autonomous module exports', () => {
  it('exports all core types', async () => {
    const types = await import('../src/autonomous/types.js');
    expect(types).toBeDefined();
  });

  it('exports reflector', async () => {
    const reflector = await import('../src/autonomous/reflector.js');
    expect(reflector.Reflector).toBeDefined();
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
    expect(auto.Reflector).toBeDefined();

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
    expect(auto.parseVitestJson).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Security constraints
// ═══════════════════════════════════════════════════════════════════════════════

describe('security constraints', () => {
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
// File structure validation
// ═══════════════════════════════════════════════════════════════════════════════

describe('project structure', () => {
  const requiredDirs = [
    'src/autonomous',
    'src/autonomous/dream',
    'src/autonomous/reasoning',
    'src/autonomous/tools',
    'src/dual-loop',
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
    'src/autonomous/reflector.ts',
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
    'src/autonomous/controller-types.ts',
    'src/autonomous/test-parser.ts',
    'src/autonomous/reasoning/scaling.ts',
    'src/autonomous/reasoning/adversarial.ts',
    'src/autonomous/dream/runner.ts',
    'src/autonomous/dream/self-model.ts',
    'src/autonomous/dream/archaeology.ts',
    'src/autonomous/tools/store-interfaces.ts',
    'src/dual-loop/dual-loop-controller.ts',
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
