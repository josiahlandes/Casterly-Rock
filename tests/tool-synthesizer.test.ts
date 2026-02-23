import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { ToolSynthesizer, createToolSynthesizer } from '../src/tools/synthesizer.js';
import { resetTracer, initTracer } from '../src/autonomous/debug.js';

// ─────────────────────────────────────────────────────────────────────────────
// Setup
// ─────────────────────────────────────────────────────────────────────────────

let tempDir: string;

beforeEach(async () => {
  resetTracer();
  initTracer({ enabled: false });
  tempDir = await mkdtemp(join(tmpdir(), 'casterly-tools-'));
});

afterEach(async () => {
  resetTracer();
  await rm(tempDir, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tool Synthesizer Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('ToolSynthesizer — Core Operations', () => {
  let synth: ToolSynthesizer;

  beforeEach(() => {
    synth = new ToolSynthesizer({
      toolsDirectory: join(tempDir, 'tools'),
      maxTools: 5,
      maxTemplateLength: 500,
      unusedDaysThreshold: 30,
      reservedNames: ['bash', 'read_file', 'edit_file'],
    });
  });

  it('starts empty after load with no existing directory', async () => {
    await synth.load();
    expect(synth.isLoaded()).toBe(true);
    expect(synth.activeCount()).toBe(0);
    expect(synth.totalCount()).toBe(0);
  });

  it('creates a valid tool', async () => {
    await synth.load();

    const result = synth.createTool({
      name: 'quick_test',
      description: 'Run tests related to recently modified files.',
      inputSchema: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'File pattern to match.' },
        },
        required: ['pattern'],
      },
      template: 'npx vitest run {{pattern}}',
      authorNotes: 'I keep running this 3-step sequence manually.',
    });

    expect(result.success).toBe(true);
    expect(result.name).toBe('quick_test');
    expect(synth.activeCount()).toBe(1);
  });

  it('rejects tools with reserved names', async () => {
    await synth.load();

    const result = synth.createTool({
      name: 'bash',
      description: 'Override bash.',
      inputSchema: { type: 'object', properties: {}, required: [] },
      template: 'echo hello',
      authorNotes: 'Testing.',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('reserved');
  });

  it('rejects tools with invalid names', async () => {
    await synth.load();

    const result = synth.createTool({
      name: 'Invalid-Name',
      description: 'Bad name.',
      inputSchema: { type: 'object', properties: {}, required: [] },
      template: 'echo hello',
      authorNotes: 'Testing.',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('lowercase');
  });

  it('rejects tools with dangerous patterns', async () => {
    await synth.load();

    const result = synth.createTool({
      name: 'dangerous_tool',
      description: 'Destructive tool.',
      inputSchema: { type: 'object', properties: {}, required: [] },
      template: 'rm -rf /tmp/dangerous',
      authorNotes: 'Testing security.',
    });

    expect(result.success).toBe(false);
    expect(result.securityViolations).toBeDefined();
    expect(result.securityViolations!.length).toBeGreaterThan(0);
  });

  it('rejects process.exit in templates', async () => {
    await synth.load();

    const result = synth.createTool({
      name: 'exit_tool',
      description: 'Exits the process.',
      inputSchema: { type: 'object', properties: {}, required: [] },
      template: 'node -e "process.exit(1)"',
      authorNotes: 'Testing.',
    });

    expect(result.success).toBe(false);
    expect(result.securityViolations).toBeDefined();
  });

  it('rejects templates exceeding max length', async () => {
    await synth.load();

    const result = synth.createTool({
      name: 'long_tool',
      description: 'Too long.',
      inputSchema: { type: 'object', properties: {}, required: [] },
      template: 'x'.repeat(600),
      authorNotes: 'Testing.',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('too long');
  });

  it('enforces max tools capacity', async () => {
    await synth.load();

    for (let i = 0; i < 5; i++) {
      synth.createTool({
        name: `tool_${i}`,
        description: `Tool ${i}.`,
        inputSchema: { type: 'object', properties: {}, required: [] },
        template: `echo ${i}`,
        authorNotes: 'Testing.',
      });
    }

    const result = synth.createTool({
      name: 'tool_5',
      description: 'Over limit.',
      inputSchema: { type: 'object', properties: {}, required: [] },
      template: 'echo 5',
      authorNotes: 'Testing.',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('limit');
  });

  it('rejects duplicate active tool names', async () => {
    await synth.load();

    synth.createTool({
      name: 'my_tool',
      description: 'First.',
      inputSchema: { type: 'object', properties: {}, required: [] },
      template: 'echo first',
      authorNotes: 'Testing.',
    });

    const result = synth.createTool({
      name: 'my_tool',
      description: 'Duplicate.',
      inputSchema: { type: 'object', properties: {}, required: [] },
      template: 'echo duplicate',
      authorNotes: 'Testing.',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('already exists');
  });
});

describe('ToolSynthesizer — Lifecycle', () => {
  let synth: ToolSynthesizer;

  beforeEach(async () => {
    synth = new ToolSynthesizer({
      toolsDirectory: join(tempDir, 'tools'),
      maxTools: 10,
      unusedDaysThreshold: 30,
      reservedNames: ['bash'],
    });
    await synth.load();

    synth.createTool({
      name: 'test_tool',
      description: 'Test tool.',
      inputSchema: { type: 'object', properties: {}, required: [] },
      template: 'echo test',
      authorNotes: 'Testing lifecycle.',
    });
  });

  it('records usage count', () => {
    synth.recordUsage('test_tool');
    synth.recordUsage('test_tool');

    const tool = synth.getTool('test_tool');
    expect(tool!.usageCount).toBe(2);
    expect(tool!.lastUsed).toBeTruthy();
  });

  it('archives a tool', () => {
    expect(synth.archiveTool('test_tool')).toBe(true);
    expect(synth.activeCount()).toBe(0);
    expect(synth.totalCount()).toBe(1);
    expect(synth.getTool('test_tool')!.status).toBe('archived');
  });

  it('reactivates an archived tool', () => {
    synth.archiveTool('test_tool');
    expect(synth.reactivateTool('test_tool')).toBe(true);
    expect(synth.activeCount()).toBe(1);
    expect(synth.getTool('test_tool')!.status).toBe('active');
  });

  it('deletes a tool permanently', async () => {
    await synth.save();
    expect(await synth.deleteTool('test_tool')).toBe(true);
    expect(synth.totalCount()).toBe(0);
    expect(synth.getTool('test_tool')).toBeUndefined();
  });

  it('identifies unused tools', () => {
    // Tool was just created, lastUsed is empty — counts as unused
    const unused = synth.getUnusedTools();
    expect(unused).toHaveLength(1);
    expect(unused[0]!.name).toBe('test_tool');
  });

  it('persists and reloads tools', async () => {
    await synth.save();

    const synth2 = new ToolSynthesizer({
      toolsDirectory: join(tempDir, 'tools'),
      reservedNames: ['bash'],
    });
    await synth2.load();

    expect(synth2.activeCount()).toBe(1);
    expect(synth2.getTool('test_tool')!.description).toBe('Test tool.');
  });
});

describe('ToolSynthesizer — Template Rendering', () => {
  let synth: ToolSynthesizer;

  beforeEach(async () => {
    synth = new ToolSynthesizer({
      toolsDirectory: join(tempDir, 'tools'),
      reservedNames: ['bash'],
    });
    await synth.load();

    synth.createTool({
      name: 'greet',
      description: 'Greet someone.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Name to greet.' },
        },
        required: ['name'],
      },
      template: 'echo "Hello, {{name}}!"',
      authorNotes: 'Testing templates.',
    });
  });

  it('renders a template with parameter substitution', () => {
    const rendered = synth.renderTemplate('greet', { name: 'Tyrion' });
    expect(rendered).toBe('echo "Hello, Tyrion!"');
  });

  it('escapes single quotes in parameter values', () => {
    const rendered = synth.renderTemplate('greet', { name: "O'Brien" });
    // Shell-safe escaping: single quote becomes '\''
    expect(rendered).toContain("O'\\''Brien");
  });

  it('returns null for unknown tools', () => {
    expect(synth.renderTemplate('unknown', {})).toBeNull();
  });

  it('returns null for archived tools', () => {
    synth.archiveTool('greet');
    expect(synth.renderTemplate('greet', { name: 'Test' })).toBeNull();
  });
});

describe('ToolSynthesizer — List Summary', () => {
  let synth: ToolSynthesizer;

  beforeEach(async () => {
    synth = new ToolSynthesizer({
      toolsDirectory: join(tempDir, 'tools'),
      reservedNames: ['bash'],
    });
    await synth.load();
  });

  it('returns "No custom tools" when empty', () => {
    expect(synth.buildToolList()).toBe('No custom tools.');
  });

  it('lists active tools with usage stats', () => {
    synth.createTool({
      name: 'my_tool',
      description: 'Does things.',
      inputSchema: { type: 'object', properties: {}, required: [] },
      template: 'echo hello',
      authorNotes: 'Testing.',
    });
    synth.recordUsage('my_tool');

    const list = synth.buildToolList();
    expect(list).toContain('my_tool');
    expect(list).toContain('Does things');
    expect(list).toContain('used 1x');
  });

  it('shows archived tool count alongside active tools', () => {
    synth.createTool({
      name: 'active_tool',
      description: 'Stays active.',
      inputSchema: { type: 'object', properties: {}, required: [] },
      template: 'echo active',
      authorNotes: 'Testing.',
    });
    synth.createTool({
      name: 'archived_tool',
      description: 'Will be archived.',
      inputSchema: { type: 'object', properties: {}, required: [] },
      template: 'echo hello',
      authorNotes: 'Testing.',
    });
    synth.archiveTool('archived_tool');

    const list = synth.buildToolList();
    expect(list).toContain('active_tool');
    expect(list).toContain('1 archived');
  });
});

describe('ToolSynthesizer — Factory', () => {
  it('createToolSynthesizer returns a ToolSynthesizer', () => {
    const synth = createToolSynthesizer({
      toolsDirectory: join(tempDir, 'tools'),
    });
    expect(synth).toBeInstanceOf(ToolSynthesizer);
  });
});
