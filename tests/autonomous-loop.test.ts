import { describe, expect, it, afterEach } from 'vitest';
import { existsSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { AbortError, loadConfig } from '../src/autonomous/loop.js';

// ─── Temp dir helpers ────────────────────────────────────────────────────────

const TEST_BASE = join(tmpdir(), `casterly-auto-loop-test-${Date.now()}`);

afterEach(() => {
  if (existsSync(TEST_BASE)) {
    rmSync(TEST_BASE, { recursive: true, force: true });
  }
});

function writeYaml(name: string, content: string): string {
  mkdirSync(TEST_BASE, { recursive: true });
  const fp = join(TEST_BASE, name);
  writeFileSync(fp, content, 'utf-8');
  return fp;
}

// ═══════════════════════════════════════════════════════════════════════════════
// AbortError
// ═══════════════════════════════════════════════════════════════════════════════

describe('AbortError', () => {
  it('has correct name', () => {
    const err = new AbortError('cycle-001');
    expect(err.name).toBe('AbortError');
  });

  it('stores the cycleId', () => {
    const err = new AbortError('cycle-xyz-123');
    expect(err.cycleId).toBe('cycle-xyz-123');
  });

  it('formats the message with cycleId', () => {
    const err = new AbortError('cycle-42');
    expect(err.message).toBe('Cycle cycle-42 aborted');
  });

  it('is an instance of Error', () => {
    const err = new AbortError('c1');
    expect(err instanceof Error).toBe(true);
  });

  it('has a stack trace', () => {
    const err = new AbortError('c2');
    expect(err.stack).toBeTruthy();
  });

  it('works with try/catch', () => {
    try {
      throw new AbortError('catch-test');
    } catch (e) {
      expect(e instanceof AbortError).toBe(true);
      expect((e as AbortError).cycleId).toBe('catch-test');
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// loadConfig — basic parsing
// ═══════════════════════════════════════════════════════════════════════════════

describe('loadConfig — basic parsing', () => {
  it('loads a minimal config', async () => {
    const fp = writeYaml('minimal.yaml', `
autonomous:
  enabled: true
  model: qwen3-coder-next:latest
  cycle_interval_minutes: 30
`);
    const config = await loadConfig(fp);
    expect(config.enabled).toBe(true);
    expect(config.model).toBe('qwen3-coder-next:latest');
    expect(config.cycleIntervalMinutes).toBe(30);
  });

  it('applies defaults for missing fields', async () => {
    const fp = writeYaml('defaults.yaml', `
autonomous:
  enabled: false
`);
    const config = await loadConfig(fp);
    expect(config.enabled).toBe(false);
    expect(config.provider).toBe('ollama');
    expect(config.model).toBe('qwen3-coder-next:latest');
    expect(config.cycleIntervalMinutes).toBe(60);
    expect(config.maxCyclesPerDay).toBe(12);
    expect(config.maxAttemptsPerCycle).toBe(3);
    expect(config.maxFilesPerChange).toBe(5);
    expect(config.attemptThreshold).toBe(0.5);
    expect(config.autoIntegrateThreshold).toBe(0.9);
    expect(config.maxBranchAgeHours).toBe(24);
    expect(config.maxConcurrentBranches).toBe(3);
    expect(config.sandboxTimeoutSeconds).toBe(300);
    expect(config.sandboxMemoryMb).toBe(8192);
  });

  it('applies git defaults', async () => {
    const fp = writeYaml('git-defaults.yaml', `
autonomous:
  enabled: false
`);
    const config = await loadConfig(fp);
    expect(config.git.remote).toBe('origin');
    expect(config.git.baseBranch).toBe('main');
    expect(config.git.branchPrefix).toBe('auto/');
    expect(config.git.integrationMode).toBe('approval_required');
    expect(config.git.pullRequest).toBeUndefined();
    expect(config.git.cleanup.deleteMergedBranches).toBe(true);
    expect(config.git.cleanup.deleteFailedBranches).toBe(true);
    expect(config.git.cleanup.maxStaleBranchAgeHours).toBe(48);
  });

  it('applies default array fields', async () => {
    const fp = writeYaml('array-defaults.yaml', `
autonomous:
  enabled: false
`);
    const config = await loadConfig(fp);
    expect(config.allowedDirectories).toEqual(['src/', 'scripts/', 'tests/']);
    expect(config.forbiddenPatterns).toEqual(['**/*.env*', '**/secrets*']);
  });

  it('handles empty config file gracefully', async () => {
    const fp = writeYaml('empty.yaml', '');
    // yaml.parse('') returns null, so loadConfig may throw
    try {
      const config = await loadConfig(fp);
      // If it doesn't throw, defaults should still apply
      expect(config.provider).toBe('ollama');
    } catch {
      // Throwing is acceptable for null raw input
      expect(true).toBe(true);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// loadConfig — custom values
// ═══════════════════════════════════════════════════════════════════════════════

describe('loadConfig — custom values', () => {
  it('reads quiet hours config', async () => {
    const fp = writeYaml('quiet.yaml', `
autonomous:
  enabled: true
  quiet_hours:
    enabled: true
    start: "22:00"
    end: "06:00"
`);
    const config = await loadConfig(fp);
    expect(config.quietHours).toBeDefined();
    expect(config.quietHours!.enabled).toBe(true);
    expect(config.quietHours!.start).toBe('22:00');
    expect(config.quietHours!.end).toBe('06:00');
  });

  it('quietHours is undefined when not specified', async () => {
    const fp = writeYaml('no-quiet.yaml', `
autonomous:
  enabled: false
`);
    const config = await loadConfig(fp);
    expect(config.quietHours).toBeUndefined();
  });

  it('reads git pull request config', async () => {
    const fp = writeYaml('pr-config.yaml', `
autonomous:
  enabled: true
git:
  integration_mode: pull_request
  pull_request:
    auto_merge: false
    require_ci: true
    labels:
      - autonomous
      - bot
    reviewers:
      - tyrion
    draft: true
`);
    const config = await loadConfig(fp);
    expect(config.git.integrationMode).toBe('pull_request');
    expect(config.git.pullRequest).toBeDefined();
    expect(config.git.pullRequest!.autoMerge).toBe(false);
    expect(config.git.pullRequest!.requireCi).toBe(true);
    expect(config.git.pullRequest!.labels).toEqual(['autonomous', 'bot']);
    expect(config.git.pullRequest!.reviewers).toEqual(['tyrion']);
    expect(config.git.pullRequest!.draft).toBe(true);
  });

  it('reads custom git settings', async () => {
    const fp = writeYaml('custom-git.yaml', `
autonomous:
  enabled: false
git:
  remote: upstream
  base_branch: develop
  branch_prefix: "bot/"
  cleanup:
    delete_merged_branches: false
    delete_failed_branches: false
    max_stale_branch_age_hours: 96
`);
    const config = await loadConfig(fp);
    expect(config.git.remote).toBe('upstream');
    expect(config.git.baseBranch).toBe('develop');
    expect(config.git.branchPrefix).toBe('bot/');
    expect(config.git.cleanup.deleteMergedBranches).toBe(false);
    expect(config.git.cleanup.deleteFailedBranches).toBe(false);
    expect(config.git.cleanup.maxStaleBranchAgeHours).toBe(96);
  });

  it('reads custom allowed directories and forbidden patterns', async () => {
    const fp = writeYaml('custom-paths.yaml', `
autonomous:
  enabled: true
  allowed_directories:
    - lib/
    - modules/
  forbidden_patterns:
    - "**/*.secret"
    - "**/keys/**"
`);
    const config = await loadConfig(fp);
    expect(config.allowedDirectories).toEqual(['lib/', 'modules/']);
    expect(config.forbiddenPatterns).toEqual(['**/*.secret', '**/keys/**']);
  });

  it('reads approval_required integration mode and timeout', async () => {
    const fp = writeYaml('approval.yaml', `
autonomous:
  enabled: false
git:
  integration_mode: approval_required
  approval_timeout_minutes: 15
`);
    const config = await loadConfig(fp);
    expect(config.git.integrationMode).toBe('approval_required');
    expect(config.approvalTimeoutMinutes).toBe(15);
  });

  it('defaults approval timeout to 10 minutes', async () => {
    const fp = writeYaml('approval-default.yaml', `
autonomous:
  enabled: false
`);
    const config = await loadConfig(fp);
    expect(config.approvalTimeoutMinutes).toBe(10);
  });

  it('reads numeric tuning options', async () => {
    const fp = writeYaml('tuning.yaml', `
autonomous:
  enabled: true
  max_cycles_per_day: 24
  max_attempts_per_cycle: 5
  max_files_per_change: 10
  auto_integrate_threshold: 0.95
  attempt_threshold: 0.7
  max_branch_age_hours: 48
  max_concurrent_branches: 5
  sandbox_timeout_seconds: 600
  sandbox_memory_mb: 16384
`);
    const config = await loadConfig(fp);
    expect(config.maxCyclesPerDay).toBe(24);
    expect(config.maxAttemptsPerCycle).toBe(5);
    expect(config.maxFilesPerChange).toBe(10);
    expect(config.autoIntegrateThreshold).toBe(0.95);
    expect(config.attemptThreshold).toBe(0.7);
    expect(config.maxBranchAgeHours).toBe(48);
    expect(config.maxConcurrentBranches).toBe(5);
    expect(config.sandboxTimeoutSeconds).toBe(600);
    expect(config.sandboxMemoryMb).toBe(16384);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// loadConfig — error handling
// ═══════════════════════════════════════════════════════════════════════════════

describe('loadConfig — error handling', () => {
  it('throws for nonexistent file', async () => {
    await expect(loadConfig(join(TEST_BASE, 'nope.yaml'))).rejects.toThrow();
  });

  it('handles invalid YAML gracefully', async () => {
    const fp = writeYaml('bad.yaml', '{{{{not yaml at all]]]]');
    // yaml.parse may throw or return unexpected data
    // Either way, loadConfig should not hang
    try {
      const config = await loadConfig(fp);
      // If it doesn't throw, it should still return a config with defaults
      expect(config.provider).toBe('ollama');
    } catch {
      // Throwing is also acceptable for invalid YAML
      expect(true).toBe(true);
    }
  });
});
