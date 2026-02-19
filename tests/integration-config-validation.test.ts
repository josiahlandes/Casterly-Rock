/**
 * Integration Test: Configuration Validation
 *
 * Validates that all YAML configuration files are internally consistent
 * and cross-reference each other correctly. This catches drift between
 * config/models.yaml, config/autonomous.yaml, and config/default.yaml.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import YAML from 'yaml';
import { loadConfig } from '../src/autonomous/loop.js';

const PROJECT_ROOT = resolve(import.meta.dirname, '..');

// ─── Helpers ─────────────────────────────────────────────────────────────────

function loadYaml(relativePath: string): Record<string, unknown> {
  const fullPath = resolve(PROJECT_ROOT, relativePath);
  if (!existsSync(fullPath)) {
    throw new Error(`Config file not found: ${fullPath}`);
  }
  return YAML.parse(readFileSync(fullPath, 'utf8')) as Record<string, unknown>;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Config file existence
// ═══════════════════════════════════════════════════════════════════════════════

describe('config file existence', () => {
  const requiredFiles = [
    'config/models.yaml',
    'config/autonomous.yaml',
    'config/default.yaml',
  ];

  for (const file of requiredFiles) {
    it(`${file} exists`, () => {
      const fullPath = resolve(PROJECT_ROOT, file);
      expect(existsSync(fullPath)).toBe(true);
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// models.yaml validation
// ═══════════════════════════════════════════════════════════════════════════════

describe('config/models.yaml', () => {
  const raw = loadYaml('config/models.yaml');
  const models = raw.models as Record<string, Record<string, unknown>>;

  it('has required model entries', () => {
    expect(models).toBeDefined();
    expect(models.coding).toBeDefined();
    expect(models.primary).toBeDefined();
    expect(models.autonomous).toBeDefined();
  });

  it('all models use ollama provider', () => {
    for (const [name, cfg] of Object.entries(models)) {
      if ((cfg as Record<string, unknown>).enabled === false) continue;
      expect((cfg as Record<string, unknown>).provider).toBe('ollama');
    }
  });

  it('primary model is gpt-oss:120b', () => {
    expect(models.primary!.model).toBe('gpt-oss:120b');
  });

  it('coding model is qwen3-coder-next:latest', () => {
    expect(models.coding!.model).toBe('qwen3-coder-next:latest');
  });

  it('autonomous model references a valid model', () => {
    const autoModel = models.autonomous!.model as string;
    expect(autoModel).toBeTruthy();
    // Should be either the coding model or primary model
    expect(['qwen3-coder-next:latest', 'gpt-oss:120b']).toContain(autoModel);
  });

  it('all fallbacks reference existing models or null', () => {
    const validModels = Object.values(models).map((m) => (m as Record<string, unknown>).model as string);
    for (const [name, cfg] of Object.entries(models)) {
      const fallback = (cfg as Record<string, unknown>).fallback;
      if (fallback === null || fallback === undefined) continue;
      expect(validModels).toContain(fallback);
    }
  });

  it('routing section references valid model roles', () => {
    const routing = raw.routing as Record<string, string>;
    expect(routing).toBeDefined();
    const validRoles = Object.keys(models);
    for (const [task, role] of Object.entries(routing)) {
      expect(validRoles).toContain(role);
    }
  });

  it('hardware section has valid constraints', () => {
    const hardware = raw.hardware as Record<string, unknown>;
    expect(hardware).toBeDefined();
    expect(hardware.memory_gb).toBeGreaterThanOrEqual(64);
    expect(hardware.max_concurrent_models).toBeGreaterThanOrEqual(1);
    expect(hardware.target_memory_usage_pct).toBeLessThanOrEqual(100);
  });

  it('all models have keep_alive set for always-hot', () => {
    for (const [name, cfg] of Object.entries(models)) {
      if ((cfg as Record<string, unknown>).enabled === false) continue;
      expect((cfg as Record<string, unknown>).keep_alive).toBe(-1);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// autonomous.yaml validation
// ═══════════════════════════════════════════════════════════════════════════════

describe('config/autonomous.yaml', () => {
  it('loads successfully via loadConfig', async () => {
    const configPath = resolve(PROJECT_ROOT, 'config/autonomous.yaml');
    const config = await loadConfig(configPath);
    expect(config).toBeDefined();
    expect(config.provider).toBe('ollama');
  });

  it('autonomous model matches models.yaml autonomous entry', () => {
    const modelsYaml = loadYaml('config/models.yaml');
    const autoYaml = loadYaml('config/autonomous.yaml');
    const modelsAutoModel = ((modelsYaml.models as Record<string, Record<string, unknown>>).autonomous!.model);
    const configAutoModel = (autoYaml.autonomous as Record<string, unknown>).model;
    expect(configAutoModel).toBe(modelsAutoModel);
  });

  it('has valid quiet hours config', () => {
    const raw = loadYaml('config/autonomous.yaml');
    const auto = raw.autonomous as Record<string, unknown>;
    const quietHours = auto.quiet_hours as Record<string, unknown>;
    expect(quietHours).toBeDefined();
    expect(quietHours.enabled).toBe(true);
    // Validate time format (HH:MM)
    const timeRegex = /^\d{2}:\d{2}$/;
    expect(quietHours.start).toMatch(timeRegex);
    expect(quietHours.end).toMatch(timeRegex);
  });

  it('integration mode is approval_required', () => {
    const raw = loadYaml('config/autonomous.yaml');
    const git = raw.git as Record<string, unknown>;
    expect(git.integration_mode).toBe('approval_required');
  });

  it('safety invariants reference valid commands', () => {
    const raw = loadYaml('config/autonomous.yaml');
    const invariants = raw.invariants as Array<Record<string, unknown>>;
    expect(invariants).toBeDefined();
    expect(invariants.length).toBeGreaterThanOrEqual(3);
    for (const inv of invariants) {
      expect(inv.name).toBeTruthy();
      expect(inv.check).toBeTruthy();
      expect(inv.description).toBeTruthy();
    }
  });

  it('forbidden patterns include sensitive file types', () => {
    const raw = loadYaml('config/autonomous.yaml');
    const auto = raw.autonomous as Record<string, unknown>;
    const forbidden = auto.forbidden_patterns as string[];
    expect(forbidden).toBeDefined();
    const hasEnv = forbidden.some((p) => p.includes('.env'));
    expect(hasEnv).toBe(true);
  });

  it('agent loop reasoning model is consistent with models.yaml primary', () => {
    const modelsYaml = loadYaml('config/models.yaml');
    const autoYaml = loadYaml('config/autonomous.yaml');
    const primaryModel = (modelsYaml.models as Record<string, Record<string, unknown>>).primary!.model;
    const agentLoop = autoYaml.agent_loop as Record<string, unknown>;
    expect(agentLoop.reasoning_model).toBe(primaryModel);
  });

  it('agent loop coding model is consistent with models.yaml coding entry', () => {
    const modelsYaml = loadYaml('config/models.yaml');
    const autoYaml = loadYaml('config/autonomous.yaml');
    const codingModel = (modelsYaml.models as Record<string, Record<string, unknown>>).coding!.model;
    const agentLoop = autoYaml.agent_loop as Record<string, unknown>;
    expect(agentLoop.coding_model).toBe(codingModel);
  });

  it('bestofn judge model matches models.yaml primary', () => {
    const modelsYaml = loadYaml('config/models.yaml');
    const autoYaml = loadYaml('config/autonomous.yaml');
    const primaryModel = (modelsYaml.models as Record<string, Record<string, unknown>>).primary!.model;
    const hardware = autoYaml.hardware as Record<string, unknown>;
    expect(hardware.bestofn_judge_model).toBe(primaryModel);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// default.yaml validation
// ═══════════════════════════════════════════════════════════════════════════════

describe('config/default.yaml', () => {
  it('primary model matches models.yaml', () => {
    const modelsYaml = loadYaml('config/models.yaml');
    const defaultYaml = loadYaml('config/default.yaml');
    const primaryModel = (modelsYaml.models as Record<string, Record<string, unknown>>).primary!.model;
    const local = defaultYaml.local as Record<string, unknown>;
    expect(local.model).toBe(primaryModel);
  });

  it('coding model matches models.yaml', () => {
    const modelsYaml = loadYaml('config/models.yaml');
    const defaultYaml = loadYaml('config/default.yaml');
    const codingModel = (modelsYaml.models as Record<string, Record<string, unknown>>).coding!.model;
    const local = defaultYaml.local as Record<string, unknown>;
    expect(local.codingModel).toBe(codingModel);
  });

  it('uses ollama provider', () => {
    const defaultYaml = loadYaml('config/default.yaml');
    const local = defaultYaml.local as Record<string, unknown>;
    expect(local.provider).toBe('ollama');
  });

  it('base URL points to localhost', () => {
    const defaultYaml = loadYaml('config/default.yaml');
    const local = defaultYaml.local as Record<string, unknown>;
    expect(local.baseUrl).toContain('localhost');
    expect(local.baseUrl).toContain('11434');
  });

  it('has required sensitivity categories', () => {
    const defaultYaml = loadYaml('config/default.yaml');
    const sensitivity = defaultYaml.sensitivity as Record<string, unknown>;
    const alwaysLocal = sensitivity.alwaysLocal as string[];
    expect(alwaysLocal).toContain('finances');
    expect(alwaysLocal).toContain('credentials');
    expect(alwaysLocal).toContain('health');
    expect(alwaysLocal).toContain('contacts');
  });

  it('bestofn judge model matches models.yaml primary', () => {
    const modelsYaml = loadYaml('config/models.yaml');
    const defaultYaml = loadYaml('config/default.yaml');
    const primaryModel = (modelsYaml.models as Record<string, Record<string, unknown>>).primary!.model;
    const hardware = defaultYaml.hardware as Record<string, unknown>;
    expect(hardware.bestofn_judge_model).toBe(primaryModel);
  });

  it('tool safety blocks dangerous patterns', () => {
    const defaultYaml = loadYaml('config/default.yaml');
    const tools = defaultYaml.tools as Record<string, unknown>;
    const bash = tools.bash as Record<string, unknown>;
    const blocked = bash.blockedPatterns as string[];
    expect(blocked).toBeDefined();
    expect(blocked.length).toBeGreaterThanOrEqual(3);
    expect(blocked.some((p) => p.includes('rm -rf'))).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Cross-config consistency
// ═══════════════════════════════════════════════════════════════════════════════

describe('cross-config consistency', () => {
  it('all configs reference the same Ollama base URL', () => {
    const modelsYaml = loadYaml('config/models.yaml');
    const defaultYaml = loadYaml('config/default.yaml');
    const ollamaUrl = (modelsYaml.ollama as Record<string, unknown>).base_url as string;
    const defaultUrl = (defaultYaml.local as Record<string, unknown>).baseUrl as string;
    // Both should point to localhost:11434
    expect(ollamaUrl).toContain('11434');
    expect(defaultUrl).toContain('11434');
  });

  it('no config references a cloud provider', () => {
    const files = ['config/models.yaml', 'config/autonomous.yaml', 'config/default.yaml'];
    for (const file of files) {
      const content = readFileSync(resolve(PROJECT_ROOT, file), 'utf8');
      expect(content).not.toContain('openai');
      expect(content).not.toContain('anthropic');
      expect(content).not.toContain('api.openai.com');
    }
  });

  it('gpt-oss model referenced consistently across all configs', () => {
    const modelsYaml = loadYaml('config/models.yaml');
    const autoYaml = loadYaml('config/autonomous.yaml');
    const defaultYaml = loadYaml('config/default.yaml');

    const primaryModel = (modelsYaml.models as Record<string, Record<string, unknown>>).primary!.model as string;

    // default.yaml
    expect((defaultYaml.local as Record<string, unknown>).model).toBe(primaryModel);

    // autonomous.yaml agent loop reasoning
    expect((autoYaml.agent_loop as Record<string, unknown>).reasoning_model).toBe(primaryModel);

    // autonomous.yaml hardware judge
    expect((autoYaml.hardware as Record<string, unknown>).bestofn_judge_model).toBe(primaryModel);

    // default.yaml hardware judge
    expect((defaultYaml.hardware as Record<string, unknown>).bestofn_judge_model).toBe(primaryModel);
  });
});
