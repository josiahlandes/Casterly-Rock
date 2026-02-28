import { describe, expect, it } from 'vitest';

import { createModeManager, ModeManager } from '../src/coding/modes/manager.js';
import { CODE_MODE, ARCHITECT_MODE, ASK_MODE, REVIEW_MODE } from '../src/coding/modes/definitions.js';
import type { ToolSchema } from '../src/tools/schemas/types.js';

/**
 * Simulate the daemon's mode-aware tool filtering logic.
 * Mirrors the code in daemon.ts processMessage().
 */
function filterToolsByMode(tools: ToolSchema[], modeManager: ModeManager | undefined): ToolSchema[] {
  if (!modeManager) return tools;
  return tools.filter((t) => modeManager.isToolAllowed(t.name));
}

/**
 * Simulate the daemon's mode-aware system prompt composition.
 */
function composeModePrompt(basePrompt: string, modeManager: ModeManager | undefined): string {
  if (!modeManager) return basePrompt;
  const detection = modeManager.autoDetectAndSwitch(''); // no-op for empty
  if (!detection) return basePrompt;
  const currentMode = modeManager.getCurrentMode();
  const modeSystemPrompt = currentMode.systemPrompt;
  return `${basePrompt}\n\n## Active Mode\n\n${modeSystemPrompt}`;
}

/** Create a minimal ToolSchema for testing */
function mockTool(name: string): ToolSchema {
  return {
    name,
    description: `Mock ${name} tool`,
    inputSchema: { type: 'object' as const, properties: {}, required: [] },
  };
}

// Realistic tool names matching the actual registry
const ALL_TOOLS: ToolSchema[] = [
  mockTool('bash'),
  mockTool('read_file'),
  mockTool('write_file'),
  mockTool('list_files'),
  mockTool('search_files'),
  mockTool('read_document'),
  mockTool('edit_file'),
  mockTool('glob_files'),
  mockTool('grep_files'),
  mockTool('validate_files'),
  mockTool('send_message'),
  mockTool('schedule_reminder'),
  mockTool('cancel_reminder'),
  mockTool('list_reminders'),
];

// ═══════════════════════════════════════════════════════════════════════════════
// Per-session mode manager lifecycle
// ═══════════════════════════════════════════════════════════════════════════════

