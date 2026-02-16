import { describe, expect, it, afterEach } from 'vitest';
import { existsSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { buildSystemPrompt } from '../src/interface/prompt-builder.js';
import type { Skill } from '../src/skills/types.js';

// ─── Temp dir helpers ────────────────────────────────────────────────────────

const TEST_BASE = join(tmpdir(), `casterly-prompt-builder-test-${Date.now()}`);

afterEach(() => {
  if (existsSync(TEST_BASE)) {
    rmSync(TEST_BASE, { recursive: true, force: true });
  }
});

function makeSkill(name: string, description: string): Skill {
  return {
    id: name.toLowerCase().replace(/\s+/g, '-'),
    path: `/skills/${name}`,
    frontmatter: {
      name,
      description,
      metadata: {},
    },
    instructions: `# ${name}\n\n${description}`,
    available: true,
    tools: [],
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// buildSystemPrompt — mode: none
// ═══════════════════════════════════════════════════════════════════════════════

describe('buildSystemPrompt — mode: none', () => {
  it('returns minimal identity-only prompt', () => {
    const result = buildSystemPrompt({
      mode: 'none',
      skills: [],
      channel: 'cli',
    });
    expect(result.systemPrompt).toContain('Tyrion');
    expect(result.systemPrompt).toContain('Casterly Rock');
  });

  it('has empty sections except identity', () => {
    const result = buildSystemPrompt({
      mode: 'none',
      skills: [],
      channel: 'cli',
    });
    expect(result.sections.bootstrap).toBe('');
    expect(result.sections.capabilities).toBe('');
    expect(result.sections.skills).toBe('');
    expect(result.sections.memory).toBe('');
    expect(result.sections.safety).toBe('');
    expect(result.sections.context).toBe('');
    expect(result.sections.guidelines).toBe('');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// buildSystemPrompt — mode: full
// ═══════════════════════════════════════════════════════════════════════════════

describe('buildSystemPrompt — mode: full', () => {
  it('includes capabilities section', () => {
    mkdirSync(TEST_BASE, { recursive: true });
    const result = buildSystemPrompt({
      mode: 'full',
      skills: [makeSkill('Calendar', 'Manage calendar events')],
      channel: 'imessage',
      workspacePath: TEST_BASE,
      includeMemory: false,
    });
    expect(result.sections.capabilities).toContain('Capabilities');
    expect(result.sections.capabilities).toContain('bash tool');
  });

  it('includes skills section when skills provided', () => {
    mkdirSync(TEST_BASE, { recursive: true });
    const result = buildSystemPrompt({
      mode: 'full',
      skills: [makeSkill('Calendar', 'Manage calendar events')],
      channel: 'imessage',
      workspacePath: TEST_BASE,
      includeMemory: false,
    });
    expect(result.sections.skills).toContain('Calendar');
    expect(result.sections.skills).toContain('Manage calendar events');
  });

  it('includes safety section', () => {
    mkdirSync(TEST_BASE, { recursive: true });
    const result = buildSystemPrompt({
      mode: 'full',
      skills: [],
      channel: 'imessage',
      workspacePath: TEST_BASE,
      includeMemory: false,
    });
    expect(result.sections.safety).toContain('Safety');
    expect(result.sections.safety).toContain('destructive');
  });

  it('includes context section with date and timezone', () => {
    mkdirSync(TEST_BASE, { recursive: true });
    const result = buildSystemPrompt({
      mode: 'full',
      skills: [],
      channel: 'imessage',
      workspacePath: TEST_BASE,
      includeMemory: false,
    });
    expect(result.sections.context).toContain('Current Context');
    expect(result.sections.context).toContain('Date');
    expect(result.sections.context).toContain('Casterly Rock');
  });

  it('includes iMessage guidelines for imessage channel', () => {
    mkdirSync(TEST_BASE, { recursive: true });
    const result = buildSystemPrompt({
      mode: 'full',
      skills: [],
      channel: 'imessage',
      workspacePath: TEST_BASE,
      includeMemory: false,
    });
    expect(result.sections.guidelines).toContain('concise');
    expect(result.sections.guidelines).toContain('text message');
  });

  it('includes CLI guidelines for cli channel', () => {
    mkdirSync(TEST_BASE, { recursive: true });
    const result = buildSystemPrompt({
      mode: 'full',
      skills: [],
      channel: 'cli',
      workspacePath: TEST_BASE,
      includeMemory: false,
    });
    expect(result.sections.guidelines).toContain('Markdown');
  });

  it('includes web guidelines for web channel', () => {
    mkdirSync(TEST_BASE, { recursive: true });
    const result = buildSystemPrompt({
      mode: 'full',
      skills: [],
      channel: 'web',
      workspacePath: TEST_BASE,
      includeMemory: false,
    });
    expect(result.sections.guidelines).toContain('markdown');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// buildSystemPrompt — capabilities
// ═══════════════════════════════════════════════════════════════════════════════

describe('buildSystemPrompt — capabilities', () => {
  it('shows basic capabilities when no skills', () => {
    mkdirSync(TEST_BASE, { recursive: true });
    const result = buildSystemPrompt({
      mode: 'full',
      skills: [],
      channel: 'cli',
      workspacePath: TEST_BASE,
      includeMemory: false,
    });
    expect(result.sections.capabilities).toContain('conversations');
  });

  it('shows tool capabilities when skills provided', () => {
    mkdirSync(TEST_BASE, { recursive: true });
    const result = buildSystemPrompt({
      mode: 'full',
      skills: [makeSkill('Test', 'A test skill')],
      channel: 'cli',
      workspacePath: TEST_BASE,
      includeMemory: false,
    });
    expect(result.sections.capabilities).toContain('bash tool');
    expect(result.sections.capabilities).toContain('CRITICAL');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// buildSystemPrompt — mode: minimal
// ═══════════════════════════════════════════════════════════════════════════════

describe('buildSystemPrompt — mode: minimal', () => {
  it('excludes skills section', () => {
    mkdirSync(TEST_BASE, { recursive: true });
    const result = buildSystemPrompt({
      mode: 'minimal',
      skills: [makeSkill('Calendar', 'Manage events')],
      channel: 'cli',
      workspacePath: TEST_BASE,
      includeMemory: false,
    });
    expect(result.sections.skills).toBe('');
  });

  it('excludes contacts section', () => {
    mkdirSync(TEST_BASE, { recursive: true });
    const result = buildSystemPrompt({
      mode: 'minimal',
      skills: [],
      channel: 'cli',
      workspacePath: TEST_BASE,
      includeMemory: false,
    });
    expect(result.sections.contacts).toBe('');
  });

  it('still includes capabilities', () => {
    mkdirSync(TEST_BASE, { recursive: true });
    const result = buildSystemPrompt({
      mode: 'minimal',
      skills: [makeSkill('Test', 'Test')],
      channel: 'cli',
      workspacePath: TEST_BASE,
      includeMemory: false,
    });
    expect(result.sections.capabilities).toBeTruthy();
  });

  it('still includes safety', () => {
    mkdirSync(TEST_BASE, { recursive: true });
    const result = buildSystemPrompt({
      mode: 'minimal',
      skills: [],
      channel: 'cli',
      workspacePath: TEST_BASE,
      includeMemory: false,
    });
    expect(result.sections.safety).toBeTruthy();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// buildSystemPrompt — bootstrap
// ═══════════════════════════════════════════════════════════════════════════════

describe('buildSystemPrompt — bootstrap', () => {
  it('loads bootstrap files from workspace', () => {
    mkdirSync(TEST_BASE, { recursive: true });
    writeFileSync(join(TEST_BASE, 'IDENTITY.md'), '# Tyrion\n\nA helpful local AI assistant');

    const result = buildSystemPrompt({
      mode: 'full',
      skills: [],
      channel: 'cli',
      workspacePath: TEST_BASE,
      includeMemory: false,
      bootstrapConfig: {
        workspacePath: TEST_BASE,
        files: ['IDENTITY.md'],
      },
    });
    expect(result.sections.bootstrap).toContain('Tyrion');
    expect(result.sections.bootstrap).toContain('helpful');
  });

  it('handles missing workspace gracefully', () => {
    const result = buildSystemPrompt({
      mode: 'full',
      skills: [],
      channel: 'cli',
      workspacePath: '/tmp/nonexistent-prompt-builder-ws',
      includeMemory: false,
    });
    // Should not throw, just have empty bootstrap
    expect(result.systemPrompt).toBeTruthy();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// buildSystemPrompt — memory
// ═══════════════════════════════════════════════════════════════════════════════

describe('buildSystemPrompt — memory', () => {
  it('includes memory when enabled', () => {
    mkdirSync(TEST_BASE, { recursive: true });
    writeFileSync(join(TEST_BASE, 'MEMORY.md'), 'Important fact: Tyrion is local-first');

    const result = buildSystemPrompt({
      mode: 'full',
      skills: [],
      channel: 'cli',
      workspacePath: TEST_BASE,
      includeMemory: true,
    });
    expect(result.sections.memory).toContain('Important fact');
  });

  it('excludes memory when disabled', () => {
    mkdirSync(TEST_BASE, { recursive: true });
    writeFileSync(join(TEST_BASE, 'MEMORY.md'), 'Should not appear');

    const result = buildSystemPrompt({
      mode: 'full',
      skills: [],
      channel: 'cli',
      workspacePath: TEST_BASE,
      includeMemory: false,
    });
    expect(result.sections.memory).toBe('');
  });

  it('excludes memory in minimal mode', () => {
    mkdirSync(TEST_BASE, { recursive: true });
    writeFileSync(join(TEST_BASE, 'MEMORY.md'), 'Should not appear');

    const result = buildSystemPrompt({
      mode: 'minimal',
      skills: [],
      channel: 'cli',
      workspacePath: TEST_BASE,
      includeMemory: true,
    });
    expect(result.sections.memory).toBe('');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// buildSystemPrompt — combined output
// ═══════════════════════════════════════════════════════════════════════════════

describe('buildSystemPrompt — combined output', () => {
  it('systemPrompt is non-empty for full mode', () => {
    mkdirSync(TEST_BASE, { recursive: true });
    const result = buildSystemPrompt({
      mode: 'full',
      skills: [],
      channel: 'imessage',
      workspacePath: TEST_BASE,
      includeMemory: false,
    });
    expect(result.systemPrompt.length).toBeGreaterThan(100);
  });

  it('systemPrompt contains sections joined by newlines', () => {
    mkdirSync(TEST_BASE, { recursive: true });
    const result = buildSystemPrompt({
      mode: 'full',
      skills: [],
      channel: 'imessage',
      workspacePath: TEST_BASE,
      includeMemory: false,
    });
    expect(result.systemPrompt).toContain('Capabilities');
    expect(result.systemPrompt).toContain('Safety');
    expect(result.systemPrompt).toContain('Current Context');
  });
});
