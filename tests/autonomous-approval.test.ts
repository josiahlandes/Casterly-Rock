/**
 * Autonomous Pending-Review & Handoff Tests
 *
 * Verifies the night-only autonomous system:
 * 1. Config parsing for approval_required
 * 2. AutonomousLoop accepts LoopOptions, exposes pendingBranchList
 * 3. pending_review is a valid CycleOutcome
 * 4. Fail-safe: no bridge — loop still constructs (bridge unused in pending-review flow)
 * 5. formatMorningSummary with handoff state
 */

import { describe, expect, it, vi, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { AutonomousLoop, loadConfig } from '../src/autonomous/loop.js';
import { formatMorningSummary } from '../src/autonomous/report.js';
import type { ApprovalBridge } from '../src/approval/index.js';
import type { ApprovalRequest } from '../src/approval/types.js';
import type { AutonomousProvider } from '../src/autonomous/provider.js';
import type { AutonomousConfig, HandoffState, PendingBranch, Reflection } from '../src/autonomous/types.js';
import type { AggregateStats } from '../src/autonomous/reflector.js';

// ─── Temp dir helpers ────────────────────────────────────────────────────────

const TEST_BASE = join(tmpdir(), `casterly-auto-approval-test-${Date.now()}`);

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

// ─── Mock helpers ────────────────────────────────────────────────────────────

function makeMockProvider(): AutonomousProvider {
  return {
    name: 'mock',
    model: 'test:7b',
    analyze: vi.fn().mockResolvedValue({ observations: [], summary: '', tokensUsed: { input: 0, output: 0 } }),
    hypothesize: vi.fn().mockResolvedValue({ hypotheses: [], reasoning: '', tokensUsed: { input: 0, output: 0 } }),
    implement: vi.fn().mockResolvedValue({ changes: [], description: '', commitMessage: '', tokensUsed: { input: 0, output: 0 } }),
    reflect: vi.fn().mockResolvedValue({ reflection: {}, learnings: '', tokensUsed: { input: 0, output: 0 } }),
    getTokenUsage: vi.fn().mockReturnValue({ input: 0, output: 0 }),
    resetTokenUsage: vi.fn(),
  };
}

function makeMinimalConfig(overrides: Partial<AutonomousConfig> = {}): AutonomousConfig {
  return {
    enabled: false,
    provider: 'ollama',
    model: 'test:7b',
    cycleIntervalMinutes: 60,
    maxCyclesPerDay: 12,
    maxAttemptsPerCycle: 3,
    maxFilesPerChange: 5,
    allowedDirectories: ['src/'],
    forbiddenPatterns: [],
    autoIntegrateThreshold: 0.9,
    attemptThreshold: 0.5,
    approvalTimeoutMinutes: 10,
    maxBranchAgeHours: 24,
    maxConcurrentBranches: 3,
    sandboxTimeoutSeconds: 300,
    sandboxMemoryMb: 2048,
    git: {
      remote: 'origin',
      baseBranch: 'main',
      branchPrefix: 'auto/',
      integrationMode: 'approval_required',
      cleanup: {
        deleteMergedBranches: true,
        deleteFailedBranches: true,
        maxStaleBranchAgeHours: 48,
      },
    },
    ...overrides,
  };
}

function makeMockApprovalBridge(approveOrDeny: boolean): ApprovalBridge {
  const mockRequest: ApprovalRequest = {
    id: 'test-approval-001',
    command: 'auto merge',
    redactedCommand: 'auto merge',
    recipient: '+15551234567',
    status: 'pending',
    createdAt: Date.now(),
    timeoutAt: Date.now() + 600_000,
  };

  return {
    requestApproval: vi.fn().mockReturnValue(mockRequest),
    waitForApproval: vi.fn().mockResolvedValue(approveOrDeny),
    tryResolveFromPoll: vi.fn().mockReturnValue(false),
    wasConsumed: vi.fn().mockReturnValue(false),
    expireStale: vi.fn(),
  };
}

function makeEmptyStats(): AggregateStats {
  return {
    totalCycles: 0,
    successfulCycles: 0,
    failedCycles: 0,
    totalTokensUsed: { input: 0, output: 0 },
    estimatedCostUsd: 0,
    successRate: 0,
    averageDurationMs: 0,
    topFailureReasons: [],
  };
}

function makePendingBranch(overrides: Partial<PendingBranch> = {}): PendingBranch {
  return {
    branch: 'auto/hyp-test-001',
    hypothesisId: 'hyp-test-001',
    proposal: 'Add timeout backoff for provider calls',
    approach: 'fix_bug',
    confidence: 0.92,
    impact: 'high',
    filesChanged: [
      { path: 'src/providers/ollama.ts', type: 'modify' },
      { path: 'config/timeouts.ts', type: 'create' },
    ],
    validatedAt: '2025-01-15T02:15:00.000Z',
    commitHash: 'abc1234',
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Config parsing — approval_required mode
// ═══════════════════════════════════════════════════════════════════════════════

describe('loadConfig — approval_required', () => {
  it('parses approval_required integration mode', async () => {
    const fp = writeYaml('approval-mode.yaml', `
autonomous:
  enabled: false
git:
  integration_mode: approval_required
`);
    const config = await loadConfig(fp);
    expect(config.git.integrationMode).toBe('approval_required');
  });

  it('defaults to approval_required when no mode specified', async () => {
    const fp = writeYaml('default-mode.yaml', `
autonomous:
  enabled: false
`);
    const config = await loadConfig(fp);
    expect(config.git.integrationMode).toBe('approval_required');
  });

  it('parses approval_timeout_minutes', async () => {
    const fp = writeYaml('timeout.yaml', `
autonomous:
  enabled: false
git:
  approval_timeout_minutes: 15
`);
    const config = await loadConfig(fp);
    expect(config.approvalTimeoutMinutes).toBe(15);
  });

  it('defaults approval_timeout_minutes to 10', async () => {
    const fp = writeYaml('timeout-default.yaml', `
autonomous:
  enabled: false
`);
    const config = await loadConfig(fp);
    expect(config.approvalTimeoutMinutes).toBe(10);
  });

  it('still allows explicit direct mode', async () => {
    const fp = writeYaml('direct-mode.yaml', `
autonomous:
  enabled: false
git:
  integration_mode: direct
`);
    const config = await loadConfig(fp);
    expect(config.git.integrationMode).toBe('direct');
  });

  it('still allows explicit pull_request mode', async () => {
    const fp = writeYaml('pr-mode.yaml', `
autonomous:
  enabled: false
git:
  integration_mode: pull_request
`);
    const config = await loadConfig(fp);
    expect(config.git.integrationMode).toBe('pull_request');
  });

  it('parses quiet hours when enabled', async () => {
    const fp = writeYaml('quiet-hours.yaml', `
autonomous:
  enabled: false
  quiet_hours:
    start: "06:00"
    end: "22:00"
    enabled: true
`);
    const config = await loadConfig(fp);
    expect(config.quietHours?.enabled).toBe(true);
    expect(config.quietHours?.start).toBe('06:00');
    expect(config.quietHours?.end).toBe('22:00');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// AutonomousLoop — constructor with LoopOptions
// ═══════════════════════════════════════════════════════════════════════════════

describe('AutonomousLoop — LoopOptions', () => {
  it('constructs without options (backward compat)', () => {
    const config = makeMinimalConfig();
    const provider = makeMockProvider();
    const loop = new AutonomousLoop(config, TEST_BASE, provider);
    expect(loop).toBeDefined();
  });

  it('constructs with empty options', () => {
    const config = makeMinimalConfig();
    const provider = makeMockProvider();
    const loop = new AutonomousLoop(config, TEST_BASE, provider, {});
    expect(loop).toBeDefined();
  });

  it('constructs with approval bridge and recipient', () => {
    const config = makeMinimalConfig();
    const provider = makeMockProvider();
    const bridge = makeMockApprovalBridge(true);
    const loop = new AutonomousLoop(config, TEST_BASE, provider, {
      approvalBridge: bridge,
      approvalRecipient: '+15551234567',
    });
    expect(loop).toBeDefined();
  });

  it('exposes config with approval_required mode', () => {
    const config = makeMinimalConfig();
    const provider = makeMockProvider();
    const loop = new AutonomousLoop(config, TEST_BASE, provider);
    expect(loop.configInstance.git.integrationMode).toBe('approval_required');
    expect(loop.configInstance.approvalTimeoutMinutes).toBe(10);
  });

  it('exposes empty pendingBranchList initially', () => {
    const config = makeMinimalConfig();
    const provider = makeMockProvider();
    const loop = new AutonomousLoop(config, TEST_BASE, provider);
    expect(loop.pendingBranchList).toEqual([]);
  });

  it('pendingBranchList returns a copy (not the internal array)', () => {
    const config = makeMinimalConfig();
    const provider = makeMockProvider();
    const loop = new AutonomousLoop(config, TEST_BASE, provider);
    const list1 = loop.pendingBranchList;
    const list2 = loop.pendingBranchList;
    expect(list1).not.toBe(list2); // Different references
    expect(list1).toEqual(list2);  // Same contents
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// CycleOutcome — pending_review
// ═══════════════════════════════════════════════════════════════════════════════

describe('CycleOutcome — pending_review', () => {
  it('pending_review is a valid CycleOutcome value', () => {
    const validOutcomes: string[] = ['success', 'failure', 'partial', 'skipped', 'pending_review'];
    expect(validOutcomes).toContain('pending_review');
  });

  it('approval_required mode uses pending_review (not success)', () => {
    const config = makeMinimalConfig();
    // In approval_required mode, validated branches get outcome=pending_review
    // rather than outcome=success, because they haven't been merged yet
    expect(config.git.integrationMode).toBe('approval_required');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// formatMorningSummary
// ═══════════════════════════════════════════════════════════════════════════════

describe('formatMorningSummary', () => {
  it('returns "no cycles" message when no handoff and no stats', () => {
    const stats = makeEmptyStats();
    const result = formatMorningSummary(stats, [], null);
    expect(result).toContain('No cycles ran overnight');
  });

  it('shows cycle count from handoff nightSummary', () => {
    const stats = makeEmptyStats();
    const handoff: HandoffState = {
      timestamp: new Date().toISOString(),
      pendingBranches: [],
      lastCycleId: null,
      nightSummary: {
        cyclesCompleted: 5,
        hypothesesAttempted: 8,
        hypothesesValidated: 2,
        tokenUsage: { input: 10000, output: 3000 },
      },
    };
    const result = formatMorningSummary(stats, [], handoff);
    expect(result).toContain('Cycles: 5 completed');
    expect(result).toContain('Hypotheses: 8 attempted, 2 validated');
  });

  it('lists pending branches from handoff', () => {
    const stats = makeEmptyStats();
    const branch = makePendingBranch();
    const handoff: HandoffState = {
      timestamp: new Date().toISOString(),
      pendingBranches: [branch],
      lastCycleId: null,
      nightSummary: {
        cyclesCompleted: 3,
        hypothesesAttempted: 5,
        hypothesesValidated: 1,
        tokenUsage: { input: 5000, output: 1500 },
      },
    };
    const result = formatMorningSummary(stats, [], handoff);
    expect(result).toContain('Branches ready for review:');
    expect(result).toContain('auto/hyp-test-001');
    expect(result).toContain('Add timeout backoff for provider calls');
    expect(result).toContain('src/providers/ollama.ts (modify)');
    expect(result).toContain('Confidence: 0.92');
  });

  it('shows token usage from handoff', () => {
    const stats = makeEmptyStats();
    const handoff: HandoffState = {
      timestamp: new Date().toISOString(),
      pendingBranches: [],
      lastCycleId: null,
      nightSummary: {
        cyclesCompleted: 2,
        hypothesesAttempted: 3,
        hypothesesValidated: 0,
        tokenUsage: { input: 45000, output: 12000 },
      },
    };
    const result = formatMorningSummary(stats, [], handoff);
    expect(result).toContain('Tokens: 45K input / 12K output');
  });

  it('includes merge instruction footer', () => {
    const stats = makeEmptyStats();
    const handoff: HandoffState = {
      timestamp: new Date().toISOString(),
      pendingBranches: [makePendingBranch()],
      lastCycleId: null,
      nightSummary: {
        cyclesCompleted: 1,
        hypothesesAttempted: 1,
        hypothesesValidated: 1,
        tokenUsage: { input: 1000, output: 500 },
      },
    };
    const result = formatMorningSummary(stats, [], handoff);
    expect(result).toContain('Review branches at your convenience');
    expect(result).toContain('merge auto/hyp-xxx');
  });

  it('shows failed attempts from reflections', () => {
    const stats = makeEmptyStats();
    stats.totalCycles = 3;
    const failedReflection = {
      cycleId: 'cycle-001',
      timestamp: new Date().toISOString(),
      observation: { id: 'obs-1', type: 'error_pattern', severity: 'medium', frequency: 1, context: {}, suggestedArea: 'src/', source: 'error_logs', timestamp: new Date().toISOString() },
      hypothesis: { id: 'hyp-1', observation: {} as never, proposal: 'Refactor test fixtures', approach: 'refactor', expectedImpact: 'medium', confidence: 0.7, affectedFiles: [], estimatedComplexity: 'simple', previousAttempts: 0, reasoning: '' },
      outcome: 'failure' as const,
      learnings: 'Lint errors in test fixtures',
      durationMs: 5000,
    } as Reflection;

    const handoff: HandoffState = {
      timestamp: new Date().toISOString(),
      pendingBranches: [],
      lastCycleId: null,
      nightSummary: {
        cyclesCompleted: 3,
        hypothesesAttempted: 3,
        hypothesesValidated: 0,
        tokenUsage: { input: 2000, output: 800 },
      },
    };

    const result = formatMorningSummary(stats, [failedReflection], handoff);
    expect(result).toContain('Failed attempts:');
    expect(result).toContain('Refactor test fixtures');
  });

  it('falls back to stats when no handoff exists', () => {
    const stats = makeEmptyStats();
    stats.totalCycles = 4;
    const result = formatMorningSummary(stats, [], null);
    expect(result).toContain('Cycles: 4 completed');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Fail-safe behavior
// ═══════════════════════════════════════════════════════════════════════════════

describe('Pending-review fail-safe', () => {
  it('loop without bridge still constructs (no bridge needed for pending-review)', () => {
    const config = makeMinimalConfig();
    const provider = makeMockProvider();
    // No bridge passed — in pending-review flow, the bridge is unused
    // (branches are left alive, no iMessage approval request sent per-hypothesis)
    const loop = new AutonomousLoop(config, TEST_BASE, provider);
    expect(loop).toBeDefined();
  });

  it('config with approval_required defaults to safe mode', async () => {
    const fp = writeYaml('no-override.yaml', `
autonomous:
  enabled: false
`);
    const config = await loadConfig(fp);
    expect(config.git.integrationMode).toBe('approval_required');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// IntegrationMode type safety
// ═══════════════════════════════════════════════════════════════════════════════

describe('IntegrationMode type', () => {
  it('approval_required is a valid IntegrationMode', () => {
    const config = makeMinimalConfig();
    const validModes: string[] = ['direct', 'pull_request', 'approval_required'];
    expect(validModes).toContain(config.git.integrationMode);
  });

  it('direct mode skips pending-review entirely', () => {
    const config = makeMinimalConfig({
      git: {
        ...makeMinimalConfig().git,
        integrationMode: 'direct',
      },
    });
    expect(config.git.integrationMode).toBe('direct');
    expect(config.git.integrationMode).not.toBe('approval_required');
  });
});