describe('Per-session ModeManager lifecycle', () => {
  it('creates a fresh mode manager per peer', () => {
    const managers = new Map<string, ModeManager>();
    const peerA = '+1234567890';
    const peerB = '+0987654321';

    managers.set(peerA, createModeManager());
    managers.set(peerB, createModeManager());

    expect(managers.get(peerA)!.getCurrentModeName()).toBe('code');
    expect(managers.get(peerB)!.getCurrentModeName()).toBe('code');

    // Switching peer A does not affect peer B
    managers.get(peerA)!.switchMode('architect');
    expect(managers.get(peerA)!.getCurrentModeName()).toBe('architect');
    expect(managers.get(peerB)!.getCurrentModeName()).toBe('code');
  });

  it('persists mode across messages within a session', () => {
    const manager = createModeManager();

    // First message switches to architect
    manager.autoDetectAndSwitch('plan the implementation for auth');
    expect(manager.getCurrentModeName()).toBe('architect');

    // Second message — ambiguous input keeps architect mode
    manager.autoDetectAndSwitch('hello');
    expect(manager.getCurrentModeName()).toBe('architect');

    // Third message — explicit switch to code
    manager.autoDetectAndSwitch('/code');
    expect(manager.getCurrentModeName()).toBe('code');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Mode-aware tool filtering (daemon integration)
// ═══════════════════════════════════════════════════════════════════════════════

describe('Mode-aware tool filtering', () => {
  it('code mode: returns all tools (no filtering)', () => {
    const manager = createModeManager();
    const filtered = filterToolsByMode(ALL_TOOLS, manager);
    expect(filtered).toHaveLength(ALL_TOOLS.length);
  });

  it('architect mode: filters out edit_file, write_file, bash, send_message', () => {
    const manager = createModeManager();
    manager.switchMode('architect');
    const filtered = filterToolsByMode(ALL_TOOLS, manager);

    const names = filtered.map((t) => t.name);
    expect(names).not.toContain('edit_file');
    expect(names).not.toContain('write_file');
    expect(names).not.toContain('bash');
    expect(names).not.toContain('send_message');
    expect(names).not.toContain('validate_files');
  });

  it('architect mode: keeps read-only tools', () => {
    const manager = createModeManager();
    manager.switchMode('architect');
    const filtered = filterToolsByMode(ALL_TOOLS, manager);

    const names = filtered.map((t) => t.name);
    expect(names).toContain('read_file');
    expect(names).toContain('glob_files');
    expect(names).toContain('grep_files');
    expect(names).toContain('read_document');
    expect(names).toContain('list_files');
    expect(names).toContain('search_files');
  });

  it('architect mode: filters out scheduler tools (not in allowedTools)', () => {
    const manager = createModeManager();
    manager.switchMode('architect');
    const filtered = filterToolsByMode(ALL_TOOLS, manager);

    const names = filtered.map((t) => t.name);
    expect(names).not.toContain('schedule_reminder');
    expect(names).not.toContain('cancel_reminder');
    expect(names).not.toContain('list_reminders');
  });

  it('ask mode: same filtering as architect mode', () => {
    const manager = createModeManager();
    manager.switchMode('ask');
    const filtered = filterToolsByMode(ALL_TOOLS, manager);

    const names = filtered.map((t) => t.name);
    expect(names).toContain('read_file');
    expect(names).not.toContain('bash');
    expect(names).not.toContain('edit_file');
  });

  it('review mode: same filtering as architect mode', () => {
    const manager = createModeManager();
    manager.switchMode('review');
    const filtered = filterToolsByMode(ALL_TOOLS, manager);

    const names = filtered.map((t) => t.name);
    expect(names).toContain('read_file');
    expect(names).not.toContain('bash');
    expect(names).not.toContain('write_file');
  });

  it('no mode manager: returns all tools unfiltered', () => {
    const filtered = filterToolsByMode(ALL_TOOLS, undefined);
    expect(filtered).toHaveLength(ALL_TOOLS.length);
  });

  it('mode switch changes tool availability', () => {
    const manager = createModeManager();

    // Start in code — all tools
    let filtered = filterToolsByMode(ALL_TOOLS, manager);
    expect(filtered).toHaveLength(ALL_TOOLS.length);

    // Switch to review — restricted
    manager.switchMode('review');
    filtered = filterToolsByMode(ALL_TOOLS, manager);
    expect(filtered.length).toBeLessThan(ALL_TOOLS.length);

    // Switch back to code — all tools again
    manager.switchMode('code');
    filtered = filterToolsByMode(ALL_TOOLS, manager);
    expect(filtered).toHaveLength(ALL_TOOLS.length);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Mode-aware system prompt injection
// ═══════════════════════════════════════════════════════════════════════════════

describe('Mode-aware system prompt injection', () => {
  it('injects active mode section into system prompt', () => {
    const manager = createModeManager();
    manager.switchMode('architect');
    const currentMode = manager.getCurrentMode();
    const basePrompt = 'You are Tyrion.';
    const composed = `${basePrompt}\n\n## Active Mode\n\n${currentMode.systemPrompt}`;

    expect(composed).toContain('You are Tyrion.');
    expect(composed).toContain('## Active Mode');
    expect(composed).toContain('ARCHITECT mode');
  });

  it('code mode includes code mode system prompt', () => {
    const manager = createModeManager();
    const currentMode = manager.getCurrentMode();
    expect(currentMode.systemPrompt).toContain('CODE mode');
  });

  it('ask mode includes ask mode system prompt', () => {
    const manager = createModeManager();
    manager.switchMode('ask');
    const currentMode = manager.getCurrentMode();
    expect(currentMode.systemPrompt).toContain('ASK mode');
  });

  it('review mode includes review mode system prompt', () => {
    const manager = createModeManager();
    manager.switchMode('review');
    const currentMode = manager.getCurrentMode();
    expect(currentMode.systemPrompt).toContain('REVIEW mode');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Mode detection → tool filtering end-to-end
// ═══════════════════════════════════════════════════════════════════════════════

describe('Mode detection → tool filtering (end-to-end)', () => {
  it('"plan the implementation" → architect → no bash', () => {
    const manager = createModeManager();
    manager.autoDetectAndSwitch('plan the implementation for auth');
    expect(manager.getCurrentModeName()).toBe('architect');

    const filtered = filterToolsByMode(ALL_TOOLS, manager);
    const names = filtered.map((t) => t.name);
    expect(names).not.toContain('bash');
    expect(names).not.toContain('edit_file');
  });

  it('"what does the router do?" → ask → no write_file', () => {
    const manager = createModeManager();
    manager.autoDetectAndSwitch('what does the router do?');
    expect(manager.getCurrentModeName()).toBe('ask');

    const filtered = filterToolsByMode(ALL_TOOLS, manager);
    const names = filtered.map((t) => t.name);
    expect(names).not.toContain('write_file');
    expect(names).toContain('read_file');
  });

  it('"review my code for bugs" → review → read-only', () => {
    const manager = createModeManager();
    manager.autoDetectAndSwitch('review my code for bugs');
    expect(manager.getCurrentModeName()).toBe('review');

    const filtered = filterToolsByMode(ALL_TOOLS, manager);
    const names = filtered.map((t) => t.name);
    expect(names).toContain('read_file');
    expect(names).not.toContain('edit_file');
  });

  it('"implement the auth module" → code → all tools', () => {
    const manager = createModeManager();
    manager.autoDetectAndSwitch('implement the auth module');
    expect(manager.getCurrentModeName()).toBe('code');

    const filtered = filterToolsByMode(ALL_TOOLS, manager);
    expect(filtered).toHaveLength(ALL_TOOLS.length);
  });

  it('"/architect" → architect → restricted tools', () => {
    const manager = createModeManager();
    manager.autoDetectAndSwitch('/architect');
    expect(manager.getCurrentModeName()).toBe('architect');

    const filtered = filterToolsByMode(ALL_TOOLS, manager);
    expect(filtered.length).toBeLessThan(ALL_TOOLS.length);
  });

  it('ambiguous input keeps current mode', () => {
    const manager = createModeManager();
    // Switch to architect first
    manager.autoDetectAndSwitch('/architect');
    expect(manager.getCurrentModeName()).toBe('architect');

    // Ambiguous input — stays in architect
    manager.autoDetectAndSwitch('ok sounds good');
    expect(manager.getCurrentModeName()).toBe('architect');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Preferred model per mode
// ═══════════════════════════════════════════════════════════════════════════════

describe('Preferred model per mode', () => {
  it('code mode prefers qwen3.5:122b', () => {
    const manager = createModeManager();
    expect(manager.getPreferredModel()).toBe('qwen3.5:122b');
  });

  it('architect mode prefers qwen3.5:122b', () => {
    const manager = createModeManager();
    manager.switchMode('architect');
    expect(manager.getPreferredModel()).toBe('qwen3.5:122b');
  });

  it('ask mode prefers qwen3.5:122b', () => {
    const manager = createModeManager();
    manager.switchMode('ask');
    expect(manager.getPreferredModel()).toBe('qwen3.5:122b');
  });

  it('review mode prefers qwen3.5:122b', () => {
    const manager = createModeManager();
    manager.switchMode('review');
    expect(manager.getPreferredModel()).toBe('qwen3.5:122b');
  });

  it('mode switch changes preferred model', () => {
    const manager = createModeManager();
    expect(manager.getPreferredModel()).toBe('qwen3.5:122b');

    manager.autoDetectAndSwitch('plan the architecture');
    expect(manager.getPreferredModel()).toBe('qwen3.5:122b');

    manager.autoDetectAndSwitch('/code');
    expect(manager.getPreferredModel()).toBe('qwen3.5:122b');
  });
});
