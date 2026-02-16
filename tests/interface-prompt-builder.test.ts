import { describe, expect, it, vi, afterEach } from 'vitest';

import {
  buildSystemPrompt,
  type PromptBuilderOptions,
  type BuiltPrompt,
} from '../src/interface/prompt-builder.js';

// Mock bootstrap to avoid file system dependencies
vi.mock('../src/interface/bootstrap.js', () => ({
  loadBootstrapFiles: vi.fn().mockReturnValue({
    files: [{ name: 'IDENTITY.md', content: 'You are Tyrion', truncated: false, originalSize: 14 }],
    combined: '## IDENTITY.md\n\nYou are Tyrion',
    workspacePath: '/tmp/test-workspace',
  }),
  formatBootstrapSection: vi.fn().mockReturnValue('# Project Context\n\n## IDENTITY.md\n\nYou are Tyrion'),
}));

// Mock memory to avoid file system dependencies
vi.mock('../src/interface/memory.js', () => ({
  createMemoryManager: vi.fn().mockReturnValue({
    load: vi.fn().mockReturnValue({
      longTerm: 'User likes coffee',
      todayLog: '',
      recentLogs: [],
    }),
    workspacePath: '/tmp/test-workspace',
  }),
  formatMemorySection: vi.fn().mockReturnValue('# Memory\n\nUser likes coffee'),
}));

// Mock contacts to avoid file system dependencies
vi.mock('../src/interface/contacts.js', () => ({
  loadAddressBook: vi.fn().mockReturnValue({
    admin: '+15551234567',
    contacts: [
      { name: 'Josiah', phone: '+15551234567', addedAt: 1700000000000 },
      { name: 'Katie', phone: '+15559876543', addedAt: 1700000000000 },
    ],
  }),
}));

