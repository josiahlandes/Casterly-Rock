import { describe, expect, it, afterEach } from 'vitest';
import { existsSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { ContextManager, createContextManager } from '../src/coding/context-manager/manager.js';

// ─── Temp dir helpers ────────────────────────────────────────────────────────

const TEST_BASE = join(tmpdir(), `casterly-context-mgr-test-${Date.now()}`);

function setupRepo(): void {
  mkdirSync(join(TEST_BASE, 'src'), { recursive: true });
  writeFileSync(join(TEST_BASE, 'src', 'index.ts'), 'export const a = 1;\n');
  writeFileSync(join(TEST_BASE, 'src', 'utils.ts'), 'export function b() { return 2; }\n');
  writeFileSync(join(TEST_BASE, 'readme.md'), '# Test\n');
}

afterEach(() => {
  if (existsSync(TEST_BASE)) {
    rmSync(TEST_BASE, { recursive: true, force: true });
  }
});

function makeMgr(overrides?: Record<string, unknown>) {
  return new ContextManager({
    rootPath: TEST_BASE,
    contextWindow: 128000,
    ...overrides,
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// ContextManager — constructor
// ═══════════════════════════════════════════════════════════════════════════════

describe('ContextManager — constructor', () => {
  it('creates instance with rootPath', () => {
    setupRepo();
    const mgr = makeMgr();
    expect(mgr.getRootPath()).toBeTruthy();
  });

  it('resolves relative path', () => {
    setupRepo();
    const mgr = makeMgr();
    // rootPath should be absolute
    expect(mgr.getRootPath().startsWith('/')).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ContextManager — system prompt
// ═══════════════════════════════════════════════════════════════════════════════

describe('ContextManager — system prompt', () => {
  it('starts with empty system prompt', () => {
    setupRepo();
    const mgr = makeMgr();
    expect(mgr.getSystemPrompt()).toBe('');
  });

  it('sets and gets system prompt', () => {
    setupRepo();
    const mgr = makeMgr();
    mgr.setSystemPrompt('You are a coding assistant.');
    expect(mgr.getSystemPrompt()).toBe('You are a coding assistant.');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ContextManager — file management
// ═══════════════════════════════════════════════════════════════════════════════

describe('ContextManager — file management', () => {
  it('adds a file', async () => {
    setupRepo();
    const mgr = makeMgr();
    const result = await mgr.addFile('src/index.ts');
    expect(result.success).toBe(true);
    expect(result.tokens).toBeGreaterThan(0);
  });

  it('tracks active files', async () => {
    setupRepo();
    const mgr = makeMgr();
    await mgr.addFile('src/index.ts');
    await mgr.addFile('src/utils.ts');
    const active = mgr.getActiveFiles();
    expect(active).toHaveLength(2);
    expect(active).toContain('src/index.ts');
    expect(active).toContain('src/utils.ts');
  });

  it('checks if file is active', async () => {
    setupRepo();
    const mgr = makeMgr();
    await mgr.addFile('src/index.ts');
    expect(mgr.isFileActive('src/index.ts')).toBe(true);
    expect(mgr.isFileActive('src/utils.ts')).toBe(false);
  });

  it('removes a file', async () => {
    setupRepo();
    const mgr = makeMgr();
    await mgr.addFile('src/index.ts');
    const removed = mgr.removeFile('src/index.ts');
    expect(removed).toBe(true);
    expect(mgr.isFileActive('src/index.ts')).toBe(false);
  });

  it('returns false when removing nonexistent file', () => {
    setupRepo();
    const mgr = makeMgr();
    expect(mgr.removeFile('nonexistent.ts')).toBe(false);
  });

  it('gets file content', async () => {
    setupRepo();
    const mgr = makeMgr();
    await mgr.addFile('src/index.ts');
    const content = mgr.getFileContent('src/index.ts');
    expect(content).toBeDefined();
    expect(content!.content).toContain('export const a');
    expect(content!.tokens).toBeGreaterThan(0);
  });

  it('marks file as modified', async () => {
    setupRepo();
    const mgr = makeMgr();
    await mgr.addFile('src/index.ts');
    mgr.markFileModified('src/index.ts');
    const modified = mgr.getModifiedFiles();
    expect(modified).toContain('src/index.ts');
  });

  it('refreshes file content', async () => {
    setupRepo();
    const mgr = makeMgr();
    await mgr.addFile('src/index.ts');
    // Modify the file on disk
    writeFileSync(join(TEST_BASE, 'src', 'index.ts'), 'export const a = 42;\n');
    const result = await mgr.refreshFile('src/index.ts');
    expect(result.success).toBe(true);
    const content = mgr.getFileContent('src/index.ts');
    expect(content!.content).toContain('42');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ContextManager — conversation
// ═══════════════════════════════════════════════════════════════════════════════

describe('ContextManager — conversation', () => {
  it('starts with empty conversation', () => {
    setupRepo();
    const mgr = makeMgr();
    expect(mgr.getConversation()).toHaveLength(0);
  });

  it('adds messages', () => {
    setupRepo();
    const mgr = makeMgr();
    const msg = mgr.addMessage('user', 'Hello');
    expect(msg.role).toBe('user');
    expect(msg.content).toBe('Hello');
    expect(msg.tokens).toBeGreaterThan(0);
    expect(msg.timestamp).toBeTruthy();
    expect(mgr.getConversation()).toHaveLength(1);
  });

  it('tracks conversation tokens', () => {
    setupRepo();
    const mgr = makeMgr();
    mgr.addMessage('user', 'Hello');
    mgr.addMessage('assistant', 'Hi there');
    const tokens = mgr.getConversationTokens();
    expect(tokens).toBeGreaterThan(0);
  });

  it('clears conversation', () => {
    setupRepo();
    const mgr = makeMgr();
    mgr.addMessage('user', 'Hello');
    mgr.addMessage('assistant', 'Hi');
    mgr.clearConversation();
    expect(mgr.getConversation()).toHaveLength(0);
    expect(mgr.getConversationTokens()).toBe(0);
  });

  it('trims conversation to token budget', () => {
    setupRepo();
    const mgr = makeMgr();
    // Add many messages
    for (let i = 0; i < 10; i++) {
      mgr.addMessage('user', `Message ${i} with some content to use tokens`);
      mgr.addMessage('assistant', `Reply ${i} with some content to use tokens`);
    }
    const beforeCount = mgr.getConversation().length;
    const beforeTokens = mgr.getConversationTokens();
    // Trim to a small budget
    mgr.trimConversation(Math.floor(beforeTokens / 2));
    expect(mgr.getConversation().length).toBeLessThan(beforeCount);
  });

  it('returns defensive copy of conversation', () => {
    setupRepo();
    const mgr = makeMgr();
    mgr.addMessage('user', 'Hello');
    const conv = mgr.getConversation();
    conv.push({ role: 'user', content: 'injected', tokens: 1, timestamp: '' });
    expect(mgr.getConversation()).toHaveLength(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ContextManager — tool results
// ═══════════════════════════════════════════════════════════════════════════════

describe('ContextManager — tool results', () => {
  it('starts with no tool results', () => {
    setupRepo();
    const mgr = makeMgr();
    expect(mgr.getToolResults()).toHaveLength(0);
  });

  it('adds tool results', () => {
    setupRepo();
    const mgr = makeMgr();
    const result = mgr.addToolResult('bash', { cmd: 'ls' }, 'file1\nfile2', true);
    expect(result.tool).toBe('bash');
    expect(result.success).toBe(true);
    expect(result.tokens).toBeGreaterThan(0);
    expect(mgr.getToolResults()).toHaveLength(1);
  });

  it('tracks tool result tokens', () => {
    setupRepo();
    const mgr = makeMgr();
    mgr.addToolResult('bash', {}, 'output', true);
    expect(mgr.getToolResultTokens()).toBeGreaterThan(0);
  });

  it('clears tool results', () => {
    setupRepo();
    const mgr = makeMgr();
    mgr.addToolResult('bash', {}, 'output', true);
    mgr.clearToolResults();
    expect(mgr.getToolResults()).toHaveLength(0);
    expect(mgr.getToolResultTokens()).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ContextManager — token budget
// ═══════════════════════════════════════════════════════════════════════════════

describe('ContextManager — token budget', () => {
  it('returns usage stats', () => {
    setupRepo();
    const mgr = makeMgr();
    mgr.setSystemPrompt('You are a helper.');
    const stats = mgr.getUsageStats();
    expect(stats.system).toBeGreaterThan(0);
    expect(typeof stats.repoMap).toBe('number');
    expect(typeof stats.files).toBe('number');
    expect(typeof stats.conversation).toBe('number');
    expect(typeof stats.tools).toBe('number');
  });

  it('returns token budget', () => {
    setupRepo();
    const mgr = makeMgr();
    const budget = mgr.getTokenBudget();
    expect(budget.total).toBe(128000);
    expect(typeof budget.system).toBe('number');
    expect(typeof budget.response).toBe('number');
  });

  it('returns remaining tokens', () => {
    setupRepo();
    const mgr = makeMgr();
    const remaining = mgr.getRemainingTokens();
    expect(remaining).toBeGreaterThan(0);
    expect(remaining).toBeLessThanOrEqual(128000);
  });

  it('canFit checks available space', () => {
    setupRepo();
    const mgr = makeMgr();
    expect(mgr.canFit(100)).toBe(true);
    expect(mgr.canFit(999999)).toBe(false);
  });

  it('returns budget summary string', () => {
    setupRepo();
    const mgr = makeMgr();
    const summary = mgr.getBudgetSummary();
    expect(summary).toContain('Context Budget');
    expect(summary).toContain('System:');
    expect(summary).toContain('Remaining:');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ContextManager — context building
// ═══════════════════════════════════════════════════════════════════════════════

describe('ContextManager — buildContext', () => {
  it('builds complete context', async () => {
    setupRepo();
    const mgr = makeMgr();
    mgr.setSystemPrompt('You are a helper.');
    await mgr.addFile('src/index.ts');
    mgr.addMessage('user', 'Hello');
    mgr.addToolResult('bash', {}, 'output', true);

    const context = mgr.buildContext();
    expect(context.systemPrompt).toBe('You are a helper.');
    expect(context.fileContents.size).toBe(1);
    expect(context.conversation).toHaveLength(1);
    expect(context.toolResults).toHaveLength(1);
    expect(context.tokenUsage).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ContextManager — reset
// ═══════════════════════════════════════════════════════════════════════════════

describe('ContextManager — reset', () => {
  it('clears all state', async () => {
    setupRepo();
    const mgr = makeMgr();
    await mgr.addFile('src/index.ts');
    mgr.addMessage('user', 'Hello');
    mgr.addToolResult('bash', {}, 'output', true);

    mgr.reset();
    expect(mgr.getActiveFiles()).toHaveLength(0);
    expect(mgr.getConversation()).toHaveLength(0);
    expect(mgr.getToolResults()).toHaveLength(0);
    expect(mgr.getRepoMap()).toBeNull();
    expect(mgr.getFormattedRepoMap()).toBe('');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// createContextManager factory
// ═══════════════════════════════════════════════════════════════════════════════

describe('createContextManager', () => {
  it('creates a ContextManager instance', () => {
    setupRepo();
    const mgr = createContextManager({ rootPath: TEST_BASE });
    expect(mgr).toBeInstanceOf(ContextManager);
  });
});