// Mock logger to suppress output
vi.mock('../src/logging/safe-logger.js', () => ({
  safeLogger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

afterEach(() => {
  vi.clearAllMocks();
});

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeOptions(overrides: Partial<PromptBuilderOptions> = {}): PromptBuilderOptions {
  return {
    mode: 'full',
    skills: [],
    channel: 'imessage',
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Mode: none
// ═══════════════════════════════════════════════════════════════════════════════

describe('buildSystemPrompt — mode: none', () => {
  it('returns minimal identity-only prompt', () => {
    const result = buildSystemPrompt(makeOptions({ mode: 'none' }));
    expect(result.systemPrompt).toBe('You are Tyrion Lannister of Casterly Rock.');
    expect(result.sections.identity).toContain('Tyrion');
    expect(result.sections.bootstrap).toBe('');
    expect(result.sections.capabilities).toBe('');
    expect(result.sections.skills).toBe('');
    expect(result.sections.memory).toBe('');
    expect(result.sections.contacts).toBe('');
    expect(result.sections.safety).toBe('');
    expect(result.sections.context).toBe('');
    expect(result.sections.guidelines).toBe('');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Mode: full
// ═══════════════════════════════════════════════════════════════════════════════

describe('buildSystemPrompt — mode: full', () => {
  it('includes all sections', () => {
    const result = buildSystemPrompt(makeOptions({ mode: 'full' }));
    // Bootstrap
    expect(result.sections.bootstrap).toContain('Project Context');
    // Capabilities
    expect(result.sections.capabilities).toContain('Capabilities');
    // Safety
    expect(result.sections.safety).toContain('Safety Guidelines');
    // Context (date/time)
    expect(result.sections.context).toContain('Current Context');
    // Guidelines (channel-specific)
    expect(result.sections.guidelines).toContain('Response Guidelines');
    // Memory
    expect(result.sections.memory).toContain('Memory');
  });

  it('includes contacts section', () => {
    const result = buildSystemPrompt(makeOptions({ mode: 'full' }));
    expect(result.sections.contacts).toContain('People You Know');
    expect(result.sections.contacts).toContain('Josiah');
    expect(result.sections.contacts).toContain('Katie');
  });

  it('includes file locations section in full mode', () => {
    const result = buildSystemPrompt(makeOptions({ mode: 'full' }));
    expect(result.systemPrompt).toContain('File Locations');
    expect(result.systemPrompt).toContain('~/Documents/Tyrion/');
  });

  it('assembles all sections into systemPrompt', () => {
    const result = buildSystemPrompt(makeOptions({ mode: 'full' }));
    expect(result.systemPrompt).toContain('Project Context');
    expect(result.systemPrompt).toContain('Capabilities');
    expect(result.systemPrompt).toContain('Safety Guidelines');
    expect(result.systemPrompt).toContain('Current Context');
    expect(result.systemPrompt).toContain('Response Guidelines');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Mode: minimal
// ═══════════════════════════════════════════════════════════════════════════════

describe('buildSystemPrompt — mode: minimal', () => {
  it('skips skills section', () => {
    const skill = {
      id: 'test-skill',
      frontmatter: { name: 'Test Skill', description: 'Does testing' },
      instructions: 'Run tests',
      path: '/skills/test-skill',
      available: true,
      tools: [],
    };
    const result = buildSystemPrompt(makeOptions({
      mode: 'minimal',
      skills: [skill],
    }));
    expect(result.sections.skills).toBe('');
  });

  it('skips memory section', () => {
    const result = buildSystemPrompt(makeOptions({ mode: 'minimal' }));
    expect(result.sections.memory).toBe('');
  });

  it('skips contacts section', () => {
    const result = buildSystemPrompt(makeOptions({ mode: 'minimal' }));
    expect(result.sections.contacts).toBe('');
  });

  it('still includes capabilities, safety, context, and guidelines', () => {
    const result = buildSystemPrompt(makeOptions({ mode: 'minimal' }));
    expect(result.sections.capabilities).toContain('Capabilities');
    expect(result.sections.safety).toContain('Safety');
    expect(result.sections.context).toContain('Current Context');
    expect(result.sections.guidelines).toContain('Response Guidelines');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Capabilities section
// ═══════════════════════════════════════════════════════════════════════════════

describe('buildSystemPrompt — capabilities', () => {
  it('shows basic capabilities when no skills', () => {
    const result = buildSystemPrompt(makeOptions({ skills: [] }));
    expect(result.sections.capabilities).toContain('conversations and answer questions');
  });

  it('shows tool-aware capabilities when skills present', () => {
    const skill = {
      id: 'bash',
      frontmatter: { name: 'Bash', description: 'Shell commands' },
      instructions: 'Use bash',
      path: '/skills/bash',
      available: true,
      tools: [],
    };
    const result = buildSystemPrompt(makeOptions({ skills: [skill] }));
    expect(result.sections.capabilities).toContain('bash tool');
    expect(result.sections.capabilities).toContain('CRITICAL');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Skills section
// ═══════════════════════════════════════════════════════════════════════════════

describe('buildSystemPrompt — skills section', () => {
  it('includes skills in full mode', () => {
    const skill = {
      id: 'weather',
      frontmatter: {
        name: 'Weather',
        description: 'Check weather forecasts',
        metadata: { openclaw: { emoji: '🌤️' } },
      },
      instructions: 'Use weather-cli',
      path: '/skills/weather',
      available: true,
      tools: [],
    };
    const result = buildSystemPrompt(makeOptions({ mode: 'full', skills: [skill] }));
    expect(result.sections.skills).toContain('Available Skills');
    expect(result.sections.skills).toContain('🌤️');
    expect(result.sections.skills).toContain('Weather');
    expect(result.sections.skills).toContain('Check weather forecasts');
  });

  it('returns empty skills section when no skills', () => {
    const result = buildSystemPrompt(makeOptions({ mode: 'full', skills: [] }));
    expect(result.sections.skills).toBe('');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Channel-specific guidelines
// ═══════════════════════════════════════════════════════════════════════════════

describe('buildSystemPrompt — channel guidelines', () => {
  it('uses imessage guidelines', () => {
    const result = buildSystemPrompt(makeOptions({ channel: 'imessage' }));
    expect(result.sections.guidelines).toContain('concise');
    expect(result.sections.guidelines).toContain('text message');
  });

  it('uses cli guidelines', () => {
    const result = buildSystemPrompt(makeOptions({ channel: 'cli' }));
    expect(result.sections.guidelines).toContain('Markdown');
    expect(result.sections.guidelines).toContain('Code blocks');
  });

  it('uses web guidelines', () => {
    const result = buildSystemPrompt(makeOptions({ channel: 'web' }));
    expect(result.sections.guidelines).toContain('markdown');
    expect(result.sections.guidelines).toContain('readability');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Context section
// ═══════════════════════════════════════════════════════════════════════════════

describe('buildSystemPrompt — context', () => {
  it('includes date and timezone', () => {
    const result = buildSystemPrompt(makeOptions({ timezone: 'America/New_York' }));
    expect(result.sections.context).toContain('Date');
    expect(result.sections.context).toContain('Time');
    expect(result.sections.context).toContain('America/New_York');
  });

  it('falls back to system timezone when not provided', () => {
    const result = buildSystemPrompt(makeOptions({}));
    expect(result.sections.context).toContain('Timezone');
  });

  it('includes location info', () => {
    const result = buildSystemPrompt(makeOptions({}));
    expect(result.sections.context).toContain('Casterly Rock');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Memory control
// ═══════════════════════════════════════════════════════════════════════════════

describe('buildSystemPrompt — memory', () => {
  it('disables memory when includeMemory is false', () => {
    const result = buildSystemPrompt(makeOptions({
      mode: 'full',
      includeMemory: false,
    }));
    expect(result.sections.memory).toBe('');
  });

  it('enables memory by default in full mode', () => {
    const result = buildSystemPrompt(makeOptions({ mode: 'full' }));
    expect(result.sections.memory).toContain('Memory');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// BuiltPrompt structure
// ═══════════════════════════════════════════════════════════════════════════════

describe('buildSystemPrompt — return shape', () => {
  it('returns all required section keys', () => {
    const result = buildSystemPrompt(makeOptions());
    expect(result.sections).toHaveProperty('identity');
    expect(result.sections).toHaveProperty('bootstrap');
    expect(result.sections).toHaveProperty('capabilities');
    expect(result.sections).toHaveProperty('skills');
    expect(result.sections).toHaveProperty('memory');
    expect(result.sections).toHaveProperty('contacts');
    expect(result.sections).toHaveProperty('safety');
    expect(result.sections).toHaveProperty('context');
    expect(result.sections).toHaveProperty('guidelines');
  });

  it('systemPrompt is a string', () => {
    const result = buildSystemPrompt(makeOptions());
    expect(typeof result.systemPrompt).toBe('string');
    expect(result.systemPrompt.length).toBeGreaterThan(0);
  });
});
